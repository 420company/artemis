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
export function splitBeatText(text: string, parts: number, weights?: readonly number[]): string[] {
  if (parts <= 1) return [text];
  const sentences = sentencesOf(text);
  if (sentences.length >= parts && weights && weights.length === parts) {
    // Pieces in proportion to the weights (seconds), at least one sentence each.
    const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0) || parts;
    const bounds = [0];
    let cumulative = 0;
    for (let index = 0; index < parts - 1; index += 1) {
      cumulative += Math.max(0, weights[index]!);
      const at = Math.round((cumulative / total) * sentences.length);
      bounds.push(Math.min(Math.max(at, bounds[index]! + 1), sentences.length - (parts - 1 - index)));
    }
    bounds.push(sentences.length);
    return Array.from({ length: parts }, (_, index) => sentences.slice(bounds[index], bounds[index + 1]).join(' '));
  }
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
 * One shot as consecutive parts of these lengths: the beat divided at
 * sentence boundaries (evenly, or in proportion to the lengths), a hard cut between parts and a
 * continuity note on the later ones.
 */
function splitShotInto<T extends SplittableShot>(shot: T, durations: readonly number[], proportional = false): T[] {
  const beats = splitBeatText(shot.storyBeat ?? '', durations.length, proportional ? durations : undefined);
  let cursor = typeof shot.timecodeStart === 'number' ? shot.timecodeStart : undefined;
  return durations.map((duration, index) => {
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
    return part;
  });
}

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
    // Whole-second parts of a fractional span: the last part takes the
    // remainder, so the parts add up to the span exactly (40.6 s → 21 + 19.6).
    const remainder = span - durations.reduce((sum, value) => sum + value, 0);
    if (Math.abs(remainder) > 1e-9) durations[durations.length - 1] = Math.round((durations[durations.length - 1]! + remainder) * 1000) / 1000;
    out.push(...splitShotInto(shot, durations));
  }
  return out;
}


/** Longest shot a planner should write: a camera set-up longer than this reads as a held, static take. */
export const NATURAL_SHOT_MAX_SECONDS = 15;

/**
 * Whether a planner writes shots of natural length: the model cuts between
 * camera shots inside one clip (so the pipeline packs shots into clips), and
 * its clip holds more than one natural shot. On a shorter clip (10 or 12 s)
 * the planner keeps writing one shot per clip, as few and as even as the
 * length allows.
 */
export function plansNaturalShots(profile: { multiShot: boolean; maxClipSeconds: number }): boolean {
  return profile.multiShot && profile.maxClipSeconds >= NATURAL_SHOT_MAX_SECONDS;
}

/** Natural shot lengths for a beat of this length: one shot up to `NATURAL_SHOT_MAX_SECONDS`, else even shots of about 10 s. */
export function naturalShotLengths(totalSeconds: number, minClipSeconds: number = MIN_SEGMENT_SECONDS): number[] {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= NATURAL_SHOT_MAX_SECONDS) return [Math.max(1, Math.round(totalSeconds) || 1)];
  return planSegmentDurations(totalSeconds, 10, minClipSeconds);
}

// ─── A clip of several camera shots ──────────────────────────────────────

/** Longest story beat a one-shot segment prompt carries. */
export const SHOT_BEAT_MAX_CHARS = 1200;
/** What each further shot of a clip adds to its beat, up to the ceiling. */
const EXTRA_SHOT_BEAT_CHARS = 150;
const CLIP_BEAT_MAX_CHARS = 1650;
/** Longest camera note in a shot marker. */
const CAMERA_MARKER_CHARS = 80;
/** Longest look line a later shot of a clip carries. */
const LOOK_CHARS = 280;
/** Action text each shot of a clip keeps at the least, besides its marker and dialogue. */
const MIN_ACTION_CHARS = 60;

/**
 * Longest story beat of a clip of `shotCount` camera shots: a one-shot beat
 * plus room for each further shot, so every shot keeps its marker, its
 * dialogue and some of its action.
 */
export function clipBeatBudget(shotCount: number): number {
  return Math.min(CLIP_BEAT_MAX_CHARS, SHOT_BEAT_MAX_CHARS + EXTRA_SHOT_BEAT_CHARS * Math.max(0, shotCount - 1));
}

/** The opening line of a clip of several camera shots. */
export function clipShotsHeader(count: number): string {
  return `One clip of ${count} camera shots joined by hard cuts inside the clip; the same characters, wardrobe, props, place and light carry across every cut.`;
}

/** One shot of a clip: its marker ("Hard cut to Shot 2 (6–14s, close-up): "), its beat and an optional look line. */
export type ClipShotPart = { marker: string; body: string; look?: string };

const CLIP_HEADER_RE = /^One clip of \d+ camera shots[^.]*\.\s*/;
const SHOT_MARKER_RE = /(?:Hard cut to )?Shot (\d+) \(\d+(?:\.\d+)?–\d+(?:\.\d+)?s(?:, [^()]*)?\): /g;
const LOOK_RE = /\s*\[Look: [^\]]*\]\s*$/;
const SPOKEN_RE = /[“”"「」『』]/;

function clipChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function renderClipBeat(parts: readonly ClipShotPart[], withLooks = true): string {
  return [clipShotsHeader(parts.length), ...parts.map((part) => `${part.marker}${part.body}${withLooks && part.look ? ` ${part.look}` : ''}`)].join(' ');
}

/** The shots of a clip beat (renderClipBeat), or undefined for a beat of one shot. */
export function parseClipBeat(beat: string): ClipShotPart[] | undefined {
  const header = CLIP_HEADER_RE.exec(beat);
  if (!header) return undefined;
  // The markers numbered 1, 2, 3… in order; anything else is beat text.
  const markers: RegExpMatchArray[] = [];
  for (const match of beat.matchAll(SHOT_MARKER_RE)) {
    if ((match.index ?? 0) >= header[0].length && Number(match[1]) === markers.length + 1) markers.push(match);
  }
  if (markers.length < 2) return undefined;
  return markers.map((match, index) => {
    const end = index + 1 < markers.length ? markers[index + 1]!.index ?? beat.length : beat.length;
    const raw = beat.slice((match.index ?? 0) + match[0].length, end).trim();
    const look = LOOK_RE.exec(raw);
    return { marker: match[0], body: look ? raw.slice(0, look.index).trim() : raw, ...(look ? { look: look[0].trim() } : {}) };
  });
}

/**
 * A clip beat after a rewrite (the story check): kept when it still reads as
 * the same number of shots; given back its opening line when the rewrite
 * kept every shot marker but dropped or changed that line; else the beat
 * before the rewrite, since a rewrite without the markers would lose shots.
 */
export function restoreClipBeat(before: string, rewritten: string): string {
  const shots = parseClipBeat(before)?.length;
  if (!shots) return rewritten;
  if (parseClipBeat(rewritten)?.length === shots && CLIP_HEADER_RE.exec(rewritten)?.[0].includes(` ${shots} camera shots`)) return rewritten;
  const body = rewritten.replace(/One clip of \d+ camera shots[^.]*\.\s*/g, '').trim();
  const restored = `${clipShotsHeader(shots)} ${body}`;
  return parseClipBeat(restored)?.length === shots ? restored : before;
}

/** How many camera shots a beat holds (1 unless it is a clip of several). */
export function clipBeatShotCount(beat: string): number {
  return parseClipBeat(beat)?.length ?? 1;
}

/** The first shot's beat of a clip of several shots (what its opening frame shows), else the beat itself. */
export function openingShotBeat(beat: string): string {
  return parseClipBeat(beat)?.[0]?.body ?? beat;
}

/** The first shot's camera of a merged camera note ("shot 1: wide; shot 2: close-up"), else the note itself. */
export function openingShotCamera(camera: string): string {
  if (!/^shot \d+: /.test(camera)) return camera;
  return /^shot 1: ([\s\S]*?)(?=; shot \d+: |$)/.exec(camera)?.[1]?.trim() ?? '';
}

/**
 * A clip beat within maxChars without losing a shot: the look lines go first
 * (last shot first), then each shot keeps its marker and every dialogue
 * sentence and shares the room left for its other sentences, in order (the
 * first one that does not fit is cut to what is left). A
 * beat of one shot, or one whose markers and dialogue alone are longer, is
 * returned as short as this makes it; the caller clips what is left.
 */
export function fitClipBeat(beat: string, maxChars: number): string {
  if (beat.length <= maxChars) return beat;
  const parts = parseClipBeat(beat);
  if (!parts) return beat;
  const kept = parts.map((part) => ({ ...part }));
  for (let index = kept.length - 1; index >= 0 && renderClipBeat(kept).length > maxChars; index -= 1) delete kept[index]!.look;
  const withLooks = renderClipBeat(kept);
  if (withLooks.length <= maxChars) return withLooks;
  const shots = parts.map((part) => {
    const sentences = sentencesOf(part.body);
    return { marker: part.marker, sentences, spoken: sentences.map((sentence) => SPOKEN_RE.test(sentence)) };
  });
  const lengthOf = (sentences: string[]) => sentences.reduce((sum, sentence) => sum + sentence.length + 1, 0);
  const fixed = clipShotsHeader(shots.length).length
    + shots.reduce((sum, shot) => sum + 1 + shot.marker.length + lengthOf(shot.sentences.filter((_, index) => shot.spoken[index])), 0);
  // The room left is shared among the shots' other sentences; a shot that
  // needs less leaves the rest to the others.
  let room = Math.max(0, maxChars - fixed);
  const wants = shots.map((shot) => lengthOf(shot.sentences.filter((_, index) => !shot.spoken[index])));
  const shares = shots.map(() => 0);
  let open = shots.map((_, index) => index).filter((index) => wants[index]! > 0);
  while (room > 0 && open.length > 0) {
    const each = Math.floor(room / open.length);
    if (each <= 0) break;
    for (const index of open) {
      const give = Math.min(each, wants[index]! - shares[index]!);
      shares[index] = shares[index]! + give;
      room -= give;
    }
    open = open.filter((index) => shares[index]! < wants[index]!);
  }
  return renderClipBeat(shots.map((shot, shotIndex) => {
    let left = shares[shotIndex]!;
    const body = shot.sentences.map((sentence, index) => {
      if (shot.spoken[index]) return sentence;
      if (sentence.length + 1 <= left) {
        left -= sentence.length + 1;
        return sentence;
      }
      if (left >= 40) {
        // The rest of the room goes to the first sentence that does not fit.
        const cut = clipChars(sentence, left - 1);
        left = 0;
        return cut;
      }
      return '';
    }).filter(Boolean).join(' ');
    return { marker: shot.marker, body };
  }), false);
}

/** Characters a shot needs in a clip beat at the least: its marker, its dialogue and some action. */
function essentialBeatChars(text: string, camera: string | undefined): number {
  const spoken = sentencesOf(text).filter((sentence) => SPOKEN_RE.test(sentence));
  return 40 + (camera ? Math.min(camera.length, CAMERA_MARKER_CHARS) + 2 : 0) + spoken.reduce((sum, sentence) => sum + sentence.length + 1, 0) + MIN_ACTION_CHARS;
}

// ─── Packing planned shots into clips ────────────────────────────────────

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

// "0–3s: ", "3-7 s:", "2.5–6秒：", "(7s–end)": a timeline position at the
// start of a beat, a sentence or a parenthesis, followed by ":" "," or ")".
// "a 5-10s pause" and "the 1990-2000s" are not timeline positions.
const BEAT_TIMELINE_RE = /(^|[.。!?！？;；:：]\s*|[(（]\s*|\n\s*)(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[–—-]\s*(?:(\d+(?:\.\d+)?)\s*(s|秒)(?![a-z])|(end|结束))(?=\s*[:：,，)）])/gi;

/**
 * A shot's beat with its timeline moved to where the shot sits in the clip
 * ("0–3s" of a shot at 8 s is "8–11s"). `origin` is where this part starts
 * inside the shot it was cut from, and `scale` stretches a shot whose length
 * was adjusted to fit the clip (times are then whole seconds). A range
 * outside the shot is left as written.
 */
export function offsetBeatTimeline(
  beat: string,
  offsetSeconds: number,
  shotSeconds: number,
  options: { origin?: number; scale?: number } = {},
): string {
  const origin = options.origin ?? 0;
  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const natural = shotSeconds / scale;
  const at = (seconds: number) => offsetSeconds + Math.min(Math.max(0, seconds - origin), natural) * scale;
  const format = (seconds: number) => (scale === 1 ? formatSeconds(seconds) : String(Math.round(seconds)));
  return beat.replace(BEAT_TIMELINE_RE, (whole: string, lead: string, from: string, to: string | undefined, unit: string | undefined, end: string | undefined) => {
    const start = Number(from);
    if (start > origin + natural + 0.5) return whole;
    const stop = to !== undefined ? Math.min(at(Number(to)), offsetSeconds + shotSeconds) : offsetSeconds + shotSeconds;
    const chinese = unit === '秒' || (unit === undefined && end === '结束');
    return `${lead}${format(at(start))}–${format(stop)}${chinese ? '秒' : 's'}`;
  });
}

/** A shot on its way into a clip: its whole-second length, the length it was planned at, and where it starts in the shot it was cut from. */
type Piece<T> = { shot: T; seconds: number; natural: number; origin: number };

/** Shortest part of a shot cut at a clip boundary. */
const MIN_PIECE_SECONDS = 3;
/** Shortest a shot gets when a clip boundary moves to its cut. */
const MIN_SHIFTED_SECONDS = 2;

/** What a shot shows: its authored prompt, else its beat, else its visual direction. */
function beatTextOf(shot: PackableShot): string {
  return (shot.prompt?.trim() || shot.storyBeat?.trim() || shot.visualPrompt?.trim() || '').replace(/\s+/g, ' ');
}

function cameraNoteOf(shot: PackableShot): string | undefined {
  const camera = shot.camera?.replace(/[()（）]/g, ' ').replace(/\s+/g, ' ').trim();
  return camera ? clipChars(camera, CAMERA_MARKER_CHARS) : undefined;
}

/** A piece cut in two at `first` seconds; each part's beat is its share of the sentences. */
function splitPiece<T extends PackableShot>(piece: Piece<T>, first: number): [Piece<T>, Piece<T>] {
  const second = piece.seconds - first;
  const text = beatTextOf(piece.shot);
  const [a, b] = splitShotInto({ ...piece.shot, storyBeat: text, prompt: undefined } as T, [first, second], true);
  const naturalA = (piece.natural * first) / piece.seconds;
  return [
    { shot: a!, seconds: first, natural: naturalA, origin: piece.origin },
    { shot: b!, seconds: second, natural: piece.natural - naturalA, origin: piece.origin + naturalA },
  ];
}

function fitsOneClipBeat<T extends PackableShot>(pieces: readonly Piece<T>[]): boolean {
  if (pieces.length <= 1) return true;
  const needed = clipShotsHeader(pieces.length).length
    + pieces.reduce((sum, piece) => sum + essentialBeatChars(beatTextOf(piece.shot), cameraNoteOf(piece.shot)), 0);
  return needed <= clipBeatBudget(pieces.length);
}

/**
 * Consecutive pieces (all joined by cuts) as clips of about the even plan's
 * length (planSegmentDurations), so the clip count is the one a video of
 * this length takes. A clip boundary that falls inside a shot cuts it there
 * (both parts at least MIN_PIECE_SECONDS); one that falls within a few
 * seconds of a cut moves to it, the neighbouring shots taking up the
 * difference. A clip also ends when its beat could not keep every shot's
 * marker and dialogue.
 */
function packRun<T extends PackableShot>(run: readonly Piece<T>[], max: number, min: number): Piece<T>[][] {
  const queue = run.map((piece) => ({ ...piece }));
  const groups: Piece<T>[][] = [];
  while (queue.length > 0) {
    const remaining = queue.reduce((sum, piece) => sum + piece.seconds, 0);
    if (remaining <= max && fitsOneClipBeat(queue)) {
      groups.push(queue.splice(0));
      break;
    }
    const target = planSegmentDurations(remaining, max, min)[0]!;
    const group: Piece<T>[] = [queue.shift()!];
    let filled = group[0]!.seconds;
    while (queue.length > 0) {
      const next = queue[0]!;
      if (!fitsOneClipBeat([...group, next])) break;
      if (filled + next.seconds <= target) {
        group.push(queue.shift()!);
        filled += next.seconds;
        continue;
      }
      const room = target - filled;
      const over = next.seconds - room;
      if (room <= 0) break;
      if (over < MIN_PIECE_SECONDS && filled + next.seconds <= max) {
        // A shot that only just runs past the target: the whole shot.
        group.push(queue.shift()!);
      } else if (room >= MIN_PIECE_SECONDS && over >= MIN_PIECE_SECONDS) {
        // The boundary falls inside the shot: cut it there.
        const [head, tail] = splitPiece(next, room);
        queue[0] = tail;
        group.push(head);
      } else if (room < MIN_PIECE_SECONDS && over >= MIN_SHIFTED_SECONDS) {
        // Just short of a cut: the clip's last shots hold a second longer
        // each, the next shot starts that much later.
        next.seconds -= room;
        for (let left = room, index = group.length - 1; left > 0; left -= 1, index = index > 0 ? index - 1 : group.length - 1) {
          group[index]!.seconds += 1;
        }
      } else if (room >= MIN_SHIFTED_SECONDS && queue.length > 1 && queue[1]!.seconds + over <= max) {
        // Just past a cut with no room for the whole shot: it ends at the
        // boundary and the shot after it starts that much earlier.
        next.seconds = room;
        queue[1]!.seconds += over;
        group.push(queue.shift()!);
      }
      break;
    }
    groups.push(group);
  }
  return groups;
}

/** A piece on its own: the shot as planned, or with its new length and timeline. */
function soloShot<T extends PackableShot>(piece: Piece<T>): T {
  if (piece.seconds === piece.shot.duration) return piece.shot;
  const retimed = piece.seconds !== piece.natural || piece.origin !== 0;
  return {
    ...piece.shot,
    duration: piece.seconds,
    ...(retimed && piece.shot.storyBeat
      ? { storyBeat: offsetBeatTimeline(piece.shot.storyBeat, 0, piece.seconds, { origin: piece.origin, scale: piece.seconds / piece.natural }) }
      : {}),
  };
}

function mergeShots<T extends PackableShot>(group: readonly Piece<T>[]): T {
  if (group.length === 1) return soloShot(group[0]!);
  const first = group[0]!.shot;
  const last = group[group.length - 1]!.shot;
  let cursor = 0;
  const parts: ClipShotPart[] = group.map((piece, index) => {
    const start = cursor;
    cursor += piece.seconds;
    const shot = piece.shot;
    const camera = cameraNoteOf(shot);
    const text = beatTextOf(shot);
    // An authored prompt is the shot's whole text; with only some shots
    // authored, each keeps its own.
    const body = offsetBeatTimeline(text, start, piece.seconds, { origin: piece.origin, scale: piece.seconds / piece.natural });
    const visual = shot.visualPrompt?.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const look = index > 0 && visual && visual !== text ? `[Look: ${clipChars(visual, LOOK_CHARS)}]` : undefined;
    return { marker: `${index > 0 ? 'Hard cut to ' : ''}Shot ${index + 1} (${start}–${cursor}s${camera ? `, ${camera}` : ''}): `, body, ...(look ? { look } : {}) };
  });
  const continuity = Array.from(new Set(group.map((piece) => piece.shot.continuity?.trim()).filter((value): value is string => Boolean(value))));
  const cameras = group.map((piece, index) => (piece.shot.camera?.trim() ? `shot ${index + 1}: ${piece.shot.camera.trim()}` : '')).filter(Boolean);
  const merged: T = {
    ...first,
    title: `${first.title ?? 'Shot'} → ${last.title ?? 'Shot'}`,
    duration: cursor,
    storyBeat: fitClipBeat(renderClipBeat(parts), clipBeatBudget(parts.length)),
    // The opening frame is the first shot's.
    ...(first.visualPrompt ? { visualPrompt: first.visualPrompt } : {}),
    ...(cameras.length > 0 ? { camera: cameras.join('; ') } : {}),
    ...(continuity.length > 0 ? { continuity: continuity.join(' ') } : {}),
    // Every shot's prompt is in the beat above.
    prompt: undefined,
  };
  // The clip ends on the last shot's closing frame.
  if (last.transition) merged.transition = last.transition;
  else delete merged.transition;
  return merged;
}

/**
 * Planned shots of natural length packed into generation clips: consecutive
 * shots share a clip (cut together inside it), each clip at most
 * `maxClipSeconds` and about as long as the even plan for the video, so the
 * clip count is the one planSegmentDurations gives, not one per shot. A shot
 * that opens with a transition other than a plain cut starts a new clip (the
 * renderer makes that transition between clips). Shot order, beats, dialogue
 * and the total length are kept, in whole seconds.
 *
 * A shot longer than the clip is first split with splitLongShots, so callers
 * need not run it before. Shots with timecodes (a timeline the user wrote)
 * or without a length are returned as they are. Callers pack only for a
 * model that cuts inside a clip (VideoModelProfile.multiShot), and never a
 * script the user wrote or one sent as written.
 */
export function packShotsIntoClips<T extends PackableShot>(
  shots: readonly T[],
  maxClipSeconds: number,
  minClipSeconds: number = MIN_SEGMENT_SECONDS,
): T[] {
  const max = Math.floor(maxClipSeconds);
  if (shots.length < 2 || !(max > 0)) return [...shots];
  if (shots.some((shot) => typeof shot.duration !== 'number' || !Number.isFinite(shot.duration) || shot.duration <= 0)) return [...shots];
  if (shots.some((shot) => typeof shot.timecodeStart === 'number' || typeof shot.timecodeEnd === 'number')) return [...shots];
  const split = splitLongShots(shots, max, minClipSeconds);
  // Whole seconds, the total kept: each shot ends where its unrounded end rounds to.
  let end = 0;
  let previous = 0;
  const pieces: Piece<T>[] = split.map((shot) => {
    end += shot.duration!;
    const seconds = Math.max(1, Math.round(end) - previous);
    previous += seconds;
    return { shot, seconds, natural: seconds, origin: 0 };
  });
  const runs: Piece<T>[][] = [];
  for (const piece of pieces) {
    if (runs.length === 0 || !joinsWithCut(piece.shot)) runs.push([]);
    runs[runs.length - 1]!.push(piece);
  }
  return runs.flatMap((run) => packRun(run, max, Math.max(1, Math.floor(minClipSeconds)))).map((group) => mergeShots(group));
}
