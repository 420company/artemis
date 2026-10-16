/**
 * storage/conversationSearch.ts — full-text search across conversations,
 * down to the message (`artemis session search`).
 *
 * The session index (sessionSearch.ts) ranks which conversations match; each
 * of those is then read whole, archived pages included, and every visible
 * message (the owner's and the agent's text, as a chat UI shows it) is
 * matched. A hit carries its message id, a snippet with the matched ranges,
 * and how many visible messages come after it, so a host that shows history
 * a page at a time can page back far enough to show it.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { searchSessionCandidates } from './sessionSearch.js';
import { isChatVisibleMessage, SessionStore } from './sessions.js';
import { userVisibleMessageText } from '../utils/internalNames.js';
import { resolveDataRootDir } from '../utils/fs.js';

export type MessageHit = {
  messageId: string;
  role: 'user' | 'assistant';
  createdAt: string;
  /** Text around the first match, on one line, `…` where it was cut. */
  snippet: string;
  /** [start, end) ranges in `snippet` that matched, in order. */
  highlights: Array<[number, number]>;
  /** Visible messages after this one in the conversation (0: the latest). */
  newerCount: number;
};

export type ConversationMatch = {
  sessionId: string;
  title: string;
  updatedAt: string;
  /** Matching visible messages in the conversation (hits holds the newest few). */
  matchCount: number;
  hits: MessageHit[];
};

export type ConversationSearchOptions = {
  /** Only this conversation. */
  sessionId?: string;
  /** Most conversations returned (default 20). */
  limit?: number;
  /** Most hits per conversation (default 5). */
  hitsPerConversation?: number;
};

const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 140;
const MAX_QUERY_CHARS = 200;

/** Words of the query, lowercased; a query without word characters keeps its trimmed text. */
export function queryTerms(query: string): string[] {
  const trimmed = query.trim().slice(0, MAX_QUERY_CHARS).toLowerCase();
  const words = trimmed.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const terms = [...new Set(words.length ? words : trimmed ? [trimmed] : [])];
  // Longest first, so a highlight covers "report" before "rep".
  return terms.sort((a, b) => b.length - a.length);
}

/**
 * Whether `text` matches: the whole query as typed, or every term somewhere.
 * Returns the ranges to highlight (all occurrences of the phrase or terms).
 */
/**
 * `text` lowercased one code unit group at a time, with where each lowered
 * position came from: lowercasing can change the length ("İ" → "i̇"), and
 * the highlights must point into the original text.
 */
function lowerWithMap(text: string): { lower: string; origin: number[] } {
  let lower = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i)!;
    const width = code > 0xffff ? 2 : 1;
    const lowered = text.slice(i, i + width).toLowerCase();
    for (let k = 0; k < lowered.length; k += 1) origin.push(i);
    lower += lowered;
    i += width;
  }
  origin.push(text.length);
  return { lower, origin };
}

export function matchText(text: string, query: string): Array<[number, number]> | null {
  const { lower, origin } = lowerWithMap(text);
  const phrase = query.trim().slice(0, MAX_QUERY_CHARS).toLowerCase();
  const terms = queryTerms(query);
  if (!phrase) return null;
  let needles: string[];
  if (lower.includes(phrase)) needles = [phrase];
  else if (terms.length > 0 && terms.every((term) => lower.includes(term))) needles = terms;
  else return null;
  const ranges: Array<[number, number]> = [];
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      // Back to positions in the original text (the end: just past the last matched character).
      const endOrigin = origin[at + needle.length - 1]!;
      const endWidth = (text.codePointAt(endOrigin) ?? 0) > 0xffff ? 2 : 1;
      ranges.push([origin[at]!, endOrigin + endWidth]);
      from = at + needle.length;
    }
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push([range[0], range[1]]);
  }
  return out;
}

/** One line around the first range, with the ranges that fall inside it moved into place. */
export function buildSnippet(text: string, ranges: Array<[number, number]>): { snippet: string; highlights: Array<[number, number]> } {
  // Lines become spaces one for one, so the ranges still line up.
  const flat = text.replace(/[\r\n\t]/g, ' ');
  const first = ranges[0] ?? [0, 0];
  let start = Math.max(0, first[0] - SNIPPET_BEFORE);
  let end = Math.min(flat.length, first[1] + SNIPPET_AFTER);
  // Never split a surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(flat[start] ?? '')) start -= 1;
  if (end < flat.length && /[\uDC00-\uDFFF]/.test(flat[end] ?? '')) end += 1;
  const lead = start > 0 ? '…' : '';
  const tail = end < flat.length ? '…' : '';
  const highlights = ranges
    .filter(([s, e]) => s >= start && e <= end)
    .map(([s, e]) => [s - start + lead.length, e - start + lead.length] as [number, number]);
  return { snippet: `${lead}${flat.slice(start, end)}${tail}`, highlights };
}

/** At most this many archives (newest first) and this many bytes are read per search. */
const MAX_ARCHIVES_PER_SEARCH = 200;
const MAX_ARCHIVE_BYTES_PER_SEARCH = 48 * 1024 * 1024;

/**
 * Sessions whose transcript archive (pages compaction moved out of the live
 * history) has a visible message that matches: only the owner's and the
 * agent's text counts, never the JSON around it. Bounded: the newest
 * archives first, within a file and byte budget, stopping at `wanted`.
 */
async function sessionsWithArchivedMatch(cwd: string, query: string, wanted: number, skip: ReadonlySet<string>): Promise<string[]> {
  const sessionDir = path.join(resolveDataRootDir(cwd), 'sessions');
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return [];
  }
  const archives: Array<{ id: string; file: string; mtimeMs: number; size: number }> = [];
  for (const entry of entries) {
    if (entry.endsWith('.json') || entry.endsWith('.lock') || skip.has(entry)) continue;
    const file = path.join(sessionDir, entry, 'transcript.jsonl');
    try {
      const info = await stat(file);
      if (info.isFile()) archives.push({ id: entry, file, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // No archive: nothing was compacted in this session.
    }
  }
  archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const found: string[] = [];
  let budget = MAX_ARCHIVE_BYTES_PER_SEARCH;
  for (const archive of archives.slice(0, MAX_ARCHIVES_PER_SEARCH)) {
    if (found.length >= wanted || archive.size > budget) break;
    budget -= archive.size;
    let raw: string;
    try {
      raw = await readFile(archive.file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let message: { role?: unknown; content?: unknown; name?: unknown } | undefined;
      try {
        message = (JSON.parse(line) as { message?: { role?: unknown; content?: unknown; name?: unknown } }).message;
      } catch {
        continue;
      }
      if ((message?.role !== 'user' && message?.role !== 'assistant') || typeof message.content !== 'string') continue;
      // Runtime context kept in the history: never the user's words.
      if (message.name === 'runtime_context') continue;
      const text = message.role === 'user' ? userVisibleMessageText(message.content) : message.content;
      if (matchText(text, query)) {
        found.push(archive.id);
        break;
      }
    }
  }
  return found;
}

export async function searchConversations(
  cwd: string,
  query: string,
  options: ConversationSearchOptions = {},
): Promise<ConversationMatch[]> {
  if (!query.trim()) return [];
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const perConversation = Math.max(1, Math.min(50, options.hitsPerConversation ?? 5));
  const store = new SessionStore(cwd);
  const candidates = options.sessionId
    ? [options.sessionId]
    : await searchSessionCandidates(cwd, query, { maxResults: Math.max(limit * 2, 24) });
  if (!options.sessionId && candidates.length < limit * 2) {
    // The index holds the live history only: pages compaction moved to a
    // session's transcript archive are looked through as well.
    for (const id of await sessionsWithArchivedMatch(cwd, query, limit * 2 - candidates.length, new Set(candidates))) candidates.push(id);
  }

  const matches: ConversationMatch[] = [];
  for (const sessionId of candidates) {
    if (matches.length >= limit) break;
    let session;
    try {
      session = await store.load(sessionId, { readOnly: true });
    } catch {
      continue;
    }
    // Delegated helper sessions are not conversations the owner had.
    if (session.kind === 'agent') continue;
    const { messages } = await store.loadFullHistory(session);
    const visible = messages.filter(isChatVisibleMessage);
    const hits: MessageHit[] = [];
    let matchCount = 0;
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const message = visible[i]!;
      const text = message.role === 'user' ? userVisibleMessageText(message.content) : message.content;
      const ranges = matchText(text, query);
      if (!ranges) continue;
      matchCount += 1;
      if (hits.length >= perConversation) continue;
      hits.push({
        messageId: message.id,
        role: message.role as 'user' | 'assistant',
        createdAt: message.createdAt,
        ...buildSnippet(text, ranges),
        newerCount: visible.length - 1 - i,
      });
    }
    if (matchCount === 0) continue;
    matches.push({ sessionId: session.id, title: session.title, updatedAt: session.updatedAt, matchCount, hits });
  }
  return matches;
}
