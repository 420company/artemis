import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { AgentAction } from '../core/types.js';
import {
  ensureDir,
  ensureNotSensitivePath,
  invalidateWalkFilesCache,
  pathExists,
  readTextFileSafe,
  truncate,
} from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';

export async function executeWriteFile(
  action: Extract<AgentAction, { type: 'write_file' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const { absolute, cwd: effectiveCwd, displayPath } = await resolveToolPathWithWorkspaceAccess({
    inputPath: action.path,
    toolName: 'write_file',
    context,
  });
  ensureNotSensitivePath(absolute, action.path);
  const existed = await pathExists(absolute);
  if (existed) {
    await readTextFileSafe(absolute);
  }
  await ensureDir(path.dirname(absolute));
  await writeFile(absolute, action.content, 'utf8');
  const confirmed = await readTextFileSafe(absolute);

  if (confirmed !== action.content) {
    throw new Error(`write_file verification failed for ${action.path}.`);
  }

  invalidateWalkFilesCache(effectiveCwd);

  return {
    action: {
      ...action,
      path: displayPath,
    },
    ok: true,
    output: [
      `Wrote ${displayPath}.`,
      `verified_write: true${existed ? ' (overwrote existing file)' : ''}`,
      'preview:',
      truncate(action.content, 500),
    ].join('\n'),
  };
}
