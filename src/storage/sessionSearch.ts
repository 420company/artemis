/**
 * storage/sessionSearch.ts — cross-session full-text search
 *
 * Primary path: SQLite FTS5 index stored in `.artemis/session-search.sqlite`.
 * Compatibility path: in-memory parsed-session scan when SQLite is unavailable.
 *
 * Session saves incrementally upsert into the SQLite index; searches also run a
 * lightweight disk sync so pre-existing or externally-modified session files
 * are picked up without requiring a rebuild step.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveDataRootDir } from '../utils/fs.js'
import type { SessionRecord } from '../core/types.js'

type SqliteModule = typeof import('node:sqlite')
type SqliteDatabase = import('node:sqlite').DatabaseSync

export interface SessionSearchResult {
  sessionId: string
  sessionTitle: string
  updatedAt: string
  matchCount: number
  /** Up to 3 surrounding-context snippets */
  snippets: string[]
}

type IndexedSessionEntry = {
  sessionId: string
  sessionTitle: string
  updatedAt: string
  messages: Array<{ role: string; content: string }>
}

type SqliteBackend = {
  db: SqliteDatabase
  sessionDir: string
}

type SqliteSearchRow = {
  sessionId: string
  sessionTitle: string
  updatedAt: string
  sourceFile: string
  score: number
}

const sessionSearchIndexCache = new Map<string, IndexedSessionEntry[]>()
const sqliteBackendCache = new Map<string, SqliteBackend | null>()
let sqliteModulePromise: Promise<SqliteModule | null> | undefined

function getDataRoot(cwd: string): string {
  return resolveDataRootDir(cwd)
}

function getSessionDir(cwd: string): string {
  return path.join(getDataRoot(cwd), 'sessions')
}

function getSearchDbPath(cwd: string): string {
  return path.join(getDataRoot(cwd), 'session-search.sqlite')
}

function getSessionFilePath(cwd: string, sessionId: string): string {
  return path.join(getSessionDir(cwd), `${sessionId}.json`)
}

function tokenizeQuery(query: string): string[] {
  return [...new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
      .map((token) => token.trim())
      .filter(Boolean),
  )]
}

function buildFtsQuery(query: string): string | null {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) {
    return null
  }
  return tokens.map((token) => `${token}*`).join(' AND ')
}

function normalizeMessages(session: SessionRecord): IndexedSessionEntry['messages'] {
  return (session.messages ?? [])
    .filter((msg) =>
      msg.role !== 'system' &&
      typeof msg.content === 'string' &&
      msg.content.length > 0,
    )
    .map((msg) => ({ role: msg.role, content: msg.content }))
}

function toIndexedEntry(session: SessionRecord): IndexedSessionEntry {
  return {
    sessionId: session.id,
    sessionTitle: session.title,
    updatedAt: session.updatedAt,
    messages: normalizeMessages(session),
  }
}

function buildSearchDocument(entry: IndexedSessionEntry): string {
  return entry.messages
    .map((msg) => `[${msg.role}] ${msg.content.replace(/\n+/g, ' ')}`)
    .join('\n')
}

function buildMatcher(query: string): {
  matches(text: string): { index: number; length: number } | null
} {
  const normalizedQuery = query.trim().toLowerCase()
  const tokens = tokenizeQuery(query)

  return {
    matches(text: string) {
      const lower = text.toLowerCase()
      const exactIndex = normalizedQuery ? lower.indexOf(normalizedQuery) : -1
      if (exactIndex >= 0) {
        return { index: exactIndex, length: normalizedQuery.length }
      }

      if (tokens.length === 0 || !tokens.every((token) => lower.includes(token))) {
        return null
      }

      const firstIndex = tokens
        .map((token) => lower.indexOf(token))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0]
      const firstToken = tokens[0] ?? normalizedQuery
      return {
        index: firstIndex ?? 0,
        length: firstToken.length,
      }
    },
  }
}

function computeSessionSearchResult(
  session: IndexedSessionEntry,
  query: string,
): SessionSearchResult | null {
  const matcher = buildMatcher(query)
  const snippets: string[] = []
  let matchCount = 0

  for (const msg of session.messages) {
    const match = matcher.matches(msg.content)
    if (!match) continue

    matchCount += 1
    if (snippets.length < 3) {
      const start = Math.max(0, match.index - 60)
      const end = Math.min(msg.content.length, match.index + match.length + 120)
      const snippet =
        (start > 0 ? '…' : '') +
        msg.content.slice(start, end).replace(/\n+/g, ' ') +
        (end < msg.content.length ? '…' : '')
      snippets.push(`[${msg.role}] ${snippet}`)
    }
  }

  if (matchCount === 0) {
    return null
  }

  return {
    sessionId: session.sessionId,
    sessionTitle: session.sessionTitle,
    updatedAt: session.updatedAt,
    matchCount,
    snippets,
  }
}

async function loadIndexedSessions(cwd: string): Promise<IndexedSessionEntry[]> {
  const dir = getSessionDir(cwd)
  const cached = sessionSearchIndexCache.get(dir)
  if (cached) {
    return cached
  }

  let files: string[]
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.json'))
  } catch {
    return []
  }

  const entries = (await Promise.all(
    files.map(async (file): Promise<IndexedSessionEntry | null> => {
      try {
        const raw = await readFile(path.join(dir, file), 'utf8')
        return toIndexedEntry(JSON.parse(raw) as SessionRecord)
      } catch {
        return null
      }
    }),
  )).filter((entry): entry is IndexedSessionEntry => entry !== null)

  sessionSearchIndexCache.set(dir, entries)
  return entries
}

async function searchSessionsInMemory(
  cwd: string,
  query: string,
  maxResults: number,
): Promise<SessionSearchResult[]> {
  const indexedSessions = await loadIndexedSessions(cwd)
  const nowMs = Date.now()
  const decayHalfLifeDays = 30
  const msPerDay = 86400000

  return indexedSessions
    .map((session) => computeSessionSearchResult(session, query))
    .filter((result): result is SessionSearchResult => result !== null)
    .sort((a, b) => {
      const ageMsA = Math.max(0, nowMs - Date.parse(a.updatedAt))
      const ageMsB = Math.max(0, nowMs - Date.parse(b.updatedAt))
      const decayA = Math.max(0.1, Math.exp(-(ageMsA / msPerDay) / decayHalfLifeDays))
      const decayB = Math.max(0.1, Math.exp(-(ageMsB / msPerDay) / decayHalfLifeDays))

      const scoreA = a.matchCount * decayA
      const scoreB = b.matchCount * decayB

      if (scoreB !== scoreA) return scoreB - scoreA
      return b.updatedAt.localeCompare(a.updatedAt)
    })
    .slice(0, maxResults)
}

async function loadSqliteModule(): Promise<SqliteModule | null> {
  if (!sqliteModulePromise) {
    const originalEmitWarning = process.emitWarning.bind(process)
    const filteredEmitWarning = ((warning: unknown, ...args: unknown[]) => {
      const warningText =
        typeof warning === 'string'
          ? warning
          : warning instanceof Error
            ? warning.message
            : ''
      if (/SQLite is an experimental feature/i.test(warningText)) {
        return
      }
      return (originalEmitWarning as (...emitArgs: unknown[]) => void)(warning, ...args)
    }) as typeof process.emitWarning

    process.emitWarning = filteredEmitWarning
    sqliteModulePromise = import('node:sqlite')
      .then((module) => module)
      .catch(() => null)
      .finally(() => {
        process.emitWarning = originalEmitWarning as typeof process.emitWarning
      })
  }
  return sqliteModulePromise
}

function ensureSqliteSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_search_meta (
      source_file TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      file_mtime_ms INTEGER NOT NULL
    );
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_search_meta_session_id
      ON session_search_meta(session_id);
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts
      USING fts5(
        session_id UNINDEXED,
        session_title,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
  `)
}

async function getSqliteBackend(cwd: string): Promise<SqliteBackend | null> {
  const sessionDir = getSessionDir(cwd)
  if (sqliteBackendCache.has(sessionDir)) {
    return sqliteBackendCache.get(sessionDir) ?? null
  }

  const sqlite = await loadSqliteModule()
  if (!sqlite) {
    sqliteBackendCache.set(sessionDir, null)
    return null
  }

  try {
    const db = new sqlite.DatabaseSync(getSearchDbPath(cwd))
    db.exec('PRAGMA journal_mode = WAL;')
    ensureSqliteSchema(db)
    const backend = { db, sessionDir }
    sqliteBackendCache.set(sessionDir, backend)
    return backend
  } catch {
    sqliteBackendCache.set(sessionDir, null)
    return null
  }
}

function removeIndexedSession(backend: SqliteBackend, sourceFile: string, sessionId: string): void {
  backend.db.prepare(
    'DELETE FROM session_search_fts WHERE session_id = ?',
  ).run(sessionId)
  backend.db.prepare(
    'DELETE FROM session_search_meta WHERE source_file = ?',
  ).run(sourceFile)
}

function upsertIndexedSession(
  backend: SqliteBackend,
  entry: IndexedSessionEntry,
  sourceFile: string,
  fileMtimeMs: number,
): void {
  backend.db.prepare(
    'DELETE FROM session_search_fts WHERE session_id = ?',
  ).run(entry.sessionId)
  backend.db.prepare(`
    INSERT INTO session_search_fts(session_id, session_title, content)
    VALUES (?, ?, ?)
  `).run(entry.sessionId, entry.sessionTitle, buildSearchDocument(entry))
  backend.db.prepare(`
    INSERT INTO session_search_meta(source_file, session_id, session_title, updated_at, file_mtime_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_file) DO UPDATE SET
      session_id = excluded.session_id,
      session_title = excluded.session_title,
      updated_at = excluded.updated_at,
      file_mtime_ms = excluded.file_mtime_ms
  `).run(
    sourceFile,
    entry.sessionId,
    entry.sessionTitle,
    entry.updatedAt,
    Math.round(fileMtimeMs),
  )
}

async function syncSqliteIndexFromDisk(
  cwd: string,
  backend: SqliteBackend,
): Promise<void> {
  let files: string[]
  try {
    files = (await readdir(backend.sessionDir)).filter((file) => file.endsWith('.json'))
  } catch {
    return
  }

  const rows = backend.db.prepare(`
    SELECT source_file AS sourceFile, session_id AS sessionId, file_mtime_ms AS fileMtimeMs
    FROM session_search_meta
  `).all() as Array<{ sourceFile: string; sessionId: string; fileMtimeMs: number }>
  const metaByFile = new Map(rows.map((row) => [row.sourceFile, row]))
  const liveFiles = new Set(files)

  for (const row of rows) {
    if (!liveFiles.has(row.sourceFile)) {
      removeIndexedSession(backend, row.sourceFile, row.sessionId)
    }
  }

  for (const file of files) {
    const filePath = path.join(backend.sessionDir, file)
    let fileMtimeMs = 0
    try {
      fileMtimeMs = Math.round((await stat(filePath)).mtimeMs)
    } catch {
      continue
    }

    const existing = metaByFile.get(file)
    if (existing && Math.round(existing.fileMtimeMs) === fileMtimeMs) {
      continue
    }

    try {
      const raw = await readFile(filePath, 'utf8')
      const session = JSON.parse(raw) as SessionRecord
      upsertIndexedSession(backend, toIndexedEntry(session), file, fileMtimeMs)
    } catch {
      continue
    }
  }
}

async function loadSessionEntryById(
  cwd: string,
  sessionId: string,
): Promise<IndexedSessionEntry | null> {
  try {
    const raw = await readFile(getSessionFilePath(cwd, sessionId), 'utf8')
    return toIndexedEntry(JSON.parse(raw) as SessionRecord)
  } catch {
    return null
  }
}

async function searchSessionsWithSqlite(
  cwd: string,
  query: string,
  maxResults: number,
): Promise<SessionSearchResult[] | null> {
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery) {
    return null
  }

  const backend = await getSqliteBackend(cwd)
  if (!backend) {
    return null
  }

  try {
    await syncSqliteIndexFromDisk(cwd, backend)
    const candidateLimit = Math.max(maxResults * 3, maxResults + 6)
    const rows = backend.db.prepare(`
      SELECT
        meta.session_id AS sessionId,
        meta.session_title AS sessionTitle,
        meta.updated_at AS updatedAt,
        meta.source_file AS sourceFile,
        bm25(session_search_fts, 10.0, 1.0) AS score
      FROM session_search_fts
      JOIN session_search_meta AS meta
        ON meta.session_id = session_search_fts.session_id
      WHERE session_search_fts MATCH ?
      ORDER BY score ASC, meta.updated_at DESC
      LIMIT ?
    `).all(ftsQuery, candidateLimit) as SqliteSearchRow[]

    if (rows.length === 0) {
      return []
    }

    const detailed = await Promise.all(
      rows.map(async (row) => {
        const entry = await loadSessionEntryById(cwd, row.sessionId)
        if (!entry) return null
        const result = computeSessionSearchResult(entry, query)
        if (!result) return null
        return { ...result, score: row.score }
      }),
    )

    const nowMs = Date.now()
    const decayHalfLifeDays = 30
    const msPerDay = 86400000

    return detailed
      .filter((entry): entry is SessionSearchResult & { score: number } => entry !== null)
      .sort((a, b) => {
        const ageMsA = Math.max(0, nowMs - Date.parse(a.updatedAt))
        const ageMsB = Math.max(0, nowMs - Date.parse(b.updatedAt))
        const decayA = Math.max(0.1, Math.exp(-(ageMsA / msPerDay) / decayHalfLifeDays))
        const decayB = Math.max(0.1, Math.exp(-(ageMsB / msPerDay) / decayHalfLifeDays))

        // FTS5 bm25 score is negative; a larger absolute value means a better match.
        // Multiplying by decay factor (< 1) makes the score LESS negative (closer to 0), thus worsening it.
        const decayedScoreA = a.score * decayA
        const decayedScoreB = b.score * decayB
        
        if (decayedScoreA !== decayedScoreB) {
            return decayedScoreA - decayedScoreB
        }
        return b.updatedAt.localeCompare(a.updatedAt)
      })
      .slice(0, maxResults)
      .map(({ score: _score, ...result }) => result)
  } catch {
    sqliteBackendCache.set(getSessionDir(cwd), null)
    return null
  }
}

export function invalidateSessionSearchCache(cwd: string): void {
  sessionSearchIndexCache.delete(getSessionDir(cwd))
}

export async function syncSessionSearchIndex(
  cwd: string,
  session: SessionRecord,
): Promise<void> {
  invalidateSessionSearchCache(cwd)

  const backend = await getSqliteBackend(cwd)
  if (!backend) {
    return
  }

  try {
    const filePath = getSessionFilePath(cwd, session.id)
    let fileMtimeMs = Date.now()
    try {
      fileMtimeMs = Math.round((await stat(filePath)).mtimeMs)
    } catch {
      fileMtimeMs = Date.now()
    }
    upsertIndexedSession(
      backend,
      toIndexedEntry(session),
      `${session.id}.json`,
      fileMtimeMs,
    )
  } catch {
    sqliteBackendCache.set(getSessionDir(cwd), null)
  }
}

export async function searchSessions(
  cwd: string,
  query: string,
  opts: { maxResults?: number } = {},
): Promise<SessionSearchResult[]> {
  if (!query.trim()) return []

  const maxResults = opts.maxResults ?? 12
  const sqliteResults = await searchSessionsWithSqlite(cwd, query, maxResults)
  if (sqliteResults && sqliteResults.length > 0) {
    return sqliteResults
  }

  return searchSessionsInMemory(cwd, query, maxResults)
}
