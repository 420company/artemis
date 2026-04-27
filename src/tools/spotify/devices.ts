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
 * Auto-wake: if no devices are available at all (Spotify app closed on every
 * device the user owns), we try to launch Spotify on the local machine — the
 * one running Artemis. Once Spotify is up, it joins Spotify Connect within
 * a few seconds, and we poll for its appearance before giving up.
 *
 * This is what makes the "send 'play music' from phone, walk in to music
 * already playing" use case work even when the home Mac was idle.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getDevices, type SpotifyDevice, transferPlayback } from './client.js';
import { loadSpotifyConfig, saveSpotifyConfig } from './store.js';

const execAsync = promisify(exec);

/**
 * Launch the local Spotify desktop app. Cross-platform; best-effort. Returns
 * true if a launch command was successfully invoked. Note: the app needs a
 * few seconds to register with Spotify Connect after launching.
 */
async function launchLocalSpotify(): Promise<{ ok: boolean; method: string; error?: string }> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      // macOS — `tell application "Spotify" to activate` both launches AND
      // brings to foreground, which is what triggers Connect registration.
      await execAsync(`osascript -e 'tell application "Spotify" to activate'`, { timeout: 8000 });
      return { ok: true, method: 'osascript activate' };
    }
    if (platform === 'win32') {
      // Windows — spotify: URI scheme is the standard launcher.
      await execAsync('start spotify:', { timeout: 8000 });
      return { ok: true, method: 'start spotify:' };
    }
    // Linux — try common installation paths
    try {
      await execAsync('spotify --no-zygote --no-sandbox &', { timeout: 8000 });
      return { ok: true, method: 'spotify' };
    } catch {
      // try flatpak fallback
      await execAsync('flatpak run com.spotify.Client &', { timeout: 8000 });
      return { ok: true, method: 'flatpak' };
    }
  } catch (err) {
    return { ok: false, method: 'unknown', error: (err as Error).message };
  }
}

/**
 * Poll getDevices() until we see at least one device or timeout. Used after
 * launching Spotify locally — the app needs a moment to register with
 * Spotify Connect before its device shows up in the API response.
 */
async function waitForDevice(maxWaitMs = 12_000, intervalMs = 1500): Promise<SpotifyDevice[]> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const result = await getDevices();
    if (result.ok && result.data.devices.length > 0) {
      return result.data.devices;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return [];
}

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

  let devices = result.data.devices;

  // No devices online anywhere (every Spotify app the user has is closed).
  // Try to wake up the local Spotify desktop app — the most likely place to
  // play in an "I'm coming home" ambient-agent scenario. If launch succeeds,
  // poll for it to register with Spotify Connect.
  if (devices.length === 0) {
    const launch = await launchLocalSpotify();
    if (launch.ok) {
      devices = await waitForDevice();
    }
  }

  if (devices.length === 0) {
    return {
      ok: false,
      error: 'no Spotify devices available (auto-launch attempted)',
      hint: '本机自动拉起 Spotify 失败或注册超时。请确认这台电脑上已安装 Spotify 桌面 app 并已登录你的账户。手机/网页播放器也可以——只要让某台设备的 Spotify 在线即可。',
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
