// The raw-mode switch for Saga. Raw mode skips narrative analysis, Super
// Visual and the Director, so only an explicit tag turns it on: "[原样直传]"
// or "【raw直传】", a tag alone on a line, or a tag set off by punctuation
// ("…，raw seedance", "raw mode，…"). Everyday wording ("不要滤镜", "short
// prompt") and a tag word inside a sentence ("她说要原样直传这段剧本") do not.

const TAG = '(?:原样直传|raw[-\\s]?直传|raw[-\\s]?mode|raw[-\\s]?seedance|clean[-\\s]?direct|直连\\s*seedance)';
const BRACKETED = `[[【]\\s*${TAG}\\s*[\\]】]`;
const ALONE_ON_LINE = `^[ \\t]*${TAG}[ \\t]*$`;
const AFTER_DELIMITER = `[，,、;；][ \\t]*${TAG}[ \\t]*(?=$|[，,、;；。.!！\\n])`;
const BEFORE_DELIMITER = `^[ \\t]*${TAG}[ \\t]*[，,、;；:：][ \\t]*`;

export function hasRawModeTag(text: string): boolean {
  return [BRACKETED, ALONE_ON_LINE, AFTER_DELIMITER, BEFORE_DELIMITER].some((source) => new RegExp(source, 'im').test(text));
}

/** Removes the raw-mode tag so the video model never sees it. */
export function stripRawModeTag(text: string): string {
  return text
    .replace(new RegExp(BRACKETED, 'gi'), ' ')
    .replace(new RegExp(ALONE_ON_LINE, 'gim'), '')
    .replace(new RegExp(AFTER_DELIMITER, 'gim'), '')
    .replace(new RegExp(BEFORE_DELIMITER, 'gim'), '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
