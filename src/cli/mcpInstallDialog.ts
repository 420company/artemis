import { emitKeypressEvents } from 'node:readline'
import { spawn } from 'node:child_process'
import { createWriteStream, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as https from 'node:https'
import { pipeline } from 'node:stream/promises'
import { stringWidth } from '../input/stringWidth.js'
import type { UiLocale } from './locale.js'

const ESC     = '\x1b'
const ALT_ON  = `${ESC}[?1049h${ESC}[H${ESC}[2J`
const ALT_OFF = `${ESC}[?1049l`
const HIDE    = `${ESC}[?25l`
const SHOW    = `${ESC}[?25h`

const CLI_ROOT          = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLED_MCP_DIR   = path.join(CLI_ROOT, 'mcp-packages')
const WHISPER_MODEL_NAME = 'ggml-base.bin'
const WHISPER_MODEL_URL  = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
const WHISPER_MODEL_MIN_BYTES = 100 * 1024 * 1024
// Install MCP deps into a user-data directory so they survive `npm install -g` reinstalls
// of artemis-code (which would otherwise wipe out the bundled mcp-packages/node_modules).
export const MCP_INSTALL_DIR = path.join(homedir(), '.artemis', 'mcp-packages')

function whisperModelPath(cwd: string): string {
  return path.join(cwd, '.artemis', 'models', WHISPER_MODEL_NAME)
}

function hasUsableWhisperModel(cwd: string): boolean {
  try {
    return statSync(whisperModelPath(cwd)).size >= WHISPER_MODEL_MIN_BYTES
  } catch {
    return false
  }
}

function ensureMcpInstallDir(): void {
  if (!existsSync(MCP_INSTALL_DIR)) {
    mkdirSync(MCP_INSTALL_DIR, { recursive: true })
  }
  const targetPkg = path.join(MCP_INSTALL_DIR, 'package.json')
  const sourcePkg = path.join(BUNDLED_MCP_DIR, 'package.json')
  if (!existsSync(targetPkg) && existsSync(sourcePkg)) {
    copyFileSync(sourcePkg, targetPkg)
  }
  // Seed the bundled lockfile so the progress bar can show a real total
  // count from the very first frame (npm doesn't emit a usable lockfile
  // until well into the install). Only seeded if the user doesn't already
  // have one — preserves any locally-customised state.
  const targetLock = path.join(MCP_INSTALL_DIR, 'package-lock.json')
  const sourceLock = path.join(BUNDLED_MCP_DIR, 'package-lock.json')
  if (!existsSync(targetLock) && existsSync(sourceLock)) {
    copyFileSync(sourceLock, targetLock)
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
    subtitle: 'Artemis 内置 91 个 MCP 服务插件',
    desc1:    '其中 23 个插件需要安装 npm 依赖包',
    desc2:    '同时安装本地 Whisper 免费模型 ggml-base.bin（约 141 MB）',
    desc3:    '请确保网络通畅，也可以跳过稍后再安装',
    yes:      '✦ 立即安装全部依赖',
    no:       '跳过，稍后再说 ✦',
    footer:   '← → 选择   Enter 确认',
    brand:    'www.420.company',
    installing: '◆ 正在安装 MCP / 本地语音依赖 ◆',
    wait:     '请稍候，安装完成后自动继续…',
    preparing: '连接中…',
    modelPreparing: '准备本地 Whisper 模型…',
    modelReady: '本地 Whisper 模型已就绪：ggml-base.bin',
    modelProgress: (mb: number, pct?: number) => pct == null ? `下载 ggml-base.bin：${mb} MB` : `下载 ggml-base.bin：${mb} MB / ${pct}%`,
    pkgCount: (d: number, t?: number) => t ? `已安装 ${d} / ${t} 个包` : `已安装 ${d} 个包`,
    doneOk:   '✓ MCP 依赖和本地 Whisper 模型安装完成！',
    doneFail: '⚠ 部分依赖安装失败，可用 /mcp install 重试',
    anyKey:   '按任意键继续…',
    mcpHint:  '使用 /mcp enable <id> 启用任意插件',
  },
  'en': {
    title:    '✦ MCP Plugin Setup ✦',
    subtitle: 'Artemis ships with 91 MCP plugin servers',
    desc1:    '23 of them require npm package dependencies',
    desc2:    'Also installs the free local Whisper model ggml-base.bin (~141 MB)',
    desc3:    'You can skip and install later when needed',
    yes:      '✦ Install all now',
    no:       'Skip for now ✦',
    footer:   '← → select   Enter confirm',
    brand:    'www.420.company',
    installing: '◆ Installing MCP / Local Voice Dependencies ◆',
    wait:     'Please wait, auto-continues when done…',
    preparing: 'Connecting…',
    modelPreparing: 'Preparing local Whisper model…',
    modelReady: 'Local Whisper model ready: ggml-base.bin',
    modelProgress: (mb: number, pct?: number) => pct == null ? `Downloading ggml-base.bin: ${mb} MB` : `Downloading ggml-base.bin: ${mb} MB / ${pct}%`,
    pkgCount: (d: number, t?: number) => t ? `${d} / ${t} packages installed` : `${d} packages installed`,
    doneOk:   '✓ MCP dependencies and local Whisper model installed!',
    doneFail: '⚠ Some dependencies failed — run /mcp install to retry',
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

async function downloadWhisperModel(cwd: string, onStatus: (line: string) => void, locale: UiLocale): Promise<void> {
  const t = COPY[locale] ?? COPY['en']
  const target = whisperModelPath(cwd)
  if (hasUsableWhisperModel(cwd)) {
    onStatus(t.modelReady)
    return
  }

  mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.download`
  try {
    if (existsSync(tmp)) unlinkSync(tmp)
  } catch {
    // Best effort cleanup before retrying the download.
  }

  onStatus(t.modelPreparing)

  const fetchToDisk = async (url: string, redirects = 0): Promise<void> => {
    if (redirects > 5) throw new Error('Too many redirects while downloading ggml-base.bin')

    await new Promise<void>((resolve, reject) => {
      const req = https.get(url, async (res) => {
        try {
          const status = res.statusCode ?? 0
          const location = res.headers.location
          if (status >= 300 && status < 400 && location) {
            res.resume()
            const nextUrl = new URL(location, url).toString()
            try {
              await fetchToDisk(nextUrl, redirects + 1)
              resolve()
            } catch (error) {
              reject(error)
            }
            return
          }

          if (status !== 200) {
            res.resume()
            reject(new Error(`Model download failed with HTTP ${status}`))
            return
          }

          const total = Number(res.headers['content-length'] ?? 0)
          let received = 0
          let lastPct = -1
          let lastMb = -1
          res.on('data', (chunk: Buffer) => {
            received += chunk.length
            const mb = Math.floor(received / (1024 * 1024))
            const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : undefined
            if (pct !== lastPct || mb - lastMb >= 5) {
              lastPct = pct ?? -1
              lastMb = mb
              onStatus(t.modelProgress(mb, pct))
            }
          })

          await pipeline(res, createWriteStream(tmp))
          renameSync(tmp, target)
          if (!hasUsableWhisperModel(cwd)) {
            throw new Error('Downloaded ggml-base.bin is incomplete')
          }
          onStatus(t.modelReady)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
      req.setTimeout(10 * 60 * 1000, () => {
        req.destroy(new Error('Timed out downloading ggml-base.bin'))
      })
    })
  }

  try {
    await fetchToDisk(WHISPER_MODEL_URL)
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Ignore cleanup errors; the original download failure is more useful.
    }
    throw error
  }
}

// ─── public API ────────────────────────────────────────────────────────────────

export function shouldShowMcpInstallDialog(cwd = process.cwd()): boolean {
  return !existsSync(path.join(MCP_INSTALL_DIR, 'node_modules')) || !hasUsableWhisperModel(cwd)
}

export async function runMcpInstallDialog(locale: UiLocale, options: { cwd?: string } = {}): Promise<'installed' | 'skipped'> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'skipped'
  const cwd = options.cwd ?? process.cwd()

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
  // The bar's `done` is sourced from disk reality (top-level dirs in
  // node_modules) — that's the only signal that strictly never overcounts.
  // The "current" line shows the last package npm fetched, parsed from
  // `npm http fetch` output via --loglevel=http. Result: bar climbs as
  // packages are linked, while the spinner line shows live download
  // activity even before anything lands on disk.
  let done    = 0
  let fetchedPkgs = 0
  let current = (COPY[locale] ?? COPY['en']).preparing
  let pfi     = 0

  ensureMcpInstallDir()
  const nmDir = path.join(MCP_INSTALL_DIR, 'node_modules')
  const countInstalled = (): number => countNodeModulesEntries(nmDir)
  const cachedTotal: { value: number | undefined } = { value: undefined }
  const refreshCachedTotal = (): void => {
    const lockTotal =
      countExpectedVisiblePackageEntries(path.join(MCP_INSTALL_DIR, 'package-lock.json')) ??
      countExpectedVisiblePackageEntries(path.join(BUNDLED_MCP_DIR, 'package-lock.json'))
    if (lockTotal && lockTotal > 0) cachedTotal.value = lockTotal
  }
  refreshCachedTotal()
  const getEstimatedTotal = (): number | undefined => {
    if (cachedTotal.value === undefined) return undefined
    // Guard: if the on-disk count somehow exceeds the cached lock total
    // (npm regenerated lockfile late, etc.), bump the cached total so the
    // bar can still hit 100%.
    if (done > cachedTotal.value) cachedTotal.value = done
    return cachedTotal.value
  }

  const renderProgress = () => {
    layout = buildLayout(locale)
    const total = getEstimatedTotal()
    // While npm is still fetching and node_modules is empty, the bar
    // would otherwise sit at 0%. Use fetchedPkgs as a transient floor so
    // the bar starts moving immediately based on real download events.
    const effectiveDone = Math.max(done, Math.min(fetchedPkgs, total ?? Number.POSITIVE_INFINITY))
    updateBody(progressBody(pfi, effectiveDone, total, current, locale, layout), layout)
  }

  const onResizeProgress = () => {
    layout = buildLayout(locale)
    const total = getEstimatedTotal()
    const effectiveDone = Math.max(done, Math.min(fetchedPkgs, total ?? Number.POSITIVE_INFINITY))
    rebuildScreen(progressBody(pfi, effectiveDone, total, current, locale, layout), layout)
  }
  process.stdout.on('resize', onResizeProgress)

  renderProgress()
  // Tick at 200ms so the spinner + elapsed feel snappy and the on-disk
  // package counter is sampled often enough that no individual extract
  // step looks frozen for >200ms. Cheap enough — countNodeModulesEntries
  // is one readdir.
  const progressTimer = setInterval(() => {
    pfi++
    done = countInstalled()
    // Re-read total in case npm just wrote a fresh lockfile
    if (cachedTotal.value === undefined) refreshCachedTotal()
    renderProgress()
  }, 200)

  const npmSuccess = await new Promise<boolean>((resolve) => {
    // --loglevel=http makes npm emit one `npm http fetch GET 200 <url>`
    // line per tarball download. We use that as the "current package"
    // signal so the dialog shows real activity during the otherwise
    // silent resolve+download phase.
    const child = spawn(
      'npm',
      ['install', '--prefix', MCP_INSTALL_DIR, '--no-audit', '--no-fund', '--loglevel=http'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stderrBuf = ''
    let stdoutBuf = ''

    const handleLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return

      // npm http fetch GET 200 https://registry.npmjs.org/<pkg>/-/<pkg>-1.2.3.tgz 234ms
      const fetchMatch = trimmed.match(/npm http fetch GET (?:\d+\s+)?https:\/\/[^\s/]+\/([^\s]+)/)
      if (fetchMatch?.[1]) {
        const url = fetchMatch[1]
        // Strip .../-/<tarball>.tgz suffix if present, and decode any %xx
        const pkgPath = url.split('/-/')[0] ?? url
        try {
          current = decodeURIComponent(pkgPath)
        } catch {
          current = pkgPath
        }
        fetchedPkgs += 1
        return
      }

      // Final summary: "added 690 packages in 47s"
      const addedMatch = trimmed.match(/added\s+(\d+)\s+packages?/)
      if (addedMatch?.[1]) {
        const n = parseInt(addedMatch[1], 10)
        if (Number.isFinite(n) && n > 0) {
          // Tighten cachedTotal to npm's reported figure if it's higher
          if (!cachedTotal.value || cachedTotal.value < n) cachedTotal.value = n
          current = `linked ${n} packages`
        }
        return
      }

      // Show short notable lines verbatim (warnings, "removed N packages", etc.)
      // but skip the verbose `npm http fetch` cruft that didn't match above.
      if (trimmed.length < 80 && !trimmed.startsWith('npm http')) {
        current = trimmed
      }
    }

    const consume = (buf: Buffer, which: 'stdout' | 'stderr'): void => {
      const text = buf.toString()
      const accumulated = (which === 'stdout' ? stdoutBuf : stderrBuf) + text
      const lines = accumulated.split('\n')
      // Keep the final partial line (no trailing newline) for next chunk
      const leftover = lines.pop() ?? ''
      if (which === 'stdout') stdoutBuf = leftover
      else stderrBuf = leftover
      for (const line of lines) handleLine(line)
    }

    child.stdout?.on('data', (b: Buffer) => consume(b, 'stdout'))
    child.stderr?.on('data', (b: Buffer) => consume(b, 'stderr'))
    child.on('close', (code) => {
      // Flush trailing partial line on close
      if (stdoutBuf) handleLine(stdoutBuf)
      if (stderrBuf) handleLine(stderrBuf)
      resolve(code === 0)
    })
    child.on('error', () => resolve(false))
  })

  let success = npmSuccess
  if (npmSuccess) {
    try {
      await downloadWhisperModel(cwd, (line) => { current = line }, locale)
      success = true
    } catch (error) {
      current = error instanceof Error ? error.message : String(error)
      success = false
    }
  }

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
