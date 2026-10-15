/**
 * Long-video segment plans from the active video model's longest clip (L,
 * videoCapabilities.ts). One generated clip per segment, so:
 *
 * - without timecodes, a video is the fewest segments of at most L seconds,
 *   as even as whole seconds allow (60 s on L=30 → 30+30; 75 s → 25+25+25);
 * - a timecoded segment the user wrote is kept as it is, and one longer than
 *   L is split into even parts at sentence boundaries, never truncated;
 * - planned shots keep their natural lengths (a few seconds to about 15 s,
 *   by beat and dialogue) and consecutive ones are packed into as few clips
 *   of at most L as fit, cut together inside the clip (packShotsIntoClips).
 *   L only decides how many clips are generated, never how long a shot is.
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
  // L is the video model's hard limit: enough segments that none is longer
  // (an unrounded 12.4 s on L=12 is two). The minimum is soft: fewer, longer
  // segments when that still keeps every one within L, else parts below it
  // (11 s on L=5 is 4+4+3). The total stays exact.
  let count = Math.max(1, Math.ceil(raw / max - 1e-9));
  while (count > 1 && Math.floor(total / count) < min && Math.ceil(total / (count - 1)) <= max) count -= 1;
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

/** Longest shot a planner should write: a camera set-up longer than this reads as a held, static take. */
export const NATURAL_SHOT_MAX_SECONDS = 15;

/** Natural shot lengths for a beat of this length: one shot up to `NATURAL_SHOT_MAX_SECONDS`, else even shots of about 10 s. */
export function naturalShotLengths(totalSeconds: number, minClipSeconds: number = MIN_SEGMENT_SECONDS): number[] {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= NATURAL_SHOT_MAX_SECONDS) return [Math.max(1, Math.round(totalSeconds) || 1)];
  return planSegmentDurations(totalSeconds, 10, minClipSeconds);
}

export type PackableShot = SplittableShot & {
  camera?: string;
  transition?: string;
  prompt?: string;
};

/** Transitions a model can make inside one clip: a plain cut. Anything else is rendered between clips. */
function joinsWithCut(shot: PackableShot): boolean {
  return shot.transitionKind === undefined || shot.transitionKind === 'cut';
}

function formatSeconds(value: number): string {
  return String(Math.round(value * 10) / 10);
}

// "0–3s", "3-7 s", "2.5–6秒", "7s–end": a beat's own timeline, counted from the shot's start.
const BEAT_TIMELINE_RE = /(?<![\d.:])(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[–—-]\s*(?:(\d+(?:\.\d+)?)\s*(s|秒)(?![a-z])|(end|结束))/gi;

/** A shot's beat with its timeline moved to where the shot sits in the clip ("0–3s" of a shot at 8 s is "8–11s"). */
export function offsetBeatTimeline(beat: string, offsetSeconds: number, shotSeconds: number): string {
  return beat.replace(BEAT_TIMELINE_RE, (_whole, from: string, to: string | undefined, unit: string | undefined) => {
    const start = Number(from) + offsetSeconds;
    const end = to !== undefined ? Number(to) + offsetSeconds : offsetSeconds + shotSeconds;
    return `${formatSeconds(start)}–${formatSeconds(end)}${unit === '秒' ? '秒' : 's'}`;
  });
}

function mergeShots<T extends PackableShot>(group: readonly T[]): T {
  if (group.length === 1) return group[0]!;
  const first = group[0]!;
  const last = group[group.length - 1]!;
  const durations = group.map((shot) => shot.duration ?? 0);
  const total = Math.round(durations.reduce((sum, value) => sum + value, 0));
  let cursor = 0;
  const parts = group.map((shot, index) => {
    const start = cursor;
    const seconds = durations[index]!;
    cursor += seconds;
    const camera = shot.camera?.replace(/\s+/g, ' ').trim();
    const beat = offsetBeatTimeline((shot.storyBeat ?? shot.visualPrompt ?? '').replace(/\s+/g, ' ').trim(), start, seconds);
    const look = index > 0 && shot.visualPrompt && shot.storyBeat
      ? ` Look: ${shot.visualPrompt.replace(/\s+/g, ' ').trim().slice(0, 280)}`
      : '';
    return `${index > 0 ? 'Hard cut to ' : ''}Shot ${index + 1} (${formatSeconds(start)}–${formatSeconds(cursor)}s${camera ? `, ${camera}` : ''}): ${beat}${look}`;
  });
  const continuity = Array.from(new Set(group.map((shot) => shot.continuity?.trim()).filter((value): value is string => Boolean(value))));
  const prompts = group.map((shot, index) => (shot.prompt?.trim() ? `Shot ${index + 1}: ${shot.prompt.trim()}` : '')).filter(Boolean);
  const cameras = group.map((shot, index) => (shot.camera?.trim() ? `shot ${index + 1}: ${shot.camera.trim()}` : '')).filter(Boolean);
  return {
    ...first,
    title: `${first.title ?? 'Shot'} → ${last.title ?? 'Shot'}`,
    duration: total,
    storyBeat: [
      `One clip of ${group.length} camera shots joined by hard cuts inside the clip; the same characters, wardrobe, props, place and light carry across every cut.`,
      ...parts,
    ].join(' '),
    // The opening frame is the first shot's.
    ...(first.visualPrompt ? { visualPrompt: first.visualPrompt } : {}),
    ...(cameras.length > 0 ? { camera: cameras.join('; ') } : {}),
    ...(continuity.length > 0 ? { continuity: continuity.join(' ') } : {}),
    // The clip ends on the last shot's closing frame.
    ...(last.transition ? { transition: last.transition } : {}),
    ...(prompts.length === group.length ? { prompt: prompts.join(' Hard cut. ') } : { prompt: undefined }),
  };
}

/**
 * Planned shots of natural length packed into generation clips: consecutive
 * shots share a clip (cut together inside it) while the clip stays within
 * `maxClipSeconds`, in as few clips as fit, as even as the shot lengths
 * allow. A shot that opens with a transition other than a plain cut starts a
 * new clip (the renderer makes that transition between clips). Shot order,
 * beats, dialogue and the total length are kept; a shot longer than the
 * limit is left for splitLongShots, and shots with timecodes (a timeline the
 * user wrote) or without a length are returned as they are.
 */
export function packShotsIntoClips<T extends PackableShot>(
  shots: readonly T[],
  maxClipSeconds: number,
): T[] {
  const max = Math.floor(maxClipSeconds);
  if (shots.length < 2 || !(max > 0)) return [...shots];
  const durations = shots.map((shot) => shot.duration);
  if (durations.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max)) return [...shots];
  if (shots.some((shot) => typeof shot.timecodeStart === 'number' || typeof shot.timecodeEnd === 'number')) return [...shots];
  const lengths = durations as number[];
  // best[i]: the best packing of the first i shots: fewest clips, then the
  // most even (smallest sum of squared clip lengths).
  type Best = { clips: number; spread: number; from: number };
  const best: Array<Best | undefined> = [{ clips: 0, spread: 0, from: -1 }];
  for (let end = 1; end <= shots.length; end += 1) {
    let sum = 0;
    for (let start = end - 1; start >= 0; start -= 1) {
      sum += lengths[start]!;
      if (sum > max + 1e-9) break;
      // A shot that is not cut into may only open a clip.
      if (start < end - 1 && !joinsWithCut(shots[start + 1]!)) break;
      const previous = best[start];
      if (!previous) continue;
      const candidate = { clips: previous.clips + 1, spread: previous.spread + sum * sum, from: start };
      const current = best[end];
      if (!current || candidate.clips < current.clips || (candidate.clips === current.clips && candidate.spread < current.spread - 1e-9)) {
        best[end] = candidate;
      }
    }
  }
  const groups: T[][] = [];
  for (let end = shots.length; end > 0;) {
    const start = best[end]!.from;
    groups.unshift(shots.slice(start, end));
    end = start;
  }
  return groups.map((group) => mergeShots(group));
}
