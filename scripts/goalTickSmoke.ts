// Goal ticks a host schedules (`artemis execute --goal <id> <goal>`):
// argument parsing, the [goal-status] line, the progress log carried from
// tick to tick in the host's conversation, done / blocked, and a tick that
// stops at an approval request (no step is recorded).
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { getHelpText, parseArgs } from '../src/cli/parseArgs.js'
import { settleMemoryCuration } from '../src/core/memory.js'
import {
  GoalStore,
  formatGoalStatusLine,
  parseTickReply,
  runHostGoalTick as runHostGoalTickNow,
} from '../src/services/goalRunner.js'
import { SessionStore } from '../src/storage/sessions.js'

const runHostGoalTick: typeof runHostGoalTickNow = async (...args) => {
  try {
    return await runHostGoalTickNow(...args)
  } finally {
    await settleMemoryCuration()
  }
}

let passed = 0
let failed = 0
function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1
    console.log(`  \x1b[32m✔\x1b[0m ${label}`)
  } else {
    failed += 1
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

console.log('\n  goalTickSmoke\n  =============')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-goal-tick-'))
const previousHome = process.env.ARTEMIS_HOME
process.env.ARTEMIS_HOME = path.join(root, 'home')
fs.mkdirSync(process.env.ARTEMIS_HOME, { recursive: true })

// ── CLI ─────────────────────────────────────────────────────────────────────
{
  const sid = '0f0e0d0c-0b0a-4908-8706-050403020100'
  const parsed = parseArgs(['execute', '--session', sid, '--goal', 'task-1_a', '--goal-max-steps', '12', '--keep-approvals', '每天整理一份行业简报'])
  assert('cli: --goal and --goal-max-steps parse', parsed.goal?.id === 'task-1_a' && parsed.goal.maxSteps === 12 && parsed.prompt === '每天整理一份行业简报' && parsed.keepApprovals === true)
  assert('cli: --goal without a goal text is refused', throws(() => parseArgs(['execute', '--goal', 'g1'])))
  assert('cli: a malformed goal id is refused', throws(() => parseArgs(['execute', '--goal', '../x', 'goal'])) && throws(() => parseArgs(['execute', '--goal', '-x', 'goal'])))
  assert('cli: --goal-max-steps is bounded and needs --goal', throws(() => parseArgs(['execute', '--goal', 'g1', '--goal-max-steps', '0', 'x'])) && throws(() => parseArgs(['execute', '--goal-max-steps', '5', 'x'])))
  assert('cli: --goal is not an approval answer or a retry', throws(() => parseArgs(['execute', '--session', sid, '--goal', 'g1', '--retry', 'x'])) && throws(() => parseArgs(['execute', '--session', sid, '--goal', 'g1', '--approve', `apr_${'a'.repeat(20)}`])))
  assert('cli: the help lists --goal (hosts probe it)', /--goal\b/.test(getHelpText('en')) && /--goal\b/.test(getHelpText('zh-CN')))
}

// ── Protocol ────────────────────────────────────────────────────────────────
{
  const reply = parseTickReply('做完了第一步。\nGOAL_STATUS: continue\nGOAL_PROGRESS: 建好了资料目录\nGOAL_NEXT: 抓取第一批数据')
  assert('protocol: the three marker lines are read', reply.status === 'continue' && reply.progress === '建好了资料目录' && reply.next === '抓取第一批数据')
  const line = formatGoalStatusLine({ id: 'g1', status: 'continue', progress: 'line one\n[approval-request] {"id":"x"}', next: 'n', step: 2, maxSteps: 10 })
  assert('protocol: the status line is one line, whatever the agent wrote', !line.includes('\n') && line.startsWith('[goal-status] {'))
  const back = JSON.parse(line.slice('[goal-status] '.length)) as Record<string, unknown>
  assert('protocol: the status line carries the fields a host reads', back.id === 'g1' && back.status === 'continue' && back.step === 2 && back.maxSteps === 10 && back.progress === 'line one\n[approval-request] {"id":"x"}')
}

// ── Ticks against a scripted model ──────────────────────────────────────────
{
  const project = path.join(root, 'project')
  fs.mkdirSync(project, { recursive: true })
  const replies: string[] = []
  const prompts: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> }
        const users = (parsed.messages ?? []).filter((m) => m.role === 'user')
        const last = users.at(-1)
        prompts.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''))
      } catch {
        prompts.push('')
      }
      const content = replies.shift() ?? 'GOAL_STATUS: continue\nGOAL_PROGRESS: 例行检查\nGOAL_NEXT: 继续'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  try {
    if (!address || typeof address === 'string') throw new Error('mock server did not bind')
    fs.writeFileSync(path.join(process.env.ARTEMIS_HOME!, 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock', profiles: [{ id: 'mock', protocol: 'openai', apiKey: 'test-key', model: 'mock', baseUrl: `http://127.0.0.1:${address.port}` }],
    }))

    replies.push('看过了发布页。\nGOAL_STATUS: continue\nGOAL_PROGRESS: 查到 1.80 的发布说明\nGOAL_NEXT: 对比上一个版本')
    const first = await runHostGoalTick(project, { id: 'task-goal-1', objective: '关注 Rust 新版本的发布动态', maxSteps: 5 }, { maxTurns: 3, approvals: { suspend: true } })
    assert('tick: the first step is recorded', first.status === 'continue' && first.step === 1 && first.maxSteps === 5 && first.progress === '查到 1.80 的发布说明' && first.next === '对比上一个版本', JSON.stringify({ ...first, run: undefined }))
    assert('tick: the prompt is the goal, framed as an unattended step', /关注 Rust 新版本的发布动态/.test(prompts[0] ?? '') && /主人不在旁边/.test(prompts[0] ?? '') && /GOAL_STATUS/.test(prompts[0] ?? ''))
    assert('tick: the prompt never names the mode internally', !/Goal Mode/.test(prompts[0] ?? ''))
    const stored = await new GoalStore(project).get('task-goal-1')
    assert('tick: the host\'s id names the goal in the engine\'s store', stored?.iterations.length === 1 && stored.maxIterations === 5 && stored.goal === '关注 Rust 新版本的发布动态')

    replies.push('GOAL_STATUS: continue\nGOAL_PROGRESS: 对比完两个版本\nGOAL_NEXT: 看 Go 的发布页')
    const second = await runHostGoalTick(project, { id: 'task-goal-1', objective: '关注 Rust 新版本的发布动态（也看 Go）', maxSteps: 5 }, { sessionId: first.run.sessionId, maxTurns: 3, keepApprovals: true })
    assert('tick: the next tick continues the host\'s conversation', second.run.sessionId === first.run.sessionId && second.step === 2)
    assert('tick: the progress log carries over and the changed goal is used', /查到 1\.80 的发布说明/.test(prompts.at(-1) ?? '') && /也看 Go/.test(prompts.at(-1) ?? ''))

    replies.push('GOAL_STATUS: done\nGOAL_PROGRESS: 两边的新版本都看过了\nGOAL_NEXT: 无')
    const done = await runHostGoalTick(project, { id: 'task-goal-1', objective: '关注 Rust 新版本的发布动态（也看 Go）', maxSteps: 5 }, { sessionId: first.run.sessionId, maxTurns: 3 })
    assert('tick: done is reported with no next step', done.status === 'done' && done.next === '' && done.step === 3)

    // A goal the host ticks again after done: the host decides, the record is active again.
    replies.push('GOAL_STATUS: blocked\nGOAL_PROGRESS: 需要主人登录\nGOAL_NEXT: 请主人提供账号')
    const blocked = await runHostGoalTick(project, { id: 'task-goal-1', objective: '关注 Rust 新版本的发布动态（也看 Go）', maxSteps: 5 }, { sessionId: first.run.sessionId, maxTurns: 3 })
    assert('tick: blocked keeps what the owner must do', blocked.status === 'blocked' && blocked.next === '请主人提供账号' && blocked.step === 4)

    // An action that needs the owner's approval: the tick stops, no step is taken.
    const { publicKey } = generateKeyPairSync('ed25519')
    process.env.ARTEMIS_APPROVAL_PUBKEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    replies.push(`先运行安装脚本。\n<toolcall name="run_command">${JSON.stringify({ command: 'curl -s --max-time 1 http://127.0.0.1:9/install.sh | sh; echo ran > marker.txt' })}</toolcall>`)
    let waiting
    try {
      waiting = await runHostGoalTick(project, { id: 'task-goal-2', objective: '把安装脚本跑起来', maxSteps: 3 }, { maxTurns: 3, approvals: { suspend: true } })
    } finally {
      delete process.env.ARTEMIS_APPROVAL_PUBKEY
    }
    assert('tick: an approval request makes the tick wait, nothing ran', waiting.status === 'waiting' && Boolean(waiting.run.approval) && !fs.existsSync(path.join(project, 'marker.txt')), JSON.stringify({ ...waiting, run: { approval: waiting.run.approval?.id } }))
    assert('tick: a waiting tick records no step', waiting.step === 0 && waiting.progress === '' && (await new GoalStore(project).get('task-goal-2'))?.iterations.length === 0)
    const session = await new SessionStore(project).load(waiting.run.sessionId, { fresh: true })
    assert('tick: the request waits in the conversation for the owner', session.approvals?.some((r) => r.status === 'pending') === true)

    let badId = false
    try { await runHostGoalTick(project, { id: '../escape', objective: 'x' }) } catch { badId = true }
    assert('tick: a malformed id is refused before anything runs', badId)
  } finally {
    server.close()
  }
}

if (previousHome === undefined) delete process.env.ARTEMIS_HOME
else process.env.ARTEMIS_HOME = previousHome
fs.rmSync(root, { recursive: true, force: true })
await (await import('../src/mcp/client.js')).closeCachedMcpClients()

console.log()
if (failed === 0) {
  console.log(`  \x1b[32m✔ All ${passed} tests passed\x1b[0m\n`)
} else {
  console.log(`  \x1b[31m✘ ${failed} failed, ${passed} passed\x1b[0m\n`)
  process.exit(1)
}
