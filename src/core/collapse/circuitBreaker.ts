/**
 * collapse/circuitBreaker.ts — Prevent infinite compression loops
 *
 * ClaudeCode limits consecutive autocompact failures to 3 before
 * giving up (autoCompact.ts:70). Without this, a session with
 * irrecoverably large context can waste hundreds of API calls
 * retrying compression that will never succeed.
 */

const MAX_CONSECUTIVE_FAILURES = 3
const RESET_AFTER_SUCCESSFUL_TURNS = 5

// ── Churn detection (rumination loop) ────────────────────────────────────────
// When the compressor keeps firing but no Edit/Write ops occur between firings,
// the model is stuck re-reading the same context after every compaction. We
// detect this and dynamically escalate the compression threshold so the model
// has more headroom to actually act.
const CHURN_WINDOW_MS = 5 * 60 * 1000        // look at compressions in last 5 min
const CHURN_TRIGGER_COUNT = 3                // 3+ compressions within window
const CHURN_THRESHOLD_STEP = 1.5             // multiply threshold by this per escalation
const CHURN_THRESHOLD_CEIL = 4.0             // cap multiplier so we still compress eventually
const CHURN_DECAY_AFTER_MS = 10 * 60 * 1000  // reset multiplier after this much quiet time

export type CircuitBreakerState = {
  consecutiveFailures: number
  turnsSinceLastFailure: number
  lastFailureAt: string | null
  lastFailureReason: string | null
  trippedAt: string | null
  // Churn detection fields
  recentCompressionTimestamps: number[]   // ms epoch, sliding window
  thresholdMultiplier: number              // ≥ 1.0, applied to compression triggers
  lastCompressionAt: number                // ms epoch of most recent compression
}

export function createCircuitBreakerState(): CircuitBreakerState {
  return {
    consecutiveFailures: 0,
    turnsSinceLastFailure: 0,
    lastFailureAt: null,
    lastFailureReason: null,
    trippedAt: null,
    recentCompressionTimestamps: [],
    thresholdMultiplier: 1.0,
    lastCompressionAt: 0,
  }
}

/**
 * Record that a compression just ran. Returns updated state with churn
 * detection applied — if we've seen many compressions in the window
 * AND the caller reports no Edit/Write ops happened between compressions,
 * the threshold multiplier escalates.
 *
 * Caller passes `editsSinceLast` so this module stays decoupled from
 * conversation message inspection.
 */
export function recordCompressionTriggered(
  state: CircuitBreakerState,
  opts: { editsSinceLast: number; now?: number },
): { state: CircuitBreakerState; churnDetected: boolean } {
  const now = opts.now ?? Date.now()
  const fresh = state.recentCompressionTimestamps
    .filter(t => t > now - CHURN_WINDOW_MS)
  fresh.push(now)

  let nextMultiplier = state.thresholdMultiplier || 1.0
  // Decay multiplier if it's been quiet
  if (state.lastCompressionAt > 0 && now - state.lastCompressionAt > CHURN_DECAY_AFTER_MS) {
    nextMultiplier = 1.0
  }

  // Escalate when: window has 3+ compressions AND no edits since last one
  const churnDetected = fresh.length >= CHURN_TRIGGER_COUNT && opts.editsSinceLast === 0
  if (churnDetected) {
    nextMultiplier = Math.min(nextMultiplier * CHURN_THRESHOLD_STEP, CHURN_THRESHOLD_CEIL)
  }

  return {
    state: {
      ...state,
      recentCompressionTimestamps: fresh,
      thresholdMultiplier: nextMultiplier,
      lastCompressionAt: now,
    },
    churnDetected,
  }
}

export function getThresholdMultiplier(state: CircuitBreakerState): number {
  return state.thresholdMultiplier && state.thresholdMultiplier >= 1.0
    ? Math.min(state.thresholdMultiplier, CHURN_THRESHOLD_CEIL)
    : 1.0
}

export function recordCompressionFailure(
  state: CircuitBreakerState,
  reason: string,
): CircuitBreakerState {
  const next = { ...state }
  next.consecutiveFailures += 1
  next.turnsSinceLastFailure = 0
  next.lastFailureAt = new Date().toISOString()
  next.lastFailureReason = reason

  if (next.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    next.trippedAt = new Date().toISOString()
  }

  return next
}

export function recordCompressionSuccess(
  state: CircuitBreakerState,
): CircuitBreakerState {
  return {
    ...state,
    consecutiveFailures: 0,
    turnsSinceLastFailure: 0,
    trippedAt: null,
  }
}

export function recordTurnCompleted(
  state: CircuitBreakerState,
): CircuitBreakerState {
  const next = { ...state }
  next.turnsSinceLastFailure += 1

  // Auto-reset after N successful turns
  if (
    next.consecutiveFailures > 0 &&
    next.turnsSinceLastFailure >= RESET_AFTER_SUCCESSFUL_TURNS
  ) {
    next.consecutiveFailures = 0
    next.trippedAt = null
    next.lastFailureAt = null
    next.lastFailureReason = null
  }

  return next
}

export function isCircuitBreakerTripped(state: CircuitBreakerState): boolean {
  return state.trippedAt !== null
}

export function getCircuitBreakerStatus(state: CircuitBreakerState): {
  tripped: boolean
  failures: number
  maxFailures: number
  reason: string | null
} {
  return {
    tripped: isCircuitBreakerTripped(state),
    failures: state.consecutiveFailures,
    maxFailures: MAX_CONSECUTIVE_FAILURES,
    reason: state.lastFailureReason,
  }
}
