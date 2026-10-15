#!/usr/bin/env tsx
/**
 * scripts/toolSafetySmoke.ts — regressions from the review of #47–#69.
 *
 * - no engine wallet tools; spending only through the host's wallet MCP tools
 * - extras run programs with argv arrays (no shell), are validated on the
 *   brain path, and the reproduced git_branch injection creates nothing
 * - get_env never returns a secret-looking variable, not even by name
 * - git writes, npm_run and format_code are execute/shell and need approval;
 *   delete/move/copy/download outside the workspace need approval
 * - the full tool manifest by default; lazy loading only with ARTEMIS_LAZY_TOOLS=1
 * - edit_timeline: import_long_video, input paths limited to the workspace or
 *   the media root, an `output` string
 * - reverted surfaces stay gone (mcp_run_command, http_request, web_scraper,
 *   bin/artemis-cli.js, wp2-registry.patch)
 * - STT: platform falls through to local Whisper; the wizard never writes
 *   into a platform-managed speech entry and keeps the language
 * - `artemis retry` returns the reply and forwards progress
 * - MCP: ping is answered; a message with a method is always a request
 *
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/toolSafetySmoke.ts
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

let passed = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  \x1b[32m✔\x1b[0m ${label}`)
  } else {
    failures.push(label)
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}
function section(name: string): void {
  console.log(`\n  ${name}`)
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-tool-safety-'))
const originalEnv = { ...process.env }
process.env.ARTEMIS_HOME = path.join(sandbox, 'home')
process.env.ARTEMIS_MEDIA_OUTPUT_ROOT = path.join(sandbox, 'media')
fs.mkdirSync(process.env.ARTEMIS_HOME, { recursive: true })
fs.mkdirSync(process.env.ARTEMIS_MEDIA_OUTPUT_ROOT, { recursive: true })
delete process.env.ARTEMIS_LAZY_TOOLS
delete process.env.ARTEMIS_APPROVAL_POLICY

const { ALL_AGENT_ACTION_TYPES } = await import('../src/core/types.js')
const { getAllowedActionTypesForProfile } = await import('../src/core/agentProfiles.js')
const registry = await import('../src/tools/registry.js')
const { buildSystemPrompt } = await import('../src/core/systemPrompt.js')
const { buildDirectNativeFunctionTools } = await import('../src/tools/directTools.js')
const { APPROVAL_KINDS, classifyApprovalNeed, classifyDirectToolNeed } = await import('../src/security/approvals.js')
const { describeDangerousCommand } = await import('../src/tools/runCommand.js')
const extras = await import('../src/tools/extras.js')
const { validateExtraAction } = await import('../src/tools/extras-validators.js')
const { executeEditTimeline } = await import('../src/tools/visual/timelineEditor.js')
const { applyProviderOverrides, resetSession, think } = await import('../src/brain.js')
const { resolveDataRootDir } = await import('../src/utils/fs.js')

const mainPrompt = buildSystemPrompt(sandbox, 'PRODUCER', 'standard', 'main', true)
const directToolNames = buildDirectNativeFunctionTools().map((tool) => tool.name)
const allTypes = ALL_AGENT_ACTION_TYPES as readonly string[]
const mainAllowed = getAllowedActionTypesForProfile('main') as readonly string[]

// ── A1: wallet ──────────────────────────────────────────────────────────────
section('A1 wallet tools are gone')
for (const name of ['get_balance', 'swap_quote', 'send_transaction']) {
  check(`${name}: not an action, not in the main profile, not registered, not a direct tool, not in the prompt`,
    !allTypes.includes(name) && !mainAllowed.includes(name) && !registry.getToolDefinition(name) && !directToolNames.includes(name) && !mainPrompt.includes(name))
}
check('src/tools/wallet is deleted', !fs.existsSync(path.join(repoRoot, 'src/tools/wallet')))
check('no wallet approval kind (spending goes through the host wallet MCP tools)', !(APPROVAL_KINDS as readonly string[]).some((kind) => kind.startsWith('wallet')))
{
  const ctx = { cwd: sandbox }
  const kindOf = (toolName: string) => classifyApprovalNeed({ type: 'mcp_call_tool', serverId: 'artemis_online', toolName, args: { amount: '1' } } as never, ctx)?.kind
  check('host wallet MCP tools that move money ask the owner',
    ['request_swap', 'transfer_to_allowlisted', 'pay_x402'].every((name) => kindOf(name) !== undefined),
    ['request_swap', 'transfer_to_allowlisted', 'pay_x402'].map((name) => `${name}=${kindOf(name)}`).join(' '))
}

// ── B2 / B3 / B6: reverted surfaces ──────────────────────────────────────────
section('B2/B3/B6 reverted surfaces stay gone')
check('mcp_run_command: not an action, not a core tool, not in the prompt',
  !allTypes.includes('mcp_run_command') && !registry.CORE_TOOL_TYPES.has('mcp_run_command') && !mainPrompt.includes('mcp_run_command'))
check('src/mcp/commands.ts stays removed and nothing sends commands/call',
  !fs.existsSync(path.join(repoRoot, 'src/mcp/commands.ts')) && !fs.readFileSync(path.join(repoRoot, 'src/mcp/client.ts'), 'utf8').includes('commands/call'))
for (const name of ['http_request', 'web_scraper']) {
  check(`${name}: not registered, not a direct tool`, !registry.getToolDefinition(name) && !directToolNames.includes(name))
}
check('brain.ts has no inline http_request fetch', !/name === 'http_request'/.test(fs.readFileSync(path.join(repoRoot, 'src/brain.ts'), 'utf8')))
check('wp2-registry.patch and bin/artemis-cli.js are deleted',
  !fs.existsSync(path.join(repoRoot, 'wp2-registry.patch')) && !fs.existsSync(path.join(repoRoot, 'bin/artemis-cli.js')))

// ── A4: lazy tool loading is opt-in ──────────────────────────────────────────
section('A4 full tool manifest by default')
check('default manifest tier is "all"', registry.resolveToolManifestTier() === 'all')
check('the system prompt never tells the model to call load_tools', !mainPrompt.includes('load_tools') && !/lazy tool loading/i.test(mainPrompt))
check('non-core tools are listed in full by default (generate_image, browser_navigate)',
  /^## generate_image$/m.test(mainPrompt) && /^## browser_navigate$/m.test(mainPrompt))
process.env.ARTEMIS_LAZY_TOOLS = '1'
try {
  check('ARTEMIS_LAZY_TOOLS=1 opts into the core tier', registry.resolveToolManifestTier() === 'core')
  const mainOnDemand = registry.getOnDemandToolSummaries(null, 'main').map((tool) => tool.type)
  const builderOnDemand = registry.getOnDemandToolSummaries(null, 'builder').map((tool) => tool.type)
  check('on-demand summaries leave out the profile\'s own core set',
    !mainOnDemand.includes('search_web') && builderOnDemand.includes('search_web') && !builderOnDemand.includes('run_command'))
  const lazyPrompt = buildSystemPrompt(sandbox, 'PRODUCER', 'standard', 'main', true)
  check('a profile without load_tools still gets every tool in full', /^## generate_image$/m.test(lazyPrompt))
} finally {
  delete process.env.ARTEMIS_LAZY_TOOLS
}

// ── A2: no shell on the extras path ──────────────────────────────────────────
section('A2 extras: argv only, validated on the brain path')
{
  const source = fs.readFileSync(path.join(repoRoot, 'src/tools/extras.ts'), 'utf8')
  check('extras.ts imports execFile, never exec / execSync / spawn with a shell',
    /import \{ execFile \} from 'node:child_process'/.test(source) && !/(?<![.\w])exec(?:Sync)?\(|execAsync|shell:\s*true/.test(source))
}
const repo = path.join(sandbox, 'repo')
fs.mkdirSync(repo, { recursive: true })
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Smoke', GIT_AUTHOR_EMAIL: 'smoke@example.com', GIT_COMMITTER_NAME: 'Smoke', GIT_COMMITTER_EMAIL: 'smoke@example.com' }
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: gitEnv })
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
execFileSync('git', ['add', 'a.txt'], { cwd: repo, env: gitEnv })
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env: gitEnv })
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Smoke', GIT_AUTHOR_EMAIL: 'smoke@example.com', GIT_COMMITTER_NAME: 'Smoke', GIT_COMMITTER_EMAIL: 'smoke@example.com' })
// $REPO is what the reproduced payload writes into: if any shell ever ran it, the file would appear here.
process.env.REPO = repo
const pwned = () => fs.readdirSync(repo).filter((name) => name.startsWith('PWNED'))
const payload = 'x; echo injected > $REPO/PWNED'

check('validateExtraAction rejects the reproduced git_branch payload', validateExtraAction({ type: 'git_branch', create: payload } as never).length > 0)
{
  // Straight to the executor, past the validator: argv makes the payload a (bad) branch name, nothing more.
  const direct = await extras.executeExtraTool('git_branch', { create: payload }, repo)
  check('git_branch {create: payload} without the validator: refused by git, nothing created', !direct.ok && pwned().length === 0, direct.output)
  const others: Array<[string, Record<string, unknown>]> = [
    ['git_diff', { path: '; echo injected > $REPO/PWNED_diff' }],
    ['git_add', { paths: ['$(echo injected > $REPO/PWNED_add)'] }],
    ['git_commit', { message: '"; echo injected > $REPO/PWNED_commit; echo "' }],
    ['which_command', { command: 'ls; echo injected > $REPO/PWNED_which' }],
    ['npm_run', { script: 'test; echo injected > $REPO/PWNED_npm' }],
    ['format_code', { path: 'a.ts"; echo injected > $REPO/PWNED_fmt; echo "' }],
    ['git_log', { limit: '1; echo injected > $REPO/PWNED_log' }],
  ]
  for (const [name, input] of others) await extras.executeExtraTool(name, input, repo)
  check('git_diff / git_add / git_commit / which_command / npm_run / format_code / git_log payloads create nothing', pwned().length === 0, pwned())
  const message = 'Say "hi" $(whoami) `id` ; done'
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n')
  const staged = await extras.executeExtraTool('git_add', { paths: ['b.txt'] }, repo)
  check('git_add stages a file', staged.ok, staged.output)
  const commit = await extras.executeExtraTool('git_commit', { message }, repo)
  const logged = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim()
  check('git_commit stores the message exactly as given (no shell expansion)', commit.ok && logged === message, { commit: commit.output, logged })
  const option = await extras.executeExtraTool('git_branch', { create: '--force' }, repo)
  check('git_branch refuses a name that git would read as an option', !option.ok && /branch name/.test(option.output), option.output)
  const branch = await extras.executeExtraTool('git_branch', { create: 'feature/ok' }, repo)
  check('git_branch creates an ordinary branch', branch.ok && execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim() === 'feature/ok', branch.output)
  const which = await extras.executeExtraTool('which_command', { command: 'git' }, repo)
  check('which_command still finds a program', which.ok && /git/.test(which.output), which.output)
}

// The brain (think) path: a mock OpenAI-compatible endpoint that asks for tools.
type ToolCall = { id: string; name: string; args: Record<string, unknown> }
async function runThinkWithToolCalls(cwd: string, calls: ToolCall[], extraOptions: Record<string, unknown> = {}): Promise<Array<Record<string, any>>> {
  const toolMessages: Array<Record<string, any>> = []
  let round = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>
      res.writeHead(200, { 'content-type': 'application/json' })
      const messages = (body.messages ?? []) as Array<Record<string, any>>
      const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
      if (!Array.isArray(body.tools) || system.includes('distil reusable procedures')) {
        res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content: '{}' } }] }))
        return
      }
      round++
      if (round === 1) {
        res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content: '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] }))
        return
      }
      for (const m of messages) if (m.role === 'tool') toolMessages.push(m)
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content: 'done' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const dataRoot = resolveDataRootDir(cwd)
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'providers.json'), JSON.stringify({
    defaultMainProfileId: 'mock',
    profiles: [{ id: 'mock', label: 'Mock', protocol: 'openai', apiKey: 'test-key', model: 'mock', baseUrl: `http://127.0.0.1:${port}` }],
  }))
  const previousCwd = process.cwd()
  try {
    process.chdir(cwd)
    resetSession()
    applyProviderOverrides({})
    await think('do the requested steps', () => {}, { cwd, permissionMode: 'accept-all', ...extraOptions })
  } finally {
    process.chdir(previousCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return toolMessages
}
const parse = (message: Record<string, any> | undefined): Record<string, any> => {
  try {
    return JSON.parse(String(message?.content ?? '{}'))
  } catch {
    return { output: String(message?.content ?? '') }
  }
}
{
  const results = await runThinkWithToolCalls(repo, [{ id: 'c1', name: 'git_branch', args: { create: payload } }])
  const result = parse(results.find((m) => m.tool_call_id === 'c1'))
  check('brain path: the reproduced git_branch payload is refused as invalid arguments and creates nothing',
    result.ok === false && result.error?.code === 'tool_invalid_arguments' && pwned().length === 0, result)
}
{
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'smoke', private: true, scripts: { mark: 'node -e "require(\'fs\').writeFileSync(\'RAN\', \'1\')"' } }))
  const results = await runThinkWithToolCalls(repo, [{ id: 'n1', name: 'npm_run', args: { script: 'mark' } }])
  const result = parse(results.find((m) => m.tool_call_id === 'n1'))
  check('brain path: npm_run needs the owner\'s approval and does not run without it',
    result.ok === false && /approval/.test(String(result.error?.code)) && !fs.existsSync(path.join(repo, 'RAN')), result)
  const asked: string[] = []
  const approved = await runThinkWithToolCalls(repo, [{ id: 'n2', name: 'npm_run', args: { script: 'mark' } }], {
    onUserConfirmationRequest: async (request: { question: string }) => {
      asked.push(request.question)
      return true
    },
  })
  const ran = parse(approved.find((m) => m.tool_call_id === 'n2'))
  check('brain path: once approved, npm_run runs the script (without a shell)', ran.ok !== false && /> mark/.test(String(ran.output)) && fs.existsSync(path.join(repo, 'RAN')) && asked.length === 1 && /npm run mark/.test(asked[0] ?? ''), { ran, asked })
}

// ── A3: get_env ──────────────────────────────────────────────────────────────
section('A3 get_env')
{
  process.env.SMOKE_API_KEY = 'sk-should-not-leak'
  process.env.SMOKE_GITHUB_TOKEN = 'ghp-should-not-leak'
  process.env.SMOKE_PLAIN = 'visible-value'
  const single = await extras.executeExtraTool('get_env', { key: 'SMOKE_API_KEY' }, sandbox)
  const many = await extras.executeExtraTool('get_env', { keys: ['SMOKE_GITHUB_TOKEN', 'SMOKE_PLAIN'] }, sandbox)
  const all = await extras.executeExtraTool('get_env', {}, sandbox)
  check('a secret-looking name is hidden when asked for by key', !single.output.includes('sk-should-not-leak') && /hidden/.test(single.output), single.output)
  check('a secret-looking name is hidden in keys; a plain one is returned', !many.output.includes('ghp-should-not-leak') && many.output.includes('visible-value'), many.output)
  check('the listing never shows secret-looking names', !all.output.includes('should-not-leak'))
  check('registry and tool descriptions say secrets are never returned, also by name',
    registry.getToolDefinition('get_env')?.description === extras.GET_ENV_DESCRIPTION && /not even by name/.test(extras.GET_ENV_DESCRIPTION))
}

// ── A7: classification and approvals ────────────────────────────────────────
section('A7 extras classification and approvals')
for (const name of ['git_add', 'git_commit', 'git_branch', 'npm_run', 'format_code']) {
  check(`${name} is an execute tool`, registry.getToolPermissionCategory(name) === 'execute', registry.getToolPermissionCategory(name))
}
{
  const ctx = { cwd: repo, dangerousCommand: describeDangerousCommand }
  // Classification only (nothing is written): a path outside the workspace and outside the temp dir.
  const outside = path.join(os.homedir(), '.artemis-tool-safety-outside')
  const kind = (action: Record<string, unknown>) => classifyApprovalNeed(action as never, ctx)?.kind ?? null
  const directKind = (name: string, input: Record<string, unknown>) => classifyDirectToolNeed(name, input, ctx)?.kind ?? null
  check('npm_run, git_commit and format_code are high-risk shell steps (agent and direct path)',
    ['npm_run', 'git_commit', 'format_code'].every((type) => kind({ type, script: 'test', message: 'm', path: 'a.ts' }) === 'shell_high_risk' && directKind(type, { script: 'test', message: 'm', path: 'a.ts' }) === 'shell_high_risk'))
  check('delete_directory outside the workspace needs approval, inside does not',
    kind({ type: 'delete_directory', path: outside }) === 'delete_outside_workspace' && kind({ type: 'delete_directory', path: 'build' }) === null)
  check('download_file to outside the workspace needs approval, inside does not',
    kind({ type: 'download_file', url: 'https://example.com/a', destination: path.join(outside, 'a') }) === 'delete_outside_workspace' &&
      kind({ type: 'download_file', url: 'https://example.com/a', destination: 'a.bin' }) === null &&
      kind({ type: 'download_file', url: 'https://example.com/a' }) === null)
  check('move_file / copy_file to outside the workspace need approval',
    kind({ type: 'move_file', from: 'a.txt', to: path.join(outside, 'a.txt') }) === 'delete_outside_workspace' &&
      kind({ type: 'copy_file', from: 'a.txt', to: path.join(outside, 'a.txt') }) === 'delete_outside_workspace' &&
      kind({ type: 'move_file', from: 'a.txt', to: 'b.txt' }) === null)
}

// ── A9 / A5: timeline editor ─────────────────────────────────────────────────
section('A9 edit_timeline inputs and output')
{
  const ws = path.join(sandbox, 'timeline-ws')
  fs.mkdirSync(path.join(ws, 'agent-credentials'), { recursive: true })
  const projectDir = path.join(process.env.ARTEMIS_HOME!, 'timeline-projects', 'p1')
  fs.mkdirSync(projectDir, { recursive: true })
  const now = new Date().toISOString()
  fs.writeFileSync(path.join(projectDir, 'timeline.json'), JSON.stringify({
    version: 1, projectId: 'p1', createdAt: now, updatedAt: now, ratio: '16:9', fps: 30, width: 1920, height: 1080,
    segments: [{ index: 1, title: 'One', duration: 3, originalDuration: 3, videoPath: path.join(ws, 'one.mp4'), prompt: '', trimmed: false }],
    subtitles: [],
  }))
  const outsideDir = path.join(sandbox, 'outside')
  fs.mkdirSync(outsideDir, { recursive: true })
  fs.writeFileSync(path.join(outsideDir, 'x.mp4'), 'not a video')
  fs.writeFileSync(path.join(outsideDir, 'x.mp3'), 'not audio')
  fs.writeFileSync(path.join(ws, 'agent-credentials', 'x.mp4'), 'secret')
  fs.symlinkSync(path.join(outsideDir, 'x.mp4'), path.join(ws, 'link.mp4'))
  const where = /工作区或媒体输出目录内|受保护的目录/
  const run = (args: Record<string, unknown>) => executeEditTimeline({ type: 'edit_timeline', ...args }, { cwd: ws })
  const outsideVideo = await run({ action: 'replace_segment', projectId: 'p1', segmentIndex: 1, newVideoPath: path.join(outsideDir, 'x.mp4') })
  const privateVideo = await run({ action: 'replace_segment', projectId: 'p1', segmentIndex: 1, newVideoPath: 'agent-credentials/x.mp4' })
  const linked = await run({ action: 'replace_segment', projectId: 'p1', segmentIndex: 1, newVideoPath: 'link.mp4' })
  const outsideAudio = await run({ action: 'set_bgm', projectId: 'p1', audioPath: path.join(outsideDir, 'x.mp3') })
  const insideAudio = await run({ action: 'set_bgm', projectId: 'p1', audioPath: 'missing.mp3' })
  check('replace_segment refuses a file outside the workspace and media root', outsideVideo.ok === false && where.test(outsideVideo.output), outsideVideo.output)
  check('replace_segment refuses the agent\'s private folders', privateVideo.ok === false && /受保护的目录/.test(privateVideo.output), privateVideo.output)
  check('replace_segment refuses a link that points outside', linked.ok === false && where.test(linked.output), linked.output)
  check('set_bgm refuses a file outside the workspace and media root', outsideAudio.ok === false && where.test(outsideAudio.output), outsideAudio.output)
  check('set_bgm accepts a workspace path (and then checks the file itself)', insideAudio.ok === false && !where.test(insideAudio.output), insideAudio.output)
  const listed = await run({ action: 'list_segments', projectId: 'p1' })
  check('executeEditTimeline returns an output string (and ok)', listed.ok === true && typeof listed.output === 'string' && listed.output.includes('"segments"'), listed)
  const failed = await run({ action: 'list_segments', projectId: 'nope' })
  check('a failure carries output and a structured error', failed.ok === false && typeof failed.output === 'string' && failed.error?.code === 'edit_timeline_failed', failed)
  const imported = await run({ action: 'import_long_video', projectId: 'missing-video' })
  const legacy = await run({ action: 'import_saga', projectId: 'p2', sagaProjectId: 'missing-video' })
  check('import_long_video takes projectId and says "long video", never the internal name',
    imported.ok === false && /长视频/.test(imported.output) && !/saga/i.test(imported.output), imported.output)
  check('import_saga / sagaProjectId still work as hidden aliases', legacy.ok === false && /长视频/.test(legacy.output) && legacy.action === 'import_long_video', legacy)
  const validate = (action: Record<string, unknown>) => registry.validateToolAction({ type: 'edit_timeline', ...action })
  check('registry: import_long_video needs projectId; the old alias still validates',
    validate({ action: 'import_long_video' }).length > 0 && validate({ action: 'import_long_video', projectId: 'a' }).length === 0 && validate({ action: 'import_saga', sagaProjectId: 'a' }).length === 0)
}

// ── B5: speech recognition setup ────────────────────────────────────────────
section('B5 STT')
{
  const { executeTranscribeAudio } = await import('../src/tools/transcribeAudio.js')
  const { mergeWizardSpeechEntry, wizardSttSetup } = await import('../src/cli/setupWizard.js')
  const ws = path.join(sandbox, 'stt-ws')
  fs.mkdirSync(ws, { recursive: true })
  fs.mkdirSync(resolveDataRootDir(ws), { recursive: true })
  fs.writeFileSync(path.join(ws, 'note.wav'), Buffer.alloc(64))
  fs.writeFileSync(path.join(resolveDataRootDir(ws), 'providers.json'), JSON.stringify({
    profiles: [],
    setup: { voice: { stt: { enabled: true, provider: 'platform', engine: 'auto' } } },
  }))
  // No platform speech entry in the global store.
  fs.writeFileSync(path.join(process.env.ARTEMIS_HOME!, 'providers.json'), JSON.stringify({ profiles: [] }))
  const missing = await executeTranscribeAudio({ type: 'transcribe_audio', inputPath: 'note.wav' }, { cwd: ws }).then((r) => r.output, (e: unknown) => String(e))
  check('provider "platform" without a platform config falls through to local Whisper', !/not implemented/.test(missing), missing)
  const local = await executeTranscribeAudio({ type: 'transcribe_audio', inputPath: 'note.wav', engine: 'whisper.cpp' }, { cwd: ws }).then((r) => r.output, (e: unknown) => String(e))
  check('provider "platform" with local Whisper asked for uses local Whisper', !/not implemented/.test(local), local)
  const platformEntry = { provider: 'platform' as const, enabled: true, baseUrl: 'https://gw.example/v1', apiKey: 'k', sttModel: 'm', managedBy: 'platform' as const }
  const wizardEntry = { provider: 'platform' as const, enabled: true, baseUrl: 'https://mine.example/v1', apiKey: 'mine', sttModel: 'asr', managedBy: 'user' as const }
  check('the wizard never merges into a platform-managed speech entry', mergeWizardSpeechEntry(platformEntry, wizardEntry) === undefined)
  check('the wizard replaces its own earlier entry and keeps other fields', mergeWizardSpeechEntry({ ...wizardEntry, ttsModel: 'tts', apiKey: 'old' }, wizardEntry)?.apiKey === 'mine' && mergeWizardSpeechEntry({ ...wizardEntry, ttsModel: 'tts' }, wizardEntry)?.ttsModel === 'tts')
  const stt = wizardSttSetup({ enabled: false, provider: 'local' }, { enabled: true, provider: 'platform', engine: 'auto', localModel: 'base', language: ' zh ' })
  check('the wizard writes the recognition language to setup.voice.stt.language', stt.language === 'zh' && stt.provider === 'platform' && stt.engine === 'auto')
  check('an empty language leaves the earlier one', wizardSttSetup({ enabled: true, provider: 'local', language: 'en' }, { enabled: true, provider: 'local', language: '' }).language === 'en')
}

// ── B7: artemis retry ───────────────────────────────────────────────────────
section('B7 artemis retry')
{
  const { runHeadlessAgent } = await import('../src/services/headlessAgent.js')
  const { runRetryCommand } = await import('../src/cli/retryCommand.js')
  const { settleMemoryCuration } = await import('../src/core/memory.js')
  const project = path.join(sandbox, 'retry-ws')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(resolveDataRootDir(project), { recursive: true })
  let replies = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      replies++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { content: JSON.stringify({ reply: `answer ${replies}`, done: true }) } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  fs.writeFileSync(path.join(resolveDataRootDir(project), 'providers.json'), JSON.stringify({
    defaultMainProfileId: 'mock',
    profiles: [{ id: 'mock', protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'mock-model' }],
  }))
  try {
    const first = await runHeadlessAgent(project, 'say hi', { maxTurns: 2, selfCheck: false, autoRoute: false })
    await settleMemoryCuration()
    const lines: string[] = []
    const retried = await runRetryCommand({ cwd: project, sessionId: first.sessionId, maxTurns: 2, onInfo: (message) => { lines.push(message) } })
    await settleMemoryCuration()
    check('retry returns the reply of the re-run', retried.ok && /^answer \d+/.test(retried.reply) && retried.reply !== first.reply && retried.retriedPrompt === 'say hi', retried)
    check('retry forwards progress lines like execute', lines.length > 0, lines)
    const cliSource = fs.readFileSync(path.join(repoRoot, 'src/cli/runCli.ts'), 'utf8')
    const retryBlock = cliSource.slice(cliSource.indexOf("options.command === 'retry'"), cliSource.indexOf("options.command === 'retry'") + 2500)
    check('the retry command prints result.reply and forwards onInfo', /console\.log\(result\.reply\)/.test(retryBlock) && /onInfo: \(message\) => console\.error\(oneLine\(message\)\)/.test(retryBlock))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// ── B9: MCP server requests ─────────────────────────────────────────────────
section('B9 MCP server requests')
{
  const { McpServerRequestRouter } = await import('../src/mcp/serverRequests.js')
  const routed = await new McpServerRequestRouter().route('ping', undefined, { serverId: 's', transport: 'stdio' } as never)
  check('ping is answered with an empty result', JSON.stringify(routed) === JSON.stringify({ result: {} }), routed)

  const { callMcpServerTool, closeCachedMcpClients } = await import('../src/mcp/client.js')
  const file = path.join(sandbox, 'ping-collide.mjs')
  // On tools/call id N, the server first sends its own request with the same id N
  // (a ping) and answers the call only after the client has replied to the ping.
  fs.writeFileSync(file, `
const write = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
let waiting
process.stdin.on('data', (c) => {
  buf += c
  for (;;) {
    const i = buf.indexOf('\\n')
    if (i < 0) return
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    if (msg.method === undefined) {
      if (waiting && msg.id === waiting.id) {
        write({ jsonrpc: '2.0', id: waiting.id, result: { content: [{ type: 'text', text: 'ping answered: ' + JSON.stringify(msg.result ?? msg.error) }] } })
        waiting = undefined
      }
      continue
    }
    if (msg.method === 'initialize') write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pinger', version: '1' } } })
    else if (msg.method === 'tools/list') write({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } })
    else if (msg.method === 'tools/call') { waiting = { id: msg.id }; write({ jsonrpc: '2.0', id: msg.id, method: 'ping' }) }
    else write({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
`)
  const server = { id: 'pinger', enabled: true, transport: 'stdio' as const, command: process.execPath, commandArgs: [file], authType: 'none' as const, authState: 'unknown' as const, createdAt: '', updatedAt: '' }
  try {
    const result = await callMcpServerTool({ server: server as never, cwd: sandbox, toolName: 'echo', args: {}, timeoutMs: 15_000 })
    check('a server request whose id equals our pending call is routed as a request (ping answered, then the real result)', result.output.includes('ping answered: {}'), result.output)
  } catch (error) {
    check('a server request whose id equals our pending call is routed as a request (ping answered, then the real result)', false, error instanceof Error ? error.message : String(error))
  } finally {
    await closeCachedMcpClients()
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
Object.assign(process.env, originalEnv)
fs.rmSync(sandbox, { recursive: true, force: true })
console.log(`\n  toolSafetySmoke: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
process.exit(0)
