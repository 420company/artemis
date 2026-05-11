/**
 * collapse/ — Persistent Collapse Ledger System
 *
 * Prevents "失忆" (forgetting), "混乱" (confusion), and "串台" (context mixing)
 * during long sessions (8+ hours) by:
 *
 * 1. ledger.ts — Persisting compression metadata to disk so context
 *    is recoverable across compactions, not just within a single request
 *
 * 2. postCompactRecovery.ts — Re-injecting file states, plans, tools,
 *    MCP servers, and skills after compaction (like ClaudeCode's
 *    compact → attachment pipeline)
 *
 * 3. circuitBreaker.ts — Stopping infinite compression retry loops
 *    when context is irrecoverably large
 *
 * 4. artifactIndex.ts — Storing large tool outputs as disk artifacts
 *    with lightweight inline references, instead of keeping them
 *    verbatim in conversation history
 */

export {
  loadLedger,
  saveLedger,
  createLedger,
  getOrCreateLedger,
  recordCollapse,
  createFileStateSnapshot,
  saveFileArtifact,
  loadFileArtifact,
  cleanupLedger,
  getLastCollapse,
  getCollapseCount,
  getTokenSavings,
  hashContent,
} from './ledger.js'

export type {
  CollapseEntry,
  FileStateSnapshot,
  PlanSnapshot,
  CollapseLedger,
} from './ledger.js'

export {
  buildPostCompactRecoveryMessages,
  prepareForSessionRestore,
} from './postCompactRecovery.js'

export {
  createCircuitBreakerState,
  recordCompressionFailure,
  recordCompressionSuccess,
  recordTurnCompleted,
  isCircuitBreakerTripped,
  getCircuitBreakerStatus,
} from './circuitBreaker.js'

export type { CircuitBreakerState } from './circuitBreaker.js'

export {
  maybeStoreToolArtifact,
  loadToolArtifact,
  loadToolArtifactById,
  cleanupSessionArtifacts,
  getSessionArtifactSize,
} from './artifactIndex.js'

export type { ArtifactIndex } from './artifactIndex.js'
