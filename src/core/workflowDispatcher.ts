/**
 * Workflow dispatcher — UI-agnostic entry point shared by the desktop CLI
 * (interactive.ts) and the IM bridges (telegram/discord/wechat).
 *
 * Users do not pick workflows any more: core/workflowRouter.ts chooses one
 * from the request. The only slash entries left here are /nidhogg (the
 * background adversarial harness) and /run (direct background run); the
 * retired /niko /athena /contest /design /team words are stripped by the
 * router and treated as natural language.
 *
 * Design: stays out of the brain tool loop. Returns a "resolution" object
 * that callers feed into setSystemPromptSuffix() + think() or
 * runWorkflowMode(). This keeps the dispatcher pure and testable, and lets
 * each frontend keep its own progress-rendering style.
 */

import type { WorkflowMode } from './workflowMode.js'
import type { UiLocale } from '../cli/locale.js'
import { buildWorkflowHint } from './workflowHints.js'
import {
  AUTO_WORKFLOW_MODE,
  buildRoutedWorkflowHint,
  describeAutoWorkflow,
  describeRouteReason,
  type WorkflowRoute,
} from './workflowRouter.js'
import {
  detectVisualGenerationNeed,
  hasExplicitLocalVisualConsent,
  hasExplicitRemoteVisualFallback,
  VISUAL_NOT_CONFIGURED_POLICY,
  resolveConfiguredVisualProvider,
  describeVisualProvider,
} from '../utils/visualGenerationConfig.js'
import { pickLocale } from '../cli/locale.js'

export type WorkflowSlash = '/nidhogg' | '/run'

export const WORKFLOW_SLASH_COMMANDS: readonly WorkflowSlash[] = [
  '/nidhogg',
  '/run',
] as const

const WORKFLOW_SLASH_SET: ReadonlySet<string> = new Set(WORKFLOW_SLASH_COMMANDS)

export interface WorkflowSlashMatch {
  command: WorkflowSlash | null
  body: string
  source?: 'slash' | 'natural-language'
}

/**
 * Detect a workflow slash command at the start of user input.
 * Returns command=null if input is not a workflow slash command.
 */
export function detectWorkflowSlashCommand(text: string): WorkflowSlashMatch {
  const trimmed = text.trim()
  for (const cmd of WORKFLOW_SLASH_COMMANDS) {
    if (trimmed.toLowerCase() === cmd) return { command: cmd, body: '', source: 'slash' }
    const lowerHead = trimmed.slice(0, cmd.length + 1).toLowerCase()
    if (lowerHead === cmd + ' ' || lowerHead === cmd + '\n') {
      return { command: cmd, body: trimmed.slice(cmd.length).trim(), source: 'slash' }
    }
  }
  return { command: null, body: trimmed }
}

const NATURAL_WORKFLOW_INTENT_RE = /(?:启用|启动|开启|进入|切到|切换到|使用|用|走|run|use|start|switch\s+to)\s*(?:工作流|模式|workflow|mode)?\s*$/i

/** "/nidhogg <task>", or "用 /nidhogg 模式 …" written as a sentence. */
export function detectExplicitWorkflowIntent(text: string): WorkflowSlashMatch {
  const slashMatch = detectWorkflowSlashCommand(text)
  if (slashMatch.command) return slashMatch

  const trimmed = text.trim()
  const matches: Array<{ command: WorkflowSlash; index: number }> = []
  for (const cmd of WORKFLOW_SLASH_COMMANDS) {
    const re = new RegExp(`${cmd.replace('/', '\\/')}(?![a-z])`, 'i')
    const match = re.exec(trimmed)
    if (!match) continue
    const before = trimmed.slice(0, match.index)
    if (!NATURAL_WORKFLOW_INTENT_RE.test(before)) continue
    matches.push({ command: cmd, index: match.index })
  }
  if (matches.length === 0) return { command: null, body: trimmed }

  const priority: WorkflowSlash[] = ['/nidhogg', '/run']
  const chosen = priority.find((cmd) => matches.some((match) => match.command === cmd)) ?? matches[0]!.command
  return { command: chosen, body: trimmed, source: 'natural-language' }
}

export function isWorkflowSlashCommand(token: string): token is WorkflowSlash {
  return WORKFLOW_SLASH_SET.has(token)
}

export interface WorkflowResolution {
  /** The mode to run (internal workflow name). */
  mode: WorkflowMode
  /** Hint string ready to be passed to setSystemPromptSuffix. Empty string for 'direct'. */
  hint: string
  /** The augmented user prompt with any policy directives appended. */
  effectivePrompt: string
  /** Human-readable summary of the routing/policy decisions (for chat output). */
  summary: string[]
  /** The automatic route, when the router chose the workflow. */
  route?: WorkflowRoute
}

export interface ResolveWorkflowOptions {
  cwd: string
  locale: UiLocale
  /** Optional callback for progress notifications during routing. */
  onProgress?: (message: string, level?: 'info' | 'warn' | 'error') => void | Promise<void>
  /** When true, skip interactive choices and default to local generation if configured. */
  nonInteractive?: boolean
}

/**
 * Resolve an explicit workflow slash command (/nidhogg, /run) into a
 * concrete workflow mode + system prompt suffix + augmented prompt. Pure
 * async function; does not call think() or mutate the brain.
 */
export async function resolveWorkflow(
  match: WorkflowSlashMatch,
  opts: ResolveWorkflowOptions,
): Promise<WorkflowResolution> {
  const t = (zh: string, en: string): string => pickLocale(opts.locale, { zh, en })
  const summary: string[] = []
  let mode: WorkflowMode = 'direct'

  if (match.command === '/nidhogg') {
    mode = 'nidhogg'
    summary.push(t('工作流: Nidhogg', 'Workflow: Nidhogg'))
  } else if (match.command === '/run') {
    summary.push(t('执行模式: 直接调度', 'Execution mode: direct'))
  }

  const policyResult = await applyVisualPolicy(match.body, opts)
  if (policyResult.summary) summary.push(policyResult.summary)
  const effectivePrompt = policyResult.prompt

  const hint = mode === 'direct'
    ? ''
    : buildWorkflowHint(mode, { cwd: opts.cwd, userPrompt: effectivePrompt })

  return { mode, hint, effectivePrompt, summary }
}

/**
 * Resolve a route chosen by core/workflowRouter.ts (never 'saga': Saga has
 * its own wizard) into the same resolution shape as an explicit command.
 */
export async function resolveRoutedWorkflow(
  route: WorkflowRoute,
  opts: ResolveWorkflowOptions,
): Promise<WorkflowResolution> {
  const t = (zh: string, en: string): string => pickLocale(opts.locale, { zh, en })
  const mode: WorkflowMode = route.workflow === 'saga' ? 'direct' : AUTO_WORKFLOW_MODE[route.workflow]
  const summary: string[] = []
  if (mode !== 'direct') {
    summary.push(t(
      `🧭 自动选择工作流：${describeAutoWorkflow(route.workflow, 'zh-CN')}（${describeRouteReason(route, 'zh-CN')}）`,
      `🧭 Workflow chosen automatically: ${describeAutoWorkflow(route.workflow, 'en')} (${describeRouteReason(route, 'en')})`,
    ))
  }
  const policyResult = await applyVisualPolicy(route.text, opts)
  if (policyResult.summary) summary.push(policyResult.summary)
  const effectivePrompt = policyResult.prompt
  const hint = mode === 'direct'
    ? ''
    : buildRoutedWorkflowHint(route.workflow, { cwd: opts.cwd, userPrompt: effectivePrompt, reason: route.reason })
  return { mode, hint, effectivePrompt, summary, route }
}

/**
 * Inspect prompt for image/video generation needs and return a prompt with the
 * appropriate visual generation policy directive appended.
 */
async function applyVisualPolicy(
  prompt: string,
  opts: ResolveWorkflowOptions,
): Promise<{ prompt: string; summary: string }> {
  const need = detectVisualGenerationNeed(prompt)
  if (!need.image && !need.video) return { prompt, summary: '' }

  const t = (zh: string, en: string): string => pickLocale(opts.locale, { zh, en })

  const configured = (
    await Promise.all([
      need.image ? resolveConfiguredVisualProvider(opts.cwd, 'image') : Promise.resolve(null),
      need.video ? resolveConfiguredVisualProvider(opts.cwd, 'video') : Promise.resolve(null),
    ])
  ).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

  if (configured.length === 0) {
    return {
      prompt: `${prompt}\n\n${VISUAL_NOT_CONFIGURED_POLICY}`,
      summary: t(
        '⚠️ 视觉素材策略：图片/视频生成尚未配置，运行 /visual 完成配置后重试',
        '⚠️ Visual policy: image/video generation is not configured; run /visual to set it up, then retry',
      ),
    }
  }

  const configuredText = configured.map(c => describeVisualProvider(c.config, c.assetKind)).join(', ')

  if (hasExplicitRemoteVisualFallback(prompt)) {
    return {
      prompt: `${prompt}\n\n[Visual generation policy]\nThe user explicitly requested online/search visual assets. Do not call generate_image/generate_video unless the user asks again.`,
      summary: t(
        `视觉素材策略：用户要求网络/搜索素材；本地 API 已配置 (${configuredText})`,
        `Visual policy: user requested web-search assets; local API configured (${configuredText})`,
      ),
    }
  }

  // Default for bridges (or explicit consent in CLI): use local generation
  if (hasExplicitLocalVisualConsent(prompt) || opts.nonInteractive) {
    return {
      prompt: `${prompt}\n\n[Visual generation policy]\nUser allowed local visual generation. Photographic / product / editorial / lifestyle assets MUST be produced via generate_image (or generate_video when appropriate). Icons, logos, UI controls, loaders, geometric or abstract decoration, charts, diagrams, and other vector-native graphics MAY be authored as SVG/CSS directly — these are the right tool for those jobs and are not violations. The forbidden pattern is substituting hand-authored SVG/canvas/procedural code for what should be a real photograph (e.g. writing a node/python script that draws "product images" instead of calling generate_image). If generate_image returns an error, report it to the user explicitly and ask whether to retry or switch to web-search; do not silently fall back to SVG placeholders for photographic subjects.`,
      summary: t(
        `视觉素材策略：本地视觉 API 已启用 (${configuredText})`,
        `Visual policy: local visual API enabled (${configuredText})`,
      ),
    }
  }

  // Fallback for interactive CLI when no consent given (CLI handles its own prompt UI).
  return { prompt, summary: '' }
}
