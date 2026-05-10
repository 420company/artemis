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
const TOOL_ERROR_KEEP_CHARS = 1_500
const TOOL_RESULT_PLACEHOLDER = '[旧工具输出已清除以节省上下文]'

/** Rough token estimate: 1 token ≈ 4 chars */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

function estimateMsgListTokens(msgs: SessionMessage[]): number {
  return msgs.reduce((s, m) => s + estimateTokens(m.content), 0)
}

// ─── Phase 1: lossless tool-result pruning ────────────────────────────────────

function looksLikeToolFailure(content: string): boolean {
  const lower = content.toLowerCase()
  return lower.includes('"ok": false') ||
    lower.includes('tool_invalid_arguments') ||
    lower.includes('invalid arguments') ||
    lower.includes('execution error') ||
    lower.includes('error:') ||
    lower.includes('failed')
}

function truncateToolFailureContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    const output = typeof parsed.output === 'string' ? parsed.output : ''
    const outputHead = output.slice(0, 500)
    const outputTail = output.length > 1_000 ? output.slice(-500) : output.slice(500)
    return JSON.stringify({
      ...parsed,
      output: output.length > 1_000
        ? `${outputHead}
...[旧工具失败输出已截断 ${output.length - 1_000} chars，保留错误结构和输出首尾]
${outputTail}`
        : output,
    })
  } catch {
    return `${content.slice(0, TOOL_ERROR_KEEP_CHARS)}
...[旧工具失败输出已截断，保留错误开头以便恢复]`
  }
}

function pruneToolResults(messages: SessionMessage[], protectedFromIdx: number): SessionMessage[] {
  return messages.map((msg, i) => {
    if (msg.role !== 'tool') return msg
    if (i >= protectedFromIdx) return msg
    if (msg.content.length <= TOOL_RESULT_KEEP_CHARS) return msg
    if (looksLikeToolFailure(msg.content)) {
      return {
        ...msg,
        content: msg.content.length <= TOOL_ERROR_KEEP_CHARS
          ? msg.content
          : truncateToolFailureContent(msg.content),
      }
    }
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
  
  const scored = messages.map((m, index) => ({
    msg: m,
    index,
    score: scoreMessageSemanticImportance(m),
  }))

  // Sort by importance but preserve original order for the final list.
  // Keep assistant tool-call messages and their immediately following tool
  // results together; dropping either side can make OpenAI/Anthropic reject the
  // compressed request or deprive the summarizer of the failure evidence.
  const sorted = [...scored].sort((a, b) => b.score - a.score)
  const keepCount = Math.max(1, Math.floor(messages.length * (1 - targetReduction)))
  const threshold = sorted[keepCount]?.score ?? 0
  const keep = new Set<number>()

  for (const item of scored) {
    if (item.score >= threshold || item.msg.role === 'user') {
      keep.add(item.index)
    }
    if (assistantNeedsToolResults(item.msg)) {
      keep.add(item.index)
      if (messages[item.index + 1]?.role === 'tool') keep.add(item.index + 1)
    }
    if (item.msg.role === 'tool' && item.index > 0 && assistantNeedsToolResults(messages[item.index - 1]!)) {
      keep.add(item.index - 1)
      keep.add(item.index)
    }
  }

  return scored
    .filter(s => keep.has(s.index))
    .map(s => s.msg)
}

// ─── Phase 3: structured summarization ───────────────────────────────────────

export type SummarizeFn = (prompt: string) => Promise<string>

const SUMMARY_PROMPT = `\
请将以下对话历史压缩为结构化摘要。

目标：压缩后接手的 AI 必须能继续当前任务，不误改文件、不丢工具链、不忘验证。

对话历史：
{HISTORY}

---
{PREV_SUMMARY}
请输出 JSON（用代码块包裹），格式如下：
\`\`\`json
{
  "goal": "用户的总体目标",
  "current_task": "当前正在处理的具体任务/用户最新要求",
  "completed": ["已完成事项1", "已完成事项2"],
  "in_progress": ["进行中事项"],
  "key_decisions": ["关键决策和结论"],
  "relevant_files": ["相关文件路径"],
  "modified_files": ["已修改但可能尚未提交/发布的文件路径"],
  "tools_and_commands": ["已经使用过且后续可能仍需要的工具或命令"],
  "validation": ["已运行的验证及结果，或尚未验证的缺口"],
  "risks": ["可能导致跑偏/误改/丢上下文的风险"],
  "next_steps": ["下一步行动"],
  "critical_context": "其他不可丢失的上下文"
}
\`\`\`
摘要要精简，只保留最重要的信息，用中文输出。
必须遵守：
- 如果对话中出现明确路径、文件名、命令、工具名、错误信息、验证结果，尽量原样保留。
- 如果用户最新要求改变了任务方向，必须写入 current_task。
- 如果存在未完成的修改或尚未验证的改动，必须写入 in_progress、modified_files、validation 或 risks。
- 不要编造未执行的工具结果或验证结论。`

async function buildStructuredSummary(
  messages: SessionMessage[],
  previousSummary: string | undefined,
  summarize: SummarizeFn,
): Promise<string> {
  const history = messages
    .map((m) => {
      const limit = m.role === 'tool' && looksLikeToolFailure(m.content) ? 2_000 : m.role === 'user' ? 1_200 : 800
      return `[${m.role}]: ${m.content.slice(0, limit)}`
    })
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
  if (obj.current_task)    lines.push(`当前任务：${str(obj.current_task)}`)
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
  if (arr(obj.modified_files).length)
    lines.push(`已修改文件：${arr(obj.modified_files).join(', ')}`)
  if (arr(obj.tools_and_commands).length) {
    lines.push('工具与命令：'); arr(obj.tools_and_commands).forEach(c => lines.push(`  · ${c}`))
  }
  if (arr(obj.validation).length) {
    lines.push('验证：'); arr(obj.validation).forEach(c => lines.push(`  · ${c}`))
  }
  if (arr(obj.risks).length) {
    lines.push('风险/注意：'); arr(obj.risks).forEach(c => lines.push(`  · ${c}`))
  }
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
  /** Compress when token usage exceeds this fraction of limit. Default: adaptive, usually 0.70 */
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

/**
 * Compression follows the selected model's real window. Default policy:
 *   - small windows (<64K): start at 60% so tool output still fits;
 *   - medium windows (64K-256K): start at 70%;
 *   - large windows (>256K): start at 80%.
 * A high soft cap remains as cost protection for million-token models, but it
 * no longer forces 200K/1M models to compress at the old 40K ceiling.
 */
const LARGE_CONTEXT_SOFT_COMPRESS_AT_TOKENS = 700_000

export function getAdaptiveCompressionThreshold(tokenLimit: number): number {
  if (!Number.isFinite(tokenLimit) || tokenLimit <= 0) return 0.70
  if (tokenLimit < 64_000) return 0.60
  if (tokenLimit <= 256_000) return 0.70
  return 0.80
}

export function getCompressionTriggerTokens(tokenLimit: number, threshold?: number): number {
  const safeLimit = Number.isFinite(tokenLimit) && tokenLimit > 0 ? tokenLimit : 180_000
  const resolvedThreshold = typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0
    ? threshold
    : getAdaptiveCompressionThreshold(safeLimit)
  return Math.max(1, Math.floor(Math.min(safeLimit * resolvedThreshold, LARGE_CONTEXT_SOFT_COMPRESS_AT_TOKENS)))
}

export async function compressMessages(
  messages: SessionMessage[],
  summarize: SummarizeFn,
  opts: CompressionOptions = {},
): Promise<CompressResult> {
  const tokenLimit       = opts.tokenLimit       ?? 180_000
  const threshold        = opts.threshold        ?? getAdaptiveCompressionThreshold(tokenLimit)
  const protectHead      = opts.protectHead      ?? 3
  // Shrink the uncompressed tail from 20K → 12K tokens so the compressor
  // can reclaim more space during multi-agent workflows.
  const protectTailTok   = opts.protectTailTokens ?? 12_000
  const previousSummary  = opts.previousSummary
  const onInfo           = opts.onInfo

  const tokensBefore = estimateMsgListTokens(messages)

  const triggerAt = getCompressionTriggerTokens(tokenLimit, threshold)
  if (tokensBefore < triggerAt) {
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
    const pruned = pruneToolResults(messages, tailStart)
    const tokensAfter = estimateMsgListTokens(pruned)
    onInfo?.(`[压缩] 中段不足，仅修剪工具结果：${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K`)
    return { messages: pruned, compressed: true, tokensBefore, tokensAfter }
  }

  // ── Phase 1 on middle: prune tool results ─────────────────────────────────
  let prunedMiddle = pruneToolResults(middle, middle.length)
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
    const pruned = pruneToolResults(messages, tailStart)
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
