/**
 * core/agentUpdates.ts — short progress messages the agent posts while it is
 * still working ("已经在办了…", "香港机房没货了，正在看新加坡…").
 *
 * The model calls the `post_update` tool. The host (the web server, which
 * forwards to the web app and Telegram) reads one stderr line per update:
 *
 *   [agent-update] {"id":"upd_<16 hex>","text":"…","at":"<ISO time>","seq":1}
 *
 * Each update is also kept in the conversation: the tool result message that
 * records the call carries `agentUpdate: {id, text}`, and the chat history
 * (storage/sessions.ts) shows it as its own assistant message, in order, with
 * `kind: "update"`. The message the model is sent stays a normal tool result.
 *
 * Updates are bounded so a model cannot flood the user: at most
 * MAX_UPDATE_CHARS characters each, a small burst then one every
 * REFILL_MS, at most MAX_UPDATES_PER_RUN per run, no exact repeats, and no
 * cards or code blocks (questions belong in the reply, where they can be
 * answered).
 */

import { randomBytes } from 'node:crypto';
import { scrubInternalNames } from '../utils/internalNames.js';

export const AGENT_UPDATE_PREFIX = '[agent-update]';

/** Characters (code points) one update may have. */
export const MAX_UPDATE_CHARS = 280;
/** Updates in one run. */
export const MAX_UPDATES_PER_RUN = 12;
/** Updates that may go out back to back (e.g. the acknowledgement and the first finding). */
export const UPDATE_BURST = 2;
/** One more update becomes available this often. */
export const UPDATE_REFILL_MS = 8_000;

export interface AgentUpdate {
  id: string;
  text: string;
  at: string;
  /** 1-based position in this run. */
  seq: number;
}

export type PostUpdateResult =
  | { ok: true; update: AgentUpdate }
  | { ok: false; code: 'update_empty' | 'update_too_long' | 'update_has_card' | 'update_repeated' | 'update_rate_limited' | 'update_limit_reached'; message: string; retryable: boolean };

export interface AgentUpdateChannelOptions {
  /** Writes one protocol line (the headless host: stderr through onInfo). */
  emit: (line: string) => void;
  now?: () => number;
  maxChars?: number;
  maxPerRun?: number;
  burst?: number;
  refillMs?: number;
}

/** Normalises the text: trimmed, at most one blank line in a row, internal names removed. */
export function cleanUpdateText(raw: string): string {
  return scrubInternalNames(String(raw ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatAgentUpdateLine(update: AgentUpdate): string {
  return `${AGENT_UPDATE_PREFIX} ${JSON.stringify(update)}`;
}

/**
 * One run's updates: checks the limits, emits the line, and remembers what
 * was delivered so the stored tool result can be marked with the same id.
 */
export class AgentUpdateChannel {
  private readonly emit: (line: string) => void;
  private readonly now: () => number;
  private readonly maxChars: number;
  private readonly maxPerRun: number;
  private readonly burst: number;
  private readonly refillMs: number;
  private tokens: number;
  private lastRefill: number;
  private readonly delivered: AgentUpdate[] = [];
  private readonly unclaimed: AgentUpdate[] = [];

  constructor(options: AgentUpdateChannelOptions) {
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    this.maxChars = options.maxChars ?? MAX_UPDATE_CHARS;
    this.maxPerRun = options.maxPerRun ?? MAX_UPDATES_PER_RUN;
    this.burst = options.burst ?? UPDATE_BURST;
    this.refillMs = options.refillMs ?? UPDATE_REFILL_MS;
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  /** Updates delivered so far, in order. */
  get updates(): readonly AgentUpdate[] {
    return this.delivered;
  }

  post(raw: string): PostUpdateResult {
    const text = cleanUpdateText(raw);
    if (!text) return { ok: false, code: 'update_empty', message: 'The update is empty. Write one or two short sentences for the user.', retryable: true };
    const chars = [...text].length;
    if (chars > this.maxChars) {
      return {
        ok: false,
        code: 'update_too_long',
        message: `The update has ${chars} characters; the limit is ${this.maxChars}. Say only what changed, in one or two sentences, and keep details for the final reply.`,
        retryable: true,
      };
    }
    if (/```/.test(text)) {
      return {
        ok: false,
        code: 'update_has_card',
        message: 'Updates are plain progress text. Put questions, options and cards in your reply (done=true) so the user can answer them.',
        retryable: true,
      };
    }
    if (this.delivered.length >= this.maxPerRun) {
      return {
        ok: false,
        code: 'update_limit_reached',
        message: `This task already sent ${this.maxPerRun} updates. Keep working and put the rest in the final reply.`,
        retryable: false,
      };
    }
    if (this.delivered.at(-1)?.text === text) {
      return { ok: false, code: 'update_repeated', message: 'The user already has this exact update. Send a new one only when something changed.', retryable: false };
    }
    this.refill();
    if (this.tokens < 1) {
      const waitSeconds = Math.ceil((this.refillMs - (this.now() - this.lastRefill)) / 1000);
      return {
        ok: false,
        code: 'update_rate_limited',
        message: `Too many updates in a row. Keep working; the next update can go out in about ${Math.max(1, waitSeconds)} s. Fold this news into that one or into the final reply.`,
        retryable: false,
      };
    }
    this.tokens -= 1;
    const update: AgentUpdate = {
      id: `upd_${randomBytes(8).toString('hex')}`,
      text,
      at: new Date(this.now()).toISOString(),
      seq: this.delivered.length + 1,
    };
    this.delivered.push(update);
    this.unclaimed.push(update);
    this.emit(formatAgentUpdateLine(update));
    return { ok: true, update };
  }

  /**
   * The delivered update a stored tool result belongs to (first unclaimed
   * one with the same text), so history and the live stream share its id.
   */
  claim(raw: string): AgentUpdate | undefined {
    const text = cleanUpdateText(raw);
    const index = this.unclaimed.findIndex((update) => update.text === text);
    if (index < 0) return undefined;
    return this.unclaimed.splice(index, 1)[0];
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed < this.refillMs) return;
    const gained = Math.floor(elapsed / this.refillMs);
    this.tokens = Math.min(this.burst, this.tokens + gained);
    this.lastRefill = this.tokens >= this.burst ? now : this.lastRefill + gained * this.refillMs;
  }
}
