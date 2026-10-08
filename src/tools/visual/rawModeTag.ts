// Saga has two opt-in modes that loosen the default pipeline, switched on by
// different wording:
//
// - Raw passthrough ("[原样直传]", "【raw直传】"): the script goes to the video
//   model as written. No narrative analysis, Super Visual, keyframes or
//   Director. Only an explicit tag turns it on: in brackets, alone on a line,
//   or leading the request ("/saga 原样直传 …"). The phrase inside a sentence
//   ("她说，原样直传，不要改") does not.
//
// - cleanDirect (Saga Brief Authoring Guide §9.10: "原始质感 / 少滤镜 /
//   raw-seedance / clean-direct", "raw look / low filter"): only the
//   aesthetic dressing is removed (style and aesthetic locks, the Director's
//   scaffolding, the rendering rules). Narrative analysis, Super Visual
//   identity, the character / wardrobe / prop / location locks, subtitle
//   protection and the Critic stay. Everyday wording ("不要滤镜", "无滤镜",
//   "short prompt") does not switch it on.

const RAW_TAG = '(?:原样直传|raw[-\\s]?直传)';
const BRACKETED = `[[【(（]\\s*${RAW_TAG}\\s*[\\]】)）]`;
const ALONE_ON_LINE = `^[ \\t]*${RAW_TAG}[ \\t]*[。.!！]?[ \\t]*$`;
// Only at the very start of the message: "/saga 原样直传 …", "原样直传：…".
const LEADING = `^\\s*(?:/saga\\s+)?${RAW_TAG}[ \\t]*(?:[，,：:。]|\\s|$)`;

export function hasRawModeTag(text: string): boolean {
  return new RegExp(BRACKETED, 'i').test(text)
    || new RegExp(ALONE_ON_LINE, 'im').test(text)
    || new RegExp(LEADING, 'i').test(text);
}

/** Removes the raw-passthrough tag so the video model never sees it. */
export function stripRawModeTag(text: string): string {
  return text
    .replace(new RegExp(BRACKETED, 'gi'), ' ')
    .replace(new RegExp(ALONE_ON_LINE, 'gim'), '')
    .replace(new RegExp(LEADING, 'i'), (match) => (match.trimStart().startsWith('/saga') ? '/saga ' : ''))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CLEAN_DIRECT_KEYWORD_RE = new RegExp([
  '\\braw[-\\s_]?seedance\\b',
  '\\bclean[-\\s_]?direct\\b',
  '\\braw[-\\s_]?mode\\b',
  '直连\\s*seedance',
  '少滤镜',
  '低滤镜',
  '\\blow[-\\s]?filter\\b',
  // "木头的原始质感" describes a material, not the mode.
  '(?<!的)原始质感',
  // "the raw look of the concrete" describes a surface, not the mode.
  '(?<!\\b(?:the|a|its|his|her|their|of)\\s)\\braw[-\\s]look\\b',
].join('|'), 'i');

/** Guide §9.10 keywords that switch on cleanDirect. */
export function hasCleanDirectKeyword(text: string): boolean {
  return CLEAN_DIRECT_KEYWORD_RE.test(text);
}

const CLEAN_DIRECT_FILLER_RE = /请|使用|用|开启|启用|模式|please|use|enable|mode|with|and|[\s/／|、，,;；:：。.!！"“”'‘’()（）[\]【】*_-]+/gi;

/**
 * Removes a line that only switches cleanDirect on ("请用原始质感 / 少滤镜 /
 * raw-seedance / clean-direct。"), so the video model never reads it. A line
 * that says anything else is kept.
 */
export function stripCleanDirectInstruction(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      if (!hasCleanDirectKeyword(line)) return true;
      const rest = line.replace(new RegExp(CLEAN_DIRECT_KEYWORD_RE.source, 'gi'), ' ').replace(CLEAN_DIRECT_FILLER_RE, '');
      return rest.length >= 4;
    })
    .join('\n');
}
