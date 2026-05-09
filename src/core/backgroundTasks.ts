/**
 * Process-wide registry for long-running tool calls (image gen, video gen,
 * delegate_task) that should not block the agent's tool-batch loop.
 *
 * Design intent
 * -------------
 * The agent's main loop is turn-based: model emits tool_use → runtime executes
 * → result is sent back → model emits next response. For tools that take
 * 20-300s (image/video generation, agent delegation), this stalls the entire
 * loop on a single I/O wait, even though the model could be doing other useful
 * work in parallel.
 *
 * This module provides a fire-and-forget mechanism:
 *   1. The tool dispatcher calls `start(runner)` which returns a taskId
 *      synchronously.
 *   2. The runner runs in the background.
 *   3. On completion (success or failure), the registered callback fires.
 *      The agent loop's wrapper uses this callback to inject a `system`
 *      message into the session, so the *next* turn sees the result.
 *
 * Visibility: callers can subscribe to `change` events to render an
 * always-visible panel of in-flight background tasks.
 *
 * Scope: process-wide singleton. Background tasks die with the process — by
 * design, no on-disk persistence. CLI sessions are short-lived.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export type BackgroundTaskKind =
  | 'generate_image'
  | 'generate_video'
  | 'generate_long_video'
  | 'delegate_task';

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed';

export interface BackgroundTaskRecord {
  id: string;
  kind: BackgroundTaskKind;
  label: string;
  startedAtMs: number;
  completedAtMs?: number;
  status: BackgroundTaskStatus;
  /** Human-readable result text (e.g. file path or summary) on success. */
  result?: string;
  /** Error message on failure. */
  error?: string;
}

export interface StartTaskOptions<T> {
  kind: BackgroundTaskKind;
  label: string;
  runner: () => Promise<T>;
  /**
   * Called when runner resolves successfully. Receives both the runner's
   * raw return value and the registry record (which has elapsed time, etc.).
   */
  onComplete: (result: T, record: BackgroundTaskRecord) => void | Promise<void>;
  /**
   * Optional semantic failure check for runners that resolve structured
   * `{ ok: false }` results instead of throwing.
   */
  isFailureResult?: (result: T) => boolean;
  /**
   * Called when runner rejects or throws. The registry catches the error and
   * never re-throws — caller must handle inside this callback.
   */
  onError: (error: Error, record: BackgroundTaskRecord) => void | Promise<void>;
}

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private readonly emitter = new EventEmitter();

  /**
   * Start a background task. Returns a synchronously-allocated taskId.
   * The runner is launched on the next tick so this method itself never throws
   * from runner errors.
   */
  start<T>(options: StartTaskOptions<T>): string {
    const id = `bg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const record: BackgroundTaskRecord = {
      id,
      kind: options.kind,
      label: options.label,
      startedAtMs: Date.now(),
      status: 'running',
    };
    this.tasks.set(id, record);
    this.emitter.emit('change');

    // Defer to next tick so callers see `start` return before any callback fires.
    queueMicrotask(() => {
      Promise.resolve()
        .then(() => options.runner())
        .then(async (result) => {
          record.status = options.isFailureResult?.(result) === true
            ? 'failed'
            : 'completed';
          record.completedAtMs = Date.now();
          this.emitter.emit('change');
          try {
            await options.onComplete(result, record);
          } catch (callbackError) {
            // Registry never crashes from callback failures.
            const msg =
              callbackError instanceof Error
                ? callbackError.message
                : String(callbackError);
            record.error = `onComplete callback failed: ${msg}`;
            this.emitter.emit('change');
          }
        })
        .catch(async (error) => {
          record.status = 'failed';
          record.completedAtMs = Date.now();
          record.error = error instanceof Error ? error.message : String(error);
          this.emitter.emit('change');
          try {
            await options.onError(
              error instanceof Error ? error : new Error(String(error)),
              record,
            );
          } catch {
            // Swallow — registry is best-effort.
          }
        });
    });

    return id;
  }

  get(id: string): BackgroundTaskRecord | undefined {
    return this.tasks.get(id);
  }

  /** All tasks currently in `running` state, sorted oldest first. */
  listActive(): BackgroundTaskRecord[] {
    const out: BackgroundTaskRecord[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === 'running') out.push(t);
    }
    out.sort((a, b) => a.startedAtMs - b.startedAtMs);
    return out;
  }

  /**
   * All tasks (running + completed + failed). Used for status panel that
   * keeps recently-finished tasks visible briefly.
   */
  listAll(): BackgroundTaskRecord[] {
    return [...this.tasks.values()].sort(
      (a, b) => a.startedAtMs - b.startedAtMs,
    );
  }

  /**
   * Remove tasks that completed or failed more than `maxAgeMs` ago. Called by
   * UI render loop so the panel naturally clears itself.
   */
  pruneFinished(maxAgeMs: number): void {
    const now = Date.now();
    let mutated = false;
    for (const [id, t] of this.tasks) {
      if (
        (t.status === 'completed' || t.status === 'failed') &&
        t.completedAtMs !== undefined &&
        now - t.completedAtMs > maxAgeMs
      ) {
        this.tasks.delete(id);
        mutated = true;
      }
    }
    if (mutated) this.emitter.emit('change');
  }

  on(event: 'change', listener: () => void): void {
    this.emitter.on(event, listener);
  }

  off(event: 'change', listener: () => void): void {
    this.emitter.off(event, listener);
  }
}

let singleton: BackgroundTaskRegistry | undefined;

export function getBackgroundTaskRegistry(): BackgroundTaskRegistry {
  if (!singleton) {
    singleton = new BackgroundTaskRegistry();
  }
  return singleton;
}

/**
 * Format an active task line for the status panel.
 *   "🎨 image: 'a red cube...' · 23s"
 */
export function formatBackgroundTaskLine(
  record: BackgroundTaskRecord,
  nowMs = Date.now(),
): string {
  const icon =
    record.kind === 'generate_image'
      ? '🎨'
      : record.kind === 'generate_video' || record.kind === 'generate_long_video'
        ? '🎬'
        : '👩‍🦳';
  const elapsed = Math.max(
    0,
    Math.floor(((record.completedAtMs ?? nowMs) - record.startedAtMs) / 1000),
  );
  const statusTag =
    record.status === 'running'
      ? `${elapsed}s`
      : record.status === 'completed'
        ? `✓ ${elapsed}s`
        : `✗ ${elapsed}s`;
  return `${icon} ${record.label} · ${statusTag}`;
}
