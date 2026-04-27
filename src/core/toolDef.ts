import type { ZodSchema } from 'zod'
import type { AgentAction } from './types.js'

export type ToolKind = 'read' | 'write' | 'shell' | 'agent' | 'mcp' | 'search' | 'code' | 'function'

export type ToolPermissionCategory = 
  | 'none'            // 无需权限检查
  | 'read'            // 只读操作
  | 'write'           // 写入操作
  | 'execute'         // 执行操作
  | 'sensitive'       // 敏感操作
  | 'admin'           // 管理员操作
  | 'agent'           // 代理操作

export type ToolExecutionMode = 
  | 'blocking'        // 阻塞执行
  | 'non-blocking'    // 非阻塞执行
  | 'background'      // 后台执行

export interface ToolDefinition {
  type: string
  description: string
  kind: ToolKind
  permissionCategory: ToolPermissionCategory
  executionMode: ToolExecutionMode
  parallelSafe: boolean
  searchHint?: string
  maxResultSizeChars?: number
  shouldDefer?: boolean
  ui?: {
    component?: string
    userFacingName?: string
  }
  tags?: string[]
  validate?: (action: AgentAction) => string[]
  execute?: (
    action: AgentAction,
    context: any
  ) => Promise<any>
  toAutoClassifierInput?: (input: any) => string
  renderToolUseMessage?: (input: any) => any
  renderToolResultMessage?: (result: any) => any
  mapToolResultToToolResultBlockParam?: (result: any, toolUseID: string) => any
}

export interface ToolDefBuilder<TInput extends object, TOutput extends object> {
  name: string
  description: string
  kind: ToolKind
  permissionCategory: ToolPermissionCategory
  executionMode: ToolExecutionMode
  parallelSafe: boolean
  searchHint?: string
  maxResultSizeChars?: number
  shouldDefer?: boolean
  ui?: {
    component?: string
    userFacingName?: string
  }
  tags?: string[]
  inputSchema?: ZodSchema<TInput>
  outputSchema?: ZodSchema<TOutput>
  validate?: (action: AgentAction) => string[]
  execute?: (
    action: AgentAction,
    context: any
  ) => Promise<TOutput>
  toAutoClassifierInput?: (input: TInput) => string
  renderToolUseMessage?: (input: TInput) => any
  renderToolResultMessage?: (result: TOutput) => any
  mapToolResultToToolResultBlockParam?: (result: TOutput, toolUseID: string) => any
}

export function buildTool<TInput extends object, TOutput extends object>(
  toolDef: ToolDefBuilder<TInput, TOutput>
): ToolDefinition {
  return {
    type: toolDef.name,
    description: toolDef.description,
    kind: toolDef.kind,
    permissionCategory: toolDef.permissionCategory,
    executionMode: toolDef.executionMode,
    parallelSafe: toolDef.parallelSafe,
    searchHint: toolDef.searchHint,
    maxResultSizeChars: toolDef.maxResultSizeChars,
    shouldDefer: toolDef.shouldDefer,
    ui: toolDef.ui,
    tags: toolDef.tags,
    validate: toolDef.validate,
    execute: toolDef.execute,
    toAutoClassifierInput: toolDef.toAutoClassifierInput,
    renderToolUseMessage: toolDef.renderToolUseMessage,
    renderToolResultMessage: toolDef.renderToolResultMessage,
    mapToolResultToToolResultBlockParam: toolDef.mapToolResultToToolResultBlockParam
  }
}
