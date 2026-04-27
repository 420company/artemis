/**
 * utils/env.ts — minimal environment detection stub
 * Minimal environment helper exported for termio/osc.ts.
 */

function detectTerminal(): string {
  const term = process.env.TERM_PROGRAM ?? process.env.TERM ?? ''
  if (term.includes('kitty')) return 'kitty'
  if (term.includes('iTerm')) return 'iterm2'
  if (process.env.TMUX) return 'tmux'
  return term
}

export const env = {
  get terminal(): string {
    return detectTerminal()
  },
}
