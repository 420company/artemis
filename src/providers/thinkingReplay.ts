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
 * Model ids the API runs the prefix check for, later generations included.
 * An optional vendor prefix (`anthropic.`, `us.anthropic.`) is allowed.
 * Other models keep the request shape they always had.
 */
const PREFIX_CHECKED_MODELS =
  /^(?:[a-z0-9-]+\.)*claude-(?:fable-(?:5[.-][1-9]|[6-9])|(?:opus|sonnet|haiku)-(?:5[.-][5-9]|[6-9]))(?![0-9])/i;

export function modelChecksThinkingPrefix(model: string): boolean {
  return PREFIX_CHECKED_MODELS.test(model.trim());
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

/**
 * Canonical form for the digest. Key order and `cache_control` marks are not
 * part of what the API checks, and a string content is the same value as one
 * text block, so neither changes the digest.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === 'cache_control') continue;
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      out[key] = canonical(entry);
    }
    return out;
  }
  return value;
}

function canonicalMessage(message: { role?: unknown; content?: unknown }): string {
  const content = typeof message.content === 'string'
    ? (message.content ? [{ type: 'text', text: message.content }] : [])
    : message.content;
  return JSON.stringify(canonical({ role: message.role, content }));
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

  constructor(system: unknown, tools: unknown) {
    const toolList = Array.isArray(tools)
      ? [...tools].sort((a, b) => String((a as Block)?.name ?? '').localeCompare(String((b as Block)?.name ?? '')))
      : [];
    this.current = sha256(JSON.stringify(canonical({ system: system ?? null, tools: toolList })));
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

/** The body with every thinking block left out of its messages; null when it has none. */
export function stripThinkingFromBody(body: Record<string, unknown>): Record<string, unknown> | null {
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content) || !content.some(isThinkingBlock)) {
      next.push(message);
      continue;
    }
    changed = true;
    const kept = withoutThinkingBlocks(content);
    // A turn that held nothing but thinking goes; the API merges the turns around it.
    if (kept.length > 0) next.push({ ...(message as Record<string, unknown>), content: kept });
  }
  return changed ? { ...body, messages: next } : null;
}

/**
 * Leaves the thinking blocks out of the stored assistant turns named in
 * `ids` (their text and tool calls stay). Once a block has been left out of
 * a request it has to stay out: putting it back would invalidate the
 * thinking produced while it was gone.
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
    const kept = withoutThinkingBlocks(message.rawContentBlocks!);
    const { rawContentBlocks: _raw, thinkingBinding: _binding, ...rest } = message;
    return kept.length > 0 ? { ...rest, rawContentBlocks: kept } : rest;
  });
  return { messages: next, changed };
}
