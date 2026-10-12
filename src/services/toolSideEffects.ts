/**
 * services/toolSideEffects.ts — whether running a tool again changes
 * something outside the conversation.
 *
 * Used before a retry: reading, searching and looking things up are safe to
 * repeat; writing files, running commands, generating media, research
 * (it writes a report and may cost money), sending messages, publishing,
 * paying or calling outside services are not, and the host warns first.
 *
 * What a tool may do is decided from what the engine knows itself: the tool
 * registry, and for MCP tools the descriptor the MCP server published (its
 * readOnlyHint). Arguments the model wrote (such as `readOnly: true`) are
 * never trusted. Unknown tools count as side-effecting.
 */

import { buildProjectedMcpToolName } from '../core/providerNativeTools.js';
import { McpServerStore } from '../mcp/store.js';
import { isReadOnlyCommand } from '../security/commandPolicy.js';
import { getToolDefinition } from '../tools/registry.js';
import type { SideEffectClassifier } from '../storage/sessionTurns.js';

/** Categories whose tools only read. */
const READ_ONLY_CATEGORIES = new Set(['read', 'none']);

/** Tools filed under a broader category that only look, ask or navigate. */
const HARMLESS = new Set(['request_user_confirmation', 'browser_navigate', 'browser_wait_for', 'browser_tabs', 'browser_close']);

/** Filed as reading in the registry, but they write files or spend all the same. */
const ALWAYS_SIDE_EFFECTS = new Set(['deep_research']);

/** MCP tools the servers declared read-only, by projected name (`mcp__<server>__<tool>`). */
export type McpReadOnlyIndex = ReadonlySet<string>;

/** The name a host shows for a tool use: MCP calls as `mcp__<server>__<tool>`, so they can be named in words. */
export function toolUseName(name: string, action: Record<string, unknown> | undefined): string {
  if (name === 'mcp_call_tool' && typeof action?.serverId === 'string' && typeof action?.toolName === 'string') {
    return buildProjectedMcpToolName(action.serverId, action.toolName);
  }
  return name;
}

export function toolHasSideEffects(
  name: string,
  action: Record<string, unknown> | undefined,
  mcpReadOnly: McpReadOnlyIndex = new Set(),
): boolean {
  if (ALWAYS_SIDE_EFFECTS.has(name)) return true;
  if (HARMLESS.has(name)) return false;
  if (name === 'run_command') {
    const command = typeof action?.command === 'string' ? action.command : '';
    return !isReadOnlyCommand(command);
  }
  const mcpName = toolUseName(name, action);
  if (mcpName.startsWith('mcp__')) return !mcpReadOnly.has(mcpName);
  if (name === 'mcp_call_tool') return true;
  const definition = getToolDefinition(name);
  if (!definition) return true;
  return !READ_ONLY_CATEGORIES.has(definition.permissionCategory);
}

/** The read-only MCP tools, from the descriptors the configured servers published. */
export async function loadMcpReadOnlyIndex(cwd: string): Promise<McpReadOnlyIndex> {
  const index = new Set<string>();
  try {
    const store = new McpServerStore(cwd);
    // Reading only: a workspace without MCP configuration is not given one here.
    if (!(await store.exists())) return index;
    const data = await store.load();
    for (const server of data.servers) {
      for (const tool of server.surface?.tools ?? []) {
        if (tool.readOnly === true && tool.destructive !== true) index.add(buildProjectedMcpToolName(server.id, tool.name));
      }
    }
  } catch {
    // No MCP configuration: every MCP tool counts as side-effecting.
  }
  return index;
}

/** The classifier for one workspace: registry rules plus its MCP servers' descriptors. */
export async function createSideEffectClassifier(cwd: string): Promise<SideEffectClassifier> {
  const mcpReadOnly = await loadMcpReadOnlyIndex(cwd);
  return (name, action) => toolHasSideEffects(name, action, mcpReadOnly);
}
