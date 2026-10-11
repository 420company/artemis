/**
 * services/toolSideEffects.ts — whether running a tool again changes
 * something outside the conversation.
 *
 * Used before a retry: reading, searching and looking things up are safe to
 * repeat; writing files, running commands, generating media, sending
 * messages or calling outside services are not, and the host warns first.
 * Unknown tools count as side-effecting (the safe answer).
 */

import { isReadOnlyCommand } from '../security/commandPolicy.js';
import { getToolDefinition } from '../tools/registry.js';

/** Categories whose tools only read. */
const READ_ONLY_CATEGORIES = new Set(['read', 'none']);

/** Tools filed under a broader category that only look, ask or navigate. */
const HARMLESS = new Set(['request_user_confirmation', 'browser_navigate', 'browser_wait_for', 'browser_tabs', 'browser_close']);

export function toolHasSideEffects(name: string, action: Record<string, unknown> | undefined): boolean {
  if (HARMLESS.has(name)) return false;
  if (name === 'run_command') {
    const command = typeof action?.command === 'string' ? action.command : '';
    return !isReadOnlyCommand(command);
  }
  if (name === 'mcp_call_tool') return action?.readOnly !== true;
  const definition = getToolDefinition(name);
  if (!definition) return true;
  return !READ_ONLY_CATEGORIES.has(definition.permissionCategory);
}
