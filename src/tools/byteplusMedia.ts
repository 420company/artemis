/* eslint-disable @typescript-eslint/no-unused-vars */
import { homedir } from 'node:os';
import { ProviderStore } from '../providers/store.js';
import type { ProviderProfile, ProviderStoreData } from '../providers/types.js';

export type BytePlusMediaCredentials = {
  apiKey: string;
  baseUrl: string;
};

export type BytePlusMediaAssetKind = 'image' | 'video';

const BYTEPLUS_DEFAULT_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const BYTEPLUS_HOST_FRAGMENT = 'bytepluses.com';

function isBytePlusProfile(profile: ProviderProfile | undefined): profile is ProviderProfile {
  return Boolean(profile?.baseUrl?.includes(BYTEPLUS_HOST_FRAGMENT));
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
    if (visualProfile?.enabled) {
      const slot = assetKind === 'image' ? visualProfile.image : visualProfile.video;
      if (assetKind === 'video' && !visualProfile.video?.enabled) {
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
    
    // 如果没有找到视觉配置，尝试从主配置文件获取（向后兼容）
    if (data.defaultMainProfileId) {
      const mainProfile = data.profiles.find(p => p.id === data.defaultMainProfileId);
      if (mainProfile && mainProfile.protocol === 'openai' && mainProfile.baseUrl.includes('byteplus')) {
        return {
          apiKey: mainProfile.apiKey,
          baseUrl: normalizeBytePlusMediaBaseUrl(mainProfile.baseUrl.replace('/api/coding/v3', '/api/v3')),
        };
      }
    }
  }
  
  throw new Error(
    `BytePlus ${assetKind} credentials not found. Set ARK_API_KEY explicitly, or configure a BytePlus visual ${assetKind} profile in the current workspace or home directory.`,
  );
}
