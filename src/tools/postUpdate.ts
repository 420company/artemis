import type { AgentAction } from '../core/types.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

/** post_update: a short progress message the user sees at once (core/agentUpdates.ts). */
export async function executePostUpdate(
  action: Extract<AgentAction, { type: 'post_update' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  if (!context.postUpdate) {
    const message = 'Live updates are not available here; the user reads your replies directly. Put the progress in your reply instead.';
    return { action, ok: false, output: message, error: { code: 'updates_unavailable', message, retryable: false } };
  }
  const result = context.postUpdate(action.text);
  if (!result.ok) {
    return { action, ok: false, output: result.message, error: { code: result.code, message: result.message, retryable: result.retryable } };
  }
  return {
    action: { ...action, text: result.update.text },
    ok: true,
    output: `Shown to the user (update ${result.update.seq}). Keep working; do not repeat it in your final reply.`,
    data: { updateId: result.update.id },
  };
}
