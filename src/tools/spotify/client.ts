/**
 * Spotify Web API HTTP client.
 *
 * Thin wrapper around fetch that:
 *   - Auto-refreshes expired access tokens before each call
 *   - Uniform error shape
 *   - Handles empty 204 responses (most playback control endpoints return 204)
 *   - Retries once on 401 (token stale despite our cache)
 */

import { getValidAccessToken } from './oauth.js';

const API_BASE = 'https://api.spotify.com/v1';

export interface SpotifyApiOk<T> {
  ok: true;
  data: T;
}

export interface SpotifyApiErr {
  ok: false;
  status?: number;
  error: string;
}

export type SpotifyApiResult<T> = SpotifyApiOk<T> | SpotifyApiErr;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

async function rawRequest<T = unknown>(
  endpoint: string,
  token: string,
  opts: RequestOptions = {},
): Promise<{ status: number; body: T | null; text?: string }> {
  let url = `${API_BASE}${endpoint}`;
  if (opts.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined) continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const resp = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body,
  });

  // Most playback endpoints return 204 No Content on success
  if (resp.status === 204 || resp.status === 202) {
    return { status: resp.status, body: null };
  }

  const text = await resp.text();
  if (!text) return { status: resp.status, body: null };

  try {
    return { status: resp.status, body: JSON.parse(text) as T };
  } catch {
    return { status: resp.status, body: null, text };
  }
}

/**
 * Make an authenticated Spotify API request with automatic token handling
 * and a single retry on 401.
 */
export async function spotifyApi<T = unknown>(
  endpoint: string,
  opts: RequestOptions = {},
): Promise<SpotifyApiResult<T>> {
  const tokenResult = await getValidAccessToken();
  if (!tokenResult.ok) {
    return { ok: false, error: tokenResult.error };
  }

  const result = await rawRequest<T>(endpoint, tokenResult.token, opts);

  if (result.status === 401) {
    // Token rejected despite being non-expired in our cache — force a fresh one
    const refreshed = await getValidAccessToken();
    if (!refreshed.ok) return { ok: false, status: 401, error: refreshed.error };
    const retry = await rawRequest<T>(endpoint, refreshed.token, opts);
    if (retry.status >= 200 && retry.status < 300) {
      return { ok: true, data: (retry.body ?? ({} as T)) };
    }
    return {
      ok: false,
      status: retry.status,
      error: retry.text ?? `HTTP ${retry.status}`,
    };
  }

  if (result.status >= 200 && result.status < 300) {
    return { ok: true, data: (result.body ?? ({} as T)) };
  }

  // Spotify error responses include { error: { status, message } }
  const body = result.body as { error?: { status?: number; message?: string } } | null;
  const message = body?.error?.message ?? result.text ?? `HTTP ${result.status}`;
  return { ok: false, status: result.status, error: message };
}

// ── Convenience typed wrappers for the endpoints we actually use ──────────

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
  supports_volume: boolean;
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album: { id: string; name: string };
  duration_ms: number;
}

export interface SpotifyPlaylist {
  id: string;
  uri: string;
  name: string;
  owner: { id: string; display_name?: string };
  tracks: { total: number };
}

export async function getDevices(): Promise<SpotifyApiResult<{ devices: SpotifyDevice[] }>> {
  return spotifyApi<{ devices: SpotifyDevice[] }>('/me/player/devices');
}

export async function getCurrentlyPlaying(): Promise<
  SpotifyApiResult<{ is_playing: boolean; item?: SpotifyTrack; device?: SpotifyDevice }>
> {
  return spotifyApi('/me/player');
}

export async function getLikedTracks(limit = 50, offset = 0): Promise<
  SpotifyApiResult<{ items: Array<{ track: SpotifyTrack }>; total: number; next: string | null }>
> {
  return spotifyApi('/me/tracks', { query: { limit, offset } });
}

export async function searchTracks(
  query: string,
  limit = 5,
): Promise<SpotifyApiResult<{ tracks: { items: SpotifyTrack[] } }>> {
  return spotifyApi('/search', { query: { q: query, type: 'track', limit } });
}

export async function searchPlaylists(
  query: string,
  limit = 5,
): Promise<SpotifyApiResult<{ playlists: { items: SpotifyPlaylist[] } }>> {
  return spotifyApi('/search', { query: { q: query, type: 'playlist', limit } });
}

export async function getMyPlaylists(
  limit = 50,
): Promise<SpotifyApiResult<{ items: SpotifyPlaylist[] }>> {
  return spotifyApi('/me/playlists', { query: { limit } });
}

export async function play(args: {
  deviceId?: string;
  contextUri?: string;
  trackUris?: string[];
  positionMs?: number;
}): Promise<SpotifyApiResult<null>> {
  const query: Record<string, string> = {};
  if (args.deviceId) query.device_id = args.deviceId;
  const body: Record<string, unknown> = {};
  if (args.contextUri) body.context_uri = args.contextUri;
  if (args.trackUris) body.uris = args.trackUris;
  if (args.positionMs !== undefined) body.position_ms = args.positionMs;
  return spotifyApi('/me/player/play', {
    method: 'PUT',
    query,
    body: Object.keys(body).length > 0 ? body : undefined,
  });
}

export async function pause(deviceId?: string): Promise<SpotifyApiResult<null>> {
  return spotifyApi('/me/player/pause', {
    method: 'PUT',
    query: deviceId ? { device_id: deviceId } : undefined,
  });
}

export async function skipNext(deviceId?: string): Promise<SpotifyApiResult<null>> {
  return spotifyApi('/me/player/next', {
    method: 'POST',
    query: deviceId ? { device_id: deviceId } : undefined,
  });
}

export async function skipPrevious(deviceId?: string): Promise<SpotifyApiResult<null>> {
  return spotifyApi('/me/player/previous', {
    method: 'POST',
    query: deviceId ? { device_id: deviceId } : undefined,
  });
}

export async function setVolume(percent: number, deviceId?: string): Promise<SpotifyApiResult<null>> {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return spotifyApi('/me/player/volume', {
    method: 'PUT',
    query: deviceId ? { volume_percent: clamped, device_id: deviceId } : { volume_percent: clamped },
  });
}

export async function setShuffle(state: boolean, deviceId?: string): Promise<SpotifyApiResult<null>> {
  return spotifyApi('/me/player/shuffle', {
    method: 'PUT',
    query: deviceId ? { state, device_id: deviceId } : { state },
  });
}

export async function transferPlayback(deviceId: string, play = false): Promise<SpotifyApiResult<null>> {
  return spotifyApi('/me/player', {
    method: 'PUT',
    body: { device_ids: [deviceId], play },
  });
}
