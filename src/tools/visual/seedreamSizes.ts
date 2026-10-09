// Output sizes for BytePlus Seedream image models. The ModelArk images API
// takes `size` as a tier ("1K" / "2K" / "4K", aspect chosen by the model from
// the prompt) or as explicit "WIDTHxHEIGHT" pixels, and each model accepts
// only a range of total pixels:
//
//   Seedream 4.0                 921,600 – 16,777,216 px (1280x720 – 4096x4096)
//   Seedream 4.5 and 5.0 (lite)  3,686,400 – 16,777,216 px (2560x1440 – 4096x4096)
//   Seedream 5.0 Pro             921,600 – 4,194,304 px (1K and 2K tiers only)
//
// with the aspect ratio between 1:16 and 16:1. Saga needs a fixed aspect
// (a landscape turnaround sheet, keyframes in the video's ratio), so it asks
// for explicit pixels: the 2K sizes BytePlus recommends for each aspect,
// checked against the model's range and scaled into it when needed.

export type SeedreamAspect = '16:9' | '9:16' | '1:1' | '4:3' | '3:4';

type PixelRange = { min: number; max: number };

/** BytePlus's recommended 2K sizes per aspect ratio. */
const RECOMMENDED_2K: Record<SeedreamAspect, [number, number]> = {
  '1:1': [2048, 2048],
  '4:3': [2304, 1728],
  '3:4': [1728, 2304],
  '16:9': [2560, 1440],
  '9:16': [1440, 2560],
};

const MAX_PIXELS = 4096 * 4096;

export function seedreamPixelRange(model: string): PixelRange {
  const id = model.toLowerCase();
  if (/seedream[-_ ]?5[-_.]?0.*pro/.test(id)) return { min: 1280 * 720, max: 2048 * 2048 };
  if (/seedream[-_ ]?(?:4[-_.]?5|5[-_.]?0)/.test(id)) return { min: 2560 * 1440, max: MAX_PIXELS };
  return { min: 1280 * 720, max: MAX_PIXELS };
}

function roundTo16(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16);
}

/** Explicit "WIDTHxHEIGHT" for a Seedream model and aspect, inside that model's pixel range. */
export function seedreamImageSize(model: string, aspect: SeedreamAspect): string {
  const [baseWidth, baseHeight] = RECOMMENDED_2K[aspect];
  const range = seedreamPixelRange(model);
  const pixels = baseWidth * baseHeight;
  if (pixels >= range.min && pixels <= range.max) return `${baseWidth}x${baseHeight}`;
  // Scale both sides by the same factor into the range, keeping the aspect.
  const target = pixels < range.min ? range.min : range.max;
  const scale = Math.sqrt(target / pixels);
  let width = roundTo16(baseWidth * scale);
  let height = roundTo16(baseHeight * scale);
  // Rounding may step just outside the range; nudge by one 16 px step.
  if (width * height < range.min) { width += 16; height = roundTo16((width * baseHeight) / baseWidth); }
  if (width * height > range.max) { width -= 16; height = roundTo16((width * baseHeight) / baseWidth); }
  return `${width}x${height}`;
}

/** The Seedream aspect for a Saga ratio. */
export function seedreamAspectForRatio(ratio: string | undefined): SeedreamAspect {
  if (ratio === '9:16') return '9:16';
  if (ratio === '1:1') return '1:1';
  if (ratio === '4:3') return '4:3';
  if (ratio === '3:4') return '3:4';
  return '16:9';
}

/**
 * Translates OpenAI-style size words ("landscape", "portrait", "square") into
 * Seedream pixels; any other value is passed through unchanged.
 */
export function seedreamSizeFromKeyword(model: string, size: string): string {
  const key = size.trim().toLowerCase();
  if (key === 'landscape') return seedreamImageSize(model, '16:9');
  if (key === 'portrait') return seedreamImageSize(model, '9:16');
  if (key === 'square') return seedreamImageSize(model, '1:1');
  return size;
}
