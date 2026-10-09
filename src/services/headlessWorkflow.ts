/**
 * services/headlessWorkflow.ts — workflow routing for one headless run
 * (`artemis execute`, the web app).
 *
 * Every request goes through core/workflowRouter.ts. Saga is special: it
 * spends real money, so a request that only looks like a long-video request
 * is answered with a yes/no question and nothing else runs; the Saga
 * playbook starts after an explicit yes (or at once for "/saga …"). Each
 * run is a separate process, so the pending question and the active Saga
 * conversation live in the session's metadata, and the confirmed request
 * carries the `[Artemis Saga long video workflow]` marker in the stored
 * history (the generate_video → generate_long_video safety net in
 * core/agent.ts keys off it).
 */

import type { ChatProvider } from '../providers/types.js'
import type { SessionRecord } from '../core/types.js'
import {
  buildRoutedWorkflowHint,
  routeWorkflow,
  type AutoWorkflow,
} from '../core/workflowRouter.js'
import { buildSagaOfferQuestion, parseSagaOfferReply } from '../tools/visual/sagaWorkflow.js'

const SAGA_STATE_TTL_MS = 30 * 60 * 1000
export const SAGA_CONFIRMED_MARKER = '[Artemis Saga long video workflow] The user confirmed the Saga long-video workflow for this request.'

type WorkflowRoutingState = {
  /** A Saga question is waiting for yes / no. */
  sagaOffer?: { text: string; at: number }
  /** Saga was confirmed; short follow-ups ("9:16", "60秒") stay in it. */
  sagaActiveAt?: number
}

export type HeadlessWorkflowPlan =
  | { kind: 'reply'; reply: string }
  | { kind: 'run'; prompt: string; workflow: AutoWorkflow; hint: string; note?: string }

export interface PlanHeadlessWorkflowInput {
  session: SessionRecord
  prompt: string
  cwd: string
  attachmentCount: number
  inCodeRepo: boolean
  /** false: no routing at all (Goal Mode ticks, read-only analysis). */
  autoRoute: boolean
  getClassifier: () => Promise<ChatProvider | undefined>
  /** Whether a video provider is configured (Saga can run at all). */
  hasVideoProvider: () => Promise<boolean>
  onInfo?: (message: string) => void
  now?: number
}

function readState(session: SessionRecord): WorkflowRoutingState {
  const raw = session.metadata?.workflowRouting
  return raw && typeof raw === 'object' ? { ...(raw as WorkflowRoutingState) } : {}
}

function writeState(session: SessionRecord, state: WorkflowRoutingState): void {
  const clean: WorkflowRoutingState = {}
  if (state.sagaOffer) clean.sagaOffer = state.sagaOffer
  if (state.sagaActiveAt) clean.sagaActiveAt = state.sagaActiveAt
  const metadata = { ...(session.metadata ?? {}) }
  if (clean.sagaOffer || clean.sagaActiveAt) metadata.workflowRouting = clean
  else delete metadata.workflowRouting
  session.metadata = metadata
}

function sagaRun(prompt: string, cwd: string, note: string): HeadlessWorkflowPlan {
  return {
    kind: 'run',
    prompt,
    workflow: 'saga',
    hint: buildRoutedWorkflowHint('saga', { cwd, userPrompt: prompt, reason: note }),
    note,
  }
}

/**
 * Decide how this run proceeds. Mutates the session's metadata (the caller
 * saves it, or runAgent does).
 */
export async function planHeadlessWorkflow(input: PlanHeadlessWorkflowInput): Promise<HeadlessWorkflowPlan> {
  const now = input.now ?? Date.now()
  const state = readState(input.session)
  let prompt = input.prompt
  let sagaDeclined = false

  // An answer to a pending Saga question.
  const offer = state.sagaOffer && now - state.sagaOffer.at < SAGA_STATE_TTL_MS ? state.sagaOffer : undefined
  delete state.sagaOffer
  if (offer) {
    const answer = parseSagaOfferReply(prompt)
    if (answer === 'yes') {
      state.sagaActiveAt = now
      writeState(input.session, state)
      return sagaRun(`${offer.text}\n\n${SAGA_CONFIRMED_MARKER}`, input.cwd, 'the user confirmed Saga')
    }
    if (answer === 'no') {
      prompt = offer.text
      sagaDeclined = true
    }
  }

  // "/saga …" is an explicit, immediate entry.
  const explicitSaga = /^\s*\/saga(?:\s|$)/i.exec(prompt)
  if (explicitSaga) {
    const story = prompt.slice(explicitSaga[0].length).trim()
    if (story) {
      state.sagaActiveAt = now
      writeState(input.session, state)
      return sagaRun(`${story}\n\n${SAGA_CONFIRMED_MARKER}`, input.cwd, 'explicit /saga')
    }
  }

  if (!input.autoRoute) {
    delete state.sagaActiveAt
    writeState(input.session, state)
    return { kind: 'run', prompt, workflow: 'direct', hint: '' }
  }

  const route = await routeWorkflow(
    { text: prompt, attachmentCount: input.attachmentCount, inCodeRepo: input.inCodeRepo },
    { getClassifier: input.getClassifier, onInfo: input.onInfo },
  )

  // A confirmed Saga conversation keeps short replies ("9:16", "60秒", "1").
  const sagaActive = state.sagaActiveAt !== undefined && now - state.sagaActiveAt < SAGA_STATE_TTL_MS
  if (sagaActive && !sagaDeclined && route.workflow === 'direct' && route.reason !== 'question') {
    state.sagaActiveAt = now
    writeState(input.session, state)
    return sagaRun(route.text, input.cwd, 'continuing the confirmed Saga video')
  }
  delete state.sagaActiveAt

  if (route.workflow === 'saga') {
    if (!sagaDeclined && (await input.hasVideoProvider())) {
      state.sagaOffer = { text: route.text, at: now }
      writeState(input.session, state)
      const zh = /[㐀-鿿]/.test(route.text)
      return { kind: 'reply', reply: buildSagaOfferQuestion(zh ? 'zh-CN' : 'en') }
    }
    writeState(input.session, state)
    return { kind: 'run', prompt: route.text, workflow: 'direct', hint: '' }
  }

  writeState(input.session, state)
  if (route.workflow !== 'direct') input.onInfo?.(`[workflow] ${route.workflow} (${route.source}): ${route.reason}`)
  return {
    kind: 'run',
    prompt: route.text,
    workflow: route.workflow,
    hint: buildRoutedWorkflowHint(route.workflow, { cwd: input.cwd, userPrompt: route.text, reason: route.reason }),
  }
}
