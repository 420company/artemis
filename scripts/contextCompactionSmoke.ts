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
import { runAgent } from '../src/core/agent.js'
import { SessionStore } from '../src/storage/sessions.js'
import { PermissionManager } from '../src/security/permissions.js'
import { MessagesCompatibleProvider } from '../src/providers/messagesCompatible.js'
import { OpenAICompatibleProvider } from '../src/providers/openaiCompatible.js'
import type { SessionMessage } from '../src/core/types.js'
import type { ChatProvider, ProviderResponse } from '../src/providers/types.js'
import { applyProviderOverrides, getLastPromptTokens, getMessages, resetSession, restoreSessionStateForCwd, think } from '../src/brain.js'
import { parseRemoteCommand, runRemoteCommand } from '../src/bragi/runtime.js'
import { runHeadlessAgent } from '../src/services/headlessAgent.js'
import { HOSTED_DEFAULT_MAX_CONTEXT_TOKENS, resolveMaxContextTokens } from '../src/core/compaction/index.js'
import { fitOutputTokensToWindow } from '../src/providers/capabilities.js'

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

{
  // The budget's output reserve agrees with the adapters' max_tokens fitting:
  // a prompt that fills the effective window still gets the reserved output.
  let worst = ''
  for (const window of [8_000, 16_000, 32_000, 128_000, 200_000, 272_000, 1_000_000]) {
    for (const maxOutput of [undefined, 4_096, 16_000, 64_000, 128_000, 384_000]) {
      const budget = resolveContextBudget({ contextWindow: window, maxOutputTokens: maxOutput })
      const limit = maxOutput ?? budget.reservedOutput
      const fitted = fitOutputTokensToWindow(limit, window, budget.effective, true)
      if (fitted < Math.min(limit, budget.reservedOutput)) worst ||= `window=${window} max=${maxOutput} fitted=${fitted} reserved=${budget.reservedOutput}`
    }
  }
  assert('budget: reserved output matches fitOutputTokensToWindow at the effective limit', !worst, worst)
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

// ── Path A (runAgent) integration ────────────────────────────────────────────

type Request = { messages: SessionMessage[]; system: string }

function envelope(reply: string, actions: unknown[] = []): ProviderResponse {
  return { text: JSON.stringify({ reply, done: actions.length === 0, ...(actions.length ? { actions } : {}) }), raw: null }
}

{
  // The system prompt is byte-identical across turns and runs without compaction.
  const cwd = tmpDir('stable-system')
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'alpha\nbeta\n')
  const store = new SessionStore(cwd)
  const session = store.createSession({ title: 'stable system prompt' })
  await store.save(session)
  const requests: Request[] = []
  let call = 0
  const provider: ChatProvider = {
    contextWindow: 200_000,
    async complete(messages) {
      requests.push({ messages, system: messages[0]!.content })
      call += 1
      return call % 2 === 1
        ? envelope('reading', [{ type: 'read_file', path: 'notes.txt' }])
        : envelope('done reading')
    },
  }
  for (const input of ['first: read notes.txt', 'second: read it again', 'third: once more']) {
    await runAgent(session, input, {
      cwd, provider, sessionStore: store, permissionManager: new PermissionManager('accept-all', false), maxTurns: 4, profile: 'main',
    })
  }
  const systems = new Set(requests.map((r) => r.system))
  assert(
    'path A: system prompt is byte-identical across 6 requests in 3 runs',
    requests.length >= 6 && systems.size === 1,
    `requests=${requests.length} distinct=${systems.size}`,
  )
  assert(
    'path A: the system prompt carries no conversation summary or evidence digest',
    !requests[0]!.system.includes('Conversation summary:') && !requests[0]!.system.includes('Repository evidence:'),
  )
  const stored = JSON.parse(fs.readFileSync(path.join(cwd, '.artemis', 'sessions', `${session.id}.json`), 'utf8')) as { metadata?: { context?: ContextState } }
  assert('path A: context state is persisted with the session', stored.metadata?.context?.version === 1)
  fs.rmSync(cwd, { recursive: true, force: true })
}

{
  // Newlines survive in user messages, assistant code blocks and tool output.
  const cwd = tmpDir('newlines')
  fs.writeFileSync(path.join(cwd, 'a.ts'), 'export const a = 1\nexport const b = 2\n')
  const store = new SessionStore(cwd)
  const session = store.createSession({ title: 'newlines' })
  await store.save(session)
  const requests: Request[] = []
  let call = 0
  const code = 'Please fix this:\n```ts\nfunction f() {\n  return 1\n}\n```'
  const provider: ChatProvider = {
    async complete(messages) {
      requests.push({ messages, system: messages[0]!.content })
      call += 1
      return call === 1
        ? envelope('Reading:\n```ts\nconst x = 1\n```', [{ type: 'read_file', path: 'a.ts' }])
        : envelope('Done.\n- line one\n- line two')
    },
  }
  await runAgent(session, code, { cwd, provider, sessionStore: store, permissionManager: new PermissionManager('accept-all', false), maxTurns: 3, profile: 'main' })
  const second = requests[1]!.messages
  assert(
    'newlines: user code block reaches the provider unchanged',
    second.some((m) => m.role === 'user' && m.content === code),
  )
  assert(
    'newlines: assistant code block and tool output keep their newlines',
    second.some((m) => m.role === 'assistant' && m.content.includes('```ts\nconst x = 1\n```')) &&
      second.some((m) => m.role === 'tool' &&
        (JSON.parse(m.content) as { output: string }).output.includes('1 | export const a = 1\n2 | export const b = 2')),
  )
  fs.rmSync(cwd, { recursive: true, force: true })
}

{
  // Overflow error → forced compaction → retry succeeds; the compacted
  // history is persisted so the next run does not overflow again.
  const cwd = tmpDir('overflow')
  const store = new SessionStore(cwd)
  const session = store.createSession({ title: 'overflow recovery' })
  session.messages.push(msg('user', 'GOAL_OVERFLOW_TEST: keep the API stable'))
  for (let i = 0; i < 70; i += 1) {
    session.messages.push(msg('user', `question ${i} ${'context '.repeat(250)}`))
    session.messages.push(msg('assistant', `answer ${i} ${'detail '.repeat(250)}`))
  }
  await store.save(session)
  const realLimit = 60_000 // the provider's real limit is lower than the configured window
  let rejected = 0
  let accepted = 0
  const summarizerLog: Array<{ system: string; prompt: string }> = []
  const summarizerFn = markerSummarizer(summarizerLog)
  const summarizer: ChatProvider = {
    async complete(messages) {
      return { text: await summarizerFn({ system: messages[0]!.content, prompt: messages[1]!.content }), raw: null }
    },
  }
  const provider: ChatProvider = {
    contextWindow: 200_000,
    async complete(messages) {
      const size = estimateMessagesTokens(messages)
      if (size > realLimit) {
        rejected += 1
        throw Object.assign(new Error(`Server message: prompt is too long: ${size} tokens > ${realLimit} maximum`), { status: 400 })
      }
      accepted += 1
      return envelope('recovered')
    },
  }
  const notices: string[] = []
  const result = await runAgent(session, 'continue please', {
    cwd, provider, sessionStore: store, permissionManager: new PermissionManager('accept-all', false), maxTurns: 2, profile: 'main',
    resolveSummarizerProvider: () => summarizer,
    onContextCompaction: (notice) => notices.push(notice),
  })
  const reloaded = await new SessionStore(cwd).load(session.id)
  assert(
    'overflow: a context-length 400 triggers compaction and one successful retry',
    rejected === 1 && accepted === 1 && result.reply === 'recovered',
    `rejected=${rejected} accepted=${accepted} reply=${result.reply}`,
  )
  assert(
    'overflow: the compacted history is persisted and keeps the goal',
    isCompactionBoundary(reloaded.messages[0]) && reloaded.messages[0]!.content.includes('GOAL_OVERFLOW_TEST') &&
      reloaded.messages.length < 141 / 2 && notices.length === 1 && notices[0]!.includes('compacted'),
    `messages=${reloaded.messages.length} notices=${notices.join(' | ')}`,
  )
  // A second overflow after the forced compaction is reported clearly.
  const alwaysTooBig: ChatProvider = {
    async complete() {
      throw Object.assign(new Error('prompt is too long: 999999 tokens > 1000 maximum'), { status: 400 })
    },
  }
  let error: unknown
  try {
    await runAgent(reloaded, 'again', { cwd, provider: alwaysTooBig, sessionStore: store, permissionManager: new PermissionManager('accept-all', false), maxTurns: 2, profile: 'main' })
  } catch (caught) {
    error = caught
  }
  assert(
    'overflow: a second overflow is reported as a clear context error',
    error instanceof ContextOverflowError && /context window/.test((error as Error).message),
    String(error),
  )
  fs.rmSync(cwd, { recursive: true, force: true })
}

{
  // A weeks-long web session (300 Chinese turns with tool output) is brought
  // under the window on the next run, with the full history archived.
  const cwd = tmpDir('long-web')
  const store = new SessionStore(cwd)
  const session = store.createSession({ title: 'long web session' })
  session.messages.push(msg('user', '总目标 GOAL_WEB_LONG：维护电商后台，所有改动先写测试。'))
  for (let i = 0; i < 300; i += 1) {
    session.messages.push(msg('user', `第 ${i} 个请求：检查订单服务的日志并修复问题。`))
    session.messages.push(msg('assistant', `已检查第 ${i} 个问题，修改了 src/order/svc${i % 12}.ts。`))
    session.messages.push(msg('tool', JSON.stringify({ ok: true, action: { type: 'run_command', command: `npm test order${i}` }, output: `订单测试 ${i} 通过\n`.repeat(40) }, null, 2), { name: 'run_command' }))
  }
  await store.save(session)
  const window = 64_000
  const sizes: number[] = []
  const provider: ChatProvider = {
    contextWindow: window,
    async complete(messages) {
      if (messages[0]?.id === 'compaction-system') {
        return { text: await markerSummarizer([])({ system: messages[0]!.content, prompt: messages[1]!.content }), raw: null }
      }
      sizes.push(estimateMessagesTokens(messages))
      return envelope('好的，继续。')
    },
  }
  await runAgent(session, '继续处理第 301 个请求', { cwd, provider, sessionStore: store, permissionManager: new PermissionManager('accept-all', false), maxTurns: 2, profile: 'main' })
  const reloaded = await new SessionStore(cwd).load(session.id)
  const archivePath = path.join(cwd, '.artemis', 'sessions', session.id, 'transcript.jsonl')
  const archivedLines = fs.readFileSync(archivePath, 'utf8').trim().split('\n').length
  assert(
    'path A: a 300-turn stored session is compacted under the window on the next run',
    sizes.length === 1 && sizes[0]! < window && isCompactionBoundary(reloaded.messages[0]) && reloaded.messages[0]!.content.includes('GOAL_WEB_LONG'),
    `size=${sizes[0]} window=${window}`,
  )
  assert(
    'path A: removed messages are in the archive named by the boundary; stored history is bounded',
    archivedLines > 700 && reloaded.messages[0]!.content.includes(archivePath) && reloaded.messages.length < 150 &&
      archivedLines + reloaded.messages.length - 1 >= 902,
    `archived=${archivedLines} kept=${reloaded.messages.length}`,
  )
  fs.rmSync(cwd, { recursive: true, force: true })
}

{
  // Old session files load: missing fields, legacy keys, malformed messages.
  const cwd = tmpDir('legacy')
  const sessionsDir = path.join(cwd, '.artemis', 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  const id = 'legacy-session-0001'
  const legacy = {
    id,
    cwd,
    title: 'legacy',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    summary: '- user: old char summary line\n- assistant: another',
    harnessEvents: [],
    messages: [
      { id: 'l1', role: 'user', content: 'GOAL_LEGACY: keep working', createdAt: '2025-01-01T00:00:01.000Z' },
      { role: 'assistant', content: 'no id or timestamp' },
      { id: 'l3', role: 'tool_result', content: { text: 'structured' }, createdAt: '2025-01-01T00:00:03.000Z' },
      null,
      { id: 'l5', role: 'narrator', content: 'unknown role' },
      ...Array.from({ length: 200 }, (_, i) => ({ id: `big${i}`, role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'text '.repeat(300)}`, createdAt: '2025-01-01T01:00:00.000Z' })),
    ],
  }
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(legacy))
  const store = new SessionStore(cwd)
  const loaded = await store.load(id)
  assert(
    'old session files: load and migrate (ids, timestamps, roles, content) without dropping usable messages',
    loaded.messages.length === 203 &&
      loaded.messages.every((m) => typeof m.id === 'string' && typeof m.createdAt === 'string' && typeof m.content === 'string') &&
      loaded.messages[2]!.role === 'tool' && Array.isArray(loaded.tasks),
    `count=${loaded.messages.length}`,
  )
  const result = await manageContext({
    messages: loaded.messages,
    fixedTokens: 3_000,
    budget: resolveContextBudget({ contextWindow: 32_000 }),
    state: createContextState(),
    summarize: markerSummarizer([]),
  })
  assert(
    'old session files: an oversized legacy history compacts under the window',
    result.action === 'summary' && result.tokensAfter < resolveContextBudget({ contextWindow: 32_000 }).threshold &&
      result.messages[0]!.content.includes('GOAL_LEGACY'),
    `action=${result.action} after=${result.tokensAfter}`,
  )
  fs.rmSync(cwd, { recursive: true, force: true })
}

// ── Path B (think) integration ───────────────────────────────────────────────

type ChatBody = { messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }>; tools?: unknown[] }

function bodyChars(body: ChatBody): number {
  return body.messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0)
}

function isSummaryRequest(body: ChatBody): boolean {
  const system = body.messages.find((m) => m.role === 'system')
  return typeof system?.content === 'string' && /compact a long conversation|压缩一段用户与 AI 代理/.test(system.content)
}

async function withMockChatServer(
  handler: (body: ChatBody, res: http.ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => handler(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as ChatBody, res))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function writeProviderProfile(cwd: string, baseUrl: string, contextLength: number): void {
  fs.mkdirSync(path.join(cwd, '.artemis'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.artemis', 'providers.json'), JSON.stringify({
    defaultMainProfileId: 'mock',
    profiles: [{ id: 'mock', label: 'Mock', protocol: 'openai', apiKey: 'k', model: 'mock-chat-model', baseUrl, contextLength }],
  }))
}

function reply(res: http.ServerResponse, message: Record<string, unknown>, promptTokens = 1_000): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ model: 'mock-chat-model', choices: [{ message }], usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 } }))
}

const summaryText = summarySectionTitles('en').map((t, i) => `## ${i + 1}. ${t}\nGOAL_BRIDGE_TASK and earlier details`).join('\n')

{
  // Overflow → compaction → retry, with the compacted history written back.
  const cwd = tmpDir('think-overflow')
  const originalCwd = process.cwd()
  let rejected = 0
  let summaries = 0
  let lastMainChars = 0
  try {
    await withMockChatServer((body, res) => {
      if (isSummaryRequest(body)) {
        summaries += 1
        reply(res, { content: summaryText })
        return
      }
      const chars = bodyChars(body)
      if (chars > 120_000) {
        rejected += 1
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: "This model's maximum context length is 30000 tokens.", code: 'context_length_exceeded' } }))
        return
      }
      lastMainChars = chars
      reply(res, { content: '已恢复，继续处理。' }, Math.ceil(chars / 4))
    }, async (baseUrl) => {
      writeProviderProfile(cwd, baseUrl, 100_000)
      process.chdir(cwd)
      resetSession()
      applyProviderOverrides({})
      const history: SessionMessage[] = [msg('user', 'GOAL_BRIDGE_TASK: 维护这个项目')]
      for (let i = 0; i < 50; i += 1) history.push(msg(i % 2 ? 'assistant' : 'user', `turn ${i} ${'x'.repeat(4_000)}`))
      restoreSessionStateForCwd({ messages: history }, cwd)
      const result = await think('继续', () => {}, { cwd, permissionMode: 'read-only', disableNativeTools: true, contextDir: path.join(cwd, 'ctx') })
      const after = getMessages()
      assert(
        'path B: a context-length 400 triggers compaction and one successful retry',
        rejected === 1 && summaries >= 1 && result.reply === '已恢复，继续处理。' && lastMainChars <= 120_000,
        `rejected=${rejected} summaries=${summaries} reply=${result.reply}`,
      )
      assert(
        'path B: the compacted history is written back to the session (bridges persist it)',
        isCompactionBoundary(after[0]) && after.length < 30 && after.at(-1)?.content === '已恢复，继续处理。' &&
          fs.existsSync(path.join(cwd, 'ctx', 'transcript.jsonl')),
        `messages=${after.length}`,
      )
      assert(
        'path B: the context size reported is the last request, not a sum',
        getLastPromptTokens() === Math.ceil(lastMainChars / 4),
        `last=${getLastPromptTokens()} expected=${Math.ceil(lastMainChars / 4)}`,
      )
      // The next turn starts from the compacted history: no re-summarizing.
      const before = summaries
      await think('再继续', () => {}, { cwd, permissionMode: 'read-only', disableNativeTools: true, contextDir: path.join(cwd, 'ctx') })
      assert(
        'path B: the next turn does not re-summarize (compaction was persisted, not recomputed per round)',
        summaries === before && rejected === 1 && isCompactionBoundary(getMessages()[0]),
        `summaries=${summaries} before=${before}`,
      )
    })
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

{
  // An interjection that arrives while a tool round runs is kept, after the results.
  const cwd = tmpDir('think-interject')
  fs.writeFileSync(path.join(cwd, 'alpha.txt'), 'alpha\n')
  const originalCwd = process.cwd()
  const requests: ChatBody[] = []
  let polls = 0
  try {
    await withMockChatServer((body, res) => {
      requests.push(body)
      if (requests.length === 1) {
        reply(res, { content: '', tool_calls: [{ id: 'call_ls', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] })
        return
      }
      reply(res, { content: '目录里有 alpha.txt；已按新要求处理。' })
    }, async (baseUrl) => {
      writeProviderProfile(cwd, baseUrl, 128_000)
      process.chdir(cwd)
      resetSession()
      applyProviderOverrides({})
      await think('列出当前目录的文件', () => {}, {
        cwd,
        permissionMode: 'accept-all',
        contextDir: path.join(cwd, 'ctx'),
        pollRunningUserMessages: () => {
          polls += 1
          return polls === 2 ? ['INTERJECTION_ALSO_CHECK_BETA'] : []
        },
      })
      const second = requests[1]?.messages ?? []
      const assistantIdx = second.findIndex((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
      const toolIdx = second.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'call_ls')
      const interjectionIdx = second.findIndex((m) => typeof m.content === 'string' && m.content.includes('INTERJECTION_ALSO_CHECK_BETA'))
      assert(
        'path B: an interjection during a tool round is not lost and follows the tool results',
        assistantIdx >= 0 && toolIdx === assistantIdx + 1 && interjectionIdx > toolIdx &&
          getMessages().some((m) => m.content.includes('INTERJECTION_ALSO_CHECK_BETA')),
        `assistant=${assistantIdx} tool=${toolIdx} interjection=${interjectionIdx} polls=${polls}`,
      )
    })
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

{
  // A long bridge conversation stays under the window across many turns, and
  // the system prompt is the same on every request.
  const cwd = tmpDir('think-long')
  const originalCwd = process.cwd()
  const systems = new Set<string>()
  let maxChars = 0
  let summaries = 0
  try {
    await withMockChatServer((body, res) => {
      if (isSummaryRequest(body)) {
        summaries += 1
        reply(res, { content: summaryText })
        return
      }
      systems.add(String(body.messages.find((m) => m.role === 'system')?.content ?? ''))
      const chars = bodyChars(body)
      maxChars = Math.max(maxChars, chars)
      reply(res, { content: `收到。${'说明'.repeat(300)}` }, chars)
    }, async (baseUrl) => {
      writeProviderProfile(cwd, baseUrl, 32_000)
      process.chdir(cwd)
      resetSession()
      applyProviderOverrides({})
      for (let turn = 0; turn < 40; turn += 1) {
        await think(`第 ${turn} 条消息：${'需求描述'.repeat(400)}`, () => {}, { cwd, permissionMode: 'read-only', disableNativeTools: true, contextDir: path.join(cwd, 'ctx') })
      }
      // 32K window; at most ~1 char per CJK token, so chars bound tokens from above.
      assert(
        'path B: 40 long Chinese turns on a 32K model never exceed the window',
        maxChars < 32_000 && summaries >= 2,
        `maxChars=${maxChars} summaries=${summaries}`,
      )
      assert('path B: the system prompt is byte-identical on every request (no budget note)', systems.size === 1, `distinct=${systems.size}`)
    })
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

{
  // Bridges: an overflow that survives the retry still saves the compacted
  // history, so the next message does not hit the same overflow forever.
  const cwd = tmpDir('bridge-overflow')
  const originalCwd = process.cwd()
  let mainCalls = 0
  try {
    await withMockChatServer((body, res) => {
      if (isSummaryRequest(body)) {
        reply(res, { content: summaryText })
        return
      }
      mainCalls += 1
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'prompt is too long: 999999 tokens > 1000 maximum' } }))
    }, async (baseUrl) => {
      writeProviderProfile(cwd, baseUrl, 100_000)
      process.chdir(cwd)
      resetSession()
      applyProviderOverrides({})
      const store = new SessionStore(cwd)
      const stored = store.createSession({ title: 'bridge chat' })
      stored.messages.push(msg('user', 'GOAL_BRIDGE_TASK'))
      for (let i = 0; i < 40; i += 1) stored.messages.push(msg(i % 2 ? 'assistant' : 'user', 'y'.repeat(4_000)))
      await store.save(stored)
      const result = await runRemoteCommand(parseRemoteCommand('hello'), {
        binding: { storedSession: stored, permissionMode: 'read-only', rolledOver: false },
        store,
        locale: 'en',
        cwd,
      })
      const saved = await new SessionStore(cwd).load(stored.id)
      assert(
        'bridge: a persistent overflow reports a clear error and saves the compacted history',
        mainCalls === 2 && /context window/.test(result.replies[0] ?? '') &&
          isCompactionBoundary(saved.messages[0]) && saved.messages.length < 20 &&
          isCompactionBoundary(result.storedSession.messages[0]),
        `calls=${mainCalls} saved=${saved.messages.length} reply=${result.replies[0]?.slice(0, 120)}`,
      )
    })
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

// ── Hosted context cap ───────────────────────────────────────────────────────

{
  assert(
    'cost cap: hosted runs default to 200K, the interactive CLI keeps the full window',
    resolveMaxContextTokens({ mode: 'hosted', env: {} }) === HOSTED_DEFAULT_MAX_CONTEXT_TOKENS &&
      HOSTED_DEFAULT_MAX_CONTEXT_TOKENS === 200_000 &&
      resolveMaxContextTokens({ mode: 'interactive', env: {} }) === undefined,
  )
  assert(
    'cost cap: precedence is setup.agent.compression.maxContextTokens > ARTEMIS_MAX_CONTEXT_TOKENS > mode default',
    resolveMaxContextTokens({ mode: 'hosted', configured: 150_000, env: { ARTEMIS_MAX_CONTEXT_TOKENS: '300000' } }) === 150_000 &&
      resolveMaxContextTokens({ mode: 'hosted', env: { ARTEMIS_MAX_CONTEXT_TOKENS: '300_000' } }) === 300_000 &&
      resolveMaxContextTokens({ mode: 'interactive', env: { ARTEMIS_MAX_CONTEXT_TOKENS: '120000' } }) === 120_000,
  )
  assert(
    'cost cap: 0 or "off" removes the cap explicitly; junk values are ignored',
    resolveMaxContextTokens({ mode: 'hosted', configured: 0, env: {} }) === undefined &&
      resolveMaxContextTokens({ mode: 'hosted', env: { ARTEMIS_MAX_CONTEXT_TOKENS: 'off' } }) === undefined &&
      resolveMaxContextTokens({ mode: 'hosted', env: { ARTEMIS_MAX_CONTEXT_TOKENS: 'lots' } }) === 200_000,
  )
}

{
  // A 1M-window model in headless mode compacts at ~78% of the 200K cap,
  // not at ~78% of 1M.
  const cwd = tmpDir('headless-cap')
  const savedEnv = process.env.ARTEMIS_MAX_CONTEXT_TOKENS
  delete process.env.ARTEMIS_MAX_CONTEXT_TOKENS
  const infos: string[] = []
  const mainSizes: number[] = []
  try {
    await withMockChatServer((body, res) => {
      if (isSummaryRequest(body)) {
        reply(res, { content: summaryText })
        return
      }
      mainSizes.push(estimateTokens(body.messages.map((m) => typeof m.content === 'string' ? m.content : '').join('\n')))
      reply(res, { content: JSON.stringify({ reply: 'done', done: true }) })
    }, async (baseUrl) => {
      writeProviderProfile(cwd, baseUrl, 1_000_000)
      const store = new SessionStore(cwd)
      const session = store.createSession({ title: 'headless cap' })
      session.messages.push(msg('user', 'GOAL_HEADLESS_CAP'))
      // ~160K tokens: over 78% of the capped window, far below 78% of 1M.
      for (let i = 0; i < 80; i += 1) session.messages.push(msg(i % 2 ? 'assistant' : 'user', `turn ${i} ${'word '.repeat(1_600)}`))
      await store.save(session)
      const result = await runHeadlessAgent(cwd, 'continue', {
        sessionId: session.id,
        maxTurns: 2,
        onInfo: (message) => infos.push(message),
      })
      const budget = resolveContextBudget({ contextWindow: 200_000 })
      const contextLine = infos.find((line) => line.startsWith('[context] tokens~')) ?? ''
      assert(
        'cost cap: a 1M-window model in headless mode compacts at ~78% of 200K',
        result.contextNotices.length === 1 &&
          contextLine.includes('/200000 ') && contextLine.includes(`threshold=${budget.threshold}`) &&
          Math.abs(budget.threshold / (budget.effective) - 0.78) < 0.01 &&
          mainSizes.length >= 1 && mainSizes[0]! < budget.threshold,
        `notices=${result.contextNotices.length} line=${contextLine} sent=${mainSizes[0]}`,
      )
    })
  } finally {
    if (savedEnv === undefined) delete process.env.ARTEMIS_MAX_CONTEXT_TOKENS
    else process.env.ARTEMIS_MAX_CONTEXT_TOKENS = savedEnv
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

if (failed > 0) {
  console.log(`\n  \x1b[31m✘ ${failed} failed, ${passed} passed\x1b[0m`)
  process.exit(1)
}
console.log(`\n  \x1b[32m✔ All ${passed} context compaction checks passed\x1b[0m`)
