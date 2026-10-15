import {
  resolveVideoModelProfile,
  type VideoCapabilityOverrides,
} from './videoCapabilities.js';

export type VideoModelLimits = {
  provider: string;
  model: string;
  minSegmentSeconds: number;
  /** L, the longest single clip (videoCapabilities.ts is the source of truth). */
  maxSegmentSeconds: number;
  /** Segment length the planner aims for: the longest clip, so a video needs the fewest segments. */
  preferredSegmentSeconds: number;
  referenceInputs: readonly ('image' | 'video' | 'audio')[];
  canGenerateAudio: boolean;
  /** Longest prompt Artemis sends this model. */
  maxPromptChars: number;
  /** Cuts between camera shots inside one clip (videoCapabilities.ts). */
  multiShot: boolean;
};

export function resolveVideoModelLimits(
  provider: string,
  model: string,
  overrides?: VideoCapabilityOverrides,
): VideoModelLimits {
  const profile = resolveVideoModelProfile(provider, model, overrides);
  return {
    provider,
    model,
    minSegmentSeconds: profile.minClipSeconds,
    maxSegmentSeconds: profile.maxClipSeconds,
    preferredSegmentSeconds: profile.maxClipSeconds,
    referenceInputs: profile.referenceInputs,
    canGenerateAudio: profile.canGenerateAudio,
    maxPromptChars: profile.maxPromptChars,
    multiShot: profile.multiShot,
  };
}
