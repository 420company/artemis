import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, APP_VERSION } from '../appMeta.js';
import type { SessionMessage } from '../core/types.js';
import type {
  McpAuthState,
  McpCommandDescriptor,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpServerConfig,
  McpServerSurface,
  McpToolDescriptor,
} from './store.js';
import {
  ensureMcpOAuthAccessToken,
  persistMcpServerUpdate,
} from './oauth.js';
import {
  type McpDependencyInfo,
  buildDependencyInfo,
  detectDependencyRequirement,
  isMissingExecutableError,
} from './installer.js';

export class McpDependencyError extends Error {
  readonly server: McpServerConfig;
  readonly dependencyInfo: McpDependencyInfo;

  constructor(server: McpServerConfig, info: McpDependencyInfo) {
    super(`MCP plugin "${server.id}" requires a missing dependency: ${info.installInstructions}`);
    this.name = 'McpDependencyError';
    this.server = server;
    this.dependencyInfo = info;
  }
}

type JsonRecord = Record<string, unknown>;
type SseFrame = {
  event?: string;
  data?: string;
  id?: string;
};

type RpcClientInfo = {
  name?: string;
  version?: string;
};

type McpListChangedKind = 'tools' | 'prompts' | 'resources';

type McpDiscoveryResult = {
  surface: McpServerSurface;
  authState: McpAuthState;
  server: McpServerConfig;
  contentType?: string;
  serverSignature?: string;
  sampledHeaders?: string[];
};

type McpToolCallResult = {
  output: string;
  raw: unknown;
  surface?: McpServerSurface;
  authState: McpAuthState;
  server: McpServerConfig;
};

type McpResourceReadResult = {
  output: string;
  raw: unknown;
  surface?: McpServerSurface;
  authState: McpAuthState;
  server: McpServerConfig;
};

export type McpPromptGetResult = {
  output: string;
  raw: unknown;
  surface?: McpServerSurface;
  authState: McpAuthState;
  server: McpServerConfig;
};

type RpcTransport = {
  initialize(): Promise<RpcClientInfo>;
  listTools(): Promise<McpToolDescriptor[]>;
  listResources(): Promise<McpResourceDescriptor[]>;
  listPrompts(): Promise<McpPromptDescriptor[]>;
  listCommands(): Promise<McpCommandDescriptor[]>;
  setListChangedHandler?(
    handler?: (kind: McpListChangedKind) => void,
  ): void;
  callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
  getPrompt(
    promptName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  close(): Promise<void>;
  getServerConfig(): McpServerConfig;
  getTransportSummary(): {
    contentType?: string;
    serverSignature?: string;
    sampledHeaders?: string[];
  };
};

// CLI root: src/mcp/client.ts compiles to dist/mcp/client.js, so ../../ = project root
const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PLUGINS_DIR = path.join(CLI_ROOT, 'plugins');
// Prefer the user-data install (~/.artemis/mcp-packages) so MCP node_modules survives
// `npm install -g artemis-code` reinstalls. Falls back to the bundled dir otherwise.
const USER_MCP_PACKAGES_DIR = path.join(os.homedir(), '.artemis', 'mcp-packages');
const BUNDLED_MCP_PACKAGES_DIR = path.join(CLI_ROOT, 'mcp-packages');
const CLI_MCP_PACKAGES_DIR = existsSync(path.join(USER_MCP_PACKAGES_DIR, 'node_modules'))
  ? USER_MCP_PACKAGES_DIR
  : BUNDLED_MCP_PACKAGES_DIR;

const DEFAULT_TIMEOUT_MS = 4_000;
const CLIENT_PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = {
  name: APP_NAME,
  version: APP_VERSION,
};
const MCP_CLIENT_CACHE = new Map<string, RpcTransport>();
const MCP_MANAGED_SURFACE_CACHE = new Map<
  string,
  {
    result: McpDiscoveryResult;
    cachedAt: number;
  }
>();
let exitHookRegistered = false;
const MANAGED_SURFACE_CACHE_TTL_MS = 30_000;

function now(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalCollapsedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
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

function resolveStaticServerHeaders(server: McpServerConfig): Record<string, string> {
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
      if (isRecord(parsed)) {
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

  return headers;
}

async function resolveServerHeaders(
  cwd: string,
  server: McpServerConfig,
): Promise<{
  server: McpServerConfig;
  headers: Record<string, string>;
}> {
  const headers = resolveStaticServerHeaders(server);
  if (server.authType !== 'oauth') {
    return {
      server,
      headers,
    };
  }

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
}

function deriveAuthStateFromError(
  server: McpServerConfig,
  message: string,
): McpAuthState {
  if (/invalid_grant|refresh token|token expired/i.test(message)) {
    return server.authType === 'oauth' ? 'expired' : 'error';
  }

  if (/401|403|unauthorized|forbidden|authorization rejected|invalid_client/i.test(message)) {
    return server.authType === 'oauth' ? 'expired' : 'error';
  }

  return server.authType === 'none' ? 'configured' : server.authState;
}

function isMcpSessionExpiryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /HTTP 404/i.test(message) &&
    (/session not found/i.test(message) ||
      /-32001/.test(message) ||
      /mcp-session-id/i.test(message))
  );
}

function extractText(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractText(entry));
  }

  if (!isRecord(value)) {
    return [];
  }

  const parts: string[] = [];
  for (const key of [
    'text',
    'message',
    'content',
    'output_text',
    'description',
    'title',
    'uri',
  ]) {
    const entry = value[key];
    if (typeof entry === 'string' && entry.trim()) {
      parts.push(entry.trim());
    }
  }

  if (value.contents) {
    parts.push(...extractText(value.contents));
  }
  if (value.content) {
    parts.push(...extractText(value.content));
  }
  if (value.structuredContent) {
    parts.push(...extractText(value.structuredContent));
  }

  return parts;
}

function serializeResult(value: unknown): string {
  const text = [...new Set(extractText(value))].filter(Boolean).join('\n').trim();
  if (text) {
    return text;
  }

  return JSON.stringify(value, null, 2);
}

function serializePromptContent(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((entry) => serializePromptContent(entry))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (!isRecord(value)) {
    return typeof value === 'string' ? value : serializeResult(value);
  }

  if (value.type === 'text' && typeof value.text === 'string') {
    return value.text.trim();
  }

  if (value.type === 'image') {
    const mimeType =
      typeof value.mimeType === 'string' && value.mimeType.trim()
        ? value.mimeType.trim()
        : 'unknown';
    return `[image content ${mimeType}]`;
  }

  if (value.type === 'audio') {
    const mimeType =
      typeof value.mimeType === 'string' && value.mimeType.trim()
        ? value.mimeType.trim()
        : 'unknown';
    return `[audio content ${mimeType}]`;
  }

  if (
    value.type === 'resource' ||
    value.type === 'resource_link' ||
    value.type === 'resourceLink'
  ) {
    const uri =
      typeof value.uri === 'string' && value.uri.trim()
        ? value.uri.trim()
        : typeof value.name === 'string' && value.name.trim()
          ? value.name.trim()
          : 'resource';
    return `[resource ${uri}]`;
  }

  return serializeResult(value);
}

function serializePromptResult(
  promptName: string,
  value: unknown,
): string {
  if (!isRecord(value)) {
    return serializeResult(value);
  }

  const lines: string[] = [];
  const description =
    typeof value.description === 'string' && value.description.trim()
      ? value.description.trim()
      : undefined;
  if (description) {
    lines.push(`Prompt description: ${description}`);
  }

  const messages = Array.isArray(value.messages) ? value.messages : [];
  if (messages.length === 0) {
    return lines.length > 0 ? lines.join('\n') : serializeResult(value);
  }

  lines.push(`Prompt messages for ${promptName}:`);
  for (const message of messages) {
    if (!isRecord(message)) {
      lines.push('[unknown]');
      lines.push(serializePromptContent(message) || '(empty)');
      continue;
    }

    const role =
      typeof message.role === 'string' && message.role.trim()
        ? message.role.trim()
        : 'unknown';
    lines.push(`[${role}]`);
    lines.push(serializePromptContent(message.content) || '(empty)');
  }

  return lines.join('\n');
}

function normalizeToolDescriptor(value: unknown): McpToolDescriptor | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) {
    return null;
  }

  const annotations = isRecord(value.annotations) ? value.annotations : undefined;
  const meta = isRecord(value._meta) ? value._meta : undefined;
  const readOnly =
    typeof value.readOnly === 'boolean'
      ? value.readOnly
      : typeof annotations?.readOnlyHint === 'boolean'
        ? annotations.readOnlyHint
        : typeof annotations?.destructiveHint === 'boolean'
          ? annotations.destructiveHint === true
            ? false
            : undefined
          : undefined;

  return {
    name: value.name.trim(),
    title: normalizeOptionalCollapsedString(annotations?.title),
    description:
      typeof value.description === 'string' && value.description.trim()
        ? value.description.trim()
        : undefined,
    searchHint: normalizeOptionalCollapsedString(
      meta?.['anthropic/searchHint'],
    ),
    alwaysLoad: meta?.['anthropic/alwaysLoad'] === true ? true : undefined,
    inputSchema: isRecord(value.inputSchema)
      ? (value.inputSchema as Record<string, unknown>)
      : undefined,
    readOnly,
    destructive:
      typeof annotations?.destructiveHint === 'boolean'
        ? annotations.destructiveHint
        : undefined,
    openWorld:
      typeof annotations?.openWorldHint === 'boolean'
        ? annotations.openWorldHint
        : undefined,
  };
}

function normalizeResourceDescriptor(value: unknown): McpResourceDescriptor | null {
  if (!isRecord(value) || typeof value.uri !== 'string' || !value.uri.trim()) {
    return null;
  }

  return {
    uri: value.uri.trim(),
    name:
      typeof value.name === 'string' && value.name.trim()
        ? value.name.trim()
        : undefined,
    description:
      typeof value.description === 'string' && value.description.trim()
        ? value.description.trim()
        : undefined,
    mimeType:
      typeof value.mimeType === 'string' && value.mimeType.trim()
        ? value.mimeType.trim()
        : undefined,
  };
}

function normalizePromptDescriptor(value: unknown): McpPromptDescriptor | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) {
    return null;
  }

  const args = Array.isArray(value.arguments)
    ? value.arguments
        .map((entry) => normalizePromptArgumentDescriptor(entry))
        .filter(
          (
            entry,
          ): entry is NonNullable<ReturnType<typeof normalizePromptArgumentDescriptor>> => entry !== null,
        )
    : [];
  return {
    name: value.name.trim(),
    title:
      typeof value.title === 'string' && value.title.trim()
        ? value.title.trim()
        : undefined,
    description:
      typeof value.description === 'string' && value.description.trim()
        ? value.description.trim()
        : undefined,
    arguments: args.length > 0 ? args : undefined,
  };
}

function normalizePromptArgumentDescriptor(
  value: unknown,
): { name: string; description?: string; required?: boolean } | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) {
    return null;
  }

  return {
    name: value.name.trim(),
    ...(typeof value.description === 'string' && value.description.trim()
      ? { description: value.description.trim() }
      : {}),
    ...(typeof value.required === 'boolean'
      ? { required: value.required }
      : {}),
  };
}

function normalizeCommandDescriptor(value: unknown): McpCommandDescriptor | null {
  if (!isRecord(value)) {
    return null;
  }

  const name =
    typeof value.name === 'string' && value.name.trim()
      ? value.name.trim()
      : typeof value.title === 'string' && value.title.trim()
        ? value.title.trim()
        : undefined;
  if (!name) {
    return null;
  }

  return {
    name,
    title:
      typeof value.title === 'string' && value.title.trim()
        ? value.title.trim()
        : undefined,
    description:
      typeof value.description === 'string' && value.description.trim()
        ? value.description.trim()
        : undefined,
  };
}

function readArray<T>(
  value: unknown,
  normalizeEntry: (entry: unknown) => T | null,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is T => entry !== null);
}

function buildServerSurface(options: {
  source: 'probe' | 'client';
  clientInfo?: RpcClientInfo;
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  prompts: McpPromptDescriptor[];
  commands?: McpCommandDescriptor[];
}): McpServerSurface {
  return {
    discoveredAt: now(),
    source: options.source,
    serverName: options.clientInfo?.name,
    serverVersion: options.clientInfo?.version,
    tools: options.tools,
    resources: options.resources,
    prompts: options.prompts,
    commands: options.commands ?? [],
  };
}

function parseRpcResponse(payload: unknown, method: string): JsonRecord {
  if (!isRecord(payload)) {
    throw new Error(`MCP ${method} returned a non-object response.`);
  }

  if (payload.error) {
    const error = isRecord(payload.error) ? payload.error : {};
    const message =
      typeof error.message === 'string' && error.message.trim()
        ? error.message.trim()
        : `MCP ${method} returned an error response.`;
    throw new Error(message);
  }

  if (!isRecord(payload.result)) {
    return payload;
  }

  return payload.result;
}

function getListChangedKindFromMethod(
  method: unknown,
): McpListChangedKind | undefined {
  if (typeof method !== 'string') {
    return undefined;
  }

  const normalized = method.trim().toLowerCase();
  if (
    normalized === 'notifications/tools/list_changed' ||
    normalized === 'tools/list_changed'
  ) {
    return 'tools';
  }
  if (
    normalized === 'notifications/prompts/list_changed' ||
    normalized === 'prompts/list_changed'
  ) {
    return 'prompts';
  }
  if (
    normalized === 'notifications/resources/list_changed' ||
    normalized === 'resources/list_changed'
  ) {
    return 'resources';
  }

  return undefined;
}

function parseSseFrames(buffer: string): {
  frames: SseFrame[];
  remaining: string;
} {
  const frames: SseFrame[] = [];
  let remaining = buffer;

  for (;;) {
    const match = remaining.match(/\r\n\r\n|\n\n|\r\r/u);
    if (!match || match.index === undefined) {
      break;
    }

    const boundary = match.index;
    const separator = match[0];
    const rawFrame = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + separator.length);

    const lines = rawFrame.split(/\r\n|\n|\r/u);
    let event: string | undefined;
    let id: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) {
        continue;
      }

      const separatorIndex = line.indexOf(':');
      const field =
        separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
      const rawValue =
        separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
      const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        dataLines.push(value);
      } else if (field === 'id') {
        id = value;
      }
    }

    frames.push({
      event,
      id,
      data: dataLines.length > 0 ? dataLines.join('\n') : undefined,
    });
  }

  return {
    frames,
    remaining,
  };
}

function pickJsonRpcResponseForId(
  payload: unknown,
  requestId: string,
): JsonRecord | undefined {
  const entries = Array.isArray(payload) ? payload : [payload];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.id === undefined) {
      continue;
    }
    if (String(entry.id) === requestId) {
      return entry;
    }
  }

  return undefined;
}

async function readJsonRpcResponseFromSse(options: {
  body: ReadableStream<Uint8Array>;
  requestId: string;
  method: string;
}): Promise<JsonRecord> {
  const reader = options.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseFrames(buffer);
      buffer = parsed.remaining;

      for (const frame of parsed.frames) {
        if (!frame.data) {
          continue;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(frame.data) as unknown;
        } catch {
          continue;
        }

        const response = pickJsonRpcResponseForId(payload, options.requestId);
        if (response) {
          await reader.cancel().catch(() => undefined);
          return parseRpcResponse(response, options.method);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error(
    `SSE response for MCP ${options.method} ended before JSON-RPC response ${options.requestId} arrived.`,
  );
}

function buildRpcRequest(id: number, method: string, params: object = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params,
  });
}

function buildRpcNotification(method: string, params: object = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
  });
}

async function postHttpRpc(options: {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    return await fetch(options.url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream;q=0.9, */*;q=0.1',
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: options.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function readTransportSummaryFromResponse(response: Response): {
  contentType?: string;
  serverSignature?: string;
  sampledHeaders?: string[];
  sessionId?: string;
} {
  const sampledHeaders = ['server', 'x-powered-by', 'mcp-session-id']
    .map((key) => {
      const value = response.headers.get(key);
      return value ? `${key}=${value}` : undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
  return {
    contentType: response.headers.get('content-type') ?? undefined,
    serverSignature:
      response.headers.get('server') ??
      response.headers.get('x-powered-by') ??
      undefined,
    sampledHeaders: sampledHeaders.length > 0 ? sampledHeaders : undefined,
    sessionId: response.headers.get('mcp-session-id') ?? undefined,
  };
}

class HttpRpcTransport implements RpcTransport {
  private server: McpServerConfig;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private initialized = false;
  private sessionId?: string;
  private requestId = 0;
  private clientInfo?: RpcClientInfo;
  private contentType?: string;
  private serverSignature?: string;
  private sampledHeaders?: string[];

  constructor(server: McpServerConfig, cwd: string, timeoutMs: number) {
    this.server = server;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
  }

  private async send(
    method: string,
    params: object = {},
    expectResponse = true,
  ): Promise<JsonRecord> {
    const body = expectResponse
      ? buildRpcRequest(++this.requestId, method, params)
      : buildRpcNotification(method, params);
    const auth = await resolveServerHeaders(this.cwd, this.server);
    this.server = auth.server;
    const response = await postHttpRpc({
      url: this.server.url ?? '',
      body,
      headers: this.sessionId
        ? { ...auth.headers, 'mcp-session-id': this.sessionId }
        : auth.headers,
      timeoutMs: this.timeoutMs,
    });

    const summary = readTransportSummaryFromResponse(response);
    this.contentType = summary.contentType ?? this.contentType;
    this.serverSignature = summary.serverSignature ?? this.serverSignature;
    this.sampledHeaders = summary.sampledHeaders ?? this.sampledHeaders;
    this.sessionId = summary.sessionId ?? this.sessionId;

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `HTTP ${response.status} ${response.statusText}${bodyText.trim() ? ` :: ${bodyText.trim()}` : ''}`,
      );
    }

    if (!expectResponse) {
      return {};
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (/text\/event-stream/i.test(contentType)) {
      if (!response.body) {
        throw new Error(
          `SSE response for MCP ${method} did not include a readable body.`,
        );
      }
      return readJsonRpcResponseFromSse({
        body: response.body,
        requestId: String(this.requestId),
        method,
      });
    }

    const payload = (await response.json().catch(() => null)) as unknown;
    return parseRpcResponse(payload, method);
  }

  async initialize(): Promise<RpcClientInfo> {
    if (this.initialized && this.clientInfo) {
      return this.clientInfo;
    }

    const result = await this.send('initialize', {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      clientInfo: CLIENT_INFO,
      capabilities: {},
    });
    this.clientInfo = isRecord(result.serverInfo)
      ? {
          name:
            typeof result.serverInfo.name === 'string'
              ? result.serverInfo.name
              : undefined,
          version:
            typeof result.serverInfo.version === 'string'
              ? result.serverInfo.version
              : undefined,
        }
      : undefined;
    await this.send('notifications/initialized', {}, false);
    this.initialized = true;
    return this.clientInfo ?? {};
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.initialize();
    const result = await this.send('tools/list');
    return readArray(result.tools, normalizeToolDescriptor);
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    await this.initialize();
    const result = await this.send('resources/list');
    return readArray(result.resources, normalizeResourceDescriptor);
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    await this.initialize();
    const result = await this.send('prompts/list');
    return readArray(result.prompts, normalizePromptDescriptor);
  }

  async listCommands(): Promise<McpCommandDescriptor[]> {
    await this.initialize();
    const result = (await this.send('commands/list').catch(
      () => ({}) as JsonRecord,
    )) as JsonRecord;
    return readArray(result.commands, normalizeCommandDescriptor);
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.initialize();
    return await this.send('tools/call', {
      name: toolName,
      arguments: args,
    });
  }

  async readResource(uri: string): Promise<unknown> {
    await this.initialize();
    return await this.send('resources/read', { uri });
  }

  async getPrompt(
    promptName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.initialize();
    return await this.send('prompts/get', {
      name: promptName,
      arguments: args,
    });
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  setListChangedHandler(): void {}

  getServerConfig(): McpServerConfig {
    return this.server;
  }

  getTransportSummary(): {
    contentType?: string;
    serverSignature?: string;
    sampledHeaders?: string[];
  } {
    return {
      contentType: this.contentType,
      serverSignature: this.serverSignature,
      sampledHeaders: this.sampledHeaders,
    };
  }
}

class SseRpcTransport implements RpcTransport {
  private server: McpServerConfig;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private initialized = false;
  private requestId = 0;
  private clientInfo?: RpcClientInfo;
  private postUrl?: string;
  private sessionId?: string;
  private contentType?: string;
  private serverSignature?: string;
  private sampledHeaders?: string[];
  private connectPromise?: Promise<void>;
  private streamAbortController?: AbortController;
  private streamReaderPromise?: Promise<void>;
  private closing = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private reconnectTimer?: NodeJS.Timeout;
  private listChangedHandler?: (kind: McpListChangedKind) => void;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: JsonRecord) => void;
      reject: (error: Error) => void;
      method: string;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(server: McpServerConfig, cwd: string, timeoutMs: number) {
    this.server = server;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectPendingRequest(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(error);
  }

  private resolvePendingWithParsedResult(
    requestId: string,
    result: JsonRecord,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(result);
  }

  private resolvePendingFromRpcPayload(
    requestId: string,
    payload: unknown,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    try {
      pending.resolve(parseRpcResponse(payload, pending.method));
    } catch (error) {
      pending.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private handleSsePayload(payload: unknown): void {
    const entries = Array.isArray(payload) ? payload : [payload];
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }

      const listChangedKind = getListChangedKindFromMethod(entry.method);
      if (listChangedKind) {
        this.listChangedHandler?.(listChangedKind);
      }

      if (entry.id === undefined) {
        continue;
      }

      this.resolvePendingFromRpcPayload(String(entry.id), entry);
    }
  }

  private resetStreamState(preserveSessionId?: string): void {
    this.postUrl = undefined;
    this.sessionId = preserveSessionId;
    this.initialized = false;
    this.clientInfo = undefined;
    this.connectPromise = undefined;
    this.streamAbortController = undefined;
    this.streamReaderPromise = undefined;
  }

  private scheduleReconnect(savedSessionId: string | undefined): void {
    if (this.closing || this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }
    const delayMs = 1_000 * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closing) {
        return;
      }
      // Restore session ID so the server can resume the existing session.
      this.sessionId = savedSessionId;
      this.connectPromise = this.openStream().then(
        () => {
          this.reconnectAttempts = 0;
          this.connectPromise = undefined;
        },
        (error: Error) => {
          this.connectPromise = undefined;
          this.resetStreamState(this.sessionId);
          this.scheduleReconnect(this.sessionId);
          // If all reconnect attempts exhausted, reject any newly queued requests
          if (this.reconnectAttempts > this.maxReconnectAttempts) {
            this.rejectPending(error);
          }
        },
      );
    }, delayMs);
  }

  private handleStreamClosed(error: Error): void {
    const savedSessionId = this.sessionId;
    this.resetStreamState();
    if (this.closing) {
      return;
    }
    this.rejectPending(error);
    this.scheduleReconnect(savedSessionId);
  }

  private async openStream(): Promise<void> {
    const auth = await resolveServerHeaders(this.cwd, this.server);
    this.server = auth.server;

    const controller = new AbortController();
    let connectTimer: NodeJS.Timeout | undefined;

    const response = await new Promise<Response>((resolve, reject) => {
      connectTimer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `SSE MCP connect timed out after ${this.timeoutMs}ms.`,
          ),
        );
      }, this.timeoutMs);

      void fetch(this.server.url ?? '', {
        method: 'GET',
        headers: this.sessionId
          ? {
              Accept: 'text/event-stream',
              ...auth.headers,
              'mcp-session-id': this.sessionId,
            }
          : {
              Accept: 'text/event-stream',
              ...auth.headers,
            },
        signal: controller.signal,
      }).then(
        (value) => {
          clearTimeout(connectTimer);
          resolve(value);
        },
        (error) => {
          clearTimeout(connectTimer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });

    const summary = readTransportSummaryFromResponse(response);
    this.contentType = summary.contentType ?? this.contentType;
    this.serverSignature = summary.serverSignature ?? this.serverSignature;
    this.sampledHeaders = summary.sampledHeaders ?? this.sampledHeaders;
    this.sessionId = summary.sessionId ?? this.sessionId;

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `HTTP ${response.status} ${response.statusText}${bodyText.trim() ? ` :: ${bodyText.trim()}` : ''}`,
      );
    }

    if (!/text\/event-stream/i.test(this.contentType ?? '')) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `Legacy SSE MCP endpoint did not return text/event-stream${bodyText.trim() ? ` :: ${bodyText.trim()}` : ''}`,
      );
    }

    if (!response.body) {
      throw new Error('Legacy SSE MCP endpoint did not include a readable event stream.');
    }

    this.streamAbortController = controller;

    let endpointSettled = false;
    let resolveEndpoint!: () => void;
    let rejectEndpoint!: (error: Error) => void;
    const endpointReady = new Promise<void>((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const streamReaderPromise = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseFrames(buffer);
          buffer = parsed.remaining;

          for (const frame of parsed.frames) {
            const eventType =
              typeof frame.event === 'string' && frame.event.trim()
                ? frame.event.trim()
                : 'message';
            if (eventType === 'endpoint') {
              if (typeof frame.data === 'string' && frame.data.trim()) {
                this.postUrl = new URL(
                  frame.data.trim(),
                  this.server.url ?? '',
                ).toString();
                if (!endpointSettled) {
                  endpointSettled = true;
                  resolveEndpoint();
                }
              }
              continue;
            }

            if (!frame.data) {
              continue;
            }

            try {
              this.handleSsePayload(JSON.parse(frame.data) as unknown);
            } catch {
              // Ignore non-JSON SSE data from legacy transports and keep the stream alive.
            }
          }
        }

        if (!endpointSettled) {
          endpointSettled = true;
          rejectEndpoint(
            new Error(
              'Legacy SSE MCP stream closed before advertising an endpoint event.',
            ),
          );
        }
        this.handleStreamClosed(new Error('Legacy SSE MCP stream closed.'));
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        if (!endpointSettled) {
          endpointSettled = true;
          rejectEndpoint(normalized);
        }
        if (!(this.closing && normalized.name === 'AbortError')) {
          this.handleStreamClosed(
            normalized.name === 'AbortError'
              ? new Error('Legacy SSE MCP stream aborted.')
              : normalized,
          );
        } else {
          this.resetStreamState();
        }
      } finally {
        reader.releaseLock();
      }
    })();

    this.streamReaderPromise = streamReaderPromise;
    await endpointReady;
  }

  private async ensureConnection(): Promise<void> {
    if (this.postUrl && this.streamReaderPromise) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.openStream();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async send(
    method: string,
    params: object = {},
    expectResponse = true,
  ): Promise<JsonRecord> {
    await this.ensureConnection();
    if (!this.postUrl) {
      throw new Error('Legacy SSE MCP endpoint is unavailable.');
    }

    const requestId = String(++this.requestId);
    const body = expectResponse
      ? buildRpcRequest(Number(requestId), method, params)
      : buildRpcNotification(method, params);
    const auth = await resolveServerHeaders(this.cwd, this.server);
    this.server = auth.server;

    let pendingPromise: Promise<JsonRecord> | undefined;
    if (expectResponse) {
      pendingPromise = new Promise<JsonRecord>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(
            new Error(`sse MCP ${method} timed out after ${this.timeoutMs}ms.`),
          );
        }, this.timeoutMs);

        this.pending.set(requestId, {
          resolve,
          reject,
          method,
          timer,
        });
      });
    }

    try {
      const response = await postHttpRpc({
        url: this.postUrl,
        body,
        headers: this.sessionId
          ? { ...auth.headers, 'mcp-session-id': this.sessionId }
          : auth.headers,
        timeoutMs: this.timeoutMs,
      });
      const summary = readTransportSummaryFromResponse(response);
      this.contentType = summary.contentType ?? this.contentType;
      this.serverSignature = summary.serverSignature ?? this.serverSignature;
      this.sampledHeaders = summary.sampledHeaders ?? this.sampledHeaders;
      this.sessionId = summary.sessionId ?? this.sessionId;

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(
          `HTTP ${response.status} ${response.statusText}${bodyText.trim() ? ` :: ${bodyText.trim()}` : ''}`,
        );
      }

      if (!expectResponse) {
        return {};
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (/json/i.test(contentType)) {
        const payload = (await response.json().catch(() => null)) as unknown;
        try {
          this.resolvePendingWithParsedResult(
            requestId,
            parseRpcResponse(payload, method),
          );
        } catch (error) {
          this.rejectPendingRequest(
            requestId,
            error instanceof Error ? error : new Error(String(error)),
          );
          throw error;
        }
        return pendingPromise ?? {};
      }

      if (/text\/event-stream/i.test(contentType)) {
        if (!response.body) {
          this.rejectPendingRequest(
            requestId,
            new Error(
              `SSE response for MCP ${method} did not include a readable body.`,
            ),
          );
          throw new Error(
            `SSE response for MCP ${method} did not include a readable body.`,
          );
        }

        try {
          this.resolvePendingWithParsedResult(
            requestId,
            await readJsonRpcResponseFromSse({
              body: response.body,
              requestId,
              method,
            }),
          );
        } catch (error) {
          this.rejectPendingRequest(
            requestId,
            error instanceof Error ? error : new Error(String(error)),
          );
          throw error;
        }
        return pendingPromise ?? {};
      }

      response.body?.cancel().catch(() => undefined);
      return (await pendingPromise) ?? {};
    } catch (error) {
      if (expectResponse) {
        this.rejectPendingRequest(
          requestId,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      throw error;
    }
  }

  async initialize(): Promise<RpcClientInfo> {
    if (this.initialized && this.clientInfo) {
      return this.clientInfo;
    }

    const result = await this.send('initialize', {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      clientInfo: CLIENT_INFO,
      capabilities: {},
    });
    this.clientInfo = isRecord(result.serverInfo)
      ? {
          name:
            typeof result.serverInfo.name === 'string'
              ? result.serverInfo.name
              : undefined,
          version:
            typeof result.serverInfo.version === 'string'
              ? result.serverInfo.version
              : undefined,
        }
      : undefined;
    await this.send('notifications/initialized', {}, false);
    this.initialized = true;
    return this.clientInfo ?? {};
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.initialize();
    const result = await this.send('tools/list');
    return readArray(result.tools, normalizeToolDescriptor);
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    await this.initialize();
    const result = await this.send('resources/list');
    return readArray(result.resources, normalizeResourceDescriptor);
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    await this.initialize();
    const result = await this.send('prompts/list');
    return readArray(result.prompts, normalizePromptDescriptor);
  }

  async listCommands(): Promise<McpCommandDescriptor[]> {
    await this.initialize();
    const result = (await this.send('commands/list').catch(
      () => ({}) as JsonRecord,
    )) as JsonRecord;
    return readArray(result.commands, normalizeCommandDescriptor);
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.initialize();
    return await this.send('tools/call', {
      name: toolName,
      arguments: args,
    });
  }

  async readResource(uri: string): Promise<unknown> {
    await this.initialize();
    return await this.send('resources/read', { uri });
  }

  async getPrompt(
    promptName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.initialize();
    return await this.send('prompts/get', {
      name: promptName,
      arguments: args,
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectPending(new Error('sse MCP client closed.'));

    const abortController = this.streamAbortController;
    const streamReaderPromise = this.streamReaderPromise;
    this.streamAbortController = undefined;
    this.streamReaderPromise = undefined;
    abortController?.abort();
    await streamReaderPromise?.catch(() => undefined);
    await this.connectPromise?.catch(() => undefined);

    this.resetStreamState();
    this.reconnectAttempts = 0;
    this.closing = false;
  }

  setListChangedHandler(
    handler?: (kind: McpListChangedKind) => void,
  ): void {
    this.listChangedHandler = handler;
  }

  getServerConfig(): McpServerConfig {
    return this.server;
  }

  getTransportSummary(): {
    contentType?: string;
    serverSignature?: string;
    sampledHeaders?: string[];
  } {
    return {
      contentType: this.contentType,
      serverSignature: this.serverSignature,
      sampledHeaders: this.sampledHeaders,
    };
  }
}

class StdioRpcTransport implements RpcTransport {
  private readonly server: McpServerConfig;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private child?: ChildProcessWithoutNullStreams;
  private initialized = false;
  private requestId = 0;
  private buffer = Buffer.alloc(0);
  private static readonly MAX_BUFFER_BYTES = 64 * 1024 * 1024; // 64 MB hard cap
  private readonly pending = new Map<
    number,
    {
      resolve: (value: JsonRecord) => void;
      reject: (error: Error) => void;
      method: string;
      timer: NodeJS.Timeout;
    }
  >();
  private stderr = '';
  private clientInfo?: RpcClientInfo;
  private listChangedHandler?: (kind: McpListChangedKind) => void;

  constructor(server: McpServerConfig, cwd: string, timeoutMs: number) {
    this.server = server;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
  }

  private resolveArg(value: string): string {
    if (value.includes('${CLAUDE_PLUGIN_ROOT}')) {
      const pluginRoot = path.join(CLI_PLUGINS_DIR, this.server.id);
      value = value.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot);
    }
    if (value.includes('${ARTEMIS_MCP_PACKAGES}')) {
      value = value.split('${ARTEMIS_MCP_PACKAGES}').join(CLI_MCP_PACKAGES_DIR);
    }
    return value;
  }

  private ensureProcess(): void {
    if (this.child) {
      return;
    }

    const resolvedCommand = this.resolveArg(this.server.command ?? '');
    let resolvedArgs = (this.server.commandArgs ?? []).map((a) => this.resolveArg(a));

    // Auto-inject --prefix so npx uses locally bundled packages when available
    if (path.basename(resolvedCommand) === 'npx' && !resolvedArgs.includes('--prefix')) {
      resolvedArgs = ['--prefix', CLI_MCP_PACKAGES_DIR, ...resolvedArgs];
    }

    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd: this.server.workingDirectory ?? this.cwd,
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...(this.server.environment ?? {}),
      },
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > StdioRpcTransport.MAX_BUFFER_BYTES) {
        this.rejectPending(new Error(
          `stdio MCP server output exceeded ${StdioRpcTransport.MAX_BUFFER_BYTES / (1024 * 1024)} MB buffer limit.`,
        ));
        this.buffer = Buffer.alloc(0);
        return;
      }
      this.drainFrames();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += String(chunk);
    });
    child.on('error', (error) => {
      this.rejectPending(
        new Error(`Failed to start stdio server: ${error.message}`),
      );
    });
    child.on('close', (code) => {
      const message =
        this.stderr.trim() ||
        `stdio server exited${typeof code === 'number' ? ` with code ${code}` : ''}.`;
      this.rejectPending(new Error(message));
      this.child = undefined;
      this.initialized = false;
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private drainFrames(): void {
    while (this.buffer.length > 0) {
      const separatorIndex = this.buffer.indexOf('\r\n\r\n');
      if (separatorIndex < 0) {
        return;
      }

      const headerText = this.buffer
        .subarray(0, separatorIndex)
        .toString('utf8');
      const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        this.rejectPending(
          new Error('stdio server returned a frame without Content-Length.'),
        );
        this.buffer = Buffer.alloc(0);
        return;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1] ?? '', 10);
      const bodyStart = separatorIndex + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.subarray(bodyEnd);

      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch (error) {
        this.rejectPending(
          new Error(
            `stdio server returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        continue;
      }

      if (!isRecord(payload)) {
        continue;
      }

      const listChangedKind = getListChangedKindFromMethod(payload.method);
      if (listChangedKind) {
        this.listChangedHandler?.(listChangedKind);
        continue;
      }

      if (typeof payload.id !== 'number') {
        continue;
      }

      const pending = this.pending.get(payload.id);
      if (!pending) {
        continue;
      }

      clearTimeout(pending.timer);
      this.pending.delete(payload.id);
      try {
        pending.resolve(parseRpcResponse(payload, pending.method));
      } catch (error) {
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private async send(
    method: string,
    params: object = {},
    expectResponse = true,
  ): Promise<JsonRecord> {
    this.ensureProcess();
    const child = this.child;
    if (!child) {
      throw new Error('stdio transport is unavailable.');
    }

    const body = expectResponse
      ? buildRpcRequest(++this.requestId, method, params)
      : buildRpcNotification(method, params);
    const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;

    if (!expectResponse) {
      child.stdin.write(frame, 'utf8');
      return {};
    }

    return new Promise<JsonRecord>((resolve, reject) => {
      const id = this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`stdio MCP ${method} timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        method,
        timer,
      });
      child.stdin.write(frame, 'utf8');
    });
  }

  async initialize(): Promise<RpcClientInfo> {
    if (this.initialized && this.clientInfo) {
      return this.clientInfo;
    }

    const result = await this.send('initialize', {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      clientInfo: CLIENT_INFO,
      capabilities: {},
    });
    this.clientInfo = isRecord(result.serverInfo)
      ? {
          name:
            typeof result.serverInfo.name === 'string'
              ? result.serverInfo.name
              : undefined,
          version:
            typeof result.serverInfo.version === 'string'
              ? result.serverInfo.version
              : undefined,
        }
      : undefined;
    await this.send('notifications/initialized', {}, false);
    this.initialized = true;
    return this.clientInfo ?? {};
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.initialize();
    const result = await this.send('tools/list');
    return readArray(result.tools, normalizeToolDescriptor);
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    await this.initialize();
    const result = await this.send('resources/list');
    return readArray(result.resources, normalizeResourceDescriptor);
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    await this.initialize();
    const result = await this.send('prompts/list');
    return readArray(result.prompts, normalizePromptDescriptor);
  }

  async listCommands(): Promise<McpCommandDescriptor[]> {
    await this.initialize();
    const result = (await this.send('commands/list').catch(
      () => ({}) as JsonRecord,
    )) as JsonRecord;
    return readArray(result.commands, normalizeCommandDescriptor);
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.initialize();
    return await this.send('tools/call', {
      name: toolName,
      arguments: args,
    });
  }

  async readResource(uri: string): Promise<unknown> {
    await this.initialize();
    return await this.send('resources/read', { uri });
  }

  async getPrompt(
    promptName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.initialize();
    return await this.send('prompts/get', {
      name: promptName,
      arguments: args,
    });
  }

  async close(): Promise<void> {
    this.rejectPending(new Error('stdio MCP client closed.'));
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
    this.initialized = false;
  }

  setListChangedHandler(
    handler?: (kind: McpListChangedKind) => void,
  ): void {
    this.listChangedHandler = handler;
  }

  getServerConfig(): McpServerConfig {
    return this.server;
  }

  getTransportSummary(): {
    contentType?: string;
    serverSignature?: string;
    sampledHeaders?: string[];
  } {
    return {};
  }
}

function createRpcTransport(
  server: McpServerConfig,
  cwd: string,
  timeoutMs: number,
): RpcTransport {
  if (server.transport === 'stdio') {
    return new StdioRpcTransport(server, cwd, timeoutMs);
  }

  if (server.transport === 'sse') {
    return new SseRpcTransport(server, cwd, timeoutMs);
  }

  return new HttpRpcTransport(server, cwd, timeoutMs);
}

async function withEphemeralClient<T>(
  server: McpServerConfig,
  cwd: string,
  timeoutMs: number,
  fn: (client: RpcTransport) => Promise<T>,
): Promise<T> {
  const client = createRpcTransport(server, cwd, timeoutMs);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function getClientCacheKey(server: McpServerConfig, cwd: string): string {
  return JSON.stringify({
    cwd,
    id: server.id,
    transport: server.transport,
    url: server.url,
    command: server.command,
    commandArgs: server.commandArgs ?? [],
    workingDirectory: server.workingDirectory,
    environment: server.environment ?? {},
  });
}

async function getManagedClient(
  server: McpServerConfig,
  cwd: string,
  timeoutMs: number,
): Promise<RpcTransport> {
  const key = getClientCacheKey(server, cwd);
  const cached = MCP_CLIENT_CACHE.get(key);
  if (cached) {
    return cached;
  }

  const client = createRpcTransport(server, cwd, timeoutMs);
  client.setListChangedHandler?.(() => {
    MCP_MANAGED_SURFACE_CACHE.delete(key);
  });
  MCP_CLIENT_CACHE.set(key, client);

  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once('exit', () => {
      for (const entry of MCP_CLIENT_CACHE.values()) {
        void entry.close();
      }
      MCP_CLIENT_CACHE.clear();
      MCP_MANAGED_SURFACE_CACHE.clear();
    });
  }

  return client;
}

async function invalidateManagedClient(
  server: McpServerConfig,
  cwd: string,
): Promise<void> {
  const key = getClientCacheKey(server, cwd);
  MCP_MANAGED_SURFACE_CACHE.delete(key);
  const cached = MCP_CLIENT_CACHE.get(key);
  if (!cached) {
    return;
  }

  MCP_CLIENT_CACHE.delete(key);
  await cached.close();
}

export async function invalidateCachedMcpServer(options: {
  cwd: string;
  previousServer?: McpServerConfig;
  nextServer?: McpServerConfig;
}): Promise<void> {
  const handledKeys = new Set<string>();
  const invalidate = async (server: McpServerConfig | undefined) => {
    if (!server) {
      return;
    }

    const key = getClientCacheKey(server, options.cwd);
    if (handledKeys.has(key)) {
      return;
    }
    handledKeys.add(key);
    await invalidateManagedClient(server, options.cwd);
  };

  await invalidate(options.previousServer);
  await invalidate(options.nextServer);
}

async function discoverSurfaceWithClient(
  client: RpcTransport,
  source: 'probe' | 'client',
): Promise<McpDiscoveryResult> {
  const clientInfo = await client.initialize();
  const [tools, resources, prompts, commands] = await Promise.all([
    client.listTools().catch(() => []),
    client.listResources().catch(() => []),
    client.listPrompts().catch(() => []),
    client.listCommands().catch(() => []),
  ]);

  const transportSummary = client.getTransportSummary();
  return {
    surface: buildServerSurface({
      source,
      clientInfo,
      tools,
      resources,
      prompts,
      commands,
    }),
    authState: 'configured',
    server: client.getServerConfig(),
    contentType: transportSummary.contentType,
    serverSignature: transportSummary.serverSignature,
    sampledHeaders: transportSummary.sampledHeaders,
  };
}

async function discoverManagedSurface(options: {
  server: McpServerConfig;
  cwd: string;
  timeoutMs: number;
  forceRefresh?: boolean;
}): Promise<McpDiscoveryResult> {
  const key = getClientCacheKey(options.server, options.cwd);
  const cached = MCP_MANAGED_SURFACE_CACHE.get(key);
  if (
    !options.forceRefresh &&
    cached &&
    Date.now() - cached.cachedAt < MANAGED_SURFACE_CACHE_TTL_MS
  ) {
    return cached.result;
  }

  const client = await getManagedClient(
    options.server,
    options.cwd,
    options.timeoutMs,
  );
  const result = await discoverSurfaceWithClient(client, 'client');
  MCP_MANAGED_SURFACE_CACHE.set(key, {
    result,
    cachedAt: Date.now(),
  });
  return result;
}

export async function discoverMcpServerSurface(options: {
  server: McpServerConfig;
  cwd: string;
  timeoutMs?: number;
  source?: 'probe' | 'client';
}): Promise<McpDiscoveryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withEphemeralClient(
    options.server,
    options.cwd,
    timeoutMs,
    async (client) => discoverSurfaceWithClient(client, options.source ?? 'probe'),
  );
}

export async function callMcpServerTool(options: {
  server: McpServerConfig;
  cwd: string;
  toolName: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<McpToolCallResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      const surface = await discoverManagedSurface({
        server: options.server,
        cwd: options.cwd,
        timeoutMs,
      });
      const client = await getManagedClient(options.server, options.cwd, timeoutMs);
      const result = await client.callTool(options.toolName, options.args ?? {});
      return {
        output: serializeResult(result),
        raw: result,
        surface: surface.surface,
        authState: surface.authState,
        server: surface.server,
      };
    } catch (error) {
      await invalidateManagedClient(options.server, options.cwd);
      if (attempt === 0 && isMcpSessionExpiryError(error)) {
        continue;
      }
      // Detect missing runtime/executable — do not retry, surface to user
      if (isMissingExecutableError(error)) {
        const req = detectDependencyRequirement(options.server);
        if (req) {
          throw new McpDependencyError(
            options.server,
            buildDependencyInfo(options.server, req),
          );
        }
      }
      throw new Error(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  throw new Error('MCP tool call retry loop exited unexpectedly.');
}

export async function readMcpServerResource(options: {
  server: McpServerConfig;
  cwd: string;
  uri: string;
  timeoutMs?: number;
}): Promise<McpResourceReadResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      const surface = await discoverManagedSurface({
        server: options.server,
        cwd: options.cwd,
        timeoutMs,
      });
      const client = await getManagedClient(options.server, options.cwd, timeoutMs);
      const result = await client.readResource(options.uri);
      return {
        output: serializeResult(result),
        raw: result,
        surface: surface.surface,
        authState: surface.authState,
        server: surface.server,
      };
    } catch (error) {
      await invalidateManagedClient(options.server, options.cwd);
      if (attempt === 0 && isMcpSessionExpiryError(error)) {
        continue;
      }
      throw new Error(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  throw new Error('MCP resource read retry loop exited unexpectedly.');
}

// Extract the messages from a raw MCP getPrompt result and convert them to
// SessionMessage objects that can be injected into context.session.messages.
// Each MCP message becomes one SessionMessage; non-text content is converted to
// a bracketed placeholder so the session message is always a plain string.
export function extractMcpPromptSessionMessages(
  promptName: string,
  raw: unknown,
): SessionMessage[] {
  if (!isRecord(raw) || !Array.isArray(raw.messages)) {
    return [];
  }

  const now = new Date().toISOString();
  const results: SessionMessage[] = [];

  for (const msg of raw.messages) {
    if (!isRecord(msg)) {
      continue;
    }

    const role = typeof msg.role === 'string' ? msg.role.trim() : '';
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }

    const content = serializePromptContent(msg.content);
    if (!content) {
      continue;
    }

    results.push({
      id: randomUUID(),
      role: role as 'user' | 'assistant',
      content,
      name: `mcp:${promptName}`,
      createdAt: now,
    });
  }

  return results;
}

export async function getMcpServerPrompt(options: {
  server: McpServerConfig;
  cwd: string;
  promptName: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<McpPromptGetResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      const surface = await discoverManagedSurface({
        server: options.server,
        cwd: options.cwd,
        timeoutMs,
      });
      const client = await getManagedClient(options.server, options.cwd, timeoutMs);
      const result = await client.getPrompt(
        options.promptName,
        options.args ?? {},
      );
      return {
        output: serializePromptResult(options.promptName, result),
        raw: result,
        surface: surface.surface,
        authState: surface.authState,
        server: surface.server,
      };
    } catch (error) {
      await invalidateManagedClient(options.server, options.cwd);
      if (attempt === 0 && isMcpSessionExpiryError(error)) {
        continue;
      }
      throw new Error(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  throw new Error('MCP prompt retrieval retry loop exited unexpectedly.');
}

export function getSuggestedMcpAuthState(
  server: McpServerConfig,
  error: unknown,
): McpAuthState {
  const message = error instanceof Error ? error.message : String(error);
  return deriveAuthStateFromError(server, message);
}

export async function closeCachedMcpClients(): Promise<void> {
  const clients = [...MCP_CLIENT_CACHE.values()];
  MCP_CLIENT_CACHE.clear();
  MCP_MANAGED_SURFACE_CACHE.clear();
  await Promise.all(clients.map((client) => client.close()));
}
