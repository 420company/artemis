import { SearchToolManager } from '../core/searchToolManager.js';
import type { AgentAction } from '../core/types.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

export async function executeSearchWeb(action: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const { query, limit = 5, backend } = action;

  try {
    const result = await SearchToolManager.search(query, limit, backend);
    
    if (!result.success) {
      return {
        action,
        ok: false,
        output: `搜索失败: ${result.error}`
      };
    }

    if (result.data.web.length === 0) {
      return {
        action,
        ok: true,
        output: '未找到相关结果'
      };
    }

    const formattedResults = result.data.web.map((item: any, index: number) => {
      return `${index + 1}. ${item.title}\n   链接: ${item.url}${item.description ? `\n   描述: ${item.description}` : ''}`;
    }).join('\n\n');

    return {
      action,
      ok: true,
      output: formattedResults
    };
  } catch (error) {
    return {
      action,
      ok: false,
      output: `搜索过程中发生错误: ${error instanceof Error ? error.message : '未知错误'}`
    };
  }
}