/**
 * cli/artemisMd.ts — ARTEMIS.md / Artemis.md project instruction file loader
 *
 * Walks the cwd tree looking for ARTEMIS.md files. Their combined content is
 * appended to the system prompt so the AI knows project-specific conventions.
 *
 * Project instruction file convention:
 *   - Place a ARTEMIS.md in the repo root for global project instructions
 *   - Place more specific ARTEMIS.md files in sub-directories for local rules
 *   - All matching files are loaded and concatenated (alphabetical order)
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { walkFiles, pathExists } from '../utils/fs.js'
import { loadUserProfile, formatProfileForPrompt } from '../memory/userProfile.js'
import { loadSoul, formatSoulForPrompt } from '../memory/soul.js'

const INSTRUCTION_FILENAMES = ['ARTEMIS.md', 'artemis.md', 'Artemis.md', '.artemis.md']
const MAX_INSTRUCTION_BYTES = 64_000

/** Find all ARTEMIS.md files under `cwd`, sorted by path. */
export async function findInstructionFiles(cwd: string): Promise<string[]> {
  const names = new Set(INSTRUCTION_FILENAMES)
  let files: string[]
  try {
    files = await walkFiles(cwd)
  } catch {
    return []
  }
  return files
    .filter(f => names.has(path.basename(f)))
    .sort()
}

/** Load and concatenate all ARTEMIS.md content found under `cwd`. */
export async function loadProjectInstructions(cwd: string): Promise<string> {
  const files = await findInstructionFiles(cwd)
  const parts: string[] = []
  let totalBytes = 0

  for (const filePath of files) {
    if (!(await pathExists(filePath))) continue
    try {
      const content = await readFile(filePath, 'utf8')
      const remaining = MAX_INSTRUCTION_BYTES - totalBytes
      if (remaining <= 0) break
      const trimmed = content.slice(0, remaining).trim()
      if (!trimmed) continue
      const rel = path.relative(cwd, filePath)
      parts.push(`<!-- ${rel} -->\n${trimmed}`)
      totalBytes += trimmed.length
    } catch {
      // skip unreadable files
    }
  }

  return parts.join('\n\n---\n\n')
}

/** Build the system prompt suffix from project instruction files. */
export async function buildProjectInstructionSuffix(cwd: string): Promise<string> {
  const content = await loadProjectInstructions(cwd)
  if (!content) return ''
  return `\n\n---\n# Project Instructions (from ARTEMIS.md)\n\n${content}`
}

/**
 * Build the full system prompt suffix:
 * ARTEMIS.md project instructions + user profile (user.md).
 */
export async function buildFullSystemSuffix(cwd: string): Promise<string> {
  const [projectSuffix, userProfile, soul] = await Promise.all([
    buildProjectInstructionSuffix(cwd),
    loadUserProfile(),
    loadSoul(),
  ])
  const profileSection = formatProfileForPrompt(userProfile)
  const soulSection    = formatSoulForPrompt(soul)
  return [projectSuffix, profileSection, soulSection].filter(Boolean).join('')
}
