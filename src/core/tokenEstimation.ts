/**
 * core/tokenEstimation.ts — the single source of local token estimates.
 *
 * Provider-reported usage is always the ground truth; these estimates only
 * cover what the provider has not counted yet (messages appended since the
 * last request, a changed system prompt, tool schemas) and the first request
 * of a session.
 *
 * The estimate is deliberately conservative:
 * - CJK characters (Han, Kana, Hangul, CJK punctuation, full-width forms)
 *   count as one token each. Byte-based estimates undercount Chinese by
 *   roughly 25-75% depending on the tokenizer.
 * - Everything else counts as UTF-8 bytes / 4.
 * - Messages also count tool-call arguments, reasoning text, thinking blocks
 *   and a small per-message framing overhead, which the old estimate ignored.
 */

import type { SessionMessage } from './types.js'

/** UTF-8 bytes per token for non-CJK text. */
export const BYTES_PER_TOKEN = 4

/** Approximate token cost of one image content block. */
export const IMAGE_TOKEN_ESTIMATE = 765

/** Role/framing tokens each message adds on top of its content. */
export const MESSAGE_OVERHEAD_TOKENS = 4

/** Framing tokens each tool schema adds on top of its JSON. */
const TOOL_SCHEMA_OVERHEAD_TOKENS = 8

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x2fdf) || // CJK radicals, Kangxi radicals
    (cp >= 0x3000 && cp <= 0x303f) || // CJK symbols and punctuation
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana, Katakana
    (cp >= 0x3100 && cp <= 0x31ff) || // Bopomofo, Hangul compat, Kanbun, Katakana ext
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xffef) || // Half-width and full-width forms
    (cp >= 0x20000 && cp <= 0x3134f) // CJK Extensions B-H (supplementary planes)
  )
}

/** Number of CJK characters in `text`. */
export function countCjkChars(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    let cp = text.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = ((cp - 0xd800) << 10) + (low - 0xdc00) + 0x10000
        i += 1
      }
    }
    if (isCjkCodePoint(cp)) count += 1
  }
  return count
}

/**
 * Token estimate for a text: CJK characters count as one token each, all
 * other characters as UTF-8 bytes / 4 (rounded up).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let otherBytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) {
      otherBytes += 1
      continue
    }
    if (unit < 0x800) {
      otherBytes += 2
      continue
    }
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        const cp = ((unit - 0xd800) << 10) + (low - 0xdc00) + 0x10000
        i += 1
        if (isCjkCodePoint(cp)) cjk += 1
        else otherBytes += 4
        continue
      }
    }
    if (isCjkCodePoint(unit)) cjk += 1
    else otherBytes += 3
  }
  return cjk + Math.ceil(otherBytes / BYTES_PER_TOKEN)
}

/** Inverse of the ASCII rate: a token budget expressed as a character budget. */
export function estimateChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens)) * BYTES_PER_TOKEN
}

/** Token estimate for `imageCount` images. */
export function estimateImageTokens(imageCount: number): number {
  return Math.max(0, Math.floor(imageCount)) * IMAGE_TOKEN_ESTIMATE
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? '') ?? ''
  } catch {
    return ''
  }
}

/**
 * Token estimate for one content block: images use a constant, text and
 * thinking blocks count their text, tool_use counts its input JSON, and
 * tool_result recurses into its content. Unknown shapes count their JSON.
 */
export function estimateContentBlockTokens(block: unknown): number {
  if (block == null) return 0
  if (typeof block === 'string') return estimateTokens(block)
  if (typeof block !== 'object') return 0
  const b = block as {
    type?: string
    text?: string
    thinking?: string
    data?: string
    input?: unknown
    name?: string
    content?: unknown
  }
  if (b.type === 'image') return IMAGE_TOKEN_ESTIMATE
  if (b.type === 'tool_use') {
    return estimateTokens(b.name ?? '') + estimateTokens(safeJson(b.input))
  }
  if (b.type === 'tool_result') {
    if (typeof b.content === 'string') return estimateTokens(b.content)
    if (Array.isArray(b.content)) return estimateContentBlocksTokens(b.content)
    return 0
  }
  if (typeof b.text === 'string') return estimateTokens(b.text)
  if (typeof b.thinking === 'string') return estimateTokens(b.thinking)
  if (b.type === 'redacted_thinking' && typeof b.data === 'string') {
    return Math.ceil(b.data.length / BYTES_PER_TOKEN)
  }
  return estimateTokens(safeJson(block))
}

/** Token estimate for an array of content blocks. */
export function estimateContentBlocksTokens(blocks: readonly unknown[]): number {
  return blocks.reduce<number>((sum, block) => sum + estimateContentBlockTokens(block), 0)
}

function isImageBlock(block: unknown): boolean {
  return block != null && typeof block === 'object'
    && (block as { type?: string }).type === 'image'
}

export type EstimableMessage =
  Pick<SessionMessage, 'content'>
  & Partial<Pick<SessionMessage, 'contentBlocks' | 'toolCalls' | 'reasoningContent' | 'rawContentBlocks' | 'name' | 'toolUseId'>>

/**
 * Token estimate for one session message. Counts the text content, tool-call
 * names and arguments, reasoning text, images, and a framing overhead.
 *
 * Providers that replay `rawContentBlocks` (Anthropic thinking round-trip)
 * send those blocks instead of `content` and `toolCalls`, so the larger of
 * the two representations is counted rather than their sum.
 */
export function estimateMessageTokens(msg: EstimableMessage): number {
  let plain = estimateTokens(String(msg.content ?? ''))
  if (Array.isArray(msg.toolCalls)) {
    for (const call of msg.toolCalls) {
      plain += estimateTokens(call?.name ?? '') + estimateTokens(call?.arguments ?? '') + 4
    }
  }
  const raw = Array.isArray(msg.rawContentBlocks) && msg.rawContentBlocks.length > 0
    ? estimateContentBlocksTokens(msg.rawContentBlocks)
    : 0
  let total = Math.max(plain, raw) + MESSAGE_OVERHEAD_TOKENS
  if (msg.reasoningContent) total += estimateTokens(msg.reasoningContent)
  if (msg.name) total += estimateTokens(msg.name)
  if (msg.toolUseId) total += 8
  if (Array.isArray(msg.contentBlocks) && msg.contentBlocks.length > 0) {
    total += estimateImageTokens(msg.contentBlocks.filter(isImageBlock).length)
  }
  return total
}

/** Sum of the per-message estimates. */
export function estimateMessagesTokens(messages: ReadonlyArray<EstimableMessage>): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}

/** Token estimate for a list of native tool (function) schemas. */
export function estimateToolSchemaTokens(tools: ReadonlyArray<unknown> | undefined): number {
  if (!tools || tools.length === 0) return 0
  return tools.reduce<number>(
    (sum, tool) => sum + estimateTokens(safeJson(tool)) + TOOL_SCHEMA_OVERHEAD_TOKENS,
    0,
  )
}

/**
 * Fraction threshold check. Inclusive: `used` exactly at
 * `contextWindow * thresholdFraction` triggers. A missing window never triggers.
 */
export function exceedsThreshold(
  used: number,
  contextWindow: number,
  thresholdFraction: number,
): boolean {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false
  return used >= contextWindow * thresholdFraction
}

/** Absolute threshold check. Inclusive, like `exceedsThreshold`. */
export function exceedsTokenBudget(used: number, budgetTokens: number): boolean {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return false
  return used >= budgetTokens
}
