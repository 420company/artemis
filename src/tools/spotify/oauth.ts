/**
 * Spotify OAuth 2.0 PKCE flow.
 *
 * Why PKCE: works without a client secret, safe for installed CLIs.
 * Flow:
 *   1. Generate code_verifier (random) + code_challenge (sha256 of verifier)
 *   2. Open browser to Spotify authorize URL with code_challenge
 *   3. User logs in + approves → Spotify redirects to http://127.0.0.1:8888/callback?code=xxx
 *   4. Local server captures code, exchanges it for tokens with code_verifier
 *   5. Save tokens to ~/.artemis/spotify.json
 *
 * Refresh: access_token expires in 1 hour. refresh_token gets a fresh access
 * token without re-prompting. Spotify's refresh tokens may rotate (new
 * refresh_token returned occasionally) — we handle both cases.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import { exec } from 'node:child_process';
import {
  loadSpotifyConfig,
  saveSpotifyConfig,
  getRedirectUri,
  type SpotifyAuth,
  type SpotifyConfig,
} from './store.js';

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const REQUIRED_SCOPES = [
  'user-library-read',
  'user-modify-playback-state',
  'user-read-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-email',
].join(' ');

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(64));
}

function generateCodeChallenge(verifier: string): string {
  return base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
}

function openBrowser(url: string): void {
  // Cross-platform browser launch
  const opener =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(opener, (err) => {
    if (err) {
      console.warn(`[spotify] couldn't auto-open browser; please visit:\n${url}`);
    }
  });
}

interface AuthResult {
  ok: true;
  config: SpotifyConfig;
}

interface AuthError {
  ok: false;
  error: string;
}

/**
 * Run the full OAuth login flow. Spawns a local callback server, opens the
 * browser, waits for the redirect, exchanges the code, persists tokens.
 *
 * Caller passes Client ID. If user has registered their own Spotify app at
 * developer.spotify.com, they pass that ID here. Redirect URI must match
 * what they configured (default http://127.0.0.1:8888/callback).
 */
export async function loginSpotify(clientId: string): Promise<AuthResult | AuthError> {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = base64UrlEncode(crypto.randomBytes(16));
  const redirectUri = getRedirectUri();

  const authUrl = new URL(SPOTIFY_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', REQUIRED_SCOPES);

  // Spawn local server to capture redirect
  const codePromise = new Promise<{ code: string; state: string } | { error: string }>((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const errorParam = url.searchParams.get('error');

        if (errorParam) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildResponseHtml('授权失败 / Authorization failed', errorParam, false));
          server.close();
          resolve({ error: errorParam });
          return;
        }

        if (!code || !returnedState) {
          res.writeHead(400);
          res.end('Missing code or state');
          return;
        }

        if (returnedState !== state) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildResponseHtml('CSRF state 不匹配 / state mismatch', '可能是 CSRF 攻击，已拒绝。', false));
          server.close();
          resolve({ error: 'state mismatch — possible CSRF, rejected' });
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildResponseHtml('Spotify 已连接 ✓', '可以关闭这个窗口回到 Artemis 终端了。', true));
        server.close();
        resolve({ code, state: returnedState });
      } catch (err) {
        res.writeHead(500);
        res.end('Internal error');
        server.close();
        resolve({ error: (err as Error).message });
      }
    });

    server.on('error', (err) => {
      if ((err as { code?: string }).code === 'EADDRINUSE') {
        resolve({ error: 'Port 8888 is already in use. Close any other process listening on http://127.0.0.1:8888 and try again.' });
      } else {
        resolve({ error: err.message });
      }
    });

    server.listen(8888, '127.0.0.1', () => {
      // Server up — open browser
      openBrowser(authUrl.toString());
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      resolve({ error: 'login timed out after 5 minutes' });
    }, 5 * 60_000);
  });

  const result = await codePromise;
  if ('error' in result) return { ok: false, error: result.error };

  // Exchange code for tokens
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: result.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    const resp = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `token exchange failed (${resp.status}): ${text}` };
    }
    const json = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };

    const auth: SpotifyAuth = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in - 60) * 1000, // 60s safety buffer
      scope: json.scope,
    };

    // Fetch user profile so we can show "logged in as ..."
    let user: SpotifyConfig['user'] | undefined;
    try {
      const meResp = await fetch('https://api.spotify.com/v1/me', {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (meResp.ok) {
        const me = (await meResp.json()) as { id: string; display_name?: string; email?: string };
        user = { id: me.id, displayName: me.display_name, email: me.email };
      }
    } catch {
      /* non-fatal */
    }

    const cfg = await loadSpotifyConfig();
    const updated: SpotifyConfig = {
      ...cfg,
      clientId,
      redirectUri,
      auth,
      user,
    };
    await saveSpotifyConfig(updated);
    return { ok: true, config: updated };
  } catch (err) {
    return { ok: false, error: `token exchange threw: ${(err as Error).message}` };
  }
}

/**
 * Refresh the access token using the stored refresh_token. Updates the
 * config in place. Returns the new auth bundle.
 */
export async function refreshSpotifyToken(): Promise<{ ok: true; auth: SpotifyAuth } | { ok: false; error: string }> {
  const cfg = await loadSpotifyConfig();
  if (!cfg.auth?.refreshToken || !cfg.clientId) {
    return { ok: false, error: 'not authenticated — run /spotify login first' };
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.auth.refreshToken,
      client_id: cfg.clientId,
    });
    const resp = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `refresh failed (${resp.status}): ${text}` };
    }
    const json = (await resp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    };

    const newAuth: SpotifyAuth = {
      accessToken: json.access_token,
      // Spotify may rotate the refresh token; if not returned, keep the old one.
      refreshToken: json.refresh_token ?? cfg.auth.refreshToken,
      expiresAt: Date.now() + (json.expires_in - 60) * 1000,
      scope: json.scope || cfg.auth.scope,
    };
    cfg.auth = newAuth;
    await saveSpotifyConfig(cfg);
    return { ok: true, auth: newAuth };
  } catch (err) {
    return { ok: false, error: `refresh threw: ${(err as Error).message}` };
  }
}

/**
 * Get a valid access token, refreshing if needed. This is the function the
 * Web API client calls before every request.
 */
export async function getValidAccessToken(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const cfg = await loadSpotifyConfig();
  if (!cfg.auth) {
    return { ok: false, error: 'not authenticated — run /spotify login first' };
  }
  if (cfg.auth.expiresAt > Date.now() + 30_000) {
    return { ok: true, token: cfg.auth.accessToken };
  }
  const refreshed = await refreshSpotifyToken();
  if (!refreshed.ok) return refreshed;
  return { ok: true, token: refreshed.auth.accessToken };
}

function buildResponseHtml(title: string, body: string, success: boolean): string {
  const color = success ? '#1DB954' : '#E22134';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 60px 40px; background: #121212; color: #fff; }
  .card { max-width: 480px; margin: 0 auto; background: #1f1f1f; border-radius: 12px; padding: 40px; text-align: center; }
  h1 { color: ${color}; margin-bottom: 16px; }
  p { color: #b3b3b3; line-height: 1.5; }
  .footer { margin-top: 32px; font-size: 13px; color: #666; }
</style></head><body><div class="card">
<h1>${title}</h1>
<p>${body}</p>
<div class="footer">Artemis · 420.COMPANY</div>
</div></body></html>`;
}
