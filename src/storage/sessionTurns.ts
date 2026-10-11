/**
 * storage/sessionTurns.ts — the last exchange of a conversation: what it is,
 * and taking it back out.
 *
 * Hosts offer "retry", "edit and resend" and "undo" on the latest turn. All
 * three start by removing the last exchange (the owner's last message and
 * everything the agent did after it) from the live history. Before that, a
 * host can ask what the exchange did, so it can warn when retrying would run
 * tools with side effects (files written, commands run, media made) again.
 *
 * Only the live history is edited. When compaction moved the last message
 * into the transcript archive (a very long single turn), the exchange is not
 * removable and the caller is told so instead of guessing.
 */

import type { SessionMessage, SessionRecord } from '../core/types.js';
import { isSyntheticUserMessage } from '../core/compaction/language.js';
import { invalidateUsageAnchor, normalizeContextState } from '../core/compaction/accounting.js';
import { userVisibleMessageText } from '../utils/internalNames.js';

/** Where `artemis execute` records the turn it ran, for a later retry. */
export const LAST_TURN_METADATA_KEY = 'lastTurn';

/** What a headless run records about its turn (session.metadata.lastTurn). */
export type LastTurnRecord = {
  /** The owner's message the turn started from. */
  userMessageId: string;
  /** The last message of the turn when it ended; a later message means another turn followed. */
  lastMessageId: string;
  /** The prompt exactly as the host sent it (attachment lines included). */
  prompt: string;
  intent?: string;
  imagePaths?: string[];
  at: string;
};

/** One tool the exchange used, and whether running it again changes something. */
export type ExchangeTool = { name: string; sideEffect: boolean };

export type LastExchange = {
  /** Index in session.messages where the exchange starts (the owner's message). */
  startIndex: number;
  userMessage: { id: string; content: string; createdAt: string };
  /** The agent's last visible reply in the exchange (may be empty: stopped or failed). */
  reply?: { id: string; content: string; createdAt: string };
  /** Messages the exchange holds (user, assistant, tool and runtime entries). */
  messageCount: number;
  tools: ExchangeTool[];
  sideEffects: boolean;
  /** The recorded turn matches this exchange: a retry can reuse its prompt, intent and images. */
  recorded?: LastTurnRecord;
};

export type LastExchangeLookup =
  | { ok: true; exchange: LastExchange }
  | { ok: false; reason: 'empty' | 'compacted' };

/**
 * Decides whether one tool use changes something outside the conversation.
 * `action` is the tool's arguments as recorded (its `type` is the tool name).
 */
export type SideEffectClassifier = (name: string, action: Record<string, unknown> | undefined) => boolean;

function readRecord(session: SessionRecord): LastTurnRecord | undefined {
  const raw = session.metadata?.[LAST_TURN_METADATA_KEY] as Partial<LastTurnRecord> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  if (typeof raw.userMessageId !== 'string' || typeof raw.lastMessageId !== 'string' || typeof raw.prompt !== 'string') return undefined;
  return {
    userMessageId: raw.userMessageId,
    lastMessageId: raw.lastMessageId,
    prompt: raw.prompt,
    ...(typeof raw.intent === 'string' ? { intent: raw.intent } : {}),
    ...(Array.isArray(raw.imagePaths) ? { imagePaths: raw.imagePaths.filter((p): p is string => typeof p === 'string') } : {}),
    at: typeof raw.at === 'string' ? raw.at : '',
  };
}

/** A message the owner wrote (not a runtime note, reminder or compaction entry). */
function isOwnerMessage(message: SessionMessage): boolean {
  return message.role === 'user' && !isSyntheticUserMessage(message) && Boolean(message.content?.trim());
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The tools an exchange used, one entry per name; a name counts as side-effecting if any use was. */
export function exchangeTools(messages: readonly SessionMessage[], classify: SideEffectClassifier): ExchangeTool[] {
  const byName = new Map<string, boolean>();
  const note = (name: string, action: Record<string, unknown> | undefined) => {
    if (!name) return;
    const effect = classify(name, action);
    byName.set(name, (byName.get(name) ?? false) || effect);
  };
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        const args = parseJsonObject(call.arguments);
        note(call.name, args ? { ...args, type: call.name } : { type: call.name });
      }
    } else if (message.role === 'tool') {
      // Tool results are stored as {ok, action, output}; runtime notes are plain text and are not tools.
      const payload = parseJsonObject(message.content);
      const action = payload?.action && typeof payload.action === 'object' ? payload.action as Record<string, unknown> : undefined;
      const name = typeof action?.type === 'string' ? action.type : undefined;
      if (name) note(name, action);
    }
  }
  return [...byName.entries()].map(([name, sideEffect]) => ({ name, sideEffect }));
}

/**
 * The last exchange of the live history. With a turn record that still
 * describes the end of the history, its message marks the start; otherwise
 * the last message the owner wrote does.
 */
export function findLastExchange(session: SessionRecord, classify: SideEffectClassifier): LastExchangeLookup {
  const messages = session.messages;
  const record = readRecord(session);
  let startIndex = -1;
  let recorded: LastTurnRecord | undefined;
  if (record && messages.at(-1)?.id === record.lastMessageId) {
    const at = messages.findIndex((message) => message.id === record.userMessageId);
    if (at < 0) {
      // The turn is still the latest one, but its start went to the archive.
      return { ok: false, reason: 'compacted' };
    }
    startIndex = at;
    recorded = record;
  }
  if (startIndex < 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (isOwnerMessage(messages[i]!)) {
        startIndex = i;
        break;
      }
    }
  }
  if (startIndex < 0) {
    // The live history starts with a compaction boundary and holds no owner message: the
    // turn's start is in the archive. A history with nothing in it has nothing to take back.
    const compacted = messages.some((message) => Boolean(message.compaction));
    return { ok: false, reason: compacted ? 'compacted' : 'empty' };
  }
  const turn = messages.slice(startIndex);
  const user = messages[startIndex]!;
  const reply = [...turn].reverse().find((message) => message.role === 'assistant' && message.content?.trim());
  const tools = exchangeTools(turn, classify);
  return {
    ok: true,
    exchange: {
      startIndex,
      userMessage: { id: user.id, content: userVisibleMessageText(user.content), createdAt: user.createdAt },
      ...(reply ? { reply: { id: reply.id, content: reply.content, createdAt: reply.createdAt } } : {}),
      messageCount: turn.length,
      tools,
      sideEffects: tools.some((tool) => tool.sideEffect),
      ...(recorded ? { recorded } : {}),
    },
  };
}

/**
 * Removes the exchange from the live history (in memory; the caller saves).
 * The stored token count no longer describes the history, so it is dropped,
 * and so is the turn record.
 */
export function removeExchange(session: SessionRecord, exchange: Pick<LastExchange, 'startIndex'>): SessionMessage[] {
  const removed = session.messages.splice(exchange.startIndex);
  const metadata = session.metadata ? { ...session.metadata } : undefined;
  if (metadata) {
    delete metadata[LAST_TURN_METADATA_KEY];
    if (metadata.context) {
      const context = normalizeContextState(metadata.context);
      invalidateUsageAnchor(context);
      metadata.context = context;
    }
    session.metadata = metadata;
  }
  session.updatedAt = new Date().toISOString();
  return removed;
}

/** Records the turn a headless run just finished (in memory; the caller saves). */
export function recordLastTurn(
  session: SessionRecord,
  turn: { userMessageId: string; prompt: string; intent?: string; imagePaths?: string[] },
): void {
  const last = session.messages.at(-1);
  if (!last) return;
  const record: LastTurnRecord = {
    userMessageId: turn.userMessageId,
    lastMessageId: last.id,
    prompt: turn.prompt,
    ...(turn.intent ? { intent: turn.intent } : {}),
    ...(turn.imagePaths?.length ? { imagePaths: [...turn.imagePaths] } : {}),
    at: new Date().toISOString(),
  };
  session.metadata = { ...(session.metadata ?? {}), [LAST_TURN_METADATA_KEY]: record };
}

/** The first message the owner wrote among `messages` that is not among `before` (the turn a run added). */
export function firstNewOwnerMessage(messages: readonly SessionMessage[], before: ReadonlySet<string>): SessionMessage | undefined {
  return messages.find((message) => !before.has(message.id) && isOwnerMessage(message));
}

/** `artemis execute --retry` and `session undo` exit with this when there is nothing to take back (sysexits EX_DATAERR). */
export const NOTHING_TO_REWIND_EXIT_CODE = 65;

export class SessionRewindError extends Error {
  readonly exitCode = NOTHING_TO_REWIND_EXIT_CODE;
  constructor(readonly reason: 'empty' | 'compacted') {
    super(reason === 'empty'
      ? 'Nothing to take back: the conversation has no message yet.'
      : 'The last message was moved out of the live history to save space; it can no longer be taken back.');
    this.name = 'SessionRewindError';
  }
}
