import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { McpServerStore, type McpOAuthConfig, type McpServerConfig } from './store.js';

type OAuthMetadata = {
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl?: string;
  metadataUrl?: string;
};

type OAuthClientRegistration = {
  clientId: string;
  clientSecret?: string;
  clientName?: string;
};

type OAuthTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: 'Bearer';
  expiresAt?: string;
};

type OAuthAccessResolution = {
  server: McpServerConfig;
  accessToken: string;
};

type OAuthLoginResult = {
  server: McpServerConfig;
  authorizationUrl: string;
  browserOpened: boolean;
  message: string;
};

const OAUTH_REQUEST_TIMEOUT_MS = 20_000;
const OAUTH_CALLBACK_TIMEOUT_MS = 120_000;
const OAUTH_REFRESH_SKEW_MS = 60_000;
const CALLBACK_PATH = '/oauth/callback';

function now(): string {
  return new Date().toISOString();
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createPkceVerifier(): string {
  return base64UrlEncode(randomBytes(48));
}

function createPkceChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

function createOAuthState(): string {
  return base64UrlEncode(randomBytes(24));
}

function isLoopbackRedirect(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function shouldRefreshAccessToken(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) {
    return false;
  }

  return expiry <= Date.now() + OAUTH_REFRESH_SKEW_MS;
}

function buildMcpLoginCommand(serverId: string): string {
  return `artemis mcp login ${serverId}`;
}

function mergeServer(data: { servers: McpServerConfig[] }, nextServer: McpServerConfig): {
  servers: McpServerConfig[];
} {
  return {
    servers: data.servers.map((server) =>
      server.id === nextServer.id ? nextServer : server,
    ),
  };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        typeof (payload as Record<string, unknown>).error_description === 'string'
          ? String((payload as Record<string, unknown>).error_description)
          : payload &&
              typeof payload === 'object' &&
              !Array.isArray(payload) &&
              typeof (payload as Record<string, unknown>).error === 'string'
            ? String((payload as Record<string, unknown>).error)
            : `${response.status} ${response.statusText}`.trim();
      throw new Error(message);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`OAuth endpoint ${url} did not return a JSON object.`);
    }
    return payload as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function getString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getStringList(
  payload: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function buildOAuthWellKnownCandidates(baseUrl: string, kind: string): string[] {
  try {
    const parsed = new URL(baseUrl);
    const suffix =
      parsed.pathname && parsed.pathname !== '/'
        ? parsed.pathname.replace(/\/+$/u, '')
        : '';
    return [...new Set([
      new URL(`/.well-known/${kind}${suffix}`, parsed.origin).toString(),
      new URL(`/.well-known/${kind}`, parsed.origin).toString(),
    ])];
  } catch {
    return [];
  }
}

async function discoverMetadataFromUrl(candidate: string): Promise<OAuthMetadata | null> {
  try {
    const payload = await fetchJson(candidate);
    const authorizationUrl =
      getString(payload, 'authorization_endpoint') ??
      getString(payload, 'authorizationUrl');
    const tokenUrl =
      getString(payload, 'token_endpoint') ??
      getString(payload, 'tokenUrl');
    if (!authorizationUrl || !tokenUrl) {
      return null;
    }

    return {
      authorizationUrl,
      tokenUrl,
      registrationUrl:
        getString(payload, 'registration_endpoint') ??
        getString(payload, 'registrationUrl'),
      metadataUrl: candidate,
    };
  } catch {
    return null;
  }
}

async function discoverMetadataViaProtectedResource(
  server: McpServerConfig,
): Promise<OAuthMetadata | null> {
  for (const candidate of buildOAuthWellKnownCandidates(
    server.url ?? '',
    'oauth-protected-resource',
  )) {
    try {
      const payload = await fetchJson(candidate);
      const authorizationServers =
        getStringList(payload, 'authorization_servers') ?? [];
      for (const issuer of authorizationServers) {
        for (const metadataCandidate of buildOAuthWellKnownCandidates(
          issuer,
          'oauth-authorization-server',
        )) {
          const metadata = await discoverMetadataFromUrl(metadataCandidate);
          if (metadata) {
            return metadata;
          }
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function discoverOAuthMetadata(server: McpServerConfig): Promise<OAuthMetadata> {
  if (
    server.oauth?.authorizationUrl &&
    server.oauth?.tokenUrl
  ) {
    return {
      authorizationUrl: server.oauth.authorizationUrl,
      tokenUrl: server.oauth.tokenUrl,
      registrationUrl: server.oauth.registrationUrl,
      metadataUrl: server.oauth.metadataUrl,
    };
  }

  if (server.oauth?.metadataUrl) {
    const configured = await discoverMetadataFromUrl(server.oauth.metadataUrl);
    if (configured) {
      return {
        ...configured,
        metadataUrl: server.oauth.metadataUrl,
      };
    }
  }

  for (const candidate of buildOAuthWellKnownCandidates(
    server.url ?? '',
    'oauth-authorization-server',
  )) {
    const metadata = await discoverMetadataFromUrl(candidate);
    if (metadata) {
      return metadata;
    }
  }

  const protectedResourceMetadata = await discoverMetadataViaProtectedResource(server);
  if (protectedResourceMetadata) {
    return protectedResourceMetadata;
  }

  throw new Error(
    `Could not discover OAuth metadata for ${server.id}. Add oauth.metadataUrl or oauth.authorizationUrl/tokenUrl to the MCP server config.`,
  );
}

async function registerDynamicClient(options: {
  metadata: OAuthMetadata;
  redirectUri: string;
}): Promise<OAuthClientRegistration> {
  if (!options.metadata.registrationUrl) {
    throw new Error(
      'OAuth metadata is missing a registration endpoint. Import a pre-registered clientId into this MCP server config first.',
    );
  }

  const payload = await fetchJson(options.metadata.registrationUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_name: 'Artemis MCP',
      redirect_uris: [options.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });

  const clientId = getString(payload, 'client_id');
  if (!clientId) {
    throw new Error('OAuth dynamic client registration returned no client_id.');
  }

  return {
    clientId,
    clientSecret: getString(payload, 'client_secret'),
    clientName: getString(payload, 'client_name') ?? 'Artemis MCP',
  };
}

async function exchangeToken(
  tokenUrl: string,
  body: URLSearchParams,
): Promise<OAuthTokenResponse> {
  const payload = await fetchJson(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const accessToken = getString(payload, 'access_token');
  if (!accessToken) {
    throw new Error('OAuth token endpoint returned no access_token.');
  }

  const expiresInRaw = payload.expires_in;
  const expiresIn =
    typeof expiresInRaw === 'number'
      ? expiresInRaw
      : typeof expiresInRaw === 'string'
        ? Number(expiresInRaw)
        : undefined;

  return {
    accessToken,
    refreshToken: getString(payload, 'refresh_token'),
    tokenType: 'Bearer',
    expiresAt:
      Number.isFinite(expiresIn) && Number(expiresIn) > 0
        ? new Date(Date.now() + Number(expiresIn) * 1_000).toISOString()
        : undefined,
  };
}

async function openExternalUrl(url: string): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      const child = spawn('open', [url], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return true;
    }

    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return true;
    }

    const child = spawn('xdg-open', [url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function announceOAuthAuthorizationUrl(serverId: string, url: string): void {
  if (!process.stderr.isTTY) {
    return;
  }

  try {
    process.stderr.write(
      `Authorize MCP server ${serverId} in your browser:\n${url}\n`,
    );
  } catch {
    // Ignore terminal write failures and continue with the OAuth flow.
  }
}

async function createLoopbackCallbackServer(
  preferredRedirectUri?: string,
): Promise<{
  redirectUri: string;
  waitForCode: (state: string) => Promise<string>;
  close: () => Promise<void>;
}> {
  const preferred = preferredRedirectUri && isLoopbackRedirect(preferredRedirectUri)
    ? new URL(preferredRedirectUri)
    : undefined;
  const callbackPath = preferred?.pathname || CALLBACK_PATH;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let settled = false;
  const pendingCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    try {
      const parsed = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? '127.0.0.1'}`,
      );
      if (parsed.pathname !== callbackPath) {
        response.statusCode = 404;
        response.end('Not found.');
        return;
      }

      const code = parsed.searchParams.get('code');
      const state = parsed.searchParams.get('state');
      const error = parsed.searchParams.get('error');
      const errorDescription = parsed.searchParams.get('error_description');

      if (error) {
        response.statusCode = 400;
        response.end('OAuth authorization failed. You can close this window.');
        if (!settled) {
          settled = true;
          rejectCode(
            new Error(
              errorDescription?.trim()
                ? `${error}: ${errorDescription}`
                : error,
            ),
          );
        }
        return;
      }

      if (!code || !state) {
        response.statusCode = 400;
        response.end('Missing OAuth callback parameters. You can close this window.');
        if (!settled) {
          settled = true;
          rejectCode(new Error('OAuth callback was missing code/state.'));
        }
        return;
      }

      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('Artemis authorization complete. You can close this window.');
      if (!settled) {
        settled = true;
        resolveCode(`${state}::${code}`);
      }
    } catch (error) {
      response.statusCode = 500;
      response.end('OAuth callback handling failed. You can close this window.');
      if (!settled) {
        settled = true;
        rejectCode(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(
      preferred?.port ? Number(preferred.port) : 0,
      preferred?.hostname ?? '127.0.0.1',
      () => {
        server.off('error', reject);
        resolve();
      },
    );
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('OAuth callback server did not expose a TCP address.');
  }

  const redirectUri = preferred
    ? new URL(
        `${preferred.protocol}//${preferred.hostname}:${(address as AddressInfo).port}${callbackPath}`,
      ).toString()
    : `http://127.0.0.1:${(address as AddressInfo).port}${callbackPath}`;

  return {
    redirectUri,
    waitForCode: async (expectedState: string) => {
      const combined = await Promise.race([
        pendingCode,
        new Promise<string>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `OAuth callback timed out after ${Math.round(
                  OAUTH_CALLBACK_TIMEOUT_MS / 1_000,
                )} seconds.`,
              ),
            );
          }, OAUTH_CALLBACK_TIMEOUT_MS);
        }),
      ]);
      const [receivedState, code] = combined.split('::');
      if (receivedState !== expectedState) {
        throw new Error('OAuth callback state mismatch.');
      }
      return code;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }).catch(() => undefined);
    },
  };
}

function applyOAuthPatch(
  server: McpServerConfig,
  patch: Partial<McpOAuthConfig>,
  authState = server.authState,
  lastError?: string,
): McpServerConfig {
  return {
    ...server,
    oauth: {
      ...(server.oauth ?? {}),
      ...patch,
    },
    authState,
    lastError,
    lastCheckedAt: authState === 'configured' ? now() : server.lastCheckedAt,
    updatedAt: now(),
  };
}

export function clearMcpOAuthSession(server: McpServerConfig): McpServerConfig {
  if (server.authType !== 'oauth') {
    return server;
  }

  return {
    ...server,
    authState: 'unknown',
    lastError: undefined,
    runtime: undefined,
    oauth: server.oauth
      ? {
          ...server.oauth,
          accessToken: undefined,
          refreshToken: undefined,
          tokenType: undefined,
          expiresAt: undefined,
          lastRefreshAt: undefined,
        }
      : undefined,
    updatedAt: now(),
  };
}

export async function loginMcpOAuthServer(options: {
  cwd: string;
  data: { servers: McpServerConfig[] };
  server: McpServerConfig;
}): Promise<OAuthLoginResult> {
  const server = options.server;
  if (server.authType !== 'oauth') {
    throw new Error(`MCP server ${server.id} is not configured for OAuth.`);
  }

  if (!server.url) {
    throw new Error(`OAuth login for ${server.id} requires an HTTP or SSE MCP endpoint.`);
  }

  const metadata = await discoverOAuthMetadata(server);
  const callback = await createLoopbackCallbackServer(server.oauth?.redirectUri);
  try {
    const clientRegistration =
      server.oauth?.clientId
        ? {
            clientId: server.oauth.clientId,
            clientSecret: server.oauth.clientSecret,
            clientName: server.oauth.clientName,
          }
        : await registerDynamicClient({
            metadata,
            redirectUri: callback.redirectUri,
          });

    const state = createOAuthState();
    const verifier = createPkceVerifier();
    const challenge = createPkceChallenge(verifier);
    const authorizationUrl = new URL(metadata.authorizationUrl);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', clientRegistration.clientId);
    authorizationUrl.searchParams.set('redirect_uri', callback.redirectUri);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    if (server.oauth?.scopes && server.oauth.scopes.length > 0) {
      authorizationUrl.searchParams.set('scope', server.oauth.scopes.join(' '));
    }
    if (server.oauth?.audience) {
      authorizationUrl.searchParams.set('audience', server.oauth.audience);
    }
    if (server.oauth?.resource) {
      authorizationUrl.searchParams.set('resource', server.oauth.resource);
    }

    announceOAuthAuthorizationUrl(server.id, authorizationUrl.toString());
    const browserOpened = await openExternalUrl(authorizationUrl.toString());
    const code = await callback.waitForCode(state);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientRegistration.clientId,
      redirect_uri: callback.redirectUri,
      code_verifier: verifier,
    });
    if (clientRegistration.clientSecret) {
      body.set('client_secret', clientRegistration.clientSecret);
    }

    const tokens = await exchangeToken(metadata.tokenUrl, body);
    const updatedServer = applyOAuthPatch(
      server,
      {
        metadataUrl: metadata.metadataUrl ?? server.oauth?.metadataUrl,
        authorizationUrl: metadata.authorizationUrl,
        tokenUrl: metadata.tokenUrl,
        registrationUrl: metadata.registrationUrl,
        clientId: clientRegistration.clientId,
        clientSecret: clientRegistration.clientSecret,
        clientName: clientRegistration.clientName,
        redirectUri: callback.redirectUri,
        tokenType: tokens.tokenType,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? server.oauth?.refreshToken,
        expiresAt: tokens.expiresAt,
        registeredAt: server.oauth?.registeredAt ?? now(),
        lastRefreshAt: now(),
      },
      'configured',
      undefined,
    );

    return {
      server: updatedServer,
      authorizationUrl: authorizationUrl.toString(),
      browserOpened,
      message: browserOpened
        ? `OAuth login completed for ${server.id}.`
        : `OAuth login completed for ${server.id}. Browser auto-open failed, but the authorization URL was generated successfully.`,
    };
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    await callback.close();
  }
}

async function refreshMcpOAuthServer(options: {
  server: McpServerConfig;
}): Promise<McpServerConfig> {
  const server = options.server;
  if (server.authType !== 'oauth') {
    return server;
  }

  if (!server.oauth?.refreshToken) {
    throw new Error(
      `OAuth session for ${server.id} has no refresh token. Run ${buildMcpLoginCommand(server.id)} first.`,
    );
  }

  const metadata = await discoverOAuthMetadata(server);
  const clientId = server.oauth.clientId;
  if (!clientId) {
    throw new Error(
      `OAuth client registration is missing for ${server.id}. Run ${buildMcpLoginCommand(server.id)} first.`,
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: server.oauth.refreshToken,
    client_id: clientId,
  });
  if (server.oauth.clientSecret) {
    body.set('client_secret', server.oauth.clientSecret);
  }

  const tokens = await exchangeToken(metadata.tokenUrl, body);
  return applyOAuthPatch(
    server,
    {
      metadataUrl: metadata.metadataUrl ?? server.oauth.metadataUrl,
      authorizationUrl: metadata.authorizationUrl,
      tokenUrl: metadata.tokenUrl,
      registrationUrl: metadata.registrationUrl,
      tokenType: tokens.tokenType,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? server.oauth.refreshToken,
      expiresAt: tokens.expiresAt,
      lastRefreshAt: now(),
    },
    'configured',
    undefined,
  );
}

export async function ensureMcpOAuthAccessToken(options: {
  server: McpServerConfig;
}): Promise<OAuthAccessResolution> {
  const server = options.server;
  if (server.authType !== 'oauth') {
    throw new Error(`MCP server ${server.id} is not configured for OAuth.`);
  }

  if (!server.oauth?.accessToken && !server.oauth?.refreshToken) {
    throw new Error(
      `OAuth session for ${server.id} is not configured. Run ${buildMcpLoginCommand(server.id)} first.`,
    );
  }

  if (server.oauth?.accessToken && !shouldRefreshAccessToken(server.oauth.expiresAt)) {
    return {
      server,
      accessToken: server.oauth.accessToken,
    };
  }

  try {
    const refreshedServer = await refreshMcpOAuthServer({
      server,
    });
    if (!refreshedServer.oauth?.accessToken) {
      throw new Error(`OAuth refresh for ${server.id} returned no access token.`);
    }
    return {
      server: refreshedServer,
      accessToken: refreshedServer.oauth.accessToken,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      /invalid_grant|refresh token|expired/i.test(message)
        ? `OAuth session expired for ${server.id}. Run ${buildMcpLoginCommand(server.id)} again.`
        : message,
    );
  }
}

export async function persistMcpServerUpdate(options: {
  cwd: string;
  server: McpServerConfig;
}): Promise<McpServerConfig> {
  const store = new McpServerStore(options.cwd);
  const currentData = await store.load();
  const nextData = mergeServer(currentData, options.server);
  await store.save(nextData);
  return options.server;
}
