/**
 * services/headlessAgent.ts — one-shot real agent execution outside the
 * interactive UI. The single bootstrap used by `artemis execute/analyze`,
 * Goal Mode ticks, and any future headless caller: resolve the user's
 * configured provider, wire the router/permissions/session store, and run
 * the REAL agent loop (core/agent.ts runAgent) with full tool access.
 */

import type { PermissionModeInput } from '../security/permissionModes.js'
import type { SessionRecord } from '../core/types.js'
import type { SessionStore } from '../storage/sessions.js'
import type { ApprovalRequest } from '../security/approvals.js'
import type { ProviderConfig } from '../providers/types.js'

export interface HeadlessAgentOptions {
  /** PRODUCER = full autonomous tools; read-only for analysis. Default PRODUCER. */
  permissionMode?: PermissionModeInput
  /** Override the configured model for this run. */
  model?: string
  /** Override the configured endpoint for this run (`--base-url`); needs `apiKey` when it is another endpoint. */
  baseUrl?: string
  /** Override the configured API key for this run (`--api-key`). */
  apiKey?: string
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
   * research, reminder, slides, document or spreadsheet (services/headlessWorkflow.ts). Unknown names are
   * ignored with a warning on onInfo.
   */
  intent?: string
  /**
   * Approvals (security/approvals.ts). `suspend`: stop at an ask-mode action
   * and leave a pending request in the session (`artemis execute`); without
   * it such actions are refused. Requests are bound to the host's public
   * key (ARTEMIS_APPROVAL_PUBKEY) and answered only with its signature.
   */
  approvals?: { suspend?: boolean }
  /**
   * Answer a pending approval request of `sessionId` instead of sending a
   * message: approve runs exactly the stored action once, deny runs nothing;
   * then the model continues. `prompt` is ignored.
   */
  answer?: { id: string; decision: 'approve' | 'deny'; reason?: string; expectDigest?: string; signature?: string }
  /**
   * Retry: take the conversation's last exchange (the owner's last message
   * and everything after it) out first, then run. An empty prompt runs the
   * same message again, with the intent and images it had; a prompt replaces
   * it (edit and resend). Needs `sessionId`.
   */
  retry?: boolean
  /**
   * With `retry`: the owner message id of the exchange the host asked to
   * replace. Checked under the session lock; another last exchange fails
   * the retry (SessionRewindError 'changed') instead of replacing it.
   */
  retryOf?: string
  /**
   * The message is not from the owner (a scheduled task, a trigger, a call's
   * follow-up, a connector that became ready): requests still waiting in the
   * conversation stay as they are. Only the owner's own message ends them.
   */
  keepApprovals?: boolean
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

/**
 * The main provider of a headless run. `--model`, `--base-url` and
 * `--api-key` together name a complete endpoint; otherwise they override the
 * configured main profile under the rules in providers/overrides.ts (another
 * endpoint needs its own key; a key alone only for a profile from the
 * owner's own store).
 */
export async function resolveHeadlessProviderConfig(
  cwd: string,
  overrides: { model?: string; baseUrl?: string; apiKey?: string },
  onInfo?: (message: string) => void,
): Promise<ProviderConfig> {
  const { resolveMainProviderConfig } = await import('../providers/onboarding.js')
  const { mainProfileIsFromOwnerStore, overrideProviderConfig } = await import('../providers/overrides.js')
  const model = overrides.model?.trim() || undefined
  const baseUrl = overrides.baseUrl?.trim() || undefined
  const apiKey = overrides.apiKey?.trim() || undefined
  if (model && baseUrl && apiKey) {
    return resolveMainProviderConfig({ cwd, config: { model, baseUrl, apiKey }, ...(onInfo ? { onInfo } : {}) })
  }
  const configured = await resolveMainProviderConfig({ cwd, config: {}, ...(onInfo ? { onInfo } : {}) })
  if (!model && !baseUrl && !apiKey) return configured
  return overrideProviderConfig(configured, { model, baseUrl, apiKey }, { ownerStore: await mainProfileIsFromOwnerStore(cwd) })
}

export async function runHeadlessAgent(
  cwd: string,
  prompt: string,
  opts: HeadlessAgentOptions = {},
): Promise<HeadlessAgentResult> {
  const { createTrackedProviderFromConfig } = await import('../providers/telemetry.js')
  const { createProviderRouter } = await import('../providers/router.js')
  const { PermissionManager } = await import('../security/permissions.js')
  const { SessionStore } = await import('../storage/sessions.js')
  const { runAgent, toolHeartbeatIntervalMs } = await import('../core/agent.js')
  const { loadCompactionSettings } = await import('./compactionSettings.js')

  if (opts.retry && !opts.sessionId) throw new Error('A retry needs the session it continues (--session <id>).')
  const onInfo = opts.onInfo ?? (() => undefined)
  // The web server's credential broker for this run: kept by this process,
  // removed from the environment before any tool or shell starts.
  const { captureCredentialBroker, claimCredentialBroker } = await import('../security/credentialStore.js')
  captureCredentialBroker()
  await claimCredentialBroker()
  const providerConfig = await resolveHeadlessProviderConfig(cwd, opts, onInfo)
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
  // A retry reads its message, intent and images from the session, under the lock.
  const imageAttachments = opts.retry ? [] : await loadPromptImages(opts.imagePaths ?? [], cwd)
  const sessionTurns = await import('../storage/sessionTurns.js')

  // Workflow routing (services/headlessWorkflow.ts): the user never names a
  // workflow; a Saga long video is only offered, never started unasked.
  const { createDelegationBudget } = await import('../core/workflowRouter.js')
  const { finishSagaIfGenerated, planHeadlessWorkflow } = await import('./headlessWorkflow.js')
  const { resolveWorkflowClassifierProvider } = await import('../providers/workflowClassifier.js')
  const { resolveConfiguredVisualProvider } = await import('../utils/visualGenerationConfig.js')
  const { resolveActiveVideoClipSeconds } = await import('../tools/visual/activeVideoModel.js')
  const { resolveArtemisHomeDir } = await import('../utils/fs.js')
  const { existsSync } = await import('node:fs')
  const { isAbsolute, join } = await import('node:path')
  const readOnly = (opts.permissionMode ?? 'PRODUCER') === 'read-only'

  // Live updates and status for the host (core/agentUpdates.ts, core/agentStatus.ts):
  // one stderr line each, through onInfo.
  const { AgentUpdateChannel } = await import('../core/agentUpdates.js')
  const { AgentStatusReporter } = await import('../core/agentStatus.js')
  const agentUpdates = readOnly ? undefined : new AgentUpdateChannel({ emit: onInfo })
  const agentStatus = new AgentStatusReporter(onInfo)
  const { resolveProfileContextLength } = await import('../providers/modelContext.js')
  const contextNotices: string[] = []
  const started = Date.now()
  // One run per session at a time across processes (a chat bridge may be
  // working on the same session).
  const { withSessionLock } = await import('../storage/sessionLock.js')
  const compaction = await loadCompactionSettings(cwd, 'hosted')
  const {
    hostApprovalKey,
    validateApprovalAnswer,
    grantOf,
    publicApproval,
    requestMessageOf,
    supersedePendingApprovals,
    ApprovalResumeError,
    APPROVAL_RESULT_PREFIX,
  } = await import('../security/approvals.js')
  // Requests are bound to the host's public key when the run has one: only the host's signature answers them.
  const hostKey = hostApprovalKey()
  const approvalSettings = {
    suspend: opts.approvals?.suspend === true,
    ...(hostKey ? { hostBinding: hostKey.id } : {}),
  }
  // The run is over: waiting for the owner when it stopped at a hard
  // approval request (by the request's kind) or ended with a card that asks
  // them something, else done.
  const finishStatus = async (ended: { reply?: string; approval?: ApprovalRequest }): Promise<void> => {
    const { statusAtEnd, statusForApprovalKind } = await import('../core/agentStatus.js')
    agentStatus.finish(ended.approval ? statusForApprovalKind(ended.approval.kind) : statusAtEnd(ended.reply ?? ''))
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
      ...(agentUpdates ? { agentUpdates } : {}),
      onToolActivity: (event: Parameters<typeof agentStatus.onToolActivity>[0]) => agentStatus.onToolActivity(event),
      onInfo: opts.onInfo,
      approvals: approvalSettings,
    }

    if (opts.answer) {
      // The owner answered a request this session stopped at. Checked and
      // marked used under the lock, before anything runs: an answer works once.
      let record
      try {
        record = validateApprovalAnswer(current, opts.answer.id, {
          decision: opts.answer.decision,
          ...(opts.answer.signature ? { signature: opts.answer.signature } : {}),
          ...(opts.answer.expectDigest ? { expectedDigest: opts.answer.expectDigest } : {}),
          ...(hostKey ? { hostKey } : {}),
        })
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
      const originalRequest = requestMessageOf(current, record)
        ?? [...current.messages].reverse().find((m) => m.role === 'user' && !isSyntheticUserMessage(m))?.content
        ?? ''
      const resumed = await runAgent(current, originalRequest, {
        ...agentOptions,
        approvals: { ...approvalSettings, resumed: { action: record.action, ok: opts.answer.decision === 'approve' && answered.ok } },
        appendUserMessage: false,
        delegationBudget: createDelegationBudget('direct'),
      })
      await finishStatus(resumed)
      return resumed
    }

    // A new message from the owner in this conversation: requests still
    // waiting from an earlier turn are stale (the owner moved on). They
    // expire here, and the host is told, so a late answer can never run an
    // old action. A message the host sends on its own keeps them.
    const superseded = opts.keepApprovals ? [] : supersedePendingApprovals(current)
    if (superseded.length) {
      await sessionStore.save(current)
      for (const record of superseded) onInfo(`${APPROVAL_RESULT_PREFIX} ${JSON.stringify({ id: record.id, decision: 'expired', reason: 'superseded' })}`)
    }

    let runPrompt = prompt
    let runIntent = opts.intent
    let runImagePaths = opts.imagePaths ?? []
    let runImages = imageAttachments
    if (opts.retry) {
      const { createSideEffectClassifier } = await import('./toolSideEffects.js')
      const exchange = sessionTurns.lastExchangeFor(current, await createSideEffectClassifier(cwd), opts.retryOf)
      if (!prompt.trim()) {
        runPrompt = exchange.recorded?.prompt ?? current.messages[exchange.startIndex]!.content
        if (!runImagePaths.length) runImagePaths = (exchange.recorded?.imagePaths ?? []).filter((file) => existsSync(file))
        // Files deleted since the first time are left out, and the agent is told so.
        const resent = sessionTurns.dropMissingAttachments(runPrompt, (file) => existsSync(isAbsolute(file) ? file : join(cwd, file)))
        if (resent.missing.length) {
          runPrompt = resent.prompt
          onInfo(`[session] retry: ${resent.missing.length} attachment(s) no longer exist and were left out`)
        }
      }
      runIntent = opts.intent ?? exchange.recorded?.intent
      // Images first: one that cannot be read fails the retry before anything is removed.
      runImages = await loadPromptImages(runImagePaths, cwd)
      sessionTurns.removeExchange(current, exchange)
      await sessionStore.save(current)
      onInfo(`[session] retry: removed the last exchange (${exchange.messageCount} messages)`)
    }
    const knownIds = new Set(current.messages.map((message) => message.id))
    // What a later retry needs: where this turn starts and what it was asked
    // with. Recorded as soon as the owner's message is stored (marked open),
    // so a run that fails, is stopped or killed can still be retried as asked;
    // closed with the message the turn ended at once the run is over.
    const turnFields = () => ({
      prompt: runPrompt,
      ...(runIntent !== undefined ? { intent: runIntent } : {}),
      ...(runImagePaths.length ? { imagePaths: runImagePaths } : {}),
    })
    let turnMessageId: string | undefined
    const appendMessage = sessionStore.appendMessage.bind(sessionStore)
    sessionStore.appendMessage = (target, role, content, name) => {
      const updated = appendMessage(target, role, content, name)
      if (turnMessageId === undefined && target === current && role === 'user') {
        const asked = sessionTurns.firstNewOwnerMessage(current.messages, knownIds)
        if (asked) {
          turnMessageId = asked.id
          // Saved with the message by the caller's next save.
          sessionTurns.recordLastTurn(current, { userMessageId: asked.id, ...turnFields() }, { open: true })
        }
      }
      return updated
    }
    const recordTurn = async () => {
      sessionStore.appendMessage = appendMessage
      if (turnMessageId === undefined) return
      sessionTurns.recordLastTurn(current, { userMessageId: turnMessageId, ...turnFields() })
      await sessionStore.save(current)
    }
    const plan = await planHeadlessWorkflow({
      session: current,
      prompt: runPrompt,
      cwd,
      attachmentCount: runImages.length,
      inCodeRepo: existsSync(join(cwd, '.git')),
      // Goal Mode ticks are written by Artemis; read-only analysis only reads.
      autoRoute: opts.autoRoute !== false && !readOnly,
      // Only a configured worker model classifies; never the main model.
      getClassifier: () => resolveWorkflowClassifierProvider([cwd, resolveArtemisHomeDir()], cwd),
      hasVideoProvider: async () => Boolean(await resolveConfiguredVisualProvider(cwd, 'video')),
      videoClipSeconds: () => resolveActiveVideoClipSeconds(cwd),
      onInfo,
      ...(runIntent !== undefined ? { intent: runIntent } : {}),
    })
    if (plan.kind === 'reply') {
      agentStatus.finish()
      // The Saga question: answered without running the model.
      sessionStore.appendMessage(current, 'user', runPrompt)
      sessionStore.appendMessage(current, 'assistant', plan.reply)
      await sessionStore.save(current)
      await recordTurn()
      return { reply: plan.reply, turns: 0 }
    }
    const messagesBefore = current.messages.length
    agentStatus.thinking()
    // Talking about trading: the platform's trading playbook rides along for this turn.
    const { withTradingPlaybook } = await import('../core/tradingPlaybook.js')
    const workflowHint = plan.workflow === 'saga' ? plan.hint : withTradingPlaybook(plan.hint, plan.prompt)
    let runResult
    try {
    runResult = await runAgent(
    current,
    // A retired workflow slash word ("/niko …") is already removed.
    plan.prompt,
    {
    ...agentOptions,
    ...(workflowHint ? { workflowHint } : {}),
    // Every run is bounded, routed or not (Goal Mode and analysis: direct cap).
    delegationBudget: createDelegationBudget(plan.workflow),
    appendUserMessage: true,
    // Verify before done: the main path checks its own work once (bounded).
    selfCheck: opts.selfCheck !== false && !readOnly && plan.workflow !== 'saga',
    ...(runImages.length ? { imageAttachments: runImages } : {}),
  })
    // A generated long video ends the Saga conversation of this session.
    if (plan.workflow === 'saga' && finishSagaIfGenerated(current, current.messages.slice(messagesBefore))) {
      await sessionStore.save(current)
    }
    } finally {
      // Closed whether the run answered or failed (a killed process leaves it open).
      await recordTurn().catch(() => undefined)
    }
    await finishStatus(runResult)
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
