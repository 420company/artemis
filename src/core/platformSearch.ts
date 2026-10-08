/**
 * The "platform" backend of search_web: web search through the hosted
 * platform's model gateway (`POST <gateway>/v1/search`).
 *
 * On a hosted VPS the engine holds no search key of its own: the gateway
 * owns the upstream search keys and bills each query to the owner's account.
 * The engine authenticates with the platform key it already uses for the
 * platform's models. The agent server writes where to find them into the
 * global providers.json:
 *
 *   "webSearch": { "provider": "platform", "enabled": true,
 *                  "baseUrl": "https://<gateway>/v1", "apiKey": "ak-…",
 *                  "managedBy": "platform" }
 *
 * `enabled: false` turns the backend off (the platform offers no search on
 * this account's route). Without a `webSearch` entry, a main profile the
 * agent server manages (`capabilitiesSource` or `managedBy` "platform") is
 * taken as the gateway, with its own base URL and key.
 *
 * Only the global store (~/.artemis or $ARTEMIS_HOME) is read: a workspace's
 * own providers.json cannot point the platform key at another endpoint.
 */
import { createGlobalProviderStore } from '../providers/store.js';
import type { ProviderProfile } from '../providers/types.js';

export interface PlatformSearchConfig {
  /** The gateway's API root, e.g. https://gw.example/v1. */
  baseUrl: string;
  /** The owner's platform key. */
  apiKey: string;
  /** Where the settings came from (for diagnostics only). */
  source: 'webSearch' | 'mainProfile';
}

export type PlatformFreshness = 'day' | 'week' | 'month' | 'year';

export interface PlatformSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

type WebSearchEntry = {
  provider?: unknown;
  enabled?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
};

const isHttpUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim());
const isKey = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function platformManaged(profile: ProviderProfile | undefined): boolean {
  return !!profile && (profile.capabilitiesSource === 'platform' || profile.managedBy === 'platform');
}

/**
 * The platform search settings from a provider store's data, or undefined
 * when this host has none (or they are turned off). Pure, for tests.
 */
export function platformSearchFromStore(data: {
  webSearch?: unknown;
  profiles?: ProviderProfile[];
  defaultMainProfileId?: string;
}): PlatformSearchConfig | undefined {
  const entry = data.webSearch;
  if (entry !== undefined && entry !== null) {
    if (typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const ws = entry as WebSearchEntry;
    if (ws.provider !== 'platform' || ws.enabled === false) return undefined;
    if (!isHttpUrl(ws.baseUrl) || !isKey(ws.apiKey)) return undefined;
    return { baseUrl: ws.baseUrl.trim(), apiKey: ws.apiKey.trim(), source: 'webSearch' };
  }
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const main = profiles.find((p) => p?.id === (data.defaultMainProfileId ?? 'executor'));
  if (!platformManaged(main) || !isHttpUrl(main?.baseUrl) || !isKey(main?.apiKey)) return undefined;
  return { baseUrl: main!.baseUrl.trim(), apiKey: main!.apiKey.trim(), source: 'mainProfile' };
}

/** The platform search settings of this host, from the global providers.json. */
export async function resolvePlatformSearch(): Promise<PlatformSearchConfig | undefined> {
  try {
    const data = await createGlobalProviderStore().load();
    return platformSearchFromStore(data as Parameters<typeof platformSearchFromStore>[0]);
  } catch {
    // An unreadable store means no platform search, never a crash of the tool.
    return undefined;
  }
}

/** A failure the model can relay to the user as is: never fake results. */
export class PlatformSearchError extends Error {
  constructor(
    readonly code: 'insufficient_balance' | 'rate_limited' | 'unavailable' | 'failed' | 'unreachable' | 'invalid_request' | 'unauthorized',
    message: string,
  ) {
    super(message);
    this.name = 'PlatformSearchError';
  }
}

/**
 * Whole call, the gateway's own failover across providers included. The
 * gateway keeps one search within 25 s across all its providers, so this
 * leaves room for the network and never gives up while it still works.
 */
export const PLATFORM_SEARCH_TIMEOUT_MS = 30_000;

/**
 * One query through the gateway. Resolves with the results (possibly none)
 * and the provider that answered; rejects with a PlatformSearchError whose
 * message says plainly what went wrong.
 */
export async function searchWithPlatform(
  query: string,
  limit: number,
  config: PlatformSearchConfig,
  options: { freshness?: PlatformFreshness; signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ results: PlatformSearchResult[]; provider?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PLATFORM_SEARCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        count: Math.max(1, Math.min(10, Math.floor(limit) || 5)),
        ...(options.freshness ? { freshness: options.freshness } : {}),
      }),
      signal,
    });
  } catch (error) {
    const timedOut = timeout.aborted;
    throw new PlatformSearchError(
      'unreachable',
      timedOut ? 'platform search did not answer in time' : `platform search is unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let data: { results?: unknown; provider?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
  try {
    data = (await response.json()) as typeof data;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const code = typeof data?.error?.code === 'string' ? data.error.code : '';
    const detail = typeof data?.error?.message === 'string' ? `: ${data.error.message}` : '';
    if (response.status === 402) throw new PlatformSearchError('insufficient_balance', 'platform search refused: the account balance is too low (the owner needs to top up)');
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      throw new PlatformSearchError('rate_limited', `platform search is rate limited${retry ? `; retry in ${retry} s` : ''}`);
    }
    if (response.status === 401 || response.status === 403) throw new PlatformSearchError('unauthorized', 'platform search refused the platform key');
    if (response.status === 400) throw new PlatformSearchError('invalid_request', `platform search refused the query${detail}`);
    if (response.status === 404 || response.status === 503) {
      throw new PlatformSearchError('unavailable', `platform search is not available right now (${code || `HTTP ${response.status}`})`);
    }
    throw new PlatformSearchError('failed', `platform search failed (${code || `HTTP ${response.status}`})${detail}`);
  }
  if (!Array.isArray(data?.results)) throw new PlatformSearchError('failed', 'platform search answered without results');
  const results: PlatformSearchResult[] = [];
  for (const raw of data.results as Record<string, unknown>[]) {
    if (!raw || typeof raw.url !== 'string' || !/^https?:\/\//i.test(raw.url)) continue;
    results.push({
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : raw.url,
      url: raw.url,
      snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
      ...(typeof raw.publishedAt === 'string' && raw.publishedAt ? { publishedAt: raw.publishedAt } : {}),
    });
  }
  return { results, ...(typeof data.provider === 'string' ? { provider: data.provider } : {}) };
}
