import { TerminalEvent } from './terminal-event.js'

/**
 * Terminal resize event. Fired when the terminal window dimensions change.
 * Does not bubble.
 */
export class ResizeEvent extends TerminalEvent {
  readonly columns: number
  readonly rows: number

  constructor(columns: number, rows: number) {
    super('resize', { bubbles: false, cancelable: false })
    this.columns = columns
    this.rows = rows
  }
}
