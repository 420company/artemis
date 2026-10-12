/**
 * Per-run overrides of the main provider: `--model`, `--base-url` and
 * `--api-key` (or ARTEMIS_MODEL / ARTEMIS_BASE_URL / ARTEMIS_API_KEY).
 * The headless runner, the interactive CLI and background workflows apply
 * them with the same rules, so a key only ever goes to an endpoint its
 * owner chose:
 *
 * - Another endpoint needs its own key. The configured key is never sent
 *   there, and only the protocol and the model carry over from the profile.
 * - A key on its own replaces the configured key only when the profile comes
 *   from the owner's own store (the global store, or any store under the
 *   Artemis home). A workspace `<cwd>/.artemis/providers.json` belongs to the
 *   checkout and chooses its own endpoint, so a key for it must come with
 *   the endpoint it is meant for (`--base-url`).
 * - A model override drops platform capabilities, which describe the
 *   profile's own model.
 */
import path from 'node:path';
import { resolveArtemisHomeDir } from '../utils/fs.js';
import { hasPlatformCapabilities } from './capabilities.js';
import { ProviderStore } from './store.js';
import type { ProviderConfig } from './types.js';

export type ProviderOverrides = {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
};

/** A combination of overrides that would send a key where its owner did not choose. */
export class ProviderOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderOverrideError';
  }
}

/** Whether a providers.json lives in the owner's Artemis home rather than in a workspace checkout. */
export function isOwnerProviderStoreFile(filePath: string): boolean {
  const home = path.resolve(resolveArtemisHomeDir());
  const dir = path.resolve(path.dirname(filePath));
  const relative = path.relative(home, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Whether the main profile for `cwd` comes from the owner's own store. The
 * workspace store is read first (as the providers resolve); without a main
 * profile there, the global store supplies it.
 */
export async function mainProfileIsFromOwnerStore(cwd: string): Promise<boolean> {
  const local = new ProviderStore(cwd);
  const localMain = local.getDefaultMainProfile(await local.load());
  return localMain ? isOwnerProviderStoreFile(local.getFilePath()) : true;
}

function sameEndpoint(left: string | undefined, right: string | undefined): boolean {
  return (left ?? '').trim().replace(/\/+$/, '') === (right ?? '').trim().replace(/\/+$/, '');
}

/** The configured main provider with the overrides applied, or a ProviderOverrideError. */
export function overrideProviderConfig(
  configured: ProviderConfig,
  overrides: ProviderOverrides,
  options: { ownerStore: boolean },
): ProviderConfig {
  const model = overrides.model?.trim() || undefined;
  const baseUrl = overrides.baseUrl?.trim() || undefined;
  const apiKey = overrides.apiKey?.trim() || undefined;
  const otherEndpoint = Boolean(baseUrl) && !sameEndpoint(baseUrl, configured.baseUrl);
  if (otherEndpoint && !apiKey) {
    throw new ProviderOverrideError('--base-url (ARTEMIS_BASE_URL) names another endpoint than the configured one: pass its --api-key (ARTEMIS_API_KEY) as well. The configured key is not sent there.');
  }
  if (apiKey && !baseUrl && !options.ownerStore) {
    throw new ProviderOverrideError('--api-key (ARTEMIS_API_KEY) alone is not applied to a profile from this workspace\'s .artemis/providers.json: pass the endpoint it is for with --base-url (ARTEMIS_BASE_URL) as well.');
  }
  const config: ProviderConfig = otherEndpoint
    ? { protocol: configured.protocol, model: configured.model, baseUrl: baseUrl as string, apiKey: apiKey as string }
    : { ...configured, ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) };
  if (model && model !== config.model) {
    config.model = model;
    if (hasPlatformCapabilities(configured)) {
      delete config.supportsImages;
      delete config.contextLength;
      delete config.maxOutputTokens;
      delete config.capabilitiesSource;
    }
  }
  return config;
}
