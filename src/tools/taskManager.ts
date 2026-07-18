import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { join as joinPath } from 'node:path';
import type { AgentAction } from '../core/types.js';
import { invalidateWalkFilesCache } from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

// ── output capture: front/tail dual buffer + full spill-to-disk ──────────────
// In-memory state per stream is bounded to a frozen "front" half plus a rolling
// "tail" half; the complete stream is written to a log file on disk so the
// model can recover omitted middle sections with read_file / search_files.

const HALF_BUDGET_CHARS = 3_000;
const TOMBSTONE_TAIL_CHARS = 64 * 1024;
const MAX_LOG_FILE_BYTES = 512 * 1024 * 1024;
const LOG_DIR = joinPath(tmpdir(), 'artemis-command-logs');

export class DualBuffer {
  private front: string | null = null;
  private tail = '';
  totalChars = 0;

  constructor(private readonly halfBudget = HALF_BUDGET_CHARS) {}

  append(text: string): void {
    if (!text) return;
    this.totalChars += text.length;
    if (this.front === null) {
      this.tail += text;
      if (this.tail.length > this.halfBudget * 2) {
        this.front = this.tail.slice(0, this.halfBudget);
        this.tail = this.tail.slice(-this.halfBudget);
      }
    } else {
      this.tail = this.tail.length + text.length > this.halfBudget
        ? (this.tail + text).slice(-this.halfBudget)
        : this.tail + text;
    }
  }

  get truncated(): boolean {
    return this.front !== null;
  }

  /** Render "front + annotation + tail" (or the whole content when small). */
  render(logPath?: string): string {
    if (this.front === null) return this.tail;
    const shown = this.front.length + this.tail.length;
    const where = logPath ? ` — full output at: ${logPath}` : '';
    return (
      `${this.front}\n` +
      `[truncated: showing first/last ${shown} of ${this.totalChars} chars${where}]\n` +
      this.tail
    );
  }

  /** Drop the frozen front and keep only a bounded tail (tombstone memory). */
  trimForTombstone(): void {
    this.front = null;
    if (this.tail.length > TOMBSTONE_TAIL_CHARS) {
      this.tail = this.tail.slice(-TOMBSTONE_TAIL_CHARS);
    }
  }
}

export type CommandCapture = {
  stdout: DualBuffer;
  stderr: DualBuffer;
  logPath: string;
  logStream: WriteStream | null;
  loggedBytes: number;
  logCapped: boolean;
};

export function createCommandCapture(): CommandCapture {
  const logPath = joinPath(
    LOG_DIR,
    `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.log`,
  );
  let logStream: WriteStream | null = null;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', () => {
      /* disk trouble must never break command execution */
    });
  } catch {
    logStream = null;
  }
  return {
    stdout: new DualBuffer(),
    stderr: new DualBuffer(),
    logPath,
    logStream,
    loggedBytes: 0,
    logCapped: false,
  };
}

export function appendCaptureChunk(
  capture: CommandCapture,
  stream: 'stdout' | 'stderr',
  chunk: Buffer | string,
): void {
  const text = String(chunk);
  capture[stream].append(text);
  if (capture.logStream && !capture.logCapped) {
    const bytes = Buffer.byteLength(text);
    if (capture.loggedBytes + bytes > MAX_LOG_FILE_BYTES) {
      capture.logCapped = true;
      try {
        capture.logStream.write(
          `\n[log capped at ${MAX_LOG_FILE_BYTES} bytes — further output not persisted]\n`,
        );
      } catch { /* ignore */ }
      return;
    }
    capture.loggedBytes += bytes;
    try {
      capture.logStream.write(text);
    } catch { /* ignore */ }
  }
}

export function closeCaptureLog(capture: CommandCapture): void {
  if (capture.logStream) {
    try { capture.logStream.end(); } catch { /* ignore */ }
    capture.logStream = null;
  }
}

/** Remove the on-disk log when nothing was truncated (nothing to recover). */
export function discardCaptureLogIfComplete(capture: CommandCapture): void {
  if (capture.stdout.truncated || capture.stderr.truncated || capture.logCapped) return;
  closeCaptureLog(capture);
  try { unlinkSync(capture.logPath); } catch { /* ignore */ }
}

// ── background task manager ──────────────────────────────────────────────────

const TOMBSTONE_TTL_MS = 5 * 60_000;
const BACKGROUND_MAX_RUNTIME_MS = 10 * 60 * 60_000;
const SIGKILL_GRACE_MS = 1_500;
const MAX_TRACKED_TASKS = 50;

export type BackgroundReason = 'explicit' | 'foreground-timeout';
export type TaskStatus = 'running' | 'completed' | 'killed' | 'failed';

export type BackgroundTask = {
  id: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  child: ChildProcess | null;
  status: TaskStatus;
  exitCode: number | null;
  signal: string | null;
  reason: BackgroundReason;
  killReason: 'kill_task' | 'max_runtime' | null;
  startedAt: number;
  completedAt: number | null;
  capture: CommandCapture;
  maxRuntimeTimer: NodeJS.Timeout | null;
  tombstoneTimer: NodeJS.Timeout | null;
  completionWaiters: Array<() => void>;
};

const isWindows = process.platform === 'win32';

function killProcessTree(task: BackgroundTask, signal: NodeJS.Signals): void {
  const child = task.child;
  if (!child) return;
  if (!isWindows && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through to direct kill when no distinct process group exists
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

class TaskManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly pendingReminders = new Map<string, string>();
  private exitHookInstalled = false;

  get runningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') count += 1;
    }
    return count;
  }

  hasCapacity(): boolean {
    return this.runningCount < MAX_TRACKED_TASKS;
  }

  /**
   * Take ownership of an already-spawned child (explicit background start or a
   * foreground command whose timeout budget expired). The caller's stream
   * listeners keep feeding `capture`; the caller must route the eventual
   * close event to `finalize()`.
   */
  adopt(options: {
    child: ChildProcess;
    capture: CommandCapture;
    command: string;
    cwd: string;
    reason: BackgroundReason;
  }): BackgroundTask {
    this.installExitHook();
    const id = `task_${randomBytes(4).toString('hex')}`;
    const task: BackgroundTask = {
      id,
      command: options.command,
      cwd: options.cwd,
      pid: options.child.pid,
      child: options.child,
      status: 'running',
      exitCode: null,
      signal: null,
      reason: options.reason,
      killReason: null,
      startedAt: Date.now(),
      completedAt: null,
      capture: options.capture,
      maxRuntimeTimer: null,
      tombstoneTimer: null,
      completionWaiters: [],
    };
    task.maxRuntimeTimer = setTimeout(() => {
      if (task.status !== 'running') return;
      task.killReason = 'max_runtime';
      killProcessTree(task, 'SIGTERM');
      setTimeout(() => {
        if (task.status === 'running') killProcessTree(task, 'SIGKILL');
      }, SIGKILL_GRACE_MS).unref?.();
    }, BACKGROUND_MAX_RUNTIME_MS);
    task.maxRuntimeTimer.unref?.();
    this.tasks.set(id, task);
    return task;
  }

  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId.trim());
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  /** Called from the child's close handler once the process tree winds down. */
  finalize(taskId: string, exitCode: number | null, signal: string | null): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;
    task.exitCode = exitCode;
    task.signal = signal;
    task.completedAt = Date.now();
    if (task.killReason) {
      task.status = 'killed';
    } else {
      task.status = exitCode === 0 ? 'completed' : 'failed';
    }
    task.child = null;
    if (task.maxRuntimeTimer) {
      clearTimeout(task.maxRuntimeTimer);
      task.maxRuntimeTimer = null;
    }
    closeCaptureLog(task.capture);
    task.capture.stdout.trimForTombstone();
    task.capture.stderr.trimForTombstone();
    if (exitCode === 0) invalidateWalkFilesCache();

    // Surface a completion reminder on the next tool call — except for
    // explicit kill_task kills, which the model already observes directly.
    if (task.killReason !== 'kill_task') {
      this.pendingReminders.set(task.id, this.formatReminder(task));
    }

    for (const waiter of task.completionWaiters.splice(0)) waiter();

    task.tombstoneTimer = setTimeout(() => {
      this.tasks.delete(task.id);
      this.pendingReminders.delete(task.id);
    }, TOMBSTONE_TTL_MS);
    task.tombstoneTimer.unref?.();
  }

  private formatReminder(task: BackgroundTask): string {
    const runtime = task.completedAt
      ? formatDuration(task.completedAt - task.startedAt)
      : 'unknown';
    const outcome = task.killReason === 'max_runtime'
      ? `was force-killed after exceeding the ${formatDuration(BACKGROUND_MAX_RUNTIME_MS)} background runtime limit`
      : `finished with exit code ${task.exitCode ?? -1}`;
    const commandPreview = task.command.length > 120
      ? `${task.command.slice(0, 120)}…`
      : task.command;
    return [
      `Background task ${task.id} (\`${commandPreview}\`) ${outcome} after ${runtime}.`,
      `Inspect it with task_output (taskId: "${task.id}") or read the full log at: ${task.capture.logPath}`,
    ].join('\n');
  }

  consumeReminder(taskId: string): void {
    this.pendingReminders.delete(taskId);
  }

  drainReminders(): string[] {
    if (this.pendingReminders.size === 0) return [];
    const reminders = [...this.pendingReminders.values()];
    this.pendingReminders.clear();
    return reminders;
  }

  waitForCompletion(taskId: string, timeoutMs: number): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      task.completionWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async kill(taskId: string): Promise<{ ok: boolean; message: string }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { ok: false, message: `No background task with id ${taskId}. It may have completed more than 5 minutes ago.` };
    }
    if (task.status !== 'running') {
      return {
        ok: true,
        message: `Task ${taskId} already ended (status: ${task.status}, exit code: ${task.exitCode ?? 'n/a'}).`,
      };
    }
    task.killReason = 'kill_task';
    this.consumeReminder(taskId);
    killProcessTree(task, 'SIGTERM');
    const graceTimer = setTimeout(() => {
      if (task.status === 'running') killProcessTree(task, 'SIGKILL');
    }, SIGKILL_GRACE_MS);
    graceTimer.unref?.();
    const ended = await this.waitForCompletion(taskId, 5_000);
    clearTimeout(graceTimer);
    if (!ended && task.status === 'running') {
      killProcessTree(task, 'SIGKILL');
      return {
        ok: true,
        message: `Task ${taskId} was sent SIGTERM/SIGKILL but has not been reaped yet. It should terminate momentarily.`,
      };
    }
    return {
      ok: true,
      message: `Task ${taskId} terminated (exit code: ${task.exitCode ?? 'n/a'}${task.signal ? `, signal: ${task.signal}` : ''}).`,
    };
  }

  /** Best-effort teardown so 10-hour background children do not outlive the CLI. */
  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.once('exit', () => {
      for (const task of this.tasks.values()) {
        if (task.status === 'running') {
          killProcessTree(task, 'SIGTERM');
        }
      }
    });
  }
}

export const taskManager = new TaskManager();

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
}

// ── completion reminder flush ────────────────────────────────────────────────
// Any tool result that passes through the registry executor wrapper picks up
// pending background-task completion notices so the model learns about them
// without polling.

export function appendPendingTaskReminders(
  result: ToolExecutionResult,
): ToolExecutionResult {
  const reminders = taskManager.drainReminders();
  if (reminders.length === 0) return result;
  const block = `<system-reminder>\n${reminders.join('\n\n')}\n</system-reminder>`;
  return {
    ...result,
    output: result.output ? `${result.output}\n\n${block}` : block,
  };
}

// ── task_output / kill_task executors ────────────────────────────────────────

function readLogTailLines(logPath: string, tailLines: number): string | null {
  try {
    if (!existsSync(logPath)) return null;
    const size = statSync(logPath).size;
    const window = Math.min(size, Math.max(tailLines * 400, 256 * 1024));
    const fd = openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(window);
      readSync(fd, buffer, 0, window, size - window);
      const text = buffer.toString('utf8');
      const lines = text.split('\n');
      // Drop the first (possibly partial) line when we did not read from offset 0.
      const usable = size > window ? lines.slice(1) : lines;
      return usable.slice(-tailLines).join('\n');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function toTailCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

export async function executeTaskOutput(
  action: Extract<AgentAction, { type: 'task_output' }>,
  _context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const task = taskManager.get(action.taskId);
  if (!task) {
    const known = taskManager.list().map((entry) => `${entry.id} (${entry.status})`);
    return {
      action,
      ok: false,
      output: [
        `No background task with id ${action.taskId}. Completed tasks are only retained for 5 minutes.`,
        known.length > 0 ? `Known tasks: ${known.join(', ')}` : 'No background tasks are currently tracked.',
      ].join('\n'),
    };
  }
  taskManager.consumeReminder(task.id);

  const tail = toTailCount(action.tail);
  const runtime = (task.completedAt ?? Date.now()) - task.startedAt;
  let outputSection: string;
  if (tail !== undefined) {
    const fromLog = readLogTailLines(task.capture.logPath, tail);
    outputSection = fromLog !== null
      ? fromLog
      : task.capture.stdout.render(task.capture.logPath);
  } else {
    const stdoutText = task.capture.stdout.render(task.capture.logPath);
    const stderrText = task.capture.stderr.render(task.capture.logPath);
    outputSection = [
      'stdout:',
      stdoutText,
      'stderr:',
      stderrText,
    ].join('\n');
  }

  return {
    action,
    ok: true,
    output: [
      `task_id: ${task.id}`,
      `command: ${task.command}`,
      `status: ${task.status}`,
      `runtime: ${Math.round(runtime / 1_000)}s`,
      ...(task.status !== 'running' ? [`exit_code: ${task.exitCode ?? -1}`] : []),
      ...(task.signal ? [`signal: ${task.signal}`] : []),
      `log_file: ${task.capture.logPath}${task.capture.logCapped ? ' (capped at 512MB)' : ''}`,
      tail !== undefined ? `tail (last ${tail} lines):` : 'output:',
      outputSection,
      ...(task.status === 'running'
        ? ['note: task is still running — do NOT sleep-poll; you will receive a system-reminder when it completes.']
        : []),
    ].join('\n'),
  };
}

export async function executeKillTask(
  action: Extract<AgentAction, { type: 'kill_task' }>,
  _context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const result = await taskManager.kill(action.taskId);
  const task = taskManager.get(action.taskId);
  return {
    action,
    ok: result.ok,
    output: [
      result.message,
      ...(task
        ? [
            `log_file: ${task.capture.logPath}`,
            'final output tail:',
            task.capture.stdout.render(task.capture.logPath) || '(empty)',
          ]
        : []),
    ].join('\n'),
  };
}
