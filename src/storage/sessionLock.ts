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
 * for itself.
 */

import { link, open, readFile, rename, rm, stat, utimes, mkdir } from 'node:fs/promises'
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

const held = new AsyncLocalStorage<ReadonlySet<string>>()
/** Locks held by this process: path -> token (for release on exit or signal). */
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
 * Remove an abandoned lock without removing a fresh one that replaced it in
 * between: move it aside, check it is the one judged stale, and put it back
 * if it is not.
 */
async function takeOver(lockPath: string, judged: LockOwner | undefined): Promise<void> {
  const aside = `${lockPath}.stale-${randomBytes(6).toString('hex')}`
  try {
    await rename(lockPath, aside)
  } catch {
    return // someone else moved or released it
  }
  const moved = await readOwner(aside)
  if (moved?.token && judged?.token !== moved.token) {
    // A new owner got in after we looked: give its lock back.
    await link(aside, lockPath).catch(() => undefined)
  }
  await rm(aside, { force: true }).catch(() => undefined)
}

function releaseSync(lockPath: string, token: string): void {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as LockOwner
    if (owner?.token === token) unlinkSync(lockPath)
  } catch {
    /* already gone */
  }
}

let cleanupInstalled = false
function installCleanup(): void {
  if (cleanupInstalled) return
  cleanupInstalled = true
  const releaseAll = (): void => {
    for (const [lockPath, token] of processLocks) releaseSync(lockPath, token)
    processLocks.clear()
  }
  process.on('exit', releaseAll)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const onSignal = (): void => {
      if (processLocks.size === 0) return
      releaseAll()
      // Nobody else handles the signal: restore the default (terminate).
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, onSignal)
        process.kill(process.pid, signal)
      }
    }
    process.on(signal, onSignal)
  }
}

/** True when the current async call chain holds `lockPath`. */
export function holdsSessionLock(lockPath: string): boolean {
  const resolved = path.resolve(lockPath)
  // The async context outlives the lock in background work started under
  // it, so the lock must also still be held by this process.
  return (held.getStore()?.has(resolved) ?? false) && processLocks.has(resolved)
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
        await takeOver(resolved, owner)
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

  const heldNow = new Set(held.getStore() ?? [])
  heldNow.add(resolved)
  try {
    return await held.run(heldNow, fn)
  } finally {
    clearInterval(beat)
    processLocks.delete(resolved)
    const owner = await readOwner(resolved)
    if (owner?.token === token) await rm(resolved, { force: true }).catch(() => undefined)
  }
}
