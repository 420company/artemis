/**
 * Provider for the workflow router's classifier (core/workflowRouter.ts).
 *
 * The classification is one short JSON reply, so it only runs on the cheap
 * specialist (worker) profile, at low effort. Without a worker profile there
 * is no classifier at all and ambiguous requests take the direct path: the
 * main model (often with adaptive thinking) is never spent on routing.
 */
import type { ChatProvider, ProviderConfig } from './types.js'
import { ProviderStore } from './store.js'
import { createTrackedProviderFromConfig } from './telemetry.js'

export async function resolveWorkflowClassifierProvider(
  roots: readonly string[],
  cwd: string,
): Promise<ChatProvider | undefined> {
  for (const root of roots) {
    try {
      const store = new ProviderStore(root)
      const data = await store.load()
      const specialist = store.getProfile(data, data.specialistProfileId)
      if (!specialist) continue
      const config = { ...(specialist as unknown as ProviderConfig), effort: 'low' as const }
      const profileId = typeof (specialist as { id?: unknown }).id === 'string' ? (specialist as { id: string }).id : undefined
      return createTrackedProviderFromConfig(config, { cwd, profileId, profileLabel: profileId })
    } catch {
      // try the next root
    }
  }
  return undefined
}
