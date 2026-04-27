/**
 * Smart device selection.
 *
 * When user sends "play music" without specifying a device, we pick the most
 * sensible one. Priority:
 *   1. Explicit `deviceHint` in the call (user said "play on living room speaker")
 *   2. The currently active device (if any)
 *   3. The user's preferred device (remembered from last successful play)
 *   4. The first available device in the list
 *
 * If no devices are returned at all, the user has no Spotify session open
 * anywhere — return an error suggesting they open Spotify on a device.
 */

import { getDevices, type SpotifyDevice, transferPlayback } from './client.js';
import { loadSpotifyConfig, saveSpotifyConfig } from './store.js';

export interface DevicePickResult {
  ok: true;
  device: SpotifyDevice;
  /** True if we transferred playback to this device (was inactive). */
  transferred: boolean;
}

export interface DevicePickError {
  ok: false;
  error: string;
  hint?: string;
}

/**
 * Pick the best device for playback. Optionally transfers playback to it
 * if it isn't already active.
 *
 * @param deviceHint  Optional substring or device name to prefer
 * @param autoTransfer Whether to transfer playback (true for play actions,
 *                     false for read-only ops like getCurrentlyPlaying)
 */
export async function pickDevice(
  deviceHint?: string,
  autoTransfer = true,
): Promise<DevicePickResult | DevicePickError> {
  const result = await getDevices();
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const devices = result.data.devices;
  if (devices.length === 0) {
    return {
      ok: false,
      error: 'no Spotify devices available',
      hint: '请在某台设备上打开 Spotify（手机 / 桌面 app / 网页播放器），让它出现在 Spotify Connect 设备列表里。',
    };
  }

  let chosen: SpotifyDevice | undefined;

  // Step 1: explicit hint match (substring, case-insensitive)
  if (deviceHint && deviceHint.trim().length > 0) {
    const needle = deviceHint.trim().toLowerCase();
    chosen = devices.find((d) => d.name.toLowerCase().includes(needle));
    if (!chosen) {
      return {
        ok: false,
        error: `no device matching "${deviceHint}" — available: ${devices.map((d) => d.name).join(', ')}`,
      };
    }
  }

  // Step 2: currently active device
  if (!chosen) {
    chosen = devices.find((d) => d.is_active);
  }

  // Step 3: previously preferred device (remembered from last successful play)
  if (!chosen) {
    const cfg = await loadSpotifyConfig();
    if (cfg.preferredDevice) {
      chosen = devices.find(
        (d) =>
          d.id === cfg.preferredDevice?.id ||
          d.name.toLowerCase() === cfg.preferredDevice?.name.toLowerCase(),
      );
    }
  }

  // Step 4: first available
  if (!chosen) {
    chosen = devices[0];
  }

  if (!chosen) {
    // Defensive: should never reach here given the empty-list guard above
    return { ok: false, error: 'device selection failed unexpectedly' };
  }

  // Auto-transfer if needed
  let transferred = false;
  if (autoTransfer && !chosen.is_active && !chosen.is_restricted) {
    const transferResult = await transferPlayback(chosen.id, false);
    if (transferResult.ok) {
      transferred = true;
      // Spotify needs a moment for the transfer to register before play()
      await new Promise((r) => setTimeout(r, 400));
    }
    // If transfer fails, fall through and let the caller try play() with
    // device_id directly — that often works.
  }

  // Remember this as the preferred device
  await rememberDevice(chosen);

  return { ok: true, device: chosen, transferred };
}

async function rememberDevice(device: SpotifyDevice): Promise<void> {
  const cfg = await loadSpotifyConfig();
  cfg.preferredDevice = {
    id: device.id,
    name: device.name,
    rememberedAt: new Date().toISOString(),
  };
  await saveSpotifyConfig(cfg);
}

/**
 * Format a device list for display in error messages or hints.
 */
export function formatDeviceList(devices: SpotifyDevice[]): string {
  if (devices.length === 0) return '(none)';
  return devices
    .map((d) => `${d.is_active ? '▶ ' : '  '}${d.name} [${d.type}]`)
    .join('\n');
}
