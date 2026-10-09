#!/usr/bin/env tsx
/**
 * scripts/selfCheckSmoke.ts — "verify before done" (core/selfCheck.ts)
 *
 * Safety first: the self-check never runs a command the agent did not run
 * itself (an untrusted repo's test script stays untouched), honours "don't
 * run anything", re-runs the agent's own check from where it ran without
 * moving the run's working directory, and enforces the fix turn's tool
 * policy (no installs, sub-agents or video; a call and round cap) and its
 * wall-time cap in code.
 *
 * Also: the gating table (chat, read-only runs, source vs data/config
 * edits, a check after the last edit, Saga, sub-agents, the disabled
 * flag), the fix flow (one fix turn, one re-run, one final turn), pre-
 * existing and environment failures, honesty (explicit check claims only;
 * a disclosed failure is no overclaim), explicit-only image/video
 * expectations with a fake vision provider, and both engine paths end to
 * end: runAgent with a fake provider, think() against mock OpenAI-
 * compatible (JSON and SSE) and Anthropic messages servers — the system
 * prompt and tool list stay identical (prompt cache), the self-check note
 * is never stored, and a no-tool turn never leaves a tool_use behind.
 *
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/selfCheckSmoke.ts
 */

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  checkMediaMetadata,
  checkShape,
  checkUnavailableReason,
  createProviderImageJudge,
  gateSelfCheck,
  loadSelfCheckSettings,
  normalizeCheckCommand,
  parseMediaExpectations,
  readImageSize,
  requestForbidsCommands,
  isReadOnlyInspection,
  failureSignature,
  parseBareCheck,
  SELF_CHECK_VISION_SYSTEM,
  SelfCheckFixPolicy,
  SelfCheckRun,
  SelfCheckTracker,
  selfCheckRunCommand,
  suggestCheckCommand,
  type ImageJudge,
  type SelfCheckHost,
  type SelfCheckSettings,
} from '../src/core/selfCheck.js'
import { replyClaimsChecksPass, replyDisclosesProblem } from '../src/core/skillVerification.js'
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
  ARTEMIS_SELF_CHECK_MAX_MS: process.env.ARTEMIS_SELF_CHECK_MAX_MS,
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
  delete process.env.ARTEMIS_SELF_CHECK_MAX_MS
  // Keep the skill curator out of these runs.
  process.env.ARTEMIS_SKILL_LEARNING = '0'
  return { home, cwd }
}

/** A monorepo: the root has no test script; packages/foo has `npm test` over its own test/. */
function monorepoCase(label: string): { cwd: string; pkg: string } {
  const { cwd } = freshCase(label, false)
  const pkg = path.join(cwd, 'packages', 'foo')
  fs.mkdirSync(path.join(pkg, 'test'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }))
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'foo', scripts: { test: 'node --test' } }))
  fs.writeFileSync(path.join(pkg, 'test', 'sum.test.js'), SUM_TEST)
  return { cwd, pkg }
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

function cmdOutput(command: string, exit: number, body = ''): string {
  return `command: ${command}\nexit_code: ${exit}\nstdout:\n${body}`
}

type Answer = { ok: boolean; exit: number; body?: string; errorCode?: string }
/** A host whose commands answer from a script (the header names the command really run); records what ran, where, and the progress lines. */
function fakeHost(
  answers: Answer[],
  extra: Partial<SelfCheckHost> = {},
): SelfCheckHost & { ran: string[]; cwds: Array<string | undefined>; progressLines: string[] } {
  const ran: string[] = []
  const cwds: Array<string | undefined> = []
  const progressLines: string[] = []
  const host: SelfCheckHost = {
    runCommand: async (command, _timeoutMs, cwd) => {
      ran.push(command)
      cwds.push(cwd)
      const answer = answers.shift() ?? { ok: true, exit: 0 }
      return { ok: answer.ok, output: cmdOutput(command, answer.exit, answer.body ?? ''), ...(answer.errorCode ? { errorCode: answer.errorCode } : {}) }
    },
    progress: (message) => { progressLines.push(message) },
    ...extra,
  }
  return Object.assign(host, { ran, cwds, progressLines })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  // ── helpers: claims, disclosure, unavailable checks, commands, expectations ─
  {
    assert('claims: "Done — all tests pass." claims checks passed', replyClaimsChecksPass('Done — all tests pass.'))
    assert('claims: "已完成，测试全部通过" claims checks passed', replyClaimsChecksPass('已完成，测试全部通过'))
    assert('claims: "Done." / "works as follows" / "Changes applied." / "Let me know when you are ready to review." are no check claims',
      ['Done.', 'The function works as follows: ...', 'Changes applied.', 'Let me know when you are ready to review.', '已完成部分修改，但测试还没跑。'].every((reply) => !replyClaimsChecksPass(reply)))
    for (const reply of ['Implemented it. npm test has 1 failing test (test_legacy) that was already failing before my change.', 'All tests pass except one that still fails.', '测试未通过，原因见下。', '还没跑测试。', 'There is a pre-existing failure in test_b.', 'The tests were not run.']) {
      assert(`disclosure: ${JSON.stringify(reply)} discloses a problem (no overclaim)`, replyDisclosesProblem(reply) && !replyClaimsChecksPass(reply))
    }
    assert('disclosure: "Fixed the failing test; all tests pass" is a claim, not a disclosure', replyClaimsChecksPass('Fixed the failing test; all tests pass.'))
    assert('unavailable: exit 127 means the tool is missing', checkUnavailableReason('pytest', false, cmdOutput('pytest', 127)) === 'tool missing')
    assert('unavailable: "sh: 1: jest: not found" means the tool is missing', checkUnavailableReason('npm test', false, cmdOutput('npm test', 1, 'sh: 1: jest: not found')) === 'tool missing')
    assert('unavailable: a permission denial is no failing check', checkUnavailableReason('npm test', false, 'Permission denied: ask', 'tool_permission_denied') === 'not permitted')
    assert('unavailable: a killed timeout is no failing check', checkUnavailableReason('npm test', false, 'Command timed out after 180000ms and was killed (killOnTimeout).') === 'timed out')
    assert('unavailable: pytest collection errors from a missing module are the environment',
      checkUnavailableReason('pytest', false, cmdOutput('pytest', 2, "E   ModuleNotFoundError: No module named 'requests'\n!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!")) === 'environment')
    assert('unavailable: a cargo download failure is the environment',
      checkUnavailableReason('cargo test', false, cmdOutput('cargo test', 101, '    Updating crates.io index\nerror: failed to download from `https://index.crates.io/...`')) === 'environment')
    assert('unavailable: a missing npm package is the environment',
      checkUnavailableReason('npm test', false, cmdOutput('npm test', 1, "Error: Cannot find module 'vitest'")) === 'environment')
    assert('unavailable: a real failure is a verdict', checkUnavailableReason('npm test', false, cmdOutput('npm test', 1, 'not ok 1 - sum')) === undefined)
    assert('normalize: output pipes are removed', normalizeCheckCommand('npm test 2>&1 | tail -30') === 'npm test' && normalizeCheckCommand('pytest -q | head -n 50') === 'pytest -q')
    assert('run as: CI=true on the runner, after its cd', selfCheckRunCommand({ runner: 'npm test' }) === 'CI=true npm test' && selfCheckRunCommand({ dir: 'app', runner: 'npm test' }) === 'cd app && CI=true npm test')
    for (const request of ['Only edit the file; this repo is untrusted, so execute nothing.', "Fix it but don't run anything", 'Fix it but don\u2019t run anything', 'No need to run the tests, just fix the typo.', 'Fix the typo and skip the tests.', '改一下，不要运行任何命令', '改个错别字，不用跑测试', '别跑测试，直接改', '改一下配置，别动 CI']) {
      assert(`no-run request honoured: ${JSON.stringify(request)}`, requestForbidsCommands(request))
    }
    assert('no-run: a normal request is not a no-run request', !requestForbidsCommands('Fix the parser and run the tests'))
    assert('signature: failing test names, else the first error line',
      failureSignature('not ok 1 - adds\nok 2 - b\nnot ok 3 - subtracts') === 'adds\nsubtracts' && failureSignature('FAILED tests/test_a.py::test_x - assert 1 == 2') === 'tests/test_a.py::test_x' && failureSignature('src/a.ts(3,1): error TS2304: Cannot find name') === 'src/a.ts(3,1): error TS2304: Cannot find name')

    const e1 = parseMediaExpectations('画一张 16:9 的海报，写着“开业大吉”')
    assert('expectations: an explicit 16:9 is read', e1.ratio?.w === 16 && e1.ratio.h === 9)
    const e2 = parseMediaExpectations('Make a 10 second video in portrait orientation with background music')
    assert('expectations: explicit duration, orientation and sound', e2.durationSec === 10 && (e2.ratio?.w === 9 || e2.orientation === 'portrait') && e2.wantsAudio === true, JSON.stringify(e2))
    for (const request of ['Paint a portrait of my grandmother', 'A landscape painting of misty mountains', 'Times Square at night, neon', 'A medieval town square', 'Draw a cat with vertical stripes', '生成一张图：比分 3:2 的足球海报', '生成一张图：比分 1:1 的海报']) {
      const expect = parseMediaExpectations(request)
      assert(`expectations: ${JSON.stringify(request)} names no frame format`, !expect.ratio && !expect.orientation && checkShape(1024, 1024, expect, 'en').length === 0, JSON.stringify(expect))
    }
    assert('expectations: "a 60s rock band" is no duration; "1990s style" neither', parseMediaExpectations('Make a video of a 60s rock band').durationSec === undefined && parseMediaExpectations('a 1990s style clip').durationSec === undefined)
    assert('expectations: "music festival" is no request for sound; "十分精彩" no duration',
      parseMediaExpectations('a short video of a music festival crowd').wantsAudio === undefined && parseMediaExpectations('一个十分精彩的音乐节视频').durationSec === undefined && parseMediaExpectations('一个十分精彩的音乐节视频').wantsAudio === undefined)
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

  // ── which command may run: only the agent's own ─────────────────────────
  {
    const { cwd } = freshCase('commands')
    assert('N2: the agent\'s piped `npm test 2>&1 | tail -30` is a bare check `npm test`', parseBareCheck('npm test 2>&1 | tail -30', cwd)?.command === 'npm test')
    fs.mkdirSync(path.join(cwd, 'app', 'test'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'app', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    fs.writeFileSync(path.join(cwd, 'app', 'test', 'a.test.js'), "require('node:test')('a', () => {})\n")
    const inApp = parseBareCheck('cd app && npm test | head -50', cwd)
    assert('N2: `cd <dir> && npm test` is a bare check with its directory', inApp?.dir === 'app' && inApp.runner === 'npm test' && inApp.fingerprint.length === 16, JSON.stringify(inApp))
    for (const command of [
      'npm install && npm test', 'npm run dev', 'npx vitest', 'jest --watch', 'npm test && git push', 'npm test && touch PUSHED', 'npm test; echo done',
      'npm test || true', '(npm test)', 'FOO=1 npm test', 'CI=false npm test', 'npm test > out.txt', 'npm test | tee log.txt', 'jest -u', 'npx jest --updateSnapshot',
      'eslint --fix .', 'prettier --write .', 'npm test -- --update-snapshots', 'sudo npm test', 'npm run lint', 'cd app && npm test && cd ..', 'npm test $(echo x)',
    ]) {
      assert(`N2: not a bare check: ${command}`, parseBareCheck(command, cwd) === undefined)
    }
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'jest --watch', lint: 'eslint --fix .' } }))
    assert('N2: scripts that watch or fix are not re-run', parseBareCheck('npm test', cwd) === undefined && parseBareCheck('npm run lint', cwd) === undefined)
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    fs.writeFileSync(path.join(cwd, 'Makefile'), 'test:\n\tnode --test\n\npush:\n\tgit push\n')
    assert('N2: a make target is fingerprinted by its recipe; a missing target is refused',
      (parseBareCheck('make test', cwd)?.fingerprint.length ?? 0) === 16 && parseBareCheck('make check', cwd) === undefined)
    assert('suggest (text only): the project\'s check is named for the reply', (await suggestCheckCommand(cwd, [path.join(cwd, 'sum.js')])) === 'npm test')
    assert('suggest: data/config-only changes name nothing', (await suggestCheckCommand(cwd, [path.join(cwd, 'config.yaml')])) === undefined)
  }

  // ── gating table (controller, fake host) ────────────────────────────────
  {
    const { cwd } = freshCase('gate')
    const run = (tracker: SelfCheckTracker, extra: Partial<ConstructorParameters<typeof SelfCheckRun>[0]> = {}) =>
      new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'Add sum() in sum.js', language: 'en', ...extra })

    {
      const tracker = new SelfCheckTracker(cwd)
      const host = fakeHost([])
      const decision = await run(tracker).review('Paris is the capital of France.', host)
      assert('gate: chat → no check, reply unchanged, nothing run, no progress line',
        decision.kind === 'finish' && decision.reply === 'Paris is the capital of France.' && decision.outcome === 'skipped' && host.ran.length === 0 && host.progressLines.length === 0)
    }
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'read_file', ok: true, args: { path: 'sum.js' } })
      tracker.record({ tool: 'search_files', ok: true, args: { pattern: 'sum' } })
      assert('gate: read-only analysis → no check', !gateSelfCheck(tracker).eligible)
    }
    for (const file of ['results.json', 'config.yaml', 'package-lock.json', '.env', 'notes', 'src/README.md', 'data.csv']) {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: file, content: 'x' } })
      assert(`gate: writing ${file} (not a source file) → no check`, !gateSelfCheck(tracker).eligible)
    }
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      const host = fakeHost([])
      const decision = await run(tracker).review('Added sum() in sum.js.', host)
      assert('B1: code edit, the agent never ran a check → NO command runs, reply unchanged',
        decision.kind === 'finish' && decision.reply === 'Added sum() in sum.js.' && host.ran.length === 0 && host.progressLines.length === 0, JSON.stringify(decision))
    }
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      const host = fakeHost([])
      const decision = await run(tracker).review('Added sum() in sum.js; all tests pass.', host)
      assert('B1: an unverified "all tests pass" gets a no-tool correction naming the check as text; nothing runs',
        decision.kind === 'turn' && !decision.tools && decision.note.includes('no test or check was run') && decision.note.includes('`npm test`') && host.ran.length === 0, JSON.stringify(decision).slice(0, 400))
    }
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      tracker.record({ tool: 'run_command', ok: true, command: 'npm test', output: cmdOutput('npm test', 0) })
      const host = fakeHost([])
      const decision = await run(tracker).review('Added sum(); npm test passes.', host)
      assert('gate: code edit with a passing test after the last edit → no extra run',
        decision.kind === 'finish' && decision.outcome === 'skipped' && host.ran.length === 0 && host.progressLines.length === 0)
    }
    {
      const sub = path.join(cwd, 'sub')
      fs.mkdirSync(sub, { recursive: true })
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      tracker.record({ tool: 'run_command', ok: true, command: 'npm test 2>&1 | tail -30', output: cmdOutput('npm test 2>&1 | tail -30', 0, '# pass 1') })
      tracker.record({ tool: 'replace_in_file', ok: true, args: { path: 'sum.js', find: 'a', replace: 'b' } })
      const host = fakeHost([{ ok: true, exit: 0, body: '# pass 1' }])
      const check = run(tracker)
      const decision = await check.review('Added sum() in sum.js.', host)
      assert('B1: the agent\'s own piped check before the last edit is re-run once, pipe removed, with CI=true, from where it ran',
        host.ran.length === 1 && host.ran[0] === 'CI=true npm test' && host.cwds[0] === cwd && decision.kind === 'finish' && decision.outcome === 'passed' && check.modelCalls === 0,
        JSON.stringify({ ran: host.ran, cwds: host.cwds, decision }))
      assert('gate: one short progress line', host.progressLines.length === 1 && host.progressLines[0] === 'Self-check…', JSON.stringify(host.progressLines))
    }
    {
      // The script changed after the agent ran it: its fingerprint no longer matches.
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'run_command', ok: true, command: 'npm test', output: cmdOutput('npm test', 0) })
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test && echo changed' } }))
      const host = fakeHost([])
      await run(tracker).review('Added sum().', host)
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'gate', scripts: { test: 'node --test' } }))
      assert('N2: a check whose script changed since the agent ran it is not re-run', host.ran.length === 0, JSON.stringify(host.ran))
    }
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'run_command', ok: true, command: 'npm test && touch PUSHED', output: cmdOutput('npm test && touch PUSHED', 0) })
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      const host = fakeHost([])
      await run(tracker).review('Added sum().', host)
      assert('N2: a compound the agent ran (`npm test && touch PUSHED`) is never re-run', host.ran.length === 0, JSON.stringify(host.ran))
    }
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'run_command', ok: true, command: 'npm test', output: cmdOutput('npm test', 0) })
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      const host = fakeHost([])
      const decision = await run(tracker, { userRequest: 'Change sum.js. This repo is untrusted: execute nothing.' }).review('Changed sum.js.', host)
      assert('B1: "execute nothing" in the request → no command, even the agent\'s own', host.ran.length === 0 && decision.kind === 'finish' && decision.reply === 'Changed sum.js.')
    }
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
      tracker.record({ tool: 'generate_long_video', ok: true, output: 'Generated /tmp/x.mp4' })
      const host = fakeHost([])
      const decision = await run(tracker).review('Your long video is ready.', host)
      assert('gate: a Saga run is never self-checked', decision.kind === 'finish' && decision.outcome === 'skipped' && host.ran.length === 0)
    }
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'run_command', ok: true, command: 'npm test', output: cmdOutput('npm test', 0) })
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
      const host = fakeHost([])
      const decision = await run(tracker, { settings: { ...SETTINGS, enabled: false } }).review('Done.', host)
      assert('gate: disabled → no check', decision.kind === 'finish' && decision.outcome === 'skipped' && host.ran.length === 0)
    }
    for (const [label, answer] of [
      ['a missing tool', { ok: false, exit: 127, body: 'sh: 1: node: not found' }],
      ['a missing dependency', { ok: false, exit: 1, body: "Error: Cannot find module 'vitest'" }],
      ['a network failure', { ok: false, exit: 1, body: 'npm error getaddrinfo ENOTFOUND registry.npmjs.org' }],
    ] as Array<[string, Answer]>) {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'run_command', ok: true, command: 'npm test', output: cmdOutput('npm test', 0) })
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
      const check = run(tracker)
      const decision = await check.review('Added sum().', fakeHost([answer]))
      assert(`I3: ${label} is "unverified": no fix turn, reply unchanged`, decision.kind === 'finish' && decision.reply === 'Added sum().' && decision.outcome === 'unverified' && check.modelCalls === 0)
    }
    {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - sum') })
      const host = fakeHost([])
      const quiet = await run(tracker, { userRequest: 'run the tests' }).review('I ran npm test; here is the output.', host)
      assert('read-only: a run that only ran a failing test gets no self-check line', quiet.kind === 'finish' && quiet.reply === 'I ran npm test; here is the output.' && host.ran.length === 0)
      const tracker2 = new SelfCheckTracker(cwd)
      tracker2.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - sum') })
      const loud = await run(tracker2, { userRequest: 'run the tests' }).review('All tests pass. Done!', host)
      assert('read-only: an explicit "all tests pass" against that failure gets one no-tool correction', loud.kind === 'turn' && !loud.tools && loud.note.includes('claims that checks passed'))
    }
  }

  // ── a re-run finds a failure: one fix turn, one re-run, one final reply ─
  {
    const { cwd } = freshCase('fix')
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'run_command', ok: true, command: 'npm test', output: cmdOutput('npm test', 0, '# pass 1') })
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    const host = fakeHost([
      { ok: false, exit: 1, body: 'not ok 1 - sum\n  AssertionError: expected 5, got -1' },
      { ok: true, exit: 0, body: '# pass 1' },
    ])
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'Refactor sum()', language: 'en' })
    const first = await check.review('Done: refactored sum() in sum.js.', host)
    assert('fix: a failing re-run asks for ONE fix turn with tools and the failure excerpt',
      first.kind === 'turn' && first.tools && first.note.includes('FAILED') && first.note.includes('AssertionError') && first.note.includes('ONE turn') && /do not install/i.test(first.note),
      JSON.stringify(first).slice(0, 400))
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
    const second = await check.afterTurn('Fixed the operator.', host)
    assert('fix: after the fix the check re-runs once, then one no-tool final turn',
      host.ran.length === 2 && second.kind === 'turn' && !second.tools && second.note.includes('PASSES'), JSON.stringify(second).slice(0, 300))
    const done = await check.afterTurn('Refactored sum() in sum.js. The self-check caught a wrong operator and fixed it; npm test passes.', host)
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
    tracker.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - sum\nAssertionError: expected 5') })
    const host = fakeHost([{ ok: false, exit: 1, body: 'not ok 1 - sum\nAssertionError: expected 5' }])
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'Add sum()', language: 'en' })
    const first = await check.review('Done.', host)
    assert('fix: the agent\'s own failing check after its last edit, not disclosed → one fix turn', first.kind === 'turn' && first.tools)
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    const final = await check.afterTurn('Tried a fix.', host)
    assert('still failing: the final turn is told it still fails and not to claim success',
      final.kind === 'turn' && !final.tools && final.note.includes('still FAILS') && final.note.includes('Do not claim success'))
    const done = await check.afterTurn('All done, everything works and all tests pass!', host)
    assert('still failing: an overclaiming final reply gets a short honest line (no third call)',
      done.kind === 'finish' && done.outcome === 'still-failing' && done.reply.includes('Self-check: `npm test` fails (exit 1)') && check.modelCalls === 2,
      JSON.stringify(done))
  }

  // ── disclosed and pre-existing failures are left alone ─────────────────
  {
    const { cwd } = freshCase('disclosed')
    // Reviewer probe zz_h: a failure the reply already discloses.
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'parser.js', content: 'x' } })
    tracker.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - test_legacy\n# fail 1') })
    const reply = 'Implemented the parser. Note: npm test has 1 failing test (test_legacy) that was already failing before my change.'
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'implement the parser', language: 'en' })
    const host = fakeHost([])
    const decision = await check.review(reply, host)
    assert('I2: a failure the reply discloses gets no fix turn, no correction and no extra line',
      decision.kind === 'finish' && decision.reply === reply && check.modelCalls === 0 && host.ran.length === 0, JSON.stringify(decision).slice(0, 300))

    const pre = new SelfCheckTracker(cwd)
    pre.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - legacy') })
    pre.record({ tool: 'write_file', ok: true, args: { path: 'parser.js', content: 'x' } })
    pre.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - legacy') })
    const preCheck = new SelfCheckRun({ settings: SETTINGS, tracker: pre, userRequest: 'implement the parser', language: 'en' })
    const preDecision = await preCheck.review('Implemented the parser.', fakeHost([]))
    assert('I2: a check that already failed before the first edit (pre-existing) gets no fix turn, only a line saying so',
      preDecision.kind === 'finish' && preCheck.modelCalls === 0 && preDecision.reply.includes('already failed before the changes'), JSON.stringify(preDecision))
  }

  // ── N3: TDD — "make the failing test pass" still gets the fix turn ─────
  {
    const { cwd } = freshCase('tdd')
    const tdd = new SelfCheckTracker(cwd)
    const failing = cmdOutput('npm test', 1, `not ok 1 - sum adds\n  at ${path.join(cwd, 'test', 'sum.test.js')}:1:1`)
    tdd.record({ tool: 'run_command', ok: false, command: 'npm test', output: failing })
    tdd.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    tdd.record({ tool: 'run_command', ok: false, command: 'npm test', output: failing })
    const tddDecision = await new SelfCheckRun({ settings: SETTINGS, tracker: tdd, userRequest: 'Make the failing sum test pass', language: 'en' }).review('Done.', fakeHost([]))
    assert('N3: same failing test before and after, but the agent edited the file the test exercises → fix turn',
      tddDecision.kind === 'turn' && tddDecision.tools, JSON.stringify(tddDecision).slice(0, 200))
    const changed = new SelfCheckTracker(cwd)
    changed.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - legacy') })
    changed.record({ tool: 'write_file', ok: true, args: { path: 'parser.js', content: 'x' } })
    changed.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - legacy\nnot ok 2 - parses') })
    const changedDecision = await new SelfCheckRun({ settings: SETTINGS, tracker: changed, userRequest: 'implement the parser', language: 'en' }).review('Implemented the parser.', fakeHost([]))
    assert('N3: a different failure after the edit (a new failing test) → fix turn', changedDecision.kind === 'turn' && changedDecision.tools)
  }

  // ── N4: a pass claim against a failing check is always corrected ───────
  {
    const { cwd } = freshCase('n4')
    for (const reply of ['Fixed 3 errors in the parser; all tests pass.', '已修复 bug，还修复了一个报错，测试全部通过。', 'Done, all tests pass (one was failing before, now fixed).']) {
      const tracker = new SelfCheckTracker(cwd)
      tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
      tracker.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - sum') })
      const decision = await new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'x', language: 'en' }).review(reply, fakeHost([]))
      assert(`N4: ${JSON.stringify(reply)} against a failing check → fix turn`, decision.kind === 'turn' && decision.tools)
      const zero = new SelfCheckTracker(cwd)
      zero.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
      zero.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - sum') })
      const line = await new SelfCheckRun({ settings: { ...SETTINGS, maxModelCalls: 0 }, tracker: zero, userRequest: 'x', language: 'en' }).review(reply, fakeHost([]))
      assert(`N4: ${JSON.stringify(reply)} with no call left → the self-check line`, line.kind === 'finish' && /Self-check: `npm test` fails/.test(line.reply), JSON.stringify(line))
    }
    assert('N4: "Fixed 3 errors" / "修复了一个报错" are no disclosure; "still fails", "N failing", "未通过", "还在报错", "没跑" are',
      !replyDisclosesProblem('Fixed 3 errors in the parser.') && !replyDisclosesProblem('修复了一个报错。') &&
      ['It still fails on Windows.', '2 tests failing.', '测试未通过。', '还在报错。', '我没跑测试。'].every(replyDisclosesProblem))
  }

  // ── honesty ─────────────────────────────────────────────────────────────
  {
    const { cwd } = freshCase('honesty')
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    tracker.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - sum') })
    const check = new SelfCheckRun({ settings: { ...SETTINGS, maxModelCalls: 1 }, tracker, userRequest: 'x', language: 'en' })
    const host = fakeHost([])
    const first = await check.review('All tests pass. Done!', host)
    assert('honesty: the one model call goes to the fix turn; its overclaiming answer gets a short line', first.kind === 'turn' && first.tools)
    const done = await check.afterTurn('Everything is fine, all tests pass.', host)
    assert('honesty: past the budget a short line corrects the claim', done.kind === 'finish' && done.reply.includes('Self-check: `npm test` fails'), JSON.stringify(done))

    const zero = new SelfCheckTracker(cwd)
    zero.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    zero.record({ tool: 'run_command', ok: false, command: 'npm test', output: cmdOutput('npm test', 1, 'not ok 1 - sum') })
    const noCalls = await new SelfCheckRun({ settings: { ...SETTINGS, maxModelCalls: 0 }, tracker: zero, userRequest: 'x', language: 'zh' }).review('已完成，测试全部通过。', fakeHost([]))
    assert('honesty: with no model call left, a short line in the user\'s language corrects the claim',
      noCalls.kind === 'finish' && noCalls.reply.startsWith('已完成，测试全部通过。') && noCalls.reply.includes('自检：`npm test` 未通过'), JSON.stringify(noCalls))
  }

  // ── bounds: wall time, command cap, fix-turn policy, abort signal ───────
  {
    const { cwd } = freshCase('wall')
    const tracker = new SelfCheckTracker(cwd)
    tracker.record({ tool: 'run_command', ok: true, command: 'npm test', output: cmdOutput('npm test', 0) })
    tracker.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_BUGGY } })
    let clock = 0
    const inner = fakeHost([{ ok: false, exit: 1, body: 'not ok 1' }])
    const slowHost: SelfCheckHost = { ...inner, runCommand: async (command, timeoutMs, cwd2) => { clock += 240_000; return inner.runCommand(command, timeoutMs, cwd2) } }
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'x', language: 'en', now: () => clock })
    const decision = await check.review('Added sum().', slowHost)
    assert('bounds: past the wall-time cap no fix turn starts; the failure is reported',
      decision.kind === 'finish' && check.modelCalls === 0 && decision.reply.includes('Self-check: `npm test` fails'), JSON.stringify(decision))
    let timeoutSeen = 0
    const tracker2 = new SelfCheckTracker(cwd)
    tracker2.record({ tool: 'run_command', ok: true, command: 'npm test', output: cmdOutput('npm test', 0) })
    tracker2.record({ tool: 'write_file', ok: true, args: { path: 'sum.js', content: SUM_FIXED } })
    await new SelfCheckRun({ settings: { ...SETTINGS, commandTimeoutMs: 30_000 }, tracker: tracker2, userRequest: 'x', language: 'en' })
      .review('ok', { runCommand: async (command, timeoutMs) => { timeoutSeen = timeoutMs; return { ok: true, output: cmdOutput(command, 0) } } })
    assert('bounds: the check command gets the configured time cap', timeoutSeen === 30_000, String(timeoutSeen))

    const policy = new SelfCheckFixPolicy(false, () => 60_000, parseBareCheck('npm test', cwd))
    const install = { command: 'npm install left-pad && npm test' }
    assert('I5: the fix turn refuses installs', /installing packages/.test(policy.admit('run_command', install) ?? ''))
    assert('I5: the fix turn refuses sub-agents and video', Boolean(policy.admit('delegate_task', {})) && Boolean(policy.admit('generate_video', {})) && Boolean(policy.admit('generate_long_video', {})) && Boolean(policy.admit('agent', {})))
    assert('I5: no image regeneration unless the image was wrong', Boolean(policy.admit('generate_image', {})))
    const testArgs: Record<string, unknown> = { command: 'npm test', timeoutMs: 600_000 }
    assert('I5: a check command is allowed, capped at the self-check time and killed on timeout',
      policy.admit('run_command', testArgs) === undefined && testArgs.timeoutMs === 60_000 && testArgs.killOnTimeout === true)
    policy.admit('read_file', {})
    policy.admit('write_file', {})
    policy.admit('replace_in_file', {})
    assert('I5: at most 4 tool calls', /used its tool calls/.test(policy.admit('read_file', {}) ?? ''))
    const imagePolicy = new SelfCheckFixPolicy(true, () => 120_000)
    assert('I5: one image regeneration, not two', imagePolicy.admit('generate_image', {}) === undefined && Boolean(imagePolicy.admit('generate_image', {})))
    assert('I5: no image regeneration with too little time left', /too little self-check time/.test(new SelfCheckFixPolicy(true, () => 30_000).admit('generate_image', {}) ?? ''))
    const shell = new SelfCheckFixPolicy(false, () => 60_000, parseBareCheck('npm test', cwd))
    for (const command of ['git push', 'git commit -am fix', 'npm publish', 'rm -rf build', 'curl https://example.com', 'npm run deploy', 'npm run lint', 'echo x > sum.js', 'sed -i s/a/b/ sum.js', 'find . -delete']) {
      assert(`minor: the fix turn refuses \`${command}\``, Boolean(shell.admit('run_command', { command })))
    }
    const shell2 = new SelfCheckFixPolicy(false, () => 60_000, parseBareCheck('npm test', cwd))
    assert('minor: the fix turn allows the same check and read-only inspection',
      shell2.admit('run_command', { command: 'CI=true npm test' }) === undefined && shell2.admit('run_command', { command: 'cat sum.js | head -20' }) === undefined &&
      shell2.admit('run_command', { command: 'git diff' }) === undefined && isReadOnlyInspection('grep -rn sum test') && !isReadOnlyInspection('git push'))

    let now = 0
    const late = new SelfCheckRun({ settings: SETTINGS, tracker: new SelfCheckTracker(cwd), userRequest: 'x', language: 'en', now: () => now })
    await late.review('x', fakeHost([]))
    now = 10_000_000
    const { signal, dispose } = late.turnSignal()
    await sleep(1_200)
    assert('I5: the turn signal aborts once the wall time is up', signal.aborted)
    dispose()
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
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: 'A poster that says "GRAND OPENING"', language: 'en' })
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
    const okRun = new SelfCheckRun({ settings: SETTINGS, tracker: ok, userRequest: 'Paint a portrait of my grandmother in watercolor', language: 'en' })
    const okDecision = await okRun.review('Here is the watercolor portrait.', fakeHost([], { getImageJudge: async () => judge }))
    assert('I1: "a portrait of my grandmother" as a square image is no header mismatch; only the judge looks (it matches)',
      okDecision.kind === 'finish' && okDecision.reply === 'Here is the watercolor portrait.' && okRun.modelCalls === 1)

    const wide = path.join(cwd, 'wide.png')
    fs.writeFileSync(wide, Buffer.concat([pngHeader(1920, 1080), Buffer.alloc(64)]))
    const shape = new SelfCheckTracker(cwd)
    shape.record({ tool: 'generate_image', ok: true, output: `Generated 1 image(s):\n  [1] ${wide}` })
    const before = visionRequests.length
    const shapeRun = new SelfCheckRun({ settings: SETTINGS, tracker: shape, userRequest: '生成一张 9:16 竖版壁纸', language: 'zh' })
    const shapeDecision = await shapeRun.review('壁纸已生成。', fakeHost([], { getImageJudge: async () => judge }))
    assert('image: an explicitly requested 9:16 missed is caught from the file header without a vision call',
      shapeDecision.kind === 'turn' && shapeDecision.note.includes('9:16') && visionRequests.length === before && shapeRun.modelCalls === 1, JSON.stringify(shapeDecision).slice(0, 300))

    const noVision = new SelfCheckTracker(cwd)
    noVision.record({ tool: 'generate_image', ok: true, output: `Generated 1 image(s):\n  [1] ${img}` })
    const nv = await new SelfCheckRun({ settings: SETTINGS, tracker: noVision, userRequest: 'A square poster', language: 'en' })
      .review('Here it is.', fakeHost([], { getImageJudge: async () => undefined }))
    assert('image: without a vision-capable model nothing is judged', nv.kind === 'finish' && nv.reply === 'Here it is.')

    const failedThenMade = new SelfCheckTracker(cwd)
    const out = path.join(cwd, 'cover.png')
    failedThenMade.record({ tool: 'generate_image', ok: false, args: { prompt: 'cover', outputPath: out }, output: 'generate_image failed: timeout' })
    fs.writeFileSync(out, pngHeader(100, 100))
    failedThenMade.record({ tool: 'run_command', ok: true, command: `ffmpeg -i in.png ${out}`, output: cmdOutput(`ffmpeg -i in.png ${out}`, 0) })
    assert('minor: a failed generation whose file was produced another way is not reported', !gateSelfCheck(failedThenMade).failedMedia)
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
    const check = new SelfCheckRun({ settings: SETTINGS, tracker, userRequest: '做一个 10 秒的横屏视频', language: 'zh' })
    const decision = await check.review('视频已生成：clip.mp4', host)
    assert('video: metadata mismatch is reported in one short line, never regenerated (no model call)',
      decision.kind === 'finish' && probes === 1 && decision.reply.includes('自检：clip.mp4: 时长 5.0 秒，要求的是 10 秒') && check.modelCalls === 0, JSON.stringify(decision))
    const band = new SelfCheckTracker(cwd)
    band.record({ tool: 'generate_video', ok: true, output: `Saved video: ${clip}` })
    const bandDecision = await new SelfCheckRun({ settings: SETTINGS, tracker: band, userRequest: 'Make a video of a 60s rock band at a music festival', language: 'en' })
      .review('Here is the video.', fakeHost([], { probeMedia: async () => ({ durationSec: 5, width: 1280, height: 720, hasVideo: true, hasAudio: false }) }))
    assert('I1: "60s rock band" / "music festival" ask no duration or sound: nothing reported', bandDecision.kind === 'finish' && bandDecision.reply === 'Here is the video.', JSON.stringify(bandDecision))
  }

  // ── runAgent end to end ─────────────────────────────────────────────────
  const envelope = (body: Record<string, unknown>): ProviderResponse => ({ text: JSON.stringify(body), raw: null })
  const toolMessages = (messages: SessionMessage[]) => messages.filter((m) => m.role === 'tool')
  {
    const { cwd } = freshCase('run-agent')
    const store = new SessionStore(cwd)
    const requests: SessionMessage[][] = []
    let phase = 0
    let fixTurnAsked = false
    const provider: ChatProvider = {
      async complete(messages): Promise<ProviderResponse> {
        requests.push(messages)
        const last = messages.at(-1)?.content ?? ''
        if (last.includes('[Self-check before done')) {
          fixTurnAsked = true
          // The policy keeps the install and the sub-agent out; the edit goes through.
          return envelope({ reply: 'Fixing the operator in sum.js.', done: false, actions: [
            { type: 'run_command', command: 'npm install left-pad' },
            { type: 'delegate_task', role: 'builder', task: 'fix it' },
            { type: 'write_file', path: 'sum.js', content: SUM_FIXED },
          ] })
        }
        if (last.includes('[Self-check result')) {
          return envelope({ reply: 'Refactored sum(a, b) in sum.js. The self-check caught a wrong operator and fixed it; npm test passes.', done: true, actions: [{ type: 'write_file', path: 'ignored.js', content: 'x' }] })
        }
        phase++
        if (phase === 1) return envelope({ reply: 'Writing sum.js.', done: false, actions: [{ type: 'write_file', path: 'sum.js', content: SUM_FIXED }] })
        if (phase === 2) return envelope({ reply: 'Testing.', done: false, actions: [{ type: 'run_command', command: 'npm test 2>&1 | tail -20' }] })
        if (phase === 3) return envelope({ reply: 'Refactoring.', done: false, actions: [{ type: 'write_file', path: 'sum.js', content: SUM_BUGGY }] })
        return envelope({ reply: 'Done: refactored sum(a, b) in sum.js.', done: true })
      },
    }
    const options = {
      cwd,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 8,
      profile: 'main' as const,
      selfCheck: true,
    }
    const session = store.createSession({ title: 'self-check A' })
    await store.save(session)
    const result = await runAgent(session, 'Add a sum(a, b) function in sum.js, test it, then refactor it', options)
    assert('runAgent: the re-run of the agent\'s own check failed → one fix turn → a passing re-run',
      fixTurnAsked && fs.readFileSync(path.join(cwd, 'sum.js'), 'utf8') === SUM_FIXED && result.reply.includes('self-check caught'), JSON.stringify(result))
    assert('runAgent: the no-tool final turn\'s actions are ignored', !fs.existsSync(path.join(cwd, 'ignored.js')))
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
    const tools = toolMessages(stored.messages)
    assert('runAgent: the note is never stored; the re-runs are normal tool turns running `CI=true npm test`',
      !stored.messages.some((m) => m.content.includes('[Self-check')) &&
      tools.filter((m) => m.content.includes('CI=true npm test')).length === 2,
      JSON.stringify(tools.map((m) => m.content.slice(0, 80))))
    assert('I3/I5: the fix turn\'s install and sub-agent were refused, never run',
      tools.filter((m) => m.content.includes('Refused by the self-check')).length === 2 && !fs.existsSync(path.join(cwd, 'node_modules')))
    assert('runAgent: the stored final reply is the corrected one', stored.messages.filter((m) => m.role === 'assistant').at(-1)?.content === result.reply)

    // chat: nothing extra
    requests.length = 0
    const chatProvider: ChatProvider = { async complete(messages) { requests.push(messages); return envelope({ reply: 'Paris.', done: true }) } }
    const chat = await runAgent(store.createSession({ title: 'chat' }), 'What is the capital of France?', { ...options, provider: chatProvider })
    assert('runAgent: chat → one request, no check', chat.reply === 'Paris.' && requests.length === 1)

    // opt-in only; sub-agents and the disabled flag never check
    const testThenBreak = (): ChatProvider => {
      let n = 0
      return {
        async complete(messages) {
          requests.push(messages)
          n++
          if (n === 1) return envelope({ reply: 'Testing.', done: false, actions: [{ type: 'run_command', command: 'npm test' }] })
          if (n === 2) return envelope({ reply: 'Writing.', done: false, actions: [{ type: 'write_file', path: 'sum.js', content: SUM_BUGGY }] })
          return envelope({ reply: 'Done.', done: true })
        },
      }
    }
    const countChecks = async (opts: Record<string, unknown>): Promise<{ checks: number; requests: number }> => {
      requests.length = 0
      const s = store.createSession({ title: 'opt' })
      await runAgent(s, 'Change sum() in sum.js', { ...options, provider: testThenBreak(), ...opts })
      const saved = await store.load(s.id)
      return { checks: saved.messages.filter((m) => m.role === 'tool' && m.content.includes('CI=true npm test')).length, requests: requests.length }
    }
    const baseline = await countChecks({ selfCheck: undefined })
    assert('runAgent: without selfCheck (callers that do not opt in) → no check', baseline.checks === 0)
    const withCheck = await countChecks({})
    assert('runAgent: the same run with selfCheck → the agent\'s own check is re-run', withCheck.checks >= 1 && withCheck.requests <= baseline.requests + 2, JSON.stringify({ baseline, withCheck }))
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
      await runAgent(s, '[Artemis Saga long video workflow]\nChange sum() in sum.js', { ...options, provider: testThenBreak() })
      const saved = await store.load(s.id)
      assert('runAgent: a Saga-marked request → no check', saved.messages.filter((m) => m.role === 'tool' && m.content.includes('CI=true')).length === 0)
    }
  }

  // ── runAgent: an untrusted repo's script never runs (reviewer probe C) ──
  {
    const { cwd } = freshCase('untrusted', false)
    const marker = path.join(sandbox, `PWNED-${caseCounter}`)
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: `echo exfil > ${marker} && node -e 1` } }))
    const store = new SessionStore(cwd)
    for (const request of ['Change a.js to export 1. Only edit the file; this repo is untrusted, so execute nothing.', 'Change a.js to export 1.']) {
      let n = 0
      const provider: ChatProvider = {
        async complete() {
          n++
          if (n === 1) return envelope({ reply: 'Editing.', done: false, actions: [{ type: 'write_file', path: 'a.js', content: 'module.exports = 1\n' }] })
          return envelope({ reply: 'Done. All tests pass.', done: true })
        },
      }
      const session = store.createSession({ title: 'c' })
      await store.save(session)
      await runAgent(session, request, { cwd, provider, sessionStore: store, permissionManager: new PermissionManager('PRODUCER', false), maxTurns: 6, profile: 'main', selfCheck: true })
      const saved = await store.load(session.id)
      assert(`B1: ${request.includes('untrusted') ? '"execute nothing"' : 'no agent check'} → the repo's test script never runs`,
        !fs.existsSync(marker) && !toolMessages(saved.messages).some((m) => m.content.includes('"run_command"')),
        JSON.stringify(toolMessages(saved.messages).map((m) => m.content.slice(0, 100))))
    }
  }

  // ── runAgent: nothing from an earlier task is re-run (round-2 probe G) ─
  {
    const scripted = (steps: Array<Record<string, unknown>>): ChatProvider => {
      let i = 0
      return { async complete() { return envelope(steps[Math.min(i++, steps.length - 1)]!) } }
    }
    const mk = (dir: string, testBody: string) => {
      fs.mkdirSync(path.join(dir, 'test'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: testBody } }))
      fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), "require('node:test')('ok', () => {})\n")
    }
    const opts = (cwd: string, store: SessionStore, provider: ChatProvider) => ({ cwd, provider, sessionStore: store, permissionManager: new PermissionManager('PRODUCER', false), maxTurns: 6, profile: 'main' as const, selfCheck: true })
    const { cwd: base } = freshCase('probe-g', false)
    const repo1 = path.join(base, 'repo1')
    mk(repo1, 'node --test')
    const store1 = new SessionStore(repo1)
    const s1 = store1.createSession({ title: 'g1' })
    await store1.save(s1)
    await runAgent(s1, 'Run the tests and push.', opts(repo1, store1, scripted([{ reply: 'running', done: false, actions: [{ type: 'run_command', command: 'npm test && touch PUSHED' }] }, { reply: 'Tests pass; pushed.', done: true }])))
    fs.rmSync(path.join(repo1, 'PUSHED'), { force: true })
    await runAgent(s1, 'Rename the export in a.js to sum.', opts(repo1, store1, scripted([{ reply: 'w', done: false, actions: [{ type: 'write_file', path: 'a.js', content: 'module.exports.sum = 1\n' }] }, { reply: 'Renamed.', done: true }])))
    assert('N1 (probe G1): an earlier task\'s `npm test && touch PUSHED` is never re-run by a later task', !fs.existsSync(path.join(repo1, 'PUSHED')))
    const repoA = path.join(base, 'repoA')
    const repoB = path.join(base, 'repoB')
    const pwned = path.join(base, 'PWNED_B')
    mk(repoA, 'node --test')
    mk(repoB, `touch ${pwned} && node --test`)
    const storeA = new SessionStore(repoA)
    const sA = storeA.createSession({ title: 'g2' })
    await storeA.save(sA)
    await runAgent(sA, 'Run the tests.', opts(repoA, storeA, scripted([{ reply: 'r', done: false, actions: [{ type: 'run_command', command: 'npm test' }] }, { reply: 'Tests pass.', done: true }])))
    await runAgent(sA, 'Now in this other checkout, change b.js to export 2.', opts(repoB, storeA, scripted([{ reply: 'w', done: false, actions: [{ type: 'write_file', path: 'b.js', content: 'module.exports = 2\n' }] }, { reply: 'Done.', done: true }])))
    assert('N1 (probe G2): a check from an earlier task in another repo never runs in this one', !fs.existsSync(pwned))
  }

  // ── runAgent: monorepo, the re-run never moves the run (probe E) ───────
  {
    const { cwd, pkg } = monorepoCase('mono-agent')
    const store = new SessionStore(cwd)
    let n = 0
    const provider: ChatProvider = {
      async complete(messages) {
        const last = String(messages.at(-1)?.content ?? '')
        if (last.includes('[Self-check before done')) return envelope({ reply: 'fixing', done: false, actions: [{ type: 'write_file', path: 'sum.js', content: SUM_FIXED }] })
        if (last.includes('[Self-check result')) return envelope({ reply: 'Fixed sum() in packages/foo; the self-check caught it.', done: true })
        n++
        // The agent cds into the package itself; its own cd persists.
        if (n === 1) return envelope({ reply: 'w', done: false, actions: [{ type: 'write_file', path: 'packages/foo/sum.js', content: SUM_FIXED }] })
        if (n === 2) return envelope({ reply: 't', done: false, actions: [{ type: 'run_command', command: 'cd packages/foo && npm test' }] })
        if (n === 3) return envelope({ reply: 'w2', done: false, actions: [{ type: 'write_file', path: 'sum.js', content: SUM_BUGGY }] })
        return envelope({ reply: 'Done.', done: true })
      },
    }
    const session = store.createSession({ title: 'e' })
    await store.save(session)
    await runAgent(session, 'Add sum(a, b) in packages/foo/sum.js, test it, then simplify it', { cwd, provider, sessionStore: store, permissionManager: new PermissionManager('PRODUCER', false), maxTurns: 8, profile: 'main', selfCheck: true })
    const saved = await store.load(session.id)
    const reruns = toolMessages(saved.messages).filter((m) => /cd packages\/foo && (?:CI=true )?npm test/.test(m.content))
    assert('B2 (runAgent): the fix lands in the real file; no stray packages/foo/packages/foo',
      fs.readFileSync(path.join(pkg, 'sum.js'), 'utf8') === SUM_FIXED && !fs.existsSync(path.join(pkg, 'packages')), JSON.stringify(reruns.map((m) => m.content.slice(0, 300))))
    assert('B2 (runAgent): the re-runs ran from where the agent ran its check (no nested cd)', reruns.length === 3 && !reruns.some((m) => m.content.includes('packages/foo/packages/foo')))
  }

  // ── runAgent: the wall-time cap aborts an in-flight self-check turn ─────
  {
    const { cwd } = freshCase('abort-agent')
    process.env.ARTEMIS_SELF_CHECK_MAX_MS = '25000'
    const store = new SessionStore(cwd)
    let n = 0
    let aborted = false
    const provider: ChatProvider = {
      async complete(messages, options) {
        const last = String(messages.at(-1)?.content ?? '')
        if (last.includes('[Self-check before done')) {
          // A fix turn that never answers: the self-check's cap must stop it.
          return await new Promise<ProviderResponse>((_, reject) => {
            options?.abortSignal?.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
          })
        }
        n++
        if (n === 1) return envelope({ reply: 'w', done: false, actions: [{ type: 'write_file', path: 'sum.js', content: SUM_FIXED }] })
        if (n === 2) return envelope({ reply: 't', done: false, actions: [{ type: 'run_command', command: 'npm test' }] })
        if (n === 3) return envelope({ reply: 'w', done: false, actions: [{ type: 'write_file', path: 'sum.js', content: SUM_BUGGY }] })
        return envelope({ reply: 'Done: changed sum().', done: true })
      },
    }
    const session = store.createSession({ title: 'abort' })
    await store.save(session)
    const started = Date.now()
    const result = await runAgent(session, 'Change sum() in sum.js', { cwd, provider, sessionStore: store, permissionManager: new PermissionManager('accept-all', false), maxTurns: 6, profile: 'main', selfCheck: true })
    const elapsed = Date.now() - started
    assert('I5 (runAgent): the in-flight fix turn is aborted at the wall-time cap; the reply reports the failure',
      aborted && elapsed < 40_000 && result.reply.includes('Self-check: `npm test` fails'), JSON.stringify({ elapsed, reply: result.reply }))
    delete process.env.ARTEMIS_SELF_CHECK_MAX_MS
  }

  // ── think(): mock OpenAI-compatible / Anthropic messages servers ────────
  type MockReply = { status?: number; body: unknown; sse?: string }
  const withMockProvider = async (
    cwd: string,
    protocol: 'openai' | 'messages',
    handle: (body: Record<string, any>) => MockReply | 'hang',
    run: () => Promise<void>,
  ): Promise<void> => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>
        const answer = handle(body)
        if (answer === 'hang') return
        if (answer.sse !== undefined) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          for (const part of answer.sse.match(/.{1,8}/g) ?? []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
          res.end('data: [DONE]\n\n')
          return
        }
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer.body))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const dataRoot = resolveDataRootDir(cwd)
    fs.mkdirSync(dataRoot, { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-self-check',
      profiles: [{ id: 'mock-self-check', label: 'Mock', protocol, apiKey: 'test-key', model: 'mock', baseUrl: `http://127.0.0.1:${port}` }],
    }, null, 2))
    const originalCwd = process.cwd()
    try {
      process.chdir(cwd)
      resetSession()
      applyProviderOverrides({})
      await run()
    } finally {
      process.chdir(originalCwd)
      resetSession()
      applyProviderOverrides({})
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  const oa = (content: string, toolCalls?: unknown[]): MockReply => ({ body: {
    model: 'mock',
    choices: [{ message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  } })
  const oaCall = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const isMain = (body: Record<string, any>) => Array.isArray(body.tools) && body.tools.length > 0
  const lastText = (body: Record<string, any>) => JSON.stringify((body.messages ?? []).at(-1) ?? '')

  {
    const { cwd } = freshCase('think')
    const bodies: Array<Record<string, any>> = []
    let round = 0
    await withMockProvider(cwd, 'openai', (body) => {
      if (!isMain(body)) return oa('{}')
      bodies.push(body)
      const last = lastText(body)
      if (last.includes('[Self-check before done')) {
        return oa('', [oaCall('f0', 'run_command', { command: 'pip install requests' }), oaCall('f1', 'write_file', { path: 'sum.js', content: SUM_FIXED })])
      }
      if (last.includes('[Self-check result')) return oa('Refactored sum() in sum.js. The self-check caught a wrong operator and fixed it; npm test passes now.')
      round++
      if (round === 1) return oa('', [oaCall('c1', 'write_file', { path: 'sum.js', content: SUM_FIXED })])
      if (round === 2) return oa('', [oaCall('c2', 'run_command', { command: 'npm test 2>&1 | tail -20' })])
      if (round === 3) return oa('', [oaCall('c3', 'write_file', { path: 'sum.js', content: SUM_BUGGY })])
      if (round === 4) return oa('Done: refactored sum() in sum.js, all tests pass.')
      return oa('sum.js exports a function that adds two numbers.')
    }, async () => {
      const deltas: string[] = []
      const progress: string[] = []
      const toolCalls: string[] = []
      const result = await think('Add a sum(a, b) function in sum.js, test it, then refactor it', (delta) => deltas.push(delta), {
        cwd,
        permissionMode: 'accept-all',
        selfCheck: true,
        onSelfCheck: (message) => progress.push(message),
        onToolCall: (name, args) => toolCalls.push(`${name}:${String((args as { command?: string }).command ?? (args as { path?: string }).path ?? '')}`),
      })
      assert('think: the re-run of the agent\'s own check failed → one fix turn; the file is fixed',
        fs.readFileSync(path.join(cwd, 'sum.js'), 'utf8') === SUM_FIXED && result.reply.includes('self-check caught'), JSON.stringify({ reply: result.reply, toolCalls }))
      assert('think: the check re-ran twice as normal tool calls (with CI=true), one progress line; the install was refused, never run',
        toolCalls.filter((entry) => entry === 'run_command:CI=true npm test').length === 2 && progress.length === 1 && !toolCalls.some((entry) => entry.includes('pip install')),
        JSON.stringify({ toolCalls, progress }))
      assert('think: two extra model requests', bodies.length === 6, String(bodies.length))
      assert('think: the overclaiming first reply is never shown; only the final one is',
        !deltas.join('').includes('all tests pass') && deltas.join('').includes('self-check caught'), JSON.stringify(deltas))
      const systemOf = (body: Record<string, any>) => JSON.stringify((body.messages as Array<{ role: string }>).filter((m) => m.role === 'system'))
      assert('think: the system messages are identical in every request (cache prefix stable)', new Set(bodies.map(systemOf)).size === 1)
      assert('think: the tool list is identical in every request (cache prefix stable)', new Set(bodies.map((b) => JSON.stringify(b.tools))).size === 1)
      assert('think: the self-check note is never stored in the conversation',
        !getMessages().some((m: SessionMessage) => String(m.content).includes('[Self-check')))
      const stored = getMessages() as SessionMessage[]
      assert('think: the stored conversation ends with the final reply', stored.at(-1)?.role === 'assistant' && String(stored.at(-1)?.content).includes('self-check caught'))
      const before = bodies.length
      const answer = await think('What does sum.js export?', () => undefined, { cwd, permissionMode: 'accept-all', selfCheck: true })
      assert('think: a turn without changes → no check, one request', bodies.length === before + 1 && answer.reply.length > 0)
    })
  }

  // ── think(): monorepo, the re-run never moves the turn (probe D) ───────
  {
    const { cwd, pkg } = monorepoCase('mono-think')
    let round = 0
    const runs: string[] = []
    await withMockProvider(cwd, 'openai', (body) => {
      if (!isMain(body)) return oa('{}')
      const last = lastText(body)
      if (last.includes('[Self-check before done')) return oa('', [oaCall('f1', 'write_file', { path: 'sum.js', content: SUM_FIXED })])
      if (last.includes('[Self-check result')) return oa('Fixed sum(); the self-check caught it.')
      round++
      if (round === 1) return oa('', [oaCall('c1', 'write_file', { path: 'packages/foo/sum.js', content: SUM_FIXED })])
      if (round === 2) return oa('', [oaCall('c2', 'run_command', { command: 'cd packages/foo && npm test' })])
      if (round === 3) return oa('', [oaCall('c3', 'write_file', { path: 'sum.js', content: SUM_BUGGY })])
      return oa('Done: simplified sum() in packages/foo/sum.js.')
    }, async () => {
      const result = await think('Add sum(a, b) in packages/foo/sum.js, test it, then simplify it', () => undefined, {
        cwd, permissionMode: 'accept-all', selfCheck: true,
        onToolResult: (name, _ok, output) => { if (name === 'run_command') runs.push(String(output).slice(0, 400)) },
      })
      assert('B2 (think): the fix lands in the real file; no stray packages/foo/packages/foo',
        fs.readFileSync(path.join(pkg, 'sum.js'), 'utf8') === SUM_FIXED && !fs.existsSync(path.join(pkg, 'packages')), JSON.stringify({ reply: result.reply, runs }))
      assert('B2 (think): the turn ends in the agent\'s own directory, the re-runs never nested', result.cwd === pkg && runs.length === 3 && !runs.some((entry) => entry.includes('packages/foo/packages/foo')), JSON.stringify({ cwd: result.cwd, runs }))
    })
  }

  // ── think(): Anthropic messages — a no-tool turn leaves no tool_use (probe A) ─
  {
    const { cwd } = freshCase('think-messages')
    let round = 0
    const orphans: string[] = []
    const okMsg = (content: unknown[], stop = 'end_turn'): MockReply => ({ body: { id: 'm', type: 'message', role: 'assistant', model: 'mock', content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } } })
    const tu = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
    let secondTurn = ''
    await withMockProvider(cwd, 'messages', (body) => {
      const msgs = (body.messages ?? []) as Array<{ role: string; content: unknown }>
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]!
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
        const ids = (m.content as Array<{ type: string; id: string }>).filter((b) => b.type === 'tool_use').map((b) => b.id)
        if (!ids.length) continue
        const next = msgs[i + 1]
        const got = Array.isArray(next?.content) ? (next!.content as Array<{ type: string; tool_use_id: string }>).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : []
        const results = Array.isArray(next?.content) ? (next!.content as Array<{ type: string; content?: unknown }>).filter((b) => b.type === 'tool_result').map((b) => JSON.stringify(b.content ?? '')) : []
        if (!ids.every((id) => got.includes(id)) || results.some((text) => text.includes('No result was recorded'))) orphans.push(ids.join(','))
      }
      const last = lastText(body)
      if (last.includes('thanks')) {
        secondTurn = 'ok'
        return okMsg([{ type: 'text', text: 'You are welcome.' }])
      }
      if (!isMain(body)) return okMsg([{ type: 'text', text: '{}' }])
      if (last.includes('[Self-check before done')) return okMsg([tu('f1', 'write_file', { path: 'sum.js', content: SUM_FIXED })], 'tool_use')
      if (last.includes('[Self-check result')) {
        // The model calls a tool in the no-tool final turn anyway.
        return okMsg([{ type: 'text', text: 'Fixed sum(); the self-check caught a wrong operator.' }, tu('r1', 'run_command', { command: 'npm test' })], 'tool_use')
      }
      round++
      if (round === 1) return okMsg([tu('c0', 'write_file', { path: 'sum.js', content: SUM_FIXED })], 'tool_use')
      if (round === 2) return okMsg([tu('c1', 'run_command', { command: 'npm test' })], 'tool_use')
      if (round === 3) return okMsg([tu('c2', 'write_file', { path: 'sum.js', content: SUM_BUGGY })], 'tool_use')
      return okMsg([{ type: 'text', text: 'Done: added sum().' }])
    }, async () => {
      const first = await think('Add a sum(a, b) function in sum.js', () => undefined, { cwd, permissionMode: 'accept-all', selfCheck: true })
      const stored = getMessages() as SessionMessage[]
      const last = stored.at(-1)
      assert('minor: the no-tool turn\'s reply is stored as text only (no tool_use, no raw blocks)',
        last?.role === 'assistant' && !last.toolCalls?.length && !(last as { rawContentBlocks?: unknown }).rawContentBlocks && String(last.content).includes('self-check caught'),
        JSON.stringify(last).slice(0, 400))
      const second = await think('thanks', () => undefined, { cwd, permissionMode: 'accept-all', selfCheck: true })
      assert('probe A: the next turn has no orphan tool_use and succeeds',
        orphans.length === 0 && secondTurn === 'ok' && second.reply.includes('welcome') && first.reply.includes('self-check caught'), JSON.stringify({ orphans, second: second.reply }))
    })
  }

  // ── think(): SSE streaming — the overclaim never streams (probe B) ─────
  {
    const { cwd } = freshCase('think-sse')
    let round = 0
    await withMockProvider(cwd, 'openai', (body) => {
      if (!isMain(body)) return oa('{}')
      const last = lastText(body)
      if (last.includes('[Self-check before done')) return oa('', [oaCall('f1', 'write_file', { path: 'sum.js', content: SUM_FIXED })])
      if (last.includes('[Self-check result')) return { body: null, sse: 'Added sum(); the self-check caught a wrong operator and fixed it.' }
      round++
      if (round === 1) return oa('', [oaCall('c0', 'write_file', { path: 'sum.js', content: SUM_FIXED })])
      if (round === 2) return oa('', [oaCall('c1', 'run_command', { command: 'npm test' })])
      if (round === 3) return oa('', [oaCall('c2', 'write_file', { path: 'sum.js', content: SUM_BUGGY })])
      return { body: null, sse: 'Done: added sum(), all tests pass.' }
    }, async () => {
      const deltas: string[] = []
      const result = await think('Add a sum(a, b) function in sum.js', (delta) => deltas.push(delta), { cwd, permissionMode: 'accept-all', selfCheck: true })
      assert('probe B: with SSE the overclaiming draft never reaches the user; the final reply does',
        !deltas.join('').includes('all tests pass') && deltas.join('').includes('self-check caught') && result.reply.includes('self-check caught'), JSON.stringify(deltas))
    })
  }

  // ── think(): the wall-time cap aborts an in-flight fix turn ────────────
  {
    const { cwd } = freshCase('think-abort')
    process.env.ARTEMIS_SELF_CHECK_MAX_MS = '25000'
    let round = 0
    await withMockProvider(cwd, 'openai', (body) => {
      if (!isMain(body)) return oa('{}')
      if (lastText(body).includes('[Self-check before done')) return 'hang'
      round++
      if (round === 1) return oa('', [oaCall('c0', 'write_file', { path: 'sum.js', content: SUM_FIXED })])
      if (round === 2) return oa('', [oaCall('c1', 'run_command', { command: 'npm test' })])
      if (round === 3) return oa('', [oaCall('c2', 'write_file', { path: 'sum.js', content: SUM_BUGGY })])
      return oa('Done: changed sum().')
    }, async () => {
      const started = Date.now()
      const result = await think('Change sum() in sum.js', () => undefined, { cwd, permissionMode: 'accept-all', selfCheck: true })
      const elapsed = Date.now() - started
      assert('I5 (think): the in-flight fix turn is aborted at the wall-time cap; the reply reports the failure',
        elapsed < 40_000 && result.reply.includes('Self-check: `npm test` fails'), JSON.stringify({ elapsed, reply: result.reply }))
    })
    delete process.env.ARTEMIS_SELF_CHECK_MAX_MS
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
