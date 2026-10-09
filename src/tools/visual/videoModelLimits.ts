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
  /**
   * Longest prompt Artemis sends this model. ModelArk publishes no figure for
   * Seedance; the Artemis App sent Seedance prompts of about 4,100 characters
   * in production, so 4,000 keeps a margin. Other models get the Director's
   * own cap, the longest prompt sent to them so far.
   */
  maxPromptChars: number;
};

/** The Director's cap on a directed prompt (videoDirector.ts). */
const DIRECTED_PROMPT_CHARS = 2600;
const SEEDANCE_PROMPT_CHARS = 4000;

function maxPromptCharsFor(model: string): number {
  return /seedance|dreamina/i.test(model) ? SEEDANCE_PROMPT_CHARS : DIRECTED_PROMPT_CHARS;
}

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
      maxPromptChars: maxPromptCharsFor(model),
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
      maxPromptChars: maxPromptCharsFor(model),
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
    maxPromptChars: maxPromptCharsFor(model),
  };
}
