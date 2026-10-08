const DEFAULT_VIDEO_DURATION = 5;
const MIN_VIDEO_DURATION = 1;
const MAX_VIDEO_DURATION = 60;
const BYTEPLUS_SEEDANCE_2_MIN_DURATION = 4;
const BYTEPLUS_SEEDANCE_2_MAX_DURATION = 15;
const BYTEPLUS_SEEDANCE_1_5_MIN_DURATION = 4;
const BYTEPLUS_SEEDANCE_1_5_MAX_DURATION = 12;

export function sanitizeVideoDuration(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_VIDEO_DURATION;
  const n = Math.floor(raw);
  if (n < MIN_VIDEO_DURATION) return MIN_VIDEO_DURATION;
  if (n > MAX_VIDEO_DURATION) return MAX_VIDEO_DURATION;
  return n;
}

export function normalizeVideoDurationForProvider(
  raw: number | undefined,
  provider?: string,
  model?: string,
): number {
  const duration = sanitizeVideoDuration(raw);
  const key = `${provider ?? ''}/${model ?? ''}`.toLowerCase();
  if (
    (key.includes('byteplus') || key.includes('seedance') || key.includes('dreamina')) &&
    (key.includes('dreamina-seedance-2-0') || key.includes('seedance-2-0'))
  ) {
    return Math.min(
      BYTEPLUS_SEEDANCE_2_MAX_DURATION,
      Math.max(BYTEPLUS_SEEDANCE_2_MIN_DURATION, duration),
    );
  }
  if (
    (key.includes('byteplus') || key.includes('seedance') || key.includes('dreamina')) &&
    key.includes('seedance-1-5')
  ) {
    return Math.min(
      BYTEPLUS_SEEDANCE_1_5_MAX_DURATION,
      Math.max(BYTEPLUS_SEEDANCE_1_5_MIN_DURATION, duration),
    );
  }
  return duration;
}

/**
 * Resolutions a request may ask for. No configured video provider renders 4K
 * (Seedance, DashScope and Sora top out at 1080p), so it is not offered.
 */
export const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;

/**
 * Canonical video resolution ("480p" / "720p" / "1080p") from what a model
 * or a config wrote ("1080P", "1080"); undefined when it is not one of them.
 */
export function normalizeVideoResolution(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let value = raw.trim().toLowerCase();
  if (/^\d+$/.test(value)) value = `${value}p`;
  return (VIDEO_RESOLUTIONS as readonly string[]).includes(value) ? value : undefined;
}

/** Fails before any billing when the provider/model cannot render the requested resolution. */
export function assertVideoResolutionSupported(
  resolution: string | undefined,
  supported: readonly string[],
  target: string,
): void {
  if (resolution && !supported.includes(resolution)) {
    throw new Error(
      `${target} cannot render ${resolution} video; supported: ${supported.join(', ')}. Omit resolution to use the default.`,
    );
  }
}
