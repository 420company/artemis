/**
 * Local deep-research engine — the "builtin" fallback when Gemini Deep
 * Research is not configured.
 *
 * Runs a bounded plan → search → read → digest loop on the cheap
 * specialist/worker provider (falling back to the main profile) at low
 * effort, using the existing searchWeb backends (DuckDuckGo works with zero
 * keys) and an axios+cheerio page extractor. Depth is intentionally modest —
 * the goal is "always-available research", not parity with Gemini's
 * server-side agent.
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { searchWeb } from '../core/searchTools.js';
import { createProviderFromConfig } from '../providers/factory.js';
import { ProviderStore } from '../providers/store.js';
import { resolveArtemisHomeDir } from '../utils/fs.js';
import type { ChatProvider, ProviderConfig } from '../providers/types.js';
import type { SessionMessage } from '../core/types.js';
import type { UiLocale } from '../cli/locale.js';
import { pickLocale } from '../cli/locale.js';

const MAX_ROUNDS = 2;
const QUERIES_PER_ROUND = 3;
const PAGES_PER_ROUND = 4;
const PAGE_EXCERPT_CHARS = 8_000;
const NOTES_CHAR_CAP = 12_000;
const PAGE_FETCH_TIMEOUT_MS = 15_000;

export type LocalDeepResearchSource = {
  index: number;
  url: string;
  title: string;
};

export type LocalDeepResearchResult = {
  status: 'completed' | 'failed';
  reportMarkdown?: string;
  sources: LocalDeepResearchSource[];
  roundsRun: number;
  pagesRead: number;
  error?: string;
};

// ── provider resolution (specialist → main, cwd → global) ────────────────────

async function resolveResearchProvider(cwd: string): Promise<ChatProvider | null> {
  for (const preferSpecialist of [true, false]) {
    for (const root of [cwd, resolveArtemisHomeDir()]) {
      try {
        const store = new ProviderStore(root);
        const data = await store.load();
        const profile = preferSpecialist
          ? store.getProfile(data, data.specialistProfileId)
          : store.getDefaultMainProfile(data);
        if (profile) {
          const config: ProviderConfig = { ...(profile as ProviderConfig), effort: 'low' };
          return createProviderFromConfig(config);
        }
      } catch {
        // try next root
      }
    }
  }
  return null;
}

// ── page extraction ───────────────────────────────────────────────────────────

async function extractPageText(url: string): Promise<string | null> {
  try {
    const response = await axios.get<string>(url, {
      timeout: PAGE_FETCH_TIMEOUT_MS,
      maxContentLength: 4 * 1024 * 1024,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const contentType = String(response.headers['content-type'] ?? '');
    if (contentType && !/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
      return null;
    }
    const $ = cheerio.load(response.data);
    $('script, style, noscript, svg, nav, footer, iframe, form').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.slice(0, PAGE_EXCERPT_CHARS);
  } catch {
    return null;
  }
}

// ── JSON reply parsing (same brace-scan approach as team.ts) ─────────────────

function parseJsonBlock(raw: string): Record<string, unknown> | null {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '{') continue;
    let depth = 0;
    let j = i;
    while (j < raw.length) {
      if (raw[j] === '{') depth += 1;
      else if (raw[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    if (depth !== 0) continue;
    try {
      return JSON.parse(raw.slice(i, j + 1)) as Record<string, unknown>;
    } catch {
      // try next opening brace
    }
  }
  return null;
}

function asStringArray(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, cap);
}

// ── LLM calls ─────────────────────────────────────────────────────────────────

function makeMessages(system: string, user: string): SessionMessage[] {
  const now = new Date().toISOString();
  return [
    { id: `ldr-sys-${Date.now()}`, role: 'system', content: system, createdAt: now },
    { id: `ldr-usr-${Date.now()}`, role: 'user', content: user, createdAt: now },
  ] as SessionMessage[];
}

async function completeText(provider: ChatProvider, system: string, user: string): Promise<string> {
  const response = await provider.complete(makeMessages(system, user));
  return response.text ?? '';
}

// ── main loop ─────────────────────────────────────────────────────────────────

export async function runLocalDeepResearch(options: {
  prompt: string;
  cwd: string;
  locale?: UiLocale;
  systemInstruction?: string;
  maxRounds?: number;
  onInfo?: (message: string) => void;
}): Promise<LocalDeepResearchResult> {
  const locale = options.locale ?? 'en';
  const maxRounds = Math.max(1, Math.min(4, options.maxRounds ?? MAX_ROUNDS));
  const provider = await resolveResearchProvider(options.cwd);
  if (!provider) {
    return {
      status: 'failed',
      sources: [],
      roundsRun: 0,
      pagesRead: 0,
      error: pickLocale(locale, {
        zh: '本地研究引擎需要至少一个已配置的 AI provider（providers.json 为空）。',
        en: 'The local research engine needs at least one configured AI provider (providers.json is empty).',
      }),
    };
  }

  const baseSystem = [
    'You are the planning/digest engine inside a bounded web-research loop.',
    'Always answer with exactly one JSON object and nothing else.',
    options.systemInstruction ? `Task context from the caller: ${options.systemInstruction}` : '',
  ].filter(Boolean).join('\n');

  // Round 0: derive initial search queries.
  let queries: string[] = [];
  try {
    const planReply = await completeText(
      provider,
      baseSystem,
      [
        `Research question:\n${options.prompt.trim()}`,
        '',
        `Produce up to ${QUERIES_PER_ROUND} web search queries that together cover the question.`,
        'Use the question\'s own language for queries unless English clearly retrieves better sources.',
        'JSON schema: {"queries": ["..."]}',
      ].join('\n'),
    );
    queries = asStringArray(parseJsonBlock(planReply)?.queries, QUERIES_PER_ROUND);
  } catch {
    // fall through to raw-question query
  }
  if (queries.length === 0) queries = [options.prompt.trim().slice(0, 200)];

  let notes = '';
  const sources: LocalDeepResearchSource[] = [];
  const seenUrls = new Set<string>();
  let pagesRead = 0;
  let roundsRun = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    roundsRun = round;
    options.onInfo?.(pickLocale(locale, {
      zh: `本地研究 第${round}轮：搜索 ${queries.map((q) => `“${q}”`).join(' / ')}`,
      en: `Local research round ${round}: searching ${queries.map((q) => `"${q}"`).join(' / ')}`,
    }));

    // Search all queries in parallel; tolerate individual failures.
    const searchResults = await Promise.all(
      queries.map((q) => searchWeb(q, 5).catch(() => null)),
    );
    const candidates: Array<{ url: string; title: string; description: string }> = [];
    for (const result of searchResults) {
      if (!result?.success) continue;
      for (const item of result.data.web) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        candidates.push({ url: item.url, title: item.title, description: item.description ?? '' });
      }
    }
    const picked = candidates.slice(0, PAGES_PER_ROUND);

    // Fetch pages in parallel; drop failures silently.
    const excerpts = await Promise.all(
      picked.map(async (candidate) => ({
        candidate,
        text: await extractPageText(candidate.url),
      })),
    );
    const materials: string[] = [];
    for (const { candidate, text } of excerpts) {
      if (!text) continue;
      pagesRead += 1;
      const index = sources.length + 1;
      sources.push({ index, url: candidate.url, title: candidate.title || candidate.url });
      materials.push(`[${index}] ${candidate.title}\nURL: ${candidate.url}\nExcerpt: ${text}`);
    }

    if (materials.length === 0 && round === 1 && candidates.length === 0) {
      return {
        status: 'failed',
        sources,
        roundsRun,
        pagesRead,
        error: pickLocale(locale, {
          zh: '所有搜索后端都没有返回结果（网络或搜索引擎不可用）。',
          en: 'No search backend returned results (network or search engines unavailable).',
        }),
      };
    }

    // Digest + plan next round in a single call.
    try {
      const digestReply = await completeText(
        provider,
        baseSystem,
        [
          `Research question:\n${options.prompt.trim()}`,
          '',
          notes ? `Accumulated notes so far:\n${notes}` : 'No notes yet.',
          '',
          materials.length > 0
            ? `New source material this round (cite by [index]):\n\n${materials.join('\n\n---\n\n')}`
            : 'No new material could be fetched this round.',
          '',
          'Update the research notes: merge new confirmed facts (each with its [index] citation), keep prior facts, drop speculation.',
          round < maxRounds
            ? `If important gaps remain, propose up to ${QUERIES_PER_ROUND} follow-up search queries; otherwise return an empty list.`
            : 'This is the final round; return an empty queries list.',
          `JSON schema: {"notes": "markdown notes with [n] citations", "queries": ["follow-up query"]}`,
        ].join('\n'),
      );
      const parsed = parseJsonBlock(digestReply);
      const nextNotes = typeof parsed?.notes === 'string' ? parsed.notes.trim() : '';
      if (nextNotes) notes = nextNotes.slice(0, NOTES_CHAR_CAP);
      else if (materials.length > 0) notes = `${notes}\n\n${materials.join('\n\n')}`.slice(0, NOTES_CHAR_CAP);
      queries = asStringArray(parsed?.queries, QUERIES_PER_ROUND);
    } catch {
      // Digest failed — keep raw materials as notes and stop iterating.
      if (materials.length > 0) notes = `${notes}\n\n${materials.join('\n\n')}`.slice(0, NOTES_CHAR_CAP);
      queries = [];
    }

    if (queries.length === 0) break;
  }

  if (!notes.trim()) {
    return {
      status: 'failed',
      sources,
      roundsRun,
      pagesRead,
      error: pickLocale(locale, {
        zh: '没有收集到任何可用材料（页面抓取全部失败）。',
        en: 'No usable material was collected (all page fetches failed).',
      }),
    };
  }

  // Final synthesis.
  let report = '';
  try {
    report = (await completeText(
      provider,
      [
        'You are a research writer. Write in the same language as the research question.',
        'Only state what the notes support; keep every [n] citation attached to its claim.',
        'End with a short "未核实/Limitations" section listing what remains unverified.',
        options.systemInstruction ? `Task context from the caller: ${options.systemInstruction}` : '',
      ].filter(Boolean).join('\n'),
      [
        `Research question:\n${options.prompt.trim()}`,
        '',
        `Research notes (with [n] citations):\n${notes}`,
        '',
        'Write the final research report in markdown: a 2-3 sentence summary, then the findings with citations, then limitations. Do not invent a sources list — it is appended automatically.',
      ].join('\n'),
    )).trim();
  } catch {
    report = notes;
  }

  const sourceLines = sources.map((s) => `[${s.index}] ${s.title} — ${s.url}`);
  const reportMarkdown = [
    report,
    '',
    pickLocale(locale, { zh: '## 来源', en: '## Sources' }),
    sourceLines.length > 0
      ? sourceLines.join('\n')
      : pickLocale(locale, { zh: '（无可用来源）', en: '(no usable sources)' }),
  ].join('\n');

  return { status: 'completed', reportMarkdown, sources, roundsRun, pagesRead };
}
