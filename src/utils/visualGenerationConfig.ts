import { homedir } from 'node:os';
import { ProviderStore, isOwnKeyProfile } from '../providers/store.js';
import type { ProviderProfile, VisualModelConfig } from '../providers/types.js';
import { DEFAULT_MODEL_IDS } from '../providers/presets.js';
import { isSeedance25Model, isSeedance2Model } from '../tools/visual/videoCapabilities.js';

export type VisualAssetKind = 'image' | 'video';

export type ConfiguredVisualProvider = {
  config: VisualModelConfig;
  assetKind: VisualAssetKind;
  provider: string;
  model: string;
  source: string;
  /** When true, this provider accepts NSFW/adult content without filtering. */
  nsfw?: boolean;
  /**
   * Whether this provider takes a real person as a reference without
   * refusing it. Two different questions get confused here, so they are kept
   * apart: adult content (nsfw) and a real human face (this).
   *
   * BytePlus's official API filters real people with an image classifier, so
   * a photo of one has to reach the video model as an illustrated
   * identity-only sheet (superVisualMode.ts, style 'illustrated'); the
   * keyframes then pull the look back to photographic. router.ai takes the
   * person directly, and stylising there would throw away the likeness for
   * nothing.
   *
   * Default: allowed, except for the providers known to filter. Guessing
   * "allowed" wrongly costs one visible refusal, which the run reports;
   * guessing "filtered" wrongly turns the owner's real person into a cartoon
   * and nobody finds out why. The visible failure is the better trade.
   */
  realPerson?: boolean;
  /**
   * Whether the model would refuse adult content. Not the same as the slot's
   * `nsfw` flag, which is the owner asking for their words to go through as
   * written; this only says the route would not reject them.
   */
  nsfwCapable?: boolean;
};

/** Providers whose own filter refuses a real person as a reference. */
const REAL_PERSON_FILTERED = new Set(['byteplus']);

/**
 * Whether the model behind this slot would refuse adult content. Three
 * different questions get confused around the word "nsfw", so they are kept
 * apart here:
 *
 *   nsfwCapable (this) — the provider and model do not refuse it. router.ai's
 *     Seedance 2.0 Pro does not; BytePlus's official API does.
 *   realPersonAllowed — the provider does not refuse a real human face.
 *   the slot's own `nsfw` flag — the owner asking for their words to reach
 *     the model as written, with the Director's cinematic spec left off. That
 *     changes how every video on the route looks, so it stays theirs to set
 *     and is never turned on from a capability.
 */
export function nsfwCapable(slot: { provider: string; model?: string; nsfw?: boolean }): boolean {
  if (slot.nsfw === true) return true;
  const provider = slot.provider.trim().toLowerCase();
  if (REAL_PERSON_FILTERED.has(provider)) return false;
  // router.ai serves Seedance 2.0 (Pro) without the official API's filters.
  if (provider === 'routerai') return isSeedance2Model(slot.model) || isSeedance25Model(slot.model);
  return false;
}

/** Whether this slot takes a real person; nsfw implies it does. */
export function realPersonAllowed(slot: { provider: string; model?: string; nsfw?: boolean; realPerson?: boolean }): boolean {
  if (typeof slot.realPerson === 'boolean') return slot.realPerson;
  if (slot.nsfw === true) return true;
  // A model that takes adult content certainly takes a face.
  if (nsfwCapable(slot)) return true;
  return !REAL_PERSON_FILTERED.has(slot.provider.trim().toLowerCase());
}

export type VisualFallbackCandidate = ConfiguredVisualProvider & {
  profileId: string;
  label: string;
};

export type VisualGenerationNeed = {
  image: boolean;
  video: boolean;
};

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const BYTEPLUS_VISUAL_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3';
export const BYTEPLUS_VIDEO_TASKS_ENDPOINT = `${BYTEPLUS_VISUAL_BASE_URL}/contents/generations/tasks`;
export const VISUAL_SETUP_REQUIRED_ERROR = 'ARTEMIS_VISUAL_SETUP_REQUIRED';

export type BytePlusVideoPreset = {
  id: 'seedance-2-pro' | 'seedance-2-fast' | 'seedance-1-5-pro';
  label: { zh: string; en: string };
  description: { zh: string; en: string };
  model: string;
  baseUrl: string;
  endpoint: string;
  defaultParams: {
    duration: '5s' | '7s' | '10s' | '15s';
    resolution: '720p' | '1080p';
    framerate: '24fps';
  };
};

export const BYTEPLUS_VIDEO_PRESETS: readonly BytePlusVideoPreset[] = [
  {
    id: 'seedance-2-pro',
    label: { zh: 'Seedance 2.0 Pro', en: 'Seedance 2.0 Pro' },
    description: {
      zh: '专业级多模态视频创作，适合需要图像、视频、音频与文本共同塑造画面的作品。',
      en: 'Professional multimodal video creation with coordinated text, image, video, and audio references.',
    },
    model: 'dreamina-seedance-2-0-260128',
    baseUrl: BYTEPLUS_VISUAL_BASE_URL,
    endpoint: BYTEPLUS_VIDEO_TASKS_ENDPOINT,
    defaultParams: { duration: '10s', resolution: '720p', framerate: '24fps' },
  },
  {
    id: 'seedance-2-fast',
    label: { zh: 'Seedance 2.0 Fast', en: 'Seedance 2.0 Fast' },
    description: {
      zh: '面向高频创作与快速成片流程，保留 Seedance 2.0 的多模态参考能力。',
      en: 'Optimized for high-tempo creation workflows while preserving Seedance 2.0 multimodal references.',
    },
    model: 'dreamina-seedance-2-0-fast-260128',
    baseUrl: BYTEPLUS_VISUAL_BASE_URL,
    endpoint: BYTEPLUS_VIDEO_TASKS_ENDPOINT,
    defaultParams: { duration: '10s', resolution: '720p', framerate: '24fps' },
  },
  {
    id: 'seedance-1-5-pro',
    label: { zh: 'Seedance 1.5 Pro', en: 'Seedance 1.5 Pro' },
    description: {
      zh: '成熟稳定的图文生视频模型，适合脚本驱动、首帧参考与商业短片制作。',
      en: 'A mature text and image guided video model for scripted clips, first-frame reference, and commercial production.',
    },
    model: 'seedance-1-5-pro-251215',
    baseUrl: BYTEPLUS_VISUAL_BASE_URL,
    endpoint: BYTEPLUS_VIDEO_TASKS_ENDPOINT,
    defaultParams: { duration: '10s', resolution: '720p', framerate: '24fps' },
  },
];

export function getBytePlusVideoPreset(model: string | undefined): BytePlusVideoPreset | undefined {
  const normalized = model?.trim();
  if (!normalized) return undefined;
  return BYTEPLUS_VIDEO_PRESETS.find((preset) => preset.model === normalized);
}

function isEnabledFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

function hasApiKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isVisualSetupRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(VISUAL_SETUP_REQUIRED_ERROR) || /visual .*credentials not found|credentials not found/i.test(message);
}

/**
 * Policy appended to a request that needs images or video when no visual API
 * is configured: say so and how to configure it, never fall back to web images.
 */
export const VISUAL_NOT_CONFIGURED_POLICY =
  '[Visual generation policy]\nImage/video generation is not configured, so generate_image and generate_video will fail. ' +
  'If the task needs generated images or video, tell the user that image generation is not configured and that they can set it up with /visual ' +
  '(or /config visual, or `artemis setup visual` in a shell) and retry. Do not substitute web-search or downloaded images unless the user explicitly asks for them, ' +
  'and never claim an asset was generated. Vector-native graphics (icons, logos, charts, diagrams) may still be authored as SVG/CSS; ' +
  'do not write scripts that draw placeholder photos.';

export function buildVisualSetupRequiredMessage(assetKind: VisualAssetKind): string {
  const assetLabel = assetKind === 'image' ? 'image generation' : 'video generation';
  const zhAssetLabel = assetKind === 'image' ? '图片生成' : '视频生成';

  return buildAsciiPanel('Visual model unavailable / 视觉模型不可用', [
    `Status : Artemis cannot use ${assetLabel} now.`,
    `状态   : 当前无法使用${zhAssetLabel}。`,
    '',
    'What happened / 发生了什么',
    '  - No usable visual API was found in workspace or home config.',
    '  - Artemis also tried eligible main/secondary providers before fallback.',
    '',
    'Quick repair / 快捷修复',
    '  artemis setup visual --repair',
    '',
    'Manual setup / 手动配置',
    '  1. Run: artemis setup visual',
    '  2. Choose your image/video service provider',
    '  3. Enter: API Key, Base URL, image/video model name',
    '  4. Retry the generation request.',
    '',
    'Note / 说明',
    '  - Main chat API can be tested as fallback, but visual API is preferred.',
    '  - 主/副模型可作为回退测试；已配置的视觉模型永远优先。',
  ]);
}

function buildAsciiPanel(title: string, lines: string[]): string {
  const width = 72;
  const inner = width - 4;
  const topTitle = ` ${title} `;
  const topFill = Math.max(0, inner - topTitle.length);
  const out = [`╭${topTitle}${'─'.repeat(topFill)}╮`];
  for (const line of lines) {
    const safeLine = line.length > inner ? line.slice(0, inner - 1) + '…' : line;
    out.push(`│ ${safeLine}${' '.repeat(Math.max(0, inner - safeLine.length))} │`);
  }
  out.push(`╰${'─'.repeat(inner + 2)}╯`);
  return out.join('\n');
}

function inferVisualProvider(profile: ProviderProfile): string | null {
  const text = `${profile.label ?? ''} ${profile.baseUrl ?? ''} ${profile.model ?? ''}`.toLowerCase();
  if (text.includes('byteplus') || text.includes('bytepluses.com') || text.includes('volces')) return 'byteplus';
  if (text.includes('generativelanguage.googleapis.com') || text.includes('google') || text.includes('gemini')) return 'google';
  if (text.includes('openai.com') || text.includes('gpt-image') || text.includes('sora')) return 'openai';
  if (profile.protocol === 'openai') return 'custom';
  return null;
}

function visualConfigFromProviderProfile(profile: ProviderProfile, assetKind: VisualAssetKind): VisualModelConfig | null {
  // The owner's own model key covers chat calls only: images and videos stay on the platform's routes.
  if (isOwnKeyProfile(profile)) return null;
  if (!hasApiKey(profile.apiKey) || !profile.baseUrl?.trim() || !profile.model?.trim()) return null;
  const provider = inferVisualProvider(profile);
  if (!provider) return null;
  const model = profile.model.trim();
  return {
    enabled: true,
    image: {
      provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: assetKind === 'image' ? model : defaultVisualModelForProvider(provider, 'image'),
      defaultParams: {
        size: '1024x1024',
        quality: 'standard',
        style: 'realistic',
        watermark: false,
      },
    },
    video: {
      enabled: assetKind === 'video',
      provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: assetKind === 'video' ? model : defaultVisualModelForProvider(provider, 'video'),
      defaultParams: {
        duration: '10s',
        resolution: '720p',
        quality: 'standard',
        style: 'realistic',
        format: 'mp4',
        framerate: '30fps',
        watermark: false,
      },
    },
  };
}

export function defaultVisualModelForProvider(
  provider: string,
  assetKind: VisualAssetKind,
): string {
  switch (provider.toLowerCase()) {
    case 'luna':
    case 'router':
      return assetKind === 'image' ? 'gpt-image-2' : DEFAULT_MODEL_IDS.byteplusVideo;
    case 'openai':
      return assetKind === 'image' ? 'gpt-image-2' : 'sora-2';
    case 'byteplus':
      return assetKind === 'image'
        ? DEFAULT_MODEL_IDS.byteplusImage
        : DEFAULT_MODEL_IDS.byteplusVideo;
    case 'google':
      return assetKind === 'image'
        ? 'gemini-3-pro-image-preview'
        : 'veo-3.1-generate-preview';
    case 'mock':
      return assetKind === 'image' ? 'mock-image' : 'mock-video';
    default:
      return assetKind === 'image' ? 'custom-image' : 'custom-video';
  }
}

export function defaultVisualBaseUrlForProvider(provider: string): string {
  switch (provider.toLowerCase()) {
    case 'openai':
      return OPENAI_BASE_URL;
    case 'byteplus':
      return BYTEPLUS_VISUAL_BASE_URL;
    case 'luna':
    case 'router':
      return 'https://api.router.ai/v1';
    case 'google':
      return 'https://generativelanguage.googleapis.com/v1beta';
    default:
      return '';
  }
}

export function describeVisualProvider(config: VisualModelConfig, assetKind: VisualAssetKind): string {
  const slot = assetKind === 'image' ? config.image : config.video;
  const model = slot.model || defaultVisualModelForProvider(slot.provider, assetKind);
  return `${slot.provider}/${model}`;
}

export function detectVisualGenerationNeed(input: string): VisualGenerationNeed {
  const text = input.toLowerCase();
  const imageNegated = /(?:不要|无需|不需要|别)[\s\S]{0,24}(?:生成|创建|制作|绘制|设计|渲染|产出|画)?[\s\S]{0,24}(?:图片|图像|照片|插图|视觉素材|配图|商品图|产品图|海报|封面|banner)/i.test(input) ||
    /\b(?:do\s+not|don't|dont|no\s+need\s+to|without)\b[\s\S]{0,40}\b(?:generate|create|make|draw|render|produce|design)?[\s\S]{0,40}\b(?:image|picture|photo|illustration|visual|asset|product shot)\b/i.test(text);
  const image = !imageNegated && [
    /\b(generate|create|make|draw|render|produce|design)\b[\s\S]{0,80}\b(image|picture|photo|illustration|visual|asset|product shot)\b/i,
    /\b(image|picture|photo|illustration|visual|asset|product shot)\b[\s\S]{0,80}\b(generate|create|make|draw|render|produce|design)\b/i,
    /(?:生成|创建|制作|绘制|设计|渲染|产出|画|画一张)[\s\S]{0,80}(?:图片|图像|照片|插图|视觉素材|配图|商品图|产品图|海报|封面|banner)/i,
    /(?:图片|图像|照片|插图|视觉素材|配图|商品图|产品图|海报|封面|banner)[\s\S]{0,80}(?:生成|创建|制作|绘制|设计|渲染|产出)/i,
    /(?:商品配图|产品配图|产品摄影|商品摄影|产品拍摄|商品拍摄|海报|封面|banner|hero image)/i,
  ].some((pattern) => pattern.test(text));

  const videoNegated = /(?:不要|无需|不需要|别)[\s\S]{0,24}(?:生成|创建|制作|设计|渲染|产出|剪辑?)?[\s\S]{0,24}(?:视频|短片|动画|动效)/i.test(input) ||
    /\b(?:do\s+not|don't|dont|no\s+need\s+to|without)\b[\s\S]{0,40}\b(?:generate|create|make|render|produce|design)?[\s\S]{0,40}\b(?:video|movie|clip|animation|motion)\b/i.test(text);
  const video = !videoNegated && [
    /\b(generate|create|make|render|produce|design)\b[\s\S]{0,80}\b(video|movie|clip|animation|motion)\b/i,
    /\b(video|movie|clip|animation|motion)\b[\s\S]{0,80}\b(generate|create|make|render|produce|design)\b/i,
    /(?:生成|创建|制作|设计|渲染|产出|剪|做)[\s\S]{0,80}(?:视频|短片|动画|动效)/i,
    /(?:视频|短片|动画|动效)[\s\S]{0,80}(?:生成|创建|制作|设计|渲染|产出|剪辑)/i,
  ].some((pattern) => pattern.test(text));

  return { image, video };
}

export function hasExplicitLocalVisualConsent(input: string): boolean {
  return [
    /(?:本地生成|本地生图|本地图片生成|本地视频生成|本地视觉|调用.*(?:生图|图片|视频).*api|api.*(?:生图|图片|视频)|使用.*(?:本地|配置).*视觉|尽量本地|尽量.*本地)/i,
    /\b(local|configured)\b[\s\S]{0,40}\b(image|video|visual|generation|api)\b/i,
    /\b(image|video|visual|generation|api)\b[\s\S]{0,40}\b(local|configured)\b/i,
  ].some((pattern) => pattern.test(input));
}

export function hasExplicitRemoteVisualFallback(input: string): boolean {
  return [
    /(?:不要.*本地|不用.*本地|禁用.*本地|网上搜索|网络搜索|搜索图片|搜索素材|用网上|线上素材|web\s*search|online\s+(image|asset))/i,
  ].some((pattern) => pattern.test(input));
}

export async function resolveConfiguredVisualProvider(
  cwd: string,
  assetKind: VisualAssetKind,
): Promise<ConfiguredVisualProvider | null> {
  const stores: Array<{ store: ProviderStore; source: string }> = [
    { store: new ProviderStore(cwd), source: 'workspace' },
  ];
  if (cwd !== homedir()) {
    stores.push({ store: new ProviderStore(homedir()), source: 'home' });
  }

  for (const { store, source } of stores) {
    let data;
    try {
      data = await store.load();
    } catch {
      continue;
    }
    const visualProfile = data.visualProfile;
    const slot = assetKind === 'image' ? visualProfile?.image : visualProfile?.video;
    const profileEnabled = isEnabledFlag(visualProfile?.enabled) || hasApiKey(slot?.apiKey);
    if (!visualProfile || !profileEnabled) {
      continue;
    }

    const videoEnabled = isEnabledFlag(visualProfile.video?.enabled) || hasApiKey(visualProfile.video?.apiKey);
    if (assetKind === 'video' && !videoEnabled) {
      continue;
    }
    if (!hasApiKey(slot?.apiKey)) {
      continue;
    }

    return {
      config: visualProfile,
      assetKind,
      provider: slot.provider,
      model: slot.model || defaultVisualModelForProvider(slot.provider, assetKind),
      source,
      nsfw: slot.nsfw === true,
      realPerson: realPersonAllowed({
        provider: slot.provider,
        model: slot.model || defaultVisualModelForProvider(slot.provider, assetKind),
        nsfw: slot.nsfw === true,
        ...(typeof (slot as { realPerson?: unknown }).realPerson === 'boolean' ? { realPerson: (slot as { realPerson?: boolean }).realPerson } : {}),
      }),
      nsfwCapable: nsfwCapable({
        provider: slot.provider,
        model: slot.model || defaultVisualModelForProvider(slot.provider, assetKind),
        nsfw: slot.nsfw === true,
      }),
    };
  }

  return null;
}

export async function resolveMainSecondaryVisualFallbackCandidates(
  cwd: string,
  assetKind: VisualAssetKind,
): Promise<VisualFallbackCandidate[]> {
  const stores: Array<{ store: ProviderStore; source: string }> = [
    { store: new ProviderStore(cwd), source: 'workspace' },
  ];
  if (cwd !== homedir()) stores.push({ store: new ProviderStore(homedir()), source: 'home' });

  const candidates: VisualFallbackCandidate[] = [];
  const seen = new Set<string>();
  for (const { store, source } of stores) {
    let data;
    try {
      data = await store.load();
    } catch {
      continue;
    }
    const ids = [data.defaultMainProfileId, data.specialistProfileId].filter(Boolean) as string[];
    for (const id of ids) {
      if (seen.has(`${source}:${id}`)) continue;
      const profile = store.getProfile(data, id);
      if (!profile) continue;
      const config = visualConfigFromProviderProfile(profile, assetKind);
      if (!config) continue;
      const slot = assetKind === 'image' ? config.image : config.video;
      candidates.push({
        config,
        assetKind,
        provider: slot.provider,
        model: slot.model,
        source,
        profileId: id,
        label: profile.label || id,
      });
      seen.add(`${source}:${id}`);
    }
  }
  return candidates;
}
