import { toolWarn } from '../../utils/log.js';
import { resolveConfiguredVisualProvider } from '../../utils/visualGenerationConfig.js';

export type SagaDialogueUse = 'spoken_dialogue' | 'voiceover' | 'subtitle' | 'quoted_dialogue';

export type SagaDialogueLine = {
  text: string;
  language: string;
  use: SagaDialogueUse;
  marker?: string;
};

export type SagaGenerationLanguageResult = {
  originalText: string;
  generationText: string;
  generationLanguage: 'en';
  dialogueLines: SagaDialogueLine[];
  usedLlmRewrite: boolean;
};

export type SagaSubtitleMode = 'auto' | 'always' | 'off';

type ChatModelInfo = { apiKey: string; baseUrl: string; model: string };

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

export function extractSagaDialogueLines(text: string): SagaDialogueLine[] {
  const lines: SagaDialogueLine[] = [];
  // Marker pass: explicit "对白/台词/旁白/dialogue/..." preceding quoted text.
  // The optional [*_]* before/after the marker accommodates markdown emphasis
  // like **对白（…）**: which is common in detailed briefs.
  const markerRe = /(?:^|[\n\r。；;.!?\s])[*_]*(?<marker>对白|台词|旁白|字幕|dialogue|spoken\s*dialogue|spoken\s*line|voice\s*over|voiceover|narration|subtitle|caption|she\s*(?:says|whispers|murmurs)|he\s*(?:says|whispers|murmurs)|她\s*(?:说|低声说)|他\s*(?:说|低声说))[*_]*\s*(?:[（(][^）)]{0,40}[）)])?\s*[*_]*\s*[:：]\s*[“"'‘](?<line>[^”"'’]{1,240})[”"'’]/giu;
  for (const match of text.matchAll(markerRe)) {
    const line = match.groups?.line?.trim();
    if (!line) continue;
    const marker = match.groups?.marker?.trim();
    lines.push({ text: line, language: detectTextLanguage(line), use: classifyDialogueUse(marker), marker });
  }

  // Greedy fallback: bare quoted text without a marker is only treated as
  // dialogue when it LOOKS LIKE a spoken sentence — i.e. ends in a
  // sentence-final mark (。！？!?…/...). This prevents design-concept refs
  // (e.g. "中国街道", "霓虹城市"), brand names (e.g. "Parts Unknown"), and
  // section-header song lyrics (e.g. "It was just two lovers / sittin' in
  // the car") from being mis-classified as spoken dialogue — which would
  // otherwise trigger audio safety rejection at the provider and pollute the
  // dialogue language map.
  const quoteRe = /[“"'‘](?<line>[^”"'’]{2,240})[”"'’]/gu;
  const sentenceEndRe = /(?:[。！？!?…]|\.{3,})\s*$/u;
  for (const match of text.matchAll(quoteRe)) {
    const line = match.groups?.line?.trim();
    if (!line) continue;
    if (!sentenceEndRe.test(line)) continue;
    const language = detectTextLanguage(line);
    if (language === 'English' && !/[。！？：，、]/.test(line)) continue;
    lines.push({ text: line, language, use: 'spoken_dialogue' });
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
}): string {
  const dialogueLines = input.dialogueLines ?? extractSagaDialogueLines(input.originalText);
  return [
    'Generation instruction language: English.',
    'Preserve identity, ethnicity, wardrobe, setting, props, actions, relationships, pacing, duration, aspect ratio, audio intent, and all constraints. If the user describes Asian/Chinese/Japanese/Korean characters, state that identity explicitly; do not westernize.',
    'Convert abstract emotion into visible cinematic behavior (facial micro-expressions, posture, breathing, gaze, movement). Use concrete visual language over metaphor. Avoid safety boilerplate, logos, captions unless requested.',
    buildDialogueBlock(dialogueLines, input.subtitleMode),
    '',
    'User brief (source material to render):',
    input.originalText.trim(),
  ].join('\n');
}

async function resolveChatModel(cwd: string): Promise<ChatModelInfo | null> {
  let mainApiKey: string | undefined;
  let mainBaseUrl: string | undefined;
  let mainModel = 'gpt-5.5';
  try {
    const { ProviderStore } = await import('../../providers/store.js');
    const store = await new ProviderStore(cwd).load();
    const main = store?.profiles?.find((p: any) => p.id === (store?.defaultMainProfileId ?? 'main'));
    if (main) {
      if (main.apiKey) mainApiKey = String(main.apiKey).trim();
      if (main.baseUrl) mainBaseUrl = String(main.baseUrl).trim();
      if (main.model) mainModel = String(main.model);
    }
  } catch { /* fallback below */ }
  if (mainApiKey && mainBaseUrl) return { apiKey: mainApiKey, baseUrl: mainBaseUrl, model: mainModel };
  const imageConfigured = await resolveConfiguredVisualProvider(cwd, 'image');
  const apiKey = imageConfigured?.config.image.apiKey?.trim();
  const baseUrl = imageConfigured?.config.image.baseUrl?.trim();
  if (!apiKey || !baseUrl) return null;
  return { apiKey, baseUrl, model: mainModel };
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

export async function normalizeSagaPromptForVideoGeneration(options: {
  cwd: string;
  text: string;
  enableLlmRewrite?: boolean;
  subtitleMode?: SagaSubtitleMode;
}): Promise<SagaGenerationLanguageResult> {
  const originalText = options.text.trim();
  const dialogueLines = extractSagaDialogueLines(originalText);
  const subtitleMode = options.subtitleMode ?? 'auto';
  const fallback = buildDeterministicEnglishVisualPrompt({ originalText, dialogueLines, subtitleMode });
  if (!options.enableLlmRewrite) {
    return { originalText, generationText: fallback, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };
  }

  const chat = await resolveChatModel(options.cwd);
  if (!chat) return { originalText, generationText: fallback, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };

  const userPayload = {
    originalText,
    extractedDialogueLines: dialogueLines,
    deterministicTemplate: fallback,
  };
  const body = {
    model: chat.model,
    messages: [
      { role: 'system', content: VISUAL_DIRECTOR_REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload, null, 2) },
    ],
    temperature: 0.35,
    response_format: { type: 'json_object' },
    max_tokens: 2200,
  } as Record<string, unknown>;

  try {
    const res = await fetch(chat.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chat.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      toolWarn(`⚠️ Saga Visual Director English rewrite skipped: LLM ${res.status}`);
      return { originalText, generationText: fallback, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };
    }
    const raw = await res.text();
    const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('empty content');
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
      generationText: [generationText, '', buildDialogueBlock(uniqueLines([...dialogueLines, ...llmDialogue]), subtitleMode)].join('\n'),
      generationLanguage: 'en',
      dialogueLines: uniqueLines([...dialogueLines, ...llmDialogue]),
      usedLlmRewrite: true,
    };
  } catch (error) {
    toolWarn(`⚠️ Saga Visual Director English rewrite skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { originalText, generationText: fallback, generationLanguage: 'en', dialogueLines, usedLlmRewrite: false };
  }
}
