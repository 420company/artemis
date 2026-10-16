#!/usr/bin/env tsx
/**
 * thinkingReplaySmoke.ts — replaying signed thinking blocks on the Messages
 * API after the history changed (providers/thinkingReplay.ts).
 *
 * A local fake Messages endpoint stands in for the API and enforces the
 * preserved-thinking rules on every request, independently of the engine and
 * strictly: a thinking block is accepted only while the `system` prompt, the
 * `tools` (in order) and every message before it are what they were when the
 * block was produced (a string content is not the same as a text block; only
 * a block's own `cache_control` mark is ignored), and the thinking blocks
 * kept form an unbroken run of the original sequence (earlier blocks may be
 * removed from the front, a block left out must stay out). An assistant turn
 * with empty content is rejected too. Anything else gets the API's 400.
 *
 * Covers: a tool loop keeps every round's thinking when the per-run context
 * is kept in the history, and degrades without a 400 when it is re-sent
 * last; tier-1 and tier-2 compaction followed by requests (no stale thinking,
 * first-time success, thinking produced afterwards replayed again); the same
 * history gives the same bytes and each request extends the previous one;
 * the 400 retry (streaming and not), a dropped block staying dropped, and the
 * gate becoming sticky for an id it did not know; a thinking-only turn left
 * without its thinking; tool order; images on every round; the finalizer
 * with tool_choice none; interjections and self-check notes; path B
 * (think()) end to end over two user turns, the second extending the first's
 * request (prompt cache reuse) with the first turn's thinking kept.
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
  checksThinkingReplay,
  dropStoredThinking,
  EMPTY_TURN_TEXT,
  isThinkingReplayError,
  modelChecksThinkingPrefix,
  PrefixDigest,
} from '../src/providers/thinkingReplay.js'
import { RUNTIME_CONTEXT_MESSAGE_NAME } from '../src/providers/runtimeContext.js'
import type { ImageAttachment, ProviderNativeFunctionTool, ProviderRequestOptions, ProviderResponse } from '../src/providers/types.js'
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
type Body = { system?: Block[]; tools?: Json[]; messages: ApiMessage[]; stream?: boolean; tool_choice?: Json }
type Reply = { text?: string; toolUse?: { id: string; name: string; input: Json } }

const isThinking = (b: Block): boolean => b?.type === 'thinking' || b?.type === 'redacted_thinking'

/** A block without its own cache mark; nested keys (tool inputs, schemas) stay. */
function unmarked(block: Json): Json {
  const { cache_control: _mark, ...rest } = block
  return rest
}

/** What the check compares: system, tools in order, and the messages before the block without their thinking. */
function prefixOf(body: Body, uptoMessage: number): string {
  const messages = body.messages.slice(0, uptoMessage).map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.filter((b) => !isThinking(b)).map(unmarked),
  }))
  return JSON.stringify({ system: (body.system ?? []).map(unmarked), tools: (body.tools ?? []).map(unmarked), messages })
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
    for (let i = 0; i < body.messages.length; i += 1) {
      const m = body.messages[i]!
      const empty = typeof m.content === 'string'
        ? !m.content.trim()
        : m.content.length === 0 || m.content.some((b) => b.type === 'text' && !String(b.text ?? '').trim())
      if (m.role === 'assistant' && empty) return `messages.${i}: all messages must have non-empty content except for the optional final assistant message`
    }
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
    if (reply.toolUse && body.tool_choice?.type !== 'none') content.push({ type: 'tool_use', ...reply.toolUse })
    if (content.length === 1) content.push({ type: 'text', text: 'done' })
    const stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
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

/** Messages as compared for caching: each block without its own cache mark. */
function withoutCacheMarks(messages: ApiMessage[]): string {
  return JSON.stringify(messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(unmarked) })))
}

/** Whether `next` sends `previous` unchanged (cache marks aside) and then appends to it. */
function extendsRequest(next: Body | undefined, previous: Body | undefined): boolean {
  if (!next || !previous) return false
  return JSON.stringify((next.system ?? []).map(unmarked)) === JSON.stringify((previous.system ?? []).map(unmarked)) &&
    JSON.stringify((next.tools ?? []).map(unmarked)) === JSON.stringify((previous.tools ?? []).map(unmarked)) &&
    withoutCacheMarks(next.messages.slice(0, previous.messages.length)) === withoutCacheMarks(previous.messages)
}

// ── Driving the provider like path B does ───────────────────────────────────

const TOOLS: ProviderNativeFunctionTool[] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'list_files', description: 'List files', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]
const SYSTEM = msg('system', 'You are a careful engineer.')
const CONTEXT_TEXT = 'Per-run context: cwd=/repo; skills index: none.'
let contextSeq = 0
const contextMessage = (text = CONTEXT_TEXT): SessionMessage =>
  msg('user', text, { name: RUNTIME_CONTEXT_MESSAGE_NAME, id: `runtime-context-kept-${++contextSeq}` })

type ConversationOptions = {
  /** The per-run context: kept in the history like path B does on checked models, or re-sent last each request. */
  context?: 'kept' | 'trailing' | 'none'
  tools?: ProviderNativeFunctionTool[]
}

class Conversation {
  history: SessionMessage[] = []
  retries: string[] = []
  tools: ProviderNativeFunctionTool[]
  private readonly context: 'kept' | 'trailing' | 'none'

  constructor(private readonly provider: MessagesCompatibleProvider, options: ConversationOptions = {}) {
    this.context = options.context ?? 'kept'
    this.tools = options.tools ?? TOOLS
  }

  /** A user request; with a kept context, the context follows it once. */
  ask(text: string): SessionMessage {
    const user = msg('user', text)
    this.history.push(user)
    if (this.context === 'kept') this.history.push(contextMessage())
    return user
  }

  /** One request; the reply is stored like brain.ts stores it, dropped thinking is removed from the history. */
  async round(stream = false, extra: Partial<ProviderRequestOptions> = {}): Promise<ProviderResponse> {
    const trailing = this.context === 'trailing' ? [msg('user', CONTEXT_TEXT, { name: RUNTIME_CONTEXT_MESSAGE_NAME })] : []
    const messages = [SYSTEM, ...this.history, ...trailing]
    const options: ProviderRequestOptions = {
      nativeFunctionTools: this.tools,
      onRetry: (_a: number, _d: number, reason: string) => { this.retries.push(reason) },
      ...extra,
    }
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

  assistants(): SessionMessage[] {
    return this.history.filter((m) => m.role === 'assistant')
  }
}

function provider(api: FakeMessagesApi, model: string): MessagesCompatibleProvider {
  return new MessagesCompatibleProvider({ protocol: 'messages', baseUrl: api.baseUrl, apiKey: 'k', model })
}

/** Replies with a read_file call. */
const readFiles = (_body: Body, index: number): Reply => ({
  toolUse: { id: `toolu_${index}`, name: 'read_file', input: { path: `/repo/src/f${index}.ts` } },
})

async function withApi(reply: (body: Body, index: number) => Reply, run: (api: FakeMessagesApi) => Promise<void>): Promise<void> {
  const api = new FakeMessagesApi(reply)
  await api.start()
  try {
    await run(api)
  } finally {
    await api.stop()
  }
}

// ── Gating and the digest ───────────────────────────────────────────────────

{
  const checked = [
    'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-6',
    'anthropic.claude-opus-5-5', 'us.anthropic.claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'vertex_ai/claude-opus-5-5@default',
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5-v1:0',
  ]
  const unchecked = ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5-1', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-opus-5-20260101', 'gpt-5', 'claude-test', 'my-claude-opus-5-5']
  assert(
    'gating: checking model ids are recognized wherever they sit in a longer name; older ones and others are not',
    checked.every(modelChecksThinkingPrefix) && !unchecked.some(modelChecksThinkingPrefix),
    JSON.stringify({ checked: checked.filter((m) => !modelChecksThinkingPrefix(m)), unchecked: unchecked.filter(modelChecksThinkingPrefix) }),
  )
  assert(
    'gating: only the Messages protocol is gated',
    checksThinkingReplay({ protocol: 'messages', model: 'claude-opus-5-5' }) && !checksThinkingReplay({ protocol: 'openai', model: 'claude-opus-5-5' }),
  )
  assert(
    'gating: the API\'s replay 400 is recognized; other 400s are not',
    isThinkingReplayError(400, '{"error":{"message":"messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."}}') &&
      !isThinkingReplayError(400, '{"error":{"message":"prompt is too long"}}') &&
      !isThinkingReplayError(500, 'Invalid `signature` in `thinking` block'),
  )
  const digestOf = (tools: Json[], content: unknown): string => {
    const d = new PrefixDigest([{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], tools)
    d.push({ role: 'assistant', content })
    return d.digest()
  }
  const a = { name: 'a', input_schema: { type: 'object' } }
  const b = { name: 'b', input_schema: { type: 'object' } }
  const use = (input: Json, mark?: Json): Block[] => [{ type: 'tool_use', id: 't', name: 'a', input, ...(mark ? { cache_control: mark } : {}) }]
  assert(
    'digest: a block\'s own cache mark is ignored, a nested "cache_control" key (tool input) is not',
    digestOf([a], use({ x: 1 })) === digestOf([{ ...a, cache_control: { type: 'ephemeral' } }], use({ x: 1 }, { type: 'ephemeral' })) &&
      digestOf([a], use({ x: 1 })) !== digestOf([a], use({ x: 1, cache_control: { type: 'ephemeral' } })),
  )
  assert(
    'digest: tool order counts, and a string content differs from a text block',
    digestOf([a, b], 'x') !== digestOf([b, a], 'x') && digestOf([a], 'x') !== digestOf([a], [{ type: 'text', text: 'x' }]),
  )
}

// ── Tool loop ───────────────────────────────────────────────────────────────

await withApi((body, index) => index < 4 ? readFiles(body, index) : { text: 'done' }, async (api) => {
  const conv = new Conversation(provider(api, 'claude-opus-5-5'))
  conv.ask('Fix the build.')
  for (let round = 1; round <= 4; round += 1) {
    const response = await conv.round(round % 2 === 0)
    if (response.nativeToolCalls?.length) conv.toolResult(`contents of file ${round}`)
  }
  const last = api.bodies.at(-1)
  const sigs = conv.assistants().slice(0, 3).map(signatureOf)
  assert(
    'tool loop: with the per-run context kept in the history, every round\'s thinking is replayed unchanged and accepted',
    api.rejected === 0 && conv.retries.length === 0 && JSON.stringify(signaturesIn(last)) === JSON.stringify(sigs),
    `rejected=${api.rejected} sent=${signaturesIn(last)} stored=${sigs}`,
  )
  assert(
    'tool loop: each request repeats the previous one and appends to it (cache marks aside)',
    api.bodies.slice(1).every((body, i) => extendsRequest(body, api.bodies[i])),
  )
  assert(
    'tool loop: on a checked model every message content goes as blocks, never as a string',
    api.bodies.every((body) => body.messages.every((m) => Array.isArray(m.content))),
  )
})

await withApi((body, index) => index < 3 ? readFiles(body, index) : { text: 'done' }, async (api) => {
  // A caller that re-sends the context last each round: no 400, the previous round's thinking goes.
  const conv = new Conversation(provider(api, 'claude-opus-5-5'), { context: 'trailing' })
  conv.ask('Fix the build.')
  await conv.round()
  conv.toolResult('one')
  const second = await conv.round()
  assert(
    'tool loop: a context re-sent last (moving each round) costs the earlier thinking, never a 400',
    api.rejected === 0 && signaturesIn(api.bodies.at(-1)).length === 0 && second.droppedThinkingMessageIds?.length === 1,
    `rejected=${api.rejected}`,
  )
})

// ── The 400 retry and the sticky gate ───────────────────────────────────────

await withApi((body, index) => index < 3 ? readFiles(body, index) : { text: 'done' }, async (api) => {
  // The bug's request shape on a model the gate does not know: rejected once,
  // retried without thinking; the gate then holds for that id.
  const conv = new Conversation(provider(api, 'house-alias-for-opus'), { context: 'trailing' })
  conv.ask('Fix the build.')
  const first = await conv.round()
  conv.toolResult('one')
  const second = await conv.round()
  const firstTry = api.bodies.at(-2)
  const retry = api.bodies.at(-1)
  assert(
    'retry: the old request shape (context last, all thinking replayed) is rejected by the check',
    api.rejected === 1 && first.thinkingBinding === undefined && signaturesIn(firstTry).length === 1,
    `rejected=${api.rejected}`,
  )
  assert(
    'retry: the rejected request is sent once more without any thinking, succeeds, and is reported',
    signaturesIn(retry).length === 0 && conv.retries.length === 1 &&
      second.droppedThinkingMessageIds?.length === 1 && !signatureOf(conv.history[1]) && Boolean(conv.history[1]!.toolCalls?.length),
    `retries=${conv.retries.length} dropped=${second.droppedThinkingMessageIds}`,
  )
  conv.toolResult('two')
  const third = await conv.round()
  conv.toolResult('three')
  await conv.round()
  assert(
    'sticky gate: after one replay 400 the id is checked: bindings are recorded and no round is rejected again',
    checksThinkingReplay({ protocol: 'messages', baseUrl: api.baseUrl, model: 'house-alias-for-opus' }) &&
      typeof third.thinkingBinding === 'string' && api.rejected === 1,
    `rejected=${api.rejected} binding=${typeof third.thinkingBinding}`,
  )
})

await withApi((body, index) => index < 4 ? readFiles(body, index) : { text: 'done' }, async (api) => {
  // An unknown rejection on a checking model: one retry without thinking, and
  // the turns stay without it afterwards (no reinstated block, no repeated 400).
  const conv = new Conversation(provider(api, 'claude-sonnet-5-5'))
  conv.ask('Fix the build.')
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
      JSON.stringify(signaturesIn(api.bodies.at(-1))) === JSON.stringify([signatureOf(conv.assistants()[1])]),
    `sent=${signaturesIn(api.bodies.at(-1))}`,
  )
})

// ── A turn that held nothing but thinking ───────────────────────────────────

await withApi(() => ({ text: 'done' }), async (api) => {
  const thinkingOnly = (sig: string): SessionMessage => msg('assistant', '', {
    rawContentBlocks: [{ type: 'thinking', thinking: '', signature: sig }],
    thinkingBinding: 'stale',
  })
  const conv = new Conversation(provider(api, 'claude-opus-5-5'))
  conv.ask('Start.')
  conv.history.push(thinkingOnly('sig-unknown-1'))
  conv.history.push(msg('user', 'Go on.'))
  const response = await conv.round()
  const sentTurn = api.bodies.at(-1)!.messages.find((m) => m.role === 'assistant')
  assert(
    'empty turn: a stale thinking-only turn goes with a placeholder text, not an empty content (no 400)',
    api.rejected === 0 && JSON.stringify(sentTurn?.content) === JSON.stringify([{ type: 'text', text: EMPTY_TURN_TEXT }]) &&
      response.droppedThinkingMessageIds?.length === 1,
    JSON.stringify(sentTurn),
  )
  await conv.round()
  assert(
    'empty turn: once dropped from the history it maps to the same bytes (no 400, nothing bricked)',
    api.rejected === 0 && extendsRequest(api.bodies.at(-1), api.bodies.at(-2)),
  )

  // Unchecked model: the API rejects the unknown block; the retry uses the same placeholder.
  const legacy = new Conversation(provider(api, 'claude-opus-4-8'), { context: 'none' })
  legacy.ask('Start.')
  legacy.history.push(thinkingOnly('sig-unknown-2'))
  legacy.history.push(msg('user', 'Go on.'))
  const before = api.rejected
  await legacy.round()
  await legacy.round()
  assert(
    'empty turn: on an unchecked model the retry without thinking keeps the turn as a placeholder, and the next request succeeds first time',
    api.rejected === before + 1 && legacy.retries.length === 1 &&
      JSON.stringify(api.bodies.at(-1)!.messages[1]!.content) === JSON.stringify([{ type: 'text', text: EMPTY_TURN_TEXT }]),
    `rejected=${api.rejected - before}`,
  )
})

// ── In-run cases that keep thinking ─────────────────────────────────────────

await withApi((body, index) => index < 4 ? readFiles(body, index) : { text: 'done' }, async (api) => {
  const conv = new Conversation(provider(api, 'claude-opus-5-5'))
  const user = conv.ask('What is in this picture? Then read the files.')
  const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' } as ImageAttachment
  const images = { imageAttachments: [image], imageMessageId: user.id }
  await conv.round(false, images)
  conv.toolResult('one')
  // An interjection lands after the tool results.
  conv.history.push(msg('user', '[Interjection] also check beta.txt', { name: 'interjection' }))
  await conv.round(false, images)
  conv.toolResult('two')
  // The forced finalizer: tools stay declared, tool_choice none.
  conv.history.push(msg('user', 'Stop calling tools and answer now.'))
  await conv.round(false, { ...images, toolChoice: 'none' })
  // A self-check note kept after the final reply.
  conv.history.push(contextMessage('[Self-check before done] re-run the tests and report.'))
  await conv.round(false, images)
  const bodies = api.bodies.slice(-4)
  const imageOn = (body: Body): boolean => {
    const target = body.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'text' && String(b.text).startsWith('What is in this picture')))
    return Array.isArray(target?.content) && target!.content[0]?.type === 'image'
  }
  assert(
    'in-run: images stay on the request\'s own message on every round (ahead of its text)',
    bodies.every(imageOn),
  )
  assert(
    'in-run: an interjection, the forced finalizer (tool_choice none, tools kept) and a self-check note keep every earlier round\'s thinking',
    api.rejected === 0 && JSON.stringify(signaturesIn(bodies[3])) === JSON.stringify(conv.assistants().slice(0, 3).map(signatureOf)) &&
      bodies[2]!.tool_choice?.type === 'none' && (bodies[2]!.tools?.length ?? 0) === TOOLS.length &&
      bodies.slice(1).every((body, i) => extendsRequest(body, bodies[i])),
    `rejected=${api.rejected} sent=${signaturesIn(bodies[3])}`,
  )
})

await withApi((body, index) => index < 4 ? readFiles(body, index) : { text: 'done' }, async (api) => {
  const conv = new Conversation(provider(api, 'claude-opus-5-5'))
  conv.ask('Fix the build.')
  await conv.round()
  conv.toolResult('one')
  conv.tools = [...TOOLS].reverse()
  const response = await conv.round()
  assert(
    'tools: a reordered tool list counts as changed: the earlier thinking goes, no 400',
    api.rejected === 0 && signaturesIn(api.bodies.at(-1)).length === 0 && response.droppedThinkingMessageIds?.length === 1,
  )
})

// ── Compaction followed by a request ────────────────────────────────────────

async function longToolLoop(api: FakeMessagesApi, model: string, rounds: number): Promise<Conversation> {
  const conv = new Conversation(provider(api, model))
  conv.ask('GOAL_FIX_BUILD: make the build pass')
  for (let i = 0; i < rounds; i += 1) {
    await conv.round()
    conv.toolResult(`export const v${i} = 1\n`.repeat(400))
  }
  return conv
}

await withApi(readFiles, async (api) => {
  // Tier 1: old tool results become placeholders.
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
    conv.toolResult('after compaction')
    await conv.round()
    const next = api.bodies.at(-1)!
    const newest = signatureOf(conv.assistants().at(-2))
    assert(
      'tier 1: thinking produced after the compaction is replayed in the tool loop and accepted',
      api.rejected === rejectedBefore && Boolean(newest) && signaturesIn(next).at(-1) === newest && extendsRequest(next, sent),
      `newest=${newest} sent=${signaturesIn(next).slice(-2)}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await withApi(readFiles, async (api) => {
  // Tier 2: everything before a verbatim tail becomes one summary message.
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
    const tail = conv.assistants()
    assert(
      'tier 2: the compaction left a summary boundary and a verbatim tail with signed thinking (setup)',
      (managed.action === 'summary' || managed.action === 'fallback') && conv.history[0]?.compaction?.kind === 'boundary' &&
        tail.length > 0 && tail.every((m) => signatureOf(m)),
      `${managed.action} tail=${tail.length}`,
    )
    // Without the fix, the kept turns' thinking goes out as stored: the check rejects it.
    const asBlocks = (text: string): Block[] => [{ type: 'text', text }]
    const stale = api.violation({
      system: [{ type: 'text', text: SYSTEM.content }],
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages: conv.history.map((m) => m.role === 'assistant'
        ? { role: 'assistant', content: m.rawContentBlocks as Block[] }
        : m.role === 'tool' ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolUseId, content: m.content }] } : { role: 'user', content: asBlocks(m.content) }),
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
    // Same history, same bytes (whether or not the drops are stored yet).
    const again = provider(api, 'claude-opus-5-5')
    const replayHistory = conv.history.slice(0, -1)
    await again.complete([SYSTEM, ...replayHistory], { nativeFunctionTools: TOOLS })
    await again.complete([SYSTEM, ...replayHistory], { nativeFunctionTools: TOOLS })
    const raws = api.rawBodies.slice(-3)
    assert('determinism: the same history gives byte-identical requests (stored drops or not)', raws[0] === raws[1] && raws[1] === raws[2])
    conv.toolResult('after compaction')
    await conv.round()
    conv.toolResult('and again')
    await conv.round()
    const last = api.bodies.at(-1)!
    const fresh = conv.assistants().slice(-3, -1).map(signatureOf)
    assert(
      'tier 2: thinking produced after the summary is replayed in the following rounds and accepted',
      api.rejected === rejectedBefore && JSON.stringify(signaturesIn(last)) === JSON.stringify(fresh),
      `sent=${signaturesIn(last)} fresh=${fresh}`,
    )
    assert('determinism: each request after the compaction repeats the previous one and appends to it', extendsRequest(last, api.bodies.at(-2)))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await withApi((body, index) => index < 2 ? readFiles(body, index) : { text: 'done' }, async (api) => {
  // A model that does not check: request shape unchanged (context last, strings, thinking as stored, no binding).
  const conv = new Conversation(provider(api, 'claude-opus-4-8'), { context: 'trailing' })
  conv.ask('hello')
  const first = await conv.round()
  assert(
    'unchecked model: no binding is recorded, the context goes last, text goes as a string',
    first.thinkingBinding === undefined && api.bodies[0]!.messages.at(-1)!.content === CONTEXT_TEXT,
  )
})

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
    const turnOne = api.bodies.length
    const loopBody = api.bodies.find((b) => b.messages.some((m) => m.role === 'assistant'))
    const stored = getMessages().filter((m) => m.role === 'assistant')
    const keptContext = getMessages().filter((m) => m.name === RUNTIME_CONTEXT_MESSAGE_NAME)
    assert(
      'path B: the tool loop replays the first round\'s thinking and stores each turn\'s binding',
      api.rejected === 0 && signaturesIn(loopBody).length === 1 && stored.length === 2 && stored.every((m) => typeof m.thinkingBinding === 'string'),
      `rejected=${api.rejected} sent=${signaturesIn(loopBody).length} stored=${stored.length}`,
    )
    assert(
      'path B: the per-turn context is kept once in the history, right after the request',
      keptContext.length === 1 && getMessages().indexOf(keptContext[0]!) === 1 && keptContext[0]!.content.includes('TURN_NOTE'),
      `kept=${keptContext.length}`,
    )
    // The same request again: path B projects the same tools (a different
    // projection changes `tools`, which resets thinking and the cache).
    await think('List the files here', () => {}, options)
    const after = getMessages().filter((m) => m.role === 'assistant')
    const secondTurn = api.bodies.slice(turnOne)
    assert(
      'path B: the next user turn sends the previous turn\'s last request unchanged and appends to it (its cached prefix is reused)',
      api.rejected === 0 && extendsRequest(secondTurn[0], api.bodies[turnOne - 1]),
      `rejected=${api.rejected}`,
    )
    assert(
      'path B: the previous turn\'s thinking stays valid and is replayed in the next turn, with the new turn\'s own',
      JSON.stringify(signaturesIn(secondTurn.at(-1))) === JSON.stringify(after.slice(0, 3).map(signatureOf)) &&
        getMessages().filter((m) => m.name === RUNTIME_CONTEXT_MESSAGE_NAME).length === 1,
      `sent=${signaturesIn(secondTurn.at(-1))} stored=${after.map(signatureOf)}`,
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
