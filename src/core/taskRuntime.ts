import { randomUUID } from 'node:crypto';
import { truncate } from '../utils/fs.js';
import type {
  AgentPhase,
  AgentRole,
  SessionRecord,
  TaskRuntimeCommandRecord,
  TaskRuntimeCommandState,
  TaskRuntimeCommandType,
  TaskRuntimeRecord,
  TaskRuntimeStatus,
} from './types.js';
import type { WorkflowMode } from './workflowMode.js';

export type ParsedTaskRuntimeCommand =
  | { type: 'show' }
  | { type: 'interrupt'; runtimeId: string }
  | { type: 'interrupt-all' }
  | { type: 'clear-finished' }
  | { type: 'clear-all' }
  | { type: 'invalid'; reason: string };

export type TaskRuntimeCommandResult = {
  changed: boolean;
  runtimes: TaskRuntimeRecord[];
  message: string;
  showBoard: boolean;
};

const TERMINAL_TASK_RUNTIME_STATUSES = new Set<TaskRuntimeStatus>([
  'completed',
  'failed',
  'interrupted',
]);

const ACTIVE_TASK_RUNTIME_STATUSES = new Set<TaskRuntimeStatus>([
  'queued',
  'running',
  'waiting_approval',
]);
const MAX_TASK_RUNTIME_COMMANDS = 32;

function now(): string {
  return new Date().toISOString();
}

function isTaskRuntimeCommandType(
  value: unknown,
): value is TaskRuntimeCommandType {
  return value === 'interrupt' || value === 'notify';
}

function isTaskRuntimeCommandState(
  value: unknown,
): value is TaskRuntimeCommandState {
  return value === 'queued' || value === 'acknowledged';
}

function normalizeTaskRuntimeCommandMetadata(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, rawValue]) => {
      if (typeof rawValue !== 'string') {
        return null;
      }
      const normalizedKey = key.trim();
      const normalizedValue = rawValue.trim();
      if (!normalizedKey || !normalizedValue) {
        return null;
      }
      return [normalizedKey, normalizedValue] as const;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function createTaskRuntimeCommandRecord(options: {
  id?: string;
  type: TaskRuntimeCommandType;
  state?: TaskRuntimeCommandState;
  createdAt?: string;
  updatedAt?: string;
  handledAt?: string;
  handledBySessionId?: string;
  summary?: string;
  metadata?: Record<string, string>;
}): TaskRuntimeCommandRecord {
  const createdAt = options.createdAt ?? now();
  const updatedAt = options.updatedAt ?? createdAt;

  return {
    id: options.id ?? randomUUID(),
    type: options.type,
    state: options.state ?? 'queued',
    createdAt,
    updatedAt,
    handledAt: options.handledAt,
    handledBySessionId:
      typeof options.handledBySessionId === 'string' &&
      options.handledBySessionId.trim()
        ? options.handledBySessionId.trim()
        : undefined,
    summary:
      typeof options.summary === 'string' && options.summary.trim()
        ? truncate(options.summary, 800)
        : undefined,
    metadata: normalizeTaskRuntimeCommandMetadata(options.metadata),
  };
}

function normalizeTaskRuntimeCommandRecord(
  value: unknown,
): TaskRuntimeCommandRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (!isTaskRuntimeCommandType(candidate.type)) {
    return null;
  }

  const createdAt =
    typeof candidate.createdAt === 'string' && candidate.createdAt.trim()
      ? candidate.createdAt.trim()
      : now();

  return {
    id:
      typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id.trim()
        : randomUUID(),
    type: candidate.type,
    state: isTaskRuntimeCommandState(candidate.state)
      ? candidate.state
      : 'queued',
    createdAt,
    updatedAt:
      typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim()
        ? candidate.updatedAt.trim()
        : createdAt,
    handledAt:
      typeof candidate.handledAt === 'string' && candidate.handledAt.trim()
        ? candidate.handledAt.trim()
        : undefined,
    handledBySessionId:
      typeof candidate.handledBySessionId === 'string' &&
      candidate.handledBySessionId.trim()
        ? candidate.handledBySessionId.trim()
        : undefined,
    summary:
      typeof candidate.summary === 'string' && candidate.summary.trim()
        ? truncate(candidate.summary.trim(), 800)
        : undefined,
    metadata: normalizeTaskRuntimeCommandMetadata(candidate.metadata),
  };
}

function normalizeTaskRuntimeCommandCollection(
  value: unknown,
): TaskRuntimeCommandRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const commands: TaskRuntimeCommandRecord[] = [];

  for (const entry of value) {
    const command = normalizeTaskRuntimeCommandRecord(entry);
    if (!command || seen.has(command.id)) {
      continue;
    }
    seen.add(command.id);
    commands.push(command);
  }

  return commands
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-MAX_TASK_RUNTIME_COMMANDS);
}

export function isTaskRuntimeStatus(
  value: unknown,
): value is TaskRuntimeStatus {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'waiting_approval' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'interrupted'
  );
}

export function isTaskRuntimeTerminalStatus(
  value: TaskRuntimeStatus,
): boolean {
  return TERMINAL_TASK_RUNTIME_STATUSES.has(value);
}

export function isTaskRuntimeActiveStatus(
  value: TaskRuntimeStatus,
): boolean {
  return ACTIVE_TASK_RUNTIME_STATUSES.has(value);
}

export function isTerminalTaskRuntimeStatus(
  value: TaskRuntimeStatus,
): boolean {
  return (
    value === 'completed' || value === 'failed' || value === 'interrupted'
  );
}

export function isRecoverableTaskRuntimeStatus(
  value: TaskRuntimeStatus,
): boolean {
  return value === 'queued' || value === 'running';
}

export function isOpenTaskRuntimeStatus(
  value: TaskRuntimeStatus,
): boolean {
  return (
    value === 'queued' || value === 'running' || value === 'waiting_approval'
  );
}

export function createTaskRuntimeRecord(options: {
  id?: string;
  label: string;
  taskId?: string;
  parentId?: string;
  processId?: number;
  processStartedAt?: string;
  processToken?: string;
  workflowMode?: WorkflowMode;
  role?: AgentRole;
  phase?: AgentPhase;
  workerSessionId?: string;
  commandQueue?: TaskRuntimeCommandRecord[];
  status?: TaskRuntimeStatus;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  lastOutput?: string;
}): TaskRuntimeRecord {
  const createdAt = options.createdAt ?? now();
  const updatedAt = options.updatedAt ?? createdAt;
  const commandQueue = normalizeTaskRuntimeCommandCollection(
    options.commandQueue,
  );

  return {
    id: options.id ?? randomUUID(),
    label: options.label.trim(),
    taskId: options.taskId,
    parentId: options.parentId,
    processId:
      typeof options.processId === 'number' &&
      Number.isInteger(options.processId) &&
      options.processId > 0
        ? options.processId
        : undefined,
    processStartedAt:
      typeof options.processStartedAt === 'string' &&
      options.processStartedAt.trim()
        ? options.processStartedAt.trim()
        : undefined,
    processToken:
      typeof options.processToken === 'string' &&
      options.processToken.trim()
        ? options.processToken.trim()
        : undefined,
    workflowMode: options.workflowMode,
    role: options.role,
    phase: options.phase,
    workerSessionId: options.workerSessionId,
    commandQueue: commandQueue.length > 0 ? commandQueue : undefined,
    status: options.status ?? 'queued',
    createdAt,
    updatedAt,
    finishedAt: options.finishedAt,
    lastOutput: options.lastOutput ? truncate(options.lastOutput, 800) : undefined,
  };
}

export function normalizeTaskRuntimeRecord(
  value: unknown,
): TaskRuntimeRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id =
    typeof candidate.id === 'string' && candidate.id.trim()
      ? candidate.id.trim()
      : randomUUID();
  const label =
    typeof candidate.label === 'string' && candidate.label.trim()
      ? candidate.label.trim()
      : '';
  if (!label) {
    return null;
  }

  const createdAt =
    typeof candidate.createdAt === 'string' && candidate.createdAt.trim()
      ? candidate.createdAt
      : now();
  const updatedAt =
    typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim()
      ? candidate.updatedAt
      : createdAt;
  const status = isTaskRuntimeStatus(candidate.status)
    ? candidate.status
    : 'queued';
  const commandQueue = normalizeTaskRuntimeCommandCollection(
    candidate.commandQueue,
  );

  return {
    id,
    label,
    taskId:
      typeof candidate.taskId === 'string' && candidate.taskId.trim()
        ? candidate.taskId.trim()
        : undefined,
    parentId:
      typeof candidate.parentId === 'string' && candidate.parentId.trim()
        ? candidate.parentId.trim()
        : undefined,
    processId:
      typeof candidate.processId === 'number' &&
      Number.isInteger(candidate.processId) &&
      candidate.processId > 0
        ? candidate.processId
        : undefined,
    processStartedAt:
      typeof candidate.processStartedAt === 'string' &&
      candidate.processStartedAt.trim()
        ? candidate.processStartedAt.trim()
        : undefined,
    processToken:
      typeof candidate.processToken === 'string' &&
      candidate.processToken.trim()
        ? candidate.processToken.trim()
        : undefined,
    workflowMode:
      candidate.workflowMode === 'direct' ||
      candidate.workflowMode === 'niko' ||
      candidate.workflowMode === 'contest' ||
      candidate.workflowMode === 'athena' ||
      candidate.workflowMode === 'design' ||
      candidate.workflowMode === 'nidhogg'
        ? candidate.workflowMode
        : undefined,
    role:
      candidate.role === 'planner' ||
      candidate.role === 'researcher' ||
      candidate.role === 'builder' ||
      candidate.role === 'reviewer' ||
      candidate.role === 'brainstormer' ||
      candidate.role === 'arbiter'
        ? candidate.role
        : undefined,
    phase:
      candidate.phase === 'proposal' || candidate.phase === 'execution'
        ? candidate.phase
        : undefined,
    workerSessionId:
      typeof candidate.workerSessionId === 'string' &&
      candidate.workerSessionId.trim()
        ? candidate.workerSessionId.trim()
        : undefined,
    commandQueue: commandQueue.length > 0 ? commandQueue : undefined,
    status,
    createdAt,
    updatedAt,
    finishedAt:
      typeof candidate.finishedAt === 'string' && candidate.finishedAt.trim()
        ? candidate.finishedAt
        : undefined,
    lastOutput:
      typeof candidate.lastOutput === 'string' && candidate.lastOutput.trim()
        ? truncate(candidate.lastOutput.trim(), 800)
        : undefined,
  };
}

export function normalizeTaskRuntimeCollection(
  value: unknown,
): TaskRuntimeRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const records: TaskRuntimeRecord[] = [];

  for (const entry of value) {
    const runtime = normalizeTaskRuntimeRecord(entry);
    if (!runtime || seen.has(runtime.id)) {
      continue;
    }
    seen.add(runtime.id);
    records.push(runtime);
  }

  return records.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function appendTaskRuntime(
  session: SessionRecord,
  runtime: TaskRuntimeRecord,
): TaskRuntimeRecord {
  session.taskRuntimes = [...(session.taskRuntimes ?? []), runtime];
  session.updatedAt = now();
  return runtime;
}

export function appendTaskRuntimeCommand(
  session: SessionRecord,
  runtimeId: string,
  command: Omit<
    TaskRuntimeCommandRecord,
    'id' | 'createdAt' | 'updatedAt' | 'state'
  > & {
    type: TaskRuntimeCommandType;
    state?: TaskRuntimeCommandState;
  },
): TaskRuntimeCommandRecord | undefined {
  const records = session.taskRuntimes ?? [];
  const index = records.findIndex((entry) => entry.id === runtimeId);
  if (index < 0) {
    return undefined;
  }

  const current = records[index];
  const nextCommand = createTaskRuntimeCommandRecord(command);
  const nextQueue = normalizeTaskRuntimeCommandCollection([
    ...(current.commandQueue ?? []),
    nextCommand,
  ]);
  const timestamp = now();
  const next: TaskRuntimeRecord = {
    ...current,
    commandQueue: nextQueue.length > 0 ? nextQueue : undefined,
    updatedAt: timestamp,
  };
  session.taskRuntimes = [
    ...records.slice(0, index),
    next,
    ...records.slice(index + 1),
  ];
  session.updatedAt = timestamp;
  return nextCommand;
}

export function acknowledgeTaskRuntimeCommand(
  session: SessionRecord,
  runtimeId: string,
  commandId: string,
  options?: {
    handledBySessionId?: string;
    summary?: string;
    metadata?: Record<string, string>;
  },
): TaskRuntimeCommandRecord | undefined {
  const records = session.taskRuntimes ?? [];
  const index = records.findIndex((entry) => entry.id === runtimeId);
  if (index < 0) {
    return undefined;
  }

  const current = records[index];
  if (!current.commandQueue?.length) {
    return undefined;
  }

  const timestamp = now();
  let handled: TaskRuntimeCommandRecord | undefined;
  const nextQueue = current.commandQueue.map((entry) => {
    if (entry.id !== commandId || entry.state !== 'queued') {
      return entry;
    }

    handled = {
      ...entry,
      state: 'acknowledged',
      updatedAt: timestamp,
      handledAt: timestamp,
      handledBySessionId:
        typeof options?.handledBySessionId === 'string' &&
        options.handledBySessionId.trim()
          ? options.handledBySessionId.trim()
          : entry.handledBySessionId,
      summary:
        typeof options?.summary === 'string' && options.summary.trim()
          ? truncate(options.summary, 800)
          : entry.summary,
      metadata:
        normalizeTaskRuntimeCommandMetadata({
          ...(entry.metadata ?? {}),
          ...(options?.metadata ?? {}),
        }) ?? entry.metadata,
    };
    return handled;
  });

  if (!handled) {
    return undefined;
  }

  const next: TaskRuntimeRecord = {
    ...current,
    commandQueue: nextQueue,
    updatedAt: timestamp,
  };
  session.taskRuntimes = [
    ...records.slice(0, index),
    next,
    ...records.slice(index + 1),
  ];
  session.updatedAt = timestamp;
  return handled;
}

export function updateTaskRuntime(
  session: SessionRecord,
  runtimeId: string,
  patch: Partial<
    Omit<TaskRuntimeRecord, 'id' | 'createdAt'> & { status: TaskRuntimeStatus }
  >,
): TaskRuntimeRecord | undefined {
  const records = session.taskRuntimes ?? [];
  const index = records.findIndex((entry) => entry.id === runtimeId);
  if (index < 0) {
    return undefined;
  }

  const current = records[index];
  const next: TaskRuntimeRecord = {
    ...current,
    ...patch,
    updatedAt: patch.updatedAt ?? now(),
    finishedAt:
      patch.status &&
      (patch.status === 'completed' ||
        patch.status === 'failed' ||
        patch.status === 'interrupted')
        ? patch.finishedAt ?? now()
        : patch.finishedAt ?? current.finishedAt,
    lastOutput:
      typeof patch.lastOutput === 'string'
        ? truncate(patch.lastOutput, 800)
        : current.lastOutput,
  };
  session.taskRuntimes = [
    ...records.slice(0, index),
    next,
    ...records.slice(index + 1),
  ];
  session.updatedAt = now();
  return next;
}

export function getQueuedTaskRuntimeCommands(
  runtime: TaskRuntimeRecord,
  type?: TaskRuntimeCommandType,
): TaskRuntimeCommandRecord[] {
  return (runtime.commandQueue ?? []).filter((command) =>
    command.state === 'queued' && (!type || command.type === type),
  );
}

export function formatTaskRuntimeCommandLine(
  command: TaskRuntimeCommandRecord,
): string {
  return [
    `- ${command.id} [${command.state}] ${command.type}`,
    command.handledBySessionId ? `handled_by=${command.handledBySessionId}` : '',
    command.handledAt ? `handled_at=${command.handledAt}` : '',
    command.summary ? `summary=${truncate(command.summary, 120)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function formatTaskRuntimeLines(
  session: SessionRecord,
): string[] {
  const runtimes = session.taskRuntimes ?? [];
  if (runtimes.length === 0) {
    return ['- none'];
  }

  return runtimes.map((runtime) =>
    [
      `- ${runtime.id} [${runtime.status}] ${runtime.label}`,
      runtime.workflowMode ? `workflow=${runtime.workflowMode}` : '',
      runtime.role ? `role=${runtime.role}` : '',
      runtime.phase ? `phase=${runtime.phase}` : '',
      runtime.workerSessionId ? `worker=${runtime.workerSessionId}` : '',
      runtime.processId ? `pid=${runtime.processId}` : '',
      runtime.processStartedAt ? `pid_started=${runtime.processStartedAt}` : '',
      runtime.processToken ? `pid_token=${truncate(runtime.processToken, 24)}` : '',
      runtime.commandQueue?.length
        ? `commands=${getQueuedTaskRuntimeCommands(runtime).length}/${runtime.commandQueue.length}`
        : '',
      `updated=${runtime.updatedAt}`,
      runtime.lastOutput ? `output=${truncate(runtime.lastOutput, 120)}` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
}

export function getActiveTaskRuntimes(
  session: SessionRecord,
): TaskRuntimeRecord[] {
  return (session.taskRuntimes ?? []).filter((runtime) =>
    isTaskRuntimeActiveStatus(runtime.status),
  );
}

export function hasActiveTaskRuntimes(
  session: SessionRecord,
): boolean {
  return getActiveTaskRuntimes(session).length > 0;
}

export function buildTaskRuntimeStatusLine(
  session: SessionRecord,
): string {
  const runtimes = session.taskRuntimes ?? [];
  const active = runtimes.filter((runtime) =>
    isTaskRuntimeActiveStatus(runtime.status),
  ).length;
  const terminal = runtimes.filter((runtime) =>
    isTaskRuntimeTerminalStatus(runtime.status),
  ).length;
  return `Task runtimes: total=${runtimes.length} active=${active} terminal=${terminal}`;
}

export function parseTaskRuntimeCommand(
  input: string,
): ParsedTaskRuntimeCommand {
  const trimmed = input.trim();
  if (!trimmed) {
    return { type: 'show' };
  }

  const [head, ...rest] = trimmed.split(/\s+/);
  switch (head.toLowerCase()) {
    case 'interrupt':
      if (!rest[0]) {
        return {
          type: 'invalid',
          reason: 'runtimes interrupt requires a runtime id.',
        };
      }
      return {
        type: 'interrupt',
        runtimeId: rest[0].trim(),
      };
    case 'interrupt-all':
      return { type: 'interrupt-all' };
    case 'clear-finished':
      return { type: 'clear-finished' };
    case 'clear-all':
      return { type: 'clear-all' };
    default:
      return {
        type: 'invalid',
        reason: `Unknown runtimes subcommand: ${head}`,
      };
  }
}

function interruptRuntime(
  runtime: TaskRuntimeRecord,
  reason: string,
): TaskRuntimeRecord {
  const timestamp = now();
  return {
    ...runtime,
    processId: undefined,
    processStartedAt: undefined,
    processToken: undefined,
    status: 'interrupted',
    updatedAt: timestamp,
    finishedAt: runtime.finishedAt ?? timestamp,
    lastOutput: truncate(reason, 800),
  };
}

export function applyTaskRuntimeCommand(
  runtimes: TaskRuntimeRecord[],
  command: ParsedTaskRuntimeCommand,
): TaskRuntimeCommandResult {
  if (command.type === 'show') {
    return {
      changed: false,
      runtimes,
      message: 'Showing persisted task runtimes.',
      showBoard: true,
    };
  }

  if (command.type === 'invalid') {
    return {
      changed: false,
      runtimes,
      message: command.reason,
      showBoard: false,
    };
  }

  if (command.type === 'interrupt') {
    const target = runtimes.find((runtime) => runtime.id === command.runtimeId);
    if (!target) {
      return {
        changed: false,
        runtimes,
        message: `Unknown runtime id: ${command.runtimeId}`,
        showBoard: false,
      };
    }

    if (isTaskRuntimeTerminalStatus(target.status)) {
      return {
        changed: false,
        runtimes,
        message: `Runtime ${command.runtimeId} is already ${target.status}.`,
        showBoard: false,
      };
    }

    return {
      changed: true,
      runtimes: runtimes.map((runtime) =>
        runtime.id === command.runtimeId
          ? interruptRuntime(
              runtime,
              'Interrupted manually from the runtime control surface.',
            )
          : runtime,
      ),
      message: `Interrupted runtime ${command.runtimeId}.`,
      showBoard: true,
    };
  }

  if (command.type === 'interrupt-all') {
    const active = runtimes.filter((runtime) =>
      isTaskRuntimeActiveStatus(runtime.status),
    );
    if (active.length === 0) {
      return {
        changed: false,
        runtimes,
        message: 'No active runtimes to interrupt.',
        showBoard: true,
      };
    }

    return {
      changed: true,
      runtimes: runtimes.map((runtime) =>
        isTaskRuntimeActiveStatus(runtime.status)
          ? interruptRuntime(
              runtime,
              'Interrupted manually from the runtime control surface.',
            )
          : runtime,
      ),
      message: `Interrupted ${active.length} active runtime(s).`,
      showBoard: true,
    };
  }

  if (command.type === 'clear-finished') {
    const nextRuntimes = runtimes.filter(
      (runtime) => !isTaskRuntimeTerminalStatus(runtime.status),
    );
    const removed = runtimes.length - nextRuntimes.length;
    return {
      changed: removed > 0,
      runtimes: nextRuntimes,
      message:
        removed > 0
          ? `Cleared ${removed} finished runtime(s).`
          : 'No finished runtimes to clear.',
      showBoard: true,
    };
  }

  const cleared = runtimes.length;
  return {
    changed: cleared > 0,
    runtimes: [],
    message:
      cleared > 0
        ? `Cleared all ${cleared} runtime record(s).`
        : 'No runtimes to clear.',
    showBoard: true,
  };
}

export function buildTaskRuntimeCommandText(
  result: TaskRuntimeCommandResult,
  emptyMessage = 'No task runtimes recorded.',
): string {
  const lines = [result.message];
  if (result.showBoard) {
    lines.push('');
    if (result.runtimes.length === 0) {
      lines.push(emptyMessage);
    } else {
      lines.push(...formatTaskRuntimeLines({ taskRuntimes: result.runtimes } as SessionRecord));
    }
  }

  return lines.join('\n');
}

export function buildTaskRuntimeSummary(
  session: SessionRecord,
): string {
  const runtimes = session.taskRuntimes ?? [];
  const counts: Record<TaskRuntimeStatus, number> = {
    queued: 0,
    running: 0,
    waiting_approval: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
  };

  for (const runtime of runtimes) {
    counts[runtime.status] += 1;
  }

  const open = runtimes.filter((runtime) =>
    isOpenTaskRuntimeStatus(runtime.status),
  ).length;
  return [
    `total=${runtimes.length}`,
    `open=${open}`,
    `running=${counts.running}`,
    `waiting=${counts.waiting_approval}`,
    `completed=${counts.completed}`,
    `failed=${counts.failed}`,
    `interrupted=${counts.interrupted}`,
  ].join(' ');
}

export function formatTaskRuntimeReportLines(
  session: SessionRecord,
): string[] {
  return [
    `Summary: ${buildTaskRuntimeSummary(session)}`,
    ...formatTaskRuntimeLines(session),
  ];
}

export function recoverTaskRuntimes(
  session: SessionRecord,
  reason: string,
): TaskRuntimeRecord[] {
  const recovered: TaskRuntimeRecord[] = [];
  const runtimes = [...(session.taskRuntimes ?? [])]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

  for (const runtime of runtimes) {
    if (!isRecoverableTaskRuntimeStatus(runtime.status)) {
      continue;
    }

    const next = updateTaskRuntime(session, runtime.id, {
      status: 'interrupted',
      lastOutput: reason,
    });
    if (next) {
      recovered.push(next);
    }
  }

  return recovered;
}
