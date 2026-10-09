#!/usr/bin/env tsx
/**
 * scripts/evalZh/worker.ts — runs ONE user message of an eval task through
 * the real headless path (services/headlessAgent.ts runHeadlessAgent, what
 * `artemis execute` runs), or one LLM-judge call, in its own process.
 *
 * The runner (scripts/evalZh.ts) starts it with ARTEMIS_HOME and HOME set to
 * the task's temporary directories, so nothing of the operator's own state is
 * read or written. Usage lines go to stdout as `@@EVAL {json}` (the runner
 * enforces budgets from them); the full result goes to job.outFile.
 *
 * Usage: node --import tsx scripts/evalZh/worker.ts <job.json>
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildLongChat } from './assets.js'
import { buildJudgePrompt, JUDGE_SYSTEM, parseJudgeReply } from './judge.js'
import { TrafficMeter } from './meter.js'
import { startMockServer, type MockServerHandle } from './mockServer.js'
import type {
  JudgeOutcome,
  ToolEvent,
  TranscriptEntry,
  TurnTrace,
  Usage,
  WorkerJob,
  WorkerJudgeJob,
  WorkerTurnJob,
} from './types.js'

const MARK = '@@EVAL '
const emit = (event: Record<string, unknown>): void => {
  process.stdout.write(`\n${MARK}${JSON.stringify(event)}\n`)
}

const MOCK_PROFILE_ID = 'eval-mock'
const DUMMY_VIDEO_BASE_URL = 'http://127.0.0.1:9/eval-dummy-video'
const TRANSCRIPT_ENTRY_CHARS = 4_000
const TOOL_OUTPUT_CHARS = 20_000

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[${text.length - max} more chars]` : text
}

/** Point the mock profile at this process's mock server. */
async function wireMockProfile(baseUrl: string): Promise<void> {
  const { createGlobalProviderStore } = await import('../../src/providers/store.js')
  const store = createGlobalProviderStore()
  const data = await store.load() as any
  for (const profile of data.profiles ?? []) if (profile.id === MOCK_PROFILE_ID) profile.baseUrl = baseUrl
  await store.save(data)
}

async function applySetup(job: WorkerTurnJob): Promise<void> {
  const { ProviderStore } = await import('../../src/providers/store.js')
  if (job.setup.maxContextTokens) {
    // The workspace store, for convenience: the cap stays next to the task's
    // workspace. A global setup.agent.compression value would apply too
    // (services/compactionSettings.ts merges workspace > global per field).
    const store = new ProviderStore(job.cwd)
    const data = await store.load() as any
    data.setup = { ...(data.setup ?? {}), agent: { ...(data.setup?.agent ?? {}), compression: { ...(data.setup?.agent?.compression ?? {}), maxContextTokens: job.setup.maxContextTokens } } }
    await store.save(data)
  }
  if (job.setup.videoProvider) {
    // An unreachable endpoint with a dummy key: the router sees "a video
    // provider is configured" (so it offers Saga), and any generation call
    // would fail at once instead of spending money.
    const store = new ProviderStore(job.cwd)
    const data = await store.load() as any
    data.visualProfile = {
      enabled: true,
      video: { enabled: true, provider: 'byteplus', apiKey: 'eval-dummy-key', baseUrl: DUMMY_VIDEO_BASE_URL, model: 'eval-dummy-video' },
    }
    await store.save(data)
  }
}

/** The tool call recorded in a stored tool result ({ok, action, output}), also when the output was spilled. */
function parseToolMessage(name: string | undefined, content: string): ToolEvent | undefined {
  let parsed: { ok?: unknown; action?: Record<string, unknown>; output?: unknown } | undefined
  try {
    parsed = JSON.parse(content)
  } catch {
    const head = content.match(/^\{\s*"ok":\s*(true|false),\s*"action":\s*(\{[\s\S]*?\n {2}\}),/)
    if (head) {
      try { parsed = { ok: head[1] === 'true', action: JSON.parse(head[2]!), output: content } } catch { /* fall through */ }
    }
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.action) {
    return name ? { name, args: {}, output: truncate(content, TOOL_OUTPUT_CHARS) } : undefined
  }
  const { type, ...args } = parsed.action
  return {
    name: typeof type === 'string' ? type : name ?? 'unknown',
    args,
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : undefined,
    output: truncate(typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output ?? ''), TOOL_OUTPUT_CHARS),
  }
}

function parseUsageLine(line: string, into: Usage): void {
  const match = line.match(/^\[usage\] profile=\S+ (.*)$/)
  if (!match) return
  const field = (key: string) => Number(match[1]!.match(new RegExp(`\\b${key}=(\\d+)`))?.[1] ?? 0)
  into.requests += 1
  into.inputTokens += field('prompt')
  into.outputTokens += field('completion')
}

async function runTurn(job: WorkerTurnJob): Promise<TurnTrace> {
  const meter = new TrafficMeter({
    offline: job.mode === 'mock',
    probes: job.probes,
    onUsage: (usage) => emit({ type: 'usage', input: usage.input, output: usage.output }),
  })
  meter.install()

  let mock: MockServerHandle | undefined
  if (job.mode === 'mock') {
    mock = await startMockServer(job.mock?.steps ?? [], job.mock?.aux ?? [])
    await wireMockProfile(mock.baseUrl)
  }
  await applySetup(job)

  const { SessionStore } = await import('../../src/storage/sessions.js')
  const { runHeadlessAgent } = await import('../../src/services/headlessAgent.js')
  const { settleBeforeExit } = await import('../../src/core/backgroundCuration.js')
  const { readWorkflowRoutingState } = await import('../../src/core/sagaSessionState.js')

  const store = new SessionStore(job.cwd)
  let sessionId = job.sessionId
  if (!sessionId && job.seedHistory) {
    const session = store.createSession({ title: 'eval: seeded conversation' })
    for (const message of buildLongChat(job.seedHistory)) store.appendMessage(session, message.role, message.content)
    await store.save(session)
    sessionId = session.id
  }

  const infos: string[] = []
  const mainUsage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0 }
  const startedIso = new Date(Date.now() - 1).toISOString()
  const started = Date.now()
  let reply = ''
  let modelTurns = 0
  let contextNotices: string[] = []
  let error: string | undefined
  try {
    const result = await runHeadlessAgent(job.cwd, job.prompt, {
      maxTurns: job.maxTurns,
      ...(sessionId ? { sessionId } : {}),
      ...(job.imagePaths.length ? { imagePaths: job.imagePaths } : {}),
      sessionTitle: `eval: ${job.prompt.slice(0, 40)}`,
      onInfo: (message) => {
        infos.push(message)
        parseUsageLine(message, mainUsage)
      },
    })
    reply = result.reply
    modelTurns = result.turns
    sessionId = result.sessionId
    contextNotices = result.contextNotices
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  // Curators (memory, learned skills) finish before the process exits, as in `artemis execute`.
  await settleBeforeExit()
  await meter.flush()
  const durationMs = Date.now() - started

  const tools: ToolEvent[] = []
  const transcript: TranscriptEntry[] = []
  let workflow = 'direct'
  const routed = infos.map((line) => line.match(/^\[workflow\] (plan|team|compare|design|saga) \(/)?.[1]).find(Boolean)
  if (routed) workflow = routed
  if (sessionId) {
    try {
      const session = await store.load(sessionId, { fresh: true })
      const routing = readWorkflowRoutingState(session)
      if (routing.sagaOffer) workflow = 'saga-offer'
      else if (routing.sagaActiveAt) workflow = 'saga'
      const { messages } = await store.loadFullHistory(session)
      for (const message of messages) {
        if (message.createdAt < startedIso) continue
        transcript.push({ role: message.role, ...(message.name ? { name: message.name } : {}), content: truncate(message.content ?? '', TRANSCRIPT_ENTRY_CHARS) })
        if (message.role === 'tool' && message.name && !message.name.startsWith('runtime_')) {
          const event = parseToolMessage(message.name, message.content ?? '')
          if (event) tools.push(event)
        }
      }
    } catch (caught) {
      error = error ?? `could not read the session: ${caught instanceof Error ? caught.message : String(caught)}`
    }
  }
  // Calls made by delegated sub-agents live in their own sessions: names from the progress lines.
  for (const line of infos) {
    const sub = line.match(/^\[agent:([\w-]+)\] (?:\[agent:[\w-]+\] )*\[tool:([\w.-]+)\] running/)
    if (sub) tools.push({ name: sub[2]!, args: {}, agent: sub[1]! })
  }

  await mock?.close()
  return {
    prompt: job.prompt,
    reply,
    modelTurns,
    ...(sessionId ? { sessionId } : {}),
    durationMs,
    workflow,
    contextNotices,
    tools,
    usage: { ...meter.usage },
    mainUsage,
    probes: meter.probeHits,
    mainRequests: meter.mainRequests,
    transcript,
    blockedHosts: [...meter.blockedHosts],
    ...(error ? { error } : {}),
    infoTail: infos.filter((line) => !/^\[stream-/.test(line)).slice(-40),
  }
}

async function runJudge(job: WorkerJudgeJob): Promise<JudgeOutcome> {
  const meter = new TrafficMeter({
    offline: job.mode === 'mock',
    probes: [],
    onUsage: (usage) => emit({ type: 'usage', input: usage.input, output: usage.output }),
  })
  meter.install()
  let mock: MockServerHandle | undefined
  if (job.mode === 'mock') {
    mock = await startMockServer([], [{ match: '.', reply: job.mockReply ?? '{}' }])
    await wireMockProfile(mock.baseUrl)
  }
  try {
    const { createGlobalProviderStore } = await import('../../src/providers/store.js')
    const { createTrackedProviderFromConfig } = await import('../../src/providers/telemetry.js')
    const store = createGlobalProviderStore()
    const data = await store.load()
    // The configured worker (specialist) model; the main model when there is none.
    const profile = store.getProfile(data, data.specialistProfileId) ?? store.getDefaultMainProfile(data)
    if (!profile) return { error: 'no provider profile for the judge', usage: { ...meter.usage } }
    const provider = createTrackedProviderFromConfig({ ...(profile as any), effort: 'low' }, { cwd: job.cwd })
    const now = new Date().toISOString()
    const response = await provider.complete([
      { id: 'judge-system', role: 'system', content: JUDGE_SYSTEM, createdAt: now },
      { id: 'judge-request', role: 'user', content: buildJudgePrompt(job.request, job.reply, job.rubric), createdAt: now },
    ])
    await meter.flush()
    const parsed = parseJudgeReply(response.text ?? '')
    return 'error' in parsed
      ? { error: parsed.error, raw: truncate(response.text ?? '', 2_000), usage: { ...meter.usage } }
      : { score: parsed.score, reasons: parsed.reasons, raw: truncate(response.text ?? '', 2_000), usage: { ...meter.usage } }
  } catch (caught) {
    await meter.flush()
    return { error: caught instanceof Error ? caught.message : String(caught), usage: { ...meter.usage } }
  } finally {
    await mock?.close()
  }
}

async function main(): Promise<void> {
  const jobPath = process.argv[2]
  if (!jobPath) throw new Error('usage: worker.ts <job.json>')
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8')) as WorkerJob
  const output = job.kind === 'judge' ? await runJudge(job) : await runTurn(job)
  fs.mkdirSync(path.dirname(job.outFile), { recursive: true })
  fs.writeFileSync(job.outFile, JSON.stringify(output, null, 2))
  emit({ type: 'done' })
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exit(1)
  },
)
