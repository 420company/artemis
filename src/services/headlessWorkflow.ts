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
  parseLongVideoCommand,
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
  /**
   * What the user picked in the app before sending (`artemis execute
   * --intent <name>`): long_video, image, research or reminder. Unknown
   * names are ignored with a warning. Its hint goes in the per-run context,
   * never into the stored message.
   */
  intent?: string
  /** Whether a video provider is configured (Saga can run at all). */
  hasVideoProvider: () => Promise<boolean>
  onInfo?: (message: string) => void
  now?: number
}

export const HEADLESS_INTENTS = ['long_video', 'image', 'research', 'reminder'] as const
export type HeadlessIntent = (typeof HEADLESS_INTENTS)[number]

/** A known intent name ("long-video", "Long_Video" and "longvideo" count), or undefined. */
export function normalizeHeadlessIntent(raw: string | undefined): HeadlessIntent | undefined {
  const key = (raw ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_')
  if (key === 'longvideo') return 'long_video'
  return (HEADLESS_INTENTS as readonly string[]).includes(key) ? key as HeadlessIntent : undefined
}

const INTENT_PLAIN_WORDS = 'When you talk to the user, describe what you do in plain words; never name workflows, tools, models or providers.'

const IMAGE_INTENT_HINT = [
  '[Run context — the user chose "image" in the app; this is not part of their message]',
  'The user wants an image. Make it with generate_image from their description (ask one short question only when the subject is missing).',
  'Say 「生成图片」 / "making your image" to the user. ' + INTENT_PLAIN_WORDS,
].join('\n')

const RESEARCH_INTENT_NOTE = [
  '[Run context — the user chose "research" in the app; this is not part of their message]',
  'The user wants a researched answer: look things up, compare sources and cite them; do not answer from memory alone. ' + INTENT_PLAIN_WORDS,
].join('\n')

const REMINDER_INTENT_HINT = [
  '[Run context — the user chose "reminder" in the app; this is not part of their message]',
  'The user wants something to happen later or repeatedly. Create it with the schedule tool (schedule_create from the artemis_online tools) and write the scheduled prompt as a complete instruction.',
  'Confirm in plain words when it runs, how often and what it will do. If no scheduling tool is available, say so plainly instead of pretending. ' + INTENT_PLAIN_WORDS,
].join('\n')

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

  // An intent the user picked in the app wins over routing and any pending
  // question: it is an explicit choice for this message.
  if (input.intent !== undefined) {
    const intent = normalizeHeadlessIntent(input.intent)
    if (!intent) {
      input.onInfo?.(`[intent] unknown intent "${input.intent}" ignored; known: ${HEADLESS_INTENTS.join(', ')}`)
    } else if (!input.autoRoute) {
      input.onInfo?.(`[intent] "${intent}" ignored for a read-only or unrouted run`)
    } else {
      delete state.sagaOffer
      delete state.sagaActiveAt
      const text = intent === 'long_video' ? (parseLongVideoCommand(prompt) ?? prompt).trim() : prompt
      if (intent === 'long_video' && text) {
        // Same as an explicit long-video command: no question first.
        state.sagaActiveAt = now
        writeState(input.session, state)
        return sagaRun(text, input.cwd, 'the user chose a long video')
      }
      writeState(input.session, state)
      if (intent === 'image') return { kind: 'run', prompt, workflow: 'direct', hint: IMAGE_INTENT_HINT }
      if (intent === 'reminder') return { kind: 'run', prompt, workflow: 'direct', hint: REMINDER_INTENT_HINT }
      if (intent === 'research') {
        const hint = buildRoutedWorkflowHint('plan', { cwd: input.cwd, userPrompt: prompt, reason: 'the user chose research' })
        return { kind: 'run', prompt, workflow: 'plan', hint: `${hint}\n\n${RESEARCH_INTENT_NOTE}` }
      }
      // long_video with no text: fall through to the normal path.
    }
  }

  // An answer to a pending Saga question.
  const offer = state.sagaOffer && now - state.sagaOffer.at < SAGA_SESSION_TTL_MS ? state.sagaOffer : undefined
  delete state.sagaOffer
  if (offer) {
    const answer = parseSagaOfferReply(prompt)
    if (answer === 'yes') {
      state.sagaActiveAt = now
      writeState(input.session, state)
      return sagaRun(offer.text, input.cwd, 'the user confirmed the long video')
    }
    if (answer === 'no') {
      prompt = offer.text
      sagaDeclined = true
    }
  }

  // "/longvideo …" (or the older "/saga …") is an explicit, immediate entry.
  const story = parseLongVideoCommand(prompt)
  if (story !== undefined) {
    if (story) {
      state.sagaActiveAt = now
      writeState(input.session, state)
      return sagaRun(story, input.cwd, 'explicit long-video command')
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
    return sagaRun(route.text, input.cwd, 'continuing the confirmed long video')
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
