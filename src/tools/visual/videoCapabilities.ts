import type { VideoCapabilityDeclaration, VisualModelConfig } from '../../providers/types.js';

export type VideoReferenceKind = 'image' | 'video' | 'audio';

export type VideoModelCapabilities = {
  provider: string;
  model: string;
  referenceInputs: readonly VideoReferenceKind[];
  canGenerateAudio: boolean;
};

export type VideoReferenceRequest = {
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  referenceImagePaths?: string[];
  referenceVideoPaths?: string[];
  referenceAudioPaths?: string[];
  generateAudio?: boolean;
};

export const BYTEPLUS_SEEDANCE_2_PRO_MODEL = 'dreamina-seedance-2-0-260128';

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function hasReferenceUrls(action: VideoReferenceRequest, kind: VideoReferenceKind): boolean {
  const urls =
    kind === 'image'
      ? action.referenceImageUrls
      : kind === 'video'
        ? action.referenceVideoUrls
        : action.referenceAudioUrls;
  const paths =
    kind === 'image'
      ? action.referenceImagePaths
      : kind === 'video'
        ? action.referenceVideoPaths
        : action.referenceAudioPaths;
  return (
    (Array.isArray(urls) && urls.some((url) => typeof url === 'string' && url.trim().length > 0)) ||
    (Array.isArray(paths) && paths.some((localPath) => typeof localPath === 'string' && localPath.trim().length > 0))
  );
}

export function hasMultimodalVideoReferences(action: VideoReferenceRequest): boolean {
  return hasReferenceUrls(action, 'video') || hasReferenceUrls(action, 'audio');
}

export function requiresGeneratedAudio(action: VideoReferenceRequest): boolean {
  return action.generateAudio === true;
}

export function isBytePlusProvider(provider: string | undefined): boolean {
  return normalize(provider) === 'byteplus';
}

/** Seedance 2.5 (any vendor prefix: "dreamina-seedance-2-5-…", "seedance_2.5", "Seedance 2.5 Pro"). */
export function isSeedance25Model(model: string | undefined): boolean {
  return /seedance[-_ ]?2[._-]?5(?!\d)/i.test(model ?? '');
}

/** Seedance 2.0 only. Use isSeedance2xModel for the 2.x family. */
export function isSeedance2Model(model: string | undefined): boolean {
  const key = normalize(model);
  return key.includes('dreamina-seedance-2-0') || key.includes('seedance-2-0');
}

/** Seedance 2.0 or 2.5: multimodal references and generated audio. */
export function isSeedance2xModel(model: string | undefined): boolean {
  return isSeedance2Model(model) || isSeedance25Model(model);
}

export function isSeedance15Model(model: string | undefined): boolean {
  return normalize(model).includes('seedance-1-5');
}

/**
 * What the platform (or an operator) declares about the configured video
 * model, written as `visualProfile.video.capabilities` in providers.json.
 * Every field is optional and wins over the built-in table; `model`, when
 * set, limits the override to that model id.
 */
export type VideoCapabilityOverrides = VideoCapabilityDeclaration;

/** Everything Artemis needs to know about one video model, in one place. */
export type VideoModelProfile = {
  provider: string;
  model: string;
  family: 'seedance-2.5' | 'seedance-2.0' | 'seedance-1.5' | 'seedance-1.0' | 'wan' | 'other';
  minClipSeconds: number;
  /** L: the longest single clip. Requests up to L are one clip; longer ones are a long video. */
  maxClipSeconds: number;
  allowedDurations?: readonly number[];
  maxPromptChars: number;
  ratios: readonly string[];
  resolutions: readonly string[];
  referenceInputs: readonly VideoReferenceKind[];
  firstFrame: boolean;
  canGenerateAudio: boolean;
  /** 'platform' when an override changed anything. */
  source: 'builtin' | 'platform';
};

/**
 * Longest prompt Artemis sends a model. ModelArk publishes no figure for
 * Seedance; the Artemis App sent Seedance prompts of about 4,100 characters
 * in production, so 4,000 keeps a margin. Other models get the directed
 * prompt cap (videoDirector.ts), the longest prompt sent to them so far.
 */
const SEEDANCE_PROMPT_CHARS = 4000;
const DIRECTED_PROMPT_CHARS = 2600;
const SEEDANCE_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
const COMMON_RATIOS = ['16:9', '9:16', '1:1'] as const;
const RESOLUTIONS = ['480p', '720p', '1080p'] as const;
/** Unknown models: a conservative clip length most video APIs accept. */
const OTHER_MAX_CLIP_SECONDS = 10;

function builtinProfile(provider: string, model: string): Omit<VideoModelProfile, 'source'> {
  const key = normalize(model);
  const seedancePrompt = /seedance|dreamina/.test(key) ? SEEDANCE_PROMPT_CHARS : DIRECTED_PROMPT_CHARS;
  const base = { provider, model, maxPromptChars: seedancePrompt, resolutions: RESOLUTIONS };
  if (isSeedance25Model(model)) {
    return { ...base, family: 'seedance-2.5', minClipSeconds: 4, maxClipSeconds: 30, ratios: SEEDANCE_RATIOS, referenceInputs: ['image', 'video', 'audio'], firstFrame: true, canGenerateAudio: true };
  }
  if (isSeedance2Model(model)) {
    return { ...base, family: 'seedance-2.0', minClipSeconds: 4, maxClipSeconds: 15, ratios: SEEDANCE_RATIOS, referenceInputs: ['image', 'video', 'audio'], firstFrame: true, canGenerateAudio: true };
  }
  if (isSeedance15Model(model)) {
    return { ...base, family: 'seedance-1.5', minClipSeconds: 4, maxClipSeconds: 12, ratios: SEEDANCE_RATIOS, referenceInputs: ['image'], firstFrame: true, canGenerateAudio: true };
  }
  if (key.includes('seedance-1-0')) {
    return { ...base, family: 'seedance-1.0', minClipSeconds: 4, maxClipSeconds: 10, ratios: SEEDANCE_RATIOS, referenceInputs: ['image'], firstFrame: true, canGenerateAudio: false };
  }
  if (/^wan2\.[67]-/.test(key)) {
    const referenceInputs: VideoReferenceKind[] = key.includes('-r2v')
      ? ['image', 'video']
      : key.includes('-i2v') ? ['image'] : [];
    return {
      ...base,
      family: 'wan',
      minClipSeconds: 4,
      maxClipSeconds: 10,
      ratios: COMMON_RATIOS,
      referenceInputs,
      firstFrame: key.includes('-i2v'),
      canGenerateAudio: key.startsWith('wan2.6-') && key.includes('audio'),
    };
  }
  return { ...base, family: 'other', minClipSeconds: 4, maxClipSeconds: OTHER_MAX_CLIP_SECONDS, ratios: COMMON_RATIOS, referenceInputs: [], firstFrame: false, canGenerateAudio: false };
}

function positiveSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 600 ? Math.floor(value) : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim())
    ? value.map((item: string) => item.trim())
    : undefined;
}

/** The video profile of a provider/model, with the platform's overrides applied. */
export function resolveVideoModelProfile(
  provider: string,
  model: string,
  overrides?: VideoCapabilityOverrides,
): VideoModelProfile {
  const builtin = builtinProfile(provider, model);
  if (!overrides || (overrides.model && normalize(overrides.model) !== normalize(model))) {
    return { ...builtin, source: 'builtin' };
  }
  const maxClipSeconds = positiveSeconds(overrides.maxClipSeconds) ?? builtin.maxClipSeconds;
  const minClipSeconds = Math.min(positiveSeconds(overrides.minClipSeconds) ?? builtin.minClipSeconds, maxClipSeconds);
  const allowed = Array.isArray(overrides.allowedDurations)
    ? overrides.allowedDurations.map(positiveSeconds).filter((value): value is number => value !== undefined && value <= maxClipSeconds).sort((a, b) => a - b)
    : undefined;
  const referenceInputs = Array.isArray(overrides.referenceInputs)
    ? overrides.referenceInputs.filter((kind): kind is VideoReferenceKind => kind === 'image' || kind === 'video' || kind === 'audio')
    : undefined;
  return {
    ...builtin,
    minClipSeconds,
    maxClipSeconds,
    ...(allowed && allowed.length > 0 ? { allowedDurations: allowed } : {}),
    maxPromptChars: typeof overrides.maxPromptChars === 'number' && Number.isFinite(overrides.maxPromptChars) && overrides.maxPromptChars >= 200
      ? Math.floor(overrides.maxPromptChars)
      : builtin.maxPromptChars,
    ratios: stringList(overrides.ratios) ?? builtin.ratios,
    resolutions: stringList(overrides.resolutions)?.map((value) => value.toLowerCase()) ?? builtin.resolutions,
    referenceInputs: referenceInputs ?? builtin.referenceInputs,
    firstFrame: typeof overrides.firstFrame === 'boolean' ? overrides.firstFrame : builtin.firstFrame,
    canGenerateAudio: typeof overrides.canGenerateAudio === 'boolean' ? overrides.canGenerateAudio : builtin.canGenerateAudio,
    source: 'platform',
  };
}

/** The platform's declared capabilities for the configured video model, if any. */
export function videoCapabilityOverridesFromConfig(
  config: Partial<VisualModelConfig> | undefined,
): VideoCapabilityOverrides | undefined {
  const raw: unknown = config?.video?.capabilities;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as VideoCapabilityOverrides : undefined;
}

export function resolveVideoModelCapabilities(
  provider: string,
  model: string,
  overrides?: VideoCapabilityOverrides,
): VideoModelCapabilities {
  const profile = resolveVideoModelProfile(provider, model, overrides);
  return {
    provider,
    model,
    referenceInputs: profile.referenceInputs,
    canGenerateAudio: profile.canGenerateAudio,
  };
}

export function getUnsupportedVideoReferences(
  action: VideoReferenceRequest,
  capabilities: VideoModelCapabilities,
): VideoReferenceKind[] {
  const requested: VideoReferenceKind[] = [];
  if (hasReferenceUrls(action, 'image')) requested.push('image');
  if (hasReferenceUrls(action, 'video')) requested.push('video');
  if (hasReferenceUrls(action, 'audio')) requested.push('audio');
  return requested.filter((kind) => !capabilities.referenceInputs.includes(kind));
}

export function shouldPromoteBytePlusVideoModel(
  action: VideoReferenceRequest & { model?: string },
  config: VisualModelConfig,
): boolean {
  return (
    isBytePlusProvider(config.video.provider) &&
    !action.model?.trim() &&
    (hasMultimodalVideoReferences(action) || requiresGeneratedAudio(action)) &&
    !isSeedance2xModel(config.video.model)
  );
}

export function isGeneratedAudioUnsupported(
  action: VideoReferenceRequest,
  capabilities: VideoModelCapabilities,
): boolean {
  return requiresGeneratedAudio(action) && !capabilities.canGenerateAudio;
}

export function formatUnsupportedVideoReferences(kinds: readonly VideoReferenceKind[]): string {
  return kinds
    .map((kind) => {
      if (kind === 'image') return 'image references';
      if (kind === 'video') return 'video references';
      return 'audio references';
    })
    .join(', ');
}
