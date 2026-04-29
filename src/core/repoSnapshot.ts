import path from 'node:path';
import { walkFiles } from '../utils/fs.js';
import { PROJECT_INSTRUCTION_FILENAMES } from './instructionFile.js';

type RepoScopeSummary = {
  scope: string;
  fileCount: number;
  sampleFiles: string[];
};

const PATH_REFERENCE_PATTERN =
  /(?:[A-Za-z0-9_.-]+[/\\])+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)?/g;

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function isProjectInstructionFile(relativePath: string): boolean {
  const normalized = path.basename(normalizePath(relativePath)).toLowerCase();
  return PROJECT_INSTRUCTION_FILENAMES.some(
    (fileName) => fileName.toLowerCase() === normalized,
  );
}

function tokenizePrompt(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function extractExplicitPathReferences(prompt: string): string[] {
  const matches = prompt.match(PATH_REFERENCE_PATTERN) ?? [];
  return [...new Set(
    matches
      .map((entry) => normalizePath(entry))
      .filter((entry) => entry && !isProjectInstructionFile(entry)),
  )];
}

function getScopeKey(relativePath: string): string {
  const normalized = normalizePath(relativePath);
  const parts = normalized.split('/').filter(Boolean);

  if (parts.length <= 1) {
    return normalized;
  }

  if (parts[0] === 'src' && parts.length >= 2) {
    return `src/${parts[1]}`;
  }

  return `${parts[0]}/${parts[1]}`;
}

function scoreScope(scope: string, fileCount: number, promptTokens: string[]): number {
  const normalizedScope = scope.toLowerCase();
  let score = Math.min(3, Math.ceil(fileCount / 4));

  if (promptTokens.some((token) => normalizedScope.includes(token))) {
    score += 4;
  }

  if (
    scope === 'src/core' ||
    scope === 'src/cli' ||
    scope === 'src/tools'
  ) {
    score += 2;
  }

  return score;
}

function formatRankedScopeSnapshot(
  ranked: RepoScopeSummary[],
  noun: string,
): string {
  if (ranked.length === 0) {
    return 'Repo snapshot: no files were discovered in the working tree.';
  }

  return [
    'Repo snapshot:',
    ...ranked.flatMap((entry) => [
      `- ${entry.scope} (${entry.fileCount} ${noun})`,
      ...entry.sampleFiles.map((filePath) => `  - ${filePath}`),
    ]),
  ].join('\n');
}

export async function buildRepoSnapshot(
  cwd: string,
  prompt: string,
  options?: {
    maxScopes?: number;
    maxFilesPerScope?: number;
  },
): Promise<string> {
  const maxScopes = options?.maxScopes ?? 4;
  const maxFilesPerScope = options?.maxFilesPerScope ?? 5;
  const explicitReferences = extractExplicitPathReferences(prompt);
  const promptTokens = tokenizePrompt(prompt);

  if (explicitReferences.length > 0) {
    const explicitSummaryByScope = new Map<string, RepoScopeSummary>();

    for (const filePath of explicitReferences) {
      const scope = getScopeKey(filePath);
      const existing = explicitSummaryByScope.get(scope);

      if (existing) {
        existing.fileCount += 1;
        if (existing.sampleFiles.length < maxFilesPerScope) {
          existing.sampleFiles.push(filePath);
        }
        continue;
      }

      explicitSummaryByScope.set(scope, {
        scope,
        fileCount: 1,
        sampleFiles: [filePath],
      });
    }

    const rankedExplicit = [...explicitSummaryByScope.values()]
      .sort((left, right) => {
        const scoreDelta =
          scoreScope(right.scope, right.fileCount, promptTokens) -
          scoreScope(left.scope, left.fileCount, promptTokens);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }

        const fileDelta = right.fileCount - left.fileCount;
        if (fileDelta !== 0) {
          return fileDelta;
        }

        return left.scope.localeCompare(right.scope);
      })
      .slice(0, maxScopes);

    return formatRankedScopeSnapshot(rankedExplicit, 'referenced paths');
  }

  const files = (await walkFiles(cwd))
    .map((filePath) => normalizePath(path.relative(cwd, filePath)))
    .filter((filePath) => !isProjectInstructionFile(filePath))
    .sort((left, right) => left.localeCompare(right));
  const summaryByScope = new Map<string, RepoScopeSummary>();

  for (const filePath of files) {
    const scope = getScopeKey(filePath);
    const existing = summaryByScope.get(scope);

    if (existing) {
      existing.fileCount += 1;
      if (existing.sampleFiles.length < maxFilesPerScope) {
        existing.sampleFiles.push(filePath);
      }
      continue;
    }

    summaryByScope.set(scope, {
      scope,
      fileCount: 1,
      sampleFiles: [filePath],
    });
  }

  const ranked = [...summaryByScope.values()]
    .sort((left, right) => {
      const scoreDelta =
        scoreScope(right.scope, right.fileCount, promptTokens) -
        scoreScope(left.scope, left.fileCount, promptTokens);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const fileDelta = right.fileCount - left.fileCount;
      if (fileDelta !== 0) {
        return fileDelta;
      }

      return left.scope.localeCompare(right.scope);
    })
    .slice(0, maxScopes);

  return formatRankedScopeSnapshot(ranked, 'files');
}
