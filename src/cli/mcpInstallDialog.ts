import { emitKeypressEvents } from 'node:readline'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringWidth } from '../input/stringWidth.js'
import type { UiLocale } from './locale.js'

const ESC     = '\x1b'
const ALT_ON  = `${ESC}[?1049h${ESC}[H${ESC}[2J`
const ALT_OFF = `${ESC}[?1049l`
const HIDE    = `${ESC}[?25l`
const SHOW    = `${ESC}[?25h`

const CLI_ROOT     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MCP_PACKAGES = path.join(CLI_ROOT, 'mcp-packages')

// ─── colour helpers ────────────────────────────────────────────────────────────

function rgb(t: string, r: number, g: number, b: number, bold = false): string {
  if (!process.stdout.isTTY) return t
  return `${ESC}[${bold ? '1;' : ''}38;2;${r};${g};${b}m${t}${ESC}[0m`
}
function cyan(t: string)   { return process.stdout.isTTY ? `${ESC}[36m${t}${ESC}[0m` : t }
function dim(t: string)    { return process.stdout.isTTY ? `${ESC}[2m${t}${ESC}[0m`  : t }
function invert(t: string) { return process.stdout.isTTY ? `${ESC}[7m${t}${ESC}[0m`  : t }
function bold(t: string)   { return process.stdout.isTTY ? `${ESC}[1m${t}${ESC}[0m`  : t }

function stripAnsi(t: string) { return t.replace(/\x1b\[[0-9;]*m/g, '') }
function visLen(t: string)    { return stringWidth(stripAnsi(t)) }

function padAnsiEnd(t: string, w: number): string {
  const gap = w - visLen(t)
  return gap > 0 ? t + ' '.repeat(gap) : t
}
function center(t: string, w: number): string {
  const gap = Math.max(0, Math.floor((w - visLen(t)) / 2))
  return ' '.repeat(gap) + t
}

function aurora(text: string, offset: number): string {
  const pal: [number, number, number][] = [
    [96, 214, 255], [128, 197, 255], [181, 160, 255],
    [255, 143, 214], [255, 195, 113],
  ]
  return [...text]
    .map((ch, i) => ch === ' ' ? ch : (([r, g, b]) => rgb(ch, r, g, b, true))(pal[(i + offset) % pal.length]!))
    .join('')
}

function rainbow(text: string, offset: number): string {
  const pal: [number, number, number][] = [
    [255, 82, 195], [255, 120, 155], [250, 179, 135],
    [249, 226, 175], [166, 227, 161], [148, 226, 213],
    [137, 180, 250], [148, 82, 255],
  ]
  return [...text]
    .map((ch, i) => (([r, g, b]) => rgb(ch, r, g, b, true))(pal[(i + offset) % pal.length]!))
    .join('')
}

// ─── cat frames: 🌙 upper-left, 𓃠 lower-right — diagonal gaze ─────────────────
// Moon at col ~3, cat at col ~17 → clear diagonal slope.
// Three frames: bright(✦) → medium(·✦) → soft(˚) for breathing rhythm.

const CAT_FRAMES = [
  {
    // bright — inhale
    haloTop:  ' ✦  🌙  ·  ✦  ·  ✦  ·  ✦  · ',
    innerTop: '  ·    ✦     ·    ✦  ·   ✦   ',
    scene:    '✦  ·   ✦   𓃠   ✦   ·  ✦  ·  ',
    innerBot: '  ✦  ·    ✦     ·   ✦    ·   ',
    haloBot:  ' ·  ✦  ·   ✦  ·  ✦  ·   ✦  ·',
    offset: 0,
  },
  {
    // medium
    haloTop:  ' ·   🌙  ✦  ·  ✦  ·  ✦  ·  ✦ ',
    innerTop: '  ✦    ·     ✦    ·  ✦   ·    ',
    scene:    '·  ✦   ·   𓃠   ·   ✦  ·  ✦  ',
    innerBot: '  ·  ✦    ·     ✦   ·    ✦   ',
    haloBot:  ' ✦  ·  ✦   ·  ✦  ·  ✦  ·   ✦',
    offset: 3,
  },
  {
    // soft — exhale
    haloTop:  ' ˚   🌙  ·  ˚  ·  ˚  ·  ˚  · ',
    innerTop: '  ·    ˚     ·    ˚  ·   ˚    ',
    scene:    '˚  ·   ˚   𓃠   ˚   ·  ˚  ·  ',
    innerBot: '  ˚  ·    ˚     ·   ˚    ·    ',
    haloBot:  ' ·  ˚  ·   ˚  ·  ˚  ·   ˚  · ',
    offset: 6,
  },
]

// ─── copy ──────────────────────────────────────────────────────────────────────

const COPY = {
  'zh-CN': {
    title:    '✦ MCP 插件依赖安装 ✦',
    subtitle: 'Artemis 内置 90 个 MCP 服务插件',
    desc1:    '其中 22 个插件需要安装 npm 依赖包',
    desc2:    '安装后约 1.4 GB，需要 2-5 分钟',
    desc3:    '请确保网络通畅，也可以跳过稍后再安装',
    yes:      '✦ 立即安装全部依赖',
    no:       '跳过，稍后再说 ✦',
    footer:   '← → 选择   Enter 确认',
    brand:    'www.420.company',
    installing: '◆ 正在安装 MCP 依赖 ◆',
    wait:     '请稍候，安装完成后自动继续…',
    preparing: '准备中…',
    pkgCount: (d: number, t: number) => `已完成 ${d} / ${t} 个包`,
    doneOk:   '✓ 所有 MCP 依赖安装完成！',
    doneFail: '⚠ 部分包安装失败，可用 /mcp install 重试',
    anyKey:   '按任意键继续…',
    mcpHint:  '使用 /mcp enable <id> 启用任意插件',
  },
  'en': {
    title:    '✦ MCP Plugin Setup ✦',
    subtitle: 'Artemis ships with 90 MCP plugin servers',
    desc1:    '22 of them require npm package dependencies',
    desc2:    '~1.4 GB installed, takes 2–5 minutes',
    desc3:    'You can skip and install later when needed',
    yes:      '✦ Install all now',
    no:       'Skip for now ✦',
    footer:   '← → select   Enter confirm',
    brand:    'www.420.company',
    installing: '◆ Installing MCP Dependencies ◆',
    wait:     'Please wait, auto-continues when done…',
    preparing: 'Preparing…',
    pkgCount: (d: number, t: number) => `${d} / ${t} packages`,
    doneOk:   '✓ All MCP dependencies installed!',
    doneFail: '⚠ Some packages failed — run /mcp install to retry',
    anyKey:   'Press any key to continue…',
    mcpHint:  'Use /mcp enable <id> to activate any plugin',
  },
}

// ─── layout (dynamic width — same approach as workspaceTrust) ──────────────────

type Layout = { innerWidth: number; leftPad: string; top: string; bottom: string }

function buildLayout(locale: UiLocale): Layout {
  const t = COPY[locale] ?? COPY['en']
  const probeLines = [
    t.title,
    t.subtitle,
    t.desc1,
    t.desc2,
    t.desc3,
    CAT_FRAMES[0]!.haloTop,
    CAT_FRAMES[0]!.haloBot,
    CAT_FRAMES[0]!.scene,
    ` ${t.yes}    /    ${t.no} `,
    t.footer,
    t.brand,
  ]
  const innerWidth = probeLines.reduce((m, l) => Math.max(m, stringWidth(l)), 0) + 6
  const frameWidth = innerWidth + 4
  const cols       = process.stdout.columns ?? 80
  const leftPad    = ' '.repeat(Math.max(0, Math.floor((cols - frameWidth) / 2)))
  return {
    innerWidth,
    leftPad,
    top:    `${leftPad}${cyan('╔')}${cyan('═'.repeat(innerWidth))}${cyan('╗')}`,
    bottom: `${leftPad}${cyan('╚')}${cyan('═'.repeat(innerWidth))}${cyan('╝')}`,
  }
}

// ─── row helpers ───────────────────────────────────────────────────────────────

function row(line: string, layout: Layout): string {
  const c = center(line, layout.innerWidth)
  return `${layout.leftPad}${cyan('║')}${padAnsiEnd(c, layout.innerWidth)}${cyan('║')}`
}
function blank(layout: Layout): string {
  return `${layout.leftPad}${cyan('║')}${' '.repeat(layout.innerWidth)}${cyan('║')}`
}

// ─── choice screen ─────────────────────────────────────────────────────────────

function buildChoiceLines(fi: number, sel: number, locale: UiLocale, layout: Layout): string[] {
  const t  = COPY[locale] ?? COPY['en']
  const fr = CAT_FRAMES[fi % CAT_FRAMES.length]!
  const furPal: [number, number, number][] = [
    [255, 220, 180], [255, 198, 198], [210, 230, 255],
  ]
  const [cr, cg, cb] = furPal[fr.offset % furPal.length]!

  const yesPainted = rgb(t.yes, 166, 227, 161, true)
  const noPainted  = rgb(t.no,  255, 120, 155, true)
  const options    = [
    sel === 0 ? invert(` ${yesPainted} `) : ` ${yesPainted} `,
    sel === 1 ? invert(` ${noPainted}  `) : ` ${noPainted}  `,
  ].join(dim('   /   '))

  return [
    blank(layout),
    row(aurora(t.title, fi * 3), layout),
    row(dim(t.subtitle), layout),
    blank(layout),
    row(dim(fr.haloTop), layout),
    row(dim(fr.innerTop), layout),
    row(rgb(fr.scene, cr, cg, cb, true), layout),
    row(dim(fr.innerBot), layout),
    row(dim(fr.haloBot), layout),
    blank(layout),
    row(rgb(t.desc1, 137, 180, 250), layout),
    row(rgb(t.desc2, 249, 226, 175, true), layout),
    row(dim(t.desc3), layout),
    blank(layout),
    row(options, layout),
    blank(layout),
    row(dim(t.footer), layout),
    blank(layout),
    row(dim(t.brand), layout),
    blank(layout),
  ]
}

// ─── progress screen ───────────────────────────────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function buildProgressLines(fi: number, done: number, total: number, current: string, locale: UiLocale, layout: Layout): string[] {
  const t    = COPY[locale] ?? COPY['en']
  const pct  = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0
  const barW = Math.max(20, layout.innerWidth - 14)
  const fill = Math.round((pct / 100) * barW)
  const bar  = rgb('█'.repeat(fill), 166, 227, 161) + dim('░'.repeat(barW - fill))
  const spin = SPINNER[fi % SPINNER.length]!

  return [
    blank(layout),
    blank(layout),
    row(aurora(t.installing, fi * 3), layout),
    blank(layout),
    row(`${bar}  ${rgb(pct + '%', 249, 226, 175, true)}`, layout),
    blank(layout),
    row(`${cyan(spin)}  ${dim(current.slice(0, layout.innerWidth - 6))}`, layout),
    blank(layout),
    row(dim(t.pkgCount(done, total)), layout),
    blank(layout),
    blank(layout),
    row(dim(t.wait), layout),
    blank(layout),
    blank(layout),
  ]
}

// ─── done screen ───────────────────────────────────────────────────────────────

function buildDoneLines(success: boolean, locale: UiLocale, layout: Layout): string[] {
  const t = COPY[locale] ?? COPY['en']
  return [
    blank(layout),
    blank(layout),
    blank(layout),
    row(success ? rgb(bold(t.doneOk), 166, 227, 161) : rgb(bold(t.doneFail), 255, 120, 155), layout),
    blank(layout),
    row(dim(success ? t.mcpHint : t.doneFail), layout),
    blank(layout),
    blank(layout),
    row(dim(t.anyKey), layout),
    blank(layout),
    blank(layout),
    blank(layout),
  ]
}

// ─── full-screen render ────────────────────────────────────────────────────────

function renderScreen(lines: string[], layout: Layout): void {
  const content = [
    `${ESC}[H${ESC}[2J`,
    '',
    layout.top,
    ...lines,
    layout.bottom,
    '',
  ].join('\n')
  process.stdout.write(content)
}

// ─── public API ────────────────────────────────────────────────────────────────

export function shouldShowMcpInstallDialog(): boolean {
  return !existsSync(path.join(MCP_PACKAGES, 'node_modules'))
}

export async function runMcpInstallDialog(locale: UiLocale): Promise<'installed' | 'skipped'> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'skipped'

  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdout.write(`${ALT_ON}${HIDE}`)

  let sel = 0
  let fi  = 0
  let layout = buildLayout(locale)

  const renderChoice = () => renderScreen(buildChoiceLines(fi, sel, locale, layout), layout)

  renderChoice()
  const timer = setInterval(() => { fi++; renderChoice() }, 350)

  // Re-render cleanly on terminal resize — prevents ghosting
  const onResize = () => { layout = buildLayout(locale); renderChoice() }
  process.stdout.on('resize', onResize)

  const choice = await new Promise<'yes' | 'no'>((resolve) => {
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        process.stdin.off('keypress', onKey); resolve('no'); return
      }
      if (key.name === 'left'  || key.name === 'up')   { sel = 0; renderChoice(); return }
      if (key.name === 'right' || key.name === 'down')  { sel = 1; renderChoice(); return }
      if (key.name === 'return' || key.name === 'enter') {
        process.stdin.off('keypress', onKey); resolve(sel === 0 ? 'yes' : 'no')
      }
    }
    process.stdin.on('keypress', onKey)
  })

  clearInterval(timer)
  process.stdout.off('resize', onResize)
  process.stdin.removeAllListeners('keypress')

  if (choice === 'no') {
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write(`${SHOW}${ALT_OFF}`)
    return 'skipped'
  }

  // ── install phase ─────────────────────────────────────────────────────────────
  let done    = 0
  let current = (COPY[locale] ?? COPY['en']).preparing
  let pfi     = 0

  const renderProgress = () => {
    layout = buildLayout(locale)
    renderScreen(buildProgressLines(pfi, done, 22, current, locale, layout), layout)
  }

  renderProgress()
  const progressTimer = setInterval(() => { pfi++; renderProgress() }, 120)

  const onResizeProgress = () => { layout = buildLayout(locale); renderProgress() }
  process.stdout.on('resize', onResizeProgress)

  const success = await new Promise<boolean>((resolve) => {
    const child = spawn('npm', ['install', '--prefix', MCP_PACKAGES, '--no-audit', '--no-fund'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onData = (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (!line) return
      const addedMatch = line.match(/added (\d+) packages/i)
      if (addedMatch) { done = Math.min(parseInt(addedMatch[1] ?? '0', 10), 22); return }
      const pkgMatch = line.match(/added (.+?)@\d/)
      if (pkgMatch?.[1]) current = pkgMatch[1]
      else if (line.length > 2 && line.length < 50) current = line
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('close', (code) => resolve(code === 0))
  })

  clearInterval(progressTimer)
  process.stdout.off('resize', onResizeProgress)

  // ── done screen ───────────────────────────────────────────────────────────────
  layout = buildLayout(locale)
  renderScreen(buildDoneLines(success, locale, layout), layout)

  const onResizeDone = () => {
    layout = buildLayout(locale)
    renderScreen(buildDoneLines(success, locale, layout), layout)
  }
  process.stdout.on('resize', onResizeDone)

  await new Promise<void>((resolve) => {
    const onAny = () => { process.stdin.off('keypress', onAny); resolve() }
    process.stdin.on('keypress', onAny)
  })

  process.stdout.off('resize', onResizeDone)
  process.stdin.removeAllListeners('keypress')
  process.stdin.setRawMode(false)
  process.stdin.pause()
  process.stdout.write(`${SHOW}${ALT_OFF}`)
  return success ? 'installed' : 'skipped'
}
