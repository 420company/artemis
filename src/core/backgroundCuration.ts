/**
 * core/backgroundCuration.ts — bookkeeping for background curator work.
 *
 * Finished runs start curators (long-term memory, learned skills) that the
 * run itself never waits for. Each one is tracked here so a host — or a
 * test — can wait for them before it exits or changes the process state
 * they read (cwd, ARTEMIS_HOME, provider stores).
 */

/** memory: the long-term memory curator; skill: learned-skill work. */
export type CurationKind = 'memory' | 'skill'

const pending = new Map<Promise<void>, CurationKind>()

/** Track a background curation; failures are swallowed (passive routine). */
export function trackCuration(work: Promise<unknown>, kind: CurationKind = 'memory'): void {
  const tracked: Promise<void> = work
    .then(() => undefined, () => undefined)
    .finally(() => { pending.delete(tracked) })
  pending.set(tracked, kind)
}

function pendingOf(kind?: CurationKind): Promise<void>[] {
  return [...pending.entries()].filter(([, entryKind]) => !kind || entryKind === kind).map(([promise]) => promise)
}

/** Resolves once every tracked curation (of a kind, or all), including ones started meanwhile, has finished. */
export async function settleCurations(kind?: CurationKind): Promise<void> {
  for (let batch = pendingOf(kind); batch.length > 0; batch = pendingOf(kind)) await Promise.allSettled(batch)
}

/**
 * settleCurations() bounded by a timeout, for a process that is about to
 * exit: it waits for curators to finish but never hangs the exit.
 * Resolves true when everything (of that kind) settled in time.
 */
export async function settleCurationsWithin(timeoutMs: number, kind?: CurationKind): Promise<boolean> {
  if (pendingOf(kind).length === 0) return true
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
  })
  try {
    return await Promise.race([settleCurations(kind).then(() => true), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * How long an exiting process waits for learned-skill curation:
 * ARTEMIS_CURATION_SETTLE_MS when set (0 = do not wait), else 60 s. The
 * long-term memory curator is not capped by it (see settleBeforeExit).
 */
export function curationSettleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const text = env.ARTEMIS_CURATION_SETTLE_MS?.trim()
  const raw = text ? Number(text) : Number.NaN
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000
}

/**
 * Before a one-shot process exits: wait for the memory curator as long as
 * it takes (as before learned skills existed), and for skill curation up to
 * curationSettleTimeoutMs(). Resolves true when everything settled.
 */
export async function settleBeforeExit(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const [, skillsSettled] = await Promise.all([
    settleCurations('memory'),
    settleCurationsWithin(curationSettleTimeoutMs(env), 'skill'),
  ])
  return skillsSettled && pendingOf().length === 0
}

/** Number of curations still running (diagnostics and tests). */
export function pendingCurationCount(kind?: CurationKind): number {
  return pendingOf(kind).length
}
