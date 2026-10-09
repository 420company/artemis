/**
 * services/headlessWorkflow.ts — workflow routing for one headless run
 * (`artemis execute`, the web app).
 *
 * Every request goes through core/workflowRouter.ts. Saga is special: it
 * spends real money, so a request that only looks like a long-video request
 * is answered with a yes/no question and nothing else runs; the Saga
 * playbook starts after an explicit yes (or at once for "/saga …"). Each
 * run is a separate process, so the pending question and the active Saga
 * conversation live in the session's metadata with a timestamp
 * (core/sagaSessionState.ts); the stored messages stay the user's own. The
 * generate_video → generate_long_video safety net in core/agent.ts reads
 * that state. A confirmed Saga continues only for wizard-style answers
 * ("9:16", "60秒", "1", a timecoded brief) and ends when the long video is
 * generated or another request arrives.
 */

import type { ChatProvider } from '../providers/types.js'
import type { SessionRecord } from '../core/types.js'
import {
  buildRoutedWorkflowHint,
  routeWorkflow,
  type AutoWorkflow,
} from '../core/workflowRouter.js'
import {
  buildSagaOfferQuestion,
  looksLikeSagaWizardAnswer,
  parseSagaOfferReply,
} from '../tools/visual/sagaWorkflow.js'
import {
  hasFinishedLongVideo,
  readWorkflowRoutingState,
  SAGA_SESSION_TTL_MS,
  writeWorkflowRoutingState,
} from '../core/sagaSessionState.js'

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

const readState = readWorkflowRoutingState
const writeState = writeWorkflowRoutingState

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
  const offer = state.sagaOffer && now - state.sagaOffer.at < SAGA_SESSION_TTL_MS ? state.sagaOffer : undefined
  delete state.sagaOffer
  if (offer) {
    const answer = parseSagaOfferReply(prompt)
    if (answer === 'yes') {
      state.sagaActiveAt = now
      writeState(input.session, state)
      return sagaRun(offer.text, input.cwd, 'the user confirmed Saga')
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
      return sagaRun(story, input.cwd, 'explicit /saga')
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

  // A confirmed Saga conversation keeps wizard-style answers ("9:16",
  // "60秒", "1", a timecoded brief); any other request ends it.
  const sagaActive = state.sagaActiveAt !== undefined && now - state.sagaActiveAt < SAGA_SESSION_TTL_MS
  if (sagaActive && !sagaDeclined && looksLikeSagaWizardAnswer(prompt)) {
    state.sagaActiveAt = now
    writeState(input.session, state)
    return sagaRun(route.text, input.cwd, 'continuing the confirmed Saga video')
  }
  delete state.sagaActiveAt

  if (route.workflow === 'saga') {
    if (!sagaDeclined && (await input.hasVideoProvider())) {
      state.sagaOffer = { text: route.text, at: now }
      writeState(input.session, state)
      const zh = /[\u3400-\u9fff]/.test(route.text)
      // The web app renders the ```choices card as buttons.
      return { kind: 'reply', reply: buildSagaOfferQuestion(zh ? 'zh-CN' : 'en', 'choices') }
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

/** After a Saga run: a generated long video ends the Saga conversation. */
export function finishSagaIfGenerated(session: SessionRecord, newMessages: SessionRecord['messages']): boolean {
  if (!hasFinishedLongVideo(newMessages)) return false
  const state = readState(session)
  if (state.sagaActiveAt === undefined) return false
  delete state.sagaActiveAt
  writeState(session, state)
  return true
}
