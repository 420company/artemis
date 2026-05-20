/**
 * memory/soul.ts — SOUL.md personality loader
 *
 * ~/.artemis/soul.md lets users define the AI's personality, tone, and
 * preferences. The content is injected into every system prompt.
 *
 * Example soul.md:
 *   You have a sharp, direct personality. You prefer concise answers.
 *   You enjoy a bit of dry humor. Always push back on vague requirements.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveArtemisHomeDir } from '../utils/fs.js'

const SOUL_MAX_BYTES = 4_000

/** Load ~/.artemis/soul.md. Returns empty string if missing or unreadable. */
export async function loadSoul(): Promise<string> {
  const soulPath = join(resolveArtemisHomeDir(), 'soul.md')
  try {
    const raw = await readFile(soulPath, 'utf8')
    return raw.trim().slice(0, SOUL_MAX_BYTES)
  } catch {
    return ''
  }
}

/** Format soul content for injection into the system prompt. */
export function formatSoulForPrompt(soul: string): string {
  if (!soul) return ''
  return `\n\n---\n# AI Personality (soul.md)\n\n${soul}`
}
