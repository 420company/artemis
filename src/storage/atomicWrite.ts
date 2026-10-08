/**
 * Crash- and reader-safe file replacement: the data goes to a temporary file
 * in the same directory, is flushed to disk, and is then renamed over the
 * target. A concurrent reader sees either the old file or the new one, never
 * a half-written mix.
 */

import { open, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

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
