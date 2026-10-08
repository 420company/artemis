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
  if (/对白|台词|dialogue|spoken|says|whispers|murmurs|说|低声/.test(value)) return 'spoken_dialogue';
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
const MID_SPEAKER_RE = new RegExp(`(?<=[。！？!?…~～])[ \\t]*(?=(?:${SPEAKER_NAME_SOURCE})[ \\t]*[:：][ \\t]*[（(][^（）()\\n]{1,40}[）)])`, 'gu');
const LEADING_CUE_RE = /^[（(](?<cue>[^（）()\n]{1,40})[）)][ \t]*/u;
// A direction right after a sentence ends, anywhere in the line ("Yes! (laughs) Absolutely!").
const AFTER_SENTENCE_CUE_RE = /(?<=[。！？!?…~～.])[ \t]*[（(](?<cue>[^（）()\n]{1,40})[）)][ \t]*/gu;
// Single quotes are left out: they collide with English apostrophes.
const QUOTED_SPAN_RE = /(?<open>“)(?<inner>[^“”\n]{1,240})(?<close>”)|(?<open2>「)(?<inner2>[^「」\n]{1,240})(?<close2>」)|(?<open3>")(?<inner3>[^"\s\n](?:[^"\n]{0,238}[^"\s\n])?)(?<close3>")/gu;

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
    if (knownSpeakers.has(name) || LEADING_CUE_RE.test(afterName)) {
      speaker = name;
      rest = afterName;
    }
  }
  for (let leading = LEADING_CUE_RE.exec(rest); leading?.groups?.cue; leading = LEADING_CUE_RE.exec(rest)) {
    cues.push(leading.groups.cue.trim());
    rest = rest.slice(leading[0].length);
  }
  rest = rest.replace(AFTER_SENTENCE_CUE_RE, (_whole, cue: string) => {
    cues.push(cue.trim());
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
  return original
    .split(MID_SPEAKER_RE)
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

export function extractSagaDialogueLines(text: string, options: { knownSpeakers?: readonly string[] } = {}): SagaDialogueLine[] {
  const lines: SagaDialogueLine[] = [];
  const known = knownSpeakerSet(text, options.knownSpeakers);
  const spokenTexts = (raw: string | undefined): string[] => (raw
    ? parseSpokenLines(raw, known).map((piece) => piece.spoken).filter(Boolean)
    : []);
  // Marker pass: explicit "对白/台词/旁白/dialogue/..." preceding quoted text.
  // The optional [*_]* before/after the marker accommodates markdown emphasis
  // like **对白（…）**: which is common in detailed briefs. A direction may also
  // sit between the colon and the quote: 对白：（低声）“…”.
  const markerRe = /(?:^|[\n\r。；;.!?\s])[*_]*(?<marker>对白|台词|旁白|字幕|dialogue|spoken\s*dialogue|spoken\s*line|voice\s*over|voiceover|narration|subtitle|caption|she\s*(?:says|whispers|murmurs)|he\s*(?:says|whispers|murmurs)|她\s*(?:说|低声说)|他\s*(?:说|低声说))[*_]*\s*(?:[（(][^）)]{0,40}[）)])?\s*[*_]*\s*[:：]\s*(?:[（(][^）)\n]{0,60}[）)]\s*)?[“"'‘「](?<line>[^”"'’」]{1,240})[”"'’」]/giu;
  for (const match of text.matchAll(markerRe)) {
    const marker = match.groups?.marker?.trim();
    for (const line of spokenTexts(match.groups?.line)) {
      lines.push({ text: line, language: detectTextLanguage(line), use: classifyDialogueUse(marker), marker });
    }
  }

  // Greedy fallback: bare quoted text without a marker is only treated as
  // dialogue when it LOOKS LIKE a spoken sentence — i.e. ends in a
  // sentence-final mark (。！？!?…/...). This prevents design-concept refs
  // (e.g. "中国街道", "霓虹城市"), brand names (e.g. "Parts Unknown"), and
  // section-header song lyrics (e.g. "It was just two lovers / sittin' in
  // the car") from being mis-classified as spoken dialogue — which would
  // otherwise trigger audio safety rejection at the provider and pollute the
  // dialogue language map.
  const sentenceEndRe = /(?:[。！？!?…]|\.{3,})\s*$/u;
  const quotedInners = [
    ...quotedSpans(text).map((span) => span.inner),
    ...Array.from(text.matchAll(/‘(?<line>[^‘’\n]{2,240})’/gu), (match) => match.groups?.line ?? ''),
  ];
  for (const inner of quotedInners) {
    for (const line of spokenTexts(inner)) {
      if (line.length < 2 || !sentenceEndRe.test(line)) continue;
      const language = detectTextLanguage(line);
      if (language === 'English' && !/[。！？：，、]/.test(line)) continue;
      lines.push({ text: line, language, use: 'spoken_dialogue' });
    }
  }
  return uniqueLines(lines);
}

function buildDialogueBlock(dialogueLines: SagaDialogueLine[], subtitleMode: SagaSubtitleMode = 'auto'): string {
  const subtitlePolicy = subtitleMode === 'always'
    ? '- Render readable on-screen subtitles/captions for spoken dialogue and voiceover, preserving the exact original characters.'
    : subtitleMode === 'off'
      ? '- Keep dialogue/voiceover as audio only; do not render as on-screen text unless the brief explicitly marks a line as subtitle/caption.'
      : '- Only render on-screen subtitles/captions when the brief explicitly marks a line as subtitle/caption.';
  if (dialogueLines.length === 0) {
    return [
      'Dialogue handling:',
      '- Treat any quoted text in the brief as spoken dialogue in its original language; do not translate.',
      subtitlePolicy,
    ].join('\n');
  }
  const languages = Array.from(new Set(dialogueLines.map((line) => line.language))).filter(Boolean).join(', ');
  return [
    'Dialogue handling:',
    `- Quoted text in the brief is spoken dialogue (or voiceover/subtitle if explicitly marked). Detected languages: ${languages || 'as-written'}.`,
    '- Render speech in the original language with matching lip-sync; do not translate or romanize.',
    subtitlePolicy,
  ].join('\n');
}

export function buildDeterministicEnglishVisualPrompt(input: {
  originalText: string;
  dialogueLines?: SagaDialogueLine[];
  subtitleMode?: SagaSubtitleMode;
  adultMode?: boolean;
}): string {
  const dialogueLines = input.dialogueLines ?? extractSagaDialogueLines(input.originalText);
  // The brief comes first: anything downstream that has to shorten the prompt
  // (the video Director, a model's prompt limit) cuts from the end, so the
  // generic instructions go before the user's own words ever do. When the
  // brief has dialogue, the short dialogue rules go in front of it, since a
  // long brief would push them past any cut.
  const dialogueBlock = buildDialogueBlock(dialogueLines, input.subtitleMode);
  const leadingDialogue = dialogueLines.length > 0;
  return [
    leadingDialogue ? dialogueBlock : '',
    'User brief (source material to render):',
    input.originalText.trim(),
    '',
    'Generation instruction language: English.',
    'Preserve identity, ethnicity, wardrobe, setting, props, actions, relationships, pacing, duration, aspect ratio, audio intent, and all constraints. If the user describes Asian/Chinese/Japanese/Korean characters, state that identity explicitly; do not westernize.',
    'Convert abstract emotion into visible cinematic behavior (facial micro-expressions, posture, breathing, gaze, movement). Use concrete visual language over metaphor. Avoid safety boilerplate, logos, captions unless requested.',
    input.adultMode
      ? 'Adult-content mode: preserve the user\'s adult/explicit intent instead of softening it into non-explicit romance. Do not add safe-for-work phrasing, moral disclaimers, censorship language, or negative constraints such as avoiding nudity/genitals/sex acts when the user asked for them.'
      : '',
    leadingDialogue ? '' : dialogueBlock,
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
}): Promise<SagaGenerationLanguageResult> {
  // Speaker names and stage directions move outside the quotes before
  // anything else reads the brief, so neither the rewrite nor the video model
  // treats them as words to speak.
  const originalText = relocateDialogueCues(options.text.trim(), { knownSpeakers: options.knownSpeakers });
  const dialogueLines = extractSagaDialogueLines(originalText, { knownSpeakers: options.knownSpeakers });
  const subtitleMode = options.subtitleMode ?? 'auto';
  const fallback = buildDeterministicEnglishVisualPrompt({ originalText, dialogueLines, subtitleMode, adultMode: options.adultMode });
  if (!options.enableLlmRewrite) {
    return { originalText, generationText: fallback, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };
  }

  const chat = await resolveSagaChatEndpoint(options.cwd);
  if (!chat) return { originalText, generationText: fallback, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };

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
      toolWarn(`⚠️ Saga Visual Director English rewrite skipped: LLM ${res.timedOut ? res.text : res.status ?? res.text}`);
      return { originalText, generationText: fallback, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };
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
      generationText: [buildDialogueBlock(uniqueLines([...dialogueLines, ...llmDialogue]), subtitleMode), '', generationText].join('\n'),
      generationLanguage: 'en',
      dialogueLines: uniqueLines([...dialogueLines, ...llmDialogue]),
      usedLlmRewrite: true,
    };
  } catch (error) {
    toolWarn(`⚠️ Saga Visual Director English rewrite skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { originalText, generationText: fallback, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };
  }
}
