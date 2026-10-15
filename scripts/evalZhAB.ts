#!/usr/bin/env tsx
/**
 * scripts/evalZhAB.ts — A/B experiment for cache-aware compaction summaries.
 *
 *   A  current behaviour (ARTEMIS_CACHE_AWARE_SUMMARY=0)
 *   D  tier-2 summaries continue the cached main conversation (ARTEMIS_CACHE_AWARE_SUMMARY=1)
 *
 * Both arms run the long eval tasks under a small context cap
 * (ARTEMIS_MAX_CONTEXT_TOKENS, default 60000) so they compact, in alternating
 * order per round, then a paired table and the ship rule are printed
 * (scripts/evalZh/ab.ts).
 *
 *   (default) / --dry-run   the plan and a cost estimate; no paid calls (the
 *                           estimate runs the tasks once against the scripted
 *                           mock model, offline)
 *   --live                  run both arms against the configured provider (costs money)
 *   --mock                  run both arms against the mock model (checks the plumbing; free)
 *   --compare <A> <D>       only the table: result files or directories of a finished run
 *   --tasks a,b             default long-context-recall,memory-skill-reuse,category:multistep
 *   --repeat N              rounds (default 3)
 *   --context-tokens N      ARTEMIS_MAX_CONTEXT_TOKENS for both arms (default 60000)
 *   --prices <file>         rates (see scripts/evalZh/pricing.ts; default $EVAL_ZH_PRICES or evals/prices.local.json)
 *   --model <id>            dry run: whose rates to estimate with (default: the table's default rate)
 *   --estimate-from <path>  dry run: per-task tokens from an earlier live result file/directory instead of the mock
 *   --providers <file>      live: providers.json to use (as for eval:zh)
 *   --budget-usd X          live: stop the experiment past $X in total (split evenly over the arm runs)
 *   --out <dir>             default evals/results/ab-<timestamp>
 *
 * See evals/zh/README.md ("A/B: cache-aware compaction summaries").
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareArms, listResultFiles, loadArm, renderAbComparison, type Arm } from './evalZh/ab.js'
import { loadPriceTable, priceUsage, ratesFor } from './evalZh/pricing.js'
import type { EvalTask, RunResults } from './evalZh/types.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EVAL = path.join(REPO, 'scripts', 'evalZh.ts')
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const DEFAULT_TASKS = 'long-context-recall,memory-skill-reuse,category:multistep'

/** A real model takes more turns than the scripted mock (evals/zh/README.md, "Cost"). */
const TURN_FACTOR = 2.5
/** Assumed split of input tokens when no earlier live run is given. */
const ASSUMED_SPLIT = { uncached: 0.3, cacheRead: 0.6, cacheWrite: 0.1, outputPerInput: 0.02 }

interface Options {
  mode: 'dry-run' | 'live' | 'mock' | 'compare'
  compare?: [string, string]
  tasks: string
  repeat: number
  contextTokens: number
  prices?: string
  model?: string
  estimateFrom?: string
  providers?: string
  budgetUsd?: number
  out: string
}

function parseOptions(argv: string[]): Options {
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    if (index < 0) return undefined
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
    return next
  }
  const numberOf = (flag: string): number | undefined => {
    const raw = valueOf(flag)
    if (raw === undefined) return undefined
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag}: not a positive number: ${raw}`)
    return parsed
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    const header = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
    console.log(header.slice(2, header.indexOf(' */')).map((line) => line.replace(/^ \* ?/, '')).join('\n'))
    process.exit(0)
  }
  const modes = (['--live', '--mock', '--compare', '--dry-run'] as const).filter((flag) => argv.includes(flag))
  if (modes.length > 1) throw new Error(`${modes.join(' and ')} are exclusive`)
  const compareAt = argv.indexOf('--compare')
  const compare = compareAt >= 0 ? [argv[compareAt + 1], argv[compareAt + 2]] : undefined
  if (compare && (!compare[0] || !compare[1])) throw new Error('--compare needs two paths: <A> <D>')
  const known = new Set(['--live', '--mock', '--compare', '--dry-run', '--tasks', '--repeat', '--context-tokens', '--prices', '--model', '--estimate-from', '--providers', '--budget-usd', '--out'])
  const valued = new Set(['--tasks', '--repeat', '--context-tokens', '--prices', '--model', '--estimate-from', '--providers', '--budget-usd', '--out'])
  argv.forEach((arg, i) => {
    if (compareAt >= 0 && (i === compareAt + 1 || i === compareAt + 2)) return
    if (valued.has(argv[i - 1] ?? '')) return
    if (!known.has(arg)) throw new Error(`unknown option: ${arg}`)
  })
  return {
    mode: compare ? 'compare' : argv.includes('--live') ? 'live' : argv.includes('--mock') ? 'mock' : 'dry-run',
    ...(compare ? { compare: [path.resolve(compare[0]!), path.resolve(compare[1]!)] as [string, string] } : {}),
    tasks: valueOf('--tasks') ?? DEFAULT_TASKS,
    repeat: Math.floor(numberOf('--repeat') ?? 3),
    contextTokens: Math.floor(numberOf('--context-tokens') ?? 60_000),
    prices: valueOf('--prices'),
    model: valueOf('--model'),
    estimateFrom: valueOf('--estimate-from'),
    providers: valueOf('--providers'),
    budgetUsd: numberOf('--budget-usd'),
    out: path.resolve(valueOf('--out') ?? path.join(REPO, 'evals', 'results', `ab-${new Date().toISOString().replace(/[:.]/g, '-')}`)),
  }
}

const ARM_ENV: Record<Arm, string> = { A: '0', D: '1' }

function armEnv(arm: Arm, options: Options): NodeJS.ProcessEnv {
  return { ...process.env, ARTEMIS_MAX_CONTEXT_TOKENS: String(options.contextTokens), ARTEMIS_CACHE_AWARE_SUMMARY: ARM_ENV[arm] }
}

function evalArgs(mode: 'live' | 'mock', options: Options, out: string, runs: number): string[] {
  return [
    '--no-warnings', TSX, EVAL, `--${mode}`, '--tasks', options.tasks, '--repeat', '1', '--out', out,
    ...(mode === 'live' && options.prices ? ['--prices', options.prices] : []),
    ...(mode === 'live' && options.providers ? ['--providers', options.providers] : []),
    ...(mode === 'live' && options.budgetUsd ? ['--budget-usd', String(options.budgetUsd / runs)] : []),
  ]
}

/** Rounds in alternating arm order (A,D then D,A, …) so drift over time hits both arms alike. */
function schedule(repeat: number): Array<{ round: number; arm: Arm }> {
  const runs: Array<{ round: number; arm: Arm }> = []
  for (let round = 1; round <= repeat; round += 1) {
    const order: Arm[] = round % 2 === 1 ? ['A', 'D'] : ['D', 'A']
    for (const arm of order) runs.push({ round, arm })
  }
  return runs
}

const roundDir = (options: Options, arm: Arm, round: number) => path.join(options.out, arm, `round-${String(round).padStart(2, '0')}`)

function runArms(mode: 'live' | 'mock', options: Options): void {
  const runs = schedule(options.repeat)
  console.log(`\n  A/B ${mode}: ${runs.length} arm run(s) of ${options.tasks}, ARTEMIS_MAX_CONTEXT_TOKENS=${options.contextTokens} → ${options.out}\n`)
  for (const { round, arm } of runs) {
    const out = roundDir(options, arm, round)
    console.log(`  ── round ${round}, arm ${arm} (ARTEMIS_CACHE_AWARE_SUMMARY=${ARM_ENV[arm]}) ──`)
    const result = spawnSync(process.execPath, evalArgs(mode, options, out, runs.length), { cwd: REPO, env: armEnv(arm, options), stdio: 'inherit' })
    if (result.status !== 0 && listResultFiles(out).length === 0) throw new Error(`arm ${arm}, round ${round}: eval:zh exited with ${result.status} and wrote no results`)
  }
  report(path.join(options.out, 'A'), path.join(options.out, 'D'), options.out)
}

function report(a: string, d: string, out?: string): void {
  const comparison = compareArms(loadArm(a, 'A'), loadArm(d, 'D'))
  const text = renderAbComparison(comparison)
  console.log(`\n${text}`)
  if (out) {
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, 'ab-comparison.md'), text)
    fs.writeFileSync(path.join(out, 'ab-comparison.json'), JSON.stringify(comparison, null, 2))
    console.log(`  written: ${path.relative(process.cwd(), path.join(out, 'ab-comparison.md'))} (+ .json)`)
  }
}

// ── dry run: plan and cost estimate ─────────────────────────────────────────

interface TaskEstimate { id: string; input: number; output: number; uncached: number; cacheRead: number; cacheWrite: number; ceiling: number }

function selectedTasks(filter: string): EvalTask[] {
  const dir = path.join(REPO, 'evals', 'zh', 'tasks')
  const all = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as EvalTask)
  const filters = filter.split(',').map((item) => item.trim()).filter(Boolean)
  return all.filter((task) => filters.some((f) => (f.startsWith('category:') ? task.category === f.slice(9) : f.endsWith('*') ? task.id.startsWith(f.slice(0, -1)) : task.id === f)))
}

function estimateTasks(options: Options, tasks: EvalTask[]): { estimates: TaskEstimate[]; basis: string } {
  const ceilingOf = (id: string) => tasks.find((task) => task.id === id)?.limits?.budgetTokens ?? 400_000
  if (options.estimateFrom) {
    const files = fs.statSync(options.estimateFrom).isDirectory() ? listResultFiles(options.estimateFrom) : [options.estimateFrom]
    const runs = files.flatMap((file) => (JSON.parse(fs.readFileSync(file, 'utf8')) as RunResults).tasks)
    const estimates = tasks.map((task) => {
      const mine = runs.filter((run) => run.id === task.id && run.status !== 'skipped')
      const mean = (pick: (u: (typeof mine)[number]['usage']) => number | undefined) => (mine.length ? mine.reduce((s, run) => s + (pick(run.usage) ?? 0), 0) / mine.length : 0)
      return {
        id: task.id,
        input: mean((u) => u.inputTokens), output: mean((u) => u.outputTokens),
        uncached: mean((u) => u.uncachedInputTokens ?? u.inputTokens), cacheRead: mean((u) => u.cacheReadTokens), cacheWrite: mean((u) => u.cacheWriteTokens),
        ceiling: ceilingOf(task.id),
      }
    })
    return { estimates, basis: `per-task means of ${runs.length} earlier run(s) in ${options.estimateFrom}` }
  }
  // One offline pass against the scripted mock model, scaled to a real model's turn count.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-ab-estimate-'))
  try {
    const result = spawnSync(process.execPath, evalArgs('mock', options, out, 1), { cwd: REPO, env: armEnv('A', options), encoding: 'utf8' })
    const file = listResultFiles(out)[0]
    if (!file) throw new Error(`the mock measurement wrote no results (exit ${result.status}):\n${(result.stdout ?? '').slice(-2_000)}${(result.stderr ?? '').slice(-2_000)}`)
    const runs = (JSON.parse(fs.readFileSync(file, 'utf8')) as RunResults).tasks
    const estimates = tasks.map((task) => {
      const run = runs.find((candidate) => candidate.id === task.id)
      const input = Math.min(ceilingOf(task.id) / (1 + ASSUMED_SPLIT.outputPerInput), (run?.usage.inputTokens ?? 0) * TURN_FACTOR)
      return {
        id: task.id, input, output: input * ASSUMED_SPLIT.outputPerInput,
        uncached: input * ASSUMED_SPLIT.uncached, cacheRead: input * ASSUMED_SPLIT.cacheRead, cacheWrite: input * ASSUMED_SPLIT.cacheWrite,
        ceiling: ceilingOf(task.id),
      }
    })
    return {
      estimates,
      basis: `the mock model's tokens × ${TURN_FACTOR} (real models take more turns), capped at each task's budget; assumed input split ${ASSUMED_SPLIT.uncached * 100}% uncached / ${ASSUMED_SPLIT.cacheRead * 100}% cache read / ${ASSUMED_SPLIT.cacheWrite * 100}% cache write, output ${ASSUMED_SPLIT.outputPerInput * 100}% of input`,
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
}

function dryRun(options: Options): void {
  const tasks = selectedTasks(options.tasks)
  if (tasks.length === 0) throw new Error(`--tasks matched nothing: ${options.tasks}`)
  const runs = schedule(options.repeat)
  console.log(`\n  A/B plan (dry run: nothing is sent to a paid model)\n`)
  console.log(`  tasks: ${tasks.map((task) => task.id).join(', ')}`)
  console.log(`  ${options.repeat} round(s) × 2 arms = ${runs.length} eval run(s), ${runs.length * tasks.length} task run(s); ARTEMIS_MAX_CONTEXT_TOKENS=${options.contextTokens} (a task's own setup.maxContextTokens wins)`)
  for (const { round, arm } of runs) {
    console.log(`    round ${round} ${arm}: ARTEMIS_MAX_CONTEXT_TOKENS=${options.contextTokens} ARTEMIS_CACHE_AWARE_SUMMARY=${ARM_ENV[arm]} npm run eval:zh -- --live --tasks ${options.tasks} --out ${path.relative(REPO, roundDir(options, arm, round))}`)
  }
  const { estimates, basis } = estimateTasks(options, tasks)
  const perRound = estimates.reduce((acc, e) => ({
    input: acc.input + e.input, output: acc.output + e.output, uncached: acc.uncached + e.uncached,
    cacheRead: acc.cacheRead + e.cacheRead, cacheWrite: acc.cacheWrite + e.cacheWrite, ceiling: acc.ceiling + e.ceiling,
  }), { input: 0, output: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, ceiling: 0 })
  const n = runs.length
  const total = { input: perRound.input * n, output: perRound.output * n, uncached: perRound.uncached * n, cacheRead: perRound.cacheRead * n, cacheWrite: perRound.cacheWrite * n, ceiling: perRound.ceiling * n }
  const m = (x: number) => `${(x / 1e6).toFixed(2)}M`
  console.log(`\n  Estimate (${basis}):`)
  for (const e of estimates) console.log(`    ${e.id.padEnd(28)} ~${m(e.input + e.output)} tokens per run (task budget ${m(e.ceiling)})`)
  console.log(`  whole experiment: ~${m(total.input + total.output)} tokens (input ${m(total.input)}: uncached ${m(total.uncached)}, cache read ${m(total.cacheRead)}, cache write ${m(total.cacheWrite)}; output ${m(total.output)})`)
  console.log(`  hard ceiling (every task at its token budget): ${m(total.ceiling)} tokens`)
  const prices = loadPriceTable({ repo: REPO, file: options.prices })
  const rates = prices ? ratesFor(prices, options.model) : undefined
  if (prices && rates) {
    const typical = priceUsage(prices, options.model, { uncached: total.uncached, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite, output: total.output })!
    const ceilingInput = total.ceiling / (1 + ASSUMED_SPLIT.outputPerInput)
    const worst = priceUsage(prices, options.model, { uncached: ceilingInput, cacheRead: 0, cacheWrite: 0, output: total.ceiling - ceilingInput })!
    console.log(`  cost at the rates for ${options.model ?? 'the default'} (${prices.source}): ~$${typical.toFixed(2)} typical; at most ~$${worst.toFixed(2)} (every task at its budget, no cache hits)`)
  } else {
    console.log('  cost: give rates (--prices <file> [--model <id>], or evals/prices.local.json) to see dollars;')
    console.log('        $ ≈ (uncached × input + cache read × read rate + cache write × write rate + output × output rate) / 1M')
  }
  console.log(`\n  To spend it: npm run eval:zh:ab -- --live${options.tasks !== DEFAULT_TASKS ? ` --tasks ${options.tasks}` : ''}${options.repeat !== 3 ? ` --repeat ${options.repeat}` : ''} --budget-usd <cap>\n`)
}

function main(): void {
  const options = parseOptions(process.argv.slice(2))
  if (options.mode === 'compare') return report(options.compare![0], options.compare![1])
  if (options.mode === 'dry-run') return dryRun(options)
  runArms(options.mode, options)
}

try {
  main()
} catch (error) {
  console.error(`\n  eval:zh:ab failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
