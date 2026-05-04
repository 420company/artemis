/* eslint-disable @typescript-eslint/no-unused-vars, prefer-const */
/**
 * cli/interactive.ts — interactive REPL loop
 */

// ─── Catppuccin Mocha conversation palette ────────────────────────────────────
// Colors match the Gemini CLI aesthetic: vibrant on dark bg = "glow" effect
const _E = '\x1b'
const _R = `${_E}[0m`
const CC = {
  // Catppuccin Mocha true-color
  blue:    `${_E}[38;2;137;180;250m`,   // #89B4FA — user
  bblue:   `${_E}[1;38;2;137;180;250m`, // bold blue
  dblue:   `${_E}[38;2;60;80;150m`,     // dim blue (glow edge)
  mauve:   `${_E}[38;2;203;166;247m`,   // #CBA6F7 — AI
  bmauve:  `${_E}[1;38;2;203;166;247m`, // bold mauve
  dmauve:  `${_E}[38;2;90;65;130m`,     // dim mauve (glow edge)
  text:    `${_E}[38;2;205;214;244m`,   // #CDD6F4 — body text
  green:   `${_E}[38;2;166;227;161m`,   // #A6E3A1
  peach:   `${_E}[38;2;250;179;135m`,   // #FAB387
  overlay: `${_E}[38;2;88;91;112m`,     // #585B70 — dim overlay
  R: _R,
  bold: `${_E}[1m`,
  dim:  `${_E}[2m`,
  italic: `${_E}[3m`,
}

type ConversationRole = 'user' | 'assistant'
type BridgePlatform = 'telegram' | 'discord' | 'wechat' | 'cli'

/** Generate a gradient ─── separator line transitioning from blue to mauve (top of user turn) */
function convSeparator(): string {
  const isTTY = process.stdout.isTTY === true
  if (!isTTY) return '  ' + '─'.repeat(50)
  const cols  = process.stdout.columns ?? 80
  const width = Math.min(cols - 4, 72)
  let out = '  '
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1)
    const r = Math.round(60 + t * (90 - 60))
    const g = Math.round(80 + t * (65 - 80))
    const b = Math.round(150 + t * (130 - 150))
    out += `${_E}[38;2;${r};${g};${b}m─`
  }
  return out + _R
}

/** Reverse gradient ─── separator line from mauve to blue (bottom of AI turn) */
function convSeparatorBottom(): string {
  const isTTY = process.stdout.isTTY === true
  if (!isTTY) return '  ' + '─'.repeat(50)
  const cols  = process.stdout.columns ?? 80
  const width = Math.min(cols - 4, 72)
  let out = '  '
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1)
    // mauve (#5A4182) → blue (#3C5096)
    const r = Math.round(90 + t * (60 - 90))
    const g = Math.round(65 + t * (80 - 65))
    const b = Math.round(130 + t * (150 - 130))
    out += `${_E}[38;2;${r};${g};${b}m─`
  }
  return out + _R
}

function timeStampLabel(date = new Date()): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function bridgePlatformBadge(platform: BridgePlatform): string {
  switch (platform) {
    case 'telegram': return '✈️ Telegram'
    case 'discord': return '💬 Discord'
    case 'wechat': return '🟢 WeChat'
    case 'cli': return '🌙 Artemis'
  }
}

function buildPlainConversationHeader(options: {
  role: ConversationRole
  timestamp?: string
  platform?: BridgePlatform
  targetLabel?: string
}): string {
  const icon = options.role === 'assistant' ? '🤖' : '🧑'
  const parts: string[] = []
  if (options.platform) parts.push(bridgePlatformBadge(options.platform))
  if (options.targetLabel) parts.push(options.targetLabel)
  if (options.timestamp) parts.push(options.timestamp)
  return `  ${icon}${parts.length > 0 ? `  ${parts.join(' · ')}` : ''}`
}

function buildAnsiConversationHeader(options: {
  role: ConversationRole
  timestamp?: string
  platform?: BridgePlatform
  targetLabel?: string
}): string {
  const lead = options.role === 'assistant'
    ? `${CC.dmauve}╸${_R}${CC.bmauve} 🤖${_R}`
    : `${CC.dblue}▌${_R}${CC.bblue} 🧑${_R}`
  const parts: string[] = []
  if (options.platform) parts.push(bridgePlatformBadge(options.platform))
  if (options.targetLabel) parts.push(options.targetLabel)
  if (options.timestamp) parts.push(options.timestamp)
  return `  ${lead}${parts.length > 0 ? `${CC.overlay}  ${parts.join(' · ')}${_R}` : ''}`
}

/** Render the user message header with glow effect */
function renderUserHeader(text: string): void {
  const sep = convSeparator()
  const header = buildAnsiConversationHeader({ role: 'user', timestamp: timeStampLabel() })
  process.stdout.write(`\n${sep}\n${header}\n\n`)
  for (const line of text.split('\n')) {
    process.stdout.write(`  ${CC.text}${line}${_R}\n`)
  }
  process.stdout.write('\n')
}

/** Render the AI turn header with glow effect */
function renderAiHeader(timestamp = timeStampLabel()): void {
  process.stdout.write(buildAnsiConversationHeader({ role: 'assistant', timestamp }) + '\n')
}

function renderBridgeNotificationBlock(options: {
  platform: BridgePlatform
  direction: 'inbound' | 'outbound'
  targetLabel: string
  text: string
}): string {
  const role: ConversationRole = options.direction === 'outbound' ? 'assistant' : 'user'
  const body = role === 'assistant' ? formatRichOutput(options.text) : stripAnsi(options.text)
  const bodyLines = body.split('\n')
  const block: string[] = []
  if (options.direction === 'inbound') block.push(convSeparator())
  block.push(buildAnsiConversationHeader({
    role,
    platform: options.platform,
    targetLabel: options.targetLabel,
    timestamp: timeStampLabel(),
  }))
  block.push('')
  for (const line of bodyLines) {
    block.push(role === 'assistant' ? `  ${line}` : `  ${CC.text}${line}${_R}`)
  }
  if (options.direction === 'outbound') block.push(convSeparatorBottom())
  block.push('')
  return block.join('\n')
}

type LiveAssistantRenderState = {
  timestamp: string
  content: string
}

type LiveWorkflowRenderState = {
  label: string
  content: string
}

type RunningMessageHooks = Pick<ThinkOptions, 'pollRunningUserMessages' | 'onRunningUserMessageAccepted'>

type DetachedRunningMessageCapture = {
  capture: (line: string) => void
}

function renderLiveAssistantViewport(state: LiveAssistantRenderState): void {
  // DISABLED: All content should be managed through redrawViewportFromState()
  // to ensure it respects DECSTBM scroll region boundaries.
  // This function was causing content to overflow into the HUD area.
  if (!process.stdout.isTTY) return
}

function renderLiveWorkflowViewport(state: LiveWorkflowRenderState): void {
  // DISABLED: All content should be managed through redrawViewportFromState()
  // to ensure it respects DECSTBM scroll region boundaries.
  // This function was causing content to overflow into the HUD area.
  if (!process.stdout.isTTY) return
}

import path from 'node:path'
import * as os from 'node:os'
import { stat, unlink } from 'node:fs/promises'
import { think, resetSession, getMessages, restoreSession, setSystemPromptSuffix, getSystemPromptSuffix, applyProviderOverrides, switchModel, getLastPromptTokens, getBifrostContextAuditReport } from '../brain.js'
import type { ThinkOptions } from '../brain.js'
import { type SlashMenuItem } from './prompt.js'
import { pickKaomoji } from './kaomoji.js'
import { createBlessedPrompt, type BlessedPromptHandle } from './blessedPrompt.js'
import { runBundle, shouldAutoBundle } from '../core/bundle.js'
import {
  getBackgroundTaskRegistry,
  formatBackgroundTaskLine,
} from '../core/backgroundTasks.js'
import { runBundleDialog } from './bundleDialog.js'
import { runBundleOnboarding } from './bundleOnboarding.js'
import { formatToolDone, formatToolPermission, formatToolResultPreview } from './toolRender.js'
import { setBridgePrinter } from './bridgeNotify.js'
import type { BridgeTerminalEvent, TerminalNotification } from './bridgeNotify.js'
import { buildInteractiveCompactHero, buildInteractiveHero, APP_NAME, APP_VERSION, APP_PUBLISHER } from './branding.js'
import { buildPanel, formatRichOutput, isHighEasterEggTrigger, buildHighEasterEggCompact } from './ui.js'
import { createHudState, updateHudState, renderHud, fmtTok } from './hud.js'
import type { UiLocale } from './locale.js'
import { pickLocale } from './locale.js'
import type { PermissionMode } from './parseArgs.js'
import { CliSettingsStore } from './settings.js'
import type { DocsSearchEngine } from './settings.js'
import { ProviderStore } from '../providers/store.js'
import { SessionStore } from '../storage/sessions.js'
import type { SessionMessage, SessionRecord } from '../core/types.js'
import { PromptHistoryStore } from './promptHistory.js'
import { buildFullSystemSuffix } from './artemisMd.js'
import { loadUserProfile, saveUserProfile, autoUpdateUserProfile } from '../memory/userProfile.js'
import { searchSessions } from '../storage/sessionSearch.js'
import { summarizeOnce } from '../brain.js'
import { McpServerStore } from '../mcp/store.js'
import { suggestMcpServersForIntent } from '../mcp/runtime.js'
import { OdinStore } from '../odin/store.js'
import { CronScheduler } from '../services/cron.js'
import { BragiStore } from '../bragi/store.js'
import { runOnboarding, runVisualModelSetup } from './onboarding.js'
import {
  runVercelAuthWizard,
  readStoredVercelAuth,
  clearStoredVercelAuth,
} from './vercelAuth.js'
import { runSetupWizard } from './setupWizard.js'
import { runFirstRunWelcome } from './firstRunWelcome.js'
import {
  buildDefaultSoulMarkdown,
  buildSoulMarkdown,
  buildSoulProfile,
  dismissSoulOnboarding,
  getSoulPath,
  hasSoulFile,
  readSoulFile,
  saveSoulFile,
  selectSoulQuestions,
  type SoulMode,
} from './soulOnboarding.js'
import { runWorkspaceTrustDialog } from './workspaceTrust.js'
import { resolveWorkspaceIntent } from './workspaceIntent.js'
import { wordupNow } from './wordup.js'
import { getWorkflowDisplayName } from '../core/workflowMode.js'
import type { WorkflowMode } from '../core/workflowMode.js'
import { buildWorkflowHint, buildWorkflowCompletionNote } from '../core/workflowHints.js'
import { routeTeamRequest, describeChoice } from '../core/team.js'
import {
  applyWorkflowProgressInfo,
  createWorkflowProgressState,
  markWorkflowProgressComplete,
  renderWorkflowProgress,
  shouldSurfaceWorkflowInfo,
  formatWorkflowInfoForScrollback,
} from './workflowProgress.js'
import { resolveMainProviderConfig, ensureDoubleModelSetup } from '../providers/onboarding.js'
import { createConsolePromptIO } from '../providers/router.js'
import { createTrackedProviderFromConfig } from '../providers/telemetry.js'
import { createProviderRouter } from '../providers/router.js'
import { PermissionManager } from '../security/permissions.js'
import { appendDetachedWorkflowMessage, spawnDetachedWorkflow } from '../services/detachedWorkflow.js'
import { parseHeimdallCommandBody, buildHeimdallReport, buildHeimdallThreadsReport } from '../services/heimdallControl.js'
import stripAnsi from 'strip-ansi'
import { stringWidth } from '../input/stringWidth.js'
import { getDirectToolCount } from '../tools/directTools.js'
import type { WorkspaceSwitchRequest } from '../tools/types.js'
import { resolveDataRootDir } from '../utils/fs.js'
import {
  detectVisualGenerationNeed,
  describeVisualProvider,
  hasExplicitLocalVisualConsent,
  hasExplicitRemoteVisualFallback,
  resolveConfiguredVisualProvider,
} from '../utils/visualGenerationConfig.js'

const HOME_DIR = os.homedir()
const DIRECT_TOOL_COUNT = getDirectToolCount()
const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', yellow: '\x1b[33m',
}
const c = (text: string, ...codes: string[]): string =>
  process.stdout.isTTY ? codes.join('') + text + A.reset : text

const TL = {
  userDot: `${_E}[1;38;2;125;211;252m`,
  userText: `${_E}[38;2;224;242;254m`,
  assistantDot: `${_E}[1;38;2;196;181;253m`,
  meta: `${_E}[2;38;2;148;163;184m`,
  note: `${_E}[1;38;2;245;196;94m`,
  success: `${_E}[1;38;2;74;222;128m`,
  warning: `${_E}[1;38;2;245;158;11m`,
  danger: `${_E}[1;38;2;251;113;133m`,
  soft: `${_E}[38;2;241;245;249m`,
  tagBlue: `${_E}[1;38;2;125;211;252m`,
  tagPurple: `${_E}[1;38;2;196;181;253m`,
  tagGold: `${_E}[1;38;2;245;196;94m`,
  tagGreen: `${_E}[1;38;2;74;222;128m`,
  tagRed: `${_E}[1;38;2;251;113;133m`,
}

function tint(text: string, code: string): string {
  return process.stdout.isTTY ? `${code}${text}${_R}` : text
}

// Base fixed-zone height (HUD + input rows + footer).
// The prompt expands this dynamically for overlays and multiline input.
const BASE_FZ = 6
const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[H\x1b[2J'
const LEAVE_ALT_SCREEN = '\x1b[?1049l'
const STREAM_REDRAW_INTERVAL_MS = 50

function truncatePlainToWidth(text: string, maxWidth: number): string {
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

function wrapPlainToWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return ['']
  const sourceLines = text.split('\n')
  const wrapped: string[] = []

  for (const sourceLine of sourceLines) {
    if (sourceLine.length === 0) {
      wrapped.push('')
      continue
    }

    let current = ''
    let width = 0
    for (const char of sourceLine) {
      const charWidth = stringWidth(char)
      if (width + charWidth > maxWidth && current.length > 0) {
        wrapped.push(current)
        current = ''
        width = 0
      }
      current += char
      width += charWidth
    }
    wrapped.push(current)
  }

  return wrapped.length > 0 ? wrapped : ['']
}

function timestampFor(dateInput?: string | number | Date): string {
  if (!dateInput) return ''
  const date = new Date(dateInput)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function buildTimelineMarker(glyph: string, accent: string, meta?: string[]): string {
  const metaText = meta?.filter(Boolean).join(' · ') ?? ''
  const styledGlyph = tint(glyph, accent)
  return metaText
    ? `  ${styledGlyph} ${tint(metaText, TL.meta)}`
    : `  ${styledGlyph}`
}

const USER_GLYPH = '🧑'
const ASSISTANT_GLYPH = '🤖'

function formatElapsedShort(ms: number): string {
  if (ms < 1000) return '<1s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rem = seconds % 60
  return rem === 0 ? `${minutes}m` : `${minutes}m${rem}s`
}

function inferTimelineTone(title: string): 'note' | 'success' | 'warning' | 'danger' {
  const lower = stripAnsi(title).toLowerCase()
  if (/成功|完成|已完成|已更新|已保存|已启用|已就绪|active|enabled|saved|updated|completed|ready|success/.test(lower)) {
    return 'success'
  }
  if (/警告|提醒|warning|caution|注意/.test(lower)) {
    return 'warning'
  }
  if (/错误|失败|拒绝|error|failed|denied|invalid|not found/.test(lower)) {
    return 'danger'
  }
  return 'note'
}

function renderTimelinePanel(title: string, bodyLines: string[]): string {
  const tone = inferTimelineTone(title)
  const icon = tone === 'success' ? '✓' : tone === 'warning' ? '!' : tone === 'danger' ? '✕' : '•'
  const accent = tone === 'success'
    ? TL.success
    : tone === 'warning'
    ? TL.warning
    : tone === 'danger'
    ? TL.danger
    : TL.note
  const output = [`${tint(icon, accent)} ${tint(title, accent)}`]
  for (const rawLine of bodyLines) {
    if (!rawLine.trim()) {
      output.push('')
      continue
    }
    output.push(`  ${rawLine}`)
  }
  return output.join('\n')
}

const THINKING_CAT_FRAMES = [
  {
    starsTop: '   ·    ✦    ·    ',
    starsBottom: '    ✦    ·    ✦   ',
    accent: TL.note,
    cat: [
      '    /\\_/\\   ',
      '   ( ^.^ )  ',
      '    > = <   ',
      '   /     \\  ',
    ],
  },
  {
    starsTop: '  ✦    ·    ✦    ·',
    starsBottom: '  ·    ✦    ·    ✦',
    accent: TL.tagBlue,
    cat: [
      '    /\\_/\\   ',
      '   ( -.- )  ',
      '    < = <   ',
      '   /     \\  ',
    ],
  },
  {
    starsTop: '    ✦    ·    ✦   ',
    starsBottom: ' ·    ✦    ·    · ',
    accent: TL.tagPurple,
    cat: [
      '    /\\_/\\   ',
      '   ( o.o )  ',
      '    > ~ <   ',
      '   /  |  \\  ',
    ],
  },
  {
    starsTop: ' ·   ✦    ·    ✦  ',
    starsBottom: '   ✦    ·   ✦    ',
    accent: TL.tagGold,
    cat: [
      '    /\\_/\\   ',
      '   ( ^o^ )  ',
      '    > = >   ',
      '   /     \\  ',
    ],
  },
] as const

function buildThinkingCatLines(statusText = '· Meow to the Moon! 🚀', frameIndex?: number): string[] {
  const frame = THINKING_CAT_FRAMES[
    typeof frameIndex === 'number'
      ? Math.abs(Math.floor(frameIndex)) % THINKING_CAT_FRAMES.length
      : Math.floor(Date.now() / 250) % THINKING_CAT_FRAMES.length
  ]!
  const textAccent = [
    TL.note,
    TL.tagBlue,
    TL.tagPurple,
    TL.tagGold,
    TL.tagGreen,
  ][
    typeof frameIndex === 'number'
      ? Math.abs(Math.floor(frameIndex)) % 5
      : Math.floor(Date.now() / 200) % 5
  ]!
  return [
    `       ${tint(frame.starsTop, TL.meta)}`,
    ...frame.cat.map((line) => `       ${tint(line, frame.accent)}`),
    `       ${tint(frame.starsBottom, TL.meta)}`,
    `       ${tint(statusText, textAccent)}`,
  ]
}

function styleTimelineLogLine(text: string): string {
  if (!process.stdout.isTTY) return text

  let styled = text
  styled = styled.replace(/\[([^\]]+)\]/g, (_match, inner: string) => {
    let accent = TL.meta
    if (inner.startsWith('tool:')) accent = TL.tagGreen
    else if (inner.startsWith('agent:')) accent = TL.tagPurple
    else if (
      inner.startsWith('design:') ||
      inner.startsWith('contest:') ||
      inner.startsWith('athena:') ||
      inner.startsWith('nidhogg:') ||
      inner.startsWith('niko:')
    ) accent = TL.tagBlue
    else if (
      inner.startsWith('workflow') ||
      inner.startsWith('planner') ||
      inner.startsWith('reviewer') ||
      inner.startsWith('researcher') ||
      inner.startsWith('context') ||
      inner.startsWith('evidence') ||
      inner.startsWith('tasks') ||
      inner.startsWith('plan')
    ) accent = TL.tagGold
    else if (/error|fail/i.test(inner)) accent = TL.tagRed
    return tint(`[${inner}]`, accent)
  })

  styled = styled.replace(/\b(ok|passed|done|ready)\b/gi, (match) => tint(match, TL.success))
  styled = styled.replace(/\b(failed|error|denied|invalid)\b/gi, (match) => tint(match, TL.danger))
  styled = styled.replace(/\b(running|planned|updated|thinking|generating)\b/gi, (match) => tint(match, TL.note))
  return styled
}

// Braille spinner — animates smoothly because the viewport rerenders every
// 250ms while the pending tick is alive. A static "preparing" label is too
// quiet for the 5-20s gap before the first token; an animated frame plus a
// concrete phrase makes "the AI is working" unmistakable.
const PENDING_SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'] as const

function buildPendingAssistantLines(options: {
  phase: 'generating' | 'thinking'
  startedAtMs?: number
  liveTokens?: number
  estimatedTokens?: number
}): string[] {
  const elapsedMs = options.startedAtMs ? Math.max(0, Date.now() - options.startedAtMs) : 0
  const elapsed = Math.floor(elapsedMs / 1000)
  const frame = PENDING_SPINNER_FRAMES[Math.floor(Date.now() / 100) % PENDING_SPINNER_FRAMES.length]!
  const phraseZh = options.phase === 'thinking' ? '模型推理中' : 'AI 正在思考'
  const phraseEn = options.phase === 'thinking' ? 'Reasoning' : 'Thinking'
  const phrase = `${phraseZh} · ${phraseEn}`
  const estimatedTokens = Math.max(0, options.estimatedTokens ?? Math.ceil(elapsedMs / 1000 * 8))
  const liveTokens = Math.max(0, options.liveTokens ?? 0, estimatedTokens)
  const liveTokenNote = `${fmtTok(liveTokens)} tok`
  // Hint that the user can interrupt — Claude shows this and it reassures
  // people who think the CLI hung.
  const hint = '按 Esc 中断'
  const lines = [
    `  ${tint(frame, TL.assistantDot)} ${tint(phrase, TL.assistantDot)}  ${tint(`(${elapsed}s · ${liveTokenNote} · ${hint})`, TL.meta)}`,
  ]
  // Reasoning-phase guidance: only show in `thinking` state. Tells the user
  // (a) why the wait is long even though no text appears yet, (b) how to
  // verify the call hasn't actually died, (c) how to switch to a faster
  // model. Tier escalates with elapsed time so quick thinks stay quiet.
  if (options.phase === 'thinking') {
    lines.push(...buildThinkingCatLines(undefined, Math.floor(elapsedMs / 250)))
    if (elapsed >= 60) {
      lines.push(
        `       ${tint('· 当前模型正在生成隐藏推理 (reasoning_content)，最终答案输出前可能暂时没有文字。', TL.meta)}`,
      )
      lines.push(
        `       ${tint(`· 已用 ${elapsed}s · 累计 ${liveTokenNote} —— token 仍在增长说明模型正常工作；若卡死不动 60s+ 请按 Esc 中断。`, TL.meta)}`,
      )
      lines.push(
        `       ${tint('· 如果普通聊天也经常这样，建议 /config 切到非 reasoning 主模型。', TL.meta)}`,
      )
    } else if (elapsed >= 15) {
      lines.push(
        `       ${tint('· 当前模型仍在推理阶段；可以等待，或按 Esc 中断后换用更快的主模型。', TL.meta)}`,
      )
    }
  }
  return lines
}

function buildViewportLinesFromMessages(messages: SessionMessage[], cols: number): string[] {
  return buildViewportLinesFromBlocks(buildScrollBlocksFromMessages(messages), cols)
}

type ScrollBlock =
  | { kind: 'user'; text: string; timestamp?: string }
  | { kind: 'assistant'; text: string; timestamp?: string; pending?: boolean; pendingStartMs?: number; pendingPhase?: 'generating' | 'thinking'; pendingLiveTokens?: number; finalElapsedMs?: number; finalTokens?: number }
  | { kind: 'tool'; text: string; preserveAnsi?: boolean }
  | { kind: 'bridge'; role: ConversationRole; platform: BridgePlatform; targetLabel: string; text: string; timestamp?: string }
  | { kind: 'workflow'; label: string; text: string; pending?: boolean; pendingStartMs?: number }
  | { kind: 'system'; text: string; preserveAnsi?: boolean; rawLines?: boolean; pending?: boolean }

type ScrollViewportController = {
  /** Append a block to the end of the timeline. Returns its index. */
  appendScrollBlock(block: ScrollBlock): number
  /**
   * Insert a block at the given position, shifting later blocks down. Returns
   * the index of the inserted block. Used by handleTurn to splice tool output
   * in BEFORE the pending assistant block so the conversation scrolls upward
   * naturally (Claude-Code-style inline flow).
   */
  insertScrollBlock(index: number, block: ScrollBlock): number
  /** Update a conversation block at the given index. */
  updateScrollBlock(index: number, block: ScrollBlock): void
  /**
   * Remove a conversation block at the given index. Used by handleTurn to
   * drop the empty pending assistant placeholder when the model went straight
   * to a tool call without emitting any intro text.
   */
  removeScrollBlock(index: number): void
  requestPermission?(toolName: string, category: string, args?: Record<string, unknown>): Promise<boolean>
  onWorkflowComplete?(ctx: { outputDir?: string; changedFiles: string[]; mode: WorkflowMode }): void
}

function buildScrollBlocksFromMessages(messages: SessionMessage[]): ScrollBlock[] {
  const blocks: ScrollBlock[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    if (msg.role === 'user') {
      blocks.push({ kind: 'user', text: msg.content, timestamp: timestampFor(msg.createdAt) || undefined })
      continue
    }
    if (msg.role === 'assistant') {
      blocks.push({ kind: 'assistant', text: msg.content, timestamp: timestampFor(msg.createdAt) || undefined })
      continue
    }
    if (msg.role === 'tool') {
      const toolHeader = msg.name ? `[tool:${msg.name}]` : '[tool]'
      blocks.push({ kind: 'tool', text: `${toolHeader}\n${msg.content}` })
    }
  }
  return blocks
}

function buildViewportLinesFromBlocks(blocks: ScrollBlock[], cols: number): string[] {
  const lines: string[] = []
  const bodyWidth = Math.max(1, cols - 2)
  const pushGap = (): void => {
    if (lines.length === 0 || lines[lines.length - 1] === '') return
    lines.push('')
  }

  for (const block of blocks) {
    if (block.kind === 'user') {
      pushGap()
      lines.push(buildTimelineMarker(USER_GLYPH, TL.userDot, block.timestamp ? [block.timestamp] : undefined))
      for (const raw of stripAnsi(block.text).split('\n')) {
        const wrapped = wrapPlainToWidth(raw, bodyWidth)
        for (const line of wrapped) lines.push(line ? `  ${tint(line, TL.userText)}` : '')
      }
      continue
    }

    if (block.kind === 'assistant') {
      pushGap()
      let body = block.text
      if (!body && block.pending) {
        lines.push(...buildPendingAssistantLines({
          phase: block.pendingPhase ?? 'generating',
          startedAtMs: block.pendingStartMs,
          liveTokens: block.pendingLiveTokens,
          estimatedTokens: block.pendingStartMs ? Math.ceil((Date.now() - block.pendingStartMs) / 1000 * 8) : undefined,
        }))
        continue
      }
      const assistantMeta: string[] = []
      if (block.timestamp) assistantMeta.push(block.timestamp)
      if (typeof block.finalElapsedMs === 'number' && block.finalElapsedMs > 0) {
        assistantMeta.push(formatElapsedShort(block.finalElapsedMs))
      }
      if (typeof block.finalTokens === 'number' && block.finalTokens > 0) {
        assistantMeta.push(`${fmtTok(block.finalTokens)} tok`)
      }
      lines.push(buildTimelineMarker(ASSISTANT_GLYPH, TL.assistantDot, assistantMeta.length > 0 ? assistantMeta : undefined))
      // An empty finalized assistant block (no content, not pending) was
      // appearing as just a lone timestamp — invisible reply. Surface a dim
      // placeholder so the user knows the turn completed without content.
      if (!body) {
        lines.push(`  ${tint('(no response)', TL.meta)}`)
        continue
      }
      for (const raw of formatRichOutput(body).split('\n')) {
        if (!raw) {
          lines.push('')
          continue
        }
        lines.push(`  ${raw}`)
      }
      // Pending block WITH body: append the spinner tail so the user sees
      // continuous activity during inter-chunk pauses (model emits a paragraph
      // then thinks for 10s before the next paragraph or tool call).
      if (block.pending) {
        lines.push(...buildPendingAssistantLines({
          phase: block.pendingPhase ?? 'generating',
          startedAtMs: block.pendingStartMs,
          liveTokens: block.pendingLiveTokens,
          estimatedTokens: block.pendingStartMs ? Math.ceil((Date.now() - block.pendingStartMs) / 1000 * 8) : undefined,
        }))
      }
      continue
    }

    if (block.kind === 'tool') {
      const source = block.preserveAnsi ? block.text : stripAnsi(block.text)
      for (const raw of source.split('\n')) {
        if (!raw) {
          lines.push('')
          continue
        }
        const rendered = block.preserveAnsi ? raw : styleTimelineLogLine(raw)
        lines.push(`  ${rendered}`)
      }
      continue
    }

    if (block.kind === 'system') {
      pushGap()
      const sourceLines = (block.preserveAnsi ? block.text : stripAnsi(block.text)).split('\n')
      for (const raw of sourceLines) {
        if (block.rawLines) {
          if (stringWidth(stripAnsi(raw)) <= cols) {
            lines.push(block.preserveAnsi ? raw : styleTimelineLogLine(raw))
            continue
          }
          const wrapped = wrapPlainToWidth(stripAnsi(raw), cols)
          for (const line of wrapped) lines.push(block.preserveAnsi ? line : styleTimelineLogLine(line))
          continue
        }
        if (!raw) {
          lines.push('')
          continue
        }
        if (block.preserveAnsi) {
          lines.push(`  ${raw}`)
          continue
        }
        for (const line of wrapPlainToWidth(raw, bodyWidth)) lines.push(`  ${styleTimelineLogLine(line)}`)
      }
      continue
    }

    if (block.kind === 'bridge') {
      pushGap()
      lines.push(buildTimelineMarker(
        block.role === 'assistant' ? ASSISTANT_GLYPH : USER_GLYPH,
        block.role === 'assistant' ? TL.assistantDot : TL.userDot,
        [bridgePlatformBadge(block.platform), block.targetLabel, block.timestamp].filter(
          (part): part is string => Boolean(part),
        ),
      ))
      // User messages use the standard user text color;
      // AI (outbound) messages use cyan for clear visual separation.
      if (block.role === 'assistant') {
        const body = formatRichOutput(block.text)
        for (const raw of body.split('\n')) {
          if (!raw) { lines.push(''); continue }
          lines.push(`  ${tint(raw, TL.assistantDot)}`)
        }
      } else {
        for (const raw of stripAnsi(block.text).split('\n')) {
          const wrapped = wrapPlainToWidth(raw, bodyWidth)
          for (const line of wrapped) lines.push(line ? `  ${tint(line, TL.userText)}` : '')
        }
      }
      continue
    }

    if (block.kind === 'workflow') {
      pushGap()
      lines.push(`  ${tint(block.label.toLowerCase(), TL.assistantDot)}${block.pending ? ` ${tint('· running', TL.meta)}` : ''}`)
      const body = block.text || (block.pending ? 'loading…' : '')
      for (const raw of formatRichOutput(body).split('\n')) {
        if (!raw) {
          lines.push('')
          continue
        }
        lines.push(`  ${raw}`)
      }
      // 
      if (block.pending && block.pendingStartMs) {
        const elapsedMs = Math.max(0, Date.now() - block.pendingStartMs)
        const elapsed = Math.floor(elapsedMs / 1000)
        if (elapsed >= 15) {
          const catFrames = [
            `       ${tint('    /\\_/\\   ', TL.note)}`,
            `       ${tint('   ( ^.^ )  ', TL.note)}`,
            `       ${tint('    > = <   ', TL.note)}`,
            `       ${tint('   /     \\  ', TL.note)}`,
          ]
          // 1200ms per face (gentle breathing rhythm — was 500ms which felt too flashy)
          const catFrameIndex = Math.floor(Date.now() / 1200) % 3
          const animatedCatFrames = [
            [
              `       ${tint('    /\\_/\\   ', TL.note)}`,
              `       ${tint('   ( ^.^ )  ', TL.note)}`,
              `       ${tint('    > = <   ', TL.note)}`,
              `       ${tint('   /     \\  ', TL.note)}`,
            ],
            [
              `       ${tint('    /\\_/\\   ', TL.note)}`,
              `       ${tint('   ( -.- )  ', TL.note)}`,
              `       ${tint('    > = <   ', TL.note)}`,
              `       ${tint('   /     \\  ', TL.note)}`,
            ],
            [
              `       ${tint('    /\\_/\\   ', TL.note)}`,
              `       ${tint('   ( o.o )  ', TL.note)}`,
              `       ${tint('    > ~ <   ', TL.note)}`,
              `       ${tint('   /     \\  ', TL.note)}`,
            ],
          ]
          lines.push(...animatedCatFrames[catFrameIndex])
          // 
      const animationFrames = [
        `       ${tint('· Meow to the Moon! 🚀 ', TL.note)}`,
        `       ${tint('· Meow to the Moon! 🚀 ', TL.tagBlue)}`,
        `       ${tint('· Meow to the Moon! 🚀 ', TL.tagPurple)}`,
        `       ${tint('· Meow to the Moon! 🚀 ', TL.tagGold)}`,
        `       ${tint('· Meow to the Moon! 🚀 ', TL.tagGreen)}`,
      ]
      // 800ms per color (was 200ms which strobed unpleasantly)
      const textFrameIndex = Math.floor(Date.now() / 800) % animationFrames.length
      lines.push(animationFrames[textFrameIndex])
        }
      }
    }
  }

  return lines
}

function compressHeroLines(lines: string[]): string[] {
  const trimmed = [...lines]
  while (trimmed.length > 0 && trimmed[0] === '') trimmed.shift()
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()

  const result: string[] = []
  let blankRun = 0
  for (const line of trimmed) {
    if (line === '') {
      blankRun++
      if (blankRun > 1) continue
    } else {
      blankRun = 0
    }
    result.push(line)
  }
  return result
}

function buildTimelineWithLanding(options: {
  locale: UiLocale
  cwd: string
  permissionMode: string
  modelLabel: string
  brainLabel?: string
  hud: ReturnType<typeof createHudState>
  cols: number
  visibleRows: number
  bridges?: string[]
  blocks: ScrollBlock[]
}): string[] {
  const landingLines = compressHeroLines(buildInteractiveLandingLines({
    locale: options.locale,
    cwd: options.cwd,
    permissionMode: options.permissionMode,
    modelLabel: options.modelLabel,
    brainLabel: options.brainLabel,
    hud: options.hud,
    cols: options.cols,
    visibleRows: options.visibleRows,
    bridges: options.bridges,
  }))
  const convoLines = buildViewportLinesFromBlocks(options.blocks, options.cols)
  if (landingLines.length === 0) return convoLines
  if (convoLines.length === 0) return landingLines
  return [...landingLines, '', ...convoLines]
}

function isUsableProviderProfile(profile: {
  apiKey?: string
  baseUrl?: string
  model?: string
} | undefined): boolean {
  return Boolean(
    profile?.apiKey?.trim() &&
    profile?.baseUrl?.trim() &&
    profile?.model?.trim()
  )
}

function buildInteractiveLandingLines(options: {
  locale: UiLocale
  cwd: string
  permissionMode: string
  modelLabel: string
  brainLabel?: string
  hud: ReturnType<typeof createHudState>
  cols: number
  visibleRows: number
  bridges?: string[]
}): string[] {
  const { locale, cwd, permissionMode, modelLabel, brainLabel, hud, cols, visibleRows, bridges } = options
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  const ESC = '\x1b'
  const R   = `${ESC}[0m`
  const c   = (r: number, g: number, b: number, s: string) =>
    process.stdout.isTTY ? `${ESC}[38;2;${r};${g};${b}m${s}${R}` : s
  const bd  = (s: string) => process.stdout.isTTY ? `${ESC}[1m${s}${R}` : s
  const dm  = (s: string) => process.stdout.isTTY ? `${ESC}[2m${s}${R}` : s

  const fallbackLines: string[] = [
    `  ${bd(c(82, 196, 255, APP_NAME))} ${dm(`v${APP_VERSION}`)}  ${c(148, 82, 255, APP_PUBLISHER)}  ${dm('·')}  ${dm(cwd)}`,
    '',
    `  ${dm(t('执行模型', 'Exec'))}   ${c(137, 180, 250, modelLabel)}`,
    `  ${dm(t('思维模型', 'Brain'))}  ${brainLabel ? c(203, 166, 247, brainLabel) : dm(t('未配置', 'Not configured'))}`,
    `  ${dm(t('权限模式', 'Mode'))}   ${c(249, 226, 175, permissionMode)}`,
    `  ${dm('T/S/M')}   ${c(137, 180, 250, String(DIRECT_TOOL_COUNT))} ${dm('/')} ${c(203, 166, 247, String(hud.skillCount))} ${dm('/')} ${c(148, 226, 213, String(hud.mcpServerCount))}`,
    '',
    `  ${c(245, 196, 94, bd(`✦ ${t('工作流', 'Workflows')}`))}`,
    `    ${c(245, 196, 94, bd('/team'))} ${dm(t('← 不知道选哪个？让 AI 自动派单', '← Not sure? Let AI route for you'))}`,
    `    ${c(148, 82, 255, bd('/niko'))} ${c(148, 82, 255, bd('/design'))} ${c(148, 82, 255, bd('/athena'))} ${c(148, 82, 255, bd('/nidhogg'))} ${c(148, 82, 255, bd('/contest'))} ${c(148, 82, 255, bd('/run'))}`,
    '',
    `  ${c(245, 196, 94, bd(`✦ ${t('设置', 'Setup')}`))}`,
    `    ${c(148, 82, 255, bd('/bifrost'))}  ${c(148, 82, 255, bd('/config'))}  ${c(148, 82, 255, bd('/permission'))}  ${c(148, 82, 255, bd('/newborn'))}`,
    '',
    modelLabel === '?'
      ? `  ${c(255, 120, 155, t('⚠ 未检测到可用 Provider，请先运行 /config', '⚠ No usable provider. Run /config first.'))}`
      : `  ${c(82, 196, 255, bd('(⌐■-■)'))}  ${bd(c(166, 227, 161, t('直接输入文字开始对话', 'Have a nice trip')))} ${dm(t('· / 浏览命令', '· / browse commands'))}`,
    '',
  ]

  const compactLines = [
    ...buildInteractiveCompactHero({
      locale,
      executionModel: modelLabel,
      brainModel: brainLabel,
      cwd,
      permissionMode,
      toolCount: DIRECT_TOOL_COUNT,
      skillCount: hud.skillCount,
      mcpCount: hud.mcpServerCount,
      bridges,
      providerMissing: modelLabel === '?',
    }).split('\n'),
  ]

  const heroLines = compressHeroLines([
    ...buildInteractiveHero({
      locale,
      executionModel: modelLabel,
      brainModel: brainLabel,
      cwd,
      permissionMode,
      toolCount: DIRECT_TOOL_COUNT,
      skillCount: hud.skillCount,
      mcpCount: hud.mcpServerCount,
      cols,
      bridges,
      providerMissing: modelLabel === '?',
    }).split('\n'),
  ])

  // Viewport is scrollable — only gate on width, never height.
  const heroFitsWidth = heroLines.every(line => stringWidth(stripAnsi(line)) <= cols)
  if (heroFitsWidth) return heroLines

  const compactFitsWidth = compactLines.every(line => stringWidth(stripAnsi(line)) <= cols)
  if (compactFitsWidth) return compactLines

  return fallbackLines
}

function buildInteractiveLandingBlockText(options: {
  locale: UiLocale
  cwd: string
  permissionMode: PermissionMode
  modelLabel: string
  brainLabel?: string
  hud: ReturnType<typeof createHudState>
  bridges?: string[]
}): string {
  const cols = Math.max(20, Math.min(process.stdout.columns ?? 80, 120))
  const visibleRows = Math.max(1, (process.stdout.rows ?? 24) - BASE_FZ)
  return buildInteractiveLandingLines({
    ...options,
    cols,
    visibleRows,
  }).join('\n')
}



export interface RunInteractiveOptions {
  cwd: string
  locale: UiLocale
  permissionMode: PermissionMode
  autoDrive: boolean
  model?: string
  baseUrl?: string
  apiKey?: string
  maxTurns: number
  initialPrompt?: string
  sessionId?: string
  resumeLast: boolean
  suppressInitialNewbornOnce?: boolean
  settingsStore: CliSettingsStore
  onBridgeStart?: (platform: string) => void
  autoStartBridges?: string[]
}

export async function runInteractive(opts: RunInteractiveOptions): Promise<void> {
  const { cwd, onBridgeStart } = opts
  // Mutable sandbox root for tool calls. Changed at runtime by `/cd <path>`.
  // The launch `cwd` stays immutable and is used for stores (.artemis/, sessions, MCP, etc.).
  let workspaceRoot = cwd
  const trustSettingsStore = new CliSettingsStore(HOME_DIR)
  let locale = opts.locale
  let permissionMode: PermissionMode = opts.permissionMode
  // CRITICAL: Disable alt-screen to preserve history scrollback
  // Alt-screen uses a separate buffer that disables terminal history access
  // We use DECSTBM scroll region + careful redraw management instead
  const useAltScreen = false
  let altScreenActive = false
  const leaveInteractiveScreen = (): void => {
    if (!altScreenActive) return
    altScreenActive = false
    process.stdout.write('\x1b[r')
    process.stdout.write('\x1b[?25h')
    process.stdout.write(LEAVE_ALT_SCREEN)
    process.removeListener('exit', leaveInteractiveScreen)
  }

  // ── resolve model labels (exec + brain) using the same lookup order as startup/runtime ──
  const provStore = new ProviderStore(cwd)
  const provData = await provStore.load()
  let activeStore = provStore
  let activeData = provData
  let config = provStore.getDefaultMainProfile(provData)

  if (!isUsableProviderProfile(config)) {
    const globalStore = new ProviderStore(HOME_DIR)
    const globalData = await globalStore.load()
    const globalConfig = globalStore.getDefaultMainProfile(globalData)
    if (isUsableProviderProfile(globalConfig)) {
      activeStore = globalStore
      activeData = globalData
      config = globalConfig
    }
  }

  const brainConfig = activeStore.getProfile(activeData, activeData.specialistProfileId)
  let modelLabel = opts.model ?? config?.model ?? (process.env.ANTHROPIC_API_KEY ? 'claude-sonnet-4-20250514' : '?')
  let modelContextLimit: number | undefined = opts.model ? undefined : config?.contextLength
  let brainLabel: string | undefined = brainConfig?.model

  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  let scrollBlocks: ScrollBlock[] = []
  let transientBlocks: ScrollBlock[] | null = null
  let prompt: BlessedPromptHandle | null = null
  let landingCommitted = false

  // Natural-language permission prompt: tells the user what the AI wants to
  // do in plain language (with the actual target — command, path, url) rather
  // than the raw "shell: run_command" tool identifier.
  const askToolPermission = (
    toolName: string,
    category: string,
    args?: Record<string, unknown>,
  ): Promise<boolean> => {
    const info = formatToolPermission({ name: toolName, args: args ?? {}, category, locale })
    const bodyLines: string[] = []
    if (info.detail) {
      bodyLines.push(t('操作对象：', 'Target:') + ' ' + info.detail)
    }
    bodyLines.push('')
    bodyLines.push(t('是否允许？', 'Do you want to allow this?'))
    return prompt!.confirm({
      title: info.title,
      lines: bodyLines,
      confirmLabel: t('允许', 'Allow'),
      cancelLabel: t('拒绝', 'Deny'),
    })
  }





  const appendScrollBlock = (block: ScrollBlock): number => {
    // Pending workflow and assistant blocks live in the transient zone (drawn
    // at the bottom under the input) and commit into scrollback only once
    // they finalize. This keeps scrollback append-only and avoids duplicate
    // transcript replays when a pending block changes shape mid-turn.
    if (
      ((block.kind === 'workflow' || block.kind === 'assistant') && block.pending) ||
      (block.kind === 'system' && block.pending)
    ) {
      transientBlocks = [block]
      if (!landingCommitted) landingCommitted = true
      syncViewportFromState()
      return 0
    }
    scrollBlocks.push(block)
    if (!landingCommitted) landingCommitted = true
    syncViewportFromState()
    return scrollBlocks.length - 1
  }

  const removeScrollBlock = (index: number): void => {
    if (transientBlocks && index >= 0 && index < transientBlocks.length) {
      transientBlocks.splice(index, 1)
      if (transientBlocks.length === 0) transientBlocks = null
      syncViewportFromState()
      return
    }
    if (index < 0 || index >= scrollBlocks.length) return
    scrollBlocks.splice(index, 1)
    syncViewportFromState()
  }

  const renderPlainPanel = (title: string, lines: string[]): string =>
    renderTimelinePanel(title, lines)

  const appendSystemText = (text: string): number =>
    appendScrollBlock({ kind: 'system', text, preserveAnsi: true })

  const appendSystemPanel = (title: string, lines: string[]): number =>
    appendScrollBlock({ kind: 'system', text: renderPlainPanel(title, lines), preserveAnsi: true })

  const maybeApplyVisualGenerationPolicy = async (requestText: string): Promise<string> => {
    const need = detectVisualGenerationNeed(requestText)
    if (!need.image && !need.video) {
      return requestText
    }

    const configured = [
      need.image ? await resolveConfiguredVisualProvider(workspaceRoot, 'image') : null,
      need.video ? await resolveConfiguredVisualProvider(workspaceRoot, 'video') : null,
    ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

    if (configured.length === 0) {
      const checkedPaths = [
        path.join(resolveDataRootDir(workspaceRoot), 'providers.json'),
        path.join(HOME_DIR, '.artemis', 'providers.json'),
      ]
      appendSystemPanel(t('视觉素材策略', 'Visual asset policy'), [
        t(
          '检测到任务需要图片/视频，但没有找到已配置且启用的本地视觉生成 API。',
          'Detected image/video needs, but no enabled local visual generation API is configured.',
        ),
        t(
          '本轮如需视觉素材，将使用网络搜索素材，不会伪装成本地生成。',
          'This turn will use web-search assets if needed and will not claim local generation.',
        ),
        `${t('已检查配置: ', 'Checked config: ')}${checkedPaths.join(' ; ')}`,
      ])
      return `${requestText}\n\n[Visual generation policy]\nNo configured local visual generation API is available. Use web-search assets if needed, and do not claim local generation.`
    }

    const configuredText = configured.map((entry) => describeVisualProvider(entry.config, entry.assetKind)).join(', ')
    if (hasExplicitRemoteVisualFallback(requestText)) {
      appendSystemPanel(t('视觉素材策略', 'Visual asset policy'), [
        t('用户已明确要求使用网络/搜索素材。', 'User explicitly requested online/search assets.'),
        `${t('已配置本地视觉 API: ', 'Configured local visual API: ')}${configuredText}`,
      ])
      return `${requestText}\n\n[Visual generation policy]\nThe user explicitly requested online/search visual assets. Do not call generate_image/generate_video unless the user asks again.`
    }

    if (hasExplicitLocalVisualConsent(requestText) || process.stdin.isTTY !== true) {
      appendSystemPanel(t('视觉素材策略', 'Visual asset policy'), [
        t('检测到用户已明确同意使用本地视觉生成。', 'Detected explicit consent for local visual generation.'),
        `${t('将优先使用: ', 'Will prefer: ')}${configuredText}`,
      ])
      return `${requestText}\n\n[Visual generation policy]\nThe user explicitly approved local visual generation. Photographic / product / editorial / lifestyle assets MUST be produced via generate_image (or generate_video when appropriate). Icons, logos, UI controls, loaders, geometric or abstract decoration, charts, diagrams, and other vector-native graphics MAY be authored as SVG/CSS directly — these are the right tool for those jobs and are not violations. The forbidden pattern is substituting hand-authored SVG/canvas/procedural code for what should be a real photograph (e.g. writing a node/python script that draws "product images" instead of calling generate_image). If generate_image returns an error, report it to the user explicitly and ask whether to retry or switch to web-search; do not silently fall back to SVG placeholders for photographic subjects.`
    }

    let choice: 'local' | 'search' | 'skip'
    try {
      choice = await prompt!.pickOption<'local' | 'search' | 'skip'>({
        title: t('检测到任务需要视觉素材', 'Visual assets needed'),
        hint: t('↑↓ 移动  Enter 确认', '↑↓ move  Enter confirm'),
        choices: [
          {
            label: t('使用本地视觉 API', 'Use local visual API'),
            value: 'local',
            description: configuredText,
          },
          {
            label: t('使用网络搜索素材', 'Use web-search assets'),
            value: 'search',
            description: t('不调用本地图片/视频生成 API。', 'Do not call local image/video generation APIs.'),
          },
          {
            label: t('暂不生成视觉素材', 'Skip visual assets'),
            value: 'skip',
            description: t('继续任务，但避免生成或搜索图片/视频。', 'Continue, but avoid generating or searching image/video assets.'),
          },
        ],
        initialIndex: 0,
      }) ?? 'local'
      prompt!.forceRedraw()
    } catch {
      choice = 'local'
    }

    if (choice === 'local') {
      appendSystemPanel(t('视觉素材策略', 'Visual asset policy'), [
        `${t('用户确认启用本地视觉 API: ', 'User confirmed local visual API: ')}${configuredText}`,
      ])
      return `${requestText}\n\n[Visual generation policy]\nThe user confirmed local visual generation. Photographic / product / editorial / lifestyle assets MUST be produced via generate_image (or generate_video when appropriate). Icons, logos, UI controls, loaders, geometric or abstract decoration, charts, diagrams, and other vector-native graphics MAY be authored as SVG/CSS directly — these are the right tool for those jobs and are not violations. The forbidden pattern is substituting hand-authored SVG/canvas/procedural code for what should be a real photograph (e.g. writing a node/python script that draws "product images" instead of calling generate_image). If generate_image returns an error, report it to the user explicitly and ask whether to retry or switch to web-search; do not silently fall back to SVG placeholders for photographic subjects.`
    }

    if (choice === 'search') {
      appendSystemPanel(t('视觉素材策略', 'Visual asset policy'), [
        t('用户选择网络搜索素材，本轮不调用本地视觉生成 API。', 'User chose web-search assets; do not call local visual generation APIs this turn.'),
      ])
      return `${requestText}\n\n[Visual generation policy]\nThe user declined local visual generation for this turn. Do not call generate_image/generate_video; use web-search visual assets if needed.`
    }

    appendSystemPanel(t('视觉素材策略', 'Visual asset policy'), [
      t('用户选择跳过视觉素材生成/搜索。', 'User chose to skip visual asset generation/search.'),
    ])
    return `${requestText}\n\n[Visual generation policy]\nThe user chose to skip visual asset generation/search for this turn. Avoid image/video generation and visual web-search.`
  }

  // Animated "waiting" panel: appends a system block that ticks a Braille
  // spinner or the same thinking cat used by reasoning waits.
  // Call .stop(finalTitle, finalLines) to clear the tick and replace the
  // panel in-place with the final result. Use this for any operation that may
  // exceed ~1s of user-visible wait (LLM calls, large IO, etc.).
  const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
  // Cat-frame cadence is decoupled from the render tick so the Braille spinner
  // can stay smooth at 100ms while the cat changes only every 600ms — fast
  // enough to feel alive, slow enough not to flicker uncomfortably.
  const CAT_FRAME_INTERVAL_MS = 600
  const startWaitingPanel = (
    title: string,
    bodyLines: string[],
    options: { animation?: 'spinner' | 'cat' } = {},
  ): { stop: (finalTitle: string, finalLines: string[]) => void } => {
    const startedMs = Date.now()
    const render = (): string => {
      const elapsedMs = Date.now() - startedMs
      const elapsedSec = Math.floor(elapsedMs / 1000)
      const spinnerFrame = SPINNER_FRAMES[Math.floor(Date.now() / 100) % SPINNER_FRAMES.length]!
      const catFrameIndex = Math.floor(elapsedMs / CAT_FRAME_INTERVAL_MS)
      const animationLines = options.animation === 'cat'
        ? buildThinkingCatLines(t('· 正在润色刚才输入的文字，请稍候…', '· Polishing your last input. Please wait…'), catFrameIndex)
        : []
      return renderPlainPanel(title, [
        ...animationLines,
        ...bodyLines,
        `${spinnerFrame} ${t('处理中…', 'Working…')}  (${elapsedSec}s)`,
      ])
    }
    const blockIndex = appendScrollBlock({ kind: 'system', text: render(), preserveAnsi: true, pending: true })
    const tick = setInterval(() => {
      updateScrollBlock(blockIndex, { kind: 'system', text: render(), preserveAnsi: true, pending: true })
    }, 100)
    return {
      stop: (finalTitle: string, finalLines: string[]) => {
        clearInterval(tick)
        updateScrollBlock(blockIndex, {
          kind: 'system',
          text: renderPlainPanel(finalTitle, finalLines),
          preserveAnsi: true,
          pending: false,
        })
      },
    }
  }

  // ── Background-task visibility panel ────────────────────────────────────
  // Renders a live block listing all currently-running background tools
  // (image gen, video gen, parallel-safe delegate_task) so the user can SEE
  // multi-agent activity unfolding instead of staring at a single spinner.
  // Backed by the BackgroundTaskRegistry singleton.
  const bgRegistry = getBackgroundTaskRegistry()
  let bgPanelIndex: number | null = null

  const renderBgPanel = (): string => {
    const all = bgRegistry.listAll()
    const active = all.filter(r => r.status === 'running')
    const recentlyDone = all.filter(
      r => r.status !== 'running' &&
        r.completedAtMs !== undefined &&
        Date.now() - r.completedAtMs < 5000,
    )
    const lines: string[] = []
    if (active.length > 0) {
      lines.push(t(
        `${active.length} 个后台 agent 正在工作（不会阻塞主对话）：`,
        `${active.length} background agent(s) running (main turn not blocked):`,
      ))
      for (const r of active) {
        lines.push('  ' + formatBackgroundTaskLine(r))
      }
    }
    if (recentlyDone.length > 0) {
      if (active.length > 0) lines.push('')
      lines.push(t('刚刚完成：', 'Recently finished:'))
      for (const r of recentlyDone) {
        lines.push('  ' + formatBackgroundTaskLine(r))
      }
    }
    return renderPlainPanel(
      t('🌀 多 Agent 并行', '🌀 Multi-agent parallel'),
      lines,
    )
  }

  const updateBgPanel = (): void => {
    const all = bgRegistry.listAll()
    const hasActive = all.some(r => r.status === 'running')
    const hasRecentlyDone = all.some(
      r => r.status !== 'running' &&
        r.completedAtMs !== undefined &&
        Date.now() - r.completedAtMs < 5000,
    )
    const shouldShow = hasActive || hasRecentlyDone

    if (!shouldShow) {
      // No active or recently-finished tasks. Drop the panel index so the
      // next task creates a fresh block rather than appending to a stale
      // one. Pruning keeps the registry from growing unbounded.
      if (bgPanelIndex !== null) {
        removeScrollBlock(bgPanelIndex)
      }
      bgPanelIndex = null
      bgRegistry.pruneFinished(5000)
      return
    }

    const text = renderBgPanel()
    if (bgPanelIndex === null) {
      bgPanelIndex = appendScrollBlock({
        kind: 'system',
        text,
        preserveAnsi: true,
      })
    } else {
      updateScrollBlock(bgPanelIndex, {
        kind: 'system',
        text,
        preserveAnsi: true,
      })
    }
  }

  bgRegistry.on('change', updateBgPanel)
  // Tick once per second so elapsed-time counters refresh smoothly even
  // while no registry changes fire (a long-running image gen has no events
  // until completion).
  const bgPanelTick = setInterval(updateBgPanel, 1000)
  bgPanelTick.unref?.()

  const sensitiveWorkspaceRoots = [
    path.join(HOME_DIR, '.ssh'),
    path.join(HOME_DIR, '.gnupg'),
    path.join(HOME_DIR, '.aws'),
    path.join(HOME_DIR, '.claude'),
    '/etc',
    '/root',
    '/var/root',
    '/private/etc',
  ].map((entry) => path.resolve(entry))
  const trustedSensitiveWorkspaceExceptions = [
    // Dream files are user-generated md/png/json summaries, not credentials.
    // Keep this aligned with utils/fs.ts and tools/runCommand.ts so /dream
    // status/open and AI self-introspection can read the dream scrolls without
    // opening the rest of ~/.artemis.
    path.join(HOME_DIR, '.artemis', 'dreams'),
  ].map((entry) => path.resolve(entry))

  const normalizeWorkspacePathForCompare = (target: string): string => {
    const resolved = path.resolve(target)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  const isPathWithinOrEqual = (target: string, root: string): boolean => {
    const normalizedTarget = normalizeWorkspacePathForCompare(target)
    const normalizedRoot = normalizeWorkspacePathForCompare(root)
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  }

  const isSensitiveWorkspaceTarget = (target: string): boolean => {
    const resolved = path.resolve(target)
    if (trustedSensitiveWorkspaceExceptions.some((root) => isPathWithinOrEqual(resolved, root))) {
      return false
    }
    return sensitiveWorkspaceRoots.some((root) => isPathWithinOrEqual(resolved, root))
  }

  const refreshProjectInstructionsForWorkspace = async (nextWorkspaceRoot: string): Promise<void> => {
    const nextInstructionSuffix = await buildFullSystemSuffix(nextWorkspaceRoot)
    setSystemPromptSuffix(nextInstructionSuffix)
  }

  const ensureTrustedWorkspace = async (options: {
    workspacePath: string
    requestedPath?: string
    usedNearestExistingParent?: boolean
    sourceLabel?: string
    switchNow?: boolean
  }): Promise<boolean> => {
    const nextWorkspaceRoot = path.resolve(options.workspacePath)
    const requestedPath = options.requestedPath ? path.resolve(options.requestedPath) : nextWorkspaceRoot
    const switchNow = options.switchNow !== false

    if (permissionMode !== 'PRODUCER' && isSensitiveWorkspaceTarget(nextWorkspaceRoot)) {
      appendSystemPanel(
        t('拒绝：目标位于敏感目录', 'Refused: target is a sensitive directory'),
        [nextWorkspaceRoot],
      )
      prompt?.forceRedraw()
      return false
    }

    if (switchNow && path.resolve(workspaceRoot) === nextWorkspaceRoot) {
      await trustSettingsStore.rememberTrustedWorkspace(nextWorkspaceRoot)
      return true
    }

    const alreadyTrusted = await trustSettingsStore.isWorkspaceTrusted(nextWorkspaceRoot)
    if (!alreadyTrusted) {
      const trustResult = prompt
        ? await prompt.releaseTerminal(() => runWorkspaceTrustDialog({
            cwd: nextWorkspaceRoot,
            locale,
            settingsStore: trustSettingsStore,
          }))
        : await runWorkspaceTrustDialog({
            cwd: nextWorkspaceRoot,
            locale,
            settingsStore: trustSettingsStore,
          })
      prompt?.forceRedraw()

      if (trustResult === 'declined') {
        if (switchNow) {
          appendSystemPanel(
            t('工作区未切换', 'Workspace not switched'),
            [
              nextWorkspaceRoot,
              '',
              t('已取消执行。', 'Execution cancelled.'),
            ],
          )
          prompt?.forceRedraw()
        }
        return false
      }
    } else {
      await trustSettingsStore.rememberTrustedWorkspace(nextWorkspaceRoot)
    }

    if (!switchNow) {
      return true
    }

    workspaceRoot = nextWorkspaceRoot
    await refreshProjectInstructionsForWorkspace(workspaceRoot)
    const switchedLines = [
      `→ ${workspaceRoot}`,
      t('后续工具调用（读/写/run_command）以此为根目录。', 'Tool calls (read/write/run_command) now use this as the sandbox root.'),
    ]
    if (options.usedNearestExistingParent && requestedPath !== workspaceRoot) {
      switchedLines.splice(1, 0, t(
        `原始目标不存在或不是目录，已使用最近存在目录: ${requestedPath}`,
        `Requested target did not exist or was not a directory; using nearest existing directory: ${requestedPath}`,
      ))
    }
    if (options.sourceLabel) {
      switchedLines.splice(switchedLines.length - 1, 0, `${t('来源', 'Source')}: ${options.sourceLabel}`)
    }
    appendSystemPanel(
      t('工作区已信任并切换', 'Workspace trusted and switched'),
      switchedLines,
    )
    prompt?.forceRedraw()
    return true
  }

  const trustAndSwitchWorkspace = async (options: {
    workspacePath: string
    requestedPath?: string
    usedNearestExistingParent?: boolean
    sourceLabel?: string
  }): Promise<boolean> =>
    ensureTrustedWorkspace({
      ...options,
      switchNow: true,
    })

  const handleWorkspaceSwitchRequest = async (
    request: WorkspaceSwitchRequest,
  ): Promise<boolean> => {
    const sourceLabel = request.source === 'run_command'
      ? `${request.toolName}${request.originalPath ? `: ${request.originalPath}` : ''}`
      : request.toolName
    return ensureTrustedWorkspace({
      workspacePath: request.workspacePath,
      requestedPath: request.requestedPath,
      usedNearestExistingParent: request.usedNearestExistingParent,
      sourceLabel,
      switchNow: request.switchNow,
    })
  }

  const maybeSwitchWorkspaceForRequest = async (requestText: string): Promise<boolean> => {
    const resolved = await resolveWorkspaceIntent(requestText, workspaceRoot, HOME_DIR)
    if (!resolved) return true
    return trustAndSwitchWorkspace({
      workspacePath: resolved.workspacePath,
      requestedPath: resolved.requestedPath,
      usedNearestExistingParent: resolved.usedNearestExistingParent,
      sourceLabel: resolved.source,
    })
  }

  const reloadProviderStateForUi = async (): Promise<void> => {
    const localStore = new ProviderStore(cwd)
    const localData = await localStore.load()
    let nextStore = localStore
    let nextData = localData
    let nextConfig = localStore.getDefaultMainProfile(localData)

    if (!isUsableProviderProfile(nextConfig)) {
      const globalStore = new ProviderStore(HOME_DIR)
      const globalData = await globalStore.load()
      const globalConfig = globalStore.getDefaultMainProfile(globalData)
      if (isUsableProviderProfile(globalConfig)) {
        nextStore = globalStore
        nextData = globalData
        nextConfig = globalConfig
      }
    }

    const nextBrain = nextStore.getProfile(nextData, nextData.specialistProfileId)
    modelLabel = opts.model ?? nextConfig?.model ?? (process.env.ANTHROPIC_API_KEY ? 'claude-sonnet-4-20250514' : '?')
    modelContextLimit = opts.model ? undefined : nextConfig?.contextLength
    brainLabel = nextBrain?.model
    hud.defaultModel = modelLabel
    hud.lastModel = modelLabel
    hud.contextLimit = modelContextLimit
    hud.brainModel = brainLabel
  }

  const ensureExecutionProviderForWorkflow = async (workflowCwd: string): Promise<boolean> => {
    const localStore = new ProviderStore(workflowCwd)
    const localData = await localStore.load()
    if (localStore.getDefaultMainProfile(localData)) {
      return true
    }

    const globalStore = new ProviderStore(HOME_DIR)
    const globalData = await globalStore.load()
    if (globalStore.getDefaultMainProfile(globalData)) {
      return true
    }

    prompt!.clearBuffer()
    const result = await prompt!.releaseTerminal(() => runOnboarding(locale, workflowCwd))
    prompt!.clearBuffer()
    suppressInitialNewbornOnce = true

    if (!result.configured) {
      appendSystemPanel(
        t('工作流未启动', 'Workflow not started'),
        [t('还没有可用的 Execution provider，且你刚才取消了配置。', 'No execution provider is configured, and setup was cancelled.')],
      )
      prompt!.forceRedraw()
      return false
    }

    if (result.model) {
      switchModel(result.model)
    }
    await reloadProviderStateForUi()
    prompt!.forceRedraw()
    return true
  }

  const askAndSaveSession = async (actionLabel: string): Promise<void> => {
    const messages = getMessages()
    if (messages.length === 0) return

    let choice = false
    try {
      choice = await prompt!.confirm({
        title: t('保存当前会话？', 'Save current session?'),
        lines: [
          t(`执行 "${actionLabel}" 可能会中断当前会话。`, `Executing "${actionLabel}" may interrupt current session.`),
          t('是否需要保存后再继续？', 'Would you like to save before proceeding?'),
        ],
        confirmLabel: t('保存并继续', 'Save & Continue'),
        cancelLabel: t('不需要保存', 'No need to save'),
      })
    } catch { /* ignore */ }

    if (choice) {
      const messages = getMessages()
      const saved = await wordupNow({ store: sessionStore, storedSession, messages })
      if (saved) {
        storedSession = saved
        appendSystemPanel(t('会话已保存', 'Session saved'), [
          `ID: ${saved.id.slice(0, 8)}`,
          `Title: ${saved.title}`,
          '',
          t('你可以随时输入以下指令恢复此会话：', 'You can restore this session anytime with:'),
          `\x1b[1;36m/resume ${saved.id.slice(0, 8)}\x1b[0m`,
        ])
      }
    }
  }

  const getViewportMetrics = (): { cols: number, visibleRows: number } => {
    const out = process.stdout
    return {
      cols: Math.max(20, Math.min(out.columns ?? 80, 120)),
      visibleRows: Math.max(1, (out.rows ?? 24) - BASE_FZ),
    }
  }

  const buildLandingLines = (): string[] => {
    const { cols, visibleRows } = getViewportMetrics()
    return compressHeroLines(buildInteractiveLandingLines({
      locale,
      cwd: workspaceRoot,
      permissionMode,
      modelLabel,
      brainLabel,
      hud,
      cols,
      visibleRows,
      bridges: activeBridgeNames,
    }))
  }

  const syncViewportFromState = (): void => {
    if (!prompt || !process.stdout.isTTY) return

    if (scrollBlocks.length === 0 && (!transientBlocks || transientBlocks.length === 0) && !landingCommitted) {
      // Landing screen lives in finalised — drawn once into scrollback. As soon
      // as the user submits, new finalised content pushes it up just like a
      // normal REPL chat.
      prompt.setLines(buildLandingLines(), [])
      return
    }

    const { cols } = getViewportMetrics()
    const finalised = buildViewportLinesFromBlocks(scrollBlocks, cols)
    const transient = (transientBlocks && transientBlocks.length > 0)
      ? buildViewportLinesFromBlocks(transientBlocks, cols)
      : []
    prompt.setLines(finalised, transient)
  }

  const redrawViewportFromState = (): void => {
    if (!prompt || !process.stdout.isTTY) return
    syncViewportFromState()
  }

  // ── HUD state ───────────────────────────────────────────────────────────────
  const hud = createHudState(modelLabel, modelContextLimit)
  hud.permissionMode = permissionMode
  hud.brainModel = brainLabel

  // Populate HUD with real store counts (non-fatal)
  const BRIDGE_DISPLAY_NAMES: Record<string, string> = {
    telegram: 'Telegram', discord: 'Discord', wechat: 'WeChat',
  }
  let activeBridgeNames: string[] = []
  try {
    const mcpStore   = new McpServerStore(cwd)
    const mcpData    = await mcpStore.load()
    hud.mcpServerCount = mcpData.servers.filter(s => s.enabled).length

    // 获取技能系统中的技能数量（await ready() to avoid race with async loader）
    const { SkillManager } = await import('../core/skillManager.js')
    const skillManager = new SkillManager()
    await skillManager.ready()
    const skills = skillManager.getAllSkillDefinitions()
    hud.skillCount = skills.length

    const bragiStore = new BragiStore(cwd)
    const bragiData  = await bragiStore.load()
    const enabledPlatforms = Object.entries(bragiData.platforms)
      .filter(([, cfg]) => cfg?.enabled)
      .map(([id]) => BRIDGE_DISPLAY_NAMES[id] ?? id)
    activeBridgeNames = enabledPlatforms
    hud.pluginCount  = enabledPlatforms.length
  } catch (err) { 
    console.error('Error loading skills:', err)
  }

  // ── CLI flag overrides (--model, --api-key, --base-url) ───────────────────
  if (opts.model || opts.apiKey || opts.baseUrl) {
    applyProviderOverrides({ model: opts.model, apiKey: opts.apiKey, baseUrl: opts.baseUrl })
  }

  // ── project instructions (ARTEMIS.md) + user profile ─────────────────────
  const instructionSuffix = await buildFullSystemSuffix(workspaceRoot)
  if (instructionSuffix) setSystemPromptSuffix(instructionSuffix)

  // ── session store ───────────────────────────────────────────────────────────
  const sessionStore = new SessionStore(cwd)
  const historyStore = new PromptHistoryStore(cwd)
  let storedSession: SessionRecord | null = null

  // ── resume existing session ─────────────────────────────────────────────────
  if (opts.sessionId || opts.resumeLast) {
    const loaded = opts.sessionId
      ? await sessionStore.load(opts.sessionId)
      : await sessionStore.loadLatest()
    if (loaded) {
      storedSession = loaded
      restoreSession(loaded.messages)
      hud.sessionMessageCount = loaded.messages.length
      hud.sessionTotalTokens = 0
    }
  }
  scrollBlocks = buildScrollBlocksFromMessages(getMessages())
  landingCommitted = scrollBlocks.length > 0

  // ── splash ──────────────────────────────────────────────────────────────────
  if (useAltScreen) {
    altScreenActive = true
    process.stdout.write(ENTER_ALT_SCREEN)
    process.on('exit', leaveInteractiveScreen)
  }
  console.clear()

  // ── one-shot mode (non-interactive) ────────────────────────────────────────
  if (opts.initialPrompt) {
    if (!(await maybeSwitchWorkspaceForRequest(opts.initialPrompt))) {
      return
    }
    await handleTurn(
      opts.initialPrompt,
      locale,
      hud,
      workspaceRoot,
      permissionMode,
      undefined,
      handleWorkspaceSwitchRequest,
    )
    console.log(renderHud(hud))
    console.log()
    return
  }

  // ── REPL ────────────────────────────────────────────────────────────────────
  const savedHistory = await historyStore.load()
  // Daily audit is OFF by default — it fires an AI turn against the shared
  // global session (brain.ts:getSession), which would pollute the user's chat
  // history and surface unsolicited tool calls on launch. Opt-in only.
  const startupSettings = await opts.settingsStore.load()
  if (startupSettings.dailyAuditEnabled) {
    const cron = new CronScheduler(cwd)
    cron.checkAndRun().then(report => {
      if (report) {
        appendSystemPanel(t('每日审计报告已生成', 'Daily Audit Report Generated'), [
          t('系统已完成对项目的每日例行审计。', 'Daily automated project audit completed.'),
          t('报告已存放在 .artemis/reports 目录中。', 'Report saved in .artemis/reports directory.'),
        ])
      }
    }).catch(() => { /* silent background error */ })
  }

  // Fixed zone base layout (4 rows at bottom, grows dynamically with multiline input):
  //   rows-3: HUD line
  //   rows-2: top separator
  //   rows-1: prompt line(s)
  //   rows:   bottom separator / hint bar
  // Scroll region: rows 1 .. (rows - BASE_FZ)

  // Slash-command definitions for the popup menu
  const SLASH_MENU_ITEMS: SlashMenuItem[] = [
    // ── 工作流 ──
    { value: '/team',       hint: t('AI 自动派单 (推荐)',         'AI auto-router (recommended)') },
    { value: '/niko',       hint: t('探索方向后落地',             'Explore, then build') },
    { value: '/design',     hint: t('先定设计，再实现',           'Shape the design, then implement') },
    { value: '/athena',     hint: t('深研代码库并协调执行',       'Deep repo research and coordinated execution') },
    { value: '/nidhogg',    hint: t('对抗式实现硬化 / 慢但最稳',  'Adversarial hardening / slow but strongest') },
    { value: '/contest',    hint: t('路径辩论与方案裁决',         'Path debate and selection') },
    { value: '/bifrost',    hint: t('配置思维/执行双模型',        'Setup dual brain/exec models') },
    { value: '/run',        hint: t('后台运行工作流',             'Run workflow in background') },
    // ── 系统 & 技能 ──
    { value: '/odin',       hint: t('Odin 技能库管理',           'Odin skill store') },
    { value: '/heimdall',   hint: t('Heimdall 线程控制面',        'Heimdall thread control plane') },
    { value: '/hud',        hint: t('显示 HUD 状态栏',           'Show HUD status bar') },
    // ── 对话管理 ──
    { value: '/clear',      hint: t('重置对话历史',               'Reset conversation') },
    { value: '/save',       hint: t('保存当前会话',               'Save current session') },
    { value: '/sessions',   hint: t('列出已保存会话',             'List saved sessions') },
    { value: '/search',     hint: t('跨会话全文搜索',             'Full-text search across sessions') },
    { value: '/wordup',     hint: t('列出 WordUP 快照',           'List WordUP snapshots') },
    { value: '/wordupnow',  hint: t('强制创建 WordUP 快照',       'Force-create WordUP snapshot') },
    { value: '/history',    hint: t('显示提示历史',               'Show prompt history') },
    { value: '/resume',     hint: t('恢复指定会话',               'Resume a session') },
    { value: '/undo',       hint: t('撤回上一步操作',             'Undo last turn') },
    { value: '/retry',      hint: t('重试上一步操作',             'Retry last turn') },
    // ── 配置 ──
    { value: '/model',      hint: t('切换模型',                   'Switch model') },
    { value: '/swap',       hint: t('互换执行/思维模型',          'Swap main/brain models') },
    { value: '/permission', hint: t('设置权限模式',               'Set permission mode') },
    { value: '/cd',         hint: t('切换工作区根目录',           'Switch workspace root') },
    { value: '/bundle',     hint: t('Bundle 润色增强设置',        'Bundle polisher settings') },
    { value: '/docs',       hint: t('选择文档搜索引擎',           'Choose docs search engine') },
    { value: '/locale',     hint: t('切换界面语言',               'Switch UI language') },
    { value: '/config',     hint: t('重新配置 AI 提供商',         'Reconfigure AI provider') },
    { value: '/config visual', hint: t('单独配置视觉模型',        'Configure visual model only') },
    { value: '/visual',     hint: t('快捷修改视觉 API 配置',     'Quick-edit visual API config') },
    { value: '/vercel',     hint: t('配置 Vercel 部署 token',    'Configure Vercel deployment token') },
    { value: '/config memory', hint: t('配置记忆增强',           'Configure memory enhancement') },
    { value: '/newborn',    hint: t('重置全部配置',               'Wipe config & re-run setup') },
    // ── 其他 ──
    { value: '/help',       hint: t('查看全部命令',               'Show all commands') },
    { value: '/exit',       hint: t('退出',                       'Exit') },
  ]

  const commitTransientBlocks = (): void => {
    if (!transientBlocks || transientBlocks.length === 0) {
      transientBlocks = null
      syncViewportFromState()
      return
    }
    const blocks = transientBlocks
    transientBlocks = null
    for (const b of blocks) scrollBlocks.push(b)
    syncViewportFromState()
  }



  // Inline insert — used by handleTurn to splice tool output in BEFORE the
  // pending assistant block so conversation scrolls upward (Claude-Code-style).
  const insertScrollBlock = (index: number, block: ScrollBlock): number => {
    const clamped = Math.max(0, Math.min(scrollBlocks.length, index))
    scrollBlocks.splice(clamped, 0, block)
    if (!landingCommitted) landingCommitted = true
    syncViewportFromState()
    return clamped
  }

  const updateScrollBlock = (index: number, block: ScrollBlock): void => {
    // Pending workflow / assistant blocks live in the transient zone
    // (rendered under the input). Dispatch by kind rather than just the
    // index, since both indexing schemes can hold value 0 simultaneously.
    if (
      ((block.kind === 'workflow' || block.kind === 'assistant') ||
        block.kind === 'system') &&
      transientBlocks &&
      index >= 0 &&
      index < transientBlocks.length
    ) {
      transientBlocks[index] = block
      if (!block.pending) commitTransientBlocks()
      else syncViewportFromState()
      return
    }

    if (index < 0 || index >= scrollBlocks.length) return
    scrollBlocks[index] = block
    syncViewportFromState()
  }

  const rebuildScrollBlocksFromMessages = (): void => {
    scrollBlocks = buildScrollBlocksFromMessages(getMessages())
    transientBlocks = null
    landingCommitted = scrollBlocks.length > 0
    syncViewportFromState()
  }

  const commitLandingForBackgroundNotification = (): void => {
    if (landingCommitted) return
    if (scrollBlocks.length > 0 || (transientBlocks && transientBlocks.length > 0)) return
    scrollBlocks.push({
      kind: 'system',
      text: buildLandingLines().join('\n'),
      preserveAnsi: true,
      rawLines: true,
    })
    landingCommitted = true
  }

  prompt = createBlessedPrompt({
    history: savedHistory,
    headerFn: () => renderHud(hud),
    footerHint: t(
      'Enter 提交  Ctrl+J 换行  ↑↓ 历史  Shift+↑↓/PgUp/PgDn 滚屏  / 命令',
      'Enter submit  Ctrl+J newline  ↑↓ history  Shift+↑↓/PgUp/PgDn scroll  / cmds',
    ),
    onTextChange: (text) => {
      if (text.startsWith('/') && !text.includes(' ')) {
        const filtered = SLASH_MENU_ITEMS.filter(item => item.value.startsWith(text))
        prompt?.setMenu(filtered.length > 0 ? filtered : null)
        prompt?.setSuggestion('')  // no ghost text when menu is showing
      } else {
        prompt?.setMenu(null)
        prompt?.setSuggestion('')
      }
    },
  })

  // Register prompt so background bridges can print into the scroll region
  setBridgePrinter((payload: TerminalNotification) => {
    // Background notifications (dream startup, IM bridge events, alerts) can
    // arrive before the user has typed anything. Preserve the landing/welcome
    // screen as the first scrollback block before appending the notification;
    // otherwise the first ambient message replaces the whole startup view.
    commitLandingForBackgroundNotification()
    if (typeof payload === 'string') {
      appendScrollBlock({ kind: 'tool', text: payload })
      return
    }
    if (payload.kind === 'bridge-status') {
      const level = payload.level === 'error'
        ? '[error]'
        : payload.level === 'warn'
          ? '[warning]'
          : '[info]'
      appendScrollBlock({
        kind: 'tool',
        text: `${level} ${bridgePlatformBadge(payload.platform)} · ${payload.targetLabel}: ${payload.text}`,
      })
      return
    }
    appendScrollBlock({
      kind: 'bridge',
      role: payload.direction === 'outbound' ? 'assistant' : 'user',
      platform: payload.platform,
      targetLabel: payload.targetLabel,
      text: payload.text,
      timestamp: timeStampLabel(),
    })
  })

  // Auto-start bridges after the printer is set up
  if (opts.autoStartBridges) {
    for (const platform of opts.autoStartBridges) {
      opts.onBridgeStart?.(platform)
    }
  }

  prompt.mountViewport()
  syncViewportFromState()

  const finishInteractiveSession = async (): Promise<void> => {
    setBridgePrinter(null)
    await wordupNow({ store: sessionStore, storedSession, messages: getMessages() })
    await updateUserProfileSilent(getMessages(), locale)
    prompt.dispose()
    leaveInteractiveScreen()
    process.stdout.write('\x1b[?25h')
    process.stdout.write('\x1b[0m')
    process.stdout.write('\r\n')
    console.log(buildPanel(t('已退出', 'Goodbye'), [t('感谢使用 Artemis。', 'Thanks for using Artemis.')]))
    console.log()
  }

  const interruptAndExitNow = (): never => {
    setBridgePrinter(null)
    prompt.dispose()
    leaveInteractiveScreen()
    process.stdout.write('\x1b[?25h')
    process.stdout.write('\x1b[0m')
    process.stdout.write('\r\n')
    console.log(buildPanel(t('已中断', 'Interrupted'), [t('已立即停止当前 CLI 会话。', 'Stopped the current CLI session immediately.')]))
    console.log()
    process.exit(130)
  }

  const createRunningMessageCapture = (): {
    hooks: RunningMessageHooks
    capture: (line: string) => void
  } => {
    const queue: string[] = []
    return {
      hooks: {
        pollRunningUserMessages: () => queue.splice(0),
        onRunningUserMessageAccepted: (text) => {
          appendScrollBlock({
            kind: 'system',
            text: t(
              `新对话已同步到当前任务：${text}`,
              `New message synced into the current task: ${text}`,
            ),
          })
        },
      },
      capture: (line) => {
        queue.push(line)
        appendScrollBlock({
          kind: 'user',
          text: `${line}\n\n${t('↳ 新对话已接收：Artemis 会在下一个安全点重新整理当前任务。', '↳ New message received: Artemis will reconcile it with the current task at the next safe point.')}`,
          timestamp: timeStampLabel(),
        })
        prompt.forceRedraw()
      },
    }
  }

  const waitForRunnerOrInterrupt = async (
    runnerOrCapture: Promise<void> | Promise<DetachedRunningMessageCapture | undefined>,
    onRunningMessage?: (line: string) => void,
  ): Promise<string | null | undefined> => {
    let runnerDone = false
    let runnerError: unknown = null
    let runningMessageHandler = onRunningMessage
    const trackedRunner = Promise.resolve(runnerOrCapture).then(
      (capture) => {
        if (!runningMessageHandler && capture && typeof capture.capture === 'function') {
          runningMessageHandler = capture.capture
        }
        runnerDone = true
      },
      (err) => { runnerDone = true; runnerError = err },
    )

    while (!runnerDone || runningMessageHandler) {
      const nextLine = await Promise.race([
        prompt.read(),
        trackedRunner.then(() => undefined),
      ])
      // If the runner finishes before the user submits anything, do not turn
      // that absence of input into a null line. Returning undefined lets the
      // caller start a fresh prompt instead of taking the normal EOF/Ctrl-D
      // exit path. This is especially important on Windows terminals, where a
      // completed turn was observed to fall through into the goodbye panel.
      if (nextLine === undefined) break
      if (nextLine === null) {
        interruptAndExitNow()
        continue
      }
      const trimmedLine = nextLine.trim()
      if (trimmedLine && runningMessageHandler) {
        runningMessageHandler(nextLine)
        continue
      }
      if (!runningMessageHandler) {
        await trackedRunner
        if (runnerError) throw runnerError
        return nextLine
      }
    }

    await trackedRunner
    if (runnerError) throw runnerError
    return undefined
  }

  const launchDetachedWorkflow = async (
    command: 'run' | 'nidhogg',
    effectivePrompt: string,
  ): Promise<DetachedRunningMessageCapture | undefined> => {
    try {
      if (!(await ensureExecutionProviderForWorkflow(workspaceRoot))) {
        return undefined
      }
      const provConfig = await resolveMainProviderConfig({ cwd: workspaceRoot, config: {} })
      const result = await spawnDetachedWorkflow({
        cwd: workspaceRoot,
        sessionStore,
        prompt: effectivePrompt,
        command,
        maxTurns: opts.maxTurns,
        permissionMode: permissionMode as 'PRODUCER' | 'GHOSTWRITER' | 'WRITER' | 'prompt' | 'read-only' | 'accept-edits' | 'accept-all',
        permissionModeExplicit: false,
        providerConfig: provConfig,
      })
      appendSystemPanel(
        command === 'nidhogg'
          ? t('Nidhogg Harness 已启动', 'Nidhogg Harness launched')
          : t('后台任务已启动', 'Background task launched'),
        [
          `Session: ${result.sessionId.slice(0, 8)}`,
          `Runtime: ${result.runtimeId.slice(0, 8)}`,
          `Log: ${result.logPath}`,
        ],
      )
      return {
        capture: (line) => {
          const cleanLine = line.trim()
          if (!cleanLine) return
          void appendDetachedWorkflowMessage(workspaceRoot, result.runtimeId, cleanLine).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            appendSystemPanel(t('新对话同步失败', 'New message sync failed'), [msg])
          })
          appendScrollBlock({
            kind: 'user',
            text: `${cleanLine}\n\n${t('↳ 新对话已接收：Nidhogg 会在下一个安全点重新整理当前任务。', '↳ New message received: Nidhogg will reconcile it with the current task at the next safe point.')}`,
            timestamp: timeStampLabel(),
          })
          prompt.forceRedraw()
        },
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      appendSystemPanel(t('启动失败', 'Launch failed'), [msg])
      return undefined
    }
  }

  // nextLineOverride: when the user types during AI generation, prompt.read()
  // completes concurrently. We stash the result here so the next iteration
  // uses it directly instead of calling prompt.read() again.
  let nextLineOverride: string | null | undefined = undefined
  let suppressInitialNewbornOnce = opts.suppressInitialNewbornOnce === true
  let activeDetachedCapture: DetachedRunningMessageCapture | undefined

  for (;;) {
    const line: string | null = nextLineOverride !== undefined ? nextLineOverride : await prompt.read()
    nextLineOverride = undefined

    if (line === null) {
      await finishInteractiveSession()
      return
    }

    // /team router can reassign this when it picks `direct` and falls through
    // to the regular AI turn dispatcher below.
    let trimmed: string = line.trim()
    if (!trimmed) continue

    if (activeDetachedCapture && !trimmed.startsWith('/')) {
      activeDetachedCapture.capture(line)
      continue
    }

    // Reset the dream-system idle clock — any user input means we should
    // not start dreaming for at least another idleThresholdSec.
    void (async () => {
      try {
        const { markActivity } = await import('../services/idleWatcher.js')
        markActivity()
      } catch { /* ignore */ }
    })()

    if (suppressInitialNewbornOnce && trimmed === '/newborn') {
      suppressInitialNewbornOnce = false
      appendSystemPanel(
        t('提示', 'Notice'),
        [t(
          '已忽略刚完成引导后的残留 /newborn 输入。如需重置，请再输入一次。',
          'Ignored a likely stray /newborn right after setup. Run it again if intended.',
        )],
      )
      prompt.forceRedraw()
      continue
    }
    suppressInitialNewbornOnce = false

    // ── easter egg ────────────────────────────────────────────────────────────
    if (isHighEasterEggTrigger(trimmed)) {
      appendSystemText(formatRichOutput(buildHighEasterEggCompact(locale)))
      continue
    }

    // ── slash commands ────────────────────────────────────────────────────────
    if (trimmed === '/exit' || trimmed === '/quit') {
      await askAndSaveSession('/exit')
      await updateUserProfileSilent(getMessages(), locale)
      prompt.dispose()
      leaveInteractiveScreen()
      // Clean up terminal state
      process.stdout.write('\x1b[?25h')  // Show cursor
      process.stdout.write('\x1b[0m')    // Reset all attributes
      process.stdout.write('\r\n')       // New line
      console.log(buildPanel(t('已退出', 'Goodbye'), [t('感谢使用 Artemis。', 'Thanks for using Artemis.')]))
      console.log()
      return
    }

    if (trimmed === '/clear') {
      await askAndSaveSession('/clear')
      const msgsBefore = getMessages()
      await updateUserProfileSilent(msgsBefore, locale)
      resetSession()
      scrollBlocks = []
      transientBlocks = null
      landingCommitted = false
      storedSession = null
      hud.sessionMessageCount = 0
      hud.sessionTotalTokens = 0
      hud.turnsWithUsage = 0
      redrawViewportFromState()
      continue
    }

    if (trimmed === '/hud') {
      appendSystemPanel(t('HUD', 'HUD'), [stripAnsi(renderHud(hud))])
      continue
    }

    if (trimmed === '/sessions') {
      appendSystemText(await renderSessions(sessionStore, locale))
      continue
    }

    if (trimmed.startsWith('/search')) {
      const query = trimmed.slice('/search'.length).trim()
      if (!query) {
        appendSystemPanel(t('用法', 'Usage'), [`/search <${t('关键词', 'keyword')}>`])
      } else {
        const waiter = startWaitingPanel(t('搜索中', 'Searching'), [
          `${t('关键词', 'Query')}: ${query}`,
          t('正在扫描历史会话…', 'Scanning prior sessions…'),
        ])
        const results = await searchSessions(cwd, query)
        if (results.length === 0) {
          waiter.stop(
            t(`搜索 "${query}"`, `Search: "${query}"`),
            [t('无匹配结果。', 'No results found.')],
          )
        } else {
          const lines: string[] = []
          for (const r of results) {
            const date = r.updatedAt.slice(0, 10)
            lines.push(`${r.sessionId.slice(0, 8)}  ${date}  [${r.matchCount}] ${r.sessionTitle.slice(0, 35)}`)
            for (const s of r.snippets) lines.push(`    ${s.slice(0, 90)}`)
            lines.push('')
          }
          waiter.stop(
            t(`搜索结果 "${query}" (${results.length})`, `Results for "${query}" (${results.length})`),
            lines,
          )
        }
      }
      continue
    }

    if (trimmed === '/help') {
      appendSystemText(renderHelp(locale))
      continue
    }

    // Unknown slash-prefixed input is almost certainly an attempted command or
    // menu search, not a free-form AI request. Letting it fall through to the
    // regular turn path is dangerous on Windows: `/foo` can be interpreted by
    // workspace-intent detection as a POSIX absolute path, which Node resolves
    // on the current drive (for example `C:\\foo`) and can trigger a trust
    // prompt for the drive root. Keep the prompt alive and show a local error
    // instead of submitting anything to the model/system.
    const knownSlashCommand = SLASH_MENU_ITEMS.some((item) =>
      trimmed === item.value || trimmed.startsWith(`${item.value} `),
    )
    if (trimmed.startsWith('/') && !knownSlashCommand) {
      appendSystemPanel(t('未知命令', 'Unknown command'), [
        `${trimmed.split(/\s+/, 1)[0]} — ${t('运行 /help 查看可用命令。', 'Run /help to see available commands.')}`,
      ])
      prompt.forceRedraw()
      continue
    }

    // ── /config ──────────────────────────────────────────────────────────────
    const configMatch = trimmed.match(/^\/config(?:\s+(.+))?$/)
    if (configMatch) {
      const configSubcommand = (configMatch[1] ?? '').trim().toLowerCase()
      await askAndSaveSession(trimmed)
      prompt.clearBuffer()
      if (configSubcommand === 'visual' || configSubcommand === 'vision') {
        await runVisualModelSetup(locale, cwd, {
          choose: async (options) => {
            const picked = await prompt.pickOption(options)
            if (picked === null && options.escapeValue !== undefined) return options.escapeValue
            if (picked === null) throw new Error('Selection cancelled.')
            return picked
          },
        })
        prompt.clearBuffer()
        suppressInitialNewbornOnce = true
      } else if (configSubcommand === 'memory') {
        await prompt.releaseTerminal(() => runSetupWizard({ locale, cwd, section: 'memory' }))
        prompt.clearBuffer()
        suppressInitialNewbornOnce = true
      } else {
        const result = await prompt.releaseTerminal(() => runOnboarding(locale, cwd))
        prompt.clearBuffer()
        suppressInitialNewbornOnce = true
        if (result.configured && result.model) {
          // Reload provider after reconfiguration
          const reloadStore = new ProviderStore(cwd)
          const reloadData = await reloadStore.load()
          const reloadConfig = reloadStore.getDefaultMainProfile(reloadData)
          const reloadBrain = reloadStore.getProfile(reloadData, reloadData.specialistProfileId)
          if (reloadConfig?.model) {
            switchModel(reloadConfig.model)
            modelLabel = reloadConfig.model
            modelContextLimit = reloadConfig.contextLength
            hud.defaultModel = modelLabel
            hud.lastModel    = modelLabel
            hud.contextLimit = modelContextLimit
          }
          brainLabel = reloadBrain?.model
          hud.brainModel = brainLabel
          // Refresh HUD counts
          try {
            const mcpStore  = new McpServerStore(cwd)
            const mcpData   = await mcpStore.load()
            hud.mcpServerCount = mcpData.servers.filter(s => s.enabled).length
            const bragiStore = new BragiStore(cwd)
            const bragiData  = await bragiStore.load()
            hud.pluginCount  = Object.values(bragiData.platforms).filter(p => p?.enabled).length
          } catch { /* ignore */ }
        }
      }
      continue
    }

    // ── /visual — Reconfigure visual (image/video) model only ───────────────
    if (trimmed === '/visual' || trimmed === '/vision') {
      await askAndSaveSession(trimmed)
      prompt.clearBuffer()
      await runVisualModelSetup(locale, cwd, {
        choose: async (options) => {
          const picked = await prompt.pickOption(options)
          if (picked === null && options.escapeValue !== undefined) return options.escapeValue
          if (picked === null) throw new Error('Selection cancelled.')
          return picked
        },
      })
      prompt.clearBuffer()
      suppressInitialNewbornOnce = true
      continue
    }

    // ── /vercel — Configure Vercel deployment token in-CLI ───────────────────
    if (trimmed === '/vercel' || trimmed.startsWith('/vercel ')) {
      const sub = trimmed.slice('/vercel'.length).trim().toLowerCase()
      await askAndSaveSession(trimmed)
      prompt.clearBuffer()
      if (sub === 'logout' || sub === 'clear') {
        const had = await clearStoredVercelAuth()
        appendSystemPanel(
          t('Vercel 授权', 'Vercel auth'),
          had
            ? [t('已清除已保存的 token。', 'Cleared saved token.')]
            : [t('当前没有保存的 token。', 'No saved token to clear.')],
        )
      } else if (sub === 'status') {
        const rec = await readStoredVercelAuth()
        appendSystemPanel(
          t('Vercel 授权状态', 'Vercel auth status'),
          rec
            ? [
                `${t('已配置', 'Configured')} (${rec.userEmail ?? rec.username ?? rec.userName ?? '?'})`,
                `${t('保存于', 'Saved at')} ${rec.savedAt}`,
                t('运行 /vercel 可重新授权或更换 token。', 'Run /vercel to reconfigure or replace the token.'),
              ]
            : [t('未配置。运行 /vercel 完成首次授权。', 'Not configured. Run /vercel to complete first-time auth.')],
        )
      } else {
        await prompt.releaseTerminal(() => runVercelAuthWizard(locale))
        prompt.clearBuffer()
        suppressInitialNewbornOnce = true
      }
      continue
    }

    // ── /mcp [sub] ──────────────────────────────────────────────────────────
    if (trimmed === '/mcp' || trimmed.startsWith('/mcp ')) {
      const mcpStore = new McpServerStore(cwd)
      const data = await mcpStore.load()
      const sub = trimmed.slice('/mcp'.length).trim().toLowerCase()

      if (!sub || sub === 'list' || sub === 'ls' || sub.startsWith('list ') || sub.startsWith('ls ')) {
        // /mcp list [keyword]  — keyword filters by id or surfaceName
        const keyword = sub.replace(/^(list|ls)\s*/, '').trim()
        let servers = data.servers
        if (keyword) {
          const kw = keyword.toLowerCase()
          servers = servers.filter(s => {
            const name = (s.surface?.serverName ?? '').toLowerCase()
            return s.id.toLowerCase().includes(kw) || name.includes(kw)
          })
        }
        const enabled = data.servers.filter(s => s.enabled).length
        const total = data.servers.length
        const header = keyword
          ? t(`MCP 搜索 "${keyword}" — ${servers.length}/${total} 命中, ${enabled} 已启用`, `MCP search "${keyword}" — ${servers.length}/${total} matches, ${enabled} enabled`)
          : t(`MCP 服务 — 共 ${total}, ${enabled} 已启用`, `MCP servers — ${total} total, ${enabled} enabled`)
        const rows = servers.slice(0, 40).map(s => {
          const status = s.enabled ? '\x1b[1;32mON\x1b[0m ' : '\x1b[2mOFF\x1b[0m'
          const name = (s.surface?.serverName ?? s.id).slice(0, 35).padEnd(35)
          return `${status}  ${name} [${s.transport}]  ${s.id}`
        })
        if (servers.length > 40) {
          rows.push(t(`  … +${servers.length - 40} 更多 (用 /mcp list <关键词> 过滤)`, `  … +${servers.length - 40} more (use /mcp list <keyword> to filter)`))
        }
        if (rows.length === 0) {
          rows.push(t('无匹配项', 'No matches'))
        }
        if (!keyword && total > 0) {
          rows.push('')
          rows.push(t('提示: /mcp suggest <意图> 智能推荐 | /mcp enable <id> 启用 | /mcp list <关键词> 搜索', 'Tip: /mcp suggest <intent> for AI-ranked suggestions | /mcp enable <id> | /mcp list <keyword>'))
        }
        appendSystemPanel(header, rows)
      } else if (sub.startsWith('suggest ') || sub === 'suggest') {
        const intent = trimmed.slice('/mcp suggest'.length).trim()
        if (!intent) {
          appendSystemPanel(
            t('用法', 'Usage'),
            [t('/mcp suggest <意图描述>  例如: /mcp suggest 部署到 vercel', '/mcp suggest <intent>  e.g. /mcp suggest deploy to vercel')],
          )
        } else {
          const suggestions = await suggestMcpServersForIntent(cwd, intent, data.servers)
          if (suggestions.length === 0) {
            appendSystemPanel(
              t(`MCP 建议: ${intent}`, `MCP suggestions: ${intent}`),
              [t('无匹配建议——所有相关服务可能都已启用，或 intent 太宽泛', 'No suggestions — all relevant servers may already be enabled, or intent is too broad')],
            )
          } else {
            const lines = suggestions.slice(0, 15).map((s: any) => {
              const name = (s.surface?.serverName ?? s.id).slice(0, 30).padEnd(30)
              const score = typeof s.score === 'number' ? ` [${s.score.toFixed(2)}]` : ''
              return `  \x1b[1;35m${name}\x1b[0m  ${s.id}${score}`
            })
            lines.push('')
            lines.push(t(`输入 /mcp enable <ID> 启用对应服务`, `Type /mcp enable <ID> to activate`))
            appendSystemPanel(t(`MCP 建议: ${intent}`, `MCP suggestions: ${intent}`), lines)
          }
        }
      } else if (sub.startsWith('enable ')) {
        const id = sub.slice('enable '.length).trim()
        const server = data.servers.find(s => s.id === id)
        if (server) {
          server.enabled = true
          await mcpStore.save(data)
          hud.mcpServerCount = data.servers.filter(s => s.enabled).length
          appendSystemPanel(t('MCP 已启用', 'MCP Enabled'), [`→ ${id}`])
        } else {
          appendSystemPanel(t('MCP 启用失败', 'MCP Enable Failed'), [t(`未找到 ID: ${id}`, `ID not found: ${id}`)])
        }
      } else if (sub.startsWith('disable ')) {
        const id = sub.slice('disable '.length).trim()
        const server = data.servers.find(s => s.id === id)
        if (server) {
          server.enabled = false
          await mcpStore.save(data)
          hud.mcpServerCount = data.servers.filter(s => s.enabled).length
          appendSystemPanel(t('MCP 已禁用', 'MCP Disabled'), [`→ ${id}`])
        } else {
          appendSystemPanel(t('MCP 禁用失败', 'MCP Disable Failed'), [t(`未找到 ID: ${id}`, `ID not found: ${id}`)])
        }
      } else {
        appendSystemPanel(
          t('MCP 用法', 'MCP Usage'),
          [
            '/mcp                       ' + t('列出所有 MCP 服务', 'list all MCP servers'),
            '/mcp list <关键词>          ' + t('按关键词搜索', 'search by keyword'),
            '/mcp suggest <意图>         ' + t('智能推荐相关服务', 'AI-ranked suggestions'),
            '/mcp enable <ID>           ' + t('启用某个服务', 'enable a server'),
            '/mcp disable <ID>          ' + t('禁用某个服务', 'disable a server'),
          ],
        )
      }
      continue
    }

    // ── /skills [keyword] ──────────────────────────────────────────────────
    // Show skill catalog (by category) or search by keyword.
    // With 999+ skills installed, this is the primary discovery UX.
    if (trimmed === '/skills' || trimmed.startsWith('/skills ')) {
      const { SkillManager: SkillMgr } = await import('../core/skillManager.js')
      const sm = new SkillMgr()
      await sm.ready()
      const allSkills = sm.getAllSkillDefinitions()
      const keyword = trimmed.slice('/skills'.length).trim()

      if (!keyword) {
        const byCategory = new Map<string, number>()
        for (const s of allSkills) {
          const cat = (s.category ?? 'general').toLowerCase()
          byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1)
        }
        const sorted = [...byCategory.entries()].sort((a, b) => b[1] - a[1])
        const lines = [
          t(`总技能数: ${allSkills.length}`, `Total skills: ${allSkills.length}`),
          '',
          ...sorted.map(([cat, count]) => `  ${cat.padEnd(22)} ${count}`),
          '',
          t('用法: /skills <关键词> 搜索具体技能 (匹配 name/description/tags)', 'Usage: /skills <keyword> to search by name/description/tags'),
        ]
        appendSystemPanel(t('技能目录', 'Skill catalog'), lines)
      } else {
        const matches = sm.searchSkills(keyword)
        if (matches.length === 0) {
          appendSystemPanel(
            t('技能搜索', 'Skill search'),
            [t(`未找到匹配 "${keyword}" 的技能`, `No skills match "${keyword}"`)],
          )
        } else {
          const lines = matches.slice(0, 30).map((s) => {
            const id = s.id.slice(0, 38).padEnd(38)
            const desc = (s.description ?? '').slice(0, 60)
            return `  ${id}  ${desc}`
          })
          if (matches.length > 30) {
            lines.push(t(`  … +${matches.length - 30} 更多 (优化关键词以缩小范围)`, `  … +${matches.length - 30} more (refine keyword)`))
          }
          appendSystemPanel(
            t(`技能搜索 "${keyword}" — ${matches.length} 命中`, `Skills matching "${keyword}" — ${matches.length} matches`),
            lines,
          )
        }
      }
      continue
    }

    // ── /spotify login | logout | status ──────────────────────────────────
    // Spotify OAuth (PKCE) flow. After /spotify login, brain has 10
    // spotify_* tools available for use from CLI or via bridges (Telegram /
    // Discord / WeChat).
    if (trimmed === '/spotify' || trimmed.startsWith('/spotify ')) {
      const sub = trimmed.slice('/spotify'.length).trim()
      const { loadSpotifyConfig, saveSpotifyConfig, clearSpotifyAuth } = await import('../tools/spotify/store.js')

      if (sub === 'login') {
        // Step 1: get Client ID from existing config or prompt user
        const cfg = await loadSpotifyConfig()
        let clientId = cfg.clientId
        if (!clientId) {
          appendSystemPanel(
            t('Spotify 首次配置', 'Spotify First-Time Setup'),
            [
              t(
                '需要你在 Spotify 开发者后台注册一个应用（一次性，~3 分钟）：',
                'Register a Spotify app at the developer dashboard (one-time, ~3 min):',
              ),
              '',
              '  1. ' + t('打开 https://developer.spotify.com/dashboard', 'Open https://developer.spotify.com/dashboard'),
              '  2. ' + t('Create app → 任意名字（如 Artemis Home）', 'Create app → any name (e.g. Artemis Home)'),
              '  3. ' + t('Redirect URI 填: http://127.0.0.1:8888/callback', 'Set Redirect URI to: http://127.0.0.1:8888/callback'),
              '  4. ' + t('勾选 "Web API"', 'Check "Web API" capability'),
              '  5. ' + t('在 Settings 复制 Client ID（不需要 Secret）', 'Copy Client ID from Settings (Secret not needed)'),
              '',
              t('完成后，把 Client ID 粘到下一行：', 'Paste your Client ID below:'),
            ],
          )
          const idInput = await prompt.releaseTerminal(async () => {
            const readline = await import('node:readline/promises')
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
            try {
              return (await rl.question(t('Spotify Client ID: ', 'Spotify Client ID: '))).trim()
            } finally {
              rl.close()
            }
          })
          prompt.forceRedraw()
          const trimmedId = (typeof idInput === 'string' ? idInput : '').trim()
          if (!trimmedId || trimmedId.length < 20) {
            appendSystemPanel(t('已取消', 'Cancelled'), [t('未输入有效的 Client ID。', 'No valid Client ID provided.')])
            continue
          }
          clientId = trimmedId
          await saveSpotifyConfig({ ...cfg, clientId })
        }

        // Step 2: run OAuth flow
        appendSystemPanel(
          t('Spotify 授权中', 'Spotify authorization in progress'),
          [t('浏览器即将打开，请登录 Spotify 并授权 Artemis...', 'Browser will open. Log in to Spotify and authorize Artemis...')],
        )
        const { loginSpotify } = await import('../tools/spotify/oauth.js')
        const result = await loginSpotify(clientId)
        if (!result.ok) {
          appendSystemPanel(t('Spotify 登录失败', 'Spotify Login Failed'), [result.error])
        } else {
          const userLine = result.config.user?.displayName
            ? `${result.config.user.displayName} <${result.config.user.email ?? ''}>`
            : (result.config.user?.email ?? '(unknown user)')
          appendSystemPanel(
            t('Spotify 已连接 ✓', 'Spotify connected ✓'),
            [
              t(`账户：${userLine}`, `Account: ${userLine}`),
              t('Brain 现在有 10 个 spotify_* 工具可用。', 'Brain now has 10 spotify_* tools available.'),
              t('试试：/skills (找 spotify 相关) 或直接说 "放点音乐"', 'Try: /skills spotify or just say "play some music"'),
            ],
          )
          // Refresh system prompt suffix so brain immediately sees Spotify hint
          const refreshed = await buildFullSystemSuffix(workspaceRoot)
          if (refreshed) setSystemPromptSuffix(refreshed)
        }
      } else if (sub === 'logout') {
        await clearSpotifyAuth()
        appendSystemPanel(
          t('Spotify 已注销', 'Spotify Logged Out'),
          [t('access_token + refresh_token 已清除。Client ID 保留以便下次 /spotify login 不需重输。', 'Tokens cleared. Client ID kept for next /spotify login.')],
        )
        const refreshed = await buildFullSystemSuffix(workspaceRoot)
        if (refreshed) setSystemPromptSuffix(refreshed)
      } else if (sub === '' || sub === 'status') {
        const cfg = await loadSpotifyConfig()
        const lines: string[] = []
        if (!cfg.clientId) {
          lines.push(t('未配置。运行 /spotify login 开始。', 'Not configured. Run /spotify login to start.'))
        } else if (!cfg.auth) {
          lines.push(t(`Client ID 已存（${cfg.clientId.slice(0, 8)}...），但未授权。运行 /spotify login。`, `Client ID configured (${cfg.clientId.slice(0, 8)}...). Not authorized. Run /spotify login.`))
        } else {
          const expiresIn = Math.max(0, Math.round((cfg.auth.expiresAt - Date.now()) / 1000))
          lines.push(t(`✓ 已登录`, `✓ Logged in`))
          if (cfg.user) lines.push(t(`账户：${cfg.user.displayName ?? cfg.user.email ?? cfg.user.id}`, `Account: ${cfg.user.displayName ?? cfg.user.email ?? cfg.user.id}`))
          lines.push(t(`Token 还有 ${expiresIn} 秒有效（自动刷新）`, `Token valid for ${expiresIn}s (auto-refreshes)`))
          if (cfg.preferredDevice) {
            lines.push(t(`默认设备：${cfg.preferredDevice.name}`, `Preferred device: ${cfg.preferredDevice.name}`))
          }
          lines.push('')
          lines.push(t('用法：', 'Usage:'))
          lines.push('  /spotify logout          ' + t('注销', 'log out'))
          lines.push('  /spotify status          ' + t('查看状态', 'show status'))
        }
        appendSystemPanel(t('Spotify 状态', 'Spotify Status'), lines)
      } else {
        appendSystemPanel(
          t('Spotify 用法', 'Spotify Usage'),
          [
            '/spotify          ' + t('或 /spotify status — 查看状态', 'or /spotify status — show status'),
            '/spotify login    ' + t('OAuth 登录（首次需要 Client ID）', 'OAuth login (Client ID needed first time)'),
            '/spotify logout   ' + t('注销', 'log out'),
          ],
        )
      }
      continue
    }

    if (trimmed === '/newborn') {
      const localDataRoot = resolveDataRootDir(cwd)
      const globalDataRoot = path.join(HOME_DIR, '.artemis')
      const filesToWipe = [
        path.join(localDataRoot, 'providers.json'),
        path.join(localDataRoot, 'bragi.json'),
        path.join(localDataRoot, 'wechat.json'),
        path.join(localDataRoot, 'cli-settings.json'),
        path.join(globalDataRoot, 'providers.json'),
        path.join(globalDataRoot, 'bragi.json'),
        path.join(globalDataRoot, 'wechat.json'),
        path.join(globalDataRoot, 'cli-settings.json'),
      ]

      // Show confirmation dialog directly without pre-displaying file paths
      let confirmed = false
      try {
        confirmed = await prompt.confirm({
          title: t('重置配置？', 'Reset Configuration?'),
          lines: [
            t('将删除所有配置文件并重新设置', 'Delete all config files and restart setup'),
            t('对话历史将保留', 'Chat history will be kept'),
          ],
          confirmLabel: t('确定', 'Yes'),
          cancelLabel: t('取消', 'No'),
        })
      } catch { confirmed = false }

      if (!confirmed) {
        appendSystemPanel(t('已取消', 'Cancelled'), [t('未执行重置。', 'Reset was cancelled.')])
        continue
      }

      // Save session before wiping
      await wordupNow({ store: sessionStore, storedSession, messages: getMessages() })

      for (const f of filesToWipe) {
        await unlink(f).catch(() => { /* file may not exist */ })
      }
      resetSession()

      // Re-run the first-run language chooser before onboarding.
      prompt.clearBuffer()
      locale = await prompt.releaseTerminal(() => runFirstRunWelcome({ settingsStore: opts.settingsStore }))

      // Re-run onboarding
      const result = await prompt.releaseTerminal(() => runOnboarding(locale, cwd))
      prompt.clearBuffer()
      suppressInitialNewbornOnce = true
      if (result.configured && result.model) {
        switchModel(result.model)
        modelLabel = result.model
        hud.defaultModel = modelLabel
        hud.lastModel    = modelLabel
        try {
          const reloadStore2 = new ProviderStore(cwd)
          const reloadData2  = await reloadStore2.load()
          modelContextLimit = reloadStore2.getDefaultMainProfile(reloadData2)?.contextLength
          hud.contextLimit = modelContextLimit
          brainLabel = reloadStore2.getProfile(reloadData2, reloadData2.specialistProfileId)?.model
          const mcpStore  = new McpServerStore(cwd)
          const mcpData   = await mcpStore.load()
          hud.mcpServerCount = mcpData.servers.filter(s => s.enabled).length
          const bragiStore = new BragiStore(cwd)
          const bragiData  = await bragiStore.load()
          hud.pluginCount  = Object.values(bragiData.platforms).filter(p => p?.enabled).length
          activeBridgeNames = Object.entries(bragiData.platforms)
            .filter(([, cfg]) => cfg?.enabled)
            .map(([platform]) => BRIDGE_DISPLAY_NAMES[platform] ?? platform)
          if (onBridgeStart) {
            for (const [platform, cfg] of Object.entries(bragiData.platforms)) {
              if (cfg?.autoStartOnLaunch) onBridgeStart(platform)
            }
          }
        } catch { /* non-fatal */ }
      }
      // Re-run workspace trust dialog (matches initial-launch behavior)
      const trustResult = await prompt.releaseTerminal(() => runWorkspaceTrustDialog({
        cwd, locale, settingsStore: trustSettingsStore,
      }))
      prompt.clearBuffer()
      if (trustResult === 'declined') {
        await finishInteractiveSession()
        return
      }

      // Return straight to the main landing splash — no trailing panel.
      rebuildScrollBlocksFromMessages()
      continue
    }

    if (trimmed === '/soul' || trimmed.startsWith('/soul ')) {
      const arg = trimmed.slice('/soul'.length).trim().toLowerCase()
      const soulPath = getSoulPath()

      if (!arg || arg === 'status') {
        const exists = await hasSoulFile()
        const body = exists ? await readSoulFile() : ''
        appendSystemPanel(t('赋魔 / soul.md', 'Soul Forge / soul.md'), [
          `${t('状态', 'Status')}: ${exists ? t('已存在', 'configured') : t('未配置', 'not configured')}`,
          `${t('路径', 'Path')}: ${soulPath}`,
          ...(exists ? ['', `${t('大小', 'Size')}: ${Buffer.byteLength(body, 'utf8')} bytes`] : [
            '',
            t('输入 /soul start 通过人格题建立 soul.md。', 'Run /soul start to create soul.md through personality questions.'),
            t('输入 /soul quick 写入推荐人格。', 'Run /soul quick to write the recommended soul.'),
          ]),
        ])
        continue
      }

      if (arg === 'dismiss') {
        await dismissSoulOnboarding()
        appendSystemPanel(t('赋魔提醒', 'Soul prompt'), [t('已关闭自动提醒。仍可随时输入 /soul start。', 'Dismissed. You can still run /soul start anytime.')])
        continue
      }

      if (arg === 'quick') {
        const content = buildDefaultSoulMarkdown(locale)
        await saveSoulFile(content)
        appendSystemPanel(t('赋魔完成', 'Soul forged'), [
          t('已写入推荐人格：黑猫司仪。', 'Recommended soul written: Black Cat Ceremonialist.'),
          `${t('文件', 'File')}: ${soulPath}`,
        ])
        continue
      }

      if (arg === 'show') {
        const body = await readSoulFile()
        appendSystemPanel('soul.md', body ? body.split('\n') : [t('还没有 soul.md。', 'No soul.md yet.')])
        continue
      }

      if (arg === 'start' || arg === 'standard' || arg === 'deep') {
        const mode: SoulMode = arg === 'deep' ? 'deep' : arg === 'standard' ? 'standard' : 'quick'
        const questions = selectSoulQuestions(mode)
        const answers: number[] = []
        appendSystemPanel(t('🜏 赋魔仪式开始', '🜏 Soul Forge begins'), [
          t(
            '接下来不是测试，而是点火：几道钥匙般的问题，会决定 Artemis 在事实、风险、速度、温度与想象之间如何分配自己的重力。',
            'What follows is not a test, but kindling: a few key-like questions deciding how Artemis distributes gravity among fact, risk, speed, warmth, and imagination.',
          ),
        ])

        for (const question of questions) {
          const choice = await prompt.pickOption<string>({
            title: locale === 'zh-CN' ? question.zh : question.en,
            choices: question.choices.map((choice, index) => ({
              label: `${index + 1}. ${locale === 'zh-CN' ? choice.zh : choice.en}`,
              value: String(index),
            })),
          }) ?? '0'
          prompt.clearBuffer()
          const parsed = Number.parseInt(choice, 10)
          answers.push(Number.isFinite(parsed) ? parsed : 0)
        }

        const profile = buildSoulProfile(answers, questions)
        const content = buildSoulMarkdown(profile, locale)
        await saveSoulFile(content)
        appendSystemPanel(t('🜏 赋魔完成', '🜏 Soul forged'), [
          `${t('人格', 'Type')}: ${locale === 'zh-CN' ? profile.titleZh : profile.titleEn}`,
          ...((locale === 'zh-CN' ? profile.traitsZh : profile.traitsEn).map(line => `- ${line}`)),
          '',
          `${t('文件', 'File')}: ${soulPath}`,
        ])
        continue
      }

      appendSystemPanel(t('赋魔用法', 'Soul usage'), [
        '/soul status   ' + t('查看 soul.md 状态', 'show soul.md status'),
        '/soul start    ' + t('快速赋魔题组并写入 soul.md', 'quick Soul Forge questions and write soul.md'),
        '/soul standard ' + t('标准题组', 'standard question set'),
        '/soul deep     ' + t('完整题组', 'full question set'),
        '/soul quick    ' + t('直接写入推荐人格', 'write recommended soul'),
        '/soul show     ' + t('显示当前 soul.md', 'show current soul.md'),
        '/soul dismiss  ' + t('关闭自动提醒', 'dismiss automatic prompt'),
      ])
      continue
    }

    if (trimmed === '/history') {
      appendSystemText(await renderHistory(historyStore, locale))
      continue
    }

    // ── /model [name] ─────────────────────────────────────────────────────────
    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      const arg = trimmed.slice('/model'.length).trim()
      if (!arg) {
        appendSystemPanel(t('当前模型', 'Current model'), [
          modelLabel,
          '',
          t('用法: /model <模型名>  例如:', 'Usage: /model <name>  e.g.:'),
          '  /model claude-opus-4-6',
          '  /model claude-sonnet-4-20250514',
          '  /model gpt-4o',
        ])
      } else {
        await askAndSaveSession('/model')
        switchModel(arg)
        modelLabel = arg
        modelContextLimit = undefined
        hud.defaultModel = arg
        hud.lastModel = arg
        hud.contextLimit = modelContextLimit
        appendSystemPanel(t('模型已切换', 'Model switched'), [`→ ${arg}`])
      }
      continue
    }

    // ── /locale [zh|en] ───────────────────────────────────────────────────────
    if (trimmed === '/locale' || trimmed.startsWith('/locale ')) {
      const arg = trimmed.slice('/locale'.length).trim().toLowerCase()
      if (!arg) {
        appendSystemPanel(t('当前语言', 'Current locale'), [
          locale,
          '',
          t('用法: /locale zh  或  /locale en', 'Usage: /locale zh  or  /locale en'),
        ])
      } else {
        const next: UiLocale = arg === 'zh' || arg === 'zh-cn' ? 'zh-CN' : 'en'
        locale = next
        await opts.settingsStore.setUiLocale(next).catch(() => {/* non-fatal */})
        appendSystemPanel(t('语言已切换', 'Locale switched'), [`→ ${next}`])
      }
      continue
    }

    // ── /save [title] ─────────────────────────────────────────────────────────
    if (trimmed === '/save' || trimmed.startsWith('/save ')) {
      const title = trimmed.slice('/save'.length).trim()
      const messages = getMessages()
      if (messages.length === 0) {
        appendSystemPanel(t('无内容', 'Nothing to save'), [t('当前对话为空。', 'No messages in current session.')])
      } else {
        if (storedSession) {
          if (title) storedSession = { ...storedSession, title }
          storedSession = { ...storedSession, messages, updatedAt: new Date().toISOString() }
          await sessionStore.save(storedSession)
        } else {
          const newSession = Object.assign(sessionStore.createSession({ title: title || undefined }), { messages })
          await sessionStore.save(newSession)
          storedSession = newSession
        }
        appendSystemPanel(t('会话已保存', 'Session saved'), [
          `ID: ${storedSession!.id.slice(0, 8)}`,
          `Title: ${storedSession!.title}`,
        ])
      }
      continue
    }

    if (trimmed === '/swap') {
      const data = await activeStore.load()
      const mainId = data.defaultMainProfileId
      const brainId = data.specialistProfileId

      if (!mainId || !brainId) {
        appendSystemPanel(t('无法互换', 'Cannot swap'), [
          t('必须同时配置主模型和副模型才能互换。', 'Both main and brain models must be configured to swap.'),
          t('请运行 /bifrost 进行配置。', 'Run /bifrost to set them up.')
        ])
        continue
      }

      data.defaultMainProfileId = brainId
      data.specialistProfileId = mainId
      await activeStore.save(data)
      
      // Update in-memory state
      activeData = data
      const main = activeStore.getProfile(data, data.defaultMainProfileId)
      const brain = activeStore.getProfile(data, data.specialistProfileId)
      
      modelLabel = main?.model ?? '?'
       modelContextLimit = main?.contextLength
       brainLabel = brain?.model
       hud.defaultModel = modelLabel
       hud.lastModel = modelLabel
       hud.contextLimit = modelContextLimit
       hud.brainModel = brainLabel

      appendSystemPanel(t('模型已互换', 'Models swapped'), [
        t('当前主模型 (Execution): ', 'Current Main (Execution): ') + `\x1b[1;32m${main?.label ?? main?.id}\x1b[0m (${main?.model})`,
        t('当前副模型 (Brain): ', 'Current Brain (Raven): ') + `\x1b[1;36m${brain?.label ?? brain?.id}\x1b[0m (${brain?.model})`,
      ])
      continue
    }

    if (trimmed === '/wordup') {
      const messages = getMessages()
      storedSession = await wordupNow({ store: sessionStore, storedSession, messages }) ?? storedSession
      appendSystemPanel(t('WordUP 快照已保存', 'WordUP snapshot saved'), [
        `ID: ${storedSession!.id.slice(0, 8)}`,
        `Title: ${storedSession!.title}`,
        '',
        t('你可以随时输入以下指令恢复此会话：', 'You can restore this session anytime with:'),
        `\x1b[1;36m/resume ${storedSession!.id.slice(0, 8)}\x1b[0m`,
      ])
      continue
    }

    if (trimmed === '/wordupnow') {
      const messages = getMessages()
      storedSession = await wordupNow({ store: sessionStore, storedSession, messages }) ?? storedSession
      appendSystemPanel(t('WordUP 强制快照已保存', 'WordUP forced snapshot saved'), [
        `ID: ${storedSession!.id.slice(0, 8)}`,
        `Title: ${storedSession!.title}`,
        '',
        t('你可以随时输入以下指令恢复此会话：', 'You can restore this session anytime with:'),
        `\x1b[1;36m/resume ${storedSession!.id.slice(0, 8)}\x1b[0m`,
      ])
      continue
    }

    if (trimmed === '/undo') {
      const msgs = getMessages()
      if (msgs.length === 0) {
        appendSystemPanel(t('无法撤回', 'Cannot undo'), [t('当前会话没有历史记录。', 'Conversation is empty.')])
        continue
      }
      // Find last user message index
      let lastUserIdx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') { lastUserIdx = i; break }
      }
      
      if (lastUserIdx === -1) {
        restoreSession([])
      } else {
        restoreSession(msgs.slice(0, lastUserIdx))
      }
      
      rebuildScrollBlocksFromMessages()
      hud.sessionMessageCount = getMessages().length
      appendSystemPanel(t('已撤回', 'Undone'), [t('已删除最后一次用户输入及 AI 的后续回复。', 'Removed last user turn and subsequent AI response.')])
      continue
    }

    if (trimmed === '/retry') {
      const msgs = getMessages()
      if (msgs.length === 0) {
        appendSystemPanel(t('无法重试', 'Cannot retry'), [t('当前会话没有历史记录。', 'Conversation is empty.')])
        continue
      }
      
      let lastUserMsg: string | undefined
      let lastUserIdx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          lastUserMsg = msgs[i].content
          lastUserIdx = i
          break
        }
      }

      if (!lastUserMsg) {
        appendSystemPanel(t('无法重试', 'Cannot retry'), [t('未找到用户输入。', 'No user message found to retry.')])
        continue
      }

      // Rollback to just before that user message
      restoreSession(msgs.slice(0, lastUserIdx))
      rebuildScrollBlocksFromMessages()
      
      // Inject it back as the next line to trigger a new turn
      nextLineOverride = lastUserMsg
      appendSystemPanel(t('正在重试', 'Retrying'), [t('正在重新发送上一次指令...', 'Resending last command...')])
      continue
    }

    if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
      const id = trimmed.slice('/resume'.length).trim()
      if (!id) {
        appendSystemPanel(t('用法', 'Usage'), ['/resume <session_id>'])
      } else {
        const loaded = await sessionStore.load(id)
        if (loaded) {
          storedSession = loaded
          restoreSession(loaded.messages)
          hud.sessionMessageCount = loaded.messages.length
          hud.sessionTotalTokens = 0
          rebuildScrollBlocksFromMessages()
          appendSystemPanel(t('会话已恢复', 'Session resumed'), [
            `ID: ${loaded.id.slice(0, 8)}`,
            `Title: ${loaded.title}`,
          ])
        } else {
          appendSystemPanel(t('未找到会话', 'Session not found'), [t(`找不到 ID 为 "${id}" 的会话。`, `Could not find session with ID "${id}".`)])
        }
      }
      continue
    }

    // ── /cd <path> — change workspace root at runtime ─────────────────────────
    if (trimmed === '/cd' || trimmed.startsWith('/cd ')) {
      const arg = trimmed.slice('/cd'.length).trim()
      if (!arg) {
        appendSystemPanel(
          t('当前工作区', 'Current workspace'),
          [
            workspaceRoot,
            '',
            t('用法: /cd <绝对或相对路径>',           'Usage: /cd <absolute or relative path>'),
            t('说明: 切换工具读写的根目录，会话历史仍留在启动目录。', 'Note: changes the tool sandbox root. Session history stays in the launch dir.'),
          ],
        )
        continue
      }
      // Expand ~ and resolve against current workspaceRoot.
      const expanded = arg.startsWith('~')
        ? path.join(HOME_DIR, arg.slice(1).replace(/^[/\\]+/, ''))
        : arg
      const candidate = path.resolve(workspaceRoot, expanded)
      try {
        const st = await stat(candidate)
        if (!st.isDirectory()) {
          appendSystemPanel(t('路径不是目录', 'Not a directory'), [candidate])
          continue
        }
      } catch {
        appendSystemPanel(t('路径不存在', 'Path does not exist'), [candidate])
        continue
      }
      if (!(await trustAndSwitchWorkspace({
        workspacePath: candidate,
        requestedPath: candidate,
        sourceLabel: '/cd',
      }))) {
        continue
      }
      continue
    }

    // ── /permission [mode] ────────────────────────────────────────────────────
    if (trimmed === '/permission' || trimmed.startsWith('/permission ')) {
      const arg = trimmed.slice('/permission'.length).trim().toUpperCase()
      const modes = ['PRODUCER', 'GHOSTWRITER', 'WRITER'] as const
      type PermMode = typeof modes[number]
      const descriptions: Record<PermMode, [string, string]> = {
        'PRODUCER':    ['全权限，给你的 Agent 完全自由', 'Full access — give your agent complete freedom'],
        'GHOSTWRITER': ['敏感/执行操作前询问授权', 'Ask before sensitive or execution actions'],
        'WRITER':      ['可读敏感配置，写入或执行前谨慎询问', 'Read sensitive data; ask before writing or executing'],
      }
      const normalizeMode = (mode: string): PermMode | null => {
        if ((modes as readonly string[]).includes(mode)) return mode as PermMode
        if (mode === 'ACCEPT-ALL') return 'PRODUCER'
        if (mode === 'PROMPT') return 'GHOSTWRITER'
        if (mode === 'ACCEPT-EDITS' || mode === 'READ-ONLY') return 'WRITER'
        return null
      }
      if (arg && (modes as readonly string[]).includes(arg)) {
        permissionMode = arg as PermMode
        hud.permissionMode = permissionMode
        appendSystemPanel(t('权限模式已更新', 'Permission mode updated'), [`→ ${permissionMode}`])
      } else if (arg) {
        const normalized = normalizeMode(arg)
        if (normalized) {
          permissionMode = normalized
          hud.permissionMode = permissionMode
          appendSystemPanel(t('权限模式已更新', 'Permission mode updated'), [`→ ${permissionMode}`])
        } else {
          appendSystemPanel(t('无效模式', 'Invalid mode'), [`"${arg}" 不是有效模式。可用: ${modes.join(', ')}`])
        }
      } else {
        const currentMode = normalizeMode(permissionMode) ?? 'PRODUCER'
        const initialIndex = Math.max(0, (modes as readonly string[]).indexOf(currentMode))
        const picked = await prompt.pickOption<PermMode>({
          title: t(`选择权限模式  (当前: ${currentMode})`,
                   `Select permission mode  (current: ${currentMode})`),
          initialIndex,
          hint: t('↑ ↓ 选择   Enter 确认   Esc 取消',
                  '↑ ↓ select   Enter confirm   Esc cancel'),
          choices: modes.map(m => ({
            label:       m === currentMode ? `${m}  ✓` : m,
            value:       m,
            description: t(descriptions[m][0], descriptions[m][1]),
          })),
        })
        if (picked) {
          permissionMode = picked
          hud.permissionMode = permissionMode
          appendSystemPanel(t('权限模式已更新', 'Permission mode updated'), [`→ ${permissionMode}`])
        }
      }
      continue
    }

    // ── /docs — pick docs search engine (bing/google) ─────────────────────────
    if (trimmed === '/docs' || trimmed.startsWith('/docs ')) {
      const arg = trimmed.slice('/docs'.length).trim().toLowerCase()
      const engines: DocsSearchEngine[] = ['bing', 'google']
      const descriptions: Record<DocsSearchEngine, [string, string]> = {
        'bing':   ['免 API key，默认可用', 'No API key required, works by default'],
        'google': ['需配置 GOOGLE_CSE_ID + GOOGLE_API_KEY 环境变量', 'Needs GOOGLE_CSE_ID + GOOGLE_API_KEY env vars'],
      }
      const cur = await opts.settingsStore.load()
      if (arg && (engines as readonly string[]).includes(arg)) {
        await opts.settingsStore.setDocsSearchEngine(arg as DocsSearchEngine)
        appendSystemPanel(t('文档搜索引擎已更新', 'Docs search engine updated'), [`→ ${arg}`])
      } else if (arg) {
        appendSystemPanel(t('无效引擎', 'Invalid engine'), [`"${arg}" — ${t('可用', 'available')}: ${engines.join(', ')}`])
      } else {
        const initialIndex = Math.max(0, engines.indexOf(cur.docsSearchEngine))
        try {
          const picked = await prompt.pickOption<DocsSearchEngine>({
              title: t('选择文档搜索引擎  (当前: ' + cur.docsSearchEngine + ')',
                       'Select docs search engine  (current: ' + cur.docsSearchEngine + ')'),
              initialIndex,
              hint: t('↑ ↓ 选择   Enter 确认   Esc 取消',
                      '↑ ↓ select   Enter confirm   Esc cancel'),
              choices: engines.map(e => ({
                label:       e === cur.docsSearchEngine ? `${e}  ✓` : e,
                value:       e,
                description: t(descriptions[e][0], descriptions[e][1]),
              })),
            })
          if (picked) {
            await opts.settingsStore.setDocsSearchEngine(picked)
            appendSystemPanel(t('文档搜索引擎已更新', 'Docs search engine updated'), [`→ ${picked}`])
          }
        } finally {
          prompt.forceRedraw()
        }
      }
      continue
    }

    // ── /bifrost — dual-model setup ───────────────────────────────────────────
    if (trimmed === '/bifrost audit') {
      appendSystemPanel(t('Bifrost context 审计', 'Bifrost context audit'), getBifrostContextAuditReport())
      prompt.forceRedraw()
      continue
    }

    if (trimmed === '/bifrost') {
      try {
        prompt.clearBuffer()
        // Mirror the rest of the codebase: read+write to BOTH the local cwd
        // store and the global ~/.artemis store so /bifrost stays in sync with
        // whatever onboarding wrote globally. If local is empty for both
        // slots, treat global as the source of truth and copy down.
        const bfStore = new ProviderStore(cwd)
        const bfGlobalStore = new ProviderStore(HOME_DIR)
        let bfData = await bfStore.load()
        let bfGlobalData = await bfGlobalStore.load()
        const localHasAny = Boolean(
          bfStore.getDefaultMainProfile(bfData) ||
          bfStore.getProfile(bfData, bfData.specialistProfileId)
        )
        if (!localHasAny) {
          bfData = JSON.parse(JSON.stringify(bfGlobalData)) as typeof bfGlobalData
        }
        const curMain = bfStore.getDefaultMainProfile(bfData)
        const curBrain = bfStore.getProfile(bfData, bfData.specialistProfileId)

        const fmtProfile = (p: typeof curMain): string =>
          p ? `${p.label ?? p.id}  (${p.model})` : t('未配置', 'not configured')

        appendSystemPanel(t('Bifrost 双模型 — 当前状态', 'Bifrost dual-model — status'), [
          `🛠  ${t('执行', 'exec')}:   ${fmtProfile(curMain)}`,
          `🧠 ${t('思考', 'brain')}:  ${fmtProfile(curBrain)}`,
          '',
          curMain && curBrain
            ? t('已就绪 · 执行模型跑刀，思考模型主谋划',
                'Ready · Exec executes, Brain plans')
            : t('未就绪 · 即将引导补全缺失项',
                'Incomplete · wizard will fill missing slot(s)'),
        ])
        prompt.forceRedraw()

        type BifrostAction = 'fill' | 'swap' | 'reconfig-brain' | 'reconfig-main' | 'view' | 'cancel' | 'toggle'
        let action: BifrostAction

        if (curMain && curBrain) {
          const picked = await prompt.pickOption<BifrostAction>({
              title: t('选择 Bifrost 操作', 'Choose Bifrost action'),
              hint: t('↑ ↓ 选择   Enter 确认   Esc 取消',
                      '↑ ↓ select   Enter confirm   Esc cancel'),
              choices: [
                { value: 'toggle',
                  label: t('🔄 开关双模型', '🔄 Toggle dual-model'),
                  description: t('快速开启或关闭双模型功能', 'Quickly enable or disable dual-model') },
                { value: 'swap',
                  label: t('🔁 互换角色',
                            '🔁 Swap roles'),
                  description: t('保持两个模型不变，只交换它们的角色',
                                  'Keep both models, just swap their roles') },
                { value: 'reconfig-brain',
                  label: t('🧠 重新配置思考模型',
                            '🧠 Reconfigure brain model'),
                  description: t('替换思考模型 / 改 baseUrl / 改 key',
                                  'Replace brain model / baseUrl / key') },
                { value: 'reconfig-main',
                  label: t('🛠 重新配置执行模型',
                            '🛠 Reconfigure exec model'),
                  description: t('替换执行模型 / 改 baseUrl / 改 key',
                                  'Replace exec model / baseUrl / key') },
                { value: 'view',
                  label: t('👁 仅查看 — 不做修改',
                            '👁 View only — no changes') },
                { value: 'cancel',
                  label: t('✕ 取消', '✕ Cancel') },
              ],
            })
          action = picked ?? 'cancel'
          prompt.forceRedraw()
        } else {
          action = 'fill'
        }

        const saveBoth = async (next: typeof bfData): Promise<void> => {
          await bfStore.save(next)
          await bfGlobalStore.save(next)
        }

        if (action === 'toggle' && curMain && curBrain) {
          // 检查当前是否启用了双模型
          const isDualModelEnabled = Boolean(bfData.specialistProfileId)
          
          if (isDualModelEnabled) {
            // 关闭双模型，保留主模型，但记住思考模型的配置
            // 注意：我们不删除思考模型的配置，只是停止使用它
            bfData.specialistProfileId = undefined
            await saveBoth(bfData)
            brainLabel = undefined
            hud.brainModel = brainLabel
            rebuildScrollBlocksFromMessages()
            appendSystemPanel(t('Bifrost — 已关闭双模型', 'Bifrost — dual-model disabled'), [
              t('现在使用单模型模式', 'Single model mode now active'),
              t(`当前模型: ${curMain.label ?? curMain.id} (${curMain.model})`, 
                `Current model: ${curMain.label ?? curMain.id} (${curMain.model})`),
              t('思考模型配置已保留，再次开启时无需重新设置', 
                'Brain model configuration is preserved, no need to reconfigure when reopening'),
            ])
          } else {
            // 开启双模型，恢复之前的配置
            // 我们需要检查是否有之前配置过的思考模型
            // 如果没有，说明是第一次开启，需要引导配置
            // 首先检查是否有已保存的思考模型配置
            let targetBrainProfileId: string | undefined = undefined
            
            // 检查是否有专门的思考模型配置
            // 首先尝试使用之前使用过的思考模型（如果有的话）
            // 或者检查是否有其他可用的模型作为思考模型
            
            // 尝试从存储中查找是否有之前使用过的思考模型ID
            // 或者如果只有一个模型，可能需要引导用户添加第二个
            if (curBrain) {
              // 如果 curBrain 已经存在，直接使用
              targetBrainProfileId = curBrain.id
            } else {
              // 如果没有思考模型配置，检查是否有其他可用模型
              const otherProfiles = bfData.profiles.filter(p => p.id !== curMain?.id)
              if (otherProfiles.length > 0) {
                targetBrainProfileId = otherProfiles[0].id
              }
            }
            
            if (targetBrainProfileId) {
              // 有可用的思考模型配置，直接开启双模型
              bfData.specialistProfileId = targetBrainProfileId
              await saveBoth(bfData)
              const selectedBrain = bfStore.getProfile(bfData, targetBrainProfileId)
              brainLabel = selectedBrain?.model
              hud.brainModel = brainLabel
              rebuildScrollBlocksFromMessages()
              appendSystemPanel(t('Bifrost — 已开启双模型', 'Bifrost — dual-model enabled'), [
                t('现在使用双模型模式', 'Dual model mode now active'),
                `🛠  ${t('执行', 'exec')}: ${curMain.label ?? curMain.id} (${curMain.model})`,
                `🧠 ${t('思考', 'brain')}: ${selectedBrain?.label ?? selectedBrain?.id} (${selectedBrain?.model})`,
              ])
            } else {
              // 没有可用的思考模型配置，需要引导用户配置
              appendSystemPanel(t('Bifrost — 需要配置思考模型', 'Bifrost — Brain model needed'), [
                t('需要至少两个模型配置才能使用双模型功能', 
                  'At least two model profiles are needed for dual-model functionality'),
                t('即将引导您配置思考模型', 'Wizard will guide you to configure the brain model'),
              ])
              prompt.forceRedraw()
              
              // 等待用户确认后继续
              await new Promise(resolve => setTimeout(resolve, 1500))
              
              // 继续执行原有的填充逻辑
              action = 'fill'
            }
          }
          prompt.forceRedraw()
          continue
        }

        if (action === 'cancel' || action === 'view') {
          appendSystemPanel(t('Bifrost', 'Bifrost'),
            [action === 'cancel'
              ? t('已取消 — 未做改动', 'Cancelled — no changes')
              : t('查看完毕 — 未做改动', 'Viewed — no changes')])
          continue
        }


        if (action === 'swap' && curMain && curBrain) {
          bfData.defaultMainProfileId = curBrain.id
          bfData.specialistProfileId = curMain.id
          await saveBoth(bfData)
          modelLabel = curBrain.model
          modelContextLimit = curBrain.contextLength
          brainLabel = curMain.model
          hud.defaultModel = modelLabel
          hud.lastModel = modelLabel
          hud.contextLimit = modelContextLimit
          hud.brainModel = brainLabel
          rebuildScrollBlocksFromMessages()
          appendSystemPanel(t('Bifrost — 主/副模型互换完成', 'Bifrost — Main/Secondary model swap complete'), [
            t('已成功互换执行模型和思考模型的角色', 'Successfully swapped the roles of the exec and brain models'),
            '',
            t('互换前:', 'Before swap:'),
            `  🛠  ${t('执行', 'exec')}: ${curMain.label ?? curMain.id} (${curMain.model})`,
            `  🧠 ${t('思考', 'brain')}: ${curBrain.label ?? curBrain.id} (${curBrain.model})`,
            '',
            t('互换后:', 'After swap:'),
            `  🛠  ${t('执行', 'exec')}: ${curBrain.label ?? curBrain.id} (${curBrain.model})`,
            `  🧠 ${t('思考', 'brain')}: ${curMain.label ?? curMain.id} (${curMain.model})`,
            '',
            t('现在双模型功能继续运行，但角色已互换', 'Dual model functionality continues, but roles have been swapped'),
          ])
          prompt.forceRedraw()
          continue
        }

        // reconfig: drop the existing slot so ensureDoubleModelSetup re-prompts
        if (action === 'reconfig-brain' && curBrain) {
          bfData.profiles = bfData.profiles.filter(p => p.id !== curBrain.id)
          if (bfData.specialistProfileId === curBrain.id) {
            bfData.specialistProfileId = undefined
          }
          await saveBoth(bfData)
          appendSystemPanel(t('即将配置思考模型', 'About to configure brain model'),
            [t('思考模型是负责规划 / 研究 / 评审的"思考"模型。按 Esc 可随时取消。',
               'Brain model handles planning/research/review. Esc cancels at any point.')])
        } else if (action === 'reconfig-main' && curMain) {
          bfData.profiles = bfData.profiles.filter(p => p.id !== curMain.id)
          if (bfData.defaultMainProfileId === curMain.id) {
            bfData.defaultMainProfileId = undefined
          }
          await saveBoth(bfData)
          appendSystemPanel(t('即将配置执行模型', 'About to configure exec model'),
            [t('执行模型是负责执行工具调用与代码改动的主模型。按 Esc 可随时取消。',
               'Exec model runs tools and edits code. Esc cancels at any point.')])
        } else if (action === 'fill') {
          const lines = !curMain && !curBrain
            ? [t('需要分别配置执行模型和思考模型。按 Esc 可随时取消。',
                  'Need to configure both exec and brain models. Esc cancels at any point.')]
            : !curMain
              ? [t('已有思考模型，缺少执行模型 — 即将引导你配置执行模型。',
                    'Brain configured, exec missing — about to set up exec model.')]
              : [t('已有执行模型，缺少思考模型 — 即将引导你配置思考模型。',
                    'Exec configured, brain missing — about to set up brain model.')]
          appendSystemPanel(t('Bifrost — 即将进入向导', 'Bifrost — entering wizard'), lines)
          // Mirror current in-memory state (which may have been seeded from
          // global) into local so ensureDoubleModelSetup only re-prompts for
          // the slot(s) that are genuinely missing.
          await saveBoth(bfData)
        }
        prompt.forceRedraw()

        const bifrostInfo: string[] = []
        const result = await prompt.releaseTerminal(() => ensureDoubleModelSetup({
          cwd,
          promptIO: createConsolePromptIO(),
          onInfo: msg => { bifrostInfo.push(msg) },
        }))
        prompt.clearBuffer()

        bfData = await bfStore.load()
        // Mirror whatever ensureDoubleModelSetup wrote into the global store
        // too, so subsequent /bifrost runs see consistent state regardless
        // of which cwd the user is in.
        bfGlobalData = await bfGlobalStore.load()
        if (JSON.stringify(bfData) !== JSON.stringify(bfGlobalData)) {
          await bfGlobalStore.save(bfData)
        }
        const newMain = bfStore.getDefaultMainProfile(bfData)
        const newBrain = bfStore.getProfile(bfData, bfData.specialistProfileId)
        if (newMain?.model) {
          modelLabel = newMain.model
          modelContextLimit = newMain.contextLength
          hud.defaultModel = modelLabel
          hud.lastModel = modelLabel
          hud.contextLimit = modelContextLimit
        }
        brainLabel = newBrain?.model
        hud.brainModel = brainLabel
        rebuildScrollBlocksFromMessages()

        const ready = Boolean(newMain && newBrain)
        appendSystemPanel(
          ready ? t('Bifrost 双模型已就绪', 'Bifrost dual-model ready')
                : t('Bifrost 未完成', 'Bifrost incomplete'),
          [
            `🛠  Forge:  ${fmtProfile(newMain)}`,
            `🧠 Raven:  ${fmtProfile(newBrain)}`,
            ...(bifrostInfo.length > 0 ? ['', ...bifrostInfo] : []),
            '',
            result.message,
          ])
        prompt.forceRedraw()

        const bfSettings = await opts.settingsStore.load()
        if (ready && !bfSettings.bundleConfigured) {
          await prompt.releaseTerminal(() => runBundleOnboarding({
            locale,
            settingsStore: opts.settingsStore,
            printPanel: (title, lines) => appendSystemPanel(title, lines),
          }))
          prompt.forceRedraw()
        }
      } catch (err: unknown) {
        appendSystemPanel(t('Bifrost 错误', 'Bifrost error'), [err instanceof Error ? err.message : String(err)])
      }
      continue
    }

    // ── /bundle — Bundle polisher management ──────────────────────────────────
    if (trimmed === '/bundle' || trimmed.startsWith('/bundle ')) {
      const arg = trimmed.slice('/bundle'.length).trim()
      const cur = await opts.settingsStore.load()

      if (arg === 'on' || arg === 'off') {
        await opts.settingsStore.setBundleEnabled(arg === 'on')
        appendSystemPanel(t('Bundle 状态更新', 'Bundle updated'), [`→ ${arg === 'on' ? t('已开启', 'enabled') : t('已关闭', 'disabled')}`])
        continue
      }

      if (arg === 'status' || arg === '') {
        appendSystemPanel(t('Bundle 当前配置', 'Bundle settings'), [
          `${t('开启', 'Enabled')}:      ${cur.bundleEnabled ? 'yes' : 'no'}`,
          `${t('触发模式', 'Mode')}:  ${cur.bundleMode}`,
          `${t('润色模型', 'Polisher')}:  ${cur.bundleModelChoice}`,
          `${t('最小长度', 'Min len')}:  ${cur.bundleMinLength}`,
          '',
          t('用法:', 'Usage:'),
          '  /bundle on|off            ' + t('快速开关', 'quick toggle'),
          '  /bundle config            ' + t('重新选模式/模型', 'reconfigure mode / model'),
          '  /bundle <文本>            ' + t('手动润色并发送', 'polish and send'),
        ])
        continue
      }

      if (arg === 'config' || arg === 'setup') {
        await prompt.releaseTerminal(() => runBundleOnboarding({
          locale,
          settingsStore: opts.settingsStore,
          printPanel: (title, lines) => appendSystemPanel(title, lines),
        }))
        prompt.forceRedraw()
        continue
      }

      // Treat remainder as text to polish and send.
      if (arg.length > 0) {
        const provStore = new ProviderStore(cwd)
        const provData  = await provStore.load()
        const mainCfg   = provStore.getDefaultMainProfile(provData)
        const brainCfg  = provStore.getProfile(provData, provData.specialistProfileId)
        if (!mainCfg && !brainCfg) {
          appendSystemPanel(t('Bundle 无法润色', 'Bundle cannot polish'),
            [t('请先配置 Provider（/config 或 /bifrost）。', 'Configure a provider first (/config or /bifrost).')])
          continue
        }
        const polishWaiter = startWaitingPanel(t('Bundle 润色中...', 'Bundle polishing...'), [
          t('刚才输入的文字正在润色，请稍候…', 'Your last input is being polished. Please wait…'),
          truncatePlainToWidth(arg.replace(/\s+/g, ' '), 120),
        ], { animation: 'cat' })
        try {
          const result = await runBundle({
            text: arg,
            locale,
            mainConfig:  mainCfg,
            brainConfig: brainCfg,
            modelChoice: cur.bundleModelChoice,
          })
          polishWaiter.stop(t('Bundle 润色完成', 'Bundle polish complete'), [
            `${t('模型', 'Model')}: ${result.model}`,
          ])
          const pick = await prompt.releaseTerminal(() => runBundleDialog({
            original: arg,
            enhanced: result.enhanced,
            modelName: result.model,
            locale,
          }))
          prompt.forceRedraw()
          const toSend = pick === 'enhanced' ? result.enhanced : arg
          if (!(await maybeSwitchWorkspaceForRequest(`${arg}\n${toSend}`))) {
            continue
          }
          appendScrollBlock({ kind: 'user', text: toSend, timestamp: timeStampLabel() })
          await handleTurn(
            toSend,
            locale,
            hud,
            workspaceRoot,
            permissionMode,
            {
              appendScrollBlock,
              insertScrollBlock,
              updateScrollBlock,
              removeScrollBlock,
              requestPermission: askToolPermission,
            },
            handleWorkspaceSwitchRequest,
          )
          hud.sessionMessageCount = getMessages().length
          prompt.forceRedraw()
        } catch (err) {
          polishWaiter.stop(t('Bundle 错误', 'Bundle error'), [err instanceof Error ? err.message : String(err)])
        }
        continue
      }
      continue
    }

    // ── /odin [sub] — skill store ──────────────────────────────────────────────
    if (trimmed === '/odin' || trimmed.startsWith('/odin ')) {
      const sub = trimmed.slice('/odin'.length).trim().toLowerCase()
      const odinStore = new OdinStore(cwd)
      if (!sub || sub === 'list' || sub === 'ls') {
        const skills = await odinStore.list({ status: 'active' })
        if (skills.length === 0) {
          appendSystemPanel(t('Odin 技能库', 'Odin skill store'), [t('暂无技能。AI 使用 5+ 个工具后会自动捕获技能。', 'No skills yet. Skills are auto-captured after 5+ tool calls in a turn.')])
        } else {
          const rows = skills.slice(0, 20).map(s => `[${String(s.confidence).padStart(2)}/10]  ${s.name.slice(0, 50)}`)
          appendSystemPanel(t(`Odin 技能库 (${skills.length})`, `Odin skills (${skills.length})`), rows)
        }
      } else if (sub === 'help') {
        appendSystemPanel('Odin', [
          '  /odin              ' + t('列出所有技能', 'List all skills'),
          '  /odin help         ' + t('显示帮助', 'Show help'),
          '  artemis odin list  ' + t('完整技能列表（终端）', 'Full list (terminal)'),
        ])
      } else {
        appendSystemPanel(t('Odin — 未知子命令', 'Odin — unknown subcommand'), [`"${sub}" — ` + t('运行 /odin help 查看用法', 'Run /odin help for usage')])
      }
      continue
    }

    // ── /heimdall [sub] — thread monitor ──────────────────────────────────────
    if (trimmed === '/heimdall' || trimmed.startsWith('/heimdall ')) {
      const args = trimmed.slice('/heimdall'.length).trim()
      if (args && !(await maybeSwitchWorkspaceForRequest(args))) {
        continue
      }
      const body = parseHeimdallCommandBody(args)
      try {
        if (body.action === 'threads') {
          appendSystemText(stripAnsi(await buildHeimdallThreadsReport({ cwd, locale })))
        } else {
          const sessions = await sessionStore.list().catch(() => [] as Awaited<ReturnType<SessionStore['list']>>)
          const session = sessions[0] ?? null
          if (!session) {
            appendSystemPanel(t('Heimdall', 'Heimdall'), [
              t(
                '暂无可查看的线程。先发起任务，再回到 /heimdall 观察或处理阻塞。',
                'No active thread yet. Start a task first, then return to /heimdall to observe or resolve blocking.',
              ),
            ])
          } else {
            appendSystemText(stripAnsi(await buildHeimdallReport({ cwd, session, sessionStore, locale, action: body.action, limit: body.limit, afterOffset: body.afterOffset, timeoutSeconds: body.timeoutSeconds, replyText: body.replyText })))
          }
        }
      } catch (err: unknown) {
        appendSystemPanel(t('Heimdall 错误', 'Heimdall error'), [err instanceof Error ? err.message : String(err)])
      }
      continue
    }

    // ── /dream — manually trigger or inspect the dream system ─────────────────
    if (trimmed === '/dream' || trimmed.startsWith('/dream ')) {
      const arg = trimmed.slice('/dream'.length).trim()
      const dreamModule = await import('../services/dreamComposer.js')
      const dreamStore = await import('../services/dreamStore.js')

      if (!arg || arg === 'now') {
        appendSystemPanel(t('梦境', 'Dream'), [t('开始编织梦境…', 'Composing a dream…')])
        const result = await dreamModule.composeDream({ cwd: workspaceRoot, trigger: 'manual' })
        if (result.ok && result.entry) {
          appendSystemPanel(t('梦境已生成', 'Dream composed'), [
            `${result.entry.preview}`,
            '',
            `${t('文件', 'File')}: ${result.entry.mdPath}`,
            ...(result.entry.imagePath ? [`${t('配图', 'Image')}: ${result.entry.imagePath}`] : []),
            ...(typeof result.bridgesPushed === 'number' && result.bridgesPushed > 0
              ? [t(`已推送到 ${result.bridgesPushed} 个聊天桥接。`, `Pushed to ${result.bridgesPushed} bridge chat(s).`)]
              : []),
          ])
        } else {
          appendSystemPanel(t('梦境跳过', 'Dream skipped'), [result.reason ?? t('未知原因', 'unknown')])
        }
        continue
      }

      if (arg === 'list') {
        const list = await dreamStore.loadDreamIndex()
        if (list.length === 0) {
          appendSystemPanel(t('梦境记录', 'Dream archive'), [t('还没有任何梦境。', 'No dreams yet.')])
        } else {
          appendSystemPanel(t('梦境记录', 'Dream archive'), list.slice(0, 20).map(e =>
            `${e.id}  ${e.preview}`,
          ))
        }
        continue
      }

      if (arg === 'status') {
        // No AI calls — pure local introspection. Tells the user instantly:
        // is the dream system on, what mode, when did it last fire, when can
        // it fire again, what's accumulated. Replaces the previous ~38s
        // session-digging that would happen when the user asked the AI.
        const cfg = await dreamStore.loadDreamConfig()
        const idleWatcher = await import('../services/idleWatcher.js')
        const lastActivityAt = idleWatcher.getLastActivityAt()
        const isComposing = idleWatcher.isComposing()
        const idleSec = Math.max(0, Math.floor((Date.now() - lastActivityAt) / 1000))
        const remainingSec = Math.max(0, cfg.idleThresholdSec - idleSec)
        const list = await dreamStore.loadDreamIndex()
        const cutoff = Date.now() - 24 * 60 * 60 * 1000
        const todayCount = list.filter(e => Date.parse(e.createdAt) >= cutoff).length
        const learned = await dreamStore.loadLearnedPrompt()
        const learnedBytes = Buffer.byteLength(learned, 'utf8')
        const fmtDur = (sec: number): string => {
          if (sec < 60) return `${sec}s`
          if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60 > 0 ? ` ${sec % 60}s` : ''}`
          return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60) > 0 ? ` ${Math.floor((sec % 3600) / 60)}m` : ''}`
        }
        const lines = [
          `${t('启用', 'Enabled')}: ${cfg.enabled ? t('是', 'yes') : t('否', 'no')}`,
          `${t('模式', 'Mode')}: ${cfg.mode}${cfg.mode === 'vision' ? t(' (文字 + 配图)', ' (text + image)') : ''}`,
          `${t('风格演化', 'Evolve prompt')}: ${cfg.evolveSystemPrompt ? t('开启', 'on') : t('关闭', 'off')}  ·  ${t('桥接推送', 'Bridge push')}: ${cfg.pushToBridges ? t('开启', 'on') : t('关闭', 'off')}`,
          `${t('空闲阈值', 'Idle threshold')}: ${fmtDur(cfg.idleThresholdSec)}  ·  ${t('每日上限', 'Daily cap')}: ${cfg.maxDreamsPerDay}  ·  ${t('夜间窗口', 'Night window')}: ${cfg.nightWindow.startHour}:00–${cfg.nightWindow.endHour}:00`,
          '',
          isComposing
            ? t('🌙 当前正在编织梦境…', '🌙 Currently composing a dream…')
            : remainingSec > 0
              ? t(`下次触发：还需空闲 ${fmtDur(remainingSec)}（已空闲 ${fmtDur(idleSec)}）`, `Next trigger: needs ${fmtDur(remainingSec)} more idle (currently ${fmtDur(idleSec)})`)
              : t(`已达触发条件，等待下一个 60s 检查窗口（已空闲 ${fmtDur(idleSec)}）`, `Trigger threshold reached, waiting for next 60s check (idle ${fmtDur(idleSec)})`),
          `${t('今日已做', 'Today')}: ${todayCount} / ${cfg.maxDreamsPerDay}`,
          `${t('累计学习', 'Learned style')}: ${learned ? `${learnedBytes} bytes` : t('无', 'none')}`,
          '',
          t('最近梦境（最多 5 条）', 'Recent dreams (up to 5)'),
          ...(list.length > 0
            ? list.slice(0, 5).map(e => `  ${e.id}  ${e.imagePath ? '🖼' : '📝'}  ${e.preview}`)
            : [`  ${t('（还没有任何梦境）', '(no dreams yet)')}`]),
        ]
        appendSystemPanel(t('🌙 Dream System Status', '🌙 Dream System Status'), lines)
        continue
      }

      if (arg.startsWith('open ')) {
        const id = arg.slice(5).trim()
        const body = await dreamStore.readDreamBody(id)
        appendSystemPanel(`Dream ${id}`, body ? body.split('\n') : [t('找不到这个梦境。', 'Dream not found.')])
        continue
      }

      if (arg.startsWith('forget ')) {
        const id = arg.slice(7).trim()
        const removed = await dreamStore.removeDreamEntry(id)
        appendSystemPanel(t('梦境', 'Dream'), [removed ? t(`已删除 ${id}`, `Removed ${id}`) : t('找不到', 'not found')])
        continue
      }

      if (arg === 'forget-all') {
        await dreamStore.clearLearnedPrompt()
        appendSystemPanel(t('梦境学习', 'Dream learning'), [t('已清空 learned-prompt.md。', 'Cleared learned-prompt.md.')])
        continue
      }

      appendSystemPanel(t('用法', 'Usage'), [
        '/dream status           ' + t('一键查看梦境系统当前状态（推荐）', 'One-shot dream system status (recommended)'),
        '/dream                  ' + t('立即编织一个梦境', 'Compose a dream now'),
        '/dream list             ' + t('列出最近的梦境', 'List recent dreams'),
        '/dream open <id>        ' + t('打开指定梦境', 'Open a dream'),
        '/dream forget <id>      ' + t('删除单条', 'Remove one'),
        '/dream forget-all       ' + t('清空累积的学习风格', 'Clear accumulated learned style'),
      ])
      continue
    }

    // ── /team — auto-router that picks the right workflow ─────────────────────
    // Manual entry points (/niko /design /athena /nidhogg) stay available for
    // users who already know which workflow they want; /team is for "I don't
    // know, you decide" — a brief LLM call picks among direct/brainstorm/
    // design/athena/nidhogg and we dispatch accordingly.
    if (trimmed === '/team' || trimmed.startsWith('/team ')) {
      const teamPrompt = trimmed.slice('/team'.length).trim()
      if (!teamPrompt) {
        appendSystemPanel(
          t('用法', 'Usage'),
          [`/team <${t('你的任务描述', 'your task description')}>`],
        )
        continue
      }

      if (!(await maybeSwitchWorkspaceForRequest(teamPrompt))) {
        continue
      }

      await historyStore.record(trimmed).catch(() => {/* non-fatal */})
      appendScrollBlock({ kind: 'user', text: trimmed, timestamp: timeStampLabel() })

      if (!(await ensureExecutionProviderForWorkflow(workspaceRoot))) {
        continue
      }

      // Phase 1: routing decision — render an animated scrollblock that ticks
      // a Braille spinner + elapsed seconds while we wait for the LLM. When
      // the call returns, we replace the block in-place with the verdict so
      // the user sees one panel that morphs from "thinking" → "decided".
      const routerStartedMs = Date.now()
      const routerFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'] as const
      const renderRouterWaiting = (): string => {
        const elapsedSec = Math.floor((Date.now() - routerStartedMs) / 1000)
        const frame = routerFrames[Math.floor(Date.now() / 100) % routerFrames.length]!
        return [
          `${t('Team 路由', 'Team router')}`,
          `  ${frame} ${t('正在判断该走哪条工作流…', 'Deciding which workflow fits…')}  (${elapsedSec}s)`,
          `  ${t('AI 正在分析任务意图，最长等待 45s。', 'AI is analyzing task intent — up to 45s.')}`,
        ].join('\n')
      }
      const routerBlockIndex = appendScrollBlock({
        kind: 'system',
        text: renderRouterWaiting(),
      })
      const routerTick = setInterval(() => {
        updateScrollBlock(routerBlockIndex, {
          kind: 'system',
          text: renderRouterWaiting(),
        })
      }, 100)

      let route: Awaited<ReturnType<typeof routeTeamRequest>>
      try {
        const provConfig = await resolveMainProviderConfig({ cwd: workspaceRoot, config: {} })
        const trackedProfileId =
          typeof (provConfig as unknown as { id?: unknown }).id === 'string'
            ? (provConfig as unknown as { id: string }).id
            : undefined
        const trackedProfileLabel =
          typeof (provConfig as unknown as { label?: unknown }).label === 'string'
            ? (provConfig as unknown as { label: string }).label
            : trackedProfileId
        const provider = createTrackedProviderFromConfig(provConfig, {
          cwd: workspaceRoot,
          profileId: trackedProfileId,
          profileLabel: trackedProfileLabel,
        })
        route = await routeTeamRequest(teamPrompt, provider)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        route = {
          choice: 'niko',
          reason: `router exception: ${msg}`,
        }
      } finally {
        clearInterval(routerTick)
      }

      const choiceLabel = describeChoice(route.choice, locale)
      const routerElapsedSec = Math.floor((Date.now() - routerStartedMs) / 1000)
      updateScrollBlock(routerBlockIndex, {
        kind: 'system',
        text: [
          `${t('Team 路由决策', 'Team router decision')}  (${routerElapsedSec}s)`,
          `  ${t('选择', 'Choice')}: ${choiceLabel}`,
          `  ${t('理由', 'Reason')}: ${route.reason}`,
          `  ${
            route.choice === 'direct'
              ? t('→ 直接走默认对话处理。', '→ Dispatching to the default chat agent.')
              : t(
                  `→ 启动 /${route.choice === 'niko' ? 'niko' : route.choice} 工作流。`,
                  `→ Launching /${route.choice === 'niko' ? 'niko' : route.choice} workflow.`,
                )
          }`,
        ].join('\n'),
      })

      // Phase 2: dispatch
      if (route.choice === 'direct') {
        // Re-inject as a normal user message: rewrite trimmed and fall through
        // to the AI turn block below.
        trimmed = teamPrompt
      } else {
        const effectiveTeamPrompt = await maybeApplyVisualGenerationPolicy(teamPrompt)
        if (route.choice === 'nidhogg') {
          activeDetachedCapture = await launchDetachedWorkflow('nidhogg', effectiveTeamPrompt)
          continue
        }
        const runningMessages = createRunningMessageCapture()
        const nextLineFromWorkflow = await waitForRunnerOrInterrupt(
          runHintedWorkflowTurn(
            route.choice,
            effectiveTeamPrompt,
            workspaceRoot,
            permissionMode,
            locale,
            hud,
            {
              appendScrollBlock,
              insertScrollBlock,
              updateScrollBlock,
              removeScrollBlock,
              requestPermission: askToolPermission,
            },
            handleWorkspaceSwitchRequest,
            runningMessages.hooks,
          ),
          runningMessages.capture,
        )
        hud.sessionMessageCount = getMessages().length
        prompt.forceRedraw()
        nextLineOverride = nextLineFromWorkflow
        continue
      }
    }

    // ── workflow slash commands (/niko /athena /nidhogg /design /contest /run) ─
    const WORKFLOW_COMMANDS: Record<string, WorkflowMode | 'run'> = {
      '/niko':    'niko',
      '/athena':  'athena',
      '/nidhogg': 'nidhogg',
      '/design':  'design',
      '/contest': 'contest',
      '/run':     'run',
    }
    const workflowMatch: [string, WorkflowMode | 'run'] | undefined = Object.entries(WORKFLOW_COMMANDS).find(([cmd]) =>
      trimmed === cmd || trimmed.startsWith(cmd + ' ')
    ) as [string, WorkflowMode | 'run'] | undefined
    if (workflowMatch) {
      const [cmd, mode]: [string, WorkflowMode | 'run'] = workflowMatch
      const workflowPrompt = trimmed.slice(cmd.length).trim()
      if (!workflowPrompt) {
        appendSystemPanel(
          t('用法', 'Usage'),
          [`${cmd} <${t('你的任务描述', 'your task description')}>`],
        )
        continue
      }

      if (!(await maybeSwitchWorkspaceForRequest(workflowPrompt))) {
        continue
      }

      await historyStore.record(trimmed).catch(() => {/* non-fatal */})

      appendScrollBlock({ kind: 'user', text: trimmed, timestamp: timeStampLabel() })
      const effectiveWorkflowPrompt = await maybeApplyVisualGenerationPolicy(workflowPrompt)

      if (mode === 'nidhogg') {
        // Background detached workflow
        activeDetachedCapture = await launchDetachedWorkflow('nidhogg', effectiveWorkflowPrompt)
      } else if (mode === 'run') {
        // Background detached workflow
        activeDetachedCapture = await launchDetachedWorkflow('run', effectiveWorkflowPrompt)
      } else {
        // Inline workflow — Claude Code style: inject domain hint into brain's
        // system prompt suffix, then run the same handleTurn loop as free-form
        // chat. The brain's 24-round tool loop handles execution flexibly,
        // no rigid pipeline. mode is narrowed to WorkflowMode in this branch.
        const wfMode: WorkflowMode = mode as WorkflowMode
        appendSystemPanel(
          t(`${cmd} 模式已激活`, `${cmd} mode active`),
          [t(
            `Brain 已注入 /${wfMode} 风格提示，进入主对话循环执行任务。`,
            `Brain injected with /${wfMode} style hint, entering main conversation loop.`,
          )],
        )
        const runningMessages = createRunningMessageCapture()
        const nextLineFromWorkflow = await waitForRunnerOrInterrupt(
          runHintedWorkflowTurn(
            wfMode,
            effectiveWorkflowPrompt,
            workspaceRoot,
            permissionMode,
            locale,
            hud,
            {
              appendScrollBlock,
              insertScrollBlock,
              updateScrollBlock,
              removeScrollBlock,
              requestPermission: askToolPermission,
            },
            handleWorkspaceSwitchRequest,
            runningMessages.hooks,
          ),
          runningMessages.capture,
        )
        hud.sessionMessageCount = getMessages().length
        prompt.forceRedraw()
        nextLineOverride = nextLineFromWorkflow
      }
      continue
    }

    // ── AI turn ───────────────────────────────────────────────────────────────
    if (!(await maybeSwitchWorkspaceForRequest(trimmed))) {
      continue
    }

    await historyStore.record(trimmed).catch(() => {/* non-fatal */})

    // ── Bundle auto-polish (pre-send, transparent) ───────────────────────────
    let dispatchText = trimmed
    const bundleCur = await opts.settingsStore.load()
    if (shouldAutoBundle(trimmed, {
      enabled:   bundleCur.bundleEnabled,
      mode:      bundleCur.bundleMode,
      minLength: bundleCur.bundleMinLength,
    })) {
      let bundleWaiter: ReturnType<typeof startWaitingPanel> | undefined
      try {
        const provStore = new ProviderStore(cwd)
        const provData  = await provStore.load()
        const mainCfg   = provStore.getDefaultMainProfile(provData)
        const brainCfg  = provStore.getProfile(provData, provData.specialistProfileId)
        if (mainCfg || brainCfg) {
          bundleWaiter = startWaitingPanel(t('Bundle 润色中...', 'Bundle polishing...'), [
            t('刚才输入的文字正在润色，请稍候…', 'Your last input is being polished. Please wait…'),
            truncatePlainToWidth(trimmed.replace(/\s+/g, ' '), 120),
          ], { animation: 'cat' })
          const bundleResult = await runBundle({
            text: trimmed,
            locale,
            mainConfig:  mainCfg,
            brainConfig: brainCfg,
            modelChoice: bundleCur.bundleModelChoice,
          })
          bundleWaiter.stop(t('Bundle 润色完成', 'Bundle polish complete'), [
            `${t('模型', 'Model')}: ${bundleResult.model}`,
          ])
          bundleWaiter = undefined
          const pick = await prompt.releaseTerminal(() => runBundleDialog({
            original: trimmed,
            enhanced: bundleResult.enhanced,
            modelName: bundleResult.model,
            locale,
          }))
          prompt.forceRedraw()
          if (pick === 'enhanced') dispatchText = bundleResult.enhanced
        }
      } catch (err) {
        bundleWaiter?.stop(t('Bundle 润色失败', 'Bundle polish failed'), [
          err instanceof Error ? err.message : String(err),
        ])
        appendSystemPanel(t('Bundle 润色失败，使用原版', 'Bundle polish failed, sending original'),
          [err instanceof Error ? err.message : String(err)])
      }
    }

    // ── user message ─────────────────────────────────────────────────────────
    const visibleDispatchText = dispatchText
    const effectiveDispatchText = await maybeApplyVisualGenerationPolicy(dispatchText)
    appendScrollBlock({ kind: 'user', text: visibleDispatchText, timestamp: timeStampLabel() })

    const runningMessages = createRunningMessageCapture()

    // Run AI generation and next prompt read concurrently.
    // DECSTBM scroll-region isolation keeps AI output (scroll region) and the
    // prompt (fixed zone) from interfering with each other.
    const nextLineFromGeneration = await waitForRunnerOrInterrupt(handleTurn(effectiveDispatchText, locale, hud, workspaceRoot, permissionMode, {
        appendScrollBlock,
        insertScrollBlock,
        updateScrollBlock,
        removeScrollBlock,
        requestPermission: askToolPermission,
      }, handleWorkspaceSwitchRequest, runningMessages.hooks), runningMessages.capture)

    hud.sessionMessageCount = getMessages().length
    prompt.forceRedraw()

    // ── MCP Auto-Discovery (Phase C) ────────────────────────────────────────
    try {
      const mcpStore = new McpServerStore(cwd)
      const mcpData = await mcpStore.load()
      const suggestions = await suggestMcpServersForIntent(cwd, trimmed, mcpData.servers)
      if (suggestions.length > 0) {
        appendSystemPanel(t('发现相关 MCP 服务', 'MCP Suggestions'), [
          t('我发现以下 MCP 服务可能有助于处理此任务，但尚未启用：', 'The following MCP servers might be helpful but are not enabled:'),
          ...suggestions.map((s: any) => `  • \x1b[1;35m${s.id}\x1b[0m (${s.surface?.serverName ?? t('未知', 'Unknown')})`),
          '',
          t('输入 /mcp enable <ID> 来启用它们。', 'Type /mcp enable <ID> to activate them.'),
        ])
      }
    } catch { /* ignore discovery errors */ }

    // auto-save session
    const messages = getMessages()
    if (storedSession) {
      storedSession = { ...storedSession, messages, updatedAt: new Date().toISOString() }
    } else {
      storedSession = Object.assign(sessionStore.createSession(), { messages })
    }
    await sessionStore.save(storedSession).catch(() => { /* non-fatal */ })

    // Carry the concurrently-read line into the next iteration
    nextLineOverride = nextLineFromGeneration
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function handleTurn(
  input: string,
  locale: UiLocale,
  hud: ReturnType<typeof createHudState>,
  cwd?: string,
  permissionMode?: string,
  viewport?: ScrollViewportController,
  onWorkspaceSwitchRequest?: (request: WorkspaceSwitchRequest) => Promise<boolean>,
  runningMessageHooks?: RunningMessageHooks,
): Promise<void> {
  // Per-round state. The model may emit text → tool → text → tool → text. We
  // commit the assistant text as its own block before each tool call so the
  // visual order becomes: user → AI intro → tool result → AI follow-up →
  // tool result → AI summary. Each assistant block carries its own timestamp,
  // elapsed time, and token count once committed.
  let aiTimestamp = timeStampLabel()
  let pendingStartMs = Date.now()
  let accumulated = ''
  let livePendingTokens = 0
  let assistantBlockIndex: number | null = null
  let lastAssistantFlushAt = 0
  let scheduledAssistantFlush: NodeJS.Timeout | null = null
  let pendingPhase: 'generating' | 'thinking' = 'generating'
  // Redraw the spinner block every second so the elapsed counter visibly
  // ticks while we wait for the first content byte. Without this, the block
  // only refreshes on delta arrivals and users perceive the UI as frozen.
  let pendingTick: NodeJS.Timeout | null = null
  let totalReply = ''

  const estimateStreamTokens = (text: string): number => {
    if (!text) return 0
    return Math.max(1, Math.ceil(text.length / 4))
  }

  const flushAssistantBlock = (text: string, pending: boolean): void => {
    if (assistantBlockIndex === null || !viewport) return
    viewport.updateScrollBlock(assistantBlockIndex, {
      kind: 'assistant',
      text,
      timestamp: aiTimestamp,
      pending,
      ...(pending ? {
        pendingStartMs,
        pendingPhase,
        pendingLiveTokens: livePendingTokens,
      } : {}),
    })
    lastAssistantFlushAt = Date.now()
  }

  const scheduleAssistantFlush = (): void => {
    if (assistantBlockIndex === null || !viewport) return
    const now = Date.now()
    const remaining = STREAM_REDRAW_INTERVAL_MS - (now - lastAssistantFlushAt)
    if (remaining <= 0) {
      flushAssistantBlock(accumulated, true)
      return
    }
    if (scheduledAssistantFlush) return
    scheduledAssistantFlush = setTimeout(() => {
      scheduledAssistantFlush = null
      flushAssistantBlock(accumulated, true)
    }, remaining)
  }

  const stopPendingTick = (): void => {
    if (pendingTick) {
      clearInterval(pendingTick)
      pendingTick = null
    }
  }

  const startPendingTick = (): void => {
    if (pendingTick) return
    // Tick runs for the entire pending lifetime, even after `accumulated`
    // becomes non-empty. The renderer appends a "still working" spinner tail
    // below any accumulated text — without the tick, that tail freezes the
    // moment the model pauses streaming, and the user sees a static block
    // for the 5–30s the model spends planning the next chunk / tool call.
    const intervalMs = process.platform === 'win32' ? 1000 : 250
    pendingTick = setInterval(() => {
      flushAssistantBlock(accumulated, true)
    }, intervalMs)
  }

  const cancelScheduledFlush = (): void => {
    if (scheduledAssistantFlush) {
      clearTimeout(scheduledAssistantFlush)
      scheduledAssistantFlush = null
    }
  }

  // Commit the current pending assistant block (if any) as a finalised round,
  // then reset state so the next text delta starts a fresh pending block.
  // - Has text → write it with finalElapsedMs/finalTokens metadata, append to
  //   totalReply for the session record.
  // - Empty placeholder (model went straight to tools) → drop the block.
  const commitCurrentRound = (): void => {
    cancelScheduledFlush()
    stopPendingTick()
    if (assistantBlockIndex === null || !viewport) {
      accumulated = ''
      livePendingTokens = 0
      pendingPhase = 'generating'
      return
    }
    const finalElapsedMs = Math.max(0, Date.now() - pendingStartMs)
    if (accumulated.trim().length > 0) {
      viewport.updateScrollBlock(assistantBlockIndex, {
        kind: 'assistant',
        text: accumulated,
        timestamp: aiTimestamp,
        finalElapsedMs,
        finalTokens: livePendingTokens,
      })
      totalReply = totalReply ? `${totalReply}\n\n${accumulated}` : accumulated
    } else {
      viewport.removeScrollBlock(assistantBlockIndex)
    }
    assistantBlockIndex = null
    accumulated = ''
    livePendingTokens = 0
    pendingPhase = 'generating'
  }

  // Open a new pending assistant block in the transient zone so streaming
  // deltas stay mutable without rewriting scrollback. Once the chunk is
  // committed, the block is promoted into the final timeline in one shot.
  const openPendingAssistantBlock = (): void => {
    if (!viewport || assistantBlockIndex !== null) return
    aiTimestamp = timeStampLabel()
    pendingStartMs = Date.now()
    pendingPhase = 'generating'
    livePendingTokens = 0
    assistantBlockIndex = viewport.appendScrollBlock({
      kind: 'assistant',
      text: '',
      timestamp: aiTimestamp,
      pending: true,
      pendingStartMs,
      pendingPhase,
      pendingLiveTokens: livePendingTokens,
    })
  }

  // ── Tool execution callbacks ─────────────────────────────────────────────
  // Tools commit a single block when they complete. We intentionally skip the
  // "running…" block because updates to scroll-region blocks force a full
  // redraw, which on some terminals produces flicker and can truncate the
  // prompt input. FIFO tracking gives each completion its own start time.
  interface ToolTrack { name: string; args: Record<string, unknown>; startMs: number }
  const pendingTools: ToolTrack[] = []

  const thinkOpts: ThinkOptions = {
    cwd: cwd ?? process.cwd(),
    permissionMode: permissionMode as 'PRODUCER' | 'GHOSTWRITER' | 'WRITER' | 'prompt' | 'read-only' | 'accept-edits' | 'accept-all' | undefined,

    onToolCall: (name, args) => {
      // Commit any pending assistant intro text BEFORE the tool runs so the
      // resulting tool block appears AFTER it in the timeline. Multiple tool
      // calls in the same round only commit on the first one (subsequent
      // calls see assistantBlockIndex === null and skip the commit).
      commitCurrentRound()
      pendingTools.push({ name, args, startMs: Date.now() })
    },

    onToolResult: (name, ok, output) => {
      const matchIdx = pendingTools.findIndex(t => t.name === name)
      const track = matchIdx >= 0 ? pendingTools.splice(matchIdx, 1)[0] : null
      const durationMs = track ? Date.now() - track.startMs : 0
      const args = track?.args ?? {}
      const preview = ok ? formatToolResultPreview(name, args, output) : null
      const finalText = [formatToolDone({ name, args, ok, output, durationMs, locale }), preview]
        .filter(Boolean)
        .join('\n')
      viewport?.appendScrollBlock({
        kind: 'tool',
        text: finalText,
        preserveAnsi: true,
      })
      // Between-turns indicator: after a tool result, the model is processing
      // it and may take 5–30s before the next stream chunk arrives. Without a
      // pending block here, the user just sees a frozen 🤖 timestamp and
      // assumes the CLI hung. Open one immediately so the spinner + elapsed
      // counter is visible during the gap. Idempotent if multiple parallel
      // tool results race in — only the first one opens the block.
      if (pendingTools.length === 0) {
        openPendingAssistantBlock()
        startPendingTick()
      }
    },

    onToolLog: (message, level) => {
      const prefix = level === 'error'
        ? '[error]'
        : level === 'warn'
          ? '[warning]'
          : '[info]'
      viewport?.appendScrollBlock({
        kind: 'tool',
        text: `${prefix} ${message}`,
      })
    },

    onPermissionRequest: async (toolName, category, args) => {
      if (viewport?.requestPermission) {
        return viewport.requestPermission(toolName, category, args)
      }
      return false
    },

    onUserConfirmationRequest: async (request) => {
      if (viewport?.requestPermission) {
        return viewport.requestPermission('request_user_confirmation', 'execute', {
          question: request.question,
          screenshotPath: request.screenshotPath,
          timeoutMs: request.timeoutMs,
        })
      }
      return false
    },

    onReasoning: () => {
      // Switch the spinner label from "generating" to "thinking" the moment
      // the model starts emitting reasoning deltas. We don't render the
      // reasoning content itself — just flip the phase and let the ticker
      // redraw the elapsed counter.
      if (assistantBlockIndex === null) openPendingAssistantBlock()
      if (pendingPhase !== 'thinking' && !accumulated) {
        pendingPhase = 'thinking'
        flushAssistantBlock('', true)
      }
    },

    onWorkspaceSwitchRequest,
  }

  try {
    if (viewport) {
      openPendingAssistantBlock()
      startPendingTick()
    }

    const result = await think(input, {
      ...thinkOpts,
      locale: locale === 'zh-CN' ? 'zh' : 'en',
      cwd: thinkOpts.cwd,
      pollRunningUserMessages: runningMessageHooks?.pollRunningUserMessages,
      onRunningUserMessageAccepted: runningMessageHooks?.onRunningUserMessageAccepted,
      onReasoning: (delta: string) => {
        if (assistantBlockIndex === null) openPendingAssistantBlock()
        livePendingTokens += estimateStreamTokens(delta)
        if (pendingPhase !== 'thinking' && !accumulated) {
          pendingPhase = 'thinking'
        }
        flushAssistantBlock('', true)
      },
      onStream: (delta: string) => {
        if (assistantBlockIndex === null) {
          openPendingAssistantBlock()
          startPendingTick()
        }
        if (!accumulated) {
          pendingPhase = 'generating'
          // Keep the tick alive — spinner now renders as a tail below the
          // streamed body and must continue animating during inter-chunk
          // pauses (the gap before the model resumes / calls a tool).
        }
        accumulated += delta
        livePendingTokens += estimateStreamTokens(delta)
        scheduleAssistantFlush()
      },
    })

    stopPendingTick()
    cancelScheduledFlush()

    // Final commit for whatever round is still open. Prefer the model's
    // canonical reply when available, but only for the LAST chunk — earlier
    // intro text was already committed via commitCurrentRound() at each
    // tool boundary, so we don't want to overwrite it with the full reply.
    const finalElapsedMs = Math.max(0, Date.now() - pendingStartMs)
    const lastChunk = accumulated || (totalReply ? '' : (result.text ?? ''))
    if (assistantBlockIndex !== null && viewport) {
      if (lastChunk.trim().length > 0) {
        viewport.updateScrollBlock(assistantBlockIndex, {
          kind: 'assistant',
          text: lastChunk,
          timestamp: aiTimestamp,
          finalElapsedMs,
          finalTokens: livePendingTokens,
        })
      } else {
        viewport.removeScrollBlock(assistantBlockIndex)
      }
      assistantBlockIndex = null
    } else if (lastChunk.trim().length > 0 && totalReply.length === 0) {
      // No pending block was open AND we have no committed text: append a
      // fresh finalised assistant block carrying the reply.
      viewport?.appendScrollBlock({
        kind: 'assistant',
        text: lastChunk,
        timestamp: aiTimestamp,
        finalElapsedMs,
        finalTokens: livePendingTokens,
      })
    }

    if (result.tokenStats) {
      updateHudState(hud, result.tokenStats)
      hud.lastPromptTokens = getLastPromptTokens()
      // HUD will be redrawn on next viewport update or prompt interaction
      // Budget warning line when context is getting full
      const pt = hud.lastPromptTokens
      if (pt > 0) {
        const { estimateContextLimit: ecl, fmtTok: ft } = await import('./hud.js')
        const model = hud.lastModel // 从 hud 中获取模型信息，因为 tokenStats 中没有 model 属性
        const limit = ecl(model, hud.contextLimit)
        const pct = pt / limit
        if (pct >= 0.88) {
          viewport?.appendScrollBlock({
            kind: 'tool',
            text: locale === 'zh-CN'
              ? `⚠ 上下文剩余不足 ${Math.round((1 - pct) * 100)}%，建议立即 /clear 开新会话。`
              : `⚠ Context remaining is below ${Math.round((1 - pct) * 100)}%. Run /clear soon.`,
          })
        }
      }
    }

    // Explicit "this turn is finished" footer so the user can tell at a glance
    // whether the AI is still cooking or has handed control back. This is a
    // transport/turn status, not a claim that the user's whole task is done; the
    // wording must avoid conflicting with the visible checklist above.
    //
    // We prefer the API-reported usage from result.tokenStats over the local
    // chars/4 estimate (`livePendingTokens`) because the estimate severely
    // undercounts CJK text (Chinese characters are 1-3 tokens each, not 0.25)
    // and ignores input tokens entirely. Falling back to the estimate keeps
    // the UI sane when a provider doesn't report usage.
    const totalElapsedSec = Math.max(1, Math.round((Date.now() - pendingStartMs) / 1000))
    const realUsage = result.tokenStats
    const realIn = realUsage?.promptTokens ?? 0
    const realOut = realUsage?.completionTokens ?? 0
    let tokenSummary: string
    if (realIn > 0 || realOut > 0) {
      const { fmtTok: ft } = await import('./hud.js')
      tokenSummary = locale === 'zh-CN'
        ? `输入 ${ft(realIn)} · 输出 ${ft(realOut)} tok`
        : `in ${ft(realIn)} · out ${ft(realOut)} tok`
    } else {
      const { fmtTok: ft } = await import('./hud.js')
      tokenSummary = locale === 'zh-CN'
        ? `估算 ${ft(livePendingTokens)} tok`
        : `est. ${ft(livePendingTokens)} tok`
    }
    // Cat-themed kaomoji-only closer — no trailing text, just the face.
    // Pool is intentionally large so the same one rarely repeats in a session.
    const closer = pickKaomoji()
    viewport?.appendScrollBlock({
      kind: 'system',
      text: locale === 'zh-CN'
        ? `✓ 本轮回复结束 · ${totalElapsedSec}s · ${tokenSummary} · ${closer}`
        : `✓ Turn finished · ${totalElapsedSec}s · ${tokenSummary} · ${closer}`,
    })
  } catch (err: unknown) {
    stopPendingTick()
    if (scheduledAssistantFlush) clearTimeout(scheduledAssistantFlush)
    const msg = err instanceof Error ? err.message : String(err)
    const errorText = locale === 'zh-CN' ? `错误：${msg}` : `Error: ${msg}`
    if (assistantBlockIndex !== null && viewport) {
      viewport.updateScrollBlock(assistantBlockIndex, {
        kind: 'assistant',
        text: errorText,
        timestamp: aiTimestamp,
      })
    } else {
      viewport?.appendScrollBlock({
        kind: 'assistant',
        text: errorText,
        timestamp: aiTimestamp,
      })
    }
    viewport?.appendScrollBlock({
      kind: 'system',
      text: renderTimelinePanel(locale === 'zh-CN' ? '错误' : 'Error', [msg]),
      preserveAnsi: true,
    })
  }
}

/**
 * Run a workflow command as a hint-injected turn through the brain's normal
 * main loop. Replaces the old phase-based pipeline with a Claude Code style
 * flow: inject a domain hint into the brain's system prompt, then let the
 * brain's 24-round tool loop handle the task end-to-end.
 *
 * The brain decides when to call tools, when to spawn sub-agents, when to
 * generate images — all in a single conversation, just like Claude Code does.
 */
async function runHintedWorkflowTurn(
  mode: WorkflowMode,
  userPrompt: string,
  cwd: string,
  permissionMode: PermissionMode,
  locale: UiLocale,
  hud: ReturnType<typeof createHudState>,
  viewport: ScrollViewportController,
  onWorkspaceSwitchRequest: (request: WorkspaceSwitchRequest) => Promise<boolean>,
  runningMessageHooks?: RunningMessageHooks,
): Promise<void> {
  const previousSuffix = getSystemPromptSuffix()
  const hint = buildWorkflowHint(mode, { cwd, userPrompt })
  setSystemPromptSuffix(previousSuffix ? `${previousSuffix}\n\n${hint}` : hint)

  const msgIndexBefore = getMessages().length

  try {
    await handleTurn(
      userPrompt,
      locale,
      hud,
      cwd,
      permissionMode,
      viewport,
      onWorkspaceSwitchRequest,
      runningMessageHooks,
    )
  } finally {
    // Walk new tool messages to find files written, compute common output dir.
    const newMessages = getMessages().slice(msgIndexBefore)
    const writePaths: string[] = []
    for (const msg of newMessages) {
      if ((msg as { role?: string }).role !== 'tool') continue
      const name = (msg as { name?: string }).name
      if (name !== 'write_file' && name !== 'replace_in_file' && name !== 'insert_in_file') continue
      try {
        const parsed = JSON.parse((msg as { content: string }).content) as {
          ok?: boolean
          action?: { path?: string }
        }
        if (parsed.ok && parsed.action?.path) writePaths.push(parsed.action.path)
      } catch {
        /* ignore unparseable tool result */
      }
    }
    let outputDir: string | undefined
    if (writePaths.length > 0) {
      const dirs = writePaths.map((p) => path.dirname(p))
      let common = dirs[0]!
      for (const d of dirs.slice(1)) {
        while (!d.startsWith(common + path.sep) && d !== common) {
          common = path.dirname(common)
          if (common === path.dirname(common)) break
        }
      }
      outputDir = common
    }

    // Restore suffix to baseline + append a completion note so subsequent
    // free-form turns know where the workflow's output lives.
    setSystemPromptSuffix(previousSuffix + buildWorkflowCompletionNote(mode, outputDir))
  }
}


async function saveSession(
  store: SessionStore,
  session: SessionRecord | null,
): Promise<void> {
  if (!session) return
  const messages = getMessages()
  if (messages.length === 0) return
  const updated = { ...session, messages, updatedAt: new Date().toISOString() }
  await store.save(updated).catch(() => { /* non-fatal */ })
}

async function renderHistory(store: PromptHistoryStore, locale: UiLocale): Promise<string> {
  const entries = await store.load()
  if (entries.length === 0) {
    return renderTimelinePanel(
      locale === 'zh-CN' ? '历史记录' : 'Prompt history',
      [locale === 'zh-CN' ? '暂无记录。' : 'No history yet.']
    )
  }
  const lines = entries.slice(0, 20).map((e, i) =>
    `${String(i + 1).padStart(2)}. ${e.replace(/\n/g, '↵').slice(0, 60)}`
  )
  return renderTimelinePanel(locale === 'zh-CN' ? `历史记录 (${entries.length})` : `Prompt history (${entries.length})`, lines)
}

async function renderSessions(store: SessionStore, locale: UiLocale): Promise<string> {
  const sessions = await store.list()
  if (sessions.length === 0) {
    return renderTimelinePanel(
      locale === 'zh-CN' ? '会话列表' : 'Sessions',
      [locale === 'zh-CN' ? '暂无保存的会话。' : 'No saved sessions.']
    )
  }
  const lines = sessions.slice(0, 20).map(s =>
    `${s.id.slice(0, 8)}  ${s.updatedAt.slice(0, 16).replace('T', ' ')}  ${s.title.slice(0, 40)}`
  )
  return renderTimelinePanel(locale === 'zh-CN' ? '最近会话' : 'Recent sessions', lines)
}

function renderHelp(locale: UiLocale): string {
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })

  const commands = [
    `/team <任务>       ${t('AI 自动派单 (推荐，不确定时先用它)', 'AI auto-router (recommended when unsure)')}`,
    `/niko <任务>       ${t('探索方向后落地', 'Explore, then build')}`,
    `/design <任务>     ${t('UI / 前端设计 → 实现', 'UI / frontend design → implement')}`,
    `/athena <任务>     ${t('深研代码库并协调执行', 'Deep repo research + coordinated execution')}`,
    `/nidhogg <任务>    ${t('对抗式实现硬化 / 逐轮逼近最优 (慢)', 'Adversarial hardening / iterative convergence (slow)')}`,
    `/contest <任务>    ${t('路径辩论、方案裁决、再执行', 'Debate paths, select one, then execute')}`,
    `/bifrost           ${t('开启思维/执行双模型', 'Enable dual-model mode')}`,
    `/run <任务>        ${t('后台运行工作流', 'Run workflow in background')}`,
    ``,
    `/clear             ${t('重置对话历史', 'Reset conversation')}`,
    `/save [title]      ${t('保存会话（可选标题）', 'Save session (optional title)')}`,
    `/sessions          ${t('列出已保存会话', 'List saved sessions')}`,
    `/search <词>       ${t('跨会话全文搜索', 'Full-text search across sessions')}`,
    `/wordup            ${t('创建 WordUP 快照', 'Create WordUP snapshot')}`,
    `/wordupnow         ${t('强制创建 WordUP 快照', 'Force-create WordUP snapshot')}`,
    `/history           ${t('显示提示历史', 'Show prompt history')}`,
    `/resume <ID>       ${t('恢复指定会话', 'Resume a session')}`,
    `/undo              ${t('撤回上一步操作', 'Undo last turn')}`,
    `/retry             ${t('重试上一步操作', 'Retry last turn')}`,
    ``,
    `/odin              ${t('技能库管理', 'Odin skill store')}`,
    `/heimdall          ${t('线程控制面 / 观察与审批', 'Thread control plane / observe and approve')}`,
    `/hud               ${t('显示 HUD 状态栏', 'Show HUD status bar')}`,
    ``,
    `/model [name]      ${t('切换执行模型', 'Show / switch model')}`,
    `/swap              ${t('互换主/副模型', 'Swap main/brain models')}`,
    `/locale [zh|en]    ${t('切换界面语言', 'Show / switch locale')}`,
    `/permission [mode] ${t('切换权限模式', 'Show / switch permission mode')}`,
    `/config            ${t('重新配置提供商', 'Reconfigure AI provider')}`,
    `/config visual     ${t('单独配置视觉模型', 'Configure visual model only')}`,
    `/visual            ${t('快捷修改视觉 API 配置', 'Quick-edit visual API config')}`,
    `/vercel            ${t('配置 Vercel 部署 token', 'Configure Vercel deployment token')}`,
    `/vercel status     ${t('查看 Vercel 授权状态', 'Show Vercel auth status')}`,
    `/vercel logout     ${t('清除已保存的 Vercel token', 'Clear saved Vercel token')}`,
    `/config memory     ${t('配置记忆增强', 'Configure memory enhancement')}`,
    `/newborn           ${t('清空配置并重新引导', 'Wipe config and re-run setup')}`,
    `/exit              ${t('退出程序', 'Exit')}`,
    `/help              ${t('显示此帮助', 'Show this help')}`,
  ]
  const keys = [
    `Ctrl+J / Alt+Enter   ${t('插入换行（多行模式）', 'Insert newline (multiline mode)')}`,
    `Enter                ${t('提交', 'Submit')}`,
    `↑ / ↓              ${t('历史导航', 'History')}`,
    `Ctrl+A / Ctrl+E      ${t('行首 / 行尾', 'Line start / end')}`,
    `Ctrl+K               ${t('剪切到行尾', 'Kill to end of line')}`,
    `Ctrl+U               ${t('剪切到行首', 'Kill to start of line')}`,
    `Ctrl+W               ${t('剪切一个单词', 'Kill word backward')}`,
    `Ctrl+Y               ${t('粘贴剪切内容', 'Yank (paste)')}`,
    `Ctrl+Z               ${t('撤销', 'Undo')}`,
    `Alt+Left/Right       ${t('按单词移动', 'Move by word')}`,
    `Ctrl+C               ${t('清除输入（空时退出）', 'Clear input (exit when empty)')}`,
  ]

  return [
    renderTimelinePanel(t('Slash 命令', 'Slash commands'), commands),
    '',
    renderTimelinePanel(t('键盘快捷键', 'Keyboard shortcuts'), keys),
  ].join('\n')
}

/**
 * Fire-and-forget user profile auto-update.
 * Called on session exit / clear. Never throws — errors are silently ignored.
 */
async function updateUserProfileSilent(
  messages: ReturnType<typeof getMessages>,
  _locale: UiLocale,
): Promise<void> {
  try {
    const existing = await loadUserProfile()
    const recentMessages = messages.map((m: any) => ({ role: m.role, content: m.content }))
    const updated = await autoUpdateUserProfile({
      recentMessages,
      existingProfile: existing,
      summarize: summarizeOnce,
      minMessages: 4,
    })
    if (updated && updated !== existing) {
      await saveUserProfile(updated)
    }
  } catch { /* non-fatal */ }
}
