import { resolveVideoModelProfile, type VideoCapabilityOverrides } from './videoCapabilities.js';

const DEFAULT_VIDEO_DURATION = 5;
const MIN_VIDEO_DURATION = 1;
const MAX_VIDEO_DURATION = 60;

export function sanitizeVideoDuration(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_VIDEO_DURATION;
  const n = Math.floor(raw);
  if (n < MIN_VIDEO_DURATION) return MIN_VIDEO_DURATION;
  if (n > MAX_VIDEO_DURATION) return MAX_VIDEO_DURATION;
  return n;
}

/**
 * A clip length the model accepts: clamped to its clip range for a known
 * model (videoCapabilities.ts) or a platform declaration, and snapped to the
 * nearest allowed length when the model only takes some. Other models get the
 * request as it is.
 */
export function normalizeVideoDurationForProvider(
  raw: number | undefined,
  provider?: string,
  model?: string,
  overrides?: VideoCapabilityOverrides,
): number {
  const duration = sanitizeVideoDuration(raw);
  const profile = resolveVideoModelProfile(provider ?? '', model ?? '', overrides);
  // Only the Seedance 1.5 / 2.x clip ranges are enforced from the built-in
  // table; other models are clamped only when the platform declares a range.
  const enforced = profile.source === 'platform' || ['seedance-2.5', 'seedance-2.0', 'seedance-1.5'].includes(profile.family);
  if (!enforced) return duration;
  const clamped = Math.min(profile.maxClipSeconds, Math.max(profile.minClipSeconds, duration));
  const allowed = profile.allowedDurations;
  if (!allowed || allowed.length === 0) return clamped;
  return allowed.reduce((best, value) => (Math.abs(value - clamped) < Math.abs(best - clamped) ? value : best), allowed[0]!);
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
