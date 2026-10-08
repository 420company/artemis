import { homedir } from 'node:os';
import { ProviderStore } from '../providers/store.js';
import type { ProviderStoreData } from '../providers/types.js';
import {
  BYTEPLUS_VISUAL_BASE_URL,
  VISUAL_SETUP_REQUIRED_ERROR,
} from '../utils/visualGenerationConfig.js';

export type ModelArkMediaCredentials = {
  apiKey: string;
  baseUrl: string;
};

export type ModelArkMediaAssetKind = 'image' | 'video';

// Official ModelArk hosts (BytePlus and Volcengine Ark): their base URL is the
// region host plus /api/v3.
const MODEL_ARK_HOST_SUFFIXES = ['bytepluses.com', 'volces.com'];

/** Thrown for a visual base URL that must not be used (e.g. plain http to a remote host). */
export const VISUAL_BASE_URL_MISCONFIGURED = 'Visual API base URL is misconfigured';

function isModelArkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return MODEL_ARK_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isEnabledFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

/**
 * The base URL ModelArk media requests are sent to. Official hosts
 * (*.bytepluses.com, *.volces.com) normalize to region host + /api/v3 over
 * https. Any other host (the platform gateway, a relay) is kept as configured,
 * query string included, so its key never goes to BytePlus; it must use https
 * unless it is loopback. A pasted full endpoint path is trimmed to the base.
 * Throws an Error starting with VISUAL_BASE_URL_MISCONFIGURED for plain http to
 * a remote host.
 */
export function normalizeModelArkMediaBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl?.trim()) {
    return BYTEPLUS_VISUAL_BASE_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return BYTEPLUS_VISUAL_BASE_URL;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return BYTEPLUS_VISUAL_BASE_URL;
  }

  if (isModelArkHost(parsed.hostname)) {
    const segments = parsed.pathname.split('/').filter(Boolean);
    const apiIndex = segments.findIndex(
      (segment, index) => segment === 'api' && segments[index + 1] === 'v3',
    );
    const normalizedPath =
      apiIndex >= 0 ? `/${segments.slice(0, apiIndex + 2).join('/')}` : '/api/v3';
    return `https://${parsed.host}${normalizedPath}`;
  }

  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      `${VISUAL_BASE_URL_MISCONFIGURED}: ${parsed.origin} uses plain http, which would send the API key unencrypted. ` +
        'Use an https URL (http is only allowed for localhost), then retry (/config visual).',
    );
  }
  const path = parsed.pathname
    .replace(/\/(?:images\/generations|contents\/generations\/tasks)(?:\/.*)?$/, '')
    .replace(/\/+$/, '');
  return `${parsed.origin}${path}${parsed.search}`;
}

/** Joins an endpoint path onto a ModelArk base URL, keeping the base URL's query string. */
export function modelArkEndpoint(baseUrl: string, endpointPath: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpointPath.replace(/^\/+/, '')}`;
  return url.toString();
}

export async function resolveModelArkMediaCredentials(
  cwd: string,
  assetKind: ModelArkMediaAssetKind,
): Promise<ModelArkMediaCredentials> {
  const envKey = process.env.ARK_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, baseUrl: BYTEPLUS_VISUAL_BASE_URL };
  }

  const stores = [new ProviderStore(cwd)];
  if (cwd !== homedir()) {
    stores.push(new ProviderStore(homedir()));
  }

  for (const store of stores) {
    let data: ProviderStoreData;
    try {
      data = await store.load();
    } catch {
      continue;
    }

    const visualProfile = data.visualProfile;
    const slot = assetKind === 'image' ? visualProfile?.image : visualProfile?.video;
    const profileEnabled = isEnabledFlag(visualProfile?.enabled) || Boolean(slot?.apiKey?.trim());
    if (visualProfile && profileEnabled) {
      const videoEnabled = isEnabledFlag(visualProfile.video?.enabled) || Boolean(visualProfile.video?.apiKey?.trim());
      if (assetKind === 'video' && !videoEnabled) {
        continue;
      }

      if (
        slot?.provider?.toLowerCase() === 'byteplus' &&
        slot.apiKey?.trim()
      ) {
        return {
          apiKey: slot.apiKey,
          baseUrl: normalizeModelArkMediaBaseUrl(slot.baseUrl),
        };
      }
    }
  }

  throw new Error(
    `${VISUAL_SETUP_REQUIRED_ERROR}: ModelArk ${assetKind} credentials not found. Configure an enabled visual ${assetKind} profile in the current workspace or home directory.`,
  );
}
