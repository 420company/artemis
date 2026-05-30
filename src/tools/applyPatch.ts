import path from 'node:path';
import { unlink, writeFile } from 'node:fs/promises';
import type { AgentAction } from '../core/types.js';
import {
  ensureDir,
  invalidateWalkFilesCache,
  pathExists,
  readTextFileSafe,
} from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { runEditGuards } from './editGuards.js';

type PatchOperation =
  | {
      kind: 'add';
      path: string;
      lines: string[];
    }
  | {
      kind: 'delete';
      path: string;
    }
  | {
      kind: 'update';
      path: string;
      moveTo?: string;
      hunks: PatchHunk[];
    };

type PatchHunk = {
  header?: string;
  lines: string[];
};

type ParsedPatch = {
  operations: PatchOperation[];
};

type NormalizedFile = {
  lines: string[];
  newline: string;
  trailingNewline: boolean;
};

type PlannedWrite =
  | {
      kind: 'write';
      outputPath: string;
      content: string;
      summary: string;
    }
  | {
      kind: 'move';
      sourcePath: string;
      outputPath: string;
      content: string;
      summary: string;
    }
  | {
      kind: 'delete';
      targetPath: string;
      summary: string;
    };

const PATCH_BEGIN = '*** Begin Patch';
const PATCH_END = '*** End Patch';
const ADD_FILE_PREFIX = '*** Add File: ';
const DELETE_FILE_PREFIX = '*** Delete File: ';
const UPDATE_FILE_PREFIX = '*** Update File: ';
const MOVE_TO_PREFIX = '*** Move to: ';
const END_OF_FILE = '*** End of File';

function isFileOperationStart(line: string): boolean {
  return (
    line.startsWith(ADD_FILE_PREFIX) ||
    line.startsWith(DELETE_FILE_PREFIX) ||
    line.startsWith(UPDATE_FILE_PREFIX)
  );
}

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n');
}

function assertValidPatchPath(inputPath: string): string {
  const trimmed = inputPath.trim();

  if (!trimmed) {
    throw new Error('Patch file path cannot be empty.');
  }

  return trimmed;
}

function splitNormalizedLines(input: string): string[] {
  return normalizeLineEndings(input).split('\n');
}

function parsePatch(patch: string): ParsedPatch {
  const lines = splitNormalizedLines(patch);

  if (lines[0] !== PATCH_BEGIN) {
    throw new Error('Patch must begin with "*** Begin Patch".');
  }

  const operations: PatchOperation[] = [];
  let index = 1;

  while (index < lines.length) {
    const line = lines[index];

    if (line === PATCH_END) {
      return {
        operations,
      };
    }

    if (line.startsWith(ADD_FILE_PREFIX)) {
      const filePath = assertValidPatchPath(line.slice(ADD_FILE_PREFIX.length));
      index += 1;
      const contentLines: string[] = [];

      while (index < lines.length && !isFileOperationStart(lines[index]) && lines[index] !== PATCH_END) {
        const addLine = lines[index];

        if (!addLine.startsWith('+')) {
          throw new Error(`Add File ${filePath} contains a non-add line: ${addLine}`);
        }

        contentLines.push(addLine.slice(1));
        index += 1;
      }

      operations.push({
        kind: 'add',
        path: filePath,
        lines: contentLines,
      });
      continue;
    }

    if (line.startsWith(DELETE_FILE_PREFIX)) {
      operations.push({
        kind: 'delete',
        path: assertValidPatchPath(line.slice(DELETE_FILE_PREFIX.length)),
      });
      index += 1;
      continue;
    }

    if (line.startsWith(UPDATE_FILE_PREFIX)) {
      const filePath = assertValidPatchPath(line.slice(UPDATE_FILE_PREFIX.length));
      index += 1;

      let moveTo: string | undefined;
      if (index < lines.length && lines[index].startsWith(MOVE_TO_PREFIX)) {
        moveTo = assertValidPatchPath(lines[index].slice(MOVE_TO_PREFIX.length));
        index += 1;
      }

      const rawHunkLines: string[] = [];
      while (index < lines.length && !isFileOperationStart(lines[index]) && lines[index] !== PATCH_END) {
        const hunkLine = lines[index];

        if (
          hunkLine !== END_OF_FILE &&
          !hunkLine.startsWith('@@') &&
          !hunkLine.startsWith(' ') &&
          !hunkLine.startsWith('+') &&
          !hunkLine.startsWith('-')
        ) {
          throw new Error(`Update File ${filePath} contains an invalid hunk line: ${hunkLine}`);
        }

        rawHunkLines.push(hunkLine);
        index += 1;
      }

      const hunks: PatchHunk[] = [];
      let currentHunk: PatchHunk | null = null;

      for (const rawLine of rawHunkLines) {
        if (rawLine === END_OF_FILE) {
          continue;
        }

        if (rawLine.startsWith('@@')) {
          if (currentHunk && currentHunk.lines.length > 0) {
            hunks.push(currentHunk);
          }
          currentHunk = {
            header: rawLine,
            lines: [],
          };
          continue;
        }

        if (!currentHunk) {
          currentHunk = {
            lines: [],
          };
        }

        currentHunk.lines.push(rawLine);
      }

      if (currentHunk && currentHunk.lines.length > 0) {
        hunks.push(currentHunk);
      }

      if (hunks.length === 0) {
        throw new Error(`Update File ${filePath} did not contain any hunks.`);
      }

      operations.push({
        kind: 'update',
        path: filePath,
        moveTo,
        hunks,
      });
      continue;
    }

    throw new Error(`Unexpected patch line: ${line}`);
  }

  throw new Error('Patch must end with "*** End Patch".');
}

function parseFileContent(content: string): NormalizedFile {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = normalizeLineEndings(content);
  const trailingNewline = normalized.endsWith('\n');
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;

  return {
    lines: body ? body.split('\n') : [],
    newline,
    trailingNewline,
  };
}

function serializeFileContent(file: NormalizedFile): string {
  if (file.lines.length === 0) {
    return '';
  }

  const body = file.lines.join('\n').replace(/\n/g, file.newline);
  return file.trailingNewline ? `${body}${file.newline}` : body;
}

function serializeAddedFile(lines: string[]): string {
  if (lines.length === 0) {
    return '';
  }

  return `${lines.join('\n')}\n`;
}

function countHunkChanges(hunk: PatchHunk): number {
  return hunk.lines.filter((line) => line.startsWith('+') || line.startsWith('-')).length;
}

function extractMatchLines(hunk: PatchHunk): string[] {
  return hunk.lines
    .filter((line) => !line.startsWith('+'))
    .map((line) => line.slice(1));
}

function extractReplacementLines(hunk: PatchHunk): string[] {
  return hunk.lines
    .filter((line) => !line.startsWith('-'))
    .map((line) => line.slice(1));
}

function findMatchesWith(
  lines: string[],
  needle: string[],
  normalize: (s: string) => string,
): number[] {
  if (needle.length === 0 || needle.length > lines.length) {
    return [];
  }

  const nNeedle = needle.map(normalize);
  const indexes: number[] = [];

  for (let start = 0; start <= lines.length - needle.length; start += 1) {
    let matched = true;

    for (let offset = 0; offset < needle.length; offset += 1) {
      if (normalize(lines[start + offset]) !== nNeedle[offset]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      indexes.push(start);
    }
  }

  return indexes;
}

function findAllMatchIndexes(lines: string[], needle: string[]): number[] {
  return findMatchesWith(lines, needle, (s) => s);
}

function findHunkStart(
  lines: string[],
  needle: string[],
  cursor: number,
  filePath: string,
  hunkIndex: number,
): number {
  if (needle.length === 0) {
    throw new Error(
      `Patch hunk ${hunkIndex + 1} for ${filePath} has no context. Add at least one context or removed line.`,
    );
  }

  // Fuzz 阶梯：严格 → 忽略行尾空白 → 忽略首尾缩进。更松的层只在更严的层
  // 一处都没匹配到时才运行——所以干净补丁的行为和以前完全一致。每一层都保留
  // 唯一匹配安全（多处歧义照样报错）；万一打歪，改后语法守卫会当场抓住。
  const normalizers: Array<(s: string) => string> = [
    (s) => s,
    (s) => s.replace(/[ \t]+$/, ''),
    (s) => s.trim(),
  ];

  for (const normalize of normalizers) {
    const allMatches = findMatchesWith(lines, needle, normalize);
    if (allMatches.length === 0) {
      continue;
    }

    const nextMatch = allMatches.find((match) => match >= cursor);
    if (nextMatch !== undefined) {
      return nextMatch;
    }

    if (allMatches.length === 1) {
      return allMatches[0];
    }

    throw new Error(
      `Patch hunk ${hunkIndex + 1} for ${filePath} matched multiple locations. Add more context.`,
    );
  }

  throw new Error(`Patch hunk ${hunkIndex + 1} for ${filePath} did not match the file.`);
}

function applyHunksToFile(
  content: string,
  hunks: PatchHunk[],
  filePath: string,
): {
  content: string;
  changeCount: number;
} {
  const file = parseFileContent(content);
  let lines = [...file.lines];
  let cursor = 0;
  let changeCount = 0;

  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index];
    const matchLines = extractMatchLines(hunk);
    const replacementLines = extractReplacementLines(hunk);
    const matchStart = findHunkStart(lines, matchLines, cursor, filePath, index);

    lines = [
      ...lines.slice(0, matchStart),
      ...replacementLines,
      ...lines.slice(matchStart + matchLines.length),
    ];
    cursor = matchStart + replacementLines.length;
    changeCount += countHunkChanges(hunk);
  }

  return {
    content: serializeFileContent({
      ...file,
      lines,
    }),
    changeCount,
  };
}

async function buildExecutionPlan(
  parsedPatch: ParsedPatch,
  context: ToolExecutionContext,
): Promise<PlannedWrite[]> {
  const plan: PlannedWrite[] = [];
  const touched = new Set<string>();
  let effectiveCwd = context.cwd;

  for (const operation of parsedPatch.operations) {
    if (operation.kind === 'add') {
      const resolution = await resolveToolPathWithWorkspaceAccess({
        inputPath: operation.path,
        toolName: 'apply_patch',
        context,
        baseCwd: effectiveCwd,
      });
      effectiveCwd = resolution.cwd;
      const absolute = resolution.absolute;
      if (touched.has(absolute)) {
        throw new Error(`Patch touches the same file multiple times: ${operation.path}`);
      }
      touched.add(absolute);

      if (await pathExists(absolute)) {
        throw new Error(`Cannot add ${operation.path} because the file already exists.`);
      }

      plan.push({
        kind: 'write',
        outputPath: absolute,
        content: serializeAddedFile(operation.lines),
        summary: `Added ${path.relative(effectiveCwd, absolute) || path.basename(absolute)} (${operation.lines.length} line(s)).`,
      });
      continue;
    }

    if (operation.kind === 'delete') {
      const resolution = await resolveToolPathWithWorkspaceAccess({
        inputPath: operation.path,
        toolName: 'apply_patch',
        context,
        baseCwd: effectiveCwd,
      });
      effectiveCwd = resolution.cwd;
      const absolute = resolution.absolute;
      if (touched.has(absolute)) {
        throw new Error(`Patch touches the same file multiple times: ${operation.path}`);
      }
      touched.add(absolute);

      if (!(await pathExists(absolute))) {
        throw new Error(`Cannot delete ${operation.path} because the file does not exist.`);
      }

      plan.push({
        kind: 'delete',
        targetPath: absolute,
        summary: `Deleted ${path.relative(effectiveCwd, absolute) || path.basename(absolute)}.`,
      });
      continue;
    }

    const sourceResolution = await resolveToolPathWithWorkspaceAccess({
      inputPath: operation.path,
      toolName: 'apply_patch',
      context,
      baseCwd: effectiveCwd,
    });
    effectiveCwd = sourceResolution.cwd;
    const sourcePath = sourceResolution.absolute;
    if (touched.has(sourcePath)) {
      throw new Error(`Patch touches the same file multiple times: ${operation.path}`);
    }
    touched.add(sourcePath);
    const sourceContent = await readTextFileSafe(sourcePath);
    const applied = applyHunksToFile(sourceContent, operation.hunks, operation.path);
    let destinationPath = sourcePath;
    if (operation.moveTo) {
      const moveResolution = await resolveToolPathWithWorkspaceAccess({
        inputPath: operation.moveTo,
        toolName: 'apply_patch',
        context,
        baseCwd: effectiveCwd,
      });
      effectiveCwd = moveResolution.cwd;
      destinationPath = moveResolution.absolute;
      if (destinationPath !== sourcePath && touched.has(destinationPath)) {
        throw new Error(`Patch move target collides with another operation: ${operation.moveTo}`);
      }
      if (destinationPath !== sourcePath) {
        touched.add(destinationPath);
      }
    }

    if (
      operation.moveTo &&
      destinationPath !== sourcePath &&
      await pathExists(destinationPath)
    ) {
      throw new Error(`Cannot move patch output to ${operation.moveTo} because that file already exists.`);
    }

    plan.push(
      operation.moveTo && destinationPath !== sourcePath
        ? {
            kind: 'move',
            sourcePath,
            outputPath: destinationPath,
            content: applied.content,
            summary: `Moved ${operation.path} -> ${operation.moveTo} with ${operation.hunks.length} hunk(s), ${applied.changeCount} change line(s).`,
          }
        : {
            kind: 'write',
            outputPath: destinationPath,
            content: applied.content,
            summary: `Patched ${path.relative(effectiveCwd, destinationPath) || path.basename(destinationPath)} with ${operation.hunks.length} hunk(s), ${applied.changeCount} change line(s).`,
          },
    );
  }

  return plan;
}

async function executePlan(plan: PlannedWrite[]): Promise<string[]> {
  const summaries: string[] = [];

  for (const step of plan) {
    if (step.kind === 'delete') {
      await unlink(step.targetPath);
      if (await pathExists(step.targetPath)) {
        throw new Error(`apply_patch verification failed while deleting ${step.targetPath}.`);
      }
      summaries.push(step.summary);
      continue;
    }

    await ensureDir(path.dirname(step.outputPath));
    await writeFile(step.outputPath, step.content, 'utf8');
    const confirmed = await readTextFileSafe(step.outputPath);

    if (confirmed !== step.content) {
      throw new Error(`apply_patch verification failed for ${step.outputPath}.`);
    }

    if (step.kind === 'move') {
      await unlink(step.sourcePath);
      if (await pathExists(step.sourcePath)) {
        throw new Error(`apply_patch verification failed while moving ${step.sourcePath}.`);
      }
    }

    const guards = await runEditGuards(step.outputPath, null, step.content);
    summaries.push(`${step.summary} verified_write=true${guards}`);
  }

  return summaries;
}

export async function executeApplyPatch(
  action: Extract<AgentAction, { type: 'apply_patch' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  if (!action.patch.trim()) {
    throw new Error('apply_patch requires a non-empty patch string.');
  }

  const parsedPatch = parsePatch(action.patch);

  if (parsedPatch.operations.length === 0) {
    throw new Error('Patch did not contain any file operations.');
  }

  const executionPlan = await buildExecutionPlan(parsedPatch, context);
  const summaries = await executePlan(executionPlan);
  invalidateWalkFilesCache();

  return {
    action,
    ok: true,
    output: [
      `Applied patch with ${parsedPatch.operations.length} operation(s).`,
      ...summaries,
    ].join('\n'),
  };
}
