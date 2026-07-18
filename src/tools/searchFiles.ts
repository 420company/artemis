import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAction } from '../core/types.js';
import { readTextFileSafe, truncate, walkFiles } from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

const execFileAsync = promisify(execFile);

const RG_TIMEOUT_MS = 20_000;
const RG_MAX_BUFFER = 16 * 1024 * 1024;

// Advanced-mode budgets (mirrors ripgrep-backed grep tools elsewhere).
const MAX_LINE_CHARS = 1_000;
const MAX_OUTPUT_BYTES = 5_000_000;
const CONTENT_LINE_DEFAULT = 200;
const CONTENT_LINE_LIMIT = 2_000;
const FILE_COUNT_DEFAULT = 500;
const FILE_COUNT_LIMIT = 10_000;
const MAX_CONTEXT_LINES = 20;

type SearchOutcome = { matches: string[]; hitResultLimit: boolean };

type OutputMode = 'content' | 'files_with_matches' | 'count';

// Advanced parameters arrive through the tool-call spread and are validated in
// the registry; they are not part of the core AgentAction shape. snake_case
// aliases are accepted because grep-style tools commonly use those names.
type SearchFilesAdvanced = {
  literal?: unknown;
  glob?: unknown;
  fileType?: unknown;
  file_type?: unknown;
  outputMode?: unknown;
  output_mode?: unknown;
  context?: unknown;
  headLimit?: unknown;
  head_limit?: unknown;
  multiline?: unknown;
};

function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true' || trimmed === '1') return true;
    if (trimmed === 'false' || trimmed === '0') return false;
  }
  return undefined;
}

function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

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

type AdvancedOptions = {
  query: string;
  pattern?: string;
  literal: boolean;
  glob?: string;
  fileType?: string;
  outputMode: OutputMode;
  context: number;
  headLimit: number;
  multiline: boolean;
};

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) {
    return line;
  }
  return `${line.slice(0, MAX_LINE_CHARS)} [... line truncated, ${line.length} chars total]`;
}

function buildAdvancedArgs(options: AdvancedOptions, forceLiteral: boolean): string[] {
  const args = [
    '--no-config',
    '--ignore-case',
    '--no-heading',
    '--color', 'never',
    '--max-filesize', '2M',
  ];
  if (options.literal || forceLiteral) {
    args.push('--fixed-strings');
  }
  if (options.multiline) {
    args.push('--multiline', '--multiline-dotall');
  }
  if (options.glob) {
    args.push('--glob', options.glob);
  }
  if (options.fileType) {
    args.push('--type', options.fileType);
  }
  if (options.outputMode === 'files_with_matches') {
    args.push('--files-with-matches');
  } else if (options.outputMode === 'count') {
    args.push('--count');
  } else {
    args.push('--line-number');
    if (options.context > 0) {
      args.push('--context', String(options.context));
    }
  }
  args.push('-e', options.query, '.');
  return args;
}

function collectAdvancedOutput(
  stdout: string,
  options: AdvancedOptions,
  warnings: string[],
): string[] {
  const results: string[] = [];
  let bytes = 0;

  for (const rawLine of stdout.split('\n')) {
    if (!rawLine) continue;

    // Path filter (legacy `pattern` compatibility). Context lines use a
    // `path-line-content` layout that cannot be split reliably, so pattern
    // filtering is skipped when context is requested (a warning explains it).
    if (options.pattern && (options.outputMode !== 'content' || options.context === 0)) {
      const colon = rawLine.indexOf(':');
      const filePart =
        options.outputMode === 'files_with_matches'
          ? rawLine
          : rawLine.slice(0, colon > 0 ? colon : rawLine.length);
      if (!normalizeRelative(filePart).toLowerCase().includes(options.pattern)) {
        continue;
      }
    }

    if (results.length >= options.headLimit) {
      warnings.push(
        `Results truncated at ${options.headLimit} line(s). Narrow the search or raise headLimit.`,
      );
      break;
    }

    // Strip rg's leading "./" from the path prefix without touching the
    // line content (backslashes in content must survive).
    const line = truncateLine(rawLine.replace(/^\.\//, ''));
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (bytes > MAX_OUTPUT_BYTES) {
      warnings.push(`Output truncated at the ${MAX_OUTPUT_BYTES}-byte cap.`);
      break;
    }
    results.push(line);
  }

  return results;
}

async function searchAdvanced(cwd: string, options: AdvancedOptions): Promise<string> {
  const warnings: string[] = [];
  if (options.pattern && options.outputMode === 'content' && options.context > 0) {
    warnings.push(
      'pattern (path substring) is ignored when context > 0; use glob to scope files instead.',
    );
  }

  let stdout = '';
  let usedLiteralFallback = false;
  try {
    ({ stdout } = await execFileAsync('rg', buildAdvancedArgs(options, false), {
      cwd,
      maxBuffer: RG_MAX_BUFFER,
      timeout: RG_TIMEOUT_MS,
    }));
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (typeof err.code === 'number' && err.code === 1) {
      stdout = '';
    } else if (
      typeof err.code === 'number' &&
      err.code === 2 &&
      !options.literal &&
      /regex parse error|error parsing pattern/i.test(err.stderr ?? '')
    ) {
      // Invalid regex → retry as a literal string so plain-text queries with
      // regex metacharacters keep working.
      usedLiteralFallback = true;
      try {
        ({ stdout } = await execFileAsync('rg', buildAdvancedArgs(options, true), {
          cwd,
          maxBuffer: RG_MAX_BUFFER,
          timeout: RG_TIMEOUT_MS,
        }));
      } catch (retryError) {
        const retryErr = retryError as NodeJS.ErrnoException;
        if (typeof retryErr.code === 'number' && retryErr.code === 1) {
          stdout = '';
        } else {
          throw new Error(
            `search_files failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          );
        }
      }
    } else if (err.code === 'ENOENT') {
      throw new Error(
        'search_files advanced options (regex/glob/fileType/outputMode/context/multiline) require ripgrep (rg), which was not found on PATH. Install ripgrep or use the basic query/pattern parameters.',
      );
    } else {
      const detail = (err.stderr ?? '').trim().split('\n')[0];
      throw new Error(
        `search_files failed: ${detail || (error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  if (usedLiteralFallback) {
    warnings.push('query was not a valid regex; matched it as a literal string instead.');
  }

  const results = collectAdvancedOutput(stdout, options, warnings);

  return [
    ...(warnings.length > 0
      ? ['warnings:', ...warnings.map((warning) => `- ${warning}`), '']
      : []),
    results.length > 0 ? results.join('\n') : 'No files matched the requested search.',
  ].join('\n');
}

export async function executeSearchFiles(
  action: Extract<AgentAction, { type: 'search_files' }>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const advanced = action as SearchFilesAdvanced;
  const literal = toBoolean(advanced.literal);
  const glob = toNonEmptyString(advanced.glob);
  const fileType = toNonEmptyString(advanced.fileType ?? advanced.file_type);
  const outputModeRaw = toNonEmptyString(advanced.outputMode ?? advanced.output_mode);
  const contextLines = toInteger(advanced.context);
  const headLimitRaw = toInteger(advanced.headLimit ?? advanced.head_limit);
  const multiline = toBoolean(advanced.multiline);
  const hasAdvancedParams =
    literal !== undefined ||
    glob !== undefined ||
    fileType !== undefined ||
    outputModeRaw !== undefined ||
    contextLines !== undefined ||
    headLimitRaw !== undefined ||
    multiline !== undefined;

  const maxResults = Math.min(Math.max(action.maxResults ?? 10, 1), 50);
  const pattern = action.pattern?.trim().toLowerCase() || undefined;
  const query = action.query?.trim() || undefined;
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
        'For a real search, pass `query` (file content search) and/or `pattern` (path substring).',
        '',
        sample.length === 0
          ? '(workspace appears empty)'
          : sample.join('\n') + (files.length > sample.length ? `\n... (+${files.length - sample.length} more)` : ''),
      ].join('\n'),
    };
  }

  // Advanced grep mode: any of the new parameters switches to the full
  // ripgrep surface (regex by default; `literal: true` restores -F).
  if (hasAdvancedParams && query) {
    const outputMode: OutputMode =
      outputModeRaw === 'files_with_matches' || outputModeRaw === 'count'
        ? outputModeRaw
        : 'content';
    const headLimit =
      outputMode === 'content'
        ? Math.min(headLimitRaw ?? CONTENT_LINE_DEFAULT, CONTENT_LINE_LIMIT)
        : Math.min(headLimitRaw ?? FILE_COUNT_DEFAULT, FILE_COUNT_LIMIT);
    const output = await searchAdvanced(context.cwd, {
      query,
      pattern,
      literal: literal === true,
      glob,
      fileType,
      outputMode,
      context: Math.min(Math.max(contextLines ?? 0, 0), MAX_CONTEXT_LINES),
      headLimit: Math.max(headLimit, 1),
      multiline: multiline === true,
    });
    return { action, ok: true, output };
  }

  const legacyQuery = query?.toLowerCase();
  const outcome =
    (await searchWithRipgrep(context.cwd, pattern, legacyQuery, maxResults))
    ?? (await searchWithWalk(context.cwd, pattern, legacyQuery, maxResults));
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
