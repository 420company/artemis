import { TerminalEvent } from './terminal-event.js'

/**
 * Paste event. Fired when bracketed paste data arrives from the terminal.
 * Bubbles from the focused component upward.
 */
export class PasteEvent extends TerminalEvent {
  readonly text: string

  constructor(text: string) {
    super('paste', { bubbles: true, cancelable: false })
    this.text = text
  }
}
