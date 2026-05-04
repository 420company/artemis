/* eslint-disable @typescript-eslint/no-unused-vars, no-control-regex */
/**
 * prompt.ts — terminal input system
 *
 * Interactive prompt engine for plain Node.js:
 *   - ANSI tokenizer (termio/tokenize.ts) — correct split-sequence handling
 *   - parseMultipleKeypresses — full keyboard protocol support (Kitty CSI u,
 *     modifyOtherKeys, SGR mouse, bracketed paste, terminal responses)
 *   - InputEvent / key normalization for terminal handling
 *   - Cursor class — Unicode-aware text engine (grapheme segmentation, NFC
 *     normalization, word boundaries, viewport management, kill ring)
 *   - createDoublePress — safe double-Ctrl+C and double-Escape detection
 *
 * All React / Ink / Bun dependencies have been removed.
 */

import {
  Cursor,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  updateYankLength,
  yankPop,
} from '../input/Cursor.js'
import { createDoublePress } from '../input/doublePress.js'
import { InputEvent, type Key } from '../input/events/input-event.js'
import { isModifierPressed, prewarmModifiers } from '../input/modifiers.js'
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type KeyParseState,
  type ParsedKey,
} from '../input/parse-keypress.js'
import { stringWidth } from '../input/stringWidth.js'
import stripAnsi from 'strip-ansi'
import type { PromptIO } from '../providers/types.js'
import { createInterface, type Interface, emitKeypressEvents } from 'node:readline'

// ─── ANSI output helpers ─────────────────────────────────────────────────────

const CSI = '\x1b['

function cursorUp(n: number): string { return n > 0 ? `${CSI}${n}A` : '' }
function eraseDown(): string         { return `${CSI}J` }
function hideCursor(): string        { return `${CSI}?25l` }
function showCursor(): string        { return `${CSI}?25h` }
function bold(s: string): string     { return `${CSI}1m${s}${CSI}0m` }
function dim(s: string): string      { return `${CSI}2m${s}${CSI}0m` }
function green(s: string): string    { return `${CSI}32m${s}${CSI}0m` }
function cyan(s: string): string     { return `${CSI}36m${s}${CSI}0m` }
function invert(s: string): string   { return `${CSI}7m${s}${CSI}0m` }

// ─── Types ───────────────────────────────────────────────────────────────────

/** An entry in the slash-command popup menu. */
export interface SlashMenuItem {
  /** The command text, e.g. '/help' */
  value: string
  /** Short description shown to the right */
  hint: string
}

interface PromptOptions {
  prefix?: string
  suggestion?: string
  history?: string[]
  maxUndo?: number
  /** Called whenever the input text changes (not just on submit). */
  onTextChange?: (text: string) => void
  /**
   * Called on every draw; output is rendered above the separator+input area.
   * When fixedZoneLines is set, this is rendered in the fixed bottom zone.
   */
  headerFn?: () => string
  /**
   * When set, the prompt occupies a fixed zone of this many lines at the
   * bottom of the terminal. A DECSTBM scroll region is set so the scroll
   * area ends just above the fixed zone. The input area never scrolls away.
   *
   * Layout (fixedZoneLines = 6):
   *   rows-5: HUD top border
   *   rows-4: HUD content
   *   rows-3: HUD bottom border
   *   rows-2: top separator
   *   rows-1: prompt input line
   *   rows:   bottom separator
   * Scroll region: rows 1 .. (rows - fixedZoneLines)
   */
  fixedZoneLines?: number
  /**
   * Short hint text embedded in the bottom separator bar so users always see
   * key bindings. E.g. "Ctrl+J newline  Enter submit  ↑↓ history"
   */
  footerHint?: string
  /**
   * Optional callback used when a terminal shrink requires a full-screen
   * redraw. Called after the viewport is cleared and before the fixed zone is
   * re-established.
   */
  onViewportRedraw?: () => void
  /** Called after a full viewport redraw has re-established the fixed zone. */
  onAfterViewportRedraw?: () => void
}

interface FixedZoneLayout {
  top: number
  bottom: number
}

type ConfirmState = {
  title: string
  lines: string[]
  confirmLabel: string
  cancelLabel: string
  selected: 0 | 1
  resolve: (value: boolean) => void
  timeout: NodeJS.Timeout | null
}

// Undo entry: stores text + cursor offset
interface UndoEntry { text: string; offset: number }

function truncatePlainToWidth(text: string, maxWidth: number): string {
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

// ─── Prompt class ────────────────────────────────────────────────────────────

export class Prompt {
  private prefix: string
  private historyBuf: string[]
  private historyPos: number       // -1 = live input
  private historyDraft: string     // saved draft when navigating history

  // The current editing state as a Cursor instance.
  // Cursor.text = current string, Cursor.offset = code-unit position.
  private cursor: Cursor

  private undoStack: UndoEntry[]
  private maxUndo: number

  private suggestion: string
  private onTextChange?: (text: string) => void
  private headerFn?: () => string
  private fixedZoneLines: number | undefined
  private fixedZoneInitialized = false
  private lastRenderedLines: number
  private active: boolean
  private footerHint: string
  private onViewportRedraw?: () => void
  private onAfterViewportRedraw?: () => void
  private viewportLines: string[] = []
  private overlayDrawnRows = 0
  private confirmState: ConfirmState | null = null

  // Slash-command popup menu
  private menuItems: SlashMenuItem[] | null = null
  private menuIndex: number = 0

  // Dynamic fixed zone: tracks actual fz used so we can detect when it changes
  private currentFz: number = 0
  private lastFixedLayout: FixedZoneLayout | null = null
  private lastTerminalColumns: number = process.stdout.columns ?? 80
  private lastTerminalRows: number = process.stdout.rows ?? 24

  // Paste range: when a large paste is inserted we insert a compact placeholder
  // and store the real text here so Backspace removes the whole block at once
  // and submit() expands the placeholder back to real text before resolving.
  private lastPasteRange: { start: number; end: number; realText: string } | null = null

  // Typeahead: stdin stays active (raw mode) between read() calls so the user
  // can type while the AI is generating. Keystrokes are buffered and replayed
  // at the start of the next read().
  private typeaheadBuf = ''
  private typeaheadHandler: ((c: string) => void) | null = null
  private resizeTimer: NodeJS.Timeout | null = null

  // Confirm-dialog input: when confirm() is called outside an active read()
  // (e.g. from a slash-command handler like /newborn), typeahead alone just
  // buffers keystrokes and never dispatches. We install this dedicated listener
  // for the duration of the dialog and remove it in resolveConfirm().
  private confirmDataHandler: ((c: string) => void) | null = null

  private resolve?: (value: string | null) => void

  // Key-parser state (carries internal tokenizer + paste mode)
  private parseState: KeyParseState = INITIAL_STATE

  // Double-press detectors
  private doublePressCtrlC = createDoublePress(
    () => {/* no pending indicator needed */},
    () => this.exitWithNull(),
    () => { if (this.cursor.text) { this.setCursor(Cursor.fromText('', this.availWidth(), 0)); this.redraw() } },
  )

  private doublePressEscape = createDoublePress(
    () => {/* no indicator */},
    () => { if (this.cursor.text) { this.setCursor(Cursor.fromText('', this.availWidth(), 0)); this.redraw() } },
  )

  private doublePressCtrlD = createDoublePress(
    () => {/* no indicator */},
    () => { if (!this.cursor.text) this.exitWithNull() },
  )

  constructor(opts: PromptOptions = {}) {
    this.prefix = opts.prefix ?? '  > '
    this.historyBuf = opts.history ?? []
    this.historyPos = -1
    this.historyDraft = ''
    this.cursor = Cursor.fromText('', 80, 0)
    this.undoStack = []
    this.maxUndo = opts.maxUndo ?? 200
    this.suggestion = opts.suggestion ?? ''
    this.onTextChange = opts.onTextChange
    this.headerFn = opts.headerFn
    this.fixedZoneLines = opts.fixedZoneLines
    this.lastRenderedLines = 1
    this.active = false
    this.footerHint = opts.footerHint ?? ''
    this.onViewportRedraw = opts.onViewportRedraw
    this.onAfterViewportRedraw = opts.onAfterViewportRedraw

    // Pre-warm Apple Terminal modifier detection (safe no-op on other platforms)
    if (process.platform === 'darwin') prewarmModifiers()
  }

  setSuggestion(s: string): void {
    this.suggestion = s
    if (this.active) this.redraw()
  }

  setMenu(items: SlashMenuItem[] | null): void {
    this.menuItems = (items && items.length > 0) ? items : null
    this.menuIndex = 0
    if (this.active || this.fixedZoneInitialized) this.forceRedraw()
  }

  setViewportLines(lines: string[]): void {
    this.viewportLines = lines
    if (this.active || this.fixedZoneInitialized) this.forceRedraw()
  }

  async confirm(options: { title: string, lines?: string[], confirmLabel?: string, cancelLabel?: string, timeoutMs?: number }): Promise<boolean> {
    if (this.confirmState) this.resolveConfirm(false)

    // If we're outside an active read() (e.g. called from a slash handler),
    // the only stdin listener is the passive typeahead buffer. Swap it for a
    // dedicated key-event listener so arrows/enter/esc reach handleConfirmKey.
    const needsOwnListener = !this.active && process.stdin.isTTY
    if (needsOwnListener) {
      this.stopTypeahead()
      // Ensure stdin is in raw mode even if the caller came from releaseTerminal.
      try { process.stdin.setRawMode(true) } catch { /* ignore */ }
      process.stdin.resume()
      try { process.stdin.setEncoding('utf8') } catch { /* ignore */ }
      this.parseState = INITIAL_STATE
      this.confirmDataHandler = (chunk: string) => {
        // Ctrl+C during confirm: treat as cancel (don't kill the process).
        const [events, newState] = parseMultipleKeypresses(this.parseState, chunk)
        this.parseState = newState
        for (const ev of events) {
          if (ev.kind === 'key') this.handleKeyEvent(ev)
        }
      }
      process.stdin.on('data', this.confirmDataHandler)
    }

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
      this.forceRedraw()
    })
  }

  async releaseTerminal<T>(fn: () => Promise<T>): Promise<T> {
    const restoreFixedZone = Boolean(this.fixedZoneLines && process.stdout.isTTY)
    this.stopTypeahead()
    if (restoreFixedZone) this.teardownFixedZone()

    try {
      return await fn()
    } finally {
      if (restoreFixedZone) {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true)
          process.stdin.resume()
          process.stdin.setEncoding('utf8')
        }
        this.fixedZoneInitialized = true
        this.setupFixedZone()
        this.drawFixed()
        this.startTypeahead()
      }
    }
  }

  // ── public API ──────────────────────────────────────────────────────────────

  async read(): Promise<string | null> {
    const stdin = process.stdin

    if (!stdin.isTTY) return this.readLineFallback()

    // Stop typeahead buffering and capture any keystrokes typed during generation
    this.stopTypeahead()
    const bufferedInput = this.typeaheadBuf
    this.typeaheadBuf = ''

    this.active = true
    this.cursor = Cursor.fromText('', this.availWidth(), 0)
    this.historyPos = -1
    this.historyDraft = ''
    this.lastRenderedLines = 1
    this.parseState = INITIAL_STATE

    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    // Enable bracketed paste mode: terminal wraps paste events in
    // \x1b[200~ ... \x1b[201~ so the parser can route them to handlePastedText.
    process.stdout.write('\x1b[?2004h')

    if (this.fixedZoneLines && !this.fixedZoneInitialized) {
      this.setupFixedZone()
      this.fixedZoneInitialized = true
    }
    this.draw()

    return new Promise<string | null>(res => {
      const onData = (chunk: string) => {
        const [events, newState] = parseMultipleKeypresses(this.parseState, chunk)
        this.parseState = newState
        for (const ev of events) {
          if (ev.kind === 'key') {
            this.handleKeyEvent(ev)
          }
          // mouse and terminal responses are silently ignored
        }
      }

      // Handle terminal resize: always do a full viewport redraw.
      // Selective clearing (clearPreviousFixedZone only) leaves stale content
      // in the alt-screen buffer at newly revealed rows when the terminal grows.
      const onResize = () => {
        if (!this.active) return
        if (this.resizeTimer) clearTimeout(this.resizeTimer)
        this.resizeTimer = setTimeout(() => {
          this.resizeTimer = null
          if (this.fixedZoneLines) {
            this.fullViewportRedraw()
          } else {
            const linesToClear = Math.max(this.lastRenderedLines + 2, 4)
            process.stdout.write('\r\x1b[' + linesToClear + 'A\x1b[J')
            this.lastRenderedLines = 1
            this.draw()
          }
        }, process.platform === 'win32' ? 90 : 40)
      }

      const cleanup = () => {
        stdin.removeListener('data', onData)
        process.stdout.removeListener('resize', onResize)
        if (this.resizeTimer) clearTimeout(this.resizeTimer)
        this.resizeTimer = null
        // Disable bracketed paste mode before switching to typeahead mode
        process.stdout.write('\x1b[?2004l')
        this.active = false
        this.doublePressCtrlC.cancel()
        this.doublePressEscape.cancel()
        this.doublePressCtrlD.cancel()
        // Keep stdin active (raw mode) so the user can type while AI generates.
        // Keystrokes are buffered and replayed at the start of the next read().
        this.startTypeahead()
      }

      this.resolve = (v) => { cleanup(); res(v) }
      stdin.on('data', onData)
      process.stdout.on('resize', onResize)

      // Replay any keystrokes typed during the previous AI generation turn
      if (bufferedInput) {
        queueMicrotask(() => onData(bufferedInput))
      }
    })
  }

  private readLineFallback(): Promise<string | null> {
    return new Promise<string | null>(res => {
      const stdin = process.stdin
      stdin.resume()
      stdin.setEncoding('utf8')
      let buf = ''
      const onData = (chunk: string) => {
        buf += chunk
        const idx = buf.indexOf('\n')
        if (idx !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          stdin.removeListener('data', onData)
          stdin.removeListener('end', onEnd)
          stdin.pause()
          res(line)
        }
      }
      const onEnd = () => { stdin.removeListener('data', onData); res(buf.length > 0 ? buf.replace(/\r$/, '') : null) }
      stdin.on('data', onData)
      stdin.on('end', onEnd)
    })
  }

  close(): void { this.resolve?.(null) }

  // ── key dispatch ────────────────────────────────────────────────────────────

  private handleKeyEvent(parsed: ParsedKey): void {
    if (this.confirmState) {
      this.handleConfirmKey(parsed)
      return
    }

    if (parsed.isPasted) {
      this.handlePastedText(parsed.sequence ?? '')
      return
    }

    const ev = new InputEvent(parsed)
    const { key, input } = ev

    // ── SSH/tmux fix: raw DEL chars (\x7f) without key.backspace flag ────────
    // In some SSH/tmux setups, backspace sends \x7f but the parser doesn't set
    // key.backspace. Count them and apply as backspace operations.
    // cursor movement and word navigation
    if (!key.backspace && !key.delete && input.includes('\x7f')) {
      const delCount = (input.match(/\x7f/g) ?? []).length
      let cur = this.cursor
      for (let i = 0; i < delCount; i++) {
        cur = cur.deleteTokenBefore() ?? cur.backspace()
      }
      if (!this.cursor.equals(cur)) this.setCursor(cur)
      resetKillAccumulation()
      resetYankState()
      return
    }

    // ── kill / yank state tracking ───────────────────────────────────────────
    const isKill = (key.ctrl && (input === 'k' || input === 'u' || input === 'w')) ||
                   (key.meta && (key.backspace || key.delete))
    const isYank = (key.ctrl || key.meta) && input === 'y'
    if (!isKill) resetKillAccumulation()
    if (!isYank) resetYankState()

    // ── map key to cursor operation ──────────────────────────────────────────
    const next = this.mapKey(key, input)
    if (next !== undefined) {
      this.setCursor(next)
    }
  }

  private handleConfirmKey(parsed: ParsedKey): void {
    if (!this.confirmState) return

    const ev = new InputEvent(parsed)
    const { key, input } = ev
    const lower = input.toLowerCase()

    if (key.upArrow || key.leftArrow) {
      if (this.confirmState.selected !== 0) {
        this.confirmState.selected = 0
        this.forceRedraw()
      }
      return
    }
    if (key.downArrow || key.rightArrow || key.tab) {
      if (this.confirmState.selected !== 1) {
        this.confirmState.selected = 1
        this.forceRedraw()
      }
      return
    }
    if (key.return) {
      this.resolveConfirm(this.confirmState.selected === 0)
      return
    }
    if (key.escape || (key.ctrl && input === 'c') || lower === 'n') {
      this.resolveConfirm(false)
      return
    }
    if (lower === 'y') {
      this.resolveConfirm(true)
    }
  }

  private mapKey(key: Key, input: string): Cursor | undefined {
    // ── slash-command popup menu navigation ───────────────────────────────────
    if (this.menuItems && this.menuItems.length > 0) {
      if (key.upArrow && !key.ctrl && !key.meta) {
        this.menuIndex = this.menuIndex > 0 ? this.menuIndex - 1 : this.menuItems.length - 1
        return this.cursor  // no text change, just redraw
      }
      if (key.downArrow && !key.ctrl && !key.meta) {
        this.menuIndex = this.menuIndex < this.menuItems.length - 1 ? this.menuIndex + 1 : 0
        return this.cursor
      }
      if (key.return) {
        const item = this.menuItems[this.menuIndex]
        if (item) {
          this.menuItems = null
          this.suggestion = ''
          // Insert the selected command (with a trailing space so onTextChange won't re-open the menu)
          const newText = item.value + ' '
          return Cursor.fromText(newText, this.availWidth(), newText.length)
        }
        return undefined
      }
      if (key.escape) {
        this.menuItems = null
        this.suggestion = ''
        return this.cursor
      }
    }

    // Escape — double-press to clear
    if (key.escape) {
      this.doublePressEscape.press()
      return undefined
    }

    // Arrow word movement with modifier
    if (key.leftArrow && (key.ctrl || key.meta || key.fn)) return this.cursor.prevWord()
    if (key.rightArrow && (key.ctrl || key.meta || key.fn)) return this.cursor.nextWord()

    // Backspace / Delete
    if (key.backspace) {
      if (key.meta || key.ctrl) return this.killWordBeforeOp()
      // If cursor is right at the end of a paste block (placeholder or real text),
      // delete the whole block in one keystroke.
      if (this.lastPasteRange && this.cursor.offset === this.lastPasteRange.end) {
        const { start, end } = this.lastPasteRange
        this.lastPasteRange = null
        this.pushUndo()
        const newText = this.cursor.text.slice(0, start) + this.cursor.text.slice(end)
        return Cursor.fromText(newText, this.availWidth(), start)
      }
      return this.cursor.deleteTokenBefore() ?? this.cursor.backspace()
    }
    if (key.delete) {
      if (key.meta) return this.killToLineEndOp()
      return this.cursor.del()
    }

    // Ctrl bindings
    if (key.ctrl) {
      switch (input) {
        case 'a': return this.cursor.startOfLine()
        case 'b': return this.cursor.left()
        case 'c':
          if (!this.cursor.text) {
            this.exitWithNull()
            return undefined
          }
          this.doublePressCtrlC.press()
          return undefined
        case 'd': {
          if (!this.cursor.text) { this.doublePressCtrlD.press(); return undefined }
          return this.cursor.del()
        }
        case 'e': return this.cursor.endOfLine()
        case 'f': return this.cursor.right()
        case 'h': return this.cursor.deleteTokenBefore() ?? this.cursor.backspace()
        case 'k': return this.killToLineEndOp()
        case 'n': return this.historyDownOrCursorDown()
        case 'p': return this.historyUpOrCursorUp()
        case 'u': return this.killToLineStartOp()
        case 'w': return this.killWordBeforeOp()
        case 'y': return this.yankOp()
      }
      return undefined
    }

    // Home / End / PageUp / PageDown
    if (key.home) return this.cursor.startOfLine()
    if (key.end)  return this.cursor.endOfLine()
    if (key.pageUp)   return this.historyUpOrCursorUp()
    if (key.pageDown) return this.historyDownOrCursorDown()

    // Enter
    if (key.return) {
      // Meta+Enter or Shift+Enter → insert newline
      if (key.meta || key.shift) return this.insertWithUndo('\n')
      // Apple Terminal Shift+Enter detection
      if (process.platform === 'darwin' && isModifierPressed('shift')) {
        return this.insertWithUndo('\n')
      }
      // Backslash+Enter → newline (replace \ with \n)
      const text = this.cursor.text
      if (text[this.cursor.offset - 1] === '\\') {
        return this.cursor.backspace().insert('\n')
      }
      this.submit()
      return undefined
    }

    // Meta bindings
    if (key.meta) {
      switch (input) {
        case 'b': return this.cursor.prevWord()
        case 'f': return this.cursor.nextWord()
        case 'd': return this.deleteWordAfterOp()
        case 'y': return this.yankPopOp()
        // Alt+Enter (input-event strips the ESC, leaving \r or \n as input)
        case '\r':
        case '\n': return this.insertWithUndo('\n')
      }
      return undefined
    }

    // Tab — accept ghost-text suggestion if one is set, otherwise no-op
    if (key.tab) {
      if (this.suggestion) return this.cursor.insert(this.suggestion)
      return undefined
    }

    // Up / Down arrows (history or cursor movement)
    if (key.upArrow && !key.shift)   return this.historyUpOrCursorUp()
    if (key.downArrow && !key.shift) return this.historyDownOrCursorDown()

    // Left / Right arrows
    if (key.leftArrow)  return this.cursor.left()
    if (key.rightArrow) return this.cursor.right()

    // Default: printable text (also handles SSH-coalesced Enter)
    if (input === '') return undefined

    // Strip ANSI escape codes from raw keyboard input — malformed terminal
    // data can leak escape sequences into the text stream.
    // single-key submit
    const cleaned = stripAnsi(input)
      // SSH-coalesced Enter: trailing \r after non-special content
      // ("hello\r" → strip the \r so the content inserts without triggering submit)
      // Backslash+\r is VS Code Shift+Enter keybinding — keep for \n conversion
      // eslint-disable-next-line no-useless-escape
      .replace(/(?<=[^\\\r\n])\r$/, '')
      .replace(/\r/g, '\n')

    if (cleaned === '') return undefined

    // SSH-coalesced Enter: original input ended in \r (stripped above) AND
    // has actual text content → insert text then submit.
    // On Windows, raw-mode chunks can also contain pasted text ending with CR,
    // so avoid auto-submitting there.
    if (process.platform !== 'win32' && input.length > 1 && input.endsWith('\r') &&
        !input.slice(0, -1).includes('\r') &&
        input[input.length - 2] !== '\\') {
      const newCursor = this.insertWithUndo(cleaned)
      this.resolve?.(newCursor.text)
      return undefined
    }

    return this.insertWithUndo(cleaned)
  }

  // ── cursor update + redraw ──────────────────────────────────────────────────

  private setCursor(next: Cursor): void {
    const textChanged = next.text !== this.cursor.text
    if (!next.equals(this.cursor)) {
      this.cursor = next
    }
    this.redraw()
    if (textChanged) {
      this.onTextChange?.(this.cursor.text)
      // Invalidate paste range if the user typed something after the paste
      // (cursor moved past end means they're editing beyond the placeholder)
      if (this.lastPasteRange && this.cursor.offset > this.lastPasteRange.end) {
        this.lastPasteRange = null
      }
    }
  }

  // ── editing operations (return new Cursor) ──────────────────────────────────

  private insertWithUndo(text: string): Cursor {
    this.pushUndo()
    return this.cursor.insert(text)
  }

  private killToLineEndOp(): Cursor {
    this.pushUndo()
    const { cursor: next, killed } = this.cursor.deleteToLineEnd()
    pushToKillRing(killed, 'append')
    return next
  }

  private killToLineStartOp(): Cursor {
    this.pushUndo()
    const { cursor: next, killed } = this.cursor.deleteToLineStart()
    pushToKillRing(killed, 'prepend')
    return next
  }

  private killWordBeforeOp(): Cursor {
    this.pushUndo()
    const { cursor: next, killed } = this.cursor.deleteWordBefore()
    pushToKillRing(killed, 'prepend')
    return next
  }

  private deleteWordAfterOp(): Cursor {
    this.pushUndo()
    const nextCursor = this.cursor.deleteWordAfter()
    // deleteWordAfter() doesn't return the killed text, compute it from the diff
    const killedText = this.cursor.text.slice(
      this.cursor.offset,
      this.cursor.offset + (this.cursor.text.length - nextCursor.text.length)
    )
    if (killedText) pushToKillRing(killedText, 'append')
    return nextCursor
  }

  private yankOp(): Cursor {
    const text = getLastKill()
    if (!text) return this.cursor
    this.pushUndo()
    const startOffset = this.cursor.offset
    const newCursor = this.cursor.insert(text)
    recordYank(startOffset, text.length)
    return newCursor
  }

  private yankPopOp(): Cursor {
    const popResult = yankPop()
    if (!popResult) return this.cursor
    const { text, start, length } = popResult
    const before = this.cursor.text.slice(0, start)
    const after = this.cursor.text.slice(start + length)
    const newText = before + text + after
    const newOffset = start + text.length
    updateYankLength(text.length)
    return Cursor.fromText(newText, this.availWidth(), newOffset)
  }

  // ── history & multi-line navigation ─────────────────────────────────────────

  private historyUpOrCursorUp(): Cursor | undefined {
    const up = this.cursor.up()
    if (!up.equals(this.cursor)) return up
    this.historyUp()
    return undefined
  }

  private historyDownOrCursorDown(): Cursor | undefined {
    const down = this.cursor.down()
    if (!down.equals(this.cursor)) return down
    this.historyDown()
    return undefined
  }

  private historyUp(): void {
    if (this.historyBuf.length === 0) return
    if (this.historyPos === -1) {
      this.historyDraft = this.cursor.text
      this.historyPos = this.historyBuf.length - 1
    } else if (this.historyPos > 0) {
      this.historyPos--
    } else {
      return
    }
    this.loadHistory()
  }

  private historyDown(): void {
    if (this.historyPos === -1) return
    if (this.historyPos < this.historyBuf.length - 1) {
      this.historyPos++
      this.loadHistory()
    } else {
      this.historyPos = -1
      const text = this.historyDraft
      this.cursor = Cursor.fromText(text, this.availWidth(), text.length)
      this.redraw()
    }
  }

  private loadHistory(): void {
    const entry = this.historyBuf[this.historyPos]!
    this.cursor = Cursor.fromText(entry, this.availWidth(), entry.length)
    this.redraw()
  }

  // ── paste ────────────────────────────────────────────────────────────────────

  // Threshold: pastes above this size get a visual summary shown in the scroll
  // region above the input, so the fixed-zone row doesn't get flooded.
  private static readonly LARGE_PASTE_LINES = 5
  private static readonly LARGE_PASTE_CHARS = 300

  private handlePastedText(text: string): void {
    // Sanitise: remove control chars except \n and \t
    const sanitised = text.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '')
    const normalised = sanitised.replace(/\r\n?/g, '\n')
    if (!normalised) return

    const lineCount = (normalised.match(/\n/g) ?? []).length + 1
    const charCount = normalised.length
    const isLarge   = lineCount > Prompt.LARGE_PASTE_LINES || charCount > Prompt.LARGE_PASTE_CHARS

    const pasteStart = this.cursor.offset
    this.pushUndo()

    if (isLarge) {
      // Insert a single-line placeholder — keeps the input compact.
      // The real text is stored in lastPasteRange and expanded on submit().
      const placeholder = `[📎 ${lineCount} lines, ${charCount} chars  —  Backspace removes]`
      this.cursor = this.cursor.insert(placeholder)
      const pasteEnd = this.cursor.offset
      this.lastPasteRange = { start: pasteStart, end: pasteEnd, realText: normalised }
    } else {
      this.cursor = this.cursor.insert(normalised)
      const pasteEnd = this.cursor.offset
      // Track small multi-line pastes too so Backspace can remove them at once
      if (normalised.includes('\n')) {
        this.lastPasteRange = { start: pasteStart, end: pasteEnd, realText: normalised }
      }
    }

    this.redraw()
  }

  // ── undo ─────────────────────────────────────────────────────────────────────

  private pushUndo(): void {
    this.undoStack.push({ text: this.cursor.text, offset: this.cursor.offset })
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift()
  }

  private undoOp(): void {
    const snap = this.undoStack.pop()
    if (!snap) return
    this.cursor = Cursor.fromText(snap.text, this.availWidth(), snap.offset)
    this.redraw()
  }

  // ── submit / exit ─────────────────────────────────────────────────────────

  private submit(): void {
    const value = this.cursor.text
    this.lastPasteRange = null  // clear on submit
    if (this.fixedZoneLines) {
      // Erase all input rows and reset DECSTBM back to base fz (single input line)
      const rows = process.stdout.rows ?? 24
      const fz   = this.currentFz > 0 ? this.currentFz : this.computeFz(rows)
      const baseFz = 4  // HUD + top-sep + 1 input line + bottom-sep
      const scrollBottom = rows - baseFz
      const firstInputRow = rows - (fz - 3)
      process.stdout.write(hideCursor())
      // Clear all input rows
      for (let r = firstInputRow; r <= rows - 1; r++) {
        process.stdout.write(`\x1b[${r};1H\r\x1b[2K`)
      }
      // Reset DECSTBM to base fz
      process.stdout.write(`\x1b[1;${scrollBottom}r`)
      process.stdout.write(`\x1b[${scrollBottom};1H`)
      this.currentFz = baseFz
      // Keep cursor hidden — it will be shown again by drawFixed() on next read()
    } else {
      this.clearInputArea()
      process.stdout.write('\n')
    }
    // Expand any paste placeholder back to the real text before sending
    let submitValue = value
    if (this.lastPasteRange) {
      const { start, end, realText } = this.lastPasteRange
      submitValue = value.slice(0, start) + realText + value.slice(end)
      this.lastPasteRange = null
    }
    if (submitValue.trim() && this.historyBuf[this.historyBuf.length - 1] !== submitValue) {
      this.historyBuf.push(submitValue)
    }
    this.resolve?.(submitValue)
  }

  private exitWithNull(): void {
    this.lastPasteRange = null
    if (this.fixedZoneLines) {
      const rows = process.stdout.rows ?? 24
      const baseFz = 4
      const scrollBottom = rows - baseFz
      process.stdout.write(hideCursor())
      process.stdout.write(`\x1b[1;${scrollBottom}r`)
      process.stdout.write(`\x1b[${scrollBottom};1H`)
    } else {
      this.clearInputArea()
      process.stdout.write('\n')
    }
    this.resolve?.(null)
  }

  // ── fixed zone setup / teardown ───────────────────────────────────────────

  /**
   * Establish the DECSTBM scroll region so that the top (rows - fixedZoneLines)
   * rows scroll normally while the bottom fixedZoneLines rows stay fixed.
   *
   * DECSTBM (\x1b[Pt;Pbr) moves the cursor to row 1 as a VT100 spec side
   * effect, so we save/restore with DECSC/DECRC (\x1b7 / \x1b8).
   */
  private setupFixedZone(): void {
    const rows = process.stdout.rows ?? 24
    // Start with base fz (single input line); drawFixed() will grow it dynamically.
    const baseFz = this.fixedZoneLines ?? 4
    const scrollBottom = rows - baseFz
    if (scrollBottom < 1) return  // terminal too small

    this.currentFz = baseFz

    const out = process.stdout
    out.write(hideCursor())
    out.write(`\x1b[1;${scrollBottom}r`)          // DECSTBM — cursor jumps to row 1
    out.write(`\x1b[${scrollBottom};1H`)          // explicit: move cursor to scroll bottom
    // cursor stays hidden; drawFixed() will position and show it
  }

  /**
   * Remove the scroll region (restore full-screen scrolling) and position the
   * cursor at the end of the scroll area so subsequent output is natural.
   * Call this only when the process is truly exiting.
   */
  // ── typeahead (stdin buffering between read() calls) ──────────────────────

  private startTypeahead(): void {
    if (!process.stdin.isTTY) return
    this.typeaheadBuf = ''
    this.typeaheadHandler = (chunk: string) => {
      if (chunk === '\x03') {
        // Ctrl+C during AI generation: clean exit
        this.stopTypeahead()
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.exit(0)
      }
      this.typeaheadBuf += chunk
    }
    process.stdin.on('data', this.typeaheadHandler)
  }

  private stopTypeahead(): void {
    if (this.typeaheadHandler) {
      process.stdin.removeListener('data', this.typeaheadHandler)
      this.typeaheadHandler = null
    }
  }

  teardownFixedZone(): void {
    // Stop typeahead and restore terminal to normal (cooked) mode before exit
    this.stopTypeahead()
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    const rows = process.stdout.rows ?? 24
    const fz   = this.currentFz > 0 ? this.currentFz : (this.fixedZoneLines ?? 4)
    const out  = process.stdout
    const scrollBottom = rows - fz
    // Restore full-screen scroll region; cursor jumps to row 1 as side effect,
    // then explicitly reposition to just above the fixed zone.
    out.write(`\x1b[1;${rows}r`)
    out.write(`\x1b[${scrollBottom};1H`)
    out.write(showCursor())
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private availWidth(): number {
    const cols = Math.max(20, (process.stdout.columns ?? 80) - 1)
    return Math.max(10, cols - stringWidth(this.prefix))
  }

  /**
   * Compute the actual fixed zone height for the current input.
   * fz = 3 (HUD + top-sep + bottom-sep) + clamped input line count.
   * Maximum input lines: 8, or half the terminal height minus headroom.
   */
  private computeFz(rows: number): number {
    if (!this.fixedZoneLines) return 0
    const inputLines = (this.cursor.text.match(/\n/g) ?? []).length + 1
    const maxInputLines = Math.max(1, Math.min(8, Math.floor((rows - 6) / 2)))
    return 3 + Math.min(inputLines, maxInputLines)
  }

  private clearInputArea(): void {
    const out = process.stdout
    if (this.fixedZoneLines) {
      // In fixed mode, only clear the prompt input line — leave HUD/separators alone
      const rows = process.stdout.rows ?? 24
      const promptRow = rows - 1
      out.write(`\x1b[${promptRow};1H\r\x1b[2K`)
      return
    }
    if (this.lastRenderedLines > 1) out.write(cursorUp(this.lastRenderedLines - 1))
    // Erase each line individually (\x1b[2K = erase whole line, cursor stays).
    // Using eraseDown() (\x1b[J) can wipe the entire visible screen when the
    // prompt sits at the very top of the viewport — causing the "black screen" effect.
    for (let i = 0; i < this.lastRenderedLines; i++) {
      out.write('\r\x1b[2K')
      if (i < this.lastRenderedLines - 1) out.write('\n')
    }
    if (this.lastRenderedLines > 1) out.write(cursorUp(this.lastRenderedLines - 1))
    this.lastRenderedLines = 1
  }

  private clearPreviousFixedZone(): void {
    if (!process.stdout.isTTY) return
    const layout = this.lastFixedLayout
    if (!layout) return
    const out = process.stdout
    const visibleBottom = Math.min(layout.bottom, out.rows ?? layout.bottom)
    if (visibleBottom < layout.top) return
    out.write(hideCursor())
    for (let r = layout.top; r <= visibleBottom; r++) {
      out.write(`\x1b[${r};1H\r\x1b[2K`)
    }
  }

  private fullViewportRedraw(): void {
    const out = process.stdout
    const rows = out.rows ?? 24
    out.write(hideCursor())
    if (process.platform === 'win32') {
      // Windows Terminal reflows the backing buffer while resizing. Resetting
      // scroll margins alone can leave old wrapped fixed-zone frames in view.
      out.write('\x1b[0m\x1b[3J\x1b[2J\x1b[H')
    }
    // In native mode: just reset scroll region without clearing display
    out.write('\x1b[r')           // Reset margins to full screen
    out.write(`\x1b[1;${rows}r`)  // Set new margins
    out.write('\x1b[H')           // Home (top-left)
    this.lastFixedLayout = null
    this.overlayDrawnRows = 0
    this.onViewportRedraw?.()
    this.setupFixedZone()
    this.drawFixed()
    this.onAfterViewportRedraw?.()
  }

  private redraw(): void {
    if (this.fixedZoneLines) {
      this.drawFixed()
      return
    }
    this.clearInputArea()
    this.draw()
  }

  /** Force a full redraw of the fixed zone (HUD + separators + input + cursor).
   *  Call this after external code has updated the HUD state so the prompt
   *  reclaims the cursor and repositions it correctly in the input field. */
  forceRedraw(): void {
    if (this.fixedZoneLines) this.drawFixed()
  }

  mountViewport(): void {
    if (!process.stdout.isTTY) return
    if (this.fixedZoneLines) {
      this.fixedZoneInitialized = true
      this.fullViewportRedraw()
      return
    }
    this.draw()
  }

  clearBuffer(): void {
    this.typeaheadBuf = ''
    this.cursor = Cursor.fromText('', this.availWidth(), 0)
    this.viewportLines = []
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true)
        let chunk: string | Buffer | null
        while ((chunk = process.stdin.read()) !== null) { void chunk }
      } catch { /* non-fatal */ }
    }
  }

  /** Draw input into the fixed bottom zone using absolute cursor positioning. */
  private drawFixed(): void {
    const out = process.stdout
    const rows = process.stdout.rows ?? 24
    const cols = Math.min(process.stdout.columns ?? 80, 120)
    const sep  = dim('─'.repeat(cols))

    // ── Dynamic fixed zone height ─────────────────────────────────────────────
    // fz = 3 (HUD + top-sep + bottom-sep) + clamped input line count.
    // Layout (fz = 3 + N, N = visible input lines):
    //   rows - fz + 1           : HUD line
    //   rows - fz + 2           : top separator
    //   rows - fz + 3 … rows-1  : input lines  (N rows)
    //   rows                    : bottom separator
    //   scroll region: 1 .. rows-fz
    const newFz = this.computeFz(rows)
    const scrollBottom = rows - newFz
    const fixedTop = rows - newFz + 1

    if (scrollBottom < 1) return  // terminal too small

    out.write(hideCursor())

    // Update DECSTBM if the fixed-zone height changed
    if (newFz !== this.currentFz) {
      // Clear rows that are transitioning from input area to scroll region (shrink)
      if (newFz < this.currentFz) {
        for (let r = rows - this.currentFz + 1; r < rows - newFz + 1; r++) {
          if (r > 0) out.write(`\x1b[${r};1H\r\x1b[2K`)
        }
      }
      out.write(`\x1b[1;${scrollBottom}r`)   // new DECSTBM
      out.write(`\x1b[${scrollBottom};1H`)   // park cursor at scroll bottom
      this.currentFz = newFz
    }

    const overlayRows = this.drawOverlayRows(scrollBottom, cols)
    const paintedTop = overlayRows > 0
      ? Math.max(1, scrollBottom - overlayRows + 1)
      : fixedTop

    // ── HUD ───────────────────────────────────────────────────────────────────
    if (this.headerFn) {
      const hudRow = fixedTop
      out.write(`\x1b[${hudRow};1H\r\x1b[2K${this.headerFn()}`)
    }

    // ── top separator ─────────────────────────────────────────────────────────
    const topSepRow = fixedTop + 1
    out.write(`\x1b[${topSepRow};1H\r\x1b[2K${sep}`)

    // ── input lines ──────────────────────────────────────────────────────────
    // N input lines occupy rows (rows-N) … (rows-1).
    // We render up to N visible lines from the text using the Cursor viewport.
    const inputLines = newFz - 3   // = clamped text line count
    const firstInputRow = rows - inputLines  // = rows - (newFz-3)
    const w = this.availWidth()
    const cur = Cursor.fromText(this.cursor.text, w, this.cursor.offset)
    const ghostText = this.suggestion
      ? { text: this.suggestion, dim: (s: string) => dim(s) }
      : undefined

    const rendered = cur.render(' ', '', invert, ghostText, inputLines)
    const renderedLines = rendered.split('\n')
    const prefixStr = bold(green(this.prefix))
    const padStr    = ' '.repeat(stringWidth(this.prefix))

    for (let i = 0; i < inputLines; i++) {
      const row  = firstInputRow + i
      const line = renderedLines[i] ?? ''
      out.write(`\x1b[${row};1H\r\x1b[2K${i === 0 ? prefixStr : padStr}${line}`)
    }

    // ── bottom separator / hint bar ──────────────────────────────────────────
    if (this.footerHint) {
      const maxHintWidth = Math.max(0, cols - 4)
      const hintText = truncatePlainToWidth(this.footerHint, maxHintWidth)
      const hintRaw = ` ${hintText} `
      const hintLen = stringWidth(hintRaw)
      const left    = dim('──')
      const right   = dim('─'.repeat(Math.max(0, cols - 2 - hintLen)))
      out.write(`\x1b[${rows};1H\r\x1b[2K${left}${dim(hintRaw)}${right}`)
    } else {
      out.write(`\x1b[${rows};1H\r\x1b[2K${sep}`)
    }

    // ── terminal cursor position ──────────────────────────────────────────────
    // line/column from Cursor, then map viewport line → terminal row.
    const { line: cursorLine, column: cursorColumn } = cur.getPosition()
    const viewportStart = cur.getViewportStartLine(inputLines)
    const cursorRow = firstInputRow + (cursorLine - viewportStart)
    const prefixWidth = stringWidth(this.prefix)
    // col 1-indexed; first input row has the prefix, continuation rows have pad
    const cursorCol = prefixWidth + cursorColumn + 1
    out.write(`\x1b[${cursorRow};${cursorCol}H`)
    out.write(showCursor())
    this.lastFixedLayout = { top: paintedTop, bottom: rows }
    this.lastTerminalColumns = process.stdout.columns ?? cols
    this.lastTerminalRows = rows
  }

  private resolveConfirm(value: boolean): void {
    if (!this.confirmState) return
    const state = this.confirmState
    this.confirmState = null
    if (state.timeout) clearTimeout(state.timeout)
    // If confirm() installed its own stdin listener, tear it down and restore
    // the passive typeahead buffer so the main loop can keep reading input.
    if (this.confirmDataHandler) {
      process.stdin.removeListener('data', this.confirmDataHandler)
      this.confirmDataHandler = null
      if (!this.active) this.startTypeahead()
    }
    state.resolve(value)
    this.forceRedraw()
  }

  private buildConfirmLines(cols: number): string[] {
    if (!this.confirmState) return []
    const state = this.confirmState

    // Pretty framed card: wider than the raw strings, centered, with a warm
    // amber border so destructive prompts read as "stop and think" rather than
    // as another status line. Width clamped to [48, cols-4].
    const plainTitle = state.title
    const plainBody = state.lines.filter(Boolean)
    const longest = Math.max(
      stringWidth(plainTitle),
      ...plainBody.map(l => stringWidth(l)),
      stringWidth(state.confirmLabel) + stringWidth(state.cancelLabel) + 14,
    )
    const inner = Math.max(44, Math.min(cols - 4, longest + 6))
    const pad = Math.max(0, Math.floor((cols - inner - 2) / 2))
    const lp = ' '.repeat(pad)

    const AMBER = `${CSI}38;2;255;196;106m`
    const AMBER_BOLD = `${CSI}1;38;2;255;196;106m`
    const ROSE = `${CSI}38;2;255;120;155m`
    const MINT = `${CSI}38;2;166;227;161m`
    const amber = (s: string): string => `${AMBER}${s}${CSI}0m`
    const amberBold = (s: string): string => `${AMBER_BOLD}${s}${CSI}0m`
    const rose = (s: string): string => `${ROSE}${s}${CSI}0m`
    const mint = (s: string): string => `${MINT}${s}${CSI}0m`

    const padCentered = (text: string): string => {
      const w = stringWidth(text)
      const leftSpace = Math.max(0, Math.floor((inner - w) / 2))
      const rightSpace = Math.max(0, inner - w - leftSpace)
      return ' '.repeat(leftSpace) + text + ' '.repeat(rightSpace)
    }

    const border = (left: string, fill: string, right: string): string =>
      `${lp}${amber(left + fill.repeat(inner) + right)}`

    const row = (content: string): string =>
      `${lp}${amber('│')}${content}${amber('│')}`

    // NOTE: avoid narrow-emoji prefixes like ⚠ here — their reported vs
    // rendered width differ across terminals and silently break the frame.
    const titleText = amberBold(plainTitle)
    const titleRow = row(padCentered(titleText))

    const bodyRows = plainBody.map(line => row(padCentered(line)))

    // Button row with soft padding. Mint for confirm, rose for cancel.
    const yesRaw = ` ${state.confirmLabel} `
    const noRaw  = ` ${state.cancelLabel} `
    const gap = dim('    ')
    const yesPainted = state.selected === 0
      ? invert(mint(yesRaw))
      : mint(`[${state.confirmLabel}]`)
    const noPainted = state.selected === 1
      ? invert(rose(noRaw))
      : rose(`[${state.cancelLabel}]`)
    const btnBar = `${yesPainted}${gap}${noPainted}`
    const btnRow = row(padCentered(btnBar))

    const hintRow = row(padCentered(dim('← → 选择   Enter 确认   Esc 取消')))

    return [
      '',
      border('╭', '─', '╮'),
      row(' '.repeat(inner)),
      titleRow,
      row(' '.repeat(inner)),
      ...bodyRows,
      row(' '.repeat(inner)),
      btnRow,
      row(' '.repeat(inner)),
      hintRow,
      border('╰', '─', '╯'),
    ]
  }

  private buildMenuLines(cols: number): string[] {
    const items = this.menuItems
    if (!items || items.length === 0) return []

    const maxValueWidth = Math.min(
      Math.max(...items.map(i => stringWidth(i.value))),
      Math.max(8, Math.floor((cols - 6) / 2)),
    )
    const lines = [dim('─'.repeat(cols))]

    for (let i = 0; i < Math.min(items.length, 10); i++) {
      const item = items[i]!
      const isSelected = i === this.menuIndex
      const valueRaw = truncatePlainToWidth(item.value, maxValueWidth)
      const valuePad = valueRaw.padEnd(Math.max(valueRaw.length, maxValueWidth))
      const hintWidth = Math.max(0, cols - 4 - maxValueWidth - 2)
      const hintText = truncatePlainToWidth(item.hint, hintWidth)

      lines.push(
        isSelected
          ? `  ${bold(cyan(valuePad))}  ${bold(cyan(hintText))}`
          : `  ${cyan(valuePad)}  ${dim(hintText)}`,
      )
    }

    return lines
  }

  private currentOverlayLines(cols: number): string[] {
    if (this.confirmState) return this.buildConfirmLines(cols)
    if (this.menuItems && this.menuItems.length > 0) return this.buildMenuLines(cols)
    return this.viewportLines
  }

  private drawOverlayRows(scrollBottom: number, cols: number): number {
    const out = process.stdout
    const lines = this.currentOverlayLines(cols)
    const nextRows = Math.min(scrollBottom, lines.length)

    if (nextRows === 0) {
      if (this.overlayDrawnRows > 0) {
        const prevStart = Math.max(1, scrollBottom - this.overlayDrawnRows + 1)
        for (let r = prevStart; r <= scrollBottom; r++) {
          out.write(`\x1b[${r};1H\r\x1b[2K`)
        }
      }
      this.overlayDrawnRows = 0
      return 0
    }

    const startRow = Math.max(1, scrollBottom - nextRows + 1)
    const prevStart = Math.max(1, scrollBottom - this.overlayDrawnRows + 1)
    for (let r = prevStart; r < startRow; r++) {
      out.write(`\x1b[${r};1H\r\x1b[2K`)
    }

    const visibleLines = lines.slice(-nextRows)
    for (let i = 0; i < visibleLines.length; i++) {
      const row = startRow + i
      out.write(`\x1b[${row};1H\r\x1b[2K${visibleLines[i]}`)
    }

    this.overlayDrawnRows = nextRows
    return nextRows
  }

  /**
   * Print text into the scroll region without disrupting the prompt/HUD.
   * Safe to call from background tasks (bridge notifications, etc.).
   */
  printAbove(text: string): void {
    const out = process.stdout
    if (!out.isTTY || !this.fixedZoneLines) {
      out.write(text + '\n')
      return
    }
    const rows = out.rows ?? 24
    // Use currentFz if already computed, otherwise use the base value
    const fz = this.currentFz > 0 ? this.currentFz : this.computeFz(rows)
    const scrollBottom = rows - fz

    out.write(hideCursor())
    // Move to bottom of scroll region and write each line.
    // '\n' at scrollBottom scrolls the region up one line, keeping cursor there.
    out.write(`\x1b[${scrollBottom};1H`)
    for (const line of text.split('\n')) {
      out.write(`\r\x1b[2K${line}\n`)
    }
    // Redraw the fixed zone (HUD + separators + input)
    this.drawFixed()
  }

  private draw(): void {
    if (this.fixedZoneLines) {
      this.drawFixed()
      return
    }
    const out = process.stdout
    const w = this.availWidth()

    // Rebuild cursor with current terminal width (handles window resize)
    const cur = Cursor.fromText(this.cursor.text, w, this.cursor.offset)

    // Ghost suggestion shown when cursor is at end
    const ghostText = this.suggestion
      ? { text: this.suggestion, dim: (s: string) => dim(s) }
      : undefined

    // Render full content (multi-line allowed in non-fixed mode)
    const rendered = cur.render(' ', '', invert, ghostText)
    const lines = rendered.split('\n')
    const prefixStr = bold(green(this.prefix))
    const padStr = ' '.repeat(stringWidth(this.prefix))

    // Header (HUD or any content pinned above the input)
    const headerStr  = this.headerFn ? this.headerFn() : ''

    // Separator line spanning the terminal width
    const cols = Math.min(process.stdout.columns ?? 80, 120)
    const sep = dim('─'.repeat(cols))

    let output = ''
    if (headerStr) output += headerStr + '\n'   // ── header ──
    output += sep + '\n'                        // ── top separator ──
    for (let i = 0; i < lines.length; i++) {
      output += (i === 0 ? prefixStr : padStr) + lines[i]
      if (i < lines.length - 1) output += '\n'
    }
    output += '\n' + sep                        // ── bottom separator ──

    out.write(hideCursor() + output + showCursor())
    const headerLines = headerStr.length > 0 ? headerStr.split('\n').length : 0
    this.lastRenderedLines = lines.length + 2 + headerLines
  }
}

// ─── factory ──────────────────────────────────────────────────────────────────

export interface PromptHandle {
  read(): Promise<string | null>
  setSuggestion(s: string): void
  /** Show/update the slash-command popup menu. Pass null or empty array to hide. */
  setMenu(items: SlashMenuItem[] | null): void
  /** Draw transient content just above the fixed input zone. */
  setViewportLines(lines: string[]): void
  close(): void
  /** Restore full-screen scrolling; call before process.exit() when fixedZoneLines is set. */
  dispose(): void
  /** Temporarily yield the terminal to a full-screen or line-oriented subflow. */
  releaseTerminal<T>(fn: () => Promise<T>): Promise<T>
  /** Print text into the scroll region without disrupting the prompt/HUD. */
  printAbove(text: string): void
  /** Initialize the viewport before the first read so landing and prompt share one render path. */
  mountViewport(): void
  /** Force a full fixed-zone redraw (HUD + input + cursor) after external HUD updates.
   *  This is the correct way to refresh the display after AI turns — it reclaims
   *  the cursor and positions it in the input field, eliminating stray cursors. */
  forceRedraw(): void
  /** Discard pending stdin/typeahead buffered while an external wizard owned the terminal. */
  clearBuffer(): void
  confirm(options: { title: string, lines?: string[], confirmLabel?: string, cancelLabel?: string, timeoutMs?: number }): Promise<boolean>
  history: string[]
}

interface PromptFactoryOptions {
  prefix?: string
  suggestion?: string
  history?: string[]
  maxUndo?: number
  onTextChange?: (text: string) => void
  headerFn?: () => string
  fixedZoneLines?: number
  footerHint?: string
  onViewportRedraw?: () => void
  onAfterViewportRedraw?: () => void
}

export function createPrompt(opts: PromptFactoryOptions = {}): PromptHandle {
  const history: string[] = opts.history ?? []
  const p = new Prompt({ ...opts, history })
  return {
    read: () => p.read(),
    setSuggestion: (s) => p.setSuggestion(s),
    setMenu: (items) => p.setMenu(items),
    setViewportLines: (lines) => p.setViewportLines(lines),
    mountViewport: () => p.mountViewport(),
    close: () => p.close(),
    dispose: () => p.teardownFixedZone(),
    releaseTerminal: (fn) => p.releaseTerminal(fn),
    printAbove: (text) => p.printAbove(text),
    forceRedraw: () => p.forceRedraw(),
    clearBuffer: () => p.clearBuffer(),
    confirm: (options) => p.confirm(options),
    history,
  }
}

// ─── Interactive selection helpers ───────────────────────────────────────────
// These are used by providers/router.ts, providers/onboarding.ts,
// security/permissions.ts, core/hoderActivation.ts, etc.

export type PromptMenuChoice<T> = {
  label: string
  value: T
  description?: string
}

export type PromptMenuOptions<T> = {
  title: string
  choices: Array<PromptMenuChoice<T>>
  initialIndex?: number
  hint?: string
  escapeValue?: T
}

/**
 * Interactive arrow-key menu selection.
 * Falls back to default choice when stdin is not a TTY.
 */
export async function chooseInteractiveOption<T>(
  options: PromptMenuOptions<T>,
): Promise<T> {
  if (options.choices.length === 0) {
    return options.choices[0]?.value as T
  }

  const isTTY = process.stdin.isTTY && process.stdout.isTTY
  if (!isTTY) {
    const idx = Math.min(Math.max(options.initialIndex ?? 0, 0), options.choices.length - 1)
    return options.choices[idx].value
  }

  process.stdin.resume()
  process.stdin.setRawMode?.(true)

  let selectedIndex = Math.min(
    Math.max(options.initialIndex ?? 0, 0),
    options.choices.length - 1,
  )

  // Count how many terminal screen lines a rendered string occupies.
  // Strip ANSI, then use terminal column width to compute wrapped rows.
  const screenLines = (text: string): number => {
    const cols = process.stdout.columns || 80
    const visible = stringWidth(stripAnsi(text))
    return Math.max(1, Math.ceil(visible / cols))
  }

  // Build the lines array. Only push description line when present.
  const buildLines = (): string[] => {
    const lines: string[] = []
    lines.push(`  \x1b[1m${options.title}\x1b[0m`)
    for (let i = 0; i < options.choices.length; i++) {
      const ch = options.choices[i]
      const sel = i === selectedIndex
      
      // Highlight "Done" or "Finish" related labels in choices
      const isDoneAction = ch.label.includes('完成') || ch.label.includes('Done') || ch.label.includes('Finish')
      
      let label = ch.label
      if (sel) {
        label = `\x1b[1;32m>\x1b[0m \x1b[1;33m${label}\x1b[0m` // Selection: Green arrow + Yellow Bold
      } else if (isDoneAction) {
        label = `  \x1b[1;35m${label}\x1b[0m` // Finish Action: Magenta Bold
      } else {
        label = `  \x1b[38;5;252m${label}\x1b[0m` // Unselected: Light gray (visible but not prominent)
      }
      
      lines.push(`  ${label}`)
      if (ch.description) {
        lines.push(`    \x1b[2m${ch.description}\x1b[0m`)
      }
    }
    // Hint line: High-contrast Cyan
    const defaultHint = '↑↓ 移动  Enter 确认  Esc 取消'
    lines.push(`  \x1b[1;36m${options.hint ?? defaultHint}\x1b[0m`)
    return lines
  }

  // Track total screen lines rendered last time so we can erase exactly that many.
  let lastScreenLines = 0

  const render = (): void => {
    const lines = buildLines()
    const totalScreenLines = lines.reduce((sum, l) => sum + screenLines(l), 0)
    const moveUp = lastScreenLines > 0 ? `\x1b[${lastScreenLines}A` : ''
    process.stdout.write(`\r${moveUp}\x1b[J` + lines.join('\n') + '\n')
    lastScreenLines = totalScreenLines
  }

  // Reserve vertical space, then immediately render into that space.
  const initialLines = buildLines()
  const initialScreenLines = initialLines.reduce((sum, l) => sum + screenLines(l), 0)
  process.stdout.write('\n'.repeat(initialScreenLines))
  lastScreenLines = initialScreenLines  // so render() moves up correctly on first call
  render()

  return new Promise<T>((resolve, reject) => {
    let resolved = false
    
    const cleanup = (): void => {
      if (resolved) return
      resolved = true
      process.stdin.off('keypress', onKeypress)
      process.stdin.setRawMode?.(false)
      if (!process.stdin.isPaused()) process.stdin.pause()
    }

    const onKeypress = (_ch: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
      if (!key || resolved) return
      if (key.ctrl && key.name === 'c') {
        cleanup()
        // If escapeValue is defined, use it instead of rejecting
        if (options.escapeValue !== undefined) {
          resolve(options.escapeValue)
        } else {
          reject(new Error('Selection cancelled.'))
        }
        return
      }
      if (key.name === 'up') {
        selectedIndex = selectedIndex === 0 ? options.choices.length - 1 : selectedIndex - 1
        render(); return
      }
      if (key.name === 'down') {
        selectedIndex = selectedIndex === options.choices.length - 1 ? 0 : selectedIndex + 1
        render(); return
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup(); resolve(options.choices[selectedIndex].value); return
      }
      if (key.name === 'escape') {
        cleanup()
        if (options.escapeValue !== undefined) { resolve(options.escapeValue); return }
        reject(new Error('Selection cancelled.')); return
      }
      const n = Number(key.sequence)
      if (Number.isInteger(n) && n >= 1 && n <= options.choices.length) {
        selectedIndex = n - 1; render()
      }
    }

    // Always call emitKeypressEvents - it's safe to call multiple times
    emitKeypressEvents(process.stdin)
    process.stdin.on('keypress', onKeypress)
  })
}

/**
 * Choose via PromptIO if available, otherwise fall back to interactive or default.
 */
export async function choosePromptOption<T>(
  promptIO: PromptIO | undefined,
  options: PromptMenuOptions<T>,
): Promise<T> {
  if (promptIO?.choose) {
    return promptIO.choose(options)
  }
  if (promptIO?.available) {
    return chooseInteractiveOption(options)
  }
  const idx = Math.min(Math.max(options.initialIndex ?? 0, 0), Math.max(options.choices.length - 1, 0))
  return options.choices[idx]?.value as T
}

/**
 * Ask a yes/no question via PromptIO.
 */
export async function choosePromptBoolean(
  promptIO: PromptIO | undefined,
  options: {
    title: string
    yesLabel: string
    noLabel: string
    yesDescription?: string
    noDescription?: string
    defaultValue?: boolean
    hint?: string
  },
): Promise<boolean> {
  return choosePromptOption(promptIO, {
    title: options.title,
    initialIndex: options.defaultValue === false ? 1 : 0,
    hint: options.hint,
    escapeValue: false,
    choices: [
      { label: options.yesLabel, value: true, description: options.yesDescription },
      { label: options.noLabel, value: false, description: options.noDescription },
    ],
  })
}

/**
 * Create a PromptIO backed by readline for interactive use.
 */
/**
 * Ask one line of plain text via a fresh readline interface.
 * Safe to call after chooseInteractiveOption (which leaves stdin paused).
 * Creates a new rl per call so there is no shared-state issue.
 */
function askLineOnce(prompt: string): Promise<string> {
  return new Promise<string>(resolve => {
    // Ensure stdin is available in cooked (non-raw) mode before readline.
    if ((process.stdin as NodeJS.ReadStream).isTTY) {
      try { (process.stdin as NodeJS.ReadStream).setRawMode(false) } catch { /* non-TTY */ }
    }
    process.stdin.resume()

    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let done = false
    const finish = (answer: string) => {
      if (done) return
      done = true
      rl.close()
      resolve(answer)
    }
    // resolve BEFORE close so the 'close' fallback never wins the race
    rl.question(prompt, answer => finish(answer))
    rl.once('close', () => finish(''))
  })
}

export function createInteractivePromptIO(_options?: { rl?: Interface }): PromptIO {
  const isTTY = process.stdin.isTTY && process.stdout.isTTY
  if (!isTTY) {
    return {
      available: false,
      ask: async () => '',
      write: () => {},
      choose: async ({ choices, initialIndex = 0 }) =>
        choices[Math.min(Math.max(initialIndex, 0), choices.length - 1)].value,
    }
  }

  return {
    available: true,
    ask(prompt: string, mask = false): Promise<string> {
      if (mask) {
        return new Promise<string>((resolve) => {
          // Ensure stdin is available in cooked (non-raw) mode before readline.
          if ((process.stdin as NodeJS.ReadStream).isTTY) {
            try { (process.stdin as NodeJS.ReadStream).setRawMode(true) } catch { /* non-TTY */ }
          }
          process.stdin.resume()
          process.stdin.setEncoding('utf8')
          
          process.stdout.write(prompt)
          let buf = ''

          const maskDisplay = (s: string): string => {
            if (s.length === 0) return ''
            if (s.length <= 8) return '*'.repeat(s.length)
            return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4)
          }

          const onData = (ch: string) => {
            if (ch === '\r' || ch === '\n') {
              process.stdin.setRawMode(false)
              process.stdin.pause()
              process.stdin.removeListener('data', onData)
              process.stdout.write('\n')
              resolve(buf)
            } else if (ch === '\u0003') {
              process.stdin.setRawMode(false)
              process.stdin.pause()
              process.stdin.removeListener('data', onData)
              process.stdout.write('\n')
              resolve('')
            } else if (ch === '\u007f' || ch === '\b') {
              if (buf.length > 0) {
                const prevMasked = maskDisplay(buf)
                buf = buf.slice(0, -1)
                const newMasked = maskDisplay(buf)
                process.stdout.write(
                  '\b'.repeat(prevMasked.length) +
                  newMasked +
                  ' '.repeat(Math.max(0, prevMasked.length - newMasked.length)) +
                  '\b'.repeat(Math.max(0, prevMasked.length - newMasked.length))
                )
              }
            } else if (ch >= ' ') {
              const prevMasked = maskDisplay(buf)
              buf += ch
              const newMasked = maskDisplay(buf)
              if (prevMasked.length > 0) process.stdout.write('\b'.repeat(prevMasked.length))
              process.stdout.write(newMasked)
            }
          }
          
          process.stdin.on('data', onData)
        })
      }
      return askLineOnce(prompt)
    },
    async choose(menuOptions) {
      return chooseInteractiveOption(menuOptions)
    },
    write(message: string) {
      process.stdout.write(message + '\n')
    },
    close() { /* no shared rl to close */ },
  }
}
