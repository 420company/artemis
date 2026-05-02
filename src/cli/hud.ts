/* eslint-disable @typescript-eslint/no-unused-vars, no-control-regex */
/**
 * cli/hud.ts — heads-up display overlay
 *
 * Centered 3-line status bar with context-window progress bar.
 * Adapts to terminal width and color-codes the bar by usage level.
 */

import { stringWidth } from '../input/stringWidth.js'

const A = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  white:   '\x1b[97m',
}

function useAnsi(): boolean { return process.stdout.isTTY === true }
function c(text: string, ...codes: string[]): string {
  return useAnsi() ? codes.join('') + text + A.reset : text
}
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}
function visLen(s: string): number {
  return stringWidth(stripAnsi(s))
}
function padTo(s: string, w: number): string {
  const d = w - visLen(s)
  return d > 0 ? s + ' '.repeat(d) : s
}

function truncatePlainText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth === 1) return '…'

  let out = ''
  let width = 0
  for (const char of text) {
    const nextWidth = width + stringWidth(char)
    if (nextWidth > maxWidth - 1) break
    out += char
    width = nextWidth
  }
  return `${out}…`
}

// ─── context limit estimation ─────────────────────────────────────────────────

export function normalizeContextLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : undefined
}

export function estimateContextLimit(model: string, configuredLimit?: number): number {
  const explicit = normalizeContextLimit(configuredLimit)
  if (explicit) return explicit

  const m = model.toLowerCase()
  if (m.includes('claude-opus-4') || m.includes('claude-sonnet-4') || m.includes('claude-haiku-4')) return 200_000
  if (m.includes('claude')) return 200_000
  if (m.includes('gpt-5.5')) return 1_000_000
  if (m.includes('gpt-5')) return 400_000
  if (m.includes('gpt-4.1')) return 1_000_000
  if (m.includes('gemini-1.5') || m.includes('gemini-2')) return 1_000_000
  if (m.includes('gemini')) return 1_000_000
  if (m.includes('gpt-4o') || m.includes('gpt-4-turbo')) return 128_000
  if (m.includes('gpt-4')) return 128_000
  if (m.includes('gpt-3.5')) return 16_000
  if (m.includes('deepseek-reasoner') || m.includes('deepseek-r1')) return 128_000
  if (m.includes('deepseek')) return 128_000
  if (m.includes('kimi') || m.includes('moonshot')) return 128_000
  if (m.includes('qwen') || m.includes('glm')) return 128_000
  if (m.includes('seed-') || m.includes('ark-') || m.includes('bytedance')) return 128_000
  return 128_000
}

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// ─── state ────────────────────────────────────────────────────────────────────

export interface HudState {
  defaultModel: string
  lastModel: string
  contextLimit?: number
  brainModel?: string   // specialist/brain model when dual-model is active
  lastProfileLabel?: string
  permissionMode: string
  sessionMessageCount: number
  changedFilesCount: number
  verificationCount: number
  taskCount: number
  taskRuntimeCount: number
  activeTaskRuntimeCount: number
  pluginCount: number
  skillCount: number
  mcpServerCount: number
  sessionTotalTokens: number
  lastPromptTokens: number
  lastCompletionTokens: number
  lastTotalTokens: number
  lastFirstResponseMs?: number
  lastDurationMs?: number
  turnsWithUsage: number
  lastTokenUsageEstimated?: boolean
}

export interface HudUsage {
  model?: string
  contextLimit?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  firstResponseMs?: number
  durationMs?: number
  profileLabel?: string
  tokenUsageSource?: 'provider' | 'estimated'
}

export function createHudState(defaultModel: string, contextLimit?: number): HudState {
  return {
    defaultModel,
    lastModel: defaultModel,
    contextLimit: normalizeContextLimit(contextLimit),
    permissionMode: 'accept-all',
    sessionMessageCount: 0,
    changedFilesCount: 0,
    verificationCount: 0,
    taskCount: 0,
    taskRuntimeCount: 0,
    activeTaskRuntimeCount: 0,
    pluginCount: 0,
    skillCount: 0,
    mcpServerCount: 0,
    sessionTotalTokens: 0,
    lastPromptTokens: 0,
    lastCompletionTokens: 0,
    lastTotalTokens: 0,
    turnsWithUsage: 0,
  }
}

export function updateHudState(state: HudState, usage: HudUsage): void {
  const model = usage.model?.trim() || state.defaultModel
  const total = usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0))
  state.lastModel = model
  state.contextLimit = normalizeContextLimit(usage.contextLimit) ?? state.contextLimit
  state.lastProfileLabel = usage.profileLabel?.trim() || state.lastProfileLabel
  state.lastPromptTokens = usage.promptTokens ?? 0
  state.lastCompletionTokens = usage.completionTokens ?? 0
  state.lastTotalTokens = total
  state.lastFirstResponseMs = usage.firstResponseMs
  state.lastDurationMs = usage.durationMs
  state.lastTokenUsageEstimated = usage.tokenUsageSource === 'estimated'
  if (total > 0) {
    state.sessionTotalTokens += total
    state.turnsWithUsage++
  }
}

// ─── render ───────────────────────────────────────────────────────────────────

const MAUVE = '\x1b[38;2;203;166;247m'  // Catppuccin mauve — brain model accent

/** Build a colored model part string. Dual-model shows exec ⇄ brain. */
function makeModelPart(execText: string, brainText?: string): string {
  if (brainText) {
    return (
      c(execText, A.white + A.bold) +
      c(' ⇄ ', A.dim) +
      c(brainText, MAUVE + A.bold)
    )
  }
  return c(execText, A.white + A.bold)
}

function formatLatencyCompact(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}s`
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`
  return `${Math.round(value)}ms`
}

export function renderHud(state: HudState): string {
  const model  = state.lastModel || state.defaultModel
  const brain  = state.brainModel && state.brainModel !== model ? state.brainModel : undefined
  const ctx    = state.lastPromptTokens  // current context window usage
  const limit  = estimateContextLimit(model, state.contextLimit)
  const pct    = ctx > 0 ? Math.min(100, Math.round(ctx / limit * 100)) : 0
  const firstLatency = formatLatencyCompact(state.lastFirstResponseMs)
  const totalLatency = formatLatencyCompact(state.lastDurationMs)
  const telemetryLabel = state.lastProfileLabel
    ? truncatePlainText(state.lastProfileLabel, 14)
    : undefined
  const latencyStr =
    firstLatency || totalLatency
      ? `${telemetryLabel ? `${telemetryLabel} ` : ''}${firstLatency ? `${firstLatency}→` : ''}${totalLatency ?? firstLatency}`
      : undefined

  // ── non-TTY fallback ──────────────────────────────────────────────────────
  if (!useAnsi()) {
    const bar = `[${'#'.repeat(Math.round(pct / 10))}${'.'.repeat(10 - Math.round(pct / 10))}]`
    const approx = state.lastTokenUsageEstimated ? '~' : ''
    const ctxStr = ctx > 0 ? `${approx}${fmtTok(ctx)} / ${fmtTok(limit)}` : fmtTok(limit)
    const modelStr = brain ? `${model} ⇄ ${brain}` : model
    return `◈ ${modelStr}  ${bar} ${pct}%  ·  ${ctxStr}${latencyStr ? `  ·  ${latencyStr}` : ''}`
  }

  // ── progress bar ──────────────────────────────────────────────────────────
  const termW = Math.max(20, process.stdout.columns ?? 80)
  const BAR_LEN  = termW >= 90 ? 14 : termW >= 70 ? 10 : termW >= 56 ? 8 : 6
  const filled   = Math.round(pct / 100 * BAR_LEN)
  const empty    = BAR_LEN - filled
  const barColor = pct >= 85 ? A.red : pct >= 60 ? A.yellow : A.green
  const bar      = c('█'.repeat(filled), barColor) + c('░'.repeat(empty), A.dim)

  const pctStr     = pct > 0 ? `${pct}%` : '—'
  const approx     = state.lastTokenUsageEstimated ? '~' : ''
  const ctxStr     = ctx > 0 ? `${approx}${fmtTok(ctx)} / ${fmtTok(limit)}` : fmtTok(limit)
  const ctxCompact = ctx > 0 ? `${approx}${fmtTok(ctx)}/${fmtTok(limit)}` : fmtTok(limit)
  const pctColor   = pct >= 85 ? A.red + A.bold : pct >= 60 ? A.yellow + A.bold : A.green

  // When dual-model, each name gets ~18% termW; single model gets ~28–40%
  const dualEachW   = Math.max(6, Math.floor(termW * 0.18))
  const dualEachWmd = Math.max(6, Math.floor(termW * 0.15))

  const buildWide = (execText: string, brainText?: string): string =>
    c('◈', A.cyan + A.bold) + ' ' +
    makeModelPart(execText, brainText) +
    c('  ·  ', A.dim) +
    bar + ' ' +
    c(pctStr.padStart(4), pctColor) +
    c('  ·  ', A.dim) +
    c(ctxStr, A.cyan) +
    (latencyStr ? c('  ·  ', A.dim) + c(latencyStr, A.blue) : '')

  const buildMedium = (execText: string, brainText?: string): string =>
    c('◈', A.cyan + A.bold) + ' ' +
    makeModelPart(execText, brainText) +
    c('  ', A.dim) +
    bar + ' ' +
    c(pctStr, pctColor) +
    c('  ', A.dim) +
    c(ctxCompact, A.cyan) +
    (latencyStr ? c('  ', A.dim) + c(latencyStr, A.blue) : '')

  const buildNarrow = (execText: string, brainText?: string): string =>
    c('◈', A.cyan + A.bold) + ' ' +
    makeModelPart(execText, brainText) +
    c('  ', A.dim) +
    c(ctxCompact, A.cyan)

  const candidates = brain ? [
    // Dual-model candidates
    buildWide(
      truncatePlainText(model, dualEachW),
      truncatePlainText(brain, dualEachW),
    ),
    buildMedium(
      truncatePlainText(model, dualEachWmd),
      truncatePlainText(brain, dualEachWmd),
    ),
    // Narrow: just exec model, drop brain
    buildNarrow(truncatePlainText(model, Math.max(6, Math.floor(termW * 0.35)))),
    c('◈', A.cyan + A.bold) + ' ' + c(truncatePlainText(model, Math.max(4, termW - 2)), A.white + A.bold),
  ] : [
    // Single-model candidates
    buildWide(truncatePlainText(model, Math.max(6, Math.floor(termW * 0.28)))),
    buildMedium(truncatePlainText(model, Math.max(6, Math.floor(termW * 0.24)))),
    buildNarrow(truncatePlainText(model, Math.max(6, Math.floor(termW * 0.4)))),
    c('◈', A.cyan + A.bold) + ' ' + c(truncatePlainText(model, Math.max(4, termW - 2)), A.white + A.bold),
  ]

  const content = candidates.find(line => visLen(line) <= termW) ?? candidates[candidates.length - 1]
  const contentVis = visLen(content)
  const lpad = Math.max(0, Math.floor((termW - contentVis) / 2))
  return ' '.repeat(lpad) + content
}
