/**
 * cli/branding.ts — Artemis splash screen & branding
 *
 * Clean terminal-first layout:
 *   • Gradient ASCII art logo — no border box
 *   • Centered publisher + version tag below logo
 *   • System info block (model, workspace, permissions, tools)
 *   • Numbered tips section
 *   • Single-line status bar
 */

import type { UiLocale } from './locale.js'
import { pickLocale } from './locale.js'
import { stringWidth } from '../input/stringWidth.js'
import { getDirectToolCount } from '../tools/directTools.js'
import { APP_NAME, APP_PUBLISHER, APP_VERSION } from '../appMeta.js'
export { APP_NAME, APP_PUBLISHER, APP_VERSION } from '../appMeta.js'

// ─── constants ────────────────────────────────────────────────────────────────

export const DUAL_MODEL_COMMAND      = 'bifrost'
export const WHOSYOURDADDY_FLAG      = '--whosyourdaddy'
export const WHOSYOURDADDY_MIN_TURNS = 16

const DEFAULT_DIRECT_TOOL_COUNT = getDirectToolCount()

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const ESC = '\x1b'
const R   = `${ESC}[0m`

function isTTY(): boolean { return process.stdout.isTTY === true }

function rgb(r: number, g: number, b: number, text: string): string {
  return isTTY() ? `${ESC}[38;2;${r};${g};${b}m${text}${R}` : text
}
function bold(text: string): string  { return isTTY() ? `${ESC}[1m${text}${R}` : text }
function dim(text: string): string   { return isTTY() ? `${ESC}[2m${text}${R}` : text }

function centerPad(text: string, width: number): string {
  // text may contain ANSI codes — strip them to measure visual length
  // eslint-disable-next-line no-control-regex
  const visLen = text.replace(/\x1b\[[0-9;]*m/g, '').length
  const pad    = Math.max(0, Math.floor((width - visLen) / 2))
  return ' '.repeat(pad) + text
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function padVisibleEnd(text: string, width: number): string {
  const visible = stringWidth(stripAnsi(text))
  return visible >= width ? text : text + ' '.repeat(width - visible)
}

function truncateVisibleEnd(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth === 1) return '…'

  let out = ''
  let width = 0
  for (const char of text) {
    const nextWidth = width + stringWidth(char)
    if (nextWidth > maxWidth - 1) break
    out += char
    width = nextWidth
  }
  return `${out}…`
}

function truncateVisibleMiddle(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 3) return truncateVisibleEnd(text, maxWidth)

  const chars = Array.from(text)
  let left = ''
  let right = ''
  let leftWidth = 0
  let rightWidth = 0
  let leftIdx = 0
  let rightIdx = chars.length - 1
  const budget = maxWidth - 1

  while (leftIdx <= rightIdx) {
    if (leftWidth <= rightWidth) {
      const ch = chars[leftIdx]!
      const w = stringWidth(ch)
      if (leftWidth + rightWidth + w > budget) break
      left += ch
      leftWidth += w
      leftIdx++
    } else {
      const ch = chars[rightIdx]!
      const w = stringWidth(ch)
      if (leftWidth + rightWidth + w > budget) break
      right = ch + right
      rightWidth += w
      rightIdx--
    }
  }

  return `${left}…${right}`
}

function shortenDisplayPath(cwd: string): string {
  const home = process.env.HOME ?? ''
  const shortened = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
  return shortened === '~' ? cwd : shortened
}

// ─── Gradient engine ──────────────────────────────────────────────────────────

const GRADIENT_STOPS: [number, number, number][] = [
  [ 82, 196, 255],  // sky cyan
  [100, 130, 255],  // periwinkle
  [148,  82, 255],  // violet
  [210,  72, 255],  // purple-pink
  [255,  82, 195],  // hot pink
  [255, 120, 155],  // rose
]

function lerpColor(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t))
  const scaled  = clamped * (GRADIENT_STOPS.length - 1)
  const lo = Math.floor(scaled)
  const hi = Math.min(GRADIENT_STOPS.length - 1, lo + 1)
  const frac = scaled - lo
  const a = GRADIENT_STOPS[lo]!
  const b = GRADIENT_STOPS[hi]!
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ]
}

// ─── Breathing effect engine ──────────────────────────────────────────────────

let breathePhase = 0
const BREATHE_SPEED = 0.002  // Very slow breathing

function updateBreathePhase(): void {
  breathePhase = (breathePhase + BREATHE_SPEED) % 1
}

function breatheColor(original: [number, number, number]): [number, number, number] {
  const intensity = 0.95 + 0.05 * Math.sin(breathePhase * Math.PI * 2)
  return [
    Math.round(original[0] * intensity),
    Math.round(original[1] * intensity),
    Math.round(original[2] * intensity)
  ]
}

// ─── ASCII art logo — ANSI Shadow, "ARTEMIS" ─────────────────────────────────

const LOGO_LINES = [
  '█████╗  ██████╗ ████████╗███████╗███╗   ███╗██╗███████╗',
  '██╔══██╗██╔══██╗╚══██╔══╝██╔════╝████╗ ████║██║██╔════╝',
  '███████║██████╔╝   ██║   █████╗  ██╔████╔██║██║███████╗',
  '██╔══██║██╔══██╗   ██║   ██╔══╝  ██║╚██╔╝██║██║╚════██║',
  '██║  ██║██║  ██║   ██║   ███████╗██║ ╚═╝ ██║██║███████║',
  '╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝     ╚═╝╚═╝╚══════╝',
]

const LOGO_WIDTH = Math.max(...LOGO_LINES.map(l => l.length))  // 64 chars

function gradientLine(line: string): string {
  if (!isTTY()) return line
  const len = line.length
  if (len === 0) return ''
  let out = ''
  for (let i = 0; i < len; i++) {
    const ch = line[i]!
    if (ch === ' ') { out += ch; continue }
    const [r, g, b] = breatheColor(lerpColor(i / Math.max(1, len - 1)))
    out += `${ESC}[1;38;2;${r};${g};${b}m${ch}${R}`
  }
  return out
}

// ─── Logo section — gradient lines + tagline (domain centered, version right) ─

function buildLogoSection(): string {
  updateBreathePhase()  // Update breathing phase for each render
  const gradientRows = LOGO_LINES.map(line => gradientLine(line))
  const version = dim(`v${APP_VERSION}`)
  const tagLine = APP_PUBLISHER
    ? (() => {
        const domain = APP_PUBLISHER
        const domainPad = Math.max(0, Math.floor((LOGO_WIDTH - domain.length) / 2))
        const spacer = Math.max(1, LOGO_WIDTH - domainPad - domain.length - stripAnsi(version).length)
        return (
          ' '.repeat(domainPad) +
          rgb(148, 82, 255, domain) +
          ' '.repeat(spacer) +
          version
        )
      })()
    : centerPad(version, LOGO_WIDTH)

  return [
    '',
    ...gradientRows,
    tagLine,  // Remove extra blank line between logo and tagline
  ].join('\n')
}

// ─── System info block ────────────────────────────────────────────────────────

interface SystemInfoOpts {
  locale: UiLocale
  executionModel: string
  brainModel?: string
  cwd: string
  permissionMode: string
  toolCount?: number
  skillCount?: number
  mcpCount?: number
  cols?: number
  bridges?: string[]  // active bridge platform names e.g. ['Telegram', 'WeChat']
}

function buildSystemInfo(opts: SystemInfoOpts): string {
  const { locale, executionModel, brainModel, cwd, permissionMode, toolCount, skillCount, mcpCount, cols, bridges } = opts
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  const shortCwd = shortenDisplayPath(cwd)

  const dot   = rgb(100, 100, 120, '  ✦ ')
  const val   = (s: string, r: number, g: number, b: number) => rgb(r, g, b, bold(s))

  const rows: string[] = []
  const labels = [
    t('思维模型', 'brain'),
    t('执行模型', 'exec'),
    t('工作区', 'workspace'),
    t('权限模式', 'permission'),
    t('工具', 'tools'),
    t('桥接', 'bridges'),
  ]
  const labelWidth = Math.max(13, ...labels.map(label => stringWidth(label)))
  const lineBudget = Math.max(56, Math.min(cols ?? 96, 112))
  const valueWidthLimit = Math.max(18, lineBudget - labelWidth - 18)
  const modelValueWidth = Math.max(
    16,
    Math.min(
      Math.min(24, valueWidthLimit),
      Math.max(
        stringWidth(executionModel),
        stringWidth(brainModel ?? t('未配置', 'Not configured')),
        stringWidth(permissionMode),
      ),
    ),
  )

  function infoRow(
    labelText: string,
    valueText: string,
    valueTone: [number, number, number],
    suffix?: string,
    valueMaxWidth: number = modelValueWidth,
  ): string {
    const shortenedValue = truncateVisibleMiddle(valueText, valueMaxWidth)
    const labelCell = padVisibleEnd(dim(labelText), labelWidth)
    const valueCell = suffix
      ? padVisibleEnd(val(shortenedValue, valueTone[0], valueTone[1], valueTone[2]), valueMaxWidth)
      : val(shortenedValue, valueTone[0], valueTone[1], valueTone[2])
    return `${dot}${labelCell}  ${valueCell}${suffix ? `  ${dim(suffix)}` : ''}`
  }

  // 在第一行显示双模型状态
  const dualModeActive = !!brainModel
  rows.push(infoRow(
    t('双模型模式', 'Dual-model mode'), 
    dualModeActive ? t('开启', 'Enabled') : t('关闭', 'Disabled'), 
    dualModeActive ? [137, 180, 250] : [166, 227, 161],
    dualModeActive ? t('运行 /bifrost 关闭', 'Run /bifrost to disable') : t('运行 /bifrost 开启', 'Run /bifrost to enable')
  ))

  // Always show both brain / exec slots
  const hasBrain = brainModel && brainModel !== executionModel
  if (hasBrain) {
    rows.push(infoRow(t('思维模型', 'brain'), brainModel!, [203, 166, 247], t('思维层', 'planning')))
    rows.push(infoRow(t('执行模型', 'exec'), executionModel, [137, 180, 250], t('执行层', 'execution')))
  } else {
    rows.push(infoRow(t('执行模型', 'exec model'), executionModel, [137, 180, 250]))
    rows.push(
      `${dot}${padVisibleEnd(dim(t('思维模型', 'brain')), labelWidth)}  ` +
      `${padVisibleEnd(dim(t('未配置', 'Not configured')), modelValueWidth)}  ` +
      `${dim(`─ ${t('运行 /bifrost 开启思维/执行双模型', 'Run /bifrost to enable dual-model mode')}`)}`
    )
  }

  rows.push(infoRow(t('工作区', 'workspace'), shortCwd, [166, 227, 161], undefined, Math.max(22, valueWidthLimit)))

  const modeColor: Record<string, [number,number,number]> = {
    'accept-all':   [250, 179, 135],
    'accept-edits': [249, 226, 175],
    'read-only':    [166, 227, 161],
    'prompt':       [203, 166, 247],
  }
  const [mr, mg, mb] = modeColor[permissionMode] ?? [200, 200, 200]
  rows.push(infoRow(t('权限模式', 'permission'), permissionMode, [mr, mg, mb]))

  const tCount = toolCount ?? DEFAULT_DIRECT_TOOL_COUNT
  const sCount = skillCount ?? 0
  const mCount = mcpCount  ?? 0
  const toolLabels = [`${tCount} tools`, `${sCount} skills`, `${mCount} MCP`]
  const bridgeLabels = bridges ?? []
  const metricColumnWidths = toolLabels.map((label, index) =>
    Math.max(stringWidth(label), stringWidth(bridgeLabels[index] ?? '')),
  )
  const caps = [
    padVisibleEnd(val(toolLabels[0]!, 137, 180, 250), metricColumnWidths[0]!),
    padVisibleEnd(sCount > 0 ? val(toolLabels[1]!, 203, 166, 247) : dim(toolLabels[1]!), metricColumnWidths[1]!),
    padVisibleEnd(mCount > 0 ? val(toolLabels[2]!, 148, 226, 213) : dim(toolLabels[2]!), metricColumnWidths[2]!),
  ].join(dim('  ·  '))
  rows.push(`${dot}${padVisibleEnd(dim(t('工具', 'tools')), labelWidth)}  ${caps}`)

  // Bridges row — only shown when at least one bridge is active
  if (bridges && bridges.length > 0) {
    const bridgeParts = bridges.map((name, index) =>
      padVisibleEnd(val(name, 148, 226, 213), metricColumnWidths[index] ?? stringWidth(name)),
    )
    rows.push(`${dot}${padVisibleEnd(dim(t('桥接', 'bridges')), labelWidth)}  ${bridgeParts.join(dim('  ·  '))}`)
  }

  return rows.join('\n')
}

// ─── Tips section ─────────────────────────────────────────────────────────────

function buildHeroFooter(locale: UiLocale, providerMissing?: boolean): string {
  const t     = (zh: string, en: string) => pickLocale(locale, { zh, en })
  const cmd   = (s: string) => rgb(148, 82, 255, bold(s))
  const sec   = (s: string) => rgb(245, 196, 94, bold(s))
  // 随机颜色生成函数
  const randomColor = (): [number, number, number] => {
    return [
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256), 
      Math.floor(Math.random() * 256)
    ]
  }
  
  const arrowColor = randomColor()
  const arrow = rgb(arrowColor[0], arrowColor[1], arrowColor[2], bold('(⌐■-■)'))
  const hint  = rgb(166, 227, 161, t('Have a nice trip', 'Have a nice trip'))
  const sub   = dim(t('  · / 浏览命令', '  · / browse commands'))

  // Compact one-line categories so the full hero (logo width ≈ 64) still fits
  // the user's terminal. Descriptions are reachable via /help; here we only
  // need to surface the entry points.
  const workflows = ['/niko', '/athena', '/nidhogg', '/design', '/contest', '/run']
  const settings  = ['/bifrost', '/config', '/permission', '/newborn']
  const sep = dim(' ')
  const workflowLine = workflows.map(cmd).join(sep)
  const settingsLine = settings.map(cmd).join(sep)

  if (providerMissing) {
    return [
      '',
      `  ${sec(`✦ ${t('设置', 'Setup')}`)} ${settingsLine}`,
      '',
      `  ${rgb(255, 120, 155, t('⚠ 未检测到可用 Provider，请先运行', '⚠ No usable provider detected. Run'))} ${cmd('/config')}`,
    ].join('\n')
  }

  return [
    '',
    `  ${sec(`✦ ${t('工作流', 'Workflows')}`)} ${workflowLine}`,
    `  ${sec(`✦ ${t('设置', 'Setup    ')}`)} ${settingsLine}`,
    '',
    `  ${arrow}  ${bold(hint)}${sub}`,
  ].join('\n')
}

function buildCompactTips(locale: UiLocale): string[] {
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  const cmd = (s: string) => rgb(148, 82, 255, bold(s))
  const star = rgb(245, 196, 94, '  ✦')
  const arrow = rgb(82, 196, 255, bold('  ▶'))
  return [
    `${star} ${t('工作流', 'Workflows')}: ${cmd('/niko')} ${cmd('/athena')} ${cmd('/nidhogg')} ${cmd('/design')} ${cmd('/contest')} ${cmd('/run')}`,
    `${star} ${t('设置', 'Setup')}: ${cmd('/bifrost')} ${cmd('/config')} ${cmd('/permission')} ${cmd('/newborn')}`,
    '',
    `${arrow} ${bold(rgb(166, 227, 161, t('直接输入文字开始对话', 'Have a nice trip')))} ${dim(t('· / 浏览命令', '· / browse commands'))}`,
  ]
}

export interface InteractiveCompactHeroOptions extends InteractiveHeroOptions {
  providerMissing?: boolean
}

export function buildInteractiveCompactHero(options: InteractiveCompactHeroOptions): string {
  const {
    locale,
    executionModel,
    brainModel,
    cwd,
    permissionMode,
    toolCount,
    skillCount,
    mcpCount,
    bridges,
    providerMissing,
  } = options
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  const shortCwd = shortenDisplayPath(cwd)
  const labels = [
    t('执行', 'Exec'),
    t('思维', 'Brain'),
    t('工作区', 'Workspace'),
    t('权限', 'Mode'),
    'T/S/M',
    t('桥接', 'Bridges'),
  ]
  const labelWidth = Math.max(...labels.map(label => stringWidth(label)))
  const bullet = rgb(100, 100, 120, '  ✦')
  const compactValueWidth = Math.max(
    20,
    Math.min(36, Math.max(
      stringWidth(executionModel),
      stringWidth(brainModel ?? t('未配置', 'Not configured')),
      stringWidth(shortCwd),
      stringWidth(permissionMode),
    )),
  )
  const row = (label: string, value: string): string =>
    `${bullet} ${padVisibleEnd(dim(label), labelWidth)} ${truncateVisibleMiddle(value, compactValueWidth)}`

  const title = `${rgb(82, 196, 255, APP_NAME)} ${dim(`v${APP_VERSION}`)} ${rgb(148, 82, 255, APP_PUBLISHER)}`
  const bodyRows = [
    row(t('执行', 'Exec'), executionModel),
    row(t('思维', 'Brain'), brainModel ?? t('未配置', 'Not configured')),
    row(t('工作区', 'Workspace'), shortCwd),
    row(t('权限', 'Mode'), permissionMode),
    row('T/S/M', `${toolCount ?? DEFAULT_DIRECT_TOOL_COUNT} / ${skillCount ?? 0} / ${mcpCount ?? 0}`),
  ]
  if (bridges && bridges.length > 0) {
    bodyRows.push(row(t('桥接', 'Bridges'), bridges.join(' · ')))
  }
  const ruleWidth = Math.max(
    42,
    Math.min(72, ...bodyRows.map(line => stringWidth(stripAnsi(line)) - 2)),
  )
  const rule = dim('  ' + '─'.repeat(ruleWidth))
  const rows = [
    '',
    `  ${bold(title)}`,
    rule,
    ...bodyRows,
  ]

  rows.push(rule)
  if (providerMissing) {
    rows.push(`  ${rgb(255, 120, 155, t('未检测到可用 Provider，请先 /config', 'No usable provider. Run /config first.'))}`)
  }
  rows.push(...buildCompactTips(locale))
  rows.push('')
  return rows.join('\n')
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getBrandingHeading(suffix?: string): string {
  return suffix ? `${APP_NAME} ${APP_VERSION} ${suffix}` : `${APP_NAME} ${APP_VERSION}`
}

export function getBrandingAttribution(): string {
  return `Modified and published by ${APP_PUBLISHER}`
}

export function getVersionText(): string {
  return [getBrandingHeading(), getBrandingAttribution()].join('\n')
}

/** @deprecated Use buildInteractiveHero instead. */
export function getInteractiveSplash(): string {
  return LOGO_LINES.join('\n')
}

export interface InteractiveHeroOptions {
  locale: UiLocale
  executionModel: string
  brainModel?: string
  cwd: string
  permissionMode: string
  toolCount?: number
  skillCount?: number
  mcpCount?: number
  cols?: number
  bridges?: string[]
  providerMissing?: boolean
}

export function buildInteractiveHero(options: InteractiveHeroOptions): string {
  const { locale, executionModel, brainModel, cwd, permissionMode, toolCount, skillCount, mcpCount, cols, bridges, providerMissing } = options

  // Non-TTY: simple text fallback
  if (!isTTY()) {
    return [
      `${APP_NAME} v${APP_VERSION}  ${APP_PUBLISHER}`,
      '',
      `Model: ${executionModel}  |  ${cwd}  |  ${permissionMode}`,
    ].join('\n')
  }

  return [
    buildLogoSection(),
    '',
    buildSystemInfo({ locale, executionModel, brainModel, cwd, permissionMode, toolCount, skillCount, mcpCount, cols, bridges }),
    buildHeroFooter(locale, providerMissing),
  ].join('\n')
}
