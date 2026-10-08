#!/usr/bin/env tsx
/**
 * contextCompactionSmoke.ts — deterministic tests for context management
 * (src/core/compaction) and its use by runAgent (path A).
 *
 * No real provider is called: a fake provider and a fake summarizer stand in
 * for the models, and local HTTP servers stand in for provider APIs where the
 * adapters themselves are under test.
 */

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  BOUNDARY_MESSAGE_NAME,
  ContextOverflowError,
  createContextState,
  createContextStorage,
  detectConversationLanguage,
  getCompactionSummary,
  isContextOverflowError,
  isCompactionBoundary,
  manageContext,
  measureContext,
  recordProviderUsage,
  repairToolPairs,
  resolveContextBudget,
  spillToolResultIfLarge,
  summarySectionTitles,
  type ContextBudget,
  type ContextState,
  type SummarizeFn,
} from '../src/core/compaction/index.js'
import {
  countCjkChars,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  estimateToolSchemaTokens,
} from '../src/core/tokenEstimation.js'
import { MessagesCompatibleProvider } from '../src/providers/messagesCompatible.js'
import { OpenAICompatibleProvider } from '../src/providers/openaiCompatible.js'
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

let clock = Date.parse('2026-09-01T00:00:00Z')
function msg(role: SessionMessage['role'], content: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  clock += 1_000
  return {
    id: `m-${clock}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date(clock).toISOString(),
    ...extra,
  }
}

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `artemis-ctx-${label}-`))
}

/** Every native tool call is answered right after its turn, and every native result has its call. */
function toolPairsIntact(messages: readonly SessionMessage[]): { ok: boolean; detail?: string } {
  if (messages[0]?.role === 'tool') return { ok: false, detail: 'history starts with a tool result' }
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const answered = new Set<string>()
      let k = i + 1
      while (k < messages.length && messages[k]!.role === 'tool') {
        if (messages[k]!.toolUseId) answered.add(messages[k]!.toolUseId!)
        k += 1
      }
      for (const call of message.toolCalls) {
        if (!answered.has(call.id)) return { ok: false, detail: `call ${call.id} at ${i} has no result` }
      }
    }
    if (message.role === 'tool' && message.toolUseId) {
      let j = i - 1
      while (j >= 0 && messages[j]!.role === 'tool') j -= 1
      const owner = messages[j]
      if (!owner || !(owner.toolCalls ?? []).some((call) => call.id === message.toolUseId)) {
        return { ok: false, detail: `result ${message.toolUseId} at ${i} has no call` }
      }
    }
  }
  return { ok: true }
}

const MARKER = /(?:GOAL|DECISION|TODO|PREF|REMEMBER)_[A-Z0-9_]+|\/repo\/[\w./-]+/g

/**
 * Fake summarizer: keeps every marker it can see in the previous summary and
 * the new messages, under the 8 required section titles. It records every
 * request it receives.
 */
function markerSummarizer(log: Array<{ system: string; prompt: string }>): SummarizeFn {
  return async ({ system, prompt }) => {
    log.push({ system, prompt })
    const zh = system.includes('中文')
    const titles = summarySectionTitles(zh ? 'zh' : 'en')
    const markers = [...new Set(prompt.match(MARKER) ?? [])]
    const pick = (prefix: string) => markers.filter((m) => m.startsWith(prefix)).join(', ') || (zh ? '无' : 'none')
    return [
      `## 1. ${titles[0]}\n${pick('GOAL')}`,
      `## 2. ${titles[1]}\n${pick('DECISION')}`,
      `## 3. ${titles[2]}\n${pick('/repo/')}`,
      `## 4. ${titles[3]}\n${zh ? '无' : 'none'}`,
      `## 5. ${titles[4]}\n${pick('PREF')}`,
      `## 6. ${titles[5]}\n${zh ? '见上' : 'see above'}`,
      `## 7. ${titles[6]}\n${pick('TODO')}`,
      `## 8. ${titles[7]}\n${pick('REMEMBER')}`,
    ].join('\n')
  }
}

console.log('\n  contextCompactionSmoke')
console.log('  ======================\n')

// ── Token accounting ─────────────────────────────────────────────────────────

{
  const zh = '请重构这个模块并保持所有接口签名不变'.repeat(100)
  const ascii = 'export function add(a: number, b: number) { return a + b }\n'.repeat(50)
  assert(
    'tokens: CJK characters count as one token each (bytes/4 undercounted them)',
    countCjkChars(zh) === 1800 && estimateTokens(zh) >= 1800,
    `cjk=${countCjkChars(zh)} est=${estimateTokens(zh)}`,
  )
  assert(
    'tokens: non-CJK text stays at UTF-8 bytes / 4',
    estimateTokens(ascii) === Math.ceil(Buffer.byteLength(ascii) / 4),
    `est=${estimateTokens(ascii)}`,
  )
  const withCalls = msg('assistant', 'reading files', {
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/' + 'x'.repeat(4000) }) }],
    reasoningContent: 'r'.repeat(4000),
  })
  assert(
    'tokens: message estimate includes tool-call arguments and reasoning',
    estimateMessageTokens(withCalls) > 2000,
    `est=${estimateMessageTokens(withCalls)}`,
  )
  assert(
    'tokens: tool schemas are estimated',
    estimateToolSchemaTokens([{ type: 'function', name: 'read_file', description: 'd'.repeat(400), parameters: {} }]) > 100,
  )
}

{
  const state = createContextState()
  const history = [msg('user', 'hello'), msg('assistant', 'hi')]
  recordProviderUsage(state, { promptTokens: 50_000, source: 'provider' }, history, 1_000)
  const appended = [...history, msg('user', 'x'.repeat(4_000))]
  const measured = measureContext(state, appended, 1_000)
  assert(
    'accounting: next request = provider count of the last request + estimate of what was appended',
    measured.source === 'provider+delta' && measured.tokens >= 51_000 && measured.tokens < 51_100,
    JSON.stringify(measured),
  )
  const rewritten = [msg('user', 'other history')]
  assert(
    'accounting: a rewritten history falls back to a full estimate',
    measureContext(state, rewritten, 1_000).source === 'estimate',
  )
  recordProviderUsage(state, { promptTokens: 10, inputTokens: 10, cacheReadTokens: 90_000, cacheCreationTokens: 5_000, source: 'provider' }, history, 0)
  assert(
    'accounting: cache reads and writes count toward the context size',
    state.anchor?.promptTokens === 95_010,
    JSON.stringify(state.anchor),
  )
}

// Anthropic adapter, non-streaming and streaming, reports cache tokens.
{
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }
      const usage = { input_tokens: 50, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2_000, output_tokens: 10 }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const events = [
          { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 50, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2_000 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
          { type: 'message_stop' },
        ]
        for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'claude-test', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  try {
    const provider = new MessagesCompatibleProvider({ protocol: 'messages', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'claude-test' })
    const plain = await provider.complete([msg('user', 'hi')])
    const streamed = await provider.completeStream([msg('user', 'hi')], () => {})
    assert(
      'accounting: Anthropic usage includes cache_read and cache_creation tokens (non-streaming)',
      plain.usage?.promptTokens === 102_050 && plain.usage?.cacheReadTokens === 100_000 && plain.usage?.cacheCreationTokens === 2_000,
      JSON.stringify(plain.usage),
    )
    assert(
      'accounting: Anthropic usage includes cache_read and cache_creation tokens (streaming)',
      streamed.usage?.promptTokens === 102_050 && streamed.usage?.completionTokens === 10,
      JSON.stringify(streamed.usage),
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

{
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'gpt-test',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 80_000, completion_tokens: 5, total_tokens: 80_005, prompt_tokens_details: { cached_tokens: 64_000 } },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  try {
    const provider = new OpenAICompatibleProvider({ protocol: 'openai', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'gpt-test' })
    const result = await provider.complete([msg('user', 'hi')])
    assert(
      'accounting: OpenAI-compatible usage reports cached prompt tokens (prompt_tokens already includes them)',
      result.usage?.promptTokens === 80_000 && result.usage?.cacheReadTokens === 64_000,
      JSON.stringify(result.usage),
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// ── Budget ───────────────────────────────────────────────────────────────────

{
  const b128 = resolveContextBudget({ contextWindow: 128_000 })
  const b272 = resolveContextBudget({ contextWindow: 272_000 })
  const b1m = resolveContextBudget({ contextWindow: 1_000_000, maxOutputTokens: 64_000 })
  const unknown = resolveContextBudget({})
  assert(
    'budget: effective window = window - reserved output - safety margin',
    b128.effective === 128_000 - b128.reservedOutput - b128.safetyMargin && b128.reservedOutput === 16_000,
    JSON.stringify(b128),
  )
  assert(
    'budget: proactive threshold is ~78% of the effective window and below the window',
    Math.abs(b272.threshold / b272.effective - 0.78) < 0.01 && b272.threshold < 272_000 && b1m.threshold < 1_000_000,
    `${b272.threshold}/${b272.effective}`,
  )
  assert(
    'budget: follows the model window (1M compacts later than 128K) and defaults to 128K when unknown',
    b1m.threshold > b128.threshold * 5 && unknown.window === 128_000,
  )
  assert(
    'budget: recent tail is ~25% of the effective window',
    Math.abs(b128.tailTokens / b128.effective - 0.25) < 0.01,
  )
  const capped = resolveContextBudget({ contextWindow: 1_000_000, maxContextTokens: 200_000 })
  assert('budget: an explicit cost cap limits the window', capped.window === 200_000)
  const custom = resolveContextBudget({ contextWindow: 128_000, thresholdRatio: 0.5 })
  assert('budget: compression.threshold overrides the ratio', custom.threshold === Math.floor(custom.effective * 0.5))
}

// ── Overflow detection ──────────────────────────────────────────────────────

{
  const withStatus = (message: string, status?: number) => Object.assign(new Error(message), status ? { status } : {})
  const shapes: Array<[string, unknown, boolean]> = [
    ['OpenAI', withStatus("Server message: {\"error\":{\"message\":\"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.\",\"code\":\"context_length_exceeded\"}}", 400), true],
    ['Anthropic', withStatus('Server message: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}', 400), true],
    ['Anthropic max_tokens', withStatus('input length and `max_tokens` exceed context limit: 180000 + 64000 > 200000', 400), true],
    ['Gemini', withStatus('The input token count (1048577) exceeds the maximum number of tokens allowed (1048576).', 400), true],
    ['BytePlus', withStatus('{"error":{"code":"InvalidParameter","message":"Total tokens of image and text exceed max message tokens. Request id: x"}}', 400), true],
    ['413', withStatus('Payload Too Large', 413), true],
    ['rate limit', withStatus('Rate limit reached for gpt-4o: tokens per min (TPM): Limit 30000', 429), false],
    ['auth', withStatus('invalid x-api-key', 401), false],
    ['ContextOverflowError', new ContextOverflowError('x'), true],
  ]
  for (const [label, error, expected] of shapes) {
    assert(`overflow detection: ${label} → ${expected}`, isContextOverflowError(error) === expected)
  }
}

// ── Tier 1: spill on intake ──────────────────────────────────────────────────

{
  const dir = tmpDir('spill')
  const storage = createContextStorage(dir)
  const budget = resolveContextBudget({ contextWindow: 128_000 })
  const log = Array.from({ length: 3_000 }, (_, i) => `line ${i}: build step ok`).join('\n') + '\nIMPORTANT_TAIL_LINE'
  const envelope = JSON.stringify({ ok: true, action: { type: 'run_command', command: 'npm test' }, output: log }, null, 2)
  const spilled = spillToolResultIfLarge(envelope, {
    storage,
    toolName: 'run_command',
    inlineTokens: budget.inlineToolResultTokens,
    previewTokens: budget.toolPreviewTokens,
  })
  const parsed = JSON.parse(spilled.content) as { output: string; outputSavedTo: string; action: { command: string } }
  assert(
    'spill: large tool output goes to a file under the session directory',
    Boolean(spilled.savedTo) && spilled.savedTo!.startsWith(path.join(dir, 'tool-results')) && fs.readFileSync(spilled.savedTo!, 'utf8') === log,
    spilled.savedTo,
  )
  assert(
    'spill: the inline preview keeps head and tail with real newlines, the size, and the path',
    parsed.output.includes('line 0: build step ok\nline 1: build step ok') &&
      parsed.output.includes('IMPORTANT_TAIL_LINE') &&
      parsed.output.includes(spilled.savedTo!) &&
      parsed.action.command === 'npm test' &&
      estimateTokens(spilled.content) < budget.inlineToolResultTokens,
    parsed.output.slice(0, 300),
  )
  const small = spillToolResultIfLarge('short\noutput', { storage, inlineTokens: 100, previewTokens: 50 })
  assert('spill: small output is kept as is', small.content === 'short\noutput' && !small.savedTo)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── Tier 1: clear old tool results ──────────────────────────────────────────

{
  const dir = tmpDir('clear')
  const storage = createContextStorage(dir)
  const budget = resolveContextBudget({ contextWindow: 64_000 })
  const history: SessionMessage[] = [msg('user', 'GOAL_FIX_BUILD: make the build pass')]
  for (let i = 0; i < 20; i += 1) {
    history.push(msg('assistant', `step ${i}`, { toolCalls: [{ id: `r${i}`, name: 'read_file', arguments: JSON.stringify({ path: `/repo/src/f${i}.ts` }) }] }))
    history.push(msg('tool', `export const v${i} = 1\n`.repeat(400), { name: 'read_file', toolUseId: `r${i}` }))
  }
  history.push(msg('assistant', 'wrote file', { toolCalls: [{ id: 'w1', name: 'write_file', arguments: '{"path":"/repo/src/out.ts"}' }] }))
  history.push(msg('tool', 'w'.repeat(2_000), { name: 'write_file', toolUseId: 'w1' }))
  history.push(msg('user', 'continue'))
  const state = createContextState()
  const result = await manageContext({ messages: history, fixedTokens: 2_000, budget, state, storage })
  const cleared = result.messages.filter((m) => m.contextCleared)
  const first = cleared[0]
  assert(
    'tier 1: old tool results are cleared before any summarization',
    result.action === 'clear_tool_results' && cleared.length > 0 && result.tokensAfter <= budget.target,
    `${result.action} cleared=${cleared.length} after=${result.tokensAfter} target=${budget.target}`,
  )
  assert(
    'tier 1: placeholder is one line with tool, args, size and where to re-read',
    Boolean(first) && !first!.content.includes('\n') && first!.content.includes('read_file') &&
      first!.content.includes('/repo/src/f0.ts') && first!.content.includes('chars') &&
      first!.content.includes(first!.contextCleared!.savedTo!) &&
      fs.readFileSync(first!.contextCleared!.savedTo!, 'utf8').includes('export const v0 = 1'),
    first?.content,
  )
  assert(
    'tier 1: write results (execution evidence) and the recent tail stay intact',
    result.messages.find((m) => m.name === 'write_file')!.content.length === 2_000 &&
      result.messages.at(-1)!.content === 'continue' &&
      toolPairsIntact(result.messages).ok,
  )
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── Tier 2: three successive compactions keep goal, decisions, paths, todos ──

{
  const dir = tmpDir('rolling')
  const storage = createContextStorage(dir)
  const budget = resolveContextBudget({ contextWindow: 32_000 })
  const log: Array<{ system: string; prompt: string }> = []
  const summarize = markerSummarizer(log)
  const state = createContextState()
  let history: SessionMessage[] = [
    msg('user', '目标 GOAL_MIGRATE_DB：把数据库从 MySQL 迁移到 Postgres，保持所有接口不变。请记住 REMEMBER_NO_FRIDAY_DEPLOY。'),
  ]
  const boundaries: string[] = []
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    for (let i = 0; i < 14; i += 1) {
      const id = `c${cycle}-${i}`
      history.push(msg('user', `第 ${cycle} 轮第 ${i} 步：继续迁移。${'说明文字'.repeat(80)}${i === 3 ? ` 偏好 PREF_TABS_${cycle}` : ''}`))
      history.push(msg('assistant', `决定 DECISION_C${cycle}_${i}：使用事务批量迁移。`, {
        toolCalls: [{ id, name: 'read_file', arguments: JSON.stringify({ path: `/repo/db/migrate_${cycle}_${i}.sql` }) }],
      }))
      history.push(msg('tool', `-- migrate ${cycle}/${i}\n${'SELECT 1;\n'.repeat(120)}`, { name: 'read_file', toolUseId: id }))
      history.push(msg('assistant', `完成第 ${i} 步。待办 TODO_VERIFY_C${cycle}_${i}`))
    }
    const result = await manageContext({
      messages: history,
      fixedTokens: 1_500,
      budget,
      state,
      storage,
      summarize,
      summarizerWindow: 32_000,
      reason: 'manual',
    })
    history = result.messages
    boundaries.push(history[0]!.content)
    assert(
      `rolling compaction ${cycle}: history is replaced by boundary + tail and fits`,
      isCompactionBoundary(history[0]) && history[0]!.name === BOUNDARY_MESSAGE_NAME &&
        history[0]!.compaction!.index === cycle && result.tokensAfter <= budget.threshold &&
        toolPairsIntact(history).ok,
      `action=${result.action} after=${result.tokensAfter} threshold=${budget.threshold}`,
    )
  }
  const lastPrompt = log.at(-1)!.prompt
  const finalBoundary = boundaries.at(-1)!
  assert(
    'rolling compaction: the 3rd summarizer call sees the previous summary, not the whole history',
    lastPrompt.includes('<previous_summary>') && lastPrompt.includes('GOAL_MIGRATE_DB') &&
      !lastPrompt.includes('第 1 轮第 0 步'),
  )
  for (const marker of ['GOAL_MIGRATE_DB', 'DECISION_C1_0', 'DECISION_C2_5', '/repo/db/migrate_1_0.sql', 'TODO_VERIFY_C1_2', 'REMEMBER_NO_FRIDAY_DEPLOY', 'PREF_TABS_1']) {
    assert(`rolling compaction: "${marker}" survives 3 compactions (in the boundary message)`, finalBoundary.includes(marker))
  }
  assert(
    'rolling compaction: summarizer prompt and sections follow the conversation language (Chinese)',
    log.every((entry) => entry.system.includes('中文')) && finalBoundary.includes('目标与最新指令') &&
      finalBoundary.includes('上下文已压缩') && detectConversationLanguage(history) === 'zh',
  )
  assert(
    'rolling compaction: summarizer receives tool-call arguments and full message content',
    log[0]!.prompt.includes('[tool call read_file] {"path":"/repo/db/migrate_1_0.sql"}') &&
      log[0]!.prompt.includes('SELECT 1;\nSELECT 1;'),
  )
  const archived = fs.readFileSync(storage.transcriptPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { message: SessionMessage })
  assert(
    'rolling compaction: removed messages are archived append-only and the boundary names the archive',
    archived.length > 100 && archived[0]!.message.content.includes('GOAL_MIGRATE_DB') &&
      finalBoundary.includes(storage.transcriptPath),
    `archived=${archived.length}`,
  )
  assert('rolling compaction: getCompactionSummary returns the rolling summary', getCompactionSummary(history)?.includes('GOAL_MIGRATE_DB') === true)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── Tool pairs are never split ───────────────────────────────────────────────

{
  let violations = 0
  let firstViolation = ''
  for (let seed = 0; seed < 40; seed += 1) {
    const history: SessionMessage[] = [msg('user', 'start')]
    for (let i = 0; i < 30; i += 1) {
      const calls = 1 + ((seed + i) % 3)
      const ids = Array.from({ length: calls }, (_, k) => `s${seed}-${i}-${k}`)
      history.push(msg('assistant', `turn ${i}`, { toolCalls: ids.map((id) => ({ id, name: 'run_command', arguments: `{"command":"echo ${id}"}` })) }))
      for (const id of ids) history.push(msg('tool', `out ${id}\n`.repeat(30 + ((seed * 7 + i) % 90)), { name: 'run_command', toolUseId: id }))
      if (i % 7 === 0) history.push(msg('user', `note ${i}`))
    }
    const budget = resolveContextBudget({ contextWindow: 8_000 + seed * 900 })
    const result = await manageContext({
      messages: history,
      fixedTokens: 500,
      budget,
      state: createContextState(),
      summarize: async () => 'summary of earlier work, no markers here but long enough to be accepted',
      reason: seed % 2 === 0 ? 'manual' : 'overflow',
    })
    const check = toolPairsIntact(result.messages)
    if (!check.ok) {
      violations += 1
      firstViolation ||= `seed=${seed}: ${check.detail}`
    }
  }
  assert('tool pairs: never split across 40 compactions with varied windows and tails', violations === 0, firstViolation)

  const broken: SessionMessage[] = [
    msg('user', 'go'),
    msg('assistant', 'calling', { toolCalls: [{ id: 'a', name: 'list_files', arguments: '{}' }, { id: 'b', name: 'read_file', arguments: '{}' }] }),
    msg('tool', 'only a', { toolUseId: 'a', name: 'list_files' }),
    msg('user', 'interrupted and resumed'),
    msg('tool', 'orphan', { toolUseId: 'zzz', name: 'read_file' }),
  ]
  const repaired = repairToolPairs(broken)
  assert(
    'tool pairs: an interrupted call gets a synthetic result and an orphan result loses its id',
    repaired.changed && toolPairsIntact(repaired.messages).ok &&
      repaired.messages.some((m) => m.toolUseId === 'b' && m.content.includes('interrupted')),
  )
}

// ── Summarizer failure still fits ────────────────────────────────────────────

{
  const budget = resolveContextBudget({ contextWindow: 32_000 })
  const history: SessionMessage[] = []
  for (let i = 0; i < 80; i += 1) {
    history.push(msg('user', `request ${i} GOAL_KEEP_${i % 5} ${'detail '.repeat(120)}`))
    history.push(msg('assistant', `answer ${i} ${'analysis '.repeat(150)}`))
  }
  const state = createContextState()
  let calls = 0
  const failing: SummarizeFn = async () => {
    calls += 1
    throw new Error('503 upstream unavailable')
  }
  const result = await manageContext({ messages: history, fixedTokens: 2_000, budget, state, summarize: failing })
  assert(
    'fallback: summarizer failure still produces a history that fits, with a marker',
    result.action === 'fallback' && result.tokensAfter <= budget.threshold &&
      result.messages[0]!.content.includes('Mechanical summary') &&
      result.messages[0]!.compaction?.mode === 'fallback' &&
      result.messages.at(-1)!.content.startsWith('answer 79'),
    `action=${result.action} after=${result.tokensAfter} threshold=${budget.threshold}`,
  )
  assert('fallback: the summarizer was retried once before falling back', calls === 2, `calls=${calls}`)
  state.summaryFailures = 3
  calls = 0
  const grown = [...result.messages]
  for (let i = 0; i < 60; i += 1) grown.push(msg('user', `more ${i} ${'detail '.repeat(150)}`), msg('assistant', `ok ${i} ${'x '.repeat(200)}`))
  const again = await manageContext({ messages: grown, fixedTokens: 2_000, budget, state, summarize: failing })
  assert(
    'fallback: after 3 consecutive failures the summarizer is skipped until it recovers',
    calls === 0 && again.action === 'fallback' && again.tokensAfter <= budget.threshold,
    `calls=${calls} after=${again.tokensAfter}`,
  )
}

{
  // A single message larger than the whole window is shrunk, never sent as is.
  const budget = resolveContextBudget({ contextWindow: 16_000 })
  const history = [msg('user', 'old'), msg('assistant', 'ok'), msg('user', `paste: ${'日志内容'.repeat(20_000)}`)]
  const result = await manageContext({ messages: history, fixedTokens: 1_000, budget, state: createContextState(), reason: 'overflow' })
  assert(
    'fallback: an oversized latest message is shrunk so the request fits',
    result.tokensAfter <= budget.effective && result.messages.some((m) => m.content.includes('paste:')),
    `after=${result.tokensAfter} effective=${budget.effective}`,
  )
}

// ── Long Chinese session: 300+ turns with tool output stay under the window ──

{
  const dir = tmpDir('long-zh')
  const storage = createContextStorage(dir)
  const window = 64_000
  const budget: ContextBudget = resolveContextBudget({ contextWindow: window })
  const state: ContextState = createContextState()
  const log: Array<{ system: string; prompt: string }> = []
  const summarize = markerSummarizer(log)
  const fixedTokens = 6_000
  let history: SessionMessage[] = [msg('user', '总目标 GOAL_LONG_ZH：重构支付模块，所有改动都要跑测试。')]
  let maxRequest = 0
  let overWindow = 0
  let compactions = 0
  for (let turn = 1; turn <= 320; turn += 1) {
    history.push(msg('user', `第 ${turn} 轮：请继续处理支付模块的第 ${turn} 个子任务，注意边界条件和错误处理。${turn % 50 === 0 ? ` 决定 DECISION_T${turn}` : ''}`))
    const id = `t${turn}`
    history.push(msg('assistant', `好的，先运行测试。`, { toolCalls: [{ id, name: 'run_command', arguments: JSON.stringify({ command: `npm test -- pay${turn}` }) }] }))
    const output = Array.from({ length: 60 + (turn % 40) }, (_, i) => `测试用例 ${turn}.${i} 通过 ✓ src/pay/module${turn % 9}.ts`).join('\n')
    history.push(msg('tool', spillToolResultIfLarge(output, {
      storage, toolName: 'run_command', inlineTokens: budget.inlineToolResultTokens, previewTokens: budget.toolPreviewTokens,
    }).content, { name: 'run_command', toolUseId: id }))
    const managed = await manageContext({ messages: history, fixedTokens, budget, state, storage, summarize, summarizerWindow: window })
    history = managed.messages
    if (managed.action === 'summary' || managed.action === 'fallback') compactions += 1
    // The "provider" counts 10% more than the estimate, like a denser tokenizer.
    const actual = Math.ceil((fixedTokens + estimateMessagesTokens(history)) * 1.1)
    maxRequest = Math.max(maxRequest, actual)
    if (actual > window - budget.reservedOutput) overWindow += 1
    recordProviderUsage(state, { promptTokens: actual, source: 'provider' }, history, fixedTokens)
    history.push(msg('assistant', `第 ${turn} 个子任务完成，测试全部通过。`))
  }
  assert(
    'long Chinese session: 320 turns with tool output never exceed the window',
    overWindow === 0 && maxRequest < window,
    `max=${maxRequest} window=${window} over=${overWindow}`,
  )
  assert('long Chinese session: compacted several times with the summarizer', compactions >= 3 && log.length >= 3, `compactions=${compactions}`)
  const finalText = history.map((m) => m.content).join('\n')
  const decisions = [50, 100, 150, 200, 250, 300].map((t) => `DECISION_T${t}`)
  assert(
    'long Chinese session: the goal and every decision survive (boundary summary or verbatim tail)',
    history[0]!.content.includes('GOAL_LONG_ZH') && decisions.every((d) => finalText.includes(d)) &&
      history[0]!.content.includes('DECISION_T50'),
    decisions.filter((d) => !finalText.includes(d)).join(','),
  )
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failed > 0) {
  console.log(`\n  \x1b[31m✘ ${failed} failed, ${passed} passed\x1b[0m`)
  process.exit(1)
}
console.log(`\n  \x1b[32m✔ All ${passed} context compaction checks passed\x1b[0m`)
