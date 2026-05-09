/**
 * Idle watcher — singleton activity tracker that triggers the dream system
 * after the user has been inactive for ≥ idleThresholdSec.
 *
 * Activity sources (any of these calls markActivity()):
 *   - CLI prompt input commit
 *   - bridge inbound message intake
 *   - brain.think() entry
 *
 * Trigger algorithm:
 *   - check every 60s
 *   - if (now - lastActivity) >= idleThresholdSec:
 *       - if in night window (default 23:00-07:00 local): trigger immediately
 *       - if outside night window: still trigger, but only every other check
 *         (~50% chance per minute) to bias toward night without locking it out
 *   - after a successful compose, reset lastActivity so we don't re-fire
 *     while still idle
 */

import { composeDream } from './dreamComposer.js'
import { loadDreamConfig } from './dreamStore.js'
import type { UiLocale } from '../cli/locale.js'
import { DEFAULT_UI_LOCALE, pickLocale } from '../cli/locale.js'

let lastActivityAt = Date.now()
let watcherInterval: NodeJS.Timeout | null = null
let composeInFlight = false
let onComposeCallback: ((event: { ok: boolean; reason?: string; bridgesPushed?: number }) => void) | null = null
let onStatusCallback: ((text: string) => void) | null = null

const CHECK_INTERVAL_MS = 60_000

export function markActivity(): void {
  lastActivityAt = Date.now()
}

export function getLastActivityAt(): number {
  return lastActivityAt
}

export function isComposing(): boolean {
  return composeInFlight
}

export function setIdleStatusCallback(cb: ((text: string) => void) | null): void {
  onStatusCallback = cb
}

export function setIdleComposeCallback(
  cb: ((event: { ok: boolean; reason?: string; bridgesPushed?: number }) => void) | null,
): void {
  onComposeCallback = cb
}

function isInNightWindow(now: Date, startHour: number, endHour: number): boolean {
  const hour = now.getHours()
  // night window may wrap midnight (e.g. 23 → 7)
  if (startHour <= endHour) {
    return hour >= startHour && hour < endHour
  }
  return hour >= startHour || hour < endHour
}

export function startIdleWatcher(cwd: string, locale: UiLocale = DEFAULT_UI_LOCALE): () => void {
  if (watcherInterval) return () => stopIdleWatcher()

  let daytimeRollIndex = 0

  watcherInterval = setInterval(async () => {
    if (composeInFlight) return

    const config = await loadDreamConfig().catch(() => null)
    if (!config || !config.enabled || config.mode === 'off') return

    const idleSec = (Date.now() - lastActivityAt) / 1000
    if (idleSec < config.idleThresholdSec) return

    const now = new Date()
    const nightWin = config.nightWindow
    const isNight = isInNightWindow(now, nightWin.startHour, nightWin.endHour)
    if (!isNight) {
      // Daytime: 50% probability per check (~30 min effective extra delay).
      daytimeRollIndex += 1
      if (daytimeRollIndex % 2 !== 0) return
    }

    composeInFlight = true
    try {
      onStatusCallback?.(pickLocale(locale, { zh: '🌙 I\'m feeling trippy…', en: '🌙 dreaming…' }))
      const result = await composeDream({ cwd, trigger: 'idle-auto', locale, onStatus: onStatusCallback ?? undefined })
      onComposeCallback?.({
        ok: result.ok,
        reason: result.reason,
        bridgesPushed: result.bridgesPushed,
      })
      // Reset lastActivity so the next dream won't fire until the user is
      // active again and then idles out for another full threshold.
      lastActivityAt = Date.now()
    } catch (err) {
      onComposeCallback?.({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      })
    } finally {
      composeInFlight = false
      onStatusCallback?.('')
    }
  }, CHECK_INTERVAL_MS)

  // Don't keep the Node event loop alive just for this; if the user quits
  // the CLI the watcher dies cleanly with the process.
  watcherInterval.unref?.()

  return () => stopIdleWatcher()
}

export function stopIdleWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval)
    watcherInterval = null
  }
}
