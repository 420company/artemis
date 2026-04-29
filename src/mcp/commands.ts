/* eslint-disable @typescript-eslint/no-unused-vars */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import { pathExists } from '../utils/fs.js';
import { truncate } from '../utils/fs.js';
import {
  type McpAuthState,
  type McpAuthType,
  type McpOAuthConfig,
  type McpServerConfig,
  type McpServerStoreData,
  type McpTransport,
  isMcpAuthState,
  isMcpAuthType,
  isMcpTransport,
} from './store.js';
import {
  probeMcpServers as runMcpServerProbes,
  type McpProbeResult,
} from './probe.js';
import {
  formatStdioCommandTarget,
  normalizeStdioCommandParts,
} from './stdioConfig.js';
import {
  clearMcpOAuthSession,
  loginMcpOAuthServer,
} from './oauth.js';
import {
  extractMcpPromptSessionMessages,
  getMcpServerPrompt,
  getSuggestedMcpAuthState,
  invalidateCachedMcpServer,
} from './client.js';
import type { SessionMessage } from '../core/types.js';
import {
  applyMcpRuntimeFailure,
  applyMcpRuntimeSuccess,
} from './runtime.js';

export type McpCommand =
  | { type: 'show' }
  | { type: 'help' }
  | { type: 'doctor' }
  | { type: 'probe'; id?: string }
  | { type: 'get'; id: string }
  | { type: 'import-json'; filePath: string }
  | { type: 'import-project'; filePath?: string }
  | {
      type: 'add';
      transport: McpTransport;
      id: string;
      target?: string;
      command?: string;
      commandArgs?: string[];
      workingDirectory?: string;
      environment?: Record<string, string>;
      headers?: Record<string, string>;
      bearerToken?: string;
      oauth?: McpOAuthConfig;
      authType: McpAuthType;
    }
  | { type: 'enable'; id: string }
  | { type: 'disable'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'login'; id: string }
  | { type: 'logout'; id: string }
  | {
      type: 'run-prompt';
      id: string;
      promptName: string;
      args: Record<string, string>;
    }
  | { type: 'auth'; id: string; authState: McpAuthState; message?: string }
  | { type: 'clear-error'; id: string }
  | { type: 'reset-state'; id: string }
  | { type: 'invalid'; reason: string };

export type McpCommandResult = {
  ok: boolean;
  changed: boolean;
  view: 'overview' | 'doctor' | 'message';
  data: McpServerStoreData;
  message: string;
};

export type ExecutedMcpCommand = {
  result: McpCommandResult;
  probeResults?: McpProbeResult[];
  // Set when a run-prompt succeeds; caller may inject these into conversation context.
  promptMessages?: SessionMessage[];
};

const MCP_USAGE_LINES = [
  'Usage:',
  'mcp',
  'mcp doctor',
  'mcp probe [id]',
  'mcp get <id>',
  'mcp run-prompt <id> <prompt-name> [--arg key=value ...]',
  'mcp import-json <path>',
  'mcp import-project [path]',
  'mcp add-http <id> <url> [--auth <none|oauth|bearer|header>]',
  'mcp add-sse <id> <url> [--auth <none|oauth|bearer|header>]',
  'mcp add-stdio <id> <command...> [--auth <none|oauth|bearer|header>]',
  'mcp enable <id>',
  'mcp disable <id>',
  'mcp remove <id>',
  'mcp login <id>',
  'mcp logout <id>',
  'mcp auth <id> <unknown|configured|expired|error> [message]',
  'mcp clear-error <id>',
  'mcp reset-state <id>',
];

function now(): string {
  return new Date().toISOString();
}

function tokenizeInput(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((entry) => entry.replace(/^['"]|['"]$/g, ''));
}

function normalizeId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // If the entire string was special characters the result is empty; fall back
  // to a safe placeholder so callers never receive an empty ID.
  return normalized || 'unnamed';
}

function quoteShellToken(value: string): string {
  if (!value || /\s|["']/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return value;
}

function parseOptionalAuthType(tokens: string[]): {
  authType: McpAuthType;
  rest: string[];
} | null {
  const authIndex = tokens.findIndex((token) => token === '--auth');
  if (authIndex < 0) {
    return {
      authType: 'none',
      rest: tokens,
    };
  }

  const authToken = tokens[authIndex + 1];
  if (!isMcpAuthType(authToken)) {
    return null;
  }

  return {
    authType: authToken,
    rest: tokens.filter(
      (_, index) => index !== authIndex && index !== authIndex + 1,
    ),
  };
}

function getServerTargetLabel(server: McpServerConfig): string {
  return server.transport === 'stdio'
    ? formatStdioCommandTarget({
        command: server.command,
        args: server.commandArgs,
      })
    : server.url ?? '<missing>';
}

function deriveHealth(server: McpServerConfig): 'ready' | 'attention' | 'disabled' {
  if (!server.enabled) {
    return 'disabled';
  }

  if (server.authState === 'expired' || server.authState === 'error') {
    return 'attention';
  }

  if (
    (server.transport === 'stdio' && !server.command) ||
    (server.transport !== 'stdio' && !server.url)
  ) {
    return 'attention';
  }

  if (server.authType !== 'none' && server.authState !== 'configured') {
    return 'attention';
  }

  if (server.lastError) {
    return 'attention';
  }

  if (server.runtime?.connection === 'attention') {
    return 'attention';
  }

  return 'ready';
}

function buildServerLine(server: McpServerConfig): string {
  return [
    `- ${server.id}`,
    `[${server.transport} ${server.enabled ? 'enabled' : 'disabled'}]`,
    `health=${deriveHealth(server)}`,
    `auth=${server.authType}/${server.authState}`,
    `target=${truncate(getServerTargetLabel(server), 120)}`,
    server.runtime
      ? `runtime=${server.runtime.connection}/${server.runtime.auth}`
      : '',
    server.runtime
      ? `surface=t${server.runtime.toolsCount} r${server.runtime.resourcesCount} p${server.runtime.promptsCount} c${server.runtime.commandsCount}`
      : '',
    server.lastCheckedAt ? `checked=${server.lastCheckedAt}` : '',
    server.lastError ? `error=${truncate(server.lastError, 120)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function buildRuntimeDetailLines(server: McpServerConfig): string[] {
  if (!server.runtime) {
    return ['runtime: none recorded'];
  }

  const runtime = server.runtime;
  const lines = [
    `runtime connection: ${runtime.connection}`,
    `runtime auth: ${runtime.auth}`,
    `runtime source: ${runtime.source}`,
    `runtime last seen: ${runtime.lastSeenAt}`,
    `runtime surface: tools=${runtime.toolsCount} resources=${runtime.resourcesCount} prompts=${runtime.promptsCount} commands=${runtime.commandsCount}`,
  ];

  if (runtime.lastReachableAt) {
    lines.push(`runtime last reachable: ${runtime.lastReachableAt}`);
  }
  if (runtime.lastAuthFailureAt) {
    lines.push(`runtime last auth failure: ${runtime.lastAuthFailureAt}`);
  }
  if (runtime.contentType) {
    lines.push(`runtime content-type: ${runtime.contentType}`);
  }
  if (runtime.serverSignature) {
    lines.push(`runtime server: ${runtime.serverSignature}`);
  }
  if (runtime.sampledHeaders && runtime.sampledHeaders.length > 0) {
    lines.push(`runtime headers: ${runtime.sampledHeaders.join('; ')}`);
  }
  if (runtime.toolSample && runtime.toolSample.length > 0) {
    lines.push(`runtime tool sample: ${runtime.toolSample.join(', ')}`);
  }
  if (runtime.resourceSample && runtime.resourceSample.length > 0) {
    lines.push(`runtime resource sample: ${runtime.resourceSample.join(', ')}`);
  }
  if (runtime.promptSample && runtime.promptSample.length > 0) {
    lines.push(`runtime prompt sample: ${runtime.promptSample.join(', ')}`);
  }
  if (runtime.commandSample && runtime.commandSample.length > 0) {
    lines.push(`runtime command sample: ${runtime.commandSample.join(', ')}`);
  }

  if (runtime.notes && runtime.notes.length > 0) {
    lines.push('runtime notes:');
    for (const note of runtime.notes) {
      lines.push(`- ${truncate(note, 160)}`);
    }
  }

  return lines;
}

function addUniqueLine(lines: string[], line: string): void {
  if (!lines.includes(line)) {
    lines.push(line);
  }
}

function looksLikeAuthRefreshFailure(text: string | undefined): boolean {
  return /invalid_grant|refresh token|token expired/i.test(text ?? '');
}

function looksLikeAuthorizationFailure(text: string | undefined): boolean {
  return /HTTP 401|HTTP 403|invalid_client|authorization rejected/i.test(
    text ?? '',
  );
}

function looksLikeMissingExecutable(text: string | undefined): boolean {
  return /enoent|not recognized|cannot find|failed to start stdio server/i.test(
    text ?? '',
  );
}

function looksLikeBadHttpEndpoint(text: string | undefined): boolean {
  return /HTTP 404|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|Failed to parse URL/i.test(
    text ?? '',
  );
}

function buildMcpRecommendedActions(server: McpServerConfig): string[] {
  const actions: string[] = [];
  const probeCommand = `artemis mcp probe ${server.id}`;
  const getCommand = `artemis mcp get ${server.id}`;
  const resetCommand = `artemis mcp reset-state ${server.id}`;
  const target = getServerTargetLabel(server);
  const lastError = server.lastError;

  if (!server.enabled) {
    addUniqueLine(
      actions,
      `Enable this server with artemis mcp enable ${server.id}, then run ${probeCommand}.`,
    );
  }

  if (server.transport === 'stdio' && !server.command) {
    addUniqueLine(
      actions,
      `Repair the stdio command for ${server.id}, then run ${resetCommand} and ${probeCommand}.`,
    );
  }

  if (server.transport !== 'stdio' && !server.url) {
    addUniqueLine(
      actions,
      `Repair the MCP endpoint URL for ${server.id}, then run ${resetCommand} and ${probeCommand}.`,
    );
  }

  if (server.authType !== 'none' && server.authState === 'unknown') {
    addUniqueLine(
      actions,
      server.authType === 'oauth'
        ? `Run artemis mcp login ${server.id}, then run ${probeCommand}.`
        : `Finish configuring ${server.authType} credentials for ${server.id}, then run ${probeCommand}.`,
    );
  }

  if (
    server.authState === 'expired' ||
    (server.authType === 'oauth' && looksLikeAuthRefreshFailure(lastError))
  ) {
    addUniqueLine(
      actions,
      server.authType === 'oauth'
        ? `Re-authorize the OAuth session for ${server.id} with artemis mcp login ${server.id}, then run ${resetCommand} and ${probeCommand}.`
        : `Refresh the stored credentials for ${server.id}, then run ${resetCommand} and ${probeCommand}.`,
    );
  }

  if (
    server.authState === 'error' ||
    (server.authType !== 'none' && looksLikeAuthorizationFailure(lastError))
  ) {
    addUniqueLine(
      actions,
      server.authType === 'oauth'
        ? `Repair the OAuth session for ${server.id} with artemis mcp login ${server.id}, then run ${resetCommand} and ${probeCommand}.`
        : `Repair the ${server.authType} credentials for ${server.id}, then run ${resetCommand} and ${probeCommand}.`,
    );
  }

  if (server.transport === 'stdio' && looksLikeMissingExecutable(lastError)) {
    addUniqueLine(
      actions,
      `Verify that the stdio command still resolves on this machine (${target}), then run ${resetCommand} and ${probeCommand}.`,
    );
  }

  if (server.transport !== 'stdio' && looksLikeBadHttpEndpoint(lastError)) {
    addUniqueLine(
      actions,
      `Verify that ${target} is the correct MCP endpoint, then run ${resetCommand} and ${probeCommand}.`,
    );
  }

  if (
    server.transport === 'streamable-http' &&
    /reachable but rejected this probe shape/i.test(lastError ?? '')
  ) {
    addUniqueLine(
      actions,
      `The endpoint is reachable but rejected the current probe shape. Check that ${target} is the MCP base URL, then inspect ${getCommand} and retry ${probeCommand}.`,
    );
  }

  if (
    server.runtime?.connection === 'reachable' &&
    server.transport === 'streamable-http' &&
    !server.lastError
  ) {
    addUniqueLine(
      actions,
      `The endpoint looks reachable but not fully connected yet. Inspect ${getCommand} for runtime notes, then retry ${probeCommand}.`,
    );
  }

  if (server.lastError && actions.length === 0) {
    addUniqueLine(
      actions,
      `Inspect the stored failure with ${getCommand}, repair the transport or credentials, then run ${resetCommand} and ${probeCommand}.`,
    );
  }

  if (actions.length === 0) {
    addUniqueLine(
      actions,
      `No repair action needed right now. Run ${probeCommand} whenever you want a fresh live status check.`,
    );
  }

  return actions;
}

function buildMcpServerDetailText(server: McpServerConfig): string {
  const actions = buildMcpRecommendedActions(server);
  const lines = [
    `id: ${server.id}`,
    `enabled: ${server.enabled ? 'yes' : 'no'}`,
    `health: ${deriveHealth(server)}`,
    `transport: ${server.transport}`,
    `auth: ${server.authType}/${server.authState}`,
    `target: ${getServerTargetLabel(server)}`,
    server.oauth?.authorizationUrl
      ? `oauth authorize: ${server.oauth.authorizationUrl}`
      : undefined,
    server.oauth?.tokenUrl ? `oauth token: ${server.oauth.tokenUrl}` : undefined,
    server.oauth?.clientId ? `oauth client id: ${server.oauth.clientId}` : undefined,
    server.oauth?.scopes?.length
      ? `oauth scopes: ${server.oauth.scopes.join(', ')}`
      : undefined,
    server.oauth?.expiresAt ? `oauth expires: ${server.oauth.expiresAt}` : undefined,
    server.oauth?.refreshToken ? 'oauth refresh token: present' : undefined,
    server.transport === 'stdio' && server.workingDirectory
      ? `cwd: ${server.workingDirectory}`
      : undefined,
    server.transport === 'stdio' &&
    server.environment &&
    Object.keys(server.environment).length > 0
      ? `env keys: ${Object.keys(server.environment).sort().join(', ')}`
      : undefined,
    server.lastCheckedAt ? `last checked: ${server.lastCheckedAt}` : undefined,
    server.lastError ? `last error: ${server.lastError}` : undefined,
    ...buildRuntimeDetailLines(server),
  ].filter((line): line is string => Boolean(line));

  if (actions.length > 0) {
    lines.push('recommended actions:');
    for (const action of actions) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join('\n');
}

function buildMcpPromptUsage(options: {
  id: string;
  promptName: string;
  prompt?: {
    arguments?: Array<{
      name: string;
      required?: boolean;
    }>;
  };
}): string {
  const args = options.prompt?.arguments ?? [];
  const argText =
    args.length > 0
      ? ` ${args
          .map((argument) =>
            argument.required === true
              ? `--arg ${argument.name}=<required>`
              : `--arg ${argument.name}=<value>`,
          )
          .join(' ')}`
      : '';
  return `artemis mcp run-prompt ${options.id} ${options.promptName}${argText}`;
}

function inferAuthTypeFromImport(
  value: Record<string, unknown>,
): McpAuthType {
  if (isMcpAuthType(value.authType)) {
    return value.authType;
  }

  if (typeof value.oauth === 'object' && value.oauth !== null) {
    return 'oauth';
  }

  if (typeof value.bearerToken === 'string' && value.bearerToken.trim()) {
    return 'bearer';
  }

  if (typeof value.headers === 'object' && value.headers !== null) {
    return 'header';
  }

  return 'none';
}

function parseImportedServerEntries(
  payload: unknown,
): Array<{
  id: string;
  target?: string;
  command?: string;
  commandArgs?: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  bearerToken?: string;
  oauth?: McpOAuthConfig;
  transport: McpTransport;
  authType: McpAuthType;
}> {
  const root =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  const mapSource =
    root.mcpServers && typeof root.mcpServers === 'object'
      ? (root.mcpServers as Record<string, unknown>)
      : root.servers && typeof root.servers === 'object'
        ? (root.servers as Record<string, unknown>)
        : {};
  const entries: Array<{
    id: string;
    target?: string;
    command?: string;
    commandArgs?: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
    headers?: Record<string, string>;
    bearerToken?: string;
    oauth?: McpOAuthConfig;
    transport: McpTransport;
    authType: McpAuthType;
  }> = [];

  for (const [rawId, rawValue] of Object.entries(mapSource)) {
    const id = normalizeId(rawId);
    if (!id || !rawValue || typeof rawValue !== 'object') {
      continue;
    }

    const value = rawValue as Record<string, unknown>;
    const transport = isMcpTransport(value.transport)
      ? value.transport
      : typeof value.url === 'string' && value.url.trim()
        ? 'streamable-http'
        : 'stdio';
    const authType = inferAuthTypeFromImport(value);
    const headers =
      value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)
        ? Object.fromEntries(
            Object.entries(value.headers)
              .filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === 'string' &&
                  entry[0].trim().length > 0 &&
                  typeof entry[1] === 'string' &&
                  entry[1].trim().length > 0,
              )
              .map(([key, headerValue]) => [key.trim(), headerValue.trim()] as const),
          )
        : undefined;
    const oauth =
      value.oauth && typeof value.oauth === 'object' && !Array.isArray(value.oauth)
        ? (value.oauth as McpOAuthConfig)
        : undefined;
    const bearerToken =
      typeof value.bearerToken === 'string' && value.bearerToken.trim()
        ? value.bearerToken.trim()
        : undefined;

    if (transport === 'stdio') {
      const normalized = normalizeStdioCommandParts({
        command:
          typeof value.command === 'string' && value.command.trim()
            ? value.command.trim()
            : '',
        args: Array.isArray(value.args)
          ? value.args
              .filter((entry): entry is string => typeof entry === 'string')
              .map((entry) => entry.trim())
              .filter(Boolean)
          : undefined,
      });
      if (!normalized.command) {
        continue;
      }
      const environment =
        value.env && typeof value.env === 'object' && !Array.isArray(value.env)
          ? Object.fromEntries(
              Object.entries(value.env)
                .filter(
                  (entry): entry is [string, string] =>
                    typeof entry[0] === 'string' &&
                    entry[0].trim().length > 0 &&
                    typeof entry[1] === 'string' &&
                    entry[1].trim().length > 0,
                )
                .map(([key, envValue]) => [key.trim(), envValue.trim()] as const),
            )
          : undefined;
      entries.push({
        id,
        command: normalized.command,
        commandArgs: normalized.args,
        workingDirectory:
          typeof value.cwd === 'string' && value.cwd.trim()
            ? value.cwd.trim()
            : typeof value.workingDirectory === 'string' &&
                value.workingDirectory.trim()
              ? value.workingDirectory.trim()
              : undefined,
        environment:
          environment && Object.keys(environment).length > 0
            ? environment
            : undefined,
        headers:
          headers && Object.keys(headers).length > 0 ? headers : undefined,
        bearerToken,
        oauth,
        transport,
        authType,
      });
      continue;
    }

    const url = typeof value.url === 'string' ? value.url.trim() : '';
    if (!url) {
      continue;
    }
    entries.push({
      id,
      target: url,
      headers:
        headers && Object.keys(headers).length > 0 ? headers : undefined,
      bearerToken,
      oauth,
      transport,
      authType,
    });
  }

  return entries;
}

async function importMcpJsonConfig(options: {
  data: McpServerStoreData;
  filePath: string;
}): Promise<McpCommandResult> {
  const raw = await readFile(options.filePath, 'utf8');
  const imported = parseImportedServerEntries(JSON.parse(raw) as unknown);

  if (imported.length === 0) {
    return {
      ok: false,
      changed: false,
      view: 'message',
      data: options.data,
      message: `No importable MCP servers found in ${options.filePath}.`,
    };
  }

  let nextData = options.data;
  for (const entry of imported) {
    nextData = applyMcpCommand(nextData, {
      type: 'add',
      id: entry.id,
      target: entry.target,
      command: entry.command,
      commandArgs: entry.commandArgs,
      workingDirectory: entry.workingDirectory,
      environment: entry.environment,
      headers: entry.headers,
      bearerToken: entry.bearerToken,
      oauth: entry.oauth,
      transport: entry.transport,
      authType: entry.authType,
    }).data;
  }

  return {
    ok: true,
    changed: JSON.stringify(nextData) !== JSON.stringify(options.data),
    view: 'overview',
    data: nextData,
    message: `Imported ${imported.length} MCP server${imported.length === 1 ? '' : 's'} from ${options.filePath}.`,
  };
}

async function resolveProjectImportPath(
  cwd: string,
  filePath?: string,
): Promise<string | undefined> {
  const candidates = filePath
    ? [path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)]
    : [
        path.join(cwd, '.mcp.json'),
        path.join(cwd, 'mcp.json'),
        path.join(cwd, '.artemis', 'mcp.json'),
      ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function buildDoctorSummary(
  probeResults: McpProbeResult[] | undefined,
  testProviders: boolean | undefined,
): string {
  if (!testProviders) {
    return 'Static inspection uses the stored transport and auth state.';
  }

  if (!probeResults) {
    return 'Live MCP connectivity probes were requested, but no probe results were recorded.';
  }

  const ok = probeResults.filter((result) => result.status === 'ok').length;
  const failed = probeResults.filter(
    (result) => result.status === 'failed',
  ).length;
  const skipped = probeResults.filter(
    (result) => result.status === 'skipped',
  ).length;

  return `Live MCP connectivity probes ran during this doctor check. ok=${ok} failed=${failed} skipped=${skipped}.`;
}

export function buildMcpUsageText(): string {
  return MCP_USAGE_LINES.join('\n');
}

export function buildMcpOverviewText(
  data: McpServerStoreData,
  locale: UiLocale = 'en',
): string {
  const enabledCount = data.servers.filter((server) => server.enabled).length;
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en });

  const lines = [
    `${t('Total servers', 'Total servers')}: ${data.servers.length}`,
    `${t('Enabled', 'Enabled')}: ${enabledCount}`,
  ];

  if (data.servers.length === 0) {
    lines.push(t('No MCP servers configured.', 'No MCP servers configured.'));
    return lines.join('\n');
  }

  lines.push('');
  lines.push(...data.servers.map(buildServerLine));
  return lines.join('\n');
}

export function buildMcpDoctorText(options: {
  data: McpServerStoreData;
  locale?: UiLocale;
  filePath?: string;
  fileExists?: boolean;
  testProviders?: boolean;
  probeResults?: McpProbeResult[];
}): string {
  const locale = options.locale ?? 'en';
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en });
  const ready = options.data.servers.filter(
    (server) => deriveHealth(server) === 'ready',
  ).length;
  const attention = options.data.servers.filter(
    (server) => deriveHealth(server) === 'attention',
  ).length;
  const disabled = options.data.servers.filter(
    (server) => deriveHealth(server) === 'disabled',
  ).length;

  const lines = [
    options.filePath
      ? `${t('config file', 'config file')}: ${options.filePath} (${
          options.fileExists === false
            ? t('missing', 'missing')
            : t('present', 'present')
        })`
      : undefined,
    `${t('total servers', 'total servers')}: ${options.data.servers.length}`,
    `${t('ready', 'ready')}: ${ready}`,
    `${t('needs attention', 'needs attention')}: ${attention}`,
    `${t('disabled', 'disabled')}: ${disabled}`,
    t(
      buildDoctorSummary(options.probeResults, options.testProviders),
      buildDoctorSummary(options.probeResults, options.testProviders),
    ),
  ].filter((line): line is string => Boolean(line));

  if (options.data.servers.length > 0) {
    lines.push('');
    lines.push(...options.data.servers.map(buildServerLine));
  }

  const actionLines = options.data.servers
    .filter((server) => deriveHealth(server) !== 'ready')
    .flatMap((server) =>
      buildMcpRecommendedActions(server).map((action) => `- ${server.id}: ${action}`),
    );
  if (actionLines.length > 0) {
    lines.push('');
    lines.push(t('recommended actions:', 'recommended actions:'));
    lines.push(...actionLines);
  }

  return lines.join('\n');
}

export function buildMcpCommandText(
  result: McpCommandResult,
  locale: UiLocale = 'en',
  doctorOptions: {
    filePath?: string;
    fileExists?: boolean;
    testProviders?: boolean;
    probeResults?: McpProbeResult[];
  } = {},
): string {
  if (result.view === 'message') {
    return result.message;
  }

  const report =
    result.view === 'doctor'
      ? buildMcpDoctorText({
          data: result.data,
          locale,
          filePath: doctorOptions.filePath,
          fileExists: doctorOptions.fileExists,
          testProviders: doctorOptions.testProviders,
          probeResults: doctorOptions.probeResults,
        })
      : buildMcpOverviewText(result.data, locale);

  return result.message ? `${result.message}\n\n${report}` : report;
}

export function parseMcpCommand(input: string): McpCommand {
  const trimmed = input.trim();
  if (!trimmed) {
    return { type: 'show' };
  }

  const tokens = tokenizeInput(trimmed);
  const [head, ...rest] = tokens;
  const command = head?.toLowerCase() ?? '';

  if (command === 'help' || command === '?') {
    return { type: 'help' };
  }

  if (command === 'doctor' || command === 'status') {
    return { type: 'doctor' };
  }

  if (command === 'probe') {
    const id = rest[0] ? normalizeId(rest[0]) : undefined;
    if (rest[0] && !id) {
      return {
        type: 'invalid',
        reason: 'mcp probe received an invalid server id.',
      };
    }
    return { type: 'probe', id };
  }

  if (command === 'get') {
    const id = normalizeId(rest[0] ?? '');
    if (!id) {
      return {
        type: 'invalid',
        reason: 'mcp get requires a server id.',
      };
    }
    return { type: 'get', id };
  }

  if (command === 'run-prompt') {
    const id = normalizeId(rest[0] ?? '');
    const promptName = rest[1]?.trim() ?? '';
    if (!id || !promptName) {
      return {
        type: 'invalid',
        reason: 'mcp run-prompt requires <server-id> <prompt-name>.',
      };
    }

    const args: Record<string, string> = {};
    const remaining = rest.slice(2);
    for (let index = 0; index < remaining.length; index += 1) {
      const token = remaining[index] ?? '';
      if (token === '--arg' && remaining[index + 1]) {
        const pair = remaining[index + 1] ?? '';
        const eqIndex = pair.indexOf('=');
        if (eqIndex > 0) {
          args[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);
        }
        index += 1;
        continue;
      }
      if (token.startsWith('--arg=')) {
        const pair = token.slice('--arg='.length);
        const eqIndex = pair.indexOf('=');
        if (eqIndex > 0) {
          args[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);
        }
      }
    }

    return {
      type: 'run-prompt',
      id,
      promptName,
      args,
    };
  }

  if (command === 'import-json') {
    const filePath = rest.join(' ').trim();
    if (!filePath) {
      return {
        type: 'invalid',
        reason: 'mcp import-json requires a path to a JSON config file.',
      };
    }

    return { type: 'import-json', filePath };
  }

  if (command === 'import-project') {
    const filePath = rest.join(' ').trim() || undefined;
    return { type: 'import-project', filePath };
  }

  if (command === 'enable' || command === 'disable' || command === 'remove') {
    const id = normalizeId(rest[0] ?? '');
    if (!id) {
      return {
        type: 'invalid',
        reason: `mcp ${command} requires a server id.`,
      };
    }

    return command === 'enable'
      ? { type: 'enable', id }
      : command === 'disable'
        ? { type: 'disable', id }
        : { type: 'remove', id };
  }

  if (command === 'clear-error') {
    const id = normalizeId(rest[0] ?? '');
    if (!id) {
      return {
        type: 'invalid',
        reason: 'mcp clear-error requires a server id.',
      };
    }

    return { type: 'clear-error', id };
  }

  if (command === 'login' || command === 'logout') {
    const id = normalizeId(rest[0] ?? '');
    if (!id) {
      return {
        type: 'invalid',
        reason: `mcp ${command} requires a server id.`,
      };
    }

    return command === 'login'
      ? { type: 'login', id }
      : { type: 'logout', id };
  }

  if (command === 'reset-state') {
    const id = normalizeId(rest[0] ?? '');
    if (!id) {
      return {
        type: 'invalid',
        reason: 'mcp reset-state requires a server id.',
      };
    }

    return { type: 'reset-state', id };
  }

  if (command === 'auth') {
    const id = normalizeId(rest[0] ?? '');
    const authState = rest[1];
    if (!id || !isMcpAuthState(authState)) {
      return {
        type: 'invalid',
        reason:
          'mcp auth requires <id> and <unknown|configured|expired|error>.',
      };
    }

    return {
      type: 'auth',
      id,
      authState,
      message: rest.slice(2).join(' ').trim() || undefined,
    };
  }

  if (
    command === 'add-http' ||
    command === 'add-sse' ||
    command === 'add-stdio'
  ) {
    const parsed = parseOptionalAuthType(rest);
    if (!parsed) {
      return {
        type: 'invalid',
        reason: 'Invalid --auth value for mcp add command.',
      };
    }

    const id = normalizeId(parsed.rest[0] ?? '');
    const targetTokens = parsed.rest.slice(1);
    const target = targetTokens.join(' ').trim();
    if (!id || !target) {
      return {
        type: 'invalid',
        reason: `mcp ${command} requires both <id> and a target.`,
      };
    }

    return {
      type: 'add',
      transport:
        command === 'add-http'
          ? 'streamable-http'
          : command === 'add-sse'
            ? 'sse'
            : 'stdio',
      id,
      ...(command === 'add-stdio'
        ? {
            command: targetTokens[0],
            commandArgs: targetTokens.slice(1),
          }
        : {
            target,
          }),
      authType: parsed.authType,
    };
  }

  return {
    type: 'invalid',
    reason: `Unknown mcp subcommand: ${head}\n\n${buildMcpUsageText()}`,
  };
}

function upsertServer(
  data: McpServerStoreData,
  nextServer: McpServerConfig,
): McpServerStoreData {
  const existing = data.servers.find((server) => server.id === nextServer.id);
  if (!existing) {
    return {
      servers: [...data.servers, nextServer].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    };
  }

  return {
    servers: data.servers
      .map((server) => (server.id === nextServer.id ? nextServer : server))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function applyMcpCommand(
  data: McpServerStoreData,
  command: McpCommand,
): McpCommandResult {
  if (command.type === 'show') {
    return {
      ok: true,
      changed: false,
      view: 'overview',
      data,
      message: '',
    };
  }

  if (command.type === 'help') {
    return {
      ok: true,
      changed: false,
      view: 'message',
      data,
      message: buildMcpUsageText(),
    };
  }

  if (command.type === 'doctor' || command.type === 'probe') {
    return {
      ok: true,
      changed: false,
      view: 'doctor',
      data,
      message: '',
    };
  }

  if (command.type === 'invalid') {
    return {
      ok: false,
      changed: false,
      view: 'message',
      data,
      message: command.reason,
    };
  }

  if (command.type === 'import-json' || command.type === 'import-project') {
    return {
      ok: false,
      changed: false,
      view: 'message',
      data,
      message:
        command.type === 'import-json'
          ? 'mcp import-json must be executed through the async MCP command runner.'
          : 'mcp import-project must be executed through the async MCP command runner.',
    };
  }

  if (command.type === 'add') {
    const timestamp = now();
    const existing = data.servers.find((server) => server.id === command.id);
    const normalizedStdio = normalizeStdioCommandParts({
      command: command.command,
      args: command.commandArgs,
    });
    const nextServer: McpServerConfig = {
      id: command.id,
      enabled: true,
      transport: command.transport,
      command:
        command.transport === 'stdio'
          ? normalizedStdio.command
          : undefined,
      commandArgs:
        command.transport === 'stdio'
          ? normalizedStdio.args
          : undefined,
      workingDirectory:
        command.transport === 'stdio'
          ? command.workingDirectory
          : undefined,
      environment:
        command.transport === 'stdio'
          ? command.environment
          : undefined,
      url: command.transport === 'stdio' ? undefined : command.target,
      headers: command.headers,
      bearerToken: command.bearerToken,
      oauth: command.oauth,
      authType: command.authType,
      authState: command.authType === 'none' ? 'configured' : 'unknown',
      lastCheckedAt: undefined,
      lastError: undefined,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const nextData = upsertServer(data, nextServer);
    return {
      ok: true,
      changed: true,
      view: 'overview',
      data: nextData,
      message: existing
        ? `Updated MCP server ${command.id}.`
        : `Added MCP server ${command.id}.`,
    };
  }

  const currentCommand = command as Extract<
    McpCommand,
    { id: string }
  >;
  const current = data.servers.find(
    (server) => server.id === currentCommand.id,
  );
  if (!current) {
    return {
      ok: false,
      changed: false,
      view: 'overview',
      data,
      message: `MCP server ${currentCommand.id} was not found.`,
    };
  }

  if (currentCommand.type === 'get') {
    return {
      ok: true,
      changed: false,
      view: 'message',
      data,
      message: buildMcpServerDetailText(current),
    };
  }

  if (
    command.type === 'enable' ||
    command.type === 'disable' ||
    command.type === 'logout'
  ) {
    if (command.type === 'logout') {
      if (current.authType !== 'oauth') {
        return {
          ok: false,
          changed: false,
          view: 'message',
          data,
          message: `MCP server ${current.id} is not configured for OAuth.`,
        };
      }

      const nextServer = clearMcpOAuthSession(current);
      return {
        ok: true,
        changed: true,
        view: 'overview',
        data: upsertServer(data, nextServer),
        message: `Cleared the stored OAuth session for ${current.id}.`,
      };
    }

    const enabled = command.type === 'enable';
    if (current.enabled === enabled) {
      return {
        ok: true,
        changed: false,
        view: 'overview',
        data,
        message: `MCP server ${currentCommand.id} is already ${
          enabled ? 'enabled' : 'disabled'
        }.`,
      };
    }

    const nextData = {
      servers: data.servers.map((server) =>
        server.id === currentCommand.id
          ? {
              ...server,
              enabled,
              updatedAt: now(),
            }
          : server,
      ),
    };
    return {
      ok: true,
      changed: true,
      view: 'overview',
      data: nextData,
      message: `${enabled ? 'Enabled' : 'Disabled'} MCP server ${currentCommand.id}.`,
    };
  }

  if (command.type === 'remove') {
    return {
      ok: true,
      changed: true,
      view: 'overview',
      data: {
        servers: data.servers.filter((server) => server.id !== currentCommand.id),
      },
      message: `Removed MCP server ${currentCommand.id}.`,
    };
  }

  if (command.type === 'clear-error') {
    const nextData = {
      servers: data.servers.map((server) =>
        server.id === currentCommand.id
          ? {
              ...server,
              lastError: undefined,
              updatedAt: now(),
            }
          : server,
      ),
    };
    return {
      ok: true,
      changed: true,
      view: 'overview',
      data: nextData,
      message: `Cleared MCP error state for ${currentCommand.id}.`,
    };
  }

  if (command.type === 'reset-state') {
    const nextAuthState: McpAuthState =
      current.authType === 'none' ? 'configured' : 'unknown';
    const nextData = {
      servers: data.servers.map((server) =>
        server.id === currentCommand.id
          ? {
              ...server,
              authState: nextAuthState,
              lastCheckedAt: undefined,
              lastError: undefined,
              runtime: undefined,
              updatedAt: now(),
            }
          : server,
      ),
    };
    return {
      ok: true,
      changed: true,
      view: 'overview',
      data: nextData,
      message: `Reset stored MCP runtime/auth state for ${currentCommand.id}.`,
    };
  }

  const authCommand = currentCommand as Extract<McpCommand, { type: 'auth' }>;
  const timestamp = now();
  const nextData = {
    servers: data.servers.map((server) =>
      server.id === authCommand.id
        ? {
            ...server,
            authState: authCommand.authState,
            lastCheckedAt: timestamp,
            lastError:
              authCommand.authState === 'error' || authCommand.authState === 'expired'
                ? authCommand.message ?? server.lastError
                : undefined,
            updatedAt: timestamp,
          }
        : server,
    ),
  };
  return {
    ok: true,
    changed: true,
    view: 'overview',
    data: nextData,
    message: `Updated MCP auth state for ${authCommand.id} -> ${authCommand.authState}.`,
  };
}

export async function executeMcpCommand(options: {
  data: McpServerStoreData;
  command: McpCommand;
  probeServers?: typeof runMcpServerProbes;
  timeoutMs?: number;
  cwd?: string;
}): Promise<ExecutedMcpCommand> {
  const finalizeResult = async (
    result: McpCommandResult,
    probeResults?: McpProbeResult[],
  ): Promise<ExecutedMcpCommand> => {
    if (options.cwd && result.changed) {
      const previousServers = new Map(
        options.data.servers.map((server) => [server.id, server] as const),
      );
      const nextServers = new Map(
        result.data.servers.map((server) => [server.id, server] as const),
      );
      const changedIds = new Set([
        ...previousServers.keys(),
        ...nextServers.keys(),
      ]);
      await Promise.all(
        [...changedIds].map(async (id) => {
          const previousServer = previousServers.get(id);
          const nextServer = nextServers.get(id);
          if (
            JSON.stringify(previousServer) === JSON.stringify(nextServer)
          ) {
            return;
          }

          await invalidateCachedMcpServer({
            cwd: options.cwd!,
            previousServer,
            nextServer,
          });
        }),
      );
    }

    return {
      result,
      ...(probeResults ? { probeResults } : {}),
    };
  };

  if (options.command.type === 'import-json') {
    return finalizeResult(
      await importMcpJsonConfig({
        data: options.data,
        filePath: options.command.filePath,
      }),
    );
  }

  if (options.command.type === 'import-project') {
    if (!options.cwd) {
      return finalizeResult({
          ok: false,
          changed: false,
          view: 'message',
          data: options.data,
          message: 'mcp import-project requires a working directory.',
        });
    }

    const importPath = await resolveProjectImportPath(
      options.cwd,
      options.command.filePath,
    );
    if (!importPath) {
      return finalizeResult({
          ok: false,
          changed: false,
          view: 'message',
          data: options.data,
          message: options.command.filePath
            ? `No MCP config file found at ${options.command.filePath}.`
            : 'No project MCP config file found. Tried .mcp.json, mcp.json, and .artemis/mcp.json.',
        });
    }

    return finalizeResult(
      await importMcpJsonConfig({
        data: options.data,
        filePath: importPath,
      }),
    );
  }

  if (options.command.type === 'login') {
    const loginCommand = options.command;
    if (!options.cwd) {
      return finalizeResult({
          ok: false,
          changed: false,
          view: 'message',
          data: options.data,
          message: 'mcp login requires a working directory.',
        });
    }

    const current = options.data.servers.find(
      (server) => server.id === loginCommand.id,
    );
    if (!current) {
      return finalizeResult({
          ok: false,
          changed: false,
          view: 'message',
          data: options.data,
          message: `MCP server ${loginCommand.id} was not found.`,
        });
    }

    try {
      const loginResult = await loginMcpOAuthServer({
        cwd: options.cwd,
        data: options.data,
        server: current,
      });
      return finalizeResult({
          ok: true,
          changed: true,
          view: 'message',
          data: upsertServer(options.data, loginResult.server),
          message: [
            loginResult.message,
            loginResult.browserOpened
              ? undefined
              : `Open this URL manually if needed: ${loginResult.authorizationUrl}`,
          ]
            .filter(Boolean)
            .join('\n'),
        });
    } catch (error) {
      return finalizeResult({
          ok: false,
          changed: false,
          view: 'message',
          data: options.data,
          message: error instanceof Error ? error.message : String(error),
        });
    }
  }

  if (options.command.type === 'run-prompt') {
    const runPromptCommand = options.command;
    if (!options.cwd) {
      return finalizeResult({
        ok: false,
        changed: false,
        view: 'message',
        data: options.data,
        message: 'mcp run-prompt requires a working directory.',
      });
    }

    const current = options.data.servers.find(
      (server) => server.id === runPromptCommand.id,
    );
    if (!current) {
      return finalizeResult({
        ok: false,
        changed: false,
        view: 'message',
        data: options.data,
        message: `MCP server ${runPromptCommand.id} was not found.`,
      });
    }

    const promptDescriptor = current.surface?.prompts.find(
      (prompt) => prompt.name === runPromptCommand.promptName,
    );
    if (current.surface && !promptDescriptor) {
      const available =
        current.surface.prompts.length > 0
          ? current.surface.prompts.map((prompt) => prompt.name).join(', ')
          : 'none discovered';
      return finalizeResult({
        ok: false,
        changed: false,
        view: 'message',
        data: options.data,
        message: [
          `Prompt "${runPromptCommand.promptName}" was not found on MCP server "${current.id}".`,
          `Available prompts: ${available}.`,
        ].join('\n'),
      });
    }

    if (promptDescriptor) {
      const missingArgs = (promptDescriptor.arguments ?? [])
        .filter(
          (argument) =>
            argument.required === true &&
            !(argument.name in runPromptCommand.args),
        )
        .map((argument) => argument.name);
      if (missingArgs.length > 0) {
        return finalizeResult({
          ok: false,
          changed: false,
          view: 'message',
          data: options.data,
          message: [
            `Missing required prompt args for "${runPromptCommand.promptName}": ${missingArgs.join(', ')}`,
            `Usage: ${buildMcpPromptUsage({
              id: current.id,
              promptName: runPromptCommand.promptName,
              prompt: promptDescriptor,
            })}`,
          ].join('\n'),
        });
      }
    }

    try {
      const promptResult = await getMcpServerPrompt({
        server: current,
        cwd: options.cwd,
        promptName: runPromptCommand.promptName,
        args: runPromptCommand.args,
        timeoutMs: options.timeoutMs,
      });
      const nextServer = applyMcpRuntimeSuccess({
        server: promptResult.server,
        authState: promptResult.authState,
        surface: promptResult.surface,
        connection: 'connected',
        notes: [
          `Prompt ${runPromptCommand.promptName} executed via mcp run-prompt.`,
        ],
      });
      const promptMessages = extractMcpPromptSessionMessages(
        runPromptCommand.promptName,
        promptResult.raw,
      );
      const baseResult = await finalizeResult({
        ok: true,
        changed: true,
        view: 'message',
        data: upsertServer(options.data, nextServer),
        message: promptResult.output,
      });
      return {
        ...baseResult,
        ...(promptMessages.length > 0 ? { promptMessages } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextServer = applyMcpRuntimeFailure({
        server: current,
        authState: getSuggestedMcpAuthState(current, error),
        message,
      });
      return finalizeResult({
        ok: false,
        changed: true,
        view: 'message',
        data: upsertServer(options.data, nextServer),
        message,
      });
    }
  }

  if (options.command.type !== 'probe') {
    return finalizeResult(
      applyMcpCommand(options.data, options.command),
    );
  }

  const probeCommand = options.command as Extract<McpCommand, { type: 'probe' }>;
  const probeServers = options.probeServers ?? runMcpServerProbes;
  const probeTarget =
    probeCommand.id === undefined
      ? options.data
      : {
          servers: options.data.servers.filter(
            (server) => server.id === probeCommand.id,
          ),
        };

  if (probeCommand.id && probeTarget.servers.length === 0) {
    return finalizeResult({
        ok: false,
        changed: false,
        view: 'message',
        data: options.data,
        message: `MCP server ${probeCommand.id} was not found.`,
      });
  }

  const outcome = await probeServers(
    probeTarget,
    options.timeoutMs,
    options.cwd,
  );
  const mergedData =
    probeCommand.id === undefined
      ? outcome.data
      : {
          servers: options.data.servers.map((server) => {
              const next = outcome.data.servers.find(
                (entry) => entry.id === server.id,
              );
              return next ?? server;
            }),
        };
  const okCount = outcome.results.filter((result) => result.status === 'ok').length;
  const failedCount = outcome.results.filter(
    (result) => result.status === 'failed',
  ).length;
  const skippedCount = outcome.results.filter(
    (result) => result.status === 'skipped',
  ).length;

  const result: McpCommandResult = {
      ok: failedCount === 0,
      changed:
        JSON.stringify(mergedData) !== JSON.stringify(options.data),
      view: 'doctor',
      data: mergedData,
      message:
        outcome.results.length === 0
          ? 'No MCP servers configured.'
          : `Live MCP probe completed. target=${probeCommand.id ?? 'all'} ok=${okCount} failed=${failedCount} skipped=${skippedCount}.`,
    };
  return finalizeResult(result, outcome.results);
}
