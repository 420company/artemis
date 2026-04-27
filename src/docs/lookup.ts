import {
  formatDocsSearchEngineLabel,
  type DocsSearchEngine,
} from './searchEngine.js';
import { APP_USER_AGENT } from '../appMeta.js';

type FetchLike = typeof fetch;

export type DocsLibraryProfile = {
  id: string;
  label: string;
  aliases: string[];
  domains: string[];
  sitemapUrls: string[];
  llmsIndexUrls?: string[];
  versionedLlmsIndexTemplate?: string;
  crawlRootUrls?: string[];
  urlPathHints?: string[];
};

export type DocsLookupItem = {
  title: string;
  url: string;
  snippet: string;
};

export type DocsLookupResult = {
  query: string;
  library?: DocsLibraryProfile;
  version?: string;
  strategy: 'llms-index' | 'sitemap' | 'crawl' | 'search-fallback';
  searchEngine: DocsSearchEngine;
  items: DocsLookupItem[];
};

type DocsCandidate = {
  title?: string;
  url: string;
  snippet?: string;
};

const REQUEST_HEADERS = {
  'user-agent': APP_USER_AGENT,
  accept: 'text/html,application/xml,text/xml;q=0.9,*/*;q=0.8',
};

const DEFAULT_MAX_RESULTS = 5;
const MAX_SITEMAP_URLS = 2_000;
const MAX_SITEMAP_FILES = 12;
const MAX_CRAWL_URLS = 1_200;
const SEARCH_ENDPOINT = 'https://www.bing.com/search?format=rss&q=';
const GOOGLE_SEARCH_ENDPOINT = 'https://www.google.com/search?hl=en&num=10&q=';
const DOCS_QUERY_STOP_WORDS = new Set([
  'api',
  'apis',
  'doc',
  'docs',
  'documentation',
  'framework',
  'guide',
  'guides',
  'library',
  'reference',
]);

export const DOCS_LIBRARY_REGISTRY: DocsLibraryProfile[] = [
  {
    id: 'react',
    label: 'React',
    aliases: ['react', 'reactjs'],
    domains: ['react.dev'],
    sitemapUrls: [],
    llmsIndexUrls: ['https://react.dev/llms.txt'],
    crawlRootUrls: [
      'https://react.dev/reference/react',
      'https://react.dev/reference/react-dom',
      'https://react.dev/reference/react-dom/client',
      'https://react.dev/learn',
    ],
    urlPathHints: ['/reference/react', '/reference/react-dom', '/learn'],
  },
  {
    id: 'nextjs',
    label: 'Next.js',
    aliases: ['next', 'nextjs', 'next.js'],
    domains: ['nextjs.org'],
    sitemapUrls: ['https://nextjs.org/sitemap.xml'],
    llmsIndexUrls: ['https://nextjs.org/docs/llms.txt'],
    versionedLlmsIndexTemplate: 'https://nextjs.org/docs/{major}/llms.txt',
    urlPathHints: ['/docs'],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    aliases: ['typescript', 'ts'],
    domains: ['typescriptlang.org', 'www.typescriptlang.org'],
    sitemapUrls: ['https://www.typescriptlang.org/sitemap-index.xml'],
    urlPathHints: ['/docs', '/tsconfig'],
  },
  {
    id: 'node',
    label: 'Node.js',
    aliases: ['node', 'nodejs', 'node.js'],
    domains: ['nodejs.org'],
    sitemapUrls: ['https://nodejs.org/sitemap.xml'],
    urlPathHints: ['/api'],
  },
  {
    id: 'playwright',
    label: 'Playwright',
    aliases: ['playwright'],
    domains: ['playwright.dev'],
    sitemapUrls: ['https://playwright.dev/sitemap.xml'],
    urlPathHints: ['/docs'],
  },
  {
    id: 'vite',
    label: 'Vite',
    aliases: ['vite'],
    domains: ['vite.dev'],
    sitemapUrls: ['https://vite.dev/sitemap.xml'],
    llmsIndexUrls: ['https://vite.dev/llms.txt'],
    urlPathHints: ['/guide', '/config', '/api'],
  },
  {
    id: 'tailwind',
    label: 'Tailwind CSS',
    aliases: ['tailwind', 'tailwindcss', 'tailwind-css'],
    domains: ['tailwindcss.com'],
    sitemapUrls: [],
    crawlRootUrls: ['https://tailwindcss.com/docs'],
    urlPathHints: ['/docs'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    aliases: ['openai'],
    domains: ['developers.openai.com', 'platform.openai.com', 'openai.com'],
    sitemapUrls: [
      'https://platform.openai.com/sitemap.xml',
      'https://openai.com/sitemap.xml',
    ],
    llmsIndexUrls: [
      'https://platform.openai.com/docs/llms.txt',
      'https://developers.openai.com/api/docs/llms.txt',
    ],
    urlPathHints: ['/api/docs', '/docs/guides', '/docs/api-reference'],
  },
  {
    id: 'figma',
    label: 'Figma',
    aliases: ['figma'],
    domains: ['figma.com', 'www.figma.com'],
    sitemapUrls: ['https://www.figma.com/sitemap.xml'],
    urlPathHints: ['/developers', '/plugin-docs', '/api'],
  },
];

const sitemapCache = new Map<string, Promise<string[]>>();
const llmsCache = new Map<string, Promise<DocsCandidate[]>>();
const crawlCache = new Map<string, Promise<string[]>>();

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, num) =>
      String.fromCodePoint(Number.parseInt(num, 10)),
    );
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function stripMarkdown(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/m, ' ')
      .replace(/^\s*---+\s*$/gm, ' ')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, ' $1 ')
      .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
      .replace(/\[([^\]]+)]\([^)]+\)/g, ' $1 ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/<\/?[^>]+>/g, ' ')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[>*-]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/\*\*|__|\*|_/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function tokenizeDocsQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9.\s/_-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function getScoringTokens(
  query: string,
  library?: DocsLibraryProfile,
  version?: string,
): string[] {
  const normalizedTokens = tokenizeDocsQuery(query);
  const ignoredTokens = new Set<string>([
    version?.toLowerCase() ?? '',
    ...(library?.aliases ?? []),
  ]);
  const filtered = normalizedTokens.filter(
    (token) => !ignoredTokens.has(token) && !DOCS_QUERY_STOP_WORDS.has(token),
  );
  return filtered.length > 0
    ? filtered
    : normalizedTokens.filter((token) => !DOCS_QUERY_STOP_WORDS.has(token));
}

export function inferDocsVersion(query: string): string | undefined {
  const match = query.match(/\b(v?\d+(?:\.\d+){0,2})\b/i);
  return match?.[1];
}

export function resolveDocsLibrary(
  explicitLibrary: string | undefined,
  query: string,
): DocsLibraryProfile | undefined {
  const normalizedExplicit = explicitLibrary?.trim().toLowerCase();
  if (normalizedExplicit) {
    return DOCS_LIBRARY_REGISTRY.find((library) =>
      library.aliases.includes(normalizedExplicit) ||
      library.id === normalizedExplicit,
    );
  }

  const tokens = tokenizeDocsQuery(query);
  return DOCS_LIBRARY_REGISTRY.find((library) =>
    library.aliases.some((alias) => tokens.includes(alias)),
  );
}

export function parseXmlLocs(xml: string): string[] {
  const urls: string[] = [];
  const regex = /<loc>([\s\S]*?)<\/loc>/gi;

  for (const match of xml.matchAll(regex)) {
    const value = decodeHtmlEntities(match[1] ?? '').trim();
    if (value) {
      urls.push(value);
    }
  }

  return urls;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/#.*$/, '');
}

function normalizeDocsDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('.md')) {
      parsed.pathname = parsed.pathname.slice(0, -3);
    }
    return normalizeUrl(parsed.toString());
  } catch {
    return normalizeUrl(url);
  }
}

function matchesLibraryDomain(
  hostname: string,
  library: DocsLibraryProfile,
): boolean {
  return library.domains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function getVersionMajor(version: string | undefined): string | undefined {
  return version?.trim().replace(/^v/i, '').split('.')[0]?.trim() || undefined;
}

function getLlmsIndexUrls(
  library: DocsLibraryProfile,
  version: string | undefined,
): string[] {
  const major = getVersionMajor(version);

  if (library.versionedLlmsIndexTemplate && major) {
    return [library.versionedLlmsIndexTemplate.replace('{major}', major)];
  }

  const urls = new Set<string>();
  for (const url of library.llmsIndexUrls ?? []) {
    urls.add(url);
  }

  return [...urls];
}

function parseFrontmatterValue(
  markdown: string,
  key: string,
): string | undefined {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1];
  if (!frontmatter) {
    return undefined;
  }

  const match = frontmatter.match(
    new RegExp(`^${key}:\\s*(.+)$`, 'mi'),
  )?.[1];
  return match?.trim().replace(/^["']|["']$/g, '') || undefined;
}

function extractMarkdownCanonicalUrl(
  markdown: string,
  sourceUrl: string,
): string | undefined {
  const candidate = parseFrontmatterValue(markdown, 'url');
  if (!candidate) {
    return undefined;
  }

  try {
    return normalizeDocsDisplayUrl(new URL(candidate, sourceUrl).toString());
  } catch {
    return undefined;
  }
}

function extractMarkdownTitle(
  markdown: string,
  url: string,
): string {
  const frontmatterTitle = parseFrontmatterValue(markdown, 'title');
  if (frontmatterTitle) {
    return frontmatterTitle;
  }

  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || url;
}

function extractMarkdownSnippet(markdown: string): string {
  const description = parseFrontmatterValue(markdown, 'description');
  if (description) {
    return truncate(description, 320);
  }

  return truncate(stripMarkdown(markdown), 320);
}

function isAllowedDocsUrl(
  value: string,
  library: DocsLibraryProfile,
): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return false;
    }

    if (!matchesLibraryDomain(hostname, library)) {
      return false;
    }

    const pathname = url.pathname.toLowerCase();
    if (
      /\.(?:png|jpe?g|svg|gif|webp|ico|css|js|mjs|json|txt|xml|map|woff2?)$/i.test(
        pathname,
      )
    ) {
      return false;
    }

    return pathname !== '/' || !library.domains.includes(hostname);
  } catch {
    return false;
  }
}

export function parseHtmlLinks(
  html: string,
  baseUrl: string,
  library: DocsLibraryProfile,
): string[] {
  const links = new Set<string>();
  const hrefRegex = /href=["']([^"'#]+)["']/gi;

  for (const match of html.matchAll(hrefRegex)) {
    const raw = decodeHtmlEntities(match[1] ?? '').trim();
    if (
      !raw ||
      raw.startsWith('#') ||
      raw.startsWith('mailto:') ||
      raw.startsWith('javascript:')
    ) {
      continue;
    }

    let resolved = '';
    try {
      resolved = normalizeUrl(new URL(raw, baseUrl).toString());
    } catch {
      continue;
    }

    if (isAllowedDocsUrl(resolved, library)) {
      links.add(resolved);
      if (links.size >= MAX_CRAWL_URLS) {
        break;
      }
    }
  }

  return [...links];
}

function parseMarkdownIndexEntries(
  markdown: string,
  sourceUrl: string,
  library: DocsLibraryProfile,
): DocsCandidate[] {
  const entries: DocsCandidate[] = [];
  const seen = new Set<string>();

  for (const line of markdown.split(/\r?\n/)) {
    for (const match of line.matchAll(/\[([^\]]+)]\(([^)]+)\)/g)) {
      const title = decodeHtmlEntities(match[1] ?? '').trim();
      const rawUrl = decodeHtmlEntities(match[2] ?? '').trim();
      if (!title || !rawUrl) {
        continue;
      }

      let resolved = '';
      try {
        resolved = normalizeUrl(new URL(rawUrl, sourceUrl).toString());
      } catch {
        continue;
      }

      if (/\/llms(?:-full)?\.txt(?:\?|$)/i.test(resolved)) {
        continue;
      }

      if (!isAllowedDocsUrl(resolved, library) || seen.has(resolved)) {
        continue;
      }

      seen.add(resolved);
      entries.push({
        title,
        url: resolved,
        snippet: truncate(
          stripMarkdown(
            line.replace(match[0], title).replace(/^[\s>*-]+/, '').trim(),
          ),
          220,
        ),
      });
    }
  }

  return entries;
}

function scoreDocsCandidate(
  candidate: DocsCandidate,
  tokens: string[],
  version?: string,
  library?: DocsLibraryProfile,
): number {
  const normalizedUrl = normalizeUrl(candidate.url).toLowerCase();
  const normalizedTitle = candidate.title?.toLowerCase() ?? '';
  const normalizedSnippet = candidate.snippet?.toLowerCase() ?? '';
  let score = 0;

  for (const token of tokens) {
    if (!token || token === version?.toLowerCase()) {
      continue;
    }

    const normalizedToken = token.toLowerCase();

    if (normalizedTitle.includes(normalizedToken)) {
      score += normalizedToken.length >= 8 ? 8 : 5;
    }

    if (normalizedUrl.includes(normalizedToken)) {
      score += normalizedToken.length >= 8 ? 6 : 3;
      if (
        normalizedUrl.includes(`/${normalizedToken}`) ||
        normalizedUrl.includes(`-${normalizedToken}`) ||
        normalizedUrl.includes(`${normalizedToken}.html`) ||
        normalizedUrl.includes(`${normalizedToken}.md`)
      ) {
        score += 2;
      }
    }

    if (normalizedSnippet.includes(normalizedToken)) {
      score += normalizedToken.length >= 8 ? 4 : 2;
    }
  }

  const normalizedVersion = version?.toLowerCase();
  if (
    normalizedVersion &&
    (
      normalizedUrl.includes(normalizedVersion) ||
      normalizedTitle.includes(normalizedVersion) ||
      normalizedSnippet.includes(normalizedVersion)
    )
  ) {
    score += 4;
  }

  if (/\/reference\/|\/api\/|\/docs?\//i.test(normalizedUrl)) {
    score += 2;
  }

  if (
    library?.urlPathHints?.some((hint) =>
      normalizedUrl.includes(hint.toLowerCase()),
    )
  ) {
    score += 2;
  }

  return score;
}

async function fetchText(
  url: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: REQUEST_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }

  return response.text();
}

async function loadSitemapUrls(
  sitemapUrl: string,
  fetchImpl: FetchLike,
  seen = new Set<string>(),
  remainingFiles = { count: MAX_SITEMAP_FILES },
): Promise<string[]> {
  if (seen.has(sitemapUrl) || remainingFiles.count <= 0) {
    return [];
  }

  seen.add(sitemapUrl);
  remainingFiles.count -= 1;

  const xml = await fetchText(sitemapUrl, fetchImpl);
  const locs = parseXmlLocs(xml);
  const pageUrls: string[] = [];

  for (const loc of locs) {
    if (pageUrls.length >= MAX_SITEMAP_URLS) {
      break;
    }

    if (/\.xml(\?|$)/i.test(loc)) {
      const nested = await loadSitemapUrls(loc, fetchImpl, seen, remainingFiles);
      for (const nestedUrl of nested) {
        if (pageUrls.length >= MAX_SITEMAP_URLS) {
          break;
        }
        pageUrls.push(nestedUrl);
      }
      continue;
    }

    pageUrls.push(loc);
  }

  return pageUrls;
}

async function getCachedSitemapUrls(
  library: DocsLibraryProfile,
  fetchImpl: FetchLike,
): Promise<string[]> {
  if (library.sitemapUrls.length === 0) {
    return [];
  }

  const cacheKey = library.id;
  const existing = sitemapCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const urls = new Set<string>();
    for (const sitemapUrl of library.sitemapUrls) {
      let loaded: string[] = [];
      try {
        loaded = await loadSitemapUrls(sitemapUrl, fetchImpl);
      } catch {
        continue;
      }

      for (const url of loaded) {
        urls.add(normalizeUrl(url));
        if (urls.size >= MAX_SITEMAP_URLS) {
          break;
        }
      }

      if (urls.size >= MAX_SITEMAP_URLS) {
        break;
      }
    }
    return [...urls];
  })();

  sitemapCache.set(cacheKey, promise);
  return promise;
}

async function getCachedLlmsEntries(
  library: DocsLibraryProfile,
  version: string | undefined,
  fetchImpl: FetchLike,
): Promise<DocsCandidate[]> {
  const llmsUrls = getLlmsIndexUrls(library, version);
  if (llmsUrls.length === 0) {
    return [];
  }

  const cacheKey = `${library.id}:llms:${getVersionMajor(version) ?? 'current'}`;
  const existing = llmsCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const entries: DocsCandidate[] = [];
    const seen = new Set<string>();

    for (const llmsUrl of llmsUrls) {
      let markdown = '';
      try {
        markdown = await fetchText(llmsUrl, fetchImpl);
      } catch {
        continue;
      }

      for (const entry of parseMarkdownIndexEntries(markdown, llmsUrl, library)) {
        if (seen.has(entry.url)) {
          continue;
        }
        seen.add(entry.url);
        entries.push(entry);
      }
    }

    return entries;
  })();

  llmsCache.set(cacheKey, promise);
  return promise;
}

async function getCachedCrawlUrls(
  library: DocsLibraryProfile,
  fetchImpl: FetchLike,
): Promise<string[]> {
  if (!library.crawlRootUrls || library.crawlRootUrls.length === 0) {
    return [];
  }

  const cacheKey = `${library.id}:crawl`;
  const existing = crawlCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const urls = new Set<string>();

    for (const rootUrl of library.crawlRootUrls ?? []) {
      try {
        const html = await fetchText(rootUrl, fetchImpl);
        urls.add(normalizeUrl(rootUrl));
        for (const url of parseHtmlLinks(html, rootUrl, library)) {
          urls.add(url);
          if (urls.size >= MAX_CRAWL_URLS) {
            break;
          }
        }
      } catch {
        continue;
      }

      if (urls.size >= MAX_CRAWL_URLS) {
        break;
      }
    }

    return [...urls];
  })();

  crawlCache.set(cacheKey, promise);
  return promise;
}

function buildBingSearchQuery(options: {
  query: string;
  library?: DocsLibraryProfile;
  version?: string;
}): string {
  const parts: string[] = [];
  if (options.library) {
    parts.push(`site:${options.library.domains[0]}`);
  } else {
    parts.push('documentation');
  }
  if (options.version) {
    parts.push(options.version);
  }
  parts.push(options.query);
  return parts.join(' ');
}

function parseBingRssItems(xml: string): DocsLookupItem[] {
  const items: DocsLookupItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;

  for (const itemMatch of xml.matchAll(itemRegex)) {
    const block = itemMatch[1] ?? '';
    const title = decodeHtmlEntities(
      block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '',
    ).trim();
    const url = decodeHtmlEntities(
      block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '',
    ).trim();
    const snippet = stripHtml(
      block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '',
    );

    if (!title || !url) {
      continue;
    }

    items.push({
      title,
      url,
      snippet: truncate(snippet, 260),
    });
  }

  return items;
}

function parseGoogleHtmlItems(html: string): DocsLookupItem[] {
  const items: DocsLookupItem[] = [];
  const seen = new Set<string>();
  const anchorRegex = /<a[^>]+href="\/url\?q=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const rawUrl = decodeHtmlEntities(match[1] ?? '').trim();
    if (!rawUrl) {
      continue;
    }

    let url = '';
    try {
      url = normalizeUrl(rawUrl);
    } catch {
      continue;
    }

    if (seen.has(url)) {
      continue;
    }

    const title = stripHtml(match[2] ?? '');
    if (!title || title.toLowerCase() === 'google search') {
      continue;
    }

    seen.add(url);
    items.push({
      title: truncate(title, 180),
      url,
      snippet: '',
    });
  }

  return items;
}

function extractPageTitle(html: string, url: string): string {
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  return title || url;
}

function extractPageSnippet(html: string): string {
  const metaDescription = stripHtml(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i)?.[1] ??
      '',
  );

  if (metaDescription) {
    return truncate(metaDescription, 320);
  }

  const body = stripHtml(html);
  return truncate(body, 320);
}

function isMarkdownDocument(
  url: string,
  contentType: string,
  text: string,
): boolean {
  if (/\.md(?:\?|$)/i.test(url)) {
    return true;
  }

  if (/markdown/i.test(contentType)) {
    return true;
  }

  return (
    /text\/plain/i.test(contentType) &&
    (/^---\r?\n/.test(text) || /^#\s+/m.test(text))
  );
}

async function hydrateDocsItems(
  candidates: DocsCandidate[],
  fetchImpl: FetchLike,
): Promise<DocsLookupItem[]> {
  const items: DocsLookupItem[] = [];

  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate.url, {
        headers: REQUEST_HEADERS,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${candidate.url}`);
      }

      const text = await response.text();
      const contentType = response.headers.get('content-type') ?? '';
      if (isMarkdownDocument(candidate.url, contentType, text)) {
        const url =
          extractMarkdownCanonicalUrl(text, candidate.url) ??
          normalizeDocsDisplayUrl(candidate.url);
        const snippet = extractMarkdownSnippet(text);
        items.push({
          title: truncate(
            extractMarkdownTitle(text, url) || candidate.title || url,
            140,
          ),
          url,
          snippet:
            snippet ||
            candidate.snippet ||
            'Artemis located this documentation page but could not extract a readable summary.',
        });
        continue;
      }

      const snippet = extractPageSnippet(text);
      items.push({
        title: truncate(
          extractPageTitle(text, candidate.url) || candidate.title || candidate.url,
          140,
        ),
        url: candidate.url,
        snippet:
          snippet ||
          candidate.snippet ||
          'Artemis located this documentation page but could not extract a readable summary.',
      });
    } catch {
      items.push({
        title: candidate.title || candidate.url,
        url: normalizeDocsDisplayUrl(candidate.url),
        snippet:
          candidate.snippet ||
          'Artemis located this documentation page but could not fetch a readable summary.',
      });
    }
  }

  return items;
}

export async function lookupDocs(options: {
  query: string;
  library?: string;
  version?: string;
  maxResults?: number;
  searchEngine?: DocsSearchEngine;
  fetchImpl?: FetchLike;
}): Promise<DocsLookupResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const library = resolveDocsLibrary(options.library, options.query);
  const version = options.version?.trim() || inferDocsVersion(options.query);
  const preferredSearchEngine = options.searchEngine ?? 'bing';
  const maxResults = Math.min(
    Math.max(options.maxResults ?? DEFAULT_MAX_RESULTS, 1),
    8,
  );
  const tokens = getScoringTokens(options.query, library, version);

  if (library) {
    const llmsMatches = (await getCachedLlmsEntries(library, version, fetchImpl))
      .map((candidate) => ({
        candidate,
        score: scoreDocsCandidate(candidate, tokens, version, library),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, maxResults);

    if (llmsMatches.length > 0) {
      return {
        query: options.query,
        library,
        version,
        strategy: 'llms-index',
        searchEngine: preferredSearchEngine,
        items: await hydrateDocsItems(
          llmsMatches.map((entry) => entry.candidate),
          fetchImpl,
        ),
      };
    }

    const sitemapMatches = (await getCachedSitemapUrls(library, fetchImpl))
      .map((url) => ({
        candidate: { url },
        score: scoreDocsCandidate({ url }, tokens, version, library),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, maxResults);

    if (sitemapMatches.length > 0) {
      return {
        query: options.query,
        library,
        version,
        strategy: 'sitemap',
        searchEngine: preferredSearchEngine,
        items: await hydrateDocsItems(
          sitemapMatches.map((entry) => entry.candidate),
          fetchImpl,
        ),
      };
    }

    const crawlMatches = (await getCachedCrawlUrls(library, fetchImpl))
      .map((url) => ({
        candidate: { url },
        score: scoreDocsCandidate({ url }, tokens, version, library),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, maxResults);

    if (crawlMatches.length > 0) {
      return {
        query: options.query,
        library,
        version,
        strategy: 'crawl',
        searchEngine: preferredSearchEngine,
        items: await hydrateDocsItems(
          crawlMatches.map((entry) => entry.candidate),
          fetchImpl,
        ),
      };
    }
  }

  const searchQuery = buildBingSearchQuery({
    query: options.query,
    library,
    version,
  });
  let effectiveSearchEngine = preferredSearchEngine;
  let searchItems: DocsLookupItem[];
  try {
    searchItems = preferredSearchEngine === 'google'
      ? parseGoogleHtmlItems(
          await fetchText(
            `${GOOGLE_SEARCH_ENDPOINT}${encodeURIComponent(searchQuery)}`,
            fetchImpl,
          ),
        )
      : parseBingRssItems(
          await fetchText(
            `${SEARCH_ENDPOINT}${encodeURIComponent(searchQuery)}`,
            fetchImpl,
          ),
      );
  } catch {
    effectiveSearchEngine = 'bing';
    searchItems = parseBingRssItems(
      await fetchText(
        `${SEARCH_ENDPOINT}${encodeURIComponent(searchQuery)}`,
        fetchImpl,
      ),
    );
  }

  if (preferredSearchEngine === 'google' && searchItems.length === 0) {
    effectiveSearchEngine = 'bing';
    searchItems = parseBingRssItems(
      await fetchText(
        `${SEARCH_ENDPOINT}${encodeURIComponent(searchQuery)}`,
        fetchImpl,
      ),
    );
  }
  const items = searchItems
    .filter((item) => {
      if (!library) {
        return true;
      }

      try {
        const hostname = new URL(item.url).hostname.toLowerCase();
        return matchesLibraryDomain(hostname, library);
      } catch {
        return false;
      }
    })
    .map((item) => ({
      item,
      score: scoreDocsCandidate(item, tokens, version, library),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults);

  return {
    query: options.query,
    library,
    version,
    strategy: 'search-fallback',
    searchEngine: effectiveSearchEngine,
    items: items.map((entry) => entry.item),
  };
}

export function formatDocsLookupReport(result: DocsLookupResult): string {
  const lines = [
    'Artemis docs lookup',
    `- query: ${result.query}`,
    `- library: ${result.library?.label ?? 'auto'}`,
    `- version hint: ${result.version ?? 'none'}`,
    `- strategy: ${result.strategy}`,
    `- search backend: ${formatDocsSearchEngineLabel(result.searchEngine)}`,
    '',
  ];

  if (result.items.length === 0) {
    lines.push('No documentation results matched the requested query.');
    return lines.join('\n');
  }

  for (const [index, item] of result.items.entries()) {
    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`   url: ${item.url}`);
    lines.push(`   snippet: ${item.snippet || 'No snippet available.'}`);
  }

  return lines.join('\n');
}
