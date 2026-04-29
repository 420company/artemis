/* eslint-disable @typescript-eslint/no-unused-vars */
// 查询解析结果
export interface QueryParsingResult {
  query: string
  intent: string
  entities: any[]
  context: any
  confidence: number
  isQuestion: boolean
  requiresTool: boolean
}

// 查询分类
export enum QueryCategory {
  INFORMATION = 'information',
  ACTION = 'action',
  QUESTION = 'question',
  COMMAND = 'command',
  CHAT = 'chat',
  EXPLORATION = 'exploration'
}

// 实体类型
export enum EntityType {
  FILE = 'file',
  DIRECTORY = 'directory',
  CODE = 'code',
  CONCEPT = 'concept',
  KEYWORD = 'keyword',
  PERSON = 'person',
  ORGANIZATION = 'organization',
  DATE = 'date',
  TIME = 'time',
  LOCATION = 'location',
  QUANTITY = 'quantity'
}

// 查询上下文
export interface QueryContext {
  userContext: any
  sessionContext: any
  systemContext: any
  history: any[]
}

// 自然语言处理系统
export class NLPProcessor {
  private patterns: any[] = []

  constructor() {
    this.initializePatterns()
  }

  /**
   * 初始化模式识别
   */
  private initializePatterns(): void {
    this.patterns = [
      // 文件操作模式
      {
        type: QueryCategory.ACTION,
        intent: 'read_file',
        patterns: ['read file', 'look at', 'view', 'show'],
        entities: [
          { type: EntityType.FILE, patterns: ['\\.\\w+'] }
        ]
      },
      {
        type: QueryCategory.ACTION,
        intent: 'write_file',
        patterns: ['write file', 'create file', 'make file', 'generate'],
        entities: [
          { type: EntityType.FILE, patterns: ['\\.\\w+'] }
        ]
      },
      {
        type: QueryCategory.ACTION,
        intent: 'run_command',
        patterns: ['run', 'execute', 'compile', 'build', 'install'],
        entities: [
          { type: EntityType.KEYWORD, patterns: ['npm', 'git', 'python', 'node'] }
        ]
      },
      // 问题模式
      {
        type: QueryCategory.QUESTION,
        intent: 'search',
        patterns: ['what', 'how', 'where', 'why', 'who', 'when'],
        entities: [
          { type: EntityType.CONCEPT, patterns: ['\\w+'] }
        ]
      }
    ]
  }

  /**
   * 解析用户查询
   */
  parseQuery(query: string, context: QueryContext): QueryParsingResult {
    const normalizedQuery = this.normalizeQuery(query)
    const result: QueryParsingResult = {
      query: normalizedQuery,
      intent: 'unknown',
      entities: [],
      context,
      confidence: 0.0,
      isQuestion: this.isQuestion(normalizedQuery),
      requiresTool: false
    }

    // 识别意图和实体
    for (const pattern of this.patterns) {
      const match = this.matchPattern(normalizedQuery, pattern)
      if (match) {
        result.intent = pattern.intent
        result.confidence = match.confidence
        result.entities = match.entities
        
        if (pattern.type === QueryCategory.ACTION) {
          result.requiresTool = true
        }
        break
      }
    }

    // 如果未找到匹配，尝试使用简单解析
    if (result.confidence < 0.5) {
      result.intent = this.detectSimpleIntent(normalizedQuery)
      result.confidence = 0.5
    }

    return result
  }

  /**
   * 规范化查询
   */
  private normalizeQuery(query: string): string {
    return query.toLowerCase()
      .trim()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
  }

  /**
   * 匹配模式
   */
  private matchPattern(query: string, pattern: any): any {
    let totalScore = 0
    const entities: any[] = []

    // 检查意图匹配
    for (const intentPattern of pattern.patterns) {
      if (query.includes(intentPattern.toLowerCase())) {
        totalScore += 0.3
        break
      }
    }

    // 检查实体匹配
    if (pattern.entities) {
      for (const entityType of pattern.entities) {
        for (const entityPattern of entityType.patterns) {
          const regex = new RegExp(entityPattern, 'g')
          const matches = query.match(regex)
          
          if (matches) {
            for (const match of matches) {
              entities.push({
                type: entityType.type,
                value: match,
                score: 0.3
              })
              totalScore += 0.3
            }
          }
        }
      }
    }

    return totalScore > 0.3 ? { confidence: totalScore, entities } : null
  }

  /**
   * 检测简单意图
   */
  private detectSimpleIntent(query: string): string {
    if (this.isQuestion(query)) {
      return 'search'
    }

    if (query.includes('file') || query.includes('read') || query.includes('write')) {
      return 'file_operation'
    }

    if (query.includes('run') || query.includes('execute') || query.includes('npm') || query.includes('git')) {
      return 'run_command'
    }

    if (query.includes('help') || query.includes('usage') || query.includes('how')) {
      return 'help'
    }

    return 'chat'
  }

  /**
   * 检查是否是问题
   */
  private isQuestion(query: string): boolean {
    const questionWords = ['what', 'how', 'where', 'why', 'who', 'when']
    const questionEndings = ['?', '?', '?']
    
    return questionWords.some(word => query.startsWith(word)) || 
           questionEndings.some(ending => query.endsWith(ending))
  }

  /**
   * 理解上下文
   */
  understandContext(query: string, context: QueryContext): any {
    const contextInfo: any = {
      history: context.history,
      userContext: context.userContext,
      systemContext: context.systemContext
    }

    // 从会话历史中提取上下文
    if (context.history.length > 0) {
      const recentMessages = context.history.slice(-3)
      
      // 识别相关主题
      const topics = this.identifyTopics(recentMessages)
      if (topics.length > 0) {
        contextInfo.topics = topics
      }

      // 识别问题链
      const followUpPatterns = ['also', 'another', 'again', 'more', 'next']
      const isFollowUp = followUpPatterns.some(pattern => 
        query.toLowerCase().includes(pattern.toLowerCase())
      )
      
      if (isFollowUp) {
        contextInfo.isFollowUp = true
        contextInfo.previousTopic = recentMessages[recentMessages.length - 1]?.text || ''
      }
    }

    return contextInfo
  }

  /**
   * 识别主题
   */
  private identifyTopics(messages: any[]): string[] {
    const topics: string[] = []
    const filePattern = /\b[\w/\\]+\.\w+\b/g
    const conceptPattern = /\b(\w+)\s*(\w+)?\b/g

    messages.forEach(msg => {
      const text = msg.text || ''
      
      // 提取文件名
      const fileMatches = text.match(filePattern)
      if (fileMatches) {
        fileMatches.forEach((file: string) => topics.push(file))
      }

      // 提取概念词
      const conceptMatches = text.match(conceptPattern)
      if (conceptMatches) {
        conceptMatches.forEach((concept: string) => topics.push(concept))
      }
    })

    return Array.from(new Set(topics))
  }

  /**
   * 优化查询
   */
  optimizeQuery(query: string, context: QueryContext): string {
    const normalized = this.normalizeQuery(query)
    
    // 简单的查询优化
    const optimizations = [
      { from: 'could you please', to: '' },
      { from: 'can you', to: '' },
      { from: 'please', to: '' },
      { from: 'i want to', to: '' },
      { from: 'i need to', to: '' }
    ]

    let optimized = normalized
    optimizations.forEach(opt => {
      optimized = optimized.replace(new RegExp(opt.from, 'gi'), opt.to)
    })

    return optimized.trim()
  }

  /**
   * 确定响应策略
   */
  determineResponseStrategy(parsedQuery: QueryParsingResult): any {
    const strategy: any = {
      type: parsedQuery.requiresTool ? 'tool_call' : 'direct_response',
      priority: 'normal',
      context: parsedQuery.context
    }

    // 根据意图确定策略
    switch (parsedQuery.intent) {
      case 'read_file':
        strategy.priority = 'high'
        strategy.maxRetries = 2
        break
      
      case 'write_file':
        strategy.priority = 'medium'
        strategy.requiresConfirmation = true
        break
      
      case 'run_command':
        strategy.priority = 'medium'
        strategy.timeout = 30000
        break
      
      case 'search':
        strategy.priority = 'normal'
        strategy.timeout = 60000
        break
    }

    return strategy
  }

  /**
   * 查询重写
   */
  rewriteQuery(query: string, context: QueryContext): string {
    const normalized = this.normalizeQuery(query)
    
    // 简单的查询重写
    const rewrites = [
      { pattern: /^read (.*)$/, replacement: 'Read the file $1' },
      { pattern: /^write (.*)$/, replacement: 'Write to the file $1' },
      { pattern: /^run (.*)$/, replacement: 'Execute $1' },
      { pattern: /^how do i (.*)$/, replacement: 'How to $1' },
      { pattern: /^what is (.*)$/, replacement: 'What is $1' }
    ]

    for (const rewrite of rewrites) {
      const match = normalized.match(rewrite.pattern)
      if (match) {
        return rewrite.replacement.replace(/\$(\d)/g, (_, index) => match[parseInt(index)])
      }
    }

    return normalized
  }
}

// 单例 NLP 处理器
let nlpProcessorInstance: NLPProcessor | null = null

export function getNLPProcessor(): NLPProcessor {
  if (!nlpProcessorInstance) {
    nlpProcessorInstance = new NLPProcessor()
  }
  return nlpProcessorInstance
}

export function createNLPProcessor(): NLPProcessor {
  return new NLPProcessor()
}

// 便利函数
export function parseQuery(query: string, context: QueryContext): QueryParsingResult {
  return getNLPProcessor().parseQuery(query, context)
}

export function understandContext(query: string, context: QueryContext): any {
  return getNLPProcessor().understandContext(query, context)
}

export function optimizeQuery(query: string, context: QueryContext): string {
  return getNLPProcessor().optimizeQuery(query, context)
}

export function determineResponseStrategy(parsedQuery: QueryParsingResult): any {
  return getNLPProcessor().determineResponseStrategy(parsedQuery)
}

export function rewriteQuery(query: string, context: QueryContext): string {
  return getNLPProcessor().rewriteQuery(query, context)
}
