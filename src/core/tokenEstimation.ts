/**
 * core/tokenEstimation.ts — 单一 token 估算来源
 *
 * 压缩触发、上下文预算、机械截断等所有「字符 → token」估算统一走这里。
 * 估算口径 = UTF-8 字节数 / 4（参考 grok-build xai-token-estimation）。
 * 旧口径 content.length / 4 数的是 UTF-16 码元，中文/emoji 会低估 3-6 倍，
 * 导致压缩迟迟不触发直至溢出。真实 provider usage 永远优先于本模块的估算。
 */

import type { SessionMessage } from './types.js'

/** UTF-8 字节 / token 的粗估比。 */
export const BYTES_PER_TOKEN = 4

/** 单张图片 content block 的近似 token 常数。 */
export const IMAGE_TOKEN_ESTIMATE = 765

/** 文本的 token 估算：UTF-8 字节数 / 4，向上取整。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN)
}

/** token 预算 → 字符预算的逆运算（ASCII 下限口径）。 */
export function estimateChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens)) * BYTES_PER_TOKEN
}

/** `imageCount` 张图片的 token 估算。 */
export function estimateImageTokens(imageCount: number): number {
  return Math.max(0, Math.floor(imageCount)) * IMAGE_TOKEN_ESTIMATE
}

function isImageBlock(block: unknown): boolean {
  return block != null && typeof block === 'object'
    && (block as { type?: string }).type === 'image'
}

/**
 * 单个 content block 的 token 估算：图片按常数，文本/思考按字节，
 * tool_use 按入参 JSON，tool_result 递归其内容。未知形状返回 0。
 */
export function estimateContentBlockTokens(block: unknown): number {
  if (block == null || typeof block !== 'object') {
    return typeof block === 'string' ? estimateTokens(block) : 0
  }
  const b = block as {
    type?: string
    text?: string
    thinking?: string
    input?: unknown
    content?: unknown
  }
  if (b.type === 'image') return IMAGE_TOKEN_ESTIMATE
  if (typeof b.text === 'string') return estimateTokens(b.text)
  if (typeof b.thinking === 'string') return estimateTokens(b.thinking)
  if (b.type === 'tool_use') {
    try {
      return estimateTokens(JSON.stringify(b.input ?? ''))
    } catch {
      return 0
    }
  }
  if (b.type === 'tool_result') {
    if (typeof b.content === 'string') return estimateTokens(b.content)
    if (Array.isArray(b.content)) return estimateContentBlocksTokens(b.content)
  }
  return 0
}

/** contentBlocks 数组的 token 估算。 */
export function estimateContentBlocksTokens(blocks: unknown[]): number {
  return blocks.reduce<number>((sum, block) => sum + estimateContentBlockTokens(block), 0)
}

/**
 * 单条会话消息的 token 估算：文本内容按字节/4，contentBlocks 中的图片
 * 按常数叠加（图片不在 content 字符串里，不会重复计数）。
 */
export function estimateMessageTokens(
  msg: Pick<SessionMessage, 'content'> & Partial<Pick<SessionMessage, 'contentBlocks'>>,
): number {
  const textTokens = estimateTokens(String(msg.content ?? ''))
  const blocks = msg.contentBlocks
  if (!Array.isArray(blocks) || blocks.length === 0) return textTokens
  return textTokens + estimateImageTokens(blocks.filter(isImageBlock).length)
}

/** 消息列表的 token 估算总和。 */
export function estimateMessagesTokens(
  messages: ReadonlyArray<Pick<SessionMessage, 'content'> & Partial<Pick<SessionMessage, 'contentBlocks'>>>,
): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}

/**
 * 阈值比较（分数口径）。边界语义为 **>=**：`used` 恰好落在
 * `contextWindow * thresholdFraction` 上即触发（与 grok-build 的
 * exceeds_threshold 一致，比旧的 `>` 门早一个 token）。
 * `contextWindow <= 0` 时恒为 false，调用方无需特判缺失窗口。
 */
export function exceedsThreshold(
  used: number,
  contextWindow: number,
  thresholdFraction: number,
): boolean {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false
  return used >= contextWindow * thresholdFraction
}

/**
 * 阈值比较（绝对 token 口径）。边界语义同样为 **>=**：
 * `used === budgetTokens` 即触发。
 */
export function exceedsTokenBudget(used: number, budgetTokens: number): boolean {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return false
  return used >= budgetTokens
}
