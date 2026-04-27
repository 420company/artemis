import { emitKeypressEvents } from 'node:readline'
import { CliSettingsStore } from './settings.js'
import { normalizeUiLocale, type UiLocale } from './locale.js'
import { stringWidth } from '../input/stringWidth.js'

const ESC = '\x1b'
const ALT_ON = `${ESC}[?1049h${ESC}[H${ESC}[2J`
const ALT_OFF = `${ESC}[?1049l`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`

type WelcomeLayout = {
  bodyLineCount: number
  leftPad: string
  innerWidth: number
  top: string
  bottom: string
}

function color(text: string, code: string): string {
  return process.stdout.isTTY ? `${code}${text}${ESC}[0m` : text
}

function cyan(text: string): string {
  return color(text, `${ESC}[36m`)
}

function rgb(text: string, r: number, g: number, b: number, bold = false): string {
  return color(text, `${ESC}[${bold ? '1;' : ''}38;2;${r};${g};${b}m`)
}

function dim(text: string): string {
  return color(text, `${ESC}[2m`)
}

function invert(text: string): string {
  return color(text, `${ESC}[7m`)
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function padAnsiEnd(text: string, width: number): string {
  const visible = stringWidth(stripAnsi(text))
  return visible >= width ? text : text + ' '.repeat(width - visible)
}

function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - stringWidth(stripAnsi(text))) / 2))
  return `${' '.repeat(pad)}${text}`
}

function rainbow(segment: string, offset: number): string {
  const palette: Array<[number, number, number]> = [
    [255, 82, 195],
    [255, 120, 155],
    [250, 179, 135],
    [249, 226, 175],
    [166, 227, 161],
    [148, 226, 213],
    [137, 180, 250],
    [148, 82, 255],
  ]

  return [...segment]
    .map((char, index) => {
      const [r, g, b] = palette[(index + offset) % palette.length]!
      return rgb(char, r, g, b, true)
    })
    .join('')
}

function aurora(text: string, offset: number): string {
  const palette: Array<[number, number, number]> = [
    [96, 214, 255],
    [128, 197, 255],
    [181, 160, 255],
    [255, 143, 214],
    [255, 195, 113],
  ]

  return [...text]
    .map((char, index) => {
      if (char === ' ') return char
      const [r, g, b] = palette[(index + offset) % palette.length]!
      return rgb(char, r, g, b, true)
    })
    .join('')
}

const CAT_FRAMES = [
  {
    stars: ['      ✦        ·        ✦   ', '   ·       ✦       ·        '],
    trailOffset: 0,
    cat: [
      '▆▅▄▃▂▁  ,------------,',
      '▁▂▃▄▅▆  |\\_/\\\\ .--. |',
      '▆▅▄▃▂▁  | ^ .^(____)|',
      '▁▂▃▄▅▆  |__^________|',
    ],
  },
  {
    stars: ['   ·       ✦       ·        ', '      ✦        ·        ✦   '],
    trailOffset: 2,
    cat: [
      '▅▄▃▂▁▆  ,------------,',
      '▂▃▄▅▆▁  |\\_/\\\\ .--. |',
      '▅▄▃▂▁▆  | o .o(____)|',
      '▂▃▄▅▆▁  |__^________|',
    ],
  },
  {
    stars: [' ✦      ·       ✦       ·   ', '    ·      ✦      ·      ✦  '],
    trailOffset: 4,
    cat: [
      '▄▃▂▁▆▅  ,------------,',
      '▃▄▅▆▁▂  |\\_/\\\\ .--. |',
      '▄▃▂▁▆▅  | ^ .^(____)|',
      '▃▄▅▆▁▂  |__^________|',
    ],
  },
]

function buildLayout(): WelcomeLayout {
  const probeBody = [
    '✦ First-Run Setup Wizard ✦',
    '首次运行配置向导',
    '',
    'choose your language / 选择界面语言',
    '',
    '      ✦        ·        ✦   ',
    '▆▅▄▃▂▁  ,------------,',
    '▁▂▃▄▅▆  |\\_/\\\\ .--. |',
    '▆▅▄▃▂▁  | ^ .^(____)|',
    '▁▂▃▄▅▆  |__^________|',
    '   ·       ✦       ·        ',
    '',
    ' 中文    /    English ',
    '',
    '← → / ↑ ↓ select   Enter confirm',
    '',
    'www.420.company',
  ]
  const innerWidth = probeBody.reduce((max, line) => Math.max(max, stringWidth(line)), 0) + 6
  const frameWidth = innerWidth + 2
  const leftPad = ' '.repeat(Math.max(0, Math.floor(((process.stdout.columns ?? 80) - frameWidth - 2) / 2)))

  return {
    bodyLineCount: probeBody.length,
    leftPad,
    innerWidth,
    top: `${leftPad}${cyan('╔')}${cyan('═'.repeat(innerWidth))}${cyan('╗')}`,
    bottom: `${leftPad}${cyan('╚')}${cyan('═'.repeat(innerWidth))}${cyan('╝')}`,
  }
}

function buildBody(frameIndex: number, localeIndex: number, layout: WelcomeLayout): string[] {
  const frame = CAT_FRAMES[frameIndex % CAT_FRAMES.length]!
  const title = aurora('✦ First-Run Setup Wizard ✦', frame.trailOffset)
  const subtitle = dim('首次运行配置向导')
  const guide = dim('choose your language / 选择界面语言')
  const prompt = dim('← → / ↑ ↓ select   Enter confirm')
  const footer = dim('www.420.company')
  const options = [
    localeIndex === 0
      ? invert(` ${rgb('中文', 148, 82, 255, true)} `)
      : ` ${rgb('中文', 148, 82, 255, true)} `,
    localeIndex === 1
      ? invert(` ${rgb('English', 100, 180, 255, true)} `)
      : ` ${rgb('English', 100, 180, 255, true)} `,
  ].join(dim('   /   '))

  const trailLines = frame.cat.map(line => {
    const trail = rainbow(line.slice(0, 6), frame.trailOffset)
    return `${trail}${rgb(line.slice(6), 245, 245, 245)}`
  })

  const body = [
    title,
    subtitle,
    '',
    guide,
    '',
    dim(frame.stars[0]!),
    trailLines[0]!,
    trailLines[1]!,
    trailLines[2]!,
    trailLines[3]!,
    dim(frame.stars[1]!),
    '',
    options,
    '',
    prompt,
    '',
    footer,
  ]

  return body.map(line => {
    const centered = center(line, layout.innerWidth)
    return `${layout.leftPad}${cyan('║')}${padAnsiEnd(centered, layout.innerWidth)}${cyan('║')}`
  })
}

export async function runFirstRunWelcome(options: {
  settingsStore: CliSettingsStore
}): Promise<UiLocale> {
  const inferred = normalizeUiLocale(undefined)

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    await options.settingsStore.setUiLocale(inferred)
    return inferred
  }

  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  let selectedIndex = inferred === 'zh-CN' ? 0 : 1
  let frameIndex = 0
  const layout = buildLayout()

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
    const lines = buildBody(frameIndex, selectedIndex, layout)
    const updates = lines.map((line, index) => `${ESC}[${index + 3};1H${line}`)
    process.stdout.write(updates.join(''))
  }

  renderStatic()
  renderBody()
  const timer = setInterval(() => {
    frameIndex = (frameIndex + 1) % CAT_FRAMES.length
    renderBody()
  }, 180)

  return await new Promise<UiLocale>((resolve, reject) => {
    const cleanup = async (result?: UiLocale, error?: Error) => {
      clearInterval(timer)
      process.stdin.off('keypress', onKeypress)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write(`${SHOW_CURSOR}${ALT_OFF}`)

      if (result) {
        await options.settingsStore.setUiLocale(result)
        resolve(result)
        return
      }

      reject(error ?? new Error('Language selection cancelled'))
    }

    const onKeypress = async (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        await cleanup(undefined, new Error('Language selection cancelled'))
        return
      }

      if (key.name === 'left' || key.name === 'up') {
        selectedIndex = 0
        renderBody()
        return
      }

      if (key.name === 'right' || key.name === 'down') {
        selectedIndex = 1
        renderBody()
        return
      }

      if (key.name === 'return' || key.name === 'enter') {
        await cleanup(selectedIndex === 0 ? 'zh-CN' : 'en')
      }
    }

    process.stdin.on('keypress', onKeypress)
  })
}
