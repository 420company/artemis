import { searchWeb, createSearchAction, executeSearchAction, type SearchResponse, type SearchBackend } from './searchTools.js';
import type { AgentAction, SessionMessage } from './types.js';

/**
 * 搜索工具管理器
 * 处理搜索动作的创建和执行
 */

export class SearchToolManager {
  /**
   * 创建搜索动作
   */
  static createSearchAction(query: string, limit: number = 5, backend?: SearchBackend): AgentAction {
    return createSearchAction(query, limit, backend);
  }

  /**
   * 执行搜索动作
   */
  static async executeSearchAction(action: AgentAction): Promise<SearchResponse> {
    if (action.type !== 'search_web') {
      throw new Error('Action is not a search action');
    }

    return await executeSearchAction(action);
  }

  /**
   * 直接搜索
   */
  static async search(query: string, limit: number = 5, backend?: SearchBackend): Promise<SearchResponse> {
    return await searchWeb(query, limit, backend);
  }

  /**
   * 搜索并返回格式化结果
   */
  static async searchAndFormat(query: string, limit: number = 5, backend?: SearchBackend): Promise<string> {
    const result = await searchWeb(query, limit, backend);

    if (!result.success) {
      return `搜索失败: ${result.error}`;
    }

    if (result.data.web.length === 0) {
      return '未找到相关结果';
    }

    return result.data.web.map((item: any, index: number) => {
      return `${index + 1}. ${item.title} (${item.url})${item.description ? `\n   ${item.description}` : ''}`;
    }).join('\n');
  }

  /**
   * 检查搜索动作是否是有效的搜索类型
   */
  static isValidSearchAction(action: any): action is AgentAction {
    return action && action.type === 'search_web' && action.query;
  }

  /**
   * 从会话消息中提取搜索查询
   */
  static extractSearchQueries(messages: SessionMessage[]): string[] {
    const queries: string[] = [];

    for (const message of messages) {
      if (message.role === 'user' && message.content) {
        // 简单的搜索查询提取逻辑
        const searchPatterns = [
          /搜索\s*(.*?)(?:的|关于|for|on)?\s*(?:结果)?/g,
          /查找\s*(.*?)(?:的|关于|for|on)?\s*(?:信息)?/g,
          /search\s*(.*?)(?:for|on)?\s*/g
        ];

        for (const pattern of searchPatterns) {
          let match;
          while ((match = pattern.exec(message.content)) !== null) {
            const query = match[1].trim();
            if (query) {
              queries.push(query);
            }
          }
        }
      }
    }

    return queries;
  }

  /**
   * 搜索结果到工具消息的转换
   */
  static searchResultToToolMessage(result: SearchResponse): SessionMessage {
    const content = result.success
      ? result.data.web.map((item: any, index: number) => {
          return `${index + 1}. ${item.title}\n   链接: ${item.url}${item.description ? `\n   描述: ${item.description}` : ''}`;
        }).join('\n\n')
      : `搜索失败: ${result.error}`;

    return {
      id: Date.now().toString(),
      role: 'tool',
      name: '搜索结果',
      content,
      createdAt: new Date().toISOString()
    };
  }
}