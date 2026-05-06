/* eslint-disable @typescript-eslint/no-unused-vars */
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeProviderProtocol } from '../providers/factory.js';
import type { ProviderConfig } from '../providers/types.js';
import { createProviderRouter } from '../providers/router.js';
import { resolveMainProviderConfig } from '../providers/onboarding.js';
import { createTrackedProviderFromConfig } from '../providers/telemetry.js';
import { PermissionManager } from '../security/permissions.js';
import { isPermissionModeInput, normalizePermissionMode } from '../security/permissionModes.js';
import { SessionStore } from '../storage/sessions.js';
import { appendTaskRuntime, createTaskRuntimeRecord, updateTaskRuntime } from '../core/taskRuntime.js';
import { getWorkflowDisplayName, getWorkflowSessionTitle, isReadOnlyWorkflow, runWorkflowMode, type WorkflowMode } from '../core/workflowMode.js';
import type { PermissionMode } from '../core/types.js';
import { truncate, ensureDir, pathExists, resolveDataRootDir } from '../utils/fs.js';
import { maybeUpgradeWorkflow, recordWorkflowAdvice } from '../core/workflowAdvisor.js';

type DetachedWorkflowWorkerArgs = {
  sessionId: string;
  runtimeId: string;
  workflow: WorkflowMode;
  promptFile: string;
  launchToken: string;
  launchedAt: string;
  maxTurns: number;
  permissionMode: PermissionMode;
};

type DetachedWorkflowManifest = {
  sessionId: string;
  runtimeId: string;
  workflow: WorkflowMode;
  prompt: string;
  promptFile: string;
  logPath: string;
  launchToken: string;
  launchedAt: string;
  processId?: number;
  permissionMode: PermissionMode;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  leaseOwner?: 'worker';
  leaseHeartbeatAt?: string;
  takeoverStatus?: 'requested' | 'graceful' | 'forced';
  takeoverRequestedAt?: string;
  takeoverRequestedBy?: string;
  takeoverReason?: string;
  takeoverCompletedAt?: string;
  takeoverForcedAt?: string;
  updatedAt: string;
  lastError?: string;
};

type DetachedWorkflowMessage = {
  id: string;
  createdAt: string;
  text: string;
  consumedAt?: string;
};

export type DetachedWorkflowLaunchResult = {
  sessionId: string;
  runtimeId: string;
  processId: number;
  workflow: WorkflowMode;
  logPath: string;
};

export type DetachedWorkflowTakeoverRequest = {
  requestedBy: string;
  reason: string;
};

const DETACHED_WORKFLOW_HEARTBEAT_MS = 2_500;
const DETACHED_WORKFLOW_TERMINATION_GRACE_MS = 1_500;

function now(): string {
  return new Date().toISOString();
}

function quoteArg(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildArgumentList(args: string[]): string {
  return args.map(quoteArg).join(' ');
}

function getDetachedWorkflowDir(cwd: string): string {
  return path.join(resolveDataRootDir(cwd), 'detached-workflows');
}

export function getDetachedWorkflowLogPath(cwd: string, runtimeId: string): string {
  return path.join(getDetachedWorkflowDir(cwd), `${runtimeId}.log`);
}

function getDetachedWorkflowPromptPath(cwd: string, runtimeId: string): string {
  return path.join(getDetachedWorkflowDir(cwd), `${runtimeId}.prompt.txt`);
}

function getDetachedWorkflowMessagesPath(cwd: string, runtimeId: string): string {
  return path.join(getDetachedWorkflowDir(cwd), `${runtimeId}.messages.json`);
}

export function getDetachedWorkflowManifestPath(
  cwd: string,
  runtimeId: string,
): string {
  return path.join(getDetachedWorkflowDir(cwd), `${runtimeId}.json`);
}

async function writeDetachedWorkflowManifest(
  cwd: string,
  runtimeId: string,
  manifest: DetachedWorkflowManifest,
): Promise<void> {
  await ensureDir(getDetachedWorkflowDir(cwd));
  await writeFile(
    getDetachedWorkflowManifestPath(cwd, runtimeId),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
}

export async function readDetachedWorkflowManifest(
  cwd: string,
  runtimeId: string,
): Promise<DetachedWorkflowManifest | null> {
  const manifestPath = getDetachedWorkflowManifestPath(cwd, runtimeId);
  const raw = await readFile(manifestPath, 'utf8').catch(() => '');
  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw) as DetachedWorkflowManifest;
  } catch {
    return null;
  }
}

async function updateDetachedWorkflowManifest(
  cwd: string,
  runtimeId: string,
  patch: Partial<DetachedWorkflowManifest>,
): Promise<void> {
  const current = await readDetachedWorkflowManifest(cwd, runtimeId);
  if (!current) {
    return;
  }
  await writeDetachedWorkflowManifest(cwd, runtimeId, {
    ...current,
    ...patch,
    updatedAt: now(),
  });
}

async function readDetachedWorkflowMessages(
  cwd: string,
  runtimeId: string,
): Promise<DetachedWorkflowMessage[]> {
  const raw = await readFile(getDetachedWorkflowMessagesPath(cwd, runtimeId), 'utf8').catch(() => '[]');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is DetachedWorkflowMessage => {
      return Boolean(
        item &&
        typeof item === 'object' &&
        typeof (item as DetachedWorkflowMessage).id === 'string' &&
        typeof (item as DetachedWorkflowMessage).createdAt === 'string' &&
        typeof (item as DetachedWorkflowMessage).text === 'string',
      );
    });
  } catch {
    return [];
  }
}

async function writeDetachedWorkflowMessages(
  cwd: string,
  runtimeId: string,
  messages: DetachedWorkflowMessage[],
): Promise<void> {
  await ensureDir(getDetachedWorkflowDir(cwd));
  await writeFile(
    getDetachedWorkflowMessagesPath(cwd, runtimeId),
    JSON.stringify(messages, null, 2),
    'utf8',
  );
}

export async function appendDetachedWorkflowMessage(
  cwd: string,
  runtimeId: string,
  text: string,
): Promise<void> {
  const cleanText = text.trim();
  if (!cleanText) {
    return;
  }
  const messages = await readDetachedWorkflowMessages(cwd, runtimeId);
  messages.push({
    id: randomUUID(),
    createdAt: now(),
    text: cleanText,
  });
  await writeDetachedWorkflowMessages(cwd, runtimeId, messages);
}

function consumeDetachedWorkflowMessagesSync(
  cwd: string,
  runtimeId: string,
): string[] {
  const messagesPath = getDetachedWorkflowMessagesPath(cwd, runtimeId);
  let messages: DetachedWorkflowMessage[] = [];
  try {
    const parsed = JSON.parse(readFileSync(messagesPath, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      messages = parsed.filter((item): item is DetachedWorkflowMessage => {
        return Boolean(
          item &&
          typeof item === 'object' &&
          typeof (item as DetachedWorkflowMessage).id === 'string' &&
          typeof (item as DetachedWorkflowMessage).createdAt === 'string' &&
          typeof (item as DetachedWorkflowMessage).text === 'string',
        );
      });
    }
  } catch {
    return [];
  }

  const pending = messages.filter((message) => !message.consumedAt);
  if (pending.length === 0) {
    return [];
  }
  const consumedAt = now();
  const pendingIds = new Set(pending.map((message) => message.id));
  try {
    writeFileSync(
      messagesPath,
      JSON.stringify(
        messages.map((message) =>
          pendingIds.has(message.id)
            ? { ...message, consumedAt }
            : message,
        ),
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    return [];
  }
  return pending.map((message) => message.text);
}

export async function requestDetachedWorkflowTakeover(
  cwd: string,
  runtimeId: string,
  request: DetachedWorkflowTakeoverRequest,
): Promise<DetachedWorkflowManifest | null> {
  const current = await readDetachedWorkflowManifest(cwd, runtimeId);
  if (!current) {
    return null;
  }

  const requestedAt = now();
  const next: DetachedWorkflowManifest = {
    ...current,
    takeoverStatus: 'requested',
    takeoverRequestedAt: requestedAt,
    takeoverRequestedBy: request.requestedBy.trim(),
    takeoverReason: request.reason.trim(),
    updatedAt: requestedAt,
  };
  await writeDetachedWorkflowManifest(cwd, runtimeId, next);
  return next;
}

export async function finalizeDetachedWorkflowTakeover(
  cwd: string,
  runtimeId: string,
  status: 'graceful' | 'forced',
): Promise<void> {
  const timestamp = now();
  await updateDetachedWorkflowManifest(cwd, runtimeId, {
    status: 'interrupted',
    leaseOwner: undefined,
    leaseHeartbeatAt: undefined,
    takeoverStatus: status,
    takeoverCompletedAt: status === 'graceful' ? timestamp : undefined,
    takeoverForcedAt: status === 'forced' ? timestamp : undefined,
    lastError: undefined,
  });
}

type DetachedWorkflowLeasePoll =
  | {
      ok: true;
      manifest: DetachedWorkflowManifest;
    }
  | {
      ok: false;
      reason: string;
      manifest?: DetachedWorkflowManifest | null;
    };

async function pollDetachedWorkflowLease(options: {
  cwd: string;
  runtimeId: string;
  launchToken: string;
}): Promise<DetachedWorkflowLeasePoll> {
  const manifest = await readDetachedWorkflowManifest(options.cwd, options.runtimeId);
  if (!manifest) {
    return {
      ok: false,
      reason: 'Detached workflow manifest disappeared during execution.',
      manifest,
    };
  }

  if (manifest.launchToken !== options.launchToken) {
    return {
      ok: false,
      reason: 'Detached workflow lease token no longer matches the active manifest.',
      manifest,
    };
  }

  if (manifest.takeoverStatus === 'requested' || manifest.takeoverRequestedAt) {
    return {
      ok: false,
      reason:
        manifest.takeoverReason?.trim() ||
        'Detached workflow takeover requested by another session.',
      manifest,
    };
  }

  const heartbeatAt = now();
  const next: DetachedWorkflowManifest = {
    ...manifest,
    leaseOwner: 'worker',
    leaseHeartbeatAt: heartbeatAt,
    updatedAt: heartbeatAt,
  };
  await writeDetachedWorkflowManifest(options.cwd, options.runtimeId, next);
  return {
    ok: true,
    manifest: next,
  };
}

function buildDetachedTakeoverMessage(
  manifest: DetachedWorkflowManifest | null | undefined,
  fallback: string,
): string {
  const takeoverReason = manifest?.takeoverReason?.trim();
  const takeoverBy = manifest?.takeoverRequestedBy?.trim();
  if (takeoverReason && takeoverBy) {
    return `${takeoverReason} Requested by ${takeoverBy}.`;
  }
  if (takeoverReason) {
    return takeoverReason;
  }
  return fallback;
}

async function resolveSelfInvocation(cwd: string): Promise<string[]> {
  const compiledEntry = path.join(cwd, 'dist', 'index.js');
  if (await pathExists(compiledEntry)) {
    return [compiledEntry];
  }

  return ['--experimental-strip-types', path.join(cwd, 'src', 'index.ts')];
}

function parseWorkerArgs(argv: string[]): DetachedWorkflowWorkerArgs {
  const next = [...argv];
  const parsed: Partial<DetachedWorkflowWorkerArgs> = {};

  while (next.length > 0) {
    const head = next.shift();
    if (!head) {
      continue;
    }

    if (head === '--session-id') {
      parsed.sessionId = next.shift();
      continue;
    }
    if (head === '--runtime-id') {
      parsed.runtimeId = next.shift();
      continue;
    }
    if (head === '--workflow') {
      const workflow = next.shift();
      if (
        workflow === 'direct' ||
        workflow === 'niko' ||
        workflow === 'contest' ||
        workflow === 'athena' ||
        workflow === 'design' ||
        workflow === 'nidhogg'
      ) {
        parsed.workflow = workflow;
      }
      continue;
    }
    if (head === '--prompt-file') {
      parsed.promptFile = next.shift();
      continue;
    }
    if (head === '--launch-token') {
      parsed.launchToken = next.shift();
      continue;
    }
    if (head === '--launched-at') {
      parsed.launchedAt = next.shift();
      continue;
    }
    if (head === '--max-turns') {
      parsed.maxTurns = Number(next.shift());
      continue;
    }
    if (head === '--permission-mode') {
      const mode = next.shift();
      if (isPermissionModeInput(mode)) {
        parsed.permissionMode = normalizePermissionMode(mode);
      }
      continue;
    }
  }

  if (
    !parsed.sessionId ||
    !parsed.runtimeId ||
    !parsed.workflow ||
    !parsed.promptFile ||
    !parsed.launchToken ||
    !parsed.launchedAt ||
    !parsed.maxTurns ||
    !parsed.permissionMode
  ) {
    throw new Error('Invalid detached workflow worker arguments.');
  }

  return parsed as DetachedWorkflowWorkerArgs;
}

export async function spawnDetachedWorkflow(options: {
  cwd: string;
  sessionStore: SessionStore;
  prompt: string;
  command: 'run' | 'athena' | 'design' | 'niko' | 'contest' | 'nidhogg';
  maxTurns: number;
  permissionMode: PermissionMode;
  permissionModeExplicit: boolean;
  providerConfig: ProviderConfig;
}): Promise<DetachedWorkflowLaunchResult> {
  const session = options.sessionStore.createSession({
    title: undefined,
  });

  const selectedWorkflow: WorkflowMode =
    options.command === 'athena'
      ? 'athena'
      : options.command === 'design'
      ? 'design'
      : options.command === 'niko'
      ? 'niko'
      : options.command === 'contest'
      ? 'contest'
      : options.command === 'nidhogg'
        ? 'nidhogg'
        : 'direct';

  session.title =
    getWorkflowSessionTitle(selectedWorkflow, options.cwd) ??
    session.title;

  const runtime = createTaskRuntimeRecord({
    label: `${getWorkflowDisplayName(selectedWorkflow)} :: ${truncate(options.prompt.trim(), 140)}`,
    workflowMode: selectedWorkflow,
    status: 'queued',
    lastOutput: 'Detached workflow queued.',
  });
  appendTaskRuntime(session, runtime);
  await options.sessionStore.save(session);

  const detachedDir = getDetachedWorkflowDir(options.cwd);
  await ensureDir(detachedDir);
  const promptFile = getDetachedWorkflowPromptPath(options.cwd, runtime.id);
  const logPath = getDetachedWorkflowLogPath(options.cwd, runtime.id);
  const launchToken = randomUUID();
  const launchedAt = now();
  await writeFile(promptFile, options.prompt, 'utf8');

  const invocation = await resolveSelfInvocation(options.cwd);
  const workerArgs = [
    ...invocation,
    '__bg_worker__',
    '--session-id',
    session.id,
    '--runtime-id',
    runtime.id,
    '--workflow',
    selectedWorkflow,
    '--prompt-file',
    promptFile,
    '--launch-token',
    launchToken,
    '--launched-at',
    launchedAt,
    '--max-turns',
    String(options.maxTurns),
    '--permission-mode',
    isReadOnlyWorkflow(selectedWorkflow) && !options.permissionModeExplicit
      ? 'read-only'
      : options.permissionMode,
  ];

  const logStream = createWriteStream(logPath, { flags: 'a' });
  logStream.write(
    `[${now()}] launching detached workflow ${selectedWorkflow} for session ${session.id}\n`,
  );
  logStream.write(`[${now()}] command: ${buildArgumentList(workerArgs)}\n\n`);

  await writeDetachedWorkflowManifest(options.cwd, runtime.id, {
    sessionId: session.id,
    runtimeId: runtime.id,
    workflow: selectedWorkflow,
    prompt: options.prompt,
    promptFile,
    logPath,
    launchToken,
    launchedAt,
    permissionMode:
      isReadOnlyWorkflow(selectedWorkflow) && !options.permissionModeExplicit
        ? 'read-only'
        : options.permissionMode,
    status: 'queued',
    leaseOwner: 'worker',
    leaseHeartbeatAt: launchedAt,
    updatedAt: launchedAt,
  });

  const child = spawn(process.execPath, workerArgs, {
    cwd: options.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ARTEMIS_PROVIDER_PROTOCOL: options.providerConfig.protocol,
      ARTEMIS_MODEL: options.providerConfig.model,
      ARTEMIS_BASE_URL: options.providerConfig.baseUrl,
      ARTEMIS_API_KEY: options.providerConfig.apiKey,
    },
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.unref();

  updateTaskRuntime(session, runtime.id, {
    processId: child.pid,
    processStartedAt: launchedAt,
    processToken: launchToken,
    lastOutput: `Detached workflow queued. Log: ${path.relative(options.cwd, logPath)}`,
  });
  await options.sessionStore.save(session);
  await updateDetachedWorkflowManifest(options.cwd, runtime.id, {
    processId: child.pid,
  });

  return {
    sessionId: session.id,
    runtimeId: runtime.id,
    processId: child.pid ?? 0,
    workflow: selectedWorkflow,
    logPath,
  };
}

export async function runDetachedWorkflowWorker(
  cwd: string,
  argv: string[],
): Promise<void> {
  const args = parseWorkerArgs(argv);
  const sessionStore = new SessionStore(cwd);
  const session = await sessionStore.load(args.sessionId);
  const prompt = await readFile(args.promptFile, 'utf8');
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const markInterrupted = async (message: string, takeoverStatus?: 'graceful' | 'forced'): Promise<void> => {
    const freshSession = await sessionStore.load(args.sessionId);
    updateTaskRuntime(freshSession, args.runtimeId, {
      status: 'interrupted',
      processId: undefined,
      processStartedAt: undefined,
      processToken: undefined,
      lastOutput: message,
    });
    await sessionStore.save(freshSession);
    await updateDetachedWorkflowManifest(cwd, args.runtimeId, {
      status: 'interrupted',
      processId: undefined,
      leaseOwner: undefined,
      leaseHeartbeatAt: undefined,
      takeoverStatus,
      takeoverCompletedAt: takeoverStatus === 'graceful' ? now() : undefined,
      takeoverForcedAt: takeoverStatus === 'forced' ? now() : undefined,
      lastError: undefined,
    });
  };

  const shutdownForSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopHeartbeat();
    const exitTimer = setTimeout(() => {
      process.exit(signal === 'SIGTERM' ? 0 : 1);
    }, DETACHED_WORKFLOW_TERMINATION_GRACE_MS);
    exitTimer.unref?.();
    void (async () => {
      const manifest = await readDetachedWorkflowManifest(cwd, args.runtimeId);
      const message = buildDetachedTakeoverMessage(
        manifest,
        signal === 'SIGTERM'
          ? 'Detached workflow interrupted for runtime takeover.'
          : `Detached workflow interrupted by ${signal}.`,
      );
      await markInterrupted(
        message,
        manifest?.takeoverStatus === 'requested' ? 'graceful' : undefined,
      );
      process.exit(signal === 'SIGTERM' ? 0 : 1);
    })();
  };

  process.once('SIGTERM', () => shutdownForSignal('SIGTERM'));
  process.once('SIGINT', () => shutdownForSignal('SIGINT'));

  try {
    const providerConfig = await resolveMainProviderConfig({
      cwd,
      config: {
        protocol: normalizeProviderProtocol(process.env.ARTEMIS_PROVIDER_PROTOCOL),
        model: process.env.ARTEMIS_MODEL,
        baseUrl: process.env.ARTEMIS_BASE_URL,
        apiKey: process.env.ARTEMIS_API_KEY,
      },
      onInfo: (message) => console.error(message),
    });
    const trackedProfileId =
      typeof (providerConfig as unknown as { id?: unknown }).id === 'string'
        ? (providerConfig as unknown as { id: string }).id
        : undefined;
    const trackedProfileLabel =
      typeof (providerConfig as unknown as { label?: unknown }).label === 'string'
        ? (providerConfig as unknown as { label: string }).label
        : trackedProfileId;
    const provider = createTrackedProviderFromConfig(providerConfig, {
      cwd,
      profileId: trackedProfileId,
      profileLabel: trackedProfileLabel,
    });
    const permissionManager = new PermissionManager(args.permissionMode, false);
    const providerRouter = await createProviderRouter({
      cwd,
      mainProvider: provider,
      onInfo: (message) => console.error(message),
    });

    if (args.workflow === 'direct') {
      const advice = await maybeUpgradeWorkflow(
        prompt,
        undefined,
        (message) => console.error(message),
      );
      if (advice) {
        await recordWorkflowAdvice(
          sessionStore,
          session,
          advice.advice,
          advice.selected,
        );
        if (advice.selected !== 'direct') {
          args.workflow = advice.selected;
          session.title =
            getWorkflowSessionTitle(args.workflow, cwd) ?? session.title;
        }
      }
    }

    updateTaskRuntime(session, args.runtimeId, {
      processId: process.pid,
      processStartedAt: args.launchedAt,
      processToken: args.launchToken,
      status: 'running',
      workflowMode: args.workflow,
      lastOutput: `Detached workflow running (${getWorkflowDisplayName(args.workflow)}).`,
    });
    await sessionStore.save(session);
    await updateDetachedWorkflowManifest(cwd, args.runtimeId, {
      processId: process.pid,
      workflow: args.workflow,
      status: 'running',
      leaseOwner: 'worker',
      leaseHeartbeatAt: now(),
    });

    const initialLease = await pollDetachedWorkflowLease({
      cwd,
      runtimeId: args.runtimeId,
      launchToken: args.launchToken,
    });
    if (!initialLease.ok) {
      await markInterrupted(
        buildDetachedTakeoverMessage(
          initialLease.manifest,
          initialLease.reason,
        ),
        initialLease.manifest?.takeoverStatus === 'requested'
          ? 'graceful'
          : undefined,
      );
      return;
    }

    heartbeatTimer = setInterval(() => {
      void (async () => {
        if (shuttingDown) {
          return;
        }
        const lease = await pollDetachedWorkflowLease({
          cwd,
          runtimeId: args.runtimeId,
          launchToken: args.launchToken,
        });
        if (lease.ok) {
          return;
        }

        shuttingDown = true;
        stopHeartbeat();
        await markInterrupted(
          buildDetachedTakeoverMessage(lease.manifest, lease.reason),
          lease.manifest?.takeoverStatus === 'requested'
            ? 'graceful'
            : undefined,
        );
        process.exit(0);
      })();
    }, DETACHED_WORKFLOW_HEARTBEAT_MS);
    heartbeatTimer.unref?.();

    const result = await runWorkflowMode(args.workflow, session, prompt, {
      cwd,
      provider,
      sessionStore,
      permissionManager,
      maxTurns: args.maxTurns,
      rootRuntimeId: args.runtimeId,
      ensureSpecialistProvider: providerRouter.ensureSpecialistProvider,
      resolveProvider: providerRouter.resolveProvider,
      onInfo: (message) => console.error(message),
      pollRunningUserMessages: () => consumeDetachedWorkflowMessagesSync(cwd, args.runtimeId),
      onRunningUserMessageAccepted: (text) => {
        console.error(`[nidhogg] new running user message synced: ${truncate(text, 120)}`);
      },
    });
    stopHeartbeat();
    console.log(result.reply);
    await updateDetachedWorkflowManifest(cwd, args.runtimeId, {
      status: 'completed',
      workflow: args.workflow,
      processId: undefined,
      leaseOwner: undefined,
      leaseHeartbeatAt: undefined,
      lastError: undefined,
    });
  } catch (error) {
    stopHeartbeat();
    const message = error instanceof Error ? error.message : String(error);
    await updateDetachedWorkflowManifest(cwd, args.runtimeId, {
      status: 'failed',
      workflow: args.workflow,
      processId: undefined,
      leaseOwner: undefined,
      leaseHeartbeatAt: undefined,
      lastError: message,
    });
    throw error;
  } finally {
    stopHeartbeat();
    await unlink(args.promptFile).catch(() => undefined);
  }
}
