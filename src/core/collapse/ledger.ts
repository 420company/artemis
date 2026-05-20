/**
 * collapse/ledger.ts — Persistent Collapse Ledger
 *
 * Records every compression event so that critical context can be
 * restored after compaction. Without this, Artemis "forgets" file
 * state, plans, tool definitions, and MCP instructions after
 * compressing — exactly the "失忆" problem users report.
 *
 * Inspired by ClaudeCode's compact → postCompactCleanup → attachment
 * restoration pipeline, but adapted to Artemis's session-based architecture.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
// SessionMessage type not directly used here but related modules re-export it

// ─── Types ──────────────────────────────────────────────────────────

export interface CollapseEntry {
  /** Unique ID for this collapse event */
  id: string
  /** ISO timestamp */
  collapsedAt: string
  /** Token counts before/after */
  tokensBefore: number
  tokensAfter: number
  /** Which messages were compressed (their IDs) */
  compressedMessageIds: string[]
  /** The summary text injected (if any) */
  summaryText?: string
  /** Summary message ID (so we can locate it later) */
  summaryMessageId?: string
  /** Whether this was a microcompact or full compact */
  mode: 'microcompact' | 'full_compact'
}

export interface FileStateSnapshot {
  /** File path */
  filePath: string
  /** Content hash (sha256) — so we can detect if file changed since collapse */
  contentHash: string
  /** First N chars of content for quick restore (limited) */
  headContent: string
  /** Full content stored as artifact path on disk */
  artifactPath?: string
  /** Last modified time */
  mtimeMs: number
  /**
   * Wall-clock ms when this file path was most recently referenced in the
   * conversation (read/write/patch). Used to demote stale snapshots so
   * recovery messages don't keep replaying files the user has moved on from.
   * Optional for backward compat with older ledger entries.
   */
  lastReferencedAt?: number
}

export interface PlanSnapshot {
  /** The plan text */
  content: string
  /** Status */
  status: string
}

export interface CollapseLedger {
  /** Session this ledger belongs to */
  sessionId: string
  /** All collapse events, ordered chronologically */
  entries: CollapseEntry[]
  /** File states captured at last collapse */
  fileStates: FileStateSnapshot[]
  /** Plan state captured at last collapse */
  planSnapshot?: PlanSnapshot
  /** Tool names that were active at collapse time */
  activeTools: string[]
  /** MCP server IDs that were connected at collapse time */
  activeMcpServers: string[]
  /** Skill contexts that were loaded */
  activeSkills: string[]
  /** Created at / updated at */
  createdAt: string
  updatedAt: string
}

// ─── Persistence ────────────────────────────────────────────────────

const LEDGER_DIR = path.join(
  process.env.HOME || process.cwd(),
  '.artemis',
  'collapse-ledger',
)

function sessionIdToSafeFileName(sessionId: string): string {
  // Hash the sessionId to ensure it's a safe file name without path separators
  return createHash('sha256').update(sessionId).digest('hex').substring(0, 16)
}

function ledgerPath(sessionId: string): string {
  const safeId = sessionIdToSafeFileName(sessionId)
  return path.join(LEDGER_DIR, `${safeId}.json`)
}

function artifactDir(sessionId: string): string {
  const safeId = sessionIdToSafeFileName(sessionId)
  return path.join(LEDGER_DIR, 'artifacts', safeId)
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export async function loadLedger(sessionId: string): Promise<CollapseLedger | null> {
  const fp = ledgerPath(sessionId)
  try {
    const raw = await readFile(fp, 'utf-8')
    return JSON.parse(raw) as CollapseLedger
  } catch {
    return null
  }
}

export async function saveLedger(ledger: CollapseLedger): Promise<void> {
  await ensureDir(LEDGER_DIR)
  ledger.updatedAt = new Date().toISOString()
  const fp = ledgerPath(ledger.sessionId)
  await writeFile(fp, JSON.stringify(ledger, null, 2), 'utf-8')
}

export async function createLedger(sessionId: string): Promise<CollapseLedger> {
  const ledger: CollapseLedger = {
    sessionId,
    entries: [],
    fileStates: [],
    activeTools: [],
    activeMcpServers: [],
    activeSkills: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await saveLedger(ledger)
  return ledger
}

export async function getOrCreateLedger(sessionId: string): Promise<CollapseLedger> {
  const existing = await loadLedger(sessionId)
  if (existing) return existing
  return createLedger(sessionId)
}

// ─── Record a collapse event ────────────────────────────────────────

export async function recordCollapse(
  sessionId: string,
  entry: CollapseEntry,
  snapshot: {
    fileStates?: FileStateSnapshot[]
    planSnapshot?: PlanSnapshot
    activeTools?: string[]
    activeMcpServers?: string[]
    activeSkills?: string[]
  },
): Promise<CollapseLedger> {
  const ledger = await getOrCreateLedger(sessionId)

  // Append entry
  ledger.entries.push(entry)

  // Keep only the 50 most recent entries to avoid unbounded growth
  if (ledger.entries.length > 50) {
    ledger.entries = ledger.entries.slice(-50)
  }

  // Update snapshots (always use latest)
  if (snapshot.fileStates) {
    ledger.fileStates = snapshot.fileStates
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, 'planSnapshot')) {
    if (snapshot.planSnapshot) {
      ledger.planSnapshot = snapshot.planSnapshot
    } else {
      delete ledger.planSnapshot
    }
  }
  if (snapshot.activeTools) {
    ledger.activeTools = snapshot.activeTools
  }
  if (snapshot.activeMcpServers) {
    ledger.activeMcpServers = snapshot.activeMcpServers
  }
  if (snapshot.activeSkills) {
    ledger.activeSkills = snapshot.activeSkills
  }

  await saveLedger(ledger)
  return ledger
}

// ─── File state helpers ─────────────────────────────────────────────

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const FILE_HEAD_CHARS = 800

export function createFileStateSnapshot(
  filePath: string,
  content: string,
  mtimeMs: number,
  lastReferencedAt?: number,
): FileStateSnapshot {
  return {
    filePath,
    contentHash: hashContent(content),
    headContent: content.slice(0, FILE_HEAD_CHARS),
    mtimeMs,
    lastReferencedAt,
  }
}

/**
 * Save a full file content as an artifact on disk.
 * This lets us restore the complete file state without keeping
 * it all in the ledger JSON.
 */
export async function saveFileArtifact(
  sessionId: string,
  filePath: string,
  content: string,
): Promise<string> {
  const dir = artifactDir(sessionId)
  await ensureDir(dir)
  const safeName = filePath.replace(/[^a-zA-Z0-9._-]/g, '_')
  const artifactPath = path.join(dir, `${safeName}.artifact`)
  await writeFile(artifactPath, content, 'utf-8')
  return artifactPath
}

export async function loadFileArtifact(artifactPath: string): Promise<string | null> {
  try {
    return await readFile(artifactPath, 'utf-8')
  } catch {
    return null
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────

export async function cleanupLedger(sessionId: string): Promise<void> {
  const fp = ledgerPath(sessionId)
  const adir = artifactDir(sessionId)
  try {
    if (existsSync(fp)) await rm(fp)
    if (existsSync(adir)) await rm(adir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup
  }
}

// ─── Query helpers ──────────────────────────────────────────────────

export function getLastCollapse(ledger: CollapseLedger): CollapseEntry | null {
  if (ledger.entries.length === 0) return null
  return ledger.entries[ledger.entries.length - 1]!
}

export function getCollapseCount(ledger: CollapseLedger): number {
  return ledger.entries.length
}

export function getTokenSavings(ledger: CollapseLedger): number {
  return ledger.entries.reduce(
    (sum, e) => sum + (e.tokensBefore - e.tokensAfter),
    0,
  )
}
