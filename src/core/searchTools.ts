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
    const url = `https://duckduckgo.com/html/?q=${encodedQuery}`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`DuckDuckGo search failed: ${response.status}`);
    }
    
    const html = await response.text();
    
    // 使用正则表达式解析 HTML，提取搜索结果
    const results: SearchResult[] = [];
    
    // 查找结果块
    const resultBlockRegex = /<div class="result__body">(.*?)<\/div>/g;
    let match;
    
    while ((match = resultBlockRegex.exec(html)) && results.length < limit) {
      const resultBlock = match[1];
      
      // 提取标题和链接
      const linkRegex = /<a class="result__a" href="([^"]+)"[^>]*>([^<]+)<\/a>/;
      const linkMatch = resultBlock.match(linkRegex);
      
      if (linkMatch) {
        let url = linkMatch[1];
        let title = linkMatch[2];
        
        // 处理 DuckDuckGo 的链接格式
        if (url.startsWith('/l/')) {
          const redirectMatch = url.match(/\/l\/\?uddg=(.*)/);
          if (redirectMatch) {
            url = decodeURIComponent(redirectMatch[1]);
          }
        }
        
        // 提取描述
        const snippetRegex = /<a class="result__snippet"[^>]*>([^<]+)<\/a>/;
        const snippetMatch = resultBlock.match(snippetRegex);
        const description = snippetMatch ? snippetMatch[1].trim() : '';
        
        // 清理标题和描述中的HTML标签
        title = title.replace(/<[^>]*>/g, '').trim();
        
        // 只添加有效的结果
        if (url && title) {
          results.push({
            title,
            url,
            description,
            position: results.length + 1
          });
        }
      }
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
 * Wikipedia 搜索实现（无API密钥需要）
 */
export async function searchWithWikipedia(query: string, limit: number = 5): Promise<SearchResponse> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodedQuery}&limit=${limit}&format=json&origin=*`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Wikipedia search failed: ${response.status}`);
    }
    
    const [, titles, descriptions, urls] = await response.json();
    
    const results: SearchResult[] = [];
    for (let i = 0; i < titles.length && i < limit; i++) {
      results.push({
        title: titles[i],
        url: urls[i],
        description: descriptions[i],
        position: i + 1
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
  const selectedBackend = backend === 'auto' ? selectSearchBackend() : backend;
  
  switch (selectedBackend) {
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