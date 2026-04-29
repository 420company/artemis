import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { pathExists, truncate } from '../utils/fs.js';

export const PROJECT_INSTRUCTION_FILENAMES = [
  'ARTEMIS.md',
  'artemis.md',
  'Artemis.md',
  'Artemis.MD',
  '.artemis.md',
] as const;

export type ProjectInstructionFileName = typeof PROJECT_INSTRUCTION_FILENAMES[number];

export type ProjectInstructionFile = {
  fileName: ProjectInstructionFileName;
  path: string;
  content: string;
};

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
  const cacheKey = path.resolve(cwd);
  const cached = instructionFileCache.get(cacheKey);
  const now = Date.now();

  if (
    cached &&
    cached.file === null &&
    now - cached.checkedAt <= MISSING_INSTRUCTION_FILE_TTL_MS
  ) {
    return null;
  }

  let selected: { fileName: ProjectInstructionFileName; path: string } | null = null;
  for (const fileName of PROJECT_INSTRUCTION_FILENAMES) {
    const filePath = path.join(cwd, fileName);
    if (await pathExists(filePath)) {
      selected = { fileName, path: filePath };
      break;
    }
  }

  if (!selected) {
    instructionFileCache.set(cacheKey, {
      checkedAt: now,
      file: null,
    });
    return null;
  }

  instructionFileCacheStats.statCalls += 1;
  const info = await stat(selected.path);
  if (
    cached &&
    cached.file &&
    cached.file.path === selected.path &&
    cached.mtimeMs === info.mtimeMs &&
    cached.size === info.size
  ) {
    return cached.file;
  }

  instructionFileCacheStats.readCalls += 1;
  const content = (await readFile(selected.path, 'utf8')).trim();
  if (!content) {
    instructionFileCache.set(cacheKey, {
      checkedAt: now,
      file: null,
      mtimeMs: info.mtimeMs,
      size: info.size,
    });
    return null;
  }

  const file = {
    fileName: selected.fileName,
    path: selected.path,
    content,
  };
  instructionFileCache.set(cacheKey, {
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
