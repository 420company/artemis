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
  /** Images attached to the prompt: sent with the first request, or described by the vision helper for a text-only model. */
  imagePaths?: string[]
  sessionTitle?: string
  onInfo?: (message: string) => void
}

export interface HeadlessAgentResult {
  reply: string
  turns: number
  sessionId: string
  durationMs: number
  /** One short line per context compaction that happened during the run. */
  contextNotices: string[]
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
  const { loadCompactionSettings } = await import('./compactionSettings.js')

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

  // A missing, unreadable or oversized image fails the run. A model that
  // cannot see images does not: runAgent hands the images to the vision
  // helper, or tells the model the plan cannot read them.
  const { loadPromptImages } = await import('../core/imageInput.js')
  const imageAttachments = await loadPromptImages(opts.imagePaths ?? [], cwd)

  const { resolveProfileContextLength } = await import('../providers/modelContext.js')
  const contextNotices: string[] = []
  const started = Date.now()
  // One run per session at a time across processes (a chat bridge may be
  // working on the same session).
  const { withSessionLock } = await import('../storage/sessionLock.js')
  const compaction = await loadCompactionSettings(cwd, 'hosted')
  const result = await withSessionLock(sessionStore.getLockPath(session.id), async () => runAgent(
    // Re-read under the lock: another process (a chat bridge) may have saved
    // a turn between the existence check above and getting the lock.
    opts.sessionId ? await sessionStore.load(session.id, { fresh: true }) : session,
    prompt,
    {
    cwd,
    provider,
    sessionStore,
    permissionManager,
    maxTurns: Math.max(1, Math.min(200, opts.maxTurns ?? 60)),
    profile: 'main',
    appendUserMessage: true,
    // The main model's window; specialists with a smaller window are capped
    // further by their own provider metadata inside runAgent.
    contextLength: resolveProfileContextLength(providerConfig),
    // Hosted runs default to a 200K-token context cap (cost); see
    // services/compactionSettings.ts for the overrides.
    compaction,
    // Nobody reviews a headless turn as it runs: memories the model saves
    // without naming a scope stay in this workspace.
    memoryDefaultScope: 'project',
    // The process exits when the run returns: slow tools (image/video
    // generation, delegated tasks) run in the foreground so their result is
    // part of this run's reply instead of a background task that dies with it.
    allowBackgroundTools: false,
    ensureSpecialistProvider: providerRouter.ensureSpecialistProvider,
    resolveProvider: providerRouter.resolveProvider,
    resolveSummarizerProvider: providerRouter.resolveSummarizerProvider,
    onContextCompaction: (notice) => contextNotices.push(notice),
    onInfo: opts.onInfo,
    ...(imageAttachments.length ? { imageAttachments } : {}),
  }), { label: `Session ${session.id}` })

  return {
    reply: result.reply,
    turns: result.turns,
    sessionId: session.id,
    durationMs: Date.now() - started,
    contextNotices,
  }
}
