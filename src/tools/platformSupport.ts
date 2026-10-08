/**
 * tools/platformSupport.ts — host capability checks for tool exposure
 *
 * Some tools only work on a particular OS or need an interactive desktop
 * session (Apple Calendar/Reminders via osascript, screen/keyboard control,
 * Spotify desktop playback). On a headless Linux server those tools can only
 * fail, so they are not offered to the model there. The tool implementations
 * keep their own platform guards; this module decides what gets advertised.
 *
 * The host can be overridden for tests via withToolHostEnvironment(), so smoke
 * tests never need to mutate process.platform.
 */

export type ToolHostRequirement =
  /** macOS only (osascript / Apple apps). */
  | 'macos'
  /** Native desktop automation backends: macOS or Windows. */
  | 'desktop-automation'
  /** Any interactive desktop session (macOS, Windows, or Linux with a display). */
  | 'desktop-session';

export interface ToolHostEnvironment {
  platform: NodeJS.Platform;
  hasDisplay: boolean;
}

const TOOL_HOST_REQUIREMENTS: ReadonlyArray<{
  prefix: string;
  requirement: ToolHostRequirement;
}> = [
  { prefix: 'calendar_', requirement: 'macos' },
  { prefix: 'reminders_', requirement: 'macos' },
  { prefix: 'computer_', requirement: 'desktop-automation' },
  // Spotify needs a local browser for the OAuth login and a desktop player
  // to control; neither exists on a headless server.
  { prefix: 'spotify_', requirement: 'desktop-session' },
];

let hostOverride: ToolHostEnvironment | undefined;

export function detectToolHostEnvironment(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ToolHostEnvironment {
  const hasDisplay =
    platform === 'darwin' ||
    platform === 'win32' ||
    Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
  return { platform, hasDisplay };
}

export function getToolHostEnvironment(): ToolHostEnvironment {
  return hostOverride ?? detectToolHostEnvironment();
}

/** Stable key for caches that depend on the host environment. */
export function getToolHostKey(host: ToolHostEnvironment = getToolHostEnvironment()): string {
  return `${host.platform}:${host.hasDisplay ? 'display' : 'headless'}`;
}

/**
 * Run `fn` with a forced host environment (tests only). The override is
 * restored afterwards even if `fn` throws. Synchronous on purpose so the
 * override cannot leak across unrelated awaits.
 */
export function withToolHostEnvironment<T>(host: ToolHostEnvironment, fn: () => T): T {
  const previous = hostOverride;
  hostOverride = host;
  try {
    return fn();
  } finally {
    hostOverride = previous;
  }
}

export function getToolHostRequirement(toolType: string): ToolHostRequirement | undefined {
  return TOOL_HOST_REQUIREMENTS.find((entry) => toolType.startsWith(entry.prefix))?.requirement;
}

export function isHostRequirementMet(
  requirement: ToolHostRequirement | undefined,
  host: ToolHostEnvironment = getToolHostEnvironment(),
): boolean {
  switch (requirement) {
    case undefined:
      return true;
    case 'macos':
      return host.platform === 'darwin';
    case 'desktop-automation':
      return host.platform === 'darwin' || host.platform === 'win32';
    case 'desktop-session':
      return host.hasDisplay;
    default: {
      const exhaustive: never = requirement;
      return Boolean(exhaustive);
    }
  }
}

/** Whether a tool can work on the current (or given) host. */
export function isToolSupportedOnHost(
  toolType: string,
  host: ToolHostEnvironment = getToolHostEnvironment(),
): boolean {
  return isHostRequirementMet(getToolHostRequirement(toolType), host);
}
