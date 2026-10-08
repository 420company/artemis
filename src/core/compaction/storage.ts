/**
 * On-disk companions of a session's context:
 *
 *   <dir>/transcript.jsonl         append-only archive of every message removed
 *                                  from the live history by compaction, in
 *                                  order, each id at most once
 *   <dir>/originals.jsonl          full text of messages that were shortened
 *                                  to fit while still live
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

import { appendFile, mkdir, open, readFile, rm } from 'node:fs/promises'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { SessionMessage } from '../types.js'
import { writeFileAtomic } from '../../storage/atomicWrite.js'

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
  readonly originalsPath: string
  readonly toolResultsDir: string
  /**
   * Append messages to the transcript archive. Never rewrites earlier lines.
   * Idempotent: a message whose id is already in the transcript (or in
   * `skipIds`) is not written again, so a crash and retry cannot archive a
   * block twice.
   */
  archiveMessages(
    messages: readonly SessionMessage[],
    meta: { compaction: number; skipIds?: ReadonlySet<string> },
  ): Promise<void>
  /**
   * Keep the full text of messages about to be shortened in place (they stay
   * live, so they are not part of the chronological transcript yet).
   */
  archiveOriginals(messages: readonly SessionMessage[]): Promise<void>
  /** Write a full tool output to its own file and return the path. Synchronous so intake stays simple. */
  writeToolResult(label: string, content: string): string
  /**
   * True only for a file this storage wrote itself (recorded in its index)
   * that really lives in its tool-results directory. Paths named in tool
   * output text are never trusted on their own.
   */
  isOwnToolResult(filePath: string): boolean
  /**
   * The tool-result files the live history (and its boundary) still point
   * to. Pruning never deletes them, nor files written after the last call
   * (their message may not be in the history yet).
   */
  setReferencedToolResults(messages: readonly SessionMessage[]): void
  readPendingCompaction(): Promise<PendingCompaction | undefined>
  writePendingCompaction(pending: PendingCompaction): Promise<void>
  clearPendingCompaction(): Promise<void>
}

function formatBytes(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`
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
  const originalsPath = path.join(resolved, 'originals.jsonl')
  // Ids already in each archive file, read once per process.
  let transcriptIds: Set<string> | undefined
  let originalIds: Set<string> | undefined
  const toolResultsDir = path.join(resolved, 'tool-results')
  const pendingPath = path.join(resolved, 'pending-compaction.json')
  const capBytes = options.toolResultsCapBytes ?? DEFAULT_TOOL_RESULTS_CAP_BYTES
  const indexPath = path.join(toolResultsDir, '.index')
  // Running total of tool-results bytes, computed once per process.
  let toolResultsBytes: number | undefined
  // Names of files this storage wrote (persisted in `.index`).
  let own: Set<string> | undefined
  // Names the history referenced at the last scan, and names written since
  // (their messages may not be in the history yet).
  let referenced: Set<string> | undefined
  const writtenSinceScan = new Set<string>()
  let warnedOverCap = false

  const ownNames = (): Set<string> => {
    if (!own) {
      own = new Set()
      try {
        for (const line of readFileSync(indexPath, 'utf8').split('\n')) if (line.trim()) own.add(line.trim())
      } catch { /* no index yet */ }
    }
    return own
  }

  let realToolResultsDir: string | undefined
  const realDir = (): string | undefined => {
    if (!realToolResultsDir) {
      try { realToolResultsDir = realpathSync(toolResultsDir) } catch { return undefined }
    }
    return realToolResultsDir
  }

  const isOwnToolResult = (filePath: string): boolean => {
    if (typeof filePath !== 'string' || !filePath) return false
    const root = realDir()
    if (!root) return false
    let real: string
    try { real = realpathSync(filePath) } catch { return false }
    if (path.dirname(real) !== root) return false
    return ownNames().has(path.basename(real))
  }

  const pruneToolResults = (): void => {
    if (toolResultsBytes === undefined) {
      toolResultsBytes = 0
      try {
        for (const name of readdirSync(toolResultsDir)) {
          if (name === '.index') continue
          try { toolResultsBytes += statSync(path.join(toolResultsDir, name)).size } catch { /* gone */ }
        }
      } catch {
        toolResultsBytes = 0
      }
    }
    if (toolResultsBytes <= capBytes) return
    // Oldest first, and only files the history no longer points to: a file
    // still referenced by a preview or placeholder is never deleted. Until
    // the history has been scanned once, nothing is known to be unreferenced.
    const files = readdirSync(toolResultsDir)
      .filter((name) => name !== '.index')
      .map((name) => {
        const full = path.join(toolResultsDir, name)
        try {
          const info = statSync(full)
          return { name, full, size: info.size, mtime: info.mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter((entry): entry is { name: string; full: string; size: number; mtime: number } => Boolean(entry))
      .sort((a, b) => a.mtime - b.mtime)
    for (const file of files) {
      if (toolResultsBytes <= capBytes * 0.9) break
      if (!referenced || referenced.has(file.name) || writtenSinceScan.has(file.name)) continue
      try {
        unlinkSync(file.full)
        toolResultsBytes -= file.size
      } catch { /* already gone */ }
    }
    if (toolResultsBytes > capBytes && !warnedOverCap) {
      warnedOverCap = true
      process.stderr.write(
        `[context] tool results in ${toolResultsDir} use ${formatBytes(toolResultsBytes)}, over the ${formatBytes(capBytes)} cap; the remaining files are still referenced by the conversation and are kept.\n`,
      )
    }
  }

  const setReferencedToolResults = (messages: readonly SessionMessage[]): void => {
    const names = new Set<string>()
    const prefixes = [toolResultsDir + path.sep]
    const real = realDir()
    if (real && real !== toolResultsDir) prefixes.push(real + path.sep)
    // Inside JSON envelopes a Windows path appears with escaped backslashes.
    for (const prefix of [...prefixes]) {
      const escaped = JSON.stringify(prefix).slice(1, -1)
      if (escaped !== prefix) prefixes.push(escaped)
    }
    for (const message of messages) {
      const texts = [message.content ?? '', message.contextCleared?.savedTo ?? '']
      for (const text of texts) {
        for (const prefix of prefixes) {
          let at = text.indexOf(prefix)
          while (at >= 0) {
            const rest = text.slice(at + prefix.length)
            const match = rest.match(/^[^\s"'\\)\]]+/)
            if (match) names.add(match[0])
            at = text.indexOf(prefix, at + prefix.length)
          }
        }
      }
    }
    referenced = names
    writtenSinceScan.clear()
  }

  const appendUnique = async (
    filePath: string,
    known: Set<string>,
    messages: readonly SessionMessage[],
    compaction: number,
  ): Promise<void> => {
    const fresh: SessionMessage[] = []
    for (const message of messages) {
      if (known.has(message.id)) continue
      known.add(message.id)
      fresh.push(message)
    }
    if (fresh.length === 0) return
    await mkdir(resolved, { recursive: true, mode: DIR_MODE })
    const archivedAt = new Date().toISOString()
    const lines = fresh.map((message) =>
      JSON.stringify({ id: message.id, archivedAt, compaction, message: sanitizeMessageForArchive(message) }))
    await appendFile(filePath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: FILE_MODE })
  }

  return {
    dir: resolved,
    transcriptPath,
    originalsPath,
    toolResultsDir,
    async archiveMessages(messages, meta) {
      const toWrite = meta.skipIds ? messages.filter((message) => !meta.skipIds!.has(message.id)) : messages
      if (toWrite.length === 0) return
      transcriptIds ??= await readArchivedIds(transcriptPath)
      await appendUnique(transcriptPath, transcriptIds, toWrite, meta.compaction)
    },
    async archiveOriginals(messages) {
      if (messages.length === 0) return
      originalIds ??= await readArchivedIds(originalsPath)
      await appendUnique(originalsPath, originalIds, messages, 0)
    },
    writeToolResult(label, content) {
      mkdirSync(toolResultsDir, { recursive: true, mode: DIR_MODE })
      const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
      const name = `${Date.now()}-${safeLabel(label)}-${digest}.txt`
      const filePath = path.join(toolResultsDir, name)
      writeFileSync(filePath, content, { encoding: 'utf8', mode: FILE_MODE })
      appendFileSync(indexPath, `${name}\n`, { encoding: 'utf8', mode: FILE_MODE })
      ownNames().add(name)
      writtenSinceScan.add(name)
      if (toolResultsBytes !== undefined) toolResultsBytes += Buffer.byteLength(content)
      pruneToolResults()
      return filePath
    },
    isOwnToolResult,
    setReferencedToolResults,
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
      await writeFileAtomic(pendingPath, JSON.stringify(pending), { mode: FILE_MODE })
    },
    async clearPendingCompaction() {
      await rm(pendingPath, { force: true })
    },
  }
}

/** Id of one archive line: the top-level `id` (cheap), else the message's. */
function archivedLineId(line: string): string | undefined {
  if (line.startsWith('{"id":"')) {
    let end = 7
    while (end < line.length && (line[end] !== '"' || line[end - 1] === '\\')) end += 1
    try {
      return JSON.parse(line.slice(6, end + 1)) as string
    } catch { /* fall through */ }
  }
  return parseArchivedLine(line)?.id
}

/** Ids present in an archive file (empty when it does not exist). */
async function readArchivedIds(filePath: string): Promise<Set<string>> {
  const ids = new Set<string>()
  let raw = ''
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return ids
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const id = archivedLineId(line)
    if (id) ids.add(id)
  }
  return ids
}

/** Full text of shortened messages (originals.jsonl), by id. */
async function readOriginals(dir: string): Promise<Map<string, SessionMessage>> {
  const originals = new Map<string, SessionMessage>()
  let raw = ''
  try {
    raw = await readFile(path.join(path.resolve(dir), 'originals.jsonl'), 'utf8')
  } catch {
    return originals
  }
  for (const line of raw.split('\n')) {
    const message = parseArchivedLine(line)
    if (message && !originals.has(message.id)) originals.set(message.id, message)
  }
  return originals
}

/**
 * Every message the conversation ever had, in order: archived messages from
 * the transcript followed by the live history. Synthetic entries (the
 * compaction boundary, per-run runtime context) are left out.
 *
 * Ordering rule, shared with readHistoryPage: a message appears once, at the
 * position of its newest copy (a live message wins over archived copies);
 * its text is the original (originals.jsonl, else the oldest copy that was
 * not shortened). Older transcripts could hold a message twice.
 */
export async function readFullHistory(
  dir: string,
  live: readonly SessionMessage[],
  isSynthetic: (message: SessionMessage) => boolean,
): Promise<{ messages: SessionMessage[]; archived: number }> {
  const liveIds = new Set(live.map((message) => message.id))
  const originals = await readOriginals(dir)
  let raw = ''
  try {
    raw = await readFile(path.join(path.resolve(dir), 'transcript.jsonl'), 'utf8')
  } catch {
    raw = ''
  }
  const copies: SessionMessage[] = []
  for (const line of raw.split('\n')) {
    const message = parseArchivedLine(line)
    if (message) copies.push(message)
  }
  // Oldest unshortened copy of each id, for the text.
  for (const message of copies) {
    if (!originals.has(message.id) && !SHRUNK_NOTE.test(message.content ?? '')) originals.set(message.id, message)
  }
  const placed = new Set<string>(liveIds)
  const archived: SessionMessage[] = []
  for (let i = copies.length - 1; i >= 0; i -= 1) {
    const message = copies[i]!
    if (placed.has(message.id)) continue
    placed.add(message.id)
    if (!isSynthetic(message)) archived.push(withOriginalText(message, originals))
  }
  archived.reverse()
  const visibleLive = live
    .filter((message) => !isSynthetic(message))
    .map((message) => withOriginalText(message, originals))
  return { messages: [...archived, ...visibleLive], archived: archived.length }
}

function withOriginalText(message: SessionMessage, originals: ReadonlyMap<string, SessionMessage>): SessionMessage {
  if (!SHRUNK_NOTE.test(message.content ?? '')) return message
  return originals.get(message.id) ?? message
}

export type HistoryPageOptions = {
  /** Most messages returned (newest first selection, returned oldest first). */
  limit: number
  /** Return only messages older than this message id (exclusive). */
  before?: string
  /** Which messages count (and are returned). */
  include: (message: SessionMessage) => boolean
  /** Shape of a returned message (strip heavy fields). */
  project?: (message: SessionMessage) => SessionMessage
}

export type HistoryPage = {
  messages: SessionMessage[]
  /** Older matching messages exist before the first returned one. */
  hasMore: boolean
  /** Pass as `before` to get the previous page. */
  nextBefore?: string
}

const SHRUNK_NOTE = /\((?:full text in the archive|middle omitted)|（完整原文见归档|（中间部分已省略|chars omitted\] …/

/**
 * Lines of a file from the last to the first, read in chunks from the end
 * (a newline byte never occurs inside a UTF-8 sequence, so splitting the raw
 * bytes is safe).
 */
async function* readLinesBackward(filePath: string, chunkBytes = 1 << 20): AsyncGenerator<string> {
  let handle: import('node:fs/promises').FileHandle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return
  }
  try {
    let position = (await handle.stat()).size
    let carry: Buffer = Buffer.alloc(0)
    while (position > 0) {
      const size = Math.min(chunkBytes, position)
      position -= size
      const chunk = Buffer.alloc(size)
      await handle.read(chunk, 0, size, position)
      const buffer = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk
      let end = buffer.length
      for (let i = buffer.length - 1; i >= 0; i -= 1) {
        if (buffer[i] !== 0x0a) continue
        if (end > i + 1) yield buffer.toString('utf8', i + 1, end)
        end = i
      }
      carry = Buffer.from(buffer.subarray(0, end))
    }
    if (carry.length > 0) yield carry.toString('utf8')
  } finally {
    await handle.close()
  }
}

function parseArchivedLine(line: string): SessionMessage | undefined {
  if (!line.trim()) return undefined
  try {
    const message = (JSON.parse(line) as { message?: SessionMessage }).message
    return message && typeof message === 'object' && typeof message.id === 'string' ? message : undefined
  } catch {
    return undefined // a torn last line after a crash
  }
}

/**
 * One page of the user-visible history, newest last, read from the end of
 * the transcript archive without reading all of it (a long-lived session's
 * archive can be tens of megabytes). Same rule as readFullHistory: each id
 * once, at its newest copy. The scan from the end passes every id at or
 * after the cursor first, so all copies of those ids are skipped and each
 * page strictly moves back; a cursor that is not found ends the paging.
 */
export async function readHistoryPage(
  dir: string,
  live: readonly SessionMessage[],
  isSynthetic: (message: SessionMessage) => boolean,
  options: HistoryPageOptions,
): Promise<HistoryPage> {
  const transcriptPath = path.join(path.resolve(dir), 'transcript.jsonl')
  const project = options.project ?? ((message: SessionMessage) => message)
  const originals = await readOriginals(dir)
  const limit = Math.max(1, options.limit)

  const placed = new Set<string>() // ids whose position (newest copy) was passed
  const collected: SessionMessage[] = []
  let passedCursor = options.before === undefined
  let hasMore = false
  let done = false
  const consider = (message: SessionMessage): void => {
    if (placed.has(message.id)) {
      // An older copy of a message already placed: only its text may help.
      const at = collected.findIndex((entry) => entry.id === message.id)
      if (at >= 0 && SHRUNK_NOTE.test(collected[at]!.content ?? '') && !SHRUNK_NOTE.test(message.content ?? '')) {
        collected[at] = message
      }
      return
    }
    placed.add(message.id)
    if (!passedCursor) {
      if (message.id === options.before) passedCursor = true
      return
    }
    if (isSynthetic(message) || !options.include(message)) return
    if (collected.length >= limit) {
      hasMore = true
      done = true
      return
    }
    collected.push(message)
  }

  for (let i = live.length - 1; i >= 0 && !done; i -= 1) consider(live[i]!)
  if (!done) {
    for await (const line of readLinesBackward(transcriptPath)) {
      const message = parseArchivedLine(line)
      if (message) consider(message)
      if (done) break
    }
  }
  if (!passedCursor) return { messages: [], hasMore: false }

  // Shortened messages show their full text.
  const shrunkIds = collected.filter((message) => SHRUNK_NOTE.test(message.content ?? '') && !originals.has(message.id)).map((m) => m.id)
  if (shrunkIds.length > 0) {
    const wanted = new Set(shrunkIds)
    for await (const line of readLinesBackward(transcriptPath)) {
      if (wanted.size === 0) break
      if (![...wanted].some((id) => line.includes(JSON.stringify(id)))) continue
      const message = parseArchivedLine(line)
      if (message && wanted.has(message.id) && !SHRUNK_NOTE.test(message.content ?? '')) {
        originals.set(message.id, message)
        wanted.delete(message.id)
      }
    }
  }
  const messages = collected.reverse().map((message) => project(withOriginalText(message, originals)))
  return {
    messages,
    hasMore,
    ...(hasMore && messages[0] ? { nextBefore: messages[0].id } : {}),
  }
}
