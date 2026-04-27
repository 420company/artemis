import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { AgentAction } from '../core/types.js';
import {
  ensureDir,
  ensureNotSensitivePath,
  invalidateWalkFilesCache,
  readTextFileSafe,
  truncate,
} from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';

function countMatches(content: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let cursor = 0;

  while (true) {
    const index = content.indexOf(needle, cursor);
    if (index < 0) {
      return count;
    }
    count += 1;
    cursor = index + Math.max(needle.length, 1);
  }
}

export async function executeReplaceInFile(
  action: Extract<AgentAction, { type: 'replace_in_file' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  if (!action.find) {
    throw new Error('replace_in_file requires a non-empty find string.');
  }

  const { absolute, cwd: effectiveCwd } = await resolveToolPathWithWorkspaceAccess({
    inputPath: action.path,
    toolName: 'replace_in_file',
    context,
  });
  ensureNotSensitivePath(absolute, action.path);
  const content = await readTextFileSafe(absolute);
  const matchCount = countMatches(content, action.find);

  if (matchCount === 0) {
    throw new Error(`Text to replace was not found in ${action.path}.`);
  }

  if (matchCount > 1 && !action.replaceAll) {
    throw new Error(
      `Text to replace matched ${matchCount} times in ${action.path}. Use replaceAll=true or provide a more specific find string.`,
    );
  }

  const nextContent = action.replaceAll
    ? content.split(action.find).join(action.replace)
    : content.replace(action.find, action.replace);

  await ensureDir(path.dirname(absolute));
  await writeFile(absolute, nextContent, 'utf8');
  const confirmed = await readTextFileSafe(absolute);

  if (confirmed !== nextContent) {
    throw new Error(`replace_in_file verification failed for ${action.path}.`);
  }

  invalidateWalkFilesCache(effectiveCwd);

  return {
    action,
    ok: true,
    output: [
      `Updated ${path.relative(effectiveCwd, absolute) || path.basename(absolute)}.`,
      `replacements: ${action.replaceAll ? matchCount : 1}`,
      'verified_write: true',
      'replacement preview:',
      truncate(action.replace, 500),
    ].join('\n'),
  };
}
