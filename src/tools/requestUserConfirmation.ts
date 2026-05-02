import type { AgentAction } from '../core/types.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

export async function executeRequestUserConfirmation(
  action: Extract<AgentAction, { type: 'request_user_confirmation' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  if (!context.requestUserConfirmation) {
    return {
      action,
      ok: false,
      output: 'User confirmation is not available in this runtime.',
      error: {
        code: 'confirmation_unavailable',
        message: 'User confirmation is not available in this runtime.',
        retryable: false,
      },
    };
  }

  const accepted = await context.requestUserConfirmation({
    question: action.question,
    screenshotPath: action.screenshotPath,
    timeoutMs: action.timeoutMs,
  });

  return {
    action,
    ok: accepted,
    output: accepted
      ? 'User confirmed. Continue with the requested action.'
      : 'User declined or confirmation timed out. Stop before the sensitive action.',
    ...(accepted
      ? {}
      : {
          error: {
            code: 'confirmation_declined',
            message: 'User declined or confirmation timed out.',
            retryable: false,
          },
        }),
  };
}
