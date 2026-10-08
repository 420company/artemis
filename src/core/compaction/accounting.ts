/**
 * Context accounting: how big is the next request?
 *
 * Ground truth is the provider-reported input size of the last request
 * (uncached + cache reads + cache writes). Only what changed since that
 * request is estimated locally: messages appended after it and growth of the
 * fixed part (system prompt, per-run context, tool schemas). Without a usable
 * anchor (first request, or the history was rewritten by compaction) the
 * whole request is estimated.
 */

import type { ProviderResponse } from '../../providers/types.js'
import type { SessionMessage } from '../types.js'
import { estimateMessagesTokens } from '../tokenEstimation.js'

export type UsageAnchor = {
  /** Provider-reported input tokens of the request, cache included. */
  promptTokens: number
  /** Number of conversation messages the request carried. */
  messageCount: number
  /** Id of the last conversation message the request carried. */
  lastMessageId?: string
  /** Estimated fixed tokens (system, per-run context, tools) of that request. */
  fixedTokens: number
  recordedAt: string
}

/** Per-session context-management state, persisted with the session. */
export type ContextState = {
  version: 1
  /** Completed compactions (summary or fallback). */
  compactions: number
  /** Consecutive summarizer failures; at 3 the mechanical fallback is used directly. */
  summaryFailures: number
  anchor?: UsageAnchor
  lastCompactionAt?: string
  /**
   * Provider count / local estimate, last seen (1-2). Kept so estimates made
   * after a compaction (when no anchor exists) still use the provider's scale.
   */
  calibration?: number
  /** When the failure breaker opened (summaryFailures reached the limit). */
  breakerOpenedAt?: string
  /** Compactions done mechanically since the breaker opened. */
  skippedSinceOpen?: number
}

export const MAX_SUMMARY_FAILURES = 3
/** With the breaker open, the summarizer is tried again after this many compactions... */
export const BREAKER_RETRY_AFTER_COMPACTIONS = 2
/** ...or after this long, whichever comes first. */
export const BREAKER_RETRY_AFTER_MS = 30 * 60_000

/**
 * Whether the summarizer may be called. After MAX_SUMMARY_FAILURES
 * consecutive failures the breaker opens and compactions are mechanical;
 * it half-opens (one attempt) after a few compactions or some time, so a
 * summarizer that recovered is used again.
 */
export function summarizerAllowed(state: ContextState, now: Date = new Date()): boolean {
  if (state.summaryFailures < MAX_SUMMARY_FAILURES) return true
  const openedAt = state.breakerOpenedAt ? Date.parse(state.breakerOpenedAt) : NaN
  if (!Number.isFinite(openedAt)) return true
  return (state.skippedSinceOpen ?? 0) >= BREAKER_RETRY_AFTER_COMPACTIONS ||
    now.getTime() - openedAt >= BREAKER_RETRY_AFTER_MS
}

export function recordSummarizerSuccess(state: ContextState): void {
  state.summaryFailures = 0
  state.breakerOpenedAt = undefined
  state.skippedSinceOpen = undefined
}

export function recordSummarizerFailure(state: ContextState, now: Date = new Date()): void {
  state.summaryFailures += 1
  if (state.summaryFailures >= MAX_SUMMARY_FAILURES) {
    // (Re)open: a failed half-open attempt waits a full cooldown again.
    state.breakerOpenedAt = now.toISOString()
    state.skippedSinceOpen = 0
  }
}

export function recordSummarizerSkipped(state: ContextState): void {
  if (state.summaryFailures >= MAX_SUMMARY_FAILURES) state.skippedSinceOpen = (state.skippedSinceOpen ?? 0) + 1
}

export function createContextState(): ContextState {
  return { version: 1, compactions: 0, summaryFailures: 0 }
}

/** Accepts anything (old session files, foreign metadata) and returns a valid state. */
export function normalizeContextState(raw: unknown): ContextState {
  if (!raw || typeof raw !== 'object') return createContextState()
  const record = raw as Record<string, unknown>
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
  const state: ContextState = {
    version: 1,
    compactions: count(record.compactions),
    summaryFailures: count(record.summaryFailures),
  }
  const anchor = record.anchor as Record<string, unknown> | undefined
  if (
    anchor &&
    typeof anchor.promptTokens === 'number' && anchor.promptTokens > 0 &&
    typeof anchor.messageCount === 'number' && anchor.messageCount >= 0
  ) {
    state.anchor = {
      promptTokens: anchor.promptTokens,
      messageCount: anchor.messageCount,
      lastMessageId: typeof anchor.lastMessageId === 'string' ? anchor.lastMessageId : undefined,
      fixedTokens: count(anchor.fixedTokens),
      recordedAt: typeof anchor.recordedAt === 'string' ? anchor.recordedAt : new Date(0).toISOString(),
    }
  }
  if (typeof record.lastCompactionAt === 'string') state.lastCompactionAt = record.lastCompactionAt
  if (typeof record.calibration === 'number' && record.calibration >= 1 && record.calibration <= 2) {
    state.calibration = record.calibration
  }
  if (typeof record.breakerOpenedAt === 'string') state.breakerOpenedAt = record.breakerOpenedAt
  if (typeof record.skippedSinceOpen === 'number' && record.skippedSinceOpen >= 0) {
    state.skippedSinceOpen = Math.floor(record.skippedSinceOpen)
  }
  return state
}

/**
 * Total input size of a request from provider usage. Adapters report
 * promptTokens with cache tokens included; when a caller only has the split
 * counters, they are summed here.
 */
export function providerPromptTokens(usage: ProviderResponse['usage'] | undefined): number | undefined {
  if (!usage) return undefined
  if (usage.source === 'estimated') return undefined
  const split = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
  const total = Math.max(usage.promptTokens ?? 0, split)
  return total > 0 ? total : undefined
}

/**
 * Remember the provider-reported size of the request that just completed.
 * `sentMessages` are the conversation messages that request carried (not
 * the system message); `fixedTokens` is the estimate of everything else.
 */
export function recordProviderUsage(
  state: ContextState,
  usage: ProviderResponse['usage'] | undefined,
  sentMessages: readonly SessionMessage[],
  fixedTokens: number,
): void {
  const promptTokens = providerPromptTokens(usage)
  if (!promptTokens) return
  const estimate = Math.max(0, fixedTokens) + estimateMessagesTokens(sentMessages)
  if (estimate > 0) state.calibration = Math.min(2, Math.max(1, promptTokens / estimate))
  state.anchor = {
    promptTokens,
    messageCount: sentMessages.length,
    lastMessageId: sentMessages.at(-1)?.id,
    fixedTokens: Math.max(0, Math.round(fixedTokens)),
    recordedAt: new Date().toISOString(),
  }
}

/** The history was rewritten; the last provider count no longer describes it. */
export function invalidateUsageAnchor(state: ContextState): void {
  state.anchor = undefined
}

export type ContextMeasurement = {
  tokens: number
  source: 'provider+delta' | 'estimate'
}

/**
 * Size of the next request: anchored on the last provider count when the
 * history still starts with the messages that request carried, else a full
 * local estimate.
 */
export function measureContext(
  state: ContextState | undefined,
  messages: readonly SessionMessage[],
  fixedTokens: number,
): ContextMeasurement {
  const anchor = state?.anchor
  if (
    anchor &&
    anchor.messageCount > 0 &&
    anchor.messageCount <= messages.length &&
    messages[anchor.messageCount - 1]?.id === anchor.lastMessageId
  ) {
    const added = estimateMessagesTokens(messages.slice(anchor.messageCount))
    const fixedGrowth = Math.max(0, fixedTokens - anchor.fixedTokens)
    return { tokens: anchor.promptTokens + added + fixedGrowth, source: 'provider+delta' }
  }
  const estimate = Math.max(0, fixedTokens) + estimateMessagesTokens(messages)
  // No anchor (first request, or right after a compaction): use the last
  // known provider/estimate ratio so a dense tokenizer is not underestimated.
  return { tokens: Math.ceil(estimate * (state?.calibration ?? 1)), source: 'estimate' }
}
