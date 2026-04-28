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
function bold(t: string)   { return process.stdout.isTTY ? `${ESC}[1m${t}${ESC}[0m`  : t }
function green(t: string)  { return rgb(t, 166, 227, 161) }
function yellow(t: string) { return rgb(t, 249, 226, 175) }
function pink(t: string)   { return rgb(t, 255, 120, 155) }

function stripAnsi(t: string) { return t.replace(/\x1b\[[0-9;]*m/g, '') }
function visLen(t: string)    { return stringWidth(stripAnsi(t)) }
function padEnd(t: string, w: number) {
  const gap = w - visLen(t)
  return gap > 0 ? t + ' '.repeat(gap) : t
}
function center(t: string, w: number) {
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

// ─── rocket mascot (3 animation frames) ────────────────────────────────────────

const ROCKET_FRAMES = [
  {
    art: [
      '    /\\     ',
      '   /  \\    ',
      '  | 🚀 |   ',
      '   \\  /    ',
      '  ══════   ',
      '  · · ·    ',
    ],
    starsTop:    '  ✦   ·   ✦  ',
    starsBottom: '  ·   ✦   ·  ',
    trailOffset: 0,
  },
  {
    art: [
      '    /\\     ',
      '   /  \\    ',
      '  | 🚀 |   ',
      '   \\  /    ',
      '  ══════   ',
      '   · · ·   ',
    ],
    starsTop:    '   ·   ✦   · ',
    starsBottom: '   ✦   ·   ✦ ',
    trailOffset: 2,
  },
  {
    art: [
      '    /\\     ',
      '   /  \\    ',
      '  | 🚀 |   ',
      '   \\  /    ',
      '  ══════   ',
      '    · · ·  ',
    ],
    starsTop:    ' ✦   ·   ✦   ',
    starsBottom: ' ·   ✦   ·   ',
    trailOffset: 4,
  },
]

// ─── layout ────────────────────────────────────────────────────────────────────

const INNER_W  = 52
const LEFT_PAD = '  '
const box = {
  top:    `${LEFT_PAD}${cyan('╔')}${cyan('═'.repeat(INNER_W))}${cyan('╗')}`,
  bottom: `${LEFT_PAD}${cyan('╚')}${cyan('═'.repeat(INNER_W))}${cyan('╝')}`,
  blank:  `${LEFT_PAD}${cyan('║')}${' '.repeat(INNER_W)}${cyan('║')}`,
  row(t: string) {
    return `${LEFT_PAD}${cyan('║')}${padEnd(t, INNER_W)}${cyan('║')}`
  },
  centered(t: string) {
    return `${LEFT_PAD}${cyan('║')}${padEnd(center(t, INNER_W), INNER_W)}${cyan('║')}`
  },
}

// ─── choice prompt screen ───────────────────────────────────────────────────────

function buildChoiceLines(frame: number, sel: number, locale: UiLocale): string[] {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const f = ROCKET_FRAMES[frame % ROCKET_FRAMES.length]!
  const lines: string[] = []

  lines.push(box.blank)
  lines.push(box.centered(dim(f.starsTop)))
  for (const row of f.art) {
    lines.push(box.centered(rainbow(row, frame * 2 + f.trailOffset)))
  }
  lines.push(box.centered(dim(f.starsBottom)))
  lines.push(box.blank)
  lines.push(box.centered(aurora(t('◆ MCP 插件依赖安装 ◆', '◆ MCP Plugin Setup ◆'), frame * 3)))
  lines.push(box.blank)
  lines.push(box.row(`  ${dim(t('Artemis 内置 90 个 MCP 服务插件。', 'Artemis ships with 90 MCP plugin servers.'))}  `))
  lines.push(box.row(`  ${dim(t('其中 22 个需要安装 npm 依赖包。', '22 of them require npm package dependencies.'))}  `))
  lines.push(box.row(`  ${dim(t('安装大小约 200 MB，耗时 1-3 分钟。', 'About 200 MB, takes 1–3 minutes.'))}  `))
  lines.push(box.blank)
  lines.push(box.row(`  ${dim(t('也可以跳过，之后用到时系统会自动提示安装。', 'You can skip — we\'ll prompt when needed.'))}  `))
  lines.push(box.blank)

  const yesLabel = t('  立即安装全部依赖  ', '  Install all now  ')
  const noLabel  = t('  跳过，稍后再说  ', '  Skip for now  ')

  const yesBtn = sel === 0
    ? rgb(`[ ${yesLabel} ]`, 148, 226, 213, true)
    : dim(`[ ${yesLabel} ]`)
  const noBtn = sel === 1
    ? rgb(`[ ${noLabel} ]`, 255, 120, 155, true)
    : dim(`[ ${noLabel} ]`)

  lines.push(box.centered(yesBtn))
  lines.push(box.blank)
  lines.push(box.centered(noBtn))
  lines.push(box.blank)
  lines.push(box.centered(dim(t('← → 选择   Enter 确认', '← → select   Enter confirm'))))
  lines.push(box.blank)

  return lines
}

// ─── install progress screen ────────────────────────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function buildProgressLines(
  frame: number,
  done: number,
  total: number,
  current: string,
  locale: UiLocale,
): string[] {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const pct  = total > 0 ? Math.floor((done / total) * 100) : 0
  const barW = 36
  const fill = Math.round((pct / 100) * barW)
  const bar  = green('█'.repeat(fill)) + dim('░'.repeat(barW - fill))
  const spin = SPINNER[frame % SPINNER.length]!

  const lines: string[] = []
  lines.push(box.blank)
  lines.push(box.blank)
  lines.push(box.centered(aurora(t('◆ 正在安装 MCP 依赖 ◆', '◆ Installing MCP Dependencies ◆'), frame * 3)))
  lines.push(box.blank)
  lines.push(box.centered(`${bar}  ${yellow(pct + '%')}`))
  lines.push(box.blank)
  lines.push(box.centered(cyan(spin) + '  ' + dim(current.slice(0, 40))))
  lines.push(box.blank)
  lines.push(box.centered(dim(t(`已完成 ${done} / ${total} 个包`, `${done} / ${total} packages`))))
  lines.push(box.blank)
  lines.push(box.blank)
  lines.push(box.centered(dim(t('请稍候，安装完成后自动继续…', 'Please wait, auto-continues when done…'))))
  lines.push(box.blank)
  lines.push(box.blank)

  return lines
}

function buildDoneLines(success: boolean, locale: UiLocale): string[] {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const lines: string[] = []
  lines.push(box.blank)
  lines.push(box.blank)
  lines.push(box.blank)
  if (success) {
    lines.push(box.centered(green(bold(t('✓ 所有 MCP 依赖安装完成！', '✓ All MCP dependencies installed!')))))
    lines.push(box.blank)
    lines.push(box.centered(dim(t('现在可以使用 /mcp enable <id> 启用任意插件', 'Use /mcp enable <id> to activate any plugin'))))
  } else {
    lines.push(box.centered(pink(bold(t('⚠ 安装过程中出现问题', '⚠ Some packages may have failed')))))
    lines.push(box.blank)
    lines.push(box.centered(dim(t('可以之后重新运行 /mcp install 手动安装', 'Run /mcp install later to retry'))))
  }
  lines.push(box.blank)
  lines.push(box.blank)
  lines.push(box.centered(dim(t('按任意键继续…', 'Press any key to continue…'))))
  lines.push(box.blank)
  lines.push(box.blank)
  lines.push(box.blank)

  return lines
}

// ─── rendering helpers ──────────────────────────────────────────────────────────

const BODY_HEIGHT = 20

function renderFrame(lines: string[], frameIndex: number, title: string) {
  const titleLine = `\n${LEFT_PAD}${rainbow(title, frameIndex * 2)}\n`
  process.stdout.write(
    `${ESC}[1;1H${titleLine}${box.top}\n${lines.map((l) => l + '\n').join('')}${box.bottom}\n`,
  )
}

// ─── public API ─────────────────────────────────────────────────────────────────

export function shouldShowMcpInstallDialog(): boolean {
  const nodeModulesPath = path.join(MCP_PACKAGES, 'node_modules')
  return !existsSync(nodeModulesPath)
}

export async function runMcpInstallDialog(locale: UiLocale): Promise<'installed' | 'skipped'> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'skipped'

  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const title = t(
    '  🔌  Artemis · MCP 插件环境配置',
    '  🔌  Artemis · MCP Plugin Setup',
  )

  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  let sel         = 0
  let frameIndex  = 0
  const bodyLines = BODY_HEIGHT

  process.stdout.write(`${ALT_ON}${HIDE}`)
  // pre-fill blank body so cursor positioning works
  const blankBody = Array.from({ length: bodyLines + 4 }, () => box.blank + '\n').join('')
  process.stdout.write(`\n${LEFT_PAD}${title}\n${box.top}\n${blankBody}${box.bottom}\n`)

  const render = () => renderFrame(buildChoiceLines(frameIndex, sel, locale), frameIndex, title)
  render()
  const timer = setInterval(() => { frameIndex++; render() }, 200)

  const choice = await new Promise<'yes' | 'no'>((resolve) => {
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') { resolve('no'); return }
      if (key.name === 'escape')         { resolve('no'); return }
      if (key.name === 'left'  || key.name === 'up')   { sel = 0; render(); return }
      if (key.name === 'right' || key.name === 'down')  { sel = 1; render(); return }
      if (key.name === 'return' || key.name === 'enter') {
        resolve(sel === 0 ? 'yes' : 'no')
      }
    }
    process.stdin.on('keypress', onKey)
  })

  clearInterval(timer)

  if (choice === 'no') {
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write(`${SHOW}${ALT_OFF}`)
    return 'skipped'
  }

  // ── install phase ────────────────────────────────────────────────────────────
  let done    = 0
  let current = t('准备中…', 'Preparing…')
  let fi      = 0

  const renderProgress = () =>
    renderFrame(buildProgressLines(fi, done, 22, current, locale), fi, title)

  renderProgress()
  const progressTimer = setInterval(() => { fi++; renderProgress() }, 120)

  const success = await new Promise<boolean>((resolve) => {
    const child = spawn('npm', ['install', '--prefix', MCP_PACKAGES, '--no-audit', '--no-fund'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const onData = (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (!line) return
      // pick up "added X packages" or package names from npm output
      const addedMatch = line.match(/added (\d+) packages/i)
      if (addedMatch) {
        done = Math.min(parseInt(addedMatch[1] ?? '0', 10), 22)
      }
      const pkgMatch = line.match(/npm warn.*|.*resolved.*|.*reify.*|added (.+)@/)
      if (pkgMatch?.[1]) current = pkgMatch[1]
      else if (line.length < 60) current = line
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('close', (code) => resolve(code === 0))
  })

  clearInterval(progressTimer)

  // ── done screen ───────────────────────────────────────────────────────────────
  fi = 0
  const doneTimer = setInterval(() => { fi++ }, 120)
  renderFrame(buildDoneLines(success, locale), fi, title)

  await new Promise<void>((resolve) => {
    const onAny = () => {
      process.stdin.off('keypress', onAny)
      resolve()
    }
    process.stdin.on('keypress', onAny)
  })

  clearInterval(doneTimer)
  process.stdin.setRawMode(false)
  process.stdin.pause()
  process.stdout.write(`${SHOW}${ALT_OFF}`)

  return success ? 'installed' : 'skipped'
}
