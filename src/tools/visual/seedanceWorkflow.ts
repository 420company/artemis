import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ImageAttachment } from '../../providers/types.js';
import { findLatestDreamBody } from '../../services/dreamStore.js';
import { resolveConfiguredVisualProvider } from '../../utils/visualGenerationConfig.js';
import {
  BYTEPLUS_SEEDANCE_2_PRO_MODEL,
  isBytePlusProvider,
  resolveVideoModelCapabilities,
} from './videoCapabilities.js';

export type SeedanceWorkflowScope = 'cli' | 'bridge';

export type SeedanceWorkflowInput = {
  scope: SeedanceWorkflowScope;
  key: string;
  cwd: string;
  text: string;
  imageAttachments?: ImageAttachment[];
  latestDream?: SeedanceDreamSource | null;
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
  cwd: string;
  prompt: string;
  originalPrompt: string;
  dreamSource?: SeedanceDreamSource;
  referenceImageUrls: string[];
  referenceVideoUrls: string[];
  referenceAudioUrls: string[];
  referenceImagePaths: string[];
  referenceVideoPaths: string[];
  referenceAudioPaths: string[];
  duration?: number;
  generateAudio: boolean;
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
const MIN_SEEDANCE_2_DURATION = 4;
const MAX_SEEDANCE_2_DURATION = 15;

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
  return /(?:^|[\s"'`(（])(?:~\/|\.\.?\/|\/|[A-Za-z0-9_.-]+\/)?[^\s"'`，。；、)）]+\.(?:png|jpe?g|webp|gif|mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg)(?:$|[\s"'`，。；、)）])/i.test(value);
}

function extractLocalMediaPathCandidates(text: string): string[] {
  const values: string[] = [];
  const pattern = /(?:~\/|\.\.?\/|\/|[A-Za-z0-9_.-]+\/)?[^\s"'`，。；、)）]+\.(?:png|jpe?g|webp|gif|mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg)/gi;
  for (const match of text.matchAll(pattern)) {
    const value = match[0].replace(/[),.;，。]+$/g, '');
    if (!/^https?:\/\//i.test(value) && looksLikeLocalMediaPath(` ${value} `)) values.push(value);
  }
  return unique(values);
}

function resolveLocalPath(cwd: string, raw: string): string {
  if (raw.startsWith('~/')) return path.join(process.env.HOME ?? '', raw.slice(2));
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
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
    if (/\.(?:png|jpe?g|webp|gif)$/.test(lower)) {
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

function extractDuration(text: string): number | undefined {
  if (DEFAULT_DURATION_RE.test(text.trim())) return DEFAULT_SEEDANCE_DURATION;
  const match = text.match(/(?:时长|duration)?\s*(\d{1,2})\s*(?:秒|s|sec|seconds)?/i);
  if (!match) return undefined;
  const raw = Number.parseInt(match[1], 10);
  if (!Number.isFinite(raw)) return undefined;
  return Math.min(MAX_SEEDANCE_2_DURATION, Math.max(MIN_SEEDANCE_2_DURATION, raw));
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

function buildOfferMessage(scope: SeedanceWorkflowScope, hasUnusableAttachment: boolean, dreamSource?: SeedanceDreamSource): string {
  const attachmentNote = hasUnusableAttachment
    ? '\n\n我已看到你发送了图片附件，会尽量转成 Base64 作为图片参考；视频/音频附件仍需要 URL 或后续 asset 上传能力。'
    : '';
  const dreamLine = dreamSource
    ? `- 回复“使用最新梦境”，直接用最新梦境日记（${dreamSource.id}）作为文字参考生成梦境视频`
    : '';
  if (scope === 'cli') {
    return [
      '当前配置的视频模型是 Seedance 2.0 Pro，多模态视频模型。',
      '它支持用文字 + 图片参考 + 视频参考 + 音频参考一起生成视频。',
      '',
      '是否添加参考素材来提升生成质量？',
      dreamLine,
      '- 回复“添加”，然后发送图片路径/图片 URL、视频 URL、音频 URL 和补充文字',
      '- 回复“直接生成”，只用当前文字生成',
      '- 回复“取消”，放弃本次视频生成',
      attachmentNote,
    ].join('\n');
  }
  return [
    '当前视频模型是 Seedance 2.0 Pro，支持多模态参考生成。',
    ...(dreamSource ? [`可回复“使用最新梦境”，直接用最新梦境日记（${dreamSource.id}）作为文字参考生成梦境视频。`] : []),
    '你可以继续发送图片 URL、视频 URL、音频 URL 和补充文字；完成后回复“开始生成”。',
    '回复“直接生成”则只用当前文字生成；回复“取消”放弃。',
    attachmentNote,
  ].filter(Boolean).join('\n');
}

function buildCollectingMessage(state: SeedanceWorkflowState, hasUnusableAttachment: boolean): string {
  const lines = [
    '已进入 Seedance 2.0 Pro 多模态视频工作流。',
    `已收集：图片 ${state.referenceImageUrls.length + state.referenceImagePaths.length} 个，视频 ${state.referenceVideoUrls.length + state.referenceVideoPaths.length} 个，音频 ${state.referenceAudioUrls.length + state.referenceAudioPaths.length} 个。`,
  ];
  if (hasUnusableAttachment) {
    lines.push('提示：图片附件会转成 Base64；视频/音频附件目前不能直接转公网 URL。');
  }
  lines.push('继续发送参考 URL/本地图片路径或补充文字；完成后回复“开始生成”。');
  return lines.join('\n');
}

function buildDurationMessage(state: SeedanceWorkflowState): string {
  return [
    '最后确认：请选择 Seedance 2.0 Pro 视频时长。',
    `已收集参考素材 ${referenceCount(state)} 个。`,
    '可回复：4、5、10、15 秒；或回复“默认/跳过”使用 5 秒。',
    '默认生成有声视频；如果不要声音，请明确说“静音/无声”。',
  ].join('\n');
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

function hasDirectCreationRequestMarker(text: string): boolean {
  return /(?:请|帮我|给我|我要|我想|需要|现在|直接|开始|please|can you|could you|for me)/i.test(text);
}

function isSeedanceWorkflowSupportDiscussion(text: string): boolean {
  const normalized = compact(text);
  if (!normalized) return false;
  const mentionsVideo = /(?:Seedance|多模态|generate_video|referenceImageUrls|referenceVideoUrls|视频|短片|动画|动效|片段|video|movie|clip|animation|motion)/i.test(normalized);
  if (!mentionsVideo) return false;
  const asksOrReviews = /(?:为什么|怎么回事|怎么|如何|没搞懂|有没有|是否|能不能|能否|可以吗|吗|？|\?|检查|审查|review|修复|实现|逻辑|代码|文档|支持|不支持|bug|问题|报错|失败|没有)/i.test(normalized);
  if (!asksOrReviews) return false;
  const mentionsSystemSurface = /(?:Seedance|多模态|工作流|流程|引导|触发|提示|确认|referenceImageUrls|referenceVideoUrls|generate_video|系统|功能|逻辑|代码|发送|发给手机|发送到手机|手机|Discord|Telegram|WeChat|bridge|投递|完成后|生成完成|主动发送|主动把视频发)/i.test(normalized);
  const explicitCreationRequest = hasVideoCreationSyntax(normalized) && hasDirectCreationRequestMarker(normalized) && !mentionsSystemSurface;
  return !explicitCreationRequest;
}

function isExplicitSeedanceVideoRequest(text: string): boolean {
  const normalized = compact(text);
  if (!normalized || isSeedanceWorkflowSupportDiscussion(normalized)) return false;
  return hasVideoCreationSyntax(normalized);
}

function buildGenerationPrompt(state: SeedanceWorkflowState): string {
  const lines = [
    state.prompt,
    '',
    '[Seedance 2.0 Pro multimodal video workflow]',
    `Use generate_video with model "${BYTEPLUS_SEEDANCE_2_PRO_MODEL}".`,
    `duration: ${state.duration ?? DEFAULT_SEEDANCE_DURATION}`,
    `generateAudio: ${state.generateAudio}`,
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
  return lines.join('\n');
}

async function hasSeedance2ProVideoConfig(cwd: string): Promise<boolean> {
  const configured = await resolveConfiguredVisualProvider(cwd, 'video');
  if (!configured) return false;
  if (!isBytePlusProvider(configured.config.video.provider)) return false;
  const model = configured.config.video.model || configured.model;
  if (model !== BYTEPLUS_SEEDANCE_2_PRO_MODEL) return false;
  const capabilities = resolveVideoModelCapabilities(configured.config.video.provider, model);
  return (
    capabilities.referenceInputs.includes('image') &&
    capabilities.referenceInputs.includes('video') &&
    capabilities.referenceInputs.includes('audio')
  );
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
    if (CANCEL_RE.test(text)) {
      WORKFLOWS.delete(key);
      return { handled: true, reply: '已取消 Seedance 2.0 Pro 多模态视频生成。' };
    }

    if (isSeedanceWorkflowSupportDiscussion(text)) {
      WORKFLOWS.delete(key);
      return { handled: false };
    }

    if (state.stage === 'choosing_dream_source') {
      if (DREAM_SOURCE_YES_RE.test(text) && state.dreamSource) {
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
        return { handled: true, reply: buildOfferMessage(input.scope, hasUnusableAttachment) };
      }
      mergeReferences(state, refs);
      if (hasUsableRefs) {
        state.dreamSource = undefined;
        state.stage = 'collecting_refs';
        return { handled: true, reply: buildCollectingMessage(state, hasUnusableAttachment) };
      }
      return {
        handled: true,
        reply: [
          `是否使用最新梦境日记（${state.dreamSource?.id ?? 'latest'}）作为文字参考？`,
          '回复“使用最新梦境”继续；回复“不用/添加素材”则按普通 Seedance 2.0 多模态流程继续；回复“取消”放弃。',
        ].join('\n'),
      };
    }

    if (state.stage === 'choosing_duration') {
      mergeReferences(state, refs);
      const duration = extractDuration(text);
      if (!duration && !wantsAudio(text) && !wantsSilence(text)) {
        return { handled: true, reply: buildDurationMessage(state) };
      }
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

  if (!(await hasSeedance2ProVideoConfig(input.cwd))) {
    return { handled: false };
  }

  const latestDream = hasDreamVideoIntent(text) ? await resolveLatestDreamSource(input) : null;

  const nextState: SeedanceWorkflowState = {
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
    generateAudio: !wantsSilence(text),
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
    const requestedDuration = extractDuration(text);
    if (requestedDuration) nextState.duration = requestedDuration;
    WORKFLOWS.set(key, nextState);
    return {
      handled: true,
      reply: [
        '检测到你要生成梦境视频，且当前视频模型是 Seedance 2.0 Pro。',
        `是否直接使用最新梦境日记（${latestDream.id}）作为视频生成的文字参考？`,
        '- 回复“使用最新梦境”：用日记文本生成梦境视频，并自动套用 Seedance 2.0 Pro Director 优化',
        '- 回复“添加素材/不用”：按原 Seedance 2.0 多模态流程继续，可继续发图片/视频/音频参考',
        '- 回复“取消”：放弃本次视频生成',
      ].join('\n'),
    };
  }

  WORKFLOWS.set(key, nextState);
  if (referenceCount(nextState) > 0) {
    return { handled: true, reply: buildCollectingMessage(nextState, hasUnusableAttachment) };
  }
  return { handled: true, reply: buildOfferMessage(input.scope, hasUnusableAttachment, latestDream ?? undefined) };
}

export function clearSeedanceMultimodalWorkflow(scope: SeedanceWorkflowScope, key: string): void {
  WORKFLOWS.delete(`${scope}:${key}`);
}
