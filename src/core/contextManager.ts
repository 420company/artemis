import type { Message } from './sessionManager.js';
import { getSessionManager } from './sessionManager.js';
import { QueryEngine } from './queryEngine.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * 上下文理解接口
 */
export interface ContextUnderstanding {
  /** 上下文摘要 */
  summary: string;
  
  /** 关键实体 */
  entities: Array<{ type: string; value: string; confidence: number }>;
  
  /** 主题 */
  topics: Array<{ name: string; score: number }>;
  
  /** 查询意图 */
  intent: Array<{ name: string; score: number }>;
  
  /** 情感分析 */
  sentiment: {
    score: number;
    label: 'positive' | 'negative' | 'neutral';
  };
  
  /** 关键词 */
  keywords: Array<{ term: string; importance: number }>;
  
  /** 时间戳 */
  timestamp: string;
}

/**
 * 历史信息管理接口
 */
export interface HistoryEntry {
  id: string;
  query: string;
  response: string;
  context?: ContextUnderstanding;
  timestamp: string;
  userContext?: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * 上下文和历史管理类
 */
export class ContextManager {
  private history: HistoryEntry[];
  private currentContext: ContextUnderstanding;
  private sessionManager = getSessionManager();
  private queryEngine: QueryEngine;

  constructor(queryEngine: QueryEngine) {
    this.history = [];
    this.currentContext = this.createInitialContext();
    this.queryEngine = queryEngine;
  }

  /**
   * 创建初始上下文
   */
  private createInitialContext(): ContextUnderstanding {
    return {
      summary: '',
      entities: [],
      topics: [],
      intent: [],
      sentiment: {
        score: 0,
        label: 'neutral',
      },
      keywords: [],
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 理解上下文
   */
  async understandContext(query: string, sessionId?: string): Promise<ContextUnderstanding> {
    try {
      // 1. 获取会话上下文中的消息
      let messages: Message[] = [];
      if (sessionId) {
        messages = await this.sessionManager.getMessages(sessionId);
      }

      // 2. 分析当前查询的上下文
      const context = await this.analyzeContext(query, messages);
      
      // 3. 更新当前上下文
      this.currentContext = context;
      
      return context;
    } catch (error) {
      console.error('Context understanding error:', error);
      return this.createInitialContext();
    }
  }

  /**
   * 分析上下文
   */
  private async analyzeContext(query: string, messages: Message[]): Promise<ContextUnderstanding> {
    // 构建完整上下文文本
    const contextText = this.buildContextText(query, messages);
    
    // 创建上下文理解对象
    const context: ContextUnderstanding = {
      summary: await this.generateSummary(contextText),
      entities: await this.extractEntities(contextText),
      topics: await this.identifyTopics(contextText),
      intent: await this.detectIntent(contextText),
      sentiment: await this.analyzeSentiment(contextText),
      keywords: await this.extractKeywords(contextText),
      timestamp: new Date().toISOString(),
    };

    return context;
  }

  /**
   * 构建上下文文本
   */
  private buildContextText(query: string, messages: Message[]): string {
    const contextLines: string[] = [];
    
    // 添加历史消息到上下文
    messages.forEach(message => {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      contextLines.push(`${role}: ${message.content}`);
    });
    
    contextLines.push(`User: ${query}`);
    
    return contextLines.join('\n');
  }

  /**
   * 生成上下文摘要
   */
  private async generateSummary(text: string): Promise<string> {
    // 简单的摘要生成逻辑
    const sentences = text.split(/[.!?]+/);
    const firstSentences = sentences.slice(0, 3).join('. ') + '.';
    return firstSentences;
  }

  /**
   * 提取实体
   */
  private async extractEntities(text: string): Promise<Array<{ type: string; value: string; confidence: number }>> {
    const entities: Array<{ type: string; value: string; confidence: number }> = [];
    
    // 提取日期
    const datePattern = /(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}\/\d{1,2}\/\d{1,2}|(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i;
    const dateMatches = text.match(datePattern);
    if (dateMatches) {
      entities.push({
        type: 'date',
        value: dateMatches[0],
        confidence: 0.8,
      });
    }
    
    // 提取数字
    const numberPattern = /\b\d+(\.\d+)?\b/g;
    const numberMatches = text.match(numberPattern);
    if (numberMatches) {
      numberMatches.forEach(match => {
        entities.push({
          type: 'number',
          value: match,
          confidence: 0.9,
        });
      });
    }
    
    // 提取邮箱
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emailMatches = text.match(emailPattern);
    if (emailMatches) {
      emailMatches.forEach(match => {
        entities.push({
          type: 'email',
          value: match,
          confidence: 0.95,
        });
      });
    }
    
    // 提取URL
    const urlPattern = /https?:\/\/[^\s]+/g;
    const urlMatches = text.match(urlPattern);
    if (urlMatches) {
      urlMatches.forEach(match => {
        entities.push({
          type: 'url',
          value: match,
          confidence: 0.95,
        });
      });
    }
    
    return entities;
  }

  /**
   * 识别主题
   */
  private async identifyTopics(text: string): Promise<Array<{ name: string; score: number }>> {
    const topics: Array<{ name: string; score: number }> = [];
    
    // 简单的主题识别
    const lowerText = text.toLowerCase();
    const possibleTopics = [
      'programming', 'development', 'testing', 'deployment', 'analysis',
      'planning', 'management', 'code', 'project', 'system'
    ];
    
    possibleTopics.forEach(topic => {
      if (lowerText.includes(topic)) {
        topics.push({
          name: topic,
          score: this.calculateTopicScore(topic, lowerText),
        });
      }
    });
    
    return topics.sort((a, b) => b.score - a.score);
  }

  /**
   * 计算主题分数
   */
  private calculateTopicScore(topic: string, text: string): number {
    const count = text.split(topic).length - 1;
    return Math.min(count * 0.2, 1);
  }

  /**
   * 检测意图
   */
  private async detectIntent(text: string): Promise<Array<{ name: string; score: number }>> {
    const intents: Array<{ name: string; score: number }> = [];
    
    const lowerText = text.toLowerCase();
    
    // 意图识别
    const intentPatterns = [
      { name: 'create', patterns: ['create', 'make', 'build', 'generate'] },
      { name: 'update', patterns: ['update', 'modify', 'change', 'improve'] },
      { name: 'delete', patterns: ['delete', 'remove', 'erase', 'delete'] },
      { name: 'search', patterns: ['search', 'find', 'locate', 'query'] },
      { name: 'analyze', patterns: ['analyze', 'evaluate', 'examine', 'assess'] },
      { name: 'compare', patterns: ['compare', 'contrast', 'vs'] },
      { name: 'explain', patterns: ['explain', 'describe', 'what is', 'how to'] },
    ];
    
    intentPatterns.forEach(intent => {
      const matches = intent.patterns.filter(pattern => 
        lowerText.includes(pattern)
      );
      
      if (matches.length > 0) {
        intents.push({
          name: intent.name,
          score: this.calculateIntentScore(matches.length, text.length),
        });
      }
    });
    
    return intents.sort((a, b) => b.score - a.score);
  }

  /**
   * 计算意图分数
   */
  private calculateIntentScore(matchCount: number, textLength: number): number {
    const baseScore = matchCount * 0.3;
    const lengthScore = 1 - (textLength / 1000);
    return Math.min(baseScore * lengthScore, 0.9);
  }

  /**
   * 情感分析
   */
  private async analyzeSentiment(text: string): Promise<{ score: number; label: 'positive' | 'negative' | 'neutral' }> {
    // 简单的情感分析
    const positiveWords = ['good', 'great', 'excellent', 'amazing', 'perfect', 'wonderful', 'fantastic'];
    const negativeWords = ['bad', 'poor', 'awful', 'terrible', 'horrible', 'worst'];
    
    let positiveCount = 0;
    let negativeCount = 0;
    
    positiveWords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = text.match(regex);
      if (matches) {
        positiveCount += matches.length;
      }
    });
    
    negativeWords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = text.match(regex);
      if (matches) {
        negativeCount += matches.length;
      }
    });
    
    const total = positiveCount + negativeCount;
    let score = 0;
    let label: 'positive' | 'negative' | 'neutral' = 'neutral';
    
    if (total > 0) {
      score = (positiveCount - negativeCount) / total;
      
      if (score > 0.3) {
        label = 'positive';
      } else if (score < -0.3) {
        label = 'negative';
      }
    }
    
    return {
      score,
      label,
    };
  }

  /**
   * 提取关键词
   */
  private async extractKeywords(text: string): Promise<Array<{ term: string; importance: number }>> {
    // 简单的关键词提取
    const wordCount: { [key: string]: number } = {};
    const words = text.toLowerCase().match(/\b[a-zA-Z]{3,}\b/g) || [];
    
    words.forEach(word => {
      wordCount[word] = (wordCount[word] || 0) + 1;
    });
    
    // 移除常见停用词
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'but', 'have', 'are', 'was',
      'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at', 'by', 'from'
    ]);
    
    const filteredWords = Object.entries(wordCount)
      .filter(([word]) => !stopWords.has(word))
      .map(([word, count]) => ({
        term: word,
        importance: count,
      }))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10);
    
    return filteredWords;
  }

  /**
   * 存储历史记录
   */
  storeHistory(query: string, response: string, context?: ContextUnderstanding, userContext?: Record<string, any>): HistoryEntry {
    const entry: HistoryEntry = {
      id: uuidv4(),
      query,
      response,
      context,
      timestamp: new Date().toISOString(),
      userContext,
      metadata: {
        queryLength: query.length,
        responseLength: response.length,
      },
    };
    
    this.history.push(entry);
    
    // 保留有限数量的历史记录
    if (this.history.length > 100) {
      this.history.shift();
    }
    
    return entry;
  }

  /**
   * 获取历史记录
   */
  getHistory(): HistoryEntry[] {
    return [...this.history];
  }

  /**
   * 搜索历史记录
   */
  searchHistory(query: string): HistoryEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.history.filter(entry => 
      entry.query.toLowerCase().includes(lowerQuery) ||
      entry.response.toLowerCase().includes(lowerQuery) ||
      (entry.context?.keywords.some(keyword => 
        keyword.term.toLowerCase().includes(lowerQuery)
      ))
    );
  }

  /**
   * 获取当前上下文
   */
  getCurrentContext(): ContextUnderstanding {
    return this.currentContext;
  }

  /**
   * 获取上下文相关的历史记录
   */
  getContextRelatedHistory(context: ContextUnderstanding, limit: number = 5): HistoryEntry[] {
    const related: HistoryEntry[] = [];
    
    this.history.forEach(entry => {
      // 检查实体匹配
      const entityMatch = context.entities.some(entity => 
        entry.context?.entities.some(entryEntity => 
          entryEntity.type === entity.type && entryEntity.value === entity.value
        )
      );
      
      // 检查主题匹配
      const topicMatch = context.topics.some(topic => 
        entry.context?.topics.some(entryTopic => 
          entryTopic.name === topic.name
        )
      );
      
      // 检查意图匹配
      const intentMatch = context.intent.some(intent => 
        entry.context?.intent.some(entryIntent => 
          entryIntent.name === intent.name
        )
      );
      
      // 检查关键词匹配
      const keywordMatch = context.keywords.some(keyword => 
        entry.context?.keywords.some(entryKeyword => 
          entryKeyword.term.includes(keyword.term) ||
          keyword.term.includes(entryKeyword.term)
        )
      );
      
      if (entityMatch || topicMatch || intentMatch || keywordMatch) {
        related.push(entry);
      }
    });
    
    return related.slice(0, limit);
  }

  /**
   * 清空历史记录
   */
  clearHistory(): void {
    this.history = [];
    this.currentContext = this.createInitialContext();
  }

  /**
   * 导出历史记录
   */
  exportHistory(): string {
    return JSON.stringify(this.history, null, 2);
  }

  /**
   * 导入历史记录
   */
  importHistory(data: string): void {
    try {
      const history = JSON.parse(data);
      if (Array.isArray(history)) {
        this.history = history;
      }
    } catch (error) {
      console.error('History import error:', error);
    }
  }

  /**
   * 分析历史模式
   */
  analyzeHistoryPatterns(): {
    queryTypes: { [key: string]: number };
    commonTopics: { [key: string]: number };
    commonEntities: { [key: string]: number };
    averageQueryLength: number;
    averageResponseLength: number;
    queryCount: number;
    responseCount: number;
    averageQueryResponseTime: number;
  } {
    const analysis = {
      queryTypes: {} as { [key: string]: number },
      commonTopics: {} as { [key: string]: number },
      commonEntities: {} as { [key: string]: number },
      averageQueryLength: 0,
      averageResponseLength: 0,
      queryCount: 0,
      responseCount: 0,
      averageQueryResponseTime: 0,
    };

    let totalQueryLength = 0;
    let totalResponseLength = 0;
    
    this.history.forEach(entry => {
      totalQueryLength += entry.query.length;
      totalResponseLength += entry.response.length;
      
      // 分析查询类型
      entry.context?.intent.forEach(intent => {
        analysis.queryTypes[intent.name] = (analysis.queryTypes[intent.name] || 0) + 1;
      });
      
      // 分析主题
      entry.context?.topics.forEach(topic => {
        analysis.commonTopics[topic.name] = (analysis.commonTopics[topic.name] || 0) + 1;
      });
      
      // 分析实体
      entry.context?.entities.forEach(entity => {
        analysis.commonEntities[entity.type] = (analysis.commonEntities[entity.type] || 0) + 1;
      });
    });
    
    analysis.queryCount = this.history.length;
    analysis.responseCount = this.history.length;
    analysis.averageQueryLength = analysis.queryCount > 0 ? Math.round(totalQueryLength / analysis.queryCount) : 0;
    analysis.averageResponseLength = analysis.responseCount > 0 ? Math.round(totalResponseLength / analysis.responseCount) : 0;
    
    return analysis;
  }

  /**
   * 生成上下文报告
   */
  async generateContextReport(): Promise<string> {
    const historyPatterns = this.analyzeHistoryPatterns();
    const currentContext = this.getCurrentContext();
    
    let report = `# Context Report\n\n`;
    
    report += `## Current Context\n`;
    report += `**Summary:** ${currentContext.summary}\n`;
    report += `**Sentiment:** ${currentContext.sentiment.label} (Score: ${currentContext.sentiment.score.toFixed(2)})\n`;
    report += `**Keywords:** ${currentContext.keywords.map(k => k.term).join(', ')}\n\n`;
    
    report += `## History Patterns\n`;
    report += `**Query Count:** ${historyPatterns.queryCount}\n`;
    report += `**Response Count:** ${historyPatterns.responseCount}\n`;
    report += `**Avg Query Length:** ${historyPatterns.averageQueryLength} characters\n`;
    report += `**Avg Response Length:** ${historyPatterns.averageResponseLength} characters\n\n`;
    
    if (Object.keys(historyPatterns.queryTypes).length > 0) {
      report += `## Query Types\n`;
      Object.entries(historyPatterns.queryTypes).forEach(([type, count]) => {
        report += `- ${type}: ${count}\n`;
      });
      report += '\n';
    }
    
    if (Object.keys(historyPatterns.commonTopics).length > 0) {
      report += `## Common Topics\n`;
      Object.entries(historyPatterns.commonTopics).forEach(([topic, count]) => {
        report += `- ${topic}: ${count}\n`;
      });
      report += '\n';
    }
    
    if (Object.keys(historyPatterns.commonEntities).length > 0) {
      report += `## Common Entities\n`;
      Object.entries(historyPatterns.commonEntities).forEach(([entityType, count]) => {
        report += `- ${entityType}: ${count}\n`;
      });
    }
    
    return report;
  }
}

/**
 * 上下文管理器单例
 */
let contextManagerInstance: ContextManager | null = null;

export function getContextManager(queryEngine?: QueryEngine): ContextManager {
  if (!contextManagerInstance && queryEngine) {
    contextManagerInstance = new ContextManager(queryEngine);
  }
  return contextManagerInstance!;
}
