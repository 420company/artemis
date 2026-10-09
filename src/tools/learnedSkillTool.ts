/**
 * tools/learnedSkillTool.ts — load_skill: read one learned skill in full.
 *
 * The per-run runtime context lists only the relevant skills' ids and
 * one-line descriptions (see core/skillLearning.ts); this tool returns the
 * whole procedure on demand and counts the load as a use. Read-only apart
 * from that counter.
 */

import type { ToolExecutionContext, ToolExecutionResult } from './types.js'
import { listAllSkills, readSkill, recordSkillUse } from '../storage/skillStore.js'
import { formatSkillForModel } from '../core/skillLearning.js'

type LoadSkillAction = { type: 'load_skill'; id: string }

export async function executeLoadSkill(
  action: LoadSkillAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const id = String(action.id ?? '').trim()
  if (!id) return fail(action, 'load_skill requires id')
  try {
    const skill = await readSkill(context.cwd, id)
    if (!skill) {
      const known = (await listAllSkills(context.cwd)).slice(0, 20).map((entry) => entry.id)
      return fail(action, known.length
        ? `No learned skill "${id}". Known ids: ${known.join(', ')}`
        : `No learned skill "${id}" (no skills learned yet).`)
    }
    const used = (await recordSkillUse(context.cwd, skill.id)) ?? skill
    return { action: action as any, ok: true, output: formatSkillForModel(used) }
  } catch (err: any) {
    return fail(action, err?.message ?? 'load_skill failed')
  }
}

function fail(action: LoadSkillAction, message: string): ToolExecutionResult {
  return {
    action: action as any,
    ok: false,
    output: message,
    error: { code: 'load_skill_error', message, retryable: false },
  }
}
