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

export type CircuitBreakerState = {
  consecutiveFailures: number
  turnsSinceLastFailure: number
  lastFailureAt: string | null
  lastFailureReason: string | null
  trippedAt: string | null
}

export function createCircuitBreakerState(): CircuitBreakerState {
  return {
    consecutiveFailures: 0,
    turnsSinceLastFailure: 0,
    lastFailureAt: null,
    lastFailureReason: null,
    trippedAt: null,
  }
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
