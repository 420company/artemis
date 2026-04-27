import { spawn } from 'node:child_process';
import { APP_NAME, APP_VERSION } from '../appMeta.js';
import { discoverMcpServerSurface, getSuggestedMcpAuthState } from './client.js';
import { buildRuntimeSnapshotFromSurface } from './runtime.js';
import type {
  McpAuthState,
  McpRuntimeSnapshot,
  McpServerConfig,
  McpServerStoreData,
} from './store.js';
import {
  ensureMcpOAuthAccessToken,
  persistMcpServerUpdate,
} from './oauth.js';

export type McpProbeResult = {
  id: string;
  status: 'ok' | 'failed' | 'skipped';
  ok: boolean;
  checkedAt: string;
  message: string;
  server?: McpServerConfig;
  nextAuthState?: McpAuthState;
  runtimeSnapshot?: McpRuntimeSnapshot;
  surface?: McpServerConfig['surface'];
};

function now(): string {
  return new Date().toISOString();
}

function normalizeIdForEnv(id: string): string {
  return id
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getEnvPrefix(server: McpServerConfig): string {
  return `ARTEMIS_MCP_${normalizeIdForEnv(server.id)}`;
}

async function resolveProbeHeaders(
  cwd: string,
  server: McpServerConfig,
): Promise<{
  server: McpServerConfig;
  headers: Record<string, string>;
  authMissing?: boolean;
}> {
  const headers: Record<string, string> = {
    ...(server.headers ?? {}),
  };
  const envPrefix = getEnvPrefix(server);
  const bearerToken =
    server.bearerToken ?? process.env[`${envPrefix}_BEARER_TOKEN`];
  if (bearerToken && !headers.authorization) {
    headers.authorization = `Bearer ${bearerToken}`;
  }

  const envHeaders = process.env[`${envPrefix}_HEADERS_JSON`];
  if (envHeaders) {
    try {
      const parsed = JSON.parse(envHeaders) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && key.trim()) {
            headers[key.trim()] = value.trim();
          }
        }
      }
    } catch {
      // Ignore malformed env header overrides and continue with the stored config.
    }
  }

  if (server.authType !== 'oauth') {
    return { server, headers };
  }

  try {
    const oauth = await ensureMcpOAuthAccessToken({
      server,
    });
    if (oauth.server !== server) {
      await persistMcpServerUpdate({
        cwd,
        server: oauth.server,
      }).catch(() => undefined);
    }
    if (!headers.authorization) {
      headers.authorization = `Bearer ${oauth.accessToken}`;
    }

    return {
      server: oauth.server,
      headers,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /not configured|run artemis mcp login/i.test(message)
    ) {
      return {
        server,
        headers,
        authMissing: true,
      };
    }

    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | undefined {
  if (Number.isInteger(value) && Number(value) >= 0) {
    return Number(value);
  }

  return undefined;
}

function pickRuntimeCount(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  const direct = readNonNegativeInteger(payload[`${key}Count`]);
  if (direct !== undefined) {
    return direct;
  }

  const nested = payload[key];
  if (Array.isArray(nested)) {
    return nested.length;
  }

  if (isRecord(nested)) {
    const nestedCount = readNonNegativeInteger(nested.count);
    if (nestedCount !== undefined) {
      return nestedCount;
    }
  }

  return readNonNegativeInteger(nested);
}

function pickRuntimeNotes(payload: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(payload.notes)) {
    const notes = payload.notes
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (notes.length > 0) {
      return notes;
    }
  }

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return [payload.message.trim()];
  }

  return undefined;
}

function readRuntimeSampleName(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ['name', 'id', 'title', 'uri', 'path']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
}

function pickRuntimeSampleNames(
  payload: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const names = value
    .map((entry) => readRuntimeSampleName(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 5);

  return names.length > 0 ? names : undefined;
}

function selectRuntimePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (isRecord(payload.runtime)) {
    return payload.runtime;
  }

  if (isRecord(payload.surface)) {
    return payload.surface;
  }

  if (isRecord(payload.snapshot)) {
    return payload.snapshot;
  }

  return payload;
}

type RpcDiscoverySurface = {
  connected: boolean;
  toolsCount?: number;
  resourcesCount?: number;
  promptsCount?: number;
  toolSample?: string[];
  resourceSample?: string[];
  promptSample?: string[];
  serverSignature?: string;
  sampledHeaders?: string[];
  notes?: string[];
};

function buildRpcRequest(id: number, method: string, params: object = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params,
  });
}

async function postRpcJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream;q=0.9, */*;q=0.1',
      'Content-Type': 'application/json',
      ...headers,
    },
    body,
    signal,
  });
}

function readRpcResultArray(
  payload: unknown,
  key: string,
): unknown[] | undefined {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    return undefined;
  }

  const value = payload.result[key];
  return Array.isArray(value) ? value : undefined;
}

async function attemptHttpRpcDiscovery(options: {
  server: McpServerConfig;
  timeoutMs: number;
}): Promise<RpcDiscoverySurface | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const initializeResponse = await postRpcJson(
      options.server.url ?? '',
      buildRpcRequest(1, 'initialize', {
        protocolVersion: '2024-11-05',
        clientInfo: {
          name: APP_NAME,
          version: APP_VERSION,
        },
        capabilities: {},
      }),
      {},
      controller.signal,
    );
    if (!initializeResponse.ok) {
      return undefined;
    }

    const initializePayload = (await initializeResponse
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    if (!initializePayload) {
      return undefined;
    }

    const sessionId = initializeResponse.headers.get('mcp-session-id') ?? undefined;
    const rpcHeaders: Record<string, string> = {};
    if (sessionId) {
      rpcHeaders['mcp-session-id'] = sessionId;
    }

    const [toolsResponse, resourcesResponse, promptsResponse] = await Promise.all([
      postRpcJson(
        options.server.url ?? '',
        buildRpcRequest(2, 'tools/list'),
        rpcHeaders,
        controller.signal,
      ).catch(() => undefined),
      postRpcJson(
        options.server.url ?? '',
        buildRpcRequest(3, 'resources/list'),
        rpcHeaders,
        controller.signal,
      ).catch(() => undefined),
      postRpcJson(
        options.server.url ?? '',
        buildRpcRequest(4, 'prompts/list'),
        rpcHeaders,
        controller.signal,
      ).catch(() => undefined),
    ]);

    const toolsPayload = toolsResponse
      ? ((await toolsResponse.clone().json().catch(() => null)) as unknown)
      : undefined;
    const resourcesPayload = resourcesResponse
      ? ((await resourcesResponse.clone().json().catch(() => null)) as unknown)
      : undefined;
    const promptsPayload = promptsResponse
      ? ((await promptsResponse.clone().json().catch(() => null)) as unknown)
      : undefined;

    const tools = readRpcResultArray(toolsPayload, 'tools') ?? [];
    const resources = readRpcResultArray(resourcesPayload, 'resources') ?? [];
    const prompts = readRpcResultArray(promptsPayload, 'prompts') ?? [];
    const serverInfo = isRecord(initializePayload.result) && isRecord(initializePayload.result.serverInfo)
      ? initializePayload.result.serverInfo
      : undefined;
    const serverSignature =
      (serverInfo && typeof serverInfo.name === 'string' ? serverInfo.name : undefined) ??
      initializeResponse.headers.get('server') ??
      initializeResponse.headers.get('x-powered-by') ??
      undefined;
    const sampledHeaders = ['server', 'x-powered-by', 'mcp-session-id']
      .map((key) => {
        const value = initializeResponse.headers.get(key);
        return value ? `${key}=${value}` : undefined;
      })
      .filter((entry): entry is string => Boolean(entry));

    return {
      connected: true,
      toolsCount: tools.length,
      resourcesCount: resources.length,
      promptsCount: prompts.length,
      toolSample: tools
        .map((entry) => readRuntimeSampleName(entry))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 5),
      resourceSample: resources
        .map((entry) => readRuntimeSampleName(entry))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 5),
      promptSample: prompts
        .map((entry) => readRuntimeSampleName(entry))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 5),
      serverSignature,
      sampledHeaders: sampledHeaders.length > 0 ? sampledHeaders : undefined,
      notes: ['Discovered via MCP initialize plus list methods.'],
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeProbeBodySummary(bodyText: string): string | undefined {
  const normalized = bodyText.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  if (/invalid_grant/i.test(normalized) || /refresh token/i.test(normalized)) {
    return 'invalid_grant: refresh token rejected';
  }

  if (/invalid_client/i.test(normalized)) {
    return 'invalid_client';
  }

  if (/expired/i.test(normalized) && /token/i.test(normalized)) {
    return 'token expired';
  }

  if (/unauthorized/i.test(normalized) && /token|auth|oauth/i.test(normalized)) {
    return 'authorization rejected';
  }

  return normalized.slice(0, 160);
}

function buildRuntimeSnapshot(options: {
  server: McpServerConfig;
  checkedAt: string;
  connection: McpRuntimeSnapshot['connection'];
  auth?: McpAuthState;
  toolsCount?: number;
  resourcesCount?: number;
  promptsCount?: number;
  commandsCount?: number;
  lastReachableAt?: string;
  lastAuthFailureAt?: string;
  contentType?: string;
  serverSignature?: string;
  sampledHeaders?: string[];
  toolSample?: string[];
  resourceSample?: string[];
  promptSample?: string[];
  commandSample?: string[];
  notes?: string[];
}): McpRuntimeSnapshot {
  const previous = options.server.runtime;
  return {
    connection: options.connection,
    auth: options.auth ?? options.server.authState,
    toolsCount: options.toolsCount ?? previous?.toolsCount ?? 0,
    resourcesCount: options.resourcesCount ?? previous?.resourcesCount ?? 0,
    promptsCount: options.promptsCount ?? previous?.promptsCount ?? 0,
    commandsCount: options.commandsCount ?? previous?.commandsCount ?? 0,
    source: 'probe',
    lastSeenAt: options.checkedAt,
    lastReachableAt: options.lastReachableAt ?? previous?.lastReachableAt,
    lastAuthFailureAt: options.lastAuthFailureAt ?? previous?.lastAuthFailureAt,
    contentType: options.contentType ?? previous?.contentType,
    serverSignature: options.serverSignature ?? previous?.serverSignature,
    sampledHeaders: options.sampledHeaders ?? previous?.sampledHeaders,
    toolSample: options.toolSample ?? previous?.toolSample,
    resourceSample: options.resourceSample ?? previous?.resourceSample,
    promptSample: options.promptSample ?? previous?.promptSample,
    commandSample: options.commandSample ?? previous?.commandSample,
    notes: options.notes ?? previous?.notes,
  };
}

async function extractHttpRuntimeSnapshot(options: {
  server: McpServerConfig;
  response: Response;
  checkedAt: string;
  auth: McpAuthState;
  connection: McpRuntimeSnapshot['connection'];
}): Promise<McpRuntimeSnapshot> {
  const contentType = options.response.headers.get('content-type') ?? '';
  const serverSignature =
    options.response.headers.get('server') ??
    options.response.headers.get('x-powered-by') ??
    undefined;
  const sampledHeaders = ['server', 'x-powered-by', 'mcp-session-id']
    .map((key) => {
      const value = options.response.headers.get(key);
      return value ? `${key}=${value}` : undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
  const lastReachableAt =
    options.connection === 'reachable' || options.connection === 'connected'
      ? options.checkedAt
      : undefined;
  const lastAuthFailureAt =
    options.auth === 'expired' || options.auth === 'error'
      ? options.checkedAt
      : undefined;
  if (!/json/i.test(contentType)) {
    return buildRuntimeSnapshot({
      server: options.server,
      checkedAt: options.checkedAt,
      auth: options.auth,
      connection: options.connection,
      lastReachableAt,
      lastAuthFailureAt,
      contentType: contentType || undefined,
      serverSignature,
      sampledHeaders: sampledHeaders.length > 0 ? sampledHeaders : undefined,
      notes: [`Non-JSON runtime surface (${contentType || 'unknown content-type'}).`],
    });
  }

  try {
    const payload = selectRuntimePayload(
      (await options.response.clone().json()) as Record<string, unknown>,
    );
    return buildRuntimeSnapshot({
      server: options.server,
      checkedAt: options.checkedAt,
      auth: options.auth,
      connection:
        payload.connected === true ||
        payload.connection === 'connected' ||
        payload.state === 'connected'
          ? 'connected'
          : options.connection,
      toolsCount: pickRuntimeCount(payload, 'tools'),
      resourcesCount: pickRuntimeCount(payload, 'resources'),
      promptsCount: pickRuntimeCount(payload, 'prompts'),
      commandsCount: pickRuntimeCount(payload, 'commands'),
      lastReachableAt,
      lastAuthFailureAt,
      contentType: contentType || undefined,
      serverSignature,
      sampledHeaders: sampledHeaders.length > 0 ? sampledHeaders : undefined,
      toolSample: pickRuntimeSampleNames(payload, 'tools'),
      resourceSample: pickRuntimeSampleNames(payload, 'resources'),
      promptSample: pickRuntimeSampleNames(payload, 'prompts'),
      commandSample: pickRuntimeSampleNames(payload, 'commands'),
      notes: pickRuntimeNotes(payload),
    });
  } catch {
    return buildRuntimeSnapshot({
      server: options.server,
      checkedAt: options.checkedAt,
      auth: options.auth,
      connection: options.connection,
      lastReachableAt,
      lastAuthFailureAt,
      contentType: contentType || undefined,
      serverSignature,
      sampledHeaders: sampledHeaders.length > 0 ? sampledHeaders : undefined,
      notes: [`Unparseable JSON runtime surface (${contentType || 'unknown content-type'}).`],
    });
  }
}

function classifyHttpProbe(options: {
  server: McpServerConfig;
  status: number;
  statusText: string;
  bodySummary?: string;
}): Pick<McpProbeResult, 'ok' | 'message' | 'nextAuthState'> {
  const baseMessage = `HTTP ${options.status} ${options.statusText}`.trim();
  const message = options.bodySummary
    ? `${baseMessage} :: ${options.bodySummary}`
    : baseMessage;

  if (options.bodySummary && /invalid_grant|refresh token|invalid_client|token expired|authorization rejected/i.test(options.bodySummary)) {
    return {
      ok: false,
      message,
      nextAuthState:
        options.server.authType === 'oauth' ? 'expired' : 'error',
    };
  }

  if (options.status >= 200 && options.status < 300) {
    return {
      ok: true,
      message,
      nextAuthState:
        options.server.authType === 'none'
          ? 'configured'
          : options.server.authState === 'unknown'
            ? 'configured'
            : options.server.authState,
    };
  }

  if (options.status === 401 || options.status === 403) {
    return {
      ok: false,
      message,
      nextAuthState:
        options.server.authType === 'oauth' ? 'expired' : 'error',
    };
  }

  if (options.status === 400 || options.status === 405 || options.status === 406) {
    return {
      ok: true,
      message: `${message} (reachable but rejected this probe shape)`,
      nextAuthState:
        options.server.authType === 'none'
          ? 'configured'
          : options.server.authState,
    };
  }

  return {
    ok: false,
    message,
    nextAuthState:
      options.server.authType === 'none' ? 'configured' : options.server.authState,
  };
}

async function probeHttpLikeServer(
  server: McpServerConfig,
  timeoutMs: number,
  cwd: string,
): Promise<McpProbeResult> {
  const checkedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const prepared = await resolveProbeHeaders(cwd, server);
    server = prepared.server;
    const response = await fetch(server.url ?? '', {
      method: 'GET',
      headers: {
        ...(server.transport === 'sse'
          ? { Accept: 'text/event-stream' }
          : { Accept: 'application/json, text/event-stream;q=0.9, */*;q=0.1' }),
        ...prepared.headers,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const bodySummary = normalizeProbeBodySummary(
      await response.clone().text().catch(() => ''),
    );

    const classified = classifyHttpProbe({
      server,
      status: response.status,
      statusText: response.statusText,
      bodySummary,
    });
    if (
      prepared.authMissing &&
      classified.nextAuthState === 'configured'
    ) {
      classified.nextAuthState = server.authState;
    }
    let runtimeSnapshot = await extractHttpRuntimeSnapshot({
      server,
      response,
      checkedAt,
      auth: classified.nextAuthState ?? server.authState,
      connection: classified.ok ? 'reachable' : 'attention',
    });

    if (
      server.transport === 'streamable-http' &&
      classified.ok &&
      runtimeSnapshot.connection !== 'connected'
    ) {
      const rpcDiscovery = await attemptHttpRpcDiscovery({
        server,
        timeoutMs,
      });
      if (rpcDiscovery) {
        runtimeSnapshot = buildRuntimeSnapshot({
          server,
          checkedAt,
          auth: classified.nextAuthState ?? server.authState,
          connection: rpcDiscovery.connected ? 'connected' : runtimeSnapshot.connection,
          toolsCount: rpcDiscovery.toolsCount,
          resourcesCount: rpcDiscovery.resourcesCount,
          promptsCount: rpcDiscovery.promptsCount,
          commandsCount: runtimeSnapshot.commandsCount,
          lastReachableAt: checkedAt,
          contentType: runtimeSnapshot.contentType,
          serverSignature: rpcDiscovery.serverSignature ?? runtimeSnapshot.serverSignature,
          sampledHeaders: rpcDiscovery.sampledHeaders ?? runtimeSnapshot.sampledHeaders,
          toolSample: rpcDiscovery.toolSample,
          resourceSample: rpcDiscovery.resourceSample,
          promptSample: rpcDiscovery.promptSample,
          commandSample: runtimeSnapshot.commandSample,
          notes: rpcDiscovery.notes ?? runtimeSnapshot.notes,
        });
      }
    }

    return {
      id: server.id,
      status: classified.ok ? 'ok' : 'failed',
      checkedAt,
      ok: classified.ok,
      message: classified.message,
      server,
      nextAuthState: classified.nextAuthState,
      runtimeSnapshot,
    };
  } catch (error) {
    clearTimeout(timer);
    const message = error instanceof Error ? error.message : String(error);
    const nextAuthState = getSuggestedMcpAuthState(server, error);
    return {
      id: server.id,
      status: 'failed',
      checkedAt,
      ok: false,
      message: `Probe failed: ${message}`,
      server,
      nextAuthState,
      runtimeSnapshot: buildRuntimeSnapshot({
        server,
        checkedAt,
        auth: nextAuthState,
        connection: 'attention',
        notes: [`Probe failed: ${message}`],
      }),
    };
  }
}

async function probeStdioServer(
  server: McpServerConfig,
  timeoutMs: number,
  cwd: string,
): Promise<McpProbeResult> {
  const checkedAt = now();

  return new Promise<McpProbeResult>((resolve) => {
    const child = spawn(server.command ?? '', server.commandArgs ?? [], {
      cwd: server.workingDirectory ?? cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...(server.environment ?? {}),
      },
    });
    let stderr = '';
    let settled = false;

    const finish = (result: McpProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        id: server.id,
        status: 'ok',
        checkedAt,
        ok: true,
        message: 'Process stayed alive long enough to accept MCP traffic.',
        server,
        nextAuthState:
          server.authType === 'none' ? 'configured' : server.authState,
        runtimeSnapshot: buildRuntimeSnapshot({
          server,
          checkedAt,
          auth:
            server.authType === 'none' ? 'configured' : server.authState,
          connection: 'reachable',
        }),
      });
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        id: server.id,
        status: 'failed',
        checkedAt,
        ok: false,
        message: `Failed to start stdio server: ${error.message}`,
        server,
        nextAuthState: server.authState,
        runtimeSnapshot: buildRuntimeSnapshot({
          server,
          checkedAt,
          auth: server.authState,
          connection: 'attention',
          notes: [`Failed to start stdio server: ${error.message}`],
        }),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const trimmedStderr = stderr.trim();
      if (code === 0) {
        finish({
          id: server.id,
          status: 'failed',
          checkedAt,
          ok: false,
          message: 'Process exited immediately before accepting MCP traffic.',
          server,
          nextAuthState: server.authState,
          runtimeSnapshot: buildRuntimeSnapshot({
            server,
            checkedAt,
            auth: server.authState,
            connection: 'attention',
            notes: ['Process exited immediately before accepting MCP traffic.'],
          }),
        });
        return;
      }

      finish({
        id: server.id,
        status: 'failed',
        checkedAt,
        ok: false,
        message:
          trimmedStderr ||
          `Process exited early with code ${code ?? -1}.`,
        server,
        nextAuthState: server.authState,
        runtimeSnapshot: buildRuntimeSnapshot({
          server,
          checkedAt,
          auth: server.authState,
          connection: 'attention',
          notes: [
            trimmedStderr ||
              `Process exited early with code ${code ?? -1}.`,
          ],
        }),
      });
    });
  });
}

async function probeViaMcpClient(
  server: McpServerConfig,
  timeoutMs: number,
  cwd: string,
): Promise<McpProbeResult> {
  const checkedAt = now();

  try {
    const discovery = await discoverMcpServerSurface({
      server,
      cwd,
      timeoutMs,
      source: 'probe',
    });

    return {
      id: server.id,
      status: 'ok',
      checkedAt,
      ok: true,
      message: 'Discovered MCP runtime surface.',
      server: discovery.server,
      nextAuthState: discovery.authState,
      runtimeSnapshot: buildRuntimeSnapshotFromSurface({
        server,
        authState: discovery.authState,
        surface: discovery.surface,
        checkedAt,
        contentType: discovery.contentType,
        serverSignature: discovery.serverSignature,
        sampledHeaders: discovery.sampledHeaders,
        notes: ['Discovered via MCP initialize plus list methods.'],
      }),
      surface: discovery.surface,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: server.id,
      status: 'failed',
      checkedAt,
      ok: false,
      message,
      server,
      nextAuthState: getSuggestedMcpAuthState(server, error),
    };
  }
}

export async function probeMcpServer(
  server: McpServerConfig,
  timeoutMs = 1_500,
  cwd = process.cwd(),
): Promise<McpProbeResult> {
  if (!server.enabled) {
    return {
      id: server.id,
      status: 'skipped',
      checkedAt: now(),
      ok: false,
      message: 'Probe skipped because the server is disabled.',
      nextAuthState: server.authState,
    };
  }

  if (server.transport === 'stdio') {
    const clientProbe = await probeViaMcpClient(server, timeoutMs, cwd);
    if (clientProbe.ok) {
      return clientProbe;
    }

    const fallback = await probeStdioServer(server, timeoutMs, cwd);
    return {
      ...fallback,
      nextAuthState: clientProbe.nextAuthState ?? fallback.nextAuthState,
      message:
        fallback.ok || !fallback.message
          ? clientProbe.message
          : `${clientProbe.message}\n${fallback.message}`,
      };
  }

  if (server.transport === 'sse') {
    const clientProbe = await probeViaMcpClient(server, timeoutMs, cwd);
    if (clientProbe.ok) {
      return clientProbe;
    }

    const fallback = await probeHttpLikeServer(server, timeoutMs, cwd);
    return {
      ...fallback,
      server: fallback.server ?? server,
      nextAuthState: clientProbe.nextAuthState ?? fallback.nextAuthState,
      message:
        fallback.ok || !fallback.message
          ? clientProbe.message
          : `${clientProbe.message}\n${fallback.message}`,
    };
  }

  return probeHttpLikeServer(server, timeoutMs, cwd);
}

export function applyProbeResult(
  server: McpServerConfig,
  result: McpProbeResult,
): McpServerConfig {
  if (result.status === 'skipped') {
    return server;
  }

  const baseServer = result.server ?? server;
  return {
    ...baseServer,
    authState: result.nextAuthState ?? baseServer.authState,
    lastCheckedAt: result.checkedAt,
    lastError: result.status === 'ok' ? undefined : result.message,
    runtime: result.runtimeSnapshot ?? baseServer.runtime,
    surface: result.surface ?? baseServer.surface,
    updatedAt: result.checkedAt,
  };
}

async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]!();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function probeMcpServers(
  data: McpServerStoreData,
  timeoutMs = 1_500,
  cwd = process.cwd(),
): Promise<{
  data: McpServerStoreData;
  results: McpProbeResult[];
}> {
  const results = await runWithConcurrencyLimit(
    data.servers.map((server) => () => probeMcpServer(server, timeoutMs, cwd)),
    5,
  );
  const resultById = new Map(results.map((result) => [result.id, result]));

  return {
    data: {
      servers: data.servers.map((server) => {
        const result = resultById.get(server.id);
        return result ? applyProbeResult(server, result) : server;
      }),
    },
    results,
  };
}
