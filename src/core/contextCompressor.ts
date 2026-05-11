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
const MICROCOMPACT_SOFT_TRIGGER_TOKENS = 40_000

/**
 * Time-based microcompact: if the last assistant message is older than this
 * threshold, the server-side prompt cache is cold anyway — proactively clear
 * old tool results before sending the request to shrink what gets rewritten.
 * Mirrors ClaudeCode's timeBasedMCConfig.gapThresholdMinutes (default 5).
 */
const TIME_BASED_MC_GAP_MINUTES = 42
const TIME_BASED_MC_KEEP_RECENT = 4

/**
 * Only microcompact tool outputs from these tool types. Write operations
 * (write_file, apply_patch, insert_in_file) are preserved because they
 * serve as execution evidence the model may need for correctness checks.
 *
 * Mirrors ClaudeCode's COMPACTABLE_TOOLS set (microCompact.ts:41-50).
 */
const COMPACTABLE_TOOL_NAMES = new Set([
  'read_file',
  'run_command',
  'npm_run',
  'search',
  'grep',
  'list_directory',
  'file_info',
  'browser_screenshot',
  'web_search',
  'web_fetch',
  'deep_research',
  // Legacy / alias names that may appear in older sessions
  'searchreplace',
  'readfile',
])

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

/**
 * Tools whose outputs represent execution evidence (writes, patches) and
 * MUST NOT be compacted even when large. The model needs these to verify
 * that its edits were applied correctly.
 */
const NON_COMPACTABLE_TOOL_NAMES = new Set([
  'write_file',
  'apply_patch',
  'insert_in_file',
  'replace_in_file',
  'create_file',
  'delete_file',
  'writefile',  // legacy alias
])

/**
 * Check if a tool message's name matches a compactable tool type.
 * Tool messages may carry the tool name in msg.name or embedded in the
 * JSON content as action.type.
 */
function isCompactableToolMessage(msg: SessionMessage): boolean {
  // Direct name field (set by session store on tool messages)
  const toolName = msg.name
  if (toolName) {
    // Explicitly non-compactable tools are never cleared
    if (NON_COMPACTABLE_TOOL_NAMES.has(toolName)) return false
    // Explicitly compactable tools
    if (COMPACTABLE_TOOL_NAMES.has(toolName)) return true
  }
  // Try parsing the JSON envelope for action.type
  try {
    const parsed = JSON.parse(msg.content) as Record<string, unknown>
    const action = parsed.action as Record<string, unknown> | undefined
    const actionType = action && typeof action.type === 'string' ? action.type : null
    if (actionType) {
      if (NON_COMPACTABLE_TOOL_NAMES.has(actionType)) return false
      if (COMPACTABLE_TOOL_NAMES.has(actionType)) return true
    }
  } catch { /* not JSON or no action field */ }
  // Fallback: if we can't determine the type AND name is unknown, still
  // compact very large generic tool outputs. But if we have a name and it
  // wasn't in either set, be conservative and don't compact.
  if (toolName) return false
  return msg.content.length > 4_000
}

function pruneToolResults(messages: SessionMessage[], protectedFromIdx: number): SessionMessage[] {
  return messages.map((msg, i) => {
    if (msg.role !== 'tool') return msg
    if (i >= protectedFromIdx) return msg
    if (msg.content.length <= TOOL_RESULT_KEEP_CHARS) return msg
    // Only compact tools whose outputs are deterministic/reproducible.
    // Write operations (write_file, apply_patch) are preserved as evidence.
    if (!isCompactableToolMessage(msg)) return msg
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
 * Full summarizing compaction follows the model window. Large-window models
 * should be allowed to retain more live conversation state; early cleanup is
 * handled by deterministic microcompaction of old tool outputs instead.
 */
const LARGE_CONTEXT_FULL_COMPRESS_AT_TOKENS = 700_000

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
  return Math.max(1, Math.floor(Math.min(safeLimit * resolvedThreshold, LARGE_CONTEXT_FULL_COMPRESS_AT_TOKENS)))
}

export function getMicrocompactTriggerTokens(tokenLimit: number): number {
  const safeLimit = Number.isFinite(tokenLimit) && tokenLimit > 0 ? tokenLimit : 180_000
  return Math.max(8_000, Math.floor(Math.min(safeLimit * 0.10, MICROCOMPACT_SOFT_TRIGGER_TOKENS)))
}

/**
 * Time-based microcompact: when the last assistant message is older than
 * TIME_BASED_MC_GAP_MINUTES, the provider-side prompt cache is cold. Clear
 * old tool results proactively to reduce what gets re-tokenized.
 *
 * Returns null when the trigger doesn't fire (no old enough assistant msg,
 * nothing to clear). Caller falls through to the regular microcompact path.
 *
 * Mirrors ClaudeCode's maybeTimeBasedMicrocompact (microCompact.ts:446-530).
 */
export function maybeTimeBasedMicrocompact(
  messages: SessionMessage[],
  onInfo?: (message: string) => void,
): CompressResult | null {
  // Find the last assistant message and check the time gap
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') { lastAssistantIdx = i; break }
  }
  if (lastAssistantIdx < 0) return null

  const lastAssistant = messages[lastAssistantIdx]!
  const createdAt = lastAssistant.createdAt ? new Date(lastAssistant.createdAt).getTime() : 0
  if (!createdAt) return null
  const gapMinutes = (Date.now() - createdAt) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < TIME_BASED_MC_GAP_MINUTES) return null

  // Collect compactable tool message indices
  const compactableIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'tool' && isCompactableToolMessage(messages[i]!) && messages[i]!.content.length > TOOL_RESULT_KEEP_CHARS) {
      compactableIndices.push(i)
    }
  }
  // Keep the most recent N tool outputs
  const keepSet = new Set(compactableIndices.slice(-TIME_BASED_MC_KEEP_RECENT))
  const clearIndices = compactableIndices.filter(i => !keepSet.has(i))
  if (clearIndices.length === 0) return null

  const clearSet = new Set(clearIndices)
  const tokensBefore = estimateMsgListTokens(messages)

  const pruned = messages.map((msg, i) => {
    if (!clearSet.has(i)) return msg
    if (looksLikeToolFailure(msg.content)) {
      return { ...msg, content: msg.content.length <= TOOL_ERROR_KEEP_CHARS ? msg.content : truncateToolFailureContent(msg.content) }
    }
    return { ...msg, content: TOOL_RESULT_PLACEHOLDER }
  })

  const tokensAfter = estimateMsgListTokens(pruned)
  if (tokensAfter >= tokensBefore) return null

  onInfo?.(`[时间微压缩] 距上次回复 ${Math.round(gapMinutes)}min > ${TIME_BASED_MC_GAP_MINUTES}min 阈值，清理 ${clearIndices.length} 条旧工具输出 (~${Math.round((tokensBefore - tokensAfter) / 1000)}K tokens)，保留最近 ${keepSet.size} 条`)
  return { messages: pruned, compressed: true, tokensBefore, tokensAfter }
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

  // ── Time-based microcompact: runs first, short-circuits ───────────────
  // If the gap since the last assistant message exceeds the threshold,
  // the provider-side cache has expired — clear old tool results now.
  const timeBased = maybeTimeBasedMicrocompact(messages, onInfo)
  if (timeBased) return timeBased

  const triggerAt = getCompressionTriggerTokens(tokenLimit, threshold)
  if (tokensBefore < triggerAt) {
    const microcompactAt = getMicrocompactTriggerTokens(tokenLimit)
    if (tokensBefore >= microcompactAt) {
      // Protect tail by token budget instead of fixed message count.
      // Walk backward until we've accumulated ~12K tokens of tail protection.
      let tailProtectTokens = 0
      let protectedFromIdx = messages.length
      for (let i = messages.length - 1; i >= 0; i--) {
        tailProtectTokens += estimateTokens(messages[i]!.content)
        if (tailProtectTokens > 12_000) { protectedFromIdx = i + 1; break }
      }
      protectedFromIdx = Math.max(0, protectedFromIdx)
      const pruned = pruneToolResults(messages, protectedFromIdx)
      const tokensAfter = estimateMsgListTokens(pruned)
      if (tokensAfter < tokensBefore) {
        onInfo?.(`[微压缩] 清理旧工具输出：${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K，保留近期 ~${Math.round(tailProtectTokens / 1000)}K 对话原文`)
        return { messages: pruned, compressed: true, tokensBefore, tokensAfter }
      }
    }
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
