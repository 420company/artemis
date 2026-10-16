#!/usr/bin/env tsx
/**
 * scripts/sessionEditSmoke.ts — retry, edit-and-resend, undo and
 * conversation search (storage/sessionTurns.ts, storage/conversationSearch.ts,
 * `artemis execute --retry`, `artemis session last-turn|undo|search`).
 *
 * Covers: finding the last exchange (with and without the turn record, after
 * compaction), which tools count as side effects, taking the exchange out
 * (turn record and usage anchor dropped), a real headless retry and edit
 * against a mock model (the same message runs once more, never twice in
 * the history; intent and images come back from the record), the CLI
 * commands' JSON, and message-level search across conversations (CJK
 * substrings, archived pages, highlights, newer-message counts, helper
 * sessions left out).
 *
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/sessionEditSmoke.ts
 */

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { settleMemoryCuration } from '../src/core/memory.js'
import type { SessionMessage, SessionRecord } from '../src/core/types.js'
import { runHeadlessAgent } from '../src/services/headlessAgent.js'
import { createSideEffectClassifier, toolHasSideEffects } from '../src/services/toolSideEffects.js'
import { buildSnippet, matchText, searchConversations } from '../src/storage/conversationSearch.js'
import { SessionStore } from '../src/storage/sessions.js'
import {
  dropMissingAttachments,
  findLastExchange,
  lastExchangeFor,
  TURN_CHANGED_EXIT_CODE,
  LAST_TURN_METADATA_KEY,
  NOTHING_TO_REWIND_EXIT_CODE,
  recordLastTurn,
  removeExchange,
  SessionRewindError,
} from '../src/storage/sessionTurns.js'
import { parseArgs } from '../src/cli/parseArgs.js'
import { runSessionCommand } from '../src/cli/runCli.js'
import { runRetryCommand } from '../src/cli/retryCommand.js'

class ExitSignal extends Error {}

/** `artemis session <args>` in this process (a CLI start-up per command is slow): exit code, stdout, stderr. */
async function sessionCli(cwd: string, ...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  // The same argv handling as the real command line.
  const parsed = parseArgs(['session', ...args])
  const out: string[] = []
  const err: string[] = []
  const saved = { log: console.log, error: console.error, exit: process.exit }
  let status = 0
  console.log = (...parts: unknown[]) => { out.push(parts.map(String).join(' ')) }
  console.error = (...parts: unknown[]) => { err.push(parts.map(String).join(' ')) }
  process.exit = ((code?: number) => {
    status = code ?? 0
    throw new ExitSignal()
  }) as typeof process.exit
  try {
    await runSessionCommand({ cwd, locale: 'en', args: parsed.promptArgs ?? [] })
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      status = 1
      err.push(String(error))
    }
  } finally {
    console.log = saved.log
    console.error = saved.error
    process.exit = saved.exit
  }
  return { status, stdout: out.join('\n'), stderr: err.join('\n') }
}

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
let seq = 0
function msg(role: SessionMessage['role'], content: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  clock += 1_000
  seq += 1
  return { id: `m${seq}`, role, content, createdAt: new Date(clock).toISOString(), ...extra }
}

function toolResult(action: Record<string, unknown>, output = 'ok'): SessionMessage {
  return msg('tool', JSON.stringify({ ok: true, action, output }, null, 2), { name: String(action.type) })
}

function session(messages: SessionMessage[], metadata?: Record<string, unknown>): SessionRecord {
  return { id: 's', cwd: '/tmp', title: 't', createdAt: '', updatedAt: '', messages, ...(metadata ? { metadata } : {}) }
}

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `artemis-edit-${label}-`))
}

console.log('\nsession turns')
{
  const messages = [
    msg('user', 'first question'),
    msg('assistant', 'first answer'),
    msg('user', 'make me a poster'),
    msg('assistant', '', { toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{"path":"a.txt","content":"x"}' }] }),
    toolResult({ type: 'write_file', path: 'a.txt' }),
    toolResult({ type: 'run_command', command: 'ls -la' }),
    msg('user', 'Run the check again before you finish.'),
    msg('assistant', 'poster done'),
  ]
  const lookup = findLastExchange(session(messages), toolHasSideEffects)
  assert('without a turn record, the last owner message starts the exchange', lookup.ok && lookup.exchange.userMessage.content === 'Run the check again before you finish.', JSON.stringify(lookup))

  const recorded = session(messages, {
    [LAST_TURN_METADATA_KEY]: { userMessageId: messages[2]!.id, lastMessageId: messages.at(-1)!.id, prompt: 'make me a poster', intent: 'image', imagePaths: ['/x.png'], at: '' },
  })
  const byRecord = findLastExchange(recorded, toolHasSideEffects)
  assert('with a turn record, a reminder inside the turn does not split it', byRecord.ok && byRecord.exchange.startIndex === 2 && byRecord.exchange.messageCount === 6, JSON.stringify(byRecord))
  assert('the exchange reports its reply and its recorded intent', byRecord.ok && byRecord.exchange.reply?.content === 'poster done' && byRecord.exchange.recorded?.intent === 'image')
  const tools = byRecord.ok ? byRecord.exchange.tools : []
  assert('tools: a file write is a side effect, a read-only command is not; each tool listed once',
    tools.length === 2 && tools.find((t) => t.name === 'write_file')?.sideEffect === true && tools.find((t) => t.name === 'run_command')?.sideEffect === false,
    JSON.stringify(tools))
  assert('the exchange as a whole has side effects', byRecord.ok && byRecord.exchange.sideEffects)

  const stale = session([...messages, msg('user', 'a later turn from elsewhere'), msg('assistant', 'ok')], recorded.metadata)
  const later = findLastExchange(stale, toolHasSideEffects)
  assert('a record that no longer ends the history is ignored', later.ok && later.exchange.userMessage.content === 'a later turn from elsewhere')

  const compacted = session([
    msg('user', 'summary of earlier conversation', { compaction: { kind: 'boundary', index: 1, summary: 's', mode: 'summary', language: 'en' } as SessionMessage['compaction'] }),
    toolResult({ type: 'read_file', path: 'a' }),
    msg('assistant', 'answer'),
  ])
  const gone = findLastExchange(compacted, toolHasSideEffects)
  assert('a turn whose message went to the archive is reported as compacted', !gone.ok && gone.reason === 'compacted', JSON.stringify(gone))
  const empty = findLastExchange(session([]), toolHasSideEffects)
  assert('an empty conversation has nothing to take back', !empty.ok && empty.reason === 'empty')

  const target = session([...messages], { ...recorded.metadata, context: { version: 1, compactions: 0, summaryFailures: 0, anchor: { promptTokens: 9, messageCount: 8, fixedTokens: 1, recordedAt: '' } } })
  const found = findLastExchange(target, toolHasSideEffects)
  if (found.ok) removeExchange(target, found.exchange)
  assert('removing the exchange leaves the earlier history, drops the turn record and the usage anchor',
    target.messages.length === 2 && target.messages[1]!.content === 'first answer' &&
      target.metadata?.[LAST_TURN_METADATA_KEY] === undefined && target.metadata?.context?.anchor === undefined,
    JSON.stringify(target.metadata))

  const recordTarget = session([msg('user', 'q'), msg('assistant', 'a')])
  recordLastTurn(recordTarget, { userMessageId: recordTarget.messages[0]!.id, prompt: 'q' })
  assert('recording a turn keeps where it ends', recordTarget.metadata?.[LAST_TURN_METADATA_KEY]?.lastMessageId === recordTarget.messages[1]!.id)

  assert('side effects: unknown tools count; read tools and confirmations do not; research does',
    toolHasSideEffects('some_new_tool', undefined) && !toolHasSideEffects('search_web', undefined) &&
      !toolHasSideEffects('request_user_confirmation', undefined) && toolHasSideEffects('generate_image', undefined) &&
      toolHasSideEffects('run_command', { command: 'rm -rf build' }) && toolHasSideEffects('deep_research', { query: 'q' }))
  assert('side effects: a model saying readOnly is not believed; the MCP server\'s descriptor is',
    toolHasSideEffects('mcp_call_tool', { serverId: 'artemis_online', toolName: 'publish_request', readOnly: true }) &&
      !toolHasSideEffects('mcp_call_tool', { serverId: 'artemis_online', toolName: 'trigger_list', readOnly: false }, new Set(['mcp__artemis_online__trigger_list'])) &&
      toolHasSideEffects('mcp__artemis_online__trigger_create', undefined, new Set(['mcp__artemis_online__trigger_list'])) &&
      !toolHasSideEffects('mcp__artemis_online__trigger_list', undefined, new Set(['mcp__artemis_online__trigger_list'])))
  {
    const mcpTurn = session([
      msg('user', 'publish it'),
      msg('assistant', '', { toolCalls: [{ id: 'c1', name: 'mcp__artemis_online__publish_request', arguments: '{}' }] }),
      toolResult({ type: 'mcp_call_tool', serverId: 'artemis_online', toolName: 'trigger_create', readOnly: true }),
      msg('assistant', 'done'),
    ])
    const found = findLastExchange(mcpTurn, toolHasSideEffects)
    assert('MCP tools are named mcp__<server>__<tool> and count as side effects (publish, triggers)',
      found.ok && JSON.stringify(found.exchange.tools) === JSON.stringify([
        { name: 'mcp__artemis_online__publish_request', sideEffect: true },
        { name: 'mcp__artemis_online__trigger_create', sideEffect: true },
      ]), JSON.stringify(found))
    let changed: unknown
    try {
      lastExchangeFor(mcpTurn, toolHasSideEffects, 'some-older-message')
    } catch (error) {
      changed = error
    }
    assert('a turn id that is not the last exchange is refused (exit 66)', changed instanceof SessionRewindError && changed.reason === 'changed' && changed.exitCode === TURN_CHANGED_EXIT_CODE)
    assert('the confirmed turn id passes', lastExchangeFor(mcpTurn, toolHasSideEffects, mcpTurn.messages[0]!.id).startIndex === 0)
    const open = session([...mcpTurn.messages, msg('user', 'Run the check again.'), msg('assistant', 'ok')], {
      [LAST_TURN_METADATA_KEY]: { userMessageId: mcpTurn.messages[0]!.id, lastMessageId: mcpTurn.messages[0]!.id, prompt: 'publish it', intent: 'research', at: '', open: true },
    })
    const fromOpen = findLastExchange(open, toolHasSideEffects)
    assert('a run that never finished (open record) still marks where its turn starts, with its intent',
      fromOpen.ok && fromOpen.exchange.startIndex === 0 && fromOpen.exchange.recorded?.intent === 'research', JSON.stringify(fromOpen))
  }
  {
    const resent = dropMissingAttachments('看看这张图\n\nAttached file: uploads/a.png\nAttached file: uploads/gone.png', (file) => file.endsWith('a.png'))
    assert('a resent prompt leaves deleted attachments out and says so in its language',
      JSON.stringify(resent.missing) === '["uploads/gone.png"]' && resent.prompt.includes('Attached file: uploads/a.png') &&
        !resent.prompt.includes('Attached file: uploads/gone.png') && resent.prompt.includes('gone.png') && resent.prompt.includes('已经被删除'),
      resent.prompt)
    const same = dropMissingAttachments('hello', () => false)
    assert('a prompt without missing files is resent as is', same.prompt === 'hello' && same.missing.length === 0)
  }
  assert('`execute --retry` parses; other commands ignore it as a flag',
    parseArgs(['execute', '--session', '0f4c2b1e-5d6a-4e7f-8a9b-0c1d2e3f4a5b', '--retry']).retry === true &&
      parseArgs(['execute', '--session', '0f4c2b1e-5d6a-4e7f-8a9b-0c1d2e3f4a5b', '--retry']).prompt === undefined &&
      parseArgs(['execute', 'hi']).retry === undefined)
}

// ── headless retry against a mock model ────────────────────────────────────────

type ChatBody = { messages: Array<{ role: string; content: unknown }> }

/** The mock model; a handler answering null fails the request (HTTP 400). */
async function withMockChatServer(handler: (body: ChatBody) => string | null, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as ChatBody
      const content = handler(body)
      if (content === null) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid request', code: 'invalid_request' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'mock-chat-model', choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function writeProviderProfile(cwd: string, baseUrl: string): void {
  fs.mkdirSync(path.join(cwd, '.artemis'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.artemis', 'providers.json'), JSON.stringify({
    defaultMainProfileId: 'mock',
    profiles: [{ id: 'mock', label: 'Mock', protocol: 'openai', apiKey: 'k', model: 'mock-chat-model', baseUrl, contextLength: 128_000 }],
  }))
}

const lastUserText = (body: ChatBody) => {
  const users = body.messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && !/^\[(?:Run context|Runtime context)/.test(m.content as string))
  return String(users.at(-1)?.content ?? '')
}

console.log('\nheadless retry')
{
  const cwd = tmpDir('retry')
  const savedHome = process.env.ARTEMIS_HOME
  delete process.env.ARTEMIS_HOME
  const asked: string[] = []
  try {
    let failNext = false
    await withMockChatServer((body) => {
      const text = lastUserText(body)
      if (failNext && /QUESTION_FAIL/.test(text)) {
        failNext = false
        return null
      }
      if (/QUESTION/.test(text)) asked.push(text.match(/QUESTION_[A-Z_]+/)?.[0] ?? text)
      return JSON.stringify({ reply: `answer to ${text.match(/QUESTION_[A-Z_]+/)?.[0] ?? 'that'}`, done: true })
    }, async (baseUrl) => {
      writeProviderProfile(cwd, baseUrl)
      const run = async (prompt: string, opts: Parameters<typeof runHeadlessAgent>[2]) => {
        try {
          return await runHeadlessAgent(cwd, prompt, { maxTurns: 2, selfCheck: false, autoRoute: false, ...opts })
        } finally {
          await settleMemoryCuration()
        }
      }
      const first = await run('QUESTION_ONE', {})
      const sessionId = first.sessionId
      await run('QUESTION_TWO', { sessionId, intent: 'research' })
      const store = new SessionStore(cwd)
      const before = await store.load(sessionId, { fresh: true })
      const record = before.metadata?.[LAST_TURN_METADATA_KEY]
      assert('a headless turn records its message, prompt and intent', record?.prompt === 'QUESTION_TWO' && record?.intent === 'research', JSON.stringify(record))

      asked.length = 0
      const retried = await run('', { sessionId, retry: true })
      const afterRetry = await new SessionStore(cwd).load(sessionId, { fresh: true })
      const users = afterRetry.messages.filter((m) => m.role === 'user' && /QUESTION/.test(m.content)).map((m) => m.content)
      assert('retry runs the same message again', asked.includes('QUESTION_TWO') && /QUESTION_TWO/.test(retried.reply), `${JSON.stringify(asked)} ${retried.reply}`)
      assert('retry leaves the message once in the history, not twice', JSON.stringify(users) === JSON.stringify(['QUESTION_ONE', 'QUESTION_TWO']), JSON.stringify(users))
      assert('retry keeps the intent of the turn it replaces', afterRetry.metadata?.[LAST_TURN_METADATA_KEY]?.intent === 'research')

      asked.length = 0
      await run('QUESTION_EDITED', { sessionId, retry: true })
      const afterEdit = await new SessionStore(cwd).load(sessionId, { fresh: true })
      const edited = afterEdit.messages.filter((m) => m.role === 'user' && /QUESTION/.test(m.content)).map((m) => m.content)
      assert('edit and resend replaces the last message', JSON.stringify(edited) === JSON.stringify(['QUESTION_ONE', 'QUESTION_EDITED']) && asked.includes('QUESTION_EDITED'), JSON.stringify(edited))

      // A runtime note kept after the request (path B, models that check
      // replayed thinking) is not the message a retry reports or re-runs.
      {
        const withNote = await new SessionStore(cwd).load(sessionId, { fresh: true })
        const requestAt = withNote.messages.map((m) => m.content).lastIndexOf('QUESTION_EDITED')
        withNote.messages.splice(requestAt + 1, 0, {
          id: 'runtime-context-kept-test', role: 'user', name: 'runtime_context',
          content: 'RUNTIME_NOTE_NOT_THE_USER', createdAt: new Date().toISOString(),
        })
        await new SessionStore(cwd).save(withNote)
        asked.length = 0
        const retriedWithNote = await runRetryCommand({ cwd, sessionId })
        assert('retry with a kept runtime note after the request reports and re-runs the request, not the note',
          retriedWithNote.retriedPrompt === 'QUESTION_EDITED' && asked.includes('QUESTION_EDITED'),
          `${retriedWithNote.retriedPrompt} ${JSON.stringify(asked)}`)
      }
      const visible = afterEdit.messages.filter((m) => m.role === 'assistant' && m.content.trim())
      assert('the replaced reply is gone', !visible.some((m) => /QUESTION_TWO/.test(m.content)), JSON.stringify(visible.map((m) => m.content)))

      // A run that fails: its turn is still recorded (with its intent), so a retry asks the same.
      const other = (await run('QUESTION_THREE', {})).sessionId
      failNext = true
      try {
        await run('QUESTION_FAIL', { sessionId: other, intent: 'image' })
      } catch {
        // The model refused the request: the run failed.
      }
      const failed = await new SessionStore(cwd).load(other, { fresh: true })
      const failedRecord = failed.metadata?.[LAST_TURN_METADATA_KEY]
      assert('a failed run leaves its turn recorded with its intent, closed', failedRecord?.prompt === 'QUESTION_FAIL' && failedRecord?.intent === 'image' && failedRecord?.open === undefined, JSON.stringify(failedRecord))
      asked.length = 0
      await run('', { sessionId: other, retry: true, retryOf: failedRecord?.userMessageId })
      const afterFail = await new SessionStore(cwd).load(other, { fresh: true })
      assert('retrying the failed run asks the same once more, with the same intent',
        asked.includes('QUESTION_FAIL') && afterFail.metadata?.[LAST_TURN_METADATA_KEY]?.intent === 'image' &&
          afterFail.messages.filter((m) => m.role === 'user' && m.content === 'QUESTION_FAIL').length === 1,
        JSON.stringify(afterFail.messages.map((m) => [m.role, m.content.slice(0, 30)])))
      let stale: unknown
      try {
        await run('', { sessionId: other, retry: true, retryOf: failedRecord?.userMessageId })
      } catch (error) {
        stale = error
      }
      assert('a retry naming a turn that was already replaced is refused (exit 66)', stale instanceof SessionRewindError && stale.exitCode === TURN_CHANGED_EXIT_CODE)

      let refused: unknown
      const emptySession = new SessionStore(cwd)
      const blank = emptySession.createSession({ title: 'blank' })
      await emptySession.save(blank)
      try {
        await run('', { sessionId: blank.id, retry: true })
      } catch (error) {
        refused = error
      }
      assert('retry in an empty conversation is refused with exit code 65', refused instanceof SessionRewindError && refused.exitCode === NOTHING_TO_REWIND_EXIT_CODE)

      // CLI: last-turn, then undo, as hosts call them.
      const cli = (...args: string[]) => sessionCli(cwd, ...args)
      const last = await cli('last-turn', sessionId)
      const lastJson = JSON.parse(last.stdout) as { turn: { userMessage: { content: string }; sideEffects: boolean; tools: unknown[] } }
      assert('`session last-turn` prints the exchange as JSON', last.status === 0 && lastJson.turn.userMessage.content === 'QUESTION_EDITED' && lastJson.turn.sideEffects === false, last.stdout + last.stderr)
      const wrongTurn = await cli('undo', sessionId, '--turn', 'not-the-last-turn')
      assert('`session undo --turn` with another turn changes nothing and exits 66', wrongTurn.status === TURN_CHANGED_EXIT_CODE && /"reason":"changed"/.test(wrongTurn.stdout), `${wrongTurn.status} ${wrongTurn.stdout}`)
      const turnId = (JSON.parse(last.stdout) as { turn: { turnId: string } }).turn.turnId
      const undo = await cli('undo', sessionId, '--turn', turnId)
      const undoJson = JSON.parse(undo.stdout) as { ok: boolean; remainingMessages: number; removed: { userMessage: { content: string } } }
      assert('`session undo` removes the last exchange and says what is left', undo.status === 0 && undoJson.ok && undoJson.removed.userMessage.content === 'QUESTION_EDITED' && undoJson.remainingMessages === 2, undo.stdout + undo.stderr)
      const shown = await cli('show', sessionId)
      const shownJson = JSON.parse(shown.stdout) as { messages: Array<{ content: string }> }
      assert('after undo, `session show` ends with the first exchange', shownJson.messages.map((m) => m.content).join('|') === 'QUESTION_ONE|answer to QUESTION_ONE', shown.stdout.slice(0, 300))
      await cli('undo', sessionId)
      const nothing = await cli('undo', sessionId)
      assert('undo with nothing left exits 65 with a reason', nothing.status === NOTHING_TO_REWIND_EXIT_CODE && /"reason":"empty"/.test(nothing.stdout), `${nothing.status} ${nothing.stdout}`)
      const missing = await cli('undo', '0f4c2b1e-5d6a-4e7f-8a9b-0c1d2e3f4a5b')
      assert('undo of an unknown session fails like `show` (ENOENT)', missing.status !== 0 && /ENOENT/.test(missing.stderr), missing.stderr)
    })
  } finally {
    if (savedHome === undefined) delete process.env.ARTEMIS_HOME
    else process.env.ARTEMIS_HOME = savedHome
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

console.log('\nMCP descriptors')
{
  const cwd = tmpDir('mcp')
  try {
    fs.mkdirSync(path.join(cwd, '.artemis'), { recursive: true })
    const at = new Date().toISOString()
    fs.writeFileSync(path.join(cwd, '.artemis', 'mcp-servers.json'), JSON.stringify({
      servers: [{
        id: 'artemis_online', enabled: true, transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', authType: 'none', authState: 'configured',
        surface: { tools: [{ name: 'trigger_list', readOnly: true }, { name: 'trigger_create' }, { name: 'publish_request', readOnly: false }], resources: [], prompts: [] },
        createdAt: at, updatedAt: at,
      }],
    }))
    const classify = await createSideEffectClassifier(cwd)
    assert('the classifier reads read-only tools from the MCP server descriptors in the workspace',
      !classify('mcp__artemis_online__trigger_list', undefined) && classify('mcp__artemis_online__trigger_create', undefined) &&
        classify('mcp_call_tool', { serverId: 'artemis_online', toolName: 'publish_request', readOnly: true }) &&
        !classify('mcp_call_tool', { serverId: 'artemis_online', toolName: 'trigger_list' }))
    const bare = tmpDir('mcp-none')
    const none = await createSideEffectClassifier(bare)
    assert('without MCP configuration every MCP tool counts, and none is created', none('mcp__x__y', undefined) && !fs.existsSync(path.join(bare, '.artemis', 'mcp-servers.json')))
    fs.rmSync(bare, { recursive: true, force: true })
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

console.log('\nconversation search')
{
  assert('matching: a phrase as typed, else every word; ranges for each',
    JSON.stringify(matchText('Deploy the report, then the deploy log', 'deploy')) === JSON.stringify([[0, 6], [28, 34]]) &&
      JSON.stringify(matchText('log of the deploy', 'deploy log')) === JSON.stringify([[0, 3], [11, 17]]) &&
      matchText('nothing here', 'deploy') === null)
  const turkish = matchText('İstanbul report', 'report')
  assert('matching: ranges point into the original text when lowercasing changes its length', JSON.stringify(turkish) === JSON.stringify([[9, 15]]), JSON.stringify(turkish))
  assert('matching: a Chinese word inside a sentence', JSON.stringify(matchText('请帮我写一份市场研究报告', '研究报告')) === JSON.stringify([[8, 12]]))
  const long = `${'前文'.repeat(60)}关键结论在这里${'后文'.repeat(120)}`
  const ranges = matchText(long, '关键结论')!
  const snip = buildSnippet(long, ranges)
  assert('snippet: cut around the match with … and the highlight moved into place',
    snip.snippet.startsWith('…') && snip.snippet.endsWith('…') && snip.snippet.slice(snip.highlights[0]![0], snip.highlights[0]![1]) === '关键结论',
    JSON.stringify(snip))

  const cwd = tmpDir('search')
  const savedHome = process.env.ARTEMIS_HOME
  delete process.env.ARTEMIS_HOME
  try {
    const store = new SessionStore(cwd)
    const a = store.createSession({ title: 'a' })
    a.messages.push(msg('user', '帮我做一份新能源汽车的研究报告'), msg('assistant', '好的，研究报告已经写好。'), msg('user', 'thanks'), msg('assistant', 'You are welcome'))
    await store.save(a)
    const b = store.createSession({ title: 'b' })
    b.messages.push(msg('user', 'Quarterly revenue report please'), msg('assistant', 'Here is the revenue summary'))
    await store.save(b)
    const helper = store.createSession({ title: 'helper', kind: 'agent', parentSessionId: a.id })
    helper.messages.push(msg('user', '研究报告 subtask'))
    await store.save(helper)
    // An archived page: compaction moved the start of conversation c to its transcript.
    const c = store.createSession({ title: 'c' })
    const archived = [msg('user', 'old archived question about lighthouses and zebracrossings'), msg('assistant', 'archived answer')]
    fs.mkdirSync(store.getContextDir(c.id), { recursive: true })
    fs.writeFileSync(path.join(store.getContextDir(c.id), 'transcript.jsonl'), archived.map((m) => JSON.stringify({ compaction: 1, message: m })).join('\n') + '\n')
    c.messages.push(msg('user', 'lighthouses again'), msg('assistant', 'more on lighthouses'))
    await store.save(c)

    const zh = await searchConversations(cwd, '研究报告')
    assert('search: a Chinese word finds its conversation, newest hit first, helper sessions left out',
      zh.length === 1 && zh[0]!.sessionId === a.id && zh[0]!.matchCount === 2 && zh[0]!.hits[0]!.role === 'assistant' && zh[0]!.hits[0]!.newerCount === 2,
      JSON.stringify(zh))
    const en = await searchConversations(cwd, 'revenue')
    assert('search: English words through the full-text index', en.length === 1 && en[0]!.sessionId === b.id && en[0]!.hits.length === 2)
    const onlyArchived = await searchConversations(cwd, 'zebracrossings')
    assert('search: a word found only in an archived page is found by the global search too',
      onlyArchived.length === 1 && onlyArchived[0]!.sessionId === c.id && onlyArchived[0]!.hits[0]!.newerCount === 3, JSON.stringify(onlyArchived))
    const keys = await searchConversations(cwd, 'compaction')
    assert('search: the archive\'s JSON keys never match, only message text', keys.length === 0, JSON.stringify(keys))
    const deep = await searchConversations(cwd, 'lighthouses', { sessionId: c.id })
    assert('search: archived pages are searched too, with how many messages are newer',
      deep[0]?.matchCount === 3 && deep[0]!.hits.at(-1)!.newerCount === 3,
      JSON.stringify(deep))
    const cli = await sessionCli(cwd, 'search', '研究报告', '--limit', '5')
    const parsed = JSON.parse(cli.stdout) as { query: string; results: Array<{ sessionId: string; hits: Array<{ highlights: number[][] }> }> }
    assert('`session search` prints the results as JSON', cli.status === 0 && parsed.query === '研究报告' && parsed.results[0]?.sessionId === a.id && parsed.results[0]!.hits[0]!.highlights.length > 0, cli.stdout + cli.stderr)
  } finally {
    if (savedHome === undefined) delete process.env.ARTEMIS_HOME
    else process.env.ARTEMIS_HOME = savedHome
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
