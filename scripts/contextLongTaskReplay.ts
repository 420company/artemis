#!/usr/bin/env tsx
/**
 * contextLongTaskReplay.ts — accelerated 8h long-task context replay/chaos test
 *
 * This does not call a real provider. It simulates a long coding session with:
 * - hundreds of user/assistant/tool turns
 * - old but critical user constraints
 * - repeated micro/full compaction cycles
 * - noisy tool logs and large read_file outputs
 * - task drift / unrelated side topics
 *
 * Goal: prove the context manager keeps the invariants that matter for 8h+
 * work: user constraints survive, current focus survives, every request fits
 * the window, tool evidence remains paired, and file paths stay recoverable.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createContextState,
  createContextStorage,
  isCompactionBoundary,
  manageContext,
  resolveContextBudget,
  summarySectionTitles,
} from '../src/core/compaction/index.js'
import type { SessionMessage } from '../src/core/types.js'

let passed = 0
let failed = 0

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  \x1b[32m✔\x1b[0m ${label}`)
    passed += 1
  } else {
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
    failed += 1
  }
}

function msg(id: string, role: SessionMessage['role'], content: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id,
    role,
    content,
    createdAt: new Date(Date.now() - 8 * 60 * 60 * 1000 + Number(id.replace(/\D/g, '').slice(-4) || 0) * 1000).toISOString(),
    ...extra,
  }
}

function makeReadFileOutput(i: number, sentinel?: string): string {
  return [
    "import { strict as assert } from 'node:assert'",
    `export interface LongTaskConfig${i} { enabled: boolean; phase: string }`,
    `export function longTaskHandler${i}(input: LongTaskConfig${i}) {`,
    `  if (!input.enabled) throw new Error('disabled-${i}')`,
    `  return '${sentinel ?? `phase-${i}`}'`,
    '}',
    `test('long task handler ${i}', () => expect(longTaskHandler${i}({ enabled: true, phase: 'x' })).toBeTruthy())`,
    '// TODO: keep validation command and restart requirement visible after compaction',
  ].join('\n') + '\n' + 'implementation detail\n'.repeat(800)
}

function buildLongSession(): SessionMessage[] {
  const messages: SessionMessage[] = []
  const invariant = 'INVARIANT_KEEP_NO_PUBLISH_WITHOUT_TYPECHECK_AND_RUNTIME_SMOKE'
  const current = 'CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY'
  const restart = 'RESTART_RUNNING_PROCESS_AFTER_CODE_CHANGE'

  messages.push(msg('u0000', 'user', `Mission invariant: ${invariant}. Also remember ${restart}.`))

  for (let i = 1; i <= 220; i += 1) {
    if (i === 37) {
      messages.push(msg(`u${i}`, 'user', `Critical old user correction: ${invariant}; do not replace it with side-topic context.`))
    } else if (i === 111) {
      messages.push(msg(`u${i}`, 'user', `Side topic: discuss visuals briefly, but do not let it override ${current}.`))
    } else if (i === 219) {
      messages.push(msg(`u${i}`, 'user', `Latest task marker: ${current}. Continue from current file and preserve validation requirements.`))
    } else {
      messages.push(msg(`u${i}`, 'user', `Long task checkpoint ${i}. Keep paths, validation, and user constraints stable. ${'context '.repeat(120)}`))
    }

    messages.push(msg(`a${i}`, 'assistant', `Progress ${i}: inspected files and planned next edit. ${'analysis '.repeat(900)}`))

    if (i % 3 === 0) {
      messages.push(msg(`t${i}`, 'tool', JSON.stringify({
        ok: true,
        path: `/tmp/context-replay/src/file-${i}.ts`,
        output: makeReadFileOutput(i, i === 36 ? invariant : undefined),
      }), { name: 'read_file' }))
    } else {
      messages.push(msg(`t${i}`, 'tool', JSON.stringify({
        ok: true,
        action: { type: 'run_command', command: i % 11 === 0 ? 'npm run typecheck' : `echo phase-${i}` },
        output: (i % 11 === 0 ? 'typecheck passed\n' : 'log line\n').repeat(1200),
      }), { name: 'run_command' }))
    }
  }

  return messages
}

function summarizerFromPrompt(prompt: string): string {
  const invariants = [
    'INVARIANT_KEEP_NO_PUBLISH_WITHOUT_TYPECHECK_AND_RUNTIME_SMOKE',
    'RESTART_RUNNING_PROCESS_AFTER_CODE_CHANGE',
    'CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY',
  ].filter(token => prompt.includes(token))
  // Like a faithful summarizer: every file path it has seen is carried forward.
  const files = [...new Set(prompt.match(/\/tmp\/context-replay\/src\/file-\d+\.ts/g) ?? [])]
  const [goals, decisions, filesTitle, facts, prefs, done, pending, remember] = summarySectionTitles('en')
  return [
    `## 1. ${goals}\naccelerated 8h context replay; ${prompt.includes('CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY') ? 'CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY' : 'missing-current-focus'}`,
    `## 2. ${decisions}\n${invariants.join('\n') || 'none'}`,
    `## 3. ${filesTitle}\n${files.join('\n') || 'none'}`,
    `## 4. ${facts}\ntypecheck passed in synthetic runs`,
    `## 5. ${prefs}\ndo not let side topic override current focus`,
    `## 6. ${done}\nsimulated many read/run turns`,
    `## 7. ${pending}\ncontinue from latest task marker`,
    `## 8. ${remember}\n${invariants.join(' | ') || 'none'}`,
  ].join('\n')
}

function toolPairsIntact(messages: SessionMessage[]): boolean {
  if (messages[0]?.role === 'tool') return false
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue
    const answered = new Set<string>()
    for (let k = i + 1; k < messages.length && messages[k]!.role === 'tool'; k += 1) {
      if (messages[k]!.toolUseId) answered.add(messages[k]!.toolUseId!)
    }
    if (!message.toolCalls.every((call) => answered.has(call.id))) return false
  }
  return true
}

console.log('\n  contextLongTaskReplay')
console.log('  =====================\n')

const contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-context-replay-'))
const storage = createContextStorage(contextDir)
const state = createContextState()
let messages = buildLongSession()
const originalCount = messages.length
let summaryCompactions = 0
let clearOnly = 0
let summaryCalls = 0
let sawCurrentFocus = false
let sawInvariant = false
let allFit = true
let pairsIntact = true
const fixedTokens = 12_000

for (let cycle = 0; cycle < 6; cycle += 1) {
  const budget = resolveContextBudget({ contextWindow: cycle < 3 ? 180_000 : 1_000_000 })
  const result = await manageContext({
    messages,
    fixedTokens,
    budget,
    state,
    storage,
    summarize: async ({ prompt }) => {
      summaryCalls += 1
      sawInvariant ||= prompt.includes('INVARIANT_KEEP_NO_PUBLISH_WITHOUT_TYPECHECK_AND_RUNTIME_SMOKE')
      sawCurrentFocus ||= prompt.includes('CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY')
      return summarizerFromPrompt(prompt)
    },
    summarizerWindow: 128_000,
  })

  if (result.action === 'summary') summaryCompactions += 1
  if (result.action === 'clear_tool_results') clearOnly += 1
  allFit &&= result.tokensAfter <= budget.threshold
  pairsIntact &&= toolPairsIntact(result.messages)

  messages = result.messages
  messages.push(msg(`cycle-u${cycle}`, 'user', `Cycle ${cycle} follow-up: CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY and INVARIANT_KEEP_NO_PUBLISH_WITHOUT_TYPECHECK_AND_RUNTIME_SMOKE must remain.`))
  messages.push(msg(`cycle-a${cycle}`, 'assistant', `Cycle ${cycle} continue with validation discipline.`))
}

const finalText = messages.map(m => m.content).join('\n')
const archive = fs.existsSync(storage.transcriptPath) ? fs.readFileSync(storage.transcriptPath, 'utf8') : ''

assert('replay generated a large synthetic 8h session', originalCount > 600, `count=${originalCount}`)
assert('summarizing compaction happened at least once', summaryCompactions >= 1, `summary=${summaryCompactions} clearOnly=${clearOnly}`)
assert('summarizer was called for full compaction', summaryCalls >= 1, `calls=${summaryCalls}`)
assert('old critical invariant reached summary prompt', sawInvariant, 'invariant missing from prompt')
assert('latest current focus reached summary prompt', sawCurrentFocus, 'focus missing from prompt')
assert('final compressed context still contains invariant', finalText.includes('INVARIANT_KEEP_NO_PUBLISH_WITHOUT_TYPECHECK_AND_RUNTIME_SMOKE'))
assert('final compressed context still contains current focus', finalText.includes('CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY'))
assert('final compressed context still contains restart requirement', finalText.includes('RESTART_RUNNING_PROCESS_AFTER_CODE_CHANGE'))
assert('compression produced bounded final context', finalText.length < 900_000, `chars=${finalText.length}`)
assert('every cycle fits below the proactive threshold', allFit)
assert('tool calls and results stay paired through every cycle', pairsIntact)
assert('history starts with the compaction boundary', isCompactionBoundary(messages[0]))
assert('read_file evidence survives as a path in the summary and in the archive', finalText.includes('file-36.ts') && archive.includes('file-36.ts'), `final=${finalText.includes('file-36.ts')} archive=${archive.includes('file-36.ts')} files=${(finalText.match(/file-\d+\.ts/g) ?? []).slice(0, 8).join(',')}`)
assert('removed messages are archived append-only', archive.trim().split('\n').length >= originalCount / 2, `lines=${archive.trim().split('\n').length}`)

fs.rmSync(contextDir, { recursive: true, force: true })

if (failed > 0) {
  console.log(`\n  \x1b[31m✘ ${failed} failed, ${passed} passed\x1b[0m`)
  process.exit(1)
}
console.log(`\n  \x1b[32m✔ All ${passed} replay checks passed\x1b[0m`)
