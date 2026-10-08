/**
 * tools/platformSupport.ts — host capability checks for tool exposure
 *
 * Some tools only work on a particular OS (Apple Calendar/Reminders via
 * osascript, screen/keyboard control). On other hosts, such as a headless
 * Linux server, those tools can only fail, so they are not offered to the
 * model there. The tool implementations keep their own platform guards; this
 * module decides what gets advertised. It also decides whether the Playwright
 * browser runs headed or headless on this host.
 *
 * The host can be overridden for tests via withToolHostEnvironment(), so smoke
 * tests never need to mutate process.platform.
 */

export type ToolHostRequirement =
  /** macOS only (osascript / Apple apps). */
  | 'macos'
  /** Native desktop automation backends: macOS or Windows. */
  | 'desktop-automation';

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
  // spotify_* tools are deliberately not listed: they drive the Spotify Web
  // API (Spotify Connect), so a headless server can still control the user's
  // phone or speakers once logged in.
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

/**
 * Parse a boolean-ish environment value. Accepts 1/true/yes/on and
 * 0/false/no/off (case-insensitive, surrounding whitespace ignored); anything
 * else, including an unset or empty value, returns undefined.
 */
export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

export interface BrowserLaunchMode {
  headless: boolean;
  /** Extra Chromium arguments needed for this host (e.g. native Wayland). */
  extraArgs: string[];
}

/**
 * Decide how the Playwright browser launches on this host.
 *
 * Headed by default where a display exists; headless without one (a headed
 * launch can only fail there). ARTEMIS_BROWSER_HEADLESS overrides either way
 * (1/true/yes forces headless, 0/false/no forces headed). On Linux with only
 * WAYLAND_DISPLAY set (no XWayland DISPLAY), a headed Chromium needs the
 * native Wayland backend, so --ozone-platform=wayland is added.
 */
export function resolveBrowserLaunchMode(
  host: ToolHostEnvironment = getToolHostEnvironment(),
  env: NodeJS.ProcessEnv = process.env,
): BrowserLaunchMode {
  const forced = parseBooleanEnv(env.ARTEMIS_BROWSER_HEADLESS);
  const headless = forced ?? !host.hasDisplay;
  const waylandOnly =
    host.platform === 'linux' &&
    !env.DISPLAY?.trim() &&
    Boolean(env.WAYLAND_DISPLAY?.trim());
  return {
    headless,
    extraArgs: !headless && waylandOnly ? ['--ozone-platform=wayland'] : [],
  };
}
