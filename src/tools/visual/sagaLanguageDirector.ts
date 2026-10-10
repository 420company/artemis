import { toolWarn } from '../../utils/log.js';
import { chatCompletionContent, postSagaChatCompletion, resolveSagaChatEndpoint } from './sagaChat.js';

export type SagaDialogueUse = 'spoken_dialogue' | 'voiceover' | 'subtitle' | 'quoted_dialogue';

export type SagaDialogueLine = {
  text: string;
  language: string;
  use: SagaDialogueUse;
  marker?: string;
};

export type SagaGenerationLanguageResult = {
  /** The brief, with speaker names and stage directions moved outside quoted dialogue. */
  originalText: string;
  generationText: string;
  /** generationText without its leading dialogue note: the brief as rewritten or templated. */
  bodyText: string;
  generationLanguage: 'en';
  dialogueLines: SagaDialogueLine[];
  usedLlmRewrite: boolean;
};

export type SagaSubtitleMode = 'auto' | 'always' | 'off';

function uniqueLines(lines: SagaDialogueLine[]): SagaDialogueLine[] {
  const seen = new Set<string>();
  const out: SagaDialogueLine[] = [];
  for (const line of lines) {
    const key = `${line.language}:${line.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function detectTextLanguage(text: string): string {
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return 'Japanese';
  if (/\p{Script=Han}/u.test(text)) return 'Mandarin Chinese';
  if (/\p{Script=Hangul}/u.test(text)) return 'Korean';
  if (/\p{Script=Arabic}/u.test(text)) return 'Arabic';
  if (/\p{Script=Cyrillic}/u.test(text)) return 'Russian';
  if (/[\u0E00-\u0E7F]/u.test(text)) return 'Thai';
  const normalized = text.toLowerCase().normalize('NFC');
  if (/[¿¡ñ]/u.test(normalized) || /\b(el|la|los|las|un|una|que|estoy|eres|soy|vamos|gracias|hola|adiós|corazón)\b/u.test(normalized)) return 'Spanish';
  if (/[àâæçéèêëîïôœùûüÿ]/u.test(normalized) || /\b(le|la|les|un|une|des|je|tu|nous|vous|suis|êtes|bonjour|merci|amour)\b/u.test(normalized)) return 'French';
  if (/[àèéìîòóù]/u.test(normalized) || /\b(il|lo|la|gli|una|sono|sei|siamo|ciao|grazie|amore|perché)\b/u.test(normalized)) return 'Italian';
  return 'English';
}

function classifyDialogueUse(marker: string | undefined): SagaDialogueUse {
  const value = (marker ?? '').toLowerCase();
  if (/旁白|voice\s*over|voiceover|narration|narrator/.test(value)) return 'voiceover';
  if (/字幕|subtitle|caption|on[-\s]?screen/.test(value)) return 'subtitle';
  if (/对白|台词|dialogue|\bline\b|spoken|says|said|whispers|whispered|murmurs|murmured|asks|asked|replies|replied|shouts|shouted|说|道|问|喊|低声/.test(value)) return 'spoken_dialogue';
  return 'quoted_dialogue';
}

// ─── Spoken-line cleanup ──────────────────────────────────────────────────
// Briefs often write a quoted line with its speaker and a stage direction
// inside the quotes: “方天豪：（豪迈大笑）今天谁也别想走！”. Video models
// speak everything inside the quotes, so the name and the direction were read
// aloud. The rules below separate them, and they are deliberately narrow so
// real speech is never cut:
//   - a speaker prefix is a name (Han characters, or one to four capitalized
//     Latin words) followed by a colon, with no digits ("10:30" stays);
//   - it is only removed when the name is known (passed in, or seen elsewhere
//     in the brief as "Name: (direction)") or a parenthetical follows it, so
//     "注意：前方有危险！" and "Listen: the bridge is out!" stay intact;
//   - only a leading parenthetical, or a trailing one after sentence-final
//     punctuation, counts as a stage direction; "我（们）一起走吧。" stays;
//   - a second "Name：（direction）" after a sentence ends starts a new line
//     by that speaker; a quote that is only a direction is not speech;
//   - typographic “…” and 「…」 quotes are always paired; plain ASCII "…" only
//     on a line with an even number of them, and only when the quote hugs its
//     text, so 6" blade or 5"照片 never pairs with real dialogue.

const SPEAKER_NAME_SOURCE = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}ー·]{1,8}|[A-Z][A-Za-z'’.-]*(?:[ \\t]+[A-Z][A-Za-z'’.-]*){0,3}";
const SPEAKER_PREFIX_RE = new RegExp(`^[*_]*(?<name>${SPEAKER_NAME_SOURCE})[*_]*[ \\t]*[:：][ \\t]*`, 'u');
// A later speaker inside the same quote: after a sentence ends, "Name：（cue）".
// ASCII "." is left out so "Dr. Smith:" or "Mr. O'Brien:" never splits.
const MID_SPEAKER_RE = new RegExp(`(?<=[。！？!?…~～])[ \\t]*(?=(?<name>${SPEAKER_NAME_SOURCE})[ \\t]*[:：][ \\t]*[（(][^（）()\\n]{1,40}[）)])`, 'gu');
// Words that label what follows rather than name a speaker ("注意：（压低声音）…").
const NOT_A_SPEAKER = new Set([
  '注意', '提示', '警告', '小心', '听着', '记住', '说明', '备注', '旁白', '字幕', '画外音', '等等', '快', '喂',
  // Labels of text shown on screen or sung, never speech.
  '参考', '风格', '歌词', '招牌', '标题', '标语', '横幅', '海报', '屏幕', '文字', '片名', '字卡', '画面', '镜头', '场景', '地点', '背景', '声音', '环境音', '首帧定位',
  'note', 'warning', 'caution', 'listen', 'look', 'wait', 'remember', 'hey', 'narrator', 'caption', 'subtitle',
  'reference', 'style', 'lyrics', 'lyric', 'sign', 'title', 'text', 'screen', 'banner', 'poster', 'scene', 'camera', 'shot', 'sound', 'location', 'setting',
]);

function isSpeakerName(name: string): boolean {
  return !NOT_A_SPEAKER.has(name.trim().toLowerCase());
}
const LEADING_CUE_RE = /^[（(](?<cue>[^（）()\n]{1,40})[）)][ \t]*/u;
// A direction right after a sentence ends, anywhere in the line ("Yes! (laughs) Absolutely!").
// ASCII "." only counts at the end of the line, so "Dr. (Jane) Smith" is left alone.
const AFTER_SENTENCE_CUE_RE = /(?<=[。！？!?…~～])[ \t]*[（(](?<cue>[^（）()\n]{1,40})[）)][ \t]*|(?<=\.)[ \t]*[（(](?<endCue>[^（）()\n]{1,40})[）)][ \t]*$/gu;
// Single quotes are left out: they collide with English apostrophes.
const QUOTED_SPAN_RE = /(?<open>“)(?<inner>[^“”\n]{1,240})(?<close>”)|(?<open2>「)(?<inner2>[^「」\n]{1,240})(?<close2>」)|(?<open3>")(?<inner3>[^"\s\n](?:[^"\n]{0,238}[^"\s\n])?)(?<close3>")/gu;

const ON_SCREEN_TEXT_LEAD_RE = /(?:写下|写着|写道|写了|显示|显示着|印着|标着|字幕|标题|招牌|屏幕上|黑板上|reads|says on|shows|caption|title card)[:：]?\s*$/iu;

type QuotedSpan = { whole: string; index: number; open: string; inner: string; close: string };

/** Quoted spans of a text, skipping ASCII pairs on lines where their pairing is ambiguous. */
function quotedSpans(text: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  for (const match of text.matchAll(QUOTED_SPAN_RE)) {
    const groups = match.groups ?? {};
    const index = match.index ?? 0;
    if (groups.open3) {
      const lineStart = text.lastIndexOf('\n', index) + 1;
      const lineEnd = text.indexOf('\n', index);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if ((line.match(/"/g) ?? []).length % 2 !== 0) continue;
    }
    spans.push({
      whole: match[0],
      index,
      open: groups.open ?? groups.open2 ?? groups.open3 ?? '"',
      inner: groups.inner ?? groups.inner2 ?? groups.inner3 ?? '',
      close: groups.close ?? groups.close2 ?? groups.close3 ?? '"',
    });
  }
  return spans;
}

export type ParsedSpokenLine = {
  /** Only the words to be spoken; empty when the quote is only a direction. */
  spoken: string;
  speaker?: string;
  /** Stage directions removed from the line, e.g. "豪迈大笑". */
  cues: string[];
};

function parseSingleSpeakerLine(raw: string, knownSpeakers: ReadonlySet<string>): ParsedSpokenLine {
  let rest = raw.trim();
  let speaker: string | undefined;
  const cues: string[] = [];
  const prefix = SPEAKER_PREFIX_RE.exec(rest);
  if (prefix?.groups?.name) {
    const name = prefix.groups.name.trim();
    const afterName = rest.slice(prefix[0].length);
    if (knownSpeakers.has(name) || (isSpeakerName(name) && LEADING_CUE_RE.test(afterName))) {
      speaker = name;
      rest = afterName;
    }
  }
  for (let leading = LEADING_CUE_RE.exec(rest); leading?.groups?.cue; leading = LEADING_CUE_RE.exec(rest)) {
    cues.push(leading.groups.cue.trim());
    rest = rest.slice(leading[0].length);
  }
  rest = rest.replace(AFTER_SENTENCE_CUE_RE, (...args) => {
    const groups = args[args.length - 1] as { cue?: string; endCue?: string };
    cues.push((groups.cue ?? groups.endCue ?? '').trim());
    return ' ';
  }).replace(/(?<=[。！？…～])[ \t]+/gu, '');
  return { spoken: rest.trim(), ...(speaker ? { speaker } : {}), cues };
}

/**
 * Splits a quoted line into one entry per speaker: the words spoken, the
 * speaker and the stage directions. “方天豪：（大笑）走！李四：（冷笑）你走不了。”
 * gives two entries.
 */
export function parseSpokenLines(raw: string, knownSpeakers: ReadonlySet<string> = new Set()): ParsedSpokenLine[] {
  const original = raw.replace(/\s+/g, ' ').trim();
  const pieces: string[] = [];
  let start = 0;
  for (const match of original.matchAll(MID_SPEAKER_RE)) {
    if (!isSpeakerName(match.groups?.name ?? '')) continue;
    const at = match.index ?? 0;
    pieces.push(original.slice(start, at));
    start = at + match[0].length;
  }
  pieces.push(original.slice(start));
  return pieces
    .map((piece) => parseSingleSpeakerLine(piece, knownSpeakers))
    .filter((piece) => piece.spoken || piece.speaker || piece.cues.length > 0);
}

/** The first speaker's entry of a quoted line (see parseSpokenLines). */
export function parseSpokenLine(raw: string, knownSpeakers: ReadonlySet<string> = new Set()): ParsedSpokenLine {
  return parseSpokenLines(raw, knownSpeakers)[0] ?? { spoken: '', cues: [] };
}

/** Names written as "Name: (direction)" inside any quoted line of the brief. */
function speakersWithDirections(text: string): Set<string> {
  const names = new Set<string>();
  for (const span of quotedSpans(text)) {
    for (const piece of parseSpokenLines(span.inner)) {
      if (piece.speaker) names.add(piece.speaker);
    }
  }
  return names;
}

function knownSpeakerSet(text: string, extra: readonly string[] | undefined): Set<string> {
  const names = speakersWithDirections(text);
  for (const name of extra ?? []) {
    const trimmed = name.trim();
    if (trimmed) names.add(trimmed);
  }
  return names;
}

/**
 * Moves speaker names and stage directions out of quoted dialogue so only the
 * spoken words stay inside the quotes: “方天豪：（豪迈大笑）今天谁也别想走！”
 * becomes （方天豪，豪迈大笑）“今天谁也别想走！”, and a quote that is only a
 * direction loses its quotes. Quotes without such cues are left unchanged.
 */
export function relocateDialogueCues(text: string, options: { knownSpeakers?: readonly string[] } = {}): string {
  const known = knownSpeakerSet(text, options.knownSpeakers);
  let out = '';
  let cursor = 0;
  for (const span of quotedSpans(text)) {
    const pieces = parseSpokenLines(span.inner, known);
    const changed = pieces.length > 1 || pieces.some((piece) => piece.speaker || piece.cues.length > 0);
    if (!changed) continue;
    // A quote after "写下 / 显示 / 字幕 …" is text shown on screen, not speech: keep it as written.
    if (pieces.every((piece) => !piece.spoken) && ON_SCREEN_TEXT_LEAD_RE.test(text.slice(Math.max(0, span.index - 12), span.index))) continue;
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(span.inner) || span.open !== '"';
    const rendered = pieces.map((piece) => {
      const notes = [piece.speaker, ...piece.cues].filter((part): part is string => Boolean(part));
      const note = notes.length === 0 ? '' : cjk ? `（${notes.join('，')}）` : `(${notes.join(', ')})${piece.spoken ? ' ' : ''}`;
      return piece.spoken ? `${note}${span.open}${piece.spoken}${span.close}` : note;
    }).join(cjk ? '' : ' ');
    out += text.slice(cursor, span.index) + rendered;
    cursor = span.index + span.whole.length;
  }
  return out + text.slice(cursor);
}

// Dialogue markers of the Saga Brief Authoring Guide (§3.2). Only text after
// one of them is speech; bare quotes are signs, titles, lyrics or concepts.
const SPEECH_VERB_MARKER_SOURCE = '(?:she|he|they)\\s+(?:says|said|whispers|whispered|murmurs|murmured|asks|asked|replies|replied|shouts|shouted)|[她他]\\s*(?:轻声|低声|小声|大声|笑着|轻轻)?\\s*(?:说道|说|道|问|喊)';
export const DIALOGUE_MARKER_SOURCE = `对白|台词|旁白|字幕|画外音|spoken\\s*dialogue|spoken\\s*line|dialogue|line|voice\\s*over|voiceover|narration|narrator|subtitle|caption|${SPEECH_VERB_MARKER_SOURCE}`;
// A quoted line, pairing each kind of quote with its own closer so an
// apostrophe inside ("I've", "Je t'ai", "we'd") never ends the line.
export const QUOTED_LINE_SOURCE = '(?:“(?<q1>[^”\\n]{1,240})”|「(?<q2>[^」\\n]{1,240})」|"(?<q3>[^"\\n]{1,240})"|‘(?<q4>[^‘\\n]{1,240}?)’(?!\\p{L}))';
const MARKED_LINE_RE = new RegExp(
  `(?:^|[\\n\\r。；;.!?！？，,、\\s])[*_]*(?<marker>${DIALOGUE_MARKER_SOURCE})[*_]*\\s*(?:[（(][^）)]{0,40}[）)])?\\s*[*_]*\\s*[:：]\\s*(?:[（(][^）)\\n]{0,60}[）)]\\s*)?${QUOTED_LINE_SOURCE}`,
  'giu',
);
// "周屿：“（轻笑）我回来了。”" — a speaker name opening a line or a sentence.
const SPEAKER_LINE_RE = new RegExp(
  `(?:^|\\n|(?<=[。！？!?]))[ \\t]*[*_]*(?<name>${SPEAKER_NAME_SOURCE})[*_]*[ \\t]*[:：][ \\t]*(?:[（(][^）)\\n]{0,60}[）)][ \\t]*)?${QUOTED_LINE_SOURCE}`,
  'gu',
);
// "calls" and "sings" are left out: 'He calls "the Red Room" home', 'She sings "Moon River"'.
const EN_SPEECH_VERBS = 'says|said|asks|asked|whispers|whispered|shouts|shouted|replies|replied|yells|yelled|murmurs|murmured|mutters|muttered|cries|cried|answers|answered';
// People a speech verb can follow as "the …" ("The old man asks"); "the
// report / newspaper / radio / clock says" is not a speaker.
const PERSON_NOUN_SOURCE = '(?:(?:old|young|little|tired|elderly|other)[ \\t]+)?(?:man|woman|men|women|girl|boy|child|kid|mother|father|mom|dad|mum|wife|husband|son|daughter|brother|sister|grandmother|grandfather|grandma|grandpa|teacher|officer|narrator|stranger|guard|soldier|doctor|nurse|host|hostess|driver|waiter|waitress|detective|captain|lady|gentleman|friend|neighbou?r|priest|boss|girlfriend|boyfriend|student|clerk|announcer|reporter|anchor|stewardess|pilot|chef|cop|nun|monk|king|queen|prince|princess|lead|hero|heroine|protagonist)';
// "Elias says: “…”", "Lin Xia whispers “…”", "the old man asks: “…”". Case-
// sensitive, so a name is one to three capitalised words, not after "the" /
// "a" ("The Bible says" is a book).
const EN_SPEAKER_VERB_RE = new RegExp(
  `(?<![\\p{L}])(?<name>[Ss]he|[Hh]e|[Tt]hey|(?<!\\b(?:[Tt]he|[Aa]n?)[ \\t]+)(?!(?:The|An?)\\b)[A-Z][\\p{Ll}'’-]+(?:[ \\t]+[A-Z][\\p{Ll}'’-]+){0,2}|(?:[Tt]he|[Aa]n?|[Hh]is|[Hh]er|[Tt]heir|[Mm]y|[Oo]ur)[ \\t]+${PERSON_NOUN_SOURCE})[ \\t]+(?:${EN_SPEECH_VERBS})(?:[ \\t]+(?:softly|quietly|loudly|gently|firmly|coldly))?[ \\t]*[:,]?[ \\t]*(?:\\([^)\\n]{0,40}\\)[ \\t]*)?${QUOTED_LINE_SOURCE}`,
  'gu',
);
// "“Just Elias,” he says." — the speaker after the line.
const EN_TRAILING_SPEAKER_RE = new RegExp(
  `${QUOTED_LINE_SOURCE}[ \\t]*(?<name>[Ss]he|[Hh]e|[Tt]hey|[A-Z][\\p{Ll}'’-]+(?:[ \\t]+[A-Z][\\p{Ll}'’-]+){0,2})[ \\t]+(?:${EN_SPEECH_VERBS})\\b`,
  'gu',
);
// "林夏轻声说：“…”", "他喊道“林夏！”", "老陈笑着喊：“别动！”" — a speech verb right
// before the quote, colon optional.
const ZH_SPEAKER_VERB_RE = new RegExp(
  `(?<name>[她他它]们?|[\\p{Script=Han}]{1,4}?)(?:轻声|低声|小声|大声|笑着|轻轻地?|冷冷地?|淡淡地?|哽咽着|颤声|小心地|喃喃)?(?:说道|说|问道|问|喊道|喊|叫道|答道|回答|低语|嘀咕|嘟囔|笑道)[ \\t]*[:：]?[ \\t]*(?:[（(][^）)\\n]{0,40}[）)][ \\t]*)?${QUOTED_LINE_SOURCE}`,
  'gu',
);
// Words that end in a speech verb but name something else: "小说“…”", "呐喊“…”".
const NOT_SPEECH_VERB_RE = /(?:小|传|听|据|解|学|演|游|劝|胡|评)说|(?:疑|顾|学|访|提|质)问|呐喊|回答[题案]|俗话|常言|老话|古人|报告|新闻|报纸|数据|文件|广告|标语|海报|通知|公告|书上|网上|大家都|人们常|人们都|有人说/u;
// Text shown on screen is never speech: "招牌写着：“老火锅。”", "the sign says".
const DISPLAY_TEXT_RE = /写着|写道|写了|印着|显示|标着|刻着|贴着|打着|亮着|招牌|标题|字幕|歌词|屏幕上|\b(?:sign|signs|screen|caption|poster|banner|title|card|label|text|board|billboard|note|headline|plaque|display|message|letter|page|menu|notice|graffiti|tattoo|song|lyrics?)\b|\breads?\b/iu;

function quotedLineOf(groups: Record<string, string | undefined> | undefined): string | undefined {
  return groups?.q1 ?? groups?.q2 ?? groups?.q3 ?? groups?.q4;
}

/**
 * Spoken, voiceover and subtitle lines of a brief: quoted text after an
 * explicit marker (**对白（…）**, **台词**, **旁白**, **字幕**, dialogue: /
 * line: / voiceover: / subtitle: / Narrator:), after a speaker and a speech
 * verb ("Elias says: “…”", "林夏轻声说“…”", "“…,” he says"), or after a
 * speaker name opening the line ("周屿：“…”"). Bare quotes are never dialogue
 * (guide §3.2): lyrics, sign text, titles and quoted concepts stay plain text.
 */
export function extractSagaDialogueLines(text: string, options: { knownSpeakers?: readonly string[] } = {}): SagaDialogueLine[] {
  const known = knownSpeakerSet(text, options.knownSpeakers);
  const spokenTexts = (raw: string | undefined): string[] => (raw
    ? parseSpokenLines(raw, known).map((piece) => piece.spoken).filter(Boolean)
    : []);
  const found = new Map<number, SagaDialogueLine[]>();
  const add = (index: number, raw: string | undefined, use: SagaDialogueUse, marker: string) => {
    if (found.has(index)) return;
    found.set(index, spokenTexts(raw).map((line) => ({ text: line, language: detectTextLanguage(line), use, marker })));
  };
  // The position of the quote keys each line, so two rules reading the same
  // quote add it once.
  const quoteIndex = (match: RegExpMatchArray) => (match.index ?? 0) + match[0].length - (quotedLineOf(match.groups)?.length ?? 0);
  for (const match of text.matchAll(MARKED_LINE_RE)) {
    const marker = match.groups?.marker?.trim() ?? '';
    add(quoteIndex(match), quotedLineOf(match.groups), classifyDialogueUse(marker), marker);
  }
  for (const match of text.matchAll(EN_SPEAKER_VERB_RE)) {
    const name = match.groups?.name?.trim() ?? '';
    if (DISPLAY_TEXT_RE.test(name)) continue;
    add(quoteIndex(match), quotedLineOf(match.groups), 'spoken_dialogue', name);
  }
  for (const match of text.matchAll(EN_TRAILING_SPEAKER_RE)) {
    const name = match.groups?.name?.trim() ?? '';
    if (DISPLAY_TEXT_RE.test(name)) continue;
    const quoted = quotedLineOf(match.groups) ?? '';
    add((match.index ?? 0) + 1, quoted.replace(/[,，]\s*$/, ''), 'spoken_dialogue', name);
  }
  for (const match of text.matchAll(ZH_SPEAKER_VERB_RE)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 6), match.index ?? 0);
    const head = match[0].slice(0, match[0].length - (quotedLineOf(match.groups)?.length ?? 0));
    if (DISPLAY_TEXT_RE.test(before + head) || NOT_SPEECH_VERB_RE.test(head)) continue;
    add(quoteIndex(match), quotedLineOf(match.groups), 'spoken_dialogue', head.replace(/[\s:：“"「‘（(].*$/u, ''));
  }
  for (const match of text.matchAll(SPEAKER_LINE_RE)) {
    const name = match.groups?.name?.trim() ?? '';
    if (!isSpeakerName(name) || DISPLAY_TEXT_RE.test(name) || NOT_SPEECH_VERB_RE.test(name) || new RegExp(`^(?:${DIALOGUE_MARKER_SOURCE})$`, 'iu').test(name)) continue;
    // A label ("参考：“Parts Unknown”") is not a speaker: the name must be a
    // known character, or the quote a sentence.
    const quoted = quotedLineOf(match.groups) ?? '';
    if (!known.has(name) && !/[。！？!?…~～.]\s*$/u.test(quoted)) continue;
    add(quoteIndex(match), quoted, 'spoken_dialogue', name);
  }
  const lines = [...found.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, entries]) => entries);
  return uniqueLines(lines);
}

const DIALOGUE_BLOCK_MAX_LINES = 8;

function describeDialogueLine(line: SagaDialogueLine): string {
  const text = line.text.length > 90 ? `${line.text.slice(0, 89)}…` : line.text;
  const use = line.use === 'voiceover' ? 'voiceover, no lip-sync' : line.use === 'subtitle' ? 'on-screen subtitle' : 'spoken';
  return `“${text}” (${line.language}, ${use})`;
}

/** Longest list of lines in a compact dialogue block (the lines also stay in the brief below it). */
const COMPACT_DIALOGUE_LIST_CHARS = 200;

type DialogueBlockOptions = {
  /** Fewer listed lines: the prompt below already carries them. */
  compact?: boolean;
  /**
   * Saga briefs (guide §3.2): only marked lines are speech. A plain
   * generate_video prompt keeps the general rule that quoted speech is
   * dialogue ("She says “We made it home.”").
   */
  markedDialogueOnly?: boolean;
};

function buildDialogueBlock(dialogueLines: SagaDialogueLine[], subtitleMode: SagaSubtitleMode = 'auto', options: DialogueBlockOptions = {}): string {
  const { compact = false, markedDialogueOnly = false } = options;
  const subtitlePolicy = subtitleMode === 'always'
    ? '- Render readable on-screen subtitles/captions for spoken dialogue and voiceover, preserving the exact original characters.'
    : subtitleMode === 'off'
      ? '- Dialogue and voiceover are audio only; render on-screen text only for lines marked subtitle/caption.'
      : '- Only render on-screen subtitles/captions when the brief explicitly marks a line as subtitle/caption.';
  if (!markedDialogueOnly) {
    const languages = Array.from(new Set(dialogueLines.map((line) => line.language))).filter(Boolean).join(', ');
    return [
      'Dialogue handling:',
      dialogueLines.length > 0
        ? `- Quoted text in the brief is spoken dialogue (or voiceover/subtitle if explicitly marked). Detected languages: ${languages || 'as-written'}.`
        : '- Treat quoted speech in the brief as spoken dialogue in its original language; do not translate.',
      '- Render speech in the original language with matching lip-sync; do not translate or romanize.',
      subtitlePolicy,
    ].join('\n');
  }
  if (dialogueLines.length === 0) {
    // A segment without marked lines may still show people talking: say only
    // what is not speech.
    return [
      'Dialogue handling:',
      '- Lyrics, signs, titles and quoted concepts in the brief are not speech.',
      subtitlePolicy,
    ].join('\n');
  }
  const listed: string[] = [];
  for (const line of dialogueLines.slice(0, DIALOGUE_BLOCK_MAX_LINES)) {
    const entry = describeDialogueLine(line);
    if (compact && listed.length > 0 && [...listed, entry].join('; ').length > COMPACT_DIALOGUE_LIST_CHARS) break;
    listed.push(entry);
  }
  const more = dialogueLines.length - listed.length;
  return [
    'Dialogue handling:',
    `- Only these marked lines are spoken: ${listed.join('; ')}${more > 0 ? `; and ${more} more marked line${more === 1 ? '' : 's'}` : ''}. Other quoted text is not speech.`,
    '- Speak each line in its original language with matching lip-sync; do not translate or romanize.',
    subtitlePolicy,
  ].join('\n');
}

function withoutLeadingDialogueBlock(text: string): string {
  return text.replace(/^Dialogue handling:\n(?:- [^\n]*\n)*/, '').trim();
}

/**
 * The dialogue note for a prompt that goes to the model as written
 * (cleanDirect, raw passthrough): this text's own marked lines, or nothing
 * when it has none.
 */
export function buildSagaDialogueNote(text: string, subtitleMode: SagaSubtitleMode = 'auto'): string {
  const lines = extractSagaDialogueLines(relocateDialogueCues(text));
  return lines.length > 0 ? buildDialogueBlock(lines, subtitleMode, { compact: true, markedDialogueOnly: true }) : '';
}

export function buildDeterministicEnglishVisualPrompt(input: {
  originalText: string;
  dialogueLines?: SagaDialogueLine[];
  subtitleMode?: SagaSubtitleMode;
  adultMode?: boolean;
  /**
   * A Saga segment prompt already carries its locks and constraints; only the
   * dialogue rules and the prompt itself are kept.
   */
  compact?: boolean;
  /** Saga brief: only marked lines are speech (see buildDialogueBlock). */
  markedDialogueOnly?: boolean;
}): string {
  const dialogueLines = input.dialogueLines ?? extractSagaDialogueLines(input.originalText);
  // The short dialogue rules go first and the brief right after them:
  // anything downstream that has to shorten the prompt (the video Director, a
  // model's prompt limit) cuts from the end, so the generic instructions go
  // before the user's own words or the dialogue rules ever do.
  const dialogueBlock = buildDialogueBlock(dialogueLines, input.subtitleMode, { compact: input.compact, markedDialogueOnly: input.markedDialogueOnly || input.compact });
  if (input.compact) {
    return [dialogueBlock, 'User brief (source material to render):', input.originalText.trim()].join('\n');
  }
  return [
    dialogueBlock,
    'User brief (source material to render):',
    input.originalText.trim(),
    '',
    'Generation instruction language: English.',
    'Preserve identity, ethnicity, wardrobe, setting, props, actions, relationships, pacing, duration, aspect ratio, audio intent, and all constraints. If the user describes Asian/Chinese/Japanese/Korean characters, state that identity explicitly; do not westernize.',
    'Convert abstract emotion into visible cinematic behavior (facial micro-expressions, posture, breathing, gaze, movement). Use concrete visual language over metaphor. Avoid safety boilerplate, logos, captions unless requested.',
    input.adultMode
      ? 'Adult-content mode: preserve the user\'s adult/explicit intent instead of softening it into non-explicit romance. Do not add safe-for-work phrasing, moral disclaimers, censorship language, or negative constraints such as avoiding nudity/genitals/sex acts when the user asked for them.'
      : '',
  ].filter((line, index) => line !== '' || index === 3).join('\n');
}

const VISUAL_DIRECTOR_REWRITE_SYSTEM_PROMPT = `You are Artemis Saga's Visual Director Translation Pass.

Task: convert a user video brief into an English video-generation prompt while preserving the user's original meaning.

Hard rules:
1. Output English generation instructions, but preserve quoted dialogue exactly in its original language.
2. Treat quoted text or text after markers like 对白/台词/dialogue/she says as spoken dialogue by default. If the marker is 旁白/voiceover, label it as voiceover. If the marker is 字幕/subtitle/caption, label it as on-screen subtitle.
3. Detect each dialogue line's language and explicitly state it, including at minimum Mandarin Chinese, Japanese, Korean, French, English, Italian, Spanish, and other obvious scripts/languages when present. Do not hard-code one language for the whole prompt.
4. Do not translate, summarize, romanize, or drop quoted dialogue unless the user explicitly requested translation.
5. Preserve ethnicity/nationality/cultural identity exactly. If the user says Chinese or Asian, write that clearly in English.
6. Convert abstract or literary language into video-model language: visible action, camera framing, camera movement, lighting, environment, motion continuity, facial expression, body posture, and sound intent.
7. Preserve user scene order, duration, aspect ratio, reference notes, identity-source intent, and audio intent.
8. Do not add unrelated characters, locations, props, moralizing text, disclaimers, subtitles, watermarks, logos, or extra on-screen text.
9. Return JSON only: {"generationText":"...", "dialogueLines":[{"text":"...","language":"...","use":"spoken_dialogue|voiceover|subtitle"}]}.`;

const VISUAL_DIRECTOR_ADULT_REWRITE_SYSTEM_PROMPT = `${VISUAL_DIRECTOR_REWRITE_SYSTEM_PROMPT}

Adult-content mode is enabled because the user configured an unrestricted/NSFW-capable video provider.
Additional hard rules:
10. Preserve the user's adult/explicit intent; do not convert explicit material into non-explicit romance, tasteful implication, lingerie-only framing, or censored erotica.
11. Do not add phrases such as "non-explicit", "avoid visible genitalia", "avoid sex acts", "avoid penetration", "implied only", "covered nudity", "censored", "safe", or similar negative constraints unless the user explicitly requested those limits.
12. You may improve pacing, shot order, visual clarity, consent/age-neutral wording, camera language, lighting, continuity, and anatomy/physics clarity, but you must not reverse the requested content category.`;

export async function normalizeSagaPromptForVideoGeneration(options: {
  cwd: string;
  text: string;
  enableLlmRewrite?: boolean;
  subtitleMode?: SagaSubtitleMode;
  adultMode?: boolean;
  /** Character names whose "Name:" prefix inside a quote is never spoken. */
  knownSpeakers?: readonly string[];
  /** A compiled Saga segment prompt: the short template (see buildDeterministicEnglishVisualPrompt). */
  compact?: boolean;
  /** Saga brief: only marked lines are speech (see buildDialogueBlock). */
  markedDialogueOnly?: boolean;
}): Promise<SagaGenerationLanguageResult> {
  // Speaker names and stage directions move outside the quotes before
  // anything else reads the brief, so neither the rewrite nor the video model
  // treats them as words to speak.
  const originalText = relocateDialogueCues(options.text.trim(), { knownSpeakers: options.knownSpeakers });
  const dialogueLines = extractSagaDialogueLines(originalText, { knownSpeakers: options.knownSpeakers });
  const subtitleMode = options.subtitleMode ?? 'auto';
  const markedDialogueOnly = options.markedDialogueOnly === true || options.compact === true;
  const fallback = buildDeterministicEnglishVisualPrompt({ originalText, dialogueLines, subtitleMode, adultMode: options.adultMode, compact: options.compact, markedDialogueOnly });
  const fallbackBody = withoutLeadingDialogueBlock(fallback);
  if (!options.enableLlmRewrite) {
    return { originalText, generationText: fallback, bodyText: fallbackBody, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };
  }

  const chat = await resolveSagaChatEndpoint(options.cwd);
  if (!chat) return { originalText, generationText: fallback, bodyText: fallbackBody, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };

  const userPayload = {
    originalText,
    extractedDialogueLines: dialogueLines,
    deterministicTemplate: fallback,
  };
  const body = {
    model: chat.model,
    messages: [
      { role: 'system', content: options.adultMode ? VISUAL_DIRECTOR_ADULT_REWRITE_SYSTEM_PROMPT : VISUAL_DIRECTOR_REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload, null, 2) },
    ],
    temperature: 0.35,
    response_format: { type: 'json_object' },
    max_tokens: 2200,
  } as Record<string, unknown>;

  try {
    const res = await postSagaChatCompletion(chat, body);
    if (!res.ok) {
      toolWarn(`⚠️ English prompt rewrite skipped: LLM ${res.timedOut ? res.text : res.status ?? res.text}`);
      return { originalText, generationText: fallback, bodyText: fallbackBody, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };
    }
    const content = chatCompletionContent(res.text);
    if (content === undefined) throw new Error('empty content');
    let payload: any;
    try { payload = JSON.parse(content); } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no json block');
      payload = JSON.parse(match[0]);
    }
    const generationText = typeof payload.generationText === 'string' ? payload.generationText.trim() : '';
    if (!generationText) throw new Error('missing generationText');
    const llmDialogue = Array.isArray(payload.dialogueLines)
      ? payload.dialogueLines
          .map((line: any) => ({
            text: typeof line?.text === 'string' ? line.text.trim() : '',
            language: typeof line?.language === 'string' ? line.language.trim() : '',
            use: line?.use === 'voiceover' || line?.use === 'subtitle' ? line.use : 'spoken_dialogue',
          }))
          .filter((line: SagaDialogueLine) => line.text && line.language)
      : [];
    return {
      originalText,
      // Dialogue rules first, for the same reason as in the deterministic template.
      generationText: [buildDialogueBlock(uniqueLines([...dialogueLines, ...llmDialogue]), subtitleMode, { markedDialogueOnly }), '', generationText].join('\n'),
      bodyText: generationText,
      generationLanguage: 'en',
      dialogueLines: uniqueLines([...dialogueLines, ...llmDialogue]),
      usedLlmRewrite: true,
    };
  } catch (error) {
    toolWarn(`⚠️ English prompt rewrite skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { originalText, generationText: fallback, bodyText: fallbackBody, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };
  }
}
