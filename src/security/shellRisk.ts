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

import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
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
  // `..` as a whole first segment (a name such as `..x` is inside).
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
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
  sudo: /^-[ugCphUrtDRT]$|^--(?:chdir|chroot|user|group|host|prompt|role|type|other-user|close-from|command-timeout)$/,
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

/** Short options of a wrapper that take a value, also as the last letter of a cluster (`env -iC DIR`, `sudo -nu root`). */
const WRAPPER_VALUE_LETTERS: Record<string, string> = { sudo: 'ugCphUrtDRT', doas: 'uC', env: 'uC' }
/** Long options a wrapper takes; getopt_long accepts any unambiguous start of one (`sudo --logi`, `env --chd`). */
const WRAPPER_LONG_OPTIONS: Record<string, string[]> = {
  sudo: ['askpass', 'background', 'bell', 'chdir', 'chroot', 'close-from', 'command-timeout', 'edit', 'group', 'help', 'host', 'list', 'login', 'non-interactive', 'other-user', 'preserve-env', 'preserve-groups', 'prompt', 'remove-timestamp', 'reset-timestamp', 'role', 'set-home', 'shell', 'stdin', 'type', 'user', 'validate', 'version'],
  env: ['argv0', 'block-signal', 'chdir', 'debug', 'default-signal', 'help', 'ignore-environment', 'ignore-signal', 'list-signal-handling', 'null', 'split-string', 'unset', 'version'],
  su: ['command', 'session-command', 'fast', 'group', 'supp-group', 'login', 'preserve-environment', 'pty', 'shell', 'whitelist-environment', 'help', 'version'],
  runuser: ['command', 'session-command', 'fast', 'group', 'supp-group', 'login', 'preserve-environment', 'pty', 'shell', 'whitelist-environment', 'user', 'help', 'version'],
}

/** A wrapper's long option spelled out in full (`--logi` → `--login`, `--chd=x` → `--chdir=x`); as written when not one. */
function fullLongOption(name: string, word: string): string {
  const options = WRAPPER_LONG_OPTIONS[name]
  if (!options || !word.startsWith('--') || word === '--') return word
  const eq = word.indexOf('=')
  const given = (eq > 0 ? word.slice(2, eq) : word.slice(2))
  if (options.includes(given)) return word
  const matches = options.filter((o) => o.startsWith(given))
  return matches.length === 1 ? `--${matches[0]}${eq > 0 ? word.slice(eq) : ''}` : word
}
/** The wrappers that change the directory of what they run, and their option letter (`env -C DIR`, `sudo -D DIR`, both `--chdir`). */
const WRAPPER_CHDIR_LETTER: Record<string, string> = { env: 'C', sudo: 'D' }

/** How many words a wrapper's option takes (itself, and its value when that is the next word). */
function wrapperOptionWidth(name: string, word: string, takesValue: RegExp): number {
  if (takesValue.test(fullLongOption(name, word))) return 2
  const letters = WRAPPER_VALUE_LETTERS[name]
  return letters && /^-[A-Za-z]{2,}$/.test(word) && letters.includes(word.at(-1)!) ? 2 : 1
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
      i += wrapperOptionWidth(name, words[i]!, takesValue)
    }
    if (words[i] === '--') i++
    if (name === 'env') while (i < words.length && ASSIGNMENT.test(words[i]!)) i++
    if (name === 'timeout' || name === 'chrt' || name === 'taskset') i++
  }
}

/**
 * The directory changes the wrappers of a segment make for the command
 * they run (`env -C DIR`, `env --chdir=DIR`, `sudo -D DIR`, `sudo
 * --chdir DIR`), in order: each as written (`~`/`$HOME` expanded), or
 * undefined when it is not known before it runs.
 */
export function wrapperDirectoryChanges(words: string[]): (string | undefined)[] {
  const out: (string | undefined)[] = []
  let i = 0
  for (;;) {
    while (i < words.length && (ASSIGNMENT.test(words[i]!) || LEADING_WORDS.has(words[i]!))) i++
    const word = words[i]
    if (word === undefined) return out
    const name = path.basename(word)
    const takesValue = WRAPPER_OPTIONS[name]
    if (!takesValue) return out
    const letter = WRAPPER_CHDIR_LETTER[name]
    i++
    while (i < words.length && /^-/.test(words[i]!) && words[i] !== '--') {
      const a = fullLongOption(name, words[i]!)
      let width = wrapperOptionWidth(name, a, takesValue)
      // sudo -i / --login runs a login shell in the target user's home, and -R / --chroot a new root: where is not known here.
      if (name === 'sudo' && (a === '--login' || a === '--chroot' || a.startsWith('--chroot='))) out.push(undefined)
      if (letter) {
        let value: string | undefined
        let named = false
        if (a.startsWith('--chdir=')) {
          named = true
          value = a.slice('--chdir='.length)
        } else if (a === '--chdir') {
          named = true
          value = words[i + 1]
          width = 2
        } else if (/^-[A-Za-z]/.test(a) && !a.startsWith('--')) {
          // A cluster, letter by letter: a letter that takes a value takes the rest (or the next word).
          const valued = WRAPPER_VALUE_LETTERS[name] ?? ''
          for (let c = 1; c < a.length; c++) {
            const ch = a[c]!
            if (ch === letter) {
              const attached = a.slice(c + 1)
              named = true
              value = attached || words[i + 1]
              width = attached ? 1 : 2
              break
            }
            if (name === 'sudo' && ch === 'i') {
              out.push(undefined)
              continue
            }
            if (name === 'sudo' && ch === 'R') {
              out.push(undefined)
              width = c + 1 < a.length ? 1 : 2
              break
            }
            if (valued.includes(ch)) break
          }
        }
        if (named) out.push(value === undefined || value === '' ? undefined : staticPath(value))
      }
      i += width
    }
    if (words[i] === '--') i++
    if (name === 'env') while (i < words.length && ASSIGNMENT.test(words[i]!)) i++
    if (name === 'timeout' || name === 'chrt' || name === 'taskset') i++
  }
}

/** The directories a segment's command may run in, after its wrappers' directory changes (undefined: not known). */
function afterWrapperChanges(words: string[], bases: string[] | undefined): { bases: string[] | undefined; changed: boolean } {
  const changes = wrapperDirectoryChanges(words)
  let out = bases
  for (const change of changes) {
    if (change === undefined || out === undefined) out = undefined
    else out = path.isAbsolute(change) ? [change] : [...new Set(out.map((base) => path.resolve(base, change)))]
  }
  return { bases: out, changed: changes.length > 0 }
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
    // `echo "…" | at now`, `… | batch`, `… | expect`, `at now < file`: what was read becomes commands that run.
    if ((name === 'at' || name === 'batch' || name === 'expect') && (segment.join === 'pipe' || segment.join === 'procsub-out' || args.some((a) => /^\d*<(?!<)/.test(a)) || args.includes('-f') || (name === 'expect' && args.includes('-')))) return builtRisk(command)
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

// ── Programs that run another command given in their options ───────────

const RUN_VIA_OPTION: ShellRisk = { reason: 'makes a program run another command through its options or settings', reasonZh: '会通过程序的选项或设置去运行另一条命令' }
const GIT_COMMAND_KEYS =
  /^(?:core\.(?:sshcommand|pager|editor|fsmonitor|hookspath|gitproxy|askpass)|sequence\.editor|diff\.external|diff\.[^.=]+\.(?:textconv|command)|difftool\.[^.=]+\.cmd|mergetool\.[^.=]+\.cmd|filter\.[^.=]+\.(?:clean|smudge|process)|merge\.[^.=]+\.driver|alias\.[^=]+=\s*!|credential\.helper|gpg\.(?:[^.=]+\.)?program|uploadpack\.packobjectshook|ssh\.variant|pager\.[^=]+|interactive\.difffilter|remote\.[^.=]+\.(?:uploadpack|receivepack)|protocol\.[^=]+\.allow|url\..+\.insteadof|include\.path|includeif\..+)/i
const GIT_COMMAND_ENV = /(?:^|[\s;&|(])(?:export\s+)?(GIT_SSH_COMMAND|GIT_SSH|GIT_EXTERNAL_DIFF|GIT_PAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_ASKPASS|SSH_ASKPASS|GIT_PROXY_COMMAND|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|LESSOPEN|LESSCLOSE|PAGER|EDITOR|VISUAL)=("[^"]*"|'[^']*'|[^\s;&|]*)/g
/** Pagers and editors that run nothing else: `GIT_PAGER=cat` stays fine. */
const HARMLESS_PROGRAM = /^(?:cat|true|less|more|)$/

function runsProgramFromEnv(command: string): boolean {
  for (const match of command.matchAll(GIT_COMMAND_ENV)) {
    const name = match[1]!
    const value = match[2]!.replace(/^["']|["']$/g, '').trim()
    if (/^(?:GIT_PAGER|PAGER|GIT_EDITOR|EDITOR|VISUAL|GIT_SEQUENCE_EDITOR)$/.test(name) && HARMLESS_PROGRAM.test(value)) continue
    return true
  }
  return false
}
/** What find may run on what it finds without asking: commands that only read. */
const FIND_READ_ONLY = new Set(['ls', 'stat', 'cat', 'head', 'tail', 'wc', 'file', 'grep', 'egrep', 'fgrep', 'du', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'basename', 'dirname', 'echo', 'printf', 'test', '[', 'readlink', 'realpath'])
const EDITORS = new Set(['vim', 'vi', 'nvim', 'ex', 'view', 'vimdiff', 'gvim', 'rvim', 'nvi', 'elvis'])
const EDITOR_RUNS = /!|\bsystem\s*\(|^\s*:?\s*(?:py3?|python3?|pyx|lua|perl|ruby|ter(?:minal)?|r(?:ead)?\s*!)\b|\blua\b|\bos\.execute\b/

/**
 * A command made to run another command through a program's options or
 * settings: `git -c core.sshCommand=…` (and GIT_SSH_COMMAND and friends),
 * `tar --to-command` / `--use-compress-program` / `--checkpoint-action=exec`,
 * an editor's `-c`/`+`/`--cmd` with `!`, `less`/`more` with `!` or LESSOPEN,
 * awk's `system(`, `find -exec` of anything but a read-only command,
 * `rsync -e`, `ssh -o ProxyCommand=`.
 */
export function describeIndirectExecution(command: string): ShellRisk | null {
  if (runsProgramFromEnv(command)) return RUN_VIA_OPTION
  for (const segment of shellCommands(command)) {
    const head = commandHead(segment.words)
    if (!head) continue
    const name = head.name
    const args = segment.words.slice(head.index + 1)
    const valueOf = (i: number, flag: string) => (args[i] === flag ? args[i + 1] ?? '' : args[i]!.slice(flag.length))
    switch (name) {
      case 'git':
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!
          if (a === '-c' && GIT_COMMAND_KEYS.test(args[i + 1] ?? '')) return RUN_VIA_OPTION
          if (/^-c\S/.test(a) && GIT_COMMAND_KEYS.test(a.slice(2))) return RUN_VIA_OPTION
          if (/^--config-env(?:=|$)/.test(a) || /^--exec-path=/.test(a)) return RUN_VIA_OPTION
          // Options before the subcommand only.
          if (!a.startsWith('-')) break
        }
        break
      case 'tar':
      case 'bsdtar':
      case 'gtar':
        if (args.some((a) => /^--(?:to-command|use-compress-program|info-script|new-volume-script|checkpoint-action=exec|rsh-command)(?:=|$)/.test(a) || /^-[A-Za-z]*[IF]$/.test(a) || a === '-I')) return RUN_VIA_OPTION
        break
      case 'rsync':
        if (args.some((a) => /^-[A-Za-z]*e/.test(a) || /^--(?:rsh|rsync-path)(?:=|$)/.test(a))) return RUN_VIA_OPTION
        break
      case 'ssh':
      case 'scp':
      case 'sftp':
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!
          if (a === '-o' || /^-o\S/.test(a)) {
            if (/^\s*(?:ProxyCommand|LocalCommand|PermitLocalCommand|ProxyUseFdpass|KnownHostsCommand|Match)\b/i.test(valueOf(i, '-o'))) return RUN_VIA_OPTION
          }
          if (name !== 'ssh' && (a === '-S' || a === '-D')) return RUN_VIA_OPTION
        }
        break
      case 'less':
      case 'more':
      case 'most':
        if (args.some((a) => a.includes('!'))) return RUN_VIA_OPTION
        break
      case 'find':
        for (let i = 0; i < args.length; i++) {
          if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i]!)) continue
          const run = path.basename(args[i + 1] ?? '')
          if (!FIND_READ_ONLY.has(run)) return RUN_VIA_OPTION
        }
        break
      default:
        if (AWKS.has(name) && AWK_RUNS_SHELL.test(args.join(' '))) return RUN_VIA_OPTION
        if (EDITORS.has(name)) {
          for (let i = 0; i < args.length; i++) {
            const a = args[i]!
            const value = a === '-c' || a === '--cmd' ? args[i + 1] : a.startsWith('+') ? a.slice(1) : /^-c\S/.test(a) ? a.slice(2) : undefined
            if (value !== undefined && EDITOR_RUNS.test(value)) return RUN_VIA_OPTION
          }
        }
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
  return describeRuntimeBuiltCommand(command) ?? describeExfiltration(command) ?? describeIndirectExecution(command) ?? describeLockout(command)
}

// ── Deletes and overwrites ──────────────────────────────────────────────────

const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'trash-put', 'srm', 'wipe'])
/** Wrappers whose arguments are only the command that follows. */
const SIMPLE_WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'nohup', 'exec', 'time'])
/** Wrappers with their own options (the wrapped command's position is not certain). */
const COMPLEX_WRAPPERS = new Set(['env', 'timeout', 'nice', 'ionice', 'stdbuf', 'busybox', 'chroot', 'flock', 'setsid', 'unbuffer', 'watch', 'parallel', 'su', 'runuser', 'xargs', 'strace', 'taskset', 'chrt', 'script', 'awk', 'gawk', 'mawk', 'nawk', 'make', 'gmake'])
/**
 * Programs that run another command given in their arguments, as words or
 * as a string (`systemd-run rm …`, `tmux new -d "rm …"`, `at now <<< "…"`):
 * what that command does is not followed here, so one that deletes, writes
 * or serves asks.
 */
const RUNNERS = new Set([
  // The complex wrappers, but make (its own Makefile; `make install` is not a command it is given) and awk (checked on its own).
  ...[...COMPLEX_WRAPPERS].filter((w) => !/^(?:make|gmake|awk|gawk|mawk|nawk)$/.test(w)),
  'systemd-run', 'unshare', 'nsenter', 'firejail', 'bwrap', 'tmux', 'screen', 'at', 'batch', 'setpriv', 'sg', 'pkexec', 'proot',
  'fakeroot', 'fakechroot', 'torsocks', 'proxychains', 'proxychains4', 'faketime', 'daemonize', 'start-stop-daemon', 'chpst',
  'cgexec', 'numactl', 'prlimit', 'capsh', 'dbus-run-session', 'systemd-inhibit', 'xvfb-run', 'catchsegv', 'ltrace', 'valgrind',
  'entr', 'watchexec', 'nodemon', 'dtach', 'abduco', 'nq', 'tsp', 'pueue', 'sem', 'expect', 'sshpass',
])
/**
 * git that deletes or overwrites files in its work tree: clean, rm, mv, reset --hard, checkout [<ref>] --,
 * restore, after any global options, those whose value is the next word too (git -C /srv clean).
 * Reading an option as taking a value only ever adds a match (the regex tries both readings).
 */
const GIT_WRITE = `git\\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env|--attr-source)\\s+(?:"[^"]*"|'[^']*'|[^\\s;&|'"]+)\\s+|-\\S+\\s+)*(?:(?:clean|rm|mv|restore)\\b|reset\\s+(?:-\\S+\\s+)*--hard\\b|checkout\\s+(?:[^\\s;&|]+\\s+)*?--(?=$|[\\s;&|)}'"\`]))`
/** A word that deletes, writes or serves when it runs, anywhere in a runner's arguments (also inside a quoted string). */
const RUN_WORD = new RegExp([
  // Commands that delete or write whatever their arguments.
  `(?:^|[\\s;&|(){}'"\`])(?:[\\w.~+-]*/)*(?:rm|rmdir|unlink|shred|srm|wipe|trash|trash-put|tee|dd|mv|cp|install|ln|chmod|chown|chgrp|truncate|aria2c|yt-dlp|youtube-dl|axel|rsync|xargs)(?=$|[\\s;&|)}'"\`])`,
  // Commands that only write in some uses: git clean/rm/mv/reset --hard/checkout --, sed -i, curl -o/-O, wget (it saves unless to stdout), find -delete/-exec.
  `(?:^|[\\s;&|(){}'"\`/])${GIT_WRITE}`,
  `(?:^|[\\s;&|(){}'"\`/])sed\\b[^;&|]*\\s(?:-[A-Za-z]*i|--in-place)`,
  // curl -o to a sink (/dev/null, stdout) writes no file, as for curl run directly.
  `(?:^|[\\s;&|(){}'"\`/])curl\\b[^;&|]*\\s(?:-[A-Za-z]*O|--remote-name|--output-dir|(?:-[A-Za-z]*o|--output)(?![\\s=]*(?:/dev/(?:null|stdout|stderr|tty)|-)(?:$|[\\s;&|)}'"\`])))`,
  `(?:^|[\\s;&|(){}'"\`/])wget\\b(?![^;&|]*(?:\\s-[A-Za-z]*O\\s*-(?:\\s|$)|--spider|--output-document=?-(?:\\s|$)))`,
  `(?:^|[\\s;&|(){}'"\`/])find\\b[^;&|]*\\s-(?:delete|exec|execdir|ok|okdir|fprint\\w*|fls)\\b`,
  '>',
].join('|'))
/** A web server word in a runner's arguments (left to listeningServers for the runners it reads into). */
const RUN_SERVER_WORD = /\bhttp\.server\b|\bSimpleHTTPServer\b|(?:^|[\s;&|'"`/])php\b[^;&|]*\s-S|\bhttp-server\b|(?:^|[\s;&|'"`/])serve(?=$|\s)|\bhttpd\b/
/** Runners whose command analyzeDeletes reads itself (unwrapRunner), in the directory it runs in. */
const READ_INTO_RUNNERS = new Set(['su', 'runuser', 'flock', 'systemd-run'])
/** A command name that deletes, writes or runs others, as xargs's command. */
const XARGS_RISKY = /^(?:rm|rmdir|unlink|shred|srm|wipe|trash|trash-put|tee|dd|mv|cp|install|ln|chmod|chown|chgrp|truncate|sed|curl|wget|aria2c|rsync|git|find|xargs|env|sudo|doas|perl|ruby|php|node|deno|bun|lua|python[0-9.]*|(?:ba|z|k|da)?sh)$/
/** The same as a command of its own: the first operand, or the start of a string (or a part after ;, &, |). */
const RUN_WORD_AT_START = new RegExp(String.raw`^(?:[\w.~+-]*\/)*(?:rm|rmdir|unlink|shred|srm|wipe|tee|dd|mv|cp|install|ln|chmod|chown|chgrp|truncate|httpd|http-server|serve)$|(?:^|[;&|]\s*)(?:[\w.~+-]*\/)*(?:rm|rmdir|unlink|shred|srm|wipe|tee|dd|mv|cp|install|ln|chmod|chown|chgrp|truncate|http-server|serve|httpd)\s|\bhttp\.server\b|\bSimpleHTTPServer\b|(?:^|[;&|]\s*)php\b[^;&|]*\s-S|>` + `|(?:^|[;&|]\\s*)(?:[\\w.~+-]*/)*${GIT_WRITE}`)
/**
 * Commands whose arguments are data, not a command they run: for any other
 * (an unknown program or a script), a command word at the start of an
 * argument, or a redirect inside one, asks (it may run it).
 */
const KNOWN_COMMANDS = new Set([
  'ls', 'cat', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'diff', 'cmp',
  'comm', 'paste', 'column', 'nl', 'fold', 'fmt', 'rev', 'tac', 'less', 'more', 'file', 'stat', 'du', 'df', 'free', 'uname', 'whoami', 'id', 'date',
  'pwd', 'cd', 'pushd', 'popd', 'which', 'type', 'true', 'false', 'test', '[', 'sleep', 'basename', 'dirname', 'realpath', 'readlink', 'md5sum',
  'sha1sum', 'sha256sum', 'sha512sum', 'base64', 'xxd', 'od', 'hexdump', 'mkdir', 'touch', 'git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'npx',
  'pip', 'pip3', 'uv', 'poetry', 'cargo', 'go', 'rustc', 'tsc', 'eslint', 'prettier', 'vite', 'next', 'jest', 'vitest', 'pytest', 'mocha',
  'ffmpeg', 'ffprobe', 'convert', 'magick', 'identify', 'pdftotext', 'pdfinfo', 'blender', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'xz',
  'zcat', 'ps', 'top', 'kill', 'pkill', 'pgrep', 'lsof', 'ss', 'netstat', 'ip', 'ping', 'dig', 'nslookup', 'host', 'curl', 'wget', 'ssh',
  'scp', 'rsync', 'sftp', 'export', 'set', 'unset', 'source', '.', 'exit', 'return', 'read', 'wait', 'history', 'alias', 'local', 'declare',
  'seq', 'yes', 'expr', 'bc', 'awk', 'gawk', 'mawk', 'nawk', 'sed', 'find', 'tee', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'chmod',
  'chown', 'chgrp', 'install', 'truncate', 'shred', 'dd', 'unlink', 'systemctl', 'journalctl', 'docker', 'kubectl', 'openssl', 'sqlite3',
  'psql', 'mysql', 'redis-cli', 'code', 'open', 'xdg-open', 'vim', 'vi', 'nvim', 'nano', 'emacs', 'make', 'cmake', 'java', 'javac', 'mvn',
  'gradle', 'dotnet', 'php', 'composer', 'ruby', 'gem', 'bundle', 'perl', 'node', 'deno', 'python', 'python3', 'lua', 'R', 'Rscript', 'aria2c',
  'yt-dlp', 'youtube-dl', 'axel', 'http', 'https', 'xh', 'apt', 'apt-get', 'dpkg', 'brew', 'artemis', 'pandoc', 'libreoffice', 'soffice',
  'tesseract', 'whisper', 'say', 'espeak', 'qrencode', 'zbarimg', 'exiftool', 'mediainfo', 'sox', 'lame', 'opusenc', 'gifsicle', 'optipng',
  'pngquant', 'cwebp', 'dwebp', 'rsvg-convert', 'inkscape', 'gs', 'qpdf', 'mutool', 'wkhtmltopdf', 'chromium', 'google-chrome', 'playwright',
])

/** awk-like programs that can run shell commands themselves (system(), print | "cmd", "cmd" | getline). */
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk'])
const AWK_RUNS_SHELL = /\bsystem\s*\(|\|\s*"|"\s*\|\s*getline|\|&/
const INTERPRETER_RE = new RegExp(`^${INTERPRETERS}$`, 'i')
/** Destructive operations anywhere in a command, including inline code. */
export const DESTRUCTIVE_TOKEN =
  /\b(?:rm|rmdir|unlink|shred|srm|wipe|trash(?:-put)?|mv|truncate|dd)\b|\b(?:remove|removedirs|delete|unlink|rmtree|rmSync|rmdirSync|unlinkSync|truncate|truncateSync|writeFileSync|rename|renameSync|move)\s*\(|FileUtils\.rm|:\s*>|(?:^|[^<>0-9&=-])>>?(?!&)|\bgit\s+clean\b|--?delete\b|\bof=|\bopen\s*\([^)]*,\s*['"][^'"]*[wax+]|\.write_(?:text|bytes)\s*\(/
/** Places whose files run later on their own: login scripts, autostart entries, services, cron, SSH keys. */
const STARTUP_PATH =
  /(?:^|\/)(?:\.bashrc|\.bash_profile|\.bash_login|\.profile|\.zshrc|\.zprofile|\.zshenv|\.xprofile|\.xinitrc|\.config\/autostart\/|\.config\/systemd\/|\.config\/fish\/|\.local\/share\/applications\/|\.ssh\/)|^\/etc\/(?:profile|bash\.bashrc|cron|systemd\/|init\.d\/|rc\.local|xdg\/autostart\/|sudoers)|^\/var\/spool\/cron\//
/** Command directories in the home (and on PATH) the agent can write: a new file there shadows a command. */
function writableCommandDirs(): string[] {
  const home = homedir()
  const dirs = new Set(['bin', '.local/bin', '.cargo/bin', 'go/bin', '.npm-global/bin', '.bun/bin', '.deno/bin', '.yarn/bin'].map((d) => path.join(home, d)))
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue
    try {
      accessSync(dir, fsConstants.W_OK)
      dirs.add(dir)
    } catch {
      // Not writable for this user: nothing new can appear there.
    }
  }
  return [...dirs].map((dir) => realPathOf(dir))
}

/** A path (a directory ends with `/`) where a new file runs later: STARTUP_PATH, or a command directory the agent can write. */
function isStartupPath(target: string): boolean {
  if (STARTUP_PATH.test(target)) return true
  const directory = target.endsWith('/') ? target.slice(0, -1) : path.dirname(target)
  const real = realPathOf(directory)
  return writableCommandDirs().some((dir) => real === dir) || /\/(?:\.local\/bin|bin)$/.test(directory) && directory.startsWith('/home/')
}

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
  /** The same reason in the owner's words (Chinese), for the approval card. */
  unverifiableZh?: string
  /** What happens to the outside targets: removed (rm, find -delete, mv away) and/or written (redirects, tee, cp onto, downloads). */
  removes?: boolean
  writes?: boolean
}

/** Files a redirect writes: `> f`, `: > f`, and appends `>> f` (a line added to ~/.bashrc runs later); not `2>&1`. */
function redirectTargets(command: string): string[] {
  const targets: string[] = []
  const re = /(?:^|[^<>0-9&=-])>>?(?!&)\s*("[^"]*"|'[^']*'|[^\s;&|()]+)/g
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

export function analyzeDeletes(fullCommand: string, cwd: string, depth = 0): DeleteAnalysis {
  const outside = new Set<string>()
  let unverifiable: string | undefined
  let unverifiableZh: string | undefined
  let removes = false
  let writes = false
  // Here-document bodies are text; a program read from one is checked as inline code below.
  const command = withoutHeredocBodies(fullCommand)
  const destructive = DESTRUCTIVE_TOKEN.test(command)
  const flag = (why: string, whyZh: string) => {
    if (unverifiable !== undefined) return
    unverifiable = why
    unverifiableZh = whyZh
  }
  /** What the check being made does to its target: decides the card's wording, never whether it asks. */
  let operation: 'remove' | 'write' = 'write'
  const addOutside = (target: string) => {
    outside.add(target)
    if (operation === 'remove') removes = true
    else writes = true
  }
  // The directories each part may run in. `cd <static path>` adds the
  // directory it leads to, without dropping the ones before it: a subshell
  // (`(cd x && …)`), `popd`, `cd -` or a cd that fails puts the shell back in
  // an earlier one, so a relative target must be fine from every candidate.
  // A cd to a place not known before it runs makes relative targets unknown.
  let heres = [cwd]
  let hereUnknown = false
  const MAX_DIRECTORIES = 32
  const check = (raw: string, allowSinks = false, bases: string[] = heres) => {
    const resolvedWord = staticPath(raw)
    if (resolvedWord === undefined) {
      flag('target not known before it runs', '目标要到运行时才知道')
      addOutside(raw)
      return
    }
    // After a change to a directory not known before it runs (a cd, env -C, sudo -D, sudo -i), a relative target is not known either.
    if (!path.isAbsolute(resolvedWord) && hereUnknown && !(allowSinks && HARMLESS_SINKS.has(resolvedWord))) {
      flag('acts on a relative path after changing to a directory not known before it runs', '先切换到一个运行时才知道的目录，再操作相对路径')
      addOutside(raw)
      return
    }
    for (const base of path.isAbsolute(resolvedWord) ? [cwd] : bases) {
      const absolute = path.resolve(base, resolvedWord)
      if (allowSinks && HARMLESS_SINKS.has(absolute)) continue
      if (isInsideWorkspace(cwd, absolute)) continue
      if (isTemporaryPath(absolute)) continue
      addOutside(path.isAbsolute(resolvedWord) || base === cwd ? resolvedWord : absolute)
    }
  }
  /** A file a command writes (tee, sed -i, chmod -R, …): outside the workspace asks; after an unknown cd, a relative one cannot be known. */
  const checkWrite = (raw: string, allowSinks = false) => {
    const known = staticPath(raw)
    if (known !== undefined && !path.isAbsolute(known) && hereUnknown) {
      flag('writes a relative path after changing to a directory not known before it runs', '先切换到一个运行时才知道的目录，再写入相对路径')
      addOutside(raw)
      return
    }
    check(raw, allowSinks)
  }
  /** cp / install / ln -f onto `destination`: asks when it replaces something that exists outside the workspace. */
  const checkCopy = (destination: string, sources: string[]) => {
    const known = staticPath(destination)
    if (known === undefined || (!path.isAbsolute(known) && hereUnknown)) {
      flag('copies onto a path not known before it runs', '会复制到一个运行时才知道的位置')
      addOutside(destination)
      return
    }
    for (const base of path.isAbsolute(known) ? [cwd] : heres) {
      const absolute = path.resolve(base, known)
      const shown = path.isAbsolute(known) || base === cwd ? known : absolute
      if (isInsideWorkspace(cwd, absolute) || isTemporaryPath(absolute) || HARMLESS_SINKS.has(absolute)) continue
      let isDirectory = false
      try {
        isDirectory = statSync(absolute).isDirectory()
      } catch {
        // A new file where something runs later (a login script, an autostart entry, a unit, a
        // command in a PATH directory the agent can write: `cp x ~/bin/ls`) asks too.
        if (isStartupPath(absolute) || isStartupPath(`${absolute}/`)) addOutside(shown)
        continue
      }
      if (isDirectory && isStartupPath(`${absolute}/`)) {
        addOutside(shown)
        continue
      }
      if (!isDirectory) {
        addOutside(shown)
        continue
      }
      for (const source of sources) {
        const name = path.basename(staticPath(source) ?? source)
        if (existsSync(path.join(absolute, name))) addOutside(path.join(shown, name))
      }
    }
  }
  /** A download saved under its remote name into `directory` (curl -O, wget without -O): the directory must be fine. */
  const checkSaveInto = (directory: string | undefined) => {
    if (directory === undefined) {
      if (hereUnknown) {
        flag('saves a download after changing to a directory not known before it runs', '先切换到一个运行时才知道的目录，再把下载的文件存进去')
        addOutside('.')
        return
      }
      for (const base of heres) {
        if (!isInsideWorkspace(cwd, base) && !isTemporaryPath(base)) addOutside(`${base}/`)
      }
      return
    }
    checkWrite(directory.endsWith('/') ? directory : `${directory}/`)
  }
  /** Inline code that writes files: literal targets are checked, anything else cannot be known. */
  const checkInlineCode = (code: string) => {
    let rest = code
    for (const pattern of LITERAL_FILE_WRITES) {
      for (const match of code.matchAll(pattern)) check(match[2]!)
      rest = rest.replace(pattern, '')
    }
    if (DESTRUCTIVE_TOKEN.test(rest)) flag('inline code that deletes or overwrites files', '内嵌的代码会删除或改写文件')
  }

  if (destructive) {
    // Anything that hides where the command really acts. (A cd is followed: see `heres`.)
    if (/\$\(|`|\$\{?[A-Za-z_]/.test(command.replace(/\$\{HOME\}|\$HOME\b/g, ''))) flag('uses variables or command substitution', '用到了变量或命令替换')
    if (/\{[^{}\s]*,[^{}]*\}|\{[^{}\s]*\.\.[^{}\s]*\}/.test(command)) flag('uses brace expansion', '用到了花括号展开')
    if (/(?:^|\s)~[A-Za-z_]/.test(command)) flag('names another user\'s home', '涉及其他用户的主目录')
    if (/\beval\b/.test(command)) flag('uses eval', '用到了 eval')
    if (/\bxargs\b/.test(command)) flag('passes names through xargs', '通过 xargs 传递文件名')
    // A function body runs later, with arguments not known here.
    if (/(?:^|[\s;&|(])(?:function\s+[A-Za-z_][\w-]*|[A-Za-z_][\w-]*\s*\(\s*\))\s*\{/.test(command)) flag('defines a function that deletes or overwrites files', '定义了一个会删除或改写文件的函数')
  }

  // The directories as the shell keeps them (a cd); a wrapper's directory change applies to its one command.
  let shellHeres = heres
  let shellUnknown = false
  for (const parsed of shellCommands(fullCommand)) {
    const segment = parsed.words
    heres = shellHeres
    hereUnknown = shellUnknown
    const wrapped = afterWrapperChanges(segment, heres)
    if (wrapped.changed) {
      if (wrapped.bases === undefined) {
        if (destructive) flag('changes to a directory not known before it runs', '会切换到一个运行时才知道的目录')
        hereUnknown = true
      } else {
        heres = wrapped.bases
      }
    }
    // The command itself, past wrappers and their options (`sudo -u root rm …`, `env -C /etc tee …`).
    const wrapper = path.basename(segment[commandIndex(segment)] ?? '')
    const resolved = commandHead(segment)
    const i = resolved && (WRAPPER_OPTIONS[wrapper] || (segment[commandIndex(segment)] ?? '').startsWith('-')) ? resolved.index : commandIndex(segment)
    const head = path.basename(segment[i] ?? '')
    const args = segment.slice(i + 1)
    const plain = withoutRedirections(args)
    // The segment's own words, without its redirections (those are checked on their own below).
    const segmentText = segment.filter((w, k) => !/^\d*>>?$|^\d*>>?[^>&]/.test(w) && !/^\d*>>?$/.test(segment[k - 1] ?? '')).join(' ')
    operation = 'write'
    if (head === 'cd' || head === 'pushd') {
      const target = args.find((a) => !a.startsWith('-') || a === '-')
      // `cd -` and `pushd` with no directory go back to a directory already among the candidates.
      if (target === '-' || (head === 'pushd' && target === undefined)) continue
      const known = target === undefined ? homedir() : staticPath(target)
      if (known === undefined) {
        if (destructive) flag('changes to a directory not known before it runs', '会切换到一个运行时才知道的目录')
        shellUnknown = true
      } else {
        const next = [...new Set([...shellHeres, ...shellHeres.map((base) => path.resolve(base, known))])]
        if (next.length > MAX_DIRECTORIES) {
          if (destructive) flag('changes directory too many times to follow', '切换目录的次数太多，无法逐一确认')
          shellUnknown = true
        } else {
          shellHeres = next
        }
      }
      continue
    }
    if (head === 'popd') continue
    // A program that runs another command (or one not known) with a command word in its arguments: that
    // command is not followed here, so it asks.
    let readInto = false
    if (head && !INTERPRETER_RE.test(head)) {
      const hereString = parsed.hereString ? args[args.indexOf('<<<') + 1] : undefined
      // All the arguments as one line (`git clean -fdx` given as separate words; a word's use is read
      // with the words after it), and each string that holds a command of its own.
      const runnerWords = [...plain, ...(hereString ? [hereString] : []), ...(parsed.heredoc ? [parsed.heredoc.body] : [])]
      // The line once more with its spaced words quoted (git -C "/srv x" clean: the value is one word).
      const runnerText = [runnerWords.join(' '), runnerWords.map(quoteSpaced).join(' '), ...runnerWords.filter((w) => /\s/.test(w))]
      // `head` is the command past the wrappers commandHead reads (env, nice, timeout, …): those are checked as what they run.
      const inner = READ_INTO_RUNNERS.has(head) && depth < 2 ? unwrapRunner(head, plain) : undefined
      if (head === 'busybox' && plain[0] === 'httpd') {
        // A web server, checked as one (listeningServers).
      } else if (inner) {
        // su -c, flock, systemd-run: the command they run, read as one, in the directory it runs in
        // (a login, a service without --same-dir: not known; servers are left to listeningServers).
        const dirs = inner.keepsDir ? (hereUnknown ? undefined : heres) : inner.dir !== undefined ? [inner.dir] : undefined
        const into = dirs === undefined ? "cd '?' && " : dirs.filter((d) => d !== cwd).map((d) => `cd ${shellQuote(d)}; `).join('')
        const text = inner.code ?? (inner.words ?? []).map(shellQuote).join(' ')
        const found = analyzeDeletes(`${into}${text}`, cwd, depth + 1)
        readInto = true
        for (const target of found.outside) {
          operation = found.removes && !found.writes ? 'remove' : 'write'
          addOutside(target)
        }
        if (found.removes) removes = true
        if (found.unverifiable) flag(found.unverifiable, found.unverifiableZh ?? found.unverifiable)
        // su without -m/-p: `~` and $HOME are the other user's home.
        if (inner.homeChanges && /(?:^|[\s=:'"])~|\$\{?HOME\b/.test(text) && (DESTRUCTIVE_TOKEN.test(text) || RUN_WORD.test(text))) {
          flag(`uses the home of the user ${head} switches to`, `用到了 ${head} 切换到的那个用户的主目录`)
        }
        // A parse that is not certain (an option the classifier does not know, a command it does not
        // read) only ever adds to the broad scan below, never replaces it.
        if (!inner.certain || (inner.words !== undefined && !recognisedCommand(inner.words))) {
          if (runnerText.some((a) => RUN_WORD.test(a) || DESTRUCTIVE_TOKEN.test(a) || RUN_SERVER_WORD.test(a))) flag(`runs a command through ${head} that may delete, write or serve files`, `会通过 ${head} 运行一条可能删除、改写或对外提供文件的命令`)
          readInto = false
        }
      } else if (head === 'xargs') {
        // xargs runs the command after its own options on the names it reads.
        const run = xargsCommand(plain)
        const command = run.words.length ? commandHead(run.words)?.name : undefined
        if (command !== undefined && XARGS_RISKY.test(command)) flag(`passes names to ${command} through xargs`, `会通过 xargs 把文件名交给 ${command}`)
        // Options it cannot read for sure: the broad scan too.
        else if (!run.certain && runnerText.some((a) => RUN_WORD.test(a) || DESTRUCTIVE_TOKEN.test(a))) flag('passes names through xargs to a command that may delete or write files', '会通过 xargs 把文件名交给一条可能删除或改写文件的命令')
      } else if (RUNNERS.has(head)) {
        // chroot's paths are the new root's; the others run what they are given: a word that deletes,
        // writes or serves asks. chroot's servers are read by listeningServers (in a directory not known).
        const servers = head !== 'chroot'
        if (runnerText.some((a) => RUN_WORD.test(a) || DESTRUCTIVE_TOKEN.test(a) || (servers && RUN_SERVER_WORD.test(a)))) {
          flag(`runs a command through ${head} that may delete, write or serve files`, `会通过 ${head} 运行一条可能删除、改写或对外提供文件的命令`)
        }
      } else if (!KNOWN_COMMANDS.has(head) && !DELETE_COMMANDS.has(head)) {
        if (passesACommand(plain, runnerWords)) {
          flag(`passes a command that may delete, write or serve files to ${head}, a program the classifier cannot follow`, `把一条可能删除、改写或对外提供文件的命令交给了无法确认的程序 ${head}`)
        }
      }
    } else if (head && !(args.some((a) => new RegExp(`^(?:${INLINE_FLAG}|-r|--eval|--command)$`).test(a)) || parsed.heredoc)) {
      // An interpreter or a shell running a script: the script's own arguments as for a program the classifier cannot follow.
      const scriptAt = scriptIndex(head, plain)
      const scriptArgs = scriptAt < 0 ? [] : plain.slice(scriptAt + 1)
      if (passesACommand(scriptArgs, scriptArgs)) {
        flag(`passes a command that may delete, write or serve files to the script ${plain[scriptAt]}, which the classifier cannot follow`, `把一条可能删除、改写或对外提供文件的命令交给了脚本 ${plain[scriptAt]}，无法确认它会做什么`)
      }
    }
    if (!readInto && (COMPLEX_WRAPPERS.has(head) || COMPLEX_WRAPPERS.has(wrapper)) && DESTRUCTIVE_TOKEN.test(segmentText)) flag(`runs a destructive command through ${COMPLEX_WRAPPERS.has(wrapper) ? wrapper : head}`, `会通过 ${COMPLEX_WRAPPERS.has(wrapper) ? wrapper : head} 运行会删除或改写文件的命令`)
    if (INTERPRETER_RE.test(head) && args.some((a) => new RegExp(`^(?:${INLINE_FLAG}|-r|--eval|--command)$`).test(a))) checkInlineCode(args.join(' '))
    // A program read from a here-document is inline code too.
    else if (INTERPRETER_RE.test(head) && parsed.heredoc) checkInlineCode(parsed.heredoc.body)
    // awk can run any shell command from its program; what it runs is not known here.
    if (AWKS.has(head) && AWK_RUNS_SHELL.test(args.join(' '))) flag('an awk program that runs shell commands', 'awk 程序会运行其他命令')
    // A variable run as the command, with something destructive around it.
    if (destructive && /^\$\{?[A-Za-z_]/.test(segment[i] ?? '')) flag('runs a command held in a variable', '会运行保存在变量里的命令')
    if (DELETE_COMMANDS.has(head)) {
      operation = 'remove'
      let afterDashes = false
      for (const arg of args) {
        if (!afterDashes && arg === '--') {
          afterDashes = true
          continue
        }
        if (!afterDashes && arg.startsWith('-')) continue
        check(arg)
      }
    } else if (head === 'find' && args.some((a, k) => a === '-delete' || (/^-(?:exec|execdir|ok|okdir)$/.test(a) && !FIND_READ_ONLY.has(path.basename(args[k + 1] ?? ''))))) {
      operation = 'remove'
      if (args.some((a, k) => /^-(?:exec|execdir|ok|okdir)$/.test(a) && !FIND_READ_ONLY.has(path.basename(args[k + 1] ?? '')))) flag('find runs commands on what it finds', 'find 会对找到的文件运行命令')
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
        if (staticPath(destination) && HARMLESS_SINKS.has(path.resolve(cwd, staticPath(destination)!))) addOutside(destination)
        else check(destination)
        operation = 'remove'
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
      removes = true
      flag('git clean removes files it does not list first', 'git clean 会删除文件，而且不会先列出来')
    } else if (head === 'rsync' && args.some((a) => /^--(?:delete|remove-source-files)/.test(a))) {
      removes = true
      flag('rsync deletes files', 'rsync 会删除文件')
    } else if (head === 'curl' || head === 'wget') {
      // Where a download is saved: `curl -o FILE`, `-O` (its remote name), `wget -O FILE`, `-P DIR`, or by default (wget).
      const saves = downloadTargets(head, plain)
      if (saves.unknown) flag(saves.unknown.en, saves.unknown.zh)
      for (const file of saves.files) checkWrite(file, true)
      for (const directory of saves.directories) checkSaveInto(directory)
    } else if (head === 'aria2c' || HTTPIE.has(head) || OTHER_DOWNLOADERS.has(head)) {
      const saves = otherDownloadTargets(head, plain)
      if (saves.unknown) flag(saves.unknown.en, saves.unknown.zh)
      for (const file of saves.files) checkWrite(file, true)
      for (const directory of saves.directories) checkSaveInto(directory)
    } else {
      // Any other program told where to write its output (`--output FILE`, `--output-dir DIR`, …): the
      // place must be fine, whatever the program (a downloader this does not know fails closed here).
      for (const file of genericOutputs(plain)) checkWrite(file, true)
    }
  }
  // A redirect may come before or after a cd: it must be fine from every directory it may run in.
  heres = shellHeres
  hereUnknown = shellUnknown
  operation = 'write'
  for (const target of redirectTargets(command)) check(target, true)
  return {
    outside: [...outside],
    ...(unverifiable ? { unverifiable, ...(unverifiableZh ? { unverifiableZh } : {}) } : {}),
    ...(removes ? { removes } : {}),
    ...(writes ? { writes } : {}),
  }
}

/** httpie (and its look-alike xh): `--download` saves under the remote name, `-o/--output` names the file. */
const HTTPIE = new Set(['http', 'https', 'httpie', 'xh', 'xhs'])
/** Downloaders that save into the current directory unless told otherwise (`-o`/`-O`/`-P`/`-d`/`--output`/`--paths`). */
const OTHER_DOWNLOADERS = new Set(['axel', 'yt-dlp', 'youtube-dl', 'gallery-dl', 'you-get'])
/** Long options that name where any program writes its output. */
const OUTPUT_OPTION = /^--(?:output|output-file|output-document|output-dir|outdir|out-dir|out|outfile|out-file|download-dir|destination|dest|save-to|target-dir)$/

/** The files and directories a program is told to write through an output option (`--output X`, `--output=X`). */
function genericOutputs(args: string[]): string[] {
  const out: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--') break
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(0, eq) : a
    if (!OUTPUT_OPTION.test(name)) continue
    const value = eq > 0 ? a.slice(eq + 1) : args[++k]
    if (value !== undefined && value !== '-') out.push(value)
  }
  return out
}

/** Where aria2c, httpie and other downloaders save (files by name, directories under the remote name). */
function otherDownloadTargets(head: string, args: string[]): { files: string[]; directories: (string | undefined)[]; unknown?: { en: string; zh: string } } {
  const files: string[] = genericOutputs(args)
  const dirs: string[] = []
  const named: string[] = []
  let download = !HTTPIE.has(head)
  let unknown: { en: string; zh: string } | undefined
  const fromFile = { en: 'reads its options from a file', zh: '会从一个文件里读取选项（包括保存位置）' }
  // yt-dlp's `TYPE:` prefixes (`-P home:/x`, `-o thumbnail:/x/%(id)s.jpg`) name which file goes there, not the path.
  const untyped = (value: string | undefined) => (value === undefined ? undefined : value.replace(/^[A-Za-z_]+:(?!\/\/)/, ''))
  const shortValue = (a: string, letters: string): { letter: string; value: string | undefined; attached: boolean } | undefined => {
    const m = new RegExp(`^-([${letters}])(.*)$`).exec(a)
    return m ? { letter: m[1]!, value: m[2] || undefined, attached: !!m[2] } : undefined
  }
  const add = (list: string[], value: string | undefined) => {
    if (value !== undefined && value !== '-') list.push(value)
  }
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--') break
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(0, eq) : a
    const long = () => (eq > 0 ? a.slice(eq + 1) : args[++k])
    if (head === 'aria2c') {
      if (name === '--dir') add(dirs, long())
      else if (name === '--out') add(named, long())
      // Files it writes beside the download: its log, its session, cookies, DHT and server stats.
      else if (/^--(?:log|save-session|save-cookies|dht-file-path6?|server-stat-of)$/.test(name)) add(files, long())
      else if (name === '--input-file' || name === '--conf-path') unknown ??= fromFile
      else {
        const s = shortValue(a, 'doil')
        if (s?.letter === 'd') add(dirs, s.attached ? s.value : args[++k])
        else if (s?.letter === 'o') add(named, s.attached ? s.value : args[++k])
        else if (s?.letter === 'l') add(files, s.attached ? s.value : args[++k])
        else if (s?.letter === 'i') unknown ??= fromFile
      }
    } else if (HTTPIE.has(head)) {
      if (name === '--download' || a === '-d' || (/^-[A-Za-z]+$/.test(a) && a.includes('d') && !a.includes('o'))) download = true
      else if (name === '--output') add(named, long())
      else if (a === '-o' || /^-[A-Za-z]*o$/.test(a)) {
        add(named, args[++k])
        if (/d/.test(a)) download = true
      }
    } else {
      const s = shortValue(a, 'oOPd')
      if (name === '--paths' || name === '-P') add(dirs, untyped(long()))
      else if (name === '--output') add(named, untyped(long()))
      // Files it writes beside the download (cookies are saved back, the archive grows).
      else if (/^--(?:cookies|download-archive)$/.test(name)) add(files, long())
      // A command it runs on what it downloads: what that does is not known here.
      else if (/^--exec(?:-before-download)?$/.test(name)) unknown ??= { en: 'runs a command it is given on what it downloads', zh: '会对下载的内容运行它被指定的命令' }
      else if (name === '--config-locations' || name === '--batch-file' || name === '-a') unknown ??= fromFile
      else if (s?.letter === 'P' || s?.letter === 'd') add(dirs, untyped(s.attached ? s.value : args[++k]))
      else if (s?.letter === 'o' || s?.letter === 'O') add(named, untyped(s.attached ? s.value : args[++k]))
    }
  }
  for (const file of named) {
    if (path.isAbsolute(file) || /^[~$]/.test(file) || dirs.length === 0) files.push(file)
    else for (const dir of dirs) files.push(path.join(dir, file))
  }
  const directories: (string | undefined)[] = []
  if (download && (named.length === 0 || (head !== 'aria2c' && !HTTPIE.has(head)))) {
    if (dirs.length) directories.push(...dirs)
    else directories.push(undefined)
  }
  return { files, directories, ...(unknown ? { unknown } : {}) }
}

/** Options of an interpreter or a shell that take the next word as their value (not the script). */
const INTERPRETER_VALUE_OPTIONS: [RegExp, RegExp][] = [
  [/^python/i, /^-[WXQ]$/],
  [/^(?:node|deno|bun)$/i, /^(?:-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--env-file|--input-type|--title)$/],
  [/^ruby$/i, /^-[rICE]$/],
  [/^perl$/i, /^-[IMx]$/],
  [/^php$/i, /^-[cdz]$/],
  [/^lua$/i, /^-[l]$/],
  [/^(?:ba|z|k|da)?sh$/, /^(?:-[oO]|[+][oO]|--rcfile|--init-file)$/],
]

/** Where the script is in an interpreter's arguments (after its options and their values); -1 when there is none. */
function scriptIndex(name: string, args: string[]): number {
  const valued = INTERPRETER_VALUE_OPTIONS.find(([who]) => who.test(name))?.[1]
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--') return k + 1 < args.length ? k + 1 : -1
    if (valued?.test(a)) {
      k++
      continue
    }
    if (a.startsWith('-') || a.startsWith('+')) continue
    return k
  }
  return -1
}

/** A shell word, quoted so it reads back as itself. */
function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * The command xargs runs: the words after its own options. GNU's -i, -l,
 * -e, --replace, --eof and --max-lines take an optional value attached to
 * them (never the next word); -a, -d, -E, -I, -L, -n, -P, -s and BSD's -J,
 * -R, -S take the next word. `certain` is false when an option was not one
 * of these.
 */
function xargsCommand(args: string[]): { words: string[]; certain: boolean } {
  let certain = true
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--') return { words: args.slice(k + 1), certain }
    if (/^-[ile]/.test(a) || /^--(?:replace|eof|max-lines)(?:=|$)/.test(a)) continue
    if (/^-[adEILnPsJRS]$/.test(a) || /^--(?:arg-file|delimiter|max-args|max-procs|max-chars|process-slot-var)$/.test(a)) {
      k++
      continue
    }
    if (/^-[adEILnPsJRS]./.test(a) || /^--(?:arg-file|delimiter|max-args|max-procs|max-chars|process-slot-var)=/.test(a)) continue
    if (/^-[0prtxo]+$/.test(a) || /^--(?:null|no-run-if-empty|interactive|verbose|exit|open-tty|show-limits)$/.test(a)) continue
    if (a.startsWith('-')) {
      certain = false
      continue
    }
    return { words: args.slice(k), certain }
  }
  return { words: [], certain }
}

/** A word as one shell word again when it holds a space (the rest as they are, for the patterns that read them). */
function quoteSpaced(word: string): string {
  return /\s/.test(word) ? shellQuote(word) : word
}

/** A program's arguments carry a command that deletes, writes or serves: as the first operand, or as a string holding a whole command. */
function passesACommand(args: string[], texts: string[]): boolean {
  const first = args.findIndex((a) => !a.startsWith('-'))
  if (first < 0) return texts.some((a) => /\s/.test(a) && RUN_WORD_AT_START.test(a.trim()))
  // The first operand as a command, with the words after it (git -C /srv clean: git's use is in its arguments).
  const rest = args.slice(first)
  return RUN_WORD_AT_START.test(rest[0]!) || RUN_WORD_AT_START.test(rest.map(quoteSpaced).join(' ')) || texts.some((a) => /\s/.test(a) && RUN_WORD_AT_START.test(a.trim()))
}

/** curl's short options that take a value (the rest of the cluster, or the next word). */
const CURL_VALUE_SHORT = new Set('AbcCdDeEFHKmoPQrtTuUwxXyYz'.split(''))
/** curl's long options that take a value. */
const CURL_VALUE_LONG = /^--(?:data[\w-]*|json|form[\w-]*|header|proxy[\w-]*|user[\w-]*|request|referer|cookie|cookie-jar|output|output-dir|dump-header|trace|trace-ascii|stderr|libcurl|config|max-time|connect-timeout|range|retry[\w-]*|write-out|upload-file|cert[\w-]*|key[\w-]*|cacert|capath|resolve|connect-to|interface|limit-rate|max-filesize|time-cond|url|unix-socket|abstract-unix-socket|netrc-file|etag-save|etag-compare|hsts|alt-svc|variable|expand-[\w-]+|ciphers|tls[\w-]*|aws-sigv4|oauth2-bearer|happy-eyeballs-timeout-ms|keepalive-time|local-port|ftp-[\w-]+|mail-[\w-]+|socks[\w-]*|noproxy|preproxy|pinnedpubkey|dns-[\w-]+|login-options|sasl-authzid|service-name|speed-[\w-]+|telnet-option|quote|krb|delegation|engine|egd-file|random-file|create-file-mode|parallel-max|rate)$/
/** curl's options that write a file (beside the download itself). */
const CURL_FILE_OPTIONS = /^--(?:dump-header|cookie-jar|trace|trace-ascii|stderr|libcurl|etag-save|hsts|alt-svc)$/
/** wget's short options that take a value. */
const WGET_VALUE_SHORT = new Set('OoaPieTtwQUBlARDXI'.split(''))
const WGET_VALUE_LONG = /^--(?:output-document|output-file|append-output|directory-prefix|input-file|execute|tries|timeout|wait|quota|user-agent|base|level|accept|reject|domains|exclude-domains|include-directories|exclude-directories|header|user|password|post-data|post-file|body-data|body-file|method|load-cookies|save-cookies|ca-certificate|certificate|private-key|limit-rate|referer|bind-address|dns-timeout|connect-timeout|read-timeout|waitretry|default-page|restrict-file-names|cut-dirs|http-user|http-password|ftp-user|ftp-password|proxy-user|proxy-password|warc-file|rejected-log|config|local-encoding|remote-encoding)$/

/**
 * Where a curl or wget command saves files: `files` it writes by name,
 * `directories` it saves into under the remote name (undefined: the current
 * directory), and why it cannot be known (`-K` / `-e` / `--config` that may
 * say so themselves).
 */
function downloadTargets(head: 'curl' | 'wget', args: string[]): { files: string[]; directories: (string | undefined)[]; unknown?: { en: string; zh: string } } {
  const files: string[] = []
  let outputDir: string | undefined
  let remoteName = false
  let documentNamed = false
  let spider = false
  let unknown: { en: string; zh: string } | undefined
  const valueShort = head === 'curl' ? CURL_VALUE_SHORT : WGET_VALUE_SHORT
  const valueLong = head === 'curl' ? CURL_VALUE_LONG : WGET_VALUE_LONG
  const take = (option: string, value: string | undefined) => {
    if (value === undefined) return
    if (head === 'curl') {
      if (option === 'o' || option === '--output') {
        if (value !== '-') files.push(value)
      } else if (option === '--output-dir') outputDir = value
      else if (option === 'D' || option === 'c' || CURL_FILE_OPTIONS.test(option)) {
        if (value !== '-' && value !== '%') files.push(value)
      } else if (option === 'K' || option === '--config') unknown ??= { en: 'reads its options from a file', zh: '会从一个文件里读取选项（包括保存位置）' }
    } else {
      if (option === 'O' || option === '--output-document') {
        documentNamed = true
        if (value !== '-') files.push(value)
      } else if (option === 'o' || option === 'a' || option === '--output-file' || option === '--append-output' || option === '--save-cookies' || option === '--warc-file' || option === '--rejected-log') files.push(value)
      else if (option === 'P' || option === '--directory-prefix') outputDir = value
      else if ((option === 'e' || option === '--execute') && /output|dir(?:ectory)?_prefix|logfile|cookies|warc/i.test(value)) unknown ??= { en: 'sets where it saves through -e', zh: '通过 -e 设置了保存位置' }
      else if (option === '--config') unknown ??= { en: 'reads its options from a file', zh: '会从一个文件里读取选项（包括保存位置）' }
    }
  }
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--') break
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq > 0 ? a.slice(0, eq) : a
      if (head === 'curl' && /^--(?:remote-name|remote-name-all|remote-header-name)$/.test(name)) remoteName = true
      if (head === 'wget' && name === '--spider') spider = true
      if (eq > 0) take(name, a.slice(eq + 1))
      else if (valueLong.test(name)) take(name, args[++k])
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let c = 1; c < a.length; c++) {
        const ch = a[c]!
        if (head === 'curl' && (ch === 'O' || ch === 'J')) remoteName = true
        if (valueShort.has(ch)) {
          take(ch, c + 1 < a.length ? a.slice(c + 1) : args[++k])
          break
        }
      }
    }
  }
  const directories: (string | undefined)[] = []
  if (head === 'curl' && remoteName) directories.push(outputDir)
  if (head === 'curl' && outputDir !== undefined) for (let f = 0; f < files.length; f++) if (!path.isAbsolute(files[f]!) && !/^[~$]/.test(files[f]!)) files[f] = path.join(outputDir, files[f]!)
  if (head === 'wget' && !documentNamed && !spider) directories.push(outputDir)
  return { files, directories, ...(unknown ? { unknown } : {}) }
}

// ── Local web servers, and what a command is for (approval wording) ───────

/** A web server a command starts. */
export interface ListeningServer {
  /** `static` serves files only; `scripts` runs the files it serves (php -S, http.server --cgi). */
  kind: 'static' | 'scripts'
  port: string
  /** The address it binds, as written; '' for the program's default (every interface). */
  bind: string
  /** False only when it binds to the loopback interface alone (127.0.0.1, ::1, localhost). */
  exposed: boolean
  /** Its arguments hold something this cannot read for sure (an unknown option, a variable): it counts as exposed. */
  unsure?: boolean
  /** Options that change what it runs (php -d/-c/…) or a file it runs that this cannot place: it asks. */
  unsureRun?: boolean
  /** Files it runs besides what it serves (php's router script), as written. */
  runs?: string[]
  /** It runs as another user (sudo, su, runuser, a system service: root by default). */
  otherUser?: boolean
  /** The directory it serves, when certain (for the card's wording). */
  directory?: string
  /**
   * Every directory it may serve (one per directory the command may be in,
   * see analyzeDeletes); undefined when that cannot be known (a cd or a
   * served path not known before it runs).
   */
  directories?: string[]
}

const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|\[::1\]|ip6-localhost)$/i

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOST.test(host.trim())
}

/** A redirect's own word(s) (`>f`, `2>`, `&>`, `2>&1`): left out of a server's or a download's arguments. */
const REDIRECT_WORD = /^(?:\d*|&)(?:>>?|<)/

/** The command with `2>&1` / `>&2` / `&>` spelled so the tokenizer does not read their `&` as a separator. */
function withPlainRedirects(command: string): string {
  return command.replace(/(\d*)>&(\d+|-)/g, ' ').replace(/&>>?/g, ' >')
}

/** Arguments without redirections (and their targets). */
function argsWithoutRedirects(words: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (REDIRECT_WORD.test(word)) {
      if (/^(?:\d*|&)(?:>>?|<)$/.test(word)) i++
      continue
    }
    out.push(word)
  }
  return out
}

/** A runner's package (`npx -y http-server@14 …` → http-server and the arguments after it). */
function runnerPackage(name: string, args: string[]): { name: string; args: string[] } | undefined {
  let rest = args
  if (name === 'pnpm' || name === 'yarn' || name === 'npm') {
    if (rest[0] !== 'dlx' && rest[0] !== 'exec') return undefined
    rest = rest.slice(1)
  } else if (name !== 'npx' && name !== 'bunx' && name !== 'pnpx') {
    return undefined
  }
  let k = 0
  while (k < rest.length && rest[k]!.startsWith('-')) {
    if (/^(?:-p|--package)$/.test(rest[k]!)) k++
    if (rest[k] === '--') {
      k++
      break
    }
    k++
  }
  const pkg = rest[k]
  if (!pkg) return undefined
  return { name: pkg.replace(/^(@?[^@]+)@.*$/, '$1'), args: rest.slice(k + 1) }
}

/** `host:port` / `[::1]:port` / `port` → its parts. */
function hostPort(value: string): { host: string; port: string } {
  const bracket = /^\[([^\]]*)\]:(\d+)$/.exec(value)
  if (bracket) return { host: bracket[1]!, port: bracket[2]! }
  const at = value.lastIndexOf(':')
  if (at > 0 && /^\d+$/.test(value.slice(at + 1)) && !value.slice(0, at).includes(':')) return { host: value.slice(0, at), port: value.slice(at + 1) }
  if (/^\d+$/.test(value)) return { host: '', port: value }
  return { host: value, port: '' }
}

/**
 * The server one simple command starts, if it is a known one: python's
 * http.server (and SimpleHTTPServer), `php -S`, http-server, serve, and
 * busybox httpd. Anything in its arguments this cannot read for sure counts
 * as reachable from other machines.
 */
function serverOf(name: string, rawArgs: string[], here: string | undefined, heres: string[] | undefined): ListeningServer | undefined {
  // The served directory as written (the last one given wins), resolved from every candidate directory.
  let given: string | undefined
  const server = parseServer(name, rawArgs, here, (value) => {
    given = value
  })
  if (!server) return undefined
  const place = (value: string): string[] | undefined => {
    const known = staticPath(value)
    return known === undefined ? undefined : path.isAbsolute(known) ? [known] : heres?.map((base) => path.resolve(base, known))
  }
  let directories: string[] | undefined = given === undefined ? heres : place(given)
  // A script it runs (php's router) must be placed too: it counts as one more place it serves from.
  for (const file of server.runs ?? []) {
    const placed = place(file)
    directories = placed === undefined || directories === undefined ? undefined : [...directories, ...placed]
  }
  return { ...server, ...(directories ? { directories } : {}) }
}

function parseServer(name: string, rawArgs: string[], here: string | undefined, served: (value: string) => void): ListeningServer | undefined {
  const args = argsWithoutRedirects(rawArgs)
  const dirOf = (value: string | undefined): string | undefined => {
    if (value === undefined) return here
    served(value)
    const known = staticPath(value)
    return known === undefined || here === undefined ? (known && path.isAbsolute(known) ? known : undefined) : path.resolve(here, known)
  }
  const unsure = (value: string) => !value || /[`$*?[\]{}]/.test(value)
  if (INTERPRETER_NAME.test(name) && /^python/i.test(name)) {
    let m = args.findIndex((a) => a === '-m' || /^-m(?:http\.server|SimpleHTTPServer)$/.test(a))
    // `-m` must be the interpreter's own option (before any script name).
    if (m < 0 || args.slice(0, m).some((a) => !a.startsWith('-'))) return undefined
    const module = args[m] === '-m' ? args[m + 1] : args[m]!.slice(2)
    if (module !== 'http.server' && module !== 'SimpleHTTPServer') return undefined
    m += args[m] === '-m' ? 2 : 1
    let bind = ''
    let port = '8000'
    let directory: string | undefined
    let kind: ListeningServer['kind'] = 'static'
    let sure = true
    let positional = 0
    for (let k = m; k < args.length; k++) {
      const a = args[k]!
      const [option, attached] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
      if (module === 'http.server' && (/^--b(?:i(?:n(?:d)?)?)?$/.test(option) || option === '-b' || /^-b./.test(a))) {
        bind = /^-b./.test(a) ? a.slice(2) : attached ?? args[++k] ?? ''
        if (unsure(bind)) sure = false
      } else if (module === 'http.server' && (/^--d(?:i(?:r(?:e(?:c(?:t(?:o(?:r(?:y)?)?)?)?)?)?)?)?$/.test(option) || option === '-d' || /^-d./.test(a))) {
        directory = dirOf(/^-d./.test(a) ? a.slice(2) : attached ?? args[++k])
      } else if (module === 'http.server' && /^--c(?:g(?:i)?)?$/.test(option)) {
        kind = 'scripts'
      } else if (module === 'http.server' && (/^--p(?:r(?:o(?:t(?:o(?:c(?:o(?:l)?)?)?)?)?)?)?$/.test(option) || option === '-p')) {
        if (attached === undefined) k++
      } else if (a.startsWith('-')) {
        sure = false
      } else if (positional === 0 && /^\d+$/.test(a)) {
        port = a
        positional++
      } else {
        sure = false
      }
    }
    if (module === 'SimpleHTTPServer') bind = ''
    return { kind, port, bind, exposed: !sure || !isLoopbackHost(bind), ...(sure ? {} : { unsure: true }), ...(directory ?? here ? { directory: directory ?? here } : {}) }
  }
  if (name === 'php') {
    if (!args.some((a) => a === '-S' || /^-S./.test(a))) return undefined
    // Only -S, -t and one router script are read; any other option (-d auto_prepend_file=…, -c php.ini,
    // -n, -z, …) changes what runs: it asks. A second operand is not something php -S takes.
    let listen = ''
    let docroot: string | undefined
    let unsureRun = false
    const runs: string[] = []
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!
      if (a === '-S') listen = args[++k] ?? ''
      else if (/^-S./.test(a)) listen = a.slice(2)
      else if (a === '-t') docroot = args[++k]
      else if (/^-t./.test(a)) docroot = a.slice(2)
      else if (/^-[cdzfrBRFE]$/.test(a)) {
        unsureRun = true
        k++
      } else if (a.startsWith('-')) unsureRun = true
      else if (runs.length === 0) runs.push(a)
      else unsureRun = true
    }
    const { host, port } = hostPort(listen)
    const directory = docroot === undefined ? here : dirOf(docroot)
    return {
      kind: 'scripts',
      port,
      bind: host,
      exposed: unsure(host) || !isLoopbackHost(host),
      ...(unsure(host) ? { unsure: true } : {}),
      ...(unsureRun ? { unsureRun: true } : {}),
      ...(runs.length ? { runs } : {}),
      ...(directory ? { directory } : {}),
    }
  }
  const runner = runnerPackage(name, args)
  const program = runner?.name ?? name
  const rest = runner?.args ?? args
  if (program === 'http-server') {
    let bind = '0.0.0.0'
    let port = '8080'
    let dir: string | undefined
    let sure = true
    const valued = /^-[cePtCK]$|^--(?:cache|ext|proxy|proxy-options|username|password|cert|key|timeout|mimetypes|websocket-proxy)$/
    const flags = /^-[sdigbUrSvhq]+$|^--(?:silent|gzip|brotli|utc|log-ip|robots|cors|ssl|tls|no-dotfiles|proxy-all|version|help)$/
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k]!
      if (a === '-a' || a === '--address') bind = rest[++k] ?? ''
      else if (/^-a./.test(a)) bind = a.slice(2)
      else if (a.startsWith('--address=')) bind = a.slice('--address='.length)
      else if (a === '-p' || a === '--port') port = rest[++k] ?? port
      else if (/^-p\d/.test(a)) port = a.slice(2)
      else if (a.startsWith('--port=')) port = a.slice('--port='.length)
      else if (valued.test(a)) k++
      // A value attached to an option that does not change where it listens (`-c-1`, `--cache=10`).
      else if (/^-[cePtCK]./.test(a) || (/^--[\w-]+=/.test(a) && valued.test(a.slice(0, a.indexOf('='))))) continue
      else if (flags.test(a)) continue
      else if (a.startsWith('-')) sure = false
      else if (dir === undefined) dir = a
    }
    if (unsure(bind)) sure = false
    const directory = dirOf(dir)
    return { kind: 'static', port, bind, exposed: !sure || !isLoopbackHost(bind), ...(sure ? {} : { unsure: true }), ...(directory ? { directory } : {}) }
  }
  if (program === 'serve' && (runner || name === 'serve')) {
    const listens: string[] = []
    let dir: string | undefined
    let sure = true
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k]!
      if (a === '-l' || a === '--listen' || a === '-p') listens.push(rest[++k] ?? '')
      else if (/^--listen=/.test(a)) listens.push(a.slice(9))
      else if (a.startsWith('-')) {
        if (!/^-(?:[sCSuLnd]|-(?:single|cors|symlinks|no-clipboard|no-compression|no-etag|no-port-switching|no-request-logging|debug))$/.test(a)) sure = false
      } else if (dir === undefined) dir = a
    }
    const endpoints = (listens.length ? listens : ['3000']).map((l) => hostPort(l.replace(/^tcp:\/\//, '')))
    const loopback = sure && endpoints.every((e) => !unsure(e.host) && isLoopbackHost(e.host))
    const directory = dirOf(dir)
    return { kind: 'static', port: endpoints.map((e) => e.port).filter(Boolean).join(', ') || '3000', bind: endpoints.map((e) => e.host).join(', '), exposed: !loopback, ...(sure ? {} : { unsure: true }), ...(directory ? { directory } : {}) }
  }
  if (name === 'busybox' && args[0] === 'httpd') {
    const p = args.indexOf('-p')
    const { host, port } = hostPort(p >= 0 ? args[p + 1] ?? '' : '80')
    const h = args.indexOf('-h')
    const directory = dirOf(h >= 0 ? args[h + 1] : undefined)
    return { kind: 'static', port: port || '80', bind: host, exposed: unsure(host) || !isLoopbackHost(host), ...(unsure(host) ? { unsure: true } : {}), ...(directory ? { directory } : {}) }
  }
  return undefined
}

/** Where the first `(` outside quotes is (a subshell, a group, a substitution), or -1. */
function firstUnquotedParen(command: string): number {
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = undefined
      else if (ch === '\\' && quote === '"') i++
      continue
    }
    if (ch === '\\') i++
    else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') return i
  }
  return -1
}

/** One simple command and the directory it runs in (undefined once a cd cannot be followed). */
interface PlacedCommand {
  parsed: ShellCommand
  head: { index: number; name: string } | undefined
  args: string[]
  here: string | undefined
  /** Every directory it may run in (the start and every static cd before it); undefined after a cd not known before it runs. */
  heres: string[] | undefined
  /** It runs as another user (sudo, doas, su, runuser, pkexec, a system service). */
  otherUser?: boolean
}

/** The command's simple commands, in order, each with the directory it runs in (a static cd is followed), and the inline code of `sh -c` read the same way. */
function placedCommands(command: string, cwd: string, depth = 0, start: string[] | null = [cwd], asOther = false): PlacedCommand[] {
  const out: PlacedCommand[] = []
  let here: string | undefined = cwd
  // null: the directory is not known (undefined would take the default).
  let heres: string[] | undefined = start ?? undefined
  // Only the directory changes before the first group or subshell are certain for what follows.
  const groupAt = firstUnquotedParen(command)
  const certainChanges = groupAt < 0 ? Infinity : shellCommands(withPlainRedirects(command.slice(0, groupAt))).filter((c) => /^(?:cd|pushd|popd)$/.test(commandHead(c.words)?.name ?? '')).length
  let changes = 0
  for (const parsed of shellCommands(withPlainRedirects(command))) {
    const head = commandHead(parsed.words)
    const args = head ? parsed.words.slice(head.index + 1) : []
    if (head && (head.name === 'cd' || head.name === 'pushd' || head.name === 'popd')) {
      const target = args.find((a) => !a.startsWith('-') || a === '-')
      // `cd -`, `popd` and a subshell's cd make the directory of what follows uncertain: the words then do not name it.
      const known = head.name === 'popd' || target === '-' || changes++ >= certainChanges ? undefined : target === undefined ? homedir() : staticPath(target)
      here = known === undefined || here === undefined ? undefined : path.resolve(here, known)
      // The candidates, as analyzeDeletes keeps them: a cd adds one, `cd -`, `popd` and a bare `pushd` go back to one.
      if (head.name !== 'popd' && target !== '-' && !(head.name === 'pushd' && target === undefined)) {
        const to = target === undefined ? homedir() : staticPath(target)
        heres = to === undefined || heres === undefined ? undefined : [...new Set([...heres, ...heres.map((base) => path.resolve(base, to))])]
        if (heres && heres.length > 32) heres = undefined
      }
    }
    if (head && SHELL_NAME.test(head.name) && depth < 2) {
      const code = inlineProgram(head.name, args)?.code
      if (code !== undefined) {
        out.push(...placedCommands(code, here ?? cwd, depth + 1, heres ?? null, asOther).map((c) => (here === undefined ? { ...c, here: undefined } : c)))
        continue
      }
    }
    // A program that runs a command of its own (su -c, flock, chroot, systemd-run): that command, in
    // the directory it runs in (unknown when the program changes it: a login, a new root, a service).
    // sudo, doas, pkexec before the command: it runs as another user.
    const otherUser = asOther || (head ? parsed.words.slice(0, head.index).some((w) => /^(?:sudo|doas|pkexec)$/.test(path.basename(w))) : false)
    const inner = head && depth < 2 ? unwrapRunner(head.name, args) : undefined
    if (inner) {
      // Options it could not read for sure: the directory is not known either.
      const innerHeres = !inner.certain ? undefined : inner.keepsDir ? heres : inner.dir !== undefined ? (path.isAbsolute(inner.dir) ? [inner.dir] : heres?.map((base) => path.resolve(base, inner.dir!))) : undefined
      const innerHere = inner.certain && inner.keepsDir ? here : innerHeres?.length === 1 ? innerHeres[0] : undefined
      const innerOther = otherUser || inner.otherUser
      if (inner.code !== undefined) {
        out.push(...placedCommands(inner.code, innerHere ?? cwd, depth + 1, innerHeres ?? null, innerOther).map((c) => (innerHere === undefined ? { ...c, here: undefined } : c)))
      } else if (inner.words?.length) {
        const innerHead = commandHead(inner.words)
        const innerOtherUser = innerOther || inner.words.slice(0, innerHead?.index ?? 0).some((w) => /^(?:sudo|doas|pkexec)$/.test(path.basename(w)))
        out.push({ parsed: { words: inner.words, join: 'list' }, head: innerHead, args: innerHead ? inner.words.slice(innerHead.index + 1) : [], here: innerHere, heres: innerHeres, ...(innerOtherUser ? { otherUser: true } : {}) })
      }
      continue
    }
    // A wrapper's directory change (`env -C`, `sudo -D`) for this command only.
    const wrapped = afterWrapperChanges(parsed.words, heres)
    if (wrapped.changed) {
      const certain = afterWrapperChanges(parsed.words, here === undefined ? undefined : [here]).bases
      out.push({ parsed, head, args, here: certain?.length === 1 ? certain[0] : undefined, heres: wrapped.bases, ...(otherUser ? { otherUser: true } : {}) })
      continue
    }
    out.push({ parsed, head, args, here, heres, ...(otherUser ? { otherUser: true } : {}) })
  }
  return out
}

/** What a runner runs and where, as far as its options can be read. */
interface Unwrapped {
  code?: string
  words?: string[]
  /** It runs in the same directory (else `dir`, or not known). */
  keepsDir: boolean
  dir?: string
  /** Every option was one the classifier knows: otherwise the broad scan applies too. */
  certain: boolean
  /** It runs as another user (su, runuser, a system service): its servers ask. */
  otherUser: boolean
  /** `~` and `$HOME` in its code are the other user's (su without -m/-p). */
  homeChanges?: boolean
}

/**
 * The command a runner runs: su/runuser [-c] CODE, flock [opts] FILE CMD…
 * (or -c CODE), chroot [opts] ROOT CMD…, systemd-run [opts] CMD…; where it
 * runs, as whom, and whether its options were all read for sure.
 */
function unwrapRunner(name: string, args: string[]): Unwrapped | undefined {
  const valueOf = (k: number, a: string) => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[k + 1])
  if (name === 'su' || name === 'runuser') {
    let code: string | undefined
    let login = false
    let preserve = false
    let certain = true
    for (let k = 0; k < args.length; k++) {
      const a = fullLongOption(name, args[k]!)
      // Past `--`: the command (runuser) or the shell's arguments (su), not options.
      if (a === '--') break
      if (a === '-') login = true
      else if (a === '--login') login = true
      else if (a === '--preserve-environment') preserve = true
      else if (/^--(?:fast|pty)$/.test(a)) continue
      else if (/^--(?:command|session-command)(?:=|$)/.test(a)) {
        code = valueOf(k, a)
        if (!a.includes('=')) k++
      } else if (/^--(?:shell|group|supp-group|whitelist-environment|user)(?:=|$)/.test(a)) {
        if (!a.includes('=')) k++
      } else if (/^-[A-Za-z]/.test(a) && !a.startsWith('--')) {
        // A cluster, letter by letter: c, s, g, G, w (u for runuser) take a value (the rest, or the next word).
        for (let c = 1; c < a.length; c++) {
          const ch = a[c]!
          if (ch === 'l') login = true
          else if (ch === 'm' || ch === 'p') preserve = true
          else if (ch === 'f' || ch === 'P') continue
          else if ('csgGw'.includes(ch) || (name === 'runuser' && ch === 'u')) {
            const value = a.slice(c + 1) || args[++k]
            if (ch === 'c') code = value
            break
          } else certain = false
        }
      } else if (a.startsWith('--')) certain = false
    }
    // runuser -u USER [--] COMMAND…: a command of words (su passes the words after the user to the shell as arguments).
    if (code === undefined && name === 'runuser') {
      const dashes = args.indexOf('--')
      const words = dashes >= 0 ? args.slice(dashes + 1) : []
      if (words.length) return { words, keepsDir: !login, certain, otherUser: true, homeChanges: !preserve }
    }
    if (code === undefined) return undefined
    return { code, keepsDir: !login, certain, otherUser: true, homeChanges: !preserve }
  }
  if (name === 'flock') {
    let certain = true
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!
      if (a === '-c' || a === '--command' || a.startsWith('--command=')) return { code: valueOf(k, a) ?? '', keepsDir: true, certain, otherUser: false }
      if (/^(?:-w|-E|--timeout|--wait|--conflict-exit-code)$/.test(a)) {
        k++
        continue
      }
      if (/^-[sxunoFe]+$|^--(?:shared|exclusive|unlock|nonblock|nb|close|no-fork|verbose)$|^--(?:timeout|wait|conflict-exit-code)=/.test(a)) continue
      if (a.startsWith('-')) {
        certain = false
        continue
      }
      // The lock file, then the command (or -c CODE after it).
      const rest = args.slice(k + 1)
      if (rest[0] === '-c' || rest[0] === '--command') return { code: rest[1] ?? '', keepsDir: true, certain, otherUser: false }
      return { words: rest, keepsDir: true, certain, otherUser: false }
    }
    return undefined
  }
  if (name === 'chroot') {
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!
      // --userspec USER:GROUP and --groups LIST take a value (also with =).
      if (a === '--userspec' || a === '--groups') {
        k++
        continue
      }
      if (a.startsWith('-')) continue
      return { words: args.slice(k + 1), keepsDir: false, certain: true, otherUser: true }
    }
    return undefined
  }
  if (name === 'systemd-run') {
    // The directory, in order (a later option wins): -d keeps it, --working-directory / WorkingDirectory=
    // name one; RootDirectory=, RootImage=, -M and -H make it unknown for good (another root, machine or host).
    let keepsDir = false
    let dir: string | undefined
    let lost = false
    let user = false
    let switchesUser = false
    let certain = true
    const workingDirectory = (value: string | undefined) => {
      keepsDir = false
      const known = value === undefined ? undefined : staticPath(value.replace(/^-/, ''))
      if (known === undefined || !path.isAbsolute(known)) lost = true
      else dir = known
    }
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!
      if (a === '-d' || a === '--same-dir') {
        keepsDir = true
        dir = undefined
      } else if (a === '--user') user = true
      else if (a === '--system') user = false
      else if (a === '--working-directory' || a.startsWith('--working-directory=')) {
        workingDirectory(valueOf(k, a))
        if (!a.includes('=')) k++
      } else if (a === '-p' || a === '--property' || a.startsWith('--property=') || /^-p./.test(a)) {
        const property = a.startsWith('--property=') ? a.slice('--property='.length) : /^-p./.test(a) ? a.slice(2) : args[++k] ?? ''
        if (/^WorkingDirectory=/.test(property)) workingDirectory(property.slice('WorkingDirectory='.length))
        else if (/^(?:RootDirectory|RootImage)=/.test(property)) lost = true
        else if (/^(?:User|Group|DynamicUser)=/.test(property)) switchesUser = true
      } else if (/^(?:-[MH]|--(?:machine|host))$/.test(a) || /^--(?:machine|host)=/.test(a)) {
        lost = true
        if (!a.includes('=')) k++
      } else if (/^(?:--uid|--gid)(?:=|$)/.test(a)) {
        switchesUser = true
        if (!a.includes('=')) k++
      } else if (/^(?:-[uE]|--(?:unit|description|slice|setenv|nice|on-active|on-boot|on-startup|on-unit-active|on-unit-inactive|on-calendar|timer-property|path-property|socket-property|service-type))$/.test(a)) k++
      else if (/^--(?:unit|description|slice|setenv|nice|on-active|on-boot|on-startup|on-unit-active|on-unit-inactive|on-calendar|timer-property|path-property|socket-property|service-type)=/.test(a)) continue
      else if (/^(?:-[tPqGSr]+|--(?:scope|pty|pipe|quiet|collect|wait|shell|remain-after-exit|no-block|send-sighup|no-ask-password|on-clock-change|on-timezone-change|slice-inherit|ignore-failure|expand-environment=\S*))$/.test(a)) continue
      else if (a.startsWith('-')) certain = false
      else {
        const known = !lost && !keepsDir && dir !== undefined
        return { words: args.slice(k), keepsDir: !lost && keepsDir, ...(known ? { dir } : {}), certain, otherUser: !user || switchesUser }
      }
    }
    return undefined
  }
  return undefined
}

/** A runner's inner command is one the classifier reads (a known program, an interpreter, a delete command, another runner). */
function recognisedCommand(words: string[] | undefined): boolean {
  const head = words && commandHead(words)
  if (!head) return false
  return KNOWN_COMMANDS.has(head.name) || DELETE_COMMANDS.has(head.name) || INTERPRETER_RE.test(head.name) || RUNNERS.has(head.name)
}

/** The web servers a command starts (followed through `cd`, wrappers and `sh -c`). */
export function listeningServers(command: string, cwd: string): ListeningServer[] {
  const servers: ListeningServer[] = []
  for (const { head, args, here, heres, otherUser } of placedCommands(withoutHeredocBodies(command), cwd)) {
    if (!head) continue
    const server = serverOf(head.name, args, here, heres)
    if (server) servers.push({ ...server, ...(otherUser ? { otherUser: true } : {}) })
  }
  return servers
}

/** A command's purpose in plain words, both languages. */
export interface CommandSummary {
  zh: string
  en: string
}

/** Commands that do nothing worth saying on a card (waiting, printing, checking). */
const QUIET_COMMANDS = new Set(['sleep', 'true', ':', 'wait', 'echo', 'printf', 'pwd', 'date', 'cd', 'pushd', 'popd'])

function placeZh(directory: string | undefined, cwd: string): { zh: string; en: string } {
  if (directory === undefined) return { zh: '当前目录里的网页', en: 'the pages in the current directory' }
  if (isInsideWorkspace(cwd, directory)) {
    const rel = path.relative(realPathOf(cwd), realPathOf(directory))
    return rel ? { zh: `工作区 ${rel} 里的网页`, en: `the pages in ${rel} in the workspace` } : { zh: '工作区里的网页', en: 'the pages in the workspace' }
  }
  return { zh: `${directory} 里的网页`, en: `the pages in ${directory}` }
}

function urlHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return undefined
  }
}

/**
 * What a command does, in plain words, from what it is classified as: a
 * local preview, a web server other machines can reach, a check of a page
 * on this machine, a download, output written to a file. Undefined when any
 * part is something this cannot put in words (the card then says nothing
 * it cannot stand behind).
 */
export function summarizeShellCommand(command: string, cwd: string): CommandSummary | undefined {
  if (/<</.test(command)) return undefined
  const zh: string[] = []
  const en: string[] = []
  for (const { parsed, head, args, here, heres } of placedCommands(command, cwd)) {
    if (parsed.join === 'subst' || parsed.join === 'procsub-in' || parsed.join === 'procsub-out' || parsed.substitutedHead) return undefined
    if (!head) {
      if (parsed.words.every((w) => ASSIGNMENT.test(w))) continue
      return undefined
    }
    const plain = argsWithoutRedirects(args)
    const server = serverOf(head.name, args, here, heres)
    if (server) {
      // A directory certain only up to the subshells around it: say the workspace when every candidate is in it.
      const what = server.directory === undefined && server.directories?.length && server.directories.every((d) => isInsideWorkspace(cwd, d))
        ? { zh: '工作区里的网页', en: 'the pages in the workspace' }
        : placeZh(server.directory, cwd)
      if (!server.exposed) {
        const at = `${server.bind || '127.0.0.1'}:${server.port}`
        if (server.kind === 'static') {
          zh.push(`启动本地预览：在本机 ${at} 打开${what.zh}（只在本机监听）`)
          en.push(`start a local preview: serve ${what.en} at ${at} (listening on this machine only)`)
        } else {
          zh.push(`启动本地网页服务：在本机 ${at} 运行${what.zh}（只在本机监听）`)
          en.push(`start a local web server: run ${what.en} at ${at} (listening on this machine only)`)
        }
      } else {
        const everywhere = !server.bind || /^(?:0\.0\.0\.0|::|\[::\])$/.test(server.bind)
        const where = server.unsure ? '无法确认它只绑定在本机' : everywhere ? '绑定在所有网络接口上' : `绑定在地址 ${server.bind} 上`
        const whereEn = server.unsure ? 'and it cannot be told that it binds to this machine only' : everywhere ? 'bound to every network interface' : `bound to address ${server.bind}`
        zh.push(`启动网页服务：在端口 ${server.port} 上${server.kind === 'static' ? '提供' : '运行'}${what.zh}，${where}，其他机器也可能访问到`)
        en.push(`start a web server: ${server.kind === 'static' ? 'serve' : 'run'} ${what.en} on port ${server.port}, ${whereEn}, so other machines may reach it`)
      }
    } else if (head.name === 'curl' || head.name === 'wget') {
      if (curlSendsData(plain) || plain.some((a) => /^--(?:post|body|method)/.test(a))) return undefined
      const urls = plain.filter((a) => /^https?:\/\//i.test(a))
      if (!urls.length) return undefined
      const saves = downloadTargets(head.name, plain)
      const files = saves.files.filter((f) => f !== '/dev/null')
      const local = urls.every((u) => {
        const host = urlHost(u)
        return host !== undefined && isLoopbackHost(host)
      })
      const shown = urls.join(' ')
      if (saves.unknown) return undefined
      if (files.length) {
        zh.push(`把 ${shown} 下载到 ${files.join('、')}`)
        en.push(`download ${shown} to ${files.join(', ')}`)
      } else if (saves.directories.length) {
        const into = saves.directories[0] ?? (here === undefined ? undefined : isInsideWorkspace(cwd, here) ? path.relative(realPathOf(cwd), realPathOf(here)) || '.' : here)
        const intoZh = into === undefined ? '当前目录' : into === '.' ? '工作区' : isInsideWorkspace(cwd, path.resolve(cwd, into)) && !path.isAbsolute(into) ? `工作区里的 ${into}` : into
        const intoEn = into === undefined ? 'the current directory' : into === '.' ? 'the workspace' : into
        zh.push(`下载 ${shown}，保存到${/^[\x21-\x7e]/.test(intoZh) ? ' ' : ''}${intoZh}`)
        en.push(`download ${shown} into ${intoEn}`)
      } else if (local) {
        zh.push(`检查本机网页 ${shown} 能否打开`)
        en.push(`check that ${shown} opens on this machine`)
      } else {
        zh.push(`读取网页 ${shown}`)
        en.push(`fetch ${shown}`)
      }
    } else if (!QUIET_COMMANDS.has(head.name)) {
      return undefined
    }
    // Output this part writes to a file.
    for (let k = 0; k < parsed.words.length; k++) {
      const word = parsed.words[k]!
      const match = /^(?:\d*)(>>?)(.*)$/.exec(word)
      if (!match) continue
      const target = match[2] || parsed.words[++k]
      if (!target || target === '/dev/null') continue
      const known = staticPath(target)
      if (known === undefined) return undefined
      const absolute = path.resolve(here ?? cwd, known)
      const append = match[1] === '>>'
      if (isTemporaryPath(absolute)) {
        const fresh = !existsSync(absolute)
        zh.push(`${append ? '把输出追加到' : '把输出写进'}${fresh ? '新的' : ''}临时文件 ${known}`)
        en.push(`${append ? 'append its output to' : 'write its output to'} ${fresh ? 'a new ' : 'the '}temporary file ${known}`)
      } else if (here !== undefined && isInsideWorkspace(cwd, absolute)) {
        const rel = path.relative(realPathOf(cwd), realPathOf(absolute))
        zh.push(`${append ? '把输出追加到' : '把输出写进'}工作区里的 ${rel}`)
        en.push(`${append ? 'append its output to' : 'write its output to'} ${rel} in the workspace`)
      } else {
        zh.push(`${append ? '把输出追加到' : '把输出写进'} ${known}（工作区以外）`)
        en.push(`${append ? 'append its output to' : 'write its output to'} ${known} (outside the workspace)`)
      }
    }
  }
  if (!zh.length) return undefined
  return { zh: `这条命令会：${zh.join('；')}。`, en: `This command will: ${en.join('; ')}.` }
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
