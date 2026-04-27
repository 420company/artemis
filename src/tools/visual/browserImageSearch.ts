import { chromium } from 'playwright';
import { toolError, toolLog, toolWarn } from '../../utils/log.js';
import type { SearchResult } from './freyaSearch';

export class BrowserImageSearch {
  // Bing 图片搜索页面
  private static readonly BING_IMAGE_SEARCH_URL = 'https://www.bing.com/images/search'
  // Google 图片搜索页面
  private static readonly GOOGLE_IMAGE_SEARCH_URL = 'https://images.google.com/search'
  
  /**
   * 使用浏览器直接搜索图片
   */
  static async searchImages(keywords: string[]): Promise<SearchResult[]> {
    toolLog('🔍 正在使用浏览器访问图片搜索...')
    
    // 提取核心关键词：去除无关修饰词
    const coreKeywords = keywords.filter(keyword => 
      keyword.length > 1 && 
      !['图', '图片', '摄影', '背景', '灯光', '展示', '白色', '专业', '高品质', '高质量', '文件夹', '该文件夹', '工作区', '编写', '电商', '网站', 'UI', '本地', '生成', '尺寸', '就行', '要求', '人物', '拍摄', '手法', '来拍', '性感', '色情', '开始', '吧'].includes(keyword)
    );
    
    if (coreKeywords.length === 0) {
      toolLog('⚠️ 未检测到有效产品关键词')
      return []
    }
    
    // 生成动态种子和搜索查询
    const dynamicSeed = generateDynamicSeed(coreKeywords)
    const searchQuery = generateSearchQuery(coreKeywords)
    
    toolLog('🔍 核心关键词:', coreKeywords)
    toolLog('🔍 动态种子:', dynamicSeed)
    toolLog('🔍 搜索查询:', searchQuery)
    
    // 优先尝试 Bing 搜索（中国友好）
    try {
      const bingResults = this.filterUsableSearchResults(await this.searchBingImages(searchQuery, dynamicSeed))
      if (bingResults.length > 0) {
        return bingResults
      }
    } catch (error) {
      toolWarn('Bing 搜索失败:', error)
    }
    
    // 备用 Google 搜索
    try {
      const googleResults = this.filterUsableSearchResults(await this.searchGoogleImages(searchQuery, dynamicSeed))
      if (googleResults.length > 0) {
        return googleResults
      }
    } catch (error) {
      toolWarn('Google 搜索失败:', error)
    }
    
    toolWarn('图片搜索没有返回可下载的真实图片结果')
    return []
  }

  private static filterUsableSearchResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>()
    return results.filter((result) => {
      if (!isUsableRemoteImageUrl(result.url)) return false
      const normalized = normalizeUrlForDedupe(result.url)
      if (seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
  }
  
  /**
   * Google 图片搜索
   */
  private static async searchGoogleImages(query: string, seed: string): Promise<SearchResult[]> {
    toolLog('🔍 正在使用 Google 图片搜索...')
    
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    try {
      await page.goto(`${this.GOOGLE_IMAGE_SEARCH_URL}?q=${encodeURIComponent(query)}&tbs=isz:l`);
      await page.waitForSelector('img.rg_i', { timeout: 8000 });
      
      const imageResults = await page.evaluate((data) => {
        const results: SearchResult[] = [];
        const imageElements = document.querySelectorAll('img.rg_i');
        
        imageElements.forEach((img, index) => {
          if (results.length >= 12) return;
          
          const title = img.getAttribute('alt') || `${data.query} 图片`;
          const src = img.getAttribute('src') || img.getAttribute('data-src');
          if (!src) return;
          
          results.push({
            url: src,
            title: title,
            description: `${data.query} 产品图片`,
            source: 'Google Image Search',
            relevance: 0.9 - (index * 0.1),
            thumbnail: src
          });
        });
        
        return results;
      }, { seed, query });
      
      toolLog(`✅ Google 搜索找到 ${imageResults.length} 个相关图片结果`)
      return imageResults;
      
    } catch (error) {
      toolError('❌ Google 搜索失败:', error);
      return [];
      
    } finally {
      await browser.close();
    }
  }
  
  /**
   * Bing 图片搜索
   */
  private static async searchBingImages(query: string, seed: string): Promise<SearchResult[]> {
    toolLog('🔍 正在使用 Bing 图片搜索...')
    
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    try {
      await page.goto(`${this.BING_IMAGE_SEARCH_URL}?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-large`);
      await page.waitForSelector('img.mimg', { timeout: 10000 });
      
      const imageResults = await page.evaluate((data) => {
        const results: SearchResult[] = [];
        const anchors = document.querySelectorAll('a.iusc');

        anchors.forEach((anchor, index) => {
          if (results.length >= 12) return;

          const rawMeta = anchor.getAttribute('m');
          if (!rawMeta) return;

          let meta: Record<string, string> = {};
          try {
            meta = JSON.parse(rawMeta);
          } catch {
            return;
          }

          const url = meta.murl || meta.turl;
          if (!url) return;

          results.push({
            url,
            title: meta.t || anchor.getAttribute('aria-label') || `${data.query} 图片`,
            description: `${data.query} 产品图片`,
            source: 'Bing Image Search',
            relevance: 0.9 - (index * 0.1),
            thumbnail: meta.turl
          });
        });

        if (results.length === 0) {
          const imageElements = document.querySelectorAll('img.mimg');
          imageElements.forEach((img, index) => {
            if (results.length >= 12) return;

            const src = img.getAttribute('src') || img.getAttribute('data-src');
            if (!src) return;

            results.push({
              url: src,
              title: img.getAttribute('alt') || `${data.query} 图片`,
              description: `${data.query} 产品图片`,
              source: 'Bing Image Search',
              relevance: 0.8 - (index * 0.05),
              thumbnail: src
            });
          });
        }
        
        return results;
      }, { seed, query });
      
      toolLog(`✅ Bing 搜索找到 ${imageResults.length} 个相关图片结果`)
      return imageResults;
      
    } catch (error) {
      toolError('❌ Bing 搜索失败:', error);
      return [];
      
    } finally {
      await browser.close();
    }
  }
  
  /**
   * 下载图片（直接使用 fetch）
   */
  static async downloadImage(url: string, destPath: string): Promise<string> {
    const fs = await import('fs/promises');
    const path = await import('path');
    
    const dirPath = path.dirname(destPath);
    await fs.mkdir(dirPath, { recursive: true });
    
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      await fs.writeFile(destPath, buffer);
      
      return destPath;
      
    } catch (error) {
      toolWarn('⚠️ 图片下载失败:', error);
      return await this.createFallbackImage(destPath);
    }
  }
  
  /**
   * 创建产品相关的 SVG 占位图
   */
  private static async createFallbackImage(destPath: string): Promise<string> {
    const fs = await import('fs/promises');
    
    const svgContent = `
      <svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
        <rect width="800" height="600" fill="#f8f9fa"/>
        <rect x="100" y="150" width="600" height="300" fill="#ffffff" stroke="#dee2e6" stroke-width="2" rx="10"/>
        <text x="400" y="300" font-family="Arial" font-size="72" fill="#adb5bd" text-anchor="middle" dy=".3em">
          📷
        </text>
        <text x="400" y="380" font-family="Arial" font-size="24" fill="#6c757d" text-anchor="middle" dy=".3em">
          产品图片加载中...
        </text>
        <text x="400" y="420" font-family="Arial" font-size="14" fill="#adb5bd" text-anchor="middle" dy=".3em">
          请检查网络连接或稍后重试
        </text>
      </svg>
    `.trim();
    
    await fs.writeFile(destPath, svgContent);
    
    return destPath;
  }
}

/**
 * 生成动态种子
 */
function generateDynamicSeed(keywords: string[]): string {
  const seed = keywords.join('-').toLowerCase()
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff-]/g, '-')  // 保留中英文和连字符
    .replace(/-+/g, '-')  // 合并多个连字符
    .replace(/^-+|-+$/g, '');  // 去除首尾连字符
  
  return seed || 'dynamic-content';
}

/**
 * 生成搜索查询
 */
function generateSearchQuery(keywords: string[]): string {
  return keywords.join(' ');
}

function normalizeUrlForDedupe(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    return url.toString()
  } catch {
    return rawUrl
  }
}

function isUsableRemoteImageUrl(rawUrl: string): boolean {
  if (!rawUrl || rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return false

  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false

    const hostname = url.hostname.toLowerCase()
    if (
      hostname.includes('picsum.photos') ||
      hostname.includes('placeholder') ||
      hostname.includes('placehold.co')
    ) {
      return false
    }

    const pathname = url.pathname.toLowerCase()
    if (pathname.endsWith('.svg')) return false

    return true
  } catch {
    return false
  }
}

export default BrowserImageSearch;
