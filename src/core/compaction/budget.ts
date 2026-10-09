/**
 * Context budget: every size limit used by context management derives from
 * the model's context window, so the same code behaves sensibly on a 32K
 * local model and a 1M-token frontier model.
 */

/** Window assumed when neither the profile nor known-model rules know it. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Output reserve when the provider does not say how many tokens it requests. */
const DEFAULT_RESERVED_OUTPUT = 16_000

/** Default proactive trigger, as a fraction of the effective window. */
export const DEFAULT_COMPACT_THRESHOLD = 0.78

export type ContextBudget = {
  /** Model context window in tokens. */
  window: number
  /** Tokens kept free for the model's reply (max output tokens). */
  reservedOutput: number
  /** Extra headroom for estimation error and request framing. */
  safetyMargin: number
  /** window - reservedOutput - safetyMargin: the most a request may carry. */
  effective: number
  /** Proactive compaction starts when the measured context reaches this. */
  threshold: number
  /** Clearing old tool results is enough when it brings the context below this. */
  target: number
  /** Recent history kept verbatim by a summarizing compaction. */
  tailTokens: number
  /** Recent history whose tool results are never cleared. */
  toolProtectTokens: number
  /** Tool results above this are spilled to a file on intake. */
  inlineToolResultTokens: number
  /** Same, for file reads (read_file and resource reads). */
  inlineReadTokens: number
  /** Size of the inline preview kept for a spilled tool result. */
  toolPreviewTokens: number
  /** Budget for state re-attached after compaction (task board, files, pending work). */
  restoreTokens: number
  /** Upper bound asked of the summarizer for one summary. */
  summaryTokens: number
}

export type ContextBudgetInput = {
  /** Model window in tokens; undefined or non-positive uses DEFAULT_CONTEXT_WINDOW. */
  contextWindow?: number
  /** Optional caller-imposed cap below the model window (cost control). */
  maxContextTokens?: number
  /** Tokens the provider requests for output (max_tokens), when known. */
  maxOutputTokens?: number
  /** Proactive trigger as a fraction of the effective window (0.3-0.95). */
  thresholdRatio?: number
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function resolveContextBudget(input: ContextBudgetInput = {}): ContextBudget {
  const modelWindow = positive(input.contextWindow) ?? DEFAULT_CONTEXT_WINDOW
  const cap = positive(input.maxContextTokens)
  const window = cap ? Math.min(modelWindow, cap) : modelWindow

  // Some APIs reject input + max_tokens > window, so the full output request
  // is reserved, but never more than a quarter of the window.
  const requestedOutput = positive(input.maxOutputTokens) ?? DEFAULT_RESERVED_OUTPUT
  const reservedOutput = Math.min(requestedOutput, Math.floor(window * 0.25))
  // At least fitOutputTokensToWindow's margin (max(1024, 2% of the window)),
  // so a prompt that fits `effective` always leaves room for reservedOutput.
  const safetyMargin = Math.max(1_024, Math.ceil(window * 0.05))
  const effective = Math.max(1_000, window - reservedOutput - safetyMargin)

  const ratio = typeof input.thresholdRatio === 'number' && Number.isFinite(input.thresholdRatio)
    ? clamp(input.thresholdRatio, 0.3, 0.95)
    : DEFAULT_COMPACT_THRESHOLD
  const threshold = Math.floor(effective * ratio)

  return {
    window,
    reservedOutput,
    safetyMargin,
    effective,
    threshold,
    target: Math.floor(Math.min(effective * 0.6, threshold * 0.85)),
    tailTokens: Math.floor(effective * 0.25),
    toolProtectTokens: Math.floor(effective * 0.2),
    inlineToolResultTokens: clamp(Math.floor(effective * 0.03), 1_500, 8_000),
    // read_file already caps one read at 25K tokens and the agent asked for
    // that content explicitly, so file reads get a larger inline allowance.
    inlineReadTokens: clamp(Math.floor(effective * 0.15), clamp(Math.floor(effective * 0.03), 1_500, 8_000), 25_000),
    toolPreviewTokens: clamp(Math.floor(effective * 0.012), 600, 2_500),
    restoreTokens: clamp(Math.floor(effective * 0.08), 1_500, 30_000),
    summaryTokens: clamp(Math.floor(effective * 0.06), 1_200, 12_000),
  }
}

/**
 * Default context cap for hosted runs (headless `artemis execute`, web
 * sessions, chat bridges). Every turn is paid per token: without a cap a
 * 1M-window model would carry up to ~700K tokens on every request.
 */
export const HOSTED_DEFAULT_MAX_CONTEXT_TOKENS = 200_000

/** Environment variable the server or provisioning can set to change the cap. */
export const MAX_CONTEXT_TOKENS_ENV = 'ARTEMIS_MAX_CONTEXT_TOKENS'

export type ContextCapMode = 'hosted' | 'interactive'

/**
 * Parse a cap setting. A positive number caps; 0, "off", "none" or
 * "unlimited" explicitly remove the cap; anything else means "not set".
 */
export function parseContextCap(value: unknown): number | null | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0) return Math.floor(value)
    if (value === 0) return null
    return undefined
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()
    if (!trimmed) return undefined
    if (['0', 'off', 'none', 'unlimited', 'false'].includes(trimmed)) return null
    const parsed = Number(trimmed.replace(/[_,]/g, ''))
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return undefined
}

/**
 * The effective context cap, in order of precedence:
 *   1. setup.agent.compression.maxContextTokens (per install / workspace)
 *   2. ARTEMIS_MAX_CONTEXT_TOKENS (set by the server or provisioning)
 *   3. the mode default: 200K for hosted runs, none for the interactive CLI
 * Returns undefined when the full model window should be used.
 */
export function resolveMaxContextTokens(input: {
  configured?: unknown
  mode: ContextCapMode
  env?: Record<string, string | undefined>
}): number | undefined {
  const configured = parseContextCap(input.configured)
  if (configured !== undefined) return configured ?? undefined
  const fromEnv = parseContextCap((input.env ?? process.env)[MAX_CONTEXT_TOKENS_ENV])
  if (fromEnv !== undefined) return fromEnv ?? undefined
  return input.mode === 'hosted' ? HOSTED_DEFAULT_MAX_CONTEXT_TOKENS : undefined
}
