import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveConfiguredVisualProvider } from '../../utils/visualGenerationConfig.js';
import { toolWarn } from '../../utils/log.js';
import type { ToolExecutionContext } from '../types.js';

type StoryboardShot = {
  panelNumber?: string;
  title?: string;
  scene?: string;
  shotSize?: string;
  duration?: number;
  visual?: string;
  subtitle?: string;
  directorNote?: string;
  productLabels?: string[];
  personLabels?: string[];
  storyBeat?: string;
  visualPrompt?: string;
  prompt?: string;
  camera?: string;
  continuity?: string;
  transition?: string;
};

export type ParsedStoryboardImage = {
  detectedStoryboard: boolean;
  format?: string;
  panelCount?: number;
  order?: string;
  outputRatio?: string;
  language?: string;
  shotCount?: number;
  globalStyle?: string;
  globalContinuity?: string;
  summary?: string;
  shots: StoryboardShot[];
};

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function sanitizeShot(raw: unknown, index: number): StoryboardShot | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const item = value[key];
    if (typeof item === 'number' && Number.isFinite(item)) return String(item);
    return typeof item === 'string' && item.trim() ? item.trim().slice(0, 1600) : undefined;
  };
  const strList = (key: string): string[] | undefined => {
    const item = value[key];
    if (!Array.isArray(item)) return undefined;
    const values = item.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim().slice(0, 240));
    return values.length > 0 ? values : undefined;
  };
  const durationRaw = value.duration;
  const duration = typeof durationRaw === 'number' && Number.isFinite(durationRaw)
    ? Math.max(1, Math.min(30, durationRaw))
    : undefined;
  const panelNumber = str('panelNumber') ?? str('number') ?? str('index');
  const scene = str('scene');
  const shotSize = str('shotSize') ?? str('framing');
  const visual = str('visual') ?? str('image') ?? str('visualArea');
  const subtitle = str('subtitle') ?? str('copy') ?? str('caption');
  const directorNote = str('directorNote') ?? str('note');
  const storyBeat = str('storyBeat') ?? str('beat') ?? str('description') ?? [scene, visual, subtitle, directorNote].filter(Boolean).join('；');
  const visualPrompt = str('visualPrompt') ?? str('prompt') ?? [
    scene ? `Scene: ${scene}` : '',
    shotSize ? `Shot size/framing: ${shotSize}` : '',
    visual ? `Clean video image: ${visual}` : '',
    directorNote ? `Director note: ${directorNote}` : '',
  ].filter(Boolean).join('\n');
  const shot: StoryboardShot = {
    panelNumber,
    title: str('title') ?? (panelNumber ? `Storyboard panel ${panelNumber}` : `Storyboard shot ${index}`),
    scene,
    shotSize,
    duration,
    visual,
    subtitle,
    directorNote,
    productLabels: strList('productLabels') ?? strList('products'),
    personLabels: strList('personLabels') ?? strList('people') ?? strList('characters'),
    storyBeat,
    visualPrompt,
    camera: str('camera') ?? (shotSize ? `Use ${shotSize} framing; follow director note if present.` : undefined),
    continuity: str('continuity') ?? [scene ? `Keep scene continuity: ${scene}` : '', directorNote ? `Respect director note: ${directorNote}` : ''].filter(Boolean).join(' '),
    transition: str('transition'),
  };
  if (!shot.storyBeat && !shot.visualPrompt && !shot.visual) return null;
  return shot;
}

export async function parseStoryboardImageWithVision(options: {
  imagePath: string;
  context: ToolExecutionContext;
}): Promise<ParsedStoryboardImage | null> {
  const candidates: Array<{ apiKey: string; baseUrl: string; chatModel: string; label: string }> = [];

  const imageConfigured = await resolveConfiguredVisualProvider(options.context.cwd, 'image');
  const imageApiKey = imageConfigured?.config.image.apiKey?.trim();
  const imageBaseUrl = imageConfigured?.config.image.baseUrl?.trim();
  if (imageApiKey && imageBaseUrl) {
    candidates.push({ apiKey: imageApiKey, baseUrl: imageBaseUrl, chatModel: 'gpt-4o', label: 'image-provider-vision' });
  }
  try {
    const { ProviderStore } = await import('../../providers/store.js');
    const store = await new ProviderStore(options.context.cwd).load();
    const main = store?.profiles?.find((p) => p.id === (store?.defaultMainProfileId ?? 'main'));
    const mainApiKey = main?.apiKey?.trim();
    const mainBaseUrl = main?.baseUrl?.trim();
    if (mainApiKey && mainBaseUrl && main?.model) {
      candidates.push({ apiKey: mainApiKey, baseUrl: mainBaseUrl, chatModel: main.model, label: 'main-profile-vision' });
    }
  } catch { /* optional fallback */ }
  if (candidates.length === 0) return null;

  let buffer: Buffer;
  try {
    buffer = await readFile(options.imagePath);
  } catch {
    return null;
  }
  const ext = path.extname(options.imagePath).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  const buildBody = (chatModel: string) => ({
    model: chatModel,
    messages: [
      {
        role: 'system',
        content: [
          'You are a storyboard parser for an image-to-video production pipeline.',
          'The input image is explicitly supplied by the user as a storyboard / shot-board script, not as a character identity reference.',
          'Read panel order, OCR text, arrows, camera labels, duration labels, scene notes, visual thumbnails, subtitles/copy, product labels, and character labels.',
          'Explicitly support standardized storyboard sheets such as SB6-V1. Look for header anchors: FORMAT, PANELS, ORDER, LANG, OUTPUT. Example: FORMAT: SB6-V1 | PANELS: 6 | ORDER: LTR-TTB | LANG: zh-CN | OUTPUT: 9:16.',
          'If ORDER is present, follow it exactly. LTR-TTB means left-to-right, top-to-bottom. If no order is present, infer natural reading order from panel numbers first, then layout.',
          'Each panel may contain four layers: A) Panel Meta / shot info, B) Visual Area / sketch or reference image, C) Subtitle / Copy, D) Director Note. Parse these layers separately.',
          'Return STRICT JSON only. No markdown, no commentary.',
          'Schema: {"detectedStoryboard":true,"format":"SB6-V1|string|unknown","panelCount":number,"order":"LTR-TTB|TTB-LTR|numbered|unknown","outputRatio":"9:16|16:9|1:1|unknown","language":"zh|en|mixed|unknown","shotCount":number,"globalStyle":"string","globalContinuity":"string","summary":"string","shots":[{"panelNumber":"01","title":"string","scene":"string","shotSize":"Wide Shot|Full Shot|Medium Shot|Medium Close-Up|Close-Up|Extreme Close-Up|POV|Over-the-Shoulder|string","duration":number,"visual":"string","subtitle":"string","directorNote":"string","productLabels":["string"],"personLabels":["string"],"storyBeat":"string","visualPrompt":"string","camera":"string","continuity":"string","transition":"string"}]}',
          'For each shot, preserve director intent: action, framing/shot size, camera movement, subject position, environment, props, lighting, product presence, copy intent, emotion, and transition notes.',
          'Subtitle/copy/director notes are semantic intent only. Do NOT ask the video model to render text unless the user explicitly asks for on-screen typography.',
          'Do NOT copy panel borders, panel numbers, arrows, UI, handwritten notes, layout grids, or multi-panel composition into the generated video.',
          'If the storyboard artwork is cartoon/comic/line art but the target is realistic video, translate it into clean cinematic live-action photographic output instead of inheriting the drawing style.',
          'The storyboard image is director intent and composition guidance, not a character identity anchor. Identity/product references are supplied separately.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Parse this storyboard image into ordered video shots. Output strict JSON only.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 2200,
  } as Record<string, unknown>);

  for (const candidate of candidates) {
    const url = candidate.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const maxAttempts = 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.apiKey}` },
          body: JSON.stringify(buildBody(candidate.chatModel)),
          signal: AbortSignal.timeout(90_000),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          toolWarn(`⚠️ Storyboard parser: ${candidate.label} failed (HTTP ${res.status}, attempt ${attempt + 1}/${maxAttempts}) — ${errBody.slice(0, 200)}`);
          if (attempt < maxAttempts - 1 && (res.status === 429 || res.status >= 500)) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          break;
        }
        const text = await res.text();
        let parsedResponse: { choices?: Array<{ message?: { content?: unknown } }> };
        try {
          parsedResponse = JSON.parse(text);
        } catch {
          toolWarn(`⚠️ Storyboard parser: ${candidate.label} chat response was not JSON`);
          break;
        }
        const content = parsedResponse.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          toolWarn(`⚠️ Storyboard parser: ${candidate.label} response did not include text content`);
          break;
        }
        const json = extractJsonObject(content);
        if (!json) {
          toolWarn(`⚠️ Storyboard parser: no JSON object found in ${candidate.label} response — ${content.slice(0, 300)}`);
          break;
        }
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(json) as Record<string, unknown>;
        } catch (error) {
          toolWarn(`⚠️ Storyboard parser: JSON parse failed — ${error instanceof Error ? error.message : String(error)} — ${json.slice(0, 300)}`);
          break;
        }
        const rawShots = Array.isArray(raw.shots) ? raw.shots : [];
        const shots = rawShots.map((shot, index) => sanitizeShot(shot, index + 1)).filter((shot): shot is StoryboardShot => Boolean(shot));
        if (shots.length === 0) {
          toolWarn(`⚠️ Storyboard parser: parsed JSON contained no usable shots — ${json.slice(0, 300)}`);
          break;
        }
        return {
          detectedStoryboard: raw.detectedStoryboard !== false,
          format: typeof raw.format === 'string' ? raw.format : undefined,
          panelCount: typeof raw.panelCount === 'number' ? raw.panelCount : typeof raw.panels === 'number' ? raw.panels : undefined,
          order: typeof raw.order === 'string' ? raw.order : undefined,
          outputRatio: typeof raw.outputRatio === 'string' ? raw.outputRatio : typeof raw.output === 'string' ? raw.output : undefined,
          language: typeof raw.language === 'string' ? raw.language : undefined,
          shotCount: typeof raw.shotCount === 'number' ? raw.shotCount : shots.length,
          globalStyle: typeof raw.globalStyle === 'string' ? raw.globalStyle : undefined,
          globalContinuity: typeof raw.globalContinuity === 'string' ? raw.globalContinuity : undefined,
          summary: typeof raw.summary === 'string' ? raw.summary : undefined,
          shots,
        };
      } catch (error) {
        toolWarn(`⚠️ Storyboard parser: ${candidate.label} ${error instanceof Error ? error.message : String(error)}`);
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
      }
    }
  }
  return null;
}
