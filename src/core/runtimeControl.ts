import type { SessionMessage, SessionRecord, TaskRuntimeRecord } from './types.js';
import {
  formatTaskRuntimeCommandLine,
  getQueuedTaskRuntimeCommands,
  isOpenTaskRuntimeStatus,
  isTaskRuntimeActiveStatus,
} from './taskRuntime.js';
import { truncate } from '../utils/fs.js';

export type RuntimeOwnership = {
  runtime: TaskRuntimeRecord;
  ownerSession: SessionRecord;
  rootSession?: SessionRecord;
  workerSession?: SessionRecord;
};

function formatMessageLine(message: SessionMessage): string {
  const role = message.name ? `${message.role}:${message.name}` : message.role;
  return `${message.createdAt} [${role}] ${truncate(message.content, 220)}`;
}

export function listRuntimeOwnerships(
  sessions: SessionRecord[],
  options?: {
    includeTerminal?: boolean;
  },
): RuntimeOwnership[] {
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  const records: RuntimeOwnership[] = [];

  for (const session of sessions) {
    for (const runtime of session.taskRuntimes ?? []) {
      if (!options?.includeTerminal && !isOpenTaskRuntimeStatus(runtime.status)) {
        continue;
      }
      records.push({
        runtime,
        ownerSession: session,
        rootSession: sessionMap.get(session.rootSessionId ?? session.id),
        workerSession: runtime.workerSessionId
          ? sessionMap.get(runtime.workerSessionId)
          : undefined,
      });
    }
  }

  return records.sort((left, right) =>
    right.runtime.updatedAt.localeCompare(left.runtime.updatedAt),
  );
}

export function findRuntimeOwnership(
  sessions: SessionRecord[],
  runtimeId: string,
): RuntimeOwnership | undefined {
  return listRuntimeOwnerships(sessions, { includeTerminal: true }).find(
    (entry) => entry.runtime.id === runtimeId,
  );
}

export function formatRuntimeProcessLines(
  sessions: SessionRecord[],
  options?: {
    includeTerminal?: boolean;
  },
): string[] {
  const ownerships = listRuntimeOwnerships(sessions, options);
  if (ownerships.length === 0) {
    return [
      options?.includeTerminal
        ? 'No persisted runtimes found.'
        : 'No active runtimes found.',
    ];
  }

  return ownerships.map(({ runtime, ownerSession, workerSession, rootSession }) => {
    const flags = [
      runtime.workflowMode ? `workflow=${runtime.workflowMode}` : '',
      runtime.role ? `role=${runtime.role}` : '',
      runtime.phase ? `phase=${runtime.phase}` : '',
      workerSession ? `worker=${workerSession.id}` : '',
      rootSession ? `root=${rootSession.id}` : '',
      runtime.processId ? `pid=${runtime.processId}` : '',
      runtime.processStartedAt ? `pid_started=${runtime.processStartedAt}` : '',
      runtime.commandQueue?.length
        ? `commands=${getQueuedTaskRuntimeCommands(runtime).length}/${runtime.commandQueue.length}`
        : '',
      isTaskRuntimeActiveStatus(runtime.status) ? 'active=yes' : 'active=no',
    ]
      .filter(Boolean)
      .join(' ');

    return [
      `${runtime.id} [${runtime.status}] ${runtime.label}`,
      `owner=${ownerSession.id}`,
      flags,
      `updated=${runtime.updatedAt}`,
    ]
      .filter(Boolean)
      .join('  ');
  });
}

export function buildRuntimeLogsReport(
  ownership: RuntimeOwnership,
  options?: {
    messageLimit?: number;
  },
): string {
  const sourceSession = ownership.workerSession ?? ownership.ownerSession;
  const messageLimit = Math.max(1, options?.messageLimit ?? 12);
  const recentMessages = sourceSession.messages.slice(-messageLimit);
  const lines = [
    `Runtime: ${ownership.runtime.id}`,
    `Status: ${ownership.runtime.status}`,
    `Label: ${ownership.runtime.label}`,
    `Owner session: ${ownership.ownerSession.id}`,
    `Worker session: ${ownership.workerSession?.id ?? 'none'}`,
    `Root session: ${ownership.rootSession?.id ?? ownership.ownerSession.rootSessionId ?? ownership.ownerSession.id}`,
    `Updated: ${ownership.runtime.updatedAt}`,
  ];
  const commandQueue = ownership.runtime.commandQueue ?? [];

  if (commandQueue.length > 0) {
    lines.push(
      `Queued commands: ${getQueuedTaskRuntimeCommands(ownership.runtime).length}/${commandQueue.length}`,
    );
  }
  if (ownership.runtime.lastOutput) {
    lines.push(`Last output: ${ownership.runtime.lastOutput}`);
  }

  if (commandQueue.length > 0) {
    lines.push('', `Runtime commands (${commandQueue.length}):`);
    lines.push(...commandQueue.map(formatTaskRuntimeCommandLine));
  }

  lines.push('', `Recent messages (${recentMessages.length}):`);

  if (recentMessages.length === 0) {
    lines.push('- none');
  } else {
    lines.push(...recentMessages.map(formatMessageLine));
  }

  return lines.join('\n');
}
