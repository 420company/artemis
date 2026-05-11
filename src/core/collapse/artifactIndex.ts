/**
 * collapse/artifactIndex.ts — Tool Output Artifact Index
 *
 * Instead of keeping large tool outputs (file reads, command logs,
 * search results) in the conversation history, store them as
 * artifacts on disk and keep only a lightweight index entry
 * in the message. This is what ClaudeCode calls "tool result storage"
 * and "cache_reference/cache_edits" — the core of its microcompact.
 *
 * Flow:
 *   1. Tool output arrives → if > threshold, save to disk artifact
 *   2. Replace message content with: index + head snippet + summary
 *   3. On recovery, we can re-read the artifact if needed
 */

import { writeFile, readFile, readdir, stat, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const ARTIFACT_BASE_DIR = path.join(
  process.env.HOME || process.cwd(),
  '.artemis',
  'tmp',
  'tool-artifacts',
)

const TOOL_OUTPUT_INLINE_CHAR_LIMIT = 4_000
const TOOL_OUTPUT_HEAD_CHARS = 800
const TOOL_OUTPUT_TAIL_CHARS = 400

export interface ArtifactIndex {
  /** Artifact ID */
  id: string
  /** Original tool name */
  toolName: string
  /** File path on disk */
  artifactPath: string
  /** Content hash */
  contentHash: string
  /** Content length */
  contentLength: number
  /** When it was stored */
  storedAt: string
}

/**
 * If tool output exceeds the inline limit, save as artifact
 * and return a lightweight replacement string.
 * Otherwise return the content unchanged.
 */
export async function maybeStoreToolArtifact(
  sessionId: string,
  toolName: string,
  content: string,
): Promise<{ content: string; artifact?: ArtifactIndex }> {
  if (content.length <= TOOL_OUTPUT_INLINE_CHAR_LIMIT) {
    return { content }
  }

  const id = `art-${Date.now()}-${createHash('sha256').update(content).digest('hex').slice(0, 8)}`
  const dir = path.join(ARTIFACT_BASE_DIR, sessionId)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  const artifactPath = path.join(dir, `${id}.json`)
  await writeFile(artifactPath, content, 'utf-8')

  const artifact: ArtifactIndex = {
    id,
    toolName,
    artifactPath,
    contentHash: createHash('sha256').update(content).digest('hex'),
    contentLength: content.length,
    storedAt: new Date().toISOString(),
  }

  // Build lightweight replacement
  const head = content.slice(0, TOOL_OUTPUT_HEAD_CHARS)
  const tail = content.slice(-TOOL_OUTPUT_TAIL_CHARS)
  const replacement = [
    head,
    '',
    `...[工具输出已归档，共 ${content.length.toLocaleString()} 字符，保留首尾]`,
    `artifact_id: ${id}`,
    `tool: ${toolName}`,
    '',
    tail,
  ].join('\n')

  return { content: replacement, artifact }
}

/**
 * Load the full content of a stored artifact.
 */
export async function loadToolArtifact(artifactPath: string): Promise<string | null> {
  try {
    return await readFile(artifactPath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Load artifact by ID (searches in session's artifact dir).
 */
export async function loadToolArtifactById(
  sessionId: string,
  artifactId: string,
): Promise<string | null> {
  const artifactPath = path.join(ARTIFACT_BASE_DIR, sessionId, `${artifactId}.json`)
  return loadToolArtifact(artifactPath)
}

/**
 * Clean up all artifacts for a session.
 */
export async function cleanupSessionArtifacts(sessionId: string): Promise<void> {
  const dir = path.join(ARTIFACT_BASE_DIR, sessionId)
  try {
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true })
    }
  } catch {
    // Best-effort
  }
}

/**
 * Get total size of artifacts for a session.
 */
export async function getSessionArtifactSize(sessionId: string): Promise<number> {
  const dir = path.join(ARTIFACT_BASE_DIR, sessionId)
  if (!existsSync(dir)) return 0

  try {
    const files = await readdir(dir)
    let totalSize = 0
    for (const file of files) {
      const fp = path.join(dir, file)
      const info = await stat(fp)
      totalSize += info.size
    }
    return totalSize
  } catch {
    return 0
  }
}
