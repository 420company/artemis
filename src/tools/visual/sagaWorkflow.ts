import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveConfiguredVisualProvider } from '../../utils/visualGenerationConfig.js';
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

type SagaWorkflowStage = 'awaiting_initial_duration' | 'collecting_refs' | 'awaiting_storyboard_image' | 'awaiting_protagonist_clarification' | 'awaiting_duration';

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
const STORYBOARD_RE = /^(?:分镜图|分镜图片|图片分镜|上传分镜|发送分镜|storyboard|storyboard image|shot board)$/i;

function normalizeKey(input: SagaWorkflowInput): string {
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

function hasExplicitLongVideoPhrase(text: string): boolean {
  const normalized = compact(text);
  if (!normalized) return false;
  return /(?:长视频|长片|完整视频|完整短片|完整影片|一整条视频|视频解决方案|生产链|剪辑链|剪成|剪辑成片)/i.test(normalized)
    || /\b(?:long[-\s]?form|long|full|complete)\b[\s\S]{0,80}\b(?:video|movie|clip)\b/i.test(normalized);
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

function extractRatio(text: string): string | undefined {
  if (/(?:竖屏|手机|抖音|tiktok|reels|shorts|9:16|portrait)/i.test(text)) return '9:16';
  if (/(?:方形|1:1|square)/i.test(text)) return '1:1';
  if (/(?:横屏|电影|youtube|16:9|landscape)/i.test(text)) return '16:9';
  return undefined;
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
  const pattern = /(?:file:\/\/|~\/|\.\.?\/|\/|[A-Za-z0-9_.-]+\/)[^\n"'`，。；、)）]+?\.(?:png|jpe?g|webp|gif|bmp|svg|heic|heif|mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg)/gi;
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

async function saveImageAttachmentsToLocalPaths(cwd: string, imageAttachments?: ImageAttachment[]): Promise<string[]> {
  const out: string[] = [];
  const dir = path.join(cwd, 'generated-media', 'saga-refs');
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

function maybeAccumulateStory(state: SagaWorkflowState, text: string): boolean {
  const compacted = compact(text);
  if (!compacted) return false;
  if (START_RE.test(compacted) || CANCEL_RE.test(compacted) || CONFIRM_DEFAULT_RE.test(compacted)) return false;
  const narrative = stripRefTokens(text);
  // Threshold: ~30 chars of non-ref text. This catches a script paragraph but
  // skips short captions like "这是主角" which still go to referenceNotes.
  if (narrative.length < 30) return false;
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

async function buildRefAskMessage(state: SagaWorkflowState): Promise<string> {
  const modelLine = await buildModelLine(state.cwd, state.locale);
  const durationLine = state.targetDuration
    ? pickLocale(state.locale, {
      zh: `目标总时长：${state.targetDuration} 秒。`,
      en: `Target total duration: ${state.targetDuration}s.`,
    })
    : '';
  return pickLocale(state.locale, {
    zh: [
      '好，要做一段长视频。总时长已确定，接下来把参考材料备齐。',
      durationLine,
      modelLine,
      '这个模型支持图、视频、音、文字的混合参考，可以继续发：',
      '  · 图 / 视频 / 音 的链接或本地路径，作为视觉与听觉参考',
      '  · 你的剧本 / 分镜 / 设定 / 故事 — 写了我会照你的来；没写就由我来安排。',
      '  · 如果你有一张“多镜头分镜图”，先回复“分镜图”，我会把下一张图片当作分镜剧本来解析。',
      '💡 进阶提示：如果您要生成纯风景或纯视觉素材，请在后续回复『无主角』或『纯视觉』。',
      '准备好了回复 "开始生成"；想直接开始就回复 "跳过"；不做了回复 "取消"。',
    ].filter(Boolean).join('\n'),
    en: [
      'Good — a long-form piece. The total duration is set; now let\'s gather references.',
      durationLine,
      modelLine,
      'This model accepts mixed references — image, video, audio, text. You can keep sending:',
      '  · Image / video / audio URLs or local paths, as visual and auditory references',
      '  · Your own script / shot list / setting / story — if you write one, I\'ll follow it; if not, I\'ll compose it.',
      '  · If you have a multi-shot storyboard image, reply "storyboard" first; I will treat the next image as the storyboard script.',
      '💡 Pro tip: For pure landscapes or abstract visual material, reply "no lead" or "abstract" to bypass character logic.',
      'When you\'re ready, reply "start". To skip extras and begin, reply "skip". To stop, reply "cancel".',
    ].filter(Boolean).join('\n'),
  });
}

async function buildInitialDurationAskMessage(state: SagaWorkflowState): Promise<string> {
  const modelLine = await buildModelLine(state.cwd, state.locale);
  const estimated = estimateDuration(combinedStoryText(state));
  return pickLocale(state.locale, {
    zh: [
      '好，要做一段长视频。先确认最终成片的总时长。',
      modelLine,
      `请回复目标总时长，例如：20秒、30秒、60秒、2分钟；回复“自动/默认”则使用建议 ${estimated} 秒。`,
      '确认总时长后，我会继续收集图片 / 视频 / 音频 / 文字参考。',
      '不做了回复“取消”。',
    ].join('\n'),
    en: [
      'Good — a long-form piece. First, confirm the final stitched video duration.',
      modelLine,
      `Reply with the target total duration, e.g. 20s, 30s, 60s, 2 minutes; reply "auto/default" to use the suggested ${estimated}s.`,
      'After duration is confirmed, I will collect image / video / audio / text references.',
      'Reply "cancel" to stop.',
    ].join('\n'),
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
    lines.push('💡 如果是纯风景或纯视觉素材，请回复 "无主角" 或 "纯视觉"。');
    lines.push('可以继续补充，或回复 "开始生成" 进入下一步。');
    return lines.join('\n');
  }
  const counts = `${imgs} images · ${storyboardImgs} storyboard images · ${vids} videos · ${auds} audio · ${storyCount} script segments`;
  const lines = [`Received: ${counts}`];
  if (storyCount > 0) lines.push('Script archived — generation will follow your version exactly.');
  if (storyboardImgs > 0) lines.push('Storyboard image archived — it will be parsed into shot segments before generation.');
  lines.push('If your next image is a complete storyboard script, reply "storyboard" first.');
  lines.push('💡 Reply "abstract" or "no lead" if this is a pure landscape or visual piece.');
  lines.push('Send more if you like, or reply "start" to proceed.');
  return lines.join('\n');
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
  const imgs = state.referenceImageUrls.length + state.referenceImagePaths.length;
  const vids = state.referenceVideoUrls.length + state.referenceVideoPaths.length;
  const auds = state.referenceAudioUrls.length + state.referenceAudioPaths.length;
  const storyCount = state.accumulatedStory.length;
  if (state.locale === 'zh-CN') {
    const refLine = refsCount > 0 ? `参考材料：图 ${imgs} / 视频 ${vids} / 音频 ${auds}。` : '本次没有参考素材，将完全依据文字描述生成。';
    const storyLine = storyCount > 0 ? `剧本共 ${storyCount} 段，会严格按你写的来。` : '剧本由我来安排。';
    return [
      '已经准备好开始生成，最后确认一下时长。',
      modelLine,
      refLine,
      storyLine,
      `请告诉我视频总长度 — "60秒"、"90秒"、"2分钟" 之类都行；想让我自己决定就回复 "自动"（建议 ${estimated} 秒）。`,
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
    `How long should the video be? Tell me a duration — "60s", "90s", "2 minutes" — or reply "auto" and I'll choose (suggesting ${estimated}s).`,
    'To stop, reply "cancel".',
  ].join('\n');
}

// ─── Final saga generation prompt ────────────────────────────────────────

function buildGenerationPrompt(state: SagaWorkflowState): string {
  // Sanitize user input on the way through — provider-side trigger words
  // (like "真人") get mapped to safe equivalents that preserve meaning.
  const fullStory = sanitizeForVideoProvider(combinedStoryText(state));
  const targetDuration = clampDuration(state.targetDuration ?? state.prefilledDuration) ?? estimateDuration(fullStory);
  const ratio = extractRatio(fullStory) ?? '16:9';
  const projectId = `saga-${Date.now()}`;
  const sanitizedAccumulated = state.accumulatedStory.map((s) => sanitizeForVideoProvider(s));
  const userScriptBlock = sanitizedAccumulated.length > 0
    ? [
        '',
        '[USER-SUPPLIED SCRIPT — AUTHORITATIVE]',
        'The user provided the following story text. Use it AS-IS as the controlling narrative; do not invent or substitute a different story. Distribute it across shots so the storyBeats follow this script faithfully:',
        ...sanitizedAccumulated.map((segment, idx) => `--- Story segment ${idx + 1} ---\n${segment}`),
        '',
      ].join('\n')
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
    '1b. INTENT-AWARE NARRATIVE EXPANSION — You MUST prioritize user-specified anchors (scene changes, wardrobe, specific events). If the user provided script segments, use them as hard visual anchors. If the user is silent about a duration, you are ENCOURAGED to "hallucinate" and expand the story logically, but do NOT execute unauthorized teleportation (scene jumps) unless it serves a thematic or specified purpose. Your "imagination" should fill the non-specified gaps (background activity, physics, secondary actions) while respecting the primary scene continuity established by the user.',
    '2. CONTINUITY MODE — Saga auto-selects strong-vision (image-ref capable) vs text-only based on the configured model. You do not configure this.',
    '3. SHOTS — Plan a structured shots array. Each shot: title, duration, storyBeat, visualPrompt, camera, continuity, transition, optional transitionKind.',
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
  const targetDuration = clampDuration(state.targetDuration ?? state.prefilledDuration) ?? estimateDuration(fullStory);
  const ratio = extractRatio(fullStory) ?? '16:9';
  const projectIdMatch = prompt.match(/^projectId:\s*"([^"]+)"/m);
  return {
    type: 'generate_long_video',
    prompt,
    story: fullStory,
    projectId: projectIdMatch?.[1] ?? `saga-${Date.now()}`,
    totalDuration: targetDuration,
    ratio,
    assemblyMode: 'saga',
    chainReferenceFrames: 'auto',
    colorMatch: true,
    generateAudio: true,
    referenceImageUrls: [...state.referenceImageUrls],
    storyboardImageUrls: [...state.storyboardImageUrls],
    referenceVideoUrls: [...state.referenceVideoUrls],
    referenceAudioUrls: [...state.referenceAudioUrls],
    referenceImagePaths: [...state.referenceImagePaths],
    storyboardImagePaths: [...state.storyboardImagePaths],
    referenceVideoPaths: [...state.referenceVideoPaths],
    referenceAudioPaths: [...state.referenceAudioPaths],
    referenceNotes: [...state.referenceNotes],
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
    stage: 'awaiting_initial_duration',
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

    if (isSagaWorkflowSupportDiscussion(text)) {
      WORKFLOWS.delete(key);
      return { handled: false };
    }

    // Always try to merge any new refs in this turn (URLs, files, attachments).
    if (state.stage === 'awaiting_initial_duration') {
      const refs = await classifyReferences(state.cwd, text, input.imageAttachments);
      mergeRefs(state, refs);
      maybeRememberReferenceNote(state, text);
      maybeAccumulateStory(state, text);

      const duration = clampDuration(extractTargetDuration(text));
      if (!duration && !CONFIRM_DEFAULT_RE.test(text)) {
        state.updatedAt = Date.now();
        return { handled: true, reply: await buildInitialDurationAskMessage(state) };
      }
      state.targetDuration = duration ?? estimateDuration(combinedStoryText(state));
      if (state.multimodalCapable) {
        state.stage = 'collecting_refs';
        state.updatedAt = Date.now();
        return { handled: true, reply: await buildRefAskMessage(state) };
      }
      // text-only model: skip the reference question entirely
      state.stage = 'collecting_refs';
      state.updatedAt = Date.now();
      return { handled: true, reply: buildRefAckMessage(state) };
    }

    if (state.stage === 'collecting_refs') {
      const refs = await classifyReferences(state.cwd, text, input.imageAttachments);
      mergeRefs(state, refs);
      maybeRememberReferenceNote(state, text);
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
        WORKFLOWS.delete(key);
        const action = buildGenerationAction(state);
        return { handled: false, prompt: action.prompt, action };
      }

      if (START_RE.test(text)) {
        // User done collecting → run narrative analysis BEFORE moving on
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
        // High confidence — duration was confirmed before reference collection.
        WORKFLOWS.delete(key);
        const action = buildGenerationAction(state);
        return { handled: false, prompt: action.prompt, action };
      }

      // Acknowledge the refs and continue collecting
      state.updatedAt = Date.now();
      return { handled: true, reply: buildRefAckMessage(state) };
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
      // Good — duration was confirmed before reference collection.
      WORKFLOWS.delete(key);
      const action = buildGenerationAction(state);
      return { handled: false, prompt: action.prompt, action };
    }

    if (state.stage === 'awaiting_duration') {
      const duration = clampDuration(extractTargetDuration(text));
      if (!duration && !CONFIRM_DEFAULT_RE.test(text)) {
        state.updatedAt = Date.now();
        return { handled: true, reply: await buildDurationAskMessage(state) };
      }
      state.targetDuration = duration ?? estimateDuration(state.originalText);
      WORKFLOWS.delete(key);
      const action = buildGenerationAction(state);
      return { handled: false, prompt: action.prompt, action };
    }
  }

  // ─── fresh request ──────────────────────────────────────────────────
  // Starting Saga from plain chat is allowed only for explicit long-video
  // wording ("长视频", "完整视频", "long video", etc.). Generic requests like
  // "生成30秒视频" still fall through to the normal video workflow so pasted
  // logs and short-clip requests do not hijack the chat.
  const shouldStartSaga = input.forceIntent
    ? hasLongVideoIntent(text)
    : hasExplicitLongVideoPhrase(text);
  if (isSagaWorkflowSupportDiscussion(text) || !shouldStartSaga) {
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

  if (next.prefilledDuration) {
    next.targetDuration = next.prefilledDuration;
    if (multimodalCapable) {
      next.stage = 'collecting_refs';
      WORKFLOWS.set(key, next);
      return { handled: true, reply: await buildRefAskMessage(next) };
    }
    const action = buildGenerationAction(next);
    return { handled: false, prompt: action.prompt, action };
  }

  next.stage = 'awaiting_initial_duration';
  WORKFLOWS.set(key, next);
  return { handled: true, reply: await buildInitialDurationAskMessage(next) };
}
