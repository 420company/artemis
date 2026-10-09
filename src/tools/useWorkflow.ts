import type { AgentAction } from '../core/types.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

export const USE_WORKFLOW_DESCRIPTION = [
  'Switch the current task to a heavier workflow when it turns out bigger than it looked.',
  'plan = investigate, plan, then implement and verify; team = split a large job into independent parts (bounded parallel sub-agents);',
  'compare = weigh up to 3 alternative solutions, critique them, build the best; design = website/UI build with visual system, assets and screenshot check.',
  'Returns the playbook to follow. Use it only for real complexity, at most once per task; simple tasks need no workflow.',
].join(' ');

/** Returns the playbook for the chosen workflow; the runtime also raises the sub-agent budget (core/agent.ts). */
export async function executeUseWorkflow(
  action: Extract<AgentAction, { type: 'use_workflow' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const { buildEscalationPlaybook, ESCALATION_WORKFLOWS } = await import('../core/workflowRouter.js');
  if (!ESCALATION_WORKFLOWS.includes(action.workflow)) {
    return {
      action,
      ok: false,
      output: `Unknown workflow "${String(action.workflow)}". Use one of: ${ESCALATION_WORKFLOWS.join(', ')}.`,
    };
  }
  return {
    action,
    ok: true,
    output: buildEscalationPlaybook(action.workflow, context.cwd, action.reason),
  };
}
