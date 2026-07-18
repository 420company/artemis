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
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  exceedsTokenBudget,
} from './tokenEstimation.js'

// ─── constants ────────────────────────────────────────────────────────────────

const TOOL_RESULT_KEEP_CHARS = 200
const TOOL_ERROR_KEEP_CHARS = 1_500
const TOOL_RESULT_PLACEHOLDER = '[旧工具输出已清除以节省上下文]'

// Microcompact trigger: deterministic old tool-output cleanup. Keep the
// ceiling low even on large-window models; full summarizing compression scales
// with context size, but stale tool output pruning should still happen early.
const MICROCOMPACT_TRIGGER_FRACTION = 0.15  // 15% of context
const MICROCOMPACT_TRIGGER_FLOOR    = 8_000
const MICROCOMPACT_TRIGGER_CEIL     = 40_000

// Tail protection during microcompact: how many tokens of recent conversation
// are exempt from being replaced with placeholder. Must be large enough that
// a freshly-read file survives long enough to be acted on.
const TAIL_PROTECT_FRACTION = 0.05  // 5% of context
const TAIL_PROTECT_FLOOR    = 20_000
const TAIL_PROTECT_CEIL     = 100_000

/**
 * Time-based microcompact: if the last assistant message is older than this
 * threshold, the server-side prompt cache is cold anyway — proactively clear
 * old tool results before sending the request to shrink what gets rewritten.
 * Mirrors ClaudeCode's timeBasedMCConfig.gapThresholdMinutes (default 5).
 */
const TIME_BASED_MC_GAP_MINUTES = 42
const TIME_BASED_MC_KEEP_RECENT = 4

/**
 * 收益闸：full compact 后总 token 必须降到压缩前的 (1 - 0.20) = 80% 以下，
 * 否则丢弃本次压缩结果（参考 grok intra_compaction max_reduction_ratio 0.8）。
 */
const MIN_COMPACTION_REDUCTION = 0.20
const LAST_USER_INJECT_MAX_CHARS = 4000

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

// Token 估算统一走 core/tokenEstimation（UTF-8 字节/4 + 图片常数）。
function estimateMsgListTokens(msgs: SessionMessage[]): number {
  return estimateMessagesTokens(msgs)
}

// ─── progress-message localization ────────────────────────────────────────────
// Compression progress lines are surfaced to the user via onInfo. They follow
// the active UI locale (same bilingual approach as the CLI buttons). Default
// to Chinese when locale is unspecified.
export type CompressLocale = 'en' | 'zh'
function tr(locale: CompressLocale | undefined, zh: string, en: string): string {
  return locale === 'en' ? en : zh
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

function generateFileSkeleton(filePath: string, content: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const lines = content.split('\n')
  const skeleton: string[] = []
  const imports: string[] = []
  const exportsList: string[] = []
  const anchors: string[] = []
  const assertionAnchors: string[] = []

  const pushLimited = (arr: string[], value: string, max = 40) => {
    if (arr.length < max) arr.push(value)
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const line = raw.trim()
    if (/^import\s/.test(line) || /^from\s+['"]/.test(line) || /^const\s+\w+\s*=\s*require\(/.test(line)) {
      pushLimited(imports, `  L${i + 1}: ${line.slice(0, 180)}`)
    }
    if (/^export\s/.test(line)) {
      pushLimited(exportsList, `  L${i + 1}: ${line.replace(/\{.*/, '').replace(/=.*/, '').trim().slice(0, 180)}`)
    }
    if (/TODO|FIXME|HACK|XXX|IMPORTANT|WARNING|deprecated|@deprecated|throw new Error|process\.exit|assert\(|expect\(|it\(|test\(/i.test(line)) {
      const target = /assert\(|expect\(|it\(|test\(/.test(line) ? assertionAnchors : anchors
      pushLimited(target, `  L${i + 1}: ${line.slice(0, 220)}`, 60)
    }
  }

  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (
        line.startsWith('export class ') ||
        line.startsWith('class ') ||
        line.startsWith('export interface ') ||
        line.startsWith('interface ') ||
        line.startsWith('export type ') ||
        line.startsWith('type ') ||
        line.startsWith('export function ') ||
        line.startsWith('function ') ||
        line.startsWith('export const ') ||
        line.startsWith('async function ') ||
        line.startsWith('export async function ')
      ) {
        let display = line
          .replace(/\{.*/, '')
          .replace(/=.*/, '')
          .trim()
        if (display.endsWith('(')) display += '...'
        skeleton.push(`  L${i + 1}: ${display}`)
      } else if (line.match(/^(public|private|protected|async|get|set)?\s+\w+\s*\(.*\)\s*\{?/) && !line.startsWith('if') && !line.startsWith('for') && !line.startsWith('while') && !line.startsWith('switch')) {
        const display = line.replace(/\{.*/, '').trim()
        skeleton.push(`    L${i + 1}: ${display}`)
      }
    }
  } else if (ext === 'py') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const trimmed = line.trim()
      if (trimmed.startsWith('class ') || trimmed.startsWith('def ')) {
        const indent = line.length - line.trimStart().length
        skeleton.push(`${' '.repeat(indent)}L${i + 1}: ${trimmed.replace(/:.*/, '')}`)
      }
    }
  } else if (ext === 'json') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      const keys = Object.keys(parsed)
      skeleton.push(`  Top-level keys: ${keys.slice(0, 30).join(', ')}${keys.length > 30 ? '...' : ''}`)
    } catch {
      skeleton.push(`  [Invalid JSON file]`)
    }
  } else if (ext === 'md') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (line.startsWith('#')) {
        skeleton.push(`  L${i + 1}: ${line}`)
      }
    }
  }

  if (skeleton.length === 0) {
    if (filePath === 'file' || ext === '') {
      return `[旧工具输出已清除以节省上下文]`
    }

    const headLines = lines.slice(0, 15).map((l, idx) => `  L${idx + 1}: ${l.length > 100 ? l.slice(0, 100) + '...' : l}`)
    const tailLines = lines.length > 30
      ? lines.slice(-15).map((l, idx) => `  L${lines.length - 15 + idx + 1}: ${l.length > 100 ? l.slice(0, 100) + '...' : l}`)
      : []

    return [
      `[旧工具输出已清除，已提取结构摘要以节省上下文]`,
      `文件路径: ${filePath}`,
      `总长度: ${content.length} 字符, 行数: ${lines.length}`,
      `--- 文件开头首 15 行 ---`,
      ...headLines,
      lines.length > 30 ? `... [已省略 ${lines.length - 30} 行] ...` : undefined,
      ...tailLines
    ].filter((l): l is string => l !== undefined).join('\n')
  }

  return [
    `[旧工具输出已清除，已提取代码大纲以节省上下文，可通过重新读取来获取完整内容]`,
    `文件路径: ${filePath}`,
    `总长度: ${content.length} 字符, 行数: ${lines.length}`,
    imports.length ? `--- imports / requires ---` : undefined,
    ...imports,
    exportsList.length ? `--- exports ---` : undefined,
    ...exportsList,
    `--- 代码大纲与结构骨架 ---`,
    ...skeleton.slice(0, 120),
    skeleton.length > 120 ? `  ... [已省略 ${skeleton.length - 120} 个大纲项] ...` : undefined,
    assertionAnchors.length ? `--- 测试/断言锚点 ---` : undefined,
    ...assertionAnchors,
    anchors.length ? `--- 风险/TODO/错误锚点 ---` : undefined,
    ...anchors,
  ].filter((l): l is string => l !== undefined).join('\n')
}

function extractFileSkeletonFromToolResult(msg: SessionMessage): string {
  let content = msg.content
  let isEnvelope = false
  let parsedEnvelope: any = null

  try {
    const parsed = JSON.parse(msg.content)
    if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') {
      content = parsed.output
      isEnvelope = true
      parsedEnvelope = parsed
    }
  } catch {
    // Not a JSON envelope
  }

  let filePath = 'file'
  if (isEnvelope && typeof parsedEnvelope.path === 'string') {
    filePath = parsedEnvelope.path
  } else if (isEnvelope && typeof parsedEnvelope.filePath === 'string') {
    filePath = parsedEnvelope.filePath
  } else {
    try {
      if (isEnvelope && parsedEnvelope.args && typeof parsedEnvelope.args.path === 'string') {
        filePath = parsedEnvelope.args.path
      } else if (isEnvelope && parsedEnvelope.action && parsedEnvelope.action.input && typeof parsedEnvelope.action.input.path === 'string') {
        filePath = parsedEnvelope.action.input.path
      }
    } catch { /* ignored */ }
  }

  const skeletonText = generateFileSkeleton(filePath, content)

  if (isEnvelope) {
    return JSON.stringify({
      ...parsedEnvelope,
      output: skeletonText,
      contextSkeletonExtracted: true,
    }, null, 2)
  }

  return skeletonText
}

function pruneToolResults(messages: SessionMessage[], protectedFromIdx: number): { messages: SessionMessage[]; readFileSkeletonsExtracted: number } {
  let readFileSkeletonsExtracted = 0
  const pruned = messages.map((msg, i) => {
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
    // High-tier AST/skeleton extraction for read_file tools
    if (msg.name === 'read_file' || msg.name === 'readfile') {
      readFileSkeletonsExtracted += 1
      return {
        ...msg,
        content: extractFileSkeletonFromToolResult(msg),
      }
    }
    return { ...msg, content: TOOL_RESULT_PLACEHOLDER }
  })
  return { messages: pruned, readFileSkeletonsExtracted }
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

// ─── real user request lookup ────────────────────────────────────────────────
// 重建结构时要注入的是「最后一条真实用户请求」，压缩摘要/恢复/运行时护栏这类
// 合成 user 消息不算。

function isSyntheticUserMessage(msg: SessionMessage): boolean {
  if (msg.id.startsWith('recovery-') || msg.id.startsWith('ctx-summary-') || msg.id.startsWith('mech-summary')) {
    return true
  }
  const c = msg.content
  return c.startsWith('[系统：') || c.startsWith('═══') || c.startsWith('[tool:runtime_guard]')
}

function findLastRealUserMessageIndex(messages: SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    if (isSyntheticUserMessage(m)) continue
    if (m.content.trim().length < 2) continue
    return i
  }
  return -1
}

// ─── Phase 5: Evidence-preserving overflow handling ─────────────────────────

const LONG_MESSAGE_SUMMARY_HEAD_CHARS = 1_200
const LONG_MESSAGE_SUMMARY_TAIL_CHARS = 800
const LONG_MESSAGE_SUMMARY_LIMIT = 2_800

function compactLongMessageForSummary(msg: SessionMessage): SessionMessage {
  if (msg.content.length <= LONG_MESSAGE_SUMMARY_LIMIT) return msg
  if (msg.role === 'tool') return msg

  const head = msg.content.slice(0, LONG_MESSAGE_SUMMARY_HEAD_CHARS).trimEnd()
  const tail = msg.content.slice(-LONG_MESSAGE_SUMMARY_TAIL_CHARS).trimStart()
  return {
    ...msg,
    content: [
      `[长${msg.role}消息已为摘要阶段保留首尾，原始长度 ${msg.content.length} chars]`,
      '--- head ---',
      head,
      '--- tail ---',
      tail,
    ].join('\n'),
  }
}

function prepareMiddleForStructuredSummary(messages: SessionMessage[], tokenLimit: number): SessionMessage[] {
  let prepared = messages.map(compactLongMessageForSummary)
  const maxSummaryInputTokens = Math.max(24_000, Math.floor(tokenLimit * 0.35))
  if (estimateMsgListTokens(prepared) <= maxSummaryInputTokens) return prepared

  // If the middle is still too large, keep all user/tool-pair structure and
  // deterministically thin old assistant prose only. This is not a semantic
  // deletion pass: every user constraint, tool evidence, and tool-call pair
  // remains visible to the summarizer. The assistant prose that is thinned is
  // replaced with a breadcrumb rather than silently dropped.
  prepared = prepared.map((msg, index) => {
    if (msg.role !== 'assistant') return msg
    if (assistantNeedsToolResults(msg)) return msg
    const keepRecent = index >= messages.length - 12
    if (keepRecent) return msg
    return {
      ...msg,
      content: `[旧 assistant 推理/进度文本已压缩为面包屑，原始长度 ${msg.content.length} chars；用户约束、工具调用和工具结果仍保留] ${msg.content.slice(0, 400)}`,
    }
  })

  return prepared
}

// ─── Phase 3: structured summarization ───────────────────────────────────────

export type SummarizeFn = (prompt: string) => Promise<string>

// ── 摘要输出清洗（参考 grok summary.rs format_compact_summary）────────────────
// 剥离前导 <analysis>/<thinking> 草稿块（含未闭合截断情形），并对正文里回显的
// 控制标记插零宽空格去毒，防止摘要喂回上下文后自激污染下一轮输出。

const SUMMARY_DRAFT_TAGS = ['analysis', 'thinking'] as const
const MIN_SUMMARY_CHARS = 200

function stripLeadingDraftBlocks(text: string): string {
  let result = text
  for (;;) {
    const trimmed = result.trimStart()
    const tag = SUMMARY_DRAFT_TAGS.find((t) => trimmed.startsWith(`<${t}>`))
    if (!tag) break
    const open = `<${tag}>`
    const close = `</${tag}>`
    const start = result.indexOf(open)
    const closeIdx = result.indexOf(close, start + open.length)
    if (closeIdx >= 0) {
      result = result.slice(0, start) + result.slice(closeIdx + close.length)
      continue
    }
    // 未闭合的前导草稿块：若后面还有 JSON 代码块或 <summary>，保留其后内容；
    // 否则整段都是被截断的草稿，丢弃。
    const rest = result.slice(start + open.length)
    const salvageIdx = Math.min(
      ...['```json', '<summary>']
        .map((marker) => rest.indexOf(marker))
        .filter((i) => i >= 0)
        .concat([Number.POSITIVE_INFINITY]),
    )
    result = Number.isFinite(salvageIdx)
      ? result.slice(0, start) + rest.slice(salvageIdx)
      : result.slice(0, start)
    break
  }
  return result
}

function neutralizeSummaryControlTokens(text: string): string {
  // 先替换闭合标记，插入的零宽空格不会被后续替换再次命中。
  const zw = '\u200b'
  return text
    .replace(/<\/summary>/g, `<${zw}/summary>`)
    .replace(/<summary>/g, `<${zw}summary>`)
    .replace(/<\/analysis>/g, `<${zw}/analysis>`)
    .replace(/<analysis>/g, `<${zw}analysis>`)
    .replace(/<\/thinking>/g, `<${zw}/thinking>`)
    .replace(/<thinking>/g, `<${zw}thinking>`)
}

/** 清洗后正文低于最小字符数 → 摘要退化，按瞬时失败重试。 */
function isDegenerateSummary(summaryText: string): boolean {
  return summaryText.replace(/^\[对话摘要\]\s*/, '').trim().length < MIN_SUMMARY_CHARS
}

// ── 摘要失败分类（参考 grok failure.rs）──────────────────────────────────────
// deterministic：重发同一 payload 必然再失败，不重试。
// context_overflow：缩小摘要输入后再试一次。
// transient：5xx/429/408/网络抖动，原样重试一次。

type SummaryFailureKind = 'deterministic' | 'transient' | 'context_overflow'

function isContextLengthError(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('too long for this model') ||
    m.includes('prompt is too long') ||
    m.includes('maximum prompt length') ||
    m.includes('maximum context length') ||
    m.includes('context_length_exceeded') ||
    m.includes('context window') && m.includes('exceed')
}

function classifySummaryFailure(err: unknown): SummaryFailureKind {
  const message = err instanceof Error ? err.message : String(err)
  if (isContextLengthError(message)) return 'context_overflow'
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null
  let status: number | undefined
  for (const candidate of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) { status = candidate; break }
  }
  if (status === undefined) {
    const match = message.match(/\b([45]\d\d)\b/)
    if (match) status = Number(match[1])
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return 'deterministic'
  }
  return 'transient'
}

/** context-overflow 重试前的输入收缩：逐条截头，保留角色结构与开头证据。 */
function shrinkSummaryInputForOverflow(messages: SessionMessage[]): SessionMessage[] {
  return messages.map((msg) => {
    if (msg.content.length <= 400) return msg
    return {
      ...msg,
      content: `${msg.content.slice(0, 280)}\n...[context-overflow 收缩：原始 ${msg.content.length} chars]`,
    }
  })
}

const SUMMARY_PROMPT = `\
请将以下对话历史压缩为结构化摘要。

目标：压缩后接手的 AI 必须能继续当前任务，不误改文件、不丢工具链、不忘验证。

{CURRENT_FOCUS}对话历史：
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
- 不要编造未执行的工具结果或验证结论。
- **如果"当前焦点"部分存在，且历史中出现的某些任务线、文件、模块与当前焦点明显无关（例如属于早已结束的另一项工作），把它们从 current_task/in_progress/next_steps 中移除，只在 critical_context 简短记一笔即可。优先保证当前焦点干净。**`

async function buildStructuredSummary(
  messages: SessionMessage[],
  previousSummary: string | undefined,
  summarize: SummarizeFn,
  currentFocus?: string,
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

  const focusSection = currentFocus
    ? `当前焦点（用户最新消息原文，作为过滤旧任务线的锚点）：\n${currentFocus}\n\n`
    : ''

  const prompt = SUMMARY_PROMPT
    .replace('{HISTORY}', history)
    .replace('{PREV_SUMMARY}', prevSection)
    .replace('{CURRENT_FOCUS}', focusSection)

  const raw = await summarize(prompt)

  // 先剥离前导草稿块，再提取 JSON；两条路径的产物都过控制标记去毒。
  const cleaned = stripLeadingDraftBlocks(String(raw ?? ''))

  // Extract JSON from code block
  const match = cleaned.match(/```json\s*([\s\S]*?)```/)
  if (match?.[1]) {
    try {
      return neutralizeSummaryControlTokens(formatSummary(JSON.parse(match[1]) as Record<string, unknown>))
    } catch { /* fall through to raw */ }
  }

  return neutralizeSummaryControlTokens(`[对话摘要]\n${cleaned.slice(0, 2000)}`)
}

/**
 * buildStructuredSummary 的单次质量守卫（断路器管跨次，这层管单次）：
 * - 退化拒收：清洗后摘要过短 → 按瞬时失败重试一次
 * - 失败分类：4xx（除 408/429）不重试；瞬时失败重试一次；
 *   context-overflow → 收缩摘要输入再试一次
 * 共计最多一次重试；重试后仍不合格则抛给调用方走机械兜底。
 */
async function buildGuardedStructuredSummary(
  messages: SessionMessage[],
  previousSummary: string | undefined,
  summarize: SummarizeFn,
  currentFocus: string | undefined,
  onGuardInfo?: (reason: 'degenerate-retry' | 'transient-retry' | 'overflow-shrink') => void,
): Promise<string> {
  let attemptInput = messages
  let retried = false
  for (;;) {
    let summaryText: string
    try {
      summaryText = await buildStructuredSummary(attemptInput, previousSummary, summarize, currentFocus)
    } catch (err) {
      const kind = classifySummaryFailure(err)
      if (kind === 'deterministic' || retried) throw err
      retried = true
      if (kind === 'context_overflow') {
        attemptInput = shrinkSummaryInputForOverflow(attemptInput)
        onGuardInfo?.('overflow-shrink')
      } else {
        onGuardInfo?.('transient-retry')
      }
      continue
    }
    if (!isDegenerateSummary(summaryText)) return summaryText
    if (retried) {
      throw new Error(`摘要退化：清洗后不足 ${MIN_SUMMARY_CHARS} 字符（重试后仍然过短）`)
    }
    retried = true
    onGuardInfo?.('degenerate-retry')
  }
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
  /**
   * Context window of the model that actually receives the summarization
   * prompt (the worker/specialist model in dual-model setups). The summary
   * INPUT is sized to this, not to the lead model's window — otherwise a
   * small-window worker could be handed a prompt sized for a 1M lead and
   * overflow. Defaults to tokenLimit (single-model: lead == summarizer).
   */
  summarizerTokenLimit?: number
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
  /**
   * Multiplier applied to both microcompact and full-compression triggers,
   * intended to be raised by the circuit breaker when it detects compression
   * churn (3+ compactions with no Edit progress in between). Default 1.0
   * means use the proportional thresholds unchanged. Capped externally.
   */
  churnMultiplier?: number
  /**
   * Latest user message text (truncated). Threaded into the summarizer prompt
   * so the worker model can drop stale task lines that no longer relate to
   * the current focus — solves the "ghost task" problem where previousSummary
   * persists topics indefinitely across many compaction cycles.
   */
  currentFocus?: string
  /** Active UI locale for progress messages. Defaults to 'zh'. */
  locale?: CompressLocale
  /**
   * Provider 上一次请求返回的真实 prompt token 数（已扣除系统段预留、叠加了
   * 本轮新增消息的估算增量）。触发判断优先用真实值，估算只做首轮兜底。
   */
  lastPromptTokens?: number
  /**
   * 压缩前仍在进行的活动状态提醒文本（pendingAction / 运行中后台任务等），
   * 由调用方组装。仅在 full compact 重建结构时作为独立小消息注入 tail 之前，
   * 而不是事后垫尾——摘要/提醒永远不能成为模型看到的“最新用户话语”。
   */
  activeStateReminder?: string
}

export interface CompressResult {
  messages: SessionMessage[]
  compressed: boolean
  summaryText?: string
  tokensBefore: number
  tokensAfter: number
  mode?: 'none' | 'microcompact' | 'full_compact'
  readFileSkeletonsExtracted?: number
  /**
   * full compact 重建结构后，tail 近期原文段在 messages 里的起始下标。
   * 调用方若需追加恢复类消息，应插入到该下标之前（tail 保持在最后），
   * 而不是垫在整个列表末尾。
   */
  tailStartIndex?: number
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

  let fraction = MICROCOMPACT_TRIGGER_FRACTION
  let ceil = MICROCOMPACT_TRIGGER_CEIL

  // Scale triggers and ceilings dynamically for larger context windows
  if (safeLimit >= 500_000) {
    fraction = 0.25 // Allow larger live buffer for 1M+ models
    ceil = 300_000  // Generous ceiling for large models
  } else if (safeLimit >= 250_000) {
    fraction = 0.20
    ceil = 100_000
  }

  const proportional = safeLimit * fraction
  return Math.max(
    MICROCOMPACT_TRIGGER_FLOOR,
    Math.min(Math.floor(proportional), ceil),
  )
}

/**
 * Tail-protect budget: tokens of recent conversation that microcompact must
 * preserve verbatim. Sized so a typical large file read (e.g. 60K tokens)
 * survives at least one round of microcompact on 1M-context models.
 */
export function getTailProtectTokens(tokenLimit: number): number {
  const safeLimit = Number.isFinite(tokenLimit) && tokenLimit > 0 ? tokenLimit : 180_000

  let fraction = TAIL_PROTECT_FRACTION
  let ceil = TAIL_PROTECT_CEIL

  // Generous tail protection for larger context windows
  if (safeLimit >= 500_000) {
    fraction = 0.20 // Protect 20% of context (e.g. 200K tokens for 1M limit)
    ceil = 250_000  // High ceiling so large file reads survive
  } else if (safeLimit >= 250_000) {
    fraction = 0.12
    ceil = 120_000
  }

  const proportional = safeLimit * fraction
  return Math.max(
    TAIL_PROTECT_FLOOR,
    Math.min(Math.floor(proportional), ceil),
  )
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
  locale?: CompressLocale,
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

  let readFileSkeletonsExtracted = 0
  const pruned = messages.map((msg, i) => {
    if (!clearSet.has(i)) return msg
    if (looksLikeToolFailure(msg.content)) {
      return { ...msg, content: msg.content.length <= TOOL_ERROR_KEEP_CHARS ? msg.content : truncateToolFailureContent(msg.content) }
    }
    if (msg.name === 'read_file' || msg.name === 'readfile') {
      readFileSkeletonsExtracted += 1
      return { ...msg, content: extractFileSkeletonFromToolResult(msg) }
    }
    return { ...msg, content: TOOL_RESULT_PLACEHOLDER }
  })

  const tokensAfter = estimateMsgListTokens(pruned)
  if (tokensAfter >= tokensBefore) return null

  onInfo?.(tr(locale,
    `[微压缩·缓存过期] 距上次回复 ${Math.round(gapMinutes)}min，清理 ${clearIndices.length} 条旧工具输出 −${Math.round((tokensBefore - tokensAfter) / 1000)}K，保留最近 ${keepSet.size} 条`,
    `[Micro-compact · cache expired] ${Math.round(gapMinutes)}min since last reply; cleared ${clearIndices.length} old tool outputs −${Math.round((tokensBefore - tokensAfter) / 1000)}K, kept latest ${keepSet.size}`))
  return { messages: pruned, compressed: true, tokensBefore, tokensAfter, mode: 'microcompact', readFileSkeletonsExtracted }
}

export async function compressMessages(
  messages: SessionMessage[],
  summarize: SummarizeFn,
  opts: CompressionOptions = {},
): Promise<CompressResult> {
  const tokenLimit       = opts.tokenLimit       ?? 180_000
  // Window of the model that receives the summary prompt. Falls back to the
  // lead window for single-model setups.
  const summarizerLimit  = Number.isFinite(opts.summarizerTokenLimit) && (opts.summarizerTokenLimit ?? 0) > 0
    ? opts.summarizerTokenLimit!
    : tokenLimit
  const threshold        = opts.threshold        ?? getAdaptiveCompressionThreshold(tokenLimit)
  const protectHead      = opts.protectHead      ?? 3
  // Tail protection now scales with context window. 1M-context sessions get
  // up to 250K tokens of tail safe-zone so freshly-read large files survive.
  const protectTailTok   = opts.protectTailTokens ?? getTailProtectTokens(tokenLimit)
  const previousSummary  = opts.previousSummary
  const onInfo           = opts.onInfo
  const locale           = opts.locale
  const t = (zh: string, en: string): string => tr(locale, zh, en)
  const churnMul         = Number.isFinite(opts.churnMultiplier) && (opts.churnMultiplier ?? 1) >= 1
    ? Math.min(opts.churnMultiplier!, 4.0)
    : 1.0

  const tokensBefore = estimateMsgListTokens(messages)
  // 触发判断优先用 provider 上一次请求的真实 prompt token（调用方已叠加本轮
  // 新增消息的估算增量），估算 tokensBefore 只在首轮没有 usage 时兜底。
  // 缩减率核算（tokensBefore/tokensAfter）保持估算口径，前后一致可比。
  const usedTokens = Number.isFinite(opts.lastPromptTokens) && (opts.lastPromptTokens ?? 0) > 0
    ? opts.lastPromptTokens!
    : tokensBefore

  // ── Time-based microcompact: runs first, short-circuits ───────────────
  // If the gap since the last assistant message exceeds the threshold,
  // the provider-side cache has expired — clear old tool results now.
  const timeBased = maybeTimeBasedMicrocompact(messages, onInfo, locale)
  if (timeBased) return timeBased

  const triggerAt = Math.floor(getCompressionTriggerTokens(tokenLimit, threshold) * churnMul)
  if (!exceedsTokenBudget(usedTokens, triggerAt)) {
    // Keep deterministic tool-output cleanup independent from churn protection.
    // Churn raises full summarization thresholds, but stale tool output pruning
    // should still happen at the model-window-aware microcompact trigger.
    const microcompactAt = getMicrocompactTriggerTokens(tokenLimit)
    if (exceedsTokenBudget(usedTokens, microcompactAt)) {
      // Protect tail by token budget instead of fixed message count.
      // Tail size is proportional to context window (see getTailProtectTokens).
      const tailBudget = protectTailTok
      let tailProtectTokens = 0
      let protectedFromIdx = messages.length
      for (let i = messages.length - 1; i >= 0; i--) {
        tailProtectTokens += estimateMessageTokens(messages[i]!)
        if (tailProtectTokens > tailBudget) { protectedFromIdx = i + 1; break }
      }
      protectedFromIdx = Math.max(0, protectedFromIdx)
      const prunedResult = pruneToolResults(messages, protectedFromIdx)
      const tokensAfter = estimateMsgListTokens(prunedResult.messages)
      if (tokensAfter < tokensBefore) {
        onInfo?.(t(
          `[微压缩] 清理旧工具输出 ${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K，保留近期 ${Math.round(tailProtectTokens / 1000)}K 原文`,
          `[Micro-compact] Cleared old tool outputs ${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K, kept recent ${Math.round(tailProtectTokens / 1000)}K verbatim`))
        return {
          messages: prunedResult.messages,
          compressed: true,
          tokensBefore,
          tokensAfter,
          mode: 'microcompact',
          readFileSkeletonsExtracted: prunedResult.readFileSkeletonsExtracted,
        }
      }
    }
    return { messages, compressed: false, tokensBefore, tokensAfter: tokensBefore, mode: 'none' }
  }

  // Compression triggered — surface to user. Without this, the previous
  // silent operation made it look like long sessions never compressed.
  const triggerPct = Math.round((usedTokens / tokenLimit) * 100)
  onInfo?.(t(
    `[压缩] 上下文 ${Math.round(usedTokens / 1000)}K（已占 ${triggerPct}% 窗口），开始压缩…`,
    `[Compact] Context ${Math.round(usedTokens / 1000)}K (${triggerPct}% of window); starting…`))

  // ── Phase 2: determine boundaries ────────────────────────────────────────
  let headEnd = Math.min(protectHead, messages.length)

  let tailStart = messages.length
  let tailTokens = 0
  for (let i = messages.length - 1; i >= headEnd; i--) {
    const t = estimateMessageTokens(messages[i]!)
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
    const prunedResult = pruneToolResults(messages, tailStart)
    const tokensAfter = estimateMsgListTokens(prunedResult.messages)
    onInfo?.(t(
      `[压缩] 历史较短，仅清理工具输出 ${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K`,
      `[Compact] Short history; pruned tool outputs only ${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K`))
    return {
      messages: prunedResult.messages,
      compressed: true,
      tokensBefore,
      tokensAfter,
      mode: 'microcompact',
      readFileSkeletonsExtracted: prunedResult.readFileSkeletonsExtracted,
    }
  }

  // ── Phase 1 on middle: prune tool results ─────────────────────────────────
  const prunedMiddleResult = pruneToolResults(middle, middle.length)
  let prunedMiddle = prunedMiddleResult.messages
  onInfo?.(t(
    `[压缩] 整理历史中段（${middle.length} 条消息）…`,
    `[Compact] Consolidating mid-history (${middle.length} messages)…`))

  // ── Phase 5: prepare summary input without dropping critical evidence ──────
  const beforeSummaryTokens = estimateMsgListTokens(prunedMiddle)
  // Size the summary input to the SUMMARIZER's window, not the lead's.
  prunedMiddle = prepareMiddleForStructuredSummary(prunedMiddle, summarizerLimit)
  const afterSummaryTokens = estimateMsgListTokens(prunedMiddle)
  if (afterSummaryTokens < beforeSummaryTokens) {
    onInfo?.(t(
      `[压缩] 精简摘要输入 ${Math.round(beforeSummaryTokens / 1000)}K → ${Math.round(afterSummaryTokens / 1000)}K（保留用户约束与工具证据）`,
      `[Compact] Trimmed summary input ${Math.round(beforeSummaryTokens / 1000)}K → ${Math.round(afterSummaryTokens / 1000)}K (kept user constraints & tool evidence)`))
  }

  // ── Phase 3: LLM summarize ────────────────────────────────────────────────
  let summaryText: string
  try {
    onInfo?.(t(
      `[压缩] 副模型生成结构化摘要…`,
      `[Compact] Worker model generating structured summary…`))
    summaryText = await buildGuardedStructuredSummary(
      prunedMiddle,
      previousSummary,
      summarize,
      opts.currentFocus,
      (reason) => {
        if (reason === 'degenerate-retry') {
          onInfo?.(t('[压缩] 摘要过短疑似退化，重试一次…', '[Compact] Summary degenerate (too short); retrying once…'))
        } else if (reason === 'overflow-shrink') {
          onInfo?.(t('[压缩] 摘要输入超窗，收缩后重试一次…', '[Compact] Summary input overflowed; shrinking and retrying once…'))
        } else {
          onInfo?.(t('[压缩] 摘要瞬时失败，重试一次…', '[Compact] Summary hit a transient failure; retrying once…'))
        }
      },
    )
  } catch (err) {
    // If summarization fails, fall back to Phase 1 only — surface why so
    // user can debug (was silent before, often masking provider auth errors).
    const msg = err instanceof Error ? err.message : String(err)
    onInfo?.(t(
      `[压缩] 摘要失败，改为清理工具输出：${msg}`,
      `[Compact] Summary failed; falling back to tool-output pruning: ${msg}`))
    const prunedResult = pruneToolResults(messages, tailStart)
    const tokensAfter = estimateMsgListTokens(prunedResult.messages)
    onInfo?.(t(
      `[压缩] 已清理 ${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K`,
      `[Compact] Pruned ${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K`))
    return {
      messages: prunedResult.messages,
      compressed: true,
      tokensBefore,
      tokensAfter,
      mode: 'microcompact',
      readFileSkeletonsExtracted: prunedResult.readFileSkeletonsExtracted,
    }
  }

  // ── Phase 4: assemble fixed structure ────────────────────────────────────
  // [head 保留段, 摘要, 最后一条真实用户请求原文（若落在 middle）,
  //  活动状态 reminder, tail 近期原文]
  // 原则：摘要永远不能是模型看到的“最新用户话语”。最后一条真实用户请求以
  // 原文消息注入（不依赖摘要转述）；若它已在 head/tail 保留段里则不重复注入。
  const summaryMsg: SessionMessage = {
    id:        `ctx-summary-${Date.now()}`,
    role:      'user',
    content:   `[系统：以下是对话历史的压缩摘要，请基于此继续]\n\n${summaryText}\n\n[系统：摘要结束，以下是近期对话原文]`,
    createdAt: new Date().toISOString(),
  }

  const assembled: SessionMessage[] = [...head, summaryMsg]

  const lastUserIdx = findLastRealUserMessageIndex(messages)
  if (lastUserIdx >= headEnd && lastUserIdx < tailStart) {
    // 原文注入设体量上限：超长的用户消息保头尾+截断标记，否则单条巨型消息
    // 会吃掉全部压缩收益，被下方收益闸整体否决，压缩永远白做。
    const original = messages[lastUserIdx]!
    const content = typeof original.content === 'string' ? original.content : ''
    if (content.length > LAST_USER_INJECT_MAX_CHARS) {
      const half = Math.floor(LAST_USER_INJECT_MAX_CHARS / 2)
      assembled.push({
        ...original,
        content: `${content.slice(0, half)}\n[…原文过长已截断，完整内容见上方摘要…]\n${content.slice(-half)}`,
      })
    } else {
      assembled.push({ ...original })
    }
  }

  const reminderText = opts.activeStateReminder?.trim()
  if (reminderText) {
    assembled.push({
      id: `recovery-state-${Date.now()}`,
      role: 'user',
      content: reminderText,
      createdAt: new Date().toISOString(),
    })
  }

  const tailStartIndex = assembled.length
  const result = [...assembled, ...tail]
  const tokensAfter = estimateMsgListTokens(result)

  // ── 收益闸（参考 grok max_reduction_ratio = 0.8）─────────────────────────
  // 压缩后达不到压缩前 80% 以下（缩减 < 20%）说明本次压缩不值得：丢弃结果、
  // 维持原历史并记录。断路器管跨次失败，这道闸管单次收益。
  if (tokensAfter > tokensBefore * (1 - MIN_COMPACTION_REDUCTION)) {
    onInfo?.(t(
      `[压缩] 收益不足（${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K，缩减 <${Math.round(MIN_COMPACTION_REDUCTION * 100)}%），丢弃本次压缩结果`,
      `[Compact] Insufficient reduction (${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K, <${Math.round(MIN_COMPACTION_REDUCTION * 100)}%); discarding this compaction`))
    return { messages, compressed: false, tokensBefore, tokensAfter: tokensBefore, mode: 'none' }
  }

  const reductionPct = Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 100)
  onInfo?.(t(
    `[压缩] ✓ 完成 ${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K，节省 ${reductionPct}%`,
    `[Compact] ✓ Done ${Math.round(tokensBefore / 1000)}K → ${Math.round(tokensAfter / 1000)}K, saved ${reductionPct}%`))
  return {
    messages: result,
    compressed: true,
    summaryText,
    tokensBefore,
    tokensAfter,
    mode: 'full_compact',
    readFileSkeletonsExtracted: prunedMiddleResult.readFileSkeletonsExtracted,
    tailStartIndex,
  }
}
