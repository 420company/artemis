import { homedir } from 'node:os';
import { ProviderStore } from '../providers/store.js';
import type { ProviderProfile, VisualModelConfig } from '../providers/types.js';

export type VisualAssetKind = 'image' | 'video';

export type ConfiguredVisualProvider = {
  config: VisualModelConfig;
  assetKind: VisualAssetKind;
  provider: string;
  model: string;
  source: string;
};

export type VisualFallbackCandidate = ConfiguredVisualProvider & {
  profileId: string;
  label: string;
};

export type VisualGenerationNeed = {
  image: boolean;
  video: boolean;
};

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const VISUAL_SETUP_REQUIRED_ERROR = 'ARTEMIS_VISUAL_SETUP_REQUIRED';

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

export function buildVisualSetupRequiredMessage(assetKind: VisualAssetKind): string {
  const toolName = assetKind === 'image' ? 'generate_image' : 'generate_video';
  const assetLabel = assetKind === 'image' ? 'image generation' : 'video generation';
  const zhAssetLabel = assetKind === 'image' ? '图片生成' : '视频生成';

  return buildAsciiPanel('Visual model unavailable / 视觉模型不可用', [
    `Status : Artemis cannot use ${assetLabel} now.`,
    `状态   : 当前无法使用${zhAssetLabel}。`,
    '',
    'What happened / 发生了什么',
    `  - Requested tool: ${toolName}`,
    '  - No usable visual API was found in workspace or home config.',
    '  - Artemis also tried eligible main/secondary providers before fallback.',
    '',
    'Quick repair / 快捷修复',
    '  artemis setup visual --repair',
    '',
    'Manual setup / 手动配置',
    '  1. Run: artemis setup visual',
    '  2. Choose: BytePlus / OpenAI / Google / Custom API',
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
        resolution: '1080p',
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
    case 'openai':
      return assetKind === 'image' ? 'gpt-image-2' : 'sora-2';
    case 'byteplus':
      return assetKind === 'image'
        ? 'seedream-5-0-260128'
        : 'seedance-1-5-pro-251215';
    case 'stable-diffusion':
      return assetKind === 'image'
        ? 'stable-diffusion-xl'
        : 'stable-video-diffusion';
    case 'gemini':
      return assetKind === 'image' ? 'gemini-2.5-flash-image' : 'none';
    case 'google':
      return assetKind === 'image'
        ? 'gemini-2.5-flash-image'
        : 'veo-3.0-generate-preview';
    case 'grok':
      return assetKind === 'image' ? 'grok-v1' : 'grok-video';
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
      return 'https://ark.ap-southeast.bytepluses.com/api/v3';
    case 'google':
    case 'gemini':
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
  const image = [
    /\b(generate|create|make|draw|render|produce|design)\b[\s\S]{0,80}\b(image|picture|photo|illustration|visual|asset|product shot)\b/i,
    /\b(image|picture|photo|illustration|visual|asset|product shot)\b[\s\S]{0,80}\b(generate|create|make|draw|render|produce|design)\b/i,
    /(?:生成|创建|制作|绘制|设计|渲染|产出|需要|用到|配)[\s\S]{0,80}(?:图片|图像|照片|插图|视觉|素材|配图|商品图|产品图)/i,
    /(?:图片|图像|照片|插图|视觉|素材|配图|商品图|产品图)[\s\S]{0,80}(?:生成|创建|制作|绘制|设计|渲染|产出|需要|用到)/i,
    /(?:商品配图|产品配图|产品摄影|商品摄影|产品拍摄|商品拍摄|海报|封面|banner|hero image)/i,
  ].some((pattern) => pattern.test(text));

  const video = [
    /\b(generate|create|make|render|produce|design)\b[\s\S]{0,80}\b(video|movie|clip|animation|motion)\b/i,
    /\b(video|movie|clip|animation|motion)\b[\s\S]{0,80}\b(generate|create|make|render|produce|design)\b/i,
    /(?:生成|创建|制作|设计|渲染|产出|需要|用到)[\s\S]{0,80}(?:视频|短片|动画|动效|片段)/i,
    /(?:视频|短片|动画|动效|片段)[\s\S]{0,80}(?:生成|创建|制作|设计|渲染|产出|需要|用到)/i,
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
