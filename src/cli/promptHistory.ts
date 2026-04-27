/**
 * cli/promptHistory.ts — persistent prompt history store
 *
 * Saves the last N user prompts to .artemis/prompt-history.json so that
 * history navigation (↑/↓) survives restarts.
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, pathExists, resolveDataRootDir } from '../utils/fs.js'

export const PROMPT_HISTORY_LIMIT = 200

const BLOCKED_HISTORY_COMMANDS = [
  /^\/newborn(?:\s|$)/,
]

const SECRET_LIKE_PATTERNS = [
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bcli_[A-Za-z0-9]{8,}\b/,
]

function containsSecretLikeContent(value: string): boolean {
  if (SECRET_LIKE_PATTERNS.some(pattern => pattern.test(value))) return true

  return value.split('\n').some(line => {
    const trimmed = line.trim()
    return (
      /^[A-Za-z0-9_-]{24,}$/.test(trimmed) &&
      /[A-Za-z]/.test(trimmed) &&
      /\d/.test(trimmed)
    )
  })
}

function normalizeEntry(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const n = value.replace(/\r\n?/g, '\n').trim()
  return n.length > 0 ? n : undefined
}

function normalizeEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    const n = normalizeEntry(item)
    if (!n || seen.has(n)) continue
    if (BLOCKED_HISTORY_COMMANDS.some(pattern => pattern.test(n))) continue
    if (containsSecretLikeContent(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= PROMPT_HISTORY_LIMIT) break
  }
  return out
}

export class PromptHistoryStore {
  private readonly rootDir: string
  private readonly filePath: string

  constructor(cwd: string) {
    this.rootDir = resolveDataRootDir(cwd)
    this.filePath = path.join(this.rootDir, 'prompt-history.json')
  }

  async ensure(): Promise<void> { await ensureDir(this.rootDir) }

  async load(): Promise<string[]> {
    await this.ensure()
    if (!(await pathExists(this.filePath))) return []
    try {
      const raw = await readFile(this.filePath, 'utf8')
      return normalizeEntries(JSON.parse(raw))
    } catch {
      return []
    }
  }

  async save(entries: readonly string[]): Promise<string[]> {
    await this.ensure()
    const normalized = normalizeEntries(entries)
    await writeFile(this.filePath, JSON.stringify(normalized, null, 2), 'utf8')
    return normalized
  }

  /** Prepend a new entry (dedup + limit applied). */
  async record(entry: string): Promise<string[]> {
    const n = normalizeEntry(entry)
    if (!n) return this.load()
    const current = await this.load()
    return this.save([n, ...current.filter(e => e !== n)])
  }

  async clear(): Promise<void> { await this.save([]) }
}
