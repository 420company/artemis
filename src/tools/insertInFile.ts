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

function hasUsableAnchor(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return Number.isInteger(value) && Number(value) > 0;
}

function countUsableAnchors(values: Array<unknown>): number {
  return values.filter(hasUsableAnchor).length;
}

function insertByLine(content: string, atLine: number, insertion: string): string {
  const lines = content.split(/\r?\n/);
  const safeLine = Math.max(atLine, 1);

  if (safeLine > lines.length + 1) {
    throw new Error(`atLine ${atLine} is outside the file bounds.`);
  }

  const nextLines = [...lines];
  nextLines.splice(safeLine - 1, 0, insertion);
  return nextLines.join('\n');
}

function insertByAnchor(
  content: string,
  anchor: string,
  insertion: string,
  mode: 'before' | 'after',
): string {
  const index = content.indexOf(anchor);

  if (index < 0) {
    throw new Error(`Anchor text was not found for ${mode} insertion.`);
  }

  const insertAt = mode === 'before' ? index : index + anchor.length;
  return `${content.slice(0, insertAt)}${insertion}${content.slice(insertAt)}`;
}

export async function executeInsertInFile(
  action: Extract<AgentAction, { type: 'insert_in_file' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const anchorCount = countUsableAnchors([action.after, action.before, action.atLine]);

  if (anchorCount !== 1) {
    throw new Error(
      'insert_in_file requires exactly one anchor: after, before, or atLine.',
    );
  }

  const { absolute, cwd: effectiveCwd } = await resolveToolPathWithWorkspaceAccess({
    inputPath: action.path,
    toolName: 'insert_in_file',
    context,
  });
  if (context.permissionMode !== 'accept-all') {
    ensureNotSensitivePath(absolute, action.path);
  }
  const content = await readTextFileSafe(absolute);

  let nextContent: string;

  const atLine = action.atLine;
  if (typeof atLine === 'number' && Number.isInteger(atLine) && atLine > 0) {
    nextContent = insertByLine(content, atLine, action.content);
  } else if (typeof action.after === 'string' && action.after.trim().length > 0) {
    nextContent = insertByAnchor(content, action.after, action.content, 'after');
  } else if (typeof action.before === 'string' && action.before.trim().length > 0) {
    nextContent = insertByAnchor(content, action.before, action.content, 'before');
  } else {
    throw new Error('insert_in_file could not resolve an insertion anchor.');
  }

  await ensureDir(path.dirname(absolute));
  await writeFile(absolute, nextContent, 'utf8');
  const confirmed = await readTextFileSafe(absolute);

  if (confirmed !== nextContent) {
    throw new Error(`insert_in_file verification failed for ${action.path}.`);
  }

  invalidateWalkFilesCache(effectiveCwd);

  return {
    action,
    ok: true,
    output: [
      `Inserted content into ${path.relative(effectiveCwd, absolute) || path.basename(absolute)}.`,
      'verified_write: true',
      'insert preview:',
      truncate(action.content, 500),
    ].join('\n'),
  };
}
