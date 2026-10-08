/**
 * On-disk companions of a session's context:
 *
 *   <dir>/transcript.jsonl         append-only archive of every message removed
 *                                  from the live history by compaction
 *   <dir>/tool-results/            full tool outputs that were spilled on intake
 *                                  or cleared later, one file per result
 *   <dir>/pending-compaction.json  crash marker: a compaction whose archive was
 *                                  written but whose session may not be saved yet
 *
 * Path A keeps `<dir>` next to the session JSON
 * (`<data root>/sessions/<session id>/`); path B uses the same layout under
 * the bridge or CLI session id. Files are private to the user (0600, dirs
 * 0700): they hold conversation content and tool output.
 */

import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { SessionMessage } from '../types.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** Total size of one session's tool-results directory before the oldest files go. */
export const DEFAULT_TOOL_RESULTS_CAP_BYTES = 200 * 1024 * 1024

/** A compaction that archived messages; cleared once the session that holds its boundary is saved. */
export type PendingCompaction = {
  /** Compaction index (ContextState.compactions + 1 at the time). */
  index: number
  /** Ids of the messages written to the transcript by this compaction. */
  archivedIds: string[]
  /** The summary it produced, reused instead of paying for it again after a crash. */
  summary: string
  mode: 'summary' | 'fallback'
  createdAt: string
}

export type ContextStorage = {
  readonly dir: string
  readonly transcriptPath: string
  readonly toolResultsDir: string
  /**
   * Append messages to the transcript archive. Never rewrites earlier lines.
   * Messages whose id is in `skipIds` were archived already and are skipped.
   */
  archiveMessages(
    messages: readonly SessionMessage[],
    meta: { compaction: number; skipIds?: ReadonlySet<string> },
  ): Promise<void>
  /** Write a full tool output to its own file and return the path. Synchronous so intake stays simple. */
  writeToolResult(label: string, content: string): string
  readPendingCompaction(): Promise<PendingCompaction | undefined>
  writePendingCompaction(pending: PendingCompaction): Promise<void>
  clearPendingCompaction(): Promise<void>
}

function safeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80) || 'tool'
}

/** Remove inline image data before anything is persisted: images are per-request only. */
function stripImageData(blocks: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(blocks)) return blocks
  return blocks.map((block) => {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'image') {
      return { type: 'image', omitted: true }
    }
    return block
  })
}

export function sanitizeMessageForArchive(message: SessionMessage): SessionMessage {
  const copy: SessionMessage = { ...message }
  if (copy.contentBlocks) copy.contentBlocks = stripImageData(copy.contentBlocks)
  if (copy.rawContentBlocks) copy.rawContentBlocks = stripImageData(copy.rawContentBlocks)
  return copy
}

export function createContextStorage(
  dir: string,
  options: { toolResultsCapBytes?: number } = {},
): ContextStorage {
  const resolved = path.resolve(dir)
  const transcriptPath = path.join(resolved, 'transcript.jsonl')
  const toolResultsDir = path.join(resolved, 'tool-results')
  const pendingPath = path.join(resolved, 'pending-compaction.json')
  const capBytes = options.toolResultsCapBytes ?? DEFAULT_TOOL_RESULTS_CAP_BYTES
  // Running total of tool-results bytes, computed once per process.
  let toolResultsBytes: number | undefined

  const pruneToolResults = (): void => {
    if (toolResultsBytes === undefined) {
      toolResultsBytes = 0
      try {
        for (const name of readdirSync(toolResultsDir)) {
          try { toolResultsBytes += statSync(path.join(toolResultsDir, name)).size } catch { /* gone */ }
        }
      } catch {
        toolResultsBytes = 0
      }
    }
    if (toolResultsBytes <= capBytes) return
    // Oldest first: least recently written results go.
    const files = readdirSync(toolResultsDir)
      .map((name) => {
        const full = path.join(toolResultsDir, name)
        try {
          const info = statSync(full)
          return { full, size: info.size, mtime: info.mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter((entry): entry is { full: string; size: number; mtime: number } => Boolean(entry))
      .sort((a, b) => a.mtime - b.mtime)
    for (const file of files) {
      if (toolResultsBytes <= capBytes * 0.9) break
      try {
        unlinkSync(file.full)
        toolResultsBytes -= file.size
      } catch { /* already gone */ }
    }
  }

  return {
    dir: resolved,
    transcriptPath,
    toolResultsDir,
    async archiveMessages(messages, meta) {
      const toWrite = meta.skipIds ? messages.filter((message) => !meta.skipIds!.has(message.id)) : messages
      if (toWrite.length === 0) return
      await mkdir(resolved, { recursive: true, mode: DIR_MODE })
      const archivedAt = new Date().toISOString()
      const lines = toWrite.map((message) =>
        JSON.stringify({ archivedAt, compaction: meta.compaction, message: sanitizeMessageForArchive(message) }))
      await appendFile(transcriptPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: FILE_MODE })
    },
    writeToolResult(label, content) {
      mkdirSync(toolResultsDir, { recursive: true, mode: DIR_MODE })
      const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
      const filePath = path.join(toolResultsDir, `${Date.now()}-${safeLabel(label)}-${digest}.txt`)
      writeFileSync(filePath, content, { encoding: 'utf8', mode: FILE_MODE })
      if (toolResultsBytes !== undefined) toolResultsBytes += Buffer.byteLength(content)
      pruneToolResults()
      return filePath
    },
    async readPendingCompaction() {
      try {
        const parsed = JSON.parse(await readFile(pendingPath, 'utf8')) as PendingCompaction
        if (typeof parsed?.index !== 'number' || !Array.isArray(parsed.archivedIds) || typeof parsed.summary !== 'string') {
          return undefined
        }
        return parsed
      } catch {
        return undefined
      }
    },
    async writePendingCompaction(pending) {
      await mkdir(resolved, { recursive: true, mode: DIR_MODE })
      await writeFile(pendingPath, JSON.stringify(pending), { encoding: 'utf8', mode: FILE_MODE })
    },
    async clearPendingCompaction() {
      await rm(pendingPath, { force: true })
    },
  }
}

/**
 * Every message the conversation ever had, in order: archived messages from
 * the transcript followed by the live history. Synthetic entries (the
 * compaction boundary, per-run runtime context) are left out, and a message
 * archived twice appears once. A live message that was shortened to fit
 * (its original was archived first) is shown with its original text.
 */
export async function readFullHistory(
  dir: string,
  live: readonly SessionMessage[],
  isSynthetic: (message: SessionMessage) => boolean,
): Promise<{ messages: SessionMessage[]; archived: number }> {
  const liveIds = new Set(live.map((message) => message.id))
  const seen = new Set<string>()
  const archived: SessionMessage[] = []
  const originals = new Map<string, SessionMessage>()
  let raw = ''
  try {
    raw = await readFile(path.join(path.resolve(dir), 'transcript.jsonl'), 'utf8')
  } catch {
    raw = ''
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let message: SessionMessage | undefined
    try {
      message = (JSON.parse(line) as { message?: SessionMessage }).message
    } catch {
      continue // a torn last line after a crash
    }
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') continue
    if (liveIds.has(message.id)) {
      if (!originals.has(message.id)) originals.set(message.id, message)
      continue
    }
    if (seen.has(message.id) || isSynthetic(message)) continue
    seen.add(message.id)
    archived.push(message)
  }
  const visibleLive = live
    .filter((message) => !isSynthetic(message))
    .map((message) => originals.get(message.id) ?? message)
  return { messages: [...archived, ...visibleLive], archived: archived.length }
}
