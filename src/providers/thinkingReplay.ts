import { createHash } from 'node:crypto';
import type { SessionMessage } from '../core/types.js';

/**
 * Replaying signed thinking blocks on the Messages API.
 *
 * On models that run the preserved-thinking prefix check, a thinking block
 * stays valid only while the top-level `system`, the set of `tools` and every
 * message sent before it are unchanged since the block was produced. Any
 * edit (a cleared tool result, a compaction summary, a per-request note that
 * moved, a changed tool list) makes the API reject the request with a 400,
 * or drop the block when the request opts into that.
 *
 * The provider records, on each assistant turn it returns, a digest of the
 * exact prefix the turn was produced against (`thinkingBinding`). When the
 * turn is replayed, its thinking blocks are kept only if the prefix about to
 * be sent has the same digest; otherwise they are left out, while the turn's
 * text and tool_use blocks stay. The digest covers earlier thinking blocks
 * as sent, so keeping a block also requires the same set of earlier blocks:
 * the decision is a pure function of the stored history, and the same
 * history yields the same request bytes on every turn.
 */

/**
 * Model ids the API runs the prefix check for, later generations included,
 * wherever the id sits in a longer name (`anthropic.`, `us.anthropic.`,
 * `anthropic/`, `vertex_ai/`, an inference-profile ARN). Other models keep
 * the request shape they always had, unless the API has already rejected
 * replayed thinking for them (see markThinkingReplayChecked).
 */
const PREFIX_CHECKED_MODELS =
  /(?:^|[/.:@])claude-(?:fable-(?:5[.-][1-9]|[6-9])|(?:opus|sonnet|haiku)-(?:5[.-][5-9]|[6-9]))(?![0-9])/i;

export function modelChecksThinkingPrefix(model: string): boolean {
  return PREFIX_CHECKED_MODELS.test(model.trim());
}

type EndpointConfig = { protocol?: string; baseUrl?: string; model?: string };

/** Endpoint + model pairs the API has rejected replayed thinking for (aliases, unknown ids). */
const confirmedChecking = new Set<string>();

function endpointKey(config: EndpointConfig): string {
  return `${(config.baseUrl ?? '').replace(/\/+$/, '')}|${(config.model ?? '').trim().toLowerCase()}`;
}

/** After a replay 400 the endpoint + model is treated as checking for the rest of the process. */
export function markThinkingReplayChecked(config: EndpointConfig): void {
  confirmedChecking.add(endpointKey(config));
}

/**
 * Whether requests to this Messages endpoint keep replayed thinking valid:
 * the model id is a known checking one, or the API has rejected replayed
 * thinking for it once already.
 */
export function checksThinkingReplay(config: EndpointConfig | null | undefined): boolean {
  if (!config || (config.protocol !== undefined && config.protocol !== 'messages')) return false;
  return modelChecksThinkingPrefix(config.model ?? '') || confirmedChecking.has(endpointKey(config));
}

type Block = { type?: unknown; [key: string]: unknown };

export function isThinkingBlock(block: unknown): boolean {
  const type = (block as Block | null)?.type;
  return type === 'thinking' || type === 'redacted_thinking';
}

export function hasThinkingBlocks(blocks: unknown): boolean {
  return Array.isArray(blocks) && blocks.some(isThinkingBlock);
}

export function withoutThinkingBlocks<T>(blocks: readonly T[]): T[] {
  return blocks.filter((block) => !isThinkingBlock(block));
}

/** Key-sorted copy (key order is not part of what the API checks). */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = sortedKeys(entry);
    }
    return out;
  }
  return value;
}

/**
 * A system, tool or content block as the digest sees it: its own
 * `cache_control` mark is not part of the check; everything nested in it
 * (tool inputs, schemas, tool_result content) counts as sent.
 */
function canonicalBlock(block: unknown): unknown {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return sortedKeys(block);
  const { cache_control: _mark, ...rest } = block as Record<string, unknown>;
  return sortedKeys(rest);
}

function canonicalContent(content: unknown): unknown {
  return Array.isArray(content) ? content.map(canonicalBlock) : content;
}

/** A string content and a one-text-block content are kept distinct: the provider sends one form only. */
function canonicalMessage(message: { role?: unknown; content?: unknown }): string {
  return JSON.stringify({ role: message.role, content: canonicalContent(message.content) });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Running digest of a request prefix: system and tools first, then one
 * message at a time. `digest()` at message i covers everything before it.
 */
export class PrefixDigest {
  private current: string;

  /** Tools in the order sent: a reordered list counts as changed (the safe direction). */
  constructor(system: unknown, tools: unknown) {
    this.current = sha256(JSON.stringify({
      system: canonicalContent(system ?? null),
      tools: Array.isArray(tools) ? tools.map(canonicalBlock) : [],
    }));
  }

  push(message: { role?: unknown; content?: unknown }): void {
    this.current = sha256(`${this.current}\n${canonicalMessage(message)}`);
  }

  digest(): string {
    return this.current;
  }

  /** Continues from where `other` is. */
  adopt(other: PrefixDigest): void {
    this.current = other.current;
  }

  /** A copy that moves on independently (to try a message before committing it). */
  fork(): PrefixDigest {
    const copy = Object.create(PrefixDigest.prototype) as PrefixDigest;
    copy.current = this.current;
    return copy;
  }
}

/** Digest of everything a request body sends before the model's reply. */
export function requestBodyBinding(body: Record<string, unknown>): string {
  const digest = new PrefixDigest(body.system, body.tools);
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    digest.push(message as { role?: unknown; content?: unknown });
  }
  return digest.digest();
}

/**
 * The 400 the API returns for a replayed thinking block it rejects: bound to
 * another conversation (an edited prefix) or an invalid signature.
 */
export function isThinkingReplayError(status: number, body: string): boolean {
  if (status !== 400) return false;
  return /invalid\s+`?signature`?\s+in\s+`?(?:redacted_)?thinking`?\s+block|bound to a different conversation|prefix_mismatch_behavior/i.test(body);
}

/** Stands in for a turn that held nothing but thinking: an empty assistant turn is a 400 of its own. */
export const EMPTY_TURN_TEXT = '(no reply text)';

/** A turn's blocks without thinking; never empty. */
export function thinkingFreeBlocks<T>(blocks: readonly T[]): Array<T | { type: 'text'; text: string }> {
  const kept = withoutThinkingBlocks(blocks);
  return kept.length > 0 ? kept : [{ type: 'text', text: EMPTY_TURN_TEXT }];
}

/**
 * The body with every thinking block left out of its messages; null when it
 * has none. Used for the one retry after a replay 400, on any model.
 */
export function stripThinkingFromBody(body: Record<string, unknown>): Record<string, unknown> | null {
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;
  let changed = false;
  const next = messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content) || !content.some(isThinkingBlock)) return message;
    changed = true;
    return { ...(message as Record<string, unknown>), content: thinkingFreeBlocks(content) };
  });
  return changed ? { ...body, messages: next } : null;
}

/**
 * Leaves the thinking blocks out of the stored assistant turns named in
 * `ids` (their text and tool calls stay), on any model: the turns a request
 * left out (prefix changed) or that the API rejected. Once a block has been
 * left out of a request it has to stay out: putting it back would invalidate
 * the thinking produced while it was gone. The stored blocks map to the same
 * bytes the request just sent for them.
 */
export function dropStoredThinking(
  messages: readonly SessionMessage[],
  ids: readonly string[] | undefined,
): { messages: SessionMessage[]; changed: boolean } {
  if (!ids?.length) return { messages: [...messages], changed: false };
  const wanted = new Set(ids);
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== 'assistant' || !wanted.has(message.id) || !hasThinkingBlocks(message.rawContentBlocks)) return message;
    changed = true;
    const { thinkingBinding: _binding, ...rest } = message;
    return { ...rest, rawContentBlocks: thinkingFreeBlocks(message.rawContentBlocks!) };
  });
  return { messages: next, changed };
}
