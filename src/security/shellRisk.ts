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

import { existsSync, statSync } from 'node:fs'
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
  return shellCommands(command).map((c) => c.words)
}

/**
 * How a simple command is joined to what comes before it: `|` (its stdin is
 * the previous command's output), `$(` / `` ` `` (it runs inside a command
 * substitution), `<(` / `>(` (a process substitution), or a plain list
 * separator (`;`, `&&`, `||`, `&`, a newline, a group).
 */
export type ShellJoin = 'start' | 'list' | 'pipe' | 'subst' | 'procsub-in' | 'procsub-out'

export interface ShellCommand {
  words: string[]
  join: ShellJoin
  /** The command word of this segment was itself a substitution (`$(…) args`, `` `…` args ``). */
  substitutedHead?: boolean
  /** Its stdin is a here-string (`<<< text`; the text is the word after the `<<<` word). */
  hereString?: boolean
  /** Its stdin is a here-document: the body, and whether the delimiter was quoted (no expansion). */
  heredoc?: { body: string; quoted: boolean }
}

/** Simple commands with how each is joined to the one before (quotes respected; nothing expanded). */
export function shellCommands(command: string): ShellCommand[] {
  const out: ShellCommand[] = []
  let words: string[] = []
  let word = ''
  let quote: '"' | "'" | undefined
  let hasWord = false
  let join: ShellJoin = 'start'
  let nextJoin: ShellJoin = 'start'
  let substitutedHead = false
  let hereString = false
  let heredoc: { delimiter: string; strip: boolean; quoted: boolean } | undefined
  /** Here-documents declared on the current line, read after its newline. */
  const pendingDocs: { delimiter: string; strip: boolean; quoted: boolean; target: ShellCommand | undefined }[] = []
  let inBacktick = false
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endSegment = (following: ShellJoin) => {
    endWord()
    if (words.length || substitutedHead || heredoc) {
      const segment: ShellCommand = { words, join, ...(substitutedHead ? { substitutedHead: true } : {}), ...(hereString ? { hereString: true } : {}) }
      out.push(segment)
      if (heredoc) pendingDocs.push({ ...heredoc, target: segment })
    }
    words = []
    substitutedHead = false
    hereString = false
    heredoc = undefined
    join = following
    nextJoin = following
  }
  /** The segment so far has no command word yet (only assignments, `{`, `!`, wrappers). */
  const atCommandPosition = () => !hasWord && commandIndex(words) >= words.length
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
    if (ch === '<' && command[i + 1] === '<') {
      endWord()
      if (command[i + 2] === '<') {
        // A here-string: the next word is what the command reads.
        i += 2
        hereString = true
        words.push('<<<')
        continue
      }
      // A here-document: `<<[-] [quote]DELIM[quote]`, its body after this line.
      let j = i + 2
      const strip = command[j] === '-'
      if (strip) j++
      while (command[j] === ' ' || command[j] === '\t') j++
      const match = /^(["']?)([A-Za-z0-9_.-]+)\1/.exec(command.slice(j))
      if (match) {
        heredoc = { delimiter: match[2]!, strip, quoted: match[1] !== '' || /\\/.test(match[0]) }
        i = j + match[0].length - 1
        continue
      }
      i += 1
      continue
    }
    if (ch === '\n' && (pendingDocs.length || heredoc)) {
      endSegment('list')
      // Read each pending body up to its delimiter line.
      let at = i + 1
      for (const doc of pendingDocs.splice(0)) {
        const lines: string[] = []
        while (at <= command.length) {
          const end = command.indexOf('\n', at)
          const line = command.slice(at, end < 0 ? command.length : end)
          at = end < 0 ? command.length + 1 : end + 1
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
          lines.push(line)
        }
        if (doc.target) doc.target.heredoc = { body: lines.join('\n'), quoted: doc.quoted }
      }
      i = at - 1
      continue
    }
    if (ch === '(') {
      // `$(`, `<(`, `>(`: the char before belongs to the substitution, not to a word.
      const before = word.at(-1)
      if (before === '$' || before === '<' || before === '>') {
        word = word.slice(0, -1)
        if (!word) hasWord = false
        const head = before === '$' && atCommandPosition()
        if (head) substitutedHead = true
        endSegment(before === '$' ? 'subst' : before === '<' ? 'procsub-in' : 'procsub-out')
        continue
      }
      endSegment('list')
      continue
    }
    if (ch === '`') {
      if (!inBacktick && atCommandPosition()) substitutedHead = true
      inBacktick = !inBacktick
      endSegment(inBacktick ? 'subst' : 'list')
      continue
    }
    if (ch === '|') {
      if (command[i + 1] === '|') {
        i++
        endSegment('list')
      } else {
        if (command[i + 1] === '&') i++
        endSegment('pipe')
      }
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === ')') {
      if (ch === '&' && command[i + 1] === '&') i++
      endSegment('list')
      continue
    }
    if (ch === ' ' || ch === '\t') {
      endWord()
      continue
    }
    word += ch
    hasWord = true
  }
  endSegment(nextJoin)
  // A body that never ends (no newline after the declaring line, or no delimiter) is still the command's input.
  for (const doc of pendingDocs) if (doc.target) doc.target.heredoc = { body: '', quoted: doc.quoted }
  return out
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

// ── Commands built at run time (fail closed) ───────────────────────────────

const RUN_BUILT: ShellRisk = { reason: 'runs a command that is only put together when it runs', reasonZh: '会运行一条运行时才拼出来的命令，看不到它到底做什么' }
const LOCKOUT: ShellRisk = { reason: 'could cut off access to this machine or destroy its data (firewall, SSH, users, processes, packages, disks)', reasonZh: '可能会让你无法再访问这台机器，或毁掉上面的数据（防火墙、SSH、用户、进程、软件包、磁盘）' }

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Wrappers that run the command after their own options, and which of those options take a value. */
const WRAPPER_OPTIONS: Record<string, RegExp> = {
  sudo: /^-[ugCphUrtD]$/,
  doas: /^-[uC]$/,
  env: /^-[uC]$|^--(?:unset|chdir)$/,
  nice: /^-n$/,
  ionice: /^-[cnp]$/,
  stdbuf: /^-[ioe]$/,
  timeout: /^-[sk]$/,
  nohup: /^$/,
  exec: /^-a$/,
  command: /^$/,
  builtin: /^$/,
  time: /^-[fo]$/,
  setsid: /^$/,
  chrt: /^$/,
  taskset: /^$/,
}

/** The command a segment runs, after assignments, `{`/`!`/`then`…, and wrappers with their options. */
export function commandHead(words: string[]): { index: number; name: string } | undefined {
  let i = 0
  for (;;) {
    while (i < words.length && (ASSIGNMENT.test(words[i]!) || LEADING_WORDS.has(words[i]!))) i++
    const word = words[i]
    if (word === undefined) return undefined
    const name = path.basename(word)
    const takesValue = WRAPPER_OPTIONS[name]
    if (!takesValue) return { index: i, name }
    i++
    while (i < words.length && /^-/.test(words[i]!) && words[i] !== '--') {
      i += takesValue.test(words[i]!) ? 2 : 1
    }
    if (words[i] === '--') i++
    if (name === 'env') while (i < words.length && ASSIGNMENT.test(words[i]!)) i++
    if (name === 'timeout' || name === 'chrt' || name === 'taskset') i++
  }
}

const SHELL_NAME = new RegExp(`^${SHELLS}$`)
const INTERPRETER_NAME = new RegExp(`^${INTERPRETERS}$`, 'i')
/** Options that give an interpreter its program in the arguments (inline code, a module). */
const INLINE_PROGRAM: [RegExp, RegExp][] = [
  [SHELL_NAME, /^-[A-Za-z]*c[A-Za-z]*$/],
  [/^python[0-9.]*$/i, /^-[A-Za-z]*[cm]$|^-[cm]./],
  [/^(?:node|deno|bun)$/i, /^-[ep]$|^--(?:eval|print)(?:=|$)|^(?:eval|run|x)$/],
  [/^perl$/i, /^-[A-Za-z]*[eE][A-Za-z]*$/],
  [/^ruby$/i, /^-[A-Za-z]*e$/],
  [/^php$/i, /^-[rR]$/],
  [/^lua$/i, /^-e$/],
]
const STDIN_SCRIPT = /^(?:-|\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/(?:self|\d+)\/fd\/\d+)$/

/** Redirections and their targets out of an argument list (`<<<` text, `< f`, `> f`, `2>&1`, …). */
function withoutRedirections(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!
    if (word === '<<<' || /^\d*(?:<|>|>>|<>)$/.test(word)) {
      i++
      continue
    }
    if (/^\d*(?:<|>|>>|<>|>&|<&)\S/.test(word) || /^\d*>&$/.test(word)) continue
    out.push(word)
  }
  return out
}

/** Whether an interpreter run with these arguments takes its program from stdin (no script, no inline code). */
function readsProgramFromStdin(name: string, args: string[]): boolean {
  const inline = INLINE_PROGRAM.find(([who]) => who.test(name))?.[1]
  for (const arg of withoutRedirections(args)) {
    if (inline?.test(arg)) return false
    if (SHELL_NAME.test(name) && /^-[A-Za-z]*s[A-Za-z]*$/.test(arg)) return true
    if (arg === '--') continue
    if (arg.startsWith('-') && arg !== '-') continue
    return STDIN_SCRIPT.test(arg)
  }
  return true
}

/** The inline program an interpreter is given (`-c CODE`, `-e CODE`), if any. */
function inlineProgram(name: string, args: string[]): { code: string | undefined } | undefined {
  const inline = INLINE_PROGRAM.find(([who]) => who.test(name))?.[1]
  if (!inline) return undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!inline.test(arg)) continue
    // `-cCODE` (python) carries the code in the same word.
    if (/^-[cm]./.test(arg) && /^python/i.test(name)) return { code: arg.slice(2) }
    return { code: args[i + 1] }
  }
  return undefined
}

const DECODING = /\b(?:base64|base32|xxd|od|openssl|uudecode|gunzip|zcat|bzcat|xzcat|gzip\s+-d|tr|rev|iconv)\b|\bprintf\b[^;&|\n]*\\(?:[0-7]{1,3}|x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{4})|\becho\s+-[A-Za-z]*e|\$'/
/** In-language decoding run as code: exec(b64decode(…)), eval(atob(…)), … */
const INLINE_DECODE_EXEC =
  /\b(?:exec|eval|compile|Function|system|popen|spawn|execSync|spawnSync|os\.system|subprocess|child_process|IO\.popen|`)\b[\s\S]{0,400}\b(?:b64decode|b32decode|a85decode|unhexlify|fromhex|decodebytes|codecs\.decode|atob|fromCharCode|Buffer\.from|unpack|decode_base64|zlib\.decompress|rot13|reversed|\[::-1\])|\b(?:b64decode|unhexlify|fromhex|atob|fromCharCode|decode_base64|zlib\.decompress)\b[\s\S]{0,400}\b(?:exec|eval|compile|Function|system|popen|spawn|execSync|subprocess|child_process)\b/

function builtRisk(command: string): ShellRisk {
  if (FETCHES.test(command) || FETCHES_CS.test(command)) return RUN_REMOTE
  if (DECODING.test(command) || DECODES.test(command)) return RUN_DECODED
  return RUN_BUILT
}

/**
 * A command whose real text only exists when it runs: a substitution, a
 * variable, an ANSI-C string or a glob as the command word; `eval`; a shell
 * given code with a substitution in it; `source` of a process substitution
 * or of stdin; any pipe, here-string or here-document into a shell or an
 * interpreter that reads its program from stdin. Whatever the inner content:
 * the owner decides.
 */
export function describeRuntimeBuiltCommand(command: string): ShellRisk | null {
  // `source <(…)`, `. <(…)`, `bash <(…)`: a program that is the output of another command.
  if (new RegExp(`(?:^|[\\s;&|({])(?:source|\\.|${INTERPRETERS})(?:\\s+-\\S+)*\\s+<\\(`, 'i').test(command)) return builtRisk(command)
  for (const segment of shellCommands(command)) {
    if (segment.substitutedHead) return builtRisk(command)
    const head = commandHead(segment.words)
    if (!head) continue
    const word = segment.words[head.index]!
    // `$X`, `${X}`, `$'\x72m'`, `/???/r?` as the command: known only when it runs ($HOME/… is a path).
    if (/[$`*?[]/.test(word.replace(/^\$(?:HOME|\{HOME\})(?=\/)/, ''))) return builtRisk(command)
    const args = segment.words.slice(head.index + 1)
    const name = head.name
    if (name === 'eval') return builtRisk(command)
    if ((name === 'source' || name === '.') && args.some((a) => STDIN_SCRIPT.test(a))) return builtRisk(command)
    // `env -S "…"` splits a string into the command it runs.
    if (head.index > 0 && path.basename(segment.words[0] ?? '') === 'env' && segment.words.slice(0, head.index).some((w) => /^-[A-Za-z]*S|^--split-string/.test(w))) return builtRisk(command)
    if (INTERPRETER_NAME.test(name)) {
      const program = inlineProgram(name, args)
      // Code with a substitution or a variable in it, or code a substitution supplies (`sh -c $(…)`).
      if (program && (program.code === undefined || (SHELL_NAME.test(name) && /[$`]/.test(program.code)))) return builtRisk(command)
      if (program?.code && INLINE_DECODE_EXEC.test(program.code)) return RUN_DECODED
      const fromStdin = readsProgramFromStdin(name, args)
      if (fromStdin && (segment.join === 'pipe' || segment.join === 'procsub-out' || segment.hereString)) return builtRisk(command)
      if (segment.heredoc && (SHELL_NAME.test(name) ? fromStdin : fromStdin && !segment.heredoc.quoted && /\$\(|`/.test(segment.heredoc.body))) return builtRisk(command)
      if (segment.heredoc && fromStdin && INLINE_DECODE_EXEC.test(segment.heredoc.body)) return RUN_DECODED
    }
    // `… | xargs sh -c`, `parallel bash`, `find -exec sh -c`: what was read becomes shell code.
    if ((name === 'xargs' || name === 'parallel' || name === 'find') && args.some((a) => SHELL_NAME.test(path.basename(a)))) return builtRisk(command)
  }
  return null
}

// ── Sending data out ───────────────────────────────────────────────────────

/** A remote operand: `host:path`, `user@host:path`, `host::module`, `rsync://…` (not `./a:b`, `/x:y`). */
const REMOTE_OPERAND = /^(?:rsync:\/\/|(?:[^@/\s:]+@)?[A-Za-z0-9.-]+(?:\]|):(?!\/\/))/
/** Network sends from inline code (a body, a socket, a mail): enough to carry a file out. */
const INLINE_NET_SEND =
  /\burlopen\s*\([^)]*,|\bRequest\s*\([^)]*\bdata\s*=|\b(?:requests|httpx|session|aiohttp\.ClientSession\(\))\.(?:post|put|patch|request)\s*\(|\bhttp\.client\b|\bsocket\.(?:socket|create_connection)\b|\bsmtplib\b|\bftplib\b|\bparamiko\b|\bfetch\s*\([^)]*\b(?:body|method)\b|\baxios(?:\.(?:post|put|patch|request))?\s*\(|\bhttps?\.request\s*\(|\bnet\.(?:connect|createConnection|Socket)\b|\bdgram\b|\bNet::HTTP\b|\bIO::Socket\b|\bLWP::UserAgent\b|\bHTTP::Tiny\b|\bTCPSocket\b|\bcurl_exec\b|\bfsockopen\b/

function curlSendsData(args: string[]): boolean {
  return args.some(
    (a) =>
      /^--(?:data(?:-binary|-raw|-urlencode|-ascii)?|json|form(?:-string)?|upload-file|post30[123])(?:=|$)/.test(a) ||
      (/^-[A-Za-z]+$/.test(a) && /[dFT]/.test(a)),
  )
}

/** A command that sends local data to another host (an upload, a body, a raw socket, a copy to a remote host). */
export function describeExfiltration(command: string): ShellRisk | null {
  if (UPLOAD_FILE.test(command) || WGET_POST.test(command)) return EXFIL
  if (/\/dev\/(?:tcp|udp)\//.test(command)) return EXFIL
  for (const segment of shellCommands(command)) {
    const head = commandHead(segment.words)
    if (!head) continue
    const args = withoutRedirections(segment.words.slice(head.index + 1))
    const name = head.name
    const operands = args.filter((a) => !a.startsWith('-'))
    switch (name) {
      case 'curl':
        if (curlSendsData(args)) return EXFIL
        break
      case 'wget':
        if (args.some((a) => /^--(?:post-(?:data|file)|body-(?:data|file))(?:=|$)/.test(a) || /^--method=(?:POST|PUT|PATCH)$/i.test(a))) return EXFIL
        break
      case 'nc':
      case 'ncat':
      case 'netcat':
        // A port check (`-z`) sends nothing; anything else connects or listens with data.
        if (!args.some((a) => /^-[A-Za-z]*z/.test(a))) return EXFIL
        break
      case 'socat':
      case 'telnet':
        if (operands.length) return EXFIL
        break
      case 'scp':
        if (operands.length >= 2 && REMOTE_OPERAND.test(operands.at(-1)!)) return EXFIL
        break
      case 'rsync':
        if (operands.length >= 2 && REMOTE_OPERAND.test(operands.at(-1)!)) return EXFIL
        break
      case 'sftp':
      case 'ftp':
      case 'tftp':
        return EXFIL
      case 'ssh':
        // Local data into a remote command: `… | ssh host`, `ssh host … < file`.
        if (segment.join === 'pipe' || segment.hereString || segment.heredoc || segment.words.some((w) => /^\d*<(?!<)/.test(w))) return EXFIL
        break
    }
    if (INTERPRETER_NAME.test(name)) {
      const program = inlineProgram(name, args)
      const code = program?.code ?? (segment.heredoc && readsProgramFromStdin(name, args) ? segment.heredoc.body : undefined)
      if (code && INLINE_NET_SEND.test(code)) return EXFIL
    }
  }
  return null
}

// ── Lock-outs ──────────────────────────────────────────────────────────────

const PACKAGE_REMOVAL: Record<string, RegExp> = {
  'apt-get': /^(?:purge|remove|autoremove)$/,
  apt: /^(?:purge|remove|autoremove)$/,
  aptitude: /^(?:purge|remove)$/,
  dpkg: /^(?:-[rP]|--purge|--remove)$/,
  yum: /^(?:remove|erase|autoremove)$/,
  dnf: /^(?:remove|erase|autoremove)$/,
  zypper: /^(?:rm|remove)$/,
  pacman: /^-R[A-Za-z]*$/,
  apk: /^del$/,
  snap: /^remove$/,
}
const SSH_UNIT = /^(?:ssh|sshd|openssh-server)(?:\.service|\.socket)?$/
const DISK_AND_POWER = new Set(['mkfs', 'mke2fs', 'mkswap', 'wipefs', 'fdisk', 'sfdisk', 'gdisk', 'sgdisk', 'parted', 'shutdown', 'reboot', 'poweroff', 'halt', 'killall5', 'userdel', 'deluser', 'groupdel', 'delgroup', 'swapoff', 'cryptsetup', 'lvremove', 'vgremove', 'pvremove', 'mdadm', 'blkdiscard'])

/**
 * A command that can lock the owner out of a machine or wreck it: firewall
 * changes, stopping or disabling SSH, locking users, killing every process,
 * removing packages, disks, power.
 */
export function describeLockout(command: string): ShellRisk | null {
  for (const segment of shellCommands(command)) {
    const head = commandHead(segment.words)
    if (!head) continue
    const name = head.name
    const args = withoutRedirections(segment.words.slice(head.index + 1))
    const first = args.find((a) => !a.startsWith('-'))
    if (DISK_AND_POWER.has(name) || /^mkfs\./.test(name)) return LOCKOUT
    if ((name === 'init' || name === 'telinit') && /^[06]$/.test(first ?? '')) return LOCKOUT
    if (/^(?:iptables|ip6tables|iptables-legacy|iptables-nft|ebtables|arptables)$/.test(name)) {
      // Listing is fine; any change to rules or policies is not.
      if (!args.every((a) => /^-(?:L|S|n|v|x|-line-numbers|-list|-list-rules|-numeric|-verbose|t|-table)$|^(?:filter|nat|mangle|raw|security|INPUT|OUTPUT|FORWARD|PREROUTING|POSTROUTING)$/.test(a))) return LOCKOUT
    }
    if (name === 'iptables-restore' || name === 'ip6tables-restore') return LOCKOUT
    if (name === 'nft' && first !== 'list') return LOCKOUT
    if (name === 'ufw' && first !== undefined && !/^(?:status|show|version|app)$/.test(first)) return LOCKOUT
    if (name === 'firewall-cmd' && !args.every((a) => /^--(?:state|list-[a-z-]+|get-[a-z-]+|query-[a-z-]+|zone=\S+|permanent)$/.test(a))) return LOCKOUT
    if (name === 'systemctl') {
      const verb = first ?? ''
      if (/^(?:poweroff|reboot|halt|kexec|emergency|rescue|isolate|suspend|hibernate)$/.test(verb)) return LOCKOUT
      if (/^(?:stop|disable|mask|kill)$/.test(verb) && args.some((a) => SSH_UNIT.test(a))) return LOCKOUT
    }
    if (name === 'service' && args[0] !== undefined && SSH_UNIT.test(args[0]) && /^(?:stop)$/.test(args[1] ?? '')) return LOCKOUT
    if (/^\/etc\/init\.d\/sshd?$/.test(segment.words[head.index]!) && args[0] === 'stop') return LOCKOUT
    if ((name === 'pkill' || name === 'killall') && args.some((a) => /^(?:sshd?|systemd|init)$/.test(a) || /^-u$|^--user$/.test(a))) return LOCKOUT
    if (name === 'kill') {
      // `kill -9 -1`, `kill -- -1`, `kill 1`: every process, or init.
      const targets: string[] = []
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (a === '--') {
          targets.push(...args.slice(i + 1))
          break
        }
        if (a === '-s' || a === '-n') {
          i++
          continue
        }
        if (/^-(?:[A-Z]+|SIG[A-Z]+|\d+)$/.test(a) && i === 0 && args.length > 1) continue
        targets.push(a)
      }
      if (targets.some((t) => t === '-1' || t === '1')) return LOCKOUT
    }
    if (name === 'passwd' && args.some((a) => /^-[A-Za-z]*[ld]|^--(?:lock|delete|expire)$/.test(a))) return LOCKOUT
    if (name === 'usermod' && args.some((a) => /^-[A-Za-z]*[Les]|^--(?:lock|expiredate|shell)/.test(a))) return LOCKOUT
    if (name === 'chage' && args.some((a) => /^-[A-Za-z]*E|^--expiredate/.test(a))) return LOCKOUT
    if (name === 'chsh' || (name === 'gpasswd' && args.includes('-d'))) return LOCKOUT
    if (name === 'crontab' && args.some((a) => /^-[A-Za-z]*r/.test(a))) return LOCKOUT
    const removal = PACKAGE_REMOVAL[name]
    if (removal && args.some((a) => removal.test(a))) return LOCKOUT
  }
  return null
}

/** A command that runs remote or hidden code, sends data out, opens a shell to the outside, or could lock the owner out. */
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
  return describeRuntimeBuiltCommand(command) ?? describeExfiltration(command) ?? describeLockout(command)
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
export const DESTRUCTIVE_TOKEN =
  /\b(?:rm|rmdir|unlink|shred|srm|wipe|trash(?:-put)?|mv|truncate|dd)\b|\b(?:remove|removedirs|delete|unlink|rmtree|rmSync|rmdirSync|unlinkSync|truncate|truncateSync|writeFileSync|rename|renameSync|move)\s*\(|FileUtils\.rm|:\s*>|(?:^|[^<>0-9&=-])>(?!>|&)|\bgit\s+clean\b|--delete\b|\bof=|\bopen\s*\([^)]*,\s*['"][^'"]*[wax+]|\.write_(?:text|bytes)\s*\(/
/** Inline code writing a file it names literally: `open('/etc/x', 'w')`, `Path('/etc/x').write_text(…)`. */
const LITERAL_FILE_WRITES = [
  /\bopen\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])[^'"]*[wax+][^'"]*\3[^)]*\)/g,
  /\bPath\s*\(\s*(['"])([^'"]+)\1\s*\)\s*\.write_(?:text|bytes)\s*\(/g,
]

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
/** The command without the bodies of its here-documents (text a command reads, not shell syntax). */
export function withoutHeredocBodies(command: string): string {
  const lines = command.split('\n')
  const out: string[] = []
  const pending: { delimiter: string; strip: boolean }[] = []
  for (const line of lines) {
    const doc = pending[0]
    if (doc) {
      if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) pending.shift()
      continue
    }
    out.push(line)
    for (const match of line.matchAll(/(?<!<)<<(-?)[ \t]*(["']?)([A-Za-z0-9_.-]+)\2/g)) pending.push({ delimiter: match[3]!, strip: match[1] === '-' })
  }
  return out.join('\n')
}

export function analyzeDeletes(fullCommand: string, cwd: string): DeleteAnalysis {
  const outside = new Set<string>()
  let unverifiable: string | undefined
  // Here-document bodies are text; a program read from one is checked as inline code below.
  const command = withoutHeredocBodies(fullCommand)
  const destructive = DESTRUCTIVE_TOKEN.test(command)
  const flag = (why: string) => {
    unverifiable ??= why
  }
  // The directory each part runs in: `cd <static path>` is followed, anything else is not knowable.
  let here = cwd
  let hereUnknown = false
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
  /** A file a command writes (tee, sed -i, chmod -R, …): outside the workspace asks; after an unknown cd, a relative one cannot be known. */
  const checkWrite = (raw: string) => {
    const known = staticPath(raw)
    if (known !== undefined && !path.isAbsolute(known) && hereUnknown) {
      flag('writes a relative path after changing to a directory not known before it runs')
      outside.add(raw)
      return
    }
    check(raw)
  }
  /** cp / install / ln -f onto `destination`: asks when it replaces something that exists outside the workspace. */
  const checkCopy = (destination: string, sources: string[]) => {
    const known = staticPath(destination)
    if (known === undefined || (!path.isAbsolute(known) && hereUnknown)) {
      flag('copies onto a path not known before it runs')
      outside.add(destination)
      return
    }
    const absolute = path.resolve(here, known)
    if (isInsideWorkspace(cwd, absolute) || isTemporaryPath(absolute) || HARMLESS_SINKS.has(absolute)) return
    let isDirectory = false
    try {
      isDirectory = statSync(absolute).isDirectory()
    } catch {
      return
    }
    if (!isDirectory) {
      outside.add(known)
      return
    }
    for (const source of sources) {
      const name = path.basename(staticPath(source) ?? source)
      if (existsSync(path.join(absolute, name))) outside.add(path.join(known, name))
    }
  }
  /** Inline code that writes files: literal targets are checked, anything else cannot be known. */
  const checkInlineCode = (code: string) => {
    let rest = code
    for (const pattern of LITERAL_FILE_WRITES) {
      for (const match of code.matchAll(pattern)) check(match[2]!)
      rest = rest.replace(pattern, '')
    }
    if (DESTRUCTIVE_TOKEN.test(rest)) flag('inline code that deletes or overwrites files')
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

  for (const parsed of shellCommands(fullCommand)) {
    const segment = parsed.words
    const i = commandIndex(segment)
    const head = path.basename(segment[i] ?? '')
    const args = segment.slice(i + 1)
    const plain = withoutRedirections(args)
    // The segment's own words, without its redirections (those are checked on their own below).
    const segmentText = segment.filter((w, k) => !/^\d*>>?$|^\d*>>?[^>&]/.test(w) && !/^\d*>>?$/.test(segment[k - 1] ?? '')).join(' ')
    if (head === 'cd' || head === 'pushd') {
      const target = args.find((a) => !a.startsWith('-'))
      const known = target === undefined ? homedir() : staticPath(target)
      if (known === undefined) {
        if (destructive) flag('changes to a directory not known before it runs')
        hereUnknown = true
      } else {
        here = path.resolve(here, known)
      }
      continue
    }
    if (COMPLEX_WRAPPERS.has(head) && DESTRUCTIVE_TOKEN.test(segmentText)) flag(`runs a destructive command through ${head}`)
    if (INTERPRETER_RE.test(head) && args.some((a) => new RegExp(`^(?:${INLINE_FLAG}|-r|--eval|--command)$`).test(a))) checkInlineCode(args.join(' '))
    // A program read from a here-document is inline code too.
    else if (INTERPRETER_RE.test(head) && parsed.heredoc) checkInlineCode(parsed.heredoc.body)
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
    } else if (head === 'tee') {
      for (const arg of plain.filter((a) => !a.startsWith('-'))) checkWrite(arg)
    } else if (head === 'sed' && plain.some((a) => /^-[nrEsuz]*i|^--in-place/.test(a))) {
      // The files after the script (all operands when the script comes with -e / -f).
      const operands: string[] = []
      let scriptGiven = false
      for (let k = 0; k < plain.length; k++) {
        const a = plain[k]!
        if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') {
          scriptGiven = true
          k++
          continue
        }
        if (/^--(?:expression|file)=/.test(a)) {
          scriptGiven = true
          continue
        }
        if (a === '-l' || a === '--line-length') {
          k++
          continue
        }
        if (a.startsWith('-')) continue
        operands.push(a)
      }
      for (const file of scriptGiven ? operands : operands.slice(1)) checkWrite(file)
    } else if ((head === 'chmod' || head === 'chown' || head === 'chgrp') && plain.some((a) => a === '--recursive' || /^-[A-Za-z]*R/.test(a))) {
      const operands = plain.filter((a) => !a.startsWith('-'))
      const byReference = plain.some((a) => a.startsWith('--reference'))
      for (const target of operands.slice(byReference ? 0 : 1)) checkWrite(target)
    } else if (head === 'cp' || head === 'install' || (head === 'ln' && plain.some((a) => /^-[A-Za-z]*f|^--force$/.test(a)))) {
      // `install -d` only makes directories.
      if (head === 'install' && plain.some((a) => /^-[A-Za-z]*d|^--directory$/.test(a))) continue
      const valued = head === 'install' ? /^-[mogtS]$|^--(?:mode|owner|group|target-directory|suffix)$/ : /^-[tS]$|^--(?:target-directory|suffix)$/
      const operands: string[] = []
      let target: string | undefined
      for (let k = 0; k < plain.length; k++) {
        const a = plain[k]!
        if (a === '-t' || a === '--target-directory') {
          target = plain[++k]
          continue
        }
        if (a.startsWith('--target-directory=')) {
          target = a.slice('--target-directory='.length)
          continue
        }
        if (valued.test(a)) {
          k++
          continue
        }
        if (a.startsWith('-')) continue
        operands.push(a)
      }
      const destination = target ?? operands.at(-1)
      if (destination !== undefined && (target !== undefined || operands.length >= 2)) checkCopy(destination, target !== undefined ? operands : operands.slice(0, -1))
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

// ── Commands on a server the agent manages (server_setup run) ──────────────

/**
 * Paths a read-only command on a server must not show: keys, password and
 * secret files, shell histories, process memory and environments, devices.
 */
const SECRET_SERVER_PATH =
  /(?:^|\/)(?:g?shadow-?|sudoers(?:\.d)?|\.ssh|ssh_host_[^/]*|\.gnupg|\.aws|\.azure|\.config\/gcloud|\.docker|\.kube|\.netrc|\.pgpass|\.my\.cnf|\.git-credentials|\.npmrc|\.pypirc|\.env(?:\.[^/]*)?|wireguard|private|secrets?|credentials?|[^/]*\.(?:key|pem|p12|pfx|jks|keystore|kdbx)|id_(?:rsa|dsa|ecdsa|ed25519)[^/]*|authorized_keys|[^/]*_history|\.htpasswd|wp-config\.php|user-data(?:\.txt)?|master\.key|token[^/]*)(?:\/|$)|^\/proc\/(?:kcore|[^/]+\/(?:environ|mem|maps|fd|cmdline|auxv|root|cwd))|^\/dev\/|^\/sys\/firmware/i
const PLAIN_WORD = /^[\w@%+=:,./-]+$/
/** A text argument (a pattern, a time such as "1 hour ago"): letters, digits and a few signs, no shell syntax. */
const PLAIN_TEXT = /^[\w @%+=:,./-]{1,200}$/

function plainPath(word: string): boolean {
  return PLAIN_WORD.test(word) && !word.split('/').includes('..') && !SECRET_SERVER_PATH.test(word)
}

/** Options (`-x`, `--name[=plain]`) a command may take; `valued` ones take the next word, which must be plain text. */
function optionsAndOperands(
  args: string[],
  { allowed, valued = /^$/ }: { allowed: RegExp; valued?: RegExp },
): { operands: string[] } | undefined {
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('-') && a !== '-') {
      if (!allowed.test(a.replace(/=.*$/, ''))) return undefined
      if (/=/.test(a) && !PLAIN_TEXT.test(a.slice(a.indexOf('=') + 1))) return undefined
      if (valued.test(a)) {
        const value = args[++i]
        if (value === undefined || !PLAIN_TEXT.test(value)) return undefined
      }
      continue
    }
    operands.push(a)
  }
  return { operands }
}

const IP_OBJECTS = new Set(['addr', 'address', 'a', 'route', 'ro', 'r', 'link', 'l', 'neigh', 'neighbor', 'neighbour', 'n', 'rule', 'ru', 'maddr', 'maddress'])
const IP_WORDS = new Set(['show', 'list', 'ls', 'lst', 'sh', 's', 'dev', 'table', 'scope', 'label', 'up', 'type', 'to', 'from', 'proto', 'all', 'main', 'default', 'global', 'link', 'host'])
const WG_FIELDS = new Set(['public-key', 'listen-port', 'peers', 'endpoints', 'allowed-ips', 'latest-handshakes', 'transfer', 'persistent-keepalive', 'fwmark'])

/** One allowed read-only command with plain arguments; `piped`: it reads the previous command's output. */
function readOnlyServerSegment(name: string, args: string[], piped: boolean): boolean {
  const paths = (operands: string[]) => operands.every(plainPath)
  switch (name) {
    case 'uptime':
    case 'free':
    case 'uname':
    case 'whoami':
    case 'nproc':
      return args.every((a) => /^-[A-Za-z]+$|^--[a-z-]+$/.test(a))
    case 'df': {
      const parsed = optionsAndOperands(args, { allowed: /^-[A-Za-z]+$|^--(?:human-readable|si|inodes|local|print-type|total|type|exclude-type|output|block-size|all)$/, valued: /^-[tx]$|^--(?:type|exclude-type|block-size)$/ })
      return parsed !== undefined && paths(parsed.operands)
    }
    case 'cat':
    case 'ls': {
      const parsed = optionsAndOperands(args, { allowed: /^-[A-Za-z0-9]+$|^--(?:all|almost-all|long|human-readable|size|sort|time|reverse|recursive|numeric-uid-gid|classify|color|full-time|show-nonprinting|number|squeeze-blank|show-all|show-ends|show-tabs)$/ })
      return parsed !== undefined && paths(parsed.operands)
    }
    case 'head':
    case 'tail': {
      const parsed = optionsAndOperands(args, { allowed: /^-[nc]$|^-\d+$|^-[fqvF]+$|^--(?:lines|bytes|follow|quiet|verbose)$/, valued: /^-[nc]$|^--(?:lines|bytes)$/ })
      return parsed !== undefined && paths(parsed.operands)
    }
    case 'stat': {
      const parsed = optionsAndOperands(args, { allowed: /^-[LfcSt]+$|^--(?:dereference|file-system|format|terse)$/, valued: /^-c$|^--format$/ })
      return parsed !== undefined && parsed.operands.length > 0 && paths(parsed.operands)
    }
    case 'wc': {
      const parsed = optionsAndOperands(args, { allowed: /^-[lwcmL]+$|^--(?:lines|words|bytes|chars|max-line-length)$/ })
      return parsed !== undefined && paths(parsed.operands)
    }
    case 'sort': {
      const parsed = optionsAndOperands(args, { allowed: /^-[bdfghinMrRuVsz]+$|^-[kt]$|^--(?:reverse|numeric-sort|human-numeric-sort|unique|key|field-separator|ignore-case|version-sort)$/, valued: /^-[kt]$|^--(?:key|field-separator)$/ })
      return parsed !== undefined && paths(parsed.operands)
    }
    case 'uniq': {
      const parsed = optionsAndOperands(args, { allowed: /^-[cdiuz]+$|^--(?:count|repeated|ignore-case|unique)$/ })
      // A second operand is the file uniq writes.
      return parsed !== undefined && parsed.operands.length <= 1 && paths(parsed.operands)
    }
    case 'grep':
    case 'egrep':
    case 'fgrep': {
      // No recursion (it would read whatever a directory holds) and no pattern file.
      const parsed = optionsAndOperands(args, { allowed: /^-[EFGiIvwxcnlLhHoqsm0-9]+$|^-[eAB C]$|^--(?:ignore-case|invert-match|word-regexp|line-regexp|count|line-number|max-count|extended-regexp|fixed-strings|quiet|silent|only-matching|regexp)$/, valued: /^-[emABC]$|^--(?:regexp|max-count)$/ })
      if (!parsed) return false
      const hasRegexpOption = args.some((a) => a === '-e' || a === '--regexp' || a.startsWith('--regexp='))
      const pattern = hasRegexpOption ? undefined : parsed.operands[0]
      const files = hasRegexpOption ? parsed.operands : parsed.operands.slice(1)
      if (!hasRegexpOption && (pattern === undefined || !PLAIN_TEXT.test(pattern))) return false
      return piped ? files.length === 0 || paths(files) : paths(files)
    }
    case 'systemctl': {
      const parsed = optionsAndOperands(args, { allowed: /^-[lan]$|^--(?:no-pager|full|lines|all|type|state|failed|plain|no-legend|user)$/, valued: /^-n$|^--(?:lines|type|state)$/ })
      if (!parsed) return false
      const [verb, ...units] = parsed.operands
      if (verb !== undefined && !/^(?:status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers)$/.test(verb)) return false
      return units.every((u) => /^[\w@.:-]+$/.test(u))
    }
    case 'journalctl': {
      const parsed = optionsAndOperands(args, {
        allowed: /^-[nuptgSUbexkrqlaoh]+$|^--(?:unit|lines|no-pager|boot|since|until|priority|catalog|pager-end|dmesg|reverse|quiet|full|all|output|no-hostname|identifier|grep|case-sensitive|utc|system)$/,
        valued: /^-[nuptgSUo]$|^--(?:unit|lines|since|until|priority|output|identifier|grep)$/,
      })
      return parsed !== undefined && parsed.operands.every((o) => /^[A-Z_]+=[\w@.:/-]+$|^\d{1,3}$/.test(o))
    }
    case 'ss':
    case 'netstat': {
      // No -K (kills sockets), no -D/-F (files).
      const parsed = optionsAndOperands(args, { allowed: /^-[tulpnaesmioxwr46H]+$|^--(?:tcp|udp|listening|processes|numeric|all|extended|summary|ipv4|ipv6|no-header)$/ })
      return parsed !== undefined && parsed.operands.every((o) => /^[\w:.=-]+$/.test(o))
    }
    case 'ip': {
      let i = 0
      while (i < args.length && /^-(?:4|6|br|brief|c|color|s|stats|d|details|o|oneline|j|json|p|pretty)$/.test(args[i]!)) i++
      const object = args[i]
      if (object === undefined || !IP_OBJECTS.has(object)) return false
      return args.slice(i + 1).every((w) => IP_WORDS.has(w) || (/^[\w:./-]+$/.test(w) && !/^(?:add|del|delete|change|chg|replace|flush|set|append|prepend|save|restore|monitor|exec|get)$/.test(w)))
    }
    case 'ufw':
      return args[0] === 'status' && args.slice(1).every((a) => a === 'verbose' || a === 'numbered')
    case 'wg': {
      if (args.length === 0) return true
      if (args[0] !== 'show') return false
      const [, iface, field, ...rest] = args
      return rest.length === 0 && (iface === undefined || /^[\w.-]{1,15}$/.test(iface)) && (field === undefined || WG_FIELDS.has(field))
    }
    case 'docker': {
      const [verb, ...rest] = args
      const command = verb === 'container' ? rest.shift() : verb
      if (command === 'ps' || command === 'ls') {
        return optionsAndOperands(rest, { allowed: /^-[aqlsn]+$|^--(?:all|quiet|latest|size|no-trunc|last)$/, valued: /^-n$|^--last$/ })?.operands.length === 0
      }
      if (command === 'logs') {
        const parsed = optionsAndOperands(rest, { allowed: /^-[ftn]+$|^--(?:follow|timestamps|tail|since|until|details|n)$/, valued: /^-n$|^--(?:tail|since|until)$/ })
        return parsed !== undefined && parsed.operands.length === 1 && /^[\w.-]+$/.test(parsed.operands[0]!)
      }
      return false
    }
    default:
      return false
  }
}

/**
 * A command on a server that only reads: a short allowlist (uptime, df,
 * free, uname, cat/ls/head/tail/stat of paths that hold no secrets,
 * systemctl status, journalctl, ss, ip addr/route/link, ufw status,
 * wg show, docker ps/logs; grep/wc/sort/uniq/head/tail to filter their
 * output) with plain arguments, joined by `;`, `&&`, `||` or `|` only.
 * Anything else asks: on such a server the agent is root.
 */
export function readOnlyServerCommand(command: string): boolean {
  if (!command.trim() || command.length > 2_000) return false
  // No substitution, variable, redirection, glob, grouping, escape, comment, background job or line break.
  if (/[`$<>(){}\\*?[\]~!#\n\r]/.test(command) || /(?:^|[^&])&(?!&)/.test(command)) return false
  const segments = shellCommands(command)
  if (!segments.length) return false
  return segments.every((segment) => {
    if (segment.join !== 'start' && segment.join !== 'list' && segment.join !== 'pipe') return false
    if (segment.hereString || segment.heredoc || segment.substitutedHead) return false
    const [name, ...args] = segment.words
    if (name === undefined || name.includes('/') || ASSIGNMENT.test(name)) return false
    if (!args.every((a) => PLAIN_TEXT.test(a))) return false
    return readOnlyServerSegment(name, args, segment.join === 'pipe')
  })
}
