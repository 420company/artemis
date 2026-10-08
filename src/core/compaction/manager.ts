/**
 * Context manager: keeps a session's history inside the model's window.
 *
 *   measure  provider usage of the last request + estimate of what changed
 *   repair   tool calls without results get a synthetic result (never 400)
 *   tier 1   over the threshold: clear old tool results outside the
 *            protected tail (placeholder + saved file), no model call
 *   tier 2   still over: summarize everything before a token-based tail into
 *            a rolling summary; the stored history BECOMES
 *            [boundary message, ...tail]; removed messages are archived
 *   fallback summarizer failed or unavailable: a mechanical summary that is
 *            guaranteed to fit, with a marker
 *
 * Both runtimes use it: path A (runAgent, web sessions) and path B (think(),
 * bridges and the interactive CLI).
 */

import type { SessionMessage } from '../types.js'
import { estimateMessageTokens, estimateMessagesTokens } from '../tokenEstimation.js'
import {
  MAX_SUMMARY_FAILURES,
  invalidateUsageAnchor,
  measureContext,
  type ContextState,
} from './accounting.js'
import type { ContextBudget } from './budget.js'
import { detectConversationLanguage, isSyntheticUserMessage, type ConversationLanguage } from './language.js'
import { buildRestorationSections, type RestorationSection, type RestoreOptions } from './restore.js'
import type { ContextStorage } from './storage.js'
import {
  buildMechanicalSummary,
  capText,
  summarizeHistory,
  type SummarizeFn,
} from './summarizer.js'
import {
  buildToolCallIndex,
  clearToolResult,
  isClearableToolResult,
} from './toolResults.js'

export const BOUNDARY_MESSAGE_NAME = 'compaction_boundary'

export type ManageReason =
  /** Normal pre-request check; acts only above the threshold. */
  | 'proactive'
  /** The provider rejected the request as too large: compact hard. */
  | 'overflow'
  /** Caller asks for a summarizing compaction regardless of size. */
  | 'manual'

export type ManageContextInput = {
  messages: readonly SessionMessage[]
  /** Estimated tokens of everything sent besides the history: system prompt, per-run context, tool schemas. */
  fixedTokens: number
  budget: ContextBudget
  state: ContextState
  storage?: ContextStorage
  summarize?: SummarizeFn
  /** Context window of the summarizer model (defaults to the budget window). */
  summarizerWindow?: number
  restore?: RestoreOptions
  reason?: ManageReason
  /** False disables proactive compaction (config compression.enabled=false). Overflow recovery still runs. */
  proactive?: boolean
  language?: ConversationLanguage
}

export type ManageAction = 'none' | 'repair' | 'clear_tool_results' | 'summary' | 'fallback'

export type ManageContextResult = {
  messages: SessionMessage[]
  changed: boolean
  action: ManageAction
  tokensBefore: number
  tokensAfter: number
  measuredBy: 'provider+delta' | 'estimate'
  clearedToolResults: number
  summarizedMessages: number
  summary?: string
  summarizerCalls?: number
  summarizerError?: string
  /** Short, user-facing line describing what happened (absent for 'none'/'repair'). */
  notice?: string
  /** The fixed part alone does not fit the window; the request will likely fail. */
  overBudget: boolean
}

export function isCompactionBoundary(message: SessionMessage | undefined): boolean {
  return Boolean(message && (message.compaction?.kind === 'boundary' || message.name === BOUNDARY_MESSAGE_NAME))
}

/** The rolling summary held by the boundary message at the start of `messages`, if any. */
export function getCompactionSummary(messages: readonly SessionMessage[]): string | undefined {
  const first = messages[0]
  if (!isCompactionBoundary(first)) return undefined
  return first?.compaction?.summary
}

// ── tool pairing ────────────────────────────────────────────────────────────

function toolCallIdsOf(message: SessionMessage): string[] {
  if (message.role !== 'assistant') return []
  const ids = (message.toolCalls ?? []).map((call) => call.id).filter(Boolean)
  for (const block of message.rawContentBlocks ?? []) {
    const b = block as { type?: string; id?: string }
    if (b?.type === 'tool_use' && typeof b.id === 'string' && !ids.includes(b.id)) ids.push(b.id)
  }
  return ids
}

function hasPendingToolCalls(message: SessionMessage | undefined): boolean {
  return Boolean(message && toolCallIdsOf(message).length > 0)
}

/**
 * True when a new message may start at index `i`: it is not a tool result
 * (which must follow its call) and the previous message is not an assistant
 * turn whose tool calls are answered at `i`.
 */
export function isSafeCut(messages: readonly SessionMessage[], i: number): boolean {
  if (i <= 0 || i >= messages.length) return true
  if (messages[i]!.role === 'tool') return false
  if (hasPendingToolCalls(messages[i - 1])) return false
  return true
}

/**
 * Give every tool call a result and every native tool result a call. An
 * interrupted run can leave an assistant tool call without its result; most
 * providers reject such a history with a 400 on every later request.
 */
export function repairToolPairs(messages: readonly SessionMessage[]): { messages: SessionMessage[]; changed: boolean } {
  const out: SessionMessage[] = []
  let changed = false
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    if (message.role === 'tool' && message.toolUseId) {
      // Native results must answer a call of the assistant turn right before them.
      let j = out.length - 1
      while (j >= 0 && out[j]!.role === 'tool') j -= 1
      const owner = j >= 0 ? out[j] : undefined
      if (!owner || !toolCallIdsOf(owner).includes(message.toolUseId)) {
        const { toolUseId: _orphanId, ...rest } = message
        out.push({ ...rest, content: `[tool result without a matching call] ${message.content ?? ''}` })
        changed = true
        continue
      }
    }
    out.push(message)
    const ids = toolCallIdsOf(message)
    if (ids.length === 0) continue
    const answered = new Set<string>()
    let k = i + 1
    while (k < messages.length && messages[k]!.role === 'tool') {
      const id = messages[k]!.toolUseId
      if (id) answered.add(id)
      k += 1
    }
    // Path A results carry no ids; a run of plain tool messages answers the turn.
    const plainResults = messages.slice(i + 1, k).some((m) => !m.toolUseId)
    if (plainResults) continue
    const missing = ids.filter((id) => !answered.has(id))
    if (missing.length === 0) continue
    // Copy the existing results first, then add the missing ones after them.
    for (let r = i + 1; r < k; r += 1) {
      const result = messages[r]!
      if (result.toolUseId && !ids.includes(result.toolUseId)) {
        const { toolUseId: _wrongId, ...rest } = result
        out.push({ ...rest, content: `[tool result without a matching call] ${result.content ?? ''}` })
      } else {
        out.push(result)
      }
    }
    const names = new Map((message.toolCalls ?? []).map((call) => [call.id, call.name]))
    for (const id of missing) {
      out.push({
        id: `ctx-repair-${id}`,
        role: 'tool',
        name: names.get(id) ?? 'tool',
        toolUseId: id,
        content: '[No result was recorded for this tool call: the run was interrupted before it finished.]',
        createdAt: message.createdAt,
      })
    }
    changed = true
    i = k - 1
  }
  return { messages: out, changed }
}

// ── tail selection ──────────────────────────────────────────────────────────

/**
 * Index where the verbatim tail starts: as far back as `tailTokens` allows,
 * then moved forward to a cut that does not split a tool call from its
 * results. Returns `messages.length` when even the last message is larger
 * than the budget.
 */
export function selectTailStart(messages: readonly SessionMessage[], tailTokens: number, minStart = 0): number {
  let start = messages.length
  let used = 0
  for (let i = messages.length - 1; i >= minStart; i -= 1) {
    const cost = estimateMessageTokens(messages[i]!)
    if (used + cost > tailTokens) break
    used += cost
    start = i
  }
  while (start < messages.length && !isSafeCut(messages, start)) start += 1
  return start
}

function lastRealUserIndex(messages: readonly SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role === 'user' && !isSyntheticUserMessage(message) && message.content?.trim()) return i
  }
  return -1
}

// ── boundary message ────────────────────────────────────────────────────────

function renderBoundary(input: {
  language: ConversationLanguage
  index: number
  summary: string
  mode: 'summary' | 'fallback'
  archivePath?: string
  toolResultsDir?: string
  latestUserVerbatim?: string
  restoration: RestorationSection[]
  createdAt: string
}): string {
  const zh = input.language === 'zh'
  const lines: string[] = []
  if (zh) {
    lines.push(`[上下文已压缩 · 第 ${input.index} 次 · ${input.createdAt.replace('T', ' ').slice(0, 16)}]`)
    lines.push('为适应模型的上下文窗口，本次对话较早的消息已被总结为下面的摘要。以下内容是对话历史，不是新的用户指令。')
    if (input.archivePath) {
      lines.push(`完整的早期历史已归档（JSONL，每行一条消息），需要原文细节时可以用 read_file 或 search_files 读取：${input.archivePath}`)
    }
    if (input.toolResultsDir) lines.push(`被清除或截断的工具输出保存在：${input.toolResultsDir}`)
    if (input.mode === 'fallback') lines.push('注意：摘要模型这次不可用，下面是机械生成的摘要，可能缺少细节。')
  } else {
    lines.push(`[Context compacted · #${input.index} · ${input.createdAt.replace('T', ' ').slice(0, 16)}]`)
    lines.push("Earlier messages in this conversation were summarized below to fit the model's context window. This is conversation history, not a new instruction from the user.")
    if (input.archivePath) {
      lines.push(`The full earlier history is archived (JSONL, one message per line) and can be read with read_file or search_files when exact details matter: ${input.archivePath}`)
    }
    if (input.toolResultsDir) lines.push(`Cleared or truncated tool outputs are saved under: ${input.toolResultsDir}`)
    if (input.mode === 'fallback') lines.push('Note: the summarizer was unavailable this time; the summary below is mechanical and may lack detail.')
  }
  lines.push('')
  lines.push('<summary>')
  lines.push(input.summary.trim())
  lines.push('</summary>')
  if (input.latestUserVerbatim) {
    lines.push('')
    lines.push(zh ? '## 用户最新消息（原文）' : '## Latest user message (verbatim)')
    lines.push(input.latestUserVerbatim)
  }
  if (input.restoration.length > 0) {
    lines.push('')
    lines.push(zh
      ? '## 压缩时的工作状态（压缩时刻的快照，之后可能已变化）'
      : '## Working state at compaction (a snapshot from that moment; it may have changed since)')
    for (const section of input.restoration) {
      lines.push('')
      lines.push(`### ${section.title}`)
      lines.push(section.body)
    }
  }
  return lines.join('\n')
}

function formatK(tokens: number): string {
  return tokens >= 10_000 ? `${Math.round(tokens / 1000)}K` : `${(tokens / 1000).toFixed(1)}K`
}

function buildNotice(input: {
  language: ConversationLanguage
  action: ManageAction
  before: number
  after: number
  window: number
  summarized: number
  cleared: number
  index: number
  archivePath?: string
}): string {
  const zh = input.language === 'zh'
  const sizes = `${formatK(input.before)} → ${formatK(input.after)} / ${formatK(input.window)}`
  if (input.action === 'clear_tool_results') {
    return zh
      ? `[上下文] 已清理 ${input.cleared} 条旧工具输出：${sizes} tokens`
      : `[context] cleared ${input.cleared} old tool results: ${sizes} tokens`
  }
  const fallback = input.action === 'fallback'
  if (zh) {
    return `[上下文] 已压缩（第 ${input.index} 次${fallback ? '，机械摘要' : ''}）：${sizes} tokens，总结了 ${input.summarized} 条较早的消息${input.archivePath ? `；完整记录：${input.archivePath}` : ''}`
  }
  return `[context] compacted (#${input.index}${fallback ? ', mechanical summary' : ''}): ${sizes} tokens, summarized ${input.summarized} earlier messages${input.archivePath ? `; full history: ${input.archivePath}` : ''}`
}

/** Head and tail of an oversized message, keeping it valid for the provider. */
function shrinkMessage(message: SessionMessage, tokens: number, archivePath: string | undefined, language: ConversationLanguage): SessionMessage {
  const note = archivePath
    ? (language === 'zh' ? `（完整原文见归档：${archivePath}）` : `(full text in the archive: ${archivePath})`)
    : ''
  const content = `${capText(message.content ?? '', tokens)}${note ? `\n${note}` : ''}`
  const { rawContentBlocks: _raw, reasoningContent: _reasoning, ...rest } = message
  return { ...rest, content }
}

// ── main entry ──────────────────────────────────────────────────────────────

export async function manageContext(input: ManageContextInput): Promise<ManageContextResult> {
  const reason = input.reason ?? 'proactive'
  const { budget, state } = input
  const language = input.language ?? detectConversationLanguage(input.messages)

  const repaired = repairToolPairs(input.messages)
  let messages = repaired.messages
  let changed = repaired.changed
  if (changed) invalidateUsageAnchor(state)

  const measured = measureContext(state, messages, input.fixedTokens)
  const before = measured.tokens
  // When the provider counted more than the local estimate (code and logs
  // often tokenize denser than bytes/4), scale later estimates the same way
  // so "fits after compaction" means fits by the provider's count.
  const rawEstimate = input.fixedTokens + estimateMessagesTokens(messages)
  const calibration = measured.source === 'provider+delta' && rawEstimate > 0
    ? Math.min(2, Math.max(1, before / rawEstimate))
    : 1
  const sizeOf = (list: readonly SessionMessage[]): number =>
    Math.ceil((input.fixedTokens + estimateMessagesTokens(list)) * calibration)
  const base = {
    tokensBefore: before,
    measuredBy: measured.source,
    clearedToolResults: 0,
    summarizedMessages: 0,
    overBudget: input.fixedTokens > budget.effective,
  }
  const finish = (action: ManageAction, extra: Partial<ManageContextResult> = {}): ManageContextResult => ({
    ...base,
    messages,
    changed,
    action,
    tokensAfter: sizeOf(messages),
    ...extra,
  })

  if (reason === 'proactive' && (input.proactive === false || before < budget.threshold)) {
    return { ...finish(changed ? 'repair' : 'none'), tokensAfter: before }
  }

  // ── Tier 1: clear old tool results outside the protected tail ─────────────
  const callIndex = buildToolCallIndex(messages)
  const protectFrom = selectTailStart(messages, budget.toolProtectTokens)
  let cleared = 0
  const now = new Date()
  const afterClear = messages.map((message, i) => {
    if (i >= protectFrom || !isClearableToolResult(message, callIndex)) return message
    cleared += 1
    return clearToolResult(message, { storage: input.storage, callIndex, now })
  })
  if (cleared > 0) {
    messages = afterClear
    changed = true
    invalidateUsageAnchor(state)
  }
  const afterTier1 = sizeOf(messages)
  if (reason === 'proactive' && afterTier1 <= budget.target) {
    return finish('clear_tool_results', {
      clearedToolResults: cleared,
      notice: buildNotice({
        language, action: 'clear_tool_results', before, after: afterTier1, window: budget.window,
        summarized: 0, cleared, index: state.compactions,
      }),
    })
  }

  // ── Tier 2: summarize everything before a token-based tail ────────────────
  const hadBoundary = isCompactionBoundary(messages[0])
  const previous = hadBoundary ? messages[0] : undefined
  const body = hadBoundary ? messages.slice(1) : messages
  // A provider overflow means the estimate was too low: keep a smaller tail.
  const tailTokens = reason === 'overflow' ? Math.floor(budget.tailTokens / 2) : budget.tailTokens
  let tailStart = selectTailStart(body, tailTokens, 1)
  // Something has to be summarized; never everything when a safe cut exists.
  if (tailStart <= 0) tailStart = Math.min(body.length, 1)
  const middle = body.slice(0, tailStart)
  let tail = body.slice(tailStart)

  if (middle.length === 0) {
    // Nothing older than the tail: only tool clearing was possible.
    return finish(cleared > 0 ? 'clear_tool_results' : changed ? 'repair' : 'none', {
      clearedToolResults: cleared,
      notice: cleared > 0
        ? buildNotice({
          language, action: 'clear_tool_results', before, after: afterTier1, window: budget.window,
          summarized: 0, cleared, index: state.compactions,
        })
        : undefined,
    })
  }

  const compactionIndex = state.compactions + 1
  const createdAt = new Date().toISOString()
  const archived = previous ? [previous, ...middle] : middle
  let archivePath: string | undefined
  if (input.storage) {
    try {
      await input.storage.archiveMessages(archived, { compaction: compactionIndex })
      archivePath = input.storage.transcriptPath
    } catch {
      archivePath = undefined
    }
  }

  const userIdx = lastRealUserIndex(body)
  const latestUserText = userIdx >= 0 ? body[userIdx]!.content : undefined
  let latestUserVerbatim = userIdx >= 0 && userIdx < tailStart
    ? capText(latestUserText ?? '', Math.max(500, Math.floor(budget.tailTokens / 2)))
    : undefined

  const previousSummary = previous?.compaction?.summary
  let summary: string
  let mode: 'summary' | 'fallback' = 'summary'
  let summarizerCalls = 0
  let summarizerError: string | undefined
  const canSummarize = Boolean(input.summarize) && state.summaryFailures < MAX_SUMMARY_FAILURES
  if (canSummarize) {
    try {
      const result = await summarizeHistory({
        summarize: input.summarize!,
        messages: middle,
        previousSummary,
        latestUserMessage: latestUserText,
        language,
        summarizerWindow: input.summarizerWindow ?? budget.window,
        maxSummaryTokens: budget.summaryTokens,
        allMessages: messages,
      })
      summary = result.summary
      summarizerCalls = result.calls
      state.summaryFailures = 0
    } catch (error) {
      summarizerError = error instanceof Error ? error.message : String(error)
      state.summaryFailures += 1
      mode = 'fallback'
      summary = ''
    }
  } else {
    mode = 'fallback'
    summary = ''
    summarizerError = input.summarize ? 'summarizer disabled after repeated failures' : 'no summarizer configured'
  }
  if (mode === 'fallback') {
    summary = buildMechanicalSummary({
      messages: middle,
      previousSummary,
      language,
      maxTokens: budget.summaryTokens,
      reason: capText(summarizerError ?? 'unknown error', 60),
    })
  }
  // A summary larger than asked for is cut rather than allowed to crowd out the tail.
  summary = capText(summary, Math.ceil(budget.summaryTokens * 1.5))

  let restoration: RestorationSection[] = []
  if (input.restore) {
    try {
      restoration = await buildRestorationSections({
        summarized: middle,
        tail,
        options: input.restore,
        language,
        budgetTokens: budget.restoreTokens,
      })
    } catch {
      restoration = []
    }
  }

  const summarizedTotal = (previous?.compaction?.summarizedMessages ?? 0) + middle.length
  const makeBoundary = (): SessionMessage => ({
    id: `compact-boundary-${compactionIndex}-${Date.now()}`,
    role: 'user',
    name: BOUNDARY_MESSAGE_NAME,
    content: renderBoundary({
      language,
      index: compactionIndex,
      summary,
      mode,
      archivePath,
      toolResultsDir: input.storage?.toolResultsDir,
      latestUserVerbatim,
      restoration,
      createdAt,
    }),
    createdAt,
    compaction: {
      kind: 'boundary',
      index: compactionIndex,
      summary,
      mode,
      language,
      ...(archivePath ? { archivePath } : {}),
      summarizedMessages: summarizedTotal,
      createdAt,
    },
  })

  // ── Guaranteed fit ────────────────────────────────────────────────────────
  // Stay below the threshold so the next request does not compact again
  // immediately; drop optional parts first, then trim the tail.
  const fitLimit = Math.max(1_000, Math.min(budget.threshold, budget.effective) - 1_000)
  let boundary = makeBoundary()
  let result = [boundary, ...tail]
  while (sizeOf(result) > fitLimit && restoration.length > 0) {
    // Drop the least important section (highest priority number) first.
    restoration = [...restoration].sort((a, b) => a.priority - b.priority).slice(0, -1)
    boundary = makeBoundary()
    result = [boundary, ...tail]
  }
  if (sizeOf(result) > fitLimit) {
    // Clear tool results inside the tail too, then move the tail start
    // forward one safe group at a time (those messages go to the archive).
    const tailIndex = buildToolCallIndex(tail)
    tail = tail.map((message) => isClearableToolResult(message, tailIndex)
      ? clearToolResult(message, { storage: input.storage, callIndex: tailIndex, now })
      : message)
    result = [boundary, ...tail]
    const dropped: SessionMessage[] = []
    while (sizeOf(result) > fitLimit && tail.length > 1) {
      let cut = 1
      while (cut < tail.length && !isSafeCut(tail, cut)) cut += 1
      if (cut >= tail.length) break
      dropped.push(...tail.slice(0, cut))
      tail = tail.slice(cut)
      result = [boundary, ...tail]
    }
    if (dropped.length > 0) {
      if (input.storage) {
        try { await input.storage.archiveMessages(dropped, { compaction: compactionIndex }) } catch { /* best effort */ }
      }
      const droppedUserIdx = lastRealUserIndex(dropped)
      if (droppedUserIdx >= 0 && lastRealUserIndex(tail) < 0) {
        latestUserVerbatim = capText(dropped[droppedUserIdx]!.content ?? '', Math.max(500, Math.floor(budget.tailTokens / 2)))
        boundary = makeBoundary()
        result = [boundary, ...tail]
      }
    }
  }
  if (sizeOf(result) > fitLimit) {
    // Last resort: shrink oversized messages, largest first, then the summary.
    const room = Math.max(500, Math.floor(fitLimit / calibration) - input.fixedTokens - estimateMessageTokens(boundary))
    tail = tail.map((message) => estimateMessageTokens(message) > room / Math.max(1, tail.length)
      ? shrinkMessage(message, Math.max(300, Math.floor(room / Math.max(1, tail.length))), archivePath, language)
      : message)
    result = [boundary, ...tail]
    if (sizeOf(result) > fitLimit) {
      const summaryRoom = Math.max(300, Math.floor(fitLimit / calibration) - input.fixedTokens - estimateMessagesTokens(tail) - 600)
      summary = capText(summary, summaryRoom)
      restoration = []
      latestUserVerbatim = latestUserVerbatim ? capText(latestUserVerbatim, 600) : undefined
      boundary = makeBoundary()
      result = [boundary, ...tail]
    }
  }

  messages = result
  changed = true
  state.compactions = compactionIndex
  state.lastCompactionAt = createdAt
  invalidateUsageAnchor(state)
  const after = sizeOf(messages)
  const action: ManageAction = mode === 'fallback' ? 'fallback' : 'summary'
  return finish(action, {
    tokensAfter: after,
    clearedToolResults: cleared,
    summarizedMessages: middle.length,
    summary,
    summarizerCalls,
    summarizerError,
    overBudget: after > budget.effective,
    notice: buildNotice({
      language, action, before, after, window: budget.window,
      summarized: middle.length, cleared, index: compactionIndex, archivePath,
    }),
  })
}
