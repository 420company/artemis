import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { pathExists, truncate } from '../utils/fs.js';

export type ProjectInstructionFile = {
  fileName: 'Artemis.MD';
  path: string;
  content: string;
};

const PROJECT_INSTRUCTION_FILE = 'Artemis.MD' as const;
const MISSING_INSTRUCTION_FILE_TTL_MS = 4_000;

type InstructionFileCacheEntry = {
  checkedAt: number;
  file: ProjectInstructionFile | null;
  mtimeMs?: number;
  size?: number;
};

const instructionFileCache = new Map<string, InstructionFileCacheEntry>();
const instructionFileCacheStats = {
  statCalls: 0,
  readCalls: 0,
};

function clipInstructionContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  const headChars = Math.max(Math.floor(maxChars * 0.7), 800);
  const tailChars = Math.max(
    Math.min(maxChars - headChars - 80, Math.floor(maxChars * 0.2)),
    240,
  );

  if (headChars + tailChars + 80 >= content.length) {
    return truncate(content, maxChars);
  }

  return [
    content.slice(0, headChars).trimEnd(),
    `...[middle truncated ${content.length - headChars - tailChars} chars]`,
    content.slice(content.length - tailChars).trimStart(),
  ].join('\n');
}

export async function loadProjectInstructionFile(
  cwd: string,
): Promise<ProjectInstructionFile | null> {
  const filePath = path.join(cwd, PROJECT_INSTRUCTION_FILE);
  const cached = instructionFileCache.get(filePath);
  const now = Date.now();

  if (
    cached &&
    cached.file === null &&
    now - cached.checkedAt <= MISSING_INSTRUCTION_FILE_TTL_MS
  ) {
    return null;
  }

  if (!(await pathExists(filePath))) {
    instructionFileCache.set(filePath, {
      checkedAt: now,
      file: null,
    });
    return null;
  }

  instructionFileCacheStats.statCalls += 1;
  const info = await stat(filePath);
  if (
    cached &&
    cached.file &&
    cached.mtimeMs === info.mtimeMs &&
    cached.size === info.size
  ) {
    return cached.file;
  }

  instructionFileCacheStats.readCalls += 1;
  const content = (await readFile(filePath, 'utf8')).trim();
  if (!content) {
    instructionFileCache.set(filePath, {
      checkedAt: now,
      file: null,
      mtimeMs: info.mtimeMs,
      size: info.size,
    });
    return null;
  }

  const file = {
    fileName: PROJECT_INSTRUCTION_FILE,
    path: filePath,
    content,
  };
  instructionFileCache.set(filePath, {
    checkedAt: now,
    file,
    mtimeMs: info.mtimeMs,
    size: info.size,
  });
  return file;
}

export async function buildProjectInstructionFileSection(
  cwd: string,
  maxChars = 6_000,
): Promise<string | undefined> {
  const file = await loadProjectInstructionFile(cwd);
  if (!file) {
    return undefined;
  }

  return [
    `Project instruction file: ${file.fileName}`,
    `Path: ${file.path}`,
    clipInstructionContent(file.content, maxChars),
  ].join('\n');
}

export function resetProjectInstructionFileCacheForTests(): void {
  instructionFileCache.clear();
  instructionFileCacheStats.statCalls = 0;
  instructionFileCacheStats.readCalls = 0;
}

export function getProjectInstructionFileCacheStats(): {
  entries: number;
  statCalls: number;
  readCalls: number;
} {
  return {
    entries: instructionFileCache.size,
    ...instructionFileCacheStats,
  };
}
