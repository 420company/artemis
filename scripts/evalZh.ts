#!/usr/bin/env tsx
/**
 * scripts/evalZh.ts — Chinese task evaluation for the Artemis engine.
 *
 * Runs the tasks in evals/zh/tasks through the real headless path
 * (runHeadlessAgent, what `artemis execute` runs), each in a fresh temporary
 * workspace and ARTEMIS_HOME, grades them, and writes
 * evals/results/<timestamp>.json plus a Markdown summary next to it.
 *
 *   --mock                (default) offline, a scripted fake model; validates the harness and graders
 *   --live                the configured provider (providers.json / ARTEMIS_MODEL+BASE_URL+API_KEY); costs money
 *   --tasks a,b,c         ids, `prefix*` globs or `category:<name>`
 *   --self-test           mock only: every task's pass script must pass, every fail script must fail
 *                         the graders it names, and every grader type must be seen passing and failing
 *   --compare <old.json>  print deltas against an earlier result file
 *   --repeat N            run each task N times (live models are noisy)
 *   --jobs N              tasks in parallel (default: mock 4, live 1)
 *   --budget-tokens N     live: stop the run past N tokens (default 6,000,000)
 *   --budget-usd X        live: stop the run past $X (needs prices)
 *   --price-in X --price-out Y   USD per 1M input / output tokens (or EVAL_ZH_PRICE_IN / EVAL_ZH_PRICE_OUT)
 *   --providers <file>    live: providers.json to use instead of the operator's own
 *   --out <dir>           results directory (default evals/results)
 *   --keep                keep the temporary workspaces (paths are printed)
 *   --list                print the task list and exit
 *
 * See evals/zh/README.md.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeGeneratedAssets } from './evalZh/assets.js'
import { cjkRatio, countListItems, extractUrls, gradeTask, graderId, jsonPointer, listFiles, parseCsv, sha256File, validateSchema } from './evalZh/graders.js'
import { parseJudgeReply } from './evalZh/judge.js'
import { extractUsage } from './evalZh/meter.js'
import { addUsage, renderComparison, renderMarkdown, summarize } from './evalZh/report.js'
import {
  TASK_CATEGORIES,
  type ContextProbe,
  type EvalMode,
  type EvalTask,
  type GraderResult,
  type GraderType,
  type JudgeOutcome,
  type RunResults,
  type TaskResult,
  type TaskStatus,
  type TurnTrace,
  type Usage,
  type WorkerJob,
} from './evalZh/types.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TASK_DIR = path.join(REPO, 'evals', 'zh', 'tasks')
const FIXTURE_DIR = path.join(REPO, 'evals', 'zh', 'fixtures')
const WORKER = path.join(REPO, 'scripts', 'evalZh', 'worker.ts')
const TSX_LOADER = pathToFileURL(path.join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const MARK = '@@EVAL '

const GRADER_TYPES: readonly GraderType[] = [
  'reply_contains', 'reply_not_contains', 'reply_matches', 'reply_not_matches', 'reply_zh', 'reply_length',
  'reply_list_items', 'reply_urls_grounded', 'file_exists', 'file_absent', 'file_glob', 'file_contains',
  'files_unchanged', 'json_file', 'csv_file', 'command_succeeds', 'tool_called', 'tool_not_called',
  'turns_at_most', 'workflow_is', 'compaction_happened', 'context_contains', 'llm_judge', 'office_file',
]

// ── options ─────────────────────────────────────────────────────────────────

interface Options {
  mode: EvalMode
  tasks?: string[]
  selfTest: boolean
  compare?: string
  repeat: number
  jobs: number
  budgetTokens?: number
  budgetUsd?: number
  priceIn?: number
  priceOut?: number
  providers?: string
  out: string
  keep: boolean
  list: boolean
}

function parseOptions(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    if (index < 0) return undefined
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
    return next
  }
  const number = (flag: string, env?: string): number | undefined => {
    const raw = value(flag) ?? (env ? process.env[env] : undefined)
    if (raw === undefined || raw === '') return undefined
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag}: not a number: ${raw}`)
    return parsed
  }
  const known = new Set(['--mock', '--live', '--tasks', '--self-test', '--compare', '--repeat', '--jobs', '--budget-tokens', '--budget-usd', '--price-in', '--price-out', '--providers', '--out', '--keep', '--list', '--help', '-h'])
  argv.forEach((arg, i) => {
    const previous = argv[i - 1]
    const takesValue = previous && ['--tasks', '--compare', '--repeat', '--jobs', '--budget-tokens', '--budget-usd', '--price-in', '--price-out', '--providers', '--out'].includes(previous)
    if (!takesValue && !known.has(arg)) throw new Error(`unknown option: ${arg}`)
  })
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 30).map((line) => line.replace(/^ \* ?/, '')).join('\n'))
    process.exit(0)
  }
  if (argv.includes('--mock') && argv.includes('--live')) throw new Error('--mock and --live are exclusive')
  const mode: EvalMode = argv.includes('--live') ? 'live' : 'mock'
  const selfTest = argv.includes('--self-test')
  if (selfTest && mode === 'live') throw new Error('--self-test runs in mock mode only')
  return {
    mode,
    tasks: value('--tasks')?.split(',').map((item) => item.trim()).filter(Boolean),
    selfTest,
    compare: value('--compare'),
    repeat: Math.max(1, Math.floor(number('--repeat') ?? 1)),
    jobs: Math.max(1, Math.floor(number('--jobs') ?? (mode === 'mock' ? 4 : 1))),
    budgetTokens: mode === 'live' ? number('--budget-tokens') ?? 6_000_000 : undefined,
    budgetUsd: number('--budget-usd'),
    priceIn: number('--price-in', 'EVAL_ZH_PRICE_IN'),
    priceOut: number('--price-out', 'EVAL_ZH_PRICE_OUT'),
    providers: value('--providers'),
    out: path.resolve(value('--out') ?? path.join(REPO, 'evals', 'results')),
    keep: argv.includes('--keep'),
    list: argv.includes('--list'),
  }
}

// ── tasks ───────────────────────────────────────────────────────────────────

export function loadTasks(dir = TASK_DIR): EvalTask[] {
  const tasks = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort().map((file) => {
    const task = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as EvalTask
    const problems: string[] = []
    if (`${task.id}.json` !== file) problems.push(`id "${task.id}" does not match the file name`)
    if (!TASK_CATEGORIES.includes(task.category)) problems.push(`unknown category "${task.category}"`)
    if (!task.turns?.length) problems.push('no turns')
    if (!task.graders?.length) problems.push('no graders')
    if (task.fixture && !fs.existsSync(path.join(FIXTURE_DIR, task.fixture))) problems.push(`fixture "${task.fixture}" not found`)
    const ids = new Set<string>()
    task.graders?.forEach((grader, index) => {
      if (!GRADER_TYPES.includes(grader.type)) problems.push(`grader ${index + 1}: unknown type "${grader.type}"`)
      const id = graderId(grader, index)
      if (ids.has(id)) problems.push(`duplicate grader id "${id}"`)
      ids.add(id)
      if (typeof grader.turn === 'number' && (grader.turn < 1 || grader.turn > task.turns.length)) problems.push(`grader ${id}: turn ${grader.turn} out of range`)
    })
    for (const variant of ['pass', 'fail'] as const) {
      const script = task.mock?.[variant]
      if (!script) {
        if (variant === 'pass') problems.push('no mock.pass script')
        continue
      }
      if (script.turns.length !== task.turns.length) problems.push(`mock.${variant} has ${script.turns.length} turn script(s) for ${task.turns.length} turn(s)`)
    }
    for (const id of task.mock?.fail?.expectFail ?? []) {
      if (!ids.has(id) && !task.graders.some((grader) => grader.type === id)) problems.push(`mock.fail.expectFail names unknown grader "${id}"`)
    }
    if (problems.length) throw new Error(`evals/zh/tasks/${file}: ${problems.join('; ')}`)
    return task
  })
  const seen = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`duplicate task id ${task.id}`)
    seen.add(task.id)
  }
  return tasks
}

function filterTasks(tasks: EvalTask[], filters?: string[]): EvalTask[] {
  if (!filters?.length) return tasks
  const selected = tasks.filter((task) => filters.some((filter) => {
    if (filter.startsWith('category:')) return task.category === filter.slice('category:'.length)
    if (filter.endsWith('*')) return task.id.startsWith(filter.slice(0, -1))
    return task.id === filter
  }))
  if (selected.length === 0) throw new Error(`--tasks matched nothing: ${filters.join(',')}`)
  return selected
}

// ── providers ───────────────────────────────────────────────────────────────

const MOCK_PROVIDERS = {
  defaultMainProfileId: 'eval-mock',
  profiles: [{ id: 'eval-mock', label: 'Eval mock', protocol: 'openai', apiKey: 'eval-mock-key', model: 'eval-mock', baseUrl: 'http://127.0.0.1:9', supportsImages: true }],
}

interface LiveProviders {
  data: Record<string, any>
  source: string
  model?: string
  protocol?: string
  host?: string
  worker?: string
}

/**
 * The operator's provider configuration for live runs, copied into each
 * task's temporary ARTEMIS_HOME. Image/video generation settings are left
 * out: no task needs them, and they would spend money.
 */
function resolveLiveProviders(options: Options): LiveProviders {
  let data: Record<string, any> | undefined
  let source = ''
  if (options.providers) {
    data = JSON.parse(fs.readFileSync(path.resolve(options.providers), 'utf8'))
    source = options.providers
  } else if (process.env.ARTEMIS_MODEL && process.env.ARTEMIS_BASE_URL && process.env.ARTEMIS_API_KEY) {
    data = {
      defaultMainProfileId: 'eval-env',
      profiles: [{
        id: 'eval-env',
        label: 'From environment',
        protocol: process.env.ARTEMIS_PROTOCOL || 'openai',
        model: process.env.ARTEMIS_MODEL,
        baseUrl: process.env.ARTEMIS_BASE_URL,
        apiKey: process.env.ARTEMIS_API_KEY,
      }],
    }
    source = 'ARTEMIS_MODEL / ARTEMIS_BASE_URL / ARTEMIS_API_KEY'
  } else {
    const home = process.env.ARTEMIS_HOME?.trim() ? path.resolve(process.env.ARTEMIS_HOME) : path.join(os.homedir(), '.artemis')
    const file = path.join(home, 'providers.json')
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
      source = file
    }
  }
  if (!data || !Array.isArray(data.profiles) || data.profiles.length === 0) {
    throw new Error('live mode needs a configured provider: run `artemis` setup once, pass --providers <providers.json>, or set ARTEMIS_MODEL, ARTEMIS_BASE_URL and ARTEMIS_API_KEY')
  }
  const copy = { ...data }
  delete copy.visualProfile
  const main = copy.profiles.find((profile: any) => profile.id === copy.defaultMainProfileId) ?? copy.profiles[0]
  const worker = copy.profiles.find((profile: any) => profile.id === copy.specialistProfileId)
  let host: string | undefined
  try { host = main?.baseUrl ? new URL(main.baseUrl).host : undefined } catch { /* keep undefined */ }
  return { data: copy, source, model: main?.model, protocol: main?.protocol, host, worker: worker?.model }
}

// ── workers ─────────────────────────────────────────────────────────────────

const SECRET_ENV_RE = /(?:_API_KEY|_TOKEN|_SECRET)$|^GOOGLE_CX$|^ARTEMIS_(?:MODEL|BASE_URL|PROTOCOL|HOME)$|_GATEWAY_URL$|_CDP_URL$/

function workerEnv(mode: EvalMode, home: string, userHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Mock runs never see credentials; live runs keep the operator's environment
  // (search keys, feature toggles such as ARTEMIS_SELF_CHECK) except the home.
  for (const key of Object.keys(env)) if (key === 'ARTEMIS_HOME' || (mode === 'mock' && SECRET_ENV_RE.test(key))) delete env[key]
  return {
    ...env,
    ARTEMIS_HOME: home,
    HOME: userHome,
    USERPROFILE: userHome,
    TSX_TSCONFIG_PATH: path.join(REPO, 'tsconfig.json'),
    ARTEMIS_CURATION_SETTLE_MS: env.ARTEMIS_CURATION_SETTLE_MS ?? (mode === 'mock' ? '30000' : '120000'),
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
}

interface WorkerOutcome<T> {
  status: 'ok' | 'timeout' | 'budget' | 'crash'
  output?: T
  usage: Usage
  detail?: string
}

const running = new Set<ChildProcess>()

function killTree(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

process.on('SIGINT', () => {
  for (const child of running) killTree(child)
  process.exit(130)
})

/** Budget shared by the whole run (live mode). */
class Budget {
  tokens = 0
  constructor(private readonly options: Options) {}
  cost(input: number, output: number): number | undefined {
    if (this.options.priceIn === undefined && this.options.priceOut === undefined) return undefined
    return (input * (this.options.priceIn ?? 0) + output * (this.options.priceOut ?? 0)) / 1_000_000
  }
  spentUsd = 0
  exhausted(): string | undefined {
    if (this.options.budgetTokens !== undefined && this.tokens >= this.options.budgetTokens) return `run token budget (${this.options.budgetTokens}) used up`
    if (this.options.budgetUsd !== undefined && this.spentUsd >= this.options.budgetUsd) return `run budget ($${this.options.budgetUsd}) used up`
    return undefined
  }
}

async function runWorker<T>(
  job: WorkerJob,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  logFile: string,
  budget: Budget,
  taskTokensBefore: number,
  taskBudgetTokens: number | undefined,
): Promise<WorkerOutcome<T>> {
  const jobFile = `${job.outFile}.job.json`
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2))
  const usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0 }
  const log = fs.createWriteStream(logFile, { flags: 'a' })
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', '--import', TSX_LOADER, WORKER, jobFile], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    running.add(child)
    let stopped: 'timeout' | 'budget' | undefined
    let stopDetail = ''
    const stop = (why: 'timeout' | 'budget', detail: string) => {
      if (stopped) return
      stopped = why
      stopDetail = detail
      killTree(child)
    }
    const timer = setTimeout(() => stop('timeout', `no result after ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
    let buffer = ''
    child.stdout!.on('data', (data: Buffer) => {
      log.write(data)
      buffer += data.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        const at = line.indexOf(MARK)
        if (at < 0) continue
        let event: { type?: string; input?: number; output?: number }
        try { event = JSON.parse(line.slice(at + MARK.length)) } catch { continue }
        if (event.type !== 'usage') continue
        usage.requests += 1
        usage.inputTokens += event.input ?? 0
        usage.outputTokens += event.output ?? 0
        const tokens = (event.input ?? 0) + (event.output ?? 0)
        budget.tokens += tokens
        budget.spentUsd += budget.cost(event.input ?? 0, event.output ?? 0) ?? 0
        const taskTokens = taskTokensBefore + usage.inputTokens + usage.outputTokens
        if (taskBudgetTokens !== undefined && taskTokens > taskBudgetTokens) stop('budget', `task token budget (${taskBudgetTokens}) exceeded: ${taskTokens}`)
        const runOut = budget.exhausted()
        if (runOut) stop('budget', runOut)
      }
    })
    child.stderr!.on('data', (data: Buffer) => log.write(data))
    child.on('close', (code) => {
      clearTimeout(timer)
      running.delete(child)
      log.end()
      if (stopped) {
        resolve({ status: stopped, usage, detail: stopDetail })
        return
      }
      if (code !== 0 || !fs.existsSync(job.outFile)) {
        const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-15).join('\n') : ''
        resolve({ status: 'crash', usage, detail: `worker exited with ${code}${tail ? `:\n${tail}` : ''}` })
        return
      }
      resolve({ status: 'ok', usage, output: JSON.parse(fs.readFileSync(job.outFile, 'utf8')) as T })
    })
  })
}

// ── one task ────────────────────────────────────────────────────────────────

interface RunContext {
  options: Options
  mode: EvalMode
  live?: LiveProviders
  budget: Budget
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true })
  fs.cpSync(from, to, { recursive: true })
}

function emptyTrace(prompt: string, error: string): TurnTrace {
  return {
    prompt, reply: '', modelTurns: 0, durationMs: 0, workflow: 'none', contextNotices: [], tools: [],
    usage: { requests: 0, inputTokens: 0, outputTokens: 0 }, mainUsage: { requests: 0, inputTokens: 0, outputTokens: 0 },
    probes: {}, mainRequests: 0, transcript: [], blockedHosts: [], error, infoTail: [],
  }
}

async function runTask(task: EvalTask, variant: 'pass' | 'fail', ctx: RunContext, repeat?: number): Promise<TaskResult> {
  const started = Date.now()
  const base = { id: task.id, category: task.category, description: task.description, ...(ctx.mode === 'mock' ? { variant } : {}), ...(repeat ? { repeat } : {}) }
  const exhausted = ctx.budget.exhausted()
  if (exhausted) {
    return { ...base, status: 'skipped', score: 0, graders: [], turns: [], usage: { requests: 0, inputTokens: 0, outputTokens: 0 }, durationMs: 0, error: exhausted }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `artemis-eval-${task.id}-`))
  const home = path.join(root, 'artemis-home')
  const userHome = path.join(root, 'user-home')
  const workspace = path.join(root, 'workspace')
  for (const dir of [home, userHome, workspace]) fs.mkdirSync(dir, { recursive: true })
  if (task.fixture) copyDir(path.join(FIXTURE_DIR, task.fixture), workspace)
  writeGeneratedAssets(workspace, task.generated)
  const fixtureHashes = Object.fromEntries(listFiles(workspace).map((file) => [file, sha256File(path.join(workspace, file))]))
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify(ctx.mode === 'mock' ? MOCK_PROVIDERS : ctx.live!.data, null, 2), { mode: 0o600 })

  const script = variant === 'fail' && task.mock.fail ? task.mock.fail : task.mock.pass
  const setup = { ...(task.setup ?? {}), ...(ctx.mode === 'mock' ? script.setup ?? {} : {}) }
  const probeIds: Record<string, string> = {}
  const probes: ContextProbe[] = []
  task.graders.forEach((grader, index) => {
    if (grader.type !== 'context_contains') return
    const probe = { id: `p${probes.length + 1}`, pattern: grader.pattern, ...(grader.flags ? { flags: grader.flags } : {}) }
    probes.push(probe)
    probeIds[graderId(grader, index)] = probe.id
  })
  const env = workerEnv(ctx.mode, home, userHome)
  const limits = task.limits ?? {}
  const timeoutMs = (limits.timeoutSec ?? (ctx.mode === 'mock' ? 180 : 300)) * 1000
  const taskBudget = ctx.mode === 'live' ? limits.budgetTokens ?? 400_000 : undefined

  const turns: TurnTrace[] = []
  const usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0 }
  let status: TaskStatus | undefined
  let error: string | undefined
  let sessionId: string | undefined
  for (let index = 0; index < task.turns.length; index++) {
    const turn = task.turns[index]!
    if (turn.newSession) sessionId = undefined
    const outFile = path.join(root, `turn-${index + 1}.json`)
    const outcome = await runWorker<TurnTrace>({
      kind: 'turn',
      mode: ctx.mode,
      cwd: workspace,
      prompt: turn.prompt,
      ...(sessionId ? { sessionId } : {}),
      imagePaths: (turn.attachments ?? []).map((file) => path.join(workspace, file)),
      maxTurns: limits.maxTurns ?? 20,
      setup,
      ...(index === 0 && task.seedHistory ? { seedHistory: task.seedHistory } : {}),
      probes,
      ...(ctx.mode === 'mock' ? { mock: { steps: script.turns[index] ?? [], aux: script.aux ?? [] } } : {}),
      outFile,
    }, workspace, env, timeoutMs, path.join(root, 'worker.log'), ctx.budget, usage.inputTokens + usage.outputTokens, taskBudget)
    addUsage(usage, outcome.usage)
    if (outcome.status !== 'ok' || !outcome.output) {
      status = outcome.status === 'timeout' || outcome.status === 'budget' ? outcome.status : 'error'
      error = `turn ${index + 1}: ${outcome.detail ?? outcome.status}`
      turns.push({ ...emptyTrace(turn.prompt, error), usage: outcome.usage })
      break
    }
    const trace = outcome.output
    turns.push(trace)
    sessionId = trace.sessionId
    if (trace.error) {
      // The engine itself failed (provider error, bad config): the task cannot be graded fairly.
      status = 'error'
      error = `turn ${index + 1}: ${trace.error}`
      break
    }
  }

  let judge: JudgeOutcome | undefined
  const judgeGrader = task.graders.find((grader) => grader.type === 'llm_judge')
  if (!status && judgeGrader && judgeGrader.type === 'llm_judge' && ctx.mode === 'live') {
    const last = turns[turns.length - 1]!
    const outcome = await runWorker<JudgeOutcome>({
      kind: 'judge', mode: ctx.mode, cwd: workspace, request: last.prompt, reply: last.reply, rubric: judgeGrader.rubric, outFile: path.join(root, 'judge.json'),
    }, workspace, env, 120_000, path.join(root, 'worker.log'), ctx.budget, usage.inputTokens + usage.outputTokens, taskBudget)
    addUsage(usage, outcome.usage)
    judge = outcome.output ?? { error: outcome.detail ?? outcome.status, usage: outcome.usage }
  }

  const graders: GraderResult[] = status
    ? []
    : gradeTask(task.graders, { mode: ctx.mode, workspace, fixtureHashes, turns, probeIds, ...(judge ? { judge } : {}), env })
  const graded = graders.filter((grader) => grader.status !== 'skip')
  const passed = graded.filter((grader) => grader.status === 'pass').length
  const finalStatus: TaskStatus = status ?? (graded.every((grader) => grader.status === 'pass') ? 'pass' : 'fail')
  const cost = ctx.budget.cost(usage.inputTokens, usage.outputTokens)

  if (ctx.options.keep) console.log(`    kept ${root}`)
  else fs.rmSync(root, { recursive: true, force: true })
  return {
    ...base,
    status: finalStatus,
    score: graded.length ? passed / graded.length : 0,
    graders,
    turns,
    usage,
    ...(cost !== undefined && ctx.mode === 'live' ? { costUsd: cost } : {}),
    durationMs: Date.now() - started,
    ...(judge ? { judge } : {}),
    ...(error ? { error } : {}),
  }
}

async function runAll(tasks: EvalTask[], variant: 'pass' | 'fail', ctx: RunContext): Promise<TaskResult[]> {
  const queue: Array<{ task: EvalTask; repeat?: number }> = []
  for (const task of tasks) {
    for (let r = 1; r <= ctx.options.repeat; r++) queue.push({ task, ...(ctx.options.repeat > 1 ? { repeat: r } : {}) })
  }
  const results: TaskResult[] = new Array(queue.length)
  let next = 0
  const workers = Array.from({ length: Math.min(ctx.options.jobs, queue.length) }, async () => {
    while (next < queue.length) {
      const index = next++
      const { task, repeat } = queue[index]!
      const result = await runTask(task, variant, ctx, repeat)
      results[index] = result
      const failed = result.graders.filter((grader) => grader.status === 'fail').map((grader) => grader.id)
      const tokens = result.usage.inputTokens + result.usage.outputTokens
      console.log(`  ${result.status === 'pass' ? '✔' : result.status === 'skipped' ? '·' : '✘'} ${task.id}${repeat ? ` #${repeat}` : ''}${variant === 'fail' ? ' [fail script]' : ''} — ${result.status} (${(result.durationMs / 1000).toFixed(1)}s, ${tokens} tokens)${failed.length ? ` failed: ${failed.join(', ')}` : ''}${result.error ? ` — ${result.error.split('\n')[0]}` : ''}`)
    }
  })
  await Promise.all(workers)
  return results
}

// ── self-test ───────────────────────────────────────────────────────────────

function unitChecks(): string[] {
  const problems: string[] = []
  const check = (label: string, ok: boolean) => { if (!ok) problems.push(`unit: ${label}`) }
  check('judge reply parses', JSON.stringify(parseJudgeReply('好的 {"score": 4, "reasons": "结构清楚"}')) === JSON.stringify({ score: 4, reasons: '结构清楚' }))
  check('judge score out of range is an error', 'error' in parseJudgeReply('{"score": 9}'))
  check('judge without JSON is an error', 'error' in parseJudgeReply('打 5 分'))
  check('csv: quotes, BOM, CRLF', JSON.stringify(parseCsv('\uFEFF产品,销售额\r\n"橙子, 大",102\r\n')) === JSON.stringify([['产品', '销售额'], ['橙子, 大', '102']]))
  check('json pointer', jsonPointer({ a: [{ b: 1 }] }, '/a/0/b') === 1)
  check('schema: missing field', validateSchema({ a: 1 }, { type: 'object', required: ['b'] }) !== undefined)
  check('schema: pattern', validateSchema('1380', { type: 'string', pattern: '^1\\d{10}$' }) !== undefined)
  check('list items', countListItems('1. 甲\n**2.** 乙\n- 丙\n**正文**\n*强调*') === 3)
  const claim = loadTasks().find((t) => t.id === 'honesty-test-report')?.graders.find((g) => g.id === 'no-false-claim')
  const claimRe = claim?.type === 'reply_not_matches' ? new RegExp(claim.pattern, claim.flags) : undefined
  check('false-claim pattern: a claim matches, a negation does not', Boolean(claimRe?.test('所有测试都通过了')) && !claimRe?.test('并非所有测试都通过，有 1 个失败'))
  check('cjk ratio', cjkRatio('你好 hello') < 0.5 && cjkRatio('你好世界') === 1)
  check('urls', JSON.stringify(extractUrls('见 https://nodejs.org/en/about/previous-releases。')) === JSON.stringify(['https://nodejs.org/en/about/previous-releases']))
  check('usage: openai JSON', JSON.stringify(extractUsage('{"usage":{"prompt_tokens":10,"completion_tokens":3}}')) === JSON.stringify({ input: 10, output: 3 }))
  check('usage: anthropic SSE', JSON.stringify(extractUsage('data: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":20,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":42}}')) === JSON.stringify({ input: 25, output: 42 }))
  check('usage: none', extractUsage('{"choices":[]}') === undefined)
  const task = (id: string, status: TaskStatus, score: number): TaskResult => ({ id, category: 'qa', description: '', status, score, graders: [], turns: [], usage: { requests: 1, inputTokens: 100, outputTokens: 10 }, durationMs: 1000 })
  const run = (tasks: TaskResult[]): RunResults => ({ version: 1, startedAt: '', finishedAt: '', mode: 'mock', options: {}, summary: summarize(tasks, 1000), tasks })
  const comparison = renderComparison(run([task('a', 'pass', 1), task('b', 'fail', 0.5)]), run([task('a', 'fail', 0.5), task('b', 'fail', 0.5), task('c', 'pass', 1)]))
  check('compare: changed task listed, unchanged task not, extra task noted', /\| a \| pass \| fail \| -50pp/.test(comparison) && !/\| b \|/.test(comparison) && /1 only after/.test(comparison))
  return problems
}

function selfTestReport(tasks: EvalTask[], passRuns: TaskResult[], failRuns: TaskResult[], checkCoverage: boolean): string[] {
  const problems: string[] = []
  for (const result of passRuns) {
    if (result.status !== 'pass') {
      const failed = result.graders.filter((grader) => grader.status === 'fail').map((grader) => `${grader.id} (${grader.detail})`)
      problems.push(`${result.id}: pass script ended ${result.status}${failed.length ? `: ${failed.join('; ')}` : ''}${result.error ? `: ${result.error.split('\n')[0]}` : ''}`)
    }
  }
  for (const result of failRuns) {
    const task = tasks.find((candidate) => candidate.id === result.id)!
    if (result.status !== 'fail') {
      problems.push(`${result.id}: fail script ended ${result.status}, expected fail${result.error ? `: ${result.error.split('\n')[0]}` : ''}`)
      continue
    }
    for (const expected of task.mock.fail!.expectFail) {
      const matching = result.graders.filter((grader) => grader.id === expected || grader.type === expected)
      if (!matching.some((grader) => grader.status === 'fail')) problems.push(`${result.id}: fail script did not fail grader "${expected}"`)
    }
  }
  const seen = (runs: TaskResult[], status: 'pass' | 'fail') => new Set(runs.flatMap((run) => run.graders.filter((grader) => grader.status === status).map((grader) => grader.type)))
  const passedTypes = seen(passRuns, 'pass')
  const failedTypes = seen(failRuns, 'fail')
  const used = new Set(tasks.flatMap((task) => task.graders.map((grader) => grader.type)))
  if (!checkCoverage) return problems
  for (const type of used) {
    if (type === 'llm_judge') continue
    if (!passedTypes.has(type)) problems.push(`coverage: grader type ${type} never passed in mock mode`)
    if (!failedTypes.has(type)) problems.push(`coverage: grader type ${type} never failed in a fail script`)
  }
  return problems
}

/** The judge plumbing end to end against the mock model (the judge never scores in mock runs). */
async function judgeSelfCheck(ctx: RunContext): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-eval-judge-'))
  const home = path.join(root, 'artemis-home')
  const userHome = path.join(root, 'user-home')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(userHome, { recursive: true })
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify(MOCK_PROVIDERS))
  const outcome = await runWorker<JudgeOutcome>({
    kind: 'judge', mode: 'mock', cwd: root, request: '写一封请假邮件', reply: '王经理您好……', rubric: '格式完整', mockReply: '{"score": 5, "reasons": "格式完整，语气得体"}', outFile: path.join(root, 'judge.json'),
  }, root, workerEnv('mock', home, userHome), 120_000, path.join(root, 'worker.log'), ctx.budget, 0, undefined)
  fs.rmSync(root, { recursive: true, force: true })
  const ok = outcome.status === 'ok' && outcome.output?.score === 5 && (outcome.output?.usage.requests ?? 0) === 1
  return ok ? [] : [`judge plumbing: ${JSON.stringify(outcome).slice(0, 400)}`]
}

// ── main ────────────────────────────────────────────────────────────────────

function gitInfo(): RunResults['git'] {
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : undefined
  }
  const status = git('status', '--porcelain')
  return { commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty: status === undefined ? undefined : status.length > 0 }
}

function writeResults(results: RunResults, out: string, suffix = ''): string {
  fs.mkdirSync(out, { recursive: true })
  const stamp = results.startedAt.replace(/[:.]/g, '-')
  const file = path.join(out, `${stamp}${suffix}.json`)
  fs.writeFileSync(file, JSON.stringify(results, null, 2))
  fs.writeFileSync(file.replace(/\.json$/, '.md'), renderMarkdown(results))
  return file
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const all = loadTasks()
  if (options.list) {
    for (const task of all) console.log(`${task.id.padEnd(32)} ${task.category.padEnd(13)} ${task.description}`)
    return
  }
  const tasks = filterTasks(all, options.tasks)
  const live = options.mode === 'live' ? resolveLiveProviders(options) : undefined
  const ctx: RunContext = { options, mode: options.mode, ...(live ? { live } : {}), budget: new Budget(options) }

  console.log(`\n  Artemis 中文任务评测 — ${options.mode} mode, ${tasks.length} task(s)${options.repeat > 1 ? ` × ${options.repeat}` : ''}`)
  if (live) {
    console.log(`  provider: ${live.model ?? '?'} (${live.protocol ?? '?'} @ ${live.host ?? '?'})${live.worker ? `, worker ${live.worker}` : ''} — from ${live.source}`)
    console.log(`  budget: ${options.budgetTokens?.toLocaleString('en-US') ?? '∞'} tokens${options.budgetUsd !== undefined ? `, $${options.budgetUsd}` : ''}${options.priceIn !== undefined || options.priceOut !== undefined ? ` · prices $${options.priceIn ?? 0}/$${options.priceOut ?? 0} per 1M in/out` : ' · no prices given: cost is reported in tokens only'}`)
    if (options.budgetUsd !== undefined && options.priceIn === undefined && options.priceOut === undefined) {
      throw new Error('--budget-usd needs --price-in/--price-out (or EVAL_ZH_PRICE_IN/EVAL_ZH_PRICE_OUT)')
    }
  }
  console.log()

  const startedAt = new Date().toISOString()
  const started = Date.now()
  const passRuns = await runAll(tasks, 'pass', ctx)
  const results: RunResults = {
    version: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: options.mode,
    git: gitInfo(),
    ...(live ? { provider: { model: live.model, protocol: live.protocol, host: live.host, ...(live.worker ? { worker: live.worker } : {}) } } : {}),
    options: { tasks: options.tasks ?? 'all', repeat: options.repeat, budgetTokens: options.budgetTokens, budgetUsd: options.budgetUsd, priceIn: options.priceIn, priceOut: options.priceOut },
    summary: summarize(passRuns, Date.now() - started),
    tasks: passRuns,
  }
  const file = writeResults(results, options.out)
  console.log(`\n${renderMarkdown(results)}`)
  console.log(`  results: ${path.relative(process.cwd(), file)} (+ .md)`)

  if (options.compare) {
    const before = JSON.parse(fs.readFileSync(path.resolve(options.compare), 'utf8')) as RunResults
    console.log(`\n## Compared with ${options.compare}\n`)
    console.log(renderComparison(before, results))
  }

  let exitCode = 0
  if (options.selfTest) {
    console.log('\n  self-test: running the deliberate-failure scripts…\n')
    const withFail = tasks.filter((task) => task.mock.fail)
    const failRuns = await runAll(withFail, 'fail', { ...ctx, options: { ...options, repeat: 1 } })
    const problems = [...unitChecks(), ...selfTestReport(tasks, passRuns, failRuns, !options.tasks), ...(await judgeSelfCheck(ctx))]
    const usedTypes = new Set(tasks.flatMap((task) => task.graders.map((grader) => grader.type)))
    console.log(`\n  self-test: ${passRuns.length} pass script(s), ${failRuns.length} fail script(s), ${usedTypes.size} grader type(s) in use${options.tasks ? ' (grader coverage is checked on the full task set only)' : ''}`)
    if (problems.length) {
      exitCode = 1
      console.log(`  self-test FAILED (${problems.length}):`)
      for (const problem of problems) console.log(`    ✘ ${problem}`)
    } else {
      console.log(`  self-test passed: every pass script passed, every fail script failed the graders it names${options.tasks ? '' : ', every grader type was seen passing and failing'}.`)
    }
  } else if (options.mode === 'mock' && results.summary.passed !== results.summary.tasks) {
    exitCode = 1
  }
  process.exitCode = exitCode
}

main().catch((error) => {
  console.error(`\n  eval:zh failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
