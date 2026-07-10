/**
 * tools/memoryTool.ts — in-session long-term memory tool
 *
 * Lets the agent persist a memory the moment the user says "remember X" /
 * "以后都要 Y", instead of waiting for the session-end curator pass. Writes go
 * through storage/memoryFiles.ts, so all guards (size caps, shrink guard,
 * trash-instead-of-delete) apply here too.
 */

import type { ToolExecutionContext, ToolExecutionResult } from './types.js'
import {
  ensureMemoryMigrated,
  listMemories,
  saveMemory,
  trashMemory,
  scopesCollide,
  slugifyMemoryName,
  type MemoryScope,
} from '../storage/memoryFiles.js'

type MemoryAction = {
  type: 'memory'
  action: 'save' | 'update' | 'delete' | 'list'
  scope?: 'global' | 'project'
  name?: string
  description?: string
  category?: string
  content?: string
}

export async function executeMemoryTool(
  action: MemoryAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const cwd = context.cwd
  await ensureMemoryMigrated(cwd)
  const collided = scopesCollide(cwd)
  const scope: MemoryScope = collided ? 'global' : (action.scope === 'project' ? 'project' : 'global')

  try {
    if (action.action === 'list') {
      const entries = [
        ...(await listMemories(cwd, 'global')),
        ...(collided ? [] : await listMemories(cwd, 'project')),
      ]
      const lines = entries.map((e) => `[${e.scope}] ${e.name} [${e.category}] — ${e.description}`)
      return {
        action: action as any,
        ok: true,
        output: lines.length ? lines.join('\n') : 'No long-term memories recorded yet.',
      }
    }

    if (action.action === 'delete') {
      const name = String(action.name ?? '').trim()
      if (!name) return fail(action, 'delete requires name')
      const removed =
        (await trashMemory(cwd, 'global', name)) ||
        (!collided && (await trashMemory(cwd, 'project', name)))
      return removed
        ? { action: action as any, ok: true, output: `Memory "${slugifyMemoryName(name)}" moved to trash (recoverable via artemis memory restore).` }
        : fail(action, `no memory named "${name}"`)
    }

    // save / update
    const content = String(action.content ?? '').trim()
    const name = String(action.name ?? '').trim() || content.slice(0, 48)
    if (!content) return fail(action, `${action.action} requires content`)
    const result = await saveMemory(cwd, scope, {
      name,
      description: String(action.description ?? '').trim() || content.slice(0, 100),
      category: action.category,
      content,
      source: 'agent-explicit',
    }, { allowShrink: action.action === 'update' })
    if (!result.ok) return fail(action, result.reason ?? 'rejected')
    return {
      action: action as any,
      ok: true,
      output: `Memory ${result.op} (${scope}): ${result.name}`,
    }
  } catch (err: any) {
    return fail(action, err?.message ?? 'memory tool failed')
  }
}

function fail(action: MemoryAction, message: string): ToolExecutionResult {
  return {
    action: action as any,
    ok: false,
    output: message,
    error: { code: 'memory_tool_error', message, retryable: false },
  }
}
