import emojiRegex from 'emoji-regex'
import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import stripAnsi from 'strip-ansi'
import wrapAnsi from 'wrap-ansi'
import {
  INITIAL_STATE,
  nonAlphanumericKeys,
  parseMultipleKeypresses,
  type KeyParseState,
  type ParsedInput,
  type ParsedKey,
} from '../input/parse-keypress.js'
import { stringWidth } from '../input/stringWidth.js'
import { PASTE_END, PASTE_START } from '../termio/csi.js'
import type { SlashMenuItem } from './prompt.js'

export interface BlessedPromptOptions {
  history?: string[]
  headerFn?: () => string
  footerHint?: string
  onTextChange?: (text: string) => void
  onToggleTranscript?: () => void
}

export interface PickChoice<T> {
  value: T
  label: string
  description?: string
}

export interface PickOptions<T> {
  title: string
  choices: PickChoice<T>[]
  initialIndex?: number
  hint?: string
}

export interface BlessedPromptHandle {
  read(): Promise<string | null>
  setSuggestion(_s: string): void
  setMenu(items: SlashMenuItem[] | null): void
  /**
   * Stream-render API. Finalised lines flow into terminal scrollback
   * (append-only). Transient lines render in the pinned bottom zone and
   * never reach scrollback — used for live indicators like "◌ generating".
   */
  setLines(finalised: string[], transient: string[]): void
  /** Backward-compat shim — treats all lines as finalised. */
  setViewportLines(lines: string[]): void
  setSystemLogLines?(lines: string[]): void
  close(): void
  dispose(): void
  mountViewport(): void
  forceRedraw(): void
  clearBuffer(): void
  history: string[]
  releaseTerminal<T>(fn: () => Promise<T>): Promise<T>
  confirm(options: { title: string, lines?: string[], confirmLabel?: string, cancelLabel?: string, timeoutMs?: number }): Promise<boolean>
  /** Overlay-style single-choice picker. Resolves with the selected value, or null on Esc. */
  pickOption<T>(options: PickOptions<T>): Promise<T | null>
}

type PendingRead = (value: string | null) => void
type ConfirmState = {
  title: string
  lines: string[]
  confirmLabel: string
  cancelLabel: string
  selected: 0 | 1
  resolve: (value: boolean) => void
  timeout: NodeJS.Timeout | null
}

type PickerState = {
  title: string
  choices: { label: string; description?: string; value: unknown }[]
  selected: number
  hint: string
  resolve: (value: unknown | null) => void
}

type PlaceholderRange = {
  start: number
  end: number
  displayText: string
  realText: string
  kind: 'paste' | 'image'
}

const CSI = '\x1b['
const OSC = '\x1b]'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(stripAnsi(text)) <= maxWidth) return text
  if (maxWidth === 1) return '…'

  let out = ''
  let width = 0
  for (const ch of text) {
    const next = width + stringWidth(ch)
    if (next > maxWidth - 1) break
    out += ch
    width = next
  }
  return `${out}…`
}

/**
 * Strip shell-style quoting/escaping that macOS Finder & iTerm2 add when a
 * file is dragged into the terminal. Handles:
 *   '/path with spaces/foo.png'     → /path with spaces/foo.png
 *   "/path/foo.png"                 → /path/foo.png
 *   /path/with\ spaces/foo.png      → /path/with spaces/foo.png
 *   /path/with\(parens\)/foo.png    → /path/with(parens)/foo.png
 */
function stripShellQuoting(text: string): string {
  let out = text.trim()
  if (out.length >= 2) {
    const first = out[0]
    const last = out[out.length - 1]
    if ((first === "'" || first === '"') && first === last) {
      out = out.slice(1, -1)
    }
  }
  // Unescape backslash escapes (\<space>, \<paren>, \\, etc).
  out = out.replace(/\\(.)/g, '$1')
  return out
}

function deleteLastGrapheme(text: string): string {
  if (text.length === 0) return text
  const regex = emojiRegex()
  const matches = [...text.matchAll(regex)]
  if (matches.length > 0) {
    const last = matches[matches.length - 1]!
    const start = last.index ?? -1
    if (start >= 0 && start + last[0].length === text.length) {
      return text.slice(0, start)
    }
  }
  return Array.from(text).slice(0, -1).join('')
}

function padRight(text: string, width: number): string {
  const visible = stringWidth(stripAnsi(text))
  if (visible >= width) return text
  return text + ' '.repeat(width - visible)
}

function wrapPlain(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const sourceLines = text.split('\n')
  const out: string[] = []

  for (const sourceLine of sourceLines) {
    if (sourceLine.length === 0) {
      out.push('')
      continue
    }
    let row = ''
    let rowWidth = 0
    for (const ch of sourceLine) {
      const chWidth = stringWidth(ch)
      if (rowWidth > 0 && rowWidth + chWidth > safeWidth) {
        out.push(row)
        row = ch
        rowWidth = chWidth
      } else {
        row += ch
        rowWidth += chWidth
      }
    }
    out.push(row)
  }

  return out.length > 0 ? out : ['']
}

class TerminalPrompt implements BlessedPromptHandle {
  readonly history: string[]

  private readonly headerFn?: () => string
  private readonly footerHint: string
  private readonly onTextChange?: (text: string) => void
  private readonly onToggleTranscript?: () => void

  private finalisedLines: string[] = []
  private transientLines: string[] = []
  private drawnFinalisedCount = 0
  private bottomZoneHeight = 0
  private cursorOffsetFromZoneTop = 0
  private menuItems: SlashMenuItem[] = []
  private menuIndex = 0
  private submittedQueue: Array<string | null> = []
  private pendingRead: PendingRead | null = null
  private inputValue = ''
  private inputCursor = 0
  private placeholderRanges: PlaceholderRange[] = []
  private pastePlaceholderCount = 0
  private imagePlaceholderCount = 0
  private historyIndex = -1
  private historyDraft = ''
  private started = false
  private parseState: KeyParseState = INITIAL_STATE
  private dataHandler: ((chunk: string) => void) | null = null
  private resizeHandler: (() => void) | null = null
  private resizeTimer: NodeJS.Timeout | null = null
  private readonly cookedLineInput: boolean
  private confirmState: ConfirmState | null = null
  private pickerState: PickerState | null = null

  private static readonly INPUT_INNER_ROWS = 2
  private static readonly LARGE_PASTE_LINES = 5
  private static readonly LARGE_PASTE_CHARS = 300

  constructor(options: BlessedPromptOptions) {
    this.history = options.history ?? []
    this.headerFn = options.headerFn
    this.footerHint = options.footerHint ?? ''
    this.onTextChange = options.onTextChange
    this.onToggleTranscript = options.onToggleTranscript
    // Windows console hosts can drop raw-mode keypress events while still showing
    // a blinking cursor, which makes the chat box look focused but impossible to
    // type into. Use cooked line input on Windows by default so the console host
    // owns text entry/IME and Artemis receives complete submitted lines. Keep a
    // raw-mode escape hatch for terminals where per-key editing is known to work.
    this.cookedLineInput = process.platform === 'win32' && process.env.ARTEMIS_WINDOWS_RAW_INPUT !== '1'
  }

  read(): Promise<string | null> {
    this.ensureStarted()
    if (this.submittedQueue.length > 0) {
      const next = this.submittedQueue.shift()
      return Promise.resolve(next ?? null)
    }
    return new Promise<string | null>(resolve => {
      this.pendingRead = resolve
    })
  }

  setSuggestion(_s: string): void {
    // no-op
  }

  setMenu(items: SlashMenuItem[] | null): void {
    this.menuItems = items?.slice(0, 10) ?? []
    this.menuIndex = 0
    this.render()
  }

  setLines(finalised: string[], transient: string[]): void {
    this.finalisedLines = finalised
    this.transientLines = transient
    this.render()
  }

  setViewportLines(lines: string[]): void {
    this.setLines(lines, [])
  }

  setSystemLogLines(_lines: string[]): void {
    // Intentional no-op. Single scroll region; system blocks live in finalised.
  }

  close(): void {
    this.enqueue(null)
  }

  dispose(): void {
    if (this.started && process.stdout.isTTY && this.bottomZoneHeight > 0) {
      // Wipe the bottom zone so subsequent stdout writes (exit panel, etc.)
      // start on a clean line instead of overwriting the input box.
      if (this.cursorOffsetFromZoneTop > 0) {
        process.stdout.write(`${CSI}${this.cursorOffsetFromZoneTop}F`)
      } else {
        process.stdout.write('\r')
      }
      process.stdout.write(`${CSI}J`)
    }
    this.shutdown()
    this.pendingRead?.(null)
    this.pendingRead = null
  }

  mountViewport(): void {
    this.ensureStarted()
    this.render()
  }

  forceRedraw(): void {
    this.render()
  }

  clearBuffer(): void {
    this.submittedQueue = []
    this.inputValue = ''
    this.inputCursor = 0
    this.placeholderRanges = []
    this.historyIndex = -1
    this.historyDraft = ''
    this.onTextChange?.('')

    this.finalisedLines = []
    this.transientLines = []
    this.drawnFinalisedCount = 0

    if (process.stdout.isTTY) {
      // Hard wipe — visible screen + scrollback. Used by /clear and /newborn
      // so the new session starts on a truly empty terminal.
      process.stdout.write(`${CSI}3J${CSI}2J${CSI}H`)
      this.bottomZoneHeight = 0
      this.cursorOffsetFromZoneTop = 0
    }
    this.render()
  }

  async releaseTerminal<T>(fn: () => Promise<T>): Promise<T> {
    const wasStarted = this.started
    if (wasStarted) this.shutdown()
    try {
      return await fn()
    } finally {
      if (wasStarted) {
        this.ensureStarted()
        this.render()
      }
    }
  }

  async confirm(options: { title: string, lines?: string[], confirmLabel?: string, cancelLabel?: string, timeoutMs?: number }): Promise<boolean> {
    this.ensureStarted()
    if (this.confirmState) this.resolveConfirm(false)
    return new Promise<boolean>(resolve => {
      const timeout = options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => this.resolveConfirm(false), options.timeoutMs)
        : null
      this.confirmState = {
        title: options.title,
        lines: options.lines ?? [],
        confirmLabel: options.confirmLabel ?? 'Yes',
        cancelLabel: options.cancelLabel ?? 'No',
        selected: 1,
        resolve,
        timeout,
      }
      this.render()
    })
  }

  async pickOption<T>(options: PickOptions<T>): Promise<T | null> {
    this.ensureStarted()
    if (this.pickerState) this.resolvePicker(null)
    if (options.choices.length === 0) return null

    const initial = Math.min(
      Math.max(options.initialIndex ?? 0, 0),
      options.choices.length - 1,
    )
    return new Promise<T | null>(resolve => {
      this.pickerState = {
        title: options.title,
        choices: options.choices as { label: string; description?: string; value: unknown }[],
        selected: initial,
        hint: options.hint ?? '↑↓ 选择   Enter 确认   Esc 取消',
        resolve: (v) => resolve(v as T | null),
      }
      this.render()
    })
  }

  private resolvePicker(value: unknown | null): void {
    if (!this.pickerState) return
    const state = this.pickerState
    this.pickerState = null
    state.resolve(value)
    this.render()
  }

  private ensureStarted(): void {
    if (this.started) return
    this.started = true

    process.stdin.setRawMode?.(!this.cookedLineInput)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    process.stdout.write(HIDE_CURSOR)
    process.stdout.write(ENABLE_BRACKETED_PASTE)
    // Clear visible screen + cursor home. Scrollback is preserved so the user
    // keeps whatever was in the terminal before Artemis launched.
    process.stdout.write(`${CSI}2J${CSI}H`)

    // Reset render bookkeeping. After releaseTerminal()/onboarding, fn() may
    // have left the screen in any state — start clean and let render() rewrite
    // the finalised content from scratch.
    this.bottomZoneHeight = 0
    this.cursorOffsetFromZoneTop = 0
    this.drawnFinalisedCount = 0

    this.dataHandler = (chunk: string) => {
      if (this.cookedLineInput) {
        this.handleCookedInput(chunk)
        return
      }
      const [events, newState] = parseMultipleKeypresses(this.parseState, chunk)
      this.parseState = newState
      for (const event of events) this.handleEvent(event)
    }
    this.resizeHandler = () => {
      // Windows Terminal emits a burst of resize events while the user drags the
      // window and reflows the backing buffer between events. Rendering on every
      // intermediate size can interleave stale bottom-zone frames / spinners with
      // the newly wrapped finalised output. Debounce until the dimensions settle,
      // then rebuild the screen from our canonical line arrays.
      if (this.resizeTimer) clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null
        // Old wrap is wrong at the new width and the terminal may have re-flowed
        // unpredictably. On Windows, also clear scrollback (3J) because visible
        // clear alone can leave pre-resize reflow artifacts in the viewport.
        const hardClear = process.platform === 'win32' ? `${CSI}3J${CSI}2J${CSI}H` : `${CSI}2J${CSI}H`
        process.stdout.write(`${CSI}0m${HIDE_CURSOR}${hardClear}`)
        this.bottomZoneHeight = 0
        this.cursorOffsetFromZoneTop = 0
        this.drawnFinalisedCount = 0
        this.render()
      }, process.platform === 'win32' ? 90 : 40)
    }

    process.stdin.on('data', this.dataHandler)
    process.stdout.on('resize', this.resizeHandler)
  }

  private shutdown(): void {
    if (!this.started) return
    this.started = false

    if (this.dataHandler) process.stdin.removeListener('data', this.dataHandler)
    if (this.resizeHandler) process.stdout.removeListener('resize', this.resizeHandler)
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.dataHandler = null
    this.resizeHandler = null
    this.resizeTimer = null
    this.parseState = INITIAL_STATE

    process.stdout.write(DISABLE_BRACKETED_PASTE)
    process.stdout.write(SHOW_CURSOR)
    process.stdout.write(`${CSI}0m${OSC}112\x07`)

    process.stdin.setRawMode?.(false)
    process.stdin.pause()
  }

  private handleCookedInput(chunk: string): void {
    if (chunk === '\x03') {
      this.handleCtrlC()
      return
    }

    // When cooked mode is explicitly enabled, the console host owns IME and
    // Ctrl+V. Some terminals still emit bracketed-paste markers in cooked mode;
    // route those through paste handling so a pasted line ending with CR/LF is
    // inserted for review instead of being mistaken for an Enter submission.
    if (chunk.includes(PASTE_START) || chunk.includes(PASTE_END)) {
      const [events, newState] = parseMultipleKeypresses(this.parseState, chunk)
      this.parseState = newState
      for (const event of events) this.handleEvent(event)
      return
    }

    const normalised = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const endsWithNewline = normalised.endsWith('\n')
    const parts = normalised.split('\n')

    if (parts.length === 1) {
      if (parts[0]) {
        this.inputValue += parts[0]
        this.inputCursor = this.inputValue.length
        this.onTextChange?.(this.inputValue)
        this.render()
      }
      return
    }

    // If the input contains only one line plus a terminal newline, treat it as
    // an explicit Enter submission. If there are internal newlines, assume the
    // user pasted multi-line content and insert it instead of submitting.
    const firstPart = parts[0] ?? ''
    const isLikelySingleLinePaste = parts.length === 2 && endsWithNewline && firstPart.length >= TerminalPrompt.LARGE_PASTE_CHARS
    const isSingleLineSubmit = parts.length === 2 && endsWithNewline && !isLikelySingleLinePaste

    if (isSingleLineSubmit) {
      const part = firstPart
      if (part) {
        this.inputValue += part
        this.inputCursor = this.inputValue.length
        this.onTextChange?.(this.inputValue)
      }
      const submitted = this.expandPlaceholders(this.inputValue.replace(/\n+$/, ''))
      this.inputValue = ''
      this.inputCursor = 0
      this.placeholderRanges = []
      this.historyIndex = -1
      this.historyDraft = ''
      this.menuItems = []
      if (submitted.trim() && this.history[0] !== submitted) {
        this.history.unshift(submitted)
        if (this.history.length > 200) this.history.length = 200
      }
      this.onTextChange?.('')
      this.render()
      this.enqueue(submitted)
      return
    }

    if (isLikelySingleLinePaste) {
      this.inputValue += firstPart
      this.inputCursor = this.inputValue.length
      this.onTextChange?.(this.inputValue)
      this.render()
      return
    }

    const lastPart = endsWithNewline ? '' : parts.pop() ?? ''
    this.inputValue += parts.join('\n')
    if (lastPart) {
      this.inputValue += lastPart
    }
    this.inputCursor = this.inputValue.length
    this.onTextChange?.(this.inputValue)
    this.render()
  }

  private enqueue(value: string | null): void {
    if (this.pendingRead) {
      const resolve = this.pendingRead
      this.pendingRead = null
      resolve(value)
      return
    }
    this.submittedQueue.push(value)
  }

  private resolveConfirm(value: boolean): void {
    if (!this.confirmState) return
    const state = this.confirmState
    this.confirmState = null
    if (state.timeout) clearTimeout(state.timeout)
    state.resolve(value)
    this.render()
  }

  private handleEvent(event: ParsedInput): void {
    if (event.kind === 'response') return
    // No mouse tracking is enabled — wheel/click stay with the terminal so
    // native scrollback and text selection keep working.
    if (event.kind === 'mouse') return
    this.handleKey(event)
  }

  private handleKey(key: ParsedKey): void {
    if (key.isPasted) {
      this.handlePastedText(key.sequence ?? '')
      return
    }

    // wheelup/wheeldown/mouse arrive only when mouse tracking is enabled;
    // we don't enable it, so these don't fire. Drop defensively.
    if (key.name === 'wheelup' || key.name === 'wheeldown' || key.name === 'mouse') return

    if (key.ctrl && key.name === 'c') {
      this.handleCtrlC()
      return
    }
    if (key.ctrl && key.name === 't') {
      this.onToggleTranscript?.()
      return
    }

    if (this.confirmState) {
      if (key.name === 'up' || key.name === 'left') {
        this.confirmState.selected = 0
        this.render()
        return
      }
      if (key.name === 'down' || key.name === 'right') {
        this.confirmState.selected = 1
        this.render()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        this.resolveConfirm(this.confirmState.selected === 0)
        return
      }
      if (key.name === 'escape') {
        this.resolveConfirm(false)
        return
      }
      return
    }

    if (this.pickerState) {
      const count = this.pickerState.choices.length
      if (key.name === 'up') {
        this.pickerState.selected = this.pickerState.selected === 0 ? count - 1 : this.pickerState.selected - 1
        this.render()
        return
      }
      if (key.name === 'down') {
        this.pickerState.selected = this.pickerState.selected === count - 1 ? 0 : this.pickerState.selected + 1
        this.render()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        const picked = this.pickerState.choices[this.pickerState.selected]?.value ?? null
        this.resolvePicker(picked)
        return
      }
      if (key.name === 'escape') {
        this.resolvePicker(null)
        return
      }
      // Number shortcut: 1..9 selects that row
      const n = Number(key.sequence)
      if (Number.isInteger(n) && n >= 1 && n <= count) {
        this.pickerState.selected = n - 1
        this.render()
      }
      return
    }

    if (this.menuItems.length > 0) {
      if (key.name === 'up') {
        this.menuIndex = this.menuIndex > 0 ? this.menuIndex - 1 : this.menuItems.length - 1
        this.render()
        return
      }
      if (key.name === 'down') {
        this.menuIndex = this.menuIndex < this.menuItems.length - 1 ? this.menuIndex + 1 : 0
        this.render()
        return
      }
      if (key.name === 'tab' || key.name === 'return' || key.name === 'enter') {
        this.applyMenuSelection()
        return
      }
      if (key.name === 'escape') {
        this.menuItems = []
        this.render()
        return
      }
    }

    // pageup/pagedown/home/end and ctrl/shift+arrows used to scroll the
    // in-app viewport; that's now the terminal's own scrollback so we don't
    // intercept them. Plain ↑↓ still walks history.
    if (key.name === 'up') {
      this.historyUp()
      return
    }
    if (key.name === 'down') {
      this.historyDown()
      return
    }
    if (key.name === 'left') {
      this.moveCursor(-1)
      return
    }
    if (key.name === 'right') {
      this.moveCursor(1)
      return
    }
    if (key.ctrl && key.name === 'a') {
      this.inputCursor = 0
      this.render()
      return
    }
    if (key.ctrl && key.name === 'e') {
      this.inputCursor = this.inputValue.length
      this.render()
      return
    }
    if (key.ctrl && key.name === 'j') {
      this.insertAtCursor('\n')
      return
    }
    if (key.name === 'backspace') {
      if (this.deletePlaceholderBeforeCursor()) return
      this.deleteBeforeCursor()
      return
    }
    if (key.name === 'escape') {
      this.inputValue = ''
      this.inputCursor = 0
      this.placeholderRanges = []
      this.menuItems = []
      this.onTextChange?.('')
      this.render()
      return
    }
    if (key.name === 'enter' && key.sequence === '\n') {
      this.insertAtCursor('\n')
      return
    }

    if (key.name === 'return' || key.name === 'enter') {
      if ((key.sequence ?? '').includes('\n') && !(key.sequence ?? '').includes('\r')) {
        this.insertAtCursor('\n')
        return
      }
      if (this.menuItems.length > 0 && this.inputValue.startsWith('/') && !this.inputValue.includes(' ')) {
        this.applyMenuSelection()
        return
      }
      const submitted = this.inputValue.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
      this.inputValue = ''
      this.inputCursor = 0
      const expanded = this.expandPlaceholders(submitted)
      this.placeholderRanges = []
      this.historyIndex = -1
      this.historyDraft = ''
      this.menuItems = []
      // Record the just-submitted entry in the in-memory history so ↑↓ can
      // replay it within the same session. HistoryStore persists asynchronously
      // to disk, so we don't wait for it.
      if (expanded.trim() && this.history[0] !== expanded) {
        this.history.unshift(expanded)
        if (this.history.length > 200) this.history.length = 200
      }
      this.onTextChange?.('')
      this.render()
      this.enqueue(expanded)
      return
    }

    const printable = this.extractPrintable(key)
    if (printable) {
      this.insertAtCursor(printable)
      // After inserting text, check if the entire input is now an image file path.
      // Handles drag-and-drop from Finder which bypasses bracketed paste in some terminals.
      // Quick pre-filter: only run existsSync when the value looks like a file path.
      if (this.placeholderRanges.length === 0) {
        const candidate = this.inputValue.trim()
        const stripped = stripShellQuoting(candidate)
        const looksLikePath = (
          !stripped.includes('\n') &&
          (stripped.startsWith('/') || stripped.startsWith('~') || stripped.startsWith('file://')) &&
          /\.(png|jpg|jpeg|gif|webp|bmp|svg|heic|heif)$/i.test(stripped)
        )
        if (looksLikePath) {
          const imagePath = this.detectImagePath(stripped)
          if (imagePath) {
            this.inputValue = ''
            this.inputCursor = 0
            this.placeholderRanges = []
            const displayText = `[image#${++this.imagePlaceholderCount}]`
            this.insertPlaceholder(displayText, imagePath, 'image')
            return
          }
        }
      }
    }
  }

  private moveCursor(delta: number): void {
    const graphemes = Array.from(this.inputValue)
    let charIndex = 0
    let target = 0
    for (const g of graphemes) {
      if (charIndex >= this.inputCursor) break
      charIndex += g.length
      target += 1
    }
    const nextGraphemeIdx = Math.max(0, Math.min(graphemes.length, target + delta))
    let nextCursor = 0
    for (let i = 0; i < nextGraphemeIdx; i++) nextCursor += graphemes[i]!.length
    if (nextCursor === this.inputCursor) return
    this.inputCursor = nextCursor
    this.render()
  }

  private insertAtCursor(text: string): void {
    const c = Math.min(this.inputCursor, this.inputValue.length)
    this.inputValue = this.inputValue.slice(0, c) + text + this.inputValue.slice(c)
    this.inputCursor = c + text.length
    this.onTextChange?.(this.inputValue)
    this.render()
  }

  private deleteBeforeCursor(): void {
    if (this.inputCursor <= 0 || this.inputValue.length === 0) return
    const before = this.inputValue.slice(0, this.inputCursor)
    const after = this.inputValue.slice(this.inputCursor)
    const shrunk = deleteLastGrapheme(before)
    this.inputCursor -= (before.length - shrunk.length)
    this.inputValue = shrunk + after
    this.onTextChange?.(this.inputValue)
    this.render()
  }

  private extractPrintable(key: ParsedKey): string {
    if (key.ctrl || key.meta || key.super || key.fn) return ''
    if (key.name && nonAlphanumericKeys.includes(key.name)) {
      if (key.name === 'space') return ' '
      return ''
    }
    const seq = key.sequence ?? ''
    if (!seq) return ''
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(seq)) return ''
    return seq
  }

  private handleCtrlC(): void {
    if (this.inputValue.trim().length === 0) {
      this.enqueue(null)
    } else {
      this.inputValue = ''
      this.inputCursor = 0
      this.placeholderRanges = []
      this.onTextChange?.('')
      this.render()
    }
  }

  private applyMenuSelection(): void {
    if (this.menuItems.length === 0) return
    const item = this.menuItems[this.menuIndex] ?? this.menuItems[0]
    if (!item) return
    this.inputValue = `${item.value} `
    this.inputCursor = this.inputValue.length
    this.placeholderRanges = []
    this.menuItems = []
    this.onTextChange?.(this.inputValue)
    this.render()
  }

  private historyUp(): boolean {
    if (this.history.length === 0) return false
    const prevValue = this.inputValue
    const prevIndex = this.historyIndex
    if (this.historyIndex === -1) this.historyDraft = this.inputValue
    this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1)
    this.inputValue = this.history[this.historyIndex] ?? ''
    if (this.historyIndex === prevIndex && this.inputValue === prevValue) return false
    this.inputCursor = this.inputValue.length
    this.placeholderRanges = []
    this.onTextChange?.(this.inputValue)
    this.render()
    return true
  }

  private historyDown(): boolean {
    if (this.historyIndex === -1) return false
    const prevValue = this.inputValue
    const prevIndex = this.historyIndex
    if (this.historyIndex <= 0) {
      this.historyIndex = -1
      this.inputValue = this.historyDraft
    } else {
      this.historyIndex -= 1
      this.inputValue = this.history[this.historyIndex] ?? ''
    }
    if (this.historyIndex === prevIndex && this.inputValue === prevValue) return false
    this.inputCursor = this.inputValue.length
    this.placeholderRanges = []
    this.onTextChange?.(this.inputValue)
    this.render()
    return true
  }

  private handlePastedText(text: string): void {
    // eslint-disable-next-line no-control-regex
    const sanitised = text.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '')
    const normalised = sanitised.replace(/\r\n?/g, '\n')
    if (!normalised) return

    const imagePath = this.detectImagePath(normalised)
    if (imagePath) {
      const displayText = `[image#${++this.imagePlaceholderCount}]`
      this.insertPlaceholder(displayText, imagePath, 'image')
      return
    }

    const lineCount = (normalised.match(/\n/g) ?? []).length + 1
    const charCount = normalised.length
    const isLarge = lineCount > TerminalPrompt.LARGE_PASTE_LINES || charCount > TerminalPrompt.LARGE_PASTE_CHARS

    if (isLarge) {
      const displayText = `[compressed content #${++this.pastePlaceholderCount}, ${lineCount} lines]`
      this.insertPlaceholder(displayText, normalised, 'paste')
      return
    }

    this.insertAtCursor(normalised)
  }

  private detectImagePath(text: string): string | null {
    const trimmed = stripShellQuoting(text.trim())
    if (!trimmed || trimmed.includes('\n')) return null

    let candidate = trimmed
    if (candidate.startsWith('file://')) {
      try {
        candidate = decodeURIComponent(new URL(candidate).pathname)
      } catch {
        return null
      }
    }

    const lowerExt = extname(candidate).toLowerCase()
    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.heif'])
    if (!imageExts.has(lowerExt)) return null
    if (!existsSync(candidate)) return null
    try {
      if (!statSync(candidate).isFile()) return null
    } catch {
      return null
    }
    return candidate
  }

  private insertPlaceholder(displayText: string, realText: string, kind: 'paste' | 'image'): void {
    const start = this.inputValue.length
    this.inputValue += displayText
    const end = this.inputValue.length
    this.inputCursor = end
    this.placeholderRanges.push({ start, end, displayText, realText, kind })
    this.onTextChange?.(this.inputValue)
    this.render()
  }

  private deletePlaceholderBeforeCursor(): boolean {
    const match = this.placeholderRanges[this.placeholderRanges.length - 1]
    if (!match) return false
    if (match.end !== this.inputCursor) return false
    this.inputValue = this.inputValue.slice(0, match.start) + this.inputValue.slice(match.end)
    this.inputCursor = match.start
    this.placeholderRanges.pop()
    this.onTextChange?.(this.inputValue)
    this.render()
    return true
  }

  private expandPlaceholders(text: string): string {
    if (this.placeholderRanges.length === 0) return text
    let out = ''
    let cursor = 0
    for (const range of this.placeholderRanges) {
      out += text.slice(cursor, range.start)
      out += range.realText
      cursor = range.end
    }
    out += text.slice(cursor)
    return out
  }

  private buildOverlayLines(width: number): string[] {
    const innerWidth = Math.max(10, width - 4)

    if (this.pickerState) {
      const state = this.pickerState
      const rows: string[] = []
      for (let i = 0; i < state.choices.length; i++) {
        const ch = state.choices[i]
        const sel = i === state.selected
        const marker = sel ? '\x1b[1;32m▸\x1b[0m' : ' '
        const label = sel
          ? `\x1b[1;33m${ch.label}\x1b[0m`
          : `\x1b[38;5;252m${ch.label}\x1b[0m`
        const line = `  ${marker} ${label}`
        rows.push(truncateToWidth(line, innerWidth))
        if (ch.description) {
          rows.push(`    \x1b[2m${truncateToWidth(ch.description, innerWidth - 4)}\x1b[0m`)
        }
      }

      return [
        '',
        `  \x1b[1;36m${truncateToWidth(state.title, innerWidth)}\x1b[0m`,
        ...rows,
        `  \x1b[2m${truncateToWidth(state.hint, innerWidth)}\x1b[0m`,
      ]
    }

    if (this.confirmState) {
      const state = this.confirmState
      const title = truncateToWidth(state.title, innerWidth)
      const body = state.lines.filter(Boolean).map(line => `  • ${truncateToWidth(line, innerWidth - 4)}`)
      
      const yesLabel = ` [ ${state.confirmLabel} ] `
      const noLabel = ` [ ${state.cancelLabel} ] `
      
      const yes = state.selected === 0 
        ? `\x1b[30;42m${yesLabel}\x1b[0m` 
        : `\x1b[2m${yesLabel}\x1b[0m`
      const no = state.selected === 1 
        ? `\x1b[30;41m${noLabel}\x1b[0m` 
        : `\x1b[2m${noLabel}\x1b[0m`

      return [
        '',
        `  \x1b[1;33m${title}\x1b[0m`,
        ...body,
        '',
        `  ${yes}   ${no}`,
        `  \x1b[2m↑↓ ${this.footerHint.includes('Select') ? 'Select' : '选择'}  Enter ${this.footerHint.includes('Confirm') ? 'Confirm' : '确定'}\x1b[0m`,
      ]
    }

    if (this.menuItems.length > 0) {
      return this.menuItems.map((item, index) => {
        const isSelected = index === this.menuIndex
        const lead = isSelected ? '\x1b[1;32m›\x1b[0m' : ' '
        
        // Command: Bold Magenta for better visibility
        const cmdColor = isSelected ? '\x1b[1;35m' : '\x1b[35m'
        
        // Hint: Cyan/Blue for the description
        const hintColor = isSelected ? '\x1b[1;36m' : '\x1b[2;36m'
        
        const hintWidth = Math.max(8, innerWidth - stringWidth(item.value) - 6)
        return ` ${lead} ${cmdColor}${item.value}\x1b[0m  ${hintColor}${truncateToWidth(item.hint, hintWidth)}\x1b[0m`
      })
    }

    return []
  }

  private wrapForCols(line: string, cols: number): string[] {
    if (!line) return ['']
    const rendered = wrapAnsi(line, cols, { hard: true, trim: false, wordWrap: false })
    const split = rendered.split('\n')
    return split.length === 0 ? [''] : split
  }

  /**
   * Streaming render. Finalised lines flow into terminal scrollback as plain
   * `\r\n`-terminated writes; the bottom zone (transient + overlay + HUD +
   * input + footer) is wiped and redrawn in place each frame. No alt-screen,
   * no mouse tracking — wheel scroll and text selection stay native.
   */
  private render(): void {
    if (!this.started || !process.stdout.isTTY) return

    const out = process.stdout
    const cols = Math.max(20, out.columns ?? 80)
    const rows = Math.max(12, out.rows ?? 24)

    // ── Build bottom zone ─────────────────────────────────────────────────
    const overlayLines = this.buildOverlayLines(cols)
    const headerText = this.headerFn?.() ?? ''
    const sep = '─'.repeat(cols)
    const hudLines = [sep, truncateToWidth(headerText, cols), sep]

    // Box decoration takes 6 visible cells per row:
    //   "│ "(2) + "› "/"  "(2) + content + " │"(2) = cols
    // Wrapping must use the *content* width so wrapped lines never exceed
    // `cols - 6`. Using `cols - 4` (the older value) produced rows that were
    // 2 cells wider than the terminal — the terminal then wrapped them onto
    // an extra screen row, breaking bottomZoneHeight bookkeeping and stranding
    // ghost HUD "─" lines above the box on every keystroke.
    const inputContentWidth = Math.max(1, cols - 6)
    const wrappedInput = wrapPlain(this.inputValue, inputContentWidth)
    const beforeCursorText = this.inputValue.slice(0, Math.min(this.inputCursor, this.inputValue.length))
    const wrappedBeforeCursor = wrapPlain(beforeCursorText, inputContentWidth)
    const cursorAbsRow = Math.max(0, wrappedBeforeCursor.length - 1)
    const lastBeforeLine = wrappedBeforeCursor[wrappedBeforeCursor.length - 1] ?? ''
    const cursorAbsColInLine = stringWidth(lastBeforeLine)
    const totalWrappedRows = Math.max(1, wrappedInput.length)
    const visibleStart = Math.max(0, Math.min(totalWrappedRows - TerminalPrompt.INPUT_INNER_ROWS, Math.max(0, cursorAbsRow - (TerminalPrompt.INPUT_INNER_ROWS - 1))))
    const visibleEnd = Math.min(totalWrappedRows, visibleStart + TerminalPrompt.INPUT_INNER_ROWS)
    const visibleSlice = wrappedInput.slice(visibleStart, visibleEnd)
    const padCount = Math.max(0, TerminalPrompt.INPUT_INNER_ROWS - visibleSlice.length)
    const visibleInput: string[] = [...Array(padCount).fill(''), ...visibleSlice]
    const cursorVisibleRow = padCount + (cursorAbsRow - visibleStart)

    const boxTop = `┌${'─'.repeat(Math.max(1, cols - 2))}┐`
    const boxBottom = `└${'─'.repeat(Math.max(1, cols - 2))}┘`
    const inputLines = visibleInput.map((line, index) => {
      const isFirstVisibleInputRow = index === padCount
      const prefix = isFirstVisibleInputRow ? '\x1b[1;38;5;117m›\x1b[0m ' : '  '
      return `│ ${prefix}${padRight(line, inputContentWidth)} │`
    })
    const footer = truncateToWidth(this.footerHint, cols)

    // Wrap transient (assistant/system streaming may exceed cols), then keep a
    // stable head with an explicit truncation marker. Keeping the tail made
    // system/status panels look like their title/top rows were randomly eaten,
    // especially on Windows after resize. The full content still commits to
    // finalised scrollback when the block completes.
    const wrappedTransientAll: string[] = []
    for (const line of this.transientLines) {
      for (const sub of this.wrapForCols(line, cols)) wrappedTransientAll.push(sub)
    }
    const fixedZoneHeight = overlayLines.length + hudLines.length + 1 + inputLines.length + 1 + 1
    const maxTransient = Math.max(0, rows - fixedZoneHeight)
    const transientForDisplay = wrappedTransientAll.length <= maxTransient
      ? wrappedTransientAll
      : maxTransient <= 0
        ? []
        : maxTransient === 1
          ? [truncateToWidth('…', cols)]
          : [
              ...wrappedTransientAll.slice(0, maxTransient - 1),
              truncateToWidth(`… ${wrappedTransientAll.length - (maxTransient - 1)} more line(s)`, cols),
            ]

    const zoneLines: string[] = [
      ...transientForDisplay,
      ...overlayLines,
      ...hudLines,
      boxTop,
      ...inputLines,
      boxBottom,
      footer,
    ]

    // Defensive crop — pathological tiny terminals.
    let cropFromTop = 0
    while (zoneLines.length > rows) {
      zoneLines.shift()
      cropFromTop += 1
    }

    const H_NEW = zoneLines.length
    const inputBoxTopOffset = transientForDisplay.length + overlayLines.length + hudLines.length
    const cursorBoxRow = Math.max(0, Math.min(TerminalPrompt.INPUT_INNER_ROWS - 1, cursorVisibleRow))
    const cursorRowInZone = Math.max(0, Math.min(H_NEW - 1, inputBoxTopOffset + 1 + cursorBoxRow - cropFromTop))
    const cursorCol = Math.max(0, Math.min(cols - 1, 4 + cursorAbsColInLine))

    // ── Phase 1: wipe previous bottom zone ────────────────────────────────
    out.write(`${CSI}0m`)
    out.write(HIDE_CURSOR)

    if (this.bottomZoneHeight > 0) {
      if (this.cursorOffsetFromZoneTop > 0) {
        out.write(`${CSI}${this.cursorOffsetFromZoneTop}F`)
      } else {
        out.write('\r')
      }
      out.write(`${CSI}J`)
    }
    // Cursor is now at column 1, at row R_w (top of the just-wiped zone, or
    // row 1 on the first frame after ensureStarted's clear).

    // ── Phase 2: append newly-finalised lines to scrollback ───────────────
    // If finalised shrunk below drawnFinalisedCount (e.g., view rebuilt from
    // a different block list) the old content is already in scrollback and
    // can't be unwritten — re-append the whole new tail. The visual duplicate
    // is acceptable per design.
    const writeFromIndex = (this.finalisedLines.length >= this.drawnFinalisedCount)
      ? this.drawnFinalisedCount
      : 0
    let newRowsWritten = 0
    for (let i = writeFromIndex; i < this.finalisedLines.length; i++) {
      const sourceLine = this.finalisedLines[i] ?? ''
      const wrapped = this.wrapForCols(sourceLine, cols)
      for (const sub of wrapped) {
        out.write(sub)
        out.write(`${CSI}0m`)
        out.write('\r\n')
        newRowsWritten += 1
      }
    }
    this.drawnFinalisedCount = this.finalisedLines.length

    // ── Phase 3: position cursor at row T = rows - H_NEW + 1 ──────────────
    // R_w is where the cursor was after wipe. Phase 2 advanced it by
    // newRowsWritten, capped at `rows` (terminal scrolls when at bottom).
    const R_w = (this.bottomZoneHeight > 0) ? rows - this.bottomZoneHeight + 1 : 1
    const R_after = Math.min(rows, R_w + newRowsWritten)
    const T = rows - H_NEW + 1
    if (R_after <= T) {
      // Pad blank rows so zone bottoms out cleanly.
      for (let i = 0; i < T - R_after; i++) out.write('\r\n')
    } else {
      // Already past the target start row. Push content above row T into
      // scrollback by scrolling, then move cursor up to T. Writing H_NEW-1
      // newlines from row `rows` triggers H_NEW-1 scrolls; the up-move then
      // lands on the freshly-blank row T.
      for (let i = 0; i < H_NEW - 1; i++) out.write('\r\n')
      if (H_NEW > 1) out.write(`${CSI}${H_NEW - 1}A`)
    }

    // ── Phase 4: draw the bottom zone in place ────────────────────────────
    for (let i = 0; i < zoneLines.length; i++) {
      out.write(zoneLines[i] ?? '')
      if (i < zoneLines.length - 1) out.write('\r\n')
    }

    // ── Phase 5: park cursor in the input field ───────────────────────────
    const moveUp = (zoneLines.length - 1) - cursorRowInZone
    if (moveUp > 0) out.write(`${CSI}${moveUp}A`)
    out.write('\r')
    if (cursorCol > 0) out.write(`${CSI}${cursorCol}C`)

    this.bottomZoneHeight = H_NEW
    this.cursorOffsetFromZoneTop = cursorRowInZone

    out.write(SHOW_CURSOR)
  }
}

export function createBlessedPrompt(options: BlessedPromptOptions): BlessedPromptHandle {
  return new TerminalPrompt(options)
}
