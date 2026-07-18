/**
 * core/crashHandler.ts — last-resort crash capture
 *
 * Installs unconditional uncaughtException/unhandledRejection handlers. On a
 * fatal error: restore the terminal first (raw mode off + ANSI mode resets),
 * persist a redacted crash report to <artemis home>/last-crash.json (0600),
 * then exit non-zero. The next launch surfaces the report and archives it to
 * <artemis home>/crashes/ (last 5 kept).
 */

import { join } from 'node:path'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, chmod } from 'node:fs/promises'
import { resolveArtemisHomeDir } from '../utils/fs.js'
import { redactText } from '../utils/redact.js'
import { APP_VERSION } from '../appMeta.js'

const CRASH_FILE = 'last-crash.json'
const CRASH_ARCHIVE_DIR = 'crashes'
const MAX_ARCHIVED_CRASHES = 5

/**
 * Every DEC private mode the TUI may enable, disabled in one write: sync
 * update off, cursor shown, mouse tracking off (all variants), bracketed
 * paste off, focus reporting off, kitty keyboard pop, scroll region reset,
 * SGR reset, alt screen left.
 */
const TERMINAL_RESTORE_SEQ =
  '\x1b[?2026l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[<u\x1b[r\x1b[0m\x1b[?1049l'

export interface CrashReport {
  version: string
  timestamp: string
  kind: 'uncaughtException' | 'unhandledRejection'
  name: string
  message?: string
  stack?: string
}

function restoreTerminal(): void {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false)
    }
  } catch { /* stdin may already be closed */ }
  try {
    const out = process.stdout.isTTY ? process.stdout : process.stderr.isTTY ? process.stderr : null
    out?.write(TERMINAL_RESTORE_SEQ)
  } catch { /* nothing left to restore onto */ }
}

/**
 * Two-phase write: a minimal skeleton lands first so a second fault while
 * redacting the stack still leaves a usable report on disk.
 */
function writeCrashReport(kind: CrashReport['kind'], reason: unknown): string {
  const home = resolveArtemisHomeDir()
  mkdirSync(home, { recursive: true })
  const filePath = join(home, CRASH_FILE)
  const err = reason instanceof Error ? reason : undefined
  const skeleton: CrashReport = {
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    kind,
    name: err?.name || 'Error',
  }
  writeFileSync(filePath, JSON.stringify(skeleton, null, 2), { mode: 0o600 })
  // mode only applies on create — force 0600 on a preexisting file too
  try { chmodSync(filePath, 0o600) } catch { /* best effort */ }

  const full: CrashReport = {
    ...skeleton,
    message: redactText(err ? err.message : String(reason)).slice(0, 2000),
    stack: err?.stack ? redactText(err.stack).slice(0, 16_000) : undefined,
  }
  writeFileSync(filePath, JSON.stringify(full, null, 2), { mode: 0o600 })
  return filePath
}

let installed = false
let handlingFatal = false

function handleFatal(kind: CrashReport['kind'], reason: unknown): void {
  if (handlingFatal) {
    // Fault while handling a fault — nothing more to save, just get out.
    process.exit(1)
  }
  handlingFatal = true
  restoreTerminal()
  let reportPath: string | undefined
  try {
    reportPath = writeCrashReport(kind, reason)
  } catch { /* disk unavailable — still exit cleanly */ }
  try {
    const message = reason instanceof Error ? reason.message : String(reason)
    process.stderr.write(
      `\nArtemis crashed (${kind}): ${redactText(message).slice(0, 300)}\n` +
      (reportPath ? `Crash report: ${reportPath}\n` : ''),
    )
  } catch { /* stderr gone */ }
  process.exit(1)
}

/**
 * Idempotent; call once at process start, before anything else runs. Existing
 * exit/SIGINT handlers elsewhere are untouched — process.exit(1) here still
 * runs their 'exit' hooks.
 */
export function installCrashHandler(): void {
  if (installed) return
  installed = true
  process.on('uncaughtException', (err) => handleFatal('uncaughtException', err))
  process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason))
}

export interface PreviousCrash {
  report: Partial<CrashReport>
  archivePath: string
}

/**
 * Detect a crash report left by the previous run. Archives it under
 * <artemis home>/crashes/ (newest MAX_ARCHIVED_CRASHES kept) and removes the
 * original so it is only surfaced once. Returns null when there was no crash.
 */
export async function checkPreviousCrash(): Promise<PreviousCrash | null> {
  const home = resolveArtemisHomeDir()
  const filePath = join(home, CRASH_FILE)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return null
  }
  let report: Partial<CrashReport> = {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') report = parsed as Partial<CrashReport>
  } catch { /* corrupt report — archive the raw bytes anyway */ }

  const archiveDir = join(home, CRASH_ARCHIVE_DIR)
  const stamp = (typeof report.timestamp === 'string' ? report.timestamp : new Date().toISOString())
    .replace(/[:.]/g, '-')
  const archivePath = join(archiveDir, `crash-${stamp}.json`)
  try {
    await mkdir(archiveDir, { recursive: true })
    await rename(filePath, archivePath)
    await chmod(archivePath, 0o600)
    const archived = (await readdir(archiveDir)).filter((f) => f.startsWith('crash-') && f.endsWith('.json')).sort()
    while (archived.length > MAX_ARCHIVED_CRASHES) {
      const oldest = archived.shift()!
      await rm(join(archiveDir, oldest), { force: true })
    }
  } catch {
    // Archiving is best-effort; still remove the original so the notice
    // doesn't repeat on every launch.
    await rm(filePath, { force: true }).catch(() => {})
  }
  return { report, archivePath }
}
