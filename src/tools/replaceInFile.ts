import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
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
import { runEditGuards } from './editGuards.js';
import { pathNotFoundHint } from './pathSuggestions.js';
import {
  describeConfusableLines,
  findNormalizedMatches,
  hasConfusables,
  replaceNormalizedMatches,
} from './unicodeConfusables.js';

const NEAREST_MATCH_MAX_CHARS = 200;

function countMatches(content: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let cursor = 0;

  for (;;) {
    const index = content.indexOf(needle, cursor);
    if (index < 0) {
      return count;
    }
    count += 1;
    cursor = index + Math.max(needle.length, 1);
  }
}

/**
 * Nearest-match hint for a not-found error: pick the longest whitespace token
 * from the find string's first line and report the first file line containing
 * it, capped at NEAREST_MATCH_MAX_CHARS.
 */
function buildNearestMatchHint(content: string, find: string): string {
  const firstLine = find.split('\n', 1)[0] ?? '';
  let keyword = '';
  for (const token of firstLine.split(/\s+/)) {
    if (token.length > keyword.length) {
      keyword = token;
    }
  }
  if (!keyword) {
    return '';
  }

  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(keyword)) {
      const full = `\n\nNearest match: line ${index + 1}: ${lines[index].replace(/\s+$/, '')}`;
      return full.length <= NEAREST_MATCH_MAX_CHARS
        ? full
        : `${full.slice(0, NEAREST_MATCH_MAX_CHARS - 1)}…`;
    }
  }
  return '';
}

function buildNotFoundError(inputPath: string, workContent: string, workFind: string): Error {
  let message = `Text to replace was not found in ${inputPath}.`;
  message += buildNearestMatchHint(workContent, workFind);
  if (hasConfusables(workFind)) {
    message += `\n\nThe find string itself contains Unicode typography characters: ${describeConfusableLines(workFind)}. The file may use plain ASCII instead.`;
  }
  message +=
    '\n\nThe file may have been modified since it was last read. Use read_file to check its current content.';
  return new Error(message);
}

function buildAmbiguousError(inputPath: string, workContent: string): Error {
  const confusables = describeConfusableLines(workContent);
  return new Error(
    `Text to replace only matches ${inputPath} after Unicode typography normalization, and the match is ambiguous or unsafe (overlapping regions or a partial match inside an expanded character). No changes were made.` +
      (confusables
        ? `\nConfusable characters in the file: ${confusables}.`
        : '') +
      '\nRe-read the file with read_file and use a longer find string anchored on nearby ASCII-only context.',
  );
}

type MatchPlan = {
  nextWorkContent: string;
  matchCount: number;
  matchMode: 'exact' | 'crlf-normalized' | 'unicode-normalized';
};

/**
 * Matching ladder: exact on raw bytes, then exact after CRLF→LF
 * normalization, then confusable-normalized matching with original-coordinate
 * remapping (fail-closed on ambiguity). Returns the replacement applied to
 * the LF-normalized working text; the caller restores the newline style.
 */
function planReplacement(
  workContent: string,
  workFind: string,
  replace: string,
  replaceAll: boolean,
  inputPath: string,
): MatchPlan {
  const exactCount = countMatches(workContent, workFind);

  if (exactCount > 0) {
    if (exactCount > 1 && !replaceAll) {
      throw new Error(
        `Text to replace matched ${exactCount} times in ${inputPath}. Use replaceAll=true or provide a more specific find string.`,
      );
    }
    return {
      nextWorkContent: replaceAll
        ? workContent.split(workFind).join(replace)
        : workContent.replace(workFind, replace),
      matchCount: replaceAll ? exactCount : 1,
      matchMode: 'exact',
    };
  }

  const normalized = findNormalizedMatches(workContent, workFind);

  if (normalized.kind === 'ambiguous') {
    throw buildAmbiguousError(inputPath, workContent);
  }

  if (normalized.kind === 'matches') {
    const { matches } = normalized;
    if (matches.length > 1 && !replaceAll) {
      throw new Error(
        `Text to replace matched ${matches.length} times in ${inputPath} (via Unicode-normalized comparison). Use replaceAll=true or provide a more specific find string.`,
      );
    }
    const applied = replaceAll ? matches : matches.slice(0, 1);
    return {
      nextWorkContent: replaceNormalizedMatches(workContent, applied, replace),
      matchCount: applied.length,
      matchMode: 'unicode-normalized',
    };
  }

  throw buildNotFoundError(inputPath, workContent, workFind);
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
  if (context.permissionMode !== 'full-access') {
    ensureNotSensitivePath(absolute, action.path);
  }
  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new Error(
        `File not found: ${action.path}.${await pathNotFoundHint(absolute, effectiveCwd)}`,
      );
    }
    if (code === 'EISDIR') {
      throw new Error(`Cannot edit ${action.path}: path is a directory.`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Cannot edit ${action.path}: permission denied (${code}).`);
    }
    throw error;
  }

  const usesCrlf = content.includes('\r\n');
  const workContent = usesCrlf ? content.replace(/\r\n/g, '\n') : content;
  const workFind = action.find.replace(/\r\n/g, '\n');

  let plan: MatchPlan;
  if (countMatches(content, action.find) > 0) {
    plan = planReplacement(content, action.find, action.replace, action.replaceAll === true, action.path);
    // Raw match found: bypass newline restoration entirely.
    plan = { ...plan, matchMode: 'exact' };
  } else {
    plan = planReplacement(workContent, workFind, action.replace, action.replaceAll === true, action.path);
    if (plan.matchMode === 'exact') {
      plan = { ...plan, matchMode: 'crlf-normalized' };
    }
  }

  const nextContent =
    plan.matchMode === 'exact'
      ? plan.nextWorkContent
      : usesCrlf
        ? plan.nextWorkContent.replace(/\n/g, '\r\n')
        : plan.nextWorkContent;

  await ensureDir(path.dirname(absolute));
  await writeFile(absolute, nextContent, 'utf8');
  const confirmed = await readTextFileSafe(absolute);

  if (confirmed !== nextContent) {
    throw new Error(`replace_in_file verification failed for ${action.path}.`);
  }

  invalidateWalkFilesCache(effectiveCwd);
  const guards = await runEditGuards(absolute, content, nextContent);

  return {
    action,
    ok: true,
    output: [
      `Updated ${path.relative(effectiveCwd, absolute) || path.basename(absolute)}.`,
      `replacements: ${plan.matchCount}`,
      ...(plan.matchMode !== 'exact' ? [`match_mode: ${plan.matchMode}`] : []),
      'verified_write: true',
      'replacement preview:',
      truncate(action.replace, 500),
    ].join('\n') + guards,
  };
}
