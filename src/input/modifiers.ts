/**
 * macOS modifier key detection via native module.
 * Keyboard modifier helpers for terminal input.
 * Falls back to false on non-darwin platforms or if module not installed.
 */

import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

let prewarmed = false

export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') return
  prewarmed = true
  try {
    const { prewarm } = _require('modifiers-napi') as { prewarm: () => void }
    prewarm()
  } catch {
    // Module may not be installed — optional native enhancement
  }
}

export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') return false
  try {
    const { isModifierPressed: nativeCheck } =
      _require('modifiers-napi') as { isModifierPressed: (m: string) => boolean }
    return nativeCheck(modifier)
  } catch {
    return false
  }
}
