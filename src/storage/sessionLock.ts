/**
 * Advisory per-session lock, so two processes (a chat bridge and a web
 * `artemis execute`, say) do not run the same session at once and overwrite
 * each other's history.
 *
 * The lock is a file created with O_EXCL next to the session JSON. It holds
 * a random owner token; while the lock is held its mtime is refreshed (a
 * heartbeat), so a lock whose heartbeat stopped for `staleMs` is abandoned,
 * whatever host or pid wrote it (containers get recreated, pids get reused).
 * Only the owner whose token is still in the file removes it. Waiting is
 * bounded: after `timeoutMs` (30s by default, or ARTEMIS_SESSION_LOCK_TIMEOUT_MS)
 * a SessionBusyError is thrown.
 *
 * Re-entrant within one async call chain: code already running under the
 * lock (a load that needs to quarantine a damaged file, say) does not wait
 * for itself. Work started under a hold that has since ended (a detached
 * background task) is not inside it any more and waits like anyone else.
 *
 * SIGINT/SIGTERM handlers exist only while a lock is held: they release the
 * locks and re-raise the signal with its default action.
 */

import { open, readFile, rm, stat, utimes, mkdir } from 'node:fs/promises'
import { readFileSync, unlinkSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import path from 'node:path'

/** Exit code of a CLI run refused because its session is busy (sysexits EX_TEMPFAIL). */
export const SESSION_BUSY_EXIT_CODE = 75

export const SESSION_BUSY_MESSAGE = 'This conversation is busy with another task; try again in a moment.'
export const SESSION_BUSY_MESSAGE_ZH = '这个对话正在处理另一个任务，请稍后再试。'

export class SessionBusyError extends Error {
  readonly code = 'session_busy'
  readonly exitCode = SESSION_BUSY_EXIT_CODE
  constructor(message = SESSION_BUSY_MESSAGE) {
    super(message)
    this.name = 'SessionBusyError'
  }
}

type LockOwner = { token?: string; pid?: number; host?: string; createdAt?: string }

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_STALE_MS = 60_000
/** A takeover guard older than this was left by a crashed process. */
const TAKEOVER_GUARD_STALE_MS = 10_000

/** Locks the current async chain entered: path -> owner token of that hold. */
const held = new AsyncLocalStorage<ReadonlyMap<string, string>>()
/** Locks held by this process right now: path -> token (for release on exit or signal). */
const processLocks = new Map<string, string>()

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as LockOwner
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Last sign of life of a lock: the heartbeat (mtime) for locks that carry a
 * token, the creation time for older locks without one, and the mtime for
 * a lock that cannot be read (possibly being written right now).
 */
async function lastAlive(lockPath: string, owner: LockOwner | undefined): Promise<number | undefined> {
  if (owner && !owner.token && owner.createdAt) {
    const created = Date.parse(owner.createdAt)
    if (Number.isFinite(created)) return created
  }
  try {
    return (await stat(lockPath)).mtimeMs
  } catch {
    return undefined
  }
}

async function isStale(lockPath: string, owner: LockOwner | undefined, staleMs: number): Promise<boolean> {
  // Same host and the owner process is gone: no need to wait for the heartbeat.
  if (owner?.host === hostname() && typeof owner.pid === 'number' && owner.pid !== process.pid && !processAlive(owner.pid)) {
    return true
  }
  const alive = await lastAlive(lockPath, owner)
  if (alive === undefined) return false // vanished meanwhile: just retry
  return Date.now() - alive >= staleMs
}

/**
 * Remove an abandoned lock. Only one contender at a time may do it (an
 * O_EXCL guard file), and it re-checks under the guard that the lock is
 * still the one judged stale, so a fresh lock that replaced it is never
 * removed.
 */
async function takeOver(lockPath: string, judged: LockOwner | undefined, staleMs: number): Promise<void> {
  const guard = `${lockPath}.takeover`
  try {
    const handle = await open(guard, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        if (Date.now() - (await stat(guard)).mtimeMs > TAKEOVER_GUARD_STALE_MS) await rm(guard, { force: true })
      } catch { /* gone */ }
    }
    return
  }
  try {
    const current = await readOwner(lockPath)
    if (JSON.stringify(current) === JSON.stringify(judged) && await isStale(lockPath, current, staleMs)) {
      await rm(lockPath, { force: true })
    }
  } finally {
    await rm(guard, { force: true }).catch(() => undefined)
  }
}

function releaseSync(lockPath: string, token: string): void {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as LockOwner
    if (owner?.token === token) unlinkSync(lockPath)
  } catch {
    /* already gone */
  }
}

const releaseAll = (): void => {
  for (const [lockPath, token] of processLocks) releaseSync(lockPath, token)
  processLocks.clear()
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const
const signalHandlers = new Map<NodeJS.Signals, () => void>()

/** Installed while at least one lock is held; removed with the last one. */
function installCleanup(): void {
  if (signalHandlers.size > 0) return
  process.on('exit', releaseAll)
  for (const signal of SIGNALS) {
    const onSignal = (): void => {
      releaseAll()
      uninstallCleanup()
      // Nobody else handles the signal: re-raise it with the default action
      // (terminate). Otherwise the other handlers decide.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    }
    signalHandlers.set(signal, onSignal)
    process.on(signal, onSignal)
  }
}

function uninstallCleanup(): void {
  process.removeListener('exit', releaseAll)
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
  signalHandlers.clear()
}

/** True when the current async call chain is inside a hold of `lockPath` that is still in effect. */
export function holdsSessionLock(lockPath: string): boolean {
  const resolved = path.resolve(lockPath)
  const token = held.getStore()?.get(resolved)
  return token !== undefined && processLocks.get(resolved) === token
}

export async function withSessionLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number; pollMs?: number; label?: string } = {},
): Promise<T> {
  const resolved = path.resolve(lockPath)
  if (holdsSessionLock(resolved)) return fn()
  const envTimeout = Number(process.env.ARTEMIS_SESSION_LOCK_TIMEOUT_MS)
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout >= 0 ? envTimeout : DEFAULT_TIMEOUT_MS)
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const pollMs = options.pollMs ?? 250
  const deadline = Date.now() + timeoutMs
  const token = randomBytes(16).toString('hex')
  // A brand-new session may not have its directory yet.
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      const handle = await open(resolved, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }))
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await readOwner(resolved)
      if (await isStale(resolved, owner, staleMs)) {
        await takeOver(resolved, owner, staleMs)
        continue
      }
      if (Date.now() >= deadline) throw new SessionBusyError()
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  installCleanup()
  processLocks.set(resolved, token)
  // Heartbeat: refresh the mtime while the lock is held (only while it is still ours).
  const beat = setInterval(() => {
    void (async () => {
      const owner = await readOwner(resolved)
      if (owner?.token !== token) return
      const nowSec = Date.now() / 1000
      await utimes(resolved, nowSec, nowSec).catch(() => undefined)
    })()
  }, Math.max(20, Math.floor(staleMs / 4)))
  beat.unref?.()

  const heldNow = new Map(held.getStore() ?? [])
  heldNow.set(resolved, token)
  try {
    return await held.run(heldNow, fn)
  } finally {
    clearInterval(beat)
    if (processLocks.get(resolved) === token) processLocks.delete(resolved)
    if (processLocks.size === 0) uninstallCleanup()
    const owner = await readOwner(resolved)
    if (owner?.token === token) await rm(resolved, { force: true }).catch(() => undefined)
  }
}
