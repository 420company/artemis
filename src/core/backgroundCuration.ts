/**
 * core/backgroundCuration.ts — bookkeeping for background curator work.
 *
 * Finished runs start curators (long-term memory, learned skills) that the
 * run itself never waits for. Each one is tracked here so a host — or a
 * test — can wait for all of them before it exits or changes the process
 * state they read (cwd, ARTEMIS_HOME, provider stores).
 */

const pending = new Set<Promise<void>>()

/** Track a background curation; failures are swallowed (passive routine). */
export function trackCuration(work: Promise<unknown>): void {
  const tracked: Promise<void> = work
    .then(() => undefined, () => undefined)
    .finally(() => { pending.delete(tracked) })
  pending.add(tracked)
}

/** Resolves once every tracked curation (including ones started meanwhile) has finished. */
export async function settleCurations(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}

/**
 * settleCurations() bounded by a timeout, for a process that is about to
 * exit: it waits for curators to finish but never hangs the exit.
 * Resolves true when everything settled in time.
 */
export async function settleCurationsWithin(timeoutMs: number): Promise<boolean> {
  if (pending.size === 0) return true
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
  })
  try {
    return await Promise.race([settleCurations().then(() => true), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * How long an exiting process waits for curators: ARTEMIS_CURATION_SETTLE_MS
 * when set (0 = do not wait), else 60 s.
 */
export function curationSettleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const text = env.ARTEMIS_CURATION_SETTLE_MS?.trim()
  const raw = text ? Number(text) : Number.NaN
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000
}

/** Number of curations still running (diagnostics and tests). */
export function pendingCurationCount(): number {
  return pending.size
}
