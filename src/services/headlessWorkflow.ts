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
  classifyVideoRequestLength,
  looksLikeSagaWizardAnswer,
  parseLongVideoCommand,
  parseRequestedVideoSeconds,
  parseSagaOfferReply,
} from '../tools/visual/sagaWorkflow.js'
import {
  hasFinishedLongVideo,
  readWorkflowRoutingState,
  SAGA_SESSION_TTL_MS,
  writeWorkflowRoutingState,
} from '../core/sagaSessionState.js'
import { buildOfficeHint, detectOfficeRequest } from '../tools/office/officeHint.js'

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
   * --intent <name>`): video, long_video, image, research, reminder,
   * slides, document or spreadsheet.
   * Unknown names are ignored with a warning. Its hint goes in the per-run
   * context, never into the stored message.
   */
  intent?: string
  /** L, the configured video model's longest single clip (undefined: no video model). */
  videoClipSeconds?: () => Promise<number | undefined>
  /** Whether a video provider is configured (Saga can run at all). */
  hasVideoProvider: () => Promise<boolean>
  onInfo?: (message: string) => void
  now?: number
}

export const HEADLESS_INTENTS = ['video', 'long_video', 'image', 'research', 'reminder', 'slides', 'document', 'spreadsheet'] as const
export type HeadlessIntent = (typeof HEADLESS_INTENTS)[number]

const INTENT_ALIASES: Record<string, HeadlessIntent> = {
  longvideo: 'long_video',
  ppt: 'slides',
  pptx: 'slides',
  deck: 'slides',
  presentation: 'slides',
  doc: 'document',
  docx: 'document',
  word: 'document',
  report: 'document',
  sheet: 'spreadsheet',
  excel: 'spreadsheet',
  xlsx: 'spreadsheet',
}

/** A known intent name ("long-video", "Long_Video" and "longvideo" count; "ppt", "excel"… too), or undefined. */
export function normalizeHeadlessIntent(raw: string | undefined): HeadlessIntent | undefined {
  const key = (raw ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_')
  if (INTENT_ALIASES[key]) return INTENT_ALIASES[key]
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

function videoSingleClipHint(seconds: number | undefined, maxClipSeconds: number | undefined, original?: string): string {
  return [
    '[Run context — the user chose "video" in the app; this is not part of their message]',
    original ? `Their request: ${original}` : undefined,
    `Make ONE video clip with generate_video${seconds ? ` (duration: ${seconds})` : ''}; it fits in a single clip${maxClipSeconds ? ` (the video model renders up to ${maxClipSeconds} s per clip)` : ''}. Do not start a long video.`,
    'Say 「生成视频」 / "making your video" to the user. ' + INTENT_PLAIN_WORDS,
  ].filter(Boolean).join('\n')
}

/** Length choices for "how long?", derived from L: [5, 10, L, 30, 60], plus "longer" when that leaves fewer than five. */
export function videoLengthChoices(maxClipSeconds: number, zh: boolean): Array<{ label: string; seconds?: number }> {
  const seconds = Array.from(new Set([5, 10, maxClipSeconds, 30, 60].filter((value) => value >= 1))).sort((a, b) => a - b)
  const label = (value: number) => (zh
    ? (value % 60 === 0 ? `${value / 60} 分钟` : `${value} 秒`)
    : (value % 60 === 0 ? `${value / 60} minute${value === 60 ? '' : 's'}` : `${value} seconds`))
  const choices: Array<{ label: string; seconds?: number }> = seconds.map((value) => ({ label: label(value), seconds: value }))
  if (choices.length < 5) choices.push({ label: zh ? '更长，我来说' : "Longer, I'll say" })
  return choices
}

function buildVideoLengthQuestion(maxClipSeconds: number, zh: boolean): string {
  const card = JSON.stringify({ options: videoLengthChoices(maxClipSeconds, zh).map((choice) => choice.label) })
  return `${zh ? '要做多长的视频？' : 'How long should the video be?'}\n\n\`\`\`choices\n${card}\n\`\`\`\n${zh ? '也可以直接回复时长，例如“20 秒”。' : 'You can also reply with a length, e.g. "20 seconds".'}`
}

/** Longest video; a longer answer is clamped (as the long-video tool does). */
const MAX_VIDEO_SECONDS = 600
/** Answers above this are confirmed once before anything starts. */
const MAX_VIDEO_SECONDS_WITHOUT_CONFIRMATION = 300

/** A short reply that is neither a length nor a request ("嗯", "随便", "?", "ok"). */
function isUnclearShortReply(reply: string): boolean {
  const text = reply.trim()
  if (!text) return true
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length ?? 0
  const words = text.split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length
  return cjk <= 4 && words <= 2 && text.length <= 12
}

/** Runs the video the user chose a length for: one clip up to L, else a long video. */
function startChosenVideo(
  input: PlanHeadlessWorkflowInput,
  state: ReturnType<typeof readWorkflowRoutingState>,
  now: number,
  prompt: string,
  question: { text: string },
  answer: number | 'longer',
  L: number | undefined,
): HeadlessWorkflowPlan {
  if (answer !== 'longer' && L !== undefined && answer <= L) {
    writeState(input.session, state)
    return { kind: 'run', prompt, workflow: 'direct', hint: videoSingleClipHint(answer, L, question.text) }
  }
  state.sagaActiveAt = now
  writeState(input.session, state)
  const reason = answer === 'longer'
    ? `the user chose a long video for their previous request ("${question.text.slice(0, 200)}"); ask for the length if it is still missing`
    : `the user chose a ${answer}-second video for their previous request ("${question.text.slice(0, 200)}")`
  return sagaRun(prompt, input.cwd, reason)
}

/**
 * The answer to "how long?": a length in seconds, 'longer', or undefined
 * when the reply is not a length. Buttons send their labels ("10 秒",
 * "1 分钟"), so a bare number is seconds ("5", "20"), never a button index.
 */
export function parseVideoLengthAnswer(reply: string): number | 'longer' | undefined {
  const text = reply.trim().replace(/[\s!！。.~]+$/u, '')
  if (/^(?:更长|更长[，,]?\s*我来说|再长(?:一点|些)?|长一点|longer|longer,?\s*i'?ll say)$/i.test(text)) return 'longer'
  const bare = /^(\d{1,3})\s*(?:s|秒|secs?|seconds?)?$/i.exec(text)
  if (bare) return Number(bare[1]) > 0 ? Number(bare[1]) : undefined
  if (text.length > 24) return undefined
  const seconds = parseRequestedVideoSeconds(text)
  return seconds !== undefined && seconds > 0 ? seconds : undefined
}

function buildVideoLengthRetry(maxClipSeconds: number, zh: boolean): string {
  const card = JSON.stringify({ options: videoLengthChoices(maxClipSeconds, zh).map((choice) => choice.label) })
  return `${zh ? '没看懂想要多长，请选一个时长，或直接回复秒数，例如“20”。' : 'I did not catch the length. Pick one, or reply with a number of seconds such as "20".'}\n\n\`\`\`choices\n${card}\n\`\`\``
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

  // An answer to "how long should the video be?" (the video intent). Only
  // for a routed run: a read-only analysis or a Goal Mode tick leaves the
  // question waiting.
  const lengthQuestion = input.autoRoute && state.videoLengthQuestion && now - state.videoLengthQuestion.at < SAGA_SESSION_TTL_MS ? state.videoLengthQuestion : undefined
  if (lengthQuestion) delete state.videoLengthQuestion
  if (lengthQuestion && (input.intent === undefined || normalizeHeadlessIntent(input.intent) === 'video')) {
    const L = await input.videoClipSeconds?.()
    const zh = /[\u3400-\u9fff]/.test(lengthQuestion.text)
    const reply = prompt.trim()
    // A very long length asked once more first ("要做 10 分钟这么长吗？").
    if (lengthQuestion.confirmSeconds !== undefined) {
      const confirm = parseSagaOfferReply(reply)
      if (confirm === 'yes') return startChosenVideo(input, state, now, prompt, lengthQuestion, lengthQuestion.confirmSeconds, L)
      if (confirm === 'no') {
        writeState(input.session, state)
        return { kind: 'reply', reply: zh ? '好的，先不做了。需要时告诉我想要多长就行。' : 'OK, no video for now. Tell me the length whenever you like.' }
      }
    }
    const answer = L === undefined ? undefined : parseVideoLengthAnswer(reply)
    if (L !== undefined && answer !== undefined) {
      if (answer !== 'longer' && answer > MAX_VIDEO_SECONDS_WITHOUT_CONFIRMATION && lengthQuestion.confirmSeconds === undefined) {
        const seconds = Math.min(answer, MAX_VIDEO_SECONDS)
        state.videoLengthQuestion = { text: lengthQuestion.text, at: now, retried: lengthQuestion.retried, confirmSeconds: seconds }
        writeState(input.session, state)
        const minutes = Math.round((seconds / 60) * 10) / 10
        const card = JSON.stringify({ options: zh ? ['好，开始', '不用了'] : ['Yes, go ahead', 'No thanks'] })
        return { kind: 'reply', reply: `${zh ? `要做 ${minutes} 分钟这么长吗？` : `Make it ${minutes} minutes long?`}\n\n\`\`\`choices\n${card}\n\`\`\`` }
      }
      return startChosenVideo(input, state, now, prompt, lengthQuestion, answer === 'longer' ? 'longer' : Math.min(answer, MAX_VIDEO_SECONDS), L)
    }
    if (L !== undefined) {
      if (parseSagaOfferReply(reply) === 'no') {
        // "不用了" / "cancel": the question ends here.
        writeState(input.session, state)
        return { kind: 'reply', reply: zh ? '好的，先不做了。' : 'OK, no video then.' }
      }
      if (isUnclearShortReply(reply)) {
        if (!lengthQuestion.retried) {
          // Ask once more, briefly; the request stays the original one.
          state.videoLengthQuestion = { text: lengthQuestion.text, at: now, retried: true }
          writeState(input.session, state)
          return { kind: 'reply', reply: buildVideoLengthRetry(L, zh) }
        }
        // Asked twice already: stop asking rather than loop.
        writeState(input.session, state)
        return { kind: 'reply', reply: zh ? '好的，先不做了。想做的时候告诉我时长就行。' : 'OK, I will leave it for now. Tell me the length whenever you like.' }
      }
      // Anything else is a new request: the question is dropped and the
      // message is handled as usual below (a sticky video intent classifies
      // the new text on its own).
    }
  }

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
      delete state.videoLengthQuestion
      if (intent === 'video') {
        // The user chose a video; whether it is one clip or a long video
        // follows from the length and the model's longest clip (L).
        const L = await input.videoClipSeconds?.()
        if (L === undefined) {
          writeState(input.session, state)
          return { kind: 'run', prompt, workflow: 'direct', hint: videoSingleClipHint(undefined, undefined) }
        }
        const fit = classifyVideoRequestLength(prompt, L)
        if (fit.kind === 'long') {
          state.sagaActiveAt = now
          writeState(input.session, state)
          return sagaRun(prompt, input.cwd, 'the user chose a video longer than one clip')
        }
        if (fit.kind === 'single') {
          writeState(input.session, state)
          return { kind: 'run', prompt, workflow: 'direct', hint: videoSingleClipHint(fit.seconds, L) }
        }
        state.videoLengthQuestion = { text: prompt, at: now }
        writeState(input.session, state)
        return { kind: 'reply', reply: buildVideoLengthQuestion(L, /[\u3400-\u9fff]/.test(prompt)) }
      }
      if (intent === 'long_video' && text) {
        // Same as an explicit long-video command: no question first.
        state.sagaActiveAt = now
        writeState(input.session, state)
        return sagaRun(text, input.cwd, 'the user chose a long video')
      }
      writeState(input.session, state)
      if (intent === 'image') return { kind: 'run', prompt, workflow: 'direct', hint: IMAGE_INTENT_HINT }
      if (intent === 'reminder') return { kind: 'run', prompt, workflow: 'direct', hint: REMINDER_INTENT_HINT }
      if (intent === 'slides' || intent === 'document' || intent === 'spreadsheet') {
        return { kind: 'run', prompt, workflow: 'direct', hint: buildOfficeHint(intent, true) }
      }
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
    { text: prompt, attachmentCount: input.attachmentCount, inCodeRepo: input.inCodeRepo, maxClipSeconds: await input.videoClipSeconds?.() },
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
  const routedHint = buildRoutedWorkflowHint(route.workflow, { cwd: input.cwd, userPrompt: route.text, reason: route.reason })
  // A plain request for a deck, document or spreadsheet gets the office playbook too.
  const office = detectOfficeRequest(route.text)
  return {
    kind: 'run',
    prompt: route.text,
    workflow: route.workflow,
    hint: office ? [routedHint, buildOfficeHint(office, false)].filter(Boolean).join('\n\n') : routedHint,
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
