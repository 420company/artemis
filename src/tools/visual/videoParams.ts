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
