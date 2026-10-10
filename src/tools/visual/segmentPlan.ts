/**
 * Long-video segment plans from the active video model's longest clip (L,
 * videoCapabilities.ts). One generated clip per segment, so:
 *
 * - without timecodes, a video is the fewest segments of at most L seconds,
 *   as even as whole seconds allow (60 s on L=30 → 30+30; 75 s → 25+25+25);
 * - a timecoded segment the user wrote is kept as it is, and one longer than
 *   L is split into even parts at sentence boundaries, never truncated.
 */

/** Shortest clip any supported model renders well. */
export const MIN_SEGMENT_SECONDS = 4;

/** The fewest segments of at most `maxClipSeconds`, as even as whole seconds allow. */
export function planSegmentDurations(
  totalSeconds: number,
  maxClipSeconds: number,
  minClipSeconds: number = MIN_SEGMENT_SECONDS,
): number[] {
  const min = Math.max(1, Math.floor(minClipSeconds));
  const max = Math.max(1, Math.floor(maxClipSeconds));
  const raw = Number.isFinite(totalSeconds) ? Math.max(min, totalSeconds) : min;
  const total = Math.round(raw);
  // Enough segments that none is longer than L (an unrounded 12.4 s on L=12
  // is two), but never so many that one falls below the minimum: then fewer,
  // longer segments, and the total stays exact.
  let count = Math.max(1, Math.ceil(raw / max - 1e-9));
  while (count > 1 && Math.floor(total / count) < min) count -= 1;
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0));
}

/** How many segments a video of this length takes on this model. */
export function segmentCountFor(totalSeconds: number, maxClipSeconds: number, minClipSeconds?: number): number {
  return planSegmentDurations(totalSeconds, maxClipSeconds, minClipSeconds).length;
}

const QUOTED_RE = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g;

/**
 * Sentences of a beat, with their closing punctuation and nothing dropped:
 * joined back together they are the beat. A sentence ends at 。！？；!?;
 * (and the closing quotes after them), or at a "." followed by a space or
 * the end; "3.5", "example.com" and "Wait..." inside a sentence stay put,
 * and a quoted line is never cut.
 */
export function sentencesOf(text: string): string[] {
  const quotes: string[] = [];
  const masked = text.replace(QUOTED_RE, (quote) => `${quotes.push(quote) - 1}`);
  const sentences: string[] = [];
  let current = '';
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index]!;
    current += char;
    const next = masked[index + 1] ?? '';
    const closer = /[”」』"')）\]】]/;
    let ends = false;
    if (/[。！？；!?;]/.test(char)) ends = !/[。！？；!?;]/.test(next) && !closer.test(next);
    else if (closer.test(char)) ends = /[。！？；!?;.]/.test(masked[index - 1] ?? '') && !closer.test(next) && (next === '' || /\s/.test(next) || next.charCodeAt(0) > 0x7f);
    else if (char === '.') ends = next === '' || /\s/.test(next);
    if (ends) {
      sentences.push(current);
      current = '';
    }
  }
  if (current) sentences.push(current);
  return sentences
    .map((sentence) => sentence.replace(/(\d+)/g, (_, at: string) => quotes[Number(at)] ?? '').trim())
    .filter(Boolean);
}

/**
 * A beat split into `parts` contiguous pieces at sentence boundaries. A beat
 * with too few sentences stays in the first part; the later parts continue
 * its action without repeating its lines.
 */
export function splitBeatText(text: string, parts: number): string[] {
  if (parts <= 1) return [text];
  const sentences = sentencesOf(text);
  if (sentences.length >= parts) {
    return Array.from({ length: parts }, (_, index) => {
      const start = Math.floor((index * sentences.length) / parts);
      const end = Math.floor(((index + 1) * sentences.length) / parts);
      return sentences.slice(start, end).join(' ');
    });
  }
  const action = text.replace(QUOTED_RE, '…').trim();
  return Array.from({ length: parts }, (_, index) => (
    index === 0
      ? text
      : `Continue the same moment from the previous part's last frame, no restart and no new dialogue: ${action}`
  ));
}

export type SplittableShot = {
  title?: string;
  duration?: number;
  storyBeat?: string;
  visualPrompt?: string;
  continuity?: string;
  transitionKind?: string;
  timecodeStart?: number;
  timecodeEnd?: number;
};

/**
 * Shots longer than `maxClipSeconds` split into even parts (fewest parts of
 * at most L), with the beat divided at sentence boundaries, a hard cut
 * between parts and a continuity note; shorter shots are unchanged. The
 * total length is kept.
 */
export function splitLongShots<T extends SplittableShot>(
  shots: readonly T[],
  maxClipSeconds: number,
  minClipSeconds: number = MIN_SEGMENT_SECONDS,
): T[] {
  const out: T[] = [];
  for (const shot of shots) {
    const span = typeof shot.timecodeStart === 'number' && typeof shot.timecodeEnd === 'number'
      ? shot.timecodeEnd - shot.timecodeStart
      : shot.duration;
    // The unrounded length decides: 12.4 s does not fit a 12 s clip.
    if (typeof span !== 'number' || !Number.isFinite(span) || span <= maxClipSeconds) {
      out.push(shot);
      continue;
    }
    const durations = planSegmentDurations(span, maxClipSeconds, minClipSeconds);
    if (durations.length <= 1) {
      out.push(shot);
      continue;
    }
    const beats = splitBeatText(shot.storyBeat ?? '', durations.length);
    let cursor = typeof shot.timecodeStart === 'number' ? shot.timecodeStart : undefined;
    durations.forEach((duration, index) => {
      const part: T = {
        ...shot,
        title: `${shot.title ?? 'Shot'} (${index + 1}/${durations.length})`,
        duration,
        storyBeat: beats[index] ?? shot.storyBeat,
        ...(shot.visualPrompt ? { visualPrompt: `${shot.visualPrompt} (part ${index + 1} of ${durations.length})` } : {}),
        continuity: [
          shot.continuity,
          index > 0 ? 'Continues the previous part directly: same moment, place, people and light; pick up from its last frame.' : undefined,
        ].filter(Boolean).join(' '),
        // transitionKind is the transition INTO a shot: the first part keeps
        // the segment's own, the later parts join it with a plain cut.
        ...(index > 0 ? { transitionKind: 'cut' } : {}),
        ...(cursor !== undefined ? { timecodeStart: cursor, timecodeEnd: cursor + duration } : {}),
      };
      if (cursor !== undefined) cursor += duration;
      out.push(part);
    });
  }
  return out;
}
