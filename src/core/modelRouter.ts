/**
 * Model router — semantic API for picking the right model for a task.
 *
 * Artemis has two configurable provider profiles:
 *   - Lead (defaultMainProfile)   : premium, used for main brain decisions
 *   - Worker (specialistProfile)  : cheap/fast, used for bulk/digest work
 *
 * This module wraps brain.ts's provider loaders with role-based routing so
 * tools, sub-agents, and helpers can ask for a "summarize" or "deep-think"
 * provider without caring about config plumbing.
 *
 * Roles:
 *   - 'lead'      → main brain loop, final code/text, architecture decisions
 *   - 'worker'    → summarization, search digestion, bulk read compaction
 *   - 'subagent'  → spawned sub-agents; defaults to worker for read-heavy
 *                   research/explore, lead for execution-heavy tasks
 *   - 'reasoning' → deep reasoning steps; uses lead (could specialize later)
 */

import {
  hasDualModel,
  getWorkerProvider,
  getLeadProvider,
  summarizeViaWorker,
  summarizeOnce,
} from '../brain.js';

export type ModelRole = 'lead' | 'worker' | 'subagent' | 'reasoning';

export interface ModelRouteResult {
  /** True if the lead and worker are actually different. */
  isDualModelActive: boolean;
  /** True if this call resolved to the worker profile. */
  isWorker: boolean;
  /** Provider config object; shape depends on protocol. */
  config: any;
  /** Provider runtime instance. */
  provider: any;
}

/**
 * Get a provider for a given role. The caller passes a role describing what
 * they're about to do; the router picks lead vs worker accordingly.
 *
 * If no specialist profile is configured, all roles fall back to lead
 * transparently — callers don't need to branch.
 */
export async function getProviderForRole(role: ModelRole): Promise<ModelRouteResult> {
  const dual = hasDualModel();

  // Worker-targeted roles use specialist profile when dual-model is active.
  // When dual is off, fall through to lead (getWorkerProvider returns lead in
  // that case, but we explicitly call getLeadProvider for clarity).
  const wantsWorker = dual && (role === 'worker' || role === 'subagent');

  if (wantsWorker) {
    const w = await getWorkerProvider();
    return {
      isDualModelActive: dual,
      isWorker: true,
      provider: w.provider,
      config: w.config,
    };
  }

  // Lead/reasoning paths always go through getLeadProvider explicitly,
  // regardless of dual-model state.
  const l = await getLeadProvider();
  return {
    isDualModelActive: dual,
    isWorker: false,
    provider: l.provider,
    config: l.config,
  };
}

/**
 * Summarize text using the optimal model for cheap digest work.
 * - Dual-model on  → uses worker (specialist) profile
 * - Dual-model off → uses lead with haiku-first fallback
 *
 * This is the recommended helper for any tool/agent that needs to compact a
 * large blob (search results, file dumps, log output) before re-injecting
 * it into the main brain context.
 */
export async function digestForBrain(text: string, instructions?: string): Promise<string> {
  const prompt = instructions
    ? `${instructions}\n\n---\n\n${text}`
    : `Summarize the following content into a concise factual digest. Preserve specific names, paths, numbers, and error messages exactly. Drop boilerplate.\n\n---\n\n${text}`;
  if (hasDualModel()) {
    return summarizeViaWorker(prompt);
  }
  return summarizeOnce(prompt);
}

/**
 * Status string for HUD / debug display, e.g. "dual: opus + haiku" or
 * "single: sonnet". Useful for surfacing the active model setup to the user.
 */
export function getDualModelStatusLabel(leadConfig: any, workerConfig: any): string {
  const lead = leadConfig?.model ?? 'unknown';
  const worker = workerConfig?.model;
  if (!worker || worker === lead) return `single: ${lead}`;
  return `dual: ${lead} + ${worker}`;
}
