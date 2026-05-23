import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveConfiguredVisualProvider } from '../../utils/visualGenerationConfig.js';
import { getMediaOutputRoot } from '../../utils/mediaOutputRoot.js';
import { resolveArtemisHomeDir } from '../../utils/fs.js';
import { resolveVideoModelLimits } from './videoModelLimits.js';
import { resolveVideoModelCapabilities } from './videoCapabilities.js';
import type { ImageAttachment } from '../../providers/types.js';
import {
  analyzeNarrative,
  buildSagaConstitution,
  emitNarrativeStatus,
  narrativeKeywordFallback,
  sanitizeForVideoProvider,
  type NarrativeEntities,
  type ProtagonistMode,
  type ProtagonistType,
} from './sagaNarrative.js';
import { isWorkflowSupportDiscussion } from './workflowIntent.js';
import { DEFAULT_UI_LOCALE, pickLocale, type UiLocale } from '../../cli/locale.js';
import type { AgentAction } from '../../core/types.js';
import type { SagaRatio } from './sagaRenderer/types.js';

export function resolveSagaWorkflowLocaleForTest(explicitLocale?: UiLocale): UiLocale {
  return explicitLocale ?? DEFAULT_UI_LOCALE;
}

export type SagaWorkflowScope = 'cli' | 'bridge';

export type SagaWorkflowInput = {
  scope: SagaWorkflowScope;
  key: string;
  cwd: string;
  text: string;
  locale?: UiLocale;
  imageAttachments?: ImageAttachment[];
  deliveryPlatform?: 'telegram' | 'discord' | 'wechat' | 'all';
  deliveryTargetId?: string;
  // /saga explicit entry — skip the long-video intent check.
  forceIntent?: boolean;
};

export type SagaWorkflowOutcome =
  | { handled: false; prompt?: string; action?: Extract<AgentAction, { type: 'generate_long_video' }> }
  | { handled: true; reply: string };

type SagaWorkflowStage =
  // Ask subject/identity first, then collect all materials, then confirm total
  // duration last. This lets Saga estimate/split duration from the complete
  // script + references instead of forcing the user to pick a length before
  // the story exists.
  | 'awaiting_subject_mode'
  | 'awaiting_identity_source'
  | 'awaiting_turnaround_upload'
  | 'awaiting_character_image_upload'
  | 'collecting_refs'
  | 'awaiting_storyboard_image'
  | 'awaiting_protagonist_clarification'
  | 'awaiting_subtitle_mode'
  | 'awaiting_ratio'
  | 'awaiting_duration'
  | 'awaiting_bgm'
  | 'awaiting_bgm_asset';

type IdentitySource = 'turnaround' | 'character_image' | 'direct_image' | 'text_only';
type SubtitleMode = 'auto' | 'always' | 'off';

type SagaWorkflowState = {
  scope: SagaWorkflowScope;
  cwd: string;
  originalText: string;
  stage: SagaWorkflowStage;
  multimodalCapable: boolean;
  // collected references
  referenceImageUrls: string[];
  referenceVideoUrls: string[];
  referenceAudioUrls: string[];
  referenceImagePaths: string[];
  storyboardImageUrls: string[];
  storyboardImagePaths: string[];
  referenceVideoPaths: string[];
  referenceAudioPaths: string[];
  referenceNotes: string[];
  // UI locale selected by the caller. The workflow must not infer language from
  // the prompt body because prompts often contain mixed-language policy blocks.
  locale: UiLocale;
  // additional substantive story text the user types during collecting_refs
  accumulatedStory: string[];
  // narrative analysis (Layer 1 LLM result, may be overwritten by Layer 2 user clarification)
  narrative?: NarrativeEntities;
  // when narrative confidence is low, we present 4 options and wait for the user's pick
  protagonistOptions?: Array<{ key: string; label: string; type: ProtagonistType; mode: ProtagonistMode; name: string; isOwnDescription?: boolean }>;
  // pre-extracted duration from original message (if any)
  prefilledDuration?: number;
  targetDuration?: number;
  soundtrackPath?: string;
  soundtrackUrl?: string;
  soundtrackStartSec?: number;
  soundtrackVolumeDb?: number;
  environmentVolumeDb?: number;
  soundtrackFadeInSec?: number;
  soundtrackFadeOutSec?: number;
  subtitleMode?: SubtitleMode;
  ratio?: SagaRatio;
  suggestedRatio?: SagaRatio;
  aiScreenwriterMode?: boolean;
  // ── Three-step menu state ─────────────────────────────────────────────────
  // identitySource: how the character identity enters the pipeline (user picks
  //   via the three-step menu after "开始生成"). When unset, downstream falls
  //   back to legacy auto-detect behavior.
  // turnaround*: image paths/URLs explicitly tagged as turnaround sheets — go
  //   to action.referenceImagePaths but with the action's identitySource flag
  //   so generateLongVideo skips superVisual generation.
  identitySource?: IdentitySource;
  turnaroundImagePaths: string[];
  turnaroundImageUrls: string[];
  deliveryPlatform?: 'telegram' | 'discord' | 'wechat' | 'all';
  deliveryTargetId?: string;
  createdAt: number;
  updatedAt: number;
};

const WORKFLOWS = new Map<string, SagaWorkflowState>();
const WORKFLOW_TTL_MS = 30 * 60 * 1000;

const CANCEL_RE = /^(?:取消|算了|停止|不要了|cancel|stop)$/i;
const CONFIRM_DEFAULT_RE = /^(?:默认|建议|你定|自动|可以|好|好的|ok|yes|y|sure|default)$/i;
const START_RE = /^(?:开始生成|生成|done|go|start|可以生成|就这样|直接生成|跳过|没有参考|不用参考)$/i;
const ABSTRACT_RE = /^(?:无主角|纯视觉|纯风景|抽象视觉|abstract|no lead|no character|没有主角)$/i;
const STORY_DIRECTIVE_RE = /(?:剧情|剧本|分镜|故事|镜头|场景|情节|你来创造|你来安排|你来写|自由发挥|按.*(?:拍|生成)|create the story|write the story|story|script|shot|scene)/i;
const STORY_ENHANCE_RE = /^(?:剧情增强|增强剧情|story\s*enhance|enhance\s*story)$/i;
const STORYBOARD_RE = /^(?:分镜图|分镜图片|图片分镜|上传分镜|发送分镜|storyboard|storyboard image|shot board)$/i;


function wantsCleanDirectMode(segments: string[]): boolean {
  const text = segments.join('\n').toLowerCase();
  return /(?:clean[-\s]?direct|raw[-\s]?seedance|raw\s*mode|直连\s*seedance|旧版质感|老版本质感|原始质感|不要滤镜|别加滤镜|少滤镜|无滤镜|干净质感|clean prompt|short prompt)/i.test(text);
}

function hasExplicitUserScriptText(segments: string[]): boolean {
  const text = segments.join('\n').trim();
  if (!text) return false;
  if (/\[\s*\d+(?:\.\d+)?\s*[-–—~至到]\s*\d+(?:\.\d+)?\s*(?:秒|s|sec|seconds)?\s*\]/i.test(text)) return true;
  if (/(?:^|\n|\s)(?:shot\s*\d+|镜头\s*\d+|第\s*\d+\s*(?:幕|段|镜头)|分镜\s*\d+)/i.test(text)) return true;
  if (/\b(?:script|screenplay|storyboard|shot list)\b|(?:剧本|分镜|脚本|镜头表)/i.test(text)) return true;
  // A substantial supplied narrative should be treated as authored material,
  // not a free-writing seed. Short notes like “剧情你来创造” are still planner
  // briefs and may be expanded normally.
  return text.length >= 160;
}

// ── Subject-mode menu regexes ─────────────────────────────────────────────
// "Has-protagonist" vs "pure-visual / abstract / scenery". Fired right after
// duration confirmation so we know whether to ask the identity menu next.
const HAS_PROTAGONIST_RE = /^(?:1|一|①|有主角|有人|有角色|有人物|有|有的|yes|has\s*(?:a\s*)?(?:protagonist|character|subject))$/i;
const PURE_VISUAL_RE     = /^(?:2|二|②|纯视觉|纯风景|抽象|无主角|没有主角|风景|pure\s*visual|abstract|scenery|environment|no\s*(?:protagonist|character|subject))$/i;

// ── Three-step identity-source menu regexes ────────────────────────────────
// Each picks an `IdentitySource` based on the user's reply. Match either the
// number (1/2/3/4) or a natural-language description. Case-insensitive.
const HAS_TURNAROUND_RE      = /^(?:1|一|①|我有(?:角色)?三视图|三视图|有三视图|已有三视图|character\s*sheet|turnaround(?:\s+sheet)?|i\s*have\s*(?:a\s*)?turnaround)$/i;
const HAS_CHARACTER_IMAGE_RE = /^(?:2|二|②|我有(?:人物|角色)?照片|有照片|有人物照|character\s*photo|i\s*have\s*(?:a\s*)?(?:character\s*)?photo|photo)$/i;
const DIRECT_IMAGE_RE        = /^(?:3|三|③|直接用图片|直接用|不要三视图|bypass\s*turnaround|use\s*image\s*directly|direct\s*image)$/i;
const TEXT_ONLY_IDENTITY_RE  = /^(?:4|四|④|没有图片?|纯文字|文字描述|无图片|text\s*only|no\s*image|none)$/i;
const SUBTITLE_AUTO_RE       = /^(?:1|一|①|自动|按需|默认|auto|automatic|as\s*needed|default)$/i;
const SUBTITLE_ALWAYS_RE     = /^(?:2|二|②|要字幕|带字幕|有字幕|加字幕|字幕|需要字幕|always|with\s*subtitles?|subtitles?\s*on)$/i;
const SUBTITLE_OFF_RE        = /^(?:3|三|③|不要字幕|无字幕|没字幕|去字幕|关闭字幕|off|no\s*subtitles?|subtitles?\s*off)$/i;
const RATIO_VERTICAL_RE      = /^(?:1|一|①|9\s*[:：xX]\s*16|竖屏|纵向|portrait|vertical)$/i;
const RATIO_HORIZONTAL_RE    = /^(?:2|二|②|16\s*[:：xX]\s*9|横屏|横向|landscape|horizontal)$/i;
const RATIO_SQUARE_RE        = /^(?:3|三|③|1\s*[:：xX]\s*1|方屏|方形|正方形|square)$/i;
const BGM_OFF_RE             = /^(?:1|一|①|不加(?:\s*(?:BGM|音乐|配乐))?|不要(?:\s*(?:BGM|音乐|配乐))?|无(?:\s*(?:BGM|音乐|配乐))?|跳过(?:\s*(?:BGM|音乐|配乐))?|不用(?:\s*(?:BGM|音乐|配乐))?|no(?:\s*(?:bgm|music|soundtrack))?|none|skip(?:\s*(?:bgm|music|soundtrack))?)$/i;
const BGM_ADD_RE             = /^(?:2|二|②|添加|加|有|要|bgm|music|soundtrack|add)$/i;
const BGM_ASSET_PROMPT_ZH    = '请发送本地音频路径，或直接音频文件 URL（mp3/wav/m4a/flac 等）；不加 BGM 回复 “不加”。';
const BGM_ASSET_PROMPT_EN    = 'Please send a local audio path or a direct audio-file URL (mp3/wav/m4a/flac, etc.); reply “no BGM” to skip.';
// "DONE_RE" handles "I'm finished uploading" inside the upload sub-stages.
const DONE_RE                = /^(?:完成|好了|发完了|上传完成|就这些|结束|done|finished)$/i;

function normalizeKey(input: SagaWorkflowInput): string {
  return `${input.scope}:${input.key}`;
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function parseTimeExpressionSeconds(text: string): number | undefined {
  const clock = text.match(/(?:从|start(?:ing)?(?:\s+at)?|music\s*start)?\s*(\d{1,2}):(\d{2})(?:\.(\d+))?/i);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) + Number(`0.${clock[3] ?? '0'}`);
  const sec = text.match(/(?:从|start(?:ing)?(?:\s+at)?|music\s*start)\s*(\d+(?:\.\d+)?)\s*(?:秒|s|sec|seconds)/i);
  if (sec) return Number(sec[1]);
  return undefined;
}

function parseDbAfter(text: string, re: RegExp): number | undefined {
  const match = text.match(re);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function looksLikePlatformMusicPage(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(?:^|\.)(?:spotify\.com|music\.apple\.com|music\.youtube\.com|youtube\.com|youtu\.be|soundcloud\.com|tidal\.com|deezer\.com|bandcamp\.com)$/.test(host);
  } catch {
    return false;
  }
}

function directAudioUrlsFromText(text: string): string[] {
  return extractHttpUrls(text).filter((url) => /\.(?:mp3|wav|m4a|aac|flac|ogg)(?:[?#].*)?$/i.test(url));
}

async function applyBgmReplyToState(state: SagaWorkflowState, text: string): Promise<{ ok: boolean; reply?: string }> {
  if (BGM_OFF_RE.test(text) || CONFIRM_DEFAULT_RE.test(text)) return { ok: true };
  if (BGM_ADD_RE.test(text)) {
    return {
      ok: false,
      reply: pickLocale(state.locale, {
        zh: BGM_ASSET_PROMPT_ZH,
        en: BGM_ASSET_PROMPT_EN,
      }),
    };
  }
  const urls = extractHttpUrls(text);
  const directUrls = directAudioUrlsFromText(text);
  if (urls.some(looksLikePlatformMusicPage) && directUrls.length === 0) {
    return {
      ok: false,
      reply: pickLocale(state.locale, {
        zh: '这个是音乐平台播放页链接，不是可直接下载的音频文件。请发本地音频路径，或 .mp3/.wav/.m4a/.flac 这类直接音频 URL；不加 BGM 回复 “不加”。',
        en: 'That is a music platform page link, not a directly downloadable audio file. Please send a local audio path or a direct .mp3/.wav/.m4a/.flac URL; reply “no BGM” to skip.',
      }),
    };
  }
  if (directUrls.length > 0) state.soundtrackUrl = directUrls[0];
  const refs = await classifyReferences(state.cwd, text);
  if (refs.audioPaths.length > 0) state.soundtrackPath = refs.audioPaths[0];
  if (!state.soundtrackPath && !state.soundtrackUrl) {
    return { ok: false, reply: buildBgmAskMessage(state) };
  }
  const start = parseTimeExpressionSeconds(text);
  if (typeof start === 'number' && Number.isFinite(start) && start >= 0) state.soundtrackStartSec = start;
  state.soundtrackVolumeDb = parseDbAfter(text, /(?:bgm|音乐|音量|volume)[^\n\d-]{0,20}(-?\d+(?:\.\d+)?)\s*dB/i) ?? state.soundtrackVolumeDb;
  state.environmentVolumeDb = parseDbAfter(text, /(?:环境音|ambience|ambient|environment)[^\n\d-]{0,20}(-?\d+(?:\.\d+)?)\s*dB/i) ?? state.environmentVolumeDb;
  const fadeOut = text.match(/(?:淡出|fade\s*out)[^\n\d]{0,12}(\d+(?:\.\d+)?)\s*(?:秒|s|sec|seconds)?/i);
  if (fadeOut) state.soundtrackFadeOutSec = Number(fadeOut[1]);
  const fadeIn = text.match(/(?:淡入|fade\s*in)[^\n\d]{0,12}(\d+(?:\.\d+)?)\s*(?:秒|s|sec|seconds)?/i);
  if (fadeIn) state.soundtrackFadeInSec = Number(fadeIn[1]);
  return { ok: true };
}



function pruneExpiredWorkflows(): void {
  const now = Date.now();
  for (const [key, workflow] of WORKFLOWS) {
    if (now - workflow.updatedAt > WORKFLOW_TTL_MS) WORKFLOWS.delete(key);
  }
}

function hasLongVideoIntent(text: string): boolean {
  const normalized = compact(text);
  if (!normalized) return false;
  return [
    /(?:长视频|长片|完整视频|完整短片|完整影片|一整条视频|视频解决方案|生产链|剪辑链|剪成|剪辑成片)/i,
    /(?:生成|创建|制作|产出|做成|转成|变成)[\s\S]{0,100}(?:\d+\s*(?:分钟|分|秒|s|sec|seconds|min|minutes))[\s\S]{0,80}(?:视频|短片|影片|video|movie|clip)/i,
    /\b(?:long[-\s]?form|long|full|complete)\b[\s\S]{0,80}\b(?:video|movie|clip)\b/i,
    /\b(?:generate|create|make|produce|turn)\b[\s\S]{0,80}\b(?:long|full|complete)\b[\s\S]{0,80}\b(?:video|movie|clip)\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function isSagaWorkflowSupportDiscussion(text: string): boolean {
  return isWorkflowSupportDiscussion(text, {
    workflowTerms: /(?:Saga|长视频|完整视频|generate_long_video|generate_video|视频|短片|动画|片段|video|movie|clip|工作流|流程|触发|生成)/i,
    creationSyntax: hasLongVideoIntent,
  });
}

function extractTargetDuration(text: string): number | undefined {
  const normalized = compact(text);
  const zhMinute = normalized.match(/(\d{1,3})\s*(?:分钟|分)/);
  if (zhMinute) return Number.parseInt(zhMinute[1] ?? '', 10) * 60;
  const zhSecond = normalized.match(/(\d{1,4})\s*秒/);
  if (zhSecond) return Number.parseInt(zhSecond[1] ?? '', 10);
  const enMinute = normalized.match(/(\d{1,3})\s*(?:min|mins|minute|minutes)\b/i);
  if (enMinute) return Number.parseInt(enMinute[1] ?? '', 10) * 60;
  const enSecond = normalized.match(/(\d{1,4})\s*(?:s|sec|secs|second|seconds)\b/i);
  if (enSecond) return Number.parseInt(enSecond[1] ?? '', 10);
  return undefined;
}

function clampDuration(seconds: number | undefined): number | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  return Math.max(10, Math.min(600, Math.floor(seconds)));
}

function estimateDuration(text: string): number {
  const chars = compact(text).length;
  if (chars > 1600) return 180;
  if (chars > 900) return 120;
  if (chars > 450) return 90;
  return 60;
}

function extractRatio(text: string): SagaRatio | undefined {
  // Deliberately conservative: only explicit aspect-ratio / orientation words.
  // Do NOT infer from platform names (小红书 / Instagram / YouTube / etc.);
  // the workflow asks the user to confirm the final hard generation parameter.
  if (/(?:9\s*[:：xX]\s*16|竖屏|纵向|portrait|vertical)/i.test(text)) return '9:16';
  if (/(?:1\s*[:：xX]\s*1|方屏|方形|正方形|square)/i.test(text)) return '1:1';
  if (/(?:16\s*[:：xX]\s*9|横屏|横向|landscape|horizontal)/i.test(text)) return '16:9';
  return undefined;
}

function applyRatioReplyToState(state: SagaWorkflowState, text: string): boolean {
  if (RATIO_VERTICAL_RE.test(text)) state.ratio = '9:16';
  else if (RATIO_HORIZONTAL_RE.test(text)) state.ratio = '16:9';
  else if (RATIO_SQUARE_RE.test(text)) state.ratio = '1:1';
  else if (CONFIRM_DEFAULT_RE.test(text)) state.ratio = state.suggestedRatio ?? '16:9';
  else return false;
  return true;
}

// ─── Reference collection helpers ─────────────────────────────────────────

function extractHttpUrls(text: string): string[] {
  const urls: string[] = [];
  const pattern = /https?:\/\/[^\s<>"'`，。；、]+/gi;
  for (const match of text.matchAll(pattern)) {
    urls.push(match[0].replace(/[),.;，。]+$/g, ''));
  }
  return unique(urls);
}

function extractLocalMediaPathCandidates(text: string): string[] {
  const values: string[] = [];
  const pattern = /(?:file:\/\/|~\/|\.\.?\/|\/|[A-Za-z0-9_.-]+\/)[^\n"'`，。；、]+?\.(?:png|jpe?g|webp|gif|bmp|svg|heic|heif|mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg)/gi;
  for (const match of text.matchAll(pattern)) {
    values.push(match[0].replace(/[),.;，。]+$/g, '').replace(/\\(.)/g, '$1'));
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
  if (candidate.startsWith('~/')) return path.join(os.homedir(), candidate.slice(2));
  if (candidate.startsWith('/')) return candidate;
  return path.resolve(cwd, candidate);
}

async function existingLocalMediaPaths(cwd: string, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const raw of extractLocalMediaPathCandidates(text)) {
    const resolved = resolveLocalPath(cwd, raw);
    try {
      const info = await stat(resolved);
      if (info.isFile() && info.size > 64) found.push(resolved);
    } catch {
      // ignore non-existent
    }
  }
  return unique(found);
}

function imageExtensionForMediaType(mediaType: ImageAttachment['mediaType']): string {
  if (mediaType === 'image/jpeg') return '.jpg';
  if (mediaType === 'image/webp') return '.webp';
  if (mediaType === 'image/gif') return '.gif';
  return '.png';
}

async function saveImageAttachmentsToLocalPaths(_cwd: string, imageAttachments?: ImageAttachment[]): Promise<string[]> {
  const out: string[] = [];
  const dir = path.join(getMediaOutputRoot(), 'saga-refs');
  let dirReady = false;
  for (const attachment of imageAttachments ?? []) {
    if (attachment.data && attachment.mediaType) {
      const bytes = Buffer.from(attachment.data, 'base64');
      if (bytes.length <= 0) continue;
      if (!dirReady) {
        await mkdir(dir, { recursive: true });
        dirReady = true;
      }
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
      const filePath = path.join(dir, `reference-${hash}${imageExtensionForMediaType(attachment.mediaType)}`);
      await writeFile(filePath, bytes);
      out.push(filePath);
    }
  }
  return unique(out);
}

type ExtractedReferences = {
  imageUrls: string[];
  videoUrls: string[];
  audioUrls: string[];
  imagePaths: string[];
  videoPaths: string[];
  audioPaths: string[];
};

async function classifyReferences(
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
    if (/\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/.test(lower)) imageUrls.push(url);
    else if (/\.(?:mp4|mov|webm|m4v)(?:[?#].*)?$/.test(lower)) videoUrls.push(url);
    else if (/\.(?:mp3|wav|m4a|aac|flac|ogg)(?:[?#].*)?$/.test(lower)) audioUrls.push(url);
  }
  for (const localPath of await existingLocalMediaPaths(cwd, text)) {
    const lower = localPath.toLowerCase();
    if (/\.(?:png|jpe?g|webp|gif|bmp|svg|heic|heif)$/.test(lower)) imagePaths.push(localPath);
    else if (/\.(?:mp4|mov|webm|m4v)$/.test(lower)) videoPaths.push(localPath);
    else if (/\.(?:mp3|wav|m4a|aac|flac|ogg)$/.test(lower)) audioPaths.push(localPath);
  }
  for (const attachment of imageAttachments ?? []) {
    if (attachment.sourceUrl && !attachment.data) imageUrls.push(attachment.sourceUrl);
  }
  imagePaths.push(...await saveImageAttachmentsToLocalPaths(cwd, imageAttachments));

  return {
    imageUrls: unique(imageUrls),
    videoUrls: unique(videoUrls),
    audioUrls: unique(audioUrls),
    imagePaths: unique(imagePaths),
    videoPaths: unique(videoPaths),
    audioPaths: unique(audioPaths),
  };
}

function mergeRefs(state: SagaWorkflowState, refs: ExtractedReferences): void {
  state.referenceImageUrls = unique([...state.referenceImageUrls, ...refs.imageUrls]);
  state.referenceVideoUrls = unique([...state.referenceVideoUrls, ...refs.videoUrls]);
  state.referenceAudioUrls = unique([...state.referenceAudioUrls, ...refs.audioUrls]);
  state.referenceImagePaths = unique([...state.referenceImagePaths, ...refs.imagePaths]);
  state.referenceVideoPaths = unique([...state.referenceVideoPaths, ...refs.videoPaths]);
  state.referenceAudioPaths = unique([...state.referenceAudioPaths, ...refs.audioPaths]);
  state.updatedAt = Date.now();
}

function mergeStoryboardRefs(state: SagaWorkflowState, refs: ExtractedReferences): void {
  state.storyboardImageUrls = unique([...state.storyboardImageUrls, ...refs.imageUrls]);
  state.storyboardImagePaths = unique([...state.storyboardImagePaths, ...refs.imagePaths]);
  // Non-image attachments sent while waiting for the storyboard are still useful
  // references, but image attachments are intentionally kept out of identity refs.
  state.referenceVideoUrls = unique([...state.referenceVideoUrls, ...refs.videoUrls]);
  state.referenceAudioUrls = unique([...state.referenceAudioUrls, ...refs.audioUrls]);
  state.referenceVideoPaths = unique([...state.referenceVideoPaths, ...refs.videoPaths]);
  state.referenceAudioPaths = unique([...state.referenceAudioPaths, ...refs.audioPaths]);
  state.updatedAt = Date.now();
}

function refTotal(state: SagaWorkflowState): number {
  return state.referenceImageUrls.length + state.referenceVideoUrls.length + state.referenceAudioUrls.length
    + state.referenceImagePaths.length + state.referenceVideoPaths.length + state.referenceAudioPaths.length
    + state.storyboardImageUrls.length + state.storyboardImagePaths.length;
}

function maybeRememberReferenceNote(state: SagaWorkflowState, text: string): void {
  const note = compact(text);
  if (!note || START_RE.test(note) || CANCEL_RE.test(note) || CONFIRM_DEFAULT_RE.test(note)) return;
  if (/^\[用户发送了一张图片/.test(note)) return;
  state.referenceNotes = unique([...state.referenceNotes, note]).slice(-8);
  state.updatedAt = Date.now();
}

// Strip http(s) URLs and standalone media-path-like tokens from a turn so the
// remaining text reflects only the user's narrative content. We use this to
// decide whether a turn is "just refs" or actually contains story material.
function stripRefTokens(text: string): string {
  let stripped = text.replace(/https?:\/\/\S+/gi, ' ');
  stripped = stripped.replace(/(?:~\/|\.\.?\/|\/|[A-Za-z0-9_.-]+\/)?\S+\.(?:png|jpe?g|webp|gif|mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg)\b/gi, ' ');
  stripped = stripped.replace(/^\[用户发送了一张图片[^\]]*\]/g, ' ');
  return compact(stripped);
}

function imageReferenceLabel(state: SagaWorkflowState, ref: string, offset: number): string {
  const existingCount = state.referenceImagePaths.length + state.referenceImageUrls.length;
  const number = existingCount + offset + 1;
  const kind = state.identitySource === 'direct_image'
    ? 'direct video material image'
    : state.identitySource === 'turnaround'
      ? 'turnaround / identity image'
      : state.identitySource === 'character_image'
        ? 'character source image'
        : 'reference image';
  return `Image reference ${number} (${kind}): ${ref}`;
}

function maybeRememberImageReferenceNotes(state: SagaWorkflowState, refs: ExtractedReferences, text: string): boolean {
  const imageRefs = [...refs.imagePaths, ...refs.imageUrls];
  if (imageRefs.length === 0) return false;
  const caption = stripRefTokens(text);
  if (!caption || START_RE.test(caption) || CANCEL_RE.test(caption) || CONFIRM_DEFAULT_RE.test(caption) || STORY_ENHANCE_RE.test(caption) || STORYBOARD_RE.test(caption)) {
    return false;
  }
  const notes = imageRefs.map((ref, idx) => {
    const label = imageReferenceLabel(state, ref, idx);
    return `${label}. User caption/instruction for this exact image: ${caption}`;
  });
  state.referenceNotes = unique([...state.referenceNotes, ...notes]).slice(-16);
  state.updatedAt = Date.now();
  return true;
}

function maybeAccumulateStory(state: SagaWorkflowState, text: string): boolean {
  const compacted = compact(text);
  if (!compacted) return false;
  if (START_RE.test(compacted) || CANCEL_RE.test(compacted) || CONFIRM_DEFAULT_RE.test(compacted)) return false;
  const narrative = stripRefTokens(text);
  // Threshold: ~30 chars of non-ref text. This catches a script paragraph but
  // skips short captions like "这是主角" which still go to referenceNotes.
  // However, short turns such as "剧情你来创造" are substantive generation
  // direction and must be counted as script/director notes instead of being
  // hidden only in referenceNotes.
  if (narrative.length < 30 && !STORY_DIRECTIVE_RE.test(narrative)) return false;
  const existing = new Set(state.accumulatedStory.map((entry) => entry.trim()));
  const candidate = compacted;
  if (existing.has(candidate)) return false;
  state.accumulatedStory.push(candidate);
  state.updatedAt = Date.now();
  return true;
}

function combinedStoryText(state: SagaWorkflowState): string {
  const parts: string[] = [];
  if (state.originalText) parts.push(state.originalText);
  for (const segment of state.accumulatedStory) {
    if (segment && !parts.includes(segment)) parts.push(segment);
  }
  return parts.join('\n\n');
}

// ─── Replies ─────────────────────────────────────────────────────────────

async function buildModelLine(cwd: string, locale: UiLocale = 'zh-CN'): Promise<string> {
  const configured = await resolveConfiguredVisualProvider(cwd, 'video');
  if (!configured) {
    return pickLocale(locale, {
      zh: '当前没有检测到可用视频模型配置。',
      en: 'No usable video model is currently configured.',
    });
  }
  const limits = resolveVideoModelLimits(configured.config.video.provider, configured.model);
  // Strip provider prefix from user-visible model line.
  const modelOnly = String(configured.model).replace(/^[^/]+\//, '');
  return pickLocale(locale, {
    zh: `当前视频模型：${modelOnly}，单段上限约 ${limits.maxSegmentSeconds} 秒，Saga 会自动拆成多段再合成。`,
    en: `Current video model: ${modelOnly}, per-segment cap ≈ ${limits.maxSegmentSeconds}s; Saga splits into multiple segments and stitches.`,
  });
}

function buildRefAckMessage(state: SagaWorkflowState): string {
  const storyCount = state.accumulatedStory.length;
  const imgs = state.referenceImageUrls.length + state.referenceImagePaths.length;
  const storyboardImgs = state.storyboardImageUrls.length + state.storyboardImagePaths.length;
  const vids = state.referenceVideoUrls.length + state.referenceVideoPaths.length;
  const auds = state.referenceAudioUrls.length + state.referenceAudioPaths.length;
  if (state.locale === 'zh-CN') {
    const counts = `图 ${imgs} · 分镜图 ${storyboardImgs} · 视频 ${vids} · 音频 ${auds} · 剧本段 ${storyCount}`;
    const lines = [`已收：${counts}`];
    if (storyCount > 0) lines.push('剧本已归档，生成时会严格按你的版本来。');
    if (storyboardImgs > 0) lines.push('分镜图已归档，生成前会先解析成镜头段落。');
    lines.push('如果下一张图片是完整分镜剧本，请先回复 "分镜图"。');
    lines.push('如果没有剧本灵感，回复 "剧情增强"，我会基于已锁定身份和素材自动补完整剧情。');
    lines.push('💡 如果是纯风景或纯视觉素材，请回复 "无主角" 或 "纯视觉"。');
    lines.push('可以继续补充，或回复 "开始生成" 进入下一步。');
    return lines.join('\n');
  }
  const counts = `${imgs} images · ${storyboardImgs} storyboard images · ${vids} videos · ${auds} audio · ${storyCount} script segments`;
  const lines = [`Received: ${counts}`];
  if (storyCount > 0) lines.push('Script archived — generation will follow your version exactly.');
  if (storyboardImgs > 0) lines.push('Storyboard image archived — it will be parsed into shot segments before generation.');
  lines.push('If your next image is a complete storyboard script, reply "storyboard" first.');
  lines.push('If you have no script idea, reply "story enhance" and I will build a full story from the locked identity/materials.');
  lines.push('💡 Reply "abstract" or "no lead" if this is a pure landscape or visual piece.');
  lines.push('Send more if you like, or reply "start" to proceed.');
  return lines.join('\n');
}

// ─── Subject-mode menu (has-protagonist vs pure-visual) ────────────────────

function buildSubjectModeAskMessage(state: SagaWorkflowState): string {
  return pickLocale(state.locale, {
    zh: [
      '🎬 这段视频里 — 请选择：',
      '',
      '  1️⃣ 有主角 — 有具体的人物 / 角色 / 商品出镜',
      '  2️⃣ 纯视觉 — 风景、抽象、环境、氛围，没有特定主角',
      '',
      '回复编号或描述即可。回复 "取消" 退出。',
    ].join('\n'),
    en: [
      '🎬 In this video — choose one:',
      '',
      '  1️⃣ Has protagonist — specific person / character / product on camera',
      '  2️⃣ Pure visual — scenery, abstract, environment, atmosphere, no protagonist',
      '',
      'Reply with the number or description. Reply "cancel" to exit.',
    ].join('\n'),
  });
}

function formatRatioLabel(ratio: SagaRatio | undefined, locale: UiLocale): string {
  const value = ratio ?? '16:9';
  if (locale === 'zh-CN') {
    if (value === '9:16') return '9:16 竖屏';
    if (value === '1:1') return '1:1 方屏';
    return '16:9 横屏';
  }
  if (value === '9:16') return '9:16 portrait';
  if (value === '1:1') return '1:1 square';
  return '16:9 landscape';
}

function buildRatioAskMessage(state: SagaWorkflowState): string {
  const suggestion = state.suggestedRatio ?? '16:9';
  return pickLocale(state.locale, {
    zh: [
      `📐 请选择视频画幅比例（当前建议：${formatRatioLabel(suggestion, state.locale)}）`,
      '',
      '  1️⃣ 9:16 竖屏 — 手机观看 / 竖向构图',
      '  2️⃣ 16:9 横屏 — 电影感 / 横向场景',
      '  3️⃣ 1:1 方屏 — 社媒方形内容',
      '',
      '说明：只根据剧本里明确写出的 9:16 / 16:9 / 1:1 / 竖屏 / 横屏 / 方屏做预选；不会用平台名自动推断，避免误触发。',
      '回复编号或比例即可；回复“默认/自动”使用当前建议。回复 "取消" 退出。',
    ].join('\n'),
    en: [
      `📐 Choose video aspect ratio (current suggestion: ${formatRatioLabel(suggestion, state.locale)})`,
      '',
      '  1️⃣ 9:16 portrait — mobile / vertical framing',
      '  2️⃣ 16:9 landscape — cinematic / horizontal scenes',
      '  3️⃣ 1:1 square — square social format',
      '',
      'Note: Artemis only preselects from explicit 9:16 / 16:9 / 1:1 / portrait / landscape / square wording; it does not infer from platform names.',
      'Reply with a number or ratio; reply "default/auto" to use the suggestion. Reply "cancel" to stop.',
    ].join('\n'),
  });
}

function buildSubtitleModeAskMessage(state: SagaWorkflowState): string {
  return pickLocale(state.locale, {
    zh: [
      '💬 是否携带字幕？',
      '',
      '  1️⃣ 自动 — 只有你明确要求字幕/屏幕文字时才加（推荐）',
      '  2️⃣ 带字幕 — 对对白/旁白生成可读字幕，原文保留不翻译',
      '  3️⃣ 无字幕 — 对白只走音频/口型，不渲染成屏幕文字',
      '',
      '回复编号或描述即可。回复 "取消" 退出。',
    ].join('\n'),
    en: [
      '💬 Should the video include subtitles?',
      '',
      '  1️⃣ Auto — only add subtitles/on-screen text when you explicitly asked for them (recommended)',
      '  2️⃣ With subtitles — render readable captions for dialogue/voiceover, preserving original text',
      '  3️⃣ No subtitles — dialogue stays audio/lip-sync only, not on-screen text',
      '',
      'Reply with the number or description. Reply "cancel" to exit.',
    ].join('\n'),
  });
}


function buildBgmAskMessage(state: SagaWorkflowState): string {
  return pickLocale(state.locale, {
    zh: [
      '🎵 是否添加本地 BGM？',
      '',
      '  1️⃣ 不加 BGM — 只保留视频环境音/对白',
      '  2️⃣ 添加 BGM — 发送本地音频路径，或直接音频文件 URL（mp3/wav/m4a/flac 等）',
      '',
      '说明：Spotify / Apple Music / YouTube Music 这类“播放页链接”不是音频文件直链，系统不会绕过平台下载；请提供本地音频文件或可直接下载的音频 URL。',
      '可选参数示例：/Users/me/song.mp3 从1:19开始 音量-12dB 环境音-20dB 淡出1.2秒',
      '',
      '回复编号、路径或 URL 即可。回复 "取消" 退出。',
    ].join('\n'),
    en: [
      '🎵 Add local BGM?',
      '',
      '  1️⃣ No BGM — keep only video ambience/dialogue',
      '  2️⃣ Add BGM — send a local audio path or a direct audio-file URL (mp3/wav/m4a/flac, etc.)',
      '',
      'Note: Spotify / Apple Music / YouTube Music page links are not direct audio files; Artemis will not bypass platforms to download them. Please provide a local audio file or directly downloadable audio URL.',
      'Optional example: /Users/me/song.mp3 start 1:19 volume -12dB ambience -20dB fadeout 1.2s',
      '',
      'Reply with a number, path, or URL. Reply "cancel" to stop.',
    ].join('\n'),
  });
}

/**
 * After identity/subject mode is locked, prompt the user to add the OTHER
 * materials (storyboard image, script, video/audio refs, scene-only images
 * if pure-visual). This is the "collecting_refs intro" message.
 */
function buildRefIntroMessage(state: SagaWorkflowState): string {
  const idTag = state.identitySource
    ? pickLocale(state.locale, {
        zh: `· 身份来源：${state.identitySource === 'turnaround' ? '三视图' : state.identitySource === 'character_image' ? '角色照片' : state.identitySource === 'direct_image' ? '直接图片' : '纯文字'}`,
        en: `· identity: ${state.identitySource}`,
      })
    : pickLocale(state.locale, { zh: '· 纯视觉模式', en: '· pure-visual mode' });
  return pickLocale(state.locale, {
    zh: [
      `✅ 身份设定已锁定 ${idTag}`,
      '',
      '现在可以补充其它素材（可选）：',
      '  · 分镜图：先回复 "分镜图"，再发一张完整分镜剧本图',
      '  · 剧本 / 设定 / 场景描述：直接打字发就行',
      '  · 视频 / 音频参考：发 URL 或本地路径',
      '  · 没有剧本灵感：回复 "剧情增强"，我会基于已锁定身份和素材补成完整剧情',
      '',
      '补充完回复 "开始生成"；不想加直接回复 "开始生成"；中途想停回复 "取消"。',
    ].join('\n'),
    en: [
      `✅ Identity locked ${idTag}`,
      '',
      'You can now add other materials (all optional):',
      '  · Storyboard: reply "storyboard" first, then send the storyboard image',
      '  · Script / setting / scene description: just type it',
      '  · Video / audio reference: send a URL or local path',
      '  · No script idea: reply "story enhance" and I will expand the locked identity/materials into a full story',
      '',
      'Reply "start" when done (or right now if you don\'t want extras). Reply "cancel" to stop.',
    ].join('\n'),
  });
}

/**
 * Mark the state as "pure-visual / abstract" — same effect the user would get
 * by typing "无主角" / "纯视觉" mid-collection in the legacy flow. We surface
 * the choice as an explicit note so narrative analysis & generation honor it.
 */
function markAbstractPreference(state: SagaWorkflowState): void {
  state.referenceNotes.push(
    state.locale === 'zh-CN'
      ? '【用户上来就明确：纯视觉模式 — 没有主角，请输出风景/环境/抽象画面，禁止生成具体人物或可识别角色。】'
      : '[User explicitly chose pure-visual mode up-front — no protagonist; output scenery/environment/abstract imagery only; do NOT introduce specific persons or recognizable characters.]',
  );
}

function buildStoryboardAskMessage(state: SagaWorkflowState): string {
  return pickLocale(state.locale, {
    zh: '好的，下一张图片我会按“完整分镜剧本图”处理：解析镜头顺序、画面内容、动作、景别、镜头运动和时长。请直接发送分镜图；发错了可回复“取消”。',
    en: 'Got it. I will treat the next image as a complete storyboard script: shot order, visual content, action, framing, camera movement, and duration. Send the storyboard image now, or reply "cancel" to stop.',
  });
}

// ─── Narrative analysis & protagonist clarification ─────────────────────

const NARRATIVE_CONFIDENCE_THRESHOLD = 0.7;

async function runNarrativeAnalysis(state: SagaWorkflowState): Promise<NarrativeEntities> {
  const fullStory = combinedStoryText(state);
  const imagePaths = [...state.referenceImagePaths];
  const llmResult = await analyzeNarrative({
    cwd: state.cwd,
    userText: fullStory,
    imagePaths,
  });
  if (llmResult) return llmResult;
  // LLM unavailable — keyword fallback (no image-content inspection here; we only know
  // an image was supplied. Treat any user image as a likely face for character-detection.)
  return narrativeKeywordFallback({
    userText: fullStory,
    hasFaceLikelyInImages: imagePaths.length > 0,
  });
}

function shouldAskProtagonistClarification(narrative: NarrativeEntities): boolean {
  // Keyword-fallback fires when the LLM is unavailable. Its output has no
  // concrete entities — clarification options would be empty, deadlocking
  // the user. Better to proceed with whatever defaults Saga has and let the
  // critic / rewriter clean up downstream.
  if (narrative.source === 'keyword-fallback') return false;
  if (narrative.mode === 'unclear' || narrative.mode === 'mixed') return true;
  return narrative.protagonist.confidence < NARRATIVE_CONFIDENCE_THRESHOLD;
}

function buildProtagonistOptions(state: SagaWorkflowState, narrative: NarrativeEntities): Array<{ key: string; label: string; type: ProtagonistType; mode: ProtagonistMode; name: string; isOwnDescription?: boolean }> {
  const opts: Array<{ key: string; label: string; type: ProtagonistType; mode: ProtagonistMode; name: string; isOwnDescription?: boolean }> = [];
  const tag = (type: ProtagonistType) => pickLocale(state.locale, {
    zh: type === 'character' ? '角色为主' : type === 'product' ? '产品/道具为主' : '场景为主',
    en: type === 'character' ? 'character lead' : type === 'product' ? 'product / object lead' : 'environment lead',
  });
  const ownLabel = pickLocale(state.locale, {
    zh: '我自己来描述（直接告诉我谁或者什么是主角）',
    en: 'I\'ll describe it myself (just tell me who or what the lead is)',
  });
  const noLeadLabel = pickLocale(state.locale, {
    zh: '这是一个纯环境/抽象/氛围视频（绝对不要出现任何人物或主体）',
    en: 'This is a pure environment/abstract/atmospheric video (NO characters or subjects at all)',
  });
  if (narrative.protagonist.name && narrative.protagonist.name !== '(unnamed)' && narrative.protagonist.name !== '(undetermined — fallback)') {
    opts.push({
      key: 'A',
      label: `${narrative.protagonist.name} (${tag(narrative.protagonist.type)})`,
      type: narrative.protagonist.type,
      mode: narrative.protagonist.type,
      name: narrative.protagonist.name,
    });
  }
  for (const supporting of narrative.supportingCharacters.slice(0, 2)) {
    opts.push({ key: String.fromCharCode(65 + opts.length), label: `${supporting} (${tag('character')})`, type: 'character', mode: 'character', name: supporting });
  }
  for (const prop of narrative.props.slice(0, 2)) {
    opts.push({ key: String.fromCharCode(65 + opts.length), label: `${prop} (${tag('product')})`, type: 'product', mode: 'product', name: prop });
  }
  for (const env of narrative.environments.slice(0, 1)) {
    opts.push({ key: String.fromCharCode(65 + opts.length), label: `${env} (${tag('environment')})`, type: 'environment', mode: 'environment', name: env });
  }
  opts.push({
    key: String.fromCharCode(65 + opts.length),
    label: ownLabel,
    type: narrative.protagonist.type,
    mode: narrative.protagonist.type,
    name: narrative.protagonist.name,
    isOwnDescription: true,
  });
  opts.push({
    key: 'X',
    label: noLeadLabel,
    type: 'environment',
    mode: 'environment',
    name: 'Pure Abstract Environment',
    isOwnDescription: false,
  });
  return opts;
}

// ─── Three-step identity-source menu messages ───────────────────────────────

function hasCollectedAnyImage(state: SagaWorkflowState): boolean {
  return state.referenceImagePaths.length > 0 || state.referenceImageUrls.length > 0
}

function buildIdentitySourceAskMessage(state: SagaWorkflowState): string {
  return pickLocale(state.locale, {
    zh: [
      '📋 角色身份来源 — 请选择：',
      '',
      '  1️⃣ 我有角色三视图 — 直接上传，跳过图片模型生成',
      '  2️⃣ 我有人物/角色照片 — 系统会用图片模型生成三视图',
      '  3️⃣ 直接用图片做视频素材 — 跳过三视图，图片直接传给视频模型',
      '  4️⃣ 没有图片 — 纯文字描述角色',
      '',
      '回复编号或描述即可。回复 "取消" 退出。',
    ].join('\n'),
    en: [
      '📋 Character identity source — choose one:',
      '',
      '  1️⃣ I have a turnaround sheet — upload directly, skip the image model',
      '  2️⃣ I have a character photo — the system will generate a turnaround via image model',
      '  3️⃣ Use image directly as video reference — skip turnaround, pass image to video model',
      '  4️⃣ No image — text-only character description',
      '',
      'Reply with the number or description. Reply "cancel" to exit.',
    ].join('\n'),
  })
}

function buildTurnaroundUploadMessage(state: SagaWorkflowState): string {
  return pickLocale(state.locale, {
    zh: '📤 请发送你的角色三视图（一次发完，可以是多张）。发送完成后回复 "开始生成" 或 "完成"。',
    en: '📤 Please send your character turnaround sheet (one or several images). Reply "start" or "done" when finished.',
  })
}

function buildCharacterImageUploadMessage(state: SagaWorkflowState): string {
  return pickLocale(state.locale, {
    zh: [
      '📤 请发送你的角色/人物照片。',
      '系统会用图片模型把它转换为三视图，然后进入视频生成流程。',
      '⚠️ 如果图片包含成人内容且图片模型不支持，三视图生成可能失败；届时你可以改选 "直接用图片" 路径。',
      '发完后回复 "开始生成" 或 "完成"。',
    ].join('\n'),
    en: [
      '📤 Please send your character / person photo.',
      'The image model will convert it into a turnaround sheet and proceed to video generation.',
      '⚠️ If the photo contains adult content and the image model refuses, you can switch to the "direct image" path afterward.',
      'Reply "start" or "done" when finished.',
    ].join('\n'),
  })
}

function buildDirectImageUploadMessage(state: SagaWorkflowState): string {
  return pickLocale(state.locale, {
    zh: [
      '📤 请发送你想用作视频素材的图片。',
      '图片会直接作为视频模型的参考帧，跳过三视图生成。',
      '建议每次只发一张图，并在同条消息写清楚这张图的用途 / 出现时机 / 剧情作用；我会把每张图和它的文字说明配对归档。',
      '发完后回复 "开始生成" 或 "完成"。',
    ].join('\n'),
    en: [
      '📤 Please send the image(s) you want to use as video reference frames.',
      'They will be passed directly to the video model, bypassing turnaround generation.',
      'Best practice: send one image per message, with that image\'s purpose / timing / story role in the same message; I will archive each image with its paired caption.',
      'Reply "start" or "done" when finished.',
    ].join('\n'),
  })
}

function buildDirectImageAckMessage(state: SagaWorkflowState, pairedCaption: boolean): string {
  const count = state.referenceImagePaths.length + state.referenceImageUrls.length;
  return pickLocale(state.locale, {
    zh: [
      `已收到 ${count} 张视频素材图。`,
      pairedCaption
        ? '这张图的同条文字说明已配对归档，会作为它的用途 / 出现时机 / 剧情作用进入后续分析。'
        : '如果这张图有特定用途 / 出现时机 / 剧情作用，可以继续补一句说明；建议后续每次一张图并同条写说明。',
      '可以继续发下一张图，或回复 "完成" / "开始生成" 进入下一步。',
    ].join('\n'),
    en: [
      `Got ${count} direct video material image(s).`,
      pairedCaption
        ? 'The text sent with this image has been paired and archived as its purpose / timing / story role for later analysis.'
        : 'If this image has a specific purpose / timing / story role, you can add one note; best practice is one image per message with its caption in the same message.',
      'Send the next image, or reply "done" / "start" to continue.',
    ].join('\n'),
  });
}

function buildProtagonistAskMessage(state: SagaWorkflowState): string {
  if (state.locale === 'zh-CN') {
    const lines = [
      '主角还没完全确定，需要你敲定一下。',
      state.narrative?.modeRationale ? `我目前的判断：${state.narrative.modeRationale}` : '',
      '请选择编号，或直接用一句话告诉我谁是主角：',
    ].filter(Boolean);
    for (const opt of state.protagonistOptions ?? []) lines.push(`  ${opt.key}. ${opt.label}`);
    lines.push('不做了回复 "取消"。');
    return lines.join('\n');
  }
  const lines = [
    `Need you to confirm the lead — I haven't fully settled on one.`,
    state.narrative?.modeRationale ? `My current read: ${state.narrative.modeRationale}` : '',
    'Pick a letter, or tell me in one sentence who the lead is:',
  ].filter(Boolean);
  for (const opt of state.protagonistOptions ?? []) lines.push(`  ${opt.key}. ${opt.label}`);
  lines.push('To stop, reply "cancel".');
  return lines.join('\n');
}

function applyProtagonistChoice(state: SagaWorkflowState, text: string): boolean {
  if (!state.narrative || !state.protagonistOptions) return false;
  const trimmed = text.trim();
  // Match a single letter at the start, optionally followed by a separator
  // and a freeform description. Examples that all parse:
  //   "A"
  //   "A."
  //   "A. 红衣女孩是主角"
  //   "D 红衣女孩是主角"
  //   "B - the cookie sister"
  const keyMatch = trimmed.match(/^([A-Za-z])\b\s*[.、,。:：\-—–]?\s*(.*)$/);
  if (keyMatch) {
    const chosen = state.protagonistOptions.find((opt) => opt.key.toUpperCase() === keyMatch[1]!.toUpperCase());
    if (chosen) {
      const trailing = (keyMatch[2] ?? '').trim();
      if (chosen.isOwnDescription) {
        // Own-description option requires actual descriptive text. If the
        // user only sent the letter, wait for them to type more on the
        // next turn. If they sent letter + description, USE the description.
        if (!trailing || trailing.length < 2) return false;
        state.narrative = {
          ...state.narrative,
          protagonist: { ...state.narrative.protagonist, name: trailing, type: state.narrative.protagonist.type, confidence: 1.0, evidence: 'user freeform clarification (own description)' },
          mode: state.narrative.protagonist.type,
          modeRationale: `User typed their own protagonist description: "${trailing.slice(0, 80)}"`,
          source: 'user-clarification',
        };
        return true;
      }
      // For a non-own-description option, prefer trailing text if it's a
      // substantive description (len >=2); otherwise use the option's
      // canonical name. This way "D 红衣女孩是主角" overrides chosen.name
      // with the user's actual phrasing, while "D" alone uses the option.
      const finalName = trailing.length >= 2 ? trailing : chosen.name;
      state.narrative = {
        ...state.narrative,
        protagonist: { ...state.narrative.protagonist, name: finalName, type: chosen.type, confidence: 1.0, evidence: trailing.length >= 2 ? 'user clarification (option + description)' : 'user clarification (option)' },
        mode: chosen.mode,
        modeRationale: trailing.length >= 2
          ? `User picked ${chosen.key} and provided their own description: "${trailing.slice(0, 80)}"`
          : `User selected option ${chosen.key}: ${chosen.label}`,
        source: 'user-clarification',
      };
      return true;
    }
  }
  // Freeform: user typed a description; treat the trimmed text as the protagonist name and infer type from existing narrative
  if (trimmed.length >= 2) {
    const inferredType: ProtagonistType = state.narrative.protagonist.type;
    state.narrative = {
      ...state.narrative,
      protagonist: { ...state.narrative.protagonist, name: trimmed, type: inferredType, confidence: 1.0, evidence: 'user freeform clarification' },
      mode: inferredType,
      modeRationale: `User freeform clarification: "${trimmed.slice(0, 80)}"`,
      source: 'user-clarification',
    };
    return true;
  }
  return false;
}

async function buildDurationAskMessage(state: SagaWorkflowState): Promise<string> {
  const modelLine = await buildModelLine(state.cwd, state.locale);
  const estimated = estimateDuration(combinedStoryText(state));
  const refsCount = refTotal(state);
  const imgs = state.referenceImageUrls.length + state.referenceImagePaths.length + state.turnaroundImagePaths.length + state.turnaroundImageUrls.length;
  const vids = state.referenceVideoUrls.length + state.referenceVideoPaths.length;
  const auds = state.referenceAudioUrls.length + state.referenceAudioPaths.length;
  const storyCount = state.accumulatedStory.length;
  if (state.locale === 'zh-CN') {
    const refLine = refsCount > 0 ? `参考材料：图 ${imgs} / 视频 ${vids} / 音频 ${auds}。` : '本次没有参考素材，将完全依据文字描述生成。';
    const storyLine = storyCount > 0 ? `剧本共 ${storyCount} 段，会严格按你写的来。` : '剧本由我来安排。';
    return [
      '已经收齐素材，最后确认一下总时长。',
      modelLine,
      refLine,
      storyLine,
      state.prefilledDuration
        ? `我从你前面的文字里识别到 ${state.prefilledDuration} 秒；回复 "默认/自动" 就用这个。也可以重新告诉我 "60秒"、"90秒"、"2分钟"。`
        : `请告诉我视频总长度 — "60秒"、"90秒"、"2分钟" 之类都行；想让我根据剧本和素材决定就回复 "自动"（建议 ${estimated} 秒）。`,
      '不做了回复 "取消"。',
    ].join('\n');
  }
  const refLine = refsCount > 0 ? `Reference materials: ${imgs} images / ${vids} videos / ${auds} audio.` : 'No reference materials this run — generation will follow text only.';
  const storyLine = storyCount > 0 ? `Script: ${storyCount} segments, exactly as you wrote it.` : 'Script: I\'ll compose it.';
  return [
    'Ready to begin — just need to confirm the total length.',
    modelLine,
    refLine,
    storyLine,
    state.prefilledDuration
      ? `I detected ${state.prefilledDuration}s earlier; reply "default/auto" to use that, or give a new duration such as "60s", "90s", "2 minutes".`
      : `How long should the video be? Tell me a duration — "60s", "90s", "2 minutes" — or reply "auto" and I'll choose from the complete script/materials (suggesting ${estimated}s).`,
    'To stop, reply "cancel".',
  ].join('\n');
}

// ─── Final saga generation prompt ────────────────────────────────────────

function buildGenerationPrompt(state: SagaWorkflowState): string {
  // Sanitize user input on the way through — provider-side trigger words
  // (like "真人") get mapped to safe equivalents that preserve meaning.
  const fullStory = sanitizeForVideoProvider(combinedStoryText(state));
  const targetDuration = clampDuration(state.targetDuration ?? state.prefilledDuration) ?? estimateDuration(fullStory);
  const ratio = state.ratio ?? state.suggestedRatio ?? extractRatio(fullStory) ?? '16:9';
  const projectId = `saga-${Date.now()}`;
  const sanitizedAccumulated = state.accumulatedStory.map((s) => sanitizeForVideoProvider(s));
  const aiScreenwriterSeed = state.aiScreenwriterMode === true;
  const preserveUserScript = hasExplicitUserScriptText(sanitizedAccumulated) && !aiScreenwriterSeed;
  const cleanDirect = wantsCleanDirectMode([state.originalText, ...sanitizedAccumulated]);
  const creativeSeedSegments = sanitizedAccumulated.length > 0 ? sanitizedAccumulated : [fullStory].filter(Boolean);
  const userScriptBlock = (sanitizedAccumulated.length > 0 || aiScreenwriterSeed)
    ? (aiScreenwriterSeed
      ? [
        '',
        '[USER CREATIVE SEED — AI SCREENWRITER MODE]',
        'The user gave partial inspiration and explicitly wants AI to act as screenwriter/director. Treat these lines as anchors and constraints, NOT as a finished authoritative script. Create a coherent cinematic plot with setup, escalation, payoff, shot-ready actions, and continuity. Preserve every concrete user anchor, but invent missing connective tissue, scene beats, emotions, and visual actions.',
        ...creativeSeedSegments.map((segment, idx) => `--- Creative seed ${idx + 1} ---\n${segment}`),
        '',
      ].join('\n')
      : [
        '',
        '[USER-SUPPLIED SCRIPT — AUTHORITATIVE]',
        'The user provided the following story text. Use it AS-IS as the controlling narrative; do not invent or substitute a different story. Distribute it across shots so the storyBeats follow this script faithfully:',
        ...sanitizedAccumulated.map((segment, idx) => `--- Story segment ${idx + 1} ---\n${segment}`),
        '',
      ].join('\n'))
    : '';
  const narrativeBlock = state.narrative
    ? [
        '',
        buildSagaConstitution(state.narrative),
        '',
        '[Saga Narrative Entity Map — pass this through to generate_long_video as `narrativeEntities` so the planner and critic can use it]',
        JSON.stringify({
          protagonist: state.narrative.protagonist,
          supportingCharacters: state.narrative.supportingCharacters,
          props: state.narrative.props,
          environments: state.narrative.environments,
          relationships: state.narrative.relationships,
          actions: state.narrative.actions,
          protagonistAccessories: state.narrative.protagonistAccessories,
          worldModel: state.narrative.worldModel,
          mode: state.narrative.mode,
          modeRationale: state.narrative.modeRationale,
          source: state.narrative.source,
        }, null, 2),
        '',
      ].join('\n')
    : '';
  const lines: string[] = [
    fullStory,
    userScriptBlock,
    state.storyboardImageUrls.length > 0 || state.storyboardImagePaths.length > 0
      ? [
        '[User storyboard image references]',
        'The user explicitly marked these image(s) as complete storyboard scripts, not character identity references.',
        'Parse them into shot order, visual actions, framing, camera movement, continuity notes, and durations before planning the final shots.',
        'Do NOT copy storyboard panel borders, labels, arrows, UI, captions, handwritten notes, or comic layout into the generated video.',
        'Use storyboard images as director intent only; identity reference images remain separate.',
        state.storyboardImageUrls.length > 0 ? `storyboardImageUrls: ${JSON.stringify(state.storyboardImageUrls)}` : '',
        state.storyboardImagePaths.length > 0 ? `storyboardImagePaths: ${JSON.stringify(state.storyboardImagePaths)}` : '',
      ].filter(Boolean).join('\n')
      : '',
    narrativeBlock,
    '[Artemis Saga long video workflow]',
    'Call generate_long_video exactly once for this request.',
    `projectId: ${JSON.stringify(projectId)}`,
    'title: create a concise human-searchable title (2-8 words). Prefer a user-provided film title; otherwise summarize the central image/action.',
    `totalDuration: ${targetDuration}`,
    `ratio: ${JSON.stringify(ratio)}`,
    'assemblyMode: "saga"',
    'chainReferenceFrames: "auto"',
    'colorMatch: true',
    'generateAudio: true',
    `subtitleMode: ${JSON.stringify(state.subtitleMode ?? 'auto')}`,
    preserveUserScript ? 'preserveUserScript: true' : '',
    aiScreenwriterSeed ? 'aiScreenwriterMode: true' : '',
    cleanDirect ? 'cleanDirect: true' : '',
  ];

  if (state.referenceImageUrls.length > 0) lines.push(`referenceImageUrls: ${JSON.stringify(state.referenceImageUrls)}`);
  if (state.storyboardImageUrls.length > 0) lines.push(`storyboardImageUrls: ${JSON.stringify(state.storyboardImageUrls)}`);
  if (state.referenceVideoUrls.length > 0) lines.push(`referenceVideoUrls: ${JSON.stringify(state.referenceVideoUrls)}`);
  if (state.referenceAudioUrls.length > 0) lines.push(`referenceAudioUrls: ${JSON.stringify(state.referenceAudioUrls)}`);
  if (state.referenceImagePaths.length > 0) lines.push(`referenceImagePaths: ${JSON.stringify(state.referenceImagePaths)}`);
  if (state.storyboardImagePaths.length > 0) lines.push(`storyboardImagePaths: ${JSON.stringify(state.storyboardImagePaths)}`);
  if (state.referenceVideoPaths.length > 0) lines.push(`referenceVideoPaths: ${JSON.stringify(state.referenceVideoPaths)}`);
  if (state.referenceAudioPaths.length > 0) lines.push(`referenceAudioPaths: ${JSON.stringify(state.referenceAudioPaths)}`);
  if (state.referenceNotes.length > 0) lines.push(`referenceNotes: ${JSON.stringify(state.referenceNotes)}`);

  lines.push(
    'Before calling the tool, act as the Saga producer with cinematic-director discipline:',
    '0. USER REFERENCE IMAGE RULE — If the user supplied an image and described it as a character/person/form/avatar/image/形象/角色/人物, treat that image as the GLOBAL CHARACTER IDENTITY reference, not merely as a first-frame scene. Extract the subject identity from the image and carry it through every shot. Do not replace the subject with unrelated real people.',
    '1. CHARACTER IDENTITY LOCK — Character/person consistency is a GLOBAL HARD RULE. If a person, character, mascot, user-provided new image, or recurring subject appears in this long video, lock their face, age, ethnicity/species, build, hair, distinguishing features, silhouette, and wardrobe/material cues across every shot unless the user explicitly asks for transformation or multiple different identities.',
    aiScreenwriterSeed ? '1a. AI SCREENWRITER MODE — The user explicitly asked Artemis/AI to create the story from partial inspiration. Expand sparse notes into a complete cinematic plot with clear beginning, development, climax/payoff, and shot-level visible action. Preserve concrete anchors; do not treat the seed as a finished script.' : '',
    '1b. INTENT-AWARE NARRATIVE EXPANSION — You MUST prioritize user-specified anchors (scene changes, wardrobe, specific events). If the user provided script segments, use them as hard visual anchors. If the user is silent about a duration, you are ENCOURAGED to "hallucinate" and expand the story logically, but do NOT execute unauthorized teleportation (scene jumps) unless it serves a thematic or specified purpose. Your "imagination" should fill the non-specified gaps (background activity, physics, secondary actions) while respecting the primary scene continuity established by the user.',
    '2. CONTINUITY MODE — Saga auto-selects strong-vision (image-ref capable) vs text-only based on the configured model. You do not configure this.',
    preserveUserScript
      ? '3. SHOTS — The user supplied an explicit script. Do NOT replace, rewrite, or substitute the plot. If you provide a shots array, each storyBeat must be a faithful slice of the user script in the same order; only add camera/motion detail around the original action.'
      : '3. SHOTS — Plan a structured shots array. Each shot: title, duration, storyBeat, visualPrompt, camera, continuity, transition, optional transitionKind.',
    '3a. MOTION REQUIREMENT (CRITICAL — videos look "AI-dead" without this) — storyBeat MUST be a TIMELINE of physical actions, not a static description. Use this format:',
    '    "0–Xs: [character] [action verb in present-tense] [body part / object]; [environmental motion]. Xs–Ys: [next action verb] [next change]. Ys–end: [resolving action]."',
    '    Action verbs (use these — not "stands", "is", "looks"): walks, steps, turns, lifts, reaches, drops, catches, leaps, kneels, scatters, spins, opens, closes, pushes, pulls, rises, descends, glides, twirls, summons, releases, shatters.',
    '    Always include continuous environmental motion: hair tossed by wind, fabric/cape flowing, particles drifting, rain streaks, fog rolling, light flickering, water rippling, dust motes, leaves falling, fireflies, mist rising, smoke curling.',
    '    Always describe at least ONE deliberate body movement per ~3 s of clip duration — never let a shot be a single static pose.',
    '    Prefer 4–6 s action-dense shots over long static shots when the duration allows; if a clip is longer than 6 s, split it into another physical action beat instead of holding one pose.',
    '    storyBeat may NOT be: identity-preservation rules, generic continuity language, or "the character stands/sits/looks" with no movement. Saga rejects boilerplate storyBeats and falls back to story chunks.',
    '4. CINEMATIC VOCABULARY — Use industry terms (35mm/50mm lens, golden hour, volumetric beams, ray-traced reflections, IMAX 70mm grain, Arri Alexa LogC). For camera, prefer ACTIVE camera language: tracking shot, dolly-in, dolly-out, crane down, gimbal arc, whip pan, snorricam, handheld follow, parallax push. Avoid "locked-off" / "static" / "establishing only" unless the scene is genuinely meant to be still.',
    '5. HEAD/TAIL VISUAL ECHO — Write each shot N\'s `transition` as a concrete description of its closing frame (in mid-action, not a freeze); open shot N+1\'s `visualPrompt` with a matching opening-frame description that visually rhymes. The body momentum, gaze/covered-face direction, hair/fabric flow, and camera direction should continue across the cut so the transition feels alive rather than mechanical.',
    '6. SMART TRANSITIONS — Do NOT default to "crossfade" (fade-to-black) for every shot. Act as a professional editor to select `transitionKind` for each shot N (into shot N+1):',
    '   - HARD CUT (kind="cut"): Default choice. Use when Shot N and N+1 share the same location/lighting/outfit, or during high-energy action. Hard cuts preserve the temporal "flow".',
    '   - MATCH CUT (kind="match-cut"): Use when the closing frame of N and opening frame of N+1 share a similar shape, color, or directional motion (e.g. spinning, reaching out, a panning camera).',
    '   - ATMOSPHERIC BRIDGE (kind="shader-light-leak" or "dissolve"): Use for soft shifts in time, mood, or subtle location changes.',
    '   - KINETIC PUSH (kind="shader-whip-pan" or "zoom-in"): Use to follow the direction of subject motion or to create a "jump" in energy.',
    '   - ACT BREAK (kind="fade-black" or "cinematic-fade"): Use ONLY for the very last shot of the film or when there is a massive jump in location/time.',
    '   - STYLIZED (kind="shader-glitch", "shader-ridged-burn", "shader-domain-warp"): Use for dream sequences, digital glitch themes, or magical transitions.',
    '   [Full Transition Catalog: cut, crossfade, dissolve, light-leak, fade-black, fade-white, wipe-left, wipe-right, slide-up, push-left, push-right, circle-open, circle-close, blur, zoom-in, zoom-out, flash, speed-ramp, whip-pan, whip-pan-left, match-cut, glitch, cinematic-fade, iris-pulse, shader-light-leak, shader-whip-pan, shader-glitch, shader-cinematic-zoom, shader-domain-warp, shader-ridged-burn, shader-sdf-iris, shader-ripple-waves, shader-gravitational-lens, shader-chromatic-split, shader-swirl-vortex, shader-thermal-distortion, shader-flash-through-white, shader-cross-warp-morph]',
    '7. SCENE-PRIORITY — storyBeat dominates the full clip duration; transition field describes only the closing 0.5 s.',
    '8. PHYSICS & FAILURE GUARDS — Saga\'s aesthetic-lock auto-appends physics anchors (no morphing/flickering/melting, anatomically correct).',
    '9. SCENE-JUMP HANDLING — When the story has a hard location jump, insert at least one transition shot that bridges the two locations through a shared visual element.',
    '10. DURATIONS — Shot durations must add up to the requested totalDuration; each shot must stay within the detected provider segment limit.',
    `11. SUBTITLE MODE — User selected ${state.subtitleMode ?? 'auto'}: ${state.subtitleMode === 'always' ? 'render readable subtitles/captions for dialogue and voiceover, preserving original text/language.' : state.subtitleMode === 'off' ? 'do not render dialogue as on-screen subtitles; keep dialogue as audio/lip-sync unless the user explicitly authored a subtitle line.' : 'only add subtitles/on-screen text when the user explicitly requested them.'}`,
  );

  if (state.scope === 'bridge' && state.deliveryPlatform) {
    const sendArgs = [
      state.deliveryPlatform ? `platform: ${JSON.stringify(state.deliveryPlatform)}` : undefined,
      state.deliveryTargetId ? `targetId: ${JSON.stringify(state.deliveryTargetId)}` : undefined,
      'caption: "Saga long video is ready"',
    ].filter(Boolean).join(', ');
    lines.push(`After generate_long_video succeeds, immediately call bridge_send_video using the exact final video path from the tool output, with { ${sendArgs} }.`);
  }

  // Fix B — CRITICAL imperative tail. This block sits at the very end of
  // the prompt so context-compression worker models that summarize from the
  // tail preserve it. The tool name is repeated multiple times, the wrong
  // tool is named explicitly as forbidden, and the consequence of choosing
  // the wrong tool is spelled out — so the main model has no plausible
  // reason to fall back to generate_video.
  lines.push(
    '',
    '═══════════════════════════════════════════════════════════════',
    'CRITICAL — TOOL SELECTION (MUST FOLLOW):',
    '═══════════════════════════════════════════════════════════════',
    'You MUST call the tool named: generate_long_video',
    'You MUST NOT call: generate_video',
    'generate_long_video is exposed in your tool list. Verify by reading the tool list before generating; if you do not see it, that is a context-compression artifact, not a real absence — call generate_long_video anyway and the runtime will resolve it.',
    'If you call generate_video instead of generate_long_video, the result will be a single short clip (capped at 15s by the configured provider) that ignores Saga\'s continuity engine, transitions, and audio normalization, and the user will see a broken output. This is a hard failure mode.',
    'Saga\'s long-video pipeline is the only correct path for this request. generate_long_video. Not generate_video. generate_long_video.',
    '═══════════════════════════════════════════════════════════════',
  );

  return lines.join('\n');
}

function buildGenerationAction(state: SagaWorkflowState): Extract<AgentAction, { type: 'generate_long_video' }> {
  const prompt = buildGenerationPrompt(state);
  const fullStory = sanitizeForVideoProvider(combinedStoryText(state));
  const sanitizedAccumulated = state.accumulatedStory.map((s) => sanitizeForVideoProvider(s));
  const preserveUserScript = hasExplicitUserScriptText(sanitizedAccumulated);
  // cleanDirect is opt-in via explicit keywords (raw-seedance / 原始质感 / etc.).
  // It used to be auto-forced whenever preserveUserScript was true, but those
  // two concerns are independent: preserveUserScript means "don't rewrite my
  // text", whereas cleanDirect means "strip ALL directorial scaffolding"
  // (Super Visual keyframes, chain frames, STYLE-LOCK, AESTHETIC-LOCK,
  // NEGATIVE, EXPLICIT USER BRIEF LOCK, etc.). Coupling them silently broke
  // detailed timecoded briefs by removing every quality lock.
  const cleanDirect = wantsCleanDirectMode([state.originalText, ...sanitizedAccumulated]);
  const targetDuration = clampDuration(state.targetDuration ?? state.prefilledDuration) ?? estimateDuration(fullStory);
  const ratio = state.ratio ?? state.suggestedRatio ?? extractRatio(fullStory) ?? '16:9';
  const projectIdMatch = prompt.match(/^projectId:\s*"([^"]+)"/m);
  const projectId = projectIdMatch?.[1] ?? `saga-${Date.now()}`;

  // Side-channel: write the FULL story to a known file before returning.
  // The agent layer (LLM tool-call serialization) sometimes truncates a long
  // story argument when it summarizes its own action. generate_long_video
  // checks this file first and uses its content as the authoritative story,
  // so a multi-KB user script always round-trips intact.
  try {
    const dir = path.join(resolveArtemisHomeDir(), 'saga-pending');
    mkdirSync(dir, { recursive: true });
    const sourcePath = path.join(dir, `${projectId}-source-story.txt`);
    writeFileSync(sourcePath, fullStory, 'utf8');
  } catch {
    // Best-effort; if the write fails the agent flow still has the (possibly
    // truncated) story field and continues.
  }

  // If user picked 'turnaround', merge the turnaround images into the
  // reference set and preserve identitySource='turnaround'. generateLongVideo
  // uses that explicit flag to pass the supplied three-view sheet directly to
  // the video model, without relying on filename/vision heuristics and without
  // regenerating a new turnaround via the image model. For 'direct_image' /
  // 'character_image' the images are already in referenceImage* and
  // identitySource tells downstream how to route them.
  const mergedRefImagePaths = state.identitySource === 'turnaround'
    ? unique([...state.referenceImagePaths, ...state.turnaroundImagePaths])
    : [...state.referenceImagePaths]
  const mergedRefImageUrls = state.identitySource === 'turnaround'
    ? unique([...state.referenceImageUrls, ...state.turnaroundImageUrls])
    : [...state.referenceImageUrls]

  return {
    type: 'generate_long_video',
    prompt,
    story: fullStory,
    projectId,
    totalDuration: targetDuration,
    ratio,
    assemblyMode: 'saga',
    chainReferenceFrames: 'auto',
    colorMatch: true,
    generateAudio: true,
    subtitleMode: state.subtitleMode ?? 'auto',
    preserveUserScript,
    cleanDirect,
    referenceImageUrls: mergedRefImageUrls,
    storyboardImageUrls: [...state.storyboardImageUrls],
    referenceVideoUrls: [...state.referenceVideoUrls],
    referenceAudioUrls: [...state.referenceAudioUrls],
    referenceImagePaths: mergedRefImagePaths,
    storyboardImagePaths: [...state.storyboardImagePaths],
    referenceVideoPaths: [...state.referenceVideoPaths],
    referenceAudioPaths: [...state.referenceAudioPaths],
    soundtrackPath: state.soundtrackPath,
    soundtrackUrl: state.soundtrackUrl,
    soundtrackStartSec: state.soundtrackStartSec,
    soundtrackVolumeDb: state.soundtrackVolumeDb,
    environmentVolumeDb: state.environmentVolumeDb,
    soundtrackFadeInSec: state.soundtrackFadeInSec,
    soundtrackFadeOutSec: state.soundtrackFadeOutSec,
    referenceNotes: [...state.referenceNotes],
    ...(state.identitySource ? { identitySource: state.identitySource } : {}),
    ...(state.narrative ? { narrativeEntities: state.narrative } : {}),
  };
}


// ─── Main entry ──────────────────────────────────────────────────────────

async function isMultimodalCapable(cwd: string): Promise<boolean> {
  const configured = await resolveConfiguredVisualProvider(cwd, 'video');
  if (!configured) return false;
  const caps = resolveVideoModelCapabilities(configured.config.video.provider, configured.model);
  return caps.referenceInputs.some((kind) => kind === 'image' || kind === 'video' || kind === 'audio');
}

function newState(input: SagaWorkflowInput, multimodalCapable: boolean): SagaWorkflowState {
  return {
    scope: input.scope,
    cwd: input.cwd,
    originalText: input.text.trim(),
    stage: 'awaiting_subject_mode',
    multimodalCapable,
    referenceImageUrls: [],
    storyboardImageUrls: [],
    referenceVideoUrls: [],
    referenceAudioUrls: [],
    referenceImagePaths: [],
    storyboardImagePaths: [],
    referenceVideoPaths: [],
    referenceAudioPaths: [],
    referenceNotes: [],
    turnaroundImagePaths: [],
    turnaroundImageUrls: [],
    locale: resolveSagaWorkflowLocaleForTest(input.locale),
    accumulatedStory: [],
    prefilledDuration: clampDuration(extractTargetDuration(input.text)),
    deliveryPlatform: input.deliveryPlatform,
    deliveryTargetId: input.deliveryTargetId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function handleSagaLongVideoWorkflow(input: SagaWorkflowInput): Promise<SagaWorkflowOutcome> {
  pruneExpiredWorkflows();
  const key = normalizeKey(input);
  const text = input.text.trim();
  const state = WORKFLOWS.get(key);

  // ─── continuing an active workflow ──────────────────────────────────
  if (state) {
    if (input.locale) state.locale = input.locale;

    if (CANCEL_RE.test(text)) {
      WORKFLOWS.delete(key);
      return { handled: true, reply: pickLocale(state.locale, { zh: '已停止本次生成流程。', en: 'This generation has been stopped.' }) };
    }

    // Do not let the generic "workflow support discussion" classifier steal
    // control while Saga is actively collecting user material. Real scripts can
    // contain words like "视频 / 生成 / 系统 / 代码" and dialogue questions like
    // "想跟我一起玩吗？"; classifying those before the stage handler deletes the
    // workflow and drops the pasted script into the normal brain path.
    const collectingUserMaterial =
      state.stage === 'collecting_refs' ||
      state.stage === 'awaiting_storyboard_image' ||
      state.stage === 'awaiting_turnaround_upload' ||
      state.stage === 'awaiting_character_image_upload';
    if (!collectingUserMaterial && isSagaWorkflowSupportDiscussion(text)) {
      WORKFLOWS.delete(key);
      return { handled: false };
    }

    if (state.stage === 'collecting_refs') {
      const refs = await classifyReferences(state.cwd, text, input.imageAttachments);

      // Explicit menu command only. Handle before remembering notes/story so
      // the control phrase never becomes part of the final generation prompt.
      if (STORY_ENHANCE_RE.test(text)) {
        state.aiScreenwriterMode = true;
        state.updatedAt = Date.now();
        return { handled: true, reply: pickLocale(state.locale, {
          zh: '已开启「剧情增强」。我会把已锁定身份、素材、参考说明当作创作锚点，自动补完整剧情。你还可以继续补充一句风格/场景；如果不补，直接回复 "开始生成"。',
          en: 'Story Enhance enabled. I will use the locked identity, materials, and reference notes as creative anchors and expand them into a complete story. Add one more style/scene note if you want, or reply "start" now.',
        }) };
      }

      const rememberedImageNote = maybeRememberImageReferenceNotes(state, refs, text);
      mergeRefs(state, refs);
      if (!rememberedImageNote) maybeRememberReferenceNote(state, text);
      maybeAccumulateStory(state, text);

      if (STORYBOARD_RE.test(text)) {
        state.stage = 'awaiting_storyboard_image';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildStoryboardAskMessage(state) };
      }

      if (ABSTRACT_RE.test(text)) {
        state.narrative = {
          protagonist: { name: 'Pure Abstract Environment', type: 'environment', confidence: 1.0, evidence: 'User explicitly requested no characters.' },
          supportingCharacters: [],
          props: [],
          environments: ['Abstract Visual Environment'],
          relationships: [],
          actions: [],
          worldModel: {},
          protagonistAccessories: [],
          mode: 'environment',
          modeRationale: 'User explicitly requested "abstract/no lead" mode via chat command.',
          source: 'user-clarification',
        };
        state.stage = 'awaiting_duration';
        state.updatedAt = Date.now();
        return { handled: true, reply: await buildDurationAskMessage(state) };
      }

      if (START_RE.test(text)) {
        // User done collecting → run narrative analysis. The identity-source
        // three-step menu fired earlier (between duration and collecting), so
        // by this point we already know how identity enters the pipeline.
        if (!state.narrative) {
          state.narrative = await runNarrativeAnalysis(state);
          emitNarrativeStatus(state.narrative);
        }
        if (shouldAskProtagonistClarification(state.narrative)) {
          state.protagonistOptions = buildProtagonistOptions(state, state.narrative);
          state.stage = 'awaiting_protagonist_clarification';
          state.updatedAt = Date.now();
          return { handled: true, reply: buildProtagonistAskMessage(state) };
        }
        state.suggestedRatio = extractRatio(combinedStoryText(state)) ?? '16:9';
        state.stage = 'awaiting_ratio';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildRatioAskMessage(state) };
      }

      // Acknowledge the refs and continue collecting
      state.updatedAt = Date.now();
      return { handled: true, reply: buildRefAckMessage(state) };
    }

    // ── Subject-mode menu: has-protagonist vs pure-visual ──────────────────
    // Fires after the duration is set, BEFORE materials collection. This is
    // the user-suggested redesign: ask up-front whether there's a protagonist
    // so subsequent identity-source upload steps make sense to the user.
    if (state.stage === 'awaiting_subject_mode') {
      if (ABSTRACT_RE.test(text) || PURE_VISUAL_RE.test(text)) {
        markAbstractPreference(state);
        state.stage = 'collecting_refs';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildRefIntroMessage(state) };
      }
      if (HAS_PROTAGONIST_RE.test(text)) {
        // If model can't take image input at all, identity menu collapses to
        // just text-only — auto-pick it and move to collecting_refs.
        if (!state.multimodalCapable) {
          state.identitySource = 'text_only';
          state.stage = 'collecting_refs';
          state.updatedAt = Date.now();
          return { handled: true, reply: buildRefIntroMessage(state) };
        }
        state.stage = 'awaiting_identity_source';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildIdentitySourceAskMessage(state) };
      }
      state.updatedAt = Date.now();
      return { handled: true, reply: buildSubjectModeAskMessage(state) };
    }

    // ── Three-step identity-source menu ────────────────────────────────────
    if (state.stage === 'awaiting_identity_source') {
      if (HAS_TURNAROUND_RE.test(text)) {
        state.identitySource = 'turnaround';
        state.stage = 'awaiting_turnaround_upload';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildTurnaroundUploadMessage(state) };
      }
      if (HAS_CHARACTER_IMAGE_RE.test(text)) {
        state.identitySource = 'character_image';
        state.stage = 'awaiting_character_image_upload';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildCharacterImageUploadMessage(state) };
      }
      if (DIRECT_IMAGE_RE.test(text)) {
        state.identitySource = 'direct_image';
        state.stage = 'awaiting_character_image_upload';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildDirectImageUploadMessage(state) };
      }
      if (TEXT_ONLY_IDENTITY_RE.test(text)) {
        state.identitySource = 'text_only';
        // Drop any images user might have sent before — they explicitly chose text-only.
        state.referenceImagePaths = [];
        state.referenceImageUrls = [];
        state.stage = 'collecting_refs';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildRefIntroMessage(state) };
      }
      // Unrecognized — re-ask
      state.updatedAt = Date.now();
      return { handled: true, reply: buildIdentitySourceAskMessage(state) };
    }

    if (state.stage === 'awaiting_turnaround_upload') {
      // Parse any new path/URL/image-attachment from this turn into the
      // standard reference buckets. Without this, a user typing the path
      // "/path/x.jpg" on its own line never gets registered as an image
      // and the "完成"/"开始生成" branch keeps re-prompting.
      const refs = await classifyReferences(state.cwd, text, input.imageAttachments);
      mergeRefs(state, refs);
      // Move newly-merged reference images into the turnaround bucket so
      // they're tagged correctly for downstream (`identitySource: 'turnaround'`
      // tells generateLongVideo to skip superVisual generation).
      if (state.referenceImagePaths.length > 0 || state.referenceImageUrls.length > 0) {
        state.turnaroundImagePaths.push(...state.referenceImagePaths);
        state.turnaroundImageUrls.push(...state.referenceImageUrls);
        state.referenceImagePaths = [];
        state.referenceImageUrls = [];
      }
      const hasTurnaround = state.turnaroundImagePaths.length > 0 || state.turnaroundImageUrls.length > 0;
      if (START_RE.test(text) || DONE_RE.test(text)) {
        if (!hasTurnaround) {
          state.updatedAt = Date.now();
          return { handled: true, reply: buildTurnaroundUploadMessage(state) };
        }
        state.stage = 'collecting_refs';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildRefIntroMessage(state) };
      }
      state.updatedAt = Date.now();
      return { handled: true, reply: hasTurnaround
        ? pickLocale(state.locale, {
            zh: `已收到 ${state.turnaroundImagePaths.length + state.turnaroundImageUrls.length} 张三视图。继续追加或回复 "完成" 进入下一步。`,
            en: `Got ${state.turnaroundImagePaths.length + state.turnaroundImageUrls.length} turnaround image(s). Keep adding, or reply "done" to continue.`,
          })
        : buildTurnaroundUploadMessage(state) };
    }

    if (state.stage === 'awaiting_character_image_upload') {
      // Same parse-into-references contract as the turnaround branch above —
      // bug fix: missing classifyReferences call made "完成"/"开始生成" loop
      // forever because no image ever landed in state.referenceImage*.
      const refs = await classifyReferences(state.cwd, text, input.imageAttachments);
      const pairedDirectImageCaption = state.identitySource === 'direct_image'
        ? maybeRememberImageReferenceNotes(state, refs, text)
        : false;
      mergeRefs(state, refs);
      if (START_RE.test(text) || DONE_RE.test(text)) {
        if (!hasCollectedAnyImage(state)) {
          const reply = state.identitySource === 'direct_image'
            ? buildDirectImageUploadMessage(state)
            : buildCharacterImageUploadMessage(state)
          state.updatedAt = Date.now();
          return { handled: true, reply };
        }
        state.stage = 'collecting_refs';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildRefIntroMessage(state) };
      }
      state.updatedAt = Date.now();
      if (hasCollectedAnyImage(state)) {
        if (state.identitySource === 'direct_image') {
          return { handled: true, reply: buildDirectImageAckMessage(state, pairedDirectImageCaption) };
        }
        return { handled: true, reply: pickLocale(state.locale, {
          zh: `已收到 ${state.referenceImagePaths.length + state.referenceImageUrls.length} 张图。继续追加或回复 "完成" 进入下一步。`,
          en: `Got ${state.referenceImagePaths.length + state.referenceImageUrls.length} image(s). Keep adding, or reply "done" to continue.`,
        }) };
      }
      const reply = state.identitySource === 'direct_image'
        ? buildDirectImageUploadMessage(state)
        : buildCharacterImageUploadMessage(state)
      return { handled: true, reply };
    }

    if (state.stage === 'awaiting_storyboard_image') {
      const refs = await classifyReferences(state.cwd, text, input.imageAttachments);
      mergeStoryboardRefs(state, refs);
      maybeRememberReferenceNote(state, text);
      const storyboardCount = state.storyboardImageUrls.length + state.storyboardImagePaths.length;
      if (storyboardCount === 0) {
        state.updatedAt = Date.now();
        return { handled: true, reply: buildStoryboardAskMessage(state) };
      }
      state.stage = 'collecting_refs';
      state.updatedAt = Date.now();
      return { handled: true, reply: buildRefAckMessage(state) };
    }

    if (state.stage === 'awaiting_protagonist_clarification') {
      const applied = applyProtagonistChoice(state, text);
      if (!applied) {
        state.updatedAt = Date.now();
        return { handled: true, reply: buildProtagonistAskMessage(state) };
      }
      state.suggestedRatio = extractRatio(combinedStoryText(state)) ?? '16:9';
      state.stage = 'awaiting_ratio';
      state.updatedAt = Date.now();
      return { handled: true, reply: buildRatioAskMessage(state) };
    }

    if (state.stage === 'awaiting_ratio') {
      state.suggestedRatio = state.suggestedRatio ?? extractRatio(combinedStoryText(state)) ?? '16:9';
      if (!applyRatioReplyToState(state, text)) {
        state.updatedAt = Date.now();
        return { handled: true, reply: buildRatioAskMessage(state) };
      }
      state.stage = 'awaiting_subtitle_mode';
      state.updatedAt = Date.now();
      return { handled: true, reply: buildSubtitleModeAskMessage(state) };
    }

    if (state.stage === 'awaiting_subtitle_mode') {
      if (SUBTITLE_ALWAYS_RE.test(text)) state.subtitleMode = 'always';
      else if (SUBTITLE_OFF_RE.test(text)) state.subtitleMode = 'off';
      else if (SUBTITLE_AUTO_RE.test(text) || CONFIRM_DEFAULT_RE.test(text)) state.subtitleMode = 'auto';
      else {
        state.updatedAt = Date.now();
        return { handled: true, reply: buildSubtitleModeAskMessage(state) };
      }
      state.stage = 'awaiting_duration';
      state.updatedAt = Date.now();
      return { handled: true, reply: await buildDurationAskMessage(state) };
    }

    if (state.stage === 'awaiting_duration') {
      const duration = clampDuration(extractTargetDuration(text));
      if (!duration && !CONFIRM_DEFAULT_RE.test(text)) {
        state.updatedAt = Date.now();
        return { handled: true, reply: await buildDurationAskMessage(state) };
      }
      state.targetDuration = duration ?? state.prefilledDuration ?? estimateDuration(combinedStoryText(state));
      state.stage = 'awaiting_bgm';
      state.updatedAt = Date.now();
      return { handled: true, reply: buildBgmAskMessage(state) };
    }


    if (state.stage === 'awaiting_bgm') {
      if (BGM_ADD_RE.test(text)) {
        state.stage = 'awaiting_bgm_asset';
        state.updatedAt = Date.now();
        return { handled: true, reply: pickLocale(state.locale, { zh: BGM_ASSET_PROMPT_ZH, en: BGM_ASSET_PROMPT_EN }) };
      }
      const applied = await applyBgmReplyToState(state, text);
      if (!applied.ok) {
        state.updatedAt = Date.now();
        return { handled: true, reply: applied.reply ?? buildBgmAskMessage(state) };
      }
      WORKFLOWS.delete(key);
      const action = buildGenerationAction(state);
      return { handled: false, prompt: action.prompt, action };
    }

    if (state.stage === 'awaiting_bgm_asset') {
      const applied = await applyBgmReplyToState(state, text);
      if (!applied.ok) {
        state.updatedAt = Date.now();
        return { handled: true, reply: applied.reply ?? pickLocale(state.locale, { zh: BGM_ASSET_PROMPT_ZH, en: BGM_ASSET_PROMPT_EN }) };
      }
      WORKFLOWS.delete(key);
      const action = buildGenerationAction(state);
      return { handled: false, prompt: action.prompt, action };
    }
  }

  // ─── fresh request ──────────────────────────────────────────────────
  // Saga must never start from ordinary chat keywords ("图片", "视频",
  // "长视频", "long video", etc.). Fresh Saga entry is command-gated by the
  // caller: only an explicit /saga command sets forceIntent=true. Once a Saga
  // workflow is active, follow-up replies above can continue the wizard.
  if (!input.forceIntent || isSagaWorkflowSupportDiscussion(text)) {
    return { handled: false };
  }
  const configured = await resolveConfiguredVisualProvider(input.cwd, 'video');
  if (!configured) return { handled: false };

  const multimodalCapable = await isMultimodalCapable(input.cwd);
  const next = newState(input, multimodalCapable);

  // Even on the first turn, if the user already attached references in this
  // very message (Telegram image / inline URL), we want to capture them.
  if (multimodalCapable) {
    const refs = await classifyReferences(next.cwd, text, input.imageAttachments);
    mergeRefs(next, refs);
  }

  next.stage = 'awaiting_subject_mode';
  WORKFLOWS.set(key, next);
  return { handled: true, reply: buildSubjectModeAskMessage(next) };
}
