/**
 * Brain-callable Spotify tools. Each function takes a parsed AgentAction
 * and returns a uniform { ok, output, error? } result that brain.ts can
 * surface to the user / next round.
 *
 * Tools:
 *   spotify_play_liked       — Play user's Liked Songs (with optional shuffle)
 *   spotify_search_and_play  — Search by query, play first match
 *   spotify_play_playlist    — Play user's named playlist
 *   spotify_resume           — Resume current playback
 *   spotify_pause            — Pause playback
 *   spotify_skip_next        — Next track
 *   spotify_skip_previous    — Previous track
 *   spotify_set_volume       — Set volume (0-100)
 *   spotify_now_playing      — Get currently playing info
 *   spotify_set_device       — Transfer playback to a named device
 */

import {
  play,
  pause,
  skipNext,
  skipPrevious,
  setVolume,
  setShuffle,
  getCurrentlyPlaying,
  getLikedTracks,
  searchTracks,
  searchPlaylists,
  getMyPlaylists,
  transferPlayback,
  getDevices,
} from './client.js';
import { pickDevice, formatDeviceList } from './devices.js';
import { loadSpotifyConfig } from './store.js';

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
}

function notAuthenticatedError(): ToolResult {
  return {
    ok: false,
    output: 'Spotify 未登录。请先在 Artemis CLI 里跑 /spotify login 完成授权。',
    error: { code: 'spotify_not_authenticated', message: 'not authenticated' },
  };
}

function spotifyApiError(message: string, hint?: string): ToolResult {
  const lines = [`Spotify API 错误：${message}`];
  if (hint) lines.push(`提示：${hint}`);
  return {
    ok: false,
    output: lines.join('\n'),
    error: { code: 'spotify_api_error', message },
  };
}

async function ensureAuthenticated(): Promise<ToolResult | null> {
  const cfg = await loadSpotifyConfig();
  if (!cfg.auth?.refreshToken) return notAuthenticatedError();
  return null;
}

// ── spotify_play_liked ──────────────────────────────────────────────────

export interface SpotifyPlayLikedAction {
  type: 'spotify_play_liked';
  shuffle?: boolean;
  deviceHint?: string;
}

export async function executeSpotifyPlayLiked(
  action: SpotifyPlayLikedAction,
): Promise<ToolResult> {
  const authErr = await ensureAuthenticated();
  if (authErr) return authErr;

  // Liked Songs is the user's "tracks" library. There's no single context_uri
  // for it, so we fetch a batch of URIs and pass them in `uris`.
  const liked = await getLikedTracks(50);
  if (!liked.ok) return spotifyApiError(liked.error);
  const items = liked.data.items;
  if (items.length === 0) {
    return {
      ok: false,
      output: 'Your Liked Songs library is empty.',
      error: { code: 'spotify_empty_library', message: 'liked songs is empty' },
    };
  }

  const trackUris = items.map((it) => it.track.uri);

  const dev = await pickDevice(action.deviceHint, true);
  if (!dev.ok) return spotifyApiError(dev.error, dev.hint);

  // Optional shuffle (default on for "play liked" since the library is large)
  const shuffleState = action.shuffle ?? true;
  await setShuffle(shuffleState, dev.device.id).catch(() => undefined);

  const result = await play({ deviceId: dev.device.id, trackUris });
  if (!result.ok) return spotifyApiError(result.error);

  const total = liked.data.total;
  return {
    ok: true,
    output: [
      `▶ 正在播放 Liked Songs (${total} 首${shuffleState ? '，随机' : '，顺序'})`,
      `   设备：${dev.device.name}${dev.transferred ? ' (已切换)' : ''}`,
      `   首曲：${items[0]?.track.name ?? ''} — ${items[0]?.track.artists.map((a) => a.name).join(', ') ?? ''}`,
    ].join('\n'),
  };
}

// ── spotify_search_and_play ────────────────────────────────────────────

export interface SpotifySearchAndPlayAction {
  type: 'spotify_search_and_play';
  query: string;
  kind?: 'track' | 'playlist' | 'auto';
  deviceHint?: string;
}

export async function executeSpotifySearchAndPlay(
  action: SpotifySearchAndPlayAction,
): Promise<ToolResult> {
  const authErr = await ensureAuthenticated();
  if (authErr) return authErr;

  const kind = action.kind ?? 'auto';
  let firstTrackInfo = '';
  let contextUri: string | undefined;
  let trackUris: string[] | undefined;

  if (kind === 'playlist' || kind === 'auto') {
    const pl = await searchPlaylists(action.query, 1);
    if (!pl.ok) return spotifyApiError(pl.error);
    const found = pl.data.playlists.items[0];
    if (found) {
      contextUri = found.uri;
      firstTrackInfo = `歌单：${found.name} (${found.tracks.total} 首)`;
    }
  }

  if (!contextUri && (kind === 'track' || kind === 'auto')) {
    const tr = await searchTracks(action.query, 1);
    if (!tr.ok) return spotifyApiError(tr.error);
    const track = tr.data.tracks.items[0];
    if (track) {
      trackUris = [track.uri];
      firstTrackInfo = `单曲：${track.name} — ${track.artists.map((a) => a.name).join(', ')}`;
    }
  }

  if (!contextUri && !trackUris) {
    return {
      ok: false,
      output: `搜索 "${action.query}" 没有结果。`,
      error: { code: 'spotify_no_results', message: 'no search results' },
    };
  }

  const dev = await pickDevice(action.deviceHint, true);
  if (!dev.ok) return spotifyApiError(dev.error, dev.hint);

  const result = await play({ deviceId: dev.device.id, contextUri, trackUris });
  if (!result.ok) return spotifyApiError(result.error);

  return {
    ok: true,
    output: [
      `▶ 正在播放 "${action.query}"`,
      `   ${firstTrackInfo}`,
      `   设备：${dev.device.name}${dev.transferred ? ' (已切换)' : ''}`,
    ].join('\n'),
  };
}

// ── spotify_play_playlist ──────────────────────────────────────────────

export interface SpotifyPlayPlaylistAction {
  type: 'spotify_play_playlist';
  name: string;
  deviceHint?: string;
}

export async function executeSpotifyPlayPlaylist(
  action: SpotifyPlayPlaylistAction,
): Promise<ToolResult> {
  const authErr = await ensureAuthenticated();
  if (authErr) return authErr;

  // Prefer user's own playlists first (better match for "my chill playlist")
  const mine = await getMyPlaylists(50);
  if (!mine.ok) return spotifyApiError(mine.error);

  const needle = action.name.toLowerCase();
  let match = mine.data.items.find((p) => p.name.toLowerCase() === needle);
  if (!match) match = mine.data.items.find((p) => p.name.toLowerCase().includes(needle));

  // Fall back to public search
  if (!match) {
    const search = await searchPlaylists(action.name, 1);
    if (!search.ok) return spotifyApiError(search.error);
    match = search.data.playlists.items[0];
  }

  if (!match) {
    return {
      ok: false,
      output: `没找到名为 "${action.name}" 的歌单（你的 + 公开都搜过了）。`,
      error: { code: 'spotify_playlist_not_found', message: 'playlist not found' },
    };
  }

  const dev = await pickDevice(action.deviceHint, true);
  if (!dev.ok) return spotifyApiError(dev.error, dev.hint);

  const result = await play({ deviceId: dev.device.id, contextUri: match.uri });
  if (!result.ok) return spotifyApiError(result.error);

  return {
    ok: true,
    output: [
      `▶ 正在播放歌单：${match.name} (${match.tracks.total} 首)`,
      `   设备：${dev.device.name}${dev.transferred ? ' (已切换)' : ''}`,
    ].join('\n'),
  };
}

// ── spotify_resume ─────────────────────────────────────────────────────

export interface SpotifyResumeAction {
  type: 'spotify_resume';
  deviceHint?: string;
}

export async function executeSpotifyResume(
  action: SpotifyResumeAction,
): Promise<ToolResult> {
  const authErr = await ensureAuthenticated();
  if (authErr) return authErr;

  const dev = await pickDevice(action.deviceHint, true);
  if (!dev.ok) return spotifyApiError(dev.error, dev.hint);

  const result = await play({ deviceId: dev.device.id });
  if (!result.ok) return spotifyApiError(result.error);

  return { ok: true, output: `▶ 已恢复播放（${dev.device.name}）` };
}

// ── spotify_pause ──────────────────────────────────────────────────────

export interface SpotifyPauseAction {
  type: 'spotify_pause';
}

export async function executeSpotifyPause(
  _action: SpotifyPauseAction,
): Promise<ToolResult> {
  const authErr = await ensureAuthenticated();
  if (authErr) return authErr;

  const result = await pause();
  if (!result.ok) return spotifyApiError(result.error);
  return { ok: true, output: '⏸ 已暂停' };
}

// ── spotify_skip_next ──────────────────────────────────────────────────

export interface SpotifySkipNextAction {
  type: 'spotify_skip_next';
}

export async function executeSpotifySkipNext(
  _action: SpotifySkipNextAction,
): Promise<ToolResult> {
  const authErr = await ensureAuthenticated();
  if (authErr) return authErr;

  const result = await skipNext();
  if (!result.ok) return spotifyApiError(result.error);
  return { ok: true, output: '⏭ 下一首' };
}

// ── spotify_skip_previous ──────────────────────────────────────────────

export interface SpotifySkipPreviousAction {
  type: 'spotify_skip_previous';
}

export async function executeSpotifySkipPrevious(
  _action: SpotifySkipPreviousAction,
): Promise<ToolResult> {
  const authErr = await ensureAuthenticated();
  if (authErr) return authErr;

  const result = await skipPrevious();
  if (!result.ok) return spotifyApiError(result.error);
  return { ok: true, output: '⏮ 上一首' };
}

// ── spotify_set_volume ─────────────────────────────────────────────────

export interface SpotifySetVolumeAction {
  type: 'spotify_set_volume';
  volume: number; // 0-100
}

export async function executeSpotifySetVolume(
  action: SpotifySetVolumeAction,
): Promise<ToolResult> {
  const authErr = await ensureAuthenticated();
  if (authErr) return authErr;

  const result = await setVolume(action.volume);
  if (!result.ok) return spotifyApiError(result.error);
  return { ok: true, output: `🔊 音量调到 ${Math.max(0, Math.min(100, Math.round(action.volume)))}%` };
}

// ── spotify_now_playing ────────────────────────────────────────────────

export interface SpotifyNowPlayingAction {
  type: 'spotify_now_playing';
}

export async function executeSpotifyNowPlaying(
  _action: SpotifyNowPlayingAction,
): Promise<ToolResult> {
  const authErr = await ensureAuthenticated();
  if (authErr) return authErr;

  const result = await getCurrentlyPlaying();
  if (!result.ok) return spotifyApiError(result.error);
  if (!result.data.item) {
    return { ok: true, output: '当前没有播放任何内容。' };
  }
  const t = result.data.item;
  const status = result.data.is_playing ? '▶' : '⏸';
  const lines = [
    `${status} ${t.name} — ${t.artists.map((a) => a.name).join(', ')}`,
    `   专辑：${t.album.name}`,
  ];
  if (result.data.device) {
    lines.push(`   设备：${result.data.device.name}`);
  }
  return { ok: true, output: lines.join('\n') };
}

// ── spotify_set_device ─────────────────────────────────────────────────

export interface SpotifySetDeviceAction {
  type: 'spotify_set_device';
  deviceHint: string;
  startPlaying?: boolean;
}

export async function executeSpotifySetDevice(
  action: SpotifySetDeviceAction,
): Promise<ToolResult> {
  const authErr = await ensureAuthenticated();
  if (authErr) return authErr;

  const devs = await getDevices();
  if (!devs.ok) return spotifyApiError(devs.error);

  const needle = action.deviceHint.toLowerCase();
  const match = devs.data.devices.find((d) => d.name.toLowerCase().includes(needle));
  if (!match) {
    return {
      ok: false,
      output: [
        `没找到匹配 "${action.deviceHint}" 的设备。`,
        '可用设备：',
        formatDeviceList(devs.data.devices),
      ].join('\n'),
      error: { code: 'spotify_device_not_found', message: 'device not found' },
    };
  }

  const result = await transferPlayback(match.id, action.startPlaying ?? false);
  if (!result.ok) return spotifyApiError(result.error);

  return {
    ok: true,
    output: `🎧 播放已切换到 ${match.name}${action.startPlaying ? ' 并开始播放' : ''}`,
  };
}
