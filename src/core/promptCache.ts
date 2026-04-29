import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { PermissionManager } from '../security/permissions.js';
import { buildMcpRuntimeSections } from '../mcp/runtime.js';
import { resolveDataRootDir } from '../utils/fs.js';
import {
  PROJECT_INSTRUCTION_FILENAMES,
  buildProjectInstructionFileSection,
} from './instructionFile.js';
import { buildSystemPrompt } from './systemPrompt.js';
import type {
  AgentRole,
  SessionAutonomyMode,
} from './types.js';

type ExecutionProfile = 'main' | AgentRole;

type StableProviderSystemSectionsOptions = {
  cwd: string;
  permissionMode: ReturnType<PermissionManager['getMode']>;
  autonomyMode: SessionAutonomyMode;
  profile: ExecutionProfile;
  nativeToolRuntime: boolean;
};

type StableProviderSystemCacheEntry = {
  sections: string[];
};

type PromptRuntimeCacheStats = {
  hits: number;
  misses: number;
  size: number;
};

const PROMPT_CACHE_SCHEMA_VERSION = 2;
const stableProviderSystemCache = new Map<string, StableProviderSystemCacheEntry>();
const promptRuntimeCacheStats: PromptRuntimeCacheStats = {
  hits: 0,
  misses: 0,
  size: 0,
};

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function getFileSignature(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'missing';
  }
}

function getInstructionMaxChars(profile: ExecutionProfile): number {
  return profile === 'main' ? 6_000 : 2_500;
}

async function buildStablePromptCacheKey(
  options: StableProviderSystemSectionsOptions,
): Promise<string> {
  const instructionMaxChars = getInstructionMaxChars(options.profile);
  const [projectInstructionSignatures, mcpConfigSignature] = await Promise.all([
    Promise.all(
      PROJECT_INSTRUCTION_FILENAMES.map(async (fileName) => [
        fileName,
        await getFileSignature(path.join(options.cwd, fileName)),
      ] as const),
    ),
    getFileSignature(path.join(resolveDataRootDir(options.cwd), 'mcp-servers.json')),
  ]);

  return hashString(
    JSON.stringify({
      schema: PROMPT_CACHE_SCHEMA_VERSION,
      cwd: options.cwd,
      profile: options.profile,
      permissionMode: options.permissionMode,
      autonomyMode: options.autonomyMode,
      nativeToolRuntime: options.nativeToolRuntime,
      instructionMaxChars,
      projectInstructionSignatures,
      mcpConfigSignature,
    }),
  );
}

export async function buildStableProviderSystemSections(
  options: StableProviderSystemSectionsOptions,
): Promise<string[]> {
  const cacheKey = await buildStablePromptCacheKey(options);
  const cached = stableProviderSystemCache.get(cacheKey);
  if (cached) {
    promptRuntimeCacheStats.hits += 1;
    return [...cached.sections];
  }

  promptRuntimeCacheStats.misses += 1;
  const instructionMaxChars = getInstructionMaxChars(options.profile);
  const sections = [
    buildSystemPrompt(
      options.cwd,
      options.permissionMode,
      options.autonomyMode,
      options.profile,
      options.nativeToolRuntime,
    ),
  ];

  const [projectInstructionFile, mcpSections] = await Promise.all([
    buildProjectInstructionFileSection(options.cwd, instructionMaxChars),
    buildMcpRuntimeSections(options.cwd, options.profile),
  ]);

  if (projectInstructionFile) {
    sections.push(projectInstructionFile);
  }

  if (mcpSections.length > 0) {
    sections.push(...mcpSections);
  }

  stableProviderSystemCache.set(cacheKey, {
    sections: [...sections],
  });
  promptRuntimeCacheStats.size = stableProviderSystemCache.size;
  return sections;
}

export function resetPromptRuntimeCacheForTests(): void {
  stableProviderSystemCache.clear();
  promptRuntimeCacheStats.hits = 0;
  promptRuntimeCacheStats.misses = 0;
  promptRuntimeCacheStats.size = 0;
}

export function getPromptRuntimeCacheStats(): PromptRuntimeCacheStats {
  return {
    ...promptRuntimeCacheStats,
    size: stableProviderSystemCache.size,
  };
}
