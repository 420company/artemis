/**
 * Tier 1 of context management (no model calls):
 *
 * - Intake: a tool result above the inline budget is written to a file under
 *   the session directory; the history keeps a preview (head and tail, line
 *   aligned, newlines intact) and the path to re-read.
 * - Clearing: when the context is over the threshold, old tool results
 *   outside a protected recent tail become a one-line placeholder that names
 *   the tool, its arguments, the size, and where the full output lives.
 *
 * Both work on the two tool-result shapes in use: path A stores a JSON
 * envelope `{ ok, action, output, error }`; path B stores the raw output
 * (or a `{ ok: false, output, error }` envelope on failure) with the call
 * arguments on the preceding assistant message.
 */

import type { SessionMessage } from '../types.js'
import { estimateTokens } from '../tokenEstimation.js'
import type { ContextStorage } from './storage.js'

/** Marker that starts every spill header; also used to detect spilled results. */
export const SPILL_MARKER = '[Output too large for context'
/** Compatibility phrase: older parsers and tests look for it. */
const SAVED_AT_PHRASE = 'Full original output saved at:'
export const CLEARED_MARKER = '[Old tool result cleared to save context]'

/** Tools whose results are execution evidence and stay inline when old. */
const EVIDENCE_TOOLS = new Set([
  'write_file',
  'apply_patch',
  'insert_in_file',
  'replace_in_file',
  'create_file',
  'delete_file',
  'move_file',
  'edit_file',
  'writefile',
])

/** Tools whose output is file content the agent explicitly asked to read. */
const FILE_READ_TOOLS = new Set(['read_file', 'readfile', 'mcp_read_resource', 'notebook_view'])

/** Results this short are not worth clearing. */
const MIN_CLEARABLE_CHARS = 600

export type ToolCallInfo = { name: string; args: string }

export type ParsedToolContent = {
  /** The JSON envelope when the content is one. */
  envelope?: Record<string, unknown>
  /** The visible output text. */
  output: string
  ok?: boolean
  errorMessage?: string
  /** Action object of path A envelopes (type + arguments). */
  action?: Record<string, unknown>
}

export function parseToolContent(content: string): ParsedToolContent {
  const trimmed = content.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(content) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const envelope = parsed as Record<string, unknown>
        const error = envelope.error as { message?: unknown } | string | undefined
        const errorMessage = typeof error === 'string'
          ? error
          : typeof error?.message === 'string' ? error.message : undefined
        const action = envelope.action && typeof envelope.action === 'object'
          ? envelope.action as Record<string, unknown>
          : undefined
        // Only Artemis' own envelopes count: path A always has `action`,
        // failures carry `error`. A tool whose raw output merely happens to
        // be JSON with an `output` field (an HTTP body) stays plain text.
        // A top-level `path` is NOT enough: tool output (a fetched JSON API)
        // could claim any path, and paths here feed restoration.
        const isArtemisEnvelope = Boolean(action) || envelope.error !== undefined || typeof envelope.toolName === 'string'
        if (typeof envelope.output === 'string' && isArtemisEnvelope) {
          return {
            envelope,
            output: envelope.output,
            ok: typeof envelope.ok === 'boolean' ? envelope.ok : undefined,
            errorMessage,
            action,
          }
        }
      }
    } catch {
      /* not JSON */
    }
  }
  return { output: content }
}

/** Map tool-call id -> name and argument JSON, from toolCalls and raw tool_use blocks. */
export function buildToolCallIndex(messages: readonly SessionMessage[]): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const call of message.toolCalls ?? []) {
      if (call?.id) index.set(call.id, { name: call.name, args: call.arguments ?? '' })
    }
    for (const block of message.rawContentBlocks ?? []) {
      const b = block as { type?: string; id?: string; name?: string; input?: unknown }
      if (b?.type === 'tool_use' && typeof b.id === 'string' && !index.has(b.id)) {
        let args = ''
        try { args = JSON.stringify(b.input ?? {}) } catch { args = '' }
        index.set(b.id, { name: b.name ?? 'tool', args })
      }
    }
  }
  return index
}

const ARG_KEYS = [
  'path', 'file_path', 'filePath', 'paths', 'target', 'command', 'cmd', 'query', 'pattern',
  'url', 'uri', 'role', 'toolName', 'name', 'id', 'startLine', 'endLine',
]

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Short `key=value` rendering of tool arguments for placeholders and summaries. */
export function summarizeToolArgs(args: Record<string, unknown> | string | undefined, max = 160): string {
  if (args === undefined) return ''
  let record: Record<string, unknown> | undefined
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (!trimmed) return ''
    try {
      const parsed = JSON.parse(trimmed) as unknown
      record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    } catch {
      return oneLine(trimmed, max)
    }
    if (!record) return oneLine(trimmed, max)
  } else {
    record = args
  }
  const parts: string[] = []
  for (const key of ARG_KEYS) {
    const value = record[key]
    if (value === undefined || value === null || value === '') continue
    const rendered = typeof value === 'string' ? value : JSON.stringify(value)
    parts.push(`${key}=${oneLine(rendered ?? '', 100)}`)
  }
  if (parts.length === 0) {
    const rest = Object.entries(record).filter(([key]) => key !== 'type' && key !== 'content')
    if (rest.length === 0) return ''
    try {
      return oneLine(JSON.stringify(Object.fromEntries(rest)), max)
    } catch {
      return ''
    }
  }
  return oneLine(parts.join(' '), max)
}

/** Tool name and argument summary of a tool-result message. */
export function describeToolResult(
  message: SessionMessage,
  callIndex?: Map<string, ToolCallInfo>,
): { name: string; args: string } {
  const parsed = parseToolContent(message.content ?? '')
  const call = message.toolUseId ? callIndex?.get(message.toolUseId) : undefined
  const name = message.name
    ?? call?.name
    ?? (typeof parsed.action?.type === 'string' ? parsed.action.type : undefined)
    ?? 'tool'
  let args = call
    ? summarizeToolArgs(call.args)
    : parsed.action
      ? summarizeToolArgs(Object.fromEntries(Object.entries(parsed.action).filter(([key]) => key !== 'type')))
      : ''
  if (!args && typeof parsed.envelope?.path === 'string') args = `path=${parsed.envelope.path}`
  return { name, args }
}

function lineCount(text: string): number {
  if (!text) return 0
  let count = 1
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1
  return count
}

/**
 * Head and tail of a text within `tokens`, cut at line boundaries so code
 * and logs stay readable. Newlines are preserved.
 */
export function buildPreview(text: string, tokens: number): { preview: string; headLines: number; tailLines: number } {
  const lines = text.split('\n')
  const headBudget = Math.floor(tokens * 0.65)
  const tailBudget = tokens - headBudget
  const head: string[] = []
  let used = 0
  // Index of a line only partly shown in the head (its end may go in the tail).
  let partialHead = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const cost = estimateTokens(line) + 1
    if (used + cost > headBudget) {
      // Show the start of an oversized line instead of skipping it.
      const room = headBudget - used
      if (room > 40) {
        head.push(`${line.slice(0, room * 3)} …[line truncated]`)
        partialHead = i
      }
      break
    }
    head.push(line)
    used += cost
  }
  const fullHeadLines = partialHead >= 0 ? head.length - 1 : head.length
  const tail: string[] = []
  used = 0
  for (let i = lines.length - 1; i >= fullHeadLines; i -= 1) {
    const line = lines[i]!
    const cost = estimateTokens(line) + 1
    if (used + cost > tailBudget || i === partialHead) {
      const room = tailBudget - used
      if (room > 40) tail.unshift(`[line truncated]… ${line.slice(-room * 3)}`)
      break
    }
    tail.unshift(line)
    used += cost
  }
  const omitted = Math.max(0, lines.length - head.length - tail.length)
  const parts = [head.join('\n')]
  if (omitted > 0) parts.push(`… [${omitted} lines omitted] …`)
  else if (partialHead >= 0) parts.push('… [middle of a long line omitted] …')
  if (tail.length > 0) parts.push(tail.join('\n'))
  return { preview: parts.join('\n'), headLines: head.length, tailLines: tail.length }
}

/**
 * True only for results Artemis itself spilled: the content starts with the
 * spill header, or is an Artemis envelope whose output starts with it and
 * that records where the output went. Output that merely mentions the marker
 * (a search over old transcripts) is not mistaken for a spilled result.
 */
export function isSpilledToolContent(content: string): boolean {
  if (content.startsWith(SPILL_MARKER)) return true
  if (!content.trimStart().startsWith('{')) return false
  const parsed = parseToolContent(content)
  return Boolean(parsed.envelope) &&
    typeof parsed.envelope?.outputSavedTo === 'string' &&
    parsed.output.startsWith(SPILL_MARKER)
}

export type SpillOptions = {
  storage?: ContextStorage
  toolName?: string
  inlineTokens: number
  /** Inline allowance for file-read tools; defaults to inlineTokens. */
  inlineReadTokens?: number
  previewTokens: number
}

export type SpillResult = { content: string; savedTo?: string }

/**
 * Spill a large tool result: write the full output to a file and keep a
 * preview plus the path. Without storage the result is returned unchanged
 * (callers must not lose data they cannot save).
 */
export function spillToolResultIfLarge(content: string, options: SpillOptions): SpillResult {
  if (!content || !options.storage) return { content }
  const parsed = parseToolContent(content)
  const name = options.toolName
    ?? (typeof parsed.action?.type === 'string' ? parsed.action.type : undefined)
    ?? 'tool'
  const limit = FILE_READ_TOOLS.has(name)
    ? Math.max(options.inlineTokens, options.inlineReadTokens ?? options.inlineTokens)
    : options.inlineTokens
  if (estimateTokens(content) <= limit || isSpilledToolContent(content)) return { content }

  const output = parsed.output
  const savedTo = options.storage.writeToolResult(name, output)
  const { preview, headLines, tailLines } = buildPreview(output, options.previewTokens)
  const totalLines = lineCount(output)
  const header = [
    `${SPILL_MARKER}: ${output.length.toLocaleString('en-US')} chars, ${totalLines.toLocaleString('en-US')} lines.`,
    `${SAVED_AT_PHRASE} ${savedTo}`,
    `Showing the first ${headLines} and last ${tailLines} lines. Read that file (read_file with startLine/endLine, or search_files) for the rest before relying on the omitted part.]`,
  ].join('\n')
  const body = `${header}\n${preview}`

  if (parsed.envelope) {
    return {
      content: JSON.stringify({
        ...parsed.envelope,
        output: body,
        outputSavedTo: savedTo,
        outputChars: output.length,
      }, null, 2),
      savedTo,
    }
  }
  return { content: body, savedTo }
}

/** Where Artemis saved the full output of a result it spilled, if it did. */
function extractSavedPath(content: string, parsed: ParsedToolContent): string | undefined {
  if (!isSpilledToolContent(content)) return undefined
  const fromEnvelope = parsed.envelope?.outputSavedTo
  if (typeof fromEnvelope === 'string' && fromEnvelope) return fromEnvelope
  const header = content.split('\n').slice(0, 3).join('\n')
  const match = header.match(/Full original output saved at: ([^\n"\\]+)/)
  return match?.[1]?.trim()
}

export function isClearedToolResult(message: SessionMessage): boolean {
  return Boolean(message.contextCleared) || (message.content ?? '').startsWith(CLEARED_MARKER)
}

/** True when Tier 1 may replace this message with a placeholder. */
export function isClearableToolResult(message: SessionMessage, callIndex?: Map<string, ToolCallInfo>): boolean {
  if (message.role !== 'tool') return false
  if (isClearedToolResult(message)) return false
  if ((message.content ?? '').length < MIN_CLEARABLE_CHARS) return false
  const { name } = describeToolResult(message, callIndex)
  return !EVIDENCE_TOOLS.has(name)
}

/**
 * Replace a tool result with a one-line placeholder. The full output is
 * saved first (unless it already lives in a spill file) so it can be re-read.
 */
export function clearToolResult(
  message: SessionMessage,
  options: { storage?: ContextStorage; callIndex?: Map<string, ToolCallInfo>; now?: Date },
): SessionMessage {
  const content = message.content ?? ''
  const parsed = parseToolContent(content)
  const { name, args } = describeToolResult(message, options.callIndex)
  let savedTo = extractSavedPath(content, parsed)
  if (!savedTo && options.storage) {
    try {
      savedTo = options.storage.writeToolResult(name, parsed.envelope ? content : parsed.output)
    } catch {
      savedTo = undefined
    }
  }
  const failed = parsed.ok === false
  const bits = [
    `${CLEARED_MARKER} ${name}${args ? ` ${args}` : ''}`,
    `${content.length.toLocaleString('en-US')} chars`,
    failed ? `failed: ${oneLine(parsed.errorMessage ?? parsed.output, 200)}` : undefined,
    savedTo
      ? `full result: ${savedTo}`
      : 'run the tool again if you need the output',
  ].filter(Boolean)
  return {
    ...message,
    content: bits.join(' · '),
    contextCleared: {
      chars: content.length,
      ...(savedTo ? { savedTo } : {}),
      clearedAt: (options.now ?? new Date()).toISOString(),
    },
  }
}
