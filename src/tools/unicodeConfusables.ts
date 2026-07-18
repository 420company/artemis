/**
 * tools/unicodeConfusables.ts — Unicode confusable detection and normalization.
 *
 * Several Unicode typography characters are visually identical to ASCII in
 * monospace fonts (smart quotes, dashes, ellipsis, non-breaking space). Files
 * pasted from rich-text sources contain them, read_file renders them like
 * ASCII, and exact-match edit tools then fail to find the ASCII needle. This
 * module provides a narrow, conservative map plus offset-mapped normalized
 * matching so edits can fall back safely without ever guessing.
 */

/** [character, ASCII replacement, human-readable name] */
export const CONFUSABLE_MAP: ReadonlyArray<readonly [string, string, string]> = [
  ['“', '"', 'left double quotation mark'],
  ['”', '"', 'right double quotation mark'],
  ['‘', "'", 'left single quotation mark'],
  ['’', "'", 'right single quotation mark'],
  ['—', '--', 'em-dash'],
  ['–', '-', 'en-dash'],
  ['…', '...', 'horizontal ellipsis'],
  [' ', ' ', 'non-breaking space'],
];

const LOOKUP = new Map(CONFUSABLE_MAP.map(([ch, replacement, name]) => [ch, { replacement, name }]));

export type ConfusableHit = {
  /** UTF-16 code-unit offset in the source string. */
  offset: number;
  char: string;
  replacement: string;
  name: string;
  /** 1-based line number. */
  line: number;
};

export function hasConfusables(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (LOOKUP.has(text[i])) {
      return true;
    }
  }
  return false;
}

export function normalizeConfusables(text: string): string {
  if (!hasConfusables(text)) {
    return text;
  }
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const entry = LOOKUP.get(text[i]);
    out += entry ? entry.replacement : text[i];
  }
  return out;
}

export function detectConfusables(text: string): ConfusableHit[] {
  const hits: ConfusableHit[] = [];
  let line = 1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const entry = LOOKUP.get(char);
    if (entry) {
      hits.push({ offset: i, char, replacement: entry.replacement, name: entry.name, line });
    }
    if (char === '\n') {
      line += 1;
    }
  }
  return hits;
}

/**
 * Build the confusable-normalized string plus an offset map back to the
 * original. `offsetMap` has length `normalized.length + 1`; `offsetMap[i]` is
 * the original code-unit index corresponding to normalized index `i`, with a
 * terminal sentinel `offsetMap[normalized.length] === text.length`. All
 * replacement units of one confusable map back to that character's start, so
 * `text.slice(offsetMap[a], offsetMap[b])` recovers the original span for any
 * normalized range `[a, b)` that starts and ends on character boundaries.
 */
export function buildOffsetMap(text: string): { normalized: string; offsetMap: number[] } {
  let normalized = '';
  const offsetMap: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const entry = LOOKUP.get(text[i]);
    const piece = entry ? entry.replacement : text[i];
    for (let k = 0; k < piece.length; k += 1) {
      offsetMap.push(i);
    }
    normalized += piece;
  }
  offsetMap.push(text.length);
  return { normalized, offsetMap };
}

export type NormalizedMatch = {
  /** Code-unit offset in the original text where the match starts. */
  start: number;
  /** Length of the matched region in the original text. */
  length: number;
};

export type NormalizedMatchResult =
  | { kind: 'none' }
  | { kind: 'matches'; matches: NormalizedMatch[] }
  /**
   * Candidates exist in normalized space but are unsafe to apply (partial
   * expansion inside a multi-char replacement, inverted spans, or overlapping
   * remapped regions). Callers must treat this as an explicit refusal, never
   * as "not found" and never as a match.
   */
  | { kind: 'ambiguous' };

/**
 * Find non-overlapping matches of `pattern` in `text` under confusable
 * normalization and map them back to original coordinates. Every candidate is
 * roundtrip-validated: the recovered original slice must re-normalize to the
 * normalized pattern exactly, which rejects matches that start or end inside
 * an expanded character (e.g. "-" inside an em-dash's "--"). Fails closed.
 */
export function findNormalizedMatches(text: string, pattern: string): NormalizedMatchResult {
  const { normalized, offsetMap } = buildOffsetMap(text);
  const normPattern = normalizeConfusables(pattern);

  if (!normPattern) {
    return { kind: 'none' };
  }

  const validated: NormalizedMatch[] = [];
  let hadRejectedCandidates = false;
  let cursor = 0;

  for (;;) {
    const normStart = normalized.indexOf(normPattern, cursor);
    if (normStart < 0) {
      break;
    }
    cursor = normStart + normPattern.length;

    const origStart = offsetMap[normStart];
    const origEnd = offsetMap[normStart + normPattern.length];

    if (origEnd <= origStart) {
      hadRejectedCandidates = true;
      continue;
    }

    if (normalizeConfusables(text.slice(origStart, origEnd)) !== normPattern) {
      hadRejectedCandidates = true;
      continue;
    }

    validated.push({ start: origStart, length: origEnd - origStart });
  }

  if (validated.length === 0) {
    return hadRejectedCandidates ? { kind: 'ambiguous' } : { kind: 'none' };
  }

  for (let i = 1; i < validated.length; i += 1) {
    if (validated[i - 1].start + validated[i - 1].length > validated[i].start) {
      return { kind: 'ambiguous' };
    }
  }

  return { kind: 'matches', matches: validated };
}

/** Replace the given original-coordinate regions with `replacement`. */
export function replaceNormalizedMatches(
  text: string,
  matches: readonly NormalizedMatch[],
  replacement: string,
): string {
  let out = '';
  let lastEnd = 0;
  for (const match of matches) {
    out += text.slice(lastEnd, match.start);
    out += replacement;
    lastEnd = match.start + match.length;
  }
  out += text.slice(lastEnd);
  return out;
}

/**
 * Summarize which lines of `text` contain which confusable characters, e.g.
 * `line 3: right single quotation mark (’ → ')`. Returns '' when clean.
 */
export function describeConfusableLines(text: string, maxLines = 8): string {
  const hits = detectConfusables(text);
  if (hits.length === 0) {
    return '';
  }

  const byLine = new Map<number, Map<string, ConfusableHit>>();
  for (const hit of hits) {
    let entry = byLine.get(hit.line);
    if (!entry) {
      entry = new Map();
      byLine.set(hit.line, entry);
    }
    if (!entry.has(hit.char)) {
      entry.set(hit.char, hit);
    }
  }

  const lineNumbers = Array.from(byLine.keys()).sort((a, b) => a - b);
  const shown = lineNumbers.slice(0, maxLines).map((line) => {
    const kinds = Array.from(byLine.get(line)!.values())
      .map((hit) => `${hit.name} (${hit.char} -> ${hit.replacement})`)
      .join(', ');
    return `line ${line}: ${kinds}`;
  });
  const more = lineNumbers.length - shown.length;
  return shown.join('; ') + (more > 0 ? `; and ${more} more line(s)` : '');
}
