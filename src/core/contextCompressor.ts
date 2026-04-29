/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * core/contextCompressor.ts — Hermes-style 4-phase context compression
 *
 * Phase 1: Lossless tool-result pruning (no LLM, O(n) string ops)
 * Phase 2: Boundary determination — protect head + tail, compress middle
 * Phase 3: LLM structured summarization (patches previous summary, not rewrite)
 * Phase 4: Assemble head + summary message + tail
 *
 * Compression is transparent: session.messages is never mutated.
 * The compressed slice is used only for the outbound API call.
 */

import type { SessionMessage } from './types.js'

// ─── constants ────────────────────────────────────────────────────────────────

const TOOL_RESULT_KEEP_CHARS = 200
const TOOL_RESULT_PLACEHOLDER = '[旧工具输出已清除以节省上下文]'

/** Rough token estimate: 1 token ≈ 4 chars */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

function estimateMsgListTokens(msgs: SessionMessage[]): number {
  return msgs.reduce((s, m) => s + estimateTokens(m.content), 0)
}

// ─── Phase 1: lossless tool-result pruning ────────────────────────────────────

function pruneToolResults(messages: SessionMessage[], protectedFromIdx: number): SessionMessage[] {
  return messages.map((msg, i) => {
    if (msg.role !== 'tool') return msg
    if (i >= protectedFromIdx) return msg
    if (msg.content.length <= TOOL_RESULT_KEEP_CHARS) return msg
    return { ...msg, content: TOOL_RESULT_PLACEHOLDER }
  })
}

// ─── assistant-tool / tool-result pairing guard ──────────────────────────────
// Anthropic tool_use blocks and OpenAI-style assistant.toolCalls both require
// contiguous role='tool' follow-ups. If compression inserts a summary between
// them, OpenAI-compatible providers reject the request with errors like
// "assistant message with tool_calls must be followed by tool messages".

function hasAnthropicToolUseBlock(msg: SessionMessage): boolean {
  if (msg.role !== 'assistant' || !msg.contentBlocks) return false
  return msg.contentBlocks.some(
    (b) => b != null && typeof b === 'object' && (b as { type?: string }).type === 'tool_use',
  )
}

function hasOpenAIToolCalls(msg: SessionMessage): boolean {
  return msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0
}

function assistantNeedsToolResults(msg: SessionMessage): boolean {
  return hasAnthropicToolUseBlock(msg) || hasOpenAIToolCalls(msg)
}

/** A position `i` is safe if we can insert a new user-text message there without
 *  breaking a tool_use/tool_result pair. */
function isSafeBoundary(messages: SessionMessage[], i: number): boolean {
  if (i <= 0 || i >= messages.length) return true
  if (assistantNeedsToolResults(messages[i - 1]!)) return false  // prev has pending tool call
  if (messages[i]!.role === 'tool') return false       // next is orphan tool_result
  return true
}

// ─── Phase 5: Semantic-Aware Importance Filtering ────────────────────────────

interface SemanticMessage {
  msg: SessionMessage
  score: number
  category: 'core' | 'supporting' | 'boilerplate' | 'unknown'
}

/**
 * Heuristically scores message importance based on semantic signals.
 * Core logic, key decisions, and file-write operations get higher scores.
 */
function scoreMessageSemanticImportance(msg: SessionMessage): number {
  let score = 50 // Base score
  const content = msg.content.toLowerCase()

  // 1. Core Logic & Implementation (High Score)
  if (content.includes('function') || content.includes('class ') || content.includes('export ')) score += 30
  if (content.includes('implement') || content.includes('refactor') || content.includes('logic')) score += 20
  
  // 2. File Writes & Changes (High Score)
  if (msg.role === 'tool' && (
    content.includes('write_file') || content.includes('replace_in_file') ||
    content.includes('apply_patch') || content.includes('insert_in_file') ||
    content.includes('writefile') || content.includes('searchreplace')  // legacy aliases
  )) score += 40
  
  // 3. Key Decisions & Conclusions (High Score)
  if (content.includes('decision') || content.includes('conclude') || content.includes('finalized')) score += 25
  
  // 4. Errors & Debugging (Supporting)
  if (content.includes('error:') || content.includes('failed') || content.includes('exception')) score += 15
  
  // 5. Boilerplate & Repetitive Outputs (Penalty)
  if (content.includes('npm install') || content.includes('compiling...') || content.includes('successfully build')) score -= 30
  if (msg.role === 'tool' && content.length > 5000) score -= 10 // Huge tool outputs are usually logs

  return Math.max(0, Math.min(100, score))
}

function filterSemanticImportance(messages: SessionMessage[], targetReduction: number): SessionMessage[] {
  if (messages.length < 10) return messages
  
  const scored = messages.map(m => ({
    msg: m,
    score: scoreMessageSemanticImportance(m)
  }))

  // Sort by importance but preserve original order for the final list
  const sorted = [...scored].sort((a, b) => b.score - a.score)
  const keepCount = Math.floor(messages.length * (1 - targetReduction))
  const threshold = sorted[keepCount]?.score ?? 0

  return scored
    .filter(s => s.score >= threshold || s.msg.role === 'user') // Always keep user intent
    .map(s => s.msg)
}

// ─── Phase 3: structured summarization ───────────────────────────────────────

export type SummarizeFn = (prompt: string) => Promise<string>

const SUMMARY_PROMPT = `\
请将以下对话历史压缩为结构化摘要。

对话历史：
{HISTORY}

---
{PREV_SUMMARY}
请输出 JSON（用代码块包裹），格式如下：
\`\`\`json
{
  "goal": "用户的总体目标",
  "completed": ["已完成事项1", "已完成事项2"],
  "in_progress": ["进行中事项"],
  "key_decisions": ["关键决策和结论"],
  "relevant_files": ["相关文件路径"],
  "next_steps": ["下一步行动"],
  "critical_context": "其他不可丢失的上下文"
}
\`\`\`
摘要要精简，只保留最重要的信息，用中文输出。`

async function buildStructuredSummary(
  messages: SessionMessage[],
  previousSummary: string | undefined,
  summarize: SummarizeFn,
): Promise<string> {
  const history = messages
    .map(m => `[${m.role}]: ${m.content.slice(0, 600)}`)
    .join('\n\n---\n\n')

  const prevSection = previousSummary
    ? `已有摘要（在此基础上更新，不要从头重写）：\n${previousSummary}\n\n`
    : ''

  const prompt = SUMMARY_PROMPT
    .replace('{HISTORY}', history)
    .replace('{PREV_SUMMARY}', prevSection)

  const raw = await summarize(prompt)

  // Extract JSON from code block
  const match = raw.match(/```json\s*([\s\S]*?)```/)
  if (match?.[1]) {
    try {
      return formatSummary(JSON.parse(match[1]) as Record<string, unknown>)
    } catch { /* fall through to raw */ }
  }

  return `[对话摘要]\n${raw.slice(0, 2000)}`
}

function formatSummary(obj: Record<string, unknown>): string {
  const lines: string[] = ['[对话摘要]', '']
  const str  = (v: unknown) => typeof v === 'string' ? v : ''
  const arr  = (v: unknown) => Array.isArray(v) ? v as string[] : []

  if (obj.goal)            lines.push(`目标：${str(obj.goal)}`)
  if (arr(obj.completed).length) {
    lines.push('已完成：'); arr(obj.completed).forEach(c => lines.push(`  · ${c}`))
  }
  if (arr(obj.in_progress).length) {
    lines.push('进行中：'); arr(obj.in_progress).forEach(c => lines.push(`  · ${c}`))
  }
  if (arr(obj.key_decisions).length) {
    lines.push('关键决策：'); arr(obj.key_decisions).forEach(c => lines.push(`  · ${c}`))
  }
  if (arr(obj.relevant_files).length)
    lines.push(`相关文件：${arr(obj.relevant_files).join(', ')}`)
  if (arr(obj.next_steps).length) {
    lines.push('下一步：'); arr(obj.next_steps).forEach(c => lines.push(`  · ${c}`))
  }
  if (obj.critical_context) lines.push(`关键上下文：${str(obj.critical_context)}`)
  return lines.join('\n')
}

// ─── public API ───────────────────────────────────────────────────────────────

export interface CompressionOptions {
  /** Estimated token limit of the model. Default: 180_000 */
  tokenLimit?: number
  /** Compress when token usage exceeds this fraction of limit. Default: 0.5 */
  threshold?: number
  /** Number of messages to protect at the head. Default: 3 */
  protectHead?: number
  /** Approximate tokens to keep uncompressed at the tail. Default: 20_000 */
  protectTailTokens?: number
  /** Previous structured summary text — will be updated, not replaced */
  previousSummary?: string
  /**
   * Optional progress callback. Invoked when compression triggers, when
   * phases complete, and when summarization fails. Lets the CLI surface
   * compression activity to the user (was previously silent).
   */
  onInfo?: (message: string) => void
}

export interface CompressResult {
  messages: SessionMessage[]
  compressed: boolean
  summaryText?: string
  tokensBefore: number
  tokensAfter: number
}

export async function compressMessages(
  messages: SessionMessage[],
  summarize: SummarizeFn,
  opts: CompressionOptions = {},
): Promise<CompressResult> {
  const tokenLimit       = opts.tokenLimit       ?? 180_000
  // Compress when the conversation reaches 40 % of the context window.
  // The previous default of 50 % was too permissive — multi-agent design
  // workflows were spending 1M+ input tokens before compression ever fired.
  const threshold        = opts.threshold        ?? 0.40
  const protectHead      = opts.protectHead      ?? 3
  // Shrink the uncompressed tail from 20K → 12K tokens so the compressor
  // can reclaim more space during multi-agent workflows.
  const protectTailTok   = opts.protectTailTokens ?? 12_000
  const previousSummary  = opts.previousSummary
  const onInfo           = opts.onInfo

  const tokensBefore = estimateMsgListTokens(messages)

  if (tokensBefore < tokenLimit * threshold) {
    return { messages, compressed: false, tokensBefore, tokensAfter: tokensBefore }
  }

  // Compression triggered — surface to user. Without this, the previous
  // silent operation made it look like long sessions never compressed.
  const triggerPct = Math.round((tokensBefore / tokenLimit) * 100)
  onInfo?.(`[压缩] 上下文 ${Math.round(tokensBefore / 1000)}K (${triggerPct}% 限制)，开始压缩…`)

  // ── Phase 2: determine boundaries ────────────────────────────────────────
  let headEnd = Math.min(protectHead, messages.length)

  let tailStart = messages.length
  let tailTokens = 0
  for (let i = messages.length - 1; i >= headEnd; i--) {
    const t = estimateTokens(messages[i]!.content)
    if (tailTokens + t > protectTailTok) { tailStart = i + 1; break }
    tailTokens += t
    tailStart = i
  }
  tailStart = Math.max(headEnd, tailStart)

  // Snap boundaries so we don't split tool_use / tool_result pairs.
  // Move headEnd backward to escape a pending tool_use or orphan tool_result.
  while (headEnd > 0 && !isSafeBoundary(messages, headEnd)) headEnd--
  // Move tailStart forward likewise.
  while (tailStart < messages.length && !isSafeBoundary(messages, tailStart)) tailStart++
  // Re-clamp in case adjustments made head >= tail.
  tailStart = Math.max(headEnd, tailStart)

  const head   = messages.slice(0, headEnd)
  const middle = messages.slice(headEnd, tailStart)
  const tail   = messages.slice(tailStart)

  if (middle.length === 0) {
    // Not enough middle to compress — Phase 1 only (prune tool results)
    const pruned = pruneToolResults(messages, headEnd)
    const tokensAfter = estimateMsgListTokens(pruned)
    onInfo?.(`[压缩] 中段不足，仅修剪工具结果：${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K`)
    return { messages: pruned, compressed: true, tokensBefore, tokensAfter }
  }

  // ── Phase 1 on middle: prune tool results ─────────────────────────────────
  let prunedMiddle = pruneToolResults(middle, 0)
  onInfo?.(`[压缩] Phase 1: 修剪 ${middle.length} 条中段消息的工具结果`)

  // ── Phase 5: Semantic-Aware Importance Filtering ──────────────────────────
  // If the middle is still huge after pruning tool results, drop low-importance messages.
  if (estimateMsgListTokens(prunedMiddle) > tokenLimit * 0.15) {
    const beforeFilter = prunedMiddle.length
    prunedMiddle = filterSemanticImportance(prunedMiddle, 0.4) // Drop 40% of low-value messages
    onInfo?.(`[压缩] Phase 5: 按语义重要性过滤 ${beforeFilter} → ${prunedMiddle.length} 条`)
  }

  // ── Phase 3: LLM summarize ────────────────────────────────────────────────
  let summaryText: string
  try {
    onInfo?.(`[压缩] Phase 3: 调用 worker 模型生成结构化摘要…`)
    summaryText = await buildStructuredSummary(prunedMiddle, previousSummary, summarize)
  } catch (err) {
    // If summarization fails, fall back to Phase 1 only — surface why so
    // user can debug (was silent before, often masking provider auth errors).
    const msg = err instanceof Error ? err.message : String(err)
    onInfo?.(`[压缩] Phase 3 失败 → 退回 Phase 1: ${msg}`)
    const pruned = pruneToolResults(messages, headEnd)
    const tokensAfter = estimateMsgListTokens(pruned)
    onInfo?.(`[压缩] 结果（仅修剪）：${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K`)
    return { messages: pruned, compressed: true, tokensBefore, tokensAfter }
  }

  // ── Phase 4: assemble ─────────────────────────────────────────────────────
  const summaryMsg: SessionMessage = {
    id:        `ctx-summary-${Date.now()}`,
    role:      'user',
    content:   `[系统：以下是对话历史的压缩摘要，请基于此继续]\n\n${summaryText}\n\n[系统：摘要结束，以下是近期对话原文]`,
    createdAt: new Date().toISOString(),
  }

  const result = [...head, summaryMsg, ...tail]
  const tokensAfter = estimateMsgListTokens(result)
  const reductionPct = Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 100)
  onInfo?.(`[压缩] ✓ 完成：${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K (省 ${reductionPct}%)`)
  return {
    messages: result,
    compressed: true,
    summaryText,
    tokensBefore,
    tokensAfter,
  }
}
