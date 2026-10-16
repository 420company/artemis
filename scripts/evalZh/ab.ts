/**
 * scripts/evalZh/ab.ts — paired comparison of two eval arms (A: current
 * behaviour, D: cache-aware compaction summaries) and the ship rule.
 *
 * Runs of the same task and round are paired. Accuracy is the mean grader
 * score; d is the mean paired difference (D - A) and SE its standard error.
 * Cost is compared per completed (passed) task, and the paired per-run cost
 * difference has its own SE. The verdict:
 *
 *   inconclusive  fewer than 2 pairs; D wrote fewer than MIN_CONTINUATIONS
 *                 summaries by continuation (the feature barely ran); a
 *                 cost that is unknown or has unpriced calls; or D cheaper
 *                 by >= 10% per completed task but within the paired noise
 *   do not ship   D completed no task while A did; a new 4xx error in D
 *                 (rate limits, 429, are counted apart and do not block);
 *                 accuracy worse than the non-inferiority margin
 *                 (d - SE < -margin) — all checked before the inconclusive
 *                 conditions on continuations and cost, so a broken D never
 *                 reads as "unknown"; or not cheap enough for the accuracy
 *                 it brings
 *   ship          accuracy non-inferior (d - SE >= -margin) and D at least
 *                 10% cheaper per completed task (the paired cost difference
 *                 below zero by more than its SE), or accuracy better
 *                 (d > SE) at no more than 5% extra cost per completed task
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { cacheHitRatio } from './pricing.js'
import { addCompactions, addUsage, count4xx, countRateLimited, isRateLimitError } from './report.js'
import type { CompactionCounts, RunResults, TaskResult, Usage } from './types.js'

/** Continuation summaries D must have written for the comparison to say anything about them. */
export const MIN_CONTINUATIONS = 3
/** Default non-inferiority margin on accuracy (mean grader score, 0-1). */
export const DEFAULT_MARGIN = 0.05

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
  /** Undefined when a run is unpriced (a call without rates) or nothing was priced. */
  costUsd?: number
  costPerCompleted?: number
  summarizerCostUsd?: number
  unpricedRequests: number
  cacheHitRatio: number
  compactions: CompactionCounts
  fourxx: number
  rateLimited: number
}

export type Verdict = { outcome: 'ship' | 'no-ship' | 'inconclusive'; reason: string }

export interface Comparison {
  pairs: number
  unpaired: number
  a: ArmStats
  d: ArmStats
  /** Mean paired score difference D - A, and its standard error. */
  diff: number
  se: number
  margin: number
  /** Mean paired cost difference per run (D - A, USD) and its standard error. */
  costDiff?: number
  costSE?: number
  /** D's cost per completed task relative to A's (0.85 = 15% cheaper). */
  costRatio?: number
  /** Non-rate-limit 4xx errors D has beyond A, by kind. */
  new4xx: Record<string, number>
  /** Tier-2 summaries D wrote by continuation. */
  continuations: number
  perTask: Array<{ id: string; a: ArmStats; d: ArmStats }>
  verdict: Verdict
}

const key = (task: TaskResult) => `${task.id}#${task.repeat ?? 1}`

function statsOf(tasks: TaskResult[]): ArmStats {
  const usage = tasks.reduce((acc, task) => addUsage(acc, task.usage), { requests: 0, inputTokens: 0, outputTokens: 0 } as Usage)
  const compactions = tasks.reduce((acc, task) => addCompactions(acc, task.compactions), { tier1: 0, tier2: 0, mechanical: 0 } as CompactionCounts)
  const passed = tasks.filter((task) => task.status === 'pass').length
  const priced = tasks.length > 0 && tasks.every((task) => typeof task.costUsd === 'number') && !usage.unpricedRequests
  const costUsd = priced ? tasks.reduce((sum, task) => sum + (task.costUsd ?? 0), 0) : undefined
  return {
    runs: tasks.length,
    passed,
    passRate: tasks.length ? passed / tasks.length : 0,
    accuracy: tasks.length ? tasks.reduce((sum, task) => sum + task.score, 0) / tasks.length : 0,
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(costUsd !== undefined && passed > 0 ? { costPerCompleted: costUsd / passed } : {}),
    ...(costUsd !== undefined ? { summarizerCostUsd: usage.summarizerCostUsd ?? 0 } : {}),
    unpricedRequests: usage.unpricedRequests ?? 0,
    cacheHitRatio: cacheHitRatio(usage),
    compactions,
    fourxx: count4xx(usage),
    rateLimited: countRateLimited(usage),
  }
}

function meanAndSe(values: number[]): { mean: number; se: number } {
  const n = values.length
  const mean = n ? values.reduce((s, x) => s + x, 0) / n : 0
  const variance = n > 1 ? values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : Number.NaN
  return { mean, se: n > 1 ? Math.sqrt(variance / n) : Number.NaN }
}

/** Paired comparison of arm A (current) and arm D (cache-aware summaries). */
export function compareArms(a: ArmRuns, d: ArmRuns, options: { margin?: number } = {}): Comparison {
  const margin = options.margin ?? DEFAULT_MARGIN
  const usable = (task: TaskResult) => task.status !== 'skipped'
  const byKey = (runs: ArmRuns) => new Map(runs.tasks.filter(usable).map((task) => [key(task), task]))
  const left = byKey(a)
  const right = byKey(d)
  const keys = [...left.keys()].filter((k) => right.has(k)).sort()
  const unpaired = left.size + right.size - 2 * keys.length
  const pairedA = keys.map((k) => left.get(k)!)
  const pairedD = keys.map((k) => right.get(k)!)
  const { mean: diff, se } = meanAndSe(keys.map((k) => right.get(k)!.score - left.get(k)!.score))
  const sa = statsOf(pairedA)
  const sd = statsOf(pairedD)
  const priced = sa.costUsd !== undefined && sd.costUsd !== undefined
  const cost = priced ? meanAndSe(keys.map((k) => (right.get(k)!.costUsd ?? 0) - (left.get(k)!.costUsd ?? 0))) : undefined
  const costRatio = priced && sa.costPerCompleted !== undefined && sd.costPerCompleted !== undefined && sa.costPerCompleted > 0
    ? sd.costPerCompleted / sa.costPerCompleted
    : priced && sa.passed === 0 && sd.passed === 0 && sa.costUsd! > 0
      ? sd.costUsd! / sa.costUsd!
      : undefined
  const new4xx: Record<string, number> = {}
  for (const [kind, count] of Object.entries(sd.usage.apiErrors ?? {})) {
    if (!/^4\d\d\b/.test(kind) || isRateLimitError(kind)) continue
    const extra = count - (sa.usage.apiErrors?.[kind] ?? 0)
    if (extra > 0) new4xx[kind] = extra
  }
  const continuations = sd.compactions.paths?.continuation ?? 0
  const ids = [...new Set(keys.map((k) => k.slice(0, k.lastIndexOf('#'))))].sort()
  const perTask = ids.map((id) => ({
    id,
    a: statsOf(pairedA.filter((task) => task.id === id)),
    d: statsOf(pairedD.filter((task) => task.id === id)),
  }))
  const unpriced = sa.unpricedRequests + sd.unpricedRequests
  return {
    pairs: keys.length, unpaired, a: sa, d: sd, diff, se, margin,
    ...(cost ? { costDiff: cost.mean, costSE: cost.se } : {}),
    ...(costRatio !== undefined ? { costRatio } : {}),
    new4xx, continuations, perTask,
    verdict: shipRule({ pairs: keys.length, diff, se, margin, costRatio, costDiff: cost?.mean, costSE: cost?.se, new4xx, continuations, unpriced, completedA: sa.passed, completedD: sd.passed }),
  }
}

/** The ship rule (see the top of this file). */
export function shipRule(input: {
  pairs: number
  diff: number
  se: number
  margin?: number
  costRatio?: number
  costDiff?: number
  costSE?: number
  new4xx: Record<string, number>
  continuations: number
  unpriced?: number
  /** Paired runs each arm completed (passed); a D that completes nothing A does is broken, not unknown. */
  completedA?: number
  completedD?: number
}): Verdict {
  const margin = input.margin ?? DEFAULT_MARGIN
  const fresh = Object.values(input.new4xx).reduce((s, x) => s + x, 0)
  // A broken D is a "no" before anything else is weighed: completion, errors, accuracy.
  if (input.pairs > 0 && input.completedD === 0 && (input.completedA ?? 0) > 0) {
    return { outcome: 'no-ship', reason: `D completed no task (A completed ${input.completedA})` }
  }
  if (input.pairs < 2 || !Number.isFinite(input.se)) return { outcome: 'inconclusive', reason: `not enough paired runs (${input.pairs})` }
  if (fresh > 0) return { outcome: 'no-ship', reason: `${fresh} new 4xx error(s) in D (rate limits not counted)` }
  if (input.diff - input.se < -margin) return { outcome: 'no-ship', reason: `accuracy worse than the margin (d − SE = ${fmt(input.diff - input.se)} < −${fmt(margin)})` }
  if (input.continuations < MIN_CONTINUATIONS) {
    return { outcome: 'inconclusive', reason: `D wrote only ${input.continuations} summary(ies) by continuation (needs ≥ ${MIN_CONTINUATIONS}): too few compactions during runs, or the summarizer is another model (run D with --d-mode main)` }
  }
  if (input.unpriced) return { outcome: 'inconclusive', reason: `${input.unpriced} call(s) without rates: add them to the rate file` }
  if (input.costRatio === undefined) return { outcome: 'inconclusive', reason: 'cost unknown: run with rates (--prices) so $ per completed task can be compared' }
  const better = input.diff > input.se
  const cheaper = 1 - input.costRatio
  const costSignificant = input.costDiff !== undefined && input.costSE !== undefined && Number.isFinite(input.costSE) && input.costDiff + input.costSE < 0
  if (better && input.costRatio <= 1.05) return { outcome: 'ship', reason: `accuracy better (d ${fmt(input.diff)} > SE ${fmt(input.se)}) at ${pctOf(-cheaper)} cost per completed task` }
  if (input.costRatio <= 0.9) {
    if (!costSignificant) return { outcome: 'inconclusive', reason: `${pctOf(cheaper)} cheaper per completed task, but the paired cost difference (${money(input.costDiff)} ± ${money(input.costSE)} per run) is within its SE` }
    return { outcome: 'ship', reason: `accuracy non-inferior (d − SE = ${fmt(input.diff - input.se)} ≥ −${fmt(margin)}) and ${pctOf(cheaper)} cheaper per completed task (paired ${money(input.costDiff)} ± ${money(input.costSE)} per run)` }
  }
  if (better) return { outcome: 'no-ship', reason: `accuracy better, but ${pctOf(-cheaper)} cost per completed task (allows ≤ +5%)` }
  return { outcome: 'no-ship', reason: `accuracy non-inferior, but only ${pctOf(cheaper)} cheaper per completed task (needs ≥ 10%)` }
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a')
const pctOf = (x: number) => `${x >= 0 ? '' : '-'}${Math.abs(x * 100).toFixed(1)}%`
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const money = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? '-' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(4)}`)
const tokens = (x: number | undefined) => (x ?? 0).toLocaleString('en-US')
const paths = (counts: CompactionCounts) => {
  const entries = Object.entries(counts.paths ?? {})
  return `${counts.tier1}/${counts.tier2}${entries.length ? ` (${entries.map(([kind, count]) => `${kind} ${count}`).join(', ')})` : ''}`
}
const armCost = (stats: ArmStats, value: number | undefined) => (stats.unpricedRequests ? 'unpriced' : money(value))
const VERDICT_LABEL: Record<Verdict['outcome'], string> = { ship: 'SHIP', 'no-ship': 'do not ship', inconclusive: 'INCONCLUSIVE' }

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
    row('$ total', armCost(c.a, c.a.costUsd), armCost(c.d, c.d.costUsd)),
    row('$ per completed task', armCost(c.a, c.a.costPerCompleted), armCost(c.d, c.d.costPerCompleted)),
    row('$ summarizer only', armCost(c.a, c.a.summarizerCostUsd), armCost(c.d, c.d.summarizerCostUsd)),
    row('Input tokens (uncached / cache read / cache write)',
      `${tokens(c.a.usage.uncachedInputTokens)} / ${tokens(c.a.usage.cacheReadTokens)} / ${tokens(c.a.usage.cacheWriteTokens)}`,
      `${tokens(c.d.usage.uncachedInputTokens)} / ${tokens(c.d.usage.cacheReadTokens)} / ${tokens(c.d.usage.cacheWriteTokens)}`),
    row('Output tokens', tokens(c.a.usage.outputTokens), tokens(c.d.usage.outputTokens)),
    row('Cache-hit ratio', pct(c.a.cacheHitRatio), pct(c.d.cacheHitRatio)),
    row('Compactions tier 1 / tier 2 (paths)', paths(c.a.compactions), paths(c.d.compactions)),
    row('Summarizer requests / input tokens', `${tokens(c.a.usage.summarizerRequests)} / ${tokens(c.a.usage.summarizerInputTokens)}`, `${tokens(c.d.usage.summarizerRequests)} / ${tokens(c.d.usage.summarizerInputTokens)}`),
    row('4xx errors (rate limits apart)', String(c.a.fourxx), String(c.d.fourxx)),
    row('Rate limited (429)', String(c.a.rateLimited), String(c.d.rateLimited)),
    '',
    `- d (D − A, mean paired score difference) = ${fmt(c.diff)}, SE = ${fmt(c.se)}, non-inferiority margin ${fmt(c.margin)}`,
    `- Paired cost difference per run (D − A): ${c.costDiff === undefined ? 'n/a' : `${money(c.costDiff)} ± ${money(c.costSE)} (SE)`}`,
    `- $ per completed task: ${c.costRatio === undefined ? 'n/a' : `D/A = ${c.costRatio.toFixed(3)} (${pctOf(1 - c.costRatio)} cheaper)`}`,
    `- Tier-2 summaries D wrote by continuation: ${c.continuations} (needs ≥ ${MIN_CONTINUATIONS})`,
    `- New 4xx in D: ${Object.keys(c.new4xx).length ? Object.entries(c.new4xx).map(([kind, count]) => `${kind} ×${count}`).join(', ') : 'none'}`,
    `- **Ship rule: ${VERDICT_LABEL[c.verdict.outcome]}** — ${c.verdict.reason}`,
    '',
    '| Task | A passed | D passed | A accuracy | D accuracy | A $/completed | D $/completed | A cache hit | D cache hit | D compactions t1/t2 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...c.perTask.map(({ id, a, d }) =>
      `| ${id} | ${a.passed}/${a.runs} | ${d.passed}/${d.runs} | ${pct(a.accuracy)} | ${pct(d.accuracy)} | ${armCost(a, a.costPerCompleted)} | ${armCost(d, d.costPerCompleted)} | ${pct(a.cacheHitRatio)} | ${pct(d.cacheHitRatio)} | ${paths(d.compactions)} |`),
    '',
  ]
  return lines.join('\n')
}
