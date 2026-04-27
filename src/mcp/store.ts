import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists, resolveDataRootDir } from '../utils/fs.js';
import { normalizeStdioCommandParts } from './stdioConfig.js';

export type McpTransport = 'stdio' | 'streamable-http' | 'sse';
export type McpAuthType = 'none' | 'oauth' | 'bearer' | 'header';
export type McpAuthState = 'unknown' | 'configured' | 'expired' | 'error';
export type McpRuntimeConnectionState =
  | 'unknown'
  | 'reachable'
  | 'connected'
  | 'attention';
export type McpRuntimeSource = 'probe' | 'discovery' | 'manual' | 'client';
export type McpOAuthTokenType = 'Bearer';

export type McpToolDescriptor = {
  name: string;
  title?: string;
  description?: string;
  searchHint?: string;
  alwaysLoad?: boolean;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
};

export type McpResourceDescriptor = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type McpPromptDescriptor = {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgumentDescriptor[];
};

export type McpPromptArgumentDescriptor = {
  name: string;
  description?: string;
  required?: boolean;
};

export type McpCommandDescriptor = {
  name: string;
  title?: string;
  description?: string;
};

export type McpServerSurface = {
  discoveredAt: string;
  source: 'probe' | 'client';
  serverName?: string;
  serverVersion?: string;
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  prompts: McpPromptDescriptor[];
  commands: McpCommandDescriptor[];
};

export type McpRuntimeSnapshot = {
  connection: McpRuntimeConnectionState;
  auth: McpAuthState;
  toolsCount: number;
  resourcesCount: number;
  promptsCount: number;
  commandsCount: number;
  source: McpRuntimeSource;
  lastSeenAt: string;
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
};

export type McpOAuthConfig = {
  metadataUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  registrationUrl?: string;
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  scopes?: string[];
  audience?: string;
  resource?: string;
  redirectUri?: string;
  tokenType?: McpOAuthTokenType;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  registeredAt?: string;
  lastRefreshAt?: string;
};

export type McpServerConfig = {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  commandArgs?: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  bearerToken?: string;
  oauth?: McpOAuthConfig;
  authType: McpAuthType;
  authState: McpAuthState;
  lastCheckedAt?: string;
  lastError?: string;
  runtime?: McpRuntimeSnapshot;
  surface?: McpServerSurface;
  createdAt: string;
  updatedAt: string;
};

export type McpServerStoreData = {
  servers: McpServerConfig[];
};

function now(): string {
  return new Date().toISOString();
}

export function isMcpTransport(value: unknown): value is McpTransport {
  return (
    value === 'stdio' ||
    value === 'streamable-http' ||
    value === 'sse'
  );
}

export function isMcpAuthType(value: unknown): value is McpAuthType {
  return (
    value === 'none' ||
    value === 'oauth' ||
    value === 'bearer' ||
    value === 'header'
  );
}

export function isMcpAuthState(value: unknown): value is McpAuthState {
  return (
    value === 'unknown' ||
    value === 'configured' ||
    value === 'expired' ||
    value === 'error'
  );
}

export function isMcpRuntimeConnectionState(
  value: unknown,
): value is McpRuntimeConnectionState {
  return (
    value === 'unknown' ||
    value === 'reachable' ||
    value === 'connected' ||
    value === 'attention'
  );
}

export function isMcpRuntimeSource(value: unknown): value is McpRuntimeSource {
  return (
    value === 'probe' ||
    value === 'discovery' ||
    value === 'manual' ||
    value === 'client'
  );
}

function normalizeMcpServerId(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined;
}

function normalizeOptionalCollapsedString(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.length > 0 ? entries : undefined;
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === 'string' &&
        entry[0].trim().length > 0 &&
        typeof entry[1] === 'string' &&
        entry[1].trim().length > 0,
    )
    .map(([key, entryValue]) => [key.trim(), entryValue.trim()] as const);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeOAuthTokenType(
  value: unknown,
): McpOAuthTokenType | undefined {
  return value === 'Bearer' ? 'Bearer' : undefined;
}

function normalizeOAuthConfig(value: unknown): McpOAuthConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const next: McpOAuthConfig = {
    metadataUrl: normalizeOptionalString(candidate.metadataUrl),
    authorizationUrl:
      normalizeOptionalString(candidate.authorizationUrl) ??
      normalizeOptionalString(candidate.authorizationEndpoint),
    tokenUrl:
      normalizeOptionalString(candidate.tokenUrl) ??
      normalizeOptionalString(candidate.tokenEndpoint),
    registrationUrl:
      normalizeOptionalString(candidate.registrationUrl) ??
      normalizeOptionalString(candidate.registrationEndpoint),
    clientId: normalizeOptionalString(candidate.clientId),
    clientSecret: normalizeOptionalString(candidate.clientSecret),
    clientName: normalizeOptionalString(candidate.clientName),
    scopes:
      normalizeStringList(candidate.scopes) ??
      (typeof candidate.scope === 'string' && candidate.scope.trim()
        ? candidate.scope
            .trim()
            .split(/\s+/)
            .filter(Boolean)
        : undefined),
    audience: normalizeOptionalString(candidate.audience),
    resource: normalizeOptionalString(candidate.resource),
    redirectUri: normalizeOptionalString(candidate.redirectUri),
    tokenType: normalizeOAuthTokenType(candidate.tokenType),
    accessToken: normalizeOptionalString(candidate.accessToken),
    refreshToken: normalizeOptionalString(candidate.refreshToken),
    expiresAt: normalizeOptionalString(candidate.expiresAt),
    registeredAt: normalizeOptionalString(candidate.registeredAt),
    lastRefreshAt: normalizeOptionalString(candidate.lastRefreshAt),
  };

  return Object.values(next).some((entry) => entry !== undefined)
    ? next
    : undefined;
}

function normalizeObjectRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function normalizeToolDescriptor(value: unknown): McpToolDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const name = normalizeOptionalString(candidate.name);
  if (!name) {
    return null;
  }

  return {
    name,
    title: normalizeOptionalString(candidate.title),
    description: normalizeOptionalString(candidate.description),
    searchHint: normalizeOptionalCollapsedString(candidate.searchHint),
    alwaysLoad: candidate.alwaysLoad === true ? true : undefined,
    inputSchema: normalizeObjectRecord(candidate.inputSchema),
    readOnly: typeof candidate.readOnly === 'boolean' ? candidate.readOnly : undefined,
    destructive:
      typeof candidate.destructive === 'boolean'
        ? candidate.destructive
        : undefined,
    openWorld:
      typeof candidate.openWorld === 'boolean'
        ? candidate.openWorld
        : undefined,
  };
}

function normalizeResourceDescriptor(
  value: unknown,
): McpResourceDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const uri = normalizeOptionalString(candidate.uri);
  if (!uri) {
    return null;
  }

  return {
    uri,
    name: normalizeOptionalString(candidate.name),
    description: normalizeOptionalString(candidate.description),
    mimeType: normalizeOptionalString(candidate.mimeType),
  };
}

function normalizePromptDescriptor(value: unknown): McpPromptDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const name = normalizeOptionalString(candidate.name);
  if (!name) {
    return null;
  }

  return {
    name,
    title: normalizeOptionalString(candidate.title),
    description: normalizeOptionalString(candidate.description),
    arguments: normalizeDescriptorList(
      candidate.arguments,
      normalizePromptArgumentDescriptor,
    ),
  };
}

function normalizePromptArgumentDescriptor(
  value: unknown,
): McpPromptArgumentDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const name = normalizeOptionalString(candidate.name);
  if (!name) {
    return null;
  }

  return {
    name,
    ...(normalizeOptionalString(candidate.description)
      ? { description: normalizeOptionalString(candidate.description) }
      : {}),
    ...(typeof candidate.required === 'boolean'
      ? { required: candidate.required }
      : {}),
  };
}

function normalizeCommandDescriptor(
  value: unknown,
): McpCommandDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const name =
    normalizeOptionalString(candidate.name) ??
    normalizeOptionalString(candidate.title);
  if (!name) {
    return null;
  }

  return {
    name,
    title: normalizeOptionalString(candidate.title),
    description: normalizeOptionalString(candidate.description),
  };
}

function normalizeDescriptorList<T>(
  value: unknown,
  normalizeEntry: (entry: unknown) => T | null,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items = value
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is T => entry !== null);

  return items;
}

function normalizeServerSurface(value: unknown): McpServerSurface | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const discoveredAt =
    normalizeOptionalString(candidate.discoveredAt) ?? now();
  const source = candidate.source === 'client' ? 'client' : 'probe';

  return {
    discoveredAt,
    source,
    serverName: normalizeOptionalString(candidate.serverName),
    serverVersion: normalizeOptionalString(candidate.serverVersion),
    tools: normalizeDescriptorList(candidate.tools, normalizeToolDescriptor),
    resources: normalizeDescriptorList(
      candidate.resources,
      normalizeResourceDescriptor,
    ),
    prompts: normalizeDescriptorList(candidate.prompts, normalizePromptDescriptor),
    commands: normalizeDescriptorList(
      candidate.commands,
      normalizeCommandDescriptor,
    ),
  };
}

function normalizeRuntimeSnapshot(
  value: unknown,
  fallbackAuth: McpAuthState,
  fallbackTimestamp: string,
): McpRuntimeSnapshot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  return {
    connection: isMcpRuntimeConnectionState(candidate.connection)
      ? candidate.connection
      : 'unknown',
    auth: isMcpAuthState(candidate.auth) ? candidate.auth : fallbackAuth,
    toolsCount: normalizeNonNegativeInteger(candidate.toolsCount),
    resourcesCount: normalizeNonNegativeInteger(candidate.resourcesCount),
    promptsCount: normalizeNonNegativeInteger(candidate.promptsCount),
    commandsCount: normalizeNonNegativeInteger(candidate.commandsCount),
    source: isMcpRuntimeSource(candidate.source) ? candidate.source : 'manual',
    lastSeenAt:
      typeof candidate.lastSeenAt === 'string' && candidate.lastSeenAt.trim()
        ? candidate.lastSeenAt
        : fallbackTimestamp,
    lastReachableAt: normalizeOptionalString(candidate.lastReachableAt),
    lastAuthFailureAt: normalizeOptionalString(candidate.lastAuthFailureAt),
    contentType: normalizeOptionalString(candidate.contentType),
    serverSignature: normalizeOptionalString(candidate.serverSignature),
    sampledHeaders: normalizeStringList(candidate.sampledHeaders),
    toolSample: normalizeStringList(candidate.toolSample),
    resourceSample: normalizeStringList(candidate.resourceSample),
    promptSample: normalizeStringList(candidate.promptSample),
    commandSample: normalizeStringList(candidate.commandSample),
    notes: normalizeStringList(candidate.notes),
  };
}

function normalizeServer(
  value: unknown,
): McpServerConfig | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = normalizeMcpServerId(candidate.id);
  if (!id) {
    return null;
  }

  const transport = isMcpTransport(candidate.transport)
    ? candidate.transport
    : 'stdio';
  const normalizedStdio = normalizeStdioCommandParts({
    command: normalizeOptionalString(candidate.command),
    args: normalizeStringList(candidate.commandArgs ?? candidate.args),
  });
  const command = normalizedStdio.command;
  const url = normalizeOptionalString(candidate.url);

  if (transport === 'stdio' && !command) {
    return null;
  }

  if (transport !== 'stdio' && !url) {
    return null;
  }

  const createdAt =
    typeof candidate.createdAt === 'string' &&
    String(candidate.createdAt).trim()
      ? String(candidate.createdAt)
      : now();
  const updatedAt =
    typeof candidate.updatedAt === 'string' &&
    String(candidate.updatedAt).trim()
      ? String(candidate.updatedAt)
      : createdAt;

  return {
    id,
    enabled: candidate.enabled === true,
    transport,
    command,
    commandArgs: normalizedStdio.args,
    workingDirectory:
      normalizeOptionalString(candidate.workingDirectory) ??
      normalizeOptionalString(candidate.cwd),
    environment:
      normalizeStringRecord(candidate.environment) ??
      normalizeStringRecord(candidate.env),
    url,
    headers: normalizeStringRecord(candidate.headers),
    bearerToken: normalizeOptionalString(candidate.bearerToken),
    oauth: normalizeOAuthConfig(candidate.oauth),
    authType: isMcpAuthType(candidate.authType)
      ? candidate.authType
      : 'none',
    authState: isMcpAuthState(candidate.authState)
      ? candidate.authState
      : 'unknown',
    lastCheckedAt: normalizeOptionalString(
      candidate.lastCheckedAt,
    ),
    lastError: normalizeOptionalString(candidate.lastError),
    runtime: normalizeRuntimeSnapshot(
      candidate.runtime,
      isMcpAuthState(candidate.authState) ? candidate.authState : 'unknown',
      updatedAt,
    ),
    surface: normalizeServerSurface(candidate.surface),
    createdAt,
    updatedAt,
  };
}

function getDefaultData(): McpServerStoreData {
  return {
    servers: [],
  };
}

function cloneStoreData(data: McpServerStoreData): McpServerStoreData {
  return JSON.parse(JSON.stringify(data)) as McpServerStoreData;
}

function normalizeData(input: unknown): McpServerStoreData {
  const rawServers =
    input &&
    typeof input === 'object' &&
    Array.isArray((input as { servers?: unknown[] }).servers)
      ? (input as { servers: unknown[] }).servers
      : [];
  const seenIds = new Set<string>();
  const servers = rawServers
    .map((entry) => normalizeServer(entry))
    .filter((entry): entry is McpServerConfig => entry !== null)
    .filter((entry) => {
      if (seenIds.has(entry.id)) {
        return false;
      }

      seenIds.add(entry.id);
      return true;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    servers,
  };
}

export class McpServerStore {
  private readonly rootDir: string;
  private readonly filePath: string;
  private static readonly cache = new Map<
    string,
    { data: McpServerStoreData; mtimeMs?: number; size?: number }
  >();

  constructor(cwd: string) {
    this.rootDir = resolveDataRootDir(cwd);
    this.filePath = path.join(this.rootDir, 'mcp-servers.json');
  }

  getFilePath(): string {
    return this.filePath;
  }

  async exists(): Promise<boolean> {
    return pathExists(this.filePath);
  }

  async ensure(): Promise<void> {
    await ensureDir(this.rootDir);
  }

  async load(): Promise<McpServerStoreData> {
    await this.ensure();
    if (!(await this.exists())) {
      const empty = getDefaultData();
      McpServerStore.cache.set(this.filePath, { data: empty });
      return cloneStoreData(empty);
    }

    const info = await stat(this.filePath);
    const cached = McpServerStore.cache.get(this.filePath);
    if (
      cached &&
      cached.mtimeMs === info.mtimeMs &&
      cached.size === info.size
    ) {
      return cloneStoreData(cached.data);
    }

    const raw = await readFile(this.filePath, 'utf8');
    const normalized = normalizeData(JSON.parse(raw) as unknown);
    McpServerStore.cache.set(this.filePath, {
      data: normalized,
      mtimeMs: info.mtimeMs,
      size: info.size,
    });
    return cloneStoreData(normalized);
  }

  async save(data: McpServerStoreData): Promise<void> {
    await this.ensure();
    const normalized = normalizeData(data);
    // Atomic write: write to a temp file then rename so a crash mid-write
    // never leaves a partial / corrupt JSON file.
    const tmp = `${this.filePath}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(normalized, null, 2), 'utf8');
      await rename(tmp, this.filePath);
      const info = await stat(this.filePath);
      McpServerStore.cache.set(this.filePath, {
        data: normalized,
        mtimeMs: info.mtimeMs,
        size: info.size,
      });
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  getById(data: McpServerStoreData, id: string): McpServerConfig | undefined {
    return data.servers.find((s) => s.id === id);
  }

  async add(input: Partial<McpServerConfig> & { id: string }): Promise<McpServerConfig> {
    const data = await this.load();
    const now = new Date().toISOString();
    const raw = normalizeServer({ createdAt: now, updatedAt: now, ...input });
    if (!raw) throw new Error(`Invalid MCP server config for id: ${input.id}`);
    const server = raw;
    const existing = data.servers.findIndex((s) => s.id === server.id);
    if (existing >= 0) {
      data.servers[existing] = server;
    } else {
      data.servers.push(server);
    }
    await this.save(data);
    return server;
  }

  async remove(id: string): Promise<McpServerConfig | undefined> {
    const data = await this.load();
    const index = data.servers.findIndex((s) => s.id === id);
    if (index < 0) return undefined;
    const [removed] = data.servers.splice(index, 1);
    await this.save(data);
    return removed;
  }

  async updateSurface(id: string, surface: McpServerSurface): Promise<void> {
    const data = await this.load();
    const server = data.servers.find((s) => s.id === id);
    if (server) {
      server.surface = surface;
      server.updatedAt = new Date().toISOString();
      await this.save(data);
    }
  }

  async setError(id: string, error: string): Promise<void> {
    const data = await this.load();
    const server = data.servers.find((s) => s.id === id);
    if (server) {
      server.lastError = error;
      server.authState = 'error';
      server.updatedAt = new Date().toISOString();
      await this.save(data);
    }
  }
}
