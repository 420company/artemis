/* eslint-disable @typescript-eslint/no-unused-vars */
import { homedir } from 'node:os';
import { ProviderStore } from '../providers/store.js';
import type { ProviderStoreData } from '../providers/types.js';
import { VISUAL_SETUP_REQUIRED_ERROR } from '../utils/visualGenerationConfig.js';

export type BytePlusMediaCredentials = {
  apiKey: string;
  baseUrl: string;
};

export type BytePlusMediaAssetKind = 'image' | 'video';

const BYTEPLUS_DEFAULT_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const BYTEPLUS_HOST_FRAGMENT = 'bytepluses.com';

function isEnabledFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

export function normalizeBytePlusMediaBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) {
    return BYTEPLUS_DEFAULT_BASE_URL;
  }

  try {
    const parsed = new URL(baseUrl);
    if (!parsed.hostname.includes(BYTEPLUS_HOST_FRAGMENT)) {
      return BYTEPLUS_DEFAULT_BASE_URL;
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    const apiIndex = segments.findIndex(
      (segment, index) => segment === 'api' && segments[index + 1] === 'v3',
    );
    const normalizedPath =
      apiIndex >= 0 ? `/${segments.slice(0, apiIndex + 2).join('/')}` : '/api/v3';

    return `${parsed.origin}${normalizedPath}`;
  } catch {
    return BYTEPLUS_DEFAULT_BASE_URL;
  }
}

export async function resolveBytePlusCredentials(
  cwd: string,
  assetKind: BytePlusMediaAssetKind,
): Promise<BytePlusMediaCredentials> {
  const envKey = process.env.ARK_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, baseUrl: BYTEPLUS_DEFAULT_BASE_URL };
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

      // Visual generation credentials must remain independent from main / secondary
      // chat providers. Only the explicit visual slot may authorize media calls.
      if (
        slot?.provider?.toLowerCase() === 'byteplus' &&
        slot.apiKey?.trim()
      ) {
        return {
          apiKey: slot.apiKey,
          baseUrl: normalizeBytePlusMediaBaseUrl(slot.baseUrl),
        };
      }
    }

    // Do not fall back to the main chat provider. Chat API credentials and
    // visual-generation credentials are intentionally configured separately.
  }
  
  throw new Error(
    `${VISUAL_SETUP_REQUIRED_ERROR}: BytePlus ${assetKind} credentials not found. Configure an enabled visual ${assetKind} profile in the current workspace or home directory.`,
  );
}
