import {
  appendTaskRuntimeCommand,
  applyTaskRuntimeCommand,
  buildTaskRuntimeCommandText,
  formatTaskRuntimeReportLines,
  isTaskRuntimeActiveStatus,
  updateTaskRuntime,
} from '../core/taskRuntime.js';
import {
  buildRuntimeLogsReport,
  findRuntimeOwnership,
  formatRuntimeProcessLines,
  type RuntimeOwnership,
} from '../core/runtimeControl.js';
import { SessionStore } from '../storage/sessions.js';
import {
  finalizeDetachedWorkflowTakeover,
  getDetachedWorkflowLogPath,
  requestDetachedWorkflowTakeover,
} from './detachedWorkflow.js';
import { pathExists, readTextFileSafe } from '../utils/fs.js';
import { recordHeimdallEvent } from '../core/heimdall.js';

export type RuntimeInterruptResult =
  | {
      found: false;
      message: string;
    }
  | {
      found: true;
      changed: boolean;
      message: string;
      ownership: RuntimeOwnership;
      reportLines: string[];
    };

export type RuntimeCommandEnqueueResult =
  | {
      found: false;
      message: string;
    }
  | {
      found: true;
      changed: boolean;
      message: string;
      ownership: RuntimeOwnership;
      reportLines: string[];
    };

export type RuntimeWaitResult =
  | {
      found: false;
      message: string;
    }
  | {
      found: true;
      completed: boolean;
      timedOut: boolean;
      message: string;
      ownership: RuntimeOwnership;
      report: string;
    };

const TAKEOVER_SIGNAL_WAIT_MS = 5_000;
const TAKEOVER_FORCE_WAIT_MS = 1_000;
const TAKEOVER_POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessRunning(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }

  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined;
    return code === 'EPERM';
  }
}

export class RuntimeDirectoryService {
  private readonly sessionStore: SessionStore;

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
  }

  private resolveAttachTarget(ownership: RuntimeOwnership): {
    sessionId: string;
    message: string;
  } {
    if (ownership.workerSession) {
      return {
        sessionId: ownership.workerSession.id,
        message: `[attach] runtime ${ownership.runtime.id} -> worker session ${ownership.workerSession.id}`,
      };
    }

    return {
      sessionId: ownership.ownerSession.id,
      message: `[attach] runtime ${ownership.runtime.id} has no worker session, using owner session ${ownership.ownerSession.id}`,
    };
  }

  private async waitForProcessExit(
    processId: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessRunning(processId)) {
        return true;
      }
      await sleep(TAKEOVER_POLL_MS);
    }

    return !isProcessRunning(processId);
  }

  private async markRuntimeInterrupted(options: {
    runtimeId: string;
    ownerSessionId: string;
    message: string;
    reasonKind?: 'takeover_completed' | 'runtime_reconciled';
  }): Promise<void> {
    const session = await this.sessionStore.load(options.ownerSessionId);
    const next = updateTaskRuntime(session, options.runtimeId, {
      status: 'interrupted',
      processId: undefined,
      processStartedAt: undefined,
      processToken: undefined,
      lastOutput: options.message,
    });
    if (next) {
      await recordHeimdallEvent(this.sessionStore, session, {
        kind: options.reasonKind ?? 'runtime_reconciled',
        summary: options.message,
        runtimeId: options.runtimeId,
        sessionId: session.id,
        workflowMode: next.workflowMode,
        role: next.role,
        phase: next.phase,
        status: 'interrupted',
      });
      await this.sessionStore.save(session);
    }
  }

  private async takeoverProcessRuntime(
    ownership: RuntimeOwnership,
    requestedBy: string,
    reason: string,
  ): Promise<{
    ok: boolean;
    message: string;
  }> {
    const processId = ownership.runtime.processId;
    if (!processId || !isProcessRunning(processId)) {
      await this.markRuntimeInterrupted({
        runtimeId: ownership.runtime.id,
        ownerSessionId: ownership.ownerSession.id,
        message: `Runtime ${ownership.runtime.id} had no live worker during takeover; marked interrupted.`,
        reasonKind: 'takeover_completed',
      });
      return {
        ok: true,
        message: `[takeover] runtime ${ownership.runtime.id} had no live worker and was marked interrupted.`,
      };
    }

    await requestDetachedWorkflowTakeover(
      ownership.ownerSession.cwd,
      ownership.runtime.id,
      {
        requestedBy,
        reason,
      },
    ).catch(() => undefined);
    {
      const session = await this.sessionStore.load(ownership.ownerSession.id);
      await recordHeimdallEvent(this.sessionStore, session, {
        kind: 'takeover_requested',
        summary: `Runtime ${ownership.runtime.id} takeover requested.`,
        runtimeId: ownership.runtime.id,
        sessionId: session.id,
        workerSessionId: ownership.workerSession?.id,
        workflowMode: ownership.runtime.workflowMode,
        role: ownership.runtime.role,
        phase: ownership.runtime.phase,
        status: ownership.runtime.status,
        metadata: {
          requested_by: requestedBy,
          reason,
        },
      });
      await this.sessionStore.save(session);
    }

    let signalSummary = '';
    try {
      process.kill(processId, 'SIGTERM');
      signalSummary = `Sent SIGTERM to pid ${processId}. `;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      signalSummary = `Failed to send SIGTERM to pid ${processId}: ${message}. `;
    }

    let forced = false;
    let exited = await this.waitForProcessExit(processId, TAKEOVER_SIGNAL_WAIT_MS);
    if (!exited && isProcessRunning(processId)) {
      try {
        process.kill(processId, 'SIGKILL');
        forced = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          message:
            `${signalSummary}Requested takeover for runtime ${ownership.runtime.id}, ` +
            `but SIGKILL on pid ${processId} failed: ${message}.`,
        };
      }
      exited = await this.waitForProcessExit(processId, TAKEOVER_FORCE_WAIT_MS);
    }

    if (!exited) {
      return {
        ok: false,
        message:
          `${signalSummary}Requested takeover for runtime ${ownership.runtime.id}, ` +
          `but pid ${processId} is still alive.`,
      };
    }

    const interruptionMessage = forced
      ? `Detached workflow was force-taken over by ${requestedBy}. ${reason}`
      : `Detached workflow was taken over by ${requestedBy}. ${reason}`;
    await this.markRuntimeInterrupted({
      runtimeId: ownership.runtime.id,
      ownerSessionId: ownership.ownerSession.id,
      message: interruptionMessage,
      reasonKind: 'takeover_completed',
    });
    await finalizeDetachedWorkflowTakeover(
      ownership.ownerSession.cwd,
      ownership.runtime.id,
      forced ? 'forced' : 'graceful',
    ).catch(() => undefined);

    return {
      ok: true,
      message: forced
        ? `[takeover] runtime ${ownership.runtime.id} required SIGKILL after pid ${processId} ignored SIGTERM.`
        : `[takeover] runtime ${ownership.runtime.id} stopped cleanly after SIGTERM.`,
    };
  }

  async reconcileActiveRuntimes(): Promise<{
    changed: number;
    messages: string[];
  }> {
    const sessions = await this.sessionStore.list();
    const touchedSessions = new Set<string>();
    const messages: string[] = [];
    let changed = 0;

    for (const session of sessions) {
      for (const runtime of session.taskRuntimes ?? []) {
        if (
          !isTaskRuntimeActiveStatus(runtime.status) ||
          !runtime.processId ||
          isProcessRunning(runtime.processId)
        ) {
          continue;
        }

        const next = applyTaskRuntimeCommand(session.taskRuntimes ?? [], {
          type: 'interrupt',
          runtimeId: runtime.id,
        });
        if (!next.changed) {
          continue;
        }

        session.taskRuntimes = next.runtimes.map((entry) =>
          entry.id === runtime.id
            ? {
                ...entry,
                processId: undefined,
                processStartedAt: undefined,
                processToken: undefined,
                lastOutput:
                  `Observed detached worker pid ${runtime.processId} is no longer running. ` +
                  'Marked the runtime as interrupted during reconciliation.',
              }
            : entry,
        );
        await recordHeimdallEvent(this.sessionStore, session, {
          kind: 'runtime_reconciled',
          summary:
            `Observed detached worker pid ${runtime.processId} is no longer running. ` +
            'Marked the runtime as interrupted during reconciliation.',
          runtimeId: runtime.id,
          sessionId: session.id,
          workerSessionId: runtime.workerSessionId,
          workflowMode: runtime.workflowMode,
          role: runtime.role,
          phase: runtime.phase,
          status: 'interrupted',
        });
        touchedSessions.add(session.id);
        changed += 1;
        messages.push(
          `Reconciled stale runtime ${runtime.id} from session ${session.id} after pid ${runtime.processId} disappeared.`,
        );
      }
    }

    if (touchedSessions.size > 0) {
      await Promise.all(
        sessions
          .filter((session) => touchedSessions.has(session.id))
          .map((session) => this.sessionStore.save(session)),
      );
    }

    return {
      changed,
      messages,
    };
  }

  async listProcessLines(options?: {
    includeTerminal?: boolean;
  }): Promise<string[]> {
    await this.reconcileActiveRuntimes();
    return formatRuntimeProcessLines(await this.sessionStore.list(), options);
  }

  async findRuntime(
    runtimeId: string,
  ): Promise<RuntimeOwnership | undefined> {
    await this.reconcileActiveRuntimes();
    return findRuntimeOwnership(await this.sessionStore.list(), runtimeId);
  }

  async buildLogsReport(
    runtimeId: string,
    options?: {
      messageLimit?: number;
    },
  ): Promise<string | null> {
    await this.reconcileActiveRuntimes();
    const ownership = await this.findRuntime(runtimeId);
    if (!ownership) {
      return null;
    }

    const lines = [buildRuntimeLogsReport(ownership, options)];
    const detachedLogPath = getDetachedWorkflowLogPath(
      ownership.ownerSession.cwd,
      runtimeId,
    );
    if (await pathExists(detachedLogPath)) {
      const detachedLog = await readTextFileSafe(detachedLogPath);
      const tail = detachedLog.split(/\r?\n/).slice(-40).join('\n').trim();
      lines.push('', `Detached log: ${detachedLogPath}`, '', tail || '(empty log)');
    }

    return lines.join('\n');
  }

  async interruptRuntime(runtimeId: string): Promise<RuntimeInterruptResult> {
    await this.reconcileActiveRuntimes();
    const ownership = await this.findRuntime(runtimeId);
    if (!ownership) {
      return {
        found: false,
        message: `Unknown runtime id: ${runtimeId}`,
      };
    }

    let processMessage = '';
    if (
      ownership.runtime.processId &&
      ownership.runtime.processId > 0
    ) {
      try {
        process.kill(ownership.runtime.processId);
        processMessage = `Sent termination signal to pid ${ownership.runtime.processId}. `;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        processMessage = `Failed to signal pid ${ownership.runtime.processId}: ${message}. `;
      }
    }

    const result = applyTaskRuntimeCommand(
      ownership.ownerSession.taskRuntimes ?? [],
      {
        type: 'interrupt',
        runtimeId,
      },
    );

    if (result.changed) {
      ownership.ownerSession.taskRuntimes = result.runtimes;
      appendTaskRuntimeCommand(ownership.ownerSession, runtimeId, {
        type: 'interrupt',
        summary: 'Interrupted manually from the runtime control surface.',
        metadata: {
          source: 'runtime_directory',
        },
      });
      await this.sessionStore.save(ownership.ownerSession);
    }

    return {
      found: true,
      changed: result.changed,
      message: `${processMessage}${result.message}`.trim(),
      ownership,
      reportLines: [
        `Session: ${ownership.ownerSession.id}`,
        buildTaskRuntimeCommandText(
          {
            ...result,
            message: `${processMessage}${result.message}`.trim(),
          },
          'No task runtimes recorded.',
        ),
        '',
        ...formatTaskRuntimeReportLines({
          ...ownership.ownerSession,
          taskRuntimes: result.runtimes,
        }),
      ],
    };
  }

  async notifyRuntime(
    runtimeId: string,
    summary: string,
    metadata?: Record<string, string>,
  ): Promise<RuntimeCommandEnqueueResult> {
    await this.reconcileActiveRuntimes();
    const ownership = await this.findRuntime(runtimeId);
    if (!ownership) {
      return {
        found: false,
        message: `Unknown runtime id: ${runtimeId}`,
      };
    }

    if (!isTaskRuntimeActiveStatus(ownership.runtime.status)) {
      return {
        found: true,
        changed: false,
        message: `Runtime ${runtimeId} is already ${ownership.runtime.status}; no notify command was queued.`,
        ownership,
        reportLines: [
          `Session: ${ownership.ownerSession.id}`,
          `Runtime ${runtimeId} is already ${ownership.runtime.status}; no notify command was queued.`,
          '',
          ...formatTaskRuntimeReportLines(ownership.ownerSession),
        ],
      };
    }

    const command = appendTaskRuntimeCommand(ownership.ownerSession, runtimeId, {
      type: 'notify',
      summary,
      metadata: {
        source: 'runtime_directory',
        ...(metadata ?? {}),
      },
    });

    if (!command) {
      return {
        found: true,
        changed: false,
        message: `Failed to queue notify command for runtime ${runtimeId}.`,
        ownership,
        reportLines: [
          `Session: ${ownership.ownerSession.id}`,
          `Failed to queue notify command for runtime ${runtimeId}.`,
          '',
          ...formatTaskRuntimeReportLines(ownership.ownerSession),
        ],
      };
    }

    await this.sessionStore.save(ownership.ownerSession);

    return {
      found: true,
      changed: true,
      message: `Queued notify command ${command.id} for runtime ${runtimeId}.`,
      ownership,
      reportLines: [
        `Session: ${ownership.ownerSession.id}`,
        `Queued notify command ${command.id} for runtime ${runtimeId}.`,
        '',
        ...formatTaskRuntimeReportLines(ownership.ownerSession),
      ],
    };
  }

  async waitForRuntime(
    runtimeId: string,
    options?: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      messageLimit?: number;
    },
  ): Promise<RuntimeWaitResult> {
    const timeoutMs = Math.max(1_000, options?.timeoutMs ?? 30_000);
    const pollIntervalMs = Math.max(250, options?.pollIntervalMs ?? 1_500);
    const deadline = Date.now() + timeoutMs;

    while (true) {
      await this.reconcileActiveRuntimes();
      const ownership = await this.findRuntime(runtimeId);
      if (!ownership) {
        return {
          found: false,
          message: `Unknown runtime id: ${runtimeId}`,
        };
      }

      if (!isTaskRuntimeActiveStatus(ownership.runtime.status)) {
        return {
          found: true,
          completed: true,
          timedOut: false,
          message: `Runtime ${runtimeId} reached terminal status ${ownership.runtime.status}.`,
          ownership,
          report:
            (await this.buildLogsReport(runtimeId, {
              messageLimit: options?.messageLimit,
            })) ?? `Runtime ${runtimeId} reached terminal status ${ownership.runtime.status}.`,
        };
      }

      if (Date.now() >= deadline) {
        return {
          found: true,
          completed: false,
          timedOut: true,
          message: `Timed out while waiting for runtime ${runtimeId}; it is still ${ownership.runtime.status}.`,
          ownership,
          report:
            (await this.buildLogsReport(runtimeId, {
              messageLimit: options?.messageLimit,
            })) ?? `Timed out while waiting for runtime ${runtimeId}.`,
        };
      }

      await sleep(pollIntervalMs);
    }
  }

  async resolveAttachSessionId(runtimeId: string): Promise<{
    sessionId?: string;
    message: string;
  }> {
    await this.reconcileActiveRuntimes();
    const ownership = await this.findRuntime(runtimeId);
    if (!ownership) {
      return {
        message: `Unknown runtime id: ${runtimeId}`,
      };
    }

    if (
      ownership.runtime.processId &&
      isTaskRuntimeActiveStatus(ownership.runtime.status)
    ) {
      const takeover = await this.takeoverProcessRuntime(
        ownership,
        'interactive attach',
        `Interactive attach requested for runtime ${runtimeId}.`,
      );
      if (!takeover.ok) {
        return {
          message: takeover.message,
        };
      }

      const refreshed = await this.findRuntime(runtimeId);
      if (!refreshed) {
        return {
          message: takeover.message,
        };
      }
      const attachTarget = this.resolveAttachTarget(refreshed);
      return {
        sessionId: attachTarget.sessionId,
        message: `${takeover.message}\n${attachTarget.message}`,
      };
    }

    return this.resolveAttachTarget(ownership);
  }

  async prepareSessionForInteractiveResume(
    sessionId: string,
    reason: string,
  ): Promise<{
    ok: boolean;
    messages: string[];
  }> {
    await this.reconcileActiveRuntimes();
    const session = await this.sessionStore.load(sessionId);
    const activeRuntimes = (session.taskRuntimes ?? []).filter((runtime) =>
      isTaskRuntimeActiveStatus(runtime.status),
    );
    const messages: string[] = [];
    let ok = true;

    for (const runtime of activeRuntimes) {
      const ownership = await this.findRuntime(runtime.id);
      if (!ownership) {
        continue;
      }

      if (ownership.runtime.processId && isProcessRunning(ownership.runtime.processId)) {
        const takeover = await this.takeoverProcessRuntime(
          ownership,
          `interactive resume ${sessionId}`,
          reason,
        );
        messages.push(takeover.message);
        ok = ok && takeover.ok;
        continue;
      }

      await this.markRuntimeInterrupted({
        runtimeId: ownership.runtime.id,
        ownerSessionId: ownership.ownerSession.id,
        message: reason,
      });
      messages.push(
        `[takeover] runtime ${ownership.runtime.id} had no active worker and was marked interrupted before interactive resume.`,
      );
    }

    return { ok, messages };
  }
}
