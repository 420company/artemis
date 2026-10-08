/**
 * Tier 2 summarization: fold old history into a structured, rolling summary.
 *
 * The summarizer model sees the previous summary plus the messages being
 * folded in, with full content and tool-call arguments. When that does not
 * fit the summarizer's own window, the messages are split into chunks and
 * folded in order (each call updates the summary produced by the previous
 * one). The output is Markdown with fixed sections, written in the
 * conversation's language.
 */

import { readFileSync, statSync } from 'node:fs'
import type { SessionMessage } from '../types.js'
import { estimateTokens } from '../tokenEstimation.js'
import type { ConversationLanguage } from './language.js'
import { isSyntheticUserMessage } from './language.js'
import {
  buildToolCallIndex,
  describeToolResult,
  parseToolContent,
  summarizeToolArgs,
  type ToolCallInfo,
} from './toolResults.js'

export type SummarizerRequest = {
  system: string
  prompt: string
}

/** Calls a model with a system and a user prompt and returns its text. */
export type SummarizeFn = (request: SummarizerRequest) => Promise<string>

export type SummaryResult = {
  summary: string
  calls: number
  chunks: number
}

const SECTION_TITLES: Record<ConversationLanguage, string[]> = {
  en: [
    'Goals and latest instructions',
    'Decisions and reasons',
    'Files and artifacts',
    'Facts, errors and fixes',
    'User preferences and corrections',
    'Completed work',
    'Pending tasks and next step',
    'Things the user asked to remember',
  ],
  zh: [
    '目标与最新指令',
    '决策与理由',
    '文件与产物',
    '事实、错误与修复',
    '用户偏好与纠正',
    '已完成的工作',
    '待办任务与下一步',
    '用户要求记住的事项',
  ],
}

const SECTION_GUIDE: Record<ConversationLanguage, string[]> = {
  en: [
    "The user's overall goal and every instruction still in force, newest last. Quote short instructions verbatim.",
    'Each decision taken and the reason for it, including approaches rejected and why.',
    'Every file path, directory, URL, command, branch, or artifact created, read or changed, with what changed. Keep paths exact.',
    'Facts learned, errors seen (exact message), their causes and the fixes applied; anything still broken.',
    'Preferences, constraints and corrections the user stated (style, language, tools, things not to do).',
    'Work that is finished and verified, with how it was verified.',
    'Open tasks, work in progress, and the single next step the agent was about to take.',
    'Anything the user explicitly asked to remember, verbatim.',
  ],
  zh: [
    '用户的总体目标，以及仍然有效的每一条指令（最新的放最后）。较短的指令原文引用。',
    '做出的每个决策及其理由，包括被否决的方案和原因。',
    '创建、读取或修改过的每个文件路径、目录、URL、命令、分支或产物，以及改了什么。路径必须原样保留。',
    '确认的事实、遇到的错误（原文）、原因和已采取的修复；仍未解决的问题。',
    '用户提出的偏好、约束和纠正（风格、语言、工具、不要做的事）。',
    '已经完成并验证的工作，以及验证方式。',
    '未完成的任务、进行中的工作，以及接下来要执行的下一步。',
    '用户明确要求记住的内容，原文保留。',
  ],
}

export function summarySectionTitles(language: ConversationLanguage): string[] {
  return [...SECTION_TITLES[language]]
}

function buildSystemPrompt(language: ConversationLanguage): string {
  if (language === 'zh') {
    return [
      '你负责压缩一段用户与 AI 代理之间的长对话，让代理在小得多的上下文里无缝继续工作。',
      '必须忠实：不得编造事实、工具结果、文件内容或验证结论。',
      '用中文书写摘要（代码、路径、命令、报错保持原文）。',
    ].join('\n')
  }
  return [
    'You compact a long conversation between a user and an AI agent so the agent can continue the same work with a much smaller context.',
    'Be faithful: never invent facts, tool results, file contents or verification outcomes.',
    "Write the summary in the user's language (keep code, paths, commands and error messages verbatim).",
  ].join('\n')
}

function buildInstructions(language: ConversationLanguage, maxTokens: number, hasPrevious: boolean): string {
  const titles = SECTION_TITLES[language]
  const guide = SECTION_GUIDE[language]
  const sections = titles.map((title, i) => `## ${i + 1}. ${title}\n${guide[i]}`).join('\n')
  if (language === 'zh') {
    return [
      hasPrevious
        ? '请把 <new_messages> 中的内容合并进 <previous_summary>，输出一份完整的新摘要（它将完全替代旧摘要）。'
        : '请把 <new_messages> 中的对话总结成摘要。',
      '只输出摘要本身，使用 Markdown，并且严格使用以下 8 个小节（没有内容的小节写“无”）：',
      sections,
      '规则：',
      '- 原样保留标识符：文件路径、函数名、命令、报错信息、数字、ID、URL。',
      '- 旧摘要中仍然相关的内容必须保留；只删除明确过时或被取代的内容。',
      '- 如果用户后来改变了方向，以最新指令为准，并注明旧方向已放弃。',
      '- 工具结果被清除或截断时，写明完整输出所在的文件路径。',
      `- 摘要长度不超过约 ${maxTokens} tokens。`,
    ].join('\n')
  }
  return [
    hasPrevious
      ? 'Merge everything in <new_messages> into <previous_summary> and output one complete new summary (it replaces the old one entirely).'
      : 'Summarize the conversation in <new_messages>.',
    'Output only the summary, in Markdown, using exactly these 8 sections (write "none" for an empty section):',
    sections,
    'Rules:',
    '- Keep identifiers exact: file paths, function names, commands, error messages, numbers, IDs, URLs.',
    '- Keep everything from the previous summary that is still relevant; drop only what is clearly obsolete or superseded.',
    '- If the user changed direction, the latest instruction wins; note that the earlier direction was dropped.',
    '- When a tool result was cleared or truncated, record the file path where its full output lives.',
    `- Keep the summary under about ${maxTokens} tokens.`,
  ].join('\n')
}

/** Per-message caps for the summarizer input. They only bound pathological sizes. */
const USER_MESSAGE_CAP_TOKENS = 8_000
const ASSISTANT_MESSAGE_CAP_TOKENS = 4_000
const TOOL_RESULT_CAP_TOKENS = 2_500
const TOOL_ARGS_CAP_TOKENS = 1_200
const CLEARED_REHYDRATE_MAX_BYTES = 2_000_000

/** Head and tail of `text` within `tokens`, with a marker in between. */
export function capText(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text
  // Characters per token in this text, so CJK and ASCII both land near budget.
  const ratio = text.length / Math.max(1, estimateTokens(text))
  const keep = Math.max(200, Math.floor(tokens * ratio))
  const head = text.slice(0, Math.floor(keep * 0.7))
  const tail = text.slice(text.length - Math.floor(keep * 0.3))
  return `${head}\n… [${(text.length - head.length - tail.length).toLocaleString('en-US')} chars omitted] …\n${tail}`
}

function readCleared(message: SessionMessage): string | undefined {
  const savedTo = message.contextCleared?.savedTo
  if (!savedTo) return undefined
  try {
    if (statSync(savedTo).size > CLEARED_REHYDRATE_MAX_BYTES) return undefined
    return readFileSync(savedTo, 'utf8')
  } catch {
    return undefined
  }
}

function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  return iso.replace('T', ' ').slice(0, 16)
}

/** One message as summarizer input text. */
export function serializeMessageForSummary(
  message: SessionMessage,
  ordinal: number,
  callIndex: Map<string, ToolCallInfo>,
): string {
  const time = formatTime(message.createdAt)
  if (message.role === 'tool') {
    const { name, args } = describeToolResult(message, callIndex)
    // Cleared results are re-read from disk so the summarizer still sees them.
    const original = readCleared(message)
    const content = original ?? message.content ?? ''
    const parsed = parseToolContent(content)
    const status = parsed.ok === false ? ' · FAILED' : ''
    const error = parsed.ok === false && parsed.errorMessage ? `\nerror: ${parsed.errorMessage}` : ''
    const body = capText(parsed.envelope ? parsed.output : content, TOOL_RESULT_CAP_TOKENS)
    const savedNote = message.contextCleared?.savedTo ? `\n(full output: ${message.contextCleared.savedTo})` : ''
    return `--- #${ordinal} tool result · ${name}${args ? ` ${args}` : ''}${status} ---${error}\n${body}${savedNote}`
  }
  if (message.role === 'assistant') {
    const parts = [`--- #${ordinal} assistant${time ? ` · ${time}` : ''} ---`]
    if (message.content?.trim()) parts.push(capText(message.content, ASSISTANT_MESSAGE_CAP_TOKENS))
    for (const call of message.toolCalls ?? []) {
      parts.push(`[tool call ${call.name}] ${capText(call.arguments ?? '', TOOL_ARGS_CAP_TOKENS)}`)
    }
    if (!message.toolCalls?.length) {
      for (const block of message.rawContentBlocks ?? []) {
        const b = block as { type?: string; name?: string; input?: unknown }
        if (b?.type === 'tool_use') {
          parts.push(`[tool call ${b.name ?? 'tool'}] ${capText(summarizeToolArgs(b.input as Record<string, unknown>, 2_000), TOOL_ARGS_CAP_TOKENS)}`)
        }
      }
    }
    return parts.join('\n')
  }
  if (message.role === 'system') {
    return `--- #${ordinal} system note ---\n${capText(message.content ?? '', ASSISTANT_MESSAGE_CAP_TOKENS)}`
  }
  const label = isSyntheticUserMessage(message) ? 'runtime note' : 'user'
  return `--- #${ordinal} ${label}${time ? ` · ${time}` : ''} ---\n${capText(message.content ?? '', USER_MESSAGE_CAP_TOKENS)}`
}

/** Split a long text into pieces of at most `tokens` each. */
function splitText(text: string, tokens: number): string[] {
  const ratio = text.length / Math.max(1, estimateTokens(text))
  const size = Math.max(500, Math.floor(tokens * ratio))
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size))
  return pieces
}

/** Pack serialized messages into chunks of at most `chunkTokens`. */
export function chunkSerializedMessages(serialized: readonly string[], chunkTokens: number): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let used = 0
  const flush = (): void => {
    if (current.length > 0) chunks.push(current.join('\n\n'))
    current = []
    used = 0
  }
  for (const item of serialized) {
    const cost = estimateTokens(item) + 2
    if (cost > chunkTokens) {
      flush()
      for (const piece of splitText(item, chunkTokens)) chunks.push(piece)
      continue
    }
    if (used + cost > chunkTokens) flush()
    current.push(item)
    used += cost
  }
  flush()
  return chunks
}

/** Strip leading <analysis>/<thinking> drafts some models emit before the answer. */
export function cleanSummaryOutput(raw: string): string {
  let text = String(raw ?? '').trim()
  for (;;) {
    const match = text.match(/^<(analysis|thinking)>[\s\S]*?<\/\1>\s*/)
    if (!match) break
    text = text.slice(match[0].length)
  }
  const wrapped = text.match(/^<summary>([\s\S]*?)<\/summary>\s*$/)
  if (wrapped) text = wrapped[1]!.trim()
  return text.trim()
}

const MIN_SUMMARY_CHARS = 40

async function callWithRetry(summarize: SummarizeFn, request: SummarizerRequest): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const output = cleanSummaryOutput(await summarize(request))
      if (output.length >= MIN_SUMMARY_CHARS) return output
      lastError = new Error(`summary too short (${output.length} chars)`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export type SummarizeHistoryInput = {
  summarize: SummarizeFn
  messages: readonly SessionMessage[]
  previousSummary?: string
  /** Latest real user message, passed verbatim as the focus anchor. */
  latestUserMessage?: string
  language: ConversationLanguage
  /** Context window of the summarizer model. */
  summarizerWindow: number
  /** Requested summary size. */
  maxSummaryTokens: number
  /** Upper bound on summarizer calls; older chunks are digested mechanically. */
  maxCalls?: number
  /** All history messages, used to resolve tool-call arguments for results. */
  allMessages?: readonly SessionMessage[]
}

/**
 * Fold `messages` into `previousSummary` with the summarizer model.
 * Throws when the summarizer fails (after one retry per call).
 */
export async function summarizeHistory(input: SummarizeHistoryInput): Promise<SummaryResult> {
  const callIndex = buildToolCallIndex(input.allMessages ?? input.messages)
  const serialized = input.messages.map((message, i) => serializeMessageForSummary(message, i + 1, callIndex))
  const system = buildSystemPrompt(input.language)
  const latest = input.latestUserMessage ? capText(input.latestUserMessage, 2_000) : undefined

  // Room left for messages in one call: the summarizer's window minus the
  // instructions, the running summary, the focus anchor and the output.
  const fixed = estimateTokens(system)
    + estimateTokens(buildInstructions(input.language, input.maxSummaryTokens, true))
    + (latest ? estimateTokens(latest) : 0)
    + 400
  const runningSummaryAllowance = Math.max(estimateTokens(input.previousSummary ?? ''), Math.ceil(input.maxSummaryTokens * 1.3))
  const usable = Math.floor(input.summarizerWindow * 0.7) - fixed - runningSummaryAllowance - Math.ceil(input.maxSummaryTokens * 1.5)
  const chunkTokens = Math.max(2_000, usable)
  let chunks = chunkSerializedMessages(serialized, chunkTokens)

  let previous = input.previousSummary?.trim() || undefined
  const maxCalls = Math.max(1, input.maxCalls ?? 8)
  if (chunks.length > maxCalls) {
    // Too much for a bounded number of calls (a very large legacy session):
    // the oldest part is digested mechanically and fed in as prior context.
    const overflow = chunks.length - maxCalls
    const olderMessages = input.messages.slice(0, Math.floor(input.messages.length * (overflow / chunks.length)))
    const digest = buildMechanicalSummary({
      messages: olderMessages,
      previousSummary: previous,
      language: input.language,
      maxTokens: Math.min(input.maxSummaryTokens, Math.floor(chunkTokens / 2)),
      reason: input.language === 'zh' ? '历史过长，较早部分为机械摘要' : 'history too long; older part digested mechanically',
    })
    previous = digest
    const keptSerialized = serialized.slice(olderMessages.length)
    chunks = chunkSerializedMessages(keptSerialized, chunkTokens).slice(-maxCalls)
  }

  let calls = 0
  for (const chunk of chunks) {
    const prompt = [
      previous ? `<previous_summary>\n${previous}\n</previous_summary>` : '',
      `<new_messages>\n${chunk}\n</new_messages>`,
      latest ? `<latest_user_message>\n${latest}\n</latest_user_message>` : '',
      buildInstructions(input.language, input.maxSummaryTokens, Boolean(previous)),
    ].filter(Boolean).join('\n\n')
    previous = await callWithRetry(input.summarize, { system, prompt })
    calls += 1
  }
  return { summary: previous ?? '', calls, chunks: chunks.length }
}

const FILE_TOOL_HINT = /(read|write|edit|replace|insert|patch|create|delete|move|copy|file)/i

/** Paths named in tool calls and tool-result envelopes, oldest first, unique. */
export function collectReferencedPaths(messages: readonly SessionMessage[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 300 || trimmed.includes('\n')) return
    seen.delete(trimmed)
    seen.add(trimmed)
  }
  const fromArgs = (record: Record<string, unknown> | undefined): void => {
    if (!record) return
    for (const key of ['path', 'file_path', 'filePath', 'target', 'targetFile', 'destination', 'source']) add(record[key])
    if (Array.isArray(record.paths)) for (const p of record.paths) add(p)
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (!FILE_TOOL_HINT.test(call.name)) continue
        try { fromArgs(JSON.parse(call.arguments) as Record<string, unknown>) } catch { /* ignore */ }
      }
    } else if (message.role === 'tool') {
      const parsed = parseToolContent(message.content ?? '')
      const type = typeof parsed.action?.type === 'string' ? parsed.action.type : message.name ?? ''
      if (FILE_TOOL_HINT.test(type)) fromArgs(parsed.action)
      if (typeof parsed.envelope?.path === 'string') add(parsed.envelope.path)
    }
  }
  for (const value of seen) ordered.push(value)
  return ordered
}

export type MechanicalSummaryInput = {
  messages: readonly SessionMessage[]
  previousSummary?: string
  language: ConversationLanguage
  maxTokens: number
  reason: string
}

/**
 * Deterministic summary used when the summarizer fails or is unavailable:
 * the previous summary, the user's messages (newest kept first when space
 * runs out), files and commands seen, and the last assistant notes.
 * Always fits `maxTokens`.
 */
export function buildMechanicalSummary(input: MechanicalSummaryInput): string {
  const zh = input.language === 'zh'
  const header = zh
    ? `[机械摘要——摘要模型不可用（${input.reason}）。细节可能缺失；需要时请查阅归档的完整记录。]`
    : `[Mechanical summary — the summarizer was unavailable (${input.reason}). Details may be missing; consult the archived transcript when needed.]`
  const budget = Math.max(200, input.maxTokens)
  const parts: string[] = [header]
  let used = estimateTokens(header)

  const prev = input.previousSummary?.trim()
  if (prev) {
    const title = zh ? '## 之前的摘要' : '## Previous summary'
    const capped = capText(prev, Math.floor(budget * 0.45))
    parts.push(`${title}\n${capped}`)
    used += estimateTokens(capped) + 8
  }

  const userLines: string[] = []
  const assistantLines: string[] = []
  for (const message of input.messages) {
    if (message.role === 'user' && !isSyntheticUserMessage(message) && message.content?.trim()) {
      userLines.push(`- [${formatTime(message.createdAt)}] ${capText(message.content.trim(), 220).replace(/\s*\n\s*/g, ' ⏎ ')}`)
    } else if (message.role === 'assistant' && message.content?.trim()) {
      assistantLines.push(`- ${capText(message.content.trim(), 160).replace(/\s*\n\s*/g, ' ⏎ ')}`)
    }
  }
  const paths = collectReferencedPaths(input.messages).slice(-40)

  const pathsBlock = paths.length > 0
    ? `${zh ? '## 涉及的文件' : '## Files referenced'}\n${paths.map((p) => `- ${p}`).join('\n')}`
    : ''
  const lastNotes = assistantLines.slice(-3)
  const notesBlock = lastNotes.length > 0
    ? `${zh ? '## 最近的助手进展' : '## Last assistant notes'}\n${lastNotes.join('\n')}`
    : ''
  const reserved = estimateTokens(pathsBlock) + estimateTokens(notesBlock) + 16
  const userBudget = Math.max(0, budget - used - reserved)

  // Newest user messages are the most relevant; keep as many as fit, in order.
  const keptUsers: string[] = []
  let userUsed = 0
  for (let i = userLines.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(userLines[i]!) + 1
    if (userUsed + cost > userBudget) break
    keptUsers.unshift(userLines[i]!)
    userUsed += cost
  }
  if (keptUsers.length > 0) {
    const omitted = userLines.length - keptUsers.length
    const title = zh ? '## 用户消息（按时间顺序，已截断）' : '## User messages (oldest first, truncated)'
    const note = omitted > 0 ? (zh ? `\n（更早的 ${omitted} 条未列出）` : `\n(${omitted} older messages not listed)`) : ''
    parts.push(`${title}${note}\n${keptUsers.join('\n')}`)
  }
  if (pathsBlock && estimateTokens(parts.join('\n\n')) + estimateTokens(pathsBlock) <= budget) parts.push(pathsBlock)
  if (notesBlock && estimateTokens(parts.join('\n\n')) + estimateTokens(notesBlock) <= budget) parts.push(notesBlock)
  return capText(parts.join('\n\n'), budget)
}
