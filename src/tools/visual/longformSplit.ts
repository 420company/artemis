/**
 * Cutting a long text into pieces a scripting pass can work on.
 *
 * The owner's case is a novel: a hundred thousand characters, which no model
 * call holds and no film the length of a film can carry. It has to be cut,
 * and where it is cut decides whether the shots on either side can be joined.
 *
 * The rule is that the splitter does not read the story. It only ever cuts
 * where the text is already marked, because an author marks the seams: a
 * chapter heading, a scene separator, a blank line. Those are read off the
 * page, for free, with no model and no guessing, and they are tried in order
 * -- a level below is used only when the piece above it is still too large.
 *
 * When nothing is marked at all, which is what a novel-site .txt download
 * often looks like, there is still one thing to go on: a scene change shows
 * up as a break in vocabulary. The nouns turn over, because the place and the
 * objects did. Comparing the words on either side of every sentence end and
 * cutting where they overlap least is TextTiling (Hearst, 1997), it is
 * arithmetic rather than judgement, and it runs on a whole novel in
 * milliseconds.
 *
 * And when even that is flat -- an unbroken interior monologue -- the honest
 * answer is that the text has no seam. Then equal pieces at sentence ends are
 * not a compromise: every piece is a continuation, the camera is carried
 * through by the continuity rules, and what comes out is the long take the
 * writing actually is. Inventing a scene change there would be the error.
 */

/** Where a cut may fall, strongest first. */
export type BoundaryLevel = 'chapter' | 'scene-marker' | 'blank-run' | 'blank' | 'paragraph' | 'sentence';

const LEVEL_ORDER: readonly BoundaryLevel[] = ['chapter', 'scene-marker', 'blank-run', 'blank', 'paragraph', 'sentence'];

export type Boundary = {
  /** Character index where the piece after this boundary starts. */
  offset: number;
  level: BoundaryLevel;
  /** A chapter's own heading, when it has one. */
  label?: string;
};

export type LongformFormat = 'prose' | 'subtitles' | 'screenplay' | 'dialogue' | 'verse';

export type LongformChunk = {
  index: number;
  text: string;
  startOffset: number;
  /** The boundary that opened this chunk. */
  level: BoundaryLevel;
  label?: string;
  /**
   * Whether this chunk begins a scene. False for a piece cut out of the
   * middle of one, which is told to carry the previous shot's camera, light
   * and posture instead of establishing anything.
   */
  opensScene: boolean;
  /** Whether the scene ends with this chunk. */
  closesScene: boolean;
  chars: number;
};

// ─── format ───────────────────────────────────────────────────────────────

const SUBTITLE_RE = /^\s*\d+\s*\r?\n\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/m;
const VTT_RE = /^\s*WEBVTT\b/;
const SCREENPLAY_RE = /^\s*(?:INT\.|EXT\.|INT\/EXT|场景\s*[一二三四五六七八九十\d]|镜号)/im;
const DIALOGUE_LOG_RE = /^(?:[^\n:：]{1,16}[:：]\s*\S.*\n){4,}/m;

/**
 * What kind of text this is, before it is treated as prose. A subtitle file
 * and a screenplay carry harder boundaries than any novel, and reading an
 * .srt as prose throws them away.
 */
export function detectFormat(text: string): LongformFormat {
  if (VTT_RE.test(text) || SUBTITLE_RE.test(text)) return 'subtitles';
  if (SCREENPLAY_RE.test(text)) return 'screenplay';
  if (DIALOGUE_LOG_RE.test(text)) return 'dialogue';
  // Verse: many short lines, few sentence ends.
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length >= 8) {
    const short = lines.filter((line) => line.trim().length <= 24).length;
    const ends = (text.match(/[。！？.!?]/g) ?? []).length;
    if (short / lines.length > 0.8 && ends < lines.length / 3) return 'verse';
  }
  return 'prose';
}

// ─── boundaries ───────────────────────────────────────────────────────────

const CHAPTER_RE = /^[ \t　]*(?:第\s*[0-9０-９一二三四五六七八九十百千零〇]+\s*[章回节卷话篇幕]|楔子|序章|序言|前言|尾声|终章|后记|Chapter\s+[0-9IVXLC]+|CHAPTER\s+[0-9IVXLC]+|#{1,3}\s+\S)[^\n]{0,60}$/gim;
/** A line that is only a separator: *** / --- / ◇◇◇ / § / ＊＊＊ */
const SCENE_MARKER_RE = /^[ \t　]*(?:[*＊·•◇◆○●□■§~～=_\-—–]{3,}|(?:[*＊]\s?){3,}|(?:[-—–]\s?){3,})[ \t　]*$/gim;

/** Opening and closing quotes, for the depth we must never cut inside. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['《', '》'], ['〈', '〉']];
const OPENERS = new Set(QUOTE_PAIRS.map(([open]) => open));
const CLOSERS = new Map(QUOTE_PAIRS.map(([open, close]) => [close, open]));

/**
 * Quote depth before each character. A cut at a depth above zero splits a
 * line of dialogue in half, which is the one mechanical error that always
 * shows on screen.
 */
export function quoteDepths(text: string): Uint8Array {
  const depths = new Uint8Array(text.length + 1);
  let depth = 0;
  // Straight quotes have no direction, so they toggle.
  let straight = false;
  for (let i = 0; i < text.length; i += 1) {
    depths[i] = depth + (straight ? 1 : 0);
    const ch = text[i]!;
    if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) depth = Math.max(0, depth - 1);
    else if (ch === '"') straight = !straight;
  }
  depths[text.length] = depth + (straight ? 1 : 0);
  return depths;
}

/** 「我回来了。」他说 — the attribution belongs to the line before it. */
const ATTRIBUTION_RE = /^[ \t　]*(?:[^\n，。！？\s]{1,8})?(?:说道?|问道?|答道?|喊道?|笑道|回答|低声|轻声|said|asked|replied|whispered)/;

const SENTENCE_END_RE = /[。！？…]+[”’」』）)】]*|[.!?]+["'”’)\]]*(?=\s)/g;

/**
 * Every place a cut may fall, with the level that marks it. Offsets are where
 * the next piece starts, so slicing on them loses nothing.
 */
export function findBoundaries(text: string): Boundary[] {
  const depths = quoteDepths(text);
  const found = new Map<number, Boundary>();
  const put = (offset: number, level: BoundaryLevel, label?: string) => {
    if (offset <= 0 || offset >= text.length) return;
    if (depths[offset]! > 0) return;                    // never inside a quotation
    const rest = text.slice(offset, offset + 24);
    if (ATTRIBUTION_RE.test(rest)) return;              // never before "he said"
    const existing = found.get(offset);
    if (existing && LEVEL_ORDER.indexOf(existing.level) <= LEVEL_ORDER.indexOf(level)) return;
    found.set(offset, { offset, level, ...(label ? { label } : {}) });
  };

  for (const match of text.matchAll(CHAPTER_RE)) {
    put(match.index!, 'chapter', match[0].trim());
  }
  for (const match of text.matchAll(SCENE_MARKER_RE)) {
    // The piece starts after the separator line, which is not content.
    const end = match.index! + match[0].length;
    const afterNewline = text.indexOf('\n', end);
    put(afterNewline >= 0 ? afterNewline + 1 : end, 'scene-marker');
  }
  for (const match of text.matchAll(/\n[ \t　]*(?:\r?\n[ \t　]*){2,}/g)) {
    put(match.index! + match[0].length, 'blank-run');
  }
  for (const match of text.matchAll(/\n[ \t　]*\r?\n[ \t　]*/g)) {
    put(match.index! + match[0].length, 'blank');
  }
  for (const match of text.matchAll(/\n[ \t]*[　　]{1,4}(?=\S)/g)) {
    put(match.index! + 1, 'paragraph');                 // an indented new paragraph
  }
  for (const match of text.matchAll(/\n(?=\S)/g)) {
    put(match.index! + 1, 'paragraph');
  }
  for (const match of text.matchAll(SENTENCE_END_RE)) {
    put(match.index! + match[0].length, 'sentence');
  }
  return [...found.values()].sort((a, b) => a.offset - b.offset);
}

// ─── lexical cohesion (TextTiling) ────────────────────────────────────────

/**
 * Character bigrams. Chinese has no spaces, so bigrams stand in for words;
 * they work for alphabetic text too, which keeps one code path.
 */
function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const cleaned = text.replace(/[\s\p{P}\p{S}]+/gu, '');
  for (let i = 0; i + 1 < cleaned.length; i += 1) {
    const gram = cleaned.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (const value of a.values()) aa += value * value;
  for (const [gram, value] of b) {
    bb += value * value;
    const other = a.get(gram);
    if (other) dot += other * value;
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / Math.sqrt(aa * bb);
}

/**
 * How much the vocabulary on either side of each offset has in common. Low
 * means the place, the people or the objects turned over: a seam.
 */
export function cohesionAt(text: string, offsets: readonly number[], windowChars = 220): number[] {
  return offsets.map((offset) => {
    const left = text.slice(Math.max(0, offset - windowChars), offset);
    const right = text.slice(offset, offset + windowChars);
    if (left.length < 40 || right.length < 40) return 1;    // too little to judge: not a seam
    return cosine(bigrams(left), bigrams(right));
  });
}

// ─── splitting ────────────────────────────────────────────────────────────

export type SplitOptions = {
  /** What one scripting call comfortably takes. */
  targetChars?: number;
  /** Never larger than this. */
  maxChars?: number;
  /** Never smaller, except for the last piece. */
  minChars?: number;
};

const DEFAULTS = { targetChars: 3000, maxChars: 6000, minChars: 600 };

/** The seam-finding levels, in the order they are tried. */
function levelsFrom(level: BoundaryLevel): BoundaryLevel[] {
  return LEVEL_ORDER.slice(LEVEL_ORDER.indexOf(level));
}

/**
 * Cuts the text into chunks, descending the boundary levels only as far as it
 * has to and using lexical cohesion to choose among sentence ends.
 */
export function splitLongform(text: string, options: SplitOptions = {}): LongformChunk[] {
  const { targetChars, maxChars, minChars } = { ...DEFAULTS, ...options };
  const source = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  if (source.trim().length === 0) return [];
  const boundaries = findBoundaries(source);

  const pieces: Array<{ start: number; end: number; level: BoundaryLevel; label?: string }> = [];
  const cut = (start: number, end: number, level: BoundaryLevel, label?: string, from: BoundaryLevel = 'blank-run'): void => {
    if (end - start <= maxChars) {
      pieces.push({ start, end, level, ...(label ? { label } : {}) });
      return;
    }
    for (const candidate of levelsFrom(from)) {
      const inside = boundaries.filter(
        (boundary) => boundary.level === candidate
          && boundary.offset > start + minChars
          && boundary.offset < end - minChars,
      );
      if (inside.length === 0) continue;
      const chosen = candidate === 'sentence'
        ? pickBySpacingAndCohesion(source, inside, start, end, targetChars)
        : pickBySpacing(inside, start, end, targetChars);
      if (chosen.length === 0) continue;
      let cursor = start;
      let currentLevel = level;
      let currentLabel = label;
      for (const boundary of chosen) {
        cut(cursor, boundary.offset, currentLevel, currentLabel, candidate);
        cursor = boundary.offset;
        currentLevel = boundary.level;
        currentLabel = boundary.label;
      }
      cut(cursor, end, currentLevel, currentLabel, candidate);
      return;
    }
    // Nothing left to cut on: hard-split so one runaway piece cannot stall
    // the whole job. Every part is a continuation, which the chunks say.
    for (let offset = start; offset < end; offset += maxChars) {
      pieces.push({ start: offset, end: Math.min(end, offset + maxChars), level: 'sentence' });
    }
  };

  // A chapter and a scene separator are cut whatever the sizes are: they are
  // the author's own scene breaks, and chapter six must not inherit chapter
  // five's closing frame however small the two happen to be. Only the levels
  // below them are about fitting a call.
  const scenes = boundaries.filter((boundary) => boundary.level === 'chapter' || boundary.level === 'scene-marker');
  let sceneStart = 0;
  let sceneLevel: BoundaryLevel = boundaries[0]?.offset === 0 ? boundaries[0].level : 'chapter';
  // A heading on the first line is not a boundary -- there is nothing before
  // it -- so chapter one would otherwise be the one chunk with no title.
  let sceneLabel: string | undefined = firstLineHeading(source);
  for (const boundary of scenes) {
    if (boundary.offset <= sceneStart) continue;
    cut(sceneStart, boundary.offset, sceneLevel, sceneLabel);
    sceneStart = boundary.offset;
    sceneLevel = boundary.level;
    sceneLabel = boundary.label;
  }
  cut(sceneStart, source.length, sceneLevel, sceneLabel);

  return pieces
    .map((piece) => ({ ...piece, text: source.slice(piece.start, piece.end).trim() }))
    .filter((piece) => piece.text.length > 0)
    .map((piece, index, all) => {
      // A piece that starts at a chapter, a separator or a run of blank lines
      // is the start of a scene. A piece cut at a paragraph or a sentence is
      // the middle of one, and says so.
      const opensScene = piece.level === 'chapter' || piece.level === 'scene-marker' || piece.level === 'blank-run' || index === 0;
      const next = all[index + 1];
      const closesScene = !next || next.level === 'chapter' || next.level === 'scene-marker' || next.level === 'blank-run';
      return {
        index: index + 1,
        text: piece.text,
        startOffset: piece.start,
        level: piece.level,
        ...(piece.label ? { label: piece.label } : {}),
        opensScene,
        closesScene,
        chars: piece.text.replace(/\s+/g, '').length,
      };
    });
}

/** A chapter heading the text opens with, which is no boundary of its own. */
function firstLineHeading(source: string): string | undefined {
  const firstLine = source.slice(0, source.indexOf('\n') >= 0 ? source.indexOf('\n') : Math.min(80, source.length));
  const re = new RegExp(CHAPTER_RE.source, 'im');
  return re.test(firstLine) ? firstLine.trim() : undefined;
}

/** Boundaries spaced about one target apart. */
function pickBySpacing(
  candidates: readonly Boundary[],
  start: number,
  end: number,
  targetChars: number,
): Boundary[] {
  const chosen: Boundary[] = [];
  let cursor = start;
  for (const boundary of candidates) {
    if (boundary.offset - cursor >= targetChars * 0.6) {
      chosen.push(boundary);
      cursor = boundary.offset;
    }
  }
  // Keep the tail from being a sliver.
  while (chosen.length > 0 && end - chosen[chosen.length - 1]!.offset < targetChars * 0.25) chosen.pop();
  return chosen;
}

/**
 * Among the sentence ends in the allowed window, the one where the vocabulary
 * changes most. This is the only place a judgement is made, and it is made
 * with arithmetic.
 */
function pickBySpacingAndCohesion(
  text: string,
  candidates: readonly Boundary[],
  start: number,
  end: number,
  targetChars: number,
): Boundary[] {
  const chosen: Boundary[] = [];
  let cursor = start;
  while (end - cursor > targetChars * 1.25) {
    const windowStart = cursor + targetChars * 0.6;
    const windowEnd = cursor + targetChars * 1.4;
    const window = candidates.filter((boundary) => boundary.offset > windowStart && boundary.offset < Math.min(windowEnd, end));
    if (window.length === 0) break;
    const scores = cohesionAt(text, window.map((boundary) => boundary.offset));
    let best = 0;
    for (let i = 1; i < window.length; i += 1) {
      if (scores[i]! < scores[best]!) best = i;
    }
    chosen.push(window[best]!);
    cursor = window[best]!.offset;
  }
  return chosen;
}
