/**
 * State re-attached after a summarizing compaction, within a token budget:
 * the current task board / plan, fresh contents of the files the agent was
 * working on, and the in-flight action when it was summarized away.
 *
 * The summary says what happened; restoration hands back the working set,
 * so the agent does not have to re-read files it was in the middle of
 * editing before it can continue.
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { SessionMessage } from '../types.js'
import { estimateTokens } from '../tokenEstimation.js'
import type { ConversationLanguage } from './language.js'
import { capText, collectReferencedPaths } from './summarizer.js'

export type RestoreOptions = {
  /** Workspace root used to resolve relative paths. Files are not restored without it. */
  cwd?: string
  /** Pre-rendered task board / plan (path A: session.tasks and session.plan). */
  taskBoard?: string
  /** Extra paths to consider (e.g. session.changedFiles), oldest first. */
  extraPaths?: readonly string[]
  maxFiles?: number
}

export type RestorationSection = {
  title: string
  body: string
  /** Lower numbers are dropped last when space runs out. */
  priority: number
}

const MAX_FILE_BYTES = 1_000_000
const PER_FILE_TOKEN_CAP = 6_000

function isProbablyBinary(content: string): boolean {
  return content.slice(0, 8_000).includes('\u0000')
}

async function readFresh(cwd: string, filePath: string): Promise<{ absolute: string; content: string } | undefined> {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
  try {
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
    const inTail = new Set(collectReferencedPaths(input.tail))
    const candidates = [
      ...(input.options.extraPaths ?? []),
      ...collectReferencedPaths(input.summarized),
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
    for (const candidate of ordered) {
      if (restored >= maxFiles || fileBudget < 400) break
      const fresh = await readFresh(cwd, candidate)
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
