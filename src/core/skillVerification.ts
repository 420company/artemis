/**
 * core/skillVerification.ts — the evidence a learned skill may rest on.
 *
 * Three judgments the skill learner (core/skillLearning.ts) makes:
 *
 *   classifyRunnerCommand()  is this shell command a real test/build/lint
 *                            run whose exit status reaches us intact?
 *   replyReportsFailure()    does the agent's own reply admit a failure?
 *   classifyUserFeedback()   is the user's next message clearly approving
 *                            or clearly rejecting the previous result?
 *
 * All three err on the side of "no": a missed skill costs little, a skill
 * learned from a failure or from a misread complaint costs a lot. The
 * general-purpose isVerificationCommand() in core/verification.ts is far
 * looser (any command mentioning "test" or "check") and is not used here.
 */

import path from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

// ── shell commands ─────────────────────────────────────────────────────────

type Separator = '&&' | '||' | '|' | ';' | '&' | 'end'

interface ShellSegment {
  text: string
  /** Operator that follows this segment. */
  next: Separator
}

/**
 * Split a command line at top-level control operators, respecting quotes,
 * escapes, $(…)/`…` and (…) groups. Redirections such as 2>&1 or &> are
 * not operators.
 */
export function splitShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = []
  let current = ''
  let quote: '"' | "'" | '`' | null = null
  let depth = 0
  const push = (next: Separator): void => {
    segments.push({ text: current.trim(), next })
    current = ''
  }
  for (let index = 0; index < command.length; index++) {
    const ch = command[index]!
    const nextCh = command[index + 1]
    if (quote) {
      current += ch
      if (ch === '\\' && quote !== "'" && nextCh !== undefined) {
        current += nextCh
        index++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '\\' && nextCh !== undefined) {
      current += ch + nextCh
      index++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth > 0) {
      current += ch
      continue
    }
    if (ch === '\n' || ch === ';') {
      push(';')
      continue
    }
    if (ch === '&') {
      const prev = command[index - 1]
      if (prev === '>' || prev === '<' || nextCh === '>') {
        current += ch // 2>&1, &>file, >&2
        continue
      }
      if (nextCh === '&') {
        push('&&')
        index++
      } else {
        push('&')
      }
      continue
    }
    if (ch === '|') {
      if (nextCh === '|') {
        push('||')
        index++
      } else {
        if (nextCh === '&') index++ // |& pipes stderr too
        push('|')
      }
      continue
    }
    current += ch
  }
  push('end')
  return segments.filter((segment, index) => segment.text || index === segments.length - 1)
}

/** npm/pnpm/yarn/bun scripts that run checks. */
const CHECK_SCRIPT_RE = /^(?:test|tests|t|tst|lint|build|typecheck|type-check|tsc|check|verify|ci|e2e|unit|spec|smoke)(?:[:._-][\w:.-]*)?$/i
/** Check tools run directly or through npx/pnpm exec/yarn dlx/bunx. */
const CHECK_TOOL_RE = /^(?:vitest|jest|tsc|vue-tsc|eslint|mocha|ava|tap|biome|stylelint|svelte-check|jasmine|karma|nyc|c8)$/
const PREFIX_WORDS = new Set(['sudo', 'time', 'env', 'nice', 'command', 'exec', 'nohup'])
/**
 * Flags that make a runner print information, list, scaffold or skip work
 * instead of checking anything: `tsc --version`, `jest --listTests`,
 * `jest --passWithNoTests`, `pytest --collect-only`, `npm test --if-present`.
 */
const INFO_ONLY_FLAGS = new Set([
  '--version', '-V', '--help', '-h', '-?', '--init', '--listTests', '--list-tests', '--collect-only', '--co',
  '--passWithNoTests', '--pass-with-no-tests', '--if-present', '--dry-run', '--dryrun', '--showConfig', '--show-config',
  '--print-config', '--just-print', '--list', '--listFiles', '--list-files', '--noop', '--no-run',
])
/** Tools where -v means verbose; everywhere else (rspec, jest, eslint, tsc, …) it means --version. */
const VERBOSE_V_TOOLS = new Set([
  'pytest', 'py.test', 'go', 'cargo', 'dotnet', 'node', 'phpunit', 'ctest', 'tox', 'nox', 'mix', 'flutter', 'deno', 'swift',
  'ruff', 'mypy', 'flake8', 'pylint',
])
/** One statement of a package script that does nothing worth calling a check. */
const TRIVIAL_STATEMENT_RE =
  /^(?:|true|:|exit(?:\s+0)?|echo\b.*|printf\b.*|node\s+-e\s+(["'])\s*(?:process\.exit\(\s*0?\s*\)\s*;?\s*)?\1|node\s+-e\s*(["'])\s*\2)$/
const NO_TEST_RE = /no test specified|--passWithNoTests|--pass-with-no-tests/i

/** Where a check runs: the run's working directory, for package scripts and test paths. */
export interface RunnerContext {
  cwd?: string
}

function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^['"]|['"]$/g, ''))
}

function basenameOf(word: string): string {
  return word.replace(/^.*[\\/]/, '')
}

function firstPositional(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'))
}

interface PackageInfo {
  name?: string
  scripts: Record<string, string>
  workspaces: string[]
}

const packageCache = new Map<string, { mtimeMs: number; info: PackageInfo | null }>()

/** package.json of a directory (cached by mtime); null when there is none or it is unreadable. */
function packageInfo(dir: string): PackageInfo | null {
  const file = path.join(dir, 'package.json')
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return null
  }
  const cached = packageCache.get(file)
  if (cached && cached.mtimeMs === mtimeMs) return cached.info
  let info: PackageInfo | null = null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; scripts?: Record<string, unknown>; workspaces?: unknown }
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
      : (parsed.workspaces && typeof parsed.workspaces === 'object' && Array.isArray((parsed.workspaces as { packages?: unknown }).packages))
        ? (parsed.workspaces as { packages: unknown[] }).packages
        : []
    info = {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      scripts: Object.fromEntries(Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      workspaces: workspaces.filter((entry): entry is string => typeof entry === 'string'),
    }
  } catch {
    info = null
  }
  packageCache.set(file, { mtimeMs, info })
  return info
}

/** Workspace package directories of a monorepo root (package.json workspaces, pnpm-workspace.yaml). */
function workspaceDirs(root: string): string[] {
  const patterns = [...(packageInfo(root)?.workspaces ?? [])]
  try {
    const yaml = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
    for (const match of yaml.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)) patterns.push(match[1]!)
  } catch { /* not a pnpm workspace */ }
  // No declared workspaces: the conventional layouts.
  if (patterns.length === 0) patterns.push('packages/*', 'apps/*', 'libs/*', 'services/*')
  const dirs = new Set<string>()
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue
    const clean = pattern.replace(/\/\*\*?$/, '').replace(/\/$/, '')
    const base = path.resolve(root, clean)
    if (/\/\*\*?$/.test(pattern)) {
      try {
        for (const entry of readdirSync(base)) {
          const dir = path.join(base, entry)
          if (packageInfo(dir)) dirs.add(dir)
          if (dirs.size >= 200) break
        }
      } catch { /* missing dir */ }
    } else if (packageInfo(base)) {
      dirs.add(base)
    }
  }
  return [...dirs]
}

/** Workspace packages a selector names: a path, a package name, or a simple name glob. */
function selectWorkspaces(root: string, selector: string): string[] {
  const cleaned = selector.replace(/^\{|\}$/g, '').replace(/\.\.\.$|^\.\.\./g, '')
  const asPath = path.resolve(root, cleaned)
  if (packageInfo(asPath) && (cleaned.startsWith('.') || cleaned.includes('/'))) return [asPath]
  const pattern = new RegExp(`^${cleaned.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  return workspaceDirs(root).filter((dir) => {
    const name = packageInfo(dir)?.name ?? ''
    return pattern.test(name) || pattern.test(name.replace(/^@[^/]+\//, '')) || pattern.test(path.relative(root, dir))
  })
}

/**
 * The package script exists and its body actually runs something: not
 * empty, not only echo/true/exit 0/`node -e "process.exit(0)"` statements,
 * no info-only flags; a body that calls other scripts must reach a real one.
 */
function realScript(dir: string, name: string, depth: number): boolean {
  const body = packageInfo(dir)?.scripts[name]
  if (body === undefined || NO_TEST_RE.test(body)) return false
  const statements = splitShellSegments(body).map((segment) => segment.text.trim())
  if (statements.every((statement) => TRIVIAL_STATEMENT_RE.test(statement))) return false
  if (words(body).some((word) => INFO_ONLY_FLAGS.has(word))) return false
  const nested = classifyRunnerCommand(body, { cwd: dir }, depth + 1)
  return nested.runner || !/\b(?:npm|pnpm|yarn|bun|turbo|nx|lerna)\s+(?:run\s+)?\S+/.test(body)
}

function realScriptIn(dirs: string[], name: string, depth: number): boolean {
  return dirs.some((dir) => realScript(dir, name, depth))
}

function hasEntries(target: string): boolean {
  try {
    const info = statSync(target)
    return info.isFile() || (info.isDirectory() && readdirSync(target).length > 0)
  } catch {
    return false
  }
}

/** Parsed npm/pnpm/yarn/bun invocation: subcommand, its arguments, and where it runs. */
interface PackageManagerCall {
  sub?: string
  rest: string[]
  dir: string
  /** Workspace packages it runs in (null: the target dir itself). */
  workspaces: string[] | null
}

const PM_VALUE_FLAGS: Record<string, Set<string>> = {
  npm: new Set(['--prefix', '-C', '-w', '--workspace', '--userconfig', '--cache', '--registry', '--loglevel']),
  pnpm: new Set(['-C', '--dir', '--filter', '-F', '--workspace-concurrency', '--reporter', '--loglevel']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd', '--filter', '-F']),
}

function parsePackageManager(head: string, args: string[], cwd: string): PackageManagerCall {
  const valueFlags = PM_VALUE_FLAGS[head] ?? new Set<string>()
  let dir = cwd
  const selectors: string[] = []
  let all = false
  let sub: string | undefined
  const rest: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (sub !== undefined) {
      rest.push(arg)
      continue
    }
    const [flag, inline] = arg.includes('=') && arg.startsWith('-') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (valueFlags.has(flag)) {
      const value = inline ?? args[++index] ?? ''
      if (['--prefix', '-C', '--dir', '--cwd'].includes(flag)) dir = path.resolve(dir, value)
      else if (['-w', '--workspace', '--filter', '-F'].includes(flag)) selectors.push(value)
      continue
    }
    if (['--workspaces', '-ws', '-r', '--recursive'].includes(flag)) {
      all = true
      continue
    }
    if (arg.startsWith('-')) continue
    sub = arg
  }
  // Flags after the subcommand (npm test -w a, npm run lint --workspaces).
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!
    if (arg === '--') break
    if (head === 'npm' && (arg === '-w' || arg === '--workspace')) selectors.push(rest[index + 1] ?? '')
    else if (head === 'npm' && arg.startsWith('--workspace=')) selectors.push(arg.slice('--workspace='.length))
    else if (arg === '--workspaces' || arg === '-ws' || (head === 'pnpm' && (arg === '-r' || arg === '--recursive'))) all = true
  }
  const workspaces = selectors.length > 0
    ? selectors.flatMap((selector) => selectWorkspaces(dir, selector))
    : all ? workspaceDirs(dir) : null
  return { sub, rest, dir, workspaces }
}

/** The task names a turbo/nx/lerna invocation runs, when they are check tasks. */
function monorepoTasks(head: string, args: string[]): string[] {
  const positional = args.filter((arg) => !arg.startsWith('-'))
  if (head === 'turbo') return positional[0] === 'run' ? positional.slice(1) : positional.slice(0, 1)
  if (head === 'lerna') return positional[0] === 'run' ? positional.slice(1, 2) : []
  if (head === 'nx') {
    const targets: string[] = []
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!
      if (arg === '-t' || arg === '--target' || arg === '--targets') targets.push(...(args[index + 1] ?? '').split(','))
      else if (/^--targets?=/.test(arg)) targets.push(...arg.slice(arg.indexOf('=') + 1).split(','))
    }
    if (targets.length > 0) return targets
    if (positional[0] === 'run' && positional[1]?.includes(':')) return [positional[1].split(':')[1]!]
    if (positional.length >= 2 && !['run-many', 'affected', 'run'].includes(positional[0]!)) return [positional[0]!]
    return []
  }
  return []
}

/** True when the segment's command (its head, not an argument) runs tests, a build, lint or a type check. */
export function isRunnerSegment(segment: string, context: RunnerContext = {}, depth = 0): boolean {
  if (depth > 3) return false
  let tokens = words(segment.replace(/^[({\s]+|[)}\s]+$/g, ''))
  // Leading VAR=value assignments and wrappers (sudo, time, timeout 600, …).
  for (;;) {
    const head = tokens[0]
    if (!head) return false
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || PREFIX_WORDS.has(head)) {
      tokens = tokens.slice(1)
      continue
    }
    if (head === 'timeout') {
      tokens = tokens.slice(1)
      while (tokens[0] && (tokens[0].startsWith('-') || /^\d+[smhd]?$/.test(tokens[0]))) tokens = tokens.slice(1)
      continue
    }
    break
  }
  const head = basenameOf(tokens[0] ?? '')
  const args = tokens.slice(1)
  const sub = firstPositional(args)
  const dir = context.cwd ?? process.cwd()
  // Info-only invocations never check anything (also after `--`).
  if (args.some((arg) => INFO_ONLY_FLAGS.has(arg) || /^--(?:version|help)=/.test(arg))) return false
  if (args.includes('-v') && !VERBOSE_V_TOOLS.has(head) && !['python', 'python3', 'py', 'uv', 'poetry', 'pipenv', 'hatch', 'bundle'].includes(head)) return false
  if (head === 'make' || head === 'gmake') {
    if (args.some((arg) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(arg) && !arg.startsWith('--'))) return false // make -n: dry run
  }

  const viaExecutor = (rest: string[]): boolean => {
    const tool = basenameOf(firstPositional(rest) ?? '')
    const after = rest.slice(rest.indexOf(firstPositional(rest) ?? '') + 1)
    if (CHECK_TOOL_RE.test(tool)) return true
    if (tool === 'turbo' || tool === 'nx' || tool === 'lerna') return isRunnerSegment([tool, ...after].join(' '), context, depth + 1)
    if (tool === 'playwright') return firstPositional(after) === 'test'
    if (tool === 'cypress') return firstPositional(after) === 'run'
    if (tool === 'prettier') return after.includes('--check')
    return false
  }

  switch (head) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const call = parsePackageManager(head, args, dir)
      const targets = call.workspaces ?? [call.dir]
      const script = (name: string | undefined): boolean =>
        Boolean(name && CHECK_SCRIPT_RE.test(name) && (realScriptIn(targets, name, depth) || (call.workspaces !== null && realScript(call.dir, name, depth))))
      const sub = call.sub
      if (!sub) return false
      if (head === 'yarn' && sub === 'workspace') {
        // yarn workspace <name> [run] <script>
        const [name, maybeRun, maybeScript] = call.rest.filter((arg) => !arg.startsWith('-'))
        const dirs = name ? selectWorkspaces(call.dir, name) : []
        const scriptName = maybeRun === 'run' ? maybeScript : maybeRun
        return Boolean(scriptName && CHECK_SCRIPT_RE.test(scriptName) && realScriptIn(dirs, scriptName, depth))
      }
      if (head === 'yarn' && sub === 'workspaces') {
        // yarn workspaces foreach [-A] run <script> / yarn workspaces run <script>
        const positional = call.rest.filter((arg) => !arg.startsWith('-'))
        const scriptName = positional[positional.indexOf('run') + 1]
        return Boolean(positional.includes('run') && scriptName && CHECK_SCRIPT_RE.test(scriptName) && realScriptIn(workspaceDirs(call.dir), scriptName, depth))
      }
      if (['test', 't', 'tst'].includes(sub) && head !== 'bun') return script('test')
      if (sub === 'run' || sub === 'run-script') return script(firstPositional(call.rest))
      if (sub === 'exec' || sub === 'x' || sub === 'dlx') return viaExecutor(call.rest)
      if (head === 'bun' && sub === 'test') return true
      // pnpm/yarn/bun run package scripts by name.
      if (head === 'npm' || ['install', 'add', 'remove', 'init', 'create', 'link'].includes(sub)) return false
      return script(sub)
    }
    case 'turbo':
    case 'nx':
    case 'lerna': {
      const tasks = monorepoTasks(head, args).filter((task) => CHECK_SCRIPT_RE.test(task))
      if (tasks.length === 0) return false
      if (head === 'nx') return existsSync(path.join(dir, 'nx.json'))
      const dirs = [dir, ...workspaceDirs(dir)]
      return tasks.every((task) => realScriptIn(dirs, task, depth))
    }
    case 'npx':
    case 'bunx':
      return viaExecutor(args)
    case 'pytest':
    case 'py.test':
    case 'tox':
    case 'nox':
    case 'mypy':
    case 'flake8':
    case 'pylint':
    case 'rspec':
    case 'phpunit':
    case 'ctest':
      return true
    case 'ruff':
      return sub === 'check'
    case 'python':
    case 'python3':
    case 'py': {
      const index = args.indexOf('-m')
      const module = index >= 0 ? args[index + 1] : undefined
      return Boolean(module && ['pytest', 'unittest', 'mypy', 'ruff', 'flake8', 'pylint', 'tox', 'nox', 'compileall'].includes(module))
    }
    case 'uv':
    case 'poetry':
    case 'pipenv':
    case 'hatch':
      return sub === 'run' && isRunnerSegment(args.slice(args.indexOf('run') + 1).join(' '), context, depth + 1)
    case 'bundle':
      return sub === 'exec' && isRunnerSegment(args.slice(args.indexOf('exec') + 1).join(' '), context, depth + 1)
    case 'go':
      return sub === 'test' || sub === 'build' || sub === 'vet'
    case 'cargo':
      return Boolean(sub && ['test', 'build', 'check', 'clippy', 'nextest'].includes(sub))
    case 'mvn':
    case 'mvnw':
      return args.some((arg) => ['test', 'verify', 'package', 'install'].includes(arg))
    case 'gradle':
    case 'gradlew':
      return args.some((arg) => /^(?::?[\w-]+:)*(?:test|build|check|assemble)$/.test(arg))
    case 'make':
    case 'gmake':
      return args.some((arg) => /^(?:test|tests|check|build|lint)$/.test(arg))
    case 'dotnet':
    case 'swift':
      return sub === 'test' || sub === 'build'
    case 'deno':
      return sub === 'test' || sub === 'lint' || sub === 'check'
    case 'rake':
      return sub === 'test' || sub === 'spec'
    case 'mix':
    case 'flutter':
      return sub === 'test'
    case 'node': {
      if (!args.includes('--test')) return false
      // `node --test` alone passes with nothing to run: it needs test files that exist.
      const targets = args.filter((arg) => !arg.startsWith('-'))
      if (targets.length > 0) return targets.every((target) => hasEntries(path.resolve(dir, target)))
      return hasEntries(path.join(dir, 'test')) || hasEntries(path.join(dir, 'tests'))
    }
    case 'playwright':
      return sub === 'test'
    case 'cypress':
      return sub === 'run'
    case 'bash':
    case 'sh':
    case 'zsh': {
      // bash [-o pipefail] -c "<command>": judge the inner command.
      const index = args.indexOf('-c')
      const inner = index >= 0 ? args[index + 1] : undefined
      return Boolean(inner && classifyRunnerCommand(inner, context, depth + 1).runner)
    }
    default:
      return CHECK_TOOL_RE.test(head)
  }
}

export interface RunnerCommandInfo {
  /** The command runs tests/build/lint/typecheck as a command head. */
  runner: boolean
  /** The runner's exit status is what the whole command returns. */
  statusPreserved: boolean
}

/** `set -o pipefail` / `set -euo pipefail` as a statement of its own, or `bash -o pipefail …`. */
const PIPEFAIL_STATEMENT_RE = /^\s*set\s+(?:[-+][a-zA-Z]+\s+)*-[a-zA-Z]*o\s+pipefail\s*$|^\s*set\s+(?:[-+][a-zA-Z]+\s+)*-o\s+pipefail\b/

/**
 * Decide whether a command is a check run whose exit status we can trust.
 * Status is lost when a runner is followed by `||`, `;`, `&`, or a pipe
 * (unless a real `set -o pipefail` statement precedes it): `npm test || true`,
 * `npm test; echo done`, `npm test 2>&1 | tail -30`. A `cd <dir>` before
 * the runner moves where package scripts and test files are looked up.
 */
export function classifyRunnerCommand(command: string, context: RunnerContext = {}, depth = 0): RunnerCommandInfo {
  // bash -o pipefail -c "…": the inner command runs with pipefail.
  const wrapped = command.match(/^\s*(?:ba|z)?sh\s+((?:-[a-zA-Z]+\s+|-o\s+\w+\s+)*)-c\s+(["'])([\s\S]*)\2\s*$/)
  if (wrapped && depth <= 3) {
    const inner = wrapped[3]!
    const innerInfo = classifyRunnerCommand(/-o\s+pipefail/.test(wrapped[1] ?? '') ? `set -o pipefail; ${inner}` : inner, context, depth + 1)
    return innerInfo
  }
  const segments = splitShellSegments(command)
  let cwd = context.cwd ?? process.cwd()
  let pipefail = false
  let runner = false
  let statusPreserved = true
  segments.forEach((segment, index) => {
    if (PIPEFAIL_STATEMENT_RE.test(segment.text)) {
      pipefail = true
      return
    }
    const cd = segment.text.match(/^\s*cd\s+(["']?)([^"'\s]+)\1\s*$/)
    if (cd) {
      cwd = path.resolve(cwd, cd[2]!.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
      return
    }
    if (!isRunnerSegment(segment.text, { cwd }, depth)) return
    runner = true
    for (let after = index; after < segments.length; after++) {
      const next = segments[after]!.next
      if (next === 'end' || next === '&&') continue
      if (next === '|' && pipefail) continue
      statusPreserved = false
      break
    }
  })
  return { runner, statusPreserved: runner && statusPreserved }
}

/**
 * Exit status a run_command result reports in its own header — the
 * "command: <the exact command>" block the tool writes first, followed by
 * "exit_code: N" (or a background "status: … (exit_code: N)") — never a
 * number the command itself printed.
 */
export function reportedExitCode(output: string | undefined, command?: string): number | undefined {
  if (!output || command === undefined) return undefined
  const header = `command: ${command}\n`
  if (!output.startsWith(header)) return undefined
  const after = output.slice(header.length).split('\n').slice(0, 6)
  for (const line of after) {
    const direct = line.match(/^exit_code:\s*(-?\d+)\s*$/)
    if (direct) return Number(direct[1])
    const background = line.match(/^status:\s*\w+\s*\(exit_code:\s*(-?\d+)\)/)
    if (background) return Number(background[1])
    if (/^(?:stdout|stderr):/.test(line)) break
  }
  return undefined
}

/** run_command moved to the background: the result says nothing about the outcome yet. */
export function outputIsBackgrounded(output: string | undefined): boolean {
  return Boolean(output && /^(?:background:\s*true|auto_backgrounded:\s*true|status:\s*running)\b/im.test(output.slice(0, 2000)))
}

/**
 * Runner summary lines that report failures — consulted only when the exit
 * status is unknown. Ordinary log lines ("ERROR:root:…", test names that
 * mention errors, TAP "# TODO") do not count.
 */
const RUNNER_FAILURE_SUMMARY_RE = new RegExp([
  /^\s*Tests?:\s+[1-9]\d*\s+failed\b/.source, // jest
  /^\s*Tests?\s+[1-9]\d*\s+failed\b/.source, // vitest "Tests  2 failed | 3 passed"
  /^\s*Test Files\s+[1-9]\d*\s+failed\b/.source,
  /^=+ .*\b[1-9]\d* (?:failed|errors?)\b.* =+$/.source, // pytest summary
  /^FAILED \((?:failures|errors)=[1-9]/.source, // unittest
  /^# fail [1-9]\d*$/.source, // node --test / TAP
  /^\s*[1-9]\d* failing$/.source, // mocha
  /^Found [1-9]\d* errors?\b/.source, // tsc --watch-style summary
  /^\s*✖ [1-9]\d* problems? \([1-9]\d* errors?/.source, // eslint
  /^(?:error|ERROR)(?:\[E\d+\])?: could not compile\b/.source, // cargo
  /^--- FAIL: /.source, // go test
  /^BUILD FAILED\b/.source,
].join('|'), 'm')

/**
 * Verdict for one tool call: undefined when it is not a check run. The
 * exit status the tool reports is authoritative; without one, the tool's
 * ok flag decides, and failing runner summary lines turn it into a fail.
 * 'pass' needs the runner's status preserved and a foreground run.
 */
export function judgeRunnerResult(command: string | undefined, ok: boolean, output?: string, context: RunnerContext = {}): 'pass' | 'fail' | 'unknown' | undefined {
  if (!command) return undefined
  const info = classifyRunnerCommand(command, context)
  if (!info.runner) return undefined
  const exit = reportedExitCode(output, command)
  if (!ok || (exit !== undefined && exit !== 0)) return 'fail'
  if (exit === undefined && output && RUNNER_FAILURE_SUMMARY_RE.test(output.slice(0, 200_000))) return 'fail'
  if (!info.statusPreserved || outputIsBackgrounded(output)) return 'unknown'
  return 'pass'
}

// ── the agent's reply ──────────────────────────────────────────────────────

const FAILURE_REPLY_PATTERNS: RegExp[] = [
  /\b(?:i (?:was|am) (?:unable|not able)|could ?n[o']t (?:complete|finish|get|make|fix|find|run|resolve)|cannot (?:complete|finish|proceed|fix)|did not (?:succeed|work|pass)|didn'?t (?:succeed|work|pass)|no longer works|blocked by)\b/i,
  /\b\d+\s+(?:\w+\s+){0,2}(?:tests?|specs?|checks?|suites?|assertions?)\s+(?:are\s+|is\s+)?(?:still\s+)?(?:failing|failed|fail|broken|red)\b/i,
  /\b(?:tests?|specs?|build|compilation|compile|lint(?:ing)?|type ?check(?:ing)?|deploy(?:ment)?|ci|pipeline|install(?:ation)?)\s+(?:is\s+|are\s+|still\s+|now\s+)*(?:fail(?:s|ed|ing)?|broken|red|errored|erroring)\b/i,
  /\bfail(?:ed|ing|s)?\s+(?:on|with|because|due to)\b/i,
  /\bstill (?:broken|failing|fails|failed|not working|errors?|erroring|red)\b/i,
  /\b(?:errors?|failures?) (?:remain|persist)/i,
  /\bnot (?:yet )?(?:passing|working|fixed|green)\b/i,
  /未能|没能|无法完成|无法继续|执行失败|仍然失败|还是失败|依然失败|没有成功|未成功|未通过|没通过|不通过|没有通过|失败了|报错|出错|编译失败|构建失败|部署失败|安装失败|测试.{0,8}失败|仍有.{0,6}(?:错误|失败|问题)|还有.{0,6}(?:错误|失败)|依然.{0,4}(?:报错|失败|错误)|还是.{0,4}(?:报错|失败|不行)/,
]

/** Failure words that are negated: "没有报错", "no errors", "no longer fails". */
const NEGATED_FAILURE_RE =
  /没有?(?:再)?(?:任何)?(?:报错|错误|问题|失败|出错)了?|不再(?:报错|出错|失败|有问题)|不报错了|不出错了|\bno longer (?:fail(?:s|ing)?|broken|errors?|crash(?:es|ing)?)\b|\bnot (?:failing|broken|crashing)(?: anymore| any more)?\b|\bno more (?:errors?|failures?|crashes)\b|\b(?:does|do)(?:n'?t| not) (?:fail|crash|error)(?: anymore| any more)?\b|\b(?:with )?(?:0|no|zero) (?:errors?|failures?|failing tests?|issues?)\b/gi
/** Failures the reply says are still there — a failure wherever they appear, whatever else it says. */
const REMAINING_FAILURE_RE =
  /\b[1-9]\d*\s+(?:\w+\s+){0,2}(?:tests?|specs?|checks?|suites?|assertions?|errors?)\s+(?:are\s+|is\s+)?(?:still\s+)?(?:failing|failed|broken|red|remain(?:ing)?)\b|\bstill (?:failing|fails|failed|broken|erroring|red|not (?:working|passing))\b|\b(?:errors?|failures?) (?:remain|persist)|还有\s*\d*\s*个?.{0,8}(?:失败|报错|错误)|仍然(?:有)?.{0,4}(?:报错|失败|错误)|依然(?:有)?.{0,4}(?:报错|失败|错误)|还是(?:有)?.{0,4}(?:报错|失败|错误)|仍有.{0,6}(?:错误|失败)|尚未通过|仍未通过/i
/** The reply states the work succeeded. */
const SUCCESS_REPLY_RE =
  /(?:测试|检查|构建|编译|lint)?(?:已)?(?:全部)?通过|已修复|修复了|修好了|已解决|构建成功|编译成功|部署成功|运行成功|\ball (?:\d+ )?(?:tests?|checks?|specs?) (?:now )?pass(?:ed|ing)?\b|\b(?:tests?|checks?|specs?|build|lint|typecheck) (?:now )?(?:pass(?:es|ed)?|succeed(?:s|ed)?|(?:is|are) (?:passing|green))\b|\bfixed\b|\bresolved\b|\bsucceeded\b/i

function clauses(text: string): string[] {
  return text.split(/[。！!？?；;\n]|[，,](?=\s*\S)|\.\s+/).map((clause) => clause.trim()).filter(Boolean)
}

/**
 * The agent's own reply says the task (or its checks) did not succeed: a
 * failure phrase in its final clause, or anywhere when the reply never
 * states success. "已修复之前的报错，测试通过" and "The build failed earlier
 * because of a typo; fixed, build passes" are successes; "Done. 3 tests are
 * failing" and "已修复，但仍有 2 个测试失败" are not.
 */
export function replyReportsFailure(reply: string): boolean {
  const text = reply.slice(0, 6000).replace(NEGATED_FAILURE_RE, ' ')
  if (REMAINING_FAILURE_RE.test(text)) return true
  const hasFailure = (value: string): boolean => FAILURE_REPLY_PATTERNS.some((pattern) => pattern.test(value))
  const last = clauses(text).at(-1) ?? ''
  if (hasFailure(last)) return true
  return hasFailure(text) && !SUCCESS_REPLY_RE.test(text)
}

/**
 * An explicit claim that checks or results passed: "all tests pass", "the
 * build succeeds", "verified", "测试全部通过", "验证通过". "Done" or "works
 * now" alone is no claim about a check; "all tests pass except …" is none
 * either.
 */
const CHECK_PASS_CLAIM_RE = new RegExp([
  /\b(?:all\s+(?:\d+\s+)?)?(?:unit\s+|the\s+)?(?:tests?|specs?|checks?|builds?|lint(?:ing)?|type ?checks?|typecheck(?:ing)?|ci)\s+(?:now\s+|all\s+|still\s+)?(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|(?:is|are)\s+(?:passing|green|clean))\b(?!\s*,?\s*(?:except|but|apart|other than|save for))/.source,
  /\bpass(?:es|ed|ing)?\s+(?:all\s+)?(?:the\s+)?(?:\d+\s+)?(?:tests?|checks?|specs?)\b(?!\s*,?\s*(?:except|but|apart|other than))/.source,
  /\b(?:verified|tested)\s+(?:that|it|the|and|working|successfully)\b|\b(?:fully\s+)?(?:verified|tested)\s*[.!]/.source,
  /\bworks\s+(?:now\s+)?(?:and|,)\s+(?:all\s+)?(?:tests?|checks?)\s+pass/.source,
  /(?<!除了.{0,12})(?:测试|单测|检查|构建|编译|类型检查|lint)(?:用例)?(?:已经|已|都|均|全部|全都|也)*(?:通过|成功|绿了)/.source,
  /已验证|验证通过|验证无误|跑通了/.source,
].join('|'), 'i')

/** Fixing a failure is no disclosure of one: "Fixed 3 failing tests", "修复了一个报错". */
const FIXED_BEFORE_RE = /(?<!\b(?:fix(?:ed|es|ing)?|resolv(?:ed|es|ing)|address(?:ed|es|ing)|repair(?:ed|ing)?|clean(?:ed)?\s+up)\s+(?:the\s+|all\s+|these\s+|those\s+)?)/.source

/**
 * The reply discloses a present or future problem: a failing or unrun
 * check, a pre-existing failure ("still fails", "1 failing test",
 * "pre-existing failure", "tests were not run", "测试未通过", "还在报错",
 * "没跑测试"). Fixed failures ("Fixed 3 errors", "修复了一个报错") are not.
 */
const DISCLOSURE_RE = new RegExp([
  `${FIXED_BEFORE_RE}\\b\\d+\\s+(?:\\w+\\s+){0,2}(?:failing|failed)\\b`,
  /\b\d+\s+(?:\w+\s+){0,2}(?:tests?|specs?|checks?)\s+(?:are\s+|is\s+)?(?:still\s+)?(?:failing|fail)\b/.source,
  /\bstill\s+(?:fails?|failing|failed|broken|errors?|erroring|red)\b|\b(?:has|have|with|there\s+(?:is|are))\s+(?:a\s+|one\s+|some\s+|\d+\s+)?failing\b/.source,
  /\b(?:tests?|builds?|checks?|ci|lint|typecheck)\s+(?:is\s+|are\s+)?(?:currently\s+|now\s+)?(?:failing|broken|red)\b/.source,
  /\bpre-?existing\s+(?:failures?|failing|issues?|errors?|problems?)\b|\balready\s+(?:failing|broken|failed)\b|\bwas\s+(?:already\s+)?failing\b/.source,
  /\b(?:tests?|checks?|builds?)\s+(?:were|was|have|has|are|is)?\s*(?:not|n't|never)\s+(?:been\s+|yet\s+)?(?:run|executed|verified)\b/.source,
  /\b(?:did(?:n't| not)|could(?:n't| not)|cannot|can't)\s+run\s+(?:the\s+)?(?:tests?|checks?|build)\b|\bnot\s+(?:yet\s+)?(?:tested|verified)\b|\buntested\b|\bunverified\b/.source,
  /\b(?:could(?:n't| not)|unable to|was not able to|failed to)\s+(?:fix|get|make|complete|finish|resolve)\b/.source,
  /(?<!修复了?|解决了?|改好了?)(?:未通过|没通过|不通过)|未运行|没运行|没有运行|没跑|没有跑|还没跑|未测试|没有测试|没测试|未验证|没验证|没有验证|还在(?:报错|失败)|(?:仍|还|依然|仍然|还是)(?:在|有)?(?:(?!修复|解决|改好|处理)[^，。,.;；]){0,6}(?:失败|报错|错误)|(?:原本|之前|本来)就.{0,8}(?:失败|报错|错误|不通过)/.source,
].join('|'), 'i')

/** The reply discloses a present failure or an unverified state anywhere (see DISCLOSURE_RE). */
export function replyDisclosesProblem(reply: string): boolean {
  const text = reply.slice(0, 6000).replace(NEGATED_FAILURE_RE, ' ')
  return DISCLOSURE_RE.test(text)
}

/**
 * The reply explicitly claims that checks or results passed ("all tests
 * pass", "测试全部通过", "verified"). Such a claim against a failing check
 * is always corrected, whatever else the reply says. Used by the end-of-run
 * self-check (core/selfCheck.ts).
 */
export function replyClaimsChecksPass(reply: string): boolean {
  if (!reply.trim()) return false
  return CHECK_PASS_CLAIM_RE.test(reply.slice(0, 6000))
}

// ── the user's next message ────────────────────────────────────────────────

/** The longest leading clause still read as feedback on the previous result. */
const FEEDBACK_CLAUSE_MAX_CHARS = 40

const QUESTION_START_RE =
  /^(?:what|why|how|where|when|which|who|is|are|was|were|does|do|did|can|could|would|will|should|may)(?=\s)|^(?:有没有|是不是|为什么|为啥|怎么|如何|哪里|哪个|哪|什么|能不能|可不可以|是否|请问)/i
const REQUEST_START_RE =
  /^(?:please|pls|can you|could you|would you|help|fix|add|create|make|write|build|implement|update|change|remove|delete|rename|run|deploy|now|also|next|then|and|另外|还有|再|帮我|帮忙|请|麻烦|给我|把|现在|接下来|然后|顺便|再帮|修复|修改|添加|新增|创建|实现|写|改)/i
/** Polite openers that are not feedback ("不好意思，再帮我…" is a request). */
const POLITE_OPENER_RE = /^(?:不好意思|抱歉|对不起|打扰了|打扰一下|麻烦你了|sorry|excuse me|apologies)[\s,，。.!！~、]*/i
/** A whole message that is a short, clear approval (punctuation and emoji aside). */
const SHORT_APPROVAL_RE =
  /^(?:ok|okay|k|yes|yep|yeah|yup|great|perfect|nice|cool|good|lgtm|thanks|thank you|thx|ty|好|好的|好滴|好嘞|好啊|行|行了|可以|可以了|对|对的|没错|没问题|完美|搞定|嗯嗯?|妥了?)$/i
const APPROVAL_EMOJI_RE = /[👍👌✅💯👏🎉🙌]/u

/** Positive idioms that contain a negator ("没问题", "不错", "没错") — checked before negation. */
const POSITIVE_IDIOM_RE = /没问题|没毛病|没错|不错|不客气|\bno problem\b|\bnot bad\b|\bnot too bad\b|\bno issues?\b|\bno errors?\b/gi
const NEGATED_POSITIVE_RE =
  /(?:\b(?:not|isn'?t|aren'?t|wasn'?t|doesn'?t|don'?t|didn'?t|never|hardly|no longer|not quite|not really)\s+(?:\w+\s+){0,2}(?:good|great|right|correct|perfect|exactly|working|work|works|fine|ok|okay|done|what i)\b)|(?:[不没未别](?:太|大|怎么|是很)?(?:好|对|正确|行|能用|可以|成功|工作|满意|符合|准))/i
const NEGATIVE_RE =
  /\b(?:wrong|incorrect|broken|broke|doesn'?t work|didn'?t work|not working|isn'?t working|fails?|failed|failing|still (?:fails|failing|broken|wrong|errors?)|regress(?:ed|ion)|revert(?: it| that| this)?|undo(?: it| that| this)?|bad|useless|worse)\b|不对|错了|错误|不行|没用|不好用|失败|报错|坏了|有问题|不正确|不能用|撤销|回滚|不是我要的|搞砸|不太对/i
const POSITIVE_RE =
  /\b(?:thanks|thank you|thx|ty|works(?: now| great| perfectly| fine)?|it worked|that worked|perfect|great(?: job| work)?|awesome|excellent|looks good|lgtm|exactly|well done|nice(?: work| job)?|good job|all good|that'?s it|confirmed|correct|it'?s fixed|fixed it|solved)\b|谢谢|多谢|感谢|可以了|好了|搞定|完美|没问题了?|成功了|太好了|不错|没错|就是这样|好用|能用了|跑通了|对了|正确|解决了|修好了|没毛病|厉害|棒/i
const CONTRAST_RE = /\b(?:but|however|except|although|though|yet)\b|但是?|不过|可是|然而|只是/i
const DECLINE_RE = /^(?:no,?\s+thanks|no thank you|不用了?|算了)/i

function normalizeFeedbackText(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '')
    .trim()
}

/**
 * Feedback about the previous result, read conservatively from the start of
 * the user's next message:
 * - a whole message that is a short approval ("好", "ok", "👍") is positive;
 * - polite openers ("不好意思，…") are skipped;
 * - only the first clause counts, and only when it is short (or opens with
 *   a feedback word) — a new task or question that merely mentions "error"
 *   or "有问题" is neutral;
 * - negated failures ("没有报错了", "no longer fails", "not too bad") are
 *   positive, never negative; negated positives ("不好用", "isn't exactly
 *   what I need") are negative; "no thanks" and contrasts ("works on
 *   staging but not prod") are neutral;
 * - "谢谢！另外…" is positive about the past; what follows is a new request.
 */
export function classifyUserFeedback(text: string): 'positive' | 'negative' | 'neutral' {
  let message = normalizeFeedbackText(text)
  for (let guard = 0; guard < 3 && POLITE_OPENER_RE.test(message); guard++) message = message.replace(POLITE_OPENER_RE, '').trim()
  if (!message) return 'neutral'
  const asksSomething = /[?？]/.test(message)
  const bare = message.replace(/[\p{P}\p{S}\s]+/gu, ' ').trim()
  if ((bare && SHORT_APPROVAL_RE.test(bare)) || (!bare && APPROVAL_EMOJI_RE.test(message))) return asksSomething ? 'neutral' : 'positive'

  const rawFirst = message.split(/[。！!？?\n；;]|[,，](?=\s*(?:另外|还有|顺便|再|帮我|请|then|also|now|and|next|please))/)[0] ?? ''
  const firstClause = rawFirst.trim()
  if (!firstClause) return 'neutral'
  const terminator = message.slice(rawFirst.length).trimStart().charAt(0)
  if (terminator === '?' || terminator === '？' || /[吗呢嘛]$/.test(firstClause)) return 'neutral'
  if (QUESTION_START_RE.test(firstClause) || DECLINE_RE.test(firstClause)) return 'neutral'

  // Negated failures count as good news and are taken out before looking for complaints.
  const fixedNews = NEGATED_FAILURE_RE.test(firstClause)
  NEGATED_FAILURE_RE.lastIndex = 0
  const clause = firstClause.replace(NEGATED_FAILURE_RE, ' fixed ').replace(/\s+/g, ' ').trim()
  const feedbackWithin = (chars: number): boolean => fixedNews || [POSITIVE_RE, NEGATIVE_RE, NEGATED_POSITIVE_RE].some((pattern) => {
    const match = clause.match(pattern)
    return Boolean(match && (match.index ?? 99) <= chars)
  })
  // "帮我修复这个报错" asks for new work; "that's wrong, …" and "这个结果不正确" are feedback.
  if (REQUEST_START_RE.test(clause) && !feedbackWithin(2)) return 'neutral'
  if (clause.length > FEEDBACK_CLAUSE_MAX_CHARS && !feedbackWithin(10)) return 'neutral'

  // The rest of a short message counts too: "谢谢！还是不行", "No errors, the page is just
  // blank" and "Thanks! Still broken though" are complaints, whatever they open with.
  // Questions and new requests in it ("另外…有问题吗？", "再帮我…") are not.
  const others = otherClauses(message, firstClause)
  if (others.some((part) => isComplaint(part))) return 'negative'

  // "好的，再帮我…", "ok, now add tests": a short approval, then a new request.
  const firstBare = clause.replace(/[\p{P}\p{S}\s]+/gu, ' ').trim()
  if (firstBare && SHORT_APPROVAL_RE.test(firstBare) && !/[?？]/.test(rawFirst + terminator)) return 'positive'
  const contrast = clause.match(CONTRAST_RE)
  if (contrast) {
    // "thanks, but it is broken" complains; "works on staging but not prod" is unclear.
    return isComplaint(clause.slice((contrast.index ?? 0) + contrast[0].length)) ? 'negative' : 'neutral'
  }
  if (isNegative(clause)) return 'negative'
  // "No errors" is good news only when nothing else follows, or what follows is good too.
  if (fixedNews && others.some((part) => !POSITIVE_RE.test(part) && !APPROVAL_EMOJI_RE.test(part))) return 'neutral'
  if (fixedNews || POSITIVE_RE.test(clause) || APPROVAL_EMOJI_RE.test(message)) return 'positive'
  return 'neutral'
}

function isNegative(value: string): boolean {
  const withoutIdioms = value.replace(NEGATED_FAILURE_RE, ' ').replace(POSITIVE_IDIOM_RE, ' ')
  return NEGATED_POSITIVE_RE.test(withoutIdioms) || NEGATIVE_RE.test(withoutIdioms)
}

/** Complaint markers beyond plain negatives: still broken, blank page, nothing renders, 还是/仍然/空白. */
const COMPLAINT_EXTRA_RE =
  /还是|仍然|依然|空白|白屏|没反应|没有反应|不显示|没有显示|显示不出|打不开|加载不出|\bstill\b|\bblank\b|\bnothing (?:renders|shows|happens|appears|loads|works)\b|\bempty (?:page|screen|output|file|result)\b|\bno output\b|\bdoes ?n[o']t (?:show|render|load|appear)\b/i

function isComplaint(value: string): boolean {
  const cleaned = value.replace(NEGATED_FAILURE_RE, ' ').replace(POSITIVE_IDIOM_RE, ' ')
  return isNegative(cleaned) || COMPLAINT_EXTRA_RE.test(cleaned)
}

/** The message's clauses after its first one, minus questions and new requests. */
function otherClauses(message: string, _firstClause: string): string[] {
  const out: string[] = []
  const pattern = /[^。！!？?\n；;，,:：]+([。！!？?\n；;，,:：]|$)/g
  let first = true
  for (const match of message.replace(/\.\s+/g, '。').matchAll(pattern)) {
    const part = match[0].replace(/[。！!？?\n；;，,:：]$/, '').trim()
    if (!part) continue
    if (first) {
      first = false
      continue
    }
    const question = match[1] === '?' || match[1] === '？' || /[吗呢嘛]$/.test(part) || QUESTION_START_RE.test(part)
    if (question || REQUEST_START_RE.test(part)) continue
    out.push(part)
  }
  return out
}
