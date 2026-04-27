/**
 * ANSI-preserving text wrapper.
 * ANSI-aware wrapping helpers for the terminal UI.
 */

import wrapAnsiNpm from 'wrap-ansi'

type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

export const wrapAnsi: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string = wrapAnsiNpm
