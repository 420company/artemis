import { ExpandedPrompt } from '../../agents/freyaAgent.js'
import { toolError, toolLog, toolWarn } from '../../utils/log.js'
import { BrowserImageSearch } from './browserImageSearch.js'

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  url: string
  title: string
  description: string
  source: string
  relevance: number
  thumbnail?: string
}

export interface DeepSearchResult {
  success: boolean
  searchResults?: SearchResult[]
  downloadedPath?: string
  error?: string
  searchTime?: number
  downloadTime?: number
}

// ─── FREYA SEARCH MODULE ─────────────────────────────────────────────────────

export class FreyaSearch {
  // Mock search engine API endpoint (in production, replace with real API)
  private static readonly SEARCH_API_ENDPOINT = 'https://api.example.com/images/search'
  
  // 使用浏览器搜索替代真实 API 调用
  private static async getRealSearchResults(keywords: string[]): Promise<SearchResult[]> {
    toolLog('🔍 正在使用浏览器访问 Bing 图片搜索...')
    
    try {
      const results = await BrowserImageSearch.searchImages(keywords)
      
      if (results.length > 0) {
        toolLog(`✅ 找到 ${results.length} 个相关图片结果`)
        return results
      }
      
      toolWarn('Bing 图片搜索返回空结果')
      
    } catch (error) {
      toolWarn('浏览器搜索失败:', error)
    }
    
    toolWarn('Freya 搜索未找到真实可下载图片，不再使用随机风景图兜底')
    return []
  }

  /**
   * Deep search for similar images using expanded prompt
   */
  static async deepSearchSimilarImage(expandedPrompt: ExpandedPrompt, destPath: string): Promise<DeepSearchResult> {
    const startTime = Date.now()
    toolLog('🔍 Freya: 正在深度搜索视觉资产...')

    try {
      // Step 1: 提取搜索关键词
      const keywords = this.extractKeywords(expandedPrompt.raw)
      toolLog('🔍 提取的关键词:', keywords)
      
      // Step 2: 执行真实搜索
      const searchResults = await this.getRealSearchResults(keywords)
      const bestResult = searchResults[0]
      if (!bestResult) {
        throw new Error('No usable image search results returned')
      }
      
      // Step 3: Download the image
      toolLog(`📥 Freya: 正在下载图片: ${bestResult.title}`)
      const downloadedPath = await this.downloadImage(bestResult.url, destPath)
      
      const totalTime = Date.now() - startTime

      toolLog('✅ Freya: 视觉资产搜索和下载成功！')

      return {
        success: true,
        searchResults: searchResults,
        downloadedPath: downloadedPath,
        searchTime: totalTime
      }

    } catch (error) {
      toolError('❌ Freya: 深度搜索失败:', error)
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        searchTime: Date.now() - startTime
      }
    }
  }

  /**
   * Download image from URL to local file
   */
  private static async downloadImage(url: string, destPath: string): Promise<string> {
    const fs = await import('fs/promises')
    const path = await import('path')
    
    // Create directory if it doesn't exist
    const dirPath = path.dirname(destPath)
    await fs.mkdir(dirPath, { recursive: true })

    // Use Node.js fetch API to download the image
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`)
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType && !contentType.startsWith('image/')) {
      throw new Error(`downloaded asset is not an image: ${contentType}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (!looksLikeImage(buffer)) {
      throw new Error('downloaded asset does not have a supported image signature')
    }

    await fs.writeFile(destPath, buffer)

    return destPath
  }

  /**
   * Helper method to extract search keywords from prompt
   */
  static extractKeywords(prompt: string): string[] {
    const normalized = prompt
      .replace(/[“”"'`]/g, ' ')
      .replace(/[，。！？；：、,.!?;:()[\]{}<>]/g, '\n')
      .replace(/\s+/g, ' ')
      .trim()
    if (!normalized) {
      return []
    }

    const keywords: string[] = []
    const add = (value: string): void => {
      const clean = value
        .replace(/^(?:需要|要求|用|使用|做|做一个|做个|生成|创建|制作|设计|编写|一个|一张|一些|尽量|看起来|就是|那种|这种|专业的|专业|高级的|高级|本地)$/u, '')
        .replace(/(?:的话|的话用|的|地|得|和|与|及|以及|或者|或)$/u, '')
        .trim()
        .toLowerCase()
      if (!clean || clean.length < 2) return
      if (isKeywordStopWord(clean)) return
      if (!keywords.includes(clean)) keywords.push(clean)
    }

    const clauses = normalized
      .split(/\n+/)
      .map((clause) => clause.trim())
      .filter(Boolean)

    for (const clause of clauses) {
      for (const phrase of extractDemandPhrases(clause)) add(phrase)

      const words = segmentClause(clause)
      for (const word of words) add(word)

      for (let i = 0; i < words.length - 1; i += 1) {
        const phrase = `${words[i]}${words[i + 1]}`
        if (phrase.length >= 3 && phrase.length <= 10) add(phrase)
      }
    }

    const latinMatches = normalized.match(/\b[a-z][a-z0-9-]{2,}\b/gi) ?? []
    for (const match of latinMatches) add(match)

    if (keywords.length === 0) {
      add(normalized.slice(0, 16))
    }

    return keywords.slice(0, 8)
  }
}

function segmentClause(clause: string): string[] {
  const words: string[] = []
  const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'word' })
    : null

  if (segmenter) {
    for (const segment of segmenter.segment(clause)) {
      const text = segment.segment.trim()
      if (!segment.isWordLike || !text) continue
      if (/^[\p{Script=Han}a-zA-Z0-9-]+$/u.test(text)) {
        words.push(text)
      }
    }
  } else {
    words.push(...(clause.match(/[\p{Script=Han}]{2,}|[a-zA-Z][a-zA-Z0-9-]{2,}/gu) ?? []))
  }

  return words.filter((word) => !isKeywordStopWord(word.toLowerCase()))
}

function extractDemandPhrases(clause: string): string[] {
  const prepared = clause
    .replace(/(?:编写|建立|创建|制作|生成|设计|绘制|渲染|进入|设为|工作区|一个|一张|一些|卖|需要|要求|尽量|直接|开始吧|请|帮我)/gu, ' ')
    .replace(/(?:看起来|看着|就是|那种|这种|很|有|的话|的话用|使用|用|配色|UI|ui)/gu, ' ')
    .replace(/(?:但不色情|不色情|本地生成|本地|生成|尺寸|大小|就行)/gu, ' ')
    .replace(/\s+/g, ' ')
  const parts = prepared
    .split(/(?:或者|还是|以及|并且|同时|然后|如果|否则|但是|但|和|与|及|或|\s+)/u)
    .map((part) => part.trim())
    .filter(Boolean)

  const phrases: string[] = []
  for (const part of parts) {
    const matches = part.match(/[\p{Script=Han}]{2,12}/gu) ?? []
    for (const match of matches) {
      const clean = match
        .replace(/(?:的)?(?:电商)?网站$/u, '')
        .replace(/^(?:的|地|得|商品|产品)$/u, '')
        .replace(/(?:的|地|得)$/u, '')
        .trim()
      if (clean.length >= 2 && !isKeywordStopWord(clean.toLowerCase())) {
        phrases.push(clean)
      }
    }
  }

  return phrases
}

function isKeywordStopWord(word: string): boolean {
  return new Set([
    '一个', '这个', '那个', '这些', '那些', '需要', '要求', '生成', '创建', '制作',
    '设计', '编写', '网站', '电商', '商城', '页面', '用户', '需求', '尽量', '开始',
    '看着', '看起来', '感觉', '高级', '专业', '配色', '尺寸', '本地', '使用',
    'with', 'and', 'for', 'the', 'this', 'that', 'image', 'photo', 'picture',
    'visual', 'asset', 'design', 'generate', 'create', 'make', 'style',
  ]).has(word)
}

function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return true
  }
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return true
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return true
  if (buffer.toString('ascii', 4, 12).startsWith('ftypavif')) return true

  return false
}

// ─── DEFAULT EXPORTS ─────────────────────────────────────────────────────────

export default FreyaSearch
