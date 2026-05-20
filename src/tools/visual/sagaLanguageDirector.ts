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
  const markerRe = /(?:^|[\n\r。；;.!?\s])(?<marker>对白|台词|旁白|字幕|dialogue|spoken\s*dialogue|spoken\s*line|voice\s*over|voiceover|narration|subtitle|caption|she\s*(?:says|whispers|murmurs)|he\s*(?:says|whispers|murmurs)|她\s*(?:说|低声说)|他\s*(?:说|低声说))\s*(?:[（(][^）)]{0,40}[）)])?\s*[:：]\s*[“"'‘](?<line>[^”"'’]{1,240})[”"'’]/giu;
  for (const match of text.matchAll(markerRe)) {
    const line = match.groups?.line?.trim();
    if (!line) continue;
    const marker = match.groups?.marker?.trim();
    lines.push({ text: line, language: detectTextLanguage(line), use: classifyDialogueUse(marker), marker });
  }

  // Default dialogue convention: any quoted Chinese/Japanese/Korean/etc. line is
  // treated as spoken dialogue unless it was already captured with an explicit
  // subtitle/voiceover marker. Plain quoted English is left alone to avoid
  // turning titles, style names, and filenames into dialogue too aggressively.
  const quoteRe = /[“"'‘](?<line>[^”"'’]{2,240})[”"'’]/gu;
  for (const match of text.matchAll(quoteRe)) {
    const line = match.groups?.line?.trim();
    if (!line) continue;
    const language = detectTextLanguage(line);
    if (language === 'English' && !/[。！？：，、]/.test(line)) continue;
    lines.push({ text: line, language, use: 'spoken_dialogue' });
  }
  return uniqueLines(lines);
}

function buildDialogueBlock(dialogueLines: SagaDialogueLine[], subtitleMode: SagaSubtitleMode = 'auto'): string {
  const subtitlePolicy = subtitleMode === 'always'
    ? '- User selected subtitles: render readable on-screen subtitles/captions for spoken dialogue and voiceover, preserving exact original dialogue text and language.'
    : subtitleMode === 'off'
      ? '- User selected no subtitles: do not render dialogue as on-screen text; keep dialogue/voiceover as audio only unless the user explicitly wrote a subtitle/caption line.'
      : '- Subtitle mode is automatic: only create on-screen subtitles/captions when the user explicitly requested subtitles or visible text.';
  if (dialogueLines.length === 0) {
    return [
      'Dialogue handling:',
      '- If the user supplied quoted dialogue, treat it as spoken audio by default.',
      '- Detect the dialogue language from the quoted text and preserve the exact original characters.',
      '- Handle multilingual dialogue such as Mandarin Chinese, Japanese, Korean, English, French, Italian, Spanish, and other detected languages; do not assume everything is English.',
      '- Do not translate quoted dialogue unless the user explicitly requested translation.',
      subtitlePolicy,
    ].join('\n');
  }
  return [
    'Dialogue handling — preserve exact text and language:',
    ...dialogueLines.map((line, index) => {
      const use = line.use === 'voiceover'
        ? 'voiceover narration'
        : line.use === 'subtitle'
          ? 'on-screen subtitle/caption'
          : 'spoken dialogue, spoken aloud with matching lip movement';
      return `${index + 1}. ${use}; language: ${line.language}; exact text: “${line.text}”`;
    }),
    '- Keep quoted dialogue exactly as written, including Chinese/Japanese/Korean and Latin-script non-English dialogue if present.',
    '- The language map is global: every extracted spoken line, voiceover, and subtitle must carry its detected language for the downstream video/audio model.',
    '- Do not translate quoted dialogue unless the user explicitly requested translation.',
    '- For spoken dialogue, ask for audio/lip-sync in the detected language; do not render it merely as a subtitle.',
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
    '[Saga Visual Director Language Normalization v1]',
    'Generation instruction language: English.',
    'Preserve the user\'s original semantic intent, character identity, ethnicity, nationality, wardrobe, setting, props, actions, relationships, pacing, duration, aspect ratio, audio intent, and all constraints.',
    'If the user describes Asian, Chinese, Japanese, Korean, or any other ethnicity/nationality, state that identity explicitly in English; do not westernize the characters.',
    buildDialogueBlock(dialogueLines, input.subtitleMode),
    'Rewrite objective for the video model:',
    '- Convert abstract emotion into visible cinematic behavior: facial micro-expressions, body posture, breathing, gesture, gaze direction, and movement continuity.',
    '- Convert plot summary into shot-ready visual action with clear subject, environment, camera framing, camera motion, lighting, texture, and temporal continuity.',
    '- Prefer concrete visual language over literary metaphor.',
    '- Keep explicit user-provided actions and scene order; do not replace them with unrelated content.',
    '- Avoid unnecessary safety boilerplate, logos, captions, or extra text unless requested.',
    '',
    'Original user brief, preserved for semantic grounding:',
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
