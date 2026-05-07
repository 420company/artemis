import { normalizeVideoDurationForProvider } from './videoParams.js';
import {
  isBytePlusProvider,
  isSeedance15Model,
  isSeedance2Model,
  resolveVideoModelCapabilities,
} from './videoCapabilities.js';

export type VideoModelLimits = {
  provider: string;
  model: string;
  minSegmentSeconds: number;
  maxSegmentSeconds: number;
  preferredSegmentSeconds: number;
  referenceInputs: readonly ('image' | 'video' | 'audio')[];
  canGenerateAudio: boolean;
};

export function resolveVideoModelLimits(provider: string, model: string): VideoModelLimits {
  const capabilities = resolveVideoModelCapabilities(provider, model);
  if (isBytePlusProvider(provider) && isSeedance2Model(model)) {
    return {
      provider,
      model,
      minSegmentSeconds: 4,
      maxSegmentSeconds: 15,
      preferredSegmentSeconds: 10,
      referenceInputs: capabilities.referenceInputs,
      canGenerateAudio: capabilities.canGenerateAudio,
    };
  }

  if (isBytePlusProvider(provider) && isSeedance15Model(model)) {
    return {
      provider,
      model,
      minSegmentSeconds: 4,
      maxSegmentSeconds: 12,
      preferredSegmentSeconds: 8,
      referenceInputs: capabilities.referenceInputs,
      canGenerateAudio: capabilities.canGenerateAudio,
    };
  }

  const normalized = normalizeVideoDurationForProvider(60, provider, model);
  const maxSegmentSeconds = Math.max(4, Math.min(30, normalized));
  return {
    provider,
    model,
    minSegmentSeconds: 4,
    maxSegmentSeconds,
    preferredSegmentSeconds: Math.min(10, maxSegmentSeconds),
    referenceInputs: capabilities.referenceInputs,
    canGenerateAudio: capabilities.canGenerateAudio,
  };
}
