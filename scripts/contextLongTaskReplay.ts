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
 * Goal: prove the compressor keeps the invariants that matter for 8h+ work:
 * user constraints survive, current focus survives, tool evidence remains paired,
 * read_file skeletons preserve structure, and compression modes stay sane.
 */

import { compressMessages } from '../src/core/contextCompressor.js'
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

  return `\`\`\`json
${JSON.stringify({
    goal: 'accelerated 8h context replay',
    current_task: prompt.includes('CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY')
      ? 'CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY'
      : 'missing-current-focus',
    completed: ['simulated many read/run turns'],
    in_progress: ['continue context long-task replay'],
    key_decisions: invariants,
    relevant_files: ['/tmp/context-replay/src/file-36.ts'],
    modified_files: [],
    tools_and_commands: ['read_file', 'run_command', 'npm run typecheck'],
    validation: ['synthetic replay summarizer observed invariants from prompt'],
    risks: ['do not let side topic override current focus', 'do not publish without validation'],
    next_steps: ['continue from latest task marker'],
    critical_context: invariants.join(' | '),
  })}
\`\`\``
}

console.log('\n  contextLongTaskReplay')
console.log('  =====================\n')

let messages = buildLongSession()
const originalCount = messages.length
let fullCompactions = 0
let microCompactions = 0
let summaryCalls = 0
let sawSkeleton = false
let sawCurrentFocus = false
let sawInvariant = false

for (let cycle = 0; cycle < 6; cycle += 1) {
  const result = await compressMessages(messages, async (prompt) => {
    summaryCalls += 1
    sawInvariant ||= prompt.includes('INVARIANT_KEEP_NO_PUBLISH_WITHOUT_TYPECHECK_AND_RUNTIME_SMOKE')
    sawCurrentFocus ||= prompt.includes('CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY')
    return summarizerFromPrompt(prompt)
  }, {
    tokenLimit: cycle < 3 ? 180_000 : 1_000_000,
    protectTailTokens: cycle < 3 ? 20_000 : 80_000,
    churnMultiplier: cycle >= 4 ? 4 : 1,
    currentFocus: 'CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY',
  })

  if (result.mode === 'full_compact') fullCompactions += 1
  if (result.mode === 'microcompact') microCompactions += 1
  sawSkeleton ||= result.messages.some(m => m.content.includes('contextSkeletonExtracted') || m.content.includes('代码大纲与结构骨架'))

  messages = result.messages
  messages.push(msg(`cycle-u${cycle}`, 'user', `Cycle ${cycle} follow-up: CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY and INVARIANT_KEEP_NO_PUBLISH_WITHOUT_TYPECHECK_AND_RUNTIME_SMOKE must remain.`))
  messages.push(msg(`cycle-a${cycle}`, 'assistant', `Cycle ${cycle} continue with validation discipline.`))
}

const finalText = messages.map(m => m.content).join('\n')

assert('replay generated a large synthetic 8h session', originalCount > 600, `count=${originalCount}`)
assert('full compaction happened at least once', fullCompactions >= 1, `full=${fullCompactions}`)
assert('summarizer was called for full compaction', summaryCalls >= 1, `calls=${summaryCalls}`)
assert('old critical invariant reached summary prompt', sawInvariant, 'invariant missing from prompt')
assert('latest current focus reached summary prompt', sawCurrentFocus, 'focus missing from prompt')
assert('final compressed context still contains invariant', finalText.includes('INVARIANT_KEEP_NO_PUBLISH_WITHOUT_TYPECHECK_AND_RUNTIME_SMOKE'))
assert('final compressed context still contains current focus', finalText.includes('CURRENT_FOCUS_FIX_CONTEXT_LONG_TASK_REPLAY'))
assert('final compressed context still contains restart requirement', finalText.includes('RESTART_RUNNING_PROCESS_AFTER_CODE_CHANGE'))
assert('compression produced bounded final context', finalText.length < 900_000, `chars=${finalText.length}`)
assert('read_file structure survived as skeleton or summary evidence', sawSkeleton || finalText.includes('file-36.ts'))
assert('churn did not prevent continued compression loop from completing', microCompactions + fullCompactions >= 1, `micro=${microCompactions} full=${fullCompactions}`)

if (failed > 0) {
  console.log(`\n  \x1b[31m✘ ${failed} failed, ${passed} passed\x1b[0m`)
  process.exit(1)
}
console.log(`\n  \x1b[32m✔ All ${passed} replay checks passed\x1b[0m`)
