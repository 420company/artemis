/**
 * Push-based mid-turn interjection buffer, shared across every input surface.
 *
 * Any entry point (interactive prompt, bridges, detached workflows) can push a
 * user message into the per-session queue at any time; the agent loop drains
 * the queue at safe points (turn-loop top and pre-return) and injects each
 * entry as a synthetic user message instead of aborting in-flight work.
 *
 * Legacy callers that only expose a `pollRunningUserMessages` callback keep
 * working through `attachPollSource`, which periodically harvests the callback
 * into the queue. `harvestPollSources()` is also called synchronously at each
 * drain point, so safe-point injection has no polling latency.
 */

export type PendingInterjection = {
  text: string;
  receivedAt: string;
};

const INTERJECTION_POLL_SOURCE_INTERVAL_MS = 250;

/** Truncation threshold for oversized interjection text. */
const LARGE_INTERJECTION_THRESHOLD = 25_000;

/**
 * Marker stored in SessionMessage.name for injected interjections so
 * compression/replay can recognize them. Providers only interpret `name` on
 * tool-role messages, so a user-role marker is inert everywhere else.
 */
export const INTERJECTION_MESSAGE_NAME = 'user_interjection';

/**
 * Wrap interjection text as a synthetic user message with a mid-turn note.
 * No deferral instruction: the model decides how to weigh it against
 * in-flight work.
 */
export function formatInterjection(text: string): string {
  const truncated =
    text.length > LARGE_INTERJECTION_THRESHOLD
      ? `${text.slice(0, LARGE_INTERJECTION_THRESHOLD)}... [truncated]`
      : text;
  return `The user sent a message while you were working:\n<user_query>\n${truncated}\n</user_query>`;
}

export class InterjectionQueue {
  private entries: PendingInterjection[] = [];
  private pollSources = new Set<() => string[]>();
  private pollTimers = new Map<() => string[], ReturnType<typeof setInterval>>();

  push(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.entries.push({ text: clean, receivedAt: new Date().toISOString() });
  }

  /** Synchronously harvest every attached poll source into the queue. */
  harvestPollSources(): void {
    for (const poll of this.pollSources) {
      let batch: string[];
      try {
        batch = poll() ?? [];
      } catch {
        batch = [];
      }
      for (const text of batch) {
        this.push(text);
      }
    }
  }

  /**
   * Compatibility layer for legacy `pollRunningUserMessages` callers: the
   * callback is polled on an interval (and synchronously at each drain point
   * via `harvestPollSources`) with results pushed into the queue. Returns a
   * detach function that performs one final harvest before removal.
   */
  attachPollSource(
    poll: () => string[],
    intervalMs: number = INTERJECTION_POLL_SOURCE_INTERVAL_MS,
  ): () => void {
    this.pollSources.add(poll);
    const timer = setInterval(() => {
      if (!this.pollSources.has(poll)) return;
      let batch: string[];
      try {
        batch = poll() ?? [];
      } catch {
        batch = [];
      }
      for (const text of batch) {
        this.push(text);
      }
    }, intervalMs);
    timer.unref?.();
    this.pollTimers.set(poll, timer);
    return () => {
      const active = this.pollTimers.get(poll);
      if (active) {
        clearInterval(active);
        this.pollTimers.delete(poll);
      }
      if (this.pollSources.has(poll)) {
        let batch: string[];
        try {
          batch = poll() ?? [];
        } catch {
          batch = [];
        }
        for (const text of batch) {
          this.push(text);
        }
        this.pollSources.delete(poll);
      }
    };
  }

  /** FIFO drain of every buffered entry. */
  drainAll(): PendingInterjection[] {
    if (this.entries.length === 0) return [];
    const drained = this.entries;
    this.entries = [];
    return drained;
  }

  get size(): number {
    return this.entries.length;
  }

  isEmpty(): boolean {
    return this.entries.length === 0 && this.pollSources.size === 0;
  }
}

const queuesBySession = new Map<string, InterjectionQueue>();

/** Get (or lazily create) the interjection queue for a session. */
export function getInterjectionQueue(sessionId: string): InterjectionQueue {
  let queue = queuesBySession.get(sessionId);
  if (!queue) {
    queue = new InterjectionQueue();
    queuesBySession.set(sessionId, queue);
  }
  return queue;
}

/** Direct push entry point for hosts that know the target session id. */
export function pushInterjection(sessionId: string, text: string): void {
  getInterjectionQueue(sessionId).push(text);
}

/** Drop the registry entry once a run ends and nothing is left buffered. */
export function releaseInterjectionQueueIfEmpty(sessionId: string): void {
  const queue = queuesBySession.get(sessionId);
  if (queue && queue.isEmpty()) {
    queuesBySession.delete(sessionId);
  }
}

// ── Subagent coordination ────────────────────────────────────────────────────
// Central registry of live child-agent runs keyed by the parent session id.
// When a parent run unwinds (interrupt, sibling failure inside a parallel
// batch, any thrown error), it broadcasts abort to every still-registered
// child instead of leaving them orphaned.

const subagentRunsByParent = new Map<string, Set<AbortController>>();

export function registerSubagentRun(
  parentRunId: string,
  controller: AbortController,
): void {
  let controllers = subagentRunsByParent.get(parentRunId);
  if (!controllers) {
    controllers = new Set();
    subagentRunsByParent.set(parentRunId, controllers);
  }
  controllers.add(controller);
}

export function releaseSubagentRun(
  parentRunId: string,
  controller: AbortController,
): void {
  const controllers = subagentRunsByParent.get(parentRunId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) {
    subagentRunsByParent.delete(parentRunId);
  }
}

/** Abort every registered child run of a parent. Returns how many were live. */
export function abortSubagentRuns(parentRunId: string): number {
  const controllers = subagentRunsByParent.get(parentRunId);
  if (!controllers || controllers.size === 0) return 0;
  let aborted = 0;
  for (const controller of controllers) {
    if (!controller.signal.aborted) {
      controller.abort();
      aborted += 1;
    }
  }
  subagentRunsByParent.delete(parentRunId);
  return aborted;
}
