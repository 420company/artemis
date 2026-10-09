/**
 * scripts/evalZh/report.ts — run summary, the Markdown table, and the
 * before/after comparison of two result files (--compare).
 */

import type { CategorySummary, RunResults, RunSummary, TaskResult, Usage } from './types.js'

export function addUsage(into: Usage, more: Usage): Usage {
  into.requests += more.requests
  into.inputTokens += more.inputTokens
  into.outputTokens += more.outputTokens
  return into
}

const countsAsRun = (task: TaskResult) => task.status !== 'skipped'

export function summarize(tasks: TaskResult[], wallMs: number): RunSummary {
  const ran = tasks.filter(countsAsRun)
  const byCategory: Record<string, CategorySummary> = {}
  for (const task of ran) {
    const entry = byCategory[task.category] ?? { tasks: 0, passed: 0, passRate: 0, meanScore: 0 }
    entry.tasks += 1
    if (task.status === 'pass') entry.passed += 1
    entry.meanScore += task.score
    byCategory[task.category] = entry
  }
  for (const entry of Object.values(byCategory)) {
    entry.passRate = entry.tasks ? entry.passed / entry.tasks : 0
    entry.meanScore = entry.tasks ? entry.meanScore / entry.tasks : 0
  }
  const usage = tasks.reduce((acc, task) => addUsage(acc, task.usage), { requests: 0, inputTokens: 0, outputTokens: 0 })
  const costs = tasks.map((task) => task.costUsd).filter((cost): cost is number => typeof cost === 'number')
  const passed = ran.filter((task) => task.status === 'pass').length
  return {
    tasks: ran.length,
    passed,
    passRate: ran.length ? passed / ran.length : 0,
    meanScore: ran.length ? ran.reduce((acc, task) => acc + task.score, 0) / ran.length : 0,
    byCategory,
    usage,
    ...(costs.length ? { costUsd: costs.reduce((a, b) => a + b, 0) } : {}),
    wallMs,
  }
}

const pct = (value: number) => `${Math.round(value * 100)}%`
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const tokens = (usage: Usage) => usage.inputTokens + usage.outputTokens
const money = (value: number | undefined) => (value === undefined ? '-' : `$${value.toFixed(4)}`)

export function renderMarkdown(results: RunResults): string {
  const { summary } = results
  const lines: string[] = [
    `# Artemis 中文任务评测 / Chinese task eval — ${results.startedAt}`,
    '',
    `- Mode: **${results.mode}**${results.provider?.model ? ` · model \`${results.provider.model}\`` : ''}${results.provider?.worker ? ` · worker \`${results.provider.worker}\`` : ''}`,
    `- Commit: \`${results.git?.commit?.slice(0, 10) ?? '?'}\`${results.git?.branch ? ` (${results.git.branch}${results.git.dirty ? ', dirty' : ''})` : ''}`,
    `- Passed **${summary.passed}/${summary.tasks}** (${pct(summary.passRate)}), mean grader score ${pct(summary.meanScore)}`,
    `- Tokens ${tokens(summary.usage).toLocaleString('en-US')} (in ${summary.usage.inputTokens.toLocaleString('en-US')}, out ${summary.usage.outputTokens.toLocaleString('en-US')}, ${summary.usage.requests} model calls) · cost ${money(summary.costUsd)} · wall time ${secs(summary.wallMs)}`,
    '',
    '| Category | Passed | Pass rate | Mean score |',
    '|---|---|---|---|',
    ...Object.entries(summary.byCategory).sort(([a], [b]) => a.localeCompare(b)).map(([category, entry]) =>
      `| ${category} | ${entry.passed}/${entry.tasks} | ${pct(entry.passRate)} | ${pct(entry.meanScore)} |`),
    '',
    '| Task | Category | Status | Graders | Tokens | Cost | Time | Failed graders |',
    '|---|---|---|---|---|---|---|---|',
    ...results.tasks.map((task) => {
      const graded = task.graders.filter((grader) => grader.status !== 'skip')
      const passed = graded.filter((grader) => grader.status === 'pass').length
      const failed = task.graders.filter((grader) => grader.status === 'fail').map((grader) => `${grader.id}: ${grader.detail}`.replace(/\|/g, '\\|').slice(0, 140))
      const extra = task.error ? [`error: ${task.error}`.replace(/\|/g, '\\|').slice(0, 140)] : []
      return `| ${task.id}${task.repeat ? ` (#${task.repeat})` : ''} | ${task.category} | ${task.status} | ${passed}/${graded.length} | ${tokens(task.usage).toLocaleString('en-US')} | ${money(task.costUsd)} | ${secs(task.durationMs)} | ${[...failed, ...extra].join('<br>') || '-'} |`
    }),
    '',
  ]
  return lines.join('\n')
}

/** Per-task and per-category deltas between an older and a newer run. */
export function renderComparison(before: RunResults, after: RunResults): string {
  const lines: string[] = []
  if (before.mode !== after.mode) lines.push(`⚠ comparing a ${before.mode} run with a ${after.mode} run`)
  if (before.provider?.model !== after.provider?.model) lines.push(`⚠ model changed: ${before.provider?.model ?? '-'} → ${after.provider?.model ?? '-'}`)
  const delta = (a: number, b: number, format: (n: number) => string) => {
    const d = b - a
    return `${format(a)} → ${format(b)} (${d >= 0 ? '+' : ''}${format(d)})`
  }
  lines.push(
    `Pass rate: ${delta(before.summary.passRate, after.summary.passRate, pct)} · ${before.summary.passed}/${before.summary.tasks} → ${after.summary.passed}/${after.summary.tasks}`,
    `Mean score: ${delta(before.summary.meanScore, after.summary.meanScore, pct)}`,
    `Tokens: ${delta(tokens(before.summary.usage), tokens(after.summary.usage), (n) => Math.round(n).toLocaleString('en-US'))}`,
    `Cost: ${before.summary.costUsd !== undefined && after.summary.costUsd !== undefined ? delta(before.summary.costUsd, after.summary.costUsd, (n) => `$${n.toFixed(4)}`) : `${money(before.summary.costUsd)} → ${money(after.summary.costUsd)}`}`,
    `Wall time: ${delta(before.summary.wallMs, after.summary.wallMs, secs)}`,
    '',
    '| Category | Before | After | Δ pass rate |',
    '|---|---|---|---|',
  )
  const categories = [...new Set([...Object.keys(before.summary.byCategory), ...Object.keys(after.summary.byCategory)])].sort()
  for (const category of categories) {
    const a = before.summary.byCategory[category]
    const b = after.summary.byCategory[category]
    const d = (b?.passRate ?? 0) - (a?.passRate ?? 0)
    lines.push(`| ${category} | ${a ? `${a.passed}/${a.tasks}` : '-'} | ${b ? `${b.passed}/${b.tasks}` : '-'} | ${a && b ? `${d >= 0 ? '+' : ''}${Math.round(d * 100)}pp` : 'n/a'} |`)
  }
  // Repeated runs: compare the pass fraction per task id.
  const byId = (results: RunResults) => {
    const map = new Map<string, { pass: number; runs: number; score: number; tokens: number; ms: number }>()
    for (const task of results.tasks.filter(countsAsRun)) {
      const entry = map.get(task.id) ?? { pass: 0, runs: 0, score: 0, tokens: 0, ms: 0 }
      entry.runs += 1
      entry.pass += task.status === 'pass' ? 1 : 0
      entry.score += task.score
      entry.tokens += tokens(task.usage)
      entry.ms += task.durationMs
      map.set(task.id, entry)
    }
    return map
  }
  const a = byId(before)
  const b = byId(after)
  const shared = [...a.keys()].filter((id) => b.has(id)).sort()
  const onlyBefore = [...a.keys()].filter((id) => !b.has(id))
  const onlyAfter = [...b.keys()].filter((id) => !a.has(id))
  if (onlyBefore.length || onlyAfter.length) {
    const passOf = (map: typeof a) => shared.reduce((acc, id) => acc + map.get(id)!.pass / map.get(id)!.runs, 0)
    lines.unshift(`⚠ task sets differ: ${shared.length} shared, ${onlyBefore.length} only before, ${onlyAfter.length} only after. On the shared tasks: ${passOf(a).toFixed(1)} → ${passOf(b).toFixed(1)} passed.`)
  }
  const changed: string[] = []
  for (const id of shared) {
    const x = a.get(id)!
    const y = b.get(id)!
    const label = (entry: { pass: number; runs: number }) => (entry.runs > 1 ? `${entry.pass}/${entry.runs}` : entry.pass ? 'pass' : 'fail')
    const scoreDelta = y.score / y.runs - x.score / x.runs
    const tokenDelta = Math.round(y.tokens / y.runs - x.tokens / x.runs)
    if (x.pass / x.runs !== y.pass / y.runs || Math.abs(scoreDelta) > 1e-9) {
      changed.push(`| ${id} | ${label(x)} | ${label(y)} | ${scoreDelta >= 0 ? '+' : ''}${Math.round(scoreDelta * 100)}pp | ${tokenDelta >= 0 ? '+' : ''}${tokenDelta} |`)
    }
  }
  lines.push('', changed.length ? '| Task | Before | After | Δ score | Δ tokens |\n|---|---|---|---|---|' : 'No shared task changed status or score.')
  lines.push(...changed)
  return lines.join('\n')
}
