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
import type { SessionRecord } from '../core/types.js'
import type { SessionStore } from '../storage/sessions.js'

export interface HeadlessAgentOptions {
  /** PRODUCER = full autonomous tools; read-only for analysis. Default PRODUCER. */
  permissionMode?: PermissionModeInput
  /** Override the configured model for this run. */
  model?: string
  maxTurns?: number
  /** Continue this existing session (its history becomes context) instead of creating a new one. */
  sessionId?: string
  /** Images attached to the prompt; the model sees them with its first request. */
  imagePaths?: string[]
  sessionTitle?: string
  onInfo?: (message: string) => void
}

export interface HeadlessAgentResult {
  reply: string
  turns: number
  sessionId: string
  durationMs: number
}

async function loadExistingSession(sessionStore: SessionStore, sessionId: string): Promise<SessionRecord> {
  try {
    return await sessionStore.load(sessionId)
  } catch (error) {
    // A host passing a stale id must get an explicit failure, never a silent fresh session.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Session not found: ${sessionId}`)
    throw error
  }
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
  const session = opts.sessionId
    ? await loadExistingSession(sessionStore, opts.sessionId)
    : sessionStore.createSession({
      title: opts.sessionTitle ?? `Headless: ${prompt.slice(0, 48)}`,
    })

  // A missing, unreadable or oversized image, or a model that cannot see
  // images, fails the run: the user expects every image to be seen.
  const { loadPromptImages } = await import('../core/imageInput.js')
  const imageAttachments = await loadPromptImages(opts.imagePaths ?? [], cwd, {
    supportsImages: provider.supportsImages,
    name: providerConfig.model,
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
    // Nobody reviews a headless turn as it runs: memories the model saves
    // without naming a scope stay in this workspace.
    memoryDefaultScope: 'project',
    ensureSpecialistProvider: providerRouter.ensureSpecialistProvider,
    resolveProvider: providerRouter.resolveProvider,
    onInfo: opts.onInfo,
    ...(imageAttachments.length ? { imageAttachments } : {}),
  })

  return {
    reply: result.reply,
    turns: result.turns,
    sessionId: session.id,
    durationMs: Date.now() - started,
  }
}
