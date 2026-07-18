/**
 * tools/pathSuggestions.ts — enrichment hints for path-not-found errors.
 *
 * When a tool is asked for a path that does not exist, append actionable
 * guidance: a "dropped repo folder" correction (/parent/foo requested while
 * cwd is /parent/repo and /parent/repo/foo exists), up to three similar names
 * from the parent directory, and always the current working directory. All
 * filesystem probing is capped at 100ms so error paths never stall.
 */

import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { pathExists } from '../utils/fs.js';

const HINT_TIMEOUT_MS = 100;
const MAX_SIMILAR = 3;
const MIN_LEAF_LEN = 2;
const MIN_REVERSE_STEM_LEN = 4;

type CollectedHints = {
  suggestion: string | null;
  similar: string[];
};

const EMPTY_HINTS: CollectedHints = { suggestion: null, similar: [] };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(fallback), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolvePromise(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolvePromise(fallback);
      });
  });
}

/**
 * Detect the "dropped repo folder" pattern: the request targets /parent/foo
 * while cwd is /parent/repo — the model likely dropped the repo directory
 * segment. Fires only when the requested path is under cwd's parent but not
 * under cwd, no real sibling shadows it, and /parent/repo/foo exists.
 */
async function trySuggestUnderCwd(absolute: string, cwd: string): Promise<string | null> {
  if (!path.isAbsolute(absolute) || absolute === cwd || absolute.startsWith(`${cwd}${path.sep}`)) {
    return null;
  }

  const cwdParent = path.dirname(cwd);
  if (cwdParent === cwd) {
    return null;
  }
  const relFromParent = path.relative(cwdParent, absolute);
  if (!relFromParent || relFromParent.startsWith('..') || path.isAbsolute(relFromParent)) {
    return null;
  }

  const firstSegment = relFromParent.split(path.sep)[0];
  if (firstSegment) {
    const sibling = path.join(cwdParent, firstSegment);
    if (sibling !== cwd && (await pathExists(sibling))) {
      return null;
    }
  }

  const candidate = path.join(cwd, relFromParent);
  return (await pathExists(candidate)) ? candidate : null;
}

function stemOf(name: string): string {
  const ext = path.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

/**
 * Scan the missing path's parent directory for case-insensitive substring
 * matches on the leaf name (both directions; reverse matches require a stem
 * of at least MIN_REVERSE_STEM_LEN to avoid noise).
 */
async function findSimilarEntries(absolute: string): Promise<string[]> {
  const parent = path.dirname(absolute);
  const base = path.basename(absolute).toLowerCase();
  if (base.length < MIN_LEAF_LEN) {
    return [];
  }
  const baseStem = stemOf(base);

  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    const name = entry.toLowerCase();
    if (name === base) {
      continue;
    }
    const nameStem = stemOf(name);
    const forward = nameStem.includes(baseStem);
    const reverse = !forward && nameStem.length >= MIN_REVERSE_STEM_LEN && baseStem.includes(nameStem);
    if (forward || reverse) {
      matches.push(entry);
      if (matches.length >= MAX_SIMILAR) {
        break;
      }
    }
  }
  return matches;
}

async function collectHints(absolute: string, cwd: string): Promise<CollectedHints> {
  const suggestion = await trySuggestUnderCwd(absolute, cwd);
  if (suggestion) {
    return { suggestion, similar: [] };
  }
  return { suggestion: null, similar: await findSimilarEntries(absolute) };
}

/**
 * Build the hint suffix to append after a "path does not exist" error
 * message. Always ends with the current working directory note.
 */
export async function pathNotFoundHint(absolute: string, cwd: string): Promise<string> {
  const { suggestion, similar } = await withTimeout(
    collectHints(absolute, cwd),
    HINT_TIMEOUT_MS,
    EMPTY_HINTS,
  );

  let hint = '';
  if (suggestion) {
    hint += ` Did you mean ${suggestion}?`;
  } else if (similar.length > 0) {
    hint += `\nSimilar entries in parent directory: ${similar.join(', ')}`;
  }
  hint += `\nNote: your current working directory is ${cwd}`;
  return hint;
}
