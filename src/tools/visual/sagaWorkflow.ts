import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getMediaOutputRoot } from '../../utils/mediaOutputRoot.js';
import { resolveArtemisHomeDir } from '../../utils/fs.js';
import { normalizeVideoResolution } from './videoParams.js';
import { hasCleanDirectKeyword, hasRawModeTag } from './rawModeTag.js';
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
import { hasDirectCreationRequestMarker, isWorkflowSupportDiscussion } from './workflowIntent.js';
import { DEFAULT_UI_LOCALE, pickLocale, type UiLocale } from '../../cli/locale.js';
import type { AgentAction } from '../../core/types.js';
import type { SagaRatio } from './sagaRenderer/types.js';
import { extractBriefAspectRatio, normalizeAspectRatio } from './aspectRatio.js';
import { extractSagaDialogueLines } from './sagaLanguageDirector.js';
import { parseSagaBriefGlobals, stripBriefNoise } from './sagaBriefGlobals.js';
import { resolveActiveVideoProfile } from './activeVideoModel.js';
import { segmentCountFor, splitLongShots } from './segmentPlan.js';
import type { VideoModelProfile } from './videoCapabilities.js';

export function resolveSagaWorkflowLocaleForTest(explicitLocale?: UiLocale): UiLocale {
  return explicitLocale ?? DEFAULT_UI_LOCALE;
}

export type SagaWorkflowScope = 'cli' | 'bridge';

/**
 * The explicit long-video command. "/longvideo" (and "/长视频") is what help
 * and menus show; "/saga" keeps working as input (the brief guide uses it)
 * but is never shown.
 */
export const LONG_VIDEO_COMMAND = '/longvideo';
const LONG_VIDEO_COMMAND_RE = /^\s*\/(?:saga|longvideo|long-video|长视频)(?=\s|$)/i;

/** The story after an explicit long-video command ('' when none was given), or undefined for other text. */
export function parseLongVideoCommand(text: string): string | undefined {
  const match = LONG_VIDEO_COMMAND_RE.exec(text);
  return match ? text.slice(match[0].length).trim() : undefined;
}

export type SagaWorkflowInput = {
  scope: SagaWorkflowScope;
  key: string;
  cwd: string;
  text: string;
  locale?: UiLocale;
  imageAttachments?: ImageAttachment[];
  deliveryPlatform?: 'telegram' | 'discord' | 'wechat' | 'all';
  deliveryTargetId?: string;
  // Start a fresh wizard: an explicit /saga entry, or a clear long-video request (isClearSagaLongVideoRequest).
  forceIntent?: boolean;
};

export type SagaWorkflowOutcome =
  | {
      handled: false;
      prompt?: string;
      action?: Extract<AgentAction, { type: 'generate_long_video' }>;
      /**
       * The user answered a Saga offer: continue on the normal path with this
       * (the original request) instead of the short reply, without offering
       * Saga again.
       */
      replayText?: string;
    }
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
  | 'awaiting_bgm_asset'
  | 'awaiting_bgm_settings';

type IdentitySource = 'turnaround' | 'character_image' | 'direct_image' | 'text_only';
type SubtitleMode = 'auto' | 'always' | 'off';

type SagaWorkflowState = {
  scope: SagaWorkflowScope;
  cwd: string;
  originalText: string;
  stage: SagaWorkflowStage;
  multimodalCapable: boolean;
  /** L: the active video model's longest clip; segment plans and menus derive from it. */
  maxClipSeconds: number;
  minClipSeconds: number;
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
  /** "480p" / "720p" / "1080p" when the user named one; unset uses the provider default. */
  resolution?: string;
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
// "默认/自动" and "default / auto" are what a menu button labelled with both sends.
const CONFIRM_DEFAULT_RE = /^(?:默认(?:\s*\/\s*自动)?|自动(?:\s*\/\s*默认)?|建议|你定|可以|好|好的|ok|yes|y|sure|default(?:\s*\/\s*auto)?|auto(?:\s*\/\s*default)?)$/i;
const START_RE = /^(?:开始生成|生成|done|go|start|可以生成|就这样|直接生成|跳过|没有参考|不用参考)$/i;
const ABSTRACT_RE = /^(?:无主角|纯视觉|纯风景|抽象视觉|abstract|no lead|no character|没有主角)$/i;
const STORY_DIRECTIVE_RE = /(?:剧情|剧本|分镜|故事|镜头|场景|情节|你来创造|你来安排|你来写|自由发挥|按.*(?:拍|生成)|create the story|write the story|story|script|shot|scene)/i;
const STORY_ENHANCE_RE = /^(?:剧情增强|增强剧情|story\s*enhance|enhance\s*story)$/i;
const STORYBOARD_RE = /^(?:分镜图|分镜图片|图片分镜|上传分镜|发送分镜|storyboard|storyboard image|shot board)$/i;


/** Raw passthrough: an explicit "[原样直传]" / "【raw直传】" tag. */
function wantsRawPassthrough(segments: string[]): boolean {
  return segments.some((segment) => hasRawModeTag(segment));
}

/** cleanDirect: the guide's §9.10 keywords, unless raw passthrough already applies. */
function wantsCleanDirectMode(segments: string[]): boolean {
  return !wantsRawPassthrough(segments) && segments.some((segment) => hasCleanDirectKeyword(segment));
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
const RATIO_MENU_INDEX_RE    = /^(?:([1一①])|([2二②])|([3三③]))[.、)）]?$/;
const BGM_OFF_RE             = /^(?:1|一|①|不加(?:\s*(?:BGM|音乐|配乐))?|不要(?:\s*(?:BGM|音乐|配乐))?|无(?:\s*(?:BGM|音乐|配乐))?|跳过(?:\s*(?:BGM|音乐|配乐))?|不用(?:\s*(?:BGM|音乐|配乐))?|no(?:\s*(?:bgm|music|soundtrack))?|none|skip(?:\s*(?:bgm|music|soundtrack))?)$/i;
const BGM_ADD_RE             = /^(?:2|二|②|添加|加|有|要|bgm|music|soundtrack|add)$/i;
const BGM_ASSET_PROMPT_ZH    = '请发送本地音频路径，或直接音频文件 URL（mp3/wav/m4a/flac 等）；不加 BGM 回复 “不加”。';
const BGM_ASSET_PROMPT_EN    = 'Please send a local audio path or a direct audio-file URL (mp3/wav/m4a/flac, etc.); reply “no BGM” to skip.';
const BGM_SETTINGS_DEFAULT_RE = /^(?:默认|缺省|跳过|继续|确认|开始|好(?:了|的)?|可以|没问题|default(?:s)?|auto|skip|ok(?:ay)?|confirm|continue|go|proceed|use\s*defaults?)$/i;
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

type BgmParamDiff = {
  startSec?: number;
  musicVolumeDb?: number;
  environmentVolumeDb?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
};

function extractBgmParamUpdates(text: string): BgmParamDiff {
  const result: BgmParamDiff = {};
  const start = parseTimeExpressionSeconds(text);
  if (typeof start === 'number' && Number.isFinite(start) && start >= 0) result.startSec = start;
  // "环境音音量 / 环境音量 / 环境声音量 -18dB", "ambience / ambient sound volume -18dB" is the
  // ambience level, not the music's.
  const music = parseDbAfter(text, /(?:bgm|音乐|(?<!环境[音声]?\s*)音量|(?<!(?:ambience|ambient|environment)(?:\s+(?:sounds?|audio|noise))?\s*)volume)[^\n\d-]{0,20}(-?\d+(?:\.\d+)?)\s*dB/i);
  if (music !== undefined) result.musicVolumeDb = music;
  const env = parseDbAfter(text, /(?:环境音|环境声|ambience|ambient|environment)[^\n\d-]{0,20}(-?\d+(?:\.\d+)?)\s*dB/i);
  if (env !== undefined) result.environmentVolumeDb = env;
  const fadeOut = text.match(/(?:淡出|fade\s*out)[^\n\d]{0,12}(\d+(?:\.\d+)?)\s*(?:秒|s|sec|seconds)?/i);
  if (fadeOut) result.fadeOutSec = Number(fadeOut[1]);
  const fadeIn = text.match(/(?:淡入|fade\s*in)[^\n\d]{0,12}(\d+(?:\.\d+)?)\s*(?:秒|s|sec|seconds)?/i);
  if (fadeIn) result.fadeInSec = Number(fadeIn[1]);
  return result;
}

function applyBgmParamsToState(state: SagaWorkflowState, params: BgmParamDiff): void {
  if (params.startSec !== undefined) state.soundtrackStartSec = params.startSec;
  if (params.musicVolumeDb !== undefined) state.soundtrackVolumeDb = params.musicVolumeDb;
  if (params.environmentVolumeDb !== undefined) state.environmentVolumeDb = params.environmentVolumeDb;
  if (params.fadeInSec !== undefined) state.soundtrackFadeInSec = params.fadeInSec;
  if (params.fadeOutSec !== undefined) state.soundtrackFadeOutSec = params.fadeOutSec;
}

function hasBgmParamUpdates(params: BgmParamDiff): boolean {
  return params.startSec !== undefined
    || params.musicVolumeDb !== undefined
    || params.environmentVolumeDb !== undefined
    || params.fadeInSec !== undefined
    || params.fadeOutSec !== undefined;
}

async function applyBgmReplyToState(state: SagaWorkflowState, text: string): Promise<{ ok: boolean; reply?: string; inlineParams?: BgmParamDiff }> {
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
  const inlineParams = extractBgmParamUpdates(text);
  applyBgmParamsToState(state, inlineParams);
  return { ok: true, inlineParams };
}



function pruneExpiredWorkflows(): void {
  const now = Date.now();
  for (const [key, workflow] of WORKFLOWS) {
    if (now - workflow.updatedAt > WORKFLOW_TTL_MS) WORKFLOWS.delete(key);
  }
  for (const [key, offer] of PENDING_SAGA_OFFERS) {
    if (now - offer.createdAt > WORKFLOW_TTL_MS) PENDING_SAGA_OFFERS.delete(key);
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

const SAGA_VIDEO_NOUN_RE = /(?:视频|短片|影片|片子|电影|动画|镜头|分镜|宣传片|预告片|微电影|广告片|\bMV\b|vlog|video|movie|film|clip|shot|scene|trailer|teaser|short film|commercial|promo)/i;
const SAGA_CREATION_VERB_RE = /(?:生成|制作|做|拍|创作|产出|扩展成|做成|变成|拍成|想要|要一[个段部条支]|generate|create|make|produce|render|shoot|turn\b[\s\S]{0,80}\binto)/i;
const SAGA_IMPERATIVE_START_RE = /^(?:请|帮|给|把|用|将|生成|制作|做|拍|创作|来|我想|我要|generate|create|make|produce|render|turn|shoot|please|i want|i need)/i;
// "好的，…" / "ok, …" in front of a request does not change it.
const SAGA_LEADING_ACK_RE = /^(?:好的|好|嗯嗯?|行|可以|ok|okay|sure|alright)\s*[，,。.!！]\s*/i;
const SAGA_LONG_WORDING_RE = /(?:长视频|长片|完整(?:的)?(?:视频|短片|影片)|多段(?:视频|镜头)?|分段(?:视频|生成)|多个片段|\bsaga\b|long[-\s]?(?:form\s+)?(?:video|movie|film)|multi[-\s]?(?:segment|shot|scene)\s+(?:video|movie|film)|full[-\s]?length\s+(?:video|movie|film))/i;
// Work on existing footage: editing, cutting, converting, subtitling, dubbing.
const SAGA_EDIT_RE = /(?:剪辑|剪成|剪掉|剪一下|剪短|裁剪|裁成|截取|截成|转成|转换|转码|压缩|加字幕|配字幕|配音|拼接|合并|倍速|\bshorter\b|\btrim\b|\bcut\b|\bconvert\b|\bcompress\b|\btranscode\b|\bsubtitle|\bdub\b|highlight reel|from (?:these|those|my|the) (?:clips|videos|footage))/i;
// Software, tools and product surfaces about video ("视频播放器组件", "长视频平台的前端").
const SAGA_SOFTWARE_RE = /(?:脚本|代码|程序|工具|组件|播放器|网站|网页|平台|页面|前端|后端|插件|接口|倒计时|计时器|\bapp\b|\bAPI\b|\bscript\b|\bcode\b|\btool\b|\bcomponent\b|\bwebsite\b|\bplatform\b|\bpage\b|\bplayer\b|\bplugin\b|\bcountdown\b|\btimer\b|\bfps\b|redux|python|ffmpeg|javascript|typescript)/i;
// Text-only deliverables and work on existing text or recordings.
const SAGA_TEXT_ONLY_RE = /(?:清单|列表|推荐|\blist\b|\brecommend|文案|剧本大纲|大纲|纪要|建议|总结|概括|摘要|检查|校对|改错别字|错别字|翻译|润色|just text|text only|\bplan\b|\boutline\b|\b(?:\d+|two|three|some|a few|several) ideas\b|\bideas (?:for|on|about)\b|\btips\b|\badvice\b|\bsummar|\breview\b|\bproofread|\btranslat|\btranscri|\bcaption)/i;
const SAGA_QUESTION_RE = /(?:[?？]\s*$|(?:吗|呢|么)[。!！]?\s*$|^(?:how|what|why|can you|could you|do you|is it|are you)\b|^(?:你能|你会|能不能|可不可以|怎么|如何|为什么|什么是|是否))/i;
// One timecoded segment line: "[0-8秒] …", "[0:00-0:08] …", "0-8s: …".
const SAGA_SEGMENT_LINE_SOURCE = String.raw`^\s*(\[)?\s*\d+(?::\d{1,2}){0,2}(?:\.\d+)?\s*(?:秒|s|sec|seconds)?\s*[-–—~至到]\s*\d+(?::\d{1,2}){0,2}(?:\.\d+)?\s*(?:秒|s|sec|seconds)?\s*(\])?`;
const SAGA_SHOT_WORD_RE = /(?:画面|运镜|特写|远景|近景|全景|推镜|拉镜|跟拍|camera|close-up|wide shot|pan|dolly)/i;
// A brief written after the Saga guide: "【整片叙事】", "【画质规格】", "[Story]".
const SAGA_GUIDE_HEADER_RE = /(?:【\s*(?:整片叙事|画质规格|角色设定|世界观|全片设定|音频设计|BGM)\s*】|^\s*\[\s*(?:Story|Overall story|Quality spec|Characters?)\s*\])/im;

/**
 * Split a message into the request before the first timecoded segment line
 * and the segments. Exclusion words (配音, 页面, 合并, 总结, "Cut to:" …)
 * only count in the preamble: inside a brief they are story content.
 */
export function splitSagaBrief(text: string): { preamble: string; segmentLines: number; bracketedSegments: number; segments: string[] } {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(SAGA_SEGMENT_LINE_SOURCE, 'i');
  let first = -1;
  let segmentLines = 0;
  let bracketedSegments = 0;
  const segments: string[] = [];
  lines.forEach((line, index) => {
    const match = re.exec(line);
    if (!match) return;
    segmentLines += 1;
    if (match[1] && match[2]) bracketedSegments += 1;
    segments.push(line.slice(match[0].length).trim());
    if (first < 0) first = index;
  });
  return {
    preamble: (first < 0 ? text : lines.slice(0, first).join('\n')).trim(),
    segmentLines,
    bracketedSegments,
    segments,
  };
}

// "[00:00-00:15] 张三：大家好": a transcript or subtitle file, not a brief.
// Shot labels ("镜头1：", "Scene 2:") are brief syntax, not speakers.
const SPEAKER_LINE_RE = /^(?!镜头|分镜|画面|场景|旁白|字幕|shot|scene|cut)[^\s：:，,。.]{1,10}\s*[：:]/i;
function looksLikeTranscript(segments: readonly string[]): boolean {
  if (segments.length < 2) return false;
  const speakerLines = segments.filter((segment) => SPEAKER_LINE_RE.test(segment)).length;
  return speakerLines * 2 >= segments.length;
}

const ZH_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function parseZhNumber(raw: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (!raw) return undefined;
  if (raw === '十') return 10;
  const tens = raw.indexOf('十');
  if (tens >= 0) {
    const high = tens === 0 ? 1 : ZH_DIGITS[raw.slice(0, tens)];
    const low = tens === raw.length - 1 ? 0 : ZH_DIGITS[raw.slice(tens + 1)];
    return high === undefined || low === undefined ? undefined : high * 10 + low;
  }
  return raw.length === 1 ? ZH_DIGITS[raw] : undefined;
}
const EN_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, ninety: 90, sixty: 60, thirty: 30 };

/** The length asked for in a request, in seconds ("90-second", "1.5 minutes", "两分钟", "一分半"). */
// "总共60秒", "总长 2 分钟", "total 90 seconds": the whole video's length.
const TOTAL_LENGTH_LABEL_RE = /(?:总共|一共|总长(?:度)?|总时长|全片|整片|合计|in total|total(?:\s+length)?(?:\s+of)?)\s*[:：]?\s*/i;
// "每段5秒", "每个镜头 8 秒", "each shot 5 seconds", "per segment 10s": a part's length, not the video's.
const PER_PART_LENGTH_RE = /(?:每(?:一)?(?:段|个?镜头|镜|个?片段|幕)|(?:each|per)\s+(?:segment|shot|clip|scene|part))\s*[:：]?\s*(?:约|大约|about|around)?\s*[\d.零〇一二两三四五六七八九十]+\s*(?:秒|s\b|sec(?:ond)?s?\b|分钟|minutes?)/gi;

/** The length asked for in a request, in seconds ("90-second", "1.5 minutes", "两分钟", "一分半", "总共60秒"). */
export function parseRequestedVideoSeconds(text: string): number | undefined {
  // A labelled total wins over every other length in the request.
  const total = TOTAL_LENGTH_LABEL_RE.exec(text);
  if (total) {
    const value = parseLengthOnce(text.slice(total.index + total[0].length, total.index + total[0].length + 24));
    if (value !== undefined) return value;
  }
  return parseLengthOnce(text.replace(PER_PART_LENGTH_RE, ' '));
}

function parseLengthOnce(text: string): number | undefined {
  // "两分钟", "一分半", "2分30秒", "一分两秒", "半分钟"; never the adverb "十分" ("十分精彩").
  if (/半\s*分钟/.test(text)) return 30;
  const zh = /([\d.]+|[零〇一二两三四五六七八九十]{1,3})\s*分\s*(钟|半|(?=\s*(?:\d+|[零〇一二两三四五六七八九十]{1,3})\s*秒))\s*(?:([\d]+|[零〇一二两三四五六七八九十]{1,3})\s*秒)?/.exec(text);
  if (zh) {
    const minutes = parseZhNumber(zh[1] ?? '');
    if (minutes !== undefined) return Math.round(minutes * 60 + (zh[2] === '半' ? 30 : 0) + (zh[3] ? parseZhNumber(zh[3]) ?? 0 : 0));
  }
  const zhSeconds = /([\d]+|[零〇一二两三四五六七八九十]{1,3})\s*秒/.exec(text);
  if (zhSeconds) {
    const seconds = parseZhNumber(zhSeconds[1] ?? '');
    if (seconds !== undefined) return seconds;
  }
  // "90-second", "2 minutes", "1.5 min", "60 s"; not decades ("90s-style",
  // "1980s retro", "the 80s").
  const en = /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|thirty|sixty|ninety)(?:[-\s]*(minutes?|mins?|seconds?|secs?)\b|\s+(s)\b)/i.exec(text);
  if (en) {
    const value = /^\d/.test(en[1]!) ? Number(en[1]) : EN_NUMBERS[en[1]!.toLowerCase()];
    if (value === undefined) return undefined;
    return /^m/i.test(en[2] ?? '') ? Math.round(value * 60) : Math.round(value);
  }
  // A bare "60s": seconds next to Chinese ("做个60s的视频") or before a video
  // word ("make a 30s video", "a 60s clip"); otherwise a round "60s" / "90s"
  // is a decade ("80s music"), any other number is seconds.
  const bare = /(^|[^\d.])(\d{1,3})s(?![a-z])(?![-\s]?(?:style|era|retro|vibe|vibes|music|look|aesthetic|fashion|songs?|hits?))(.?)/i.exec(text);
  if (bare) {
    const after = text.slice((bare.index ?? 0) + bare[0].length - (bare[3] ? bare[3].length : 0));
    const cjkNeighbour = /[㐀-鿿]/.test(bare[1] ?? '') || /[㐀-鿿]/.test(bare[3] ?? '');
    const videoWordAfter = /^[\s-]*(?:long\s+)?(?:video|clip|film|movie|trailer|teaser|ad|promo|reel|short|vlog|animation|loop)\b/i.test(after);
    if (cjkNeighbour || videoWordAfter || !/^(?:[2-9]0)$/.test(bare[2]!)) return Number(bare[2]);
  }
  return undefined;
}

/**
 * A fresh message that clearly asks Artemis to make a new long,
 * multi-segment video. The workflow router then OFFERS Saga (the user
 * confirms before anything is generated; see offerSagaLongVideoWorkflow).
 * Clear means a creation request plus long-video wording or a total length
 * of a minute or more, or a brief: two or more timecoded segment lines (in
 * brackets, or with video words) or a Saga-guide header.
 * Not: questions, editing or converting existing footage, software or tools
 * about video, text-only deliverables (copy, scripts, summaries, reviews,
 * translations), bare keyword lists, or clips shorter than a minute. These
 * exclusions apply to the request, not to the content of a brief's segments.
 */
export function isClearSagaLongVideoRequest(text: string, options: { maxClipSeconds?: number } = {}): boolean {
  const trimmed = text.trim();
  const L = options.maxClipSeconds;
  // Empty, or a slash command: /saga is handled explicitly, others are not Saga.
  if (!trimmed || trimmed.startsWith('/')) return false;
  const brief = splitSagaBrief(trimmed.replace(SAGA_LEADING_ACK_RE, ''));
  const request = compact(brief.preamble);
  if (request && SAGA_QUESTION_RE.test(request)) return false;
  if (SAGA_EDIT_RE.test(request) || SAGA_SOFTWARE_RE.test(request) || SAGA_TEXT_ONLY_RE.test(request)) return false;
  if (request && isSagaWorkflowSupportDiscussion(request)) return false;
  const whole = compact(trimmed);
  const hasVideoNoun = SAGA_VIDEO_NOUN_RE.test(whole);
  const isCreationRequest =
    SAGA_CREATION_VERB_RE.test(request) &&
    (hasDirectCreationRequestMarker(request) || SAGA_IMPERATIVE_START_RE.test(request));
  // With the active model's longest clip (L) known, a stated length decides:
  // up to L is one clip, longer is a long video.
  const statedSeconds = parseRequestedVideoSeconds(request);
  const fitsOneClip = L !== undefined && statedSeconds !== undefined && statedSeconds <= L;
  // A brief with its own segments stays a long video whatever its length.
  if (SAGA_GUIDE_HEADER_RE.test(trimmed)) return true;
  // Timecoded lines are a brief only with a video / shot word or a creation
  // request, and never when they read like a transcript.
  const timed = brief.segmentLines >= 2 || timecodeTotalSeconds(trimmed) !== undefined;
  if (timed && !looksLikeTranscript(brief.segments) && (hasVideoNoun || SAGA_SHOT_WORD_RE.test(whole) || isCreationRequest)) return true;
  if (!isCreationRequest || !SAGA_VIDEO_NOUN_RE.test(request)) return false;
  if (fitsOneClip) return false;
  if (SAGA_LONG_WORDING_RE.test(request)) return true;
  const seconds = parseRequestedVideoSeconds(request);
  // Without a known L the old fixed bar (a minute) applies.
  return typeof seconds === 'number' && (L !== undefined ? seconds > L : seconds >= 60);
}

/**
 * How a video request fits the active model: 'single' when it states a
 * length up to L (one plain clip), 'long' when it states more than L or is a
 * brief with two or more timecoded segments, 'unknown' when it states no length.
 */
export function classifyVideoRequestLength(text: string, maxClipSeconds: number): { kind: 'single' | 'long' | 'unknown'; seconds?: number } {
  const trimmed = text.trim().replace(SAGA_LEADING_ACK_RE, '');
  const brief = splitSagaBrief(trimmed);
  // Two or more timecoded segments (or a guide-style brief) are a long video.
  if (brief.segmentLines >= 2 || timecodeTotalSeconds(trimmed) !== undefined || SAGA_GUIDE_HEADER_RE.test(trimmed)) {
    return { kind: 'long', seconds: timecodeTotalSeconds(trimmed) };
  }
  const seconds = parseRequestedVideoSeconds(brief.preamble || trimmed);
  if (seconds !== undefined) return { kind: seconds <= maxClipSeconds ? 'single' : 'long', seconds };
  return { kind: 'unknown' };
}

// ── Confirmation before a natural-language Saga start ─────────────────────
// A Saga run spends real money (one paid generation per segment), so a
// request that only looks like one is answered with a yes/no question first;
// the wizard starts after an explicit yes. /saga skips the question.

type PendingSagaOffer = {
  text: string;
  imageAttachments?: ImageAttachment[];
  createdAt: number;
};

const PENDING_SAGA_OFFERS = new Map<string, PendingSagaOffer>();
// Only a whole-reply answer counts; "好的，按方案二来", "好贵啊", "1分钟太长了",
// "ok but shorter" are new messages (the offer lapses and they are handled
// normally). The option labels count too: web buttons send them.
// Old labels ("是，开始" / "不是" / "Yes, start" / "No") still count: a web
// page or chat history rendered before the wording change sends them.
const SAGA_OFFER_YES_RE = /^(?:1|1\.|①|1️⃣|是|是的|好|好的|开始|确定|确认|可以|yes|y|ok|okay|sure|👍|✅|(?:1\.?\s*)?(?:是|好)[，,]\s*开始|(?:1\.?\s*)?yes,?\s*(?:start|go ahead)|(?:1\.?\s*)?go ahead)[\s!！。.~👍✅]*$/iu;
const SAGA_OFFER_NO_RE = /^(?:2|2\.|②|2️⃣|不是|不|不要|不用|不用了|否|算了|取消|no|n|nope|cancel|no thanks|(?:2\.?\s*)?(?:不是|不用了?)|(?:2\.?\s*)?no(?:,?\s*thanks)?)[\s!！。.~]*$/iu;

export function parseSagaOfferReply(text: string): 'yes' | 'no' | undefined {
  const reply = text.trim();
  if (SAGA_OFFER_YES_RE.test(reply)) return 'yes';
  if (SAGA_OFFER_NO_RE.test(reply)) return 'no';
  return undefined;
}

const SAGA_OFFER_TEXT = {
  zh: {
    intro: '要我帮你做成一段完整的长视频吗？',
    yes: '好，开始',
    no: '不用了',
    pick: '请回复编号。',
    alt: '也可以直接回复 1（好，开始）或 2（不用了）。',
  },
  en: {
    intro: 'Shall I make this into one complete long video?',
    yes: 'Yes, go ahead',
    no: 'No thanks',
    pick: 'Reply with the number.',
    alt: 'You can also reply 1 (yes, go ahead) or 2 (no thanks).',
  },
};

/**
 * The yes/no question. 'numbered' (CLI, chat bridges): a numbered menu
 * followed by "请回复编号" so Telegram shows buttons. 'choices' (web): a
 * ```choices card the web app renders as buttons.
 */
export function buildSagaOfferQuestion(locale?: UiLocale, format: 'numbered' | 'choices' = 'numbered'): string {
  const text = pickLocale(locale ?? DEFAULT_UI_LOCALE, { zh: 'zh', en: 'en' }) === 'zh' ? SAGA_OFFER_TEXT.zh : SAGA_OFFER_TEXT.en;
  if (format === 'choices') {
    // The intro stays as text; the card holds only the buttons.
    const card = JSON.stringify({ options: [text.yes, text.no] });
    return `${text.intro}\n\n\`\`\`choices\n${card}\n\`\`\`\n${text.alt}`;
  }
  return `${text.intro}\n1. ${text.yes}\n2. ${text.no}\n${text.pick}`;
}

const WIZARD_ANSWER_RE = /^(?:\d{1,2}\s*[.、]?|[A-Da-d]\s*[.、)）]?|\d{1,2}\s*[:：x×]\s*\d{1,2}|横屏|竖屏|方屏|landscape|portrait|square|480p|720p|1080p|默认(?:\s*\/\s*自动)?|自动|带字幕|无字幕|不要字幕|加字幕|不加(?:\s*BGM)?|不要\s*BGM|开始生成|生成|跳过|没有参考|不用参考|剧情你来创造|你来写|default|auto|skip|start|go|done)[\s!！。.~]*$/i;

/**
 * A reply that answers a Saga step (a menu number, ratio, length,
 * resolution, subtitle / BGM choice, yes / no, a short confirmation, or a
 * brief with timecoded segments). The web keeps a confirmed Saga going only
 * for these; anything else ends it.
 */
export function looksLikeSagaWizardAnswer(text: string): boolean {
  const reply = text.trim();
  if (!reply) return false;
  if (parseSagaOfferReply(reply) !== undefined || WIZARD_ANSWER_RE.test(reply)) return true;
  // A length on its own: "60秒", "两分钟", "90 seconds".
  if (reply.length <= 12 && parseRequestedVideoSeconds(reply) !== undefined) return true;
  const brief = splitSagaBrief(reply);
  return brief.segmentLines >= 2 || SAGA_GUIDE_HEADER_RE.test(reply);
}

/**
 * Ask before starting Saga for a natural-language request. Returns the
 * question to send, or undefined when no video provider is configured (then
 * the request just takes the normal path).
 */
export async function offerSagaLongVideoWorkflow(input: SagaWorkflowInput): Promise<string | undefined> {
  const profile = await resolveActiveVideoProfile(input.cwd);
  if (!profile) return undefined;
  // A request that states a length the model renders in one clip is a plain video.
  if (!isClearSagaLongVideoRequest(input.text, { maxClipSeconds: profile.maxClipSeconds })) return undefined;
  pruneExpiredWorkflows();
  PENDING_SAGA_OFFERS.set(normalizeKey(input), {
    text: input.text,
    imageAttachments: input.imageAttachments,
    createdAt: Date.now(),
  });
  return buildSagaOfferQuestion(input.locale);
}

/** True while a Saga wizard or a Saga offer is waiting for an answer under this scope + key. */
export function hasActiveSagaLongVideoWorkflow(scope: SagaWorkflowScope, key: string): boolean {
  pruneExpiredWorkflows();
  return WORKFLOWS.has(`${scope}:${key}`) || PENDING_SAGA_OFFERS.has(`${scope}:${key}`);
}

function extractTargetDuration(text: string): number | undefined {
  // A timecoded brief states its own length: the end of its last timecode,
  // not the first "N秒" (which is usually a dialogue's "约 3 秒").
  const timeline = timecodeTotalSeconds(text);
  if (timeline) return timeline;
  // "（约 3 秒，温柔低语）" describes a line or a beat, not the whole video.
  const normalized = compact(text.replace(/（[^（）\n]*）|\([^()\n]*\)/g, ' '));
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

const TIMECODE_TOKEN_SOURCE = '\\d+(?::\\d{1,2}){0,2}(?:\\.\\d+)?';
const TIMECODE_UNIT_SOURCE = '(?:\\s*(?:秒|s|sec|seconds))?';

/** End of the last timecode ("[16-24秒]", "[1:04-1:12]", "0:08-0:16:") when a brief has two or more. */
function timecodeTotalSeconds(text: string): number | undefined {
  const range = `(${TIMECODE_TOKEN_SOURCE})${TIMECODE_UNIT_SOURCE}\\s*[-–—~至到]\\s*(${TIMECODE_TOKEN_SOURCE})${TIMECODE_UNIT_SOURCE}`;
  const bracketed = Array.from(text.matchAll(new RegExp(`\\[\\s*${range}\\s*\\]`, 'gi')));
  const markers = bracketed.length >= 2
    ? bracketed
    : Array.from(text.matchAll(new RegExp(`(?:^|\\n)\\s*${range}\\s*[:：]`, 'gi')));
  const toSeconds = (token: string) => token.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
  const ends = markers
    .map((match) => ({ start: toSeconds(match[1] ?? ''), end: toSeconds(match[2] ?? '') }))
    .filter((range) => Number.isFinite(range.end) && range.end > range.start)
    .map((range) => range.end);
  return ends.length >= 2 ? Math.round(Math.max(...ends)) : undefined;
}

function clampDuration(seconds: number | undefined): number | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  return Math.max(10, Math.min(600, Math.floor(seconds)));
}

function estimateDuration(text: string): number {
  const timeline = clampDuration(timecodeTotalSeconds(text));
  if (timeline) return timeline;
  const chars = compact(text).length;
  if (chars > 1600) return 180;
  if (chars > 900) return 120;
  if (chars > 450) return 90;
  return 60;
}

function extractRatio(text: string): SagaRatio | undefined {
  // Deliberately conservative: a labelled ratio line first, otherwise only
  // bounded numeric ratios and unambiguous orientation words. Never inferred
  // from platform names (小红书 / Instagram / YouTube / etc.).
  return extractBriefAspectRatio(text)?.ratio;
}

/**
 * A ratio the user has already answered: a labelled line in the brief
 * ("画幅比例 / ratio: 9:16 竖屏"). The wizard applies it instead of asking.
 * Orientation words in story prose ("她把手机横屏举起") only preselect the menu.
 */
function statedRatio(state: SagaWorkflowState): SagaRatio | undefined {
  const brief = extractBriefAspectRatio(combinedStoryText(state));
  return brief?.labelled ? brief.ratio : undefined;
}

function applyRatioReplyToState(state: SagaWorkflowState, text: string): boolean {
  const index = text.trim().match(RATIO_MENU_INDEX_RE);
  if (index) {
    state.ratio = index[1] ? '9:16' : index[2] ? '16:9' : '1:1';
    return true;
  }
  if (CONFIRM_DEFAULT_RE.test(text)) {
    state.ratio = state.suggestedRatio ?? '16:9';
    return true;
  }
  // "9:16 竖屏", "竖屏 9:16", "portrait" — anything that names exactly one
  // ratio, including a line copied from the menu.
  if (text.trim().length > 40) return false;
  const ratio = normalizeAspectRatio(text);
  if (!ratio) return false;
  state.ratio = ratio;
  return true;
}

/**
 * Move to the ratio step. When the brief already states the ratio it is
 * applied with a one-line note and the subtitle question follows directly.
 */
function enterRatioStep(state: SagaWorkflowState): SagaWorkflowOutcome {
  state.updatedAt = Date.now();
  const stated = statedRatio(state);
  if (stated) {
    state.ratio = stated;
    state.suggestedRatio = stated;
    state.stage = 'awaiting_subtitle_mode';
    const note = pickLocale(state.locale, {
      zh: `📐 画幅：${formatRatioLabel(stated, state.locale)}（按剧本）。要改的话直接回复其它比例，例如 “16:9”。`,
      en: `📐 Aspect ratio: ${formatRatioLabel(stated, state.locale)} (from your brief). Reply with another ratio such as "16:9" to change it.`,
    });
    return { handled: true, reply: `${note}\n\n${buildSubtitleModeAskMessage(state)}` };
  }
  state.suggestedRatio = extractRatio(combinedStoryText(state)) ?? '16:9';
  state.stage = 'awaiting_ratio';
  return { handled: true, reply: buildRatioAskMessage(state) };
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

// Dedup image references by FILE CONTENT (not path string). The desktop app embeds
// attachment paths into the message text ("Attached paths: - /x.png") AND sends the
// same image as an attachment (which we copy into saga-refs). Those are two different
// path strings for the SAME image, so plain unique() counts one upload as two (and
// two as four). Hashing the bytes collapses the original + its copy back to one.
async function dedupImagePathsByContent(paths: string[]): Promise<string[]> {
  const refsDir = path.join(getMediaOutputRoot(), 'saga-refs');
  // Prefer the stable saga-refs copy over a transient user path on a content collision.
  const ordered = unique(paths).sort(
    (a, b) => (b.startsWith(refsDir) ? 1 : 0) - (a.startsWith(refsDir) ? 1 : 0),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of ordered) {
    let key: string;
    try {
      key = 'h:' + createHash('sha256').update(await readFile(p)).digest('hex');
    } catch {
      key = 'p:' + p;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
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
    imagePaths: await dedupImagePathsByContent(imagePaths),
    videoPaths: unique(videoPaths),
    audioPaths: unique(audioPaths),
  };
}

async function imageContentKey(imagePath: string): Promise<string> {
  try {
    return 'h:' + createHash('sha256').update(await readFile(imagePath)).digest('hex');
  } catch {
    return 'p:' + imagePath;
  }
}

/**
 * Appends image paths to an accumulated list, skipping any whose bytes are
 * already there. Across turns the same image can arrive as a pasted local
 * path in one message and as an attachment (saved under saga-refs) in another;
 * string comparison counted it twice. Existing entries keep their order; on a
 * collision the stable saga-refs copy replaces a transient user path in place.
 */
async function appendImagePathsByContent(existing: string[], incoming: string[]): Promise<string[]> {
  const refsDir = path.join(getMediaOutputRoot(), 'saga-refs');
  const out: string[] = [];
  const indexByKey = new Map<string, number>();
  for (const imagePath of unique([...existing, ...incoming])) {
    const key = await imageContentKey(imagePath);
    const seenAt = indexByKey.get(key);
    if (seenAt === undefined) {
      indexByKey.set(key, out.length);
      out.push(imagePath);
    } else if (imagePath.startsWith(refsDir) && !out[seenAt]!.startsWith(refsDir)) {
      out[seenAt] = imagePath;
    }
  }
  return out;
}

async function mergeRefs(state: SagaWorkflowState, refs: ExtractedReferences): Promise<void> {
  state.referenceImageUrls = unique([...state.referenceImageUrls, ...refs.imageUrls]);
  state.referenceVideoUrls = unique([...state.referenceVideoUrls, ...refs.videoUrls]);
  state.referenceAudioUrls = unique([...state.referenceAudioUrls, ...refs.audioUrls]);
  state.referenceImagePaths = await appendImagePathsByContent(state.referenceImagePaths, refs.imagePaths);
  state.referenceVideoPaths = unique([...state.referenceVideoPaths, ...refs.videoPaths]);
  state.referenceAudioPaths = unique([...state.referenceAudioPaths, ...refs.audioPaths]);
  state.updatedAt = Date.now();
}

const RESOLUTION_WORDS: Record<string, string> = {
  标清: '480p',
  sd: '480p',
  高清: '1080p',
  超清: '1080p',
  全高清: '1080p',
  hd: '1080p',
  fullhd: '1080p',
};

/**
 * A resolution from a message that is only a resolution choice ("1080p",
 * "分辨率 720P", "高清"); a bare number ("720") is a duration or menu answer,
 * not a resolution. Resolution is never read out of story text: a
 * script mentioning "一台1080P的旧显示器" must not bill every segment at
 * 1080p. 4K is not offered by any provider.
 */
export function extractRequestedResolution(text: string): string | undefined {
  const compacted = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!compacted || compacted.length > 16) return undefined;
  const match = compacted.match(/^(?:请|用|要|改成|改为|输出|设为|画质|分辨率|清晰度|resolution|quality|[:：])*(?:(480|720|1080)p|(标清|高清|超清|全高清|fullhd|hd|sd))(?:高清|超清|画质|分辨率|吧|的|[。.!！])*$/u);
  if (!match) return undefined;
  if (match[1]) return normalizeVideoResolution(`${match[1]}p`);
  return RESOLUTION_WORDS[match[2] ?? ''];
}

async function mergeStoryboardRefs(state: SagaWorkflowState, refs: ExtractedReferences): Promise<void> {
  state.storyboardImageUrls = unique([...state.storyboardImageUrls, ...refs.imageUrls]);
  state.storyboardImagePaths = await appendImagePathsByContent(state.storyboardImagePaths, refs.imagePaths);
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

function buildModelLine(state: SagaWorkflowState): string {
  // L of the active model; no model or provider name: users see what
  // happens, not which vendor runs it.
  return pickLocale(state.locale, {
    zh: `每段画面最长 ${state.maxClipSeconds} 秒，我会按需要分成尽量少的几段生成，再合成一条完整视频。`,
    en: `Each segment can be up to ${state.maxClipSeconds}s; I use as few segments as the length needs and join them into one video.`,
  });
}

/** Lengths the duration step offers, each with how many segments it takes on this model. */
export function longVideoDurationChoices(maxClipSeconds: number, minClipSeconds = 4): Array<{ seconds: number; segments: number }> {
  // A long video is longer than one clip: the examples start above L.
  return [30, 60, 90, 120, 180, 240]
    .filter((seconds) => seconds > maxClipSeconds)
    .slice(0, 4)
    .map((seconds) => ({ seconds, segments: segmentCountFor(seconds, maxClipSeconds, minClipSeconds) }));
}

function formatSecondsLabel(seconds: number, locale: UiLocale): string {
  if (locale === 'zh-CN') return seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60}分钟` : `${seconds}秒`;
  return seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60} minute${seconds === 60 ? '' : 's'}` : `${seconds}s`;
}

function formatDurationChoices(state: SagaWorkflowState): string {
  const choices = longVideoDurationChoices(state.maxClipSeconds, state.minClipSeconds);
  return state.locale === 'zh-CN'
    ? choices.map(({ seconds, segments }) => `"${formatSecondsLabel(seconds, state.locale)}"（约 ${segments} 段）`).join('、')
    : choices.map(({ seconds, segments }) => `"${formatSecondsLabel(seconds, state.locale)}" (about ${segments} segment${segments === 1 ? '' : 's'})`).join(', ');
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
      '🎵 是否添加背景音乐？',
      '',
      '  1️⃣ 不添加 — 仅保留视频原声',
      '  2️⃣ 添加 — 发送本地音频路径或音频文件 URL（mp3 / wav / m4a / flac）',
      '',
      '添加后将自动输出三个版本：原声版、混音版、智能避让版（在对白与旁白段自动降低背景音乐音量，对白结束后恢复）。',
      '',
      '不支持 Spotify / Apple Music / YouTube Music 的播放页链接；请提供本地音频文件或可直接下载的音频 URL。',
      '',
      '可选参数与路径写在同一行：',
      '  起点         从 1:19 开始',
      '  音乐音量     音量 -12dB（默认）',
      '  环境音音量   环境音 -18dB（默认）',
      '  淡出时长     淡出 1.2 秒',
      '',
      '音量参考（dB 为对数刻度，数字越接近 0 越响）：-3 较响，-12 适中（默认），-20 很轻。',
      '',
      '示例：/Users/me/song.mp3 从 1:19 开始 音量 -12dB 淡出 1.2 秒',
      '',
      '回复编号、路径或 URL；回复 "取消" 退出。',
    ].join('\n'),
    en: [
      '🎵 Add background music?',
      '',
      '  1️⃣ No music — keep only the original video audio',
      '  2️⃣ Add music — send a local audio path or direct audio URL (mp3 / wav / m4a / flac)',
      '',
      'Adding music produces three versions: original, mixed, and intelligent-ducking (background music lowers automatically during dialogue and voiceover, restoring afterward).',
      '',
      'Spotify, Apple Music, and YouTube Music page links are not supported; please supply a local audio file or a directly downloadable audio URL.',
      '',
      'Optional parameters on the same line as the path:',
      '  Start offset    start 1:19',
      '  Music volume    volume -12dB (default)',
      '  Ambience volume ambience -18dB (default)',
      '  Fade out        fadeout 1.2s',
      '',
      'Volume reference (dB is logarithmic; closer to 0 is louder): -3 = loud, -12 = balanced (default), -20 = quiet.',
      '',
      'Example: /Users/me/song.mp3 start 1:19 volume -12dB fadeout 1.2s',
      '',
      'Reply with a number, path, or URL; reply "cancel" to exit.',
    ].join('\n'),
  });
}

function buildBgmSettingsAskMessage(state: SagaWorkflowState): string {
  const source = state.soundtrackPath ?? state.soundtrackUrl ?? '';
  const label = source ? path.basename(source.split(/[?#]/)[0] || source) : 'BGM';
  return pickLocale(state.locale, {
    zh: [
      `🎚️ 已接收音乐：${label}`,
      '',
      '是否调整混音参数？回复 "默认" 使用推荐配置；或在一条消息中提供以下任意参数：',
      '',
      '  起点         从 1:19 开始',
      '  音乐音量     音量 -12dB（默认）',
      '  环境音音量   环境音 -18dB（默认）',
      '  淡入时长     淡入 0.5 秒',
      '  淡出时长     淡出 1.2 秒',
      '',
      '音量参考：-3 较响，-12 适中（默认），-20 很轻；越接近 0 越大声。',
      '推荐配置已经平衡了音乐与对白，绝大多数情况直接回复 "默认" 即可。',
      '回复 "取消" 退出。',
    ].join('\n'),
    en: [
      `🎚️ Music received: ${label}`,
      '',
      'Adjust the mix? Reply "default" to use the recommended balance, or send any of the following parameters in one message:',
      '',
      '  Start offset    start 1:19',
      '  Music volume    volume -12dB (default)',
      '  Ambience volume ambience -18dB (default)',
      '  Fade in         fade in 0.5s',
      '  Fade out        fadeout 1.2s',
      '',
      'Volume reference: -3 = loud, -12 = balanced (default), -20 = quiet; closer to 0 is louder.',
      'The recommended defaults already balance music against dialogue; for most projects, reply "default".',
      'Reply "cancel" to exit.',
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
        en: `· identity: ${state.identitySource === 'turnaround' ? 'turnaround sheet' : state.identitySource === 'character_image' ? 'character photo' : state.identitySource === 'direct_image' ? 'image used directly' : 'text only'}`,
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
  // Raw passthrough sends the script and the references to the video model
  // as they are: no LLM and vision analysis (which would lock props and
  // scenery from the reference backgrounds) and no "confirm the lead"
  // question. The keyword pass only feeds downstream routing. cleanDirect
  // keeps the analysis: it only drops aesthetic dressing.
  if (wantsRawPassthrough([state.originalText, ...state.accumulatedStory])) {
    return narrativeKeywordFallback({
      userText: fullStory,
      hasFaceLikelyInImages: imagePaths.length > 0,
    });
  }
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

// Guide §3.2: about 4-5 Chinese characters or 2-3 English words per second.
const CHINESE_CHARS_PER_SECOND = 5;
const ENGLISH_WORDS_PER_SECOND = 3;

/**
 * One line per timecoded segment whose marked dialogue (spoken lines and
 * voiceover, not subtitles) needs longer than the segment lasts at a natural
 * speech rate; such lines get cut off or sped up.
 */
function speechRateWarnings(text: string, locale: UiLocale, maxClipSeconds: number, minClipSeconds: number): string[] {
  const brief = stripBriefNoise(text);
  const range = `(${TIMECODE_TOKEN_SOURCE})${TIMECODE_UNIT_SOURCE}\\s*[-–—~至到]\\s*(${TIMECODE_TOKEN_SOURCE})${TIMECODE_UNIT_SOURCE}`;
  const markers = Array.from(brief.matchAll(new RegExp(`\\[\\s*${range}\\s*\\]`, 'gi')));
  const toSeconds = (token: string) => token.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
  const warnings: string[] = [];
  markers.forEach((marker, index) => {
    const start = toSeconds(marker[1] ?? '');
    const end = toSeconds(marker[2] ?? '');
    const seconds = end - start;
    if (!(seconds > 0)) return;
    const body = brief.slice((marker.index ?? 0) + marker[0].length, markers[index + 1]?.index ?? brief.length);
    // The clips that will actually be generated: a segment longer than the
    // model's longest clip is split into parts, and each part has to fit its lines.
    const parts = splitLongShots([{ storyBeat: body, duration: seconds, timecodeStart: start, timecodeEnd: end }], maxClipSeconds, minClipSeconds);
    parts.forEach((part, partIndex) => {
      const partSeconds = part.duration ?? seconds;
      const spoken = extractSagaDialogueLines(part.storyBeat ?? '').filter((line) => line.use !== 'subtitle');
      const han = spoken.reduce((sum, line) => sum + (line.text.match(/\p{Script=Han}/gu)?.length ?? 0), 0);
      const words = spoken.reduce((sum, line) => sum + (line.text.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}'’-]+/gu)?.length ?? 0), 0);
      const needed = han / CHINESE_CHARS_PER_SECOND + words / ENGLISH_WORDS_PER_SECOND;
      if (needed <= partSeconds) return;
      const amount = [han > 0 ? `${han} ${locale === 'zh-CN' ? '字' : 'Chinese characters'}` : '', words > 0 ? `${words} ${locale === 'zh-CN' ? '个英文词' : 'words'}` : ''].filter(Boolean).join(' + ');
      const where = parts.length > 1
        ? pickLocale(locale, { zh: `段 ${index + 1} 第 ${partIndex + 1}/${parts.length} 部分（${partSeconds} 秒）`, en: `segment ${index + 1}, part ${partIndex + 1}/${parts.length} (${partSeconds}s)` })
        : pickLocale(locale, { zh: `段 ${index + 1}（${marker[0]}，${partSeconds} 秒）`, en: `segment ${index + 1} (${marker[0]}, ${partSeconds}s)` });
      warnings.push(pickLocale(locale, {
        zh: `⚠️ 语速提示：${where}的对白约 ${amount}，正常语速需要约 ${Math.ceil(needed)} 秒，可能说不完或被加速；建议精简台词或拉长该段。`,
        en: `⚠️ Speech rate: ${where} has about ${amount} of dialogue, which takes about ${Math.ceil(needed)}s at a natural pace; it may be cut off or sped up. Shorten the lines or lengthen the segment.`,
      }));
    });
  });
  return warnings;
}

async function buildDurationAskMessage(state: SagaWorkflowState): Promise<string> {
  const modelLine = buildModelLine(state);
  const rateWarnings = speechRateWarnings(combinedStoryText(state), state.locale, state.maxClipSeconds, state.minClipSeconds);
  const estimated = estimateDuration(combinedStoryText(state));
  const estimatedSegments = segmentCountFor(estimated, state.maxClipSeconds, state.minClipSeconds);
  const prefilledSegments = state.prefilledDuration ? segmentCountFor(state.prefilledDuration, state.maxClipSeconds, state.minClipSeconds) : 0;
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
      ...rateWarnings,
      state.prefilledDuration
        ? `我从你前面的文字里识别到 ${state.prefilledDuration} 秒（约 ${prefilledSegments} 段）；回复 "默认/自动" 就用这个。也可以重新告诉我：${formatDurationChoices(state)}。`
        : `请告诉我视频总长度，例如：${formatDurationChoices(state)}；想让我根据剧本和素材决定就回复 "自动"（建议 ${estimated} 秒，约 ${estimatedSegments} 段）。`,
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
    ...rateWarnings,
    state.prefilledDuration
      ? `I detected ${state.prefilledDuration}s earlier (about ${prefilledSegments} segment${prefilledSegments === 1 ? '' : 's'}); reply "default/auto" to use that, or give a new duration: ${formatDurationChoices(state)}.`
      : `How long should the video be? For example ${formatDurationChoices(state)}; or reply "auto" and I'll choose from the complete script/materials (suggesting ${estimated}s, about ${estimatedSegments} segment${estimatedSegments === 1 ? '' : 's'}).`,
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
  const projectId = `video-${Date.now()}`;
  const sanitizedAccumulated = state.accumulatedStory.map((s) => sanitizeForVideoProvider(s));
  const aiScreenwriterSeed = state.aiScreenwriterMode === true;
  const preserveUserScript = hasExplicitUserScriptText(sanitizedAccumulated) && !aiScreenwriterSeed;
  const cleanDirect = wantsCleanDirectMode([state.originalText, ...sanitizedAccumulated]);
  const rawPassthrough = wantsRawPassthrough([state.originalText, ...sanitizedAccumulated]);
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
        '[Narrative Entity Map — pass this through to generate_long_video as `narrativeEntities` so the shot planner and story check can use it]',
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
    state.resolution ? `resolution: ${JSON.stringify(state.resolution)}` : '',
    preserveUserScript ? 'preserveUserScript: true' : '',
    aiScreenwriterSeed ? 'aiScreenwriterMode: true' : '',
    cleanDirect ? 'cleanDirect: true' : '',
    rawPassthrough ? 'rawPassthrough: true' : '',
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
    'Before calling the tool, act as the long-video producer with cinematic discipline:',
    '0. USER REFERENCE IMAGE RULE — If the user supplied an image and described it as a character/person/form/avatar/image/形象/角色/人物, treat that image as the GLOBAL CHARACTER IDENTITY reference, not merely as a first-frame scene. Extract the subject identity from the image and carry it through every shot. Do not replace the subject with unrelated real people.',
    '1. CHARACTER IDENTITY LOCK — Character/person consistency is a GLOBAL HARD RULE. If a person, character, mascot, user-provided new image, or recurring subject appears in this long video, lock their face, age, ethnicity/species, build, hair, distinguishing features, silhouette, and wardrobe/material cues across every shot unless the user explicitly asks for transformation or multiple different identities.',
    aiScreenwriterSeed ? '1a. AI SCREENWRITER MODE — The user explicitly asked Artemis/AI to create the story from partial inspiration. Expand sparse notes into a complete cinematic plot with clear beginning, development, climax/payoff, and shot-level visible action. Preserve concrete anchors; do not treat the seed as a finished script.' : '',
    '1b. INTENT-AWARE NARRATIVE EXPANSION — You MUST prioritize user-specified anchors (scene changes, wardrobe, specific events). If the user provided script segments, use them as hard visual anchors. If the user is silent about a duration, you are ENCOURAGED to "hallucinate" and expand the story logically, but do NOT execute unauthorized teleportation (scene jumps) unless it serves a thematic or specified purpose. Your "imagination" should fill the non-specified gaps (background activity, physics, secondary actions) while respecting the primary scene continuity established by the user.',
    '2. CONTINUITY MODE — The pipeline auto-selects strong-vision (image-ref capable) vs text-only based on the configured model. You do not configure this.',
    preserveUserScript
      ? '3. SHOTS — The user supplied an explicit script. Do NOT replace, rewrite, or substitute the plot. If you provide a shots array, each storyBeat must be a faithful slice of the user script in the same order; only add camera/motion detail around the original action.'
      : '3. SHOTS — Plan a structured shots array. Each shot: title, duration, storyBeat, visualPrompt, camera, continuity, transition, optional transitionKind.',
    '3a. MOTION REQUIREMENT (CRITICAL — videos look "AI-dead" without this) — storyBeat MUST be a TIMELINE of physical actions, not a static description. Use this format:',
    '    "0–Xs: [character] [action verb in present-tense] [body part / object]; [environmental motion]. Xs–Ys: [next action verb] [next change]. Ys–end: [resolving action]."',
    '    Action verbs (use these — not "stands", "is", "looks"): walks, steps, turns, lifts, reaches, drops, catches, leaps, kneels, scatters, spins, opens, closes, pushes, pulls, rises, descends, glides, twirls, summons, releases, shatters.',
    '    Always include continuous environmental motion when the story actually contains moving elements: hair tossed by wind, fabric/cape flowing, particles drifting, rain streaks, fog rolling, light flickering, water rippling, dust motes, leaves falling, fireflies, mist rising, smoke curling. Do not force camera motion or background motion when the user explicitly locks the camera or wants a static tableau. In multi-city walking scenes, keep the camera stable and let only the subject and environment move naturally.',
    '    Always describe at least ONE deliberate body movement per ~3 s of clip duration — never let a shot be a single static pose.',
    `    Each shot is ONE generated clip of at most ${state.maxClipSeconds} s. Use the fewest shots that fit: ${segmentCountFor(targetDuration, state.maxClipSeconds, state.minClipSeconds)} shot(s) of roughly equal length for ${targetDuration} s. Inside a long shot, write several physical action beats on its timeline instead of holding one pose.`,
    '    storyBeat may NOT be: identity-preservation rules, generic continuity language, or "the character stands/sits/looks" with no movement. The pipeline rejects boilerplate storyBeats and falls back to story chunks.',
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
    '8. PHYSICS & FAILURE GUARDS — The aesthetic lock auto-appends physics anchors (no morphing/flickering/melting, anatomically correct).',
    '9. SCENE-JUMP HANDLING — When the story has a hard location jump, insert at least one transition shot that bridges the two locations through a shared visual element.',
    `10. DURATIONS — Shot durations must add up to the requested totalDuration; each shot must be at most ${state.maxClipSeconds} s (a timecoded user segment that is longer is split by the pipeline, never shortened).`,
    `11. SUBTITLE MODE — User selected ${state.subtitleMode ?? 'auto'}: ${state.subtitleMode === 'always' ? 'render readable subtitles/captions for dialogue and voiceover, preserving original text/language.' : state.subtitleMode === 'off' ? 'do not render dialogue as on-screen subtitles; keep dialogue as audio/lip-sync unless the user explicitly authored a subtitle line.' : 'only add subtitles/on-screen text when the user explicitly requested them.'}`,
  );

  if (state.scope === 'bridge' && state.deliveryPlatform) {
    const sendArgs = [
      state.deliveryPlatform ? `platform: ${JSON.stringify(state.deliveryPlatform)}` : undefined,
      state.deliveryTargetId ? `targetId: ${JSON.stringify(state.deliveryTargetId)}` : undefined,
      `caption: ${JSON.stringify(pickLocale(state.locale, { zh: '🎬 长视频已生成', en: '🎬 Your long video is ready' }))}`,
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
    `If you call generate_video instead of generate_long_video, the result will be a single short clip (capped at ${state.maxClipSeconds}s by the configured video model) that ignores the long-video continuity engine, transitions, and audio normalization, and the user will see a broken output. This is a hard failure mode.`,
    'The long-video pipeline is the only correct path for this request. generate_long_video. Not generate_video. generate_long_video.',
    'When you talk to the user, say 「制作长视频」 / "making your long video"; never name this workflow, the tool, the pipeline, the model or the provider.',
    '═══════════════════════════════════════════════════════════════',
  );

  return lines.join('\n');
}

/** The brief's CHARACTER LOCK / 色彩 / 光照 / 镜头机位 / VIBE lines (guide §6) as the action's continuity locks. */
function continuityFromBrief(story: string): Extract<AgentAction, { type: 'generate_long_video' }>['continuity'] | undefined {
  const globals = parseSagaBriefGlobals(stripBriefNoise(story));
  const continuity = {
    ...(globals.characters.length > 0 ? { characters: globals.characters } : {}),
    ...(globals.palette.length > 0 ? { palette: globals.palette } : {}),
    ...(globals.lighting ? { lighting: globals.lighting } : {}),
    ...(globals.cameraLanguage ? { cameraLanguage: globals.cameraLanguage } : {}),
    ...(globals.mood ? { mood: globals.mood } : {}),
  };
  return Object.keys(continuity).length > 0 ? continuity : undefined;
}

function buildGenerationAction(state: SagaWorkflowState): Extract<AgentAction, { type: 'generate_long_video' }> {
  const prompt = buildGenerationPrompt(state);
  const fullStory = sanitizeForVideoProvider(combinedStoryText(state));
  const sanitizedAccumulated = state.accumulatedStory.map((s) => sanitizeForVideoProvider(s));
  const preserveUserScript = hasExplicitUserScriptText(sanitizedAccumulated);
  // cleanDirect is opt-in via the guide's keywords (raw-seedance / 原始质感 /
  // etc.) and raw passthrough via an explicit "[原样直传]" tag. Neither is
  // implied by preserveUserScript ("don't rewrite my text"): coupling them
  // silently broke detailed timecoded briefs by removing every quality lock.
  const cleanDirect = wantsCleanDirectMode([state.originalText, ...sanitizedAccumulated]);
  const rawPassthrough = wantsRawPassthrough([state.originalText, ...sanitizedAccumulated]);
  const targetDuration = clampDuration(state.targetDuration ?? state.prefilledDuration) ?? estimateDuration(fullStory);
  const ratio = state.ratio ?? state.suggestedRatio ?? extractRatio(fullStory) ?? '16:9';
  const briefContinuity = continuityFromBrief(fullStory);
  const projectIdMatch = prompt.match(/^projectId:\s*"([^"]+)"/m);
  const projectId = projectIdMatch?.[1] ?? `video-${Date.now()}`;

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
    ...(state.resolution ? { resolution: state.resolution } : {}),
    preserveUserScript,
    cleanDirect,
    ...(rawPassthrough ? { rawPassthrough: true } : {}),
    ...(briefContinuity ? { continuity: briefContinuity } : {}),
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

function newState(input: SagaWorkflowInput, profile: VideoModelProfile): SagaWorkflowState {
  const multimodalCapable = profile.referenceInputs.some((kind) => kind === 'image' || kind === 'video' || kind === 'audio');
  return {
    scope: input.scope,
    cwd: input.cwd,
    originalText: input.text.trim(),
    stage: 'awaiting_subject_mode',
    multimodalCapable,
    maxClipSeconds: profile.maxClipSeconds,
    minClipSeconds: profile.minClipSeconds,
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

  // ─── answer to a Saga offer ─────────────────────────────────────────
  const offer = PENDING_SAGA_OFFERS.get(key);
  if (offer) {
    PENDING_SAGA_OFFERS.delete(key);
    const answer = input.forceIntent ? undefined : parseSagaOfferReply(text);
    if (answer === 'yes') {
      const started = await handleSagaLongVideoWorkflow({
        ...input,
        text: offer.text,
        imageAttachments: offer.imageAttachments ?? input.imageAttachments,
        forceIntent: true,
      });
      return started.handled || started.prompt || started.action
        ? started
        : { handled: false, replayText: offer.text };
    }
    if (answer === 'no') return { handled: false, replayText: offer.text };
    // Anything else is a new message: the offer lapses and it is handled below.
  }

  const state = WORKFLOWS.get(key);

  // ─── continuing an active workflow ──────────────────────────────────
  if (state) {
    if (input.locale) state.locale = input.locale;

    // A message that is only a resolution choice sets it and leaves the
    // current step as it was.
    const requestedResolution = extractRequestedResolution(text);
    if (requestedResolution) {
      state.resolution = requestedResolution;
      state.updatedAt = Date.now();
      return { handled: true, reply: pickLocale(state.locale, {
        zh: `已记下：所有分段按 ${requestedResolution} 生成。请继续回答上一步的问题。`,
        en: `Noted: every segment will be generated at ${requestedResolution}. Please continue with the previous question.`,
      }) };
    }

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
      await mergeRefs(state, refs);
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
        return enterRatioStep(state);
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
      await mergeRefs(state, refs);
      // Move newly-merged reference images into the turnaround bucket so
      // they're tagged correctly for downstream (`identitySource: 'turnaround'`
      // tells generateLongVideo to skip superVisual generation).
      if (state.referenceImagePaths.length > 0 || state.referenceImageUrls.length > 0) {
        state.turnaroundImagePaths = await appendImagePathsByContent(state.turnaroundImagePaths, state.referenceImagePaths);
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
      await mergeRefs(state, refs);
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
      await mergeStoryboardRefs(state, refs);
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
      return enterRatioStep(state);
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
        // The ratio note above this menu invites a different ratio here.
        const ratioChange = text.length <= 40 ? normalizeAspectRatio(text) : undefined;
        if (ratioChange) {
          state.ratio = ratioChange;
          const note = pickLocale(state.locale, {
            zh: `📐 画幅已改为 ${formatRatioLabel(ratioChange, state.locale)}。`,
            en: `📐 Aspect ratio changed to ${formatRatioLabel(ratioChange, state.locale)}.`,
          });
          return { handled: true, reply: `${note}\n\n${buildSubtitleModeAskMessage(state)}` };
        }
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
      if ((state.soundtrackPath || state.soundtrackUrl) && !hasBgmParamUpdates(applied.inlineParams ?? {})) {
        state.stage = 'awaiting_bgm_settings';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildBgmSettingsAskMessage(state) };
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
      if ((state.soundtrackPath || state.soundtrackUrl) && !hasBgmParamUpdates(applied.inlineParams ?? {})) {
        state.stage = 'awaiting_bgm_settings';
        state.updatedAt = Date.now();
        return { handled: true, reply: buildBgmSettingsAskMessage(state) };
      }
      WORKFLOWS.delete(key);
      const action = buildGenerationAction(state);
      return { handled: false, prompt: action.prompt, action };
    }

    if (state.stage === 'awaiting_bgm_settings') {
      const trimmed = text.trim();
      if (BGM_SETTINGS_DEFAULT_RE.test(trimmed)) {
        WORKFLOWS.delete(key);
        const action = buildGenerationAction(state);
        return { handled: false, prompt: action.prompt, action };
      }
      const params = extractBgmParamUpdates(text);
      if (hasBgmParamUpdates(params)) {
        applyBgmParamsToState(state, params);
        WORKFLOWS.delete(key);
        const action = buildGenerationAction(state);
        return { handled: false, prompt: action.prompt, action };
      }
      state.updatedAt = Date.now();
      return { handled: true, reply: pickLocale(state.locale, {
        zh: ['❓ 没识别到混音参数，也不是 “默认”。请按下方提示重新输入，或回复 “默认”。', '', buildBgmSettingsAskMessage(state)].join('\n'),
        en: ['❓ Could not parse any mix options, and the reply was not "default". Use the formats below, or reply "default" to proceed.', '', buildBgmSettingsAskMessage(state)].join('\n'),
      }) };
    }
  }

  // ─── fresh request ──────────────────────────────────────────────────
  // Saga must never start from ordinary chat keywords ("图片", "视频",
  // "长视频", "long video", etc.). Fresh Saga entry is gated by the caller:
  // forceIntent=true comes from an explicit /saga command or from a clear
  // long multi-segment video request (isClearSagaLongVideoRequest). Once a
  // Saga workflow is active, follow-up replies above can continue the wizard.
  // An explicit /saga always starts the wizard. The support-discussion
  // classifier must not veto it: real timecoded briefs are full of "视频",
  // "短片", "生成" and question marks in dialogue, and a vetoed brief fell
  // through to the plain agent, which lost the identity-source choice.
  if (!input.forceIntent) {
    return { handled: false };
  }
  const profile = await resolveActiveVideoProfile(input.cwd);
  if (!profile) return { handled: false };

  const next = newState(input, profile);

  // Even on the first turn, if the user already attached references in this
  // very message (Telegram image / inline URL), we want to capture them.
  if (next.multimodalCapable) {
    const refs = await classifyReferences(next.cwd, text, input.imageAttachments);
    await mergeRefs(next, refs);
  }

  next.stage = 'awaiting_subject_mode';
  WORKFLOWS.set(key, next);
  const declared = applyDeclaredSubjectAndIdentity(next);
  if (declared) return { handled: true, reply: declared };
  return { handled: true, reply: buildSubjectModeAskMessage(next) };
}

// Guide §9.6: "主体模式：有主角。身份来源：纯文字。" / "Subject mode: pure visual."
// Guide §9.6 declarations. Only a line that starts with the label counts, in
// the brief's header (before the first timecoded segment), and only when the
// value is exactly one of the options; the same words inside story prose
// ("档案上写着：身份来源：照片") do not switch anything.
const DECLARED_LABEL_RE = /^(?<label>主体模式|身份来源|subject\s*mode|identity\s*source)\s*[:：]\s*(?<value>[^。；;\n]*?)\s*(?:[。.；;]|$)/i;
const SUBJECT_VALUE_RE = /^(?:有主角|纯视觉(?:\s*\/\s*无主角)?|无主角|has\s+(?:a\s+)?protagonist|pure\s+visual(?:\s*\/\s*no\s+protagonist)?|no\s+protagonist)$/i;
const IDENTITY_VALUE_RE = /^(?:(?:角色)?三视图(?:参考图)?|角色图|人物图|人物照片|照片|直接(?:用)?图片|纯文字|文字描述|turnaround(?:\s+(?:reference\s+)?sheet)?|three[-\s]?view(?:\s+sheet)?|character\s+(?:image|photo)|photo|direct\s+image|text[-\s]?only)$/i;

function declaredSubjectAndIdentity(text: string): { subject?: string; identity?: string } {
  const header = text.split(/^\s*\[\s*\d+(?::\d{1,2}){0,2}(?:\.\d+)?\s*(?:秒|s|sec|seconds)?\s*[-–—~至到]/m)[0] ?? '';
  const out: { subject?: string; identity?: string } = {};
  for (const rawLine of header.split(/\r?\n/)) {
    // "主体模式：有主角。身份来源：纯文字。" declares both on one line.
    let rest = rawLine.replace(/^\s*[·•*-]?\s*/, '');
    for (let match = rest.match(DECLARED_LABEL_RE); match?.groups; match = rest.match(DECLARED_LABEL_RE)) {
      const value = match.groups.value!.trim();
      const isSubject = /主体模式|subject/i.test(match.groups.label!);
      if (isSubject && SUBJECT_VALUE_RE.test(value)) out.subject ??= value.toLowerCase();
      if (!isSubject && IDENTITY_VALUE_RE.test(value)) out.identity ??= value.toLowerCase();
      rest = rest.slice(match[0].length).replace(/^[^。.；;\n]*?(?=主体模式|身份来源|subject\s*mode|identity\s*source|$)/i, '');
      if (!rest) break;
    }
  }
  return out;
}

/**
 * Applies a subject mode / identity source the brief declares up front, so
 * those questions are not asked. Returns the next reply, or undefined when
 * the brief declares neither.
 */
function applyDeclaredSubjectAndIdentity(state: SagaWorkflowState): string | undefined {
  const { subject, identity } = declaredSubjectAndIdentity(state.originalText);
  if (!subject && !identity) return undefined;
  const note = (zh: string, en: string) => pickLocale(state.locale, { zh: `📋 已按剧本设定：${zh}`, en: `📋 Taken from your brief: ${en}` });
  if (subject && /纯视觉|无主角|pure|no\s+protagonist/.test(subject)) {
    markAbstractPreference(state);
    state.stage = 'collecting_refs';
    return `${note('纯视觉（无主角）。', 'pure visual (no protagonist).')}\n\n${buildRefIntroMessage(state)}`;
  }
  // An identity source implies a protagonist.
  if (!identity) {
    if (!state.multimodalCapable) {
      state.identitySource = 'text_only';
      state.stage = 'collecting_refs';
      return `${note('有主角。', 'has a protagonist.')}\n\n${buildRefIntroMessage(state)}`;
    }
    state.stage = 'awaiting_identity_source';
    return `${note('有主角。', 'has a protagonist.')}\n\n${buildIdentitySourceAskMessage(state)}`;
  }
  if (/纯文字|文字描述|text/.test(identity) || !state.multimodalCapable) {
    state.identitySource = 'text_only';
    state.referenceImagePaths = [];
    state.referenceImageUrls = [];
    state.stage = 'collecting_refs';
    return `${note('有主角 · 身份来源：纯文字。', 'has a protagonist · identity source: text only.')}\n\n${buildRefIntroMessage(state)}`;
  }
  if (/三视图|turnaround|three/.test(identity)) {
    state.identitySource = 'turnaround';
    state.stage = 'awaiting_turnaround_upload';
    return `${note('有主角 · 身份来源：三视图。', 'has a protagonist · identity source: turnaround sheet.')}\n\n${buildTurnaroundUploadMessage(state)}`;
  }
  if (/直接|direct/.test(identity)) {
    state.identitySource = 'direct_image';
    state.stage = 'awaiting_character_image_upload';
    return `${note('有主角 · 身份来源：直接用图片。', 'has a protagonist · identity source: image used directly.')}\n\n${buildDirectImageUploadMessage(state)}`;
  }
  state.identitySource = 'character_image';
  state.stage = 'awaiting_character_image_upload';
  return `${note('有主角 · 身份来源：角色图。', 'has a protagonist · identity source: character image.')}\n\n${buildCharacterImageUploadMessage(state)}`;
}
