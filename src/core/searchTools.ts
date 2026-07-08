import type { AgentAction } from './types.js';

/**
 * 无配置搜索后端系统
 * 自动检测和选择可用的搜索后端，无需用户单独配置API密钥
 */

export type SearchBackend = 'auto' | 'bing' | 'google' | 'duckduckgo' | 'wikipedia';

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  position: number;
}

export interface SearchResponse {
  success: boolean;
  data: {
    web: SearchResult[];
  };
  error?: string;
}

/**
 * 检测可用的搜索后端
 */
export function detectAvailableBackends(): SearchBackend[] {
  const backends: SearchBackend[] = ['auto', 'duckduckgo', 'wikipedia'];
  
  // 检查是否有Bing或Google的环境变量
  if (process.env.BING_API_KEY) {
    backends.push('bing');
  }
  if (process.env.GOOGLE_API_KEY) {
    backends.push('google');
  }
  
  return backends;
}

/**
 * 智能选择搜索后端
 */
export function selectSearchBackend(preferredBackend?: SearchBackend): SearchBackend {
  const available = detectAvailableBackends();
  
  if (preferredBackend && available.includes(preferredBackend)) {
    return preferredBackend;
  }
  
  // 默认优先级：DuckDuckGo -> Wikipedia -> Bing -> Google
  const priorityOrder: SearchBackend[] = ['duckduckgo', 'wikipedia', 'bing', 'google'];
  
  for (const backend of priorityOrder) {
    if (available.includes(backend)) {
      return backend;
    }
  }
  
  return 'duckduckgo'; // 最终默认 fallback
}

/**
 * DuckDuckGo 搜索实现（无API密钥需要）
 */
export async function searchWithDuckDuckGo(query: string, limit: number = 5): Promise<SearchResponse> {
  try {
    const encodedQuery = encodeURIComponent(query);
    // html.duckduckgo.com 是官方的纯 HTML 端点，比主站 /html/ 更少触发人机挑战
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      }
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo search failed: ${response.status}`);
    }

    const html = await response.text();

    // cheerio 解析（旧的正则缺 s 标志，跨行结果块永远匹配不上）
    const cheerio = await import('cheerio');
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $('.result').each((_i, el) => {
      if (results.length >= limit) return false;
      const anchor = $(el).find('a.result__a').first();
      let href = anchor.attr('href') ?? '';
      const title = anchor.text().replace(/\s+/g, ' ').trim();
      const description = $(el).find('.result__snippet').first().text().replace(/\s+/g, ' ').trim();

      // 解开 DuckDuckGo 的跳转链接（//duckduckgo.com/l/?uddg=<encoded>&rut=…）
      const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) {
        try { href = decodeURIComponent(uddgMatch[1]!); } catch { /* keep raw */ }
      } else if (href.startsWith('//')) {
        href = `https:${href}`;
      }

      if (href && title && /^https?:\/\//i.test(href)) {
        results.push({
          title,
          url: href,
          description,
          position: results.length + 1,
        });
      }
      return undefined;
    });

    return {
      success: true,
      data: {
        web: results
      }
    };
  } catch (error) {
    return {
      success: false,
      data: {
        web: []
      },
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Wikipedia 搜索实现（无API密钥需要）
 */
export async function searchWithWikipedia(query: string, limit: number = 5): Promise<SearchResponse> {
  try {
    const encodedQuery = encodeURIComponent(query);
    // list=search 是全文检索；旧的 action=opensearch 只做标题前缀匹配，
    // 自然语言查询（多词短语）几乎总是返回空。
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodedQuery}&srlimit=${limit}&format=json&origin=*`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Wikipedia search failed: ${response.status}`);
    }

    const json = await response.json() as {
      query?: { search?: Array<{ title?: string; snippet?: string }> };
    };
    const entries = json.query?.search ?? [];

    const results: SearchResult[] = [];
    for (let i = 0; i < entries.length && i < limit; i++) {
      const title = entries[i]?.title ?? '';
      if (!title) continue;
      results.push({
        title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        description: (entries[i]?.snippet ?? '').replace(/<[^>]*>/g, ''),
        position: results.length + 1
      });
    }

    return {
      success: true,
      data: {
        web: results
      }
    };
  } catch (error) {
    return {
      success: false,
      data: {
        web: []
      },
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Bing 搜索实现（需要API密钥）
 */
export async function searchWithBing(query: string, limit: number = 5): Promise<SearchResponse> {
  const apiKey = process.env.BING_API_KEY;
  
  if (!apiKey) {
    return {
      success: false,
      data: {
        web: []
      },
      error: 'Bing search API key not configured'
    };
  }
  
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodedQuery}&count=${limit}`;
    
    const response = await fetch(url, {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey
      }
    });
    
    if (!response.ok) {
      throw new Error(`Bing search failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    const results: SearchResult[] = data.webPages?.value.map((item: any, index: number) => ({
      title: item.name,
      url: item.url,
      description: item.snippet,
      position: index + 1
    })) || [];
    
    return {
      success: true,
      data: {
        web: results.slice(0, limit)
      }
    };
  } catch (error) {
    return {
      success: false,
      data: {
        web: []
      },
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Google 搜索实现（需要API密钥）
 */
export async function searchWithGoogle(query: string, limit: number = 5): Promise<SearchResponse> {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;
  
  if (!apiKey || !cx) {
    return {
      success: false,
      data: {
        web: []
      },
      error: 'Google search API key or CX not configured'
    };
  }
  
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodedQuery}&key=${apiKey}&cx=${cx}&num=${limit}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Google search failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    const results: SearchResult[] = data.items?.map((item: any, index: number) => ({
      title: item.title,
      url: item.link,
      description: item.snippet,
      position: index + 1
    })) || [];
    
    return {
      success: true,
      data: {
        web: results.slice(0, limit)
      }
    };
  } catch (error) {
    return {
      success: false,
      data: {
        web: []
      },
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * 统一搜索接口
 */
export async function searchWeb(
  query: string, 
  limit: number = 5, 
  backend: SearchBackend = 'auto'
): Promise<SearchResponse> {
  if (backend !== 'auto') {
    return await runSearchBackend(backend, query, limit);
  }

  // auto：按优先级尝试，失败或 0 结果时穿透到下一个后端。
  // 旧实现只挑一个后端就返回——DDG 被风控/解析为空时整个搜索直接空手。
  const chain: SearchBackend[] = ['duckduckgo', 'bing', 'google', 'wikipedia'];
  let lastError: string | undefined;
  for (const candidate of chain) {
    try {
      const result = await runSearchBackend(candidate, query, limit);
      if (result.success && result.data.web.length > 0) {
        return result;
      }
      if (result.error) lastError = result.error;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    success: false,
    data: { web: [] },
    error: lastError ?? 'All search backends returned no results.',
  };
}

async function runSearchBackend(
  backend: SearchBackend,
  query: string,
  limit: number,
): Promise<SearchResponse> {
  switch (backend) {
    case 'bing':
      return await searchWithBing(query, limit);
    case 'google':
      return await searchWithGoogle(query, limit);
    case 'wikipedia':
      return await searchWithWikipedia(query, limit);
    case 'duckduckgo':
    default:
      return await searchWithDuckDuckGo(query, limit);
  }
}

/**
 * 创建搜索动作
 */
export function createSearchAction(query: string, limit: number = 5, backend?: SearchBackend): AgentAction {
  return {
    type: 'search_web',
    query,
    limit,
    backend
  };
}

/**
 * 执行搜索动作
 */
export async function executeSearchAction(action: any): Promise<SearchResponse> {
  const { query, limit = 5, backend = 'auto' } = action;
  
  return await searchWeb(query, limit, backend as SearchBackend);
}