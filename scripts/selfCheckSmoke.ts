#!/usr/bin/env tsx
/**
 * scripts/selfCheckSmoke.ts — "verify before done" (core/selfCheck.ts)
 *
 * The gating table (chat, code edit with and without a check after it, a
 * failing check, image generation with a fake vision provider, video
 * metadata, Saga, sub-agents, the disabled flag), the bounds (one fix turn,
 * at most two extra model calls, the wall-time cap), honesty corrections,
 * and both engine paths: runAgent with a fake provider and think() against
 * a mock OpenAI-compatible server — including that the self-check note
 * travels in the unsaved runtime context and the system prompt stays the
 * same (prompt cache).
 *
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/selfCheckSmoke.ts
 */

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  checkMediaMetadata,
  checkUnavailableReason,
  chooseCheckCommand,
  createProviderImageJudge,
  gateSelfCheck,
  loadSelfCheckSettings,
  parseMediaExpectations,
  readImageSize,
  SELF_CHECK_VISION_SYSTEM,
  SelfCheckRun,
  SelfCheckTracker,
  type ImageJudge,
  type SelfCheckHost,
  type SelfCheckSettings,
} from '../src/core/selfCheck.js'
import { replyClaimsSuccess } from '../src/core/skillVerification.js'
import { runAgent as runAgentNow } from '../src/core/agent.js'
import { settleMemoryCuration } from '../src/core/memory.js'
import { applyProviderOverrides, getMessages, resetSession, think } from '../src/brain.js'
import { PermissionManager } from '../src/security/permissions.js'
import { ProviderStore } from '../src/providers/store.js'
import { SessionStore } from '../src/storage/sessions.js'
import { resolveDataRootDir } from '../src/utils/fs.js'
import type { ChatProvider, ProviderResponse } from '../src/providers/types.js'
import type { SessionMessage } from '../src/core/types.js'

let passed = 0
let failed = 0
function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  \x1b[32m✔\x1b[0m ${label}`)
  } else {
    failed++
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}

console.log('\n  selfCheckSmoke')
console.log('  ==============')

const runAgent: typeof runAgentNow = async (...args) => {
  try {
    return await runAgentNow(...args)
  } finally {
    await settleMemoryCuration()
  }
}

const originalEnv = {
  ARTEMIS_HOME: process.env.ARTEMIS_HOME,
  ARTEMIS_SELF_CHECK: process.env.ARTEMIS_SELF_CHECK,
  ARTEMIS_SKILL_LEARNING: process.env.ARTEMIS_SKILL_LEARNING,
}
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-self-check-smoke-'))
let caseCounter = 0

const SUM_TEST = "const test = require('node:test'); const assert = require('node:assert'); const sum = require('../sum.js'); test('sum', () => assert.strictEqual(sum(2, 3), 5))\n"
const SUM_BUGGY = 'module.exports = (a, b) => a - b\n'
const SUM_FIXED = 'module.exports = (a, b) => a + b\n'

/** Fresh ARTEMIS_HOME + workspace with a real `npm test` (node --test over test/). */
function freshCase(label: string, withTests = true): { home: string; cwd: string } {
  caseCounter++
  const home = path.join(sandbox, `home-${caseCounter}-${label}`)
  const cwd = path.join(sandbox, `ws-${caseCounter}-${label}`)
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  if (withTests) {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: `case-${caseCounter}`, scripts: { test: 'node --test' } }))
    fs.mkdirSync(path.join(cwd, 'test'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'test', 'sum.test.js'), SUM_TEST)
  }
  process.env.ARTEMIS_HOME = home
  delete process.env.ARTEMIS_SELF_CHECK
  // Keep the skill curator out of these runs.
  process.env.ARTEMIS_SKILL_LEARNING = '0'
  return { home, cwd }
}

const SETTINGS: SelfCheckSettings = { enabled: true, maxWallMs: 240_000, commandTimeoutMs: 180_000, maxModelCalls: 2 }

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  buf.writeUInt32BE(0x89504e47, 0)
  buf.writeUInt32BE(0x0d0a1a0a, 4)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/** A host whose commands answer from a script; records what ran and the progress lines. */
function fakeHost(
  answers: Array<{ ok: boolean; output: string; errorCode?: string }>,
  extra: Partial<SelfCheckHost> = {},
): SelfCheckHost & { ran: string[]; progressLines: string[] } {
  const ran: string[] = []
  const progressLines: string[] = []
  const host: SelfCheckHost = {
    runCommand: async (command) => {
      ran.push(command)
      return answers.shift() ?? { ok: true, output: `command: ${command}\nexit_code: 0\n` }
    },
    progress: (message) => { progressLines.push(message) },
    ...extra,
  }
  return Object.assign(host, { ran, progressLines })
}

function cmdOutput(command: string, exit: number, body = ''): string {
  return `command: ${command}\nexit_code: ${exit}\nstdout:\n${body}`
}

async function main(): Promise<void> {
  // ── helpers: reply claims, unavailable checks, expectations, headers ────
  {
    assert('claims: "Done — all tests pass." claims success', replyClaimsSuccess('Done — all tests pass.'))
    assert('claims: "已完成，测试通过" claims success', replyClaimsSuccess('已完成，测试通过'))
    assert('claims: "Not done yet, 2 tests are failing" is no claim', !replyClaimsSuccess('Not done yet, 2 tests are failing'))
    assert('claims: "未完成" is no claim', !replyClaimsSuccess('还未完成，需要你确认'))
    assert('claims: a plain answer is no claim', !replyClaimsSuccess('The function takes two numbers.'))
    assert('unavailable: exit 127 means the tool is missing', checkUnavailableReason('pytest', false, cmdOutput('pytest', 127)) === 'tool missing')
    assert('unavailable: "sh: 1: jest: not found" means the tool is missing', checkUnavailableReason('npm test', false, cmdOutput('npm test', 1, 'sh: 1: jest: not found')) === 'tool missing')
    assert('unavailable: a permission denial is no failing check', checkUnavailableReason('npm test', false, 'Permission denied: ask', 'tool_permission_denied') === 'not permitted')
    assert('unavailable: a killed timeout is no failing check', checkUnavailableReason('npm test', false, 'Command timed out after 180000ms and was killed (killOnTimeout).') === 'timed out')
    assert('unavailable: a real failure is a verdict', checkUnavailableReason('npm test', false, cmdOutput('npm test', 1, 'not ok 1 - sum')) === undefined)
    const e1 = parseMediaExpectations('画一张 16:9 的海报，写着“开业大吉”')
    assert('expectations: 16:9 is read from the request', e1.ratio?.w === 16 && e1.ratio.h === 9)
    const e2 = parseMediaExpectations('Make a 10s vertical video with background music')
    assert('expectations: duration, orientation and sound', e2.durationSec === 10 && e2.orientation === 'portrait' && e2.wantsAudio === true, JSON.stringify(e2))
    assert('expectations: two ratios are ambiguous (none kept)', parseMediaExpectations('a 16:9 banner and a 1:1 avatar').ratio === undefined)
    assert('expectations: "1990s style" is no duration', parseMediaExpectations('a 1990s style clip').durationSec === undefined && parseMediaExpectations('80s retro video').durationSec === undefined)
    assert('header: PNG size is read', JSON.stringify(readImageSize(pngHeader(1920, 1080))) === JSON.stringify({ width: 1920, height: 1080 }))
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x03, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0, 0])
    assert('header: JPEG SOF size is read', JSON.stringify(readImageSize(jpeg)) === JSON.stringify({ width: 768, height: 512 }))
    const probeProblems = checkMediaMetadata('video', { durationSec: 5, width: 1080, height: 1920, hasVideo: true, hasAudio: false }, e2, 'en')
    assert('video metadata: wrong duration and missing audio are reported; portrait fits', probeProblems.length === 2 && probeProblems.some((p) => p.includes('5.0 s')) && probeProblems.some((p) => p.includes('audio')), JSON.stringify(probeProblems))
  }

  // ── settings ─────────────────────────────────────────────────────────────
  {
    const { cwd } = freshCase('settings', false)
    assert('settings: on by default with the documented bounds', JSON.stringify(await loadSelfCheckSettings(cwd)) === JSON.stringify({ enabled: true, maxWallMs: 240_000, commandTimeoutMs: 180_000, maxModelCalls: 2 }))
    process.env.ARTEMIS_SELF_CHECK = '0'
    assert('settings: ARTEMIS_SELF_CHECK=0 turns it off', !(await loadSelfCheckSettings(cwd)).enabled)
    delete process.env.ARTEMIS_SELF_CHECK
    const store = new ProviderStore(cwd)
    const data = await store.load()
    data.setup = { ...data.setup!, selfCheck: { enabled: false, maxModelCalls: 5 } }
    await store.save(data)
    const reloaded = await new ProviderStore(cwd).load()
    assert('settings: setup.selfCheck survives a providers.json round trip', reloaded.setup?.selfCheck?.enabled === false)
    const fromSetup = await loadSelfCheckSettings(cwd)
    assert('settings: setup.selfCheck.enabled=false turns it off; maxModelCalls is capped at 2', !fromSetup.enabled && fromSetup.maxModelCalls === 2)
  }

  // ── choosing the check ──────────────────────────────────────────────────
  {
    const { cwd } = freshCase('choose')
    const sum = path.join(cwd, 'sum.js')
    assert('choose: a code edit in a project with a real test script runs `npm test`', (await chooseCheckCommand(cwd, [sum])) === 'npm test')
    assert('choose: docs-only changes need no check', (await chooseCheckCommand(cwd, [path.join(cwd, 'README.md')])) === undefined)
    fs.mkdirSync(path.join(cwd, 'app'))
    fs.writeFileSync(path.join(cwd, 'app', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    fs.mkdirSync(path.join(cwd, 'app', 'test'))
    fs.writeFileSync(path.join(cwd, 'app', 'test', 'a.test.js'), 'require("node:test")("a", () => {})\n')
    assert('choose: a nested project runs its own check from its directory', (await chooseCheckCommand(cwd, [path.join(cwd, 'app', 'index.js')])) === 'cd app && npm test')
    fs.writeFileSync(path.join(cwd, 'app', 'package.json'), JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { jest: '29' } }))
    assert('choose: declared but uninstalled dependencies → no check (never installs)', (await chooseCheckCommand(cwd, [path.join(cwd, 'app', 'index.js')])) === undefined)
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'run_command', ok: true, command: 'node --test test/sum.test.js', output: cmdOutput('node --test test/sum.test.js', 0) })
    assert('choose: the check the run itself used is re-used', (await chooseCheckCommand(cwd, [sum], tracker.steps)) === 'node --test test/sum.test.js')
    const noProject = freshCase('no-project', false)
    assert('choose: no project manifest → no check', (await chooseCheckCommand(noProject.cwd, [path.join(noProject.cwd, 'x.js')])) === undefined)
  }

  // ── gating table (controller, fake host) ────────────────────────────────
  {
    const { cwd } = freshCase('gate')
    const run = (tracker: SelfCheckTracker, extra: Partial<ConstructorParameters<typeof SelfCheckRun>[0]> = {}) =>
      new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'Add sum() in sum.js', language: 'en', ...extra })

    // chat / Q&A: nothing recorded
    {
      const tracker = new SelfCheckTracker(cwd)
      const host = fakeHost([])
      const decision = await run(tracker).review('Paris is the capital of France.', host)
      assert('gate: chat → no check, reply unchanged, nothing run, no progress line',
        decision.kind === 'finish' && decision.reply === 'Paris is the capital of France.' && decision.outcome === 'skipped' && host.ran.length === 0 && host.progressLines.length === 0)
    }
    // read-only analysis
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'read_file', ok: true, args: { path: 'sum.js' } })
      tracker.record({ tool: 'search_files', ok: true, args: { pattern: 'sum' } })
      assert('gate: read-only analysis → no check', !gateSelfCheck(tracker).eligible)
    }
    // code edit without a check → runs the test once; passes → reply unchanged
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      const host = fakeHost([{ ok: true, output: cmdOutput('npm test', 0, '# pass 1') }])
      const check = run(tracker)
      const decision = await check.review('Added sum() in sum.js.', host)
      assert('gate: code edit without a test → runs `npm test` once (no model call)',
        host.ran.length === 1 && host.ran[0] === 'npm test' && check.modelCalls === 0, JSON.stringify(host.ran))
      assert('gate: a passing check leaves the reply as it is', decision.kind === 'finish' && decision.reply === 'Added sum() in sum.js.' && decision.outcome === 'passed')
      assert('gate: one short progress line', host.progressLines.length === 1 && host.progressLines[0] === 'Self-check…', JSON.stringify(host.progressLines))
    }
    // code edit with a passing check after it → nothing extra
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      tracker.record({ tool: 'run_command', ok: true, command: 'npm test', output: cmdOutput('npm test', 0) })
      const host = fakeHost([])
      const decision = await run(tracker).review('Added sum(); npm test passes.', host)
      assert('gate: code edit with a passing test after the last edit → no extra run',
        decision.kind === 'finish' && decision.outcome === 'skipped' && host.ran.length === 0 && host.progressLines.length === 0)
    }
    // a passing check BEFORE the last edit does not count
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'run_command', ok: true, command: 'npm test', output: cmdOutput('npm test', 0) })
      tracker.record({ tool: 'replace_in_file', ok: true, args: { path: 'sum.js', find: 'a', replace: 'b' } })
      assert('gate: a check before the last edit does not count', gateSelfCheck(tracker).code === 'unchecked')
    }
    // docs-only edit
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'README.md', content: '# x' } })
      assert('gate: docs-only edit → no check', !gateSelfCheck(tracker).eligible)
    }
    // Saga
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
      tracker.record({ tool: 'generate_long_video', ok: true, output: 'Generated /tmp/x.mp4' })
      const host = fakeHost([])
      const decision = await run(tracker).review('Your long video is ready.', host)
      assert('gate: a Saga run is never self-checked', decision.kind === 'finish' && decision.outcome === 'skipped' && host.ran.length === 0)
    }
    // disabled
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
      const host = fakeHost([])
      const decision = await run(tracker, { settings: { ...SETTINGS, enabled: false } }).review('Done.', host)
      assert('gate: disabled → no check', decision.kind === 'finish' && decision.outcome === 'skipped' && host.ran.length === 0)
    }
    // check tool missing → no fix turn, nothing claimed
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      const host = fakeHost([{ ok: false, output: cmdOutput('npm test', 127, 'sh: 1: node: not found') }])
      const decision = await run(tracker).review('Added sum().', host)
      assert('gate: a check that cannot run is not a failure (no fix turn, reply unchanged)',
        decision.kind === 'finish' && decision.reply === 'Added sum().' && decision.outcome === 'unverified')
    }
  }

  // ── failing check: one fix turn, one re-run, one final reply ───────────
  {
    const { cwd } = freshCase('fix')
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    const host = fakeHost([
      { ok: false, output: cmdOutput('npm test', 1, 'not ok 1 - sum\n  AssertionError: expected 5, got -1') },
      { ok: true, output: cmdOutput('npm test', 0, '# pass 1') },
    ])
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'Add sum()', language: 'en' })
    const first = await check.review('Done: added sum() in sum.js.', host)
    assert('fix: a failing check asks for ONE fix turn with tools and the failure excerpt',
      first.kind === 'turn' && first.tools && first.note.includes('FAILED') && first.note.includes('AssertionError') && first.note.includes('ONE turn'),
      JSON.stringify(first).slice(0, 400))
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
    const second = await check.afterTurn('Fixed the operator.', host)
    assert('fix: after the fix the check re-runs once, then one no-tool final turn',
      host.ran.length === 2 && second.kind === 'turn' && !second.tools && second.note.includes('PASSES'), JSON.stringify(second).slice(0, 300))
    const done = await check.afterTurn('Added sum() in sum.js. The self-check caught a wrong operator and fixed it; npm test passes.', host)
    assert('fix: the final reply is used as is when it mentions the fix',
      done.kind === 'finish' && done.outcome === 'fixed' && !done.reply.includes('\n\nSelf-check:'), JSON.stringify(done))
    assert('bounds: exactly two extra model calls, two command runs', check.modelCalls === 2 && host.ran.length === 2)
    const again = await check.review('x', host)
    assert('bounds: one self-check pass per run', again.kind === 'finish' && host.ran.length === 2)
  }

  // ── still failing after the fix: honest final reply ─────────────────────
  {
    const { cwd } = freshCase('still')
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    const failing = { ok: false, output: cmdOutput('npm test', 1, 'not ok 1 - sum\nAssertionError: expected 5') }
    const host = fakeHost([failing, failing])
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'Add sum()', language: 'en' })
    await check.review('Done.', host)
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    const final = await check.afterTurn('Tried a fix.', host)
    assert('still failing: the final turn is told it still fails and not to claim success',
      final.kind === 'turn' && !final.tools && final.note.includes('still FAILS') && final.note.includes('Do not claim success'))
    const done = await check.afterTurn('All done, everything works and all tests pass!', host)
    assert('still failing: an overclaiming final reply gets a short honest line (no third call)',
      done.kind === 'finish' && done.outcome === 'still-failing' && done.reply.includes('Self-check: `npm test` fails (exit 1)') && check.modelCalls === 2,
      JSON.stringify(done))
  }

  // ── the agent's own failing check, honestly reported → left alone ──────
  {
    const { cwd } = freshCase('admit')
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    tracker.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1') })
    const host = fakeHost([])
    const reply = 'I changed sum.js, but 1 test is still failing: the API contract is unclear. Which behaviour do you want?'
    const decision = await new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'x', language: 'en' }).review(reply, host)
    assert('admit: a failure the reply already reports gets no fix turn and no extra line',
      decision.kind === 'finish' && decision.reply === reply && host.ran.length === 0)
  }

  // ── honesty: claims success, evidence says otherwise ───────────────────
  {
    const { cwd } = freshCase('honesty')
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - sum') })
    const host = fakeHost([])
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'run the tests', language: 'en' })
    const first = await check.review('All tests pass. Done!', host)
    assert('honesty: a success claim against a failing check asks for one no-tool correction',
      first.kind === 'turn' && !first.tools && first.note.includes('claims the task succeeded') && host.ran.length === 0)
    const done = await check.afterTurn('`npm test` fails: test "sum" is failing (exit 1).', host)
    assert('honesty: the corrected reply is used without an extra line', done.kind === 'finish' && done.outcome === 'corrected' && !done.reply.includes('Self-check:'), JSON.stringify(done))

    const zero = new SelfCheckTracker(cwd)
    zero.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - sum') })
    const noCalls = await new SelfCheckRun({ settings: { ...SETTINGS, maxModelCalls: 0 }, tracker: zero, userRequest: 'x', language: 'zh' }).review('已完成，测试通过。', fakeHost([]))
    assert('honesty: with no model call left, a short line corrects the claim (in the user\'s language)',
      noCalls.kind === 'finish' && noCalls.reply.startsWith('已完成，测试通过。') && noCalls.reply.includes('自检：`npm test` 未通过'), JSON.stringify(noCalls))
  }

  // ── bounds: wall time ───────────────────────────────────────────────────
  {
    const { cwd } = freshCase('wall')
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    let clock = 0
    const host = fakeHost([{ ok: false, output: cmdOutput('npm test', 1, 'not ok 1') }])
    // The command "takes" the whole budget.
    const slowHost: SelfCheckHost = { ...host, runCommand: async (command, timeoutMs) => { clock += 240_000; return host.runCommand(command, timeoutMs) } }
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'x', language: 'en', now: () => clock })
    const decision = await check.review('Added sum().', slowHost)
    assert('bounds: past the wall-time cap no fix turn starts; the failure is reported',
      decision.kind === 'finish' && check.modelCalls === 0 && decision.reply.includes('Self-check: `npm test` fails'), JSON.stringify(decision))
    let timeoutSeen = 0
    const tracker2 = new SelfCheckTracker(cwd)
    tracker2.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
    await new SelfCheckRun({ settings: { ...SETTINGS, commandTimeoutMs: 30_000 }, tracker: tracker2, userRequest: 'x', language: 'en' })
      .review('ok', { runCommand: async (_c, timeoutMs) => { timeoutSeen = timeoutMs; return { ok: true, output: cmdOutput('npm test', 0) } } })
    assert('bounds: the check command gets the configured time cap', timeoutSeen === 30_000, String(timeoutSeen))
  }

  // ── images: fake vision provider ────────────────────────────────────────
  {
    const { cwd } = freshCase('image', false)
    const img = path.join(cwd, 'poster.png')
    fs.writeFileSync(img, Buffer.concat([pngHeader(1024, 1024), Buffer.alloc(64)]))
    const visionRequests: SessionMessage[][] = []
    let verdict = { matches: false, confident: true, problems: ['the text reads "OPEN SALE" instead of "GRAND OPENING"'] }
    const visionProvider: ChatProvider = {
      supportsImages: true,
      async complete(messages, options): Promise<ProviderResponse> {
        visionRequests.push(messages)
        const imageCount = options?.imageAttachments?.length ?? 0
        return { text: imageCount > 0 ? JSON.stringify(verdict) : '{}', raw: null }
      },
    }
    const judge: ImageJudge = createProviderImageJudge(visionProvider)
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'generate_image', ok: true, args: { prompt: 'poster' }, output: `Generated 1 image(s) via mock:\n  [1] ${img}` })
    const host = fakeHost([], { getImageJudge: async () => judge })
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'A square poster that says "GRAND OPENING"', language: 'en' })
    const first = await check.review('Here is your poster: poster.png', host)
    assert('image: the vision judge sees the image and the request once',
      visionRequests.length === 1 && visionRequests[0]![0]!.content === SELF_CHECK_VISION_SYSTEM && visionRequests[0]![1]!.content.includes('GRAND OPENING'))
    assert('image: a clear mismatch asks for ONE regeneration turn with tools',
      first.kind === 'turn' && first.tools && first.note.includes('GRAND OPENING') && first.note.includes('final reply shown to the user'), JSON.stringify(first).slice(0, 300))
    tracker.record({ tool: 'generate_image', ok: true, args: { prompt: 'poster GRAND OPENING' }, output: `Generated 1 image(s) via mock:\n  [1] ${img}` })
    const done = await check.afterTurn('Regenerated the poster with the correct text: poster.png', host)
    assert('image: after the regeneration the reply says so briefly; two calls in all (judge + regeneration)',
      done.kind === 'finish' && done.outcome === 'fixed' && done.reply.includes('regenerated it') && check.modelCalls === 2 && visionRequests.length === 1, JSON.stringify(done))

    verdict = { matches: true, confident: true, problems: [] }
    const ok = new SelfCheckTracker(cwd)
    ok.record({ tool: 'generate_image', ok: true, output: `Generated 1 image(s) via mock:\n  [1] ${img}` })
    const okRun = new SelfCheckRun({ settings: SETTINGS, tracker: ok, userRequest: 'A square poster', language: 'en' })
    const okDecision = await okRun.review('Here is your poster.', fakeHost([], { getImageJudge: async () => judge }))
    assert('image: a matching image keeps the reply; one call', okDecision.kind === 'finish' && okDecision.reply === 'Here is your poster.' && okRun.modelCalls === 1)

    const wide = path.join(cwd, 'wide.png')
    fs.writeFileSync(wide, Buffer.concat([pngHeader(1920, 1080), Buffer.alloc(64)]))
    const shape = new SelfCheckTracker(cwd)
    shape.record({ tool: 'generate_image', ok: true, output: `Generated 1 image(s):\n  [1] ${wide}` })
    const before = visionRequests.length
    const shapeRun = new SelfCheckRun({ settings: SETTINGS, tracker: shape, userRequest: '生成一张 9:16 竖版壁纸', language: 'zh' })
    const shapeDecision = await shapeRun.review('壁纸已生成。', fakeHost([], { getImageJudge: async () => judge }))
    assert('image: a wrong aspect ratio is caught from the file header without a vision call',
      shapeDecision.kind === 'turn' && shapeDecision.note.includes('9:16') && visionRequests.length === before && shapeRun.modelCalls === 1, JSON.stringify(shapeDecision).slice(0, 300))

    const noVision = new SelfCheckTracker(cwd)
    noVision.record({ tool: 'generate_image', ok: true, output: `Generated 1 image(s):\n  [1] ${img}` })
    const nv = await new SelfCheckRun({ settings: SETTINGS, tracker: noVision, userRequest: 'A square poster', language: 'en' })
      .review('Here it is.', fakeHost([], { getImageJudge: async () => undefined }))
    assert('image: without a vision-capable model nothing is judged', nv.kind === 'finish' && nv.reply === 'Here it is.')
  }

  // ── video: metadata only ────────────────────────────────────────────────
  {
    const { cwd } = freshCase('video', false)
    const clip = path.join(cwd, 'clip.mp4')
    fs.writeFileSync(clip, 'x')
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'generate_video', ok: true, output: `Saved video: ${clip}` })
    let probes = 0
    const host = fakeHost([], { probeMedia: async () => { probes++; return { durationSec: 5, width: 1280, height: 720, hasVideo: true, hasAudio: true } } })
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: '做一个 10 秒的横版视频', language: 'zh' })
    const decision = await check.review('视频已生成：clip.mp4', host)
    assert('video: metadata mismatch is reported in one short line, never regenerated (no model call)',
      decision.kind === 'finish' && probes === 1 && decision.reply.includes('自检：clip.mp4: 时长 5.0 秒，要求的是 10 秒') && check.modelCalls === 0, JSON.stringify(decision))
  }

  // ── runAgent: fix turn end to end, cache stability, opt-in, sub-agents ──
  {
    const { cwd } = freshCase('run-agent')
    const store = new SessionStore(cwd)
    const requests: SessionMessage[][] = []
    let phase = 0
    const envelope = (body: Record<string, unknown>): ProviderResponse => ({ text: JSON.stringify(body), raw: null })
    const provider: ChatProvider = {
      async complete(messages): Promise<ProviderResponse> {
        requests.push(messages)
        const last = messages.at(-1)?.content ?? ''
        if (last.includes('[Self-check before done')) {
          return envelope({ reply: 'Fixing the operator in sum.js.', done: false, actions: [{ type: 'write_file', path: 'sum.js', content: SUM_FIXED }] })
        }
        if (last.includes('[Self-check result')) {
          return envelope({ reply: 'Added sum(a, b) in sum.js. The self-check caught a wrong operator and fixed it; npm test passes.', done: true })
        }
        phase++
        if (phase === 1) return envelope({ reply: 'Writing sum.js.', done: false, actions: [{ type: 'write_file', path: 'sum.js', content: SUM_BUGGY }] })
        return envelope({ reply: 'Done: added sum(a, b) in sum.js.', done: true })
      },
    }
    const options = {
      cwd,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 6,
      profile: 'main' as const,
      selfCheck: true,
    }
    const session = store.createSession({ title: 'self-check A' })
    await store.save(session)
    const result = await runAgent(session, 'Add a sum(a, b) function in sum.js', options)
    assert('runAgent: the failing test led to one fix turn and a passing re-run',
      fs.readFileSync(path.join(cwd, 'sum.js'), 'utf8') === SUM_FIXED && result.reply.includes('self-check caught'), JSON.stringify(result))
    const fixIndex = requests.findIndex((messages) => messages.at(-1)?.content.includes('[Self-check before done'))
    assert('runAgent: two extra model calls (fix + final), no more', fixIndex > 0 && requests.length === fixIndex + 2, `${fixIndex}/${requests.length}`)
    const systems = new Set(requests.map((messages) => messages[0]?.content))
    assert('runAgent: the system prompt is identical in every request (cache prefix stable)', systems.size === 1 && ![...systems][0]!.includes('Self-check'))
    const fixRequest = requests[fixIndex]!
    assert('runAgent: the self-check note is the unsaved runtime context at the end of the request',
      fixRequest.at(-1)?.name === 'runtime_context' && fixRequest.at(-1)!.content.includes('[Self-check before done') && fixRequest.at(-1)!.content.includes('not ok'))
    assert('runAgent: the history prefix of the fix request is the previous request\'s history (append-only)',
      JSON.stringify(requests[fixIndex - 1]!.slice(0, -1).map((m) => m.id)) === JSON.stringify(fixRequest.slice(0, requests[fixIndex - 1]!.length - 1).map((m) => m.id)))
    const stored = await store.load(session.id)
    assert('runAgent: the note is never stored; the check runs are normal tool turns',
      !stored.messages.some((m) => m.content.includes('[Self-check')) &&
      stored.messages.filter((m) => m.role === 'tool' && m.content.includes('npm test')).length === 2,
      JSON.stringify(stored.messages.map((m) => [m.role, m.name, m.content.slice(0, 60)])))
    assert('runAgent: the stored final reply is the corrected one', stored.messages.filter((m) => m.role === 'assistant').at(-1)?.content === result.reply)

    // chat: nothing extra
    requests.length = 0
    const chatProvider: ChatProvider = { async complete(messages) { requests.push(messages); return envelope({ reply: 'Paris.', done: true }) } }
    const chat = await runAgent(store.createSession({ title: 'chat' }), 'What is the capital of France?', { ...options, provider: chatProvider })
    assert('runAgent: chat → one request, no check', chat.reply === 'Paris.' && requests.length === 1)

    // opt-in only; sub-agents and the disabled flag never check
    const buggyOnce = (): ChatProvider => {
      let n = 0
      return {
        async complete(messages) {
          requests.push(messages)
          n++
          return n === 1
            ? envelope({ reply: 'Writing.', done: false, actions: [{ type: 'write_file', path: 'sum.js', content: SUM_BUGGY }] })
            : envelope({ reply: 'Done.', done: true })
        },
      }
    }
    const countChecks = async (opts: Record<string, unknown>): Promise<{ checks: number; requests: number }> => {
      requests.length = 0
      const s = store.createSession({ title: 'opt' })
      await runAgent(s, 'Add sum() in sum.js', { ...options, provider: buggyOnce(), ...opts })
      const saved = await store.load(s.id)
      return { checks: saved.messages.filter((m) => m.role === 'tool' && m.content.includes('npm test')).length, requests: requests.length }
    }
    const baseline = await countChecks({ selfCheck: undefined })
    assert('runAgent: without selfCheck (callers that do not opt in) → no check', baseline.checks === 0)
    const withCheck = await countChecks({})
    assert('runAgent: the same run with selfCheck → the check runs (and fails: buggy sum)', withCheck.checks >= 1 && withCheck.requests <= baseline.requests + 2, JSON.stringify({ baseline, withCheck }))
    const sub = await countChecks({ delegationDepth: 1 })
    assert('runAgent: a sub-agent (delegationDepth 1) → no check', sub.checks === 0 && sub.requests === baseline.requests)
    assert('runAgent: a worker profile → no check', (await countChecks({ profile: 'worker' })).checks === 0)
    process.env.ARTEMIS_SELF_CHECK = '0'
    const off = await countChecks({})
    assert('runAgent: ARTEMIS_SELF_CHECK=0 → no check', off.checks === 0 && off.requests === baseline.requests)
    delete process.env.ARTEMIS_SELF_CHECK
    {
      requests.length = 0
      const s = store.createSession({ title: 'saga' })
      await runAgent(s, '[Artemis Saga long video workflow]\nAdd sum() in sum.js', { ...options, provider: buggyOnce() })
      const saved = await store.load(s.id)
      assert('runAgent: a Saga-marked request → no check', saved.messages.filter((m) => m.role === 'tool' && m.content.includes('npm test')).length === 0)
    }
  }

  // ── think(): fix turn end to end (mock OpenAI-compatible server) ────────
  {
    const { cwd } = freshCase('think')
    const originalCwd = process.cwd()
    const bodies: Array<Record<string, any>> = []
    let round = 0
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>
        res.writeHead(200, { 'content-type': 'application/json' })
        const reply = (content: string, toolCalls?: unknown[]) => res.end(JSON.stringify({
          model: 'mock',
          choices: [{ message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }))
        const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>
        const systemText = messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
        if (!Array.isArray(body.tools) && !systemText.includes('Artemis')) {
          // Background helpers (memory curation, summaries): answer neutrally.
          reply('{}')
          return
        }
        bodies.push(body)
        const lastText = JSON.stringify(messages.at(-1)?.content ?? '')
        const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
        if (lastText.includes('[Self-check before done')) {
          reply('', [call('f1', 'write_file', { path: 'sum.js', content: SUM_FIXED })])
          return
        }
        if (lastText.includes('[Self-check result')) {
          reply('Added sum() in sum.js. The self-check caught a wrong operator and fixed it; npm test passes now.')
          return
        }
        round++
        if (round === 1) reply('', [call('c1', 'write_file', { path: 'sum.js', content: SUM_BUGGY })])
        else reply('Done: added sum() in sum.js, all tests pass.')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const dataRoot = resolveDataRootDir(cwd)
    fs.mkdirSync(dataRoot, { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-self-check',
      profiles: [{ id: 'mock-self-check', label: 'Mock', protocol: 'openai', apiKey: 'test-key', model: 'mock', baseUrl: `http://127.0.0.1:${port}` }],
    }, null, 2))
    try {
      process.chdir(cwd)
      resetSession()
      applyProviderOverrides({})
      const deltas: string[] = []
      const progress: string[] = []
      const toolCalls: string[] = []
      const result = await think('Add a sum(a, b) function in sum.js', (delta) => deltas.push(delta), {
        cwd,
        permissionMode: 'accept-all',
        selfCheck: true,
        onSelfCheck: (message) => progress.push(message),
        onToolCall: (name, args) => toolCalls.push(`${name}:${String((args as { command?: string }).command ?? (args as { path?: string }).path ?? '')}`),
      })
      assert('think: the failing test led to one fix turn; the file is fixed',
        fs.readFileSync(path.join(cwd, 'sum.js'), 'utf8') === SUM_FIXED && result.reply.includes('self-check caught'), JSON.stringify({ reply: result.reply, toolCalls }))
      assert('think: the check ran twice as normal tool calls (tool events), with one progress line',
        toolCalls.filter((entry) => entry === 'run_command:npm test').length === 2 && progress.length === 1, JSON.stringify({ toolCalls, progress }))
      assert('think: four model requests (two extra)', bodies.length === 4, String(bodies.length))
      assert('think: the overclaiming first reply is never shown; only the final one is',
        !deltas.join('').includes('all tests pass') && deltas.join('').includes('self-check caught'), JSON.stringify(deltas))
      const systemOf = (body: Record<string, any>) => JSON.stringify((body.messages as Array<{ role: string }>).filter((m) => m.role === 'system'))
      assert('think: the system messages are identical in every request (cache prefix stable)', new Set(bodies.map(systemOf)).size === 1)
      assert('think: the tool list is identical in every request (cache prefix stable)', new Set(bodies.map((b) => JSON.stringify(b.tools))).size === 1)
      assert('think: the self-check note is never stored in the conversation',
        !getMessages().some((m: SessionMessage) => String(m.content).includes('[Self-check')))
      const stored = getMessages() as SessionMessage[]
      assert('think: the stored conversation ends with the final reply', stored.at(-1)?.role === 'assistant' && String(stored.at(-1)?.content).includes('self-check caught'))

      // Plain question: no check, one request.
      const before = bodies.length
      round = 99
      const answer = await think('What does sum.js export?', () => undefined, { cwd, permissionMode: 'accept-all', selfCheck: true })
      assert('think: a turn without changes → no check, one request', bodies.length === before + 1 && answer.reply.length > 0)
    } finally {
      process.chdir(originalCwd)
      resetSession()
      applyProviderOverrides({})
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

let crashed = false
try {
  await main()
} catch (error) {
  crashed = true
  console.error(error)
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
}

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0 || crashed) process.exit(1)
