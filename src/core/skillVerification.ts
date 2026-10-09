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

function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^['"]|['"]$/g, ''))
}

function basenameOf(word: string): string {
  return word.replace(/^.*[\\/]/, '')
}

function firstPositional(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'))
}

/** True when the segment's command (its head, not an argument) runs tests, a build, lint or a type check. */
export function isRunnerSegment(segment: string): boolean {
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

  const viaExecutor = (rest: string[]): boolean => {
    const tool = basenameOf(firstPositional(rest) ?? '')
    const after = rest.slice(rest.indexOf(firstPositional(rest) ?? '') + 1)
    if (CHECK_TOOL_RE.test(tool)) return true
    if (tool === 'playwright') return firstPositional(after) === 'test'
    if (tool === 'cypress') return firstPositional(after) === 'run'
    if (tool === 'prettier') return after.includes('--check')
    return false
  }

  switch (head) {
    case 'npm': {
      if (!sub) return false
      if (['test', 't', 'tst'].includes(sub)) return true
      if (sub === 'run' || sub === 'run-script') {
        const script = firstPositional(args.slice(args.indexOf(sub) + 1))
        return Boolean(script && CHECK_SCRIPT_RE.test(script))
      }
      if (sub === 'exec' || sub === 'x') return viaExecutor(args.slice(args.indexOf(sub) + 1))
      return false
    }
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      if (!sub) return false
      if (sub === 'run') {
        const script = firstPositional(args.slice(args.indexOf(sub) + 1))
        return Boolean(script && CHECK_SCRIPT_RE.test(script))
      }
      if (sub === 'exec' || sub === 'dlx' || sub === 'x') return viaExecutor(args.slice(args.indexOf(sub) + 1))
      if (head === 'bun' && sub === 'test') return true
      // pnpm/yarn/bun run package scripts by name.
      return CHECK_SCRIPT_RE.test(sub) && !['install', 'add', 'remove', 'init', 'create', 'link'].includes(sub)
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
      return sub === 'run' && isRunnerSegment(args.slice(args.indexOf('run') + 1).join(' '))
    case 'bundle':
      return sub === 'exec' && isRunnerSegment(args.slice(args.indexOf('exec') + 1).join(' '))
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
      return args.some((arg) => /^(?:test|tests|check|build|lint|all|ci)$/.test(arg))
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
    case 'node':
      return args.includes('--test')
    case 'playwright':
      return sub === 'test'
    case 'cypress':
      return sub === 'run'
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

/**
 * Decide whether a command is a check run whose exit status we can trust.
 * Status is lost when a runner is followed by `||`, `;`, `&`, or a pipe
 * (unless `set -o pipefail` is in effect): `npm test || true`,
 * `npm test; echo done`, `npm test 2>&1 | tail -30`.
 */
export function classifyRunnerCommand(command: string): RunnerCommandInfo {
  const segments = splitShellSegments(command)
  const pipefail = /\bpipefail\b/.test(command)
  let runner = false
  let statusPreserved = true
  segments.forEach((segment, index) => {
    if (!isRunnerSegment(segment.text)) return
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

/** Exit status a run_command result reports, if any. */
export function reportedExitCode(output: string | undefined): number | undefined {
  if (!output) return undefined
  const match = output.slice(0, 2000).match(/^(?:exit_code|exit code|exitCode)\s*[:=]\s*(-?\d+)/im)
    ?? output.slice(0, 2000).match(/\(exit_code:\s*(-?\d+)\)/i)
  return match ? Number(match[1]) : undefined
}

/** run_command moved to the background: the result says nothing about the outcome yet. */
export function outputIsBackgrounded(output: string | undefined): boolean {
  return Boolean(output && /^(?:background:\s*true|auto_backgrounded:\s*true|status:\s*running)\b/im.test(output.slice(0, 2000)))
}

/**
 * Verdict for one tool call: undefined when it is not a check run;
 * 'pass' only for a runner whose status is preserved, that succeeded, and
 * (when the output reports one) exited 0 in the foreground.
 */
export function judgeRunnerResult(command: string | undefined, ok: boolean, output?: string): 'pass' | 'fail' | 'unknown' | undefined {
  if (!command) return undefined
  const info = classifyRunnerCommand(command)
  if (!info.runner) return undefined
  const exit = reportedExitCode(output)
  if (!ok || (exit !== undefined && exit !== 0)) return 'fail'
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

/** The agent's own reply says the task (or its checks) did not succeed. */
export function replyReportsFailure(reply: string): boolean {
  const text = reply.slice(0, 6000)
  return FAILURE_REPLY_PATTERNS.some((pattern) => pattern.test(text))
}

// ── the user's next message ────────────────────────────────────────────────

/** The longest leading clause still read as feedback on the previous result. */
const FEEDBACK_CLAUSE_MAX_CHARS = 40

const QUESTION_START_RE =
  /^(?:what|why|how|where|when|which|who|is|are|was|were|does|do|did|can|could|would|will|should|may|有没有|是不是|为什么|为啥|怎么|如何|哪|什么|能不能|可不可以|是否|请问)\b|^(?:有没有|是不是|为什么|为啥|怎么|如何|哪里|哪个|什么|能不能|可不可以|是否|请问)/i
const REQUEST_START_RE =
  /^(?:please|pls|can you|could you|would you|help|fix|add|create|make|write|build|implement|update|change|remove|delete|rename|run|deploy|now|also|next|then|and|另外|还有|再|帮我|帮忙|请|麻烦|给我|把|现在|接下来|然后|顺便|再帮|修复|修改|添加|新增|创建|实现|写|改)/i

/** Positive idioms that contain a negator ("没问题", "不错") — checked before negation. */
const POSITIVE_IDIOM_RE = /没问题|没毛病|不错|不客气|\bno problem\b|\bnot bad\b|\bno issues?\b|\bno errors?\b/i
const NEGATED_POSITIVE_RE =
  /(?:\b(?:not|isn'?t|aren'?t|wasn'?t|doesn'?t|don'?t|didn'?t|never|hardly|no longer|not quite|not really)\s+(?:\w+\s+){0,2}(?:good|great|right|correct|perfect|exactly|working|work|works|fine|ok|okay|done|what i)\b)|(?:[不没未别](?:太|大|怎么|是很)?(?:好|对|正确|行|能用|可以|成功|工作|满意|符合|准))/i
const NEGATIVE_RE =
  /\b(?:wrong|incorrect|broken|broke|doesn'?t work|didn'?t work|not working|isn'?t working|fails?|failed|failing|still (?:fails|failing|broken|wrong|errors?)|regress(?:ed|ion)|revert(?: it| that| this)?|undo(?: it| that| this)?|bad|useless|worse)\b|不对|错了|错误|不行|没用|不好用|失败|报错|坏了|有问题|不正确|不能用|撤销|回滚|不是我要的|搞砸|不太对/i
const POSITIVE_RE =
  /\b(?:thanks|thank you|thx|ty|works(?: now| great| perfectly| fine)?|it worked|that worked|perfect|great(?: job| work)?|awesome|excellent|looks good|lgtm|exactly|well done|nice(?: work| job)?|good job|all good|that'?s it|confirmed|correct|it'?s fixed|fixed it|solved)\b|谢谢|多谢|感谢|可以了|好了|搞定|完美|没问题了?|成功了|太好了|不错|就是这样|好用|能用了|跑通了|对了|正确|解决了|修好了|没毛病|厉害|棒/i
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
 * - only the first clause counts, and only when it is short (or opens with
 *   a feedback word) — a new task or question that merely mentions "error"
 *   or "有问题" is neutral;
 * - a negated positive ("不好用", "not perfect yet", "isn't exactly what I
 *   need") is negative; "no thanks" and contrasts ("works on staging but
 *   not prod") are neutral;
 * - "谢谢！另外…" is positive about the past; what follows is a new request.
 */
export function classifyUserFeedback(text: string): 'positive' | 'negative' | 'neutral' {
  const message = normalizeFeedbackText(text)
  if (!message) return 'neutral'
  const rawFirst = message.split(/[。！!？?\n；;]|[,，](?=\s*(?:另外|还有|顺便|then|also|now|and|next))/)[0] ?? ''
  const firstClause = rawFirst.trim()
  if (!firstClause) return 'neutral'
  const terminator = message.slice(rawFirst.length).trimStart().charAt(0)
  if (terminator === '?' || terminator === '？' || /[吗呢嘛]$/.test(firstClause)) return 'neutral'
  if (QUESTION_START_RE.test(firstClause) || DECLINE_RE.test(firstClause)) return 'neutral'

  const feedbackWithin = (chars: number): boolean => [POSITIVE_RE, NEGATIVE_RE, NEGATED_POSITIVE_RE].some((pattern) => {
    const match = firstClause.match(pattern)
    return Boolean(match && (match.index ?? 99) <= chars)
  })
  // "帮我修复这个报错" asks for new work; "that's wrong, …" and "这个结果不正确" are feedback.
  if (REQUEST_START_RE.test(firstClause) && !feedbackWithin(2)) return 'neutral'
  if (firstClause.length > FEEDBACK_CLAUSE_MAX_CHARS && !feedbackWithin(10)) return 'neutral'

  const isNegative = (clause: string): boolean => {
    const withoutIdioms = clause.replace(POSITIVE_IDIOM_RE, ' ')
    return NEGATED_POSITIVE_RE.test(withoutIdioms) || NEGATIVE_RE.test(withoutIdioms)
  }
  const contrast = firstClause.match(CONTRAST_RE)
  if (contrast) {
    // "thanks, but it is broken" complains; "works on staging but not prod" is unclear.
    return isNegative(firstClause.slice((contrast.index ?? 0) + contrast[0].length)) ? 'negative' : 'neutral'
  }
  if (isNegative(firstClause)) return 'negative'
  if (POSITIVE_RE.test(firstClause)) return 'positive'
  return 'neutral'
}
