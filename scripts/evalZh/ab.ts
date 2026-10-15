/**
 * scripts/evalZh/ab.ts — paired comparison of two eval arms (A: current
 * behaviour, D: cache-aware compaction summaries) and the ship rule.
 *
 * Runs of the same task and round are paired. Accuracy is the mean grader
 * score; d is the mean paired difference (D - A) and SE its standard error.
 * Ship when, with zero new 4xx errors:
 *   - accuracy is not worse (|d| <= SE) and D is at least 10% cheaper per
 *     completed task, or
 *   - accuracy is better (d > SE) and D costs at most 5% more per completed
 *     task.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { cacheHitRatio } from './pricing.js'
import { addCompactions, addUsage, count4xx } from './report.js'
import type { CompactionCounts, RunResults, TaskResult, Usage } from './types.js'

export type Arm = 'A' | 'D'

export interface ArmRuns {
  label: string
  /** Task results with `repeat` set to the round they belong to. */
  tasks: TaskResult[]
  files: string[]
}

/**
 * The task results of one arm: a result file, or a directory of them (one
 * per round, read in name order), each run keyed by its round and repeat.
 */
export function loadArm(target: string, label: string): ArmRuns {
  const stat = fs.statSync(target)
  const files = stat.isDirectory()
    ? listResultFiles(target)
    : [target]
  if (files.length === 0) throw new Error(`${label}: no result files under ${target}`)
  const tasks: TaskResult[] = []
  files.forEach((file, index) => {
    const results = JSON.parse(fs.readFileSync(file, 'utf8')) as RunResults
    // One file per round (round N, repeat r → N*100 + r), or one file with --repeat.
    for (const task of results.tasks) tasks.push({ ...task, repeat: files.length > 1 ? (index + 1) * 100 + (task.repeat ?? 1) : task.repeat ?? 1 })
  })
  return { label, tasks, files }
}

/** Result JSON files under a directory (recursively), in path order. */
export function listResultFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listResultFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.job.json')) out.push(full)
  }
  return out
}

export interface ArmStats {
  runs: number
  passed: number
  passRate: number
  accuracy: number
  usage: Usage
  costUsd?: number
  costPerCompleted?: number
  cacheHitRatio: number
  compactions: CompactionCounts
  fourxx: number
}

export interface Comparison {
  pairs: number
  unpaired: number
  a: ArmStats
  d: ArmStats
  /** Mean paired score difference D - A, and its standard error. */
  diff: number
  se: number
  /** D's cost per completed task relative to A's (0.85 = 15% cheaper). */
  costRatio?: number
  /** 4xx errors D has beyond A, by kind. */
  new4xx: Record<string, number>
  perTask: Array<{ id: string; a: ArmStats; d: ArmStats }>
  verdict: { ship: boolean; reason: string }
}

const key = (task: TaskResult) => `${task.id}#${task.repeat ?? 1}`

function statsOf(tasks: TaskResult[]): ArmStats {
  const usage = tasks.reduce((acc, task) => addUsage(acc, task.usage), { requests: 0, inputTokens: 0, outputTokens: 0 } as Usage)
  const compactions = tasks.reduce((acc, task) => addCompactions(acc, task.compactions), { tier1: 0, tier2: 0, mechanical: 0 } as CompactionCounts)
  const passed = tasks.filter((task) => task.status === 'pass').length
  const priced = tasks.every((task) => typeof task.costUsd === 'number')
  const costUsd = priced && tasks.length ? tasks.reduce((sum, task) => sum + (task.costUsd ?? 0), 0) : undefined
  return {
    runs: tasks.length,
    passed,
    passRate: tasks.length ? passed / tasks.length : 0,
    accuracy: tasks.length ? tasks.reduce((sum, task) => sum + task.score, 0) / tasks.length : 0,
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(costUsd !== undefined && passed > 0 ? { costPerCompleted: costUsd / passed } : {}),
    cacheHitRatio: cacheHitRatio(usage),
    compactions,
    fourxx: count4xx(usage),
  }
}

/** Paired comparison of arm A (current) and arm D (cache-aware summaries). */
export function compareArms(a: ArmRuns, d: ArmRuns): Comparison {
  const usable = (task: TaskResult) => task.status !== 'skipped'
  const byKey = (runs: ArmRuns) => new Map(runs.tasks.filter(usable).map((task) => [key(task), task]))
  const left = byKey(a)
  const right = byKey(d)
  const keys = [...left.keys()].filter((k) => right.has(k)).sort()
  const unpaired = left.size + right.size - 2 * keys.length
  const pairedA = keys.map((k) => left.get(k)!)
  const pairedD = keys.map((k) => right.get(k)!)
  const diffs = keys.map((k) => right.get(k)!.score - left.get(k)!.score)
  const n = diffs.length
  const diff = n ? diffs.reduce((s, x) => s + x, 0) / n : 0
  const variance = n > 1 ? diffs.reduce((s, x) => s + (x - diff) ** 2, 0) / (n - 1) : Number.NaN
  const se = n > 1 ? Math.sqrt(variance / n) : Number.NaN
  const sa = statsOf(pairedA)
  const sd = statsOf(pairedD)
  const costRatio = sa.costPerCompleted !== undefined && sd.costPerCompleted !== undefined && sa.costPerCompleted > 0
    ? sd.costPerCompleted / sa.costPerCompleted
    : sa.costUsd !== undefined && sd.costUsd !== undefined && sa.costUsd > 0 && sa.passed === 0 && sd.passed === 0
      ? sd.costUsd / sa.costUsd
      : undefined
  const new4xx: Record<string, number> = {}
  for (const [kind, count] of Object.entries(sd.usage.apiErrors ?? {})) {
    if (!/^4\d\d\b/.test(kind)) continue
    const extra = count - (sa.usage.apiErrors?.[kind] ?? 0)
    if (extra > 0) new4xx[kind] = extra
  }
  const ids = [...new Set(keys.map((k) => k.slice(0, k.lastIndexOf('#'))))].sort()
  const perTask = ids.map((id) => ({
    id,
    a: statsOf(pairedA.filter((task) => task.id === id)),
    d: statsOf(pairedD.filter((task) => task.id === id)),
  }))
  return { pairs: n, unpaired, a: sa, d: sd, diff, se, ...(costRatio !== undefined ? { costRatio } : {}), new4xx, perTask, verdict: shipRule({ pairs: n, diff, se, costRatio, new4xx }) }
}

/** The ship rule (see the top of this file). */
export function shipRule(input: { pairs: number; diff: number; se: number; costRatio?: number; new4xx: Record<string, number> }): { ship: boolean; reason: string } {
  const fresh = Object.values(input.new4xx).reduce((s, x) => s + x, 0)
  if (input.pairs < 2 || !Number.isFinite(input.se)) return { ship: false, reason: `not enough paired runs (${input.pairs})` }
  if (fresh > 0) return { ship: false, reason: `${fresh} new 4xx error(s) in D` }
  if (input.costRatio === undefined) return { ship: false, reason: 'cost unknown: run with rates (--prices) so $ per completed task can be compared' }
  const cheaper = 1 - input.costRatio
  const tie = Math.abs(input.diff) <= input.se
  if (tie && input.costRatio <= 0.9) return { ship: true, reason: `accuracy not worse (|d| ${fmt(Math.abs(input.diff))} ≤ SE ${fmt(input.se)}) and ${pctOf(cheaper)} cheaper per completed task` }
  if (input.diff > input.se && input.costRatio <= 1.05) return { ship: true, reason: `accuracy better (d ${fmt(input.diff)} > SE ${fmt(input.se)}) at ${pctOf(-cheaper)} cost per completed task` }
  if (input.diff < -input.se) return { ship: false, reason: `accuracy worse (d ${fmt(input.diff)} < -SE ${fmt(input.se)})` }
  if (tie) return { ship: false, reason: `accuracy not worse, but only ${pctOf(cheaper)} cheaper per completed task (needs ≥ 10%)` }
  return { ship: false, reason: `accuracy better, but ${pctOf(-cheaper)} cost per completed task (allows ≤ +5%)` }
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a')
const pctOf = (x: number) => `${x >= 0 ? '' : '-'}${Math.abs(x * 100).toFixed(1)}%`
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const money = (x: number | undefined) => (x === undefined ? '-' : `$${x.toFixed(4)}`)
const tokens = (x: number | undefined) => (x ?? 0).toLocaleString('en-US')
const paths = (counts: CompactionCounts) => {
  const entries = Object.entries(counts.paths ?? {})
  return `${counts.tier1}/${counts.tier2}${entries.length ? ` (${entries.map(([kind, count]) => `${kind} ${count}`).join(', ')})` : ''}`
}

/** The paired comparison table and the verdict, as Markdown. */
export function renderAbComparison(c: Comparison, labels: { a: string; d: string } = { a: 'A (current)', d: 'D (cache-aware summary)' }): string {
  const row = (name: string, a: string, d: string) => `| ${name} | ${a} | ${d} |`
  const lines = [
    `## A/B: ${labels.a} vs ${labels.d}`,
    '',
    `${c.pairs} paired run(s)${c.unpaired ? `, ${c.unpaired} unpaired run(s) left out` : ''}.`,
    '',
    `| Metric | ${labels.a} | ${labels.d} |`,
    '|---|---|---|',
    row('Completed (passed) / runs', `${c.a.passed}/${c.a.runs}`, `${c.d.passed}/${c.d.runs}`),
    row('Accuracy (mean grader score)', pct(c.a.accuracy), pct(c.d.accuracy)),
    row('$ total', money(c.a.costUsd), money(c.d.costUsd)),
    row('$ per completed task', money(c.a.costPerCompleted), money(c.d.costPerCompleted)),
    row('Input tokens (uncached / cache read / cache write)',
      `${tokens(c.a.usage.uncachedInputTokens)} / ${tokens(c.a.usage.cacheReadTokens)} / ${tokens(c.a.usage.cacheWriteTokens)}`,
      `${tokens(c.d.usage.uncachedInputTokens)} / ${tokens(c.d.usage.cacheReadTokens)} / ${tokens(c.d.usage.cacheWriteTokens)}`),
    row('Output tokens', tokens(c.a.usage.outputTokens), tokens(c.d.usage.outputTokens)),
    row('Cache-hit ratio', pct(c.a.cacheHitRatio), pct(c.d.cacheHitRatio)),
    row('Compactions tier 1 / tier 2 (paths)', paths(c.a.compactions), paths(c.d.compactions)),
    row('Summarizer requests / input tokens', `${tokens(c.a.usage.summarizerRequests)} / ${tokens(c.a.usage.summarizerInputTokens)}`, `${tokens(c.d.usage.summarizerRequests)} / ${tokens(c.d.usage.summarizerInputTokens)}`),
    row('4xx errors', String(c.a.fourxx), String(c.d.fourxx)),
    '',
    `- d (D − A, mean paired score difference) = ${fmt(c.diff)}, SE = ${fmt(c.se)}`,
    `- $ per completed task: ${c.costRatio === undefined ? 'n/a' : `D/A = ${c.costRatio.toFixed(3)} (${pctOf(1 - c.costRatio)} cheaper)`}`,
    `- New 4xx in D: ${Object.keys(c.new4xx).length ? Object.entries(c.new4xx).map(([kind, count]) => `${kind} ×${count}`).join(', ') : 'none'}`,
    `- **Ship rule: ${c.verdict.ship ? 'SHIP' : 'do not ship'}** — ${c.verdict.reason}`,
    '',
    '| Task | A passed | D passed | A accuracy | D accuracy | A $/completed | D $/completed | A cache hit | D cache hit | D compactions t1/t2 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...c.perTask.map(({ id, a, d }) =>
      `| ${id} | ${a.passed}/${a.runs} | ${d.passed}/${d.runs} | ${pct(a.accuracy)} | ${pct(d.accuracy)} | ${money(a.costPerCompleted)} | ${money(d.costPerCompleted)} | ${pct(a.cacheHitRatio)} | ${pct(d.cacheHitRatio)} | ${paths(d.compactions)} |`),
    '',
  ]
  return lines.join('\n')
}
