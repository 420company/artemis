/**
 * cli/bridgeNotify.ts — singleton terminal notification channel for bridges.
 *
 * Bridges run as background tasks; this module lets them print messages into
 * the interactive REPL's scroll region without corrupting the prompt/HUD.
 *
 * Usage:
 *   - interactive.ts calls setBridgePrinter(text => prompt.printAbove(text))
 *     when the REPL starts, and setBridgePrinter(null) when it exits.
 *   - runCli.ts passes notifyTerminal as onNotify to each bridge.
 */

export type BridgePlatform = 'telegram' | 'discord' | 'wechat' | 'cli'

export type BridgeMessageTerminalEvent = {
  kind: 'bridge-message'
  platform: BridgePlatform
  direction: 'inbound' | 'outbound'
  targetLabel: string
  text: string
}

export type BridgeStatusTerminalEvent = {
  kind: 'bridge-status'
  platform: BridgePlatform
  targetLabel: string
  text: string
  level?: 'info' | 'warn' | 'error'
}

export type BridgeTerminalEvent = BridgeMessageTerminalEvent | BridgeStatusTerminalEvent

export type TerminalNotification = string | BridgeTerminalEvent

let _printer: ((payload: TerminalNotification) => void) | null = null
const pending: TerminalNotification[] = []
const MAX_PENDING_NOTIFICATIONS = 20

/** Register the active REPL's printAbove function. Pass null to unregister. */
export function setBridgePrinter(fn: ((payload: TerminalNotification) => void) | null): void {
  _printer = fn
  if (!_printer) return
  const buffered = pending.splice(0)
  for (const payload of buffered) _printer(payload)
}

/** Print a bridge notification into the active REPL, or buffer briefly until it mounts. */
export function notifyTerminal(payload: TerminalNotification): void {
  if (_printer) {
    _printer(payload)
    return
  }
  pending.push(payload)
  while (pending.length > MAX_PENDING_NOTIFICATIONS) pending.shift()
}
