/**
 * Per-task model routing for helper calls (`auxiliaryModels` in
 * providers.json).
 *
 * Helper tasks (image description, context compaction, research page
 * digests, memory extraction, ...) do not need the main model. A store can
 * route each task to its own model:
 *
 *   "auxiliaryModels": {
 *     "compression": { "mode": "provider", "providerProfileId": "cheap" },
 *     "web_extract": { "mode": "custom", "protocol": "openai",
 *                      "baseUrl": "https://...", "apiKey": "...", "model": "..." }
 *   }
 *
 * `mode: "auto"` (or no entry) means "no task-specific route". Resolution for
 * a task is: its explicit route, then the worker (specialist) profile, then
 * the main profile.
 *
 * Which store: when the global store holds a platform-managed candidate for
 * any of those tiers (a profile with managedBy "platform" or
 * capabilitiesSource "platform"), the agent server owns helper routing and
 * only the global store counts, so a workspace store cannot redirect the
 * platform's helper traffic to another endpoint, not even through a tier the
 * platform did not set. Otherwise each tier looks in the cwd-local store
 * first and the global store second, as the main and worker profiles do.
 */
import path from 'node:path';
import { resolveArtemisHomeDir } from '../utils/fs.js';
import { hasPlatformCapabilities } from './capabilities.js';
import { normalizeProviderProtocol } from './factory.js';
import { ProviderStore, createGlobalProviderStore } from './store.js';
import { createTrackedProviderFromConfig } from './telemetry.js';
import type {
  AuxiliaryModelRoute,
  AuxiliaryModelTask,
  ChatProvider,
  EffortLevel,
  ProviderProfile,
  ProviderStoreData,
} from './types.js';

export type AuxiliarySource = 'auxiliary' | 'worker' | 'main';

export type AuxiliaryResolution = {
  /** Profile-shaped config for the chosen model (custom routes get a synthetic id). */
  profile: ProviderProfile;
  /** Which tier supplied it. */
  source: AuxiliarySource;
  /** Directory of the store it came from (for telemetry). */
  storeCwd: string;
};

export type ResolveAuxiliaryOptions = {
  /** Stop after the explicit route (no worker/main fallback). */
  explicitOnly?: boolean;
  /** Skip the main tier (the caller has its own main-model path). */
  skipMain?: boolean;
  /** Only accept candidates this predicate allows (e.g. "can see images"). */
  accept?: (profile: ProviderProfile) => boolean;
};

type LoadedStore = { store: ProviderStore; data: ProviderStoreData; cwd: string; global: boolean };

export function isPlatformManagedProfile(profile: ProviderProfile): boolean {
  return profile.managedBy === 'platform' || hasPlatformCapabilities(profile);
}

/**
 * The profile an explicit route names, or undefined for `auto`, a missing
 * entry, or an incomplete one. A `provider` route may override the model of
 * the profile it names; the profile's platform capabilities then no longer
 * describe that model and are dropped.
 */
export function profileForAuxiliaryRoute(
  task: AuxiliaryModelTask,
  route: AuxiliaryModelRoute | undefined,
  store: ProviderStore,
  data: ProviderStoreData,
): ProviderProfile | undefined {
  if (!route || typeof route !== 'object') return undefined;
  if (route.mode === 'provider') {
    const profile = store.getProfile(data, route.providerProfileId);
    if (!profile) return undefined;
    const model = typeof route.model === 'string' ? route.model.trim() : '';
    if (!model || model === profile.model) return profile;
    return {
      ...profile,
      model,
      supportsImages: undefined,
      contextLength: undefined,
      maxOutputTokens: undefined,
      capabilitiesSource: undefined,
    } as ProviderProfile;
  }
  if (route.mode === 'custom') {
    const baseUrl = typeof route.baseUrl === 'string' ? route.baseUrl.trim() : '';
    const model = typeof route.model === 'string' ? route.model.trim() : '';
    if (!baseUrl || !model) return undefined;
    return {
      id: `auxiliary-${task}`,
      label: `auxiliary-${task}`,
      protocol: normalizeProviderProtocol(route.protocol),
      baseUrl,
      apiKey: typeof route.apiKey === 'string' ? route.apiKey : '',
      model,
    };
  }
  return undefined;
}

async function loadStores(cwd: string): Promise<LoadedStore[]> {
  const stores: LoadedStore[] = [];
  const localCwd = path.resolve(cwd);
  const globalCwd = resolveArtemisHomeDir();
  if (localCwd !== globalCwd) {
    try {
      const store = new ProviderStore(localCwd);
      stores.push({ store, data: await store.load(), cwd: localCwd, global: false });
    } catch {
      // an unreadable workspace store contributes nothing
    }
  }
  try {
    const store = createGlobalProviderStore();
    stores.push({ store, data: await store.load(), cwd: globalCwd, global: true });
  } catch {
    // an unreadable global store contributes nothing
  }
  return stores;
}

function pickTier(
  stores: LoadedStore[],
  pick: (entry: LoadedStore) => ProviderProfile | undefined,
  accept: ((profile: ProviderProfile) => boolean) | undefined,
): { profile: ProviderProfile; storeCwd: string } | undefined {
  for (const entry of stores) {
    const profile = pick(entry);
    if (profile && (!accept || accept(profile))) return { profile, storeCwd: entry.cwd };
  }
  return undefined;
}

/**
 * The model a helper task runs on: its explicit route, else the worker
 * profile, else the main profile. Undefined when nothing qualifies.
 */
export async function resolveAuxiliaryProfile(
  task: AuxiliaryModelTask,
  cwd: string,
  options: ResolveAuxiliaryOptions = {},
): Promise<AuxiliaryResolution | undefined> {
  const loaded = await loadStores(cwd);
  const pickers: Array<(entry: LoadedStore) => ProviderProfile | undefined> = [
    ({ store, data }) => profileForAuxiliaryRoute(task, data.auxiliaryModels?.[task], store, data),
    ({ store, data }) => store.getProfile(data, data.specialistProfileId),
    ({ store, data }) => store.getDefaultMainProfile(data),
  ];
  // The platform owns helper routing when its global store has a say in any tier.
  const global = loaded.find((entry) => entry.global);
  const platformOwned = global && pickers.some((pick) => {
    const profile = pick(global);
    return profile && isPlatformManagedProfile(profile) && (!options.accept || options.accept(profile));
  });
  const stores = platformOwned ? [global] : loaded;
  const explicit = pickTier(stores, pickers[0]!, options.accept);
  if (explicit) return { ...explicit, source: 'auxiliary' };
  if (options.explicitOnly) return undefined;

  const worker = pickTier(stores, pickers[1]!, options.accept);
  if (worker) return { ...worker, source: 'worker' };
  if (options.skipMain) return undefined;

  const main = pickTier(stores, pickers[2]!, options.accept);
  return main ? { ...main, source: 'main' } : undefined;
}

/** A tracked provider for a helper task, resolved like resolveAuxiliaryProfile. */
export async function createAuxiliaryProvider(
  task: AuxiliaryModelTask,
  cwd: string,
  options: ResolveAuxiliaryOptions & { effort?: EffortLevel } = {},
): Promise<{ provider: ChatProvider; profile: ProviderProfile; source: AuxiliarySource } | undefined> {
  const resolved = await resolveAuxiliaryProfile(task, cwd, options);
  if (!resolved) return undefined;
  const profile = options.effort ? { ...resolved.profile, effort: options.effort } : resolved.profile;
  const provider = createTrackedProviderFromConfig(profile, {
    cwd: resolved.storeCwd,
    profileId: profile.id,
    profileLabel: profile.label ?? profile.id,
  });
  return { provider, profile, source: resolved.source };
}
