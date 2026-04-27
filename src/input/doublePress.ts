/**
 * Double-press detector — calls one callback on first press, another on second
 * press within the timeout window.
 * Detect double-press gestures in the terminal UI.
 */

export const DOUBLE_PRESS_TIMEOUT_MS = 800

export type DoublePressHandler = () => void

export interface DoublePress {
  /** Call this whenever the key is pressed. */
  press(): void
  /** Cancel any pending first-press timeout. */
  cancel(): void
}

/**
 * Create a double-press handler.
 *
 * @param setPending  Called with true on first press, false on timeout/double.
 * @param onDoublePress  Called when a second press arrives within the timeout.
 * @param onFirstPress   Called on the first press (optional).
 */
export function createDoublePress(
  setPending: (pending: boolean) => void,
  onDoublePress: () => void,
  onFirstPress?: () => void,
): DoublePress {
  let lastPressTime = 0
  let timeout: NodeJS.Timeout | undefined

  const clearTimeoutSafe = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout)
      timeout = undefined
    }
  }

  return {
    press() {
      const now = Date.now()
      const isDoublePress = now - lastPressTime <= DOUBLE_PRESS_TIMEOUT_MS && timeout !== undefined
      lastPressTime = now

      if (isDoublePress) {
        clearTimeoutSafe()
        setPending(false)
        onDoublePress()
      } else {
        onFirstPress?.()
        setPending(true)
        clearTimeoutSafe()
        timeout = setTimeout(() => {
          setPending(false)
          timeout = undefined
        }, DOUBLE_PRESS_TIMEOUT_MS)
      }
    },

    cancel() {
      clearTimeoutSafe()
    },
  }
}
