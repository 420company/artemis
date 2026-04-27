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

export type BridgePlatform = 'telegram' | 'discord' | 'wechat'

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

/** Register the active REPL's printAbove function. Pass null to unregister. */
export function setBridgePrinter(fn: ((payload: TerminalNotification) => void) | null): void {
  _printer = fn
}

/** Print a bridge notification into the active REPL, or drop if no REPL is active. */
export function notifyTerminal(payload: TerminalNotification): void {
  _printer?.(payload)
}
