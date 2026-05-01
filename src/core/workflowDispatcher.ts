/**
 * Workflow dispatcher — UI-agnostic entry point for workflow slash commands.
 *
 * Used by both the desktop CLI (interactive.ts) and the IM bridges
 * (telegram/discord/wechat) so they share the same /team routing,
 * visual-asset policy, and workflow-hint logic.
 *
 * Design: stays out of the brain tool loop. Returns a "resolution" object
 * that callers feed into setSystemPromptSuffix() + think() (or handleTurn()
 * for the desktop UI). This keeps the dispatcher pure and testable, and lets
 * each frontend keep its own progress-rendering style.
 */

import type { WorkflowMode } from './workflowMode.js'
import type { UiLocale } from '../cli/locale.js'
import type { ChatProvider } from '../providers/types.js'
import { buildWorkflowHint } from './workflowHints.js'
import { routeTeamRequest, describeChoice, type TeamRoute } from './team.js'
import {
  detectVisualGenerationNeed,
  hasExplicitLocalVisualConsent,
  hasExplicitRemoteVisualFallback,
  resolveConfiguredVisualProvider,
  describeVisualProvider,
} from '../utils/visualGenerationConfig.js'
import { pickLocale } from '../cli/locale.js'

export type WorkflowSlash =
  | '/team'
  | '/niko'
  | '/design'
  | '/athena'
  | '/nidhogg'
  | '/contest'
  | '/run'

export const WORKFLOW_SLASH_COMMANDS: readonly WorkflowSlash[] = [
  '/team',
  '/niko',
  '/design',
  '/athena',
  '/nidhogg',
  '/contest',
  '/run',
] as const

const WORKFLOW_SLASH_SET: ReadonlySet<string> = new Set(WORKFLOW_SLASH_COMMANDS)

export interface WorkflowSlashMatch {
  command: WorkflowSlash | null
  body: string
}

/**
 * Detect a workflow slash command at the start of user input.
 * Returns command=null if input is not a workflow slash command.
 */
export function detectWorkflowSlashCommand(text: string): WorkflowSlashMatch {
  const trimmed = text.trim()
  for (const cmd of WORKFLOW_SLASH_COMMANDS) {
    if (trimmed.toLowerCase() === cmd) return { command: cmd, body: '' }
    const lowerHead = trimmed.slice(0, cmd.length + 1).toLowerCase()
    if (lowerHead === cmd + ' ' || lowerHead === cmd + '\n') {
      return { command: cmd, body: trimmed.slice(cmd.length).trim() }
    }
  }
  return { command: null, body: trimmed }
}

export function isWorkflowSlashCommand(token: string): token is WorkflowSlash {
  return WORKFLOW_SLASH_SET.has(token)
}

export interface WorkflowResolution {
  /** The mode to inject into the brain via system prompt suffix. */
  mode: WorkflowMode
  /** Hint string ready to be passed to setSystemPromptSuffix. Empty string for 'direct'. */
  hint: string
  /** The augmented user prompt with any policy directives appended. */
  effectivePrompt: string
  /** Human-readable summary of the routing/policy decisions (for chat output). */
  summary: string[]
  /** Full team route (only present when command was /team). */
  route?: TeamRoute
}

export interface ResolveWorkflowOptions {
  cwd: string
  locale: UiLocale
  /** Required only for /team auto-routing. */
  provider?: ChatProvider
  /** Optional callback for progress notifications during routing. */
  onProgress?: (message: string, level?: 'info' | 'warn' | 'error') => void | Promise<void>
  /** When true, skip interactive choices and default to local generation if configured. */
  nonInteractive?: boolean
}

/**
 * Resolve a workflow slash command (or plain chat message) into a concrete
 * workflow mode + system prompt suffix + augmented prompt. Pure async function;
 * does not call think() or mutate the brain.
 *
 *  - command=null:    plain chat; mode='direct'; visual policy still applied
 *  - command=/team:   uses LLM router to pick mode, then applies visual policy
 *  - command=/niko etc: maps directly to mode
 *  - command=/run:    treated as 'direct' (no workflow hint)
 */
export async function resolveWorkflow(
  match: WorkflowSlashMatch,
  opts: ResolveWorkflowOptions,
): Promise<WorkflowResolution> {
  const t = (zh: string, en: string): string => pickLocale(opts.locale, { zh, en })
  const summary: string[] = []
  let mode: WorkflowMode = 'direct'
  let route: TeamRoute | undefined

  // Phase 1: determine workflow mode
  if (match.command === '/team') {
    if (!match.body.trim()) {
      throw new Error(t('用法: /team <任务描述>', 'Usage: /team <task description>'))
    }
    if (!opts.provider) {
      throw new Error(t(
        '/team 路由需要可用的 AI provider，但未提供。',
        '/team router requires a provider but none was given.',
      ))
    }
    await opts.onProgress?.(
      t('🤝 Team 路由：AI 正在判断该走哪条工作流…', '🤝 Team router: deciding which workflow fits…'),
      'info',
    )
    try {
      route = await routeTeamRequest(match.body, opts.provider)
      mode = route.choice
      summary.push(t(
        `Team 路由 → ${describeChoice(route.choice, opts.locale)}（${route.reason}）`,
        `Team router → ${describeChoice(route.choice, opts.locale)} (${route.reason})`,
      ))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.push(t(
        `Team 路由失败，回落到默认会话: ${msg}`,
        `Team router failed, falling back to direct: ${msg}`,
      ))
      mode = 'direct'
    }
  } else if (match.command === '/run') {
    mode = 'direct'
    summary.push(t('执行模式: 直接调度', 'Execution mode: direct'))
  } else if (match.command === '/niko' || match.command === '/design' || match.command === '/athena' || match.command === '/nidhogg' || match.command === '/contest') {
    mode = match.command.slice(1) as WorkflowMode
    summary.push(t(`工作流: /${mode}`, `Workflow: /${mode}`))
  } else {
    mode = 'direct'
  }

  // Phase 2: apply visual generation policy on the body
  const policyResult = await applyVisualPolicy(match.body, opts)
  if (policyResult.summary) summary.push(policyResult.summary)
  const effectivePrompt = policyResult.prompt

  // Phase 3: build workflow hint string
  const hint = mode === 'direct'
    ? ''
    : buildWorkflowHint(mode, { cwd: opts.cwd, userPrompt: effectivePrompt })

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
      prompt: `${prompt}\n\n[Visual generation policy]\nNo configured local visual generation API is available. Use web-search assets if needed, and do not claim local generation. Do NOT write scripts that generate SVG placeholders as a substitute.`,
      summary: t(
        '⚠️ 视觉素材策略：未配置本地视觉 API，本轮将使用网络搜索素材',
        '⚠️ Visual policy: no local visual API configured; this turn will use web-search assets',
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
      prompt: `${prompt}\n\n[Visual generation policy]\nUser allowed local visual generation. You MUST call the generate_image (and generate_video when appropriate) tool directly for every required visual asset. Do NOT write a node/python/shell script that emits SVG, canvas, or procedural geometry as a substitute — that is a violation. If local generation returns an error, report it explicitly to the user and ask whether to retry or switch to web-search; do not silently fall back to SVG placeholders.`,
      summary: t(
        `视觉素材策略：本地视觉 API 已启用 (${configuredText})`,
        `Visual policy: local visual API enabled (${configuredText})`,
      ),
    }
  }

  // Fallback for interactive CLI when no consent given (CLI handles its own prompt UI).
  return { prompt, summary: '' }
}
