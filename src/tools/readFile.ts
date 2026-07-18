import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AgentAction } from '../core/types.js';
import { ensureNotSensitivePath } from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { noteFileRead } from './editGuards.js';
import { pathNotFoundHint } from './pathSuggestions.js';

const LARGE_FILE_WARNING_LINES = 500;
const MAX_READ_LINES = 2_000;
// Output budget is token-based (bytes/4 estimate), not raw characters.
const MAX_READ_TOKENS = 25_000;
const LONG_LINE_BYTES = 2_000;

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function readHistoryKey(absolute: string, startLine?: number, endLine?: number): string {
  return `${absolute}:${startLine ?? ''}:${endLine ?? ''}`;
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;

  if (!body) {
    return [''];
  }

  return body.split('\n');
}

function renderWithLineNumbers(
  lines: string[],
  startLine?: number,
  endLine?: number,
): { rendered: string; startLine: number; endLine: number } {
  const safeStart = Math.max(startLine ?? 1, 1);
  const safeEnd = Math.min(endLine ?? lines.length, lines.length);

  if (safeEnd < safeStart) {
    throw new Error('read_file endLine must be greater than or equal to startLine.');
  }

  return {
    rendered: lines
      .slice(safeStart - 1, safeEnd)
      .map((line, index) => `${safeStart + index} | ${line}`)
      .join('\n'),
    startLine: safeStart,
    endLine: safeEnd,
  };
}

function longLineHint(lines: string[], startLine: number, endLine: number): string {
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    if (line !== undefined && Buffer.byteLength(line, 'utf8') > LONG_LINE_BYTES) {
      return ` Note: the file contains very long single lines (>${LONG_LINE_BYTES} bytes), so line ranges cannot narrow it much further. Use run_command with jq, cut -c, or python to extract the parts you need.`;
    }
  }
  return '';
}

async function describeReadError(
  error: unknown,
  inputPath: string,
  absolute: string,
  cwd: string,
): Promise<string> {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    return `Error reading file ${inputPath}: file does not exist.${await pathNotFoundHint(absolute, cwd)}`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `Error reading file ${inputPath}: permission denied (${code}).`;
  }
  if (code === 'EISDIR') {
    return `Error reading file ${inputPath}: path is a directory. Use list_files to inspect it.`;
  }
  return `Error reading file ${inputPath}: ${error instanceof Error ? error.message : String(error)}`;
}

export async function executeReadFile(
  action: Extract<AgentAction, { type: 'read_file' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const { absolute, cwd: effectiveCwd } = await resolveToolPathWithWorkspaceAccess({
    inputPath: action.path,
    toolName: 'read_file',
    context,
  });
  if (context.permissionMode !== 'full-access') {
    ensureNotSensitivePath(absolute, action.path);
  }
  const requestedStart = toInteger(action.startLine);
  const requestedEnd = toInteger(action.endLine);
  const historyKey = readHistoryKey(absolute, requestedStart, requestedEnd);
  const previous = context.readFileHistory?.get(historyKey);
  if (previous) {
    return {
      action,
      ok: true,
      output: [
        `path: ${path.relative(effectiveCwd, absolute) || path.basename(absolute)}`,
        'content: [same as previous read_file result in this tool turn; no writes occurred between reads]',
      ].join('\n'),
    };
  }

  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    return {
      action,
      ok: false,
      output: await describeReadError(error, action.path, absolute, effectiveCwd),
    };
  }

  noteFileRead(absolute, content);
  const lines = splitLines(content);
  const totalLines = lines.length;
  const warnings: string[] = [];

  // Negative startLine reads from the tail: -N starts N lines before EOF.
  const resolvedStart =
    requestedStart !== undefined && requestedStart < 0
      ? Math.max(totalLines + requestedStart + 1, 1)
      : requestedStart === 0
        ? 1
        : requestedStart;

  if (
    typeof resolvedStart === 'number' &&
    typeof requestedEnd === 'number' &&
    requestedEnd - resolvedStart + 1 > MAX_READ_LINES
  ) {
    throw new Error(
      `read_file range exceeds ${MAX_READ_LINES} lines. Narrow the range and read in chunks.`,
    );
  }

  const rangeStart = resolvedStart;
  const rangeEnd =
    requestedStart === undefined && requestedEnd === undefined && totalLines > MAX_READ_LINES
      ? MAX_READ_LINES
      : requestedEnd;

  if (requestedStart === undefined && requestedEnd === undefined) {
    if (totalLines > LARGE_FILE_WARNING_LINES) {
      warnings.push(
        `Large file warning: ${totalLines} lines total. Prefer chunked reads with startLine/endLine for files over ${LARGE_FILE_WARNING_LINES} lines.`,
      );
    }

    if (totalLines > MAX_READ_LINES) {
      warnings.push(
        `This read was capped at lines 1-${MAX_READ_LINES}. Continue with startLine=${MAX_READ_LINES + 1} to read the next chunk.`,
      );
    }
  }

  const output = renderWithLineNumbers(lines, rangeStart, rangeEnd);
  const tokens = estimateTokens(output.rendered);

  if (tokens > MAX_READ_TOKENS) {
    const hint = longLineHint(lines, output.startLine, output.endLine);
    if (requestedStart !== undefined || requestedEnd !== undefined) {
      throw new Error(
        `The requested line range (startLine=${requestedStart ?? 1}, endLine=${requestedEnd ?? totalLines}) is ~${tokens} tokens, which exceeds the ${MAX_READ_TOKENS}-token limit. Request a smaller range.${hint}`,
      );
    }
    throw new Error(
      `File content is ~${tokens} tokens, which exceeds the ${MAX_READ_TOKENS}-token limit for a single read. Read the file in chunks with startLine/endLine.${hint}`,
    );
  }

  const returnedLongLineHint = longLineHint(lines, output.startLine, output.endLine);
  if (returnedLongLineHint) {
    warnings.push(returnedLongLineHint.trim());
  }

  const result = {
    action,
    ok: true,
    output: [
      `path: ${path.relative(effectiveCwd, absolute) || path.basename(absolute)}`,
      `total_lines: ${totalLines}`,
      `returned_lines: ${output.startLine}-${output.endLine}`,
      ...(warnings.length > 0
        ? ['warnings:', ...warnings.map((warning) => `- ${warning}`)]
        : []),
      'content:',
      output.rendered,
    ].join('\n'),
  };
  context.readFileHistory?.set(historyKey, { output: result.output });
  return result;
}
