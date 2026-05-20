/**
 * Spotify token + preferences persistence.
 *
 * Stored at ~/.artemis/spotify.json. Holds the OAuth token bundle and any
 * user preferences (preferred device name, etc.). The actual access_token is
 * short-lived (1 hour); refresh_token is long-lived. We also store
 * client_id locally because each user must register their own Spotify
 * app at developer.spotify.com — this keeps Artemis from depending on a
 * shared API quota.
 */

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { resolveArtemisHomeDir } from '../../utils/fs.js';

export interface SpotifyAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  scope: string;
}

export interface SpotifyConfig {
  clientId?: string;
  redirectUri?: string;
  auth?: SpotifyAuth;
  preferredDevice?: {
    id: string;
    name: string;
    rememberedAt: string;
  };
  user?: {
    id: string;
    displayName?: string;
    email?: string;
  };
}

const STORE_PATH = path.join(resolveArtemisHomeDir(), 'spotify.json');
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/callback';

/** Default OAuth redirect URI used by Artemis for the local callback server. */
export function getRedirectUri(): string {
  return DEFAULT_REDIRECT_URI;
}

export async function loadSpotifyConfig(): Promise<SpotifyConfig> {
  try {
    const raw = await fsp.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as SpotifyConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') return {};
    console.warn(`[spotify] failed to load config from ${STORE_PATH}: ${(err as Error).message}`);
    return {};
  }
}

export async function saveSpotifyConfig(config: SpotifyConfig): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fsp.writeFile(STORE_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[spotify] failed to save config to ${STORE_PATH}: ${(err as Error).message}`);
  }
}

export async function clearSpotifyAuth(): Promise<void> {
  const cfg = await loadSpotifyConfig();
  delete cfg.auth;
  delete cfg.user;
  await saveSpotifyConfig(cfg);
}

export async function isAuthenticated(): Promise<boolean> {
  const cfg = await loadSpotifyConfig();
  return Boolean(cfg.auth?.refreshToken);
}

export async function getStorePath(): Promise<string> {
  return STORE_PATH;
}
