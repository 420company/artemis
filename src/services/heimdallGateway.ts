import { readdir, rm } from 'node:fs/promises';
import type { SessionRecord } from '../core/types.js';
import type {
  HeimdallEventCursor,
  HeimdallEventEnvelope,
  HeimdallVirtualMounts,
} from '../core/heimdall.js';
import {
  getHeimdallArtifactManifestPath,
  getHeimdallEventLogPath,
  getHeimdallThreadPaths,
  getHeimdallThreadStatePath,
  getHeimdallUploadManifestPath,
  getHeimdallVirtualMounts,
  listHeimdallMiddlewares,
  persistHeimdallThreadState,
  readHeimdallArtifactManifest,
  readHeimdallEventLog,
  readHeimdallEventWindow,
  readHeimdallThreadState,
  readHeimdallUploadManifest,
  waitForHeimdallEvents,
} from '../core/heimdall.js';
import { SessionStore } from '../storage/sessions.js';
import { ingestHeimdallUploads } from './heimdallUploads.js';
import { pathExists } from '../utils/fs.js';

function now(): string {
  return new Date().toISOString();
}

export type HeimdallThreadSnapshot = {
  rootSessionId: string;
  statePath: string;
  stateExists: boolean;
  eventLogPath: string;
  eventLogExists: boolean;
  uploadManifestPath: string;
  uploadManifestExists: boolean;
  artifactManifestPath: string;
  artifactManifestExists: boolean;
  threadRoot: string;
  workspace: string;
  uploads: string;
  outputs: string;
  artifactsDir: string;
  virtualMounts: HeimdallVirtualMounts;
  sandboxProviderId?: string;
  sandboxMode?: string;
  sandboxFilesystemIsolation?: boolean;
  sandboxNetworkIsolation?: boolean;
  sessionTitle: string;
  sessionSummary: string;
  sessionSummaryChars: number;
  blockingStatus: string;
  blockingReason: string;
  clarificationStatus: string;
  clarificationReason: string;
  mediaTotalCount: number;
  mediaImageCount: number;
  mediaDocumentCount: number;
  mediaAudioVideoCount: number;
  lastStage?: string;
  lastEventKind?: string;
  activeRuntimeCount: number;
  eventCount: number;
  artifactCount: number;
  taskCount: number;
  planCount: number;
  changedFileCount: number;
  verificationCommandCount: number;
  middlewareCount: number;
  middlewareIds: string[];
  uploadCount: number;
  recentArtifacts: NonNullable<
    Awaited<ReturnType<typeof readHeimdallThreadState>>
  >['artifacts'];
  recentUploads: NonNullable<
    Awaited<ReturnType<typeof readHeimdallThreadState>>
  >['uploads'];
};

export type HeimdallThreadCatalogEntry = {
  rootSessionId: string;
  threadRoot: string;
  lastStage?: string;
  lastEventKind?: string;
  blockingStatus: string;
  clarificationStatus: string;
  activeRuntimeCount: number;
  artifactCount: number;
  uploadCount: number;
  mediaTotalCount: number;
  updatedAt?: string;
};

export type HeimdallThreadCatalogResponse = {
  generatedAt: string;
  limit: number;
  threads: HeimdallThreadCatalogEntry[];
};

export type HeimdallEventStreamResponse = {
  generatedAt: string;
  rootSessionId: string;
  threadRoot: string;
  eventLogPath: string;
  eventCount: number;
  cursor: HeimdallEventCursor;
  events: HeimdallEventEnvelope[];
};

export type HeimdallFollowResponse = HeimdallEventStreamResponse & {
  timedOut: boolean;
};

export type HeimdallUploadIngestionResponse = {
  generatedAt: string;
  rootSessionId: string;
  threadRoot: string;
  uploadManifestPath: string;
  artifactManifestPath: string;
  imported: Awaited<ReturnType<typeof ingestHeimdallUploads>>['imported'];
  skipped: Awaited<ReturnType<typeof ingestHeimdallUploads>>['skipped'];
  uploadCount: number;
  mediaInventory:
    NonNullable<Awaited<ReturnType<typeof readHeimdallThreadState>>>['mediaInventory'];
};

export type HeimdallThreadCleanupResponse = {
  generatedAt: string;
  rootSessionId: string;
  threadRoot: string;
  removed: boolean;
};

export async function getHeimdallThreadSnapshot(options: {
  cwd: string;
  session: SessionRecord;
}): Promise<HeimdallThreadSnapshot> {
  const rootSessionId = options.session.rootSessionId ?? options.session.id;
  const paths = getHeimdallThreadPaths(options.cwd, rootSessionId);
  const statePath = getHeimdallThreadStatePath(options.cwd, rootSessionId);
  const eventLogPath = getHeimdallEventLogPath(options.cwd, rootSessionId);
  const uploadManifestPath = getHeimdallUploadManifestPath(
    options.cwd,
    rootSessionId,
  );
  const artifactManifestPath = getHeimdallArtifactManifestPath(
    options.cwd,
    rootSessionId,
  );
  const state = await readHeimdallThreadState(options.cwd, rootSessionId);
  const eventLog = await readHeimdallEventLog({
    cwd: options.cwd,
    rootSessionId,
  });
  const uploadManifest = await readHeimdallUploadManifest({
    cwd: options.cwd,
    rootSessionId,
  });
  const artifactManifest = await readHeimdallArtifactManifest({
    cwd: options.cwd,
    rootSessionId,
  });

  return {
    rootSessionId,
    statePath,
    stateExists: await pathExists(statePath),
    eventLogPath,
    eventLogExists: await pathExists(eventLogPath),
    uploadManifestPath,
    uploadManifestExists: await pathExists(uploadManifestPath),
    artifactManifestPath,
    artifactManifestExists: await pathExists(artifactManifestPath),
    threadRoot: paths.threadRoot,
    workspace: paths.workspace,
    uploads: paths.uploads,
    outputs: paths.outputs,
    artifactsDir: paths.artifacts,
    virtualMounts: getHeimdallVirtualMounts(),
    sessionTitle: state?.sessionTitle ?? options.session.title,
    sessionSummary: state?.sessionSummary ?? options.session.summary ?? '',
    sessionSummaryChars: state?.sessionSummary.length ?? options.session.summary?.length ?? 0,
    blockingStatus: state?.blockingState.status ?? 'clear',
    blockingReason: state?.blockingState.reason ?? 'no approval or blocked-task holds',
    clarificationStatus: state?.clarificationState.status ?? 'clear',
    clarificationReason: state?.clarificationState.reason ?? 'no pending clarification',
    mediaTotalCount: state?.mediaInventory.totalCount ?? 0,
    mediaImageCount: state?.mediaInventory.imageCount ?? 0,
    mediaDocumentCount: state?.mediaInventory.documentCount ?? 0,
    mediaAudioVideoCount: state?.mediaInventory.audioVideoCount ?? 0,
    sandboxProviderId: state?.sandbox?.providerId,
    sandboxMode: state?.sandbox?.mode,
    sandboxFilesystemIsolation:
      state?.sandbox?.capabilities.isolatedFilesystem,
    sandboxNetworkIsolation:
      state?.sandbox?.capabilities.isolatedNetwork,
    lastStage: state?.middlewareScratchpad['heimdall:lastStage'],
    lastEventKind: eventLog.at(-1)?.event.kind,
    activeRuntimeCount:
      state?.activeRuntimeIds.length ??
      (options.session.taskRuntimes ?? []).filter((runtime) =>
        runtime.status === 'queued' ||
        runtime.status === 'running' ||
        runtime.status === 'waiting_approval',
      ).length,
    eventCount: eventLog.length,
    artifactCount:
      artifactManifest?.artifacts.length ??
      state?.artifacts.length ??
      options.session.changedFiles?.length ??
      0,
    taskCount: state?.taskCount ?? options.session.tasks?.length ?? 0,
    planCount: state?.planCount ?? options.session.plan?.length ?? 0,
    changedFileCount:
      state?.changedFiles.length ?? options.session.changedFiles?.length ?? 0,
    verificationCommandCount:
      state?.verificationCommandCount ??
      options.session.verificationCommands?.length ??
      0,
    middlewareCount:
      Number(state?.middlewareScratchpad['heimdall:middlewareCount'] ?? '0') ||
      listHeimdallMiddlewares().length,
    middlewareIds:
      (state?.middlewareScratchpad['heimdall:middlewareIds'] ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean).length > 0
        ? (state?.middlewareScratchpad['heimdall:middlewareIds'] ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
        : listHeimdallMiddlewares().map((middleware) => middleware.id),
    uploadCount: uploadManifest?.uploads.length ?? state?.uploads.length ?? 0,
    recentArtifacts: [...(artifactManifest?.artifacts ?? state?.artifacts ?? [])].slice(
      -5,
    ),
    recentUploads: [...(uploadManifest?.uploads ?? state?.uploads ?? [])].slice(-5),
  };
}

export async function listHeimdallThreads(options: {
  cwd: string;
  limit?: number;
}): Promise<HeimdallThreadCatalogEntry[]> {
  const threadsRoot = getHeimdallThreadPaths(options.cwd, 'placeholder').threadsRoot;
  const exists = await pathExists(threadsRoot);
  if (!exists) {
    return [];
  }

  const entries = await readdir(threadsRoot, { withFileTypes: true });
  const snapshots = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const rootSessionId = entry.name;
        const paths = getHeimdallThreadPaths(options.cwd, rootSessionId);
        const state = await readHeimdallThreadState(options.cwd, rootSessionId);
        const eventLog = await readHeimdallEventLog({
          cwd: options.cwd,
          rootSessionId,
        });
        const uploadManifest = await readHeimdallUploadManifest({
          cwd: options.cwd,
          rootSessionId,
        });
        const artifactManifest = await readHeimdallArtifactManifest({
          cwd: options.cwd,
          rootSessionId,
        });
        return {
          rootSessionId,
          threadRoot: paths.threadRoot,
          lastStage: state?.middlewareScratchpad['heimdall:lastStage'],
          lastEventKind: eventLog.at(-1)?.event.kind,
          blockingStatus: state?.blockingState.status ?? 'clear',
          clarificationStatus: state?.clarificationState.status ?? 'clear',
          activeRuntimeCount: state?.activeRuntimeIds.length ?? 0,
          artifactCount: artifactManifest?.artifacts.length ?? state?.artifacts.length ?? 0,
          uploadCount: uploadManifest?.uploads.length ?? state?.uploads.length ?? 0,
          mediaTotalCount: state?.mediaInventory.totalCount ?? 0,
          updatedAt:
            state?.middlewareScratchpad['heimdall:lastStageAt'] ??
            eventLog.at(-1)?.event.createdAt,
        } satisfies HeimdallThreadCatalogEntry;
      }),
  );

  return snapshots
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
    .slice(0, Math.max(1, options.limit ?? snapshots.length));
}

export async function getHeimdallThreadCatalogResponse(options: {
  cwd: string;
  limit?: number;
}): Promise<HeimdallThreadCatalogResponse> {
  const limit = Math.max(1, options.limit ?? 12);
  return {
    generatedAt: now(),
    limit,
    threads: await listHeimdallThreads({
      cwd: options.cwd,
      limit,
    }),
  };
}

export async function getHeimdallEventStreamResponse(options: {
  cwd: string;
  session: SessionRecord;
  limit?: number;
  afterOffset?: number;
}): Promise<HeimdallEventStreamResponse> {
  const snapshot = await getHeimdallThreadSnapshot(options);
  const window = await readHeimdallEventWindow({
    cwd: options.cwd,
    rootSessionId: snapshot.rootSessionId,
    afterOffset: options.afterOffset,
    limit: options.limit,
  });
  return {
    generatedAt: now(),
    rootSessionId: snapshot.rootSessionId,
    threadRoot: snapshot.threadRoot,
    eventLogPath: snapshot.eventLogPath,
    eventCount: snapshot.eventCount,
    cursor: window.cursor,
    events: window.events,
  };
}

export async function followHeimdallEventStream(options: {
  cwd: string;
  session: SessionRecord;
  limit?: number;
  afterOffset?: number;
  timeoutSeconds?: number;
}): Promise<HeimdallFollowResponse> {
  const snapshot = await getHeimdallThreadSnapshot(options);
  const result = await waitForHeimdallEvents({
    cwd: options.cwd,
    rootSessionId: snapshot.rootSessionId,
    afterOffset: options.afterOffset,
    limit: options.limit,
    timeoutMs: (options.timeoutSeconds ?? 30) * 1_000,
  });
  return {
    generatedAt: now(),
    rootSessionId: snapshot.rootSessionId,
    threadRoot: snapshot.threadRoot,
    eventLogPath: snapshot.eventLogPath,
    eventCount: snapshot.eventCount,
    timedOut: result.timedOut,
    cursor: result.cursor,
    events: result.events,
  };
}

export async function ingestHeimdallThreadUploads(options: {
  cwd: string;
  session: SessionRecord;
  sessionStore?: SessionStore;
  inputPaths: string[];
}): Promise<HeimdallUploadIngestionResponse> {
  const sessionStore = options.sessionStore ?? new SessionStore(options.cwd);
  const result = await ingestHeimdallUploads({
    cwd: options.cwd,
    session: options.session,
    sessionStore,
    inputPaths: options.inputPaths,
  });
  return {
    generatedAt: now(),
    rootSessionId: result.state.rootSessionId,
    threadRoot: result.state.paths.threadRoot,
    uploadManifestPath: getHeimdallUploadManifestPath(
      options.cwd,
      result.state.rootSessionId,
    ),
    artifactManifestPath: getHeimdallArtifactManifestPath(
      options.cwd,
      result.state.rootSessionId,
    ),
    imported: result.imported,
    skipped: result.skipped,
    uploadCount: result.state.uploads.length,
    mediaInventory: result.state.mediaInventory,
  };
}

export type HeimdallStateUpdateResponse = {
  generatedAt: string;
  rootSessionId: string;
  updated: boolean;
  previousBlockingStatus?: string;
  previousClarificationStatus?: string;
  blockingStatus?: string;
  clarificationStatus?: string;
  message: string;
};

export async function approveHeimdallBlocking(options: {
  cwd: string;
  session: SessionRecord;
}): Promise<HeimdallStateUpdateResponse> {
  const rootSessionId = options.session.rootSessionId ?? options.session.id;
  const state = await readHeimdallThreadState(options.cwd, rootSessionId);
  if (!state) {
    return { generatedAt: now(), rootSessionId, updated: false, message: 'no thread state found' };
  }
  const previousBlockingStatus = state.blockingState.status;
  state.blockingState = {
    status: 'clear',
    reason: 'approved by user via heimdall command',
    updatedAt: now(),
  };
  await persistHeimdallThreadState(state);
  return {
    generatedAt: now(),
    rootSessionId,
    updated: true,
    previousBlockingStatus,
    blockingStatus: state.blockingState.status,
    message: `blocking state cleared (was: ${previousBlockingStatus})`,
  };
}

export async function unblockHeimdallThread(options: {
  cwd: string;
  session: SessionRecord;
}): Promise<HeimdallStateUpdateResponse> {
  const rootSessionId = options.session.rootSessionId ?? options.session.id;
  const state = await readHeimdallThreadState(options.cwd, rootSessionId);
  if (!state) {
    return { generatedAt: now(), rootSessionId, updated: false, message: 'no thread state found' };
  }
  const previousBlockingStatus = state.blockingState.status;
  state.blockingState = {
    status: 'clear',
    reason: 'unblocked by user via heimdall command',
    updatedAt: now(),
  };
  await persistHeimdallThreadState(state);
  return {
    generatedAt: now(),
    rootSessionId,
    updated: true,
    previousBlockingStatus,
    blockingStatus: state.blockingState.status,
    message: `blocking state cleared (was: ${previousBlockingStatus})`,
  };
}

export async function replyHeimdallClarification(options: {
  cwd: string;
  session: SessionRecord;
  replyText: string;
}): Promise<HeimdallStateUpdateResponse> {
  const rootSessionId = options.session.rootSessionId ?? options.session.id;
  const state = await readHeimdallThreadState(options.cwd, rootSessionId);
  if (!state) {
    return { generatedAt: now(), rootSessionId, updated: false, message: 'no thread state found' };
  }
  const previousClarificationStatus = state.clarificationState.status;
  state.clarificationState = {
    status: 'clear',
    reason: 'user replied via heimdall command',
    updatedAt: now(),
  };
  if (options.replyText.trim()) {
    state.middlewareScratchpad['heimdall:lastReply'] = options.replyText.trim();
    state.middlewareScratchpad['heimdall:lastReplyAt'] = now();
  }
  await persistHeimdallThreadState(state);
  return {
    generatedAt: now(),
    rootSessionId,
    updated: true,
    previousClarificationStatus,
    clarificationStatus: state.clarificationState.status,
    message: `clarification state cleared (was: ${previousClarificationStatus})`,
  };
}

export async function deleteHeimdallThreadData(options: {
  cwd: string;
  rootSessionId: string;
}): Promise<HeimdallThreadCleanupResponse> {
  const paths = getHeimdallThreadPaths(options.cwd, options.rootSessionId);
  const exists = await pathExists(paths.threadRoot);
  if (!exists) {
    return {
      generatedAt: now(),
      rootSessionId: options.rootSessionId,
      removed: false,
      threadRoot: paths.threadRoot,
    };
  }

  await rm(paths.threadRoot, { recursive: true, force: true });
  return {
    generatedAt: now(),
    rootSessionId: options.rootSessionId,
    removed: true,
    threadRoot: paths.threadRoot,
  };
}
