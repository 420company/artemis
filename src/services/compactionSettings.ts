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
 */

import { parseContextCap, resolveMaxContextTokens, type ContextCapMode } from '../core/compaction/index.js'
import type { ExplicitCompressionSettings } from '../providers/store.js'

export type CompactionSettings = {
  enabled?: boolean
  thresholdRatio?: number
  maxContextTokens?: number
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
  return resolved
}

export async function loadCompactionSettings(
  cwd: string,
  mode: ContextCapMode = 'hosted',
  env: Record<string, string | undefined> = process.env,
): Promise<CompactionSettings> {
  const compression = await resolveCompressionSettings(cwd)
  return {
    enabled: compression.enabled,
    thresholdRatio: compression.threshold,
    maxContextTokens: resolveMaxContextTokens({ configured: compression.maxContextTokens, mode, env }),
  }
}
