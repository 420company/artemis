/**
 * security/shellRisk.ts — what a shell command may do that needs the owner.
 *
 * Best effort, and fail-closed where it matters: a shell is a programming
 * language, so this module cannot prove a command harmless. It looks for
 *  - remote code execution: a download (or a decoded blob) piped into, or
 *    saved and then run by, a shell or an interpreter;
 *  - exfiltration: a local file or data posted to a remote host;
 *  - deletes and overwrites outside the workspace. When a command contains a
 *    destructive operation and anything that hides its real target (a cd,
 *    a variable or command substitution, brace expansion, ~user, eval,
 *    xargs, find -exec, inline interpreter code, an unknown wrapper), it is
 *    treated as outside the workspace: the owner decides.
 * Paths are resolved through symlinks (the nearest existing ancestor), so a
 * link inside the workspace (or the temp dir) that points elsewhere counts
 * as elsewhere.
 */

import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { realPathOf } from '../utils/fs.js'

export { realPathOf }

export interface ShellRisk {
  reason: string
  reasonZh: string
}

// ── Tokenizing ──────────────────────────────────────────────────────────────

/** Splits a command into simple-command word lists (quotes respected; nothing expanded). */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let quote: '"' | "'" | undefined
  let hasWord = false
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length) segments.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = undefined
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      word += command[++i]
      hasWord = true
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') {
      endSegment()
      continue
    }
    if (ch === ' ' || ch === '\t') {
      endWord()
      continue
    }
    word += ch
    hasWord = true
  }
  endSegment()
  return segments
}

// ── Paths ───────────────────────────────────────────────────────────────────

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Inside the workspace, through symlinks on both sides. */
export function isInsideWorkspace(cwd: string, target: string): boolean {
  return isWithin(realPathOf(cwd), realPathOf(path.resolve(cwd, target)))
}

/** Under a temp dir (not the dir itself), through symlinks: a link out of /tmp is not temp. */
export function isTemporaryPath(target: string): boolean {
  const roots = [...new Set([tmpdir(), '/tmp', '/var/tmp'].map((root) => realPathOf(root)))]
  const real = realPathOf(target)
  return roots.some((root) => real !== root && isWithin(root, real))
}

/** `~` and $HOME expanded; undefined when anything else would be expanded (the target is unknown). */
function staticPath(word: string): string | undefined {
  if (/[`$*?[\]{}]/.test(word.replace(/^~(?=\/|$)/, '').replace(/\$\{HOME\}|\$HOME\b/g, ''))) return undefined
  if (/^~[^/]/.test(word)) return undefined
  const home = homedir()
  return word.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home)
}

// ── Remote code execution and exfiltration ──────────────────────────────────

const SHELLS = '(?:ba|z|k|da)?sh'
const INTERPRETERS = `(?:${SHELLS}|python[0-9.]*|node|perl|ruby|php|lua|deno|bun)`
const FETCH = '(?:curl|wget|fetch)'
/** Fetchers spelled in capitals (libwww's GET/HEAD/POST, matched case-sensitively), and other HTTP clients. */
const FETCH_CS = '(?:GET|HEAD|POST|lwp-request|xh|http|https|aria2c)'
/** An interpreter given inline code with combined flags: `bash -lc`, `sh -xc`, `perl -we`, `ruby -e`. */
const INLINE_FLAG = '-[A-Za-z]*[ceE]'

const PIPE_TO_INTERPRETER = new RegExp(
  `\\b${FETCH}\\b[^;&\`]{0,400}\\|\\s*(?:sudo(?:\\s+-\\S+)*\\s+)?(?:env(?:\\s+\\S+=\\S*)*\\s+)?${INTERPRETERS}\\b`,
  'i',
)
const DECODE_TO_INTERPRETER = new RegExp(
  `\\b(?:base64|xxd|openssl)\\b[^;&\`]{0,300}(?:-d|--decode|-r)\\b[^;&\`]{0,300}\\|\\s*(?:sudo\\s+)?${INTERPRETERS}\\b`,
  'i',
)
// No \\b before the name: `. <(curl …)` starts with a dot, which \\b cannot precede.
const PROCESS_SUBSTITUTION = new RegExp(`(?:^|[\\s;&|(])(?:${INTERPRETERS}|source|\\.)\\s+<\\(\\s*(?:${FETCH}|${FETCH_CS})\\b`, 'i')
const PIPE_TO_INTERPRETER_CS = new RegExp(
  `(?:^|[\\s;&|(])${FETCH_CS}\\s[^;&\`]{0,400}\\|\\s*(?:sudo(?:\\s+-\\S+)*\\s+)?(?:env(?:\\s+\\S+=\\S*)*\\s+)?${INTERPRETERS}\\b`,
)
const SUBSTITUTED_FETCH = new RegExp(`\\$\\(\\s*${FETCH}\\b|\`\\s*${FETCH}\\b`, 'i')
const EXEC_OF_SUBSTITUTION = new RegExp(`(?:\\b${INTERPRETERS}\\s+${INLINE_FLAG}\\s+["']?|\\beval\\s+["']?|^\\s*|[;&|]\\s*)(?:\\$\\(|\`)\\s*${FETCH}\\b`, 'i')

const UPLOAD_FILE = /\bcurl\b[^;&|]{0,400}(?:\s(?:-d|--data(?:-binary|-raw|-urlencode|-ascii)?|-F|--form)\s*=?\s*["']?[^\s"']*@|\s(?:-T|--upload-file)\s)/i
const WGET_POST = /\bwget\b[^;&|]{0,400}--post-(?:file|data)\b/i

const REVERSE_SHELLS: { re: RegExp; risk: ShellRisk }[] = [
  { re: /\bbash\s+-i\b[^|]{0,200}>&?\s*\/dev\/tcp\//, risk: { reason: 'opens an interactive reverse shell over /dev/tcp', reasonZh: '会向外部打开一个远程控制通道' } },
  { re: /\bmkfifo\b[\s\S]{0,200}\bnc\b/, risk: { reason: 'sets up a named-pipe reverse shell via nc', reasonZh: '会向外部打开一个远程控制通道' } },
  { re: /\bn(?:c|cat|etcat)\b[^|]{0,200}\s-[ec]\s+\S*(?:sh|bash|zsh)\b/i, risk: { reason: 'uses nc -e to expose a shell', reasonZh: '会把命令行暴露给外部连接' } },
]

const RUN_REMOTE: ShellRisk = { reason: 'runs code downloaded from the internet', reasonZh: '会运行从网上下载的代码' }
const RUN_DECODED: ShellRisk = { reason: 'decodes hidden content and runs it', reasonZh: '会解码一段隐藏的内容并运行' }
const EXFIL: ShellRisk = { reason: 'uploads local files or data to a remote server', reasonZh: '会把本地文件或数据上传到外部服务器' }

/** Files a command downloads or decodes (curl -o, wget -O / URL name, base64 -d > f). */
function producedFiles(command: string): { file: string; decoded: boolean }[] {
  const out: { file: string; decoded: boolean }[] = []
  for (const segment of shellSegments(command)) {
    const name = path.basename(segment[0] ?? '')
    const flag = (names: string[]) => {
      for (let i = 1; i < segment.length; i++) {
        const word = segment[i]!
        for (const n of names) {
          if (word === n && segment[i + 1]) return segment[i + 1]
          if (n.startsWith('--') && word.startsWith(`${n}=`)) return word.slice(n.length + 1)
          if (!n.startsWith('--') && word.startsWith(n) && word.length > n.length) return word.slice(n.length)
        }
      }
      return undefined
    }
    const url = segment.slice(1).find((w) => /^https?:\/\//i.test(w))
    if (name === 'curl') {
      const o = flag(['-o', '--output'])
      if (o) out.push({ file: o, decoded: false })
      else if (segment.includes('-O') && url) out.push({ file: path.basename(url.split(/[?#]/)[0]!), decoded: false })
    } else if (name === 'wget') {
      const o = flag(['-O', '--output-document'])
      if (o && o !== '-') out.push({ file: o, decoded: false })
      else if (!o && url) out.push({ file: path.basename(url.split(/[?#]/)[0]!) || 'index.html', decoded: false })
    }
    // Redirects into a file: `curl … > f`, `base64 -d … > f`.
    const redirect = segment.findIndex((w) => w === '>' || w === '>>')
    const inline = segment.find((w) => /^>>?[^>]/.test(w))
    const target = redirect >= 0 ? segment[redirect + 1] : inline?.replace(/^>>?/, '')
    if (target && ['curl', 'wget', 'base64', 'xxd', 'openssl'].includes(name)) out.push({ file: target, decoded: name !== 'curl' && name !== 'wget' })
  }
  return out
}

/** Whether a later part of the command runs `file` (sh f, bash f, ./f, python f, chmod +x f, source f). */
function runsFile(command: string, file: string): boolean {
  const base = path.basename(file)
  const variants = new Set([file, `./${base}`, base].filter(Boolean))
  for (const segment of shellSegments(command)) {
    const [head, ...rest] = segment
    if (!head) continue
    const runner = path.basename(head)
    if (variants.has(head)) return true
    if (new RegExp(`^${INTERPRETERS}$|^source$|^\\.$`, 'i').test(runner) && rest.some((w) => variants.has(w))) return true
    if (runner === 'chmod' && rest.some((w) => /\+x|7\d\d|5\d\d/.test(w)) && rest.some((w) => variants.has(w))) return true
  }
  return false
}

/** Reserved words and grouping that come before a command without changing it. */
const LEADING_WORDS = new Set(['{', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until'])

/** Index of the command word in a segment: after assignments, `{`, `!`, `then`, … and simple wrappers. */
function commandIndex(segment: string[]): number {
  let i = 0
  while (i < segment.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i]!) || LEADING_WORDS.has(segment[i]!) || SIMPLE_WRAPPERS.has(path.basename(segment[i]!)))) i++
  return i
}

/** A segment whose command is itself a variable (`$B`, `"${X}"`): what runs is not known before it runs. */
function runsAVariable(command: string): boolean {
  return shellSegments(command).some((segment) => /^\$\{?[A-Za-z_]/.test(segment[commandIndex(segment)] ?? ''))
}

const DECODES = /\b(?:base64|xxd|openssl)\b[^;&|]{0,300}(?:-d|--decode|-r)\b/i
const FETCHES = new RegExp(`\\b${FETCH}\\b`, 'i')
const FETCHES_CS = new RegExp(`(?:^|[\\s;&|(])${FETCH_CS}\\s`)

/** A command that runs remote or hidden code, sends data out, or opens a shell to the outside. */
export function describeHighRiskCommand(command: string): ShellRisk | null {
  for (const { re, risk } of REVERSE_SHELLS) if (re.test(command)) return risk
  if (PIPE_TO_INTERPRETER.test(command) || PIPE_TO_INTERPRETER_CS.test(command) || PROCESS_SUBSTITUTION.test(command)) return RUN_REMOTE
  // `B=$(… | base64 -d); $B`, `X=$(curl …); $X`: a variable run as the command.
  if (runsAVariable(command)) {
    if (DECODES.test(command)) return RUN_DECODED
    if (FETCHES.test(command) || FETCHES_CS.test(command)) return RUN_REMOTE
  }
  if (SUBSTITUTED_FETCH.test(command) && EXEC_OF_SUBSTITUTION.test(command)) return RUN_REMOTE
  if (/\beval\b/.test(command) && SUBSTITUTED_FETCH.test(command)) return RUN_REMOTE
  if (DECODE_TO_INTERPRETER.test(command)) return RUN_DECODED
  for (const { file, decoded } of producedFiles(command)) {
    if (runsFile(command, file)) return decoded ? RUN_DECODED : RUN_REMOTE
  }
  if (UPLOAD_FILE.test(command) || WGET_POST.test(command)) return EXFIL
  return null
}

// ── Deletes and overwrites ──────────────────────────────────────────────────

const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'trash-put', 'srm', 'wipe'])
/** Wrappers whose arguments are only the command that follows. */
const SIMPLE_WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'nohup', 'exec', 'time'])
/** Wrappers with their own options (the wrapped command's position is not certain). */
const COMPLEX_WRAPPERS = new Set(['env', 'timeout', 'nice', 'ionice', 'stdbuf', 'busybox', 'chroot', 'flock', 'setsid', 'unbuffer', 'watch', 'parallel', 'su', 'runuser', 'xargs', 'strace', 'taskset', 'chrt', 'script', 'awk', 'gawk', 'mawk', 'nawk', 'make', 'gmake'])
/** awk-like programs that can run shell commands themselves (system(), print | "cmd", "cmd" | getline). */
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk'])
const AWK_RUNS_SHELL = /\bsystem\s*\(|\|\s*"|"\s*\|\s*getline|\|&/
const INTERPRETER_RE = new RegExp(`^${INTERPRETERS}$`, 'i')
/** Destructive operations anywhere in a command, including inline code. */
const DESTRUCTIVE_TOKEN =
  /\b(?:rm|rmdir|unlink|shred|srm|wipe|trash(?:-put)?|mv|truncate|dd)\b|\b(?:remove|removedirs|delete|unlink|rmtree|rmSync|rmdirSync|unlinkSync|truncate|truncateSync|writeFileSync|rename|renameSync|move)\s*\(|FileUtils\.rm|:\s*>|(?:^|[^<>0-9&=-])>(?!>|&)|\bgit\s+clean\b|--delete\b|\bof=/

export interface DeleteAnalysis {
  /** Targets that resolve outside the workspace (or cannot be resolved). */
  outside: string[]
  /** Why the target cannot be known for certain (fail-closed), if so. */
  unverifiable?: string
}

/** Truncating redirects: `> f`, `: > f` (not `>>`, not `2>&1`). */
function redirectTargets(command: string): string[] {
  const targets: string[] = []
  const re = /(?:^|[^<>0-9&=-])>(?!>|&)\s*("[^"]*"|'[^']*'|[^\s;&|()]+)/g
  for (const match of command.matchAll(re)) targets.push(match[1]!.replace(/^["']|["']$/g, ''))
  return targets
}

const HARMLESS_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])

/**
 * Deletes and overwrites a command does outside the workspace. Fail-closed:
 * a command with a destructive operation whose targets cannot be known
 * statically is reported as `unverifiable` (the owner decides).
 */
export function analyzeDeletes(command: string, cwd: string): DeleteAnalysis {
  const outside = new Set<string>()
  let unverifiable: string | undefined
  const destructive = DESTRUCTIVE_TOKEN.test(command)
  const flag = (why: string) => {
    unverifiable ??= why
  }
  // The directory each part runs in: `cd <static path>` is followed, anything else is not knowable.
  let here = cwd
  const check = (raw: string, allowSinks = false, base = here) => {
    const resolvedWord = staticPath(raw)
    if (resolvedWord === undefined) {
      flag('target not known before it runs')
      outside.add(raw)
      return
    }
    const absolute = path.resolve(base, resolvedWord)
    if (allowSinks && HARMLESS_SINKS.has(absolute)) return
    if (isInsideWorkspace(cwd, absolute)) return
    if (isTemporaryPath(absolute)) return
    outside.add(resolvedWord)
  }

  if (destructive) {
    // Anything that hides where the command really acts.
    if (/(?:^|[;&|(\s])popd(?:\s|$)/.test(command) || (/[()]/.test(command) && /(?:^|[;&|(\s])(?:cd|pushd)(?:\s|$)/.test(command))) flag('changes directory')
    if (/\$\(|`|\$\{?[A-Za-z_]/.test(command.replace(/\$\{HOME\}|\$HOME\b/g, ''))) flag('uses variables or command substitution')
    if (/\{[^{}\s]*,[^{}]*\}|\{[^{}\s]*\.\.[^{}\s]*\}/.test(command)) flag('uses brace expansion')
    if (/(?:^|\s)~[A-Za-z_]/.test(command)) flag('names another user\'s home')
    if (/\beval\b/.test(command)) flag('uses eval')
    if (/\bxargs\b/.test(command)) flag('passes names through xargs')
    // A function body runs later, with arguments not known here.
    if (/(?:^|[\s;&|(])(?:function\s+[A-Za-z_][\w-]*|[A-Za-z_][\w-]*\s*\(\s*\))\s*\{/.test(command)) flag('defines a function that deletes or overwrites files')
  }

  for (const segment of shellSegments(command)) {
    const i = commandIndex(segment)
    const head = path.basename(segment[i] ?? '')
    const args = segment.slice(i + 1)
    // The segment's own words, without its redirections (those are checked on their own below).
    const segmentText = segment.filter((w, k) => !/^\d*>>?$|^\d*>>?[^>&]/.test(w) && !/^\d*>>?$/.test(segment[k - 1] ?? '')).join(' ')
    if (head === 'cd' || head === 'pushd') {
      const target = args.find((a) => !a.startsWith('-'))
      const known = target === undefined ? homedir() : staticPath(target)
      if (known === undefined) {
        if (destructive) flag('changes to a directory not known before it runs')
      } else {
        here = path.resolve(here, known)
      }
      continue
    }
    if (COMPLEX_WRAPPERS.has(head) && DESTRUCTIVE_TOKEN.test(segmentText)) flag(`runs a destructive command through ${head}`)
    if (INTERPRETER_RE.test(head) && args.some((a) => new RegExp(`^(?:${INLINE_FLAG}|-r|--eval|--command)$`).test(a)) && DESTRUCTIVE_TOKEN.test(args.join(' '))) {
      flag('inline code that deletes or overwrites files')
    }
    // awk can run any shell command from its program; what it runs is not known here.
    if (AWKS.has(head) && AWK_RUNS_SHELL.test(args.join(' '))) flag('an awk program that runs shell commands')
    // A variable run as the command, with something destructive around it.
    if (destructive && /^\$\{?[A-Za-z_]/.test(segment[i] ?? '')) flag('runs a command held in a variable')
    if (DELETE_COMMANDS.has(head)) {
      let afterDashes = false
      for (const arg of args) {
        if (!afterDashes && arg === '--') {
          afterDashes = true
          continue
        }
        if (!afterDashes && arg.startsWith('-')) continue
        check(arg)
      }
    } else if (head === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok')) {
      if (args.some((a) => a === '-exec' || a === '-execdir' || a === '-ok')) flag('find runs commands on what it finds')
      const roots: string[] = []
      for (const arg of args) {
        if (arg.startsWith('-') || arg === '!' || arg === '(') break
        roots.push(arg)
      }
      for (const root of roots.length ? roots : ['.']) check(root)
    } else if (head === 'mv') {
      const operands = args.filter((a) => !a.startsWith('-'))
      const destination = operands.at(-1)
      if (destination) {
        if (staticPath(destination) && HARMLESS_SINKS.has(path.resolve(cwd, staticPath(destination)!))) outside.add(destination)
        else check(destination)
        for (const source of operands.slice(0, -1)) check(source)
      }
    } else if (head === 'truncate' || head === 'shred') {
      for (const arg of args.filter((a, k) => !a.startsWith('-') && !/^-s$|^--size$/.test(args[k - 1] ?? ''))) check(arg)
    } else if (head === 'dd') {
      const of = args.find((a) => a.startsWith('of='))
      if (of) check(of.slice(3), true)
    } else if (head === 'git' && args.includes('clean')) {
      flag('git clean removes files it does not list first')
    } else if (head === 'rsync' && args.some((a) => /^--(?:delete|remove-source-files)/.test(a))) {
      flag('rsync deletes files')
    }
  }
  // A redirect may come before or after a cd: it must be inside from both directories.
  for (const target of redirectTargets(command)) {
    check(target, true, cwd)
    if (here !== cwd) check(target, true, here)
  }
  return { outside: [...outside], ...(unverifiable ? { unverifiable } : {}) }
}
