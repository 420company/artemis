/**
 * Context-compaction settings for hosted runs (headless execute, web
 * sessions, chat-bridge workflows): setup.agent.compression from the
 * workspace store, else the global one, with the hosted context cap applied
 * (see resolveMaxContextTokens).
 */

import { resolveMaxContextTokens, type ContextCapMode } from '../core/compaction/index.js'

export type CompactionSettings = {
  enabled?: boolean
  thresholdRatio?: number
  maxContextTokens?: number
}

export async function loadCompactionSettings(cwd: string, mode: ContextCapMode = 'hosted'): Promise<CompactionSettings> {
  const { ProviderStore } = await import('../providers/store.js')
  const { resolveArtemisHomeDir } = await import('../utils/fs.js')
  let compression: { enabled?: boolean; threshold?: number; maxContextTokens?: number } | undefined
  for (const root of [cwd, resolveArtemisHomeDir()]) {
    try {
      const data = await new ProviderStore(root).load()
      if (data.setup?.agent?.compression) {
        compression = data.setup.agent.compression
        break
      }
    } catch {
      /* fall through to the next store */
    }
  }
  return {
    enabled: compression?.enabled,
    thresholdRatio: compression?.threshold,
    maxContextTokens: resolveMaxContextTokens({ configured: compression?.maxContextTokens, mode }),
  }
}
