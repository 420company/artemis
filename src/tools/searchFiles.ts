import path from 'node:path';
import type { AgentAction } from '../core/types.js';
import { readTextFileSafe, truncate, walkFiles } from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

export async function executeSearchFiles(
  action: Extract<AgentAction, { type: 'search_files' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const files = await walkFiles(context.cwd);
  const maxResults = Math.min(Math.max(action.maxResults ?? 10, 1), 50);
  const pattern = action.pattern?.trim().toLowerCase() || undefined;
  const query = action.query?.trim().toLowerCase() || undefined;
  const matches: string[] = [];
  const warnings: string[] = [];
  let hitResultLimit = false;

  // No pattern and no query — instead of hard-failing, list a brief inventory
  // of the workspace so the agent can pick a real next step. Hard failure used
  // to send the loop into "tool failed" → retry with same args → fail again.
  if (!pattern && !query) {
    const sample = files
      .slice(0, 25)
      .map((file) => path.relative(context.cwd, file));
    return {
      action,
      ok: true,
      output: [
        'search_files was called without pattern or query — returning a workspace inventory instead.',
        'For a real search, pass `query` (file content substring) and/or `pattern` (path substring).',
        '',
        sample.length === 0
          ? '(workspace appears empty)'
          : sample.join('\n') + (files.length > sample.length ? `\n... (+${files.length - sample.length} more)` : ''),
      ].join('\n'),
    };
  }

  for (const file of files) {
    if (matches.length >= maxResults) {
      hitResultLimit = true;
      break;
    }

    const relative = path.relative(context.cwd, file);
    const fileNameMatch = !pattern || relative.toLowerCase().includes(pattern);

    if (!query) {
      if (fileNameMatch) {
        matches.push(relative);
      }
      continue;
    }

    if (!fileNameMatch) {
      continue;
    }

    try {
      const content = await readTextFileSafe(file);
      const lines = content.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= maxResults) {
          hitResultLimit = true;
          break;
        }

        const line = lines[index];
        if (!line.toLowerCase().includes(query)) {
          continue;
        }

        matches.push(
          `${relative}:${index + 1}: ${truncate(line.trim(), 240)}`,
        );
      }
    } catch {
      continue;
    }
  }

  if (hitResultLimit) {
    warnings.push(
      `Search hit the result cap (${maxResults}). Narrow the pattern or search directory-by-directory if you suspect truncation.`,
    );
  }

  return {
    action,
    ok: true,
    output: matches.length > 0
      ? [
          ...(warnings.length > 0
            ? ['warnings:', ...warnings.map((warning) => `- ${warning}`), '']
            : []),
          matches.join('\n\n'),
        ].join('\n')
      : 'No files matched the requested search.',
  };
}
