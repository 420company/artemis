/**
 * Advisory per-session lock, so two processes (a chat bridge and a web
 * `artemis execute`, say) do not run the same session at once and overwrite
 * each other's history.
 *
 * The lock is a file created with O_EXCL next to the session JSON. A lock
 * whose owner process is gone (same host) or that is older than `staleMs`
 * is taken over. Waiting is bounded: after `timeoutMs` a SessionBusyError
 * explains who holds it.
 */

import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'

export class SessionBusyError extends Error {
  readonly code = 'session_busy'
  constructor(message: string) {
    super(message)
    this.name = 'SessionBusyError'
  }
}

type LockOwner = { pid: number; host: string; createdAt: string }

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
    return typeof parsed?.pid === 'number' ? parsed : undefined
  } catch {
    return undefined
  }
}

function isStale(owner: LockOwner | undefined, staleMs: number): boolean {
  if (!owner) return true // unreadable or half-written: treat as abandoned
  const age = Date.now() - Date.parse(owner.createdAt)
  if (!Number.isFinite(age) || age > staleMs) return true
  return owner.host === hostname() && !processAlive(owner.pid)
}

export async function withSessionLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number; pollMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const staleMs = options.staleMs ?? 6 * 60 * 60_000
  const pollMs = options.pollMs ?? 250
  const deadline = Date.now() + timeoutMs
  // A brand-new session may not have its directory yet.
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }))
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await readOwner(lockPath)
      if (isStale(owner, staleMs)) {
        await rm(lockPath, { force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new SessionBusyError(
          `${options.label ?? 'This session'} is in use by another Artemis process (pid ${owner?.pid} on ${owner?.host}); try again when it finishes.`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}
