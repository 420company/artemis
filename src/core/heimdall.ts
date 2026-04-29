import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { buildContextWindow } from './context.js';
import type {
  AgentAction,
  AgentPhase,
  HeimdallArtifactRecord,
  AgentRole,
  HeimdallEventKind,
  HeimdallUploadRecord,
  SessionRecord,
  TaskRuntimeStatus,
} from './types.js';
import type { WorkflowMode } from './workflowMode.js';
import { SessionStore } from '../storage/sessions.js';
import { isOpenTaskRuntimeStatus } from './taskRuntime.js';
import { ensureDir, resolveDataRootDir, resolveInsideRoot } from '../utils/fs.js';

export type HeimdallLifecycleStage =
  | 'before_thread_bind'
  | 'before_workflow'
  | 'before_context_build'
  | 'before_tool_projection'
  | 'after_tool_projection'
  | 'after_workflow'
  | 'on_workflow_error';

export type HeimdallThreadPaths = {
  dataRoot: string;
  threadsRoot: string;
  threadRoot: string;
  uploadManifest: string;
  artifactManifest: string;
  workspace: string;
  uploads: string;
  outputs: string;
  artifacts: string;
};

export type HeimdallVirtualMounts = {
  workspace: string;
  uploads: string;
  outputs: string;
  artifacts: string;
};

export type HeimdallThreadState = {
  sessionId: string;
  rootSessionId: string;
  cwd: string;
  sessionTitle: string;
  sessionSummary: string;
  blockingState: {
    status: 'clear' | 'waiting_approval' | 'blocked';
    reason: string;
    updatedAt: string;
  };
  clarificationState: {
    status: 'clear' | 'awaiting_user';
    reason: string;
    question?: string;
    updatedAt: string;
  };
  mediaInventory: {
    totalCount: number;
    imageCount: number;
    documentCount: number;
    audioVideoCount: number;
    latestMediaPaths: string[];
    updatedAt: string;
  };
  permissionMode: 'prompt' | 'read-only' | 'accept-edits' | 'accept-all';
  workflowMode?: WorkflowMode;
  runtimeId?: string;
  remoteOrigin?: string;
  activeRuntimeIds: string[];
  taskCount: number;
  planCount: number;
  changedFiles: string[];
  verificationCommandCount: number;
  artifacts: HeimdallArtifactRecord[];
  uploads: HeimdallUploadRecord[];
  sandbox?: HeimdallSandboxLease;
  lifecycleStages: HeimdallLifecycleStage[];
  middlewareScratchpad: Record<string, string>;
  paths: HeimdallThreadPaths;
};

export type HeimdallSandboxCapabilities = {
  readFiles: boolean;
  writeFiles: boolean;
  executeCommands: boolean;
  isolatedFilesystem: boolean;
  isolatedNetwork: boolean;
};

export type HeimdallSandboxLease = {
  providerId: string;
  mode: 'local';
  rootDir: string;
  workspaceDir: string;
  uploadsDir: string;
  outputsDir: string;
  artifactsDir: string;
  acquiredAt: string;
  releasedAt?: string;
  capabilities: HeimdallSandboxCapabilities;
};

export type HeimdallSandboxProvider = {
  id: string;
  acquire(state: HeimdallThreadState): Promise<HeimdallSandboxLease>;
  release?(lease: HeimdallSandboxLease): Promise<void>;
};

export type HeimdallMiddlewareContext = {
  sessionStore: SessionStore;
  session: SessionRecord;
  state: HeimdallThreadState;
  stage: HeimdallLifecycleStage;
  workflowMode?: WorkflowMode;
  runtimeId?: string;
  role?: AgentRole;
  phase?: AgentPhase;
  status?: TaskRuntimeStatus;
  metadata?: Record<string, string | undefined>;
};

export type HeimdallMiddleware = {
  id: string;
  run(context: HeimdallMiddlewareContext): Promise<void>;
};

export type HeimdallEventEnvelope = {
  rootSessionId: string;
  threadRoot: string;
  event: {
    id: string;
    kind: HeimdallEventKind;
    createdAt: string;
    summary: string;
    runtimeId?: string;
    sessionId?: string;
    workerSessionId?: string;
    workflowMode?: WorkflowMode;
    role?: AgentRole;
    phase?: AgentPhase;
    status?: TaskRuntimeStatus;
    metadata?: Record<string, string>;
  };
};

export type HeimdallEventListener = (
  envelope: HeimdallEventEnvelope,
) => void | Promise<void>;

export type HeimdallEventCursor = {
  rootSessionId: string;
  offset: number;
  lastEventId?: string;
};

const heimdallEventListeners = new Set<HeimdallEventListener>();
const heimdallMiddlewareRegistry = new Map<string, HeimdallMiddleware>();

function now(): string {
  return new Date().toISOString();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildFallbackSummary(session: SessionRecord): string {
  const recent = session.messages.slice(-4);
  if (recent.length === 0) {
    return '';
  }
  return recent
    .map((message) => {
      const label = message.name ? `${message.role}:${message.name}` : message.role;
      const compact = message.content.replace(/\s+/g, ' ').trim();
      return `[${label}] ${compact.slice(0, 160)}`;
    })
    .join('\n')
    .slice(0, 800);
}

function normalizeMessageText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function deriveBlockingState(session: SessionRecord): HeimdallThreadState['blockingState'] {
  const waitingApprovalCount = (session.taskRuntimes ?? []).filter(
    (runtime) => runtime.status === 'waiting_approval',
  ).length;
  if (waitingApprovalCount > 0) {
    return {
      status: 'waiting_approval',
      reason: `waiting approval for ${waitingApprovalCount} runtime${waitingApprovalCount === 1 ? '' : 's'}`,
      updatedAt: now(),
    };
  }

  const blockedTaskCount = (session.tasks ?? []).filter(
    (task) => task.status === 'blocked',
  ).length;
  if (blockedTaskCount > 0) {
    return {
      status: 'blocked',
      reason: `blocked tasks=${blockedTaskCount}`,
      updatedAt: now(),
    };
  }

  return {
    status: 'clear',
    reason: 'no approval or blocked-task holds',
    updatedAt: now(),
  };
}

function deriveClarificationState(
  session: SessionRecord,
): HeimdallThreadState['clarificationState'] {
  let lastUserIndex = -1;
  let lastAssistantIndex = -1;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (lastUserIndex < 0 && message?.role === 'user') {
      lastUserIndex = index;
    }
    if (lastAssistantIndex < 0 && message?.role === 'assistant') {
      lastAssistantIndex = index;
    }
    if (lastUserIndex >= 0 && lastAssistantIndex >= 0) {
      break;
    }
  }

  const assistantMessage =
    lastAssistantIndex >= 0 ? session.messages[lastAssistantIndex] : undefined;
  const assistantContent = assistantMessage
    ? normalizeMessageText(assistantMessage.content)
    : '';
  const needsClarification =
    lastAssistantIndex > lastUserIndex &&
    assistantContent.length > 0 &&
    (/[?？]/.test(assistantContent) ||
      /(please provide|need your|which|what|when|where|who|could you|can you|would you|请提供|需要你|哪个|什么|是否|可否)/i.test(
        assistantContent,
      ));

  if (needsClarification) {
    return {
      status: 'awaiting_user',
      reason: 'assistant requested follow-up input',
      question: assistantContent.slice(0, 220),
      updatedAt: now(),
    };
  }

  return {
    status: 'clear',
    reason: 'no pending clarification',
    updatedAt: now(),
  };
}

function isMediaUpload(upload: HeimdallUploadRecord): {
  isMedia: boolean;
  kind: 'image' | 'document' | 'audioVideo' | 'other';
} {
  const mime = upload.mimeType?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) {
    return { isMedia: true, kind: 'image' };
  }
  if (mime === 'application/pdf') {
    return { isMedia: true, kind: 'document' };
  }
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    return { isMedia: true, kind: 'audioVideo' };
  }
  return { isMedia: false, kind: 'other' };
}

function deriveMediaInventory(
  uploads: HeimdallUploadRecord[],
): HeimdallThreadState['mediaInventory'] {
  let imageCount = 0;
  let documentCount = 0;
  let audioVideoCount = 0;
  const mediaPaths: string[] = [];

  for (const upload of uploads) {
    const media = isMediaUpload(upload);
    if (!media.isMedia) {
      continue;
    }
    mediaPaths.push(upload.storedPath);
    if (media.kind === 'image') {
      imageCount += 1;
    } else if (media.kind === 'document') {
      documentCount += 1;
    } else if (media.kind === 'audioVideo') {
      audioVideoCount += 1;
    }
  }

  return {
    totalCount: mediaPaths.length,
    imageCount,
    documentCount,
    audioVideoCount,
    latestMediaPaths: mediaPaths.slice(-5),
    updatedAt: now(),
  };
}

export function getHeimdallThreadPaths(
  cwd: string,
  rootSessionId: string,
): HeimdallThreadPaths {
  const dataRoot = resolveDataRootDir(cwd);
  const threadsRoot = path.join(dataRoot, 'threads');
  const threadRoot = path.join(threadsRoot, rootSessionId);
  return {
    dataRoot,
    threadsRoot,
    threadRoot,
    uploadManifest: path.join(threadRoot, 'uploads.json'),
    artifactManifest: path.join(threadRoot, 'artifacts.json'),
    workspace: path.join(threadRoot, 'workspace'),
    uploads: path.join(threadRoot, 'uploads'),
    outputs: path.join(threadRoot, 'outputs'),
    artifacts: path.join(threadRoot, 'artifacts'),
  };
}

export function getHeimdallThreadStatePath(
  cwd: string,
  rootSessionId: string,
): string {
  return path.join(getHeimdallThreadPaths(cwd, rootSessionId).threadRoot, 'state.json');
}

export function getHeimdallEventLogPath(
  cwd: string,
  rootSessionId: string,
): string {
  return path.join(getHeimdallThreadPaths(cwd, rootSessionId).threadRoot, 'events.jsonl');
}

export function getHeimdallUploadManifestPath(
  cwd: string,
  rootSessionId: string,
): string {
  return getHeimdallThreadPaths(cwd, rootSessionId).uploadManifest;
}

export function getHeimdallArtifactManifestPath(
  cwd: string,
  rootSessionId: string,
): string {
  return getHeimdallThreadPaths(cwd, rootSessionId).artifactManifest;
}

export function getHeimdallVirtualMounts(): HeimdallVirtualMounts {
  return {
    workspace: '/mnt/user-data/workspace',
    uploads: '/mnt/user-data/uploads',
    outputs: '/mnt/user-data/outputs',
    artifacts: '/mnt/user-data/artifacts',
  };
}

export function toHeimdallVirtualPath(
  cwd: string,
  rootSessionId: string,
  candidatePath: string,
): string {
  const paths = getHeimdallThreadPaths(cwd, rootSessionId);
  const mounts = getHeimdallVirtualMounts();
  const normalizedCandidate = path.resolve(cwd, candidatePath);
  const mappings = [
    [path.resolve(paths.workspace), mounts.workspace],
    [path.resolve(paths.uploads), mounts.uploads],
    [path.resolve(paths.outputs), mounts.outputs],
    [path.resolve(paths.artifacts), mounts.artifacts],
  ] as const;

  for (const [realRoot, virtualRoot] of mappings) {
    const relative = path.relative(realRoot, normalizedCandidate);
    if (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    ) {
      return path.posix.join(
        virtualRoot,
        relative.split(path.sep).filter(Boolean).join('/'),
      );
    }
  }

  return candidatePath;
}

export function fromHeimdallVirtualPath(
  cwd: string,
  candidatePath: string,
  rootSessionId?: string,
): string {
  const mounts = getHeimdallVirtualMounts();
  const normalizedCandidate = candidatePath.replace(/\\/g, '/');

  if (
    normalizedCandidate === mounts.workspace ||
    normalizedCandidate.startsWith(`${mounts.workspace}/`)
  ) {
    const relative = normalizedCandidate
      .slice(mounts.workspace.length)
      .replace(/^\/+/, '');
    return resolveInsideRoot(cwd, relative);
  }

  if (!rootSessionId) {
    return candidatePath;
  }

  const paths = getHeimdallThreadPaths(cwd, rootSessionId);
  const mappings = [
    [mounts.uploads, paths.uploads],
    [mounts.outputs, paths.outputs],
    [mounts.artifacts, paths.artifacts],
  ] as const;

  for (const [virtualRoot, realRoot] of mappings) {
    if (
      normalizedCandidate === virtualRoot ||
      normalizedCandidate.startsWith(`${virtualRoot}/`)
    ) {
      const relative = normalizedCandidate
        .slice(virtualRoot.length)
        .replace(/^\/+/, '');
      return resolveInsideRoot(realRoot, relative);
    }
  }

  return candidatePath;
}

function getActiveRuntimeIds(session: SessionRecord): string[] {
  return (session.taskRuntimes ?? [])
    .filter((runtime) => isOpenTaskRuntimeStatus(runtime.status))
    .map((runtime) => runtime.id);
}

function reconcileHeimdallArtifacts(
  previousArtifacts: HeimdallArtifactRecord[],
  session: SessionRecord,
): HeimdallArtifactRecord[] {
  const artifactMap = new Map(
    previousArtifacts.map((artifact) => [artifact.path, artifact] as const),
  );

  for (const filePath of session.changedFiles ?? []) {
    const previous = artifactMap.get(filePath);
    artifactMap.set(filePath, {
      id: previous?.id ?? `changed_file:${filePath}`,
      path: filePath,
      kind: 'changed_file',
      source: 'session.changedFiles',
      createdAt: previous?.createdAt ?? session.updatedAt,
      updatedAt: session.updatedAt,
      sessionId: session.id,
      existsInWorkspace: true,
      metadata: previous?.metadata,
    });
  }

  return [...artifactMap.values()]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .slice(-128);
}

function upsertHeimdallArtifact(
  artifacts: HeimdallArtifactRecord[],
  artifact: HeimdallArtifactRecord,
): HeimdallArtifactRecord[] {
  const artifactMap = new Map(
    artifacts.map((entry) => [entry.path, entry] as const),
  );
  artifactMap.set(artifact.path, artifact);
  return [...artifactMap.values()]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .slice(-128);
}

function sanitizeArtifactPathSegment(input: string): string {
  return input
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'artifact';
}

function syncDerivedState(
  state: HeimdallThreadState,
  session: SessionRecord,
): HeimdallThreadState {
  state.sessionId = session.id;
  state.rootSessionId = session.rootSessionId ?? session.id;
  state.sessionTitle = session.title;
  state.blockingState = deriveBlockingState(session);
  state.clarificationState = deriveClarificationState(session);
  state.mediaInventory = deriveMediaInventory(state.uploads);
  state.activeRuntimeIds = getActiveRuntimeIds(session);
  state.taskCount = session.tasks?.length ?? 0;
  state.planCount = session.plan?.length ?? 0;
  state.changedFiles = [...(session.changedFiles ?? [])];
  state.verificationCommandCount = session.verificationCommands?.length ?? 0;
  state.artifacts = reconcileHeimdallArtifacts(state.artifacts, session);
  return state;
}

async function saveHeimdallUploadManifest(
  state: HeimdallThreadState,
): Promise<void> {
  await ensureDir(state.paths.threadRoot);
  await writeFile(
    getHeimdallUploadManifestPath(state.cwd, state.rootSessionId),
    JSON.stringify(
      {
        rootSessionId: state.rootSessionId,
        updatedAt: now(),
        uploads: state.uploads,
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function saveHeimdallArtifactManifest(
  state: HeimdallThreadState,
): Promise<void> {
  await ensureDir(state.paths.threadRoot);
  await writeFile(
    getHeimdallArtifactManifestPath(state.cwd, state.rootSessionId),
    JSON.stringify(
      {
        rootSessionId: state.rootSessionId,
        updatedAt: now(),
        artifacts: state.artifacts,
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function saveHeimdallThreadState(
  state: HeimdallThreadState,
): Promise<void> {
  await ensureDir(state.paths.threadRoot);
  await writeFile(
    getHeimdallThreadStatePath(state.cwd, state.rootSessionId),
    JSON.stringify(state, null, 2),
    'utf8',
  );
  await saveHeimdallUploadManifest(state);
  await saveHeimdallArtifactManifest(state);
}

export async function readHeimdallThreadState(
  cwd: string,
  rootSessionId: string,
): Promise<HeimdallThreadState | null> {
  const filePath = getHeimdallThreadStatePath(cwd, rootSessionId);
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  if (!raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HeimdallThreadState>;
    const paths = getHeimdallThreadPaths(cwd, rootSessionId);
    return {
      sessionId: parsed.sessionId ?? rootSessionId,
      rootSessionId: parsed.rootSessionId ?? rootSessionId,
      cwd: parsed.cwd ?? cwd,
      sessionTitle: parsed.sessionTitle ?? rootSessionId,
      sessionSummary: parsed.sessionSummary ?? '',
      blockingState:
        parsed.blockingState ??
        {
          status: 'clear',
          reason: 'no approval or blocked-task holds',
          updatedAt: now(),
        },
      clarificationState:
        parsed.clarificationState ??
        {
          status: 'clear',
          reason: 'no pending clarification',
          updatedAt: now(),
        },
      mediaInventory:
        parsed.mediaInventory ??
        {
          totalCount: 0,
          imageCount: 0,
          documentCount: 0,
          audioVideoCount: 0,
          latestMediaPaths: [],
          updatedAt: now(),
        },
      permissionMode: parsed.permissionMode ?? 'prompt',
      workflowMode: parsed.workflowMode,
      runtimeId: parsed.runtimeId,
      remoteOrigin: parsed.remoteOrigin,
      activeRuntimeIds: parsed.activeRuntimeIds ?? [],
      taskCount: parsed.taskCount ?? 0,
      planCount: parsed.planCount ?? 0,
      changedFiles: parsed.changedFiles ?? [],
      verificationCommandCount: parsed.verificationCommandCount ?? 0,
      artifacts: parsed.artifacts ?? [],
      uploads: parsed.uploads ?? [],
      sandbox: parsed.sandbox,
      lifecycleStages: parsed.lifecycleStages ?? [],
      middlewareScratchpad: parsed.middlewareScratchpad ?? {},
      paths,
    };
  } catch {
    return null;
  }
}

export async function readHeimdallEventLog(options: {
  cwd: string;
  rootSessionId: string;
  limit?: number;
}): Promise<HeimdallEventEnvelope[]> {
  const raw = await readFile(
    getHeimdallEventLogPath(options.cwd, options.rootSessionId),
    'utf8',
  ).catch(() => '');
  if (!raw.trim()) {
    return [];
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed: HeimdallEventEnvelope[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as HeimdallEventEnvelope);
    } catch {
      continue;
    }
  }

  const limit = Math.max(1, options.limit ?? parsed.length);
  return parsed.slice(-limit);
}

export async function readHeimdallEventWindow(options: {
  cwd: string;
  rootSessionId: string;
  afterOffset?: number;
  afterEventId?: string;
  limit?: number;
}): Promise<{
  events: HeimdallEventEnvelope[];
  cursor: HeimdallEventCursor;
}> {
  const parsed = await readHeimdallEventLog({
    cwd: options.cwd,
    rootSessionId: options.rootSessionId,
  });
  let startIndex = Math.max(0, options.afterOffset ?? 0);
  if (options.afterEventId) {
    const afterEventIndex = parsed.findIndex(
      (entry) => entry.event.id === options.afterEventId,
    );
    if (afterEventIndex >= 0) {
      startIndex = Math.max(startIndex, afterEventIndex + 1);
    }
  }
  const window = parsed.slice(startIndex);
  const limited = Math.max(1, options.limit ?? window.length);
  const events = window.slice(0, limited);
  return {
    events,
    cursor: {
      rootSessionId: options.rootSessionId,
      offset: startIndex + events.length,
      lastEventId:
        events.at(-1)?.event.id ??
        parsed[Math.max(0, startIndex - 1)]?.event.id,
    },
  };
}

export async function waitForHeimdallEvents(options: {
  cwd: string;
  rootSessionId: string;
  afterOffset?: number;
  afterEventId?: string;
  limit?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{
  timedOut: boolean;
  events: HeimdallEventEnvelope[];
  cursor: HeimdallEventCursor;
}> {
  const timeoutMs = Math.max(50, options.timeoutMs ?? 30_000);
  const pollIntervalBaseMs = Math.max(25, options.pollIntervalMs ?? 100);
  const pollIntervalMaxMs = 1_000;
  const deadline = Date.now() + timeoutMs;
  let currentInterval = pollIntervalBaseMs;

  for (;;) {
    const window = await readHeimdallEventWindow(options);
    if (window.events.length > 0) {
      return {
        timedOut: false,
        events: window.events,
        cursor: window.cursor,
      };
    }
    if (Date.now() >= deadline) {
      return {
        timedOut: true,
        events: [],
        cursor: window.cursor,
      };
    }
    await sleep(currentInterval);
    // Exponential backoff: double each empty poll up to the max cap.
    currentInterval = Math.min(currentInterval * 2, pollIntervalMaxMs);
  }
}

export async function readHeimdallUploadManifest(options: {
  cwd: string;
  rootSessionId: string;
}): Promise<{
  rootSessionId: string;
  updatedAt?: string;
  uploads: HeimdallUploadRecord[];
} | null> {
  const raw = await readFile(
    getHeimdallUploadManifestPath(options.cwd, options.rootSessionId),
    'utf8',
  ).catch(() => '');
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as {
      rootSessionId: string;
      updatedAt?: string;
      uploads: HeimdallUploadRecord[];
    };
  } catch {
    return null;
  }
}

export async function readHeimdallArtifactManifest(options: {
  cwd: string;
  rootSessionId: string;
}): Promise<{
  rootSessionId: string;
  updatedAt?: string;
  artifacts: HeimdallArtifactRecord[];
} | null> {
  const raw = await readFile(
    getHeimdallArtifactManifestPath(options.cwd, options.rootSessionId),
    'utf8',
  ).catch(() => '');
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as {
      rootSessionId: string;
      updatedAt?: string;
      artifacts: HeimdallArtifactRecord[];
    };
  } catch {
    return null;
  }
}

export function subscribeHeimdallEvents(
  listener: HeimdallEventListener,
): () => void {
  heimdallEventListeners.add(listener);
  return () => {
    heimdallEventListeners.delete(listener);
  };
}

async function publishHeimdallEvent(
  envelope: HeimdallEventEnvelope,
): Promise<void> {
  if (heimdallEventListeners.size === 0) {
    return;
  }

  await Promise.all(
    [...heimdallEventListeners].map(async (listener) => {
      await listener(envelope);
    }),
  ).catch(() => undefined);
}

const sessionMetadataMiddleware: HeimdallMiddleware = {
  id: 'session-metadata',
  async run(context) {
    syncDerivedState(context.state, context.session);
    context.state.middlewareScratchpad['session-metadata:lastSessionUpdate'] =
      context.session.updatedAt;
    context.state.middlewareScratchpad['session-metadata:lastTitle'] =
      context.session.title;
  },
};

const summarySnapshotMiddleware: HeimdallMiddleware = {
  id: 'summary-snapshot',
  async run(context) {
    const summary =
      context.session.summary?.trim() ||
      (await buildContextWindow(context.session, 'main')).summary ||
      buildFallbackSummary(context.session);
    context.state.sessionSummary = summary;
    context.state.middlewareScratchpad['heimdall:summaryChars'] = String(
      summary.length,
    );
  },
};

const blockingStateMiddleware: HeimdallMiddleware = {
  id: 'blocking-state',
  async run(context) {
    context.state.blockingState = deriveBlockingState(context.session);
    context.state.middlewareScratchpad['heimdall:blockingStatus'] =
      context.state.blockingState.status;
    context.state.middlewareScratchpad['heimdall:blockingReason'] =
      context.state.blockingState.reason;
  },
};

const clarificationStateMiddleware: HeimdallMiddleware = {
  id: 'clarification-state',
  async run(context) {
    context.state.clarificationState = deriveClarificationState(context.session);
    context.state.middlewareScratchpad['heimdall:clarificationStatus'] =
      context.state.clarificationState.status;
    context.state.middlewareScratchpad['heimdall:clarificationReason'] =
      context.state.clarificationState.reason;
  },
};

const mediaInventoryMiddleware: HeimdallMiddleware = {
  id: 'media-inventory',
  async run(context) {
    context.state.mediaInventory = deriveMediaInventory(context.state.uploads);
    context.state.middlewareScratchpad['heimdall:mediaCount'] = String(
      context.state.mediaInventory.totalCount,
    );
    context.state.middlewareScratchpad['heimdall:imageCount'] = String(
      context.state.mediaInventory.imageCount,
    );
  },
};

const lifecycleAuditMiddleware: HeimdallMiddleware = {
  id: 'lifecycle-audit',
  async run(context) {
    context.state.middlewareScratchpad['heimdall:lastStage'] = context.stage;
    context.state.middlewareScratchpad['heimdall:lastStageAt'] = now();
    if (context.workflowMode) {
      context.state.middlewareScratchpad['heimdall:workflowMode'] =
        context.workflowMode;
    }
    if (context.runtimeId) {
      context.state.middlewareScratchpad['heimdall:runtimeId'] =
        context.runtimeId;
    }
  },
};

const localHeimdallSandboxProvider: HeimdallSandboxProvider = {
  id: 'local',
  async acquire(state) {
    return {
      providerId: 'local',
      mode: 'local',
      rootDir: state.cwd,
      workspaceDir: state.paths.workspace,
      uploadsDir: state.paths.uploads,
      outputsDir: state.paths.outputs,
      artifactsDir: state.paths.artifacts,
      acquiredAt: now(),
      capabilities: {
        readFiles: true,
        writeFiles: true,
        executeCommands: true,
        isolatedFilesystem: false,
        isolatedNetwork: false,
      },
    };
  },
};

const heimdallSandboxProviders = new Map<string, HeimdallSandboxProvider>([
  [localHeimdallSandboxProvider.id, localHeimdallSandboxProvider],
]);

function getHeimdallSandboxProvider(
  providerId: string,
): HeimdallSandboxProvider {
  return (
    heimdallSandboxProviders.get(providerId) ??
    localHeimdallSandboxProvider
  );
}

function isReusableHeimdallLease(
  lease: HeimdallSandboxLease,
  state: HeimdallThreadState,
): boolean {
  return (
    lease.releasedAt === undefined &&
    lease.providerId === localHeimdallSandboxProvider.id &&
    lease.workspaceDir === state.paths.workspace &&
    lease.outputsDir === state.paths.outputs &&
    lease.artifactsDir === state.paths.artifacts
  );
}

async function releaseHeimdallSandboxLease(
  state: HeimdallThreadState,
): Promise<void> {
  const lease = state.sandbox;
  if (!lease || lease.releasedAt) {
    return;
  }

  const provider = getHeimdallSandboxProvider(lease.providerId);
  if (provider.release) {
    try {
      await provider.release(lease);
    } catch {
      // Release errors are non-blocking; we still mark lifecycle intent.
    }
  }
  lease.releasedAt = now();
}

export async function finalizeHeimdallThreadState(
  state: HeimdallThreadState,
  options?: {
    persist?: boolean;
  },
): Promise<void> {
  await releaseHeimdallSandboxLease(state);
  if (options?.persist ?? true) {
    await persistHeimdallThreadState(state);
  }
}

const sandboxLeaseMiddleware: HeimdallMiddleware = {
  id: 'sandbox-lease',
  async run(context) {
    const existing = context.state.sandbox;
    if (existing && isReusableHeimdallLease(existing, context.state)) {
      context.state.middlewareScratchpad['sandbox:provider'] =
        existing.providerId;
      context.state.middlewareScratchpad['sandbox:mode'] = existing.mode;
      context.state.middlewareScratchpad['sandbox:fs_isolated'] = String(
        existing.capabilities.isolatedFilesystem,
      );
      context.state.middlewareScratchpad['sandbox:network_isolated'] = String(
        existing.capabilities.isolatedNetwork,
      );
      return;
    }

    if (existing) {
      await releaseHeimdallSandboxLease(context.state);
      context.state.sandbox = undefined;
    }

    const lease = await localHeimdallSandboxProvider.acquire(context.state);
    context.state.sandbox = lease;
    context.state.middlewareScratchpad['sandbox:provider'] = lease.providerId;
    context.state.middlewareScratchpad['sandbox:mode'] = lease.mode;
    context.state.middlewareScratchpad['sandbox:fs_isolated'] = String(
      lease.capabilities.isolatedFilesystem,
    );
    context.state.middlewareScratchpad['sandbox:network_isolated'] = String(
      lease.capabilities.isolatedNetwork,
    );
  },
};

const BUILTIN_HEIMDALL_MIDDLEWARES: HeimdallMiddleware[] = [
  sessionMetadataMiddleware,
  summarySnapshotMiddleware,
  blockingStateMiddleware,
  clarificationStateMiddleware,
  mediaInventoryMiddleware,
  lifecycleAuditMiddleware,
  sandboxLeaseMiddleware,
];
const BUILTIN_HEIMDALL_MIDDLEWARE_BY_ID = new Map(
  BUILTIN_HEIMDALL_MIDDLEWARES.map((middleware) => [middleware.id, middleware]),
);

for (const middleware of BUILTIN_HEIMDALL_MIDDLEWARES) {
  heimdallMiddlewareRegistry.set(middleware.id, middleware);
}

export function listHeimdallMiddlewares(): HeimdallMiddleware[] {
  return [...heimdallMiddlewareRegistry.values()];
}

export function registerHeimdallMiddleware(
  middleware: HeimdallMiddleware,
): () => void {
  heimdallMiddlewareRegistry.set(middleware.id, middleware);
  return () => {
    const builtin = BUILTIN_HEIMDALL_MIDDLEWARE_BY_ID.get(middleware.id);
    if (builtin) {
      heimdallMiddlewareRegistry.set(middleware.id, builtin);
      return;
    }
    heimdallMiddlewareRegistry.delete(middleware.id);
  };
}

export async function prepareHeimdallThreadState(options: {
  cwd: string;
  session: SessionRecord;
  permissionMode: 'prompt' | 'read-only' | 'accept-edits' | 'accept-all';
  workflowMode?: WorkflowMode;
  runtimeId?: string;
  remoteOrigin?: string;
}): Promise<HeimdallThreadState> {
  const rootSessionId = options.session.rootSessionId ?? options.session.id;
  const paths = getHeimdallThreadPaths(options.cwd, rootSessionId);
  await Promise.all([
    ensureDir(paths.threadsRoot),
    ensureDir(paths.threadRoot),
    ensureDir(paths.workspace),
    ensureDir(paths.uploads),
    ensureDir(paths.outputs),
    ensureDir(paths.artifacts),
  ]);

  const existingState = await readHeimdallThreadState(options.cwd, rootSessionId);
  if (!existingState) {
    return syncDerivedState(
      {
        sessionId: options.session.id,
        rootSessionId,
        cwd: options.cwd,
        sessionTitle: options.session.title,
        sessionSummary: options.session.summary ?? '',
        blockingState: deriveBlockingState(options.session),
        clarificationState: deriveClarificationState(options.session),
        mediaInventory: deriveMediaInventory([]),
        permissionMode: options.permissionMode,
        workflowMode: options.workflowMode,
        runtimeId: options.runtimeId,
        remoteOrigin: options.remoteOrigin,
        activeRuntimeIds: getActiveRuntimeIds(options.session),
        taskCount: options.session.tasks?.length ?? 0,
        planCount: options.session.plan?.length ?? 0,
        changedFiles: [...(options.session.changedFiles ?? [])],
        verificationCommandCount:
          options.session.verificationCommands?.length ?? 0,
        artifacts: reconcileHeimdallArtifacts([], options.session),
        uploads: [],
        sandbox: undefined,
        lifecycleStages: [],
        middlewareScratchpad: {},
        paths,
      },
      options.session,
    );
  }

  const repairedExistingState: HeimdallThreadState = {
    ...existingState,
    sessionId: options.session.id,
    rootSessionId,
    cwd: options.cwd,
    sessionTitle: options.session.title,
    permissionMode: options.permissionMode,
    workflowMode: options.workflowMode ?? existingState.workflowMode,
    runtimeId: options.runtimeId ?? existingState.runtimeId,
    remoteOrigin: options.remoteOrigin ?? existingState.remoteOrigin,
    artifacts: reconcileHeimdallArtifacts(existingState.artifacts, options.session),
    uploads: [...existingState.uploads],
    sandbox: undefined,
    middlewareScratchpad: { ...existingState.middlewareScratchpad },
    paths,
  };
  if (
    existingState.sandbox &&
    isReusableHeimdallLease(existingState.sandbox, {
      ...existingState,
      paths,
    })
  ) {
    repairedExistingState.sandbox = existingState.sandbox;
  }

  if (!repairedExistingState.sandbox) {
    repairedExistingState.middlewareScratchpad['sandbox:provider'] = '';
    repairedExistingState.middlewareScratchpad['sandbox:mode'] = '';
    repairedExistingState.middlewareScratchpad['sandbox:fs_isolated'] = '';
    repairedExistingState.middlewareScratchpad['sandbox:network_isolated'] = '';
  }

  return syncDerivedState(repairedExistingState, options.session);
}

export function syncHeimdallThreadState(
  state: HeimdallThreadState,
  session: SessionRecord,
): HeimdallThreadState {
  return syncDerivedState(state, session);
}

export async function persistHeimdallThreadState(
  state: HeimdallThreadState,
): Promise<void> {
  await saveHeimdallThreadState(state);
}

export async function persistHeimdallActionArtifact(options: {
  state: HeimdallThreadState;
  session: SessionRecord;
  action: AgentAction;
  ok: boolean;
  output: string;
}): Promise<HeimdallArtifactRecord | null> {
  const content = options.output.trim();
  if (!content) {
    return null;
  }

  const createdAt = now();
  const artifactKind =
    options.action.type === 'delegate_task' ||
    options.action.type === 'approve_builder_execution'
      ? 'report'
      : 'generated_output';
  const filename = `${createdAt
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '')}-${sanitizeArtifactPathSegment(options.action.type)}.md`;
  const absolutePath = path.join(options.state.paths.artifacts, filename);
  await ensureDir(options.state.paths.artifacts);
  await writeFile(
    absolutePath,
    [
      `# Heimdall ${artifactKind.replace('_', ' ')}`,
      '',
      `Action: ${options.action.type}`,
      `Session: ${options.session.id}`,
      `Result: ${options.ok ? 'ok' : 'failed'}`,
      `Created: ${createdAt}`,
      '',
      content,
      '',
    ].join('\n'),
    'utf8',
  );

  const relativePath = path.relative(options.session.cwd, absolutePath);
  const artifact: HeimdallArtifactRecord = {
    id: `artifact:${createdAt}:${options.action.type}`,
    path: relativePath,
    kind: artifactKind,
    source: `heimdall.action.${options.action.type}`,
    createdAt,
    updatedAt: createdAt,
    sessionId: options.session.id,
    existsInWorkspace: true,
    metadata: {
      action_type: options.action.type,
      result_ok: String(options.ok),
      virtual_path: toHeimdallVirtualPath(
        options.state.cwd,
        options.state.rootSessionId,
        absolutePath,
      ),
    },
  };
  options.state.artifacts = upsertHeimdallArtifact(options.state.artifacts, artifact);
  await persistHeimdallThreadState(options.state);
  return artifact;
}

export async function runHeimdallMiddlewareStage(
  context: HeimdallMiddlewareContext,
): Promise<void> {
  syncDerivedState(context.state, context.session);
  for (const middleware of listHeimdallMiddlewares()) {
    await middleware.run(context);
  }
  context.state.middlewareScratchpad['heimdall:middlewareCount'] = String(
    listHeimdallMiddlewares().length,
  );
  context.state.middlewareScratchpad['heimdall:middlewareIds'] =
    listHeimdallMiddlewares()
      .map((middleware) => middleware.id)
      .join(',');
  await saveHeimdallThreadState(context.state);
}

export async function recordHeimdallEvent(
  sessionStore: SessionStore,
  session: SessionRecord,
  options: {
    kind: HeimdallEventKind;
    summary: string;
    runtimeId?: string;
    sessionId?: string;
    workerSessionId?: string;
    workflowMode?: WorkflowMode;
    role?: AgentRole;
    phase?: AgentPhase;
    status?: TaskRuntimeStatus;
    metadata?: Record<string, string | undefined>;
  },
): Promise<void> {
  const metadata = options.metadata
    ? Object.fromEntries(
        Object.entries(options.metadata)
          .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
          .map(([key, value]) => [key, value.trim()])
          .filter(([key, value]) => key.trim().length > 0 && value.length > 0),
      )
    : undefined;

  const rootSessionId = session.rootSessionId ?? session.id;
  const event = {
    id: randomUUID(),
    kind: options.kind,
    createdAt: now(),
    summary: options.summary.trim(),
    runtimeId: options.runtimeId,
    sessionId: options.sessionId,
    workerSessionId: options.workerSessionId,
    workflowMode: options.workflowMode,
    role: options.role,
    phase: options.phase,
    status: options.status,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
  } as const;
  sessionStore.appendHeimdallEvent(session, event);
  const paths = getHeimdallThreadPaths(session.cwd, rootSessionId);
  await ensureDir(paths.threadRoot);
  const envelope: HeimdallEventEnvelope = {
    rootSessionId,
    threadRoot: paths.threadRoot,
    event,
  };
  // Serialise as a single JSONL line; replace bare newlines inside string
  // values so the record never spans multiple lines and split('\n') stays safe.
  const jsonlLine = JSON.stringify(envelope).replace(/\n/g, '\\n') + '\n';
  await appendFile(
    getHeimdallEventLogPath(session.cwd, rootSessionId),
    jsonlLine,
    'utf8',
  );
  await publishHeimdallEvent(envelope);
}

export async function recordHeimdallStage(
  sessionStore: SessionStore,
  session: SessionRecord,
  state: HeimdallThreadState,
  stage: HeimdallLifecycleStage,
  options?: {
    summary?: string;
    runtimeId?: string;
    workflowMode?: WorkflowMode;
    role?: AgentRole;
    phase?: AgentPhase;
    status?: TaskRuntimeStatus;
    metadata?: Record<string, string | undefined>;
  },
): Promise<void> {
  syncHeimdallThreadState(state, session);
  state.lifecycleStages = [...state.lifecycleStages, stage].slice(-32);
  await runHeimdallMiddlewareStage({
    sessionStore,
    session,
    state,
    stage,
    workflowMode: options?.workflowMode ?? state.workflowMode,
    runtimeId: options?.runtimeId ?? state.runtimeId,
    role: options?.role,
    phase: options?.phase,
    status: options?.status,
    metadata: options?.metadata,
  });

  await recordHeimdallEvent(sessionStore, session, {
    kind: stage === 'before_thread_bind' ? 'thread_bound' : 'lifecycle_stage',
    summary:
      options?.summary ??
      (stage === 'before_thread_bind'
        ? 'Heimdall thread state prepared.'
        : `Heimdall lifecycle stage: ${stage}.`),
    runtimeId: options?.runtimeId ?? state.runtimeId,
    sessionId: session.id,
    workerSessionId: undefined,
    workflowMode: options?.workflowMode ?? state.workflowMode,
    role: options?.role,
    phase: options?.phase,
    status: options?.status,
    metadata: {
      stage,
      thread_root: state.paths.threadRoot,
      workspace: state.paths.workspace,
      uploads: state.paths.uploads,
      outputs: state.paths.outputs,
      artifacts: state.paths.artifacts,
      active_runtime_count: String(state.activeRuntimeIds.length),
      ...(state.remoteOrigin ? { remote_origin: state.remoteOrigin } : {}),
      ...(options?.metadata ?? {}),
    },
  });
  await saveHeimdallThreadState(state);
}
