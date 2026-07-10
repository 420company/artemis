/**
 * services/headlessAgent.ts — one-shot real agent execution outside the
 * interactive UI. The single bootstrap used by `artemis execute/analyze`,
 * Goal Mode ticks, and any future headless caller: resolve the user's
 * configured provider, wire the router/permissions/session store, and run
 * the REAL agent loop (core/agent.ts runAgent) with full tool access.
 *
 * (Historical note: `artemis execute` previously routed through
 * core/queryEngine.ts, which only SIMULATES responses — it never called a
 * model or ran a tool. QueryEngine stays exported for API compatibility, but
 * nothing in the CLI executes through it anymore.)
 */

import type { PermissionModeInput } from '../security/permissionModes.js'

export interface HeadlessAgentOptions {
  /** PRODUCER = full autonomous tools; read-only for analysis. Default PRODUCER. */
  permissionMode?: PermissionModeInput
  /** Override the configured model for this run. */
  model?: string
  maxTurns?: number
  sessionTitle?: string
  onInfo?: (message: string) => void
}

export interface HeadlessAgentResult {
  reply: string
  turns: number
  sessionId: string
  durationMs: number
}

export async function runHeadlessAgent(
  cwd: string,
  prompt: string,
  opts: HeadlessAgentOptions = {},
): Promise<HeadlessAgentResult> {
  const { resolveMainProviderConfig } = await import('../providers/onboarding.js')
  const { createTrackedProviderFromConfig } = await import('../providers/telemetry.js')
  const { createProviderRouter } = await import('../providers/router.js')
  const { PermissionManager } = await import('../security/permissions.js')
  const { SessionStore } = await import('../storage/sessions.js')
  const { runAgent } = await import('../core/agent.js')

  const onInfo = opts.onInfo ?? (() => undefined)
  const providerConfig = await resolveMainProviderConfig({
    cwd,
    config: opts.model ? { model: opts.model } : {},
    onInfo,
  })
  const provider = createTrackedProviderFromConfig(providerConfig, { cwd })
  const permissionManager = new PermissionManager(opts.permissionMode ?? 'PRODUCER', false)
  const providerRouter = await createProviderRouter({
    cwd,
    mainProvider: provider,
    onInfo,
  })
  const sessionStore = new SessionStore(cwd)
  const session = sessionStore.createSession({
    title: opts.sessionTitle ?? `Headless: ${prompt.slice(0, 48)}`,
  })

  const started = Date.now()
  const result = await runAgent(session, prompt, {
    cwd,
    provider,
    sessionStore,
    permissionManager,
    maxTurns: Math.max(1, Math.min(200, opts.maxTurns ?? 60)),
    profile: 'main',
    appendUserMessage: true,
    ensureSpecialistProvider: providerRouter.ensureSpecialistProvider,
    resolveProvider: providerRouter.resolveProvider,
    onInfo: opts.onInfo,
  })

  return {
    reply: result.reply,
    turns: result.turns,
    sessionId: session.id,
    durationMs: Date.now() - started,
  }
}
