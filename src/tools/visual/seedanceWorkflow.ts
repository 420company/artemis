import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ImageAttachment } from '../../providers/types.js';
import { buildDreamPaths, findLatestDreamBody } from '../../services/dreamStore.js';
import { resolveConfiguredVisualProvider } from '../../utils/visualGenerationConfig.js';
import {
  BYTEPLUS_SEEDANCE_2_PRO_MODEL,
  isBytePlusProvider,
  isSeedance25Model,
  resolveVideoModelProfile,
  videoCapabilityOverridesFromConfig,
  type VideoModelProfile,
} from './videoCapabilities.js';
import {
  analyzeNarrative,
  buildSagaConstitution,
  narrativeKeywordFallback,
  type NarrativeEntities,
} from './sagaNarrative.js';
import { isWorkflowSupportDiscussion } from './workflowIntent.js';
import { DEFAULT_UI_LOCALE, pickLocale, type UiLocale } from '../../cli/locale.js';

export type SeedanceWorkflowScope = 'cli' | 'bridge';

export type SeedanceWorkflowInput = {
  scope: SeedanceWorkflowScope;
  key: string;
  cwd: string;
  text: string;
  locale?: UiLocale;
  imageAttachments?: ImageAttachment[];
  latestDream?: SeedanceDreamSource | null;
  deliveryPlatform?: 'telegram' | 'discord' | 'wechat' | 'all';
  deliveryTargetId?: string;
};

export type SeedanceWorkflowOutcome =
  | { handled: false; prompt?: string }
  | { handled: true; reply: string }
  | { handled: false; prompt: string };

export type SeedanceDreamSource = {
  id: string;
  body: string;
};

type SeedanceWorkflowStage = 'choosing_dream_source' | 'collecting_refs' | 'choosing_duration';

type SeedanceWorkflowState = {
  scope: SeedanceWorkflowScope;
  cwd: string;
  prompt: string;
  originalPrompt: string;
  dreamSource?: SeedanceDreamSource;
  dreamNarrative?: NarrativeEntities;
  referenceImageUrls: string[];
  referenceVideoUrls: string[];
  referenceAudioUrls: string[];
  referenceImagePaths: string[];
  referenceVideoPaths: string[];
  referenceAudioPaths: string[];
  duration?: number;
  /** The configured multimodal video model and the clip lengths offered for it. */
  model: string;
  clipChoices: number[];
  generateAudio: boolean;
  locale: UiLocale;
  deliveryPlatform?: 'telegram' | 'discord' | 'wechat' | 'all';
  deliveryTargetId?: string;
  stage: SeedanceWorkflowStage;
  createdAt: number;
  updatedAt: number;
};

type ExtractedReferences = {
  imageUrls: string[];
  videoUrls: string[];
  audioUrls: string[];
  imagePaths: string[];
  videoPaths: string[];
  audioPaths: string[];
};

const WORKFLOWS = new Map<string, SeedanceWorkflowState>();
const WORKFLOW_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SEEDANCE_DURATION = 5;
/** Seedance 2.0 keeps its four lengths; other models offer lengths up to their longest clip (L). */
const SEEDANCE_2_0_CLIP_CHOICES = [4, 5, 10, 15];

export function singleClipChoices(profile: Pick<VideoModelProfile, 'family' | 'allowedDurations' | 'minClipSeconds' | 'maxClipSeconds'>): number[] {
  if (profile.allowedDurations && profile.allowedDurations.length > 0) return [...profile.allowedDurations];
  if (profile.family === 'seedance-2.0' && profile.maxClipSeconds === 15) return SEEDANCE_2_0_CLIP_CHOICES;
  const choices = [5, 10, 15, 20, 30].filter((value) => value >= profile.minClipSeconds && value <= profile.maxClipSeconds);
  if (!choices.includes(profile.maxClipSeconds)) choices.push(profile.maxClipSeconds);
  return choices.sort((a, b) => a - b);
}

function formatChoices(choices: number[], locale: UiLocale): string {
  return locale === 'zh-CN' ? `${choices.join('、')} 秒` : `${choices.slice(0, -1).join(', ')}${choices.length > 1 ? ', or ' : ''}${choices[choices.length - 1]} seconds`;
}

const DIRECT_GENERATE_RE = /^(?:直接生成|只用文字|不用参考|不需要|跳过|开始生成|生成|done|go|start)$/i;
const DIRECT_GENERATE_PREFIX_RE = /^(?:直接生成|只用文字|不用参考|不需要参考|跳过参考|start\b|go\b)/i;
const CANCEL_RE = /^(?:取消|算了|停止|不要了|cancel|stop)$/i;
const CONFIRM_RE = /(?:需要|添加|要|可以|继续|参考|图片|视频|素材|yes|yep|ok|sure|add)/i;
const START_RE = /^(?:开始生成|生成|done|go|start|可以生成|就这样)$/i;
const DEFAULT_DURATION_RE = /^(?:默认|跳过|5|5秒|five|default|skip)$/i;
const DREAM_SOURCE_YES_RE = /^(?:是|好|好的|可以|确认|用|使用|使用最新梦境|用最新梦境|用梦境日记|用日记|直接用|直接生成|yes|y|ok|sure)(?:[\s，,。.].*)?$/i;
const DREAM_SOURCE_NO_RE = /^(?:否|不|不用|不要|不用梦境|不用日记|按原流程|原来流程|添加素材|手动添加|no|n)(?:[\s，,。.].*)?$/i;

function normalizeKey(input: SeedanceWorkflowInput): string {
  return `${input.scope}:${input.key}`;
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function pruneExpiredWorkflows(): void {
  const now = Date.now();
  for (const [key, workflow] of WORKFLOWS) {
    if (now - workflow.updatedAt > WORKFLOW_TTL_MS) {
      WORKFLOWS.delete(key);
    }
  }
}

function extractHttpUrls(text: string): string[] {
  const urls: string[] = [];
  const pattern = /https?:\/\/[^\s<>"'`，。；、]+/gi;
  for (const match of text.matchAll(pattern)) {
    urls.push(match[0].replace(/[),.;，。]+$/g, ''));
  }
  return unique(urls);
}

function looksLikeLocalMediaPath(value: string): boolean {
  return /(?:^|[\s"'`(（])(?:file:\/\/|~\/|\.\.?\/|\/|[A-Za-z0-9_.-]+\/)[^\n"'`，。；、)）]+?\.(?:png|jpe?g|webp|gif|bmp|svg|heic|heif|mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg)(?:$|[\s"'`，。；、)）])/i.test(value);
}

function extractLocalMediaPathCandidates(text: string): string[] {
  const values: string[] = [];
  const pattern = /(?:file:\/\/|~\/|\.\.?\/|\/|[A-Za-z0-9_.-]+\/)[^\n"'`，。；、)）]+?\.(?:png|jpe?g|webp|gif|bmp|svg|heic|heif|mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg)/gi;
  for (const match of text.matchAll(pattern)) {
    const value = match[0].replace(/[),.;，。]+$/g, '').replace(/\\(.)/g, '$1');
    if (!/^https?:\/\//i.test(value) && looksLikeLocalMediaPath(` ${value} `)) values.push(value);
  }
  return unique(values);
}

function resolveLocalPath(cwd: string, raw: string): string {
  let candidate = raw;
  if (candidate.startsWith('file://')) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      return raw;
    }
  }
  if (candidate.startsWith('~/')) return path.join(process.env.HOME ?? '', candidate.slice(2));
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}

async function existingLocalMediaPaths(cwd: string, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of extractLocalMediaPathCandidates(text)) {
    const absolute = resolveLocalPath(cwd, candidate);
    try {
      const info = await stat(absolute);
      if (info.isFile()) found.push(absolute);
    } catch {
      // Ignore path-like text that is not a readable file in the current workspace.
    }
  }
  return unique(found);
}

export async function hasExistingLocalMediaReference(cwd: string, text: string): Promise<boolean> {
  return (await existingLocalMediaPaths(cwd, text)).length > 0;
}

async function imageAttachmentDataUrls(imageAttachments?: ImageAttachment[]): Promise<string[]> {
  const urls: string[] = [];
  for (const attachment of imageAttachments ?? []) {
    if (attachment.sourceUrl) continue;
    if (attachment.data && attachment.mediaType) {
      urls.push(`data:${attachment.mediaType};base64,${attachment.data}`);
    }
  }
  return unique(urls);
}

async function classifyReferenceUrls(
  cwd: string,
  text: string,
  imageAttachments?: ImageAttachment[],
): Promise<ExtractedReferences> {
  const imageUrls: string[] = [];
  const videoUrls: string[] = [];
  const audioUrls: string[] = [];
  const imagePaths: string[] = [];
  const videoPaths: string[] = [];
  const audioPaths: string[] = [];

  for (const url of extractHttpUrls(text)) {
    const lower = url.toLowerCase();
    if (/\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/.test(lower)) {
      imageUrls.push(url);
    } else if (/\.(?:mp4|mov|webm|m4v)(?:[?#].*)?$/.test(lower)) {
      videoUrls.push(url);
    } else if (/\.(?:mp3|wav|m4a|aac|flac|ogg)(?:[?#].*)?$/.test(lower)) {
      audioUrls.push(url);
    }
  }

  for (const localPath of await existingLocalMediaPaths(cwd, text)) {
    const lower = localPath.toLowerCase();
    if (/\.(?:png|jpe?g|webp|gif|bmp|svg|heic|heif)$/.test(lower)) {
      imagePaths.push(localPath);
    } else if (/\.(?:mp4|mov|webm|m4v)$/.test(lower)) {
      videoPaths.push(localPath);
    } else if (/\.(?:mp3|wav|m4a|aac|flac|ogg)$/.test(lower)) {
      audioPaths.push(localPath);
    }
  }

  for (const attachment of imageAttachments ?? []) {
    if (attachment.sourceUrl) {
      imageUrls.push(attachment.sourceUrl);
    }
  }
  imageUrls.push(...await imageAttachmentDataUrls(imageAttachments));

  return {
    imageUrls: unique(imageUrls),
    videoUrls: unique(videoUrls),
    audioUrls: unique(audioUrls),
    imagePaths: unique(imagePaths),
    videoPaths: unique(videoPaths),
    audioPaths: unique(audioPaths),
  };
}

function mergeReferences(state: SeedanceWorkflowState, refs: ExtractedReferences): void {
  state.referenceImageUrls = unique([...state.referenceImageUrls, ...refs.imageUrls]);
  state.referenceVideoUrls = unique([...state.referenceVideoUrls, ...refs.videoUrls]);
  state.referenceAudioUrls = unique([...state.referenceAudioUrls, ...refs.audioUrls]);
  state.referenceImagePaths = unique([...state.referenceImagePaths, ...refs.imagePaths]);
  state.referenceVideoPaths = unique([...state.referenceVideoPaths, ...refs.videoPaths]);
  state.referenceAudioPaths = unique([...state.referenceAudioPaths, ...refs.audioPaths]);
  state.updatedAt = Date.now();
}

function referenceCount(state: SeedanceWorkflowState): number {
  return state.referenceImageUrls.length + state.referenceVideoUrls.length + state.referenceAudioUrls.length + state.referenceImagePaths.length + state.referenceVideoPaths.length + state.referenceAudioPaths.length;
}

function extractDuration(text: string, choices: number[]): number | undefined {
  if (DEFAULT_DURATION_RE.test(text.trim())) return DEFAULT_SEEDANCE_DURATION;
  const match = text.match(/(?:时长|duration)?\s*(\d{1,2})\s*(?:秒|s|sec|seconds)?/i);
  if (!match) return undefined;
  const raw = Number.parseInt(match[1], 10);
  if (!Number.isFinite(raw)) return undefined;
  return Math.min(Math.max(...choices), Math.max(Math.min(...choices), raw));
}

function extractRawDuration(text: string): number | undefined {
  if (DEFAULT_DURATION_RE.test(text.trim())) return DEFAULT_SEEDANCE_DURATION;
  const match = text.match(/(?:时长|duration)?\s*(\d{1,2})\s*(?:秒|s|sec|seconds)?/i);
  if (!match) return undefined;
  const raw = Number.parseInt(match[1], 10);
  return Number.isFinite(raw) ? raw : undefined;
}

function isAllowedSeedanceDuration(raw: number, choices: number[]): boolean {
  return choices.includes(raw);
}

function buildInvalidDurationMessage(state: SeedanceWorkflowState, raw: number): string {
  return pickLocale(state.locale, {
    zh: [
      `单段视频可以是 ${formatChoices(state.clipChoices, state.locale)}；你回复的是 ${raw} 秒。`,
      `请回复：${formatChoices(state.clipChoices, state.locale)}；或回复“默认/跳过”使用 ${DEFAULT_SEEDANCE_DURATION} 秒。`,
      `如果你要超过 ${Math.max(...state.clipChoices)} 秒，请重新发起，例如“生成一段 1 分钟的长视频”，我会帮你分段制作成一条完整的长视频。`,
    ].join('\n'),
    en: [
      `A single video clip can be ${formatChoices(state.clipChoices, state.locale)}; you replied ${raw} seconds.`,
      `Reply with ${formatChoices(state.clipChoices, state.locale)}; or reply "default/skip" to use ${DEFAULT_SEEDANCE_DURATION} seconds.`,
      `For more than ${Math.max(...state.clipChoices)} seconds, start a new request like "make a 1 minute long video" and I will make it as one long video, segment by segment.`,
    ].join('\n'),
  });
}

function isDirectGenerateIntent(text: string): boolean {
  const trimmed = text.trim();
  return DIRECT_GENERATE_RE.test(trimmed) || DIRECT_GENERATE_PREFIX_RE.test(trimmed);
}

function hasDreamVideoIntent(text: string): boolean {
  return /(?:梦境|做梦|dream)[\s\S]{0,80}(?:视频|短片|动画|片段|video|movie|clip)|(?:视频|短片|动画|片段|video|movie|clip)[\s\S]{0,80}(?:梦境|做梦|dream)/i.test(text);
}

async function resolveLatestDreamSource(input: SeedanceWorkflowInput): Promise<SeedanceDreamSource | null> {
  if (input.latestDream !== undefined) return input.latestDream;
  const latest = await findLatestDreamBody();
  if (!latest) return null;
  return { id: latest.entry.id, body: latest.body };
}

function buildDreamVideoPrompt(dream: SeedanceDreamSource, userRequest: string): string {
  const compactBody = dream.body
    .replace(/^<!--[^]*?-->\s*/m, '')
    .replace(/### (?:学到了什么|What I learned)[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1400);

  return [
    userRequest,
    '',
    `[Artemis latest dream journal: ${dream.id}]`,
    'Use the following dream journal as the primary text reference for a poetic cinematic dream video.',
    compactBody,
    'Preserve the main dream symbols, emotional arc, atmosphere, and spatial logic. Do not add readable subtitles, UI, logos, or literal diary text on screen.',
  ].join('\n');
}

async function analyzeDreamNarrative(cwd: string, dream: SeedanceDreamSource): Promise<NarrativeEntities> {
  const analysisText = [
    `[Artemis latest dream journal: ${dream.id}]`,
    'Analyze this dream journal before video generation. Identify the central “god” / protagonist: human, animal, creature, object, place, weather, abstract symbol, or recurring motif. Extract parameters that make the later video orbit that god rather than random scenery.',
    dream.body
      .replace(/^<!--[^]*?-->\s*/m, '')
      .replace(/### (?:学到了什么|What I learned)[\s\S]*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1600),
  ].join('\n');
  return await analyzeNarrative({ cwd, userText: analysisText }) ?? narrativeKeywordFallback({
    userText: analysisText,
    hasFaceLikelyInImages: false,
  });
}

function buildOfferMessage(scope: SeedanceWorkflowScope, locale: UiLocale, hasUnusableAttachment: boolean, dreamSource?: SeedanceDreamSource): string {
  const attachmentNote = hasUnusableAttachment
    ? pickLocale(locale, {
      zh: '\n\n我已看到你发送的图片附件，会把它作为图片参考；视频/音频参考目前需要发链接。',
      en: '\n\nI saw your image attachment and will use it as an image reference; video/audio references currently need a link.',
    })
    : '';
  const dreamLine = dreamSource
    ? pickLocale(locale, {
      zh: `- 回复“使用最新梦境”，直接用最新梦境日记（${dreamSource.id}）作为文字参考生成梦境视频`,
      en: `- Reply "use latest dream" to use the latest dream journal (${dreamSource.id}) as the text reference`,
    })
    : '';
  if (scope === 'cli') {
    return pickLocale(locale, {
      zh: [
        '这段视频可以只用文字生成，也可以加上图片、视频、音频参考一起生成。',
        '',
        '是否添加参考素材来提升生成质量？',
        dreamLine,
        '- 回复“添加”，然后发送图片路径/图片 URL、视频 URL、音频 URL 和补充文字',
        '- 回复“直接生成”，只用当前文字生成',
        '- 回复“取消”，放弃本次视频生成',
        attachmentNote,
      ].join('\n'),
      en: [
        'This video can be made from text alone, or from text plus image, video, and audio references.',
        '',
        'Do you want to add references to improve generation quality?',
        dreamLine,
        '- Reply "add", then send image paths/image URLs, video URLs, audio URLs, and extra text',
        '- Reply "direct generate" to generate from the current text only',
        '- Reply "cancel" to stop this video generation',
        attachmentNote,
      ].join('\n'),
    });
  }
  return pickLocale(locale, {
    zh: [
      '这段视频可以加上图片、视频、音频参考一起生成。',
      ...(dreamSource ? [`可回复“使用最新梦境”，直接用最新梦境日记（${dreamSource.id}）作为文字参考生成梦境视频。`] : []),
      '你可以继续发送图片 URL、视频 URL、音频 URL 和补充文字；完成后回复“开始生成”。',
      '回复“直接生成”则只用当前文字生成；回复“取消”放弃。',
      attachmentNote,
    ].filter(Boolean).join('\n'),
    en: [
      'This video can use image, video, and audio references.',
      ...(dreamSource ? [`Reply "use latest dream" to use the latest dream journal (${dreamSource.id}) as the text reference.`] : []),
      'You can keep sending image URLs, video URLs, audio URLs, and extra text; reply "start" when ready.',
      'Reply "direct generate" to use only the current text; reply "cancel" to stop.',
      attachmentNote,
    ].filter(Boolean).join('\n'),
  });
}

function buildCollectingMessage(state: SeedanceWorkflowState, hasUnusableAttachment: boolean): string {
  const lines = state.locale === 'zh-CN'
    ? [
      '好的，开始收集参考素材。',
      `已收集：图片 ${state.referenceImageUrls.length + state.referenceImagePaths.length} 个，视频 ${state.referenceVideoUrls.length + state.referenceVideoPaths.length} 个，音频 ${state.referenceAudioUrls.length + state.referenceAudioPaths.length} 个。`,
    ]
    : [
      'OK, collecting references now.',
      `Collected: ${state.referenceImageUrls.length + state.referenceImagePaths.length} images, ${state.referenceVideoUrls.length + state.referenceVideoPaths.length} videos, ${state.referenceAudioUrls.length + state.referenceAudioPaths.length} audio references.`,
    ];
  if (hasUnusableAttachment) {
    lines.push(pickLocale(state.locale, {
      zh: '提示：图片附件会直接作为参考；视频/音频附件目前需要改发链接。',
      en: 'Note: image attachments are used as references directly; video/audio attachments currently need to be sent as links.',
    }));
  }
  lines.push(pickLocale(state.locale, {
    zh: '继续发送参考 URL/本地图片路径或补充文字；完成后回复“开始生成”。',
    en: 'Keep sending reference URLs/local image paths or extra text; reply "start" when ready.',
  }));
  return lines.join('\n');
}

function buildDurationMessage(state: SeedanceWorkflowState): string {
  return pickLocale(state.locale, {
    zh: [
      '最后确认：请选择视频时长。',
      `已收集参考素材 ${referenceCount(state)} 个。`,
      `可回复：${formatChoices(state.clipChoices, state.locale)}；或回复“默认/跳过”使用 ${DEFAULT_SEEDANCE_DURATION} 秒。`,
      '默认生成有声视频；如果不要声音，请明确说“静音/无声”。',
    ].join('\n'),
    en: [
      'Final confirmation: choose the video length.',
      `Collected ${referenceCount(state)} reference item(s).`,
      `Reply with ${formatChoices(state.clipChoices, state.locale)}; or reply "default/skip" to use ${DEFAULT_SEEDANCE_DURATION} seconds.`,
      'Audio is generated by default; say "silent/no audio" if you do not want sound.',
    ].join('\n'),
  });
}

function wantsAudio(text: string): boolean {
  return /(?:有声|带声音|生成声音|generate audio|with audio|audio on)/i.test(text);
}

function wantsSilence(text: string): boolean {
  return /(?:静音|无声|不要声音|不要音频|no audio|without audio|audio off|silent)/i.test(text);
}

function hasVideoCreationSyntax(text: string): boolean {
  const normalized = compact(text);
  if (!normalized) return false;
  return [
    /(?:生成(?!完成|结束|后|完)|创建|制作|设计|渲染|产出|做成|做一个|做一段|拍一个|剪一个|转成|转为|变成)[\s\S]{0,80}(?:视频|短片|动画|动效|片段)/i,
    /(?:图片|图像|照片|梦境|故事|文本|prompt)[\s\S]{0,40}(?:转成|转为|变成|做成)[\s\S]{0,40}(?:视频|短片|动画|片段)/i,
    /\b(?:generate|create|make|render|produce|design|turn)\b[\s\S]{0,80}\b(?:video|movie|clip|animation|motion)\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function isSeedanceWorkflowSupportDiscussion(text: string): boolean {
  return isWorkflowSupportDiscussion(text, {
    workflowTerms: /(?:Seedance|多模态|generate_video|referenceImageUrls|referenceVideoUrls|视频|短片|动画|动效|片段|video|movie|clip|animation|motion)/i,
    creationSyntax: hasVideoCreationSyntax,
    systemSurfaceTerms: /(?:Seedance|多模态|工作流|流程|引导|触发|提示|确认|referenceImageUrls|referenceVideoUrls|generate_video|系统|功能|逻辑|代码|发送|发给手机|发送到手机|手机|Discord|Telegram|WeChat|bridge|投递|完成后|生成完成|主动发送|主动把视频发)/i,
  });
}

function isExplicitSeedanceVideoRequest(text: string): boolean {
  const normalized = compact(text);
  if (!normalized || isSeedanceWorkflowSupportDiscussion(normalized)) return false;
  return hasVideoCreationSyntax(normalized);
}

function buildGenerationPrompt(state: SeedanceWorkflowState): string {
  const dreamVideoPath = state.dreamSource ? buildDreamPaths(state.dreamSource.id).videoPath : undefined;
  const dreamNarrativeBlock = state.dreamNarrative
    ? [
        '',
        '[Dream journal protagonist / god analysis — authoritative]',
        buildSagaConstitution(state.dreamNarrative),
        `[Dream Video Narrative Entity Map]\n${JSON.stringify(state.dreamNarrative, null, 2)}`,
        state.dreamNarrative.protagonist.type !== 'character'
          ? 'Non-human god rule: do not force a generic human narrator. Make the camera orbit the identified object / creature / environment / symbol using macro, subjective, environmental, or symbolic point-of-view shots that keep it alive as the central subject.'
          : 'Character god rule: preserve the same protagonist identity and do not replace them with a different character between shots.',
      ].join('\n')
    : '';
  const lines = [
    state.prompt,
    dreamNarrativeBlock,
    '',
    '[Artemis multimodal video workflow]',
    'When you talk to the user, say 「生成视频」 / "making your video"; never name this workflow, the tool, the model or the provider.',
    `Use generate_video with model "${state.model}".`,
    `duration: ${state.duration ?? DEFAULT_SEEDANCE_DURATION}`,
    `generateAudio: ${state.generateAudio}`,
    ...(dreamVideoPath ? [`outputPath: ${JSON.stringify(dreamVideoPath)}`] : []),
    'Preserve the user intent and pass these reference arrays exactly when calling the tool.',
  ];
  if (state.referenceImageUrls.length > 0) {
    lines.push(`referenceImageUrls: ${JSON.stringify(state.referenceImageUrls)}`);
  }
  if (state.referenceVideoUrls.length > 0) {
    lines.push(`referenceVideoUrls: ${JSON.stringify(state.referenceVideoUrls)}`);
  }
  if (state.referenceAudioUrls.length > 0) {
    lines.push(`referenceAudioUrls: ${JSON.stringify(state.referenceAudioUrls)}`);
  }
  if (state.referenceImagePaths.length > 0) {
    lines.push(`referenceImagePaths: ${JSON.stringify(state.referenceImagePaths)}`);
  }
  if (state.referenceVideoPaths.length > 0) {
    lines.push(`referenceVideoPaths: ${JSON.stringify(state.referenceVideoPaths)}`);
  }
  if (state.referenceAudioPaths.length > 0) {
    lines.push(`referenceAudioPaths: ${JSON.stringify(state.referenceAudioPaths)}`);
  }
  lines.push('If reference arrays are present, do not omit them from generate_video. Videos should include generated audio by default unless the user explicitly asked for silence.');
  if (state.scope === 'bridge' && dreamVideoPath) {
    const sendArgs = [
      `videoPath: ${JSON.stringify(dreamVideoPath)}`,
      state.deliveryPlatform ? `platform: ${JSON.stringify(state.deliveryPlatform)}` : undefined,
      state.deliveryTargetId ? `targetId: ${JSON.stringify(state.deliveryTargetId)}` : undefined,
      `caption: ${JSON.stringify(`🎬 Artemis dream video: ${state.dreamSource?.id ?? 'latest'}`)}`,
    ].filter(Boolean).join(', ');
    lines.push(`After generate_video succeeds, immediately call bridge_send_video with { ${sendArgs} }. Send only the exact newly generated outputPath for this flow; do not use any latest-media sentinel or previously existing dream video.`);
  }
  return lines.join('\n');
}

/** The configured model when it is a multimodal Seedance 2.x model (2.0 Pro or 2.5), with its clip choices. */
async function multimodalVideoModel(cwd: string): Promise<{ model: string; clipChoices: number[] } | undefined> {
  const configured = await resolveConfiguredVisualProvider(cwd, 'video');
  if (!configured) return undefined;
  if (!isBytePlusProvider(configured.config.video.provider)) return undefined;
  const model = configured.config.video.model || configured.model;
  if (model !== BYTEPLUS_SEEDANCE_2_PRO_MODEL && !isSeedance25Model(model)) return undefined;
  const profile = resolveVideoModelProfile(configured.config.video.provider, model, videoCapabilityOverridesFromConfig(configured.config));
  const multimodal = ['image', 'video', 'audio'].every((kind) => profile.referenceInputs.includes(kind as 'image'));
  return multimodal ? { model, clipChoices: singleClipChoices(profile) } : undefined;
}

export async function handleSeedanceMultimodalWorkflow(
  input: SeedanceWorkflowInput,
): Promise<SeedanceWorkflowOutcome> {
  pruneExpiredWorkflows();

  const key = normalizeKey(input);
  const text = input.text.trim();
  const state = WORKFLOWS.get(key);
  const refs = await classifyReferenceUrls(input.cwd, text, input.imageAttachments);
  const hasUsableRefs = refs.imageUrls.length + refs.videoUrls.length + refs.audioUrls.length + refs.imagePaths.length + refs.videoPaths.length + refs.audioPaths.length > 0;
  const hasUnusableAttachment = Boolean(input.imageAttachments?.some((attachment) => !attachment.sourceUrl && !attachment.data));

  if (state) {
    if (input.locale) state.locale = input.locale;

    if (CANCEL_RE.test(text)) {
      WORKFLOWS.delete(key);
      return {
        handled: true,
        reply: pickLocale(state.locale, {
          zh: '已取消本次视频生成。',
          en: 'This video generation has been canceled.',
        }),
      };
    }

    if (isSeedanceWorkflowSupportDiscussion(text)) {
      WORKFLOWS.delete(key);
      return { handled: false };
    }

    if (state.stage === 'choosing_dream_source') {
      if (DREAM_SOURCE_YES_RE.test(text) && state.dreamSource) {
        state.dreamNarrative = await analyzeDreamNarrative(state.cwd, state.dreamSource);
        state.prompt = buildDreamVideoPrompt(state.dreamSource, state.originalPrompt);
        state.stage = 'choosing_duration';
        state.updatedAt = Date.now();
        if (state.duration) {
          WORKFLOWS.delete(key);
          return { handled: false, prompt: buildGenerationPrompt(state) };
        }
        return { handled: true, reply: buildDurationMessage(state) };
      }
      if (DREAM_SOURCE_NO_RE.test(text)) {
        state.dreamSource = undefined;
        state.stage = 'collecting_refs';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildOfferMessage(input.scope, state.locale, hasUnusableAttachment) };
      }
      mergeReferences(state, refs);
      if (hasUsableRefs) {
        state.dreamSource = undefined;
        state.stage = 'collecting_refs';
        return { handled: true, reply: buildCollectingMessage(state, hasUnusableAttachment) };
      }
      return {
        handled: true,
        reply: pickLocale(state.locale, {
          zh: [
            `是否使用最新梦境日记（${state.dreamSource?.id ?? 'latest'}）作为文字参考？`,
            '回复“使用最新梦境”继续；回复“不用/添加素材”则按普通流程继续，可以添加参考素材；回复“取消”放弃。',
          ].join('\n'),
          en: [
            `Use the latest dream journal (${state.dreamSource?.id ?? 'latest'}) as the text reference?`,
            'Reply "use latest dream" to continue; reply "no/add references" to continue normally and add references; reply "cancel" to stop.',
          ].join('\n'),
        }),
      };
    }

    if (state.stage === 'choosing_duration') {
      mergeReferences(state, refs);
      const rawDuration = extractRawDuration(text);
      if (!rawDuration && !wantsAudio(text) && !wantsSilence(text)) {
        return { handled: true, reply: buildDurationMessage(state) };
      }
      if (rawDuration && !isAllowedSeedanceDuration(rawDuration, state.clipChoices)) {
        state.updatedAt = Date.now();
        return { handled: true, reply: buildInvalidDurationMessage(state, rawDuration) };
      }
      const duration = rawDuration ? extractDuration(text, state.clipChoices) : undefined;
      state.duration = duration ?? DEFAULT_SEEDANCE_DURATION;
      if (wantsAudio(text)) state.generateAudio = true;
      if (wantsSilence(text)) state.generateAudio = false;
      WORKFLOWS.delete(key);
      return { handled: false, prompt: buildGenerationPrompt(state) };
    }

    mergeReferences(state, refs);
    if (text && !START_RE.test(text) && !isDirectGenerateIntent(text) && !hasUsableRefs && !CONFIRM_RE.test(text)) {
      state.prompt = compact(`${state.prompt}\n${text}`);
    }

    if (START_RE.test(text) || isDirectGenerateIntent(text)) {
      state.stage = 'choosing_duration';
      state.updatedAt = Date.now();
      return { handled: true, reply: buildDurationMessage(state) };
    }

    return { handled: true, reply: buildCollectingMessage(state, hasUnusableAttachment) };
  }

  if (!isExplicitSeedanceVideoRequest(text)) {
    return { handled: false };
  }

  const videoModel = await multimodalVideoModel(input.cwd);
  if (!videoModel) {
    return { handled: false };
  }

  const latestDream = hasDreamVideoIntent(text) ? await resolveLatestDreamSource(input) : null;

  const nextState: SeedanceWorkflowState = {
    scope: input.scope,
    cwd: input.cwd,
    prompt: text,
    originalPrompt: text,
    dreamSource: latestDream ?? undefined,
    referenceImageUrls: refs.imageUrls,
    referenceVideoUrls: refs.videoUrls,
    referenceAudioUrls: refs.audioUrls,
    referenceImagePaths: refs.imagePaths,
    referenceVideoPaths: refs.videoPaths,
    referenceAudioPaths: refs.audioPaths,
    model: videoModel.model,
    clipChoices: videoModel.clipChoices,
    generateAudio: !wantsSilence(text),
    locale: input.locale ?? DEFAULT_UI_LOCALE,
    deliveryPlatform: input.deliveryPlatform,
    deliveryTargetId: input.deliveryTargetId,
    stage: 'collecting_refs',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (hasUsableRefs || (isDirectGenerateIntent(text) && !latestDream)) {
    nextState.stage = 'choosing_duration';
    WORKFLOWS.set(key, nextState);
    return { handled: true, reply: buildDurationMessage(nextState) };
  }

  if (latestDream) {
    nextState.stage = 'choosing_dream_source';
    const requestedDuration = extractDuration(text, nextState.clipChoices);
    if (requestedDuration) nextState.duration = requestedDuration;
    WORKFLOWS.set(key, nextState);
    return {
      handled: true,
      reply: pickLocale(nextState.locale, {
        zh: [
          '看起来你想把梦境做成视频。',
          `是否直接使用最新梦境日记（${latestDream.id}）作为视频生成的文字参考？`,
          '- 回复“使用最新梦境”：用日记文本生成梦境视频，并自动优化镜头描述',
          '- 回复“添加素材/不用”：按普通流程继续，可以继续发图片/视频/音频参考',
          '- 回复“取消”：放弃本次视频生成',
        ].join('\n'),
        en: [
          'It looks like you want to turn a dream into a video.',
          `Use the latest dream journal (${latestDream.id}) directly as the text reference?`,
          '- Reply "use latest dream": generate from the journal text with automatically refined shot descriptions',
          '- Reply "add references/no": continue normally and send image/video/audio references',
          '- Reply "cancel": stop this video generation',
        ].join('\n'),
      }),
    };
  }

  WORKFLOWS.set(key, nextState);
  if (referenceCount(nextState) > 0) {
    return { handled: true, reply: buildCollectingMessage(nextState, hasUnusableAttachment) };
  }
  return { handled: true, reply: buildOfferMessage(input.scope, nextState.locale, hasUnusableAttachment, latestDream ?? undefined) };
}

export function clearSeedanceMultimodalWorkflow(scope: SeedanceWorkflowScope, key: string): void {
  WORKFLOWS.delete(`${scope}:${key}`);
}

/** True while the multimodal video wizard is waiting for answers under this scope + key. */
export function hasActiveSeedanceMultimodalWorkflow(scope: SeedanceWorkflowScope, key: string): boolean {
  pruneExpiredWorkflows();
  return WORKFLOWS.has(`${scope}:${key}`);
}
