/* eslint-disable @typescript-eslint/no-unused-vars, no-control-regex */
import { emitKeypressEvents } from 'node:readline'
import { CliSettingsStore } from './settings.js'
import { stringWidth } from '../input/stringWidth.js'
import type { UiLocale } from './locale.js'

const ESC = '\x1b'
const ALT_ON = `${ESC}[?1049h${ESC}[H${ESC}[2J`
const ALT_OFF = `${ESC}[?1049l`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`

export type WorkspaceTrustResult = 'trusted' | 'declined'

type Layout = {
  bodyLineCount: number
  leftPad: string
  innerWidth: number
  top: string
  bottom: string
}

// ─── color helpers ────────────────────────────────────────────────────────────

function color(text: string, code: string): string {
  return process.stdout.isTTY ? `${code}${text}${ESC}[0m` : text
}
function cyan(text: string): string { return color(text, `${ESC}[36m`) }
function dim(text: string): string  { return color(text, `${ESC}[2m`) }
function invert(text: string): string { return color(text, `${ESC}[7m`) }
function rgb(text: string, r: number, g: number, b: number, bold = false): string {
  return color(text, `${ESC}[${bold ? '1;' : ''}38;2;${r};${g};${b}m`)
}
function stripAnsi(text: string): string { return text.replace(/\x1b\[[0-9;]*m/g, '') }

function padAnsiEnd(text: string, width: number): string {
  const visible = stringWidth(stripAnsi(text))
  return visible >= width ? text : text + ' '.repeat(width - visible)
}
function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - stringWidth(stripAnsi(text))) / 2))
  return `${' '.repeat(pad)}${text}`
}

function aurora(text: string, offset: number): string {
  const palette: Array<[number, number, number]> = [
    [96, 214, 255], [128, 197, 255], [181, 160, 255], [255, 143, 214], [255, 195, 113],
  ]
  return [...text]
    .map((ch, i) => ch === ' ' ? ch : (([r, g, b]) => rgb(ch, r, g, b, true))(palette[(i + offset) % palette.length]!))
    .join('')
}

function rainbow(segment: string, offset: number): string {
  const palette: Array<[number, number, number]> = [
    [255, 82, 195], [255, 120, 155], [250, 179, 135], [249, 226, 175],
    [166, 227, 161], [148, 226, 213], [137, 180, 250], [148, 82, 255],
  ]
  return [...segment]
    .map((ch, i) => (([r, g, b]) => rgb(ch, r, g, b, true))(palette[(i + offset) % palette.length]!))
    .join('')
}

// ─── guardian cat — same pixel-trail aesthetic as firstRunWelcome ─────────────

// Free-standing sleeping-kitty art — intentionally different from the language
// picker's pixel-trail cat. All rows render at exactly the same visible width
// (12 single-width glyphs) so the frame never drifts regardless of terminal
// font metrics. Sparkles above/below cycle position each frame to animate.
const CAT_FRAMES = [
  {
    starsTop:    '   ·    ✦    ·    ',
    starsBottom: '    ✦    ·    ✦   ',
    trailOffset: 0,
    cat: [
      '    /\\_/\\   ',
      "   ( ^.^ )  ",
      '    > = <   ',
      "   /     \\  ",
    ],
  },
  {
    starsTop:    '  ✦    ·    ✦    ·',
    starsBottom: '  ·    ✦    ·    ✦',
    trailOffset: 2,
    cat: [
      '    /\\_/\\   ',
      "   ( -.- )  ",
      '    > = <   ',
      "   /     \\  ",
    ],
  },
  {
    starsTop:    '    ✦    ·    ✦   ',
    starsBottom: ' ·    ✦    ·    · ',
    trailOffset: 4,
    cat: [
      '    /\\_/\\   ',
      "   ( o.o )  ",
      '    > ~ <   ',
      "   /     \\  ",
    ],
  },
]

// ─── copy ─────────────────────────────────────────────────────────────────────

const COPY = {
  'zh-CN': {
    title:       '✦ Workspace Trust ✦',
    subtitle:    '工作区信任确认',
    intro:       '即将进入',
    notice:      '这是你创建或信任的项目吗？',
    yes:         '信任并进入',
    no:          '退出',
    footer:      '← → / ↑ ↓ 选择   Enter 确认   Esc 取消',
  },
  'en': {
    title:       '✦ Workspace Trust ✦',
    subtitle:    'Workspace trust check',
    intro:       'Entering',
    notice:      'Is this a project you created or trust?',
    yes:         'Trust & enter',
    no:          'Exit',
    footer:      '← → / ↑ ↓ select   Enter confirm   Esc cancel',
  },
} as const

// ─── path formatting ──────────────────────────────────────────────────────────

function formatPathForDisplay(p: string, maxWidth: number): string {
  if (stringWidth(p) <= maxWidth) return p
  const keepTail = Math.max(20, maxWidth - 4)
  return '...' + p.slice(-keepTail)
}

// ─── layout (tight, like firstRunWelcome) ─────────────────────────────────────

function buildLayout(cwd: string, locale: UiLocale): Layout {
  const t = COPY[locale] ?? COPY['en']
  const pathMax = Math.min(44, Math.max(28, (process.stdout.columns ?? 80) - 30))
  const pathLine = formatPathForDisplay(cwd, pathMax)

  const probeBody = [
    t.title,
    t.subtitle,
    '',
    '   ·    ✦    ·    ',
    '    /\\_/\\   ',
    "   ( ^.^ )  ",
    '    > = <   ',
    "   /     \\  ",
    '    ✦    ·    ✦   ',
    '',
    t.intro,
    pathLine,
    '',
    t.notice,
    '',
    ` ${t.yes}    /    ${t.no} `,
    '',
    t.footer,
    '',
    'www.420.company',
  ]
  const innerWidth = probeBody.reduce((m, line) => Math.max(m, stringWidth(line)), 0) + 6
  const frameWidth = innerWidth + 2
  const leftPad = ' '.repeat(Math.max(0, Math.floor(((process.stdout.columns ?? 80) - frameWidth - 2) / 2)))

  return {
    bodyLineCount: probeBody.length,
    leftPad,
    innerWidth,
    top:    `${leftPad}${cyan('╔')}${cyan('═'.repeat(innerWidth))}${cyan('╗')}`,
    bottom: `${leftPad}${cyan('╚')}${cyan('═'.repeat(innerWidth))}${cyan('╝')}`,
  }
}

// ─── body renderer ────────────────────────────────────────────────────────────

function buildBody(
  frameIndex: number,
  selectedIndex: number,
  cwd: string,
  locale: UiLocale,
  layout: Layout,
): string[] {
  const t = COPY[locale] ?? COPY['en']
  const frame = CAT_FRAMES[frameIndex % CAT_FRAMES.length]!

  const pathMax = Math.min(44, Math.max(28, (process.stdout.columns ?? 80) - 30))
  const pathText = formatPathForDisplay(cwd, pathMax)

  const title    = aurora(t.title, frame.trailOffset)
  const subtitle = dim(t.subtitle)
  const intro    = rgb(t.intro, 137, 180, 250)
  const pathLine = rgb(pathText, 249, 226, 175, true)
  const notice   = rgb(t.notice, 250, 179, 135)
  const footer   = dim(t.footer)
  const brand    = dim('www.420.company')

  // Free-standing cat, soft-warm fur color (no pixel-trail band). We cycle
  // through three gentle accent hues on each redraw so it looks alive without
  // being noisy.
  const furPalette: Array<[number, number, number]> = [
    [255, 220, 180], // warm cream
    [255, 198, 198], // blush pink
    [210, 230, 255], // cool mist
  ]
  const [fr, fg, fb] = furPalette[frame.trailOffset % furPalette.length]!
  const catLines = frame.cat.map(line => rgb(line, fr, fg, fb, true))

  // Two horizontal options, like the language picker.
  const yesPainted = rgb(t.yes, 166, 227, 161, true)   // green
  const noPainted  = rgb(t.no,  255, 120, 155, true)   // pink
  const options = [
    selectedIndex === 0 ? invert(` ${yesPainted} `) : ` ${yesPainted} `,
    selectedIndex === 1 ? invert(` ${noPainted}  `) : ` ${noPainted}  `,
  ].join(dim('   /   '))

  const body = [
    title,
    subtitle,
    '',
    dim(frame.starsTop),
    catLines[0]!,
    catLines[1]!,
    catLines[2]!,
    catLines[3]!,
    dim(frame.starsBottom),
    '',
    intro,
    pathLine,
    '',
    notice,
    '',
    options,
    '',
    footer,
    '',
    brand,
  ]

  return body.map(line => {
    const centered = center(line, layout.innerWidth)
    return `${layout.leftPad}${cyan('║')}${padAnsiEnd(centered, layout.innerWidth)}${cyan('║')}`
  })
}

// ─── main ─────────────────────────────────────────────────────────────────────

export async function runWorkspaceTrustDialog(options: {
  cwd: string
  locale: UiLocale
  settingsStore: CliSettingsStore
}): Promise<WorkspaceTrustResult> {
  const { cwd, locale, settingsStore } = options

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    await settingsStore.rememberTrustedWorkspace(cwd)
    return 'trusted'
  }

  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  let selectedIndex = 0
  let frameIndex = 0
  const layout = buildLayout(cwd, locale)

  const renderStatic = () => {
    const blank = `${layout.leftPad} ${' '.repeat(layout.innerWidth)} `
    const lines = [
      '',
      layout.top,
      ...Array.from({ length: layout.bodyLineCount }, () => blank),
      layout.bottom,
      '',
    ]
    process.stdout.write(`${ALT_ON}${HIDE_CURSOR}`)
    process.stdout.write(lines.join('\n'))
  }

  const renderBody = () => {
    const lines = buildBody(frameIndex, selectedIndex, cwd, locale, layout)
    const updates = lines.map((line, i) => `${ESC}[${i + 3};1H${line}`)
    process.stdout.write(updates.join(''))
  }

  renderStatic()
  renderBody()
  const timer = setInterval(() => {
    frameIndex = (frameIndex + 1) % CAT_FRAMES.length
    renderBody()
  }, 180)

  return await new Promise<WorkspaceTrustResult>((resolve) => {
    const cleanup = async (result: WorkspaceTrustResult) => {
      clearInterval(timer)
      process.stdin.off('keypress', onKeypress)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write(`${SHOW_CURSOR}${ALT_OFF}`)
      if (result === 'trusted') {
        await settingsStore.rememberTrustedWorkspace(cwd)
      }
      resolve(result)
    }

    const onKeypress = async (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') { await cleanup('declined'); return }
      if (key.name === 'escape')        { await cleanup('declined'); return }
      if (key.name === 'left' || key.name === 'up')   { selectedIndex = 0; renderBody(); return }
      if (key.name === 'right' || key.name === 'down'){ selectedIndex = 1; renderBody(); return }
      if (key.name === 'return' || key.name === 'enter') {
        await cleanup(selectedIndex === 0 ? 'trusted' : 'declined')
      }
    }

    process.stdin.on('keypress', onKeypress)
  })
}
