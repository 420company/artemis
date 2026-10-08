/**
 * State re-attached after a summarizing compaction, within a token budget:
 * the current task board / plan, fresh contents of the files the agent was
 * working on, and the in-flight action when it was summarized away.
 *
 * The summary says what happened; restoration hands back the working set,
 * so the agent does not have to re-read files it was in the middle of
 * editing before it can continue.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { SessionMessage } from '../types.js'
import { estimateTokens } from '../tokenEstimation.js'
import { isSensitivePath } from '../../utils/fs.js'
import type { ConversationLanguage } from './language.js'
import { capText } from './summarizer.js'
import { parseToolContent } from './toolResults.js'

export type RestoreOptions = {
  /** Workspace root used to resolve relative paths. Files are not restored without it. */
  cwd?: string
  /** Pre-rendered task board / plan (path A: session.tasks and session.plan). */
  taskBoard?: string
  /** Extra paths recorded by the runtime itself (e.g. session.changedFiles), oldest first. */
  extraPaths?: readonly string[]
  maxFiles?: number
  /**
   * Final say on reading a file (the run's permission manager). Called with
   * the resolved real path; files it rejects are not restored.
   */
  canRead?: (absolutePath: string) => boolean | Promise<boolean>
}

export type RestorationSection = {
  title: string
  body: string
  /** Lower numbers are dropped last when space runs out. */
  priority: number
}

const MAX_FILE_BYTES = 1_000_000
const PER_FILE_TOKEN_CAP = 6_000
/** All restored file content together, whatever the token budget says. */
const MAX_TOTAL_RESTORE_BYTES = 256 * 1024

/** File tools whose own arguments name a file the agent worked on. */
const RESTORABLE_FILE_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'replace_in_file',
  'insert_in_file',
  'create_file',
])

function argPath(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined
  for (const key of ['path', 'file_path', 'filePath']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() && !value.includes('\n') && value.length <= 300) return value.trim()
  }
  return undefined
}

/**
 * Paths of files the agent itself read or edited successfully, oldest
 * first. Only the agent's own tool-call arguments count (path B: the
 * assistant's toolCalls; path A: the runtime's action envelope), never
 * anything a tool returned: a fetched page or API response could name any
 * file.
 */
export function collectRestorablePaths(messages: readonly SessionMessage[]): string[] {
  const order: string[] = []
  const touch = (value: string | undefined): void => {
    if (!value) return
    const at = order.indexOf(value)
    if (at >= 0) order.splice(at, 1)
    order.push(value)
  }
  // Results by call id, to keep only calls that succeeded.
  const resultById = new Map<string, SessionMessage>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolUseId) resultById.set(message.toolUseId, message)
  }
  const succeeded = (result: SessionMessage | undefined): boolean => {
    if (!result) return false
    if (result.contextCleared) return !/· failed:/.test(result.content ?? '')
    const parsed = parseToolContent(result.content ?? '')
    return parsed.ok !== false && !parsed.errorMessage
  }
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        if (!call || typeof call !== 'object' || !RESTORABLE_FILE_TOOLS.has(call.name)) continue
        if (!succeeded(resultById.get(call.id))) continue
        let args: Record<string, unknown> | undefined
        try { args = JSON.parse(call.arguments) as Record<string, unknown> } catch { args = undefined }
        touch(argPath(args))
      }
    } else if (message.role === 'tool' && !message.toolUseId && message.name && RESTORABLE_FILE_TOOLS.has(message.name)) {
      // Path A: the runtime wraps every result as { ok, action, output }.
      const parsed = parseToolContent(message.content ?? '')
      if (parsed.action?.type === message.name && parsed.ok === true) touch(argPath(parsed.action))
    }
  }
  return order
}

function isProbablyBinary(content: string): boolean {
  return content.slice(0, 8_000).includes('\u0000')
}

/**
 * Read a file for restoration only when its real path (symlinks resolved)
 * is inside the workspace, is not a protected path, and the permission
 * check (if any) allows it.
 */
async function readFresh(
  cwd: string,
  filePath: string,
  canRead: RestoreOptions['canRead'],
): Promise<{ absolute: string; content: string } | undefined> {
  try {
    const root = await realpath(cwd)
    const absolute = await realpath(path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath))
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return undefined
    if (isSensitivePath(absolute)) return undefined
    if (canRead && !(await canRead(absolute))) return undefined
    const info = await stat(absolute)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined
    const content = await readFile(absolute, 'utf8')
    if (isProbablyBinary(content)) return undefined
    return { absolute, content }
  } catch {
    return undefined
  }
}

function fence(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}\n${content}\n${ticks}`
}

/** Head of a file within `tokens`, cut at a line boundary. */
function headLines(content: string, tokens: number): { text: string; shown: number; total: number } {
  const lines = content.split('\n')
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = estimateTokens(line) + 1
    if (used + cost > tokens) break
    kept.push(line)
    used += cost
  }
  return { text: kept.join('\n'), shown: kept.length, total: lines.length }
}

/**
 * Build restoration sections for a compaction that summarizes `summarized`
 * and keeps `tail` verbatim.
 */
export async function buildRestorationSections(input: {
  summarized: readonly SessionMessage[]
  tail: readonly SessionMessage[]
  options: RestoreOptions
  language: ConversationLanguage
  budgetTokens: number
}): Promise<RestorationSection[]> {
  const zh = input.language === 'zh'
  const sections: RestorationSection[] = []

  if (input.options.taskBoard?.trim()) {
    sections.push({
      title: zh ? '当前任务清单' : 'Current task board',
      body: capText(input.options.taskBoard.trim(), Math.floor(input.budgetTokens * 0.25)),
      priority: 0,
    })
  }

  // In-flight action: when the last assistant turn was summarized away the
  // agent would otherwise lose what it was about to do.
  const lastAssistantInTail = input.tail.some((m) => m.role === 'assistant')
  if (!lastAssistantInTail) {
    const lastAssistant = [...input.summarized].reverse().find((m) => m.role === 'assistant' && (m.content?.trim() || m.toolCalls?.length))
    if (lastAssistant) {
      const calls = (lastAssistant.toolCalls ?? []).map((call) => `- ${call.name} ${capText(call.arguments ?? '', 200)}`)
      const body = [lastAssistant.content?.trim() ? capText(lastAssistant.content.trim(), 1_200) : '', ...calls]
        .filter(Boolean).join('\n')
      if (body) {
        sections.push({
          title: zh ? '压缩前正在进行的动作' : 'In-flight action before compaction',
          body,
          priority: 1,
        })
      }
    }
  }

  const cwd = input.options.cwd
  if (cwd) {
    const inTail = new Set(collectRestorablePaths(input.tail))
    const candidates = [
      ...(input.options.extraPaths ?? []),
      ...collectRestorablePaths(input.summarized),
    ]
    // Most recent first, without paths whose content the tail already shows.
    const ordered: string[] = []
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i]!
      if (inTail.has(candidate) || ordered.includes(candidate)) continue
      ordered.push(candidate)
    }
    const maxFiles = input.options.maxFiles ?? 5
    let fileBudget = Math.floor(input.budgetTokens * 0.7)
    let restored = 0
    let restoredBytes = 0
    for (const candidate of ordered) {
      if (restored >= maxFiles || fileBudget < 400 || restoredBytes >= MAX_TOTAL_RESTORE_BYTES) break
      const fresh = await readFresh(cwd, candidate, input.options.canRead)
      if (!fresh) continue
      const cap = Math.min(PER_FILE_TOKEN_CAP, fileBudget)
      const head = headLines(fresh.content, cap)
      if (head.shown === 0) continue
      const truncatedNote = head.shown < head.total
        ? (zh
          ? `\n（仅显示前 ${head.shown}/${head.total} 行；其余部分请用 read_file 读取）`
          : `\n(first ${head.shown} of ${head.total} lines; read_file for the rest)`)
        : ''
      const body = `${fresh.absolute}${truncatedNote}\n${fence(head.text)}`
      fileBudget -= estimateTokens(body)
      restoredBytes += Buffer.byteLength(head.text)
      restored += 1
      sections.push({
        title: zh ? `文件当前内容：${candidate}` : `Current contents of ${candidate}`,
        body,
        priority: 2 + restored,
      })
    }
  }

  return sections
}
