/**
 * The configured video model's profile (videoCapabilities.ts), with what the
 * platform declares for it applied: the source of L, the longest single
 * clip, for routing, the long-video wizard and segment plans.
 */
import { resolveConfiguredVisualProvider } from '../../utils/visualGenerationConfig.js';
import {
  resolveVideoModelProfile,
  videoCapabilityOverridesFromConfig,
  type VideoModelProfile,
} from './videoCapabilities.js';

export async function resolveActiveVideoProfile(cwd: string): Promise<VideoModelProfile | undefined> {
  const configured = await resolveConfiguredVisualProvider(cwd, 'video');
  if (!configured) return undefined;
  const model = configured.model || configured.config.video.model;
  return resolveVideoModelProfile(configured.config.video.provider, model, videoCapabilityOverridesFromConfig(configured.config));
}

/** L for the configured video model, or undefined when no video model is configured. */
export async function resolveActiveVideoClipSeconds(cwd: string): Promise<number | undefined> {
  return (await resolveActiveVideoProfile(cwd))?.maxClipSeconds;
}
