import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAction } from '../core/types.js';
import { readTextFileSafe, truncate, walkFiles } from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

const execFileAsync = promisify(execFile);

const RG_TIMEOUT_MS = 20_000;
const RG_MAX_BUFFER = 16 * 1024 * 1024;

type SearchOutcome = { matches: string[]; hitResultLimit: boolean };

function normalizeRelative(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

// Fast path: ripgrep — regex-free literal search (-F) keeps the historical
// substring semantics, but gains .gitignore awareness, binary skipping, and
// orders-of-magnitude speed on big trees. Returns null when rg is not
// installed or errors unexpectedly, so the caller can fall back to the walk.
async function searchWithRipgrep(
  cwd: string,
  pattern: string | undefined,
  query: string | undefined,
  maxResults: number,
): Promise<SearchOutcome | null> {
  try {
    if (query) {
      const args = [
        '--no-config',
        '--ignore-case',
        '--fixed-strings',
        '--line-number',
        '--no-heading',
        '--color', 'never',
        '--max-count', String(maxResults),
        '--max-filesize', '2M',
        '--max-columns', '500',
        '-e', query,
        '.',
      ];
      const { stdout } = await execFileAsync('rg', args, {
        cwd,
        maxBuffer: RG_MAX_BUFFER,
        timeout: RG_TIMEOUT_MS,
      });
      const matches: string[] = [];
      let hitResultLimit = false;
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const firstColon = line.indexOf(':');
        const secondColon = firstColon >= 0 ? line.indexOf(':', firstColon + 1) : -1;
        if (firstColon <= 0 || secondColon < 0) continue;
        const relative = normalizeRelative(line.slice(0, firstColon));
        if (pattern && !relative.toLowerCase().includes(pattern)) continue;
        if (matches.length >= maxResults) {
          hitResultLimit = true;
          break;
        }
        const lineNumber = line.slice(firstColon + 1, secondColon);
        const content = line.slice(secondColon + 1);
        matches.push(`${relative}:${lineNumber}: ${truncate(content.trim(), 240)}`);
      }
      return { matches, hitResultLimit };
    }

    // pattern-only search: list files and filter by path substring
    const { stdout } = await execFileAsync('rg', ['--no-config', '--files', '--color', 'never'], {
      cwd,
      maxBuffer: RG_MAX_BUFFER,
      timeout: RG_TIMEOUT_MS,
    });
    const matches: string[] = [];
    let hitResultLimit = false;
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const relative = normalizeRelative(line);
      if (pattern && !relative.toLowerCase().includes(pattern)) continue;
      if (matches.length >= maxResults) {
        hitResultLimit = true;
        break;
      }
      matches.push(relative);
    }
    return { matches, hitResultLimit };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string };
    // Exit code 1 = no matches (rg convention), not an error.
    if (typeof err.code === 'number' && err.code === 1) {
      return { matches: [], hitResultLimit: false };
    }
    // rg not installed, timed out, or anything else → fall back to the walk.
    return null;
  }
}

// Slow path: original walk-based substring scan (no external dependency).
async function searchWithWalk(
  cwd: string,
  pattern: string | undefined,
  query: string | undefined,
  maxResults: number,
): Promise<SearchOutcome> {
  const files = await walkFiles(cwd);
  const matches: string[] = [];
  let hitResultLimit = false;

  for (const file of files) {
    if (matches.length >= maxResults) {
      hitResultLimit = true;
      break;
    }

    const relative = path.relative(cwd, file);
    const fileNameMatch = !pattern || relative.toLowerCase().includes(pattern);

    if (!query) {
      if (fileNameMatch) {
        matches.push(relative);
      }
      continue;
    }

    if (!fileNameMatch) {
      continue;
    }

    try {
      const content = await readTextFileSafe(file);
      const lines = content.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= maxResults) {
          hitResultLimit = true;
          break;
        }

        const line = lines[index];
        if (!line.toLowerCase().includes(query)) {
          continue;
        }

        matches.push(
          `${relative}:${index + 1}: ${truncate(line.trim(), 240)}`,
        );
      }
    } catch {
      continue;
    }
  }

  return { matches, hitResultLimit };
}

export async function executeSearchFiles(
  action: Extract<AgentAction, { type: 'search_files' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const maxResults = Math.min(Math.max(action.maxResults ?? 10, 1), 50);
  const pattern = action.pattern?.trim().toLowerCase() || undefined;
  const query = action.query?.trim().toLowerCase() || undefined;
  const warnings: string[] = [];

  // No pattern and no query — instead of hard-failing, list a brief inventory
  // of the workspace so the agent can pick a real next step. Hard failure used
  // to send the loop into "tool failed" → retry with same args → fail again.
  if (!pattern && !query) {
    const files = await walkFiles(context.cwd);
    const sample = files
      .slice(0, 25)
      .map((file) => path.relative(context.cwd, file));
    return {
      action,
      ok: true,
      output: [
        'search_files was called without pattern or query — returning a workspace inventory instead.',
        'For a real search, pass `query` (file content substring) and/or `pattern` (path substring).',
        '',
        sample.length === 0
          ? '(workspace appears empty)'
          : sample.join('\n') + (files.length > sample.length ? `\n... (+${files.length - sample.length} more)` : ''),
      ].join('\n'),
    };
  }

  const outcome =
    (await searchWithRipgrep(context.cwd, pattern, query, maxResults))
    ?? (await searchWithWalk(context.cwd, pattern, query, maxResults));
  const { matches, hitResultLimit } = outcome;

  if (hitResultLimit) {
    warnings.push(
      `Search hit the result cap (${maxResults}). Narrow the pattern or search directory-by-directory if you suspect truncation.`,
    );
  }

  return {
    action,
    ok: true,
    output: matches.length > 0
      ? [
          ...(warnings.length > 0
            ? ['warnings:', ...warnings.map((warning) => `- ${warning}`), '']
            : []),
          matches.join('\n\n'),
        ].join('\n')
      : 'No files matched the requested search.',
  };
}
