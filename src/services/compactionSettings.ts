/**
 * Context-compaction settings (setup.agent.compression) for every run:
 * hosted runs (headless execute, web sessions, chat-bridge workflows) through
 * loadCompactionSettings, the interactive CLI through
 * resolveCompressionSettings.
 *
 * Each field is decided on its own, and only values a providers.json
 * actually sets count (ProviderStore.loadExplicitCompression), never the
 * defaults a loaded store is filled with:
 *
 *   workspace store  >  global store ($ARTEMIS_HOME)  >  defaults
 *
 * The context cap then follows resolveMaxContextTokens: the user's own
 * setting > ARTEMIS_MAX_CONTEXT_TOKENS (the platform's per-tier budget) >
 * the mode default (200K hosted, none interactive).
 *
 * Cache-aware summaries (cacheAwareSummary, default off):
 * ARTEMIS_CACHE_AWARE_SUMMARY (1/0/main) > the stores > off. The variable
 * wins so an operator or an A/B eval can switch it per process. "main"
 * writes these summaries with the main model even when a separate
 * summarizer (worker) is configured; `true` keeps the cold path then.
 * Hosted runs only (runAgent); the interactive CLI and bridges (think())
 * ignore it.
 */

import { parseContextCap, resolveMaxContextTokens, type ContextCapMode } from '../core/compaction/index.js'
import type { ExplicitCompressionSettings } from '../providers/store.js'

export type CompactionSettings = {
  enabled?: boolean
  thresholdRatio?: number
  maxContextTokens?: number
  /** Tier-2 summaries continue the main conversation's cached prefix (see core/compaction/continuation.ts). */
  cacheAwareSummary?: true | 'main'
}

export const CACHE_AWARE_SUMMARY_ENV = 'ARTEMIS_CACHE_AWARE_SUMMARY'

/** ARTEMIS_CACHE_AWARE_SUMMARY: 1/0 (and true/false, on/off, yes/no) or "main"; undefined when unset or not recognised. */
export function parseCacheAwareSummaryEnv(raw: string | undefined): boolean | 'main' | undefined {
  const value = raw?.trim().toLowerCase()
  if (!value) return undefined
  if (value === 'main') return 'main'
  if (['1', 'true', 'on', 'yes'].includes(value)) return true
  if (['0', 'false', 'off', 'no'].includes(value)) return false
  return undefined
}

/**
 * The compression settings the user set, workspace store first, then the
 * global one; per field. An unreadable store is skipped. `enabled` is only
 * ever false (a store cannot re-enable what the other turned off: `true` is
 * the default older engines wrote everywhere). `maxContextTokens` is the raw
 * value (number or "off"); a value that does not parse counts as unset.
 */
export async function resolveCompressionSettings(cwd: string): Promise<ExplicitCompressionSettings> {
  const { ProviderStore, createGlobalProviderStore } = await import('../providers/store.js')
  const stores = [new ProviderStore(cwd), createGlobalProviderStore()]
  const unique = stores.filter((store, index) => stores.findIndex((other) => other.getFilePath() === store.getFilePath()) === index)
  const layers: ExplicitCompressionSettings[] = []
  for (const store of unique) {
    try {
      layers.push(await store.loadExplicitCompression())
    } catch {
      /* an unreadable store sets nothing */
    }
  }
  const resolved: ExplicitCompressionSettings = {}
  if (layers.some((layer) => layer.enabled === false)) resolved.enabled = false
  const threshold = layers.find((layer) => layer.threshold !== undefined)?.threshold
  if (threshold !== undefined) resolved.threshold = threshold
  const cap = layers.find((layer) => layer.maxContextTokens !== undefined && parseContextCap(layer.maxContextTokens) !== undefined)
  if (cap) resolved.maxContextTokens = cap.maxContextTokens
  const cacheAware = layers.find((layer) => layer.cacheAwareSummary !== undefined)?.cacheAwareSummary
  if (cacheAware !== undefined) resolved.cacheAwareSummary = cacheAware
  return resolved
}

export async function loadCompactionSettings(
  cwd: string,
  mode: ContextCapMode = 'hosted',
  env: Record<string, string | undefined> = process.env,
): Promise<CompactionSettings> {
  const compression = await resolveCompressionSettings(cwd)
  const cacheAwareSummary = parseCacheAwareSummaryEnv(env[CACHE_AWARE_SUMMARY_ENV]) ?? compression.cacheAwareSummary ?? false
  return {
    enabled: compression.enabled,
    thresholdRatio: compression.threshold,
    maxContextTokens: resolveMaxContextTokens({ configured: compression.maxContextTokens, mode, env }),
    ...(cacheAwareSummary ? { cacheAwareSummary: cacheAwareSummary === 'main' ? 'main' as const : true as const } : {}),
  }
}
