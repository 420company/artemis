import type { SagaRatio } from './sagaRenderer/types.js';

// Aspect-ratio parsing shared by the Saga wizard, generate_long_video and
// generate_video. Free text is scanned conservatively: a story is full of
// timecodes ("1:04", "从 1:19"), camera words ("纵向推进", "portrait lens") and
// places ("town square") that are not a frame format.

const RATIO_VALUES: Record<string, SagaRatio> = { '9:16': '9:16', '16:9': '16:9', '1:1': '1:1' };

// "9:16", "9：16", "9x16", "9×16", "9/16". Digits or colons around the pair
// mean a timecode or a longer number, never a ratio.
const NUMERIC_RATIO_RE = /(?<![\d:：.])(16|9|1)\s*[:：xX×/]\s*(16|9|1)(?![\d:：.])/g;
// Pixel sizes such as "1080x1920" or "1920×1080".
const PIXEL_SIZE_RE = /(?<![\d.])(\d{3,5})\s*[xX×*]\s*(\d{3,5})(?![\d.])/g;
// Orientation words that only ever name a frame format.
const STRICT_WORDS: Array<[RegExp, SagaRatio]> = [
  [/竖屏|竖版/, '9:16'],
  [/横屏|横版/, '16:9'],
  [/方屏/, '1:1'],
];
// Words that name a format only when the user is clearly answering the
// ratio question (a labelled line, a menu reply or a tool argument).
const LOOSE_WORDS: Array<[RegExp, SagaRatio]> = [
  ...STRICT_WORDS,
  [/纵向|\bportrait\b|\bvertical\b/i, '9:16'],
  [/横向|\blandscape\b|\bhorizontal\b|\bwidescreen\b/i, '16:9'],
  [/正方形|方形|\bsquare\b/i, '1:1'],
];

// "画幅比例 / ratio: 9:16 竖屏", "Aspect ratio: 9:16 portrait", "**画面尺寸**：竖版".
const LABELLED_LINE_RE = /(?:^|[\s·•*\-【[/|])(?:画幅(?:比例)?|画面(?:比例|尺寸)|比例|aspect\s*ratio|ratio)\s*(?:[】\]*]+\s*)?[:：]\s*(.+)$/i;

function nearestRatio(width: number, height: number): SagaRatio | undefined {
  if (!(width > 0 && height > 0)) return undefined;
  const value = Math.log(width / height);
  const candidates: Array<[SagaRatio, number]> = [['16:9', Math.log(16 / 9)], ['1:1', 0], ['9:16', Math.log(9 / 16)]];
  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (Math.abs(candidate[1] - value) < Math.abs(best[1] - value)) best = candidate;
  }
  return best[0];
}

function collectRatios(text: string, words: Array<[RegExp, SagaRatio]>): Set<SagaRatio> {
  const found = new Set<SagaRatio>();
  for (const match of text.matchAll(NUMERIC_RATIO_RE)) {
    const ratio = RATIO_VALUES[`${match[1]}:${match[2]}`];
    if (ratio) found.add(ratio);
  }
  for (const match of text.matchAll(PIXEL_SIZE_RE)) {
    const ratio = nearestRatio(Number(match[1]), Number(match[2]));
    if (ratio) found.add(ratio);
  }
  for (const [pattern, ratio] of words) {
    if (pattern.test(text)) found.add(ratio);
  }
  return found;
}

function single(found: Set<SagaRatio>): SagaRatio | undefined {
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * Normalise a value that is meant to be a ratio: a tool argument, a menu
 * reply or the value of a labelled line ("9:16 竖屏", "portrait", "9×16",
 * "1080x1920"). Returns undefined when it names no ratio or several.
 */
export function normalizeAspectRatio(value: string | undefined): SagaRatio | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return single(collectRatios(text, LOOSE_WORDS));
}

export type BriefRatio = {
  ratio: SagaRatio;
  /** True when the brief states it on a labelled line ("画幅比例：9:16"). */
  labelled: boolean;
};

/**
 * Read the frame format a brief asks for. A labelled line wins; an unfilled
 * template line that lists several ratios counts as no answer. Without a
 * label only bounded numeric ratios, pixel sizes and the unambiguous words
 * 竖屏 / 竖版 / 横屏 / 横版 / 方屏 are read, and only when they agree.
 */
export function extractBriefAspectRatio(text: string): BriefRatio | undefined {
  const unlabelled: string[] = [];
  let labelled: SagaRatio | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(LABELLED_LINE_RE);
    if (!match) {
      unlabelled.push(line);
      continue;
    }
    const ratio = normalizeAspectRatio(match[1]);
    if (ratio && !labelled) labelled = ratio;
  }
  if (labelled) return { ratio: labelled, labelled: true };
  const ratio = single(collectRatios(unlabelled.join('\n'), STRICT_WORDS));
  return ratio ? { ratio, labelled: false } : undefined;
}

const PROVIDER_RATIO_RE = /^(?:\d{1,2}:\d{1,2}|adaptive|keep_ratio)$/i;

/**
 * The ratio a single generate_video call sends. Saga ratios are normalised
 * ("9:16 竖屏" / "portrait" / "1080x1920" → "9:16"); other well-formed
 * provider values ("4:3", "21:9", "adaptive") pass through. Anything else
 * falls back to `fallback` with a warning instead of reaching the provider.
 */
export function normalizeVideoRatioArgument(
  raw: string | undefined,
  fallback: string | undefined,
  warn: (message: string) => void,
): string | undefined {
  const text = raw?.trim();
  if (!text) return fallback;
  const ratio = normalizeAspectRatio(text);
  if (ratio) return ratio;
  if (PROVIDER_RATIO_RE.test(text)) return text.toLowerCase();
  warn(`⚠️ generate_video: unrecognised aspect ratio "${text}"; ${fallback ? `using ${fallback}` : 'leaving it to the provider default'}.`);
  return fallback;
}
