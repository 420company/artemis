/**
 * tools/office/text.ts — small text helpers shared by the builders:
 * inline emphasis (**bold**, *italic*, `code`), CJK detection, and a rough
 * line-fitting estimate so slide text gets a size that fits its box.
 */

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

const CJK_RE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/**
 * `**bold**`, `__bold__`, `*italic*`, `_italic_` (not inside words) and
 * `` `code` `` as runs. Unmatched markers stay as typed.
 */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const re = /(\*\*|__)(.+?)\1|`([^`]+)`|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const at = match.index ?? 0;
    if (at > last) runs.push({ text: text.slice(last, at) });
    if (match[2] !== undefined) runs.push({ text: match[2], bold: true });
    else if (match[3] !== undefined) runs.push({ text: match[3], code: true });
    else runs.push({ text: match[4] ?? match[5] ?? '', italic: true });
    last = at + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.filter((run) => run.text.length > 0);
}

/** The text without emphasis markers. */
export function plainText(text: string): string {
  return parseInline(text).map((run) => run.text).join('');
}

/** Width of a string in em: CJK and full-width ≈ 1, Latin ≈ 0.55, spaces and narrow punctuation less. */
export function textWidthEm(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) width += 1;
    else if (/[ il.,:;'!|()[\]]/.test(ch)) width += 0.3;
    else if (/[A-Z@#%&MW]/.test(ch)) width += 0.68;
    else width += 0.55;
  }
  return width;
}

/** Lines a paragraph takes in a box `widthIn` inches wide at `pt` points. */
export function linesFor(text: string, widthIn: number, pt: number): number {
  const emIn = pt / 72;
  const perLine = Math.max(1, widthIn / emIn);
  return Math.max(1, Math.ceil(textWidthEm(plainText(text)) / perLine));
}

/**
 * The largest size from `maxPt` down to `minPt` at which the paragraphs fit
 * a box (inches), with `spacing` line height and `gapLines` extra lines of
 * space between paragraphs.
 */
export function fitFontSize(paragraphs: Array<{ text: string; indentIn?: number; scale?: number }>, widthIn: number, heightIn: number, maxPt: number, minPt: number, spacing = 1.2, gapLines = 0.45): number {
  for (let pt = maxPt; pt > minPt; pt -= 1) {
    let lines = 0;
    for (const p of paragraphs) {
      const size = pt * (p.scale ?? 1);
      lines += (linesFor(p.text, widthIn - (p.indentIn ?? 0), size) * spacing + gapLines) * (size / pt);
    }
    if (lines * (pt / 72) <= heightIn) return pt;
  }
  return minPt;
}

/** A file-name stem from a title: letters, digits and CJK kept, everything else a dash. */
export function slugify(title: string | undefined, fallback: string): string {
  const slug = (title ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** A table cell as text: small integers (years, counts) as typed, larger numbers grouped. */
export function formatCellNumber(value: string | number): string {
  if (typeof value !== 'number') return value;
  if (Number.isInteger(value) && Math.abs(value) < 10_000) return String(value);
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
