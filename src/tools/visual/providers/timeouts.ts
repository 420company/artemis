// Generous safety timeouts for visual provider HTTP calls.
// These prevent indefinite hangs but are deliberately well above normal
// generation latency so well-behaved providers never trip them.
//
// Empirical reference (2026-04, OpenAI gpt-image-2 via relay):
//   typical successful image gen: 20-70s, occasional 90s
//   video gen end-to-end: 60-300s typical
// We pick limits ~5-10x above typical so transient slowness doesn't fail.

export const IMAGE_GENERATION_TIMEOUT_MS = 600_000;       // 10 min
export const VIDEO_CREATE_TIMEOUT_MS = 120_000;           // 2 min
export const VIDEO_POLL_TIMEOUT_MS = 60_000;              // 1 min per poll
export const ASSET_DOWNLOAD_TIMEOUT_MS = 600_000;         // 10 min
