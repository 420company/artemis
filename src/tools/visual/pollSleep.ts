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

/** Longest interval between two polls: a slow interval would leave a finished clip waiting. */
export const MAX_POLL_INTERVAL_MS = 30_000;
/** Shortest total wait on a video task: a caller asking for less would give up on a task that keeps running. */
export const MIN_POLL_WAIT_MS = 5 * 60_000;
/** Longest total wait on a video task in one call. */
export const MAX_POLL_WAIT_MS = 40 * 60_000;

/**
 * How a video task is polled: the interval and count the caller asks for
 * (else the defaults), with the interval kept within 1–30 s and the total
 * wait within 5–40 minutes, so a caller can neither give up on a task that
 * keeps running (and is billed) nor wait without end.
 */
export function videoPollPlan(
  requested: { maxPolls?: number; pollIntervalMs?: number },
  defaults: { maxPolls: number; pollIntervalMs: number },
): { maxPolls: number; pollIntervalMs: number } {
  const given = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const pollIntervalMs = Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.floor(given(requested.pollIntervalMs) ? requested.pollIntervalMs : defaults.pollIntervalMs)));
  const requestedWait = given(requested.maxPolls) ? Math.floor(requested.maxPolls) * pollIntervalMs : defaults.maxPolls * defaults.pollIntervalMs;
  const wait = Math.min(MAX_POLL_WAIT_MS, Math.max(MIN_POLL_WAIT_MS, requestedWait));
  return { maxPolls: Math.max(1, Math.ceil(wait / pollIntervalMs)), pollIntervalMs };
}

/** Calls `report` once for each new whole minute waited (about once a minute while a task is polled). */
export function minuteReporter(report: (minutes: number) => void, alreadyWaitedMs = 0): (waitedMs: number) => void {
  let reported = Math.floor(alreadyWaitedMs / 60_000);
  return (waitedMs) => {
    const minutes = Math.floor(waitedMs / 60_000);
    if (minutes > reported) {
      reported = minutes;
      report(minutes);
    }
  };
}
