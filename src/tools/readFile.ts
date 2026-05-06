/* eslint-disable @typescript-eslint/no-unused-vars */
import path from 'node:path';
import type { AgentAction } from '../core/types.js';
import { ensureNotSensitivePath, readTextFileSafe } from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';

const LARGE_FILE_WARNING_LINES = 500;
const MAX_READ_LINES = 2_000;
const MAX_RENDER_CHARS = 16_000;

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

function fitRenderedChunk(
  lines: string[],
  startLine: number,
  endLine: number,
): { rendered: string; startLine: number; endLine: number } {
  const chunk: string[] = [];
  let renderedLength = 0;
  let lastLine = startLine - 1;

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const nextLine = `${lineNumber} | ${lines[lineNumber - 1] ?? ''}`;
    const nextLength = renderedLength + nextLine.length + (chunk.length > 0 ? 1 : 0);

    if (chunk.length > 0 && nextLength > MAX_RENDER_CHARS) {
      break;
    }

    chunk.push(nextLine);
    renderedLength = nextLength;
    lastLine = lineNumber;

    if (chunk.length === 1 && renderedLength > MAX_RENDER_CHARS) {
      break;
    }
  }

  return {
    rendered: chunk.join('\n'),
    startLine,
    endLine: Math.max(lastLine, startLine),
  };
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
  const historyKey = readHistoryKey(absolute, action.startLine, action.endLine);
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
  
  try {
    const content = await readTextFileSafe(absolute);
    const lines = splitLines(content);
    const totalLines = lines.length;
    const warnings: string[] = [];

    if (
      typeof action.startLine === 'number' &&
      typeof action.endLine === 'number' &&
      action.endLine - action.startLine + 1 > MAX_READ_LINES
    ) {
      throw new Error(
        `read_file range exceeds ${MAX_READ_LINES} lines. Narrow the range and read in chunks.`,
      );
    }

    const rangeStart = action.startLine;
    const rangeEnd =
      action.startLine === undefined &&
      action.endLine === undefined &&
      totalLines > MAX_READ_LINES
        ? MAX_READ_LINES
        : action.endLine;

    if (action.startLine === undefined && action.endLine === undefined) {
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

    const rendered = renderWithLineNumbers(
      lines,
      rangeStart,
      rangeEnd,
    );
    const output =
      rendered.rendered.length > MAX_RENDER_CHARS
        ? fitRenderedChunk(lines, rendered.startLine, rendered.endLine)
        : rendered;

    if (rendered.rendered.length > MAX_RENDER_CHARS) {
      warnings.push(
        `Rendered file output was capped by character budget at lines ${output.startLine}-${output.endLine}. Continue with startLine=${output.endLine + 1} to read the next chunk.`,
      );
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
  } catch (error) {
    return {
      action,
      ok: false,
      output: `Error reading file ${action.path}: File not found or unreadable`,
    };
  }
}
