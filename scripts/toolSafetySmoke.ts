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
  check('brain path: once approved, npm_run runs the script (without a shell)', ran.ok !== false && fs.existsSync(path.join(repo, 'RAN')) && asked.length === 1 && /npm run mark/.test(asked[0] ?? ''), { ran, asked })
}

{
  // The legacy think loop (chat bridges, the interactive CLI) ends the browser's turn too (tools/browser/fileGuard.ts).
  const { setBrowserWorkspace, browserWorkspaceSet } = await import('../src/tools/browser/fileGuard.js')
  setBrowserWorkspace(repo)
  await runThinkWithToolCalls(repo, [{ id: 'b1', name: 'calculate', args: { expression: '1+1' } }])
  check('brain path: the end of a think() turn closes the browser\'s workspace', browserWorkspaceSet() === false)
}

// ── think() on the opt-in runAgent path (#56/#66) ──────────────────────────
section('think(): legacy by default; the opt-in runAgent adapter is safe')
{
  const brainSource = fs.readFileSync(path.join(repoRoot, 'src/brain.ts'), 'utf8')
  const gate = brainSource.slice(brainSource.indexOf('function isBrainNewPathEnabled'), brainSource.indexOf('function isBrainNewPathEnabled') + 300)
  check('the runAgent-backed think() is opt-in (#66 reverted)', /return process\.env\.ARTEMIS_BRAIN_NEW === '1'/.test(gate), gate)
  const ws = path.join(sandbox, 'adapter-ws')
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'hello.txt'), 'hi\n')
  process.env.ARTEMIS_BRAIN_NEW = '1'
  try {
    const lines: string[] = []
    const calls: string[] = []
    let error: unknown
    await runThinkWithToolCalls(ws, [{ id: 'r1', name: 'read_file', args: { path: 'hello.txt' } }], {
      onToolLog: (message: string) => { lines.push(message) },
      onToolCall: (name: string) => { calls.push(name) },
    }).catch((e: unknown) => { error = e })
    check('ARTEMIS_BRAIN_NEW=1: think() runs through runAgent without crashing (the session has its cwd)', error === undefined, error instanceof Error ? error.stack : String(error))
    check('ARTEMIS_BRAIN_NEW=1: the [tool:] lines reach the caller', lines.some((line) => line.startsWith('[tool:read_file] running')) && calls.includes('read_file'), lines)
    const controller = new AbortController()
    controller.abort()
    let stopped: unknown
    const aborted = await runThinkWithToolCalls(ws, [{ id: 'r2', name: 'read_file', args: { path: 'hello.txt' } }], { abortSignal: controller.signal }).catch((e: unknown) => { stopped = e; return [] })
    check('ARTEMIS_BRAIN_NEW=1: the caller\'s abortSignal stops the run (no tool runs)', aborted.length === 0, { stopped: String(stopped) })
  } finally {
    delete process.env.ARTEMIS_BRAIN_NEW
  }
}

// ── N1: git runs none of the repository's code; file tools never write git's control files ──
section('N1 git config, hooks and filters')
{
  const evil = path.join(sandbox, 'evil-repo')
  fs.mkdirSync(evil, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: evil, env: gitEnv })
  fs.writeFileSync(path.join(evil, 'a.txt'), 'a\n')
  execFileSync('git', ['add', 'a.txt'], { cwd: evil, env: gitEnv })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: evil, env: gitEnv })
  // A program that only leaves a marker (and passes stdin through, as a filter would).
  const marker = (name: string) => path.join(sandbox, `marker-${name}`)
  const script = (name: string) => {
    const file = path.join(sandbox, `planted-${name}.sh`)
    fs.writeFileSync(file, `#!/bin/sh\ntouch "${marker(name)}"\ncat\n`, { mode: 0o755 })
    return file
  }
  const config = (key: string, value: string) => execFileSync('git', ['config', key, value], { cwd: evil, env: gitEnv })
  config('core.fsmonitor', script('fsmonitor'))
  config('diff.external', script('external'))
  config('filter.evil.clean', script('clean'))
  config('filter.evil.smudge', script('smudge'))
  fs.writeFileSync(path.join(evil, '.gitattributes'), '*.txt filter=evil\n')
  fs.mkdirSync(path.join(evil, '.git', 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(evil, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${marker('hook')}"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(evil, 'a.txt'), 'changed\n')
  // The planted config really runs code with plain git (so the checks below mean something).
  execFileSync('git', ['status', '--short'], { cwd: evil, env: gitEnv, stdio: 'pipe' })
  execFileSync('git', ['diff'], { cwd: evil, env: gitEnv, stdio: 'pipe' })
  const planted = ['fsmonitor', 'external', 'clean'].filter((name) => fs.existsSync(marker(name)))
  check('precondition: plain git runs the planted fsmonitor, diff.external and clean filter', planted.length === 3, planted)
  for (const name of ['fsmonitor', 'external', 'clean', 'smudge', 'hook']) fs.rmSync(marker(name), { force: true })

  const status = await extras.executeExtraTool('git_status', {}, evil)
  check('git_status with core.fsmonitor planted in .git/config creates no marker', status.ok && !fs.existsSync(marker('fsmonitor')), status.output)
  const diff = await extras.executeExtraTool('git_diff', {}, evil)
  check('git_diff runs no diff.external and no clean filter', diff.ok && !fs.existsSync(marker('external')) && !fs.existsSync(marker('clean')) && !fs.existsSync(marker('fsmonitor')), diff.output)
  const add = await extras.executeExtraTool('git_add', { paths: ['a.txt'] }, evil)
  check('git_add refuses while filter drivers are declared (nothing ran)', !add.ok && /filter drivers \(evil\)/.test(add.output) && !fs.existsSync(marker('clean')), add.output)
  const branch = await extras.executeExtraTool('git_branch', { checkout: 'main' }, evil)
  check('git_branch checkout refuses while filter drivers are declared', !branch.ok && /filter drivers/.test(branch.output) && !fs.existsSync(marker('smudge')), branch.output)
  execFileSync('git', ['config', '--unset', 'filter.evil.clean'], { cwd: evil, env: gitEnv })
  execFileSync('git', ['config', '--unset', 'filter.evil.smudge'], { cwd: evil, env: gitEnv })
  const staged = await extras.executeExtraTool('git_add', { paths: ['a.txt'] }, evil)
  const commit = await extras.executeExtraTool('git_commit', { message: 'no hooks' }, evil)
  check('git_commit runs no hook from .git/hooks (and still commits)', staged.ok && commit.ok && !fs.existsSync(marker('hook')) && !fs.existsSync(marker('fsmonitor')), { staged: staged.output, commit: commit.output })
  check('the safety options switch off fsmonitor, hooks, diff.external and the global attributes file',
    ['--no-pager', 'core.fsmonitor=false', 'diff.external='].every((option) => extras.gitSafetyOptions().includes(option)) &&
      extras.gitSafetyOptions().some((option) => option.startsWith('core.hooksPath=')) &&
      extras.gitSafetyOptions().some((option) => option.startsWith('core.attributesFile=')) &&
      extras.gitSafetyOptions(['lfs']).includes('filter.lfs.process='))

  const { executeWriteFile } = await import('../src/tools/writeFile.js')
  const { executeReplaceInFile } = await import('../src/tools/replaceInFile.js')
  const { executeApplyPatch } = await import('../src/tools/applyPatch.js')
  const refused = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      const result = (await run()) as { ok?: boolean; output?: string }
      return result?.ok === false ? String(result.output) : `NOT REFUSED: ${JSON.stringify(result).slice(0, 200)}`
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const denied = /git's own config, hooks or attributes/
  for (const mode of ['ask', 'full-access'] as const) {
    const ctx = { cwd: evil, permissionMode: mode } as never
    const hook = await refused(() => executeWriteFile({ type: 'write_file', path: '.git/hooks/pre-commit', content: '#!/bin/sh\n' } as never, ctx))
    const cfg = await refused(() => executeWriteFile({ type: 'write_file', path: '.git/config', content: '[core]\n' } as never, ctx))
    const attrs = await refused(() => executeWriteFile({ type: 'write_file', path: '.git/info/attributes', content: '* filter=x\n' } as never, ctx))
    const replace = await refused(() => executeReplaceInFile({ type: 'replace_in_file', path: '.git/config', find: '[core]', replace: '[core]\n\tfsmonitor = x' } as never, ctx))
    const patch = await refused(() => executeApplyPatch({ type: 'apply_patch', patch: '*** Begin Patch\n*** Add File: .git/hooks/post-checkout\n+#!/bin/sh\n*** End Patch' } as never, ctx))
    check(`${mode}: write_file / replace_in_file / apply_patch refuse .git/hooks, .git/config and .git/info/attributes`,
      [hook, cfg, attrs, replace, patch].every((message) => denied.test(message)), { hook, cfg, attrs, replace, patch })
  }
  fs.symlinkSync(path.join(evil, '.git', 'hooks'), path.join(evil, 'hooklink'))
  const viaLink = await refused(() => executeWriteFile({ type: 'write_file', path: 'hooklink/post-merge', content: '#!/bin/sh\n' } as never, { cwd: evil, permissionMode: 'full-access' } as never))
  check('a symlink into .git/hooks is caught too', denied.test(viaLink), viaLink)
  const extraWrites = [
    await extras.executeExtraTool('create_directory', { path: '.git/hooks/sub' }, evil, 'full-access'),
    await extras.executeExtraTool('copy_file', { from: 'a.txt', to: '.git/config' }, evil, 'full-access'),
    await extras.executeExtraTool('move_file', { from: 'a.txt', to: '.git/hooks/pre-push' }, evil, 'full-access'),
  ]
  check('file extras refuse git control files as well', extraWrites.every((r) => !r.ok && denied.test(r.output)), extraWrites.map((r) => r.output))
  check('an ordinary file next to .git is still writable',
    (await executeWriteFile({ type: 'write_file', path: 'notes/git-config.md', content: 'ok\n' } as never, { cwd: evil, permissionMode: 'ask' } as never)).ok === true)
}

// ── N1b: signing programs and other program-running keys in the repository's config ──
section('N1b git signing programs and other program keys')
{
  const repo2 = path.join(sandbox, 'sign-repo')
  fs.mkdirSync(repo2, { recursive: true })
  // Hermetic: the machine's own global/system git config (its signing setup) stays out.
  const emptyGlobal = path.join(sandbox, 'empty.gitconfig')
  fs.writeFileSync(emptyGlobal, '')
  const savedGitEnv = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }
  process.env.GIT_CONFIG_GLOBAL = emptyGlobal
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const signEnv = { ...gitEnv, GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: '1' }
  try {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo2, env: signEnv, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo2, 'a.txt'), 'a\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'init')
  const marker = (name: string) => path.join(sandbox, `sign-marker-${name}`)
  const script = (name: string) => {
    const file = path.join(sandbox, `sign-planted-${name}.sh`)
    fs.writeFileSync(file, `#!/bin/sh\ntouch "${marker(name)}"\nexit 1\n`, { mode: 0o755 })
    return file
  }
  let counter = 0
  const stageChange = () => {
    fs.writeFileSync(path.join(repo2, 'a.txt'), `change ${++counter}\n`)
    git('add', 'a.txt')
  }
  // Precondition: a signed commit really runs a repository-level gpg.program.
  git('config', 'commit.gpgSign', 'true')
  git('config', 'gpg.program', script('pre'))
  stageChange()
  try { git('commit', '-q', '-m', 'signed') } catch { /* the planted program fails the signature */ }
  check('precondition: plain git runs a repository-level gpg.program on a signed commit', fs.existsSync(marker('pre')))
  git('config', '--unset', 'gpg.program')

  const keys = ['gpg.program', 'gpg.openpgp.program', 'gpg.x509.program', 'gpg.ssh.program', 'gpg.ssh.defaultKeyCommand']
  for (const key of keys) {
    const name = key.replace(/\W/g, '_')
    git('config', key, script(name))
    if (key.startsWith('gpg.x509')) git('config', 'gpg.format', 'x509')
    if (key.startsWith('gpg.ssh')) git('config', 'gpg.format', 'ssh')
    stageChange()
    const result = await extras.executeExtraTool('git_commit', { message: `with ${key}` }, repo2)
    check(`git_commit refuses while the repository sets ${key} (nothing ran)`,
      !result.ok && /signing programs/.test(result.output) && /run_command/.test(result.output) && !fs.existsSync(marker(name)), result.output)
    git('config', '--unset', key)
    try { git('config', '--unset', 'gpg.format') } catch { /* not set */ }
  }
  // Through an include in the local config.
  const included = path.join(sandbox, 'included.gitconfig')
  fs.writeFileSync(included, `[gpg]\n\tprogram = ${script('included')}\n`)
  git('config', 'include.path', included)
  stageChange()
  const viaInclude = await extras.executeExtraTool('git_commit', { message: 'via include' }, repo2)
  check('a signing program reached through include.path is refused too', !viaInclude.ok && /signing programs/.test(viaInclude.output) && !fs.existsSync(marker('included')), viaInclude.output)
  git('config', '--unset', 'include.path')
  git('config', '--unset', 'commit.gpgSign')

  // The owner's own global signing setup is left alone.
  const globalConfig = path.join(sandbox, 'owner.gitconfig')
  fs.writeFileSync(globalConfig, `[gpg]\n\tprogram = ${script('owner')}\n`)
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  try {
    stageChange()
    const owner = await extras.executeExtraTool('git_commit', { message: 'owner signing config' }, repo2)
    check('a gpg.program in the owner\'s global config does not block git_commit', owner.ok, owner.output)
  } finally {
    process.env.GIT_CONFIG_GLOBAL = emptyGlobal
  }

  // Keys the extras never reach (or switch off): planted, nothing runs.
  for (const [key, name] of [['core.pager', 'pager'], ['core.editor', 'editor'], ['sequence.editor', 'seqeditor'], ['core.sshCommand', 'ssh'], ['core.askPass', 'askpass'], ['credential.helper', 'credential'], ['merge.evil.driver', 'merge'], ['diff.evil.command', 'diffcmd']] as const) {
    git('config', key, script(name))
  }
  fs.writeFileSync(path.join(repo2, '.gitattributes'), '*.txt merge=evil diff=evil\n')
  fs.writeFileSync(path.join(repo2, 'a.txt'), 'worktree change\n')
  const runs = [
    await extras.executeExtraTool('git_log', { limit: 3 }, repo2),
    await extras.executeExtraTool('git_status', {}, repo2),
    await extras.executeExtraTool('git_diff', {}, repo2),
    await extras.executeExtraTool('git_branch', {}, repo2),
  ]
  git('add', '.gitattributes', 'a.txt')
  runs.push(await extras.executeExtraTool('git_commit', { message: 'no editor, no pager' }, repo2))
  runs.push(await extras.executeExtraTool('git_branch', { create: 'side' }, repo2))
  runs.push(await extras.executeExtraTool('git_branch', { checkout: 'main' }, repo2))
  const ran = ['pager', 'editor', 'seqeditor', 'ssh', 'askpass', 'credential', 'merge', 'diffcmd'].filter((name) => fs.existsSync(marker(name)))
  check('core.pager, core.editor, sequence.editor, core.sshCommand, core.askPass, credential.helper, merge and diff command drivers: planted, nothing runs',
    ran.length === 0 && runs.every((r) => r.ok), { ran, outputs: runs.filter((r) => !r.ok).map((r) => r.output) })
  } finally {
    for (const [key, value] of [['GIT_CONFIG_GLOBAL', savedGitEnv.global], ['GIT_CONFIG_NOSYSTEM', savedGitEnv.nosystem]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ── N1c: no git extra descends into a submodule (its own config can declare filters) ──
section('N1c submodules: their own filter drivers never run')
{
  const emptyGlobal = path.join(sandbox, 'sub-empty.gitconfig')
  fs.writeFileSync(emptyGlobal, '')
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }
  process.env.GIT_CONFIG_GLOBAL = emptyGlobal
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const env = { ...gitEnv, GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: '1' }
  try {
    const upstream = path.join(sandbox, 'sub-upstream')
    const outer = path.join(sandbox, 'sub-outer')
    for (const dir of [upstream, outer]) fs.mkdirSync(dir, { recursive: true })
    const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' })
    run(upstream, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(upstream, 'inner.txt'), 'inner\n')
    run(upstream, 'add', 'inner.txt')
    run(upstream, 'commit', '-q', '-m', 'inner')
    run(outer, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(outer, 'top.txt'), 'top\n')
    run(outer, 'add', 'top.txt')
    run(outer, 'commit', '-q', '-m', 'top')
    run(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'sub')
    run(outer, 'commit', '-q', '-m', 'add sub')
    const subDir = path.join(outer, 'sub')
    const marker = path.join(sandbox, 'sub-marker-clean')
    const filter = path.join(sandbox, 'sub-filter.sh')
    fs.writeFileSync(filter, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 })
    // The submodule's own config (.git/modules/sub/config) declares the driver; its worktree uses it.
    run(subDir, 'config', 'filter.evil.clean', filter)
    fs.writeFileSync(path.join(subDir, '.gitattributes'), '*.txt filter=evil\n')
    // Same size, new mtime: git has to hash the file (through the clean filter) to know whether it changed.
    fs.writeFileSync(path.join(subDir, 'inner.txt'), 'inner\n')
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(path.join(subDir, 'inner.txt'), later, later)
    fs.writeFileSync(path.join(outer, 'top.txt'), 'top changed\n')
    run(outer, 'status', '--short')
    check('precondition: plain git status in the outer repository runs the submodule\'s clean filter', fs.existsSync(marker))
    fs.rmSync(marker, { force: true })
    const ran: string[] = []
    const results: Array<{ ok: boolean; output: string }> = []
    for (const [name, input] of [['git_status', {}], ['git_diff', {}], ['git_add', { paths: ['.'] }], ['git_commit', { message: 'outer only' }], ['git_log', { limit: 2 }]] as const) {
      fs.utimesSync(path.join(subDir, 'inner.txt'), later, new Date(later.getTime() + results.length * 1000))
      results.push(await extras.executeExtraTool(name, input, outer))
      if (fs.existsSync(marker)) ran.push(name)
      fs.rmSync(marker, { force: true })
    }
    check('git_status, git_diff, git_add, git_commit and git_log never run a submodule\'s own filter driver',
      results.every((r) => r.ok) && ran.length === 0, { ran, outputs: results.filter((r) => !r.ok).map((r) => r.output.slice(0, 200)) })
    check('the safety options keep git out of submodules',
      ['submodule.recurse=false', 'diff.ignoreSubmodules=all', 'status.submoduleSummary=false'].every((option) => extras.gitSafetyOptions().includes(option)))
  } finally {
    for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ── N4: Windows program resolution ──────────────────────────────────────────
section('N4 Windows programs never come from the working directory')
{
  const present = new Set(['C:\\ws\\git.exe', 'C:\\ws\\bin\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Windows\\System32\\where.exe'])
  const env = { path: '.;C:\\ws;bin;;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32', cwd: 'C:\\ws', exists: (file: string) => present.has(file) }
  check('git resolves to the PATH copy, skipping ".", the working directory and relative entries',
    extras.resolveWindowsProgram('git', env) === 'C:\\Program Files\\Git\\cmd\\git.exe', extras.resolveWindowsProgram('git', env))
  check('a program only in the working directory is not found', extras.resolveWindowsProgram('evil', { ...env, exists: (f: string) => f === 'C:\\ws\\evil.exe' }) === undefined)
  check('where resolves to System32', extras.resolveWindowsProgram('where', env) === 'C:\\Windows\\System32\\where.exe')
  const source = fs.readFileSync(path.join(repoRoot, 'src/tools/extras.ts'), 'utf8')
  check('child processes on Windows get NoDefaultCurrentDirectoryInExePath=1', /NoDefaultCurrentDirectoryInExePath: '1'/.test(source))
}

// ── N3: check_url / download_file use the shared SSRF guard ─────────────────
section('N3 check_url and download_file SSRF guard')
{
  const guard = await import('../src/tools/visual/safeDownload.js')
  const blocked = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '198.19.255.255', '0.0.0.0',
    '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1', '64:ff9b:1::a9fe:a9fe', '2002:7f00:1::1', '2002:c0a8:101::1']
  const allowed = ['8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '64:ff9b::808:808', '2002:808:808::1']
  const wrongBlocked = blocked.filter((a) => !guard.isNonPublicAddress(a))
  const wrongAllowed = allowed.filter((a) => guard.isNonPublicAddress(a))
  check('loopback, RFC1918, link-local, CGNAT, 198.18/15, ULA, and NAT64/6to4/mapped forms of private v4 are blocked; public ones pass',
    wrongBlocked.length === 0 && wrongAllowed.length === 0, { wrongBlocked, wrongAllowed })

  let hits = 0
  const local = http.createServer((_req, res) => { hits++; res.writeHead(200).end('secret') })
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', () => resolve()))
  const port = (local.address() as { port: number }).port
  const ws = path.join(sandbox, 'net-ws')
  fs.mkdirSync(ws, { recursive: true })
  try {
    const head = await extras.executeExtraTool('check_url', { url: `http://127.0.0.1:${port}/` }, ws)
    const down = await extras.executeExtraTool('download_file', { url: `http://127.0.0.1:${port}/x`, destination: 'x.bin' }, ws)
    const v6 = await extras.executeExtraTool('check_url', { url: `http://[::ffff:127.0.0.1]:${port}/` }, ws)
    check('check_url / download_file refuse a loopback URL and never reach it', !head.ok && !down.ok && !v6.ok && hits === 0 && !fs.existsSync(path.join(ws, 'x.bin')), { head: head.output, down: down.output, v6: v6.output, hits })

    const seen: string[] = []
    guard.setAssetDownloadResolverForTests(async (host) => {
      seen.push(host)
      if (host === 'public.test') return [{ address: '93.184.216.34', family: 4 }]
      if (host === 'rebind.test') return [{ address: '10.0.0.5', family: 4 }]
      return [{ address: '127.0.0.1', family: 4 }]
    })
    const connected: string[] = []
    guard.setAssetDownloadTransportForTests(async (url, { lookup, method }) => {
      // The connection resolves through the guarded lookup: the checked address is the one used.
      const address = await new Promise<string>((resolve, reject) => lookup(url.hostname, {}, (error: Error | null, addr: string) => (error ? reject(error) : resolve(addr))))
      connected.push(`${method ?? 'GET'} ${url.hostname}=${address}`)
      if (url.pathname === '/redirect-private') return { status: 302, location: 'http://internal.test/admin', body: Buffer.alloc(0) }
      if (url.pathname === '/redirect-literal') return { status: 301, location: 'http://169.254.169.254/latest/meta-data/', body: Buffer.alloc(0) }
      return { status: 200, statusText: 'OK', contentType: 'text/plain', body: Buffer.from('public body') }
    })
    const okHead = await extras.executeExtraTool('check_url', { url: 'http://public.test/' }, ws)
    const okDown = await extras.executeExtraTool('download_file', { url: 'http://public.test/file.txt', destination: 'file.txt' }, ws)
    check('a public host is checked with HEAD and downloaded through the checked address',
      okHead.ok && okDown.ok && fs.readFileSync(path.join(ws, 'file.txt'), 'utf8') === 'public body' && connected.includes('HEAD public.test=93.184.216.34'), { okHead: okHead.output, okDown: okDown.output, connected })
    const rebind = await extras.executeExtraTool('check_url', { url: 'http://rebind.test/' }, ws)
    const redirected = await extras.executeExtraTool('download_file', { url: 'http://public.test/redirect-private', destination: 'r1.bin' }, ws)
    const literal = await extras.executeExtraTool('check_url', { url: 'http://public.test/redirect-literal' }, ws)
    check('a host resolving to a private address is refused; every redirect hop is checked again (name and IP literal)',
      !rebind.ok && /10\.0\.0\.5/.test(rebind.output) && !redirected.ok && /127\.0\.0\.1/.test(redirected.output) && !literal.ok && /169\.254\.169\.254/.test(literal.output) && !fs.existsSync(path.join(ws, 'r1.bin')),
      { rebind: rebind.output, redirected: redirected.output, literal: literal.output })
  } finally {
    guard.setAssetDownloadResolverForTests(undefined)
    guard.setAssetDownloadTransportForTests(undefined)
    await new Promise<void>((resolve) => local.close(() => resolve()))
  }
}

// ── A3: get_env ──────────────────────────────────────────────────────────────
section('A3 get_env')
{
  process.env.SMOKE_API_KEY = 'sk-should-not-leak'
  process.env.SMOKE_GITHUB_TOKEN = 'ghp-should-not-leak'
  process.env.SMOKE_PLAIN = 'visible-value'
  process.env.DATABASE_URL = 'postgres://u:pw@h/db'
  process.env.GITHUB_PAT = 'github_pat_should_not_leak'
  const single = await extras.executeExtraTool('get_env', { key: 'SMOKE_API_KEY' }, sandbox)
  const many = await extras.executeExtraTool('get_env', { keys: ['SMOKE_GITHUB_TOKEN', 'SMOKE_PLAIN'] }, sandbox)
  const all = await extras.executeExtraTool('get_env', {}, sandbox)
  check('a secret-looking name is hidden when asked for by key', !single.output.includes('sk-should-not-leak') && /hidden/.test(single.output), single.output)
  check('a secret-looking name is hidden in keys; a plain one is returned', !many.output.includes('ghp-should-not-leak') && many.output.includes('visible-value'), many.output)
  check('the listing never shows secret-looking names', !all.output.includes('should-not-leak'))
  const url = await extras.executeExtraTool('get_env', { keys: ['DATABASE_URL', 'GITHUB_PAT', 'PATH'] }, sandbox)
  check('DATABASE_URL with a login and GITHUB_PAT are hidden; PATH is not mistaken for a PAT',
    !url.output.includes('u:pw@') && !url.output.includes('github_pat_should_not_leak') && JSON.parse(url.output).PATH === process.env.PATH, url.output)
  check('a credentialed URL value is hidden under any name, and so are CONN/CRED/DSN names',
    extras.isCredentialedUrlValue('redis://:s3cret@cache:6379') && !extras.isCredentialedUrlValue('https://example.com/a@b') &&
      ['DB_CONN', 'AWS_CRED', 'SENTRY_DSN', 'GITHUB_PAT'].every((name) => extras.isSecretEnvName(name)) && !extras.isSecretEnvName('PATH') && !extras.isSecretEnvName('NODE_PATH'))
  const listing = await extras.executeExtraTool('get_env', {}, sandbox)
  check('the listing hides credentialed URL values', !listing.output.includes('u:pw@'))
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
