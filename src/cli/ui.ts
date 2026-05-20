import { stdout } from 'node:process'
import { pathToFileURL } from 'node:url'

export const PANEL_WIDTH = 70

export const ANSI = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  italic:   '\x1b[3m',
  white:    '\x1b[97m',
  green:    '\x1b[32m',
  blue:     '\x1b[34m',
  cyan:     '\x1b[36m',
  red:      '\x1b[31m',
  yellow:   '\x1b[33m',
  magenta:  '\x1b[35m',
  gray:     '\x1b[90m',
  bgGreen:  '\x1b[42m',
  bgRed:    '\x1b[41m',
  bgBlue:   '\x1b[44m',
  bgYellow: '\x1b[43m',
  bgGray:   '\x1b[100m',
  black:    '\x1b[30m',
  // true-color helpers
  violet:   '\x1b[38;2;148;82;255m',
  skyblue:  '\x1b[38;2;100;180;255m',
  rose:     '\x1b[38;2;255;120;155m',
}

function useAnsi(): boolean {
  return stdout.isTTY === true
}

/** Detect whether the terminal supports OSC 8 hyperlinks.
 *  iTerm2, kitty, WezTerm, Ghostty, Windows Terminal 1.18+, etc. advertise
 *  this via the `COLORTERM` env var or specific TERM_PROGRAM values.
 *  When in doubt, skip hyperlinks — raw OSC 8 bytes corrupt terminals that
 *  don't understand them (paths glue together, spurious CSI sequences appear). */
let _osc8Supported: boolean | undefined = undefined
function supportsOsc8Hyperlinks(): boolean {
  if (_osc8Supported !== undefined) return _osc8Supported
  if (!useAnsi()) { _osc8Supported = false; return false }
  const colorterm = (process.env.COLORTERM ?? '').toLowerCase()
  const termProg  = (process.env.TERM_PROGRAM ?? '').toLowerCase()
  const term      = (process.env.TERM ?? '').toLowerCase()
  _osc8Supported = (
    colorterm === 'truecolor' || colorterm === '24bit' ||
    termProg === 'iterm.app' || termProg === 'iterm2' ||
    termProg === 'wezterm' ||
    termProg === 'ghostty' ||
    termProg === 'kitty' ||
    termProg === 'alacritty' ||
    term === 'xterm-kitty' ||
    // Windows Terminal 1.18+ sets WT_SESSION
    Boolean(process.env.WT_SESSION)
  )
  return _osc8Supported
}

export function color(text: string, code: string): string {
  return useAnsi() ? `${code}${text}${ANSI.reset}` : text
}

export function stripAnsi(text: string): string {
  return text
    // OSC sequences, including OSC8 hyperlinks terminated by BEL or ST.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    // CSI SGR and similar ANSI sequences.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
}

export function toPlainTextOutput(text: string): string {
  const normalized = stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return normalized || '(empty reply)'
}

function getCharDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2
  }
  return 1
}

function getDisplayWidth(text: string): number {
  let width = 0
  for (const char of stripAnsi(text)) {
    width += getCharDisplayWidth(char)
  }
  return width
}

function padDisplayEnd(text: string, width: number): string {
  const displayWidth = getDisplayWidth(text)
  if (displayWidth >= width) return text
  return `${text}${' '.repeat(width - displayWidth)}`
}

function splitLongToken(token: string, width: number): string[] {
  const lines: string[] = []
  let current = ''
  let currentWidth = 0
  for (const char of token) {
    const charWidth = getCharDisplayWidth(char)
    if (currentWidth + charWidth > width && current) {
      lines.push(current)
      current = ''
      currentWidth = 0
    }
    current += char
    currentWidth += charWidth
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

export function wrapText(text: string, width = PANEL_WIDTH): string[] {
  const normalized = text.trim()
  if (!normalized) return ['']
  const words = normalized.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (getDisplayWidth(candidate) <= width) {
      current = candidate
      continue
    }
    if (current) {
      lines.push(current)
      current = ''
    }
    if (getDisplayWidth(word) <= width) {
      current = word
      continue
    }
    lines.push(...splitLongToken(word, width))
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

type PanelTone = 'success' | 'danger' | 'warning' | 'normal'

function inferPanelTone(title: string): PanelTone {
  const lower = stripAnsi(title).toLowerCase()
  if (/成功|完成|已完成|已更新|已保存|已启用|已就绪|activated|success|completed|updated|saved|enabled|ready/.test(lower))
    return 'success'
  if (/错误|失败|invalid|error|failed|unauthorized|denied/.test(lower))
    return 'danger'
  if (/警告|提醒|warning|caution/.test(lower))
    return 'warning'
  return 'normal'
}

function stylePanelTitle(text: string, tone: PanelTone): string {
  switch (tone) {
    case 'success': return color(text, `${ANSI.bold}${ANSI.bgGreen}${ANSI.black}`)
    case 'danger':  return color(text, `${ANSI.bold}${ANSI.bgRed}${ANSI.white}`)
    case 'warning': return color(text, `${ANSI.bold}${ANSI.bgYellow}${ANSI.black}`)
    default:        return color(text, `${ANSI.bold}${ANSI.white}`)
  }
}




function styleCodeLine(line: string): string {
  const trimmed = line.trimStart()
  if ((trimmed.startsWith('+') && !trimmed.startsWith('+++')) || trimmed.startsWith('verified_write: true'))
    return color(line, `${ANSI.bgGreen}${ANSI.black}`)
  if ((trimmed.startsWith('-') && !trimmed.startsWith('---')) || /error|failed|invalid/i.test(trimmed))
    return color(line, `${ANSI.bgRed}${ANSI.white}`)
  if (trimmed.startsWith('@@') || /^\*\*\* (Begin|End|Update|Add|Delete)/.test(trimmed))
    return color(line, `${ANSI.bold}${ANSI.skyblue}`)
  return color(line, ANSI.skyblue)
}

function codeFenceLabel(lang: string): string | undefined {
  const key = lang.trim().toLowerCase()
  if (!key || key === 'text' || key === 'txt') return undefined
  const labels: Record<string, string> = {
    ts: 'TypeScript',
    typescript: 'TypeScript',
    js: 'JavaScript',
    javascript: 'JavaScript',
    tsx: 'TSX',
    jsx: 'JSX',
    json: 'JSON',
    bash: 'Shell',
    sh: 'Shell',
    shell: 'Shell',
    zsh: 'Shell',
    diff: 'Diff',
    patch: 'Patch',
    css: 'CSS',
    html: 'HTML',
    yaml: 'YAML',
    yml: 'YAML',
    markdown: 'Markdown',
    md: 'Markdown',
  }
  return labels[key] ?? lang.trim()
}

/** Apply inline Markdown styling: **bold**, *italic*, `code`, ~~strike~~ */
function applyInlineStyles(line: string): string {
  if (!useAnsi()) return line
  return linkLocalPaths(line)
    // **bold** — `*` never appears in filesystem paths so no boundary
    // protection needed for the asterisk form.
    .replace(/\*\*(.+?)\*\*/g, (_, t) => color(t, ANSI.bold + ANSI.white))
    // __bold__ — must NOT be adjacent to path / identifier characters,
    // otherwise filenames like `__init__.py` or path fragments like
    // `2026-05-19__draft__.md` get false-matched as bold.
    .replace(/(?<![A-Za-z0-9/.\-])__(.+?)__(?![A-Za-z0-9/.\-])/g, (_, t) => color(t, ANSI.bold + ANSI.white))
    // *italic* — `*` never appears in paths so no boundary protection.
    .replace(/\*([^*]+?)\*/g, (_, t) => color(t, ANSI.italic))
    // _italic_ — REQUIRES word-boundary on both sides. Without this, filenames
    // like `2026-05-19_dawn_0918.md` get `_dawn_` matched as italic, leaving
    // visible `3mdawn23m_0918.md` artifacts on terminals that don't fully
    // render ANSI italic. The lookbehind/ahead reject any path/identifier
    // character (letters, digits, slash, dot, hyphen) adjacent to the `_`.
    .replace(/(?<![A-Za-z0-9/_.\-])_([^_\n]+?)_(?![A-Za-z0-9/_.\-])/g, (_, t) => color(t, ANSI.italic))
    // `inline code` — emphasize with foreground color only; background blocks are visually noisy in chat text.
    .replace(/`([^`]+?)`/g, (_, code) => color(code, ANSI.cyan))
    // ~~strikethrough~~
    .replace(/~~(.+?)~~/g, (_, s) => color(s, ANSI.dim))
}

const LOCAL_PATH_RE = /(?<![\w:/.-])(\/(?:[^\s`'"<>|，。；：！？、（）【】《》])+)/g

export function formatLocalFileLink(filePath: string): string {
  if (!supportsOsc8Hyperlinks()) return filePath
  try {
    return `\x1b]8;;${pathToFileURL(filePath).href}\x1b\\${filePath}\x1b]8;;\x1b\\`
  } catch {
    return filePath
  }
}

function linkLocalPaths(line: string): string {
  if (!supportsOsc8Hyperlinks()) return line
  return line.replace(LOCAL_PATH_RE, (pathText: string) => {
    const trimmed = pathText.replace(/[),.;:!?]+$/, '')
    const suffix = pathText.slice(trimmed.length)
    try {
      const href = pathToFileURL(trimmed).href
      return `\x1b]8;;${href}\x1b\\${trimmed}\x1b]8;;\x1b\\${suffix}`
    } catch {
      return pathText
    }
  })
}

/** Full terminal Markdown renderer */
export function formatRichOutput(message: string): string {
  const lines  = message.replace(/\r\n/g, '\n').split('\n')
  const output: string[] = []
  let inCodeBlock  = false
  let codeLang     = ''
  let inDetails    = false

  for (const raw of lines) {
    const trimmed = raw.trim()

    // ── Custom run_command tag handling ────────────────────────────────────
    if (trimmed.startsWith('<run_command>')) {
      inCodeBlock = true
      codeLang = 'bash'
      output.push('')
      output.push(color('Shell', `${ANSI.skyblue}${ANSI.bold}`))
      output.push('')
      continue
    }
    if (trimmed.startsWith('</run_command>')) {
      inCodeBlock = false
      codeLang = ''
      output.push('')
      continue
    }

    // ── Details tag handling ──────────────────────────────────────────────
    if (trimmed.startsWith('<details>')) {
      inDetails = true
      continue
    }
    if (trimmed.startsWith('</details>')) {
      inDetails = false
      continue
    }
    if (inDetails) {
      // Skip details content for terminal display
      continue
    }

    // ── Summary tag handling ──────────────────────────────────────────────
    if (trimmed.startsWith('<summary>') && !trimmed.startsWith('</summary>')) {
      const summaryText = trimmed.replace(/<summary>/, '').replace(/<\/summary>/, '').trim()
      output.push(color(`  ${summaryText}`, `${ANSI.bold}${ANSI.rose}`))
      continue
    }
    if (trimmed.startsWith('</summary>')) {
      continue
    }

    // ── Code fence handling ────────────────────────────────────────────────
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLang    = trimmed.slice(3).trim()
        const label = codeLang === 'bud' ? ' HAVE A NICE TRIP! '
          : codeFenceLabel(codeLang)
        output.push('')
        if (label) {
          output.push(color(label, `${ANSI.skyblue}${ANSI.bold}`))
          output.push('')
        }
      } else {
        inCodeBlock = false
        codeLang    = ''
        output.push('')
      }
      continue
    }

    if (inCodeBlock) {
      output.push(codeLang === 'bud' ? color(raw, `${ANSI.bold}${ANSI.green}`) : styleCodeLine(raw))
      continue
    }

    // ── Headings ──────────────────────────────────────────────────────────
    const h3 = raw.match(/^#{3,}\s+(.+)/)
    if (h3) { output.push(color(`  ${h3[1]}`, `${ANSI.bold}${ANSI.violet}`)); continue }
    const h2 = raw.match(/^##\s+(.+)/)
    if (h2) { output.push(color(`  ${h2[1]}`, `${ANSI.bold}${ANSI.skyblue}`)); continue }
    const h1 = raw.match(/^#\s+(.+)/)
    if (h1) { output.push(color(`  ${h1[1]}`, `${ANSI.bold}${ANSI.white}`)); continue }

    // ── Horizontal rule ───────────────────────────────────────────────────
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      const cols = process.stdout.columns ?? 80
      output.push(color('─'.repeat(Math.min(cols - 4, 60)), ANSI.dim))
      continue
    }

    // ── Block quote ───────────────────────────────────────────────────────
    if (raw.match(/^\s*>/)) {
      const inner = raw.replace(/^\s*>\s?/, '')
      output.push(color(`  │ ${inner}`, ANSI.dim))
      continue
    }

    // ── Unordered list items ──────────────────────────────────────────────
    const ulMatch = raw.match(/^(\s*)([-*•])\s+(.+)/)
    if (ulMatch) {
      const [, indent, , content] = ulMatch
      const bullet = color('◆', ANSI.violet)
      output.push(`${indent}${bullet} ${applyInlineStyles(content!)}`)
      continue
    }

    // ── Ordered list items ────────────────────────────────────────────────
    const olMatch = raw.match(/^(\s*)(\d+)[.)]\s+(.+)/)
    if (olMatch) {
      const [, indent, num, content] = olMatch
      output.push(`${indent}${color(num! + '.', ANSI.violet)} ${applyInlineStyles(content!)}`)
      continue
    }

    // ── Success / error lines ─────────────────────────────────────────────
    if (/✅|完成|已完成|成功|已更新|已保存|activated|success|completed|updated|saved/i.test(raw))
      { output.push(color(raw, `${ANSI.bold}${ANSI.green}`)); continue }
    if (/❌|错误|失败|error|failed|invalid|unauthorized/i.test(raw))
      { output.push(color(raw, `${ANSI.red}`)); continue }

    // ── Key-value field lines (e.g. "Label: value") ───────────────────────
    const kvMatch = raw.match(/^(\s*)([^:：]{1,28})([:：])(\s+.*)$/)
    if (kvMatch) {
      const [, indent, label, sep, value] = kvMatch
      const lowerLabel = label.trim().toLowerCase()
      if (!lowerLabel.startsWith('http') && !label.includes('/') && !label.includes('`')) {
        output.push(`${indent}${color(label! + sep, `${ANSI.bold}${ANSI.rose}`)}${applyInlineStyles(value!)}`)
        continue
      }
    }

    // ── Default: inline styles only ───────────────────────────────────────
    output.push(applyInlineStyles(raw))
  }

  return output.join('\n')
}

function normalizeHiddenInput(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function isHighEasterEggInput(text: string): boolean {
  const normalized = normalizeHiddenInput(text)
  return normalized === 'i wanna get high' || normalized === '我想大一下'
}

export function buildHighEasterEgg(locale = 'en'): string {
  const heading = locale === 'zh-CN'
    ? color(' 有时候，也想 chill 一下。 ', `${ANSI.bgGreen}${ANSI.black}${ANSI.bold}`)
    : color(' Sometimes, we just want to chill. ', `${ANSI.bgGreen}${ANSI.black}${ANSI.bold}`)
  const art = String.raw`
                         :
                         =
                         +:
                         +: .
                         += .
                       =#*+:=
                     . :-*=* .
                      * %*=-#- :
                     : *++=== -:
                 .+  -#*+++=-+% -*
                  +#+*+*+==++*@-*#
                   %+@#*+:++**@+-
                    *%#*==*=+@@=+
                 .= *#*#*=**+#*#+-
                  :+ @#+=-*###=*-  +***+
                   +%*%##+***=+####=+**+
              +%%%% *=+%*#*++#*##-+#:
                -**@##*#-#***###+@
                 -*+#*+*+=+*=***%.+.
                 .-#++++*+*+==+**+:-.-****
             ===-::%#++*##*=+#*=+%#-*++*==
              +#%%%%****#%*++=++#**%=##
             .. %%@+==#+###=+*#*%+@*%-
          =%%###+-@#-#*-#%#*+=#*#*=@-
        ******##%%%+*%*=%%%###===+#@@##:
        =+++++##*#%@+#=%@%+--+#**=%#=+- ====
               =#%%++%*%+*%*+:-*+#=+@*@%#*#*##@-
           -. ++.%+%#++=+@%%%%+-*=++@%%####*##%%@.
           -%%  *=#%***+##%%#**%-#*+%%###@@......=
            =%@***###+=#**#%@@#%#+##%@*--
             @#@*####++#**#*#@##%+%#%%#==
             :@#@%%#%+*#%@%=-@###%@#*+**#=.
        ....  +%@#*##**+*%##+=%*####@@@@%%@
      :%#*#*% ##*=*=**#*#%##@=*=#*+###%*
    =##*#####%##===+=*#*##%#%@*=+#*#%+%% **###***
   %%====##*#%*#+=++**###%#*#*#*==##%#@@#*****%%%@+
           **%#***+***+%%%**#%**++*=++%%##+#%*.
             .%+##*=+*=%%##%*@###+--+#@@%%%
         %%%%-#%@*#=###@-#+#%#%*#=++%+=%..
      :#%#%%%%%%@#+%+*@@-=*#*#@=**=-@##**.
        ====+@%@%*%@=*@**###+#@=#*%##**%##:
           -=%@@%%#@+*%%*%+#@+@+*%*%#=   %+
         ..%##%%#%@@#*@@+%@#@@%%*@##%%@#..
        %*++####%@@@@%@@@@@#@@@%%%%%%%#*==%
       .*+#***%@:##%@%@.@%@%#@%@@@###**##*+#
      -#+**+#=. *#%%+@@@#%-%#%%##@%=##**+***#=
     .#*#=*#+  =##+%: @@*@:%*%#%*#@. -***#++##.
     ++#-#-    @*#*%  -##: %*%##%*+#      %#++@
     %*=@      +#=%   %+@: %+@%+##=%         @*@
    =+*:      #***   -%*@  @+  #+#+#:         :%-
    **        =*+-   ++%++:=*  -**#+:          -=
    %-        #*+    %*%#*+=%   ****@
    *         #%    *+###*#.#    #*#%
    -         #-    **#@.##=     -@=#=
              #-    #**   *=       #+=
               .   %=#-    :       =*=
                  .*+%              #%
                  @=#=               @
                 :**%                +
                 @+*@                .
                 @%*-
                  @@`
  return `${heading}\n\n\`\`\`text\n${art}\n\`\`\``
}

function normalizeHiddenInputV2(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?。！？,，]/g, '').replace(/\s+/g, ' ')
}

export function isHighEasterEggTrigger(text: string): boolean {
  const normalized = normalizeHiddenInputV2(text)
  return normalized === 'i wanna get high' || normalized === '我想大一下'
}

export function buildHighEasterEggCompact(locale = 'en'): string {
  const heading = locale === 'zh-CN'
    ? color(' 有时候，我们也想 chill 一下。 ', `${ANSI.bgGreen}${ANSI.black}${ANSI.bold}`)
    : color(' Sometimes, we just want to chill. ', `${ANSI.bgGreen}${ANSI.black}${ANSI.bold}`)
  const art = String.raw`


       -
       +
       +:
      .*:
      :##
.     =#=     .
 #:.  ***   -*
 :+*  ***  =+#
  ++: *#* :*#
  +*+:.##:=++
   #++:#:++*:
   :*++#-**:
:*=*.+##++.++*:
 =*#+*+#+**#*=
     ++#*+
    --.*:--
       =
       =`
  return `${heading}\n\n\`\`\`bud\n${art}\n\`\`\``
}

export function buildPanel(title: string, bodyLines: string[]): string {
  const innerWidth = PANEL_WIDTH
  const border = color('─'.repeat(innerWidth + 4), ANSI.dim)
  const output: string[] = [border]
  const tone = inferPanelTone(title)
  for (const line of wrapText(title, innerWidth)) {
    output.push(stylePanelTitle(padDisplayEnd(line, innerWidth), tone))
  }
  if (bodyLines.length > 0) {
    output.push('')
    for (const rawLine of bodyLines) {
      if (!rawLine.trim()) {
        output.push('')
        continue
      }
      for (const line of wrapText(rawLine, innerWidth)) {
        output.push(applyInlineStyles(padDisplayEnd(line, innerWidth)))
      }
    }
  }
  output.push(border)
  return output.join('\n')
}
