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
import type { ApprovalRequest } from '../security/approvals.js'

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
  /**
   * Pick the workflow from the request (core/workflowRouter.ts). Default
   * true; Goal Mode ticks pass false (their prompt is written by Artemis).
   */
  autoRoute?: boolean
  /**
   * End-of-run self-check ("verify before done", core/selfCheck.ts).
   * Default true; Goal Mode ticks pass false. Never for a Saga run or a
   * read-only analysis.
   */
  selfCheck?: boolean
  /**
   * What the user picked in the app (`--intent`): video, long_video, image,
   * research or reminder (services/headlessWorkflow.ts). Unknown names are
   * ignored with a warning on onInfo.
   */
  intent?: string
  /**
   * Approvals (security/approvals.ts). `suspend`: stop at an ask-mode action
   * and leave a pending request in the session (`artemis execute`); without
   * it such actions are refused. `hostSecret`: the host's per-run secret;
   * requests are bound to it and can only be answered with it.
   */
  approvals?: { suspend?: boolean; hostSecret?: string }
  /**
   * Answer a pending approval request of `sessionId` instead of sending a
   * message: approve runs exactly the stored action once, deny runs nothing;
   * then the model continues. `prompt` is ignored.
   */
  answer?: { id: string; decision: 'approve' | 'deny'; reason?: string }
}

export interface HeadlessAgentResult {
  reply: string
  turns: number
  sessionId: string
  durationMs: number
  /** One short line per context compaction that happened during the run. */
  contextNotices: string[]
  /** The run stopped at this approval request (nothing sensitive ran). */
  approval?: ApprovalRequest
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
  const { runAgent, toolHeartbeatIntervalMs } = await import('../core/agent.js')
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
  // helper, or tells the model they could not be read right now.
  const { loadPromptImages } = await import('../core/imageInput.js')
  const imageAttachments = await loadPromptImages(opts.imagePaths ?? [], cwd)

  // Workflow routing (services/headlessWorkflow.ts): the user never names a
  // workflow; a Saga long video is only offered, never started unasked.
  const { createDelegationBudget } = await import('../core/workflowRouter.js')
  const { finishSagaIfGenerated, planHeadlessWorkflow } = await import('./headlessWorkflow.js')
  const { resolveWorkflowClassifierProvider } = await import('../providers/workflowClassifier.js')
  const { resolveConfiguredVisualProvider } = await import('../utils/visualGenerationConfig.js')
  const { resolveActiveVideoClipSeconds } = await import('../tools/visual/activeVideoModel.js')
  const { resolveArtemisHomeDir } = await import('../utils/fs.js')
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const readOnly = (opts.permissionMode ?? 'PRODUCER') === 'read-only'

  const { resolveProfileContextLength } = await import('../providers/modelContext.js')
  const contextNotices: string[] = []
  const started = Date.now()
  // One run per session at a time across processes (a chat bridge may be
  // working on the same session).
  const { withSessionLock } = await import('../storage/sessionLock.js')
  const compaction = await loadCompactionSettings(cwd, 'hosted')
  const { hostBindingOf, validateApprovalAnswer, grantOf, publicApproval, ApprovalResumeError, APPROVAL_RESULT_PREFIX } = await import('../security/approvals.js')
  const approvalSettings = {
    suspend: opts.approvals?.suspend === true,
    ...(opts.approvals?.hostSecret ? { hostBinding: hostBindingOf(opts.approvals.hostSecret) } : {}),
  }
  const result = await withSessionLock(sessionStore.getLockPath(session.id), async () => {
    // Re-read under the lock: another process (a chat bridge) may have saved
    // a turn between the existence check above and getting the lock.
    const current = opts.sessionId ? await sessionStore.load(session.id, { fresh: true }) : session
    const agentOptions = {
      cwd,
      provider,
      sessionStore,
      permissionManager,
      maxTurns: Math.max(1, Math.min(200, opts.maxTurns ?? 60)),
      profile: 'main' as const,
      // The main model's window; specialists with a smaller window are capped
      // further by their own provider metadata inside runAgent.
      contextLength: resolveProfileContextLength(providerConfig),
      // Hosted runs default to a 200K-token context cap (cost); see
      // services/compactionSettings.ts for the overrides.
      compaction,
      // Nobody reviews a headless turn as it runs: memories the model saves
      // without naming a scope stay in this workspace.
      memoryDefaultScope: 'project' as const,
      // The process exits when the run returns: slow tools (image/video
      // generation, delegated tasks) run in the foreground so their result is
      // part of this run's reply instead of a background task that dies with it.
      allowBackgroundTools: false,
      // ...and while one runs, a progress line every minute tells the host the
      // run is alive (a Saga long video can take an hour in one tool call).
      toolHeartbeatMs: toolHeartbeatIntervalMs(),
      ensureSpecialistProvider: providerRouter.ensureSpecialistProvider,
      resolveProvider: providerRouter.resolveProvider,
      resolveSummarizerProvider: providerRouter.resolveSummarizerProvider,
      onContextCompaction: (notice: string) => contextNotices.push(notice),
      onInfo: opts.onInfo,
      approvals: approvalSettings,
    }

    if (opts.answer) {
      // The owner answered a request this session stopped at. Checked and
      // marked used under the lock, before anything runs: an answer works once.
      let record
      try {
        record = validateApprovalAnswer(current, opts.answer.id, { hostSecret: opts.approvals?.hostSecret })
      } catch (error) {
        // An expired or altered request is marked so; it can never be used.
        if (error instanceof ApprovalResumeError && (error.code === 'approval_expired' || error.code === 'approval_tampered')) await sessionStore.save(current)
        throw error
      }
      record.status = opts.answer.decision === 'approve' ? 'approved' : 'denied'
      record.decidedAt = new Date().toISOString()
      if (opts.answer.reason) record.reason = opts.answer.reason
      await sessionStore.save(current)
      onInfo(`${APPROVAL_RESULT_PREFIX} ${JSON.stringify({ id: record.id, decision: opts.answer.decision })}`)
      const { recordApprovalAnswer } = await import('../core/agent.js')
      const answered = await recordApprovalAnswer(current, {
        request: publicApproval(record),
        action: record.action,
        grant: grantOf(record),
        decision: opts.answer.decision,
        ...(opts.answer.reason ? { reason: opts.answer.reason } : {}),
      }, { ...agentOptions, delegationBudget: createDelegationBudget('direct') })
      // The model goes on from the recorded result, on the owner's original request.
      const { isSyntheticUserMessage } = await import('../core/compaction/language.js')
      const originalRequest = [...current.messages].reverse().find((m) => m.role === 'user' && !isSyntheticUserMessage(m))?.content ?? ''
      return runAgent(current, originalRequest, {
        ...agentOptions,
        approvals: { ...approvalSettings, resumed: { action: record.action, ok: opts.answer.decision === 'approve' && answered.ok } },
        appendUserMessage: false,
        delegationBudget: createDelegationBudget('direct'),
      })
    }

    const plan = await planHeadlessWorkflow({
      session: current,
      prompt,
      cwd,
      attachmentCount: imageAttachments.length,
      inCodeRepo: existsSync(join(cwd, '.git')),
      // Goal Mode ticks are written by Artemis; read-only analysis only reads.
      autoRoute: opts.autoRoute !== false && !readOnly,
      // Only a configured worker model classifies; never the main model.
      getClassifier: () => resolveWorkflowClassifierProvider([cwd, resolveArtemisHomeDir()], cwd),
      hasVideoProvider: async () => Boolean(await resolveConfiguredVisualProvider(cwd, 'video')),
      videoClipSeconds: () => resolveActiveVideoClipSeconds(cwd),
      onInfo,
      ...(opts.intent !== undefined ? { intent: opts.intent } : {}),
    })
    if (plan.kind === 'reply') {
      // The Saga question: answered without running the model.
      sessionStore.appendMessage(current, 'user', prompt)
      sessionStore.appendMessage(current, 'assistant', plan.reply)
      await sessionStore.save(current)
      return { reply: plan.reply, turns: 0 }
    }
    const messagesBefore = current.messages.length
    const runResult = await runAgent(
    current,
    // A retired workflow slash word ("/niko …") is already removed.
    plan.prompt,
    {
    ...agentOptions,
    ...(plan.hint ? { workflowHint: plan.hint } : {}),
    // Every run is bounded, routed or not (Goal Mode and analysis: direct cap).
    delegationBudget: createDelegationBudget(plan.workflow),
    appendUserMessage: true,
    // Verify before done: the main path checks its own work once (bounded).
    selfCheck: opts.selfCheck !== false && !readOnly && plan.workflow !== 'saga',
    ...(imageAttachments.length ? { imageAttachments } : {}),
  })
    // A generated long video ends the Saga conversation of this session.
    if (plan.workflow === 'saga' && finishSagaIfGenerated(current, current.messages.slice(messagesBefore))) {
      await sessionStore.save(current)
    }
    return runResult
  }, { label: `Session ${session.id}` })

  return {
    reply: result.reply,
    turns: result.turns,
    sessionId: session.id,
    durationMs: Date.now() - started,
    contextNotices,
    ...('approval' in result && result.approval ? { approval: result.approval } : {}),
  }
}
