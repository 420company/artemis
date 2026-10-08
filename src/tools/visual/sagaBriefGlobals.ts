// Global sections of a brief written to the Saga Brief Authoring Guide (§6):
// 【整片叙事】 / [Story], 【画质规格】 / [Picture specs], 【全局基调】 /
// [Global tone] and 【时空锚点 / WORLD ANCHOR】 / [World anchor]. They are read
// once into short structured fields so the locks reach every segment prompt
// within the model's prompt limit, instead of riding along in the long
// source-story text that gets cut first.

export type SagaWorldAnchor = {
  name: string;
  startSeconds: number;
  endSeconds: number;
  lines: string[];
};

export type SagaBriefGlobals = {
  /** One entry per locked character ("A（林夏，女主）: 26 岁…") or one text card (§9.8). */
  characters: string[];
  palette: string[];
  lighting?: string;
  mood?: string;
  /** The brief's camera-position line (镜头机位 / Camera position). */
  cameraLanguage?: string;
  /** The opening of 【整片叙事】 / [Story]. */
  storyEssence?: string;
  /** 【画质规格】 / [Picture specs] lines other than the ratio, palette and lighting. */
  pictureSpecs: string[];
  worldAnchors: SagaWorldAnchor[];
};

const TIME_TOKEN = '\\d+(?::\\d{1,2}){0,2}(?:\\.\\d+)?';
const SEGMENT_MARKER_RE = new RegExp(`^\\s*\\[\\s*${TIME_TOKEN}\\s*(?:秒|s|sec|seconds)?\\s*[-–—~至到]\\s*${TIME_TOKEN}\\s*(?:秒|s|sec|seconds)?\\s*\\]`, 'im');
const ANCHOR_HEADER_RE = new RegExp(
  `^\\s*[[【]\\s*(?:锚点|anchor)\\s*[·•:：-]?\\s*(?<name>[^|｜\\]】\\n]+?)\\s*[|｜]\\s*(?:第\\s*)?(?<start>${TIME_TOKEN})\\s*(?:秒|s|sec|seconds)?\\s*[-–—~至到]\\s*(?<end>${TIME_TOKEN})\\s*(?:秒|s|sec|seconds)?\\s*[\\]】]`,
  'i',
);
const SECTION_HEADER_RE = /^\s*(?:【[^】\n]{1,30}】|\[(?:story|picture specs?|global tone|world anchor|sound|appendix)[^\]\n]{0,40}\])/i;
const DIVIDER_RE = /^\s*[═=─━\-_*]{6,}\s*$/;
const BULLET_RE = /^\s*[·•*-]\s*/;

function timeToSeconds(token: string): number {
  const parts = token.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The part of the brief before the first timecoded segment. */
function globalPart(text: string): string {
  const match = text.match(SEGMENT_MARKER_RE);
  return match?.index === undefined ? text : text.slice(0, match.index);
}

/** The body of a section such as 【整片叙事】, up to the next header or divider. */
function sectionBody(lines: string[], header: RegExp): string[] {
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (SECTION_HEADER_RE.test(line) || DIVIDER_RE.test(line)) {
      if (body.some((entry) => entry.trim())) break;
      continue;
    }
    body.push(line);
  }
  return body;
}

/** "· 色彩: …" / "· Palette: …" anywhere in the global part. */
function fieldValue(lines: string[], label: RegExp): string | undefined {
  for (const line of lines) {
    const match = line.replace(BULLET_RE, '').match(new RegExp(`^(?:${label.source})\\s*(?:[（(][^）)]*[）)])?\\s*[:：]\\s*(.+)$`, 'i'));
    if (match?.[1] && clean(match[1])) return clean(match[1]);
  }
  return undefined;
}

const CHARACTER_LABEL_RE = /^\s*(?:[A-Z]|[A-Z]\d|角色\s*[A-Z\d]|主角|女主|男主)\s*(?:[（(][^）)]{0,40}[）)])?\s*[:：]/;

/**
 * CHARACTER LOCK entries: an inline value, labelled lines ("A（…）: …",
 * "B (…): …") or a multi-line text card (§9.8), which becomes one entry.
 */
function characterLock(lines: string[]): string[] {
  const index = lines.findIndex((line) => /^\s*[·•*-]?\s*(?:character\s*lock|角色锁定?|人物锁定?)\s*[:：]/i.test(line));
  if (index < 0) return [];
  const inline = clean(lines[index]!.replace(/^\s*[·•*-]?\s*(?:character\s*lock|角色锁定?|人物锁定?)\s*[:：]/i, ''));
  const block: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!line.trim()) break;
    // The next top-level bullet ("· 声音层级:") or section ends the card.
    if (!/^\s/.test(line) || /^\s*[·•]/.test(line) || SECTION_HEADER_RE.test(line)) break;
    block.push(clean(line.replace(/^\s*[-*]\s*/, '')));
  }
  if (block.length === 0) return inline ? [inline] : [];
  const labelled = block.filter((line) => CHARACTER_LABEL_RE.test(line));
  if (labelled.length > 0) {
    // Unlabelled lines continue the character above them.
    const entries: string[] = [];
    for (const line of block) {
      if (CHARACTER_LABEL_RE.test(line) || entries.length === 0) entries.push(line);
      else entries[entries.length - 1] = `${entries[entries.length - 1]} ${line}`;
    }
    return inline ? [inline, ...entries] : entries;
  }
  return [clean([inline, ...block].filter(Boolean).join(' '))];
}

function worldAnchors(text: string): SagaWorldAnchor[] {
  const lines = text.split(/\r?\n/);
  const anchors: SagaWorldAnchor[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(ANCHOR_HEADER_RE);
    if (!match?.groups) continue;
    const startSeconds = timeToSeconds(match.groups.start!);
    const endSeconds = timeToSeconds(match.groups.end!);
    if (!(endSeconds > startSeconds)) continue;
    const bullets: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (ANCHOR_HEADER_RE.test(line) || SECTION_HEADER_RE.test(line) || DIVIDER_RE.test(line) || SEGMENT_MARKER_RE.test(line)) break;
      if (/^\s*[-•·*]\s+/.test(line)) bullets.push(clean(line.replace(/^\s*[-•·*]\s+/, '')));
      else if (!line.trim() && bullets.length > 0) break;
    }
    if (bullets.length > 0) anchors.push({ name: clean(match.groups.name!), startSeconds, endSeconds, lines: bullets });
  }
  return anchors;
}

export function parseSagaBriefGlobals(text: string): SagaBriefGlobals {
  const global = globalPart(text ?? '');
  const lines = global.split(/\r?\n/);
  const story = clean(sectionBody(lines, /^\s*(?:【\s*整片叙事\s*】|\[\s*story\s*\])/i).join(' '));
  const specLines = sectionBody(lines, /^\s*(?:【\s*画质规格\s*】|\[\s*picture\s*specs?\s*\])/i)
    .map((line) => clean(line.replace(BULLET_RE, '')))
    .filter((line) => line && !/^(?:画幅|画面比例|画面尺寸|比例|aspect\s*ratio|ratio|色彩|色调|palette|colou?r|光照|光线|lighting)/i.test(line));
  const palette = fieldValue(lines, /色彩|色调|palette|colou?r(?:\s*palette)?/);
  return {
    characters: characterLock(lines),
    palette: palette ? [palette] : [],
    lighting: fieldValue(lines, /光照(?:风格)?|光线|lighting(?:\s*style)?/),
    mood: fieldValue(lines, /vibe|基调|mood/),
    cameraLanguage: fieldValue(lines, /镜头机位|机位|camera\s*position/),
    storyEssence: story || undefined,
    pictureSpecs: specLines,
    worldAnchors: worldAnchors(global),
  };
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Story essence plus picture specs, within maxChars. Empty when the brief has neither. */
export function formatGlobalBriefExcerpt(globals: SagaBriefGlobals, maxChars = 380): string {
  const specs = globals.pictureSpecs.join('; ');
  if (!globals.storyEssence && !specs) return '';
  const label = '[GLOBAL BRIEF] ';
  const specPart = specs ? ` Picture: ${clip(specs, Math.floor((maxChars - label.length) * 0.45))}` : '';
  const storyRoom = maxChars - label.length - specPart.length - 8;
  const storyPart = globals.storyEssence ? `Story: ${clip(globals.storyEssence, Math.max(60, storyRoom))}` : '';
  return clip(`${label}${storyPart}${specPart}`.trim(), maxChars);
}

/** World-anchor lines for a segment spanning [startSeconds, endSeconds). */
export function worldAnchorLinesFor(globals: SagaBriefGlobals, startSeconds: number, endSeconds: number): string {
  const active = globals.worldAnchors.filter((anchor) => anchor.startSeconds < endSeconds && anchor.endSeconds > startSeconds);
  if (active.length === 0) return '';
  return active
    .map((anchor) => `[WORLD ANCHOR · ${anchor.name}: ${anchor.lines.join('; ')}]`)
    .join('\n');
}

const APPENDIX_RE = /^\s*(?:【\s*附录[^】\n]*】|\[\s*appendix\b[^\]\n]*\])/im;

/**
 * Drops what a brief carries only for human readers: divider lines
 * ("═══…") and the 【附录…】 / [Appendix…] section with everything after it.
 */
export function stripBriefNoise(text: string): string {
  const appendix = text.match(APPENDIX_RE);
  const body = appendix?.index === undefined ? text : text.slice(0, appendix.index);
  return body
    .split('\n')
    .filter((line) => !DIVIDER_RE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
