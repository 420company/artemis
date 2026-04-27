/**
 * Session ownership lock — prevents two interactive workers from simultaneously
 * writing to the same session.
 *
 * Lock file: .artemis/session-lock-{sessionId}.json
 * Written on interactive entry, removed on clean exit or process signal.
 * Stale locks (dead PID) are automatically cleared.
 */

import { writeFile, unlink, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { ensureDir, pathExists, resolveDataRootDir } from '../utils/fs.js';

export type SessionLockInfo = {
  pid: number;
  startedAt: string;
  hostname: string;
  sessionId: string;
};

function lockPath(cwd: string, sessionId: string): string {
  return path.join(resolveDataRootDir(cwd), `session-lock-${sessionId}.json`);
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
        ? err.code
        : undefined;
    // EPERM means the process exists but we can't signal it (still running)
    return code === 'EPERM';
  }
}

/**
 * Read the lock file and return its contents if it exists and the owning
 * process is still alive.  Returns undefined if the lock is absent or stale.
 */
export async function readSessionLock(
  cwd: string,
  sessionId: string,
): Promise<SessionLockInfo | undefined> {
  const p = lockPath(cwd, sessionId);
  if (!(await pathExists(p))) return undefined;

  let info: SessionLockInfo;
  try {
    const raw = await readFile(p, 'utf8');
    info = JSON.parse(raw) as SessionLockInfo;
  } catch {
    return undefined;
  }

  // Stale lock — owning process is no longer running
  if (!isProcessRunning(info.pid)) {
    await removeStaleLock(cwd, sessionId);
    return undefined;
  }

  // Lock is owned by this process itself — not a conflict
  if (info.pid === process.pid) return undefined;

  return info;
}

async function removeStaleLock(cwd: string, sessionId: string): Promise<void> {
  try {
    await unlink(lockPath(cwd, sessionId));
  } catch {
    // Best-effort
  }
}

/**
 * Acquire the session lock.  Returns a `release()` function that removes
 * the lock file.
 *
 * Callers should call `release()` on clean exit and register it with
 * process exit handlers.
 */
export async function acquireSessionLock(
  cwd: string,
  sessionId: string,
): Promise<() => Promise<void>> {
  const p = lockPath(cwd, sessionId);
  await ensureDir(path.dirname(p));

  const info: SessionLockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    sessionId,
  };

  await writeFile(p, JSON.stringify(info, null, 2), 'utf8');

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      // Only remove if we still own the lock (compare pid)
      const raw = await readFile(p, 'utf8').catch(() => null);
      if (raw) {
        const current = JSON.parse(raw) as SessionLockInfo;
        if (current.pid === process.pid) {
          await unlink(p);
        }
      }
    } catch {
      // Best-effort cleanup
    }
  };

  return release;
}

/**
 * Formats a human-readable conflict warning for the user.
 */
export function formatLockConflictWarning(
  lock: SessionLockInfo,
  sessionId: string,
): string {
  const age = Math.round((Date.now() - new Date(lock.startedAt).getTime()) / 1000);
  return [
    `Session ${sessionId} is already attached by another interactive process.`,
    `  PID:     ${lock.pid}`,
    `  Host:    ${lock.hostname}`,
    `  Started: ${lock.startedAt} (${age}s ago)`,
    '',
    'Taking over will cause the other worker to write to the same session concurrently.',
    'If the other process is still running, consider stopping it first.'
  ].join('\n');
}
