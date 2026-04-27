/**
 * cli/bundleDialog.ts — "original vs enhanced" confirmation UI for Bundle.
 * Rendered inline (no alt-screen) so the chat transcript above stays visible.
 *
 * ↑/↓ toggle between original and enhanced, Enter sends the highlighted one,
 * Esc / Ctrl+C sends the original (safe default).
 */

import { emitKeypressEvents } from 'node:readline'
import { stringWidth } from '../input/stringWidth.js'
import type { UiLocale } from './locale.js'

const ESC = '\x1b'
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`

export type BundleChoice = 'original' | 'enhanced'

function color(text: string, code: string): string {
  return process.stdout.isTTY ? `${code}${text}${ESC}[0m` : text
}
function dim(text: string): string  { return color(text, `${ESC}[2m`) }
function bold(text: string): string { return color(text, `${ESC}[1m`) }
function rgb(text: string, r: number, g: number, b: number, b2 = false): string {
  return color(text, `${ESC}[${b2 ? '1;' : ''}38;2;${r};${g};${b}m`)
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const rawLine of text.split('\n')) {
    if (rawLine === '') { out.push(''); continue }
    let current = ''
    let currentWidth = 0
    for (const ch of rawLine) {
      const w = stringWidth(ch)
      if (currentWidth + w > width) {
        out.push(current)
        current = ch
        currentWidth = w
      } else {
        current += ch
        currentWidth += w
      }
    }
    if (current) out.push(current)
  }
  return out
}

const COPY = {
  'zh-CN': {
    title:       '◆ Bundle 润色预览',
    original:    '原版',
    enhanced:    '增强版',
    model:       '润色模型',
    hint:        '↑ ↓ 切换   Enter 发送所选   Esc 发原版',
    cancelled:   '（已选原版发送）',
  },
  en: {
    title:       '◆ Bundle Polish Preview',
    original:    'Original',
    enhanced:    'Enhanced',
    model:       'Polisher',
    hint:        '↑ ↓ toggle   Enter send selected   Esc send original',
    cancelled:   '(sent original)',
  },
} as const

export async function runBundleDialog(options: {
  original:  string
  enhanced:  string
  modelName: string
  locale:    UiLocale
}): Promise<BundleChoice> {
  const { original, enhanced, modelName, locale } = options
  const t = COPY[locale] ?? COPY.en

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Non-interactive: default to original (safe).
    return 'original'
  }

  const cols   = Math.max(60, process.stdout.columns ?? 100)
  const bodyW  = Math.min(cols - 4, 100)
  const origLines = wrap(original, bodyW)
  const enhLines  = wrap(enhanced, bodyW)

  let selected: BundleChoice = 'enhanced'
  let renderedLines = 0

  const render = (): number => {
    const out: string[] = []
    out.push(rgb(t.title, 148, 82, 255, true) + '   ' + dim(`${t.model}: ${modelName}`))
    out.push('')

    const marker = (active: boolean) => active ? rgb('▶', 255, 235, 150, true) : ' '
    const label  = (text: string, active: boolean) =>
      active
        ? bold(rgb(text, 148, 226, 213))
        : dim(text)

    out.push(`${marker(selected === 'original')} ${label(t.original, selected === 'original')}`)
    for (const line of origLines) {
      out.push(selected === 'original'
        ? '  ' + rgb(line, 220, 220, 220)
        : '  ' + dim(line))
    }
    out.push('')
    out.push(`${marker(selected === 'enhanced')} ${label(t.enhanced, selected === 'enhanced')}`)
    for (const line of enhLines) {
      out.push(selected === 'enhanced'
        ? '  ' + rgb(line, 166, 227, 161)
        : '  ' + dim(line))
    }
    out.push('')
    out.push(dim(t.hint))

    // Clear previously rendered region, then write new.
    if (renderedLines > 0) {
      process.stdout.write(`${ESC}[${renderedLines}A`)  // cursor up
      process.stdout.write(`${ESC}[0J`)                  // clear from cursor
    }
    process.stdout.write(out.join('\n') + '\n')
    return out.length
  }

  process.stdout.write(HIDE_CURSOR)
  emitKeypressEvents(process.stdin)
  const wasRaw = process.stdin.isRaw
  process.stdin.setRawMode(true)
  process.stdin.resume()
  renderedLines = render()

  return await new Promise<BundleChoice>((resolve) => {
    const cleanup = (pick: BundleChoice) => {
      process.stdin.off('keypress', onKeypress)
      process.stdin.setRawMode(wasRaw)
      process.stdout.write(SHOW_CURSOR)
      resolve(pick)
    }

    const onKeypress = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c')  { cleanup('original'); return }
      if (key.name === 'escape')          { cleanup('original'); return }
      if (key.name === 'up' || key.name === 'left')  { selected = 'original'; renderedLines = render(); return }
      if (key.name === 'down' || key.name === 'right'){ selected = 'enhanced'; renderedLines = render(); return }
      if (key.name === 'tab')             {
        selected = selected === 'original' ? 'enhanced' : 'original'
        renderedLines = render()
        return
      }
      if (key.name === 'return' || key.name === 'enter') { cleanup(selected) }
    }

    process.stdin.on('keypress', onKeypress)
  })
}
