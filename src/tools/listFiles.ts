import path from 'node:path';
import type { AgentAction } from '../core/types.js';
import { walkFiles } from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

export async function executeListFiles(
  action: Extract<AgentAction, { type: 'list_files' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const files = await walkFiles(context.cwd);
  const pattern = action.pattern?.toLowerCase();
  const maxResults = Math.min(Math.max(action.maxResults ?? 100, 1), 500);

  const matches = files
    .map((filePath) => path.relative(context.cwd, filePath))
    .filter((relative) => {
      if (!pattern) {
        return true;
      }
      return relative.toLowerCase().includes(pattern);
    })
    .slice(0, maxResults);

  return {
    action,
    ok: true,
    output:
      matches.length > 0
        ? matches.join('\n')
        : 'No files matched the requested pattern.',
  };
}
