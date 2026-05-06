import type { VisualModelConfig } from '../../providers/types.js';

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

export function isSeedance2Model(model: string | undefined): boolean {
  const key = normalize(model);
  return key.includes('dreamina-seedance-2-0') || key.includes('seedance-2-0');
}

export function isSeedance15Model(model: string | undefined): boolean {
  return normalize(model).includes('seedance-1-5');
}

export function resolveVideoModelCapabilities(
  provider: string,
  model: string,
): VideoModelCapabilities {
  const providerKey = normalize(provider);
  if (providerKey === 'byteplus') {
    if (isSeedance2Model(model)) {
      return {
        provider,
        model,
        referenceInputs: ['image', 'video', 'audio'],
        canGenerateAudio: true,
      };
    }
    if (isSeedance15Model(model)) {
      return {
        provider,
        model,
        referenceInputs: ['image'],
        canGenerateAudio: true,
      };
    }
  }

  return {
    provider,
    model,
    referenceInputs: [],
    canGenerateAudio: false,
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
    !isSeedance2Model(config.video.model)
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
