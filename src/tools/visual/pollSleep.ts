/**
 * The wait between status polls of a video task. Production waits the
 * interval it is given (never under MIN_POLL_INTERVAL_MS); tests replace the
 * wait so a mocked task that is already finished is read at once.
 */

/** Shortest interval between two status polls of a real video task. */
export const MIN_POLL_INTERVAL_MS = 1000;

type PollSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

let override: PollSleep | undefined;

/** Wait before the next status poll. */
export function pollSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return (override ?? waitFor)(ms, signal);
}

/** Tests: replace the wait between polls (undefined restores it). */
export function setPollSleepForTests(sleep: PollSleep | undefined): void {
  override = sleep;
}

/** The poll interval to use: the one asked for, never under the minimum. */
export function pollIntervalFor(requested: number | undefined, fallback: number): number {
  return typeof requested === 'number' && Number.isFinite(requested) ? Math.max(MIN_POLL_INTERVAL_MS, Math.floor(requested)) : fallback;
}

/** How many polls to make: the count asked for, else the fallback. */
export function maxPollsFor(requested: number | undefined, fallback: number): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : fallback;
}
