#!/usr/bin/env tsx
/**
 * thinkingReplaySmoke.ts — replaying signed thinking blocks on the Messages
 * API after the history changed (providers/thinkingReplay.ts).
 *
 * A local fake Messages endpoint stands in for the API and enforces the
 * preserved-thinking rules on every request, independently of the engine:
 * a thinking block is accepted only while the `system` prompt, the set of
 * `tools` and every message before it are what they were when the block was
 * produced, and the thinking blocks kept form an unbroken run of the
 * original sequence (earlier blocks may be removed from the front, a block
 * left out must stay out). Anything else gets the API's 400.
 *
 * Covers: a tool loop with a per-run context keeps every round's thinking;
 * tier-1 (cleared tool results) and tier-2 (summary boundary) compaction
 * followed by a request: no stale thinking goes out, the request succeeds,
 * and thinking produced after the compaction is replayed again; the same
 * history gives the same bytes, and each request extends the previous one;
 * a rejected request is retried once without thinking (and the dropped
 * turns are reported); models that do not check keep the old request shape;
 * path B (think()) end to end.
 *
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/thinkingReplaySmoke.ts
 */

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createContextState,
  createContextStorage,
  manageContext,
  resolveContextBudget,
} from '../src/core/compaction/index.js'
import type { SessionMessage } from '../src/core/types.js'
import { MessagesCompatibleProvider } from '../src/providers/messagesCompatible.js'
import {
  dropStoredThinking,
  isThinkingReplayError,
  modelChecksThinkingPrefix,
} from '../src/providers/thinkingReplay.js'
import { RUNTIME_CONTEXT_MESSAGE_NAME } from '../src/providers/runtimeContext.js'
import type { ProviderNativeFunctionTool, ProviderResponse } from '../src/providers/types.js'
import { applyProviderOverrides, getMessages, resetSession, think } from '../src/brain.js'

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

let clock = Date.parse('2026-10-01T00:00:00Z')
function msg(role: SessionMessage['role'], content: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  clock += 1_000
  return { id: `m-${clock}`, role, content, createdAt: new Date(clock).toISOString(), ...extra }
}

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `artemis-thinking-${label}-`))
}

// ── Fake Messages endpoint with the preserved-thinking check ────────────────

type Json = Record<string, unknown>
type Block = Json & { type?: string }
type ApiMessage = { role: string; content: string | Block[] }
type Body = { system?: Block[]; tools?: Json[]; messages: ApiMessage[]; stream?: boolean }
type Reply = { text?: string; toolUse?: { id: string; name: string; input: Json } }

const isThinking = (b: Block): boolean => b?.type === 'thinking' || b?.type === 'redacted_thinking'

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    const out: Json = {}
    for (const key of Object.keys(value).sort()) {
      if (key !== 'cache_control') out[key] = normalize((value as Json)[key])
    }
    return out
  }
  return value
}

/** What the check compares: system, the set of tools, and the messages before the block without their thinking. */
function prefixOf(body: Body, uptoMessage: number): string {
  const messages = body.messages.slice(0, uptoMessage).map((m) => ({
    role: m.role,
    content: (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content).filter((b) => !isThinking(b)),
  }))
  const tools = [...(body.tools ?? [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return JSON.stringify(normalize({ system: body.system ?? null, tools, messages }))
}

class FakeMessagesApi {
  readonly bodies: Body[] = []
  readonly rawBodies: string[] = []
  rejected = 0
  /** Reject the next request that carries thinking, whatever it holds (an unknown failure). */
  rejectNextThinking = false
  private produced = new Map<string, { prefix: string; previous: string | null }>()
  private seq = 0
  private server?: http.Server
  baseUrl = ''

  constructor(private readonly reply: (body: Body, index: number) => Reply) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => this.handle(Buffer.concat(chunks).toString('utf8'), res))
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()))
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  /** The first rule a request breaks, as the API words it; undefined when it passes. */
  violation(body: Body): string | undefined {
    let previousKept: string | null | undefined
    for (let i = 0; i < body.messages.length; i += 1) {
      const content = body.messages[i]!.content
      if (!Array.isArray(content)) continue
      for (let j = 0; j < content.length; j += 1) {
        const block = content[j]!
        if (!isThinking(block)) continue
        const where = `messages.${i}.content.${j}`
        const record = this.produced.get(String(block.signature))
        if (!record) return `${where}: Invalid \`signature\` in \`thinking\` block.`
        const bound = `${where}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".`
        if (record.prefix !== prefixOf(body, i)) return bound
        // Kept blocks must be an unbroken run: each one follows the block it followed when produced.
        if (previousKept !== undefined && record.previous !== previousKept) return bound
        previousKept = String(block.signature)
      }
    }
    return undefined
  }

  private handle(raw: string, res: http.ServerResponse): void {
    const body = JSON.parse(raw || '{}') as Body
    this.bodies.push(body)
    this.rawBodies.push(raw)
    const carriesThinking = body.messages.some((m) => Array.isArray(m.content) && m.content.some(isThinking))
    const problem = this.rejectNextThinking && carriesThinking
      ? 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.'
      : this.violation(body)
    if (carriesThinking) this.rejectNextThinking = false
    if (problem) {
      this.rejected += 1
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: problem } }))
      return
    }
    const signature = `sig-${++this.seq}`
    let previous: string | null = null
    for (const m of body.messages) {
      if (!Array.isArray(m.content)) continue
      for (const b of m.content) if (isThinking(b)) previous = String(b.signature)
    }
    this.produced.set(signature, { prefix: prefixOf(body, body.messages.length), previous })
    const reply = this.reply(body, this.bodies.length)
    const content: Block[] = [{ type: 'thinking', thinking: '', signature }]
    if (reply.text) content.push({ type: 'text', text: reply.text })
    if (reply.toolUse) content.push({ type: 'tool_use', ...reply.toolUse })
    const stopReason = reply.toolUse ? 'tool_use' : 'end_turn'
    const usage = { input_tokens: 100, output_tokens: 10 }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'fake', content, stop_reason: stopReason, usage }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events: Json[] = [{ type: 'message_start', message: { model: 'fake', usage } }]
    content.forEach((block, index) => {
      if (block.type === 'thinking') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } })
      } else if (block.type === 'text') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
      } else {
        events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
        events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
      }
      events.push({ type: 'content_block_stop', index })
    })
    events.push({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 10 } })
    events.push({ type: 'message_stop' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  }
}

/** Signatures of the thinking blocks a request carries, in order. */
function signaturesIn(body: Body | undefined): string[] {
  const out: string[] = []
  for (const m of body?.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (isThinking(b)) out.push(String(b.signature))
  }
  return out
}

function signatureOf(message: SessionMessage | undefined): string | undefined {
  const block = (message?.rawContentBlocks ?? []).find((b: Block) => isThinking(b)) as Block | undefined
  return block ? String(block.signature) : undefined
}

function withoutCacheMarks(messages: ApiMessage[]): string {
  return JSON.stringify(normalize(messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
  }))))
}

// ── Driving the provider like path B does ───────────────────────────────────

const TOOLS: ProviderNativeFunctionTool[] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]
const SYSTEM = msg('system', 'You are a careful engineer.')
const CONTEXT = msg('user', 'Per-run context: cwd=/repo; skills index: none.', { name: RUNTIME_CONTEXT_MESSAGE_NAME })

class Conversation {
  history: SessionMessage[] = []
  retries: string[] = []

  constructor(private readonly provider: MessagesCompatibleProvider, private readonly context: SessionMessage | undefined = CONTEXT) {}

  /** One request; the reply is stored like brain.ts stores it, dropped thinking is removed from the history. */
  async round(stream = false): Promise<ProviderResponse> {
    const messages = [SYSTEM, ...this.history, ...(this.context ? [this.context] : [])]
    const options = { nativeFunctionTools: TOOLS, onRetry: (_a: number, _d: number, reason: string) => { this.retries.push(reason) } }
    const response = stream
      ? await this.provider.completeStream(messages, () => {}, options)
      : await this.provider.complete(messages, options)
    this.history = dropStoredThinking(this.history, response.droppedThinkingMessageIds).messages
    this.history.push(msg('assistant', response.text, {
      ...(response.nativeToolCalls?.length
        ? { toolCalls: response.nativeToolCalls.map((c) => ({ id: c.callId, name: c.name, arguments: c.arguments })) }
        : {}),
      rawContentBlocks: response.rawContentBlocks,
      thinkingBinding: response.thinkingBinding,
    }))
    return response
  }

  toolResult(output: string): void {
    const call = this.history.at(-1)?.toolCalls?.[0]
    this.history.push(msg('tool', output, { name: call?.name ?? 'read_file', toolUseId: call?.id }))
  }
}

/** Replies with a read_file call until the user's latest request says otherwise. */
const readFiles = (body: Body, index: number): Reply => ({
  toolUse: { id: `toolu_${index}`, name: 'read_file', input: { path: `/repo/src/f${index}.ts` } },
})

// ── Model gating ────────────────────────────────────────────────────────────

{
  const checked = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-6', 'anthropic.claude-opus-5-5']
  const unchecked = ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5-1', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-opus-5-20260101', 'gpt-5', 'claude-test']
  assert(
    'gating: the models that check replayed thinking are recognized, older ones and others are not',
    checked.every(modelChecksThinkingPrefix) && !unchecked.some(modelChecksThinkingPrefix),
    JSON.stringify({ checked: checked.map(modelChecksThinkingPrefix), unchecked: unchecked.map(modelChecksThinkingPrefix) }),
  )
  assert(
    'gating: the API\'s replay 400 is recognized; other 400s are not',
    isThinkingReplayError(400, '{"error":{"message":"messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."}}') &&
      !isThinkingReplayError(400, '{"error":{"message":"prompt is too long"}}') &&
      !isThinkingReplayError(500, 'Invalid `signature` in `thinking` block'),
  )
}

// ── Tool loop with a per-run context ────────────────────────────────────────

{
  const api = new FakeMessagesApi((body, index) => index < 4 ? readFiles(body, index) : { text: 'done' })
  await api.start()
  try {
    const conv = new Conversation(new MessagesCompatibleProvider({ protocol: 'messages', baseUrl: api.baseUrl, apiKey: 'k', model: 'claude-opus-5-5' }))
    conv.history.push(msg('user', 'Fix the build.'))
    for (let round = 1; round <= 4; round += 1) {
      const response = await conv.round(round % 2 === 0)
      if (response.nativeToolCalls?.length) conv.toolResult(`contents of file ${round}`)
    }
    const last = api.bodies.at(-1)
    const sigs = conv.history.filter((m) => m.role === 'assistant').slice(0, 3).map(signatureOf)
    assert(
      'tool loop: every round\'s thinking is replayed unchanged and accepted (no 400, no retry)',
      api.rejected === 0 && conv.retries.length === 0 && JSON.stringify(signaturesIn(last)) === JSON.stringify(sigs),
      `rejected=${api.rejected} sent=${signaturesIn(last)} stored=${sigs}`,
    )
    const roles = last!.messages.map((m) => m.role).join(',')
    const contextAt = last!.messages.findIndex((m) => typeof m.content === 'string' && m.content.startsWith('Per-run context'))
    assert(
      'tool loop: the per-run context keeps the place it had when the loop\'s thinking was produced (after the request)',
      contextAt === 1 && roles.startsWith('user,user,assistant'),
      `contextAt=${contextAt} roles=${roles}`,
    )
    assert(
      'tool loop: each request repeats the previous one and appends to it (cache marks aside)',
      api.bodies.slice(1).every((body, i) => {
        const before = api.bodies[i]!.messages
        return withoutCacheMarks(body.messages.slice(0, before.length)) === withoutCacheMarks(before)
      }),
    )
  } finally {
    await api.stop()
  }
}

{
  // The bug: the per-run context re-sent last on each round moves, and a
  // checking API rejects every earlier round's thinking. A model that does
  // not check keeps that request shape; here the fake checks anyway, so the
  // 400 → strip → retry path is what keeps it working.
  const api = new FakeMessagesApi((body, index) => index < 3 ? readFiles(body, index) : { text: 'done' })
  await api.start()
  try {
    const conv = new Conversation(new MessagesCompatibleProvider({ protocol: 'messages', baseUrl: api.baseUrl, apiKey: 'k', model: 'claude-opus-5' }))
    conv.history.push(msg('user', 'Fix the build.'))
    await conv.round()
    conv.toolResult('contents of file 1')
    const second = await conv.round()
    const firstTry = api.bodies.at(-2)
    const retry = api.bodies.at(-1)
    assert(
      'retry: the old request shape (context last, all thinking replayed) is rejected by the check',
      api.rejected === 1 && signaturesIn(firstTry).length === 1 &&
        typeof firstTry!.messages.at(-1)!.content === 'string' && String(firstTry!.messages.at(-1)!.content).startsWith('Per-run context'),
      `rejected=${api.rejected}`,
    )
    assert(
      'retry: the rejected request is sent once more without any thinking, succeeds, and is reported',
      signaturesIn(retry).length === 0 && conv.retries.length === 1 &&
        second.droppedThinkingMessageIds?.length === 1 && signatureOf(conv.history[1]) === undefined &&
        Boolean(conv.history[1]!.toolCalls?.length),
      `retries=${conv.retries.length} dropped=${second.droppedThinkingMessageIds}`,
    )
  } finally {
    await api.stop()
  }
}

{
  // An unknown rejection on a checking model: one retry without thinking, and
  // the turns stay without it afterwards (no reinstated block, no repeated 400).
  const api = new FakeMessagesApi((body, index) => index < 4 ? readFiles(body, index) : { text: 'done' })
  await api.start()
  try {
    const conv = new Conversation(new MessagesCompatibleProvider({ protocol: 'messages', baseUrl: api.baseUrl, apiKey: 'k', model: 'claude-sonnet-5-5' }))
    conv.history.push(msg('user', 'Fix the build.'))
    await conv.round()
    conv.toolResult('one')
    api.rejectNextThinking = true
    await conv.round(true)
    conv.toolResult('two')
    const requestsBefore = api.bodies.length
    await conv.round()
    assert(
      'retry: a streaming request rejected for its thinking is retried once without it',
      api.rejected === 1 && conv.retries.length === 1 && signaturesIn(api.bodies[requestsBefore - 1]).length === 0,
      `rejected=${api.rejected} retries=${conv.retries.length}`,
    )
    assert(
      'retry: the next request leaves the dropped thinking out, replays the newer turn\'s, and succeeds first time',
      api.bodies.length === requestsBefore + 1 && api.rejected === 1 &&
        JSON.stringify(signaturesIn(api.bodies.at(-1))) === JSON.stringify([signatureOf(conv.history.filter((m) => m.role === 'assistant')[1])]),
      `sent=${signaturesIn(api.bodies.at(-1))}`,
    )
  } finally {
    await api.stop()
  }
}

// ── Compaction followed by a request ────────────────────────────────────────

async function longToolLoop(api: FakeMessagesApi, model: string, rounds: number): Promise<Conversation> {
  const conv = new Conversation(new MessagesCompatibleProvider({ protocol: 'messages', baseUrl: api.baseUrl, apiKey: 'k', model }))
  conv.history.push(msg('user', 'GOAL_FIX_BUILD: make the build pass'))
  for (let i = 0; i < rounds; i += 1) {
    await conv.round()
    conv.toolResult(`export const v${i} = 1\n`.repeat(400))
  }
  return conv
}

{
  // Tier 1: old tool results become placeholders.
  const api = new FakeMessagesApi(readFiles)
  await api.start()
  const dir = tmpDir('tier1')
  try {
    const conv = await longToolLoop(api, 'claude-opus-5-5', 20)
    const before = conv.history
    const managed = await manageContext({
      messages: before,
      fixedTokens: 2_000,
      budget: resolveContextBudget({ contextWindow: 64_000 }),
      state: createContextState(),
      storage: createContextStorage(dir),
    })
    conv.history = managed.messages
    const firstCleared = conv.history.findIndex((m) => m.contextCleared)
    const rejectedBefore = api.rejected
    const response = await conv.round()
    const sent = api.bodies.at(-1)!
    const assistants = before.filter((m) => m.role === 'assistant')
    const keptExpected = assistants.filter((m) => before.indexOf(m) < firstCleared).map(signatureOf)
    assert(
      'tier 1: the compaction cleared old tool results (setup)',
      managed.action === 'clear_tool_results' && firstCleared > 0,
      `${managed.action} firstCleared=${firstCleared}`,
    )
    assert(
      'tier 1: the next request succeeds first time: no stale thinking after the first cleared result',
      api.rejected === rejectedBefore && conv.retries.length === 0 &&
        JSON.stringify(signaturesIn(sent)) === JSON.stringify(keptExpected),
      `rejected=${api.rejected - rejectedBefore} sent=${signaturesIn(sent).length} expected=${keptExpected.length}`,
    )
    assert(
      'tier 1: the turns after the edit keep their text and tool calls; their ids are reported as dropped',
      (response.droppedThinkingMessageIds?.length ?? 0) === assistants.length - keptExpected.length &&
        sent.messages.filter((m) => m.role === 'assistant').every((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')),
      `dropped=${response.droppedThinkingMessageIds?.length}`,
    )
    // The loop goes on: thinking produced after the compaction is replayed.
    conv.toolResult('after compaction')
    await conv.round()
    const next = api.bodies.at(-1)!
    const newest = signatureOf(conv.history.filter((m) => m.role === 'assistant').at(-2))
    assert(
      'tier 1: thinking produced after the compaction is replayed in the tool loop and accepted',
      api.rejected === rejectedBefore && Boolean(newest) && signaturesIn(next).at(-1) === newest &&
        withoutCacheMarks(next.messages.slice(0, sent.messages.length)) === withoutCacheMarks(sent.messages),
      `newest=${newest} sent=${signaturesIn(next).slice(-2)}`,
    )
  } finally {
    await api.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

{
  // Tier 2: everything before a verbatim tail becomes one summary message.
  const api = new FakeMessagesApi(readFiles)
  await api.start()
  const dir = tmpDir('tier2')
  try {
    const conv = await longToolLoop(api, 'claude-opus-5-5', 30)
    const managed = await manageContext({
      messages: conv.history,
      fixedTokens: 2_000,
      budget: resolveContextBudget({ contextWindow: 32_000 }),
      state: createContextState(),
      storage: createContextStorage(dir),
      reason: 'manual',
    })
    conv.history = managed.messages
    const tail = conv.history.filter((m) => m.role === 'assistant')
    assert(
      'tier 2: the compaction left a summary boundary and a verbatim tail with signed thinking (setup)',
      (managed.action === 'summary' || managed.action === 'fallback') && conv.history[0]?.compaction?.kind === 'boundary' &&
        tail.length > 0 && tail.every((m) => signatureOf(m)),
      `${managed.action} tail=${tail.length}`,
    )
    // Without the fix, the kept turns' thinking goes out as stored: the check rejects it.
    const stale = api.violation({
      system: [{ type: 'text', text: SYSTEM.content }],
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages: [
        ...conv.history.map((m) => m.role === 'assistant'
          ? { role: 'assistant', content: m.rawContentBlocks as Block[] }
          : m.role === 'tool' ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolUseId, content: m.content }] } : { role: 'user', content: m.content }),
        { role: 'user', content: CONTEXT.content },
      ],
    })
    assert('tier 2: replaying the kept turns\' thinking as stored would be rejected (the bug)', Boolean(stale && /different conversation/.test(stale)), stale)
    const rejectedBefore = api.rejected
    const response = await conv.round()
    const sent = api.bodies.at(-1)!
    assert(
      'tier 2: the next request succeeds first time with no thinking from before the summary',
      api.rejected === rejectedBefore && conv.retries.length === 0 && signaturesIn(sent).length === 0 &&
        response.droppedThinkingMessageIds?.length === tail.length,
      `rejected=${api.rejected - rejectedBefore} sent=${signaturesIn(sent).length} dropped=${response.droppedThinkingMessageIds?.length}`,
    )
    // Same history, same bytes; then the loop goes on and replays the new thinking.
    const again = new MessagesCompatibleProvider({ protocol: 'messages', baseUrl: api.baseUrl, apiKey: 'k', model: 'claude-opus-5-5' })
    const replayHistory = conv.history.slice(0, -1)
    await again.complete([SYSTEM, ...replayHistory, CONTEXT], { nativeFunctionTools: TOOLS })
    await again.complete([SYSTEM, ...replayHistory, CONTEXT], { nativeFunctionTools: TOOLS })
    const raws = api.rawBodies.slice(-3)
    assert(
      'determinism: the same history gives byte-identical requests (stored drops or not)',
      raws[0] === raws[1] && raws[1] === raws[2],
    )
    conv.toolResult('after compaction')
    await conv.round()
    conv.toolResult('and again')
    await conv.round()
    const last = api.bodies.at(-1)!
    const fresh = conv.history.filter((m) => m.role === 'assistant').slice(-3, -1).map(signatureOf)
    assert(
      'tier 2: thinking produced after the summary is replayed in the following rounds and accepted',
      api.rejected === rejectedBefore && JSON.stringify(signaturesIn(last)) === JSON.stringify(fresh),
      `sent=${signaturesIn(last)} fresh=${fresh}`,
    )
    assert(
      'determinism: each request after the compaction repeats the previous one and appends to it',
      api.bodies.slice(-2).every((body, i, list) => i === 0 || withoutCacheMarks(body.messages.slice(0, list[i - 1]!.messages.length)) === withoutCacheMarks(list[i - 1]!.messages)),
    )
  } finally {
    await api.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

{
  // A model that does not check: request shape unchanged (context last, thinking as stored, no binding).
  const api = new FakeMessagesApi((body, index) => index < 2 ? readFiles(body, index) : { text: 'done' })
  await api.start()
  try {
    const conv = new Conversation(new MessagesCompatibleProvider({ protocol: 'messages', baseUrl: api.baseUrl, apiKey: 'k', model: 'claude-opus-4-8' }))
    conv.history.push(msg('user', 'hello'))
    const first = await conv.round()
    assert(
      'unchecked model: no binding is recorded and the context goes last',
      first.thinkingBinding === undefined &&
        String(api.bodies[0]!.messages.at(-1)!.content).startsWith('Per-run context'),
    )
  } finally {
    await api.stop()
  }
}

// ── Path B (think) end to end ───────────────────────────────────────────────

{
  const cwd = tmpDir('think')
  fs.writeFileSync(path.join(cwd, 'alpha.txt'), 'alpha\n')
  const originalCwd = process.cwd()
  let toolRound = 0
  const api = new FakeMessagesApi((body) => {
    const textOf = (m: ApiMessage): string => typeof m.content === 'string'
      ? m.content
      : m.content.map((b) => (b.type === 'text' ? String(b.text) : '')).join('')
    const asked = [...body.messages].reverse().map(textOf).find((t) => t && !t.includes('TURN_NOTE')) ?? ''
    const answered = body.messages.at(-1)?.role === 'user' && Array.isArray(body.messages.at(-1)!.content) &&
      (body.messages.at(-1)!.content as Block[]).some((b) => b.type === 'tool_result')
    if (!answered && /list/i.test(asked)) {
      toolRound += 1
      return { toolUse: { id: `toolu_ls_${toolRound}`, name: 'list_files', input: { path: '.' } } }
    }
    return { text: 'alpha.txt is here.' }
  })
  await api.start()
  try {
    fs.mkdirSync(path.join(cwd, '.artemis'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock',
      profiles: [{ id: 'mock', label: 'Mock', protocol: 'messages', apiKey: 'k', model: 'claude-opus-5-5', baseUrl: api.baseUrl, contextLength: 200_000 }],
    }))
    process.chdir(cwd)
    resetSession()
    applyProviderOverrides({})
    const options = { cwd, permissionMode: 'accept-all' as const, contextDir: path.join(cwd, 'ctx'), turnContext: 'TURN_NOTE: per-turn playbook' }
    await think('List the files here', () => {}, options)
    const loopBody = api.bodies.find((b) => b.messages.some((m) => m.role === 'assistant'))
    const stored = getMessages().filter((m) => m.role === 'assistant')
    assert(
      'path B: the tool loop replays the first round\'s thinking and stores each turn\'s binding',
      api.rejected === 0 && signaturesIn(loopBody).length === 1 && stored.length === 2 && stored.every((m) => typeof m.thinkingBinding === 'string'),
      `rejected=${api.rejected} sent=${signaturesIn(loopBody).length} stored=${stored.length}`,
    )
    const turnOneRequests = api.bodies.length
    await think('List them again', () => {}, options)
    const after = getMessages().filter((m) => m.role === 'assistant')
    const secondLoop = api.bodies.slice(turnOneRequests).find((b) => signaturesIn(b).length > 0)
    assert(
      'path B: the next user turn succeeds first time; the previous turn\'s thinking (sent before a context that is gone) is dropped and stays dropped',
      api.rejected === 0 && !signatureOf(after[0]) && !signatureOf(after[1]) && Boolean(after[0]?.toolCalls?.length),
      `rejected=${api.rejected} first=${signatureOf(after[0])}`,
    )
    assert(
      'path B: the new turn\'s tool loop replays its own thinking',
      signaturesIn(secondLoop).length === 1 && signaturesIn(secondLoop)[0] === signatureOf(after[2]),
      `sent=${signaturesIn(secondLoop)} expected=${signatureOf(after[2])}`,
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await api.stop()
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
