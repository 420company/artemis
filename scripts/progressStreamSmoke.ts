#!/usr/bin/env tsx
/**
 * scripts/progressStreamSmoke.ts — `execute --output-format stream-json`
 * (services/streamJson.ts) and the `todo` tool (core/todoList.ts).
 *
 * The security invariant this guards: hosts check what a run did from its
 * stderr `[tool:…]` lines (artemis-online run trust, sub-agents included).
 * Every tool event of the stream is written in the same onInfo call as its
 * stderr line, so the stream can never show a tool call that stderr did not
 * report, and stderr reports every call, with or without the flag.
 *
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/progressStreamSmoke.ts
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, getHelpText } from '../src/cli/parseArgs.js'
import { parseAssistantEnvelopeForSmoke, runAgent as runAgentNow } from '../src/core/agent.js'
import { ReplyStreamFilter, visibleReplyOf } from '../src/core/replyStream.js'
import { settleMemoryCuration } from '../src/core/memory.js'
import { childInfo, nextAgentRef, toolArtifacts, toolDetail, type ProgressEvent } from '../src/core/progressEvents.js'
import { normalizeTodos, renderTodos, validateTodoAction } from '../src/core/todoList.js'
import type { AgentAction } from '../src/core/types.js'
import { getAllowedActionTypesForProfile } from '../src/core/agentProfiles.js'
import type { ChatProvider, ProviderResponse } from '../src/providers/types.js'
import { PermissionManager } from '../src/security/permissions.js'
import { StreamJsonWriter, STREAM_JSON_VERSION } from '../src/services/streamJson.js'
import { SessionStore } from '../src/storage/sessions.js'
import { getToolDefinition, validateToolRegistryIntegrity } from '../src/tools/registry.js'
import { buildActionParametersSchema as getProviderToolSchema } from '../src/core/providerNativeTools.js'
import { findInternalNames } from '../src/utils/internalNames.js'

let passed = 0
let failed = 0
function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  \x1b[32m✔\x1b[0m ${label}`)
    passed++
  } else {
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-progress-'))
process.env.ARTEMIS_HOME = path.join(root, 'home')
fs.mkdirSync(process.env.ARTEMIS_HOME, { recursive: true })

const runAgent: typeof runAgentNow = async (...args) => {
  try {
    return await runAgentNow(...args)
  } finally {
    await settleMemoryCuration()
  }
}

/** The host's parser for tool lines (artemis-online server/src/engine/artemisOutput.ts ANY_TOOL), verbatim. */
const HOST_ANY_TOOL = /^(?:\[(?!tool:)[A-Za-z][A-Za-z0-9_-]{0,31}:[^\]\r\n]{0,120}\][ \t]+){0,8}\[tool:([A-Za-z0-9_.:-]+)\] (running|ok|failed|denied|error|blocked by profile policy|authorize_error)\b/

function collector(): { lines: string[]; events: Array<Record<string, unknown>>; pairs: Array<{ line: string; event?: ProgressEvent }>; onInfo: (line: string, event?: ProgressEvent) => void; writer: StreamJsonWriter } {
  const lines: string[] = []
  const events: Array<Record<string, unknown>> = []
  const pairs: Array<{ line: string; event?: ProgressEvent }> = []
  const writer = new StreamJsonWriter({ write: (line) => events.push(JSON.parse(line) as Record<string, unknown>) })
  return {
    lines,
    events,
    pairs,
    writer,
    onInfo: (line, event) => {
      lines.push(line)
      pairs.push({ line, ...(event ? { event } : {}) })
      writer.onInfo(line, event)
    },
  }
}

// ── The writer ─────────────────────────────────────────────────────────────
{
  const c = collector()
  c.writer.start({ mode: 'execute' })
  c.onInfo('[stream-chunk] profile=main turn=1 delta="Hi"', { type: 'text_delta', text: 'Hi', profile: 'main' })
  c.onInfo('[stream-chunk] profile=reviewer turn=1 delta="x"', { type: 'text_delta', text: 'x', profile: 'reviewer' })
  const agent = nextAgentRef('researcher')
  const child = childInfo(c.onInfo, '[agent:researcher]', agent)!
  c.onInfo('[agent:researcher] running', { type: 'subagent_start', agent, task: '查资料' })
  child('[stream-chunk] profile=researcher turn=1 delta="找到了"', { type: 'text_delta', text: '找到了', profile: 'researcher' })
  child('[tool:search_web] running', { type: 'tool_start', callId: 'call_9', tool: 'search_web', detail: '天气' })
  child('[tool:search_web] ok {}', { type: 'tool_end', callId: 'call_9', tool: 'search_web', status: 'ok' })
  c.onInfo('[agent:researcher] done', { type: 'subagent_end', agent, ok: true })
  c.onInfo('[approval-request] {"id":"apr_00000000000000000000","kind":"payment","title":"付款"}')
  c.onInfo('[agent:researcher] [approval-request] {"id":"apr_11111111111111111111"}')
  c.onInfo('[agent-update] {"id":"upd_0000000000000000","text":"x"}')
  c.writer.result({ sessionId: 's', turns: 1, durationMs: 5, reply: 'Hi' })
  const types = c.events.map((e) => e.type)
  assert('writer: every line carries the version and an increasing seq', c.events.every((e, i) => e.v === STREAM_JSON_VERSION && e.seq === i + 1))
  assert('writer: start first, result last', types[0] === 'start' && types.at(-1) === 'result')
  assert('writer: main text is text_delta; another profile\'s unwrapped text is not shown', c.events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('') === 'Hi')
  assert('writer: a sub-agent\'s raw text is never streamed', !c.events.some((e) => e.type === 'subagent_delta' || (e.type === 'text_delta' && e.text === '找到了')))
  const start = c.events.find((e) => e.type === 'tool_start')!
  assert('writer: a sub-agent\'s tool names its agent and has a user label', (start.agent as { id: string }).id === agent.id && typeof start.label === 'string' && findInternalNames(String(start.label)).length === 0, JSON.stringify(start))
  assert('writer: the run\'s approval request is mirrored with the same object', c.events.filter((e) => e.type === 'approval_request').length === 1 && (c.events.find((e) => e.type === 'approval_request')!.request as { id: string }).id === 'apr_00000000000000000000')
  assert('writer: control lines stay on stderr only', !types.includes('agent_update'))
}

// ── A huge reply: the result keeps its session first and cuts the reply ────
{
  const lines: string[] = []
  const w = new StreamJsonWriter({ write: (line) => lines.push(line) })
  const { MAX_RESULT_REPLY_CHARS } = await import('../src/services/streamJson.js')
  w.result({ sessionId: 'cb06d7de-7ee1-4443-8654-e306ef8e7991', turns: 2, durationMs: 1, reply: 'x'.repeat(MAX_RESULT_REPLY_CHARS + 10) })
  const r = JSON.parse(lines[0]!) as Record<string, unknown>
  assert('result: a huge reply is cut and marked, the session never lost', (r.reply as string).length === MAX_RESULT_REPLY_CHARS && r.replyTruncated === true && r.sessionId === 'cb06d7de-7ee1-4443-8654-e306ef8e7991')
  assert('result: session and turns come first in the line', /^\{"v":1,"seq":1,"type":"result","sessionId":"[0-9a-f-]{36}","turns":2,/.test(lines[0]!))
}

// ── Stdout is the stream's alone ───────────────────────────────────────────
{
  const script = path.join(root, 'stdout-check.ts')
  const writerPath = path.resolve('src/services/streamJson.ts')
  fs.writeFileSync(script, `import { StreamJsonWriter } from ${JSON.stringify(writerPath)}\nconst w = new StreamJsonWriter()\nconsole.log('noise from a library')\nprocess.stdout.write('more noise\\n')\nconsole.log('\\n[approval-request] {"id":"apr_00000000000000000000","kind":"payment","title":"x"}')\nprocess.stdout.write(Buffer.from('[tool:mcp_call_tool] ok {}\\n'))\nw.emit('result', { ok: true })\nw.close()\n`)
  const out = spawnSync(process.execPath, ['--no-warnings', path.resolve('node_modules/tsx/dist/cli.mjs'), script], { encoding: 'utf8' })
  const stdoutLines = out.stdout.split('\n').filter(Boolean)
  assert('stdout: only stream events reach stdout', stdoutLines.length === 1 && JSON.parse(stdoutLines[0]!).type === 'result', out.stdout + out.stderr)
  assert('stdout: other writes go to stderr', /noise from a library/.test(out.stderr) && /more noise/.test(out.stderr), out.stderr)
  const errLines = out.stderr.split('\n')
  assert('stdout: redirected lines are prefixed, so a library cannot start a protocol line', errLines.every((line) => !/^\[(?:approval-request|tool:)/.test(line)) && errLines.some((line) => line.startsWith('[stdout] [approval-request]')), out.stderr)
  const { redirectedStdout } = await import('../src/services/streamJson.js')
  assert('stdout: every line of a chunk gets the prefix', redirectedStdout('a\r\n[tool:x] running\nb') === '[stdout] a\n[stdout] [tool:x] running\n[stdout] b\n')
}

// ── CLI flag ───────────────────────────────────────────────────────────────
{
  assert('cli: execute --output-format stream-json', parseArgs(['execute', '--output-format', 'stream-json', 'hi']).outputFormat === 'stream-json')
  assert('cli: --output-format=text', parseArgs(['execute', '--output-format=text', 'hi']).outputFormat === 'text')
  let refused = false
  try {
    parseArgs(['execute', '--output-format', 'xml', 'hi'])
  } catch {
    refused = true
  }
  assert('cli: an unknown format is refused (never read as the message)', refused)
  assert('cli: the help lists the flag (hosts probe it)', /--output-format/.test(getHelpText('en')) && /--output-format/.test(getHelpText('zh-CN')))
}

// ── The todo tool ──────────────────────────────────────────────────────────
{
  assert('todo: registered, runtime-managed, offered to the main agent', !!getToolDefinition('todo') && getAllowedActionTypesForProfile('main').includes('todo'))
  assert('todo: the registry stays consistent', validateToolRegistryIntegrity().length === 0, validateToolRegistryIntegrity().join('; '))
  assert('todo: a native schema', JSON.stringify(getProviderToolSchema('todo')).includes('todos'))
  assert('todo: validation', validateTodoAction({ todos: [{ content: 'a', status: 'done' }] }).length === 1 && validateTodoAction({ todos: [{ content: 'a' }] }).length === 0 && validateTodoAction({}).length === 1)
  const items = normalizeTodos([{ content: ' 读  配置 ' }, { id: 't1', content: '改代码', status: 'in_progress' }])
  assert('todo: ids given and kept unique, statuses defaulted', items[0]!.id === 't1' && items[1]!.id === 't1-2' && items[0]!.content === '读 配置' && items[0]!.status === 'pending')
  assert('todo: the model reads the list back', /0\/2 done/.test(renderTodos(items)))
}

// ── Details and artifacts never carry content ─────────────────────────────
{
  assert('detail: a write names the file, not the content', toolDetail({ type: 'write_file', path: 'a.txt', content: 'SECRET BODY' } as AgentAction) === 'a.txt')
  const curl = toolDetail({ type: 'run_command', command: 'curl -H "Authorization: Bearer abcdefghijklmnop" "https://x.example/?api_key=SECRET123&q=1" sk-proj-abcdefghijklmnop' } as AgentAction) ?? ''
  assert('detail: tokens in a command are masked', !/abcdefghijklmnop|SECRET123/.test(curl) && /curl/.test(curl), curl)
  assert('detail: a site, not the whole URL', toolDetail({ type: 'browser_navigate', url: 'https://shop.example/p?token=abc' } as AgentAction) === 'shop.example')
  assert('artifacts: files named in a generator\'s output', JSON.stringify(toolArtifacts({ type: 'generate_image' } as AgentAction, true, {}, '已保存到 media/cat.png')) === '["media/cat.png"]')
  assert('artifacts: none for a failure', toolArtifacts({ type: 'write_file' } as AgentAction, false, { path: 'a' }, '') === undefined)
}

// ── A real run: every stream tool event has its stderr line, and back ──────
{
  const cwd = path.join(root, 'run')
  fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(path.join(cwd, 'notes.md'), '# notes\n')
  // Main and the researcher each play their own script (the researcher's first message is its task).
  const mainScript: Array<{ reply: string; actions?: AgentAction[] }> = [
    // Turn 1: a plan, a write, a read, and a delegated researcher.
    {
      reply: '',
      actions: [
        { type: 'todo', todos: [{ content: '写文件', status: 'in_progress' }, { content: '查资料' }] } as AgentAction,
        { type: 'write_file', path: 'out.md', content: 'hello' } as AgentAction,
        { type: 'read_file', path: 'notes.md' } as AgentAction,
        { type: 'delegate_task', role: 'researcher', task: '看看 notes.md 里有什么（Saga / Heimdall / gateway）' } as AgentAction,
      ],
    },
    // Turn 2: tick the plan off.
    { reply: '', actions: [{ type: 'todo', todos: [{ id: 't1', content: '写文件', status: 'completed' }, { id: 't2', content: '查资料', status: 'completed' }] } as AgentAction] },
  ]
  // The researcher: a read (allowed) and a write (blocked by its profile).
  // Internal names and a model id in the helper's own words: none may reach the stream.
  const LEAKY = 'Saga 和 Nidhogg、Mnemosyne、Bragi、Heimdall、Bifrost、Director agent、[niko:reviewer]、Seedance、ModelArk、Hyperframes 都提到了 doubao-seedance-1-0-pro、claude-x、OpenAI 和 generate_long_video。'
  const childScript: Array<{ reply: string; actions?: AgentAction[] }> = [
    { reply: LEAKY, actions: [{ type: 'list_files', pattern: '*.md' } as AgentAction, { type: 'write_file', path: 'x.md', content: 'no' } as AgentAction] },
    { reply: LEAKY },
  ]
  let mainCalls = 0
  let childCalls = 0
  const provider: ChatProvider = {
    async complete(messages: Array<{ role: string; content: unknown }>): Promise<ProviderResponse> {
      const first = messages.find((m) => m.role === 'user')
      const isChild = typeof first?.content === 'string' && first.content.includes('看看 notes.md 里有什么')
      const turn = isChild ? (childScript[childCalls++] ?? { reply: LEAKY }) : (mainScript[mainCalls++] ?? { reply: '都做完了。' })
      return { text: JSON.stringify({ reply: turn.reply, done: !turn.actions?.length, actions: turn.actions ?? [] }), raw: null, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
    },
  } as unknown as ChatProvider
  const store = new SessionStore(cwd)
  const session = store.createSession({ title: 'progress smoke' })
  await store.save(session)
  const c = collector()
  const result = await runAgent(session, '写个文件，再让助手看看 notes.md', {
    cwd, provider, sessionStore: store, permissionManager: new PermissionManager('accept-all', false), maxTurns: 6, profile: 'main', onInfo: c.onInfo,
  })
  if (process.env.DEBUG_PROGRESS) console.log(c.lines.filter((l) => !l.startsWith('[stream')).join('\n'))
  assert('run: finished', /做完/.test(result.reply), result.reply)

  const hostSeen = c.lines.map((line) => HOST_ANY_TOOL.exec(line)).filter((m): m is RegExpExecArray => !!m)
  const streamTools = c.events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end')
  // Pair them: every event came with a line the host's parser reads, of the same tool.
  const unpaired = c.pairs.filter((p) => p.event && (p.event.type === 'tool_start' || p.event.type === 'tool_end')).filter((p) => {
    const m = HOST_ANY_TOOL.exec(p.line)
    return !m || m[1] !== (p.event as { tool: string }).tool
  })
  assert('invariant: every stream tool event was written with a [tool:…] line the host reads', unpaired.length === 0, JSON.stringify(unpaired))
  const startedOnStderr = hostSeen.filter((m) => m[2] === 'running').length
  const endedOnStderr = hostSeen.filter((m) => m[2] !== 'running').length
  assert('invariant: as many tool_start events as running lines', streamTools.filter((e) => e.type === 'tool_start').length === startedOnStderr, `${startedOnStderr}`)
  assert('invariant: as many tool_end events as end lines', streamTools.filter((e) => e.type === 'tool_end').length === endedOnStderr, `${endedOnStderr}`)
  const subTools = hostSeen.filter((m) => m[0].startsWith('[agent:researcher]'))
  assert('invariant: the sub-agent\'s tools are on stderr, prefixed as before', subTools.some((m) => m[1] === 'list_files') && subTools.some((m) => m[1] === 'write_file' && m[2] === 'blocked by profile policy'), subTools.map((m) => m[0]).join(' | '))
  const subEvents = streamTools.filter((e) => (e.agent as { role?: string } | undefined)?.role === 'researcher')
  assert('stream: the sub-agent\'s tools carry its agent', subEvents.some((e) => e.tool === 'list_files') && subEvents.some((e) => e.tool === 'write_file' && e.status === 'blocked'), JSON.stringify(subEvents))
  assert('stream: calls are paired by callId', streamTools.filter((e) => e.type === 'tool_end' && e.status === 'ok').every((end) => streamTools.some((s) => s.type === 'tool_start' && s.callId === end.callId)))
  const write = streamTools.find((e) => e.type === 'tool_end' && e.tool === 'write_file' && e.status === 'ok')
  assert('stream: a written file is an artifact', JSON.stringify(write?.artifacts) === '["out.md"]', JSON.stringify(write))
  const todos = c.events.filter((e) => e.type === 'todo')
  assert('stream: the plan as it changes', todos.length === 2 && (todos[1]!.items as Array<{ status: string }>).every((i) => i.status === 'completed'), JSON.stringify(todos))
  assert('todo: kept on the conversation\'s task board', session.tasks?.length === 2 && session.tasks.every((t) => t.status === 'completed'))
  assert('stream: the sub-agent starts and ends', c.events.some((e) => e.type === 'subagent_start' && (e.agent as { role: string }).role === 'researcher' && typeof e.task === 'string') && c.events.some((e) => e.type === 'subagent_end' && e.ok === true))
  assert('stream: usage per model call', c.events.filter((e) => e.type === 'usage').length >= 4 && c.events.every((e) => e.type !== 'usage' || e.inputTokens === 100))
  const { hasInternalProgressName, scrubInternalNamesStrict } = await import('../src/utils/internalNames.js')
  const { detailText } = await import('../src/core/progressEvents.js')
  const shown = c.events.map((e) => [e.label, e.detail, e.task, e.summary, e.text, ...(Array.isArray(e.items) ? (e.items as Array<{ content: string }>).map((i) => i.content) : [])].filter((v) => typeof v === 'string').join(' ')).join(' ')
  assert('stream: nothing shown names an internal system or a model (the helper wrote them all)', !hasInternalProgressName(shown) && !/doubao|seedance|nidhogg|heimdall|openai|claude/i.test(shown), shown.slice(0, 400))
  assert('stream: the helper\'s summary comes with its end', c.events.some((e) => e.type === 'subagent_end' && typeof e.summary === 'string' && (e.summary as string).length > 0))
  const MUST = ['Saga 长视频', 'sagaWorkflow 模块', 'saga-render step', 'Nidhogg round', 'Mnemosyne', 'Bragi bridge', 'Heimdall log', 'Bifrost', 'Director agent', 'critic pass', '[niko:reviewer] ok', '[Workflow: saga]', 'Seedance', 'byteplus/seedream-5-0', 'doubao-seedance-1-0-pro', 'claude-x', 'gpt-4o', 'deepseek-v3', 'qwen-max', 'wan2.1', 'gemini-pro', 'OpenAI', 'Anthropic', 'volcengine', 'generate_long_video']
  for (const text of MUST) assert(`names: "${text}" is rewritten`, !hasInternalProgressName(scrubInternalNamesStrict(text)) && scrubInternalNamesStrict(text) !== text, scrubInternalNamesStrict(text))
  const KEEP = ['cd gateway', 'email the director about the contest results', 'US Constitution', 'Stripe payment gateway', 'AWS Athena', 'Carl Sagan', 'sagacious', 'Freya Allan', 'Niko Rosberg', 'report.md is done', 'see https://example.com/a', 'src/app.ts']
  for (const text of KEEP) assert(`names: "${text}" stays as it is`, scrubInternalNamesStrict(text) === text, scrubInternalNamesStrict(text))
  for (const [text, want] of [
    ['Saga.ts', 'a file'], ['src/sagaWorkflow.ts', 'a file'], ['文件 Saga.mp4', '文件'], ['see https://gemini.google.com now', 'see a link now'],
    ['打开 https://seedance.ai/x 看看', '打开 链接 看看'], ['byteplus/seedream-5-0 said no', 'a file said no'],
  ] as const) assert(`names: a path or link naming one is left out ("${text}")`, scrubInternalNamesStrict(text) === want, scrubInternalNamesStrict(text))
  for (const text of ['Nidhogg.ai', 'Seedance.pro', 'BytePlus.com', 'seedance.ai']) assert(`names: a name dressed as a file or domain is not protected ("${text}")`, !hasInternalProgressName(scrubInternalNamesStrict(text)), scrubInternalNamesStrict(text))
  assert('names: a replacement next to the same word is one word', scrubInternalNamesStrict('启动 Nidhogg 审查') === '启动 审查' && scrubInternalNamesStrict('Heimdall log') === 'run log' && scrubInternalNamesStrict('Saga Saga') === 'long video', `${scrubInternalNamesStrict('启动 Nidhogg 审查')} | ${scrubInternalNamesStrict('Heimdall log')}`)
  assert('names: the owner\'s own repeated words stay', scrubInternalNamesStrict('log log 审查 审查') === 'log log 审查 审查')
  assert('artifacts: a real path stays intact in the file links', JSON.stringify(toolArtifacts({ type: 'write_file' } as AgentAction, true, { path: 'src/sagaWorkflow.ts' }, '')) === '["src/sagaWorkflow.ts"]')
  assert('names: Chinese text gets Chinese words', scrubInternalNamesStrict('用 Saga 和 doubao-seedance 做') === '用 长视频 和 视频模型 做', scrubInternalNamesStrict('用 Saga 和 doubao-seedance 做'))
  assert('detail: a path or command naming an internal system is left out, never rewritten', detailText('src/sagaWorkflow.ts') === undefined && detailText('cat heimdall.log') === undefined && detailText('cd gateway') === 'cd gateway')

}

// ── A long video reports its segments, n of N ─────────────────────────────
{
  const { runHermeticSaga } = await import('./sagaHermeticHarness.js')
  const seen: Array<{ index: number; total: number; status: string }> = []
  const run = await runHermeticSaga(
    { prompt: 'A young woman named Mei walks along a beach at sunset, then sits on a rock and watches the waves.', totalDuration: 10, ratio: '9:16', generateAudio: false },
    { videoCapabilities: { maxClipSeconds: 5 } } as never,
    () => ({ progress: (event: { index: number; total: number; status: string }) => seen.push(event) }),
  )
  assert('segments: the long video finished', run.result.ok === true, run.result.output.slice(0, 300))
  assert('segments: each part starts and finishes, n of N', JSON.stringify(seen.map((e) => `${e.index}/${e.total} ${e.status}`)) === JSON.stringify(['1/2 started', '1/2 done', '2/2 started', '2/2 done']), JSON.stringify(seen))
  const c = collector()
  c.onInfo('[segment] long_video 1/2 done', { type: 'segment', job: 'long_video', index: 1, total: 2, status: 'done' })
  assert('segments: on the stream as segment events', c.events.some((e) => e.type === 'segment' && e.index === 1 && e.total === 2 && e.status === 'done'))
}

// ── Reference hosting through the platform: signed uploads, no storage key here ──
{
  const { platformAssetHostingFromStore, uploadViaPlatform } = await import('../src/tools/vidarAssetHosting.js')
  const managed = { defaultMainProfileId: 'executor', profiles: [{ id: 'executor', managedBy: 'platform', baseUrl: 'https://gw.example/v1', apiKey: 'ak-owner' }] } as never
  assert('hosting: a platform-managed main profile means platform hosting', JSON.stringify(platformAssetHostingFromStore(managed)) === JSON.stringify({ baseUrl: 'https://gw.example/v1', apiKey: 'ak-owner' }))
  assert('hosting: never over plain http', platformAssetHostingFromStore({ defaultMainProfileId: 'executor', profiles: [{ id: 'executor', managedBy: 'platform', baseUrl: 'http://gw.example/v1', apiKey: 'k' }] } as never) === undefined)
  assert('hosting: the key goes only to the platform\'s own origin', platformAssetHostingFromStore({ ...(managed as object), visualProfile: { assetHosting: { enabled: true, provider: 'platform', baseUrl: 'https://elsewhere.example/v1', apiKey: 'ak-owner' } } } as never) === undefined
    && JSON.stringify(platformAssetHostingFromStore({ ...(managed as object), visualProfile: { assetHosting: { enabled: true, provider: 'platform', baseUrl: 'https://gw.example/v1/', apiKey: 'ak-model' } } } as never)) === JSON.stringify({ baseUrl: 'https://gw.example/v1/', apiKey: 'ak-model' }))
  assert('hosting: turned off explicitly', platformAssetHostingFromStore({ ...(managed as object), visualProfile: { assetHosting: { enabled: false, provider: 'platform' } } } as never) === undefined)
  assert('hosting: an own bucket wins', platformAssetHostingFromStore({ ...(managed as object), visualProfile: { assetHosting: { enabled: true, provider: 'r2', endpoint: 'x' } } } as never) === undefined)
  assert('hosting: no platform, no hosting', platformAssetHostingFromStore({ profiles: [{ id: 'executor', baseUrl: 'https://api.example/v1', apiKey: 'k' }] } as never) === undefined)
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = []
  const fakeFetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    if (url.endsWith('/assets/presign')) {
      return new Response(JSON.stringify({ uploadUrl: 'https://store.example/b/acct/audio/x.mp3?X-Amz-Signature=abc', headers: { 'content-type': 'audio/mpeg', 'content-length': '4', Authorization: 'nope' }, publicUrl: 'https://assets.example/acct/audio/x.mp3' }), { status: 200 })
    }
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch
  const url = await uploadViaPlatform({ baseUrl: 'https://gw.example/v1', apiKey: 'ak-owner' }, { body: Buffer.from('abcd'), contentType: 'audio/mpeg', kind: 'audio', name: 'bgm.mp3' }, fakeFetch)
  assert('hosting: the public URL comes back', url === 'https://assets.example/acct/audio/x.mp3')
  const presign = calls[0]!
  assert('hosting: asks the gateway with the platform key, stating size and type', presign.url === 'https://gw.example/v1/assets/presign' && presign.headers.authorization === 'Bearer ak-owner' && JSON.parse(String(presign.body)).bytes === 4)
  let putFailed = ''
  try {
    await uploadViaPlatform({ baseUrl: 'https://gw.example/v1', apiKey: 'k' }, { body: Buffer.from('a'), contentType: 'audio/mpeg', kind: 'audio', name: 'a.mp3' }, (async (u: string) => (u.endsWith('/assets/presign') ? new Response(JSON.stringify({ uploadUrl: 'https://store.example/x', publicUrl: 'https://assets.example/x' }), { status: 200 }) : new Response('<Error><Code>SignatureDoesNotMatch</Code><BucketName>secret-bucket</BucketName></Error>', { status: 403 }))) as unknown as typeof fetch)
  } catch (error) {
    putFailed = (error as Error).message
  }
  assert('hosting: a failed upload says so plainly, without the store\'s own error', /HTTP 403/.test(putFailed) && !/secret-bucket|SignatureDoesNotMatch/.test(putFailed), putFailed)
  const { platformAssetHostingOff } = await import('../src/tools/vidarAssetHosting.js')
  assert('hosting: the platform turning it off is known as such', platformAssetHostingOff({ visualProfile: { assetHosting: { enabled: false, provider: 'platform' } } } as never) && !platformAssetHostingOff({} as never))
  const byoMain = { defaultMainProfileId: 'mine', profiles: [{ id: 'mine', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'own' }, { id: 'executor', managedBy: 'platform', baseUrl: 'https://gw.example/v1', apiKey: 'ak-owner' }] } as never
  assert('hosting: an owner\'s own main model (a local proxy) keeps platform hosting, with the platform\'s key', JSON.stringify(platformAssetHostingFromStore(byoMain)) === JSON.stringify({ baseUrl: 'https://gw.example/v1', apiKey: 'ak-owner' }))
  const put = calls[1]!
  assert('hosting: the upload carries no key of ours, only the signed headers', put.method === 'PUT' && !Object.keys(put.headers).some((k) => /authorization/i.test(k)) && put.headers['content-type'] === 'audio/mpeg')
  let refused = ''
  try {
    await uploadViaPlatform({ baseUrl: 'https://gw.example/v1', apiKey: 'k' }, { body: Buffer.from('a'), contentType: 'video/mp4', kind: 'video', name: 'a.mp4' }, (async () => new Response(JSON.stringify({ error: { code: 'asset_hosting_unavailable' } }), { status: 503 })) as unknown as typeof fetch)
  } catch (error) {
    refused = (error as Error).message
  }
  assert('hosting: a platform without hosting says so plainly', /does not host reference/.test(refused), refused)
  for (const [code, words] of [['asset_budget_exhausted', /used up/], ['insufficient_balance', /no quota left/], ['membership_inactive', /no quota left/], ['rate_limited', /too many/]] as const) {
    let said = ''
    try {
      await uploadViaPlatform({ baseUrl: 'https://gw.example/v1', apiKey: 'k' }, { body: Buffer.from('a'), contentType: 'video/mp4', kind: 'video', name: 'a.mp4' }, (async () => new Response(JSON.stringify({ error: { code } }), { status: 429 })) as unknown as typeof fetch)
    } catch (error) {
      said = (error as Error).message
    }
    assert(`hosting: ${code} is told plainly`, words.test(said) && !/费用|计费|余额|充值|balance/i.test(said), said)
  }
}

// ── Background music as an uploaded file ───────────────────────────────────
{
  const { looksLikeSagaWizardAnswer } = await import('../src/tools/visual/sagaWorkflow.js')
  const { buildRoutedWorkflowHint } = await import('../src/core/workflowRouter.js')
  assert('bgm: an attached audio file answers the long-video questions', looksLikeSagaWizardAnswer('Attached file: uploads/2026-10-12/bgm-1a2b.mp3') && looksLikeSagaWizardAnswer('用这个配乐\n\nAttached file: uploads/2026-10-12/song.m4a'))
  assert('bgm: a long new request with a file is not a wizard answer', !looksLikeSagaWizardAnswer('帮我把这份季度报告整理成一页摘要，然后发给团队里的每个人看看\n\nAttached file: uploads/a/report.mp3'))
  const hint = buildRoutedWorkflowHint('saga', { cwd: root, userPrompt: 'x' })
  assert('bgm: the long-video playbook takes an attached audio file as soundtrackPath', /soundtrackPath/.test(hint) && /attach an audio file/.test(hint))
}

// ── Streamed text is the reply, never the JSON envelope ───────────────────
{
  const IMAGE_ENVELOPE = '{"reply":"已生成：25岁亚洲女性全身写真，米白色连衣裙、自然光公园场景。\\n\\nmedia/images/asian-woman-full-body.png","done":true,"actions":[],"tasks":[],"claims":[],"plan":[]}'
  const stream = (raw: string, chunks: string[]): string => {
    const f = new ReplyStreamFilter()
    let out = ''
    for (const chunk of chunks) out += f.push(chunk)
    return out + f.end()
  }
  const bySize = (raw: string, size: number): string[] => {
    const chunks: string[] = []
    for (let i = 0; i < raw.length; i += size) chunks.push(raw.slice(i, i + size))
    return chunks
  }
  /** The UTF-8 bytes cut every `size` bytes, decoded as a provider's SSE reader does. */
  const byBytes = (raw: string, size: number): string[] => {
    const bytes = new TextEncoder().encode(raw)
    const decoder = new TextDecoder()
    const chunks: string[] = []
    for (let i = 0; i < bytes.length; i += size) chunks.push(decoder.decode(bytes.subarray(i, i + size), { stream: true }))
    chunks.push(decoder.decode())
    return chunks
  }
  let seed = 7
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const randomCuts = (raw: string): string[] => {
    const chunks: string[] = []
    for (let i = 0; i < raw.length;) {
      const n = 1 + Math.floor(random() * 9)
      chunks.push(raw.slice(i, i + n))
      i += n
    }
    return chunks
  }
  /** Every way to stream it gives the reply the run ends with (agent.ts tryParseEnvelope). */
  const everyCut = (label: string, raw: string, want = parseAssistantEnvelopeForSmoke(raw).reply): void => {
    const wrong: string[] = []
    for (let size = 1; size <= Math.min(raw.length, 40); size += 1) {
      const got = stream(raw, bySize(raw, size))
      if (got !== want) wrong.push(`chars/${size}: ${JSON.stringify(got)}`)
      const gotBytes = stream(raw, byBytes(raw, size))
      if (gotBytes !== want) wrong.push(`bytes/${size}: ${JSON.stringify(gotBytes)}`)
    }
    for (let round = 0; round < 30; round += 1) {
      const got = stream(raw, randomCuts(raw))
      if (got !== want) wrong.push(`random: ${JSON.stringify(got)}`)
    }
    assert(`reply stream: ${label} (every split gives ${JSON.stringify(want.slice(0, 40))})`, wrong.length === 0, wrong.slice(0, 3).join(' | '))
  }

  everyCut('the image job\'s final envelope', IMAGE_ENVELOPE)
  assert('reply stream: the image envelope shows the reply only', visibleReplyOf(IMAGE_ENVELOPE) === '已生成：25岁亚洲女性全身写真，米白色连衣裙、自然光公园场景。\n\nmedia/images/asian-woman-full-body.png')
  {
    // No delta ever shows a piece of the envelope, at any split.
    const leaks: string[] = []
    for (let size = 1; size <= IMAGE_ENVELOPE.length; size += 1) {
      const f = new ReplyStreamFilter()
      for (const chunk of bySize(IMAGE_ENVELOPE, size)) {
        const out = f.push(chunk)
        if (/[{}[\]"\\]|reply|done|actions|tasks|claims|plan/.test(out)) leaks.push(`${size}: ${JSON.stringify(out)}`)
      }
    }
    assert('reply stream: no delta carries envelope syntax or field names', leaks.length === 0, leaks.slice(0, 3).join(' | '))
  }
  everyCut('escapes split across chunks (\\n \\" \\\\ \\/ \\t \\uXXXX, a surrogate pair)', '{"reply":"第一行\\n第二行 \\"引号\\" 反斜杠\\\\ 斜杠\\/ 制表\\t 中\\u6587 表情\\ud83d\\ude00 末尾","done":true,"actions":[]}')
  everyCut('a raw emoji and CJK in the reply', '{"reply":"好的 😀👍🏽 完成","done":true}')
  everyCut('the envelope in a ```json fence', '```json\n{"reply":"围栏里的回复\\n第二行","done":true,"actions":[]}\n```')
  everyCut('whitespace before the envelope', '\n\n  {"reply": "前面有空白", "done": true}')
  everyCut('reply after the other fields', '{"done":false,"tasks":[{"id":"1","content":"reply 里的 \\"x\\"","status":"pending"}],"actions":[{"type":"write_file","path":"a.md","content":"{\\"reply\\":\\"not me\\"}","reply":"nested"}],"reply":"真正的回复","plan":[{"id":"1","content":"步骤"}]}')
  everyCut('a tool-call turn: progress note plus actions', '{"reply":"好的，开始生成图片。","done":false,"actions":[{"type":"generate_image","prompt":"25岁亚洲女性全身写真，米白色连衣裙","size":"1024x1536"}],"tasks":[{"id":"1","content":"生成图片","status":"in_progress"}],"claims":[],"plan":[]}')
  everyCut('an envelope with an empty reply', '{"reply":"","done":false,"actions":[{"type":"read_file","path":"a.md"}]}')
  everyCut('an envelope without a reply field shows nothing while streaming', '{"done":false,"actions":[{"type":"read_file","path":"a.md"}]}', '')
  everyCut('a plain-text answer is streamed as it is', '这是一个普通的回答，没有 JSON。\n\n- 第一点\n- 第二点 `code {x}` a<b\n\n```ts\nconst a = { b: 1 }\n```')
  everyCut('a plain-text answer is trimmed like the parsed reply', '\n  前后有空白的回答  \n\n')
  everyCut('a plain answer with a code fence first', '```python\nprint("hi")\n```\n说明文字')
  everyCut('prose then tool-call markup: the prose only', '我先读一下文件。\n<toolcall name="read_file">{"path":"notes.md"}</toolcall>')
  everyCut('tool-call markup only: nothing', '<toolcall name="read_file">{"path":"notes.md"}</toolcall>')
  everyCut('an <invoke> call: nothing', '<invoke name="read_file"><parameter name="path">a.md</parameter></invoke>')
  assert('reply stream: prose then an embedded envelope never shows the envelope', !/[{}"]/.test(visibleReplyOf('好的。\n```json\n{"reply":"x","done":true,"actions":[]}\n```')) && !/[{}"]/.test(visibleReplyOf('好的。 {"actions":[{"type":"read_file","path":"a"}]}')))
  assert('reply stream: tool-call markup inside an envelope reply is cut', visibleReplyOf('{"reply":"看一下 <call name=\\"read_file\\">{}</call>","done":false}') === '看一下 ')
  assert('reply stream: an unterminated stream shows what it has', stream('', ['{"reply":"写到一半']) === '写到一半')
  assert('reply stream: a high surrogate is held until its pair', (() => {
    const f = new ReplyStreamFilter()
    const a = f.push('{"reply":"x\\ud83d')
    const b = f.push('\\ude00y"}')
    return a === 'x' && b === '😀y'
  })())
}

// ── A real run streams the reply, one reply per model call ────────────────
{
  const cwd = path.join(root, 'stream-run')
  fs.mkdirSync(cwd, { recursive: true })
  const FINAL = '{"reply":"已生成：25岁亚洲女性全身写真，米白色连衣裙、自然光公园场景。\\n\\nmedia/images/asian-woman-full-body.png","done":true,"actions":[],"tasks":[{"id":"1","content":"生成图片","status":"completed"}],"claims":[],"plan":[]}'
  const scripts: Record<string, string[]> = {
    envelope: [
      '{"reply":"好的，马上生成。","done":false,"actions":[{"type":"write_file","path":"media/images/asian-woman-full-body.png","content":"png"}],"tasks":[{"id":"1","content":"生成图片","status":"in_progress"}],"claims":[],"plan":[]}',
      FINAL,
    ],
    xml: ['<toolcall name="write_file">{"path":"x.md","content":"hi"}</toolcall>', '{"reply":"写好了 x.md。","done":true,"actions":[]}'],
    plain: ['这是普通文本回答。\n\n第二段。'],
  }
  const run = async (name: string) => {
    let call = 0
    const script = scripts[name]!
    const provider = {
      async complete(): Promise<ProviderResponse> {
        throw new Error('streamed only')
      },
      async completeStream(_messages: unknown, onChunk: (delta: string) => void): Promise<ProviderResponse> {
        const text = script[Math.min(call, script.length - 1)]!
        call += 1
        // Cut at 3 characters, the way provider deltas arrive mid-token.
        for (let i = 0; i < text.length; i += 3) onChunk(text.slice(i, i + 3))
        return { text, raw: null, streamed: true, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      },
    } as unknown as ChatProvider
    const store = new SessionStore(cwd)
    const session = store.createSession({ title: `stream ${name}` })
    await store.save(session)
    const c = collector()
    const result = await runAgent(session, '生成一张图', {
      cwd, provider, sessionStore: store, permissionManager: new PermissionManager('accept-all', false), maxTurns: 4, profile: 'main', onInfo: c.onInfo,
    })
    // What a host shows: text deltas, cleared at each reset.
    let shown = ''
    const seenTexts: string[] = []
    for (const e of c.events) {
      if (e.type === 'text_reset') shown = ''
      if (e.type === 'text_delta') {
        shown += String(e.text)
        seenTexts.push(shown)
      }
    }
    // The stderr lines a host without the stream reads, rebuilt the same way.
    let fromLines = ''
    for (const line of c.lines) {
      if (line.startsWith('[stream-reset] profile=main')) fromLines = ''
      const m = /^\[stream-chunk\] profile=main turn=\d+ delta=(".*")$/.exec(line)
      if (m) fromLines += JSON.parse(m[1]!) as string
    }
    return { result, events: c.events, shown, seenTexts, fromLines }
  }

  const envelope = await run('envelope')
  assert('run: the image run finished with the parsed reply', envelope.result.reply.startsWith('已生成：'), envelope.result.reply)
  assert('run: the tool-call turn still ran its action', fs.existsSync(path.join(cwd, 'media/images/asian-woman-full-body.png')))
  assert('run: no streamed text ever showed the envelope or its fields', envelope.seenTexts.every((t) => !/[{}"]|"reply"|actions|tasks|claims|plan|done/.test(t)), JSON.stringify(envelope.seenTexts.find((t) => /[{}"]/.test(t))))
  assert('run: the progress note streamed, then a reset before the final reply', envelope.events.some((e) => e.type === 'text_delta' && String(e.text).includes('好的')) && envelope.events.filter((e) => e.type === 'text_reset').length === 1)
  assert('run: the text streamed since the last reset is the final reply (no jump)', envelope.shown === envelope.result.reply, JSON.stringify(envelope.shown))
  const resultEvent = envelope.events.find((e) => e.type === 'result')
  assert('run: stderr stream lines rebuild the same text', envelope.fromLines === envelope.result.reply && resultEvent === undefined, JSON.stringify(envelope.fromLines))

  const xml = await run('xml')
  assert('run: a tool-call-markup turn shows nothing and still runs its call', fs.existsSync(path.join(cwd, 'x.md')) && xml.events.filter((e) => e.type === 'text_reset').length === 0, JSON.stringify(xml.events.filter((e) => e.type === 'text_delta')))
  assert('run: after a markup-only turn, the streamed text is the reply', xml.shown === xml.result.reply && xml.result.reply === '写好了 x.md。', JSON.stringify(xml.shown))

  const plain = await run('plain')
  assert('run: a plain-text answer streams unchanged and equals the reply', plain.shown === plain.result.reply && plain.result.reply === '这是普通文本回答。\n\n第二段。', JSON.stringify(plain.shown))
}

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
