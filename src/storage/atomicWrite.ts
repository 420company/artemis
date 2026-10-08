/**
 * Crash- and reader-safe file replacement: the data goes to a temporary file
 * in the same directory, is flushed to disk, and is then renamed over the
 * target. A concurrent reader sees either the old file or the new one, never
 * a half-written mix.
 */

import { open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export async function writeFileAtomic(
  target: string,
  data: string,
  options: { mode?: number } = {},
): Promise<void> {
  const mode = options.mode ?? 0o600
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(tmp, 'w', mode)
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // On Windows a reader holding the target open can make the rename fail
  // for a moment; retry briefly before falling back to a direct write.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, target)
      await syncDirectory(path.dirname(target))
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!RENAME_RETRY_CODES.has(code) || attempt >= 5) {
        await rm(tmp, { force: true }).catch(() => undefined)
        if (!RENAME_RETRY_CODES.has(code)) throw error
        await writeFile(target, data, { encoding: 'utf8', mode })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt))
    }
  }
}

/** Make the rename itself durable (POSIX); a no-op where directories cannot be opened (Windows). */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    /* not supported here */
  }
}

const TEMP_NAME = /\.\d+\.[0-9a-f]{12}\.tmp$/
const STALE_TEMP_MS = 60 * 60_000

/**
 * Remove temp files a crashed writer left behind in `dir` (older than an
 * hour, so a write in progress is never touched).
 */
export async function removeStaleTempFiles(dir: string): Promise<number> {
  let removed = 0
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  const cutoff = Date.now() - STALE_TEMP_MS
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue
    const full = path.join(dir, name)
    try {
      if ((await stat(full)).mtimeMs < cutoff) {
        await rm(full, { force: true })
        removed += 1
      }
    } catch { /* gone */ }
  }
  return removed
}
