/**
 * On-disk companions of a session's context:
 *
 *   <dir>/transcript.jsonl   append-only archive of every message removed
 *                            from the live history by compaction
 *   <dir>/tool-results/      full tool outputs that were spilled on intake or
 *                            cleared later, one file per result
 *
 * Path A keeps `<dir>` next to the session JSON
 * (`<data root>/sessions/<session id>/`); path B uses the same layout under
 * the bridge or CLI session id, or a per-workspace directory otherwise.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { SessionMessage } from '../types.js'

export type ContextStorage = {
  readonly dir: string
  readonly transcriptPath: string
  readonly toolResultsDir: string
  /** Append messages to the transcript archive. Never rewrites earlier lines. */
  archiveMessages(messages: readonly SessionMessage[], meta: { compaction: number }): Promise<void>
  /** Write a full tool output to its own file and return the path. Synchronous so intake stays simple. */
  writeToolResult(label: string, content: string): string
}

function safeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80) || 'tool'
}

/** Remove inline image data before anything is persisted: images are per-request only. */
function stripImageData(blocks: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(blocks)) return blocks
  return blocks.map((block) => {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'image') {
      return { type: 'image', omitted: true }
    }
    return block
  })
}

export function sanitizeMessageForArchive(message: SessionMessage): SessionMessage {
  const copy: SessionMessage = { ...message }
  if (copy.contentBlocks) copy.contentBlocks = stripImageData(copy.contentBlocks)
  if (copy.rawContentBlocks) copy.rawContentBlocks = stripImageData(copy.rawContentBlocks)
  return copy
}

export function createContextStorage(dir: string): ContextStorage {
  const resolved = path.resolve(dir)
  const transcriptPath = path.join(resolved, 'transcript.jsonl')
  const toolResultsDir = path.join(resolved, 'tool-results')
  return {
    dir: resolved,
    transcriptPath,
    toolResultsDir,
    async archiveMessages(messages, meta) {
      if (messages.length === 0) return
      await mkdir(resolved, { recursive: true })
      const archivedAt = new Date().toISOString()
      const lines = messages.map((message) =>
        JSON.stringify({ archivedAt, compaction: meta.compaction, message: sanitizeMessageForArchive(message) }))
      await appendFile(transcriptPath, `${lines.join('\n')}\n`, 'utf8')
    },
    writeToolResult(label, content) {
      mkdirSync(toolResultsDir, { recursive: true })
      const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
      const filePath = path.join(toolResultsDir, `${Date.now()}-${safeLabel(label)}-${digest}.txt`)
      writeFileSync(filePath, content, 'utf8')
      return filePath
    },
  }
}
