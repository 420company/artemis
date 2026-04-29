import { emitKeypressEvents } from 'node:readline'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringWidth } from '../input/stringWidth.js'
import type { UiLocale } from './locale.js'

const ESC     = '\x1b'
const ALT_ON  = `${ESC}[?1049h${ESC}[H${ESC}[2J`
const ALT_OFF = `${ESC}[?1049l`
const HIDE    = `${ESC}[?25l`
const SHOW    = `${ESC}[?25h`

const CLI_ROOT          = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLED_MCP_DIR   = path.join(CLI_ROOT, 'mcp-packages')
// Install MCP deps into a user-data directory so they survive `npm install -g` reinstalls
// of artemis-code (which would otherwise wipe out the bundled mcp-packages/node_modules).
export const MCP_INSTALL_DIR = path.join(homedir(), '.artemis', 'mcp-packages')

function ensureMcpInstallDir(): void {
  if (!existsSync(MCP_INSTALL_DIR)) {
    mkdirSync(MCP_INSTALL_DIR, { recursive: true })
  }
  const targetPkg = path.join(MCP_INSTALL_DIR, 'package.json')
  const sourcePkg = path.join(BUNDLED_MCP_DIR, 'package.json')
  if (!existsSync(targetPkg) && existsSync(sourcePkg)) {
    copyFileSync(sourcePkg, targetPkg)
  }
}

// ─── colour helpers ────────────────────────────────────────────────────────────

function rgb(t: string, r: number, g: number, b: number, bold = false): string {
  if (!process.stdout.isTTY) return t
  return `${ESC}[${bold ? '1;' : ''}38;2;${r};${g};${b}m${t}${ESC}[0m`
}
function cyan(t: string)   { return process.stdout.isTTY ? `${ESC}[36m${t}${ESC}[0m` : t }
function dim(t: string)    { return process.stdout.isTTY ? `${ESC}[2m${t}${ESC}[0m`  : t }
function invert(t: string) { return process.stdout.isTTY ? `${ESC}[7m${t}${ESC}[0m`  : t }
function bold(t: string)   { return process.stdout.isTTY ? `${ESC}[1m${t}${ESC}[0m`  : t }

function stripAnsi(t: string) {
  // eslint-disable-next-line no-control-regex
  return t.replace(/\x1b\[[0-9;]*m/g, '')
}
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
    [96, 214, 255], [128, 197, 255], [181, 160, 255], [255, 143, 214], [255, 195, 113],
  ]
  return [...text]
    .map((ch, i) => ch === ' ' ? ch : (([r, g, b]) => rgb(ch, r, g, b, true))(pal[(i + offset) % pal.length]!))
    .join('')
}
function rainbow(text: string, offset: number): string {
  const pal: [number, number, number][] = [
    [255, 82, 195], [255, 120, 155], [250, 179, 135], [249, 226, 175],
    [166, 227, 161], [148, 226, 213], [137, 180, 250], [148, 82, 255],
  ]
  return [...text]
    .map((ch, i) => (([r, g, b]) => rgb(ch, r, g, b, true))(pal[(i + offset) % pal.length]!))
    .join('')
}

// ─── cat frames: 🌙 fixed upper-left, 𓃠 centred, stars breathe ───────────────
// IMPORTANT: prefix before 🌙 is identical in all frames (' ✦  ' = 4 cols)
// so the moon never moves. Only the surrounding stars change.

const CAT_FRAMES = [
  { // bright — inhale
    haloTop:  ' ✦  🌙  ✦  ·  ✦  ·  ✦  ·  ✦ ',
    innerTop: '  ·    ✦     ·    ✦  ·   ✦   ',
    innerBot: '  ✦  ·    ✦     ·   ✦    ·   ',
    haloBot:  ' ·  ✦  ·   ✦  ·  ✦  ·   ✦  ·',
    offset: 0,
  },
  { // medium
    haloTop:  ' ✦  🌙  ·  ✦  ·  ✦  ·  ✦  · ',
    innerTop: '  ✦    ·     ✦    ·  ✦   ·    ',
    innerBot: '  ·  ✦    ·     ✦   ·    ✦   ',
    haloBot:  ' ✦  ·  ✦   ·  ✦  ·  ✦  ·   ✦',
    offset: 3,
  },
  { // soft — exhale
    haloTop:  ' ✦  🌙  ˚  ·  ˚  ·  ˚  ·  ˚ ',
    innerTop: '  ·    ˚     ·    ˚  ·   ˚    ',
    innerBot: '  ˚  ·    ˚     ·   ˚    ·    ',
    haloBot:  ' ·  ˚  ·   ˚  ·  ˚  ·   ˚  · ',
    offset: 6,
  },
]
// Cat scene row is static — no animation, always centred
const CAT_SCENE = '✦  ·   ✦   𓃠   ✦   ·  ✦  ·  '

// ─── copy ──────────────────────────────────────────────────────────────────────

const COPY = {
  'zh-CN': {
    title:    '✦ MCP 插件依赖安装 ✦',
    subtitle: 'Artemis 内置 90 个 MCP 服务插件',
    desc1:    '其中 22 个插件需要安装 npm 依赖包',
    desc2:    '约 360 个包，安装后约 1.4 GB，需要 2-5 分钟',
    desc3:    '请确保网络通畅，也可以跳过稍后再安装',
    yes:      '✦ 立即安装全部依赖',
    no:       '跳过，稍后再说 ✦',
    footer:   '← → 选择   Enter 确认',
    brand:    'www.420.company',
    installing: '◆ 正在安装 MCP 依赖 ◆',
    wait:     '请稍候，安装完成后自动继续…',
    preparing: '连接中…',
    pkgCount: (d: number, t?: number) => t ? `已安装 ${d} / ${t} 个包` : `已安装 ${d} 个包`,
    doneOk:   '✓ 所有 MCP 依赖安装完成！',
    doneFail: '⚠ 部分包安装失败，可用 /mcp install 重试',
    anyKey:   '按任意键继续…',
    mcpHint:  '使用 /mcp enable <id> 启用任意插件',
  },
  'en': {
    title:    '✦ MCP Plugin Setup ✦',
    subtitle: 'Artemis ships with 90 MCP plugin servers',
    desc1:    '22 of them require npm package dependencies',
    desc2:    '~360 packages, ~1.4 GB installed, takes 2–5 minutes',
    desc3:    'You can skip and install later when needed',
    yes:      '✦ Install all now',
    no:       'Skip for now ✦',
    footer:   '← → select   Enter confirm',
    brand:    'www.420.company',
    installing: '◆ Installing MCP Dependencies ◆',
    wait:     'Please wait, auto-continues when done…',
    preparing: 'Connecting…',
    pkgCount: (d: number, t?: number) => t ? `${d} / ${t} packages installed` : `${d} packages installed`,
    doneOk:   '✓ All MCP dependencies installed!',
    doneFail: '⚠ Some packages failed — run /mcp install to retry',
    anyKey:   'Press any key to continue…',
    mcpHint:  'Use /mcp enable <id> to activate any plugin',
  },
}

// ─── layout ────────────────────────────────────────────────────────────────────

type Layout = { innerWidth: number; leftPad: string; top: string; bottom: string; blank: string }

function buildLayout(locale: UiLocale): Layout {
  const t = COPY[locale] ?? COPY['en']
  const probeLines = [
    t.title, t.subtitle, t.desc1, t.desc2, t.desc3,
    CAT_FRAMES[0]!.haloTop, CAT_FRAMES[0]!.haloBot, CAT_SCENE,
    ` ${t.yes}    /    ${t.no} `,
    t.footer, t.brand,
  ]
  const innerWidth = probeLines.reduce((m, l) => Math.max(m, stringWidth(l)), 0) + 6
  const cols    = process.stdout.columns ?? 80
  const leftPad = ' '.repeat(Math.max(0, Math.floor((cols - innerWidth - 4) / 2)))
  return {
    innerWidth,
    leftPad,
    top:    `${leftPad}${cyan('╔')}${cyan('═'.repeat(innerWidth))}${cyan('╗')}`,
    bottom: `${leftPad}${cyan('╚')}${cyan('═'.repeat(innerWidth))}${cyan('╝')}`,
    blank:  `${leftPad}${cyan('║')}${' '.repeat(innerWidth)}${cyan('║')}`,
  }
}

function row(line: string, layout: Layout): string {
  return `${layout.leftPad}${cyan('║')}${padAnsiEnd(center(line, layout.innerWidth), layout.innerWidth)}${cyan('║')}`
}

// ─── fixed body height — keeps cursor updates stable, no scrolling ─────────────

const BODY_H = 20  // same for all phases; shorter phases pad with blanks

// ─── workspaceTrust-style render: draw frame once, update body in-place ─────────

function initScreen(layout: Layout): void {
  const lines = [
    '',
    layout.top,
    ...Array.from({ length: BODY_H }, () => layout.blank),
    layout.bottom,
    '',
  ]
  process.stdout.write(`${ALT_ON}${HIDE}`)
  process.stdout.write(lines.join('\n'))
}

function updateBody(lines: string[], layout: Layout): void {
  // Pad or trim to exactly BODY_H so we always overwrite the full body
  const padded = lines.slice(0, BODY_H)
  while (padded.length < BODY_H) padded.push(layout.blank)
  const out = padded.map((l, i) => `${ESC}[${i + 3};1H${l}`)
  process.stdout.write(out.join(''))
}

function rebuildScreen(lines: string[], layout: Layout): void {
  // Full redraw on resize
  const frame = [
    '',
    layout.top,
    ...lines.slice(0, BODY_H),
    ...Array.from({ length: Math.max(0, BODY_H - lines.length) }, () => layout.blank),
    layout.bottom,
    '',
  ]
  process.stdout.write(`${ESC}[H${ESC}[2J`)
  process.stdout.write(frame.join('\n'))
}

// ─── choice screen body ────────────────────────────────────────────────────────

function choiceBody(fi: number, sel: number, locale: UiLocale, layout: Layout): string[] {
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
    row(aurora(t.title, fi * 3), layout),
    row(dim(t.subtitle), layout),
    layout.blank,
    row(rainbow(fr.haloTop, fi), layout),
    row(dim(fr.innerTop), layout),
    row(rgb(CAT_SCENE, cr, cg, cb, true), layout),
    row(dim(fr.innerBot), layout),
    row(rainbow(fr.haloBot, fi), layout),
    layout.blank,
    row(rgb(t.desc1, 137, 180, 250), layout),
    row(rgb(t.desc2, 249, 226, 175, true), layout),
    row(dim(t.desc3), layout),
    layout.blank,
    row(options, layout),
    layout.blank,
    row(dim(t.footer), layout),
    layout.blank,
    row(dim(t.brand), layout),
  ]
}

// ─── progress screen body ──────────────────────────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function progressBody(fi: number, done: number, total: number | undefined, current: string, locale: UiLocale, layout: Layout): string[] {
  const t    = COPY[locale] ?? COPY['en']
  const pct  = typeof total === 'number' && total > 0
    ? Math.min(100, Math.floor((done / total) * 100))
    : 0
  const barW = Math.max(20, layout.innerWidth - 14)
  const fill = Math.round((pct / 100) * barW)
  const bar  = rgb('█'.repeat(fill), 166, 227, 161) + dim('░'.repeat(barW - fill))
  const spin = SPINNER[fi % SPINNER.length]!

  return [
    layout.blank,
    row(aurora(t.installing, fi * 3), layout),
    layout.blank,
    row(`${bar}  ${rgb(String(pct) + '%', 249, 226, 175, true)}`, layout),
    layout.blank,
    row(`${cyan(spin)}  ${dim(current.slice(0, layout.innerWidth - 6))}`, layout),
    layout.blank,
    row(dim(t.pkgCount(done)), layout),
    layout.blank,
    layout.blank,
    row(dim(t.wait), layout),
  ]
}

// ─── done screen body ──────────────────────────────────────────────────────────

function doneBody(success: boolean, locale: UiLocale, layout: Layout, finalCount?: number): string[] {
  const t = COPY[locale] ?? COPY['en']
  const countLine = finalCount != null ? dim(t.pkgCount(finalCount, finalCount)) : ''
  return [
    layout.blank,
    layout.blank,
    row(success ? rgb(bold(t.doneOk), 166, 227, 161) : rgb(bold(t.doneFail), 255, 120, 155), layout),
    layout.blank,
    ...(countLine ? [row(countLine, layout), layout.blank] : []),
    row(dim(success ? t.mcpHint : t.doneFail), layout),
    layout.blank,
    layout.blank,
    row(dim(t.anyKey), layout),
  ]
}

function countNodeModulesEntries(dir: string): number {
  try {
    return readdirSync(dir).filter(d => !d.startsWith('.')).length
  } catch {
    return 0
  }
}

function countExpectedVisiblePackageEntries(lockPath: string): number | undefined {
  if (!existsSync(lockPath)) return undefined
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages?: Record<string, { optional?: boolean; peer?: boolean }>
    }
    const packages = lock.packages && typeof lock.packages === 'object'
      ? lock.packages
      : undefined
    if (!packages) return undefined

    const visibleDirs = new Set<string>()
    for (const packagePath of Object.keys(packages)) {
      if (!packagePath.startsWith('node_modules/')) continue
      const rest = packagePath.slice('node_modules/'.length)
      if (!rest || rest.includes('/node_modules/')) continue
      visibleDirs.add(rest.startsWith('@') ? rest.split('/')[0]! : rest.split('/')[0]!)
    }
    return visibleDirs.size > 0 ? visibleDirs.size : undefined
  } catch {
    return undefined
  }
}

// ─── public API ────────────────────────────────────────────────────────────────

export function shouldShowMcpInstallDialog(): boolean {
  return !existsSync(path.join(MCP_INSTALL_DIR, 'node_modules'))
}

export async function runMcpInstallDialog(locale: UiLocale): Promise<'installed' | 'skipped'> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'skipped'

  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  let sel = 0
  let fi  = 0
  let layout = buildLayout(locale)

  initScreen(layout)
  updateBody(choiceBody(fi, sel, locale, layout), layout)

  const renderChoice = () => updateBody(choiceBody(fi, sel, locale, layout), layout)
  const onResize = () => { layout = buildLayout(locale); rebuildScreen(choiceBody(fi, sel, locale, layout), layout) }
  process.stdout.on('resize', onResize)

  const timer = setInterval(() => { fi++; renderChoice() }, 350)

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

  ensureMcpInstallDir()
  // Count installed packages by watching node_modules directory
  const nmDir = path.join(MCP_INSTALL_DIR, 'node_modules')
  const countInstalled = (): number => countNodeModulesEntries(nmDir)
  const getEstimatedTotal = (): number | undefined => {
    const lockTotal =
      countExpectedVisiblePackageEntries(path.join(MCP_INSTALL_DIR, 'package-lock.json')) ??
      countExpectedVisiblePackageEntries(path.join(BUNDLED_MCP_DIR, 'package-lock.json'))
    return lockTotal && lockTotal >= done ? lockTotal : undefined
  }

  const renderProgress = () => {
    layout = buildLayout(locale)
    updateBody(progressBody(pfi, done, getEstimatedTotal(), current, locale, layout), layout)
  }

  const onResizeProgress = () => {
    layout = buildLayout(locale)
    rebuildScreen(progressBody(pfi, done, getEstimatedTotal(), current, locale, layout), layout)
  }
  process.stdout.on('resize', onResizeProgress)

  renderProgress()
  const progressTimer = setInterval(() => {
    pfi++
    done = countInstalled()
    renderProgress()
  }, 300)

  const success = await new Promise<boolean>((resolve) => {
    const child = spawn('npm', ['install', '--prefix', MCP_INSTALL_DIR, '--no-audit', '--no-fund'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onData = (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (!line || line.length < 3) return
      const pkgMatch = line.match(/added (.+?)@\d/)
      if (pkgMatch?.[1]) { current = pkgMatch[1]; return }
      if (line.length < 50) current = line
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('close', (code) => resolve(code === 0))
  })

  clearInterval(progressTimer)
  process.stdout.off('resize', onResizeProgress)
  const finalCount = countInstalled()

  // ── done screen ───────────────────────────────────────────────────────────────
  layout = buildLayout(locale)
  updateBody(doneBody(success, locale, layout, finalCount), layout)

  const onResizeDone = () => {
    layout = buildLayout(locale)
    rebuildScreen(doneBody(success, locale, layout, finalCount), layout)
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
