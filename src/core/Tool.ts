/* eslint-disable @typescript-eslint/no-unused-vars */
// 工具系统类型定义和管理机制
export type ToolCategory = 'file' | 'system' | 'search' | 'agent' | 'utils'

export interface ToolDefinition {
  id: string
  name: string
  description: string
  category: ToolCategory
  args: Record<string, any>
  returns: any
  examples?: string[]
}

export interface ToolExecuteResult {
  success: boolean
  data?: any
  error?: string
  durationMs?: number
}

export interface ToolContext {
  cwd: string
  sessionId?: string
  history?: any[]
}

export abstract class BaseTool {
  abstract id: string
  abstract name: string
  abstract description: string
  abstract category: ToolCategory
  
  async validateArgs(args: any): Promise<boolean> {
    return true
  }
  
  abstract execute(args: any, context: ToolContext): Promise<ToolExecuteResult>
  
  getDefinition(): ToolDefinition {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      category: this.category,
      args: this.getArgs(),
      returns: this.getReturns()
    }
  }
  
  abstract getArgs(): Record<string, any>
  abstract getReturns(): any
}

export class ToolManager {
  private tools: Map<string, BaseTool> = new Map()
  private toolCategories: Map<ToolCategory, BaseTool[]> = new Map()
  
  constructor() {
    this.initializeToolCategories()
  }
  
  private initializeToolCategories(): void {
    const categories: ToolCategory[] = ['file', 'system', 'search', 'agent', 'utils']
    categories.forEach(category => {
      this.toolCategories.set(category, [])
    })
  }
  
  registerTool(tool: BaseTool): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool with id '${tool.id}' already exists`)
    }
    
    this.tools.set(tool.id, tool)
    
    const categoryTools = this.toolCategories.get(tool.category)
    if (categoryTools) {
      categoryTools.push(tool)
    }
  }
  
  getTool(id: string): BaseTool | undefined {
    return this.tools.get(id)
  }
  
  getToolsByCategory(category: ToolCategory): BaseTool[] {
    return this.toolCategories.get(category) || []
  }
  
  getAllTools(): BaseTool[] {
    return Array.from(this.tools.values())
  }
  
  async executeTool(id: string, args: any, context: ToolContext): Promise<ToolExecuteResult> {
    const tool = this.getTool(id)
    if (!tool) {
      return {
        success: false,
        error: `Tool '${id}' not found`
      }
    }
    
    try {
      const isValid = await tool.validateArgs(args)
      if (!isValid) {
        return {
          success: false,
          error: `Invalid arguments for tool '${id}'`
        }
      }
      
      const startTime = Date.now()
      const result = await tool.execute(args, context)
      const durationMs = Date.now() - startTime
      
      return {
        ...result,
        durationMs
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
  
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => tool.getDefinition())
  }
  
  searchTools(query: string): ToolDefinition[] {
    const searchTerm = query.toLowerCase()
    return this.getToolDefinitions().filter(tool => 
      tool.name.toLowerCase().includes(searchTerm) ||
      tool.description.toLowerCase().includes(searchTerm) ||
      tool.id.toLowerCase().includes(searchTerm)
    )
  }
}

// 单例工具管理器
let toolManagerInstance: ToolManager | null = null

export function getToolManager(): ToolManager {
  if (!toolManagerInstance) {
    toolManagerInstance = new ToolManager()
  }
  return toolManagerInstance
}

export function createToolManager(): ToolManager {
  return new ToolManager()
}

// 工具工厂函数
export function registerTool(tool: BaseTool): void {
  getToolManager().registerTool(tool)
}

export function getTool(id: string): BaseTool | undefined {
  return getToolManager().getTool(id)
}

export function getToolsByCategory(category: ToolCategory): BaseTool[] {
  return getToolManager().getToolsByCategory(category)
}

export function getAllTools(): BaseTool[] {
  return getToolManager().getAllTools()
}

export function executeTool(id: string, args: any, context: ToolContext): Promise<ToolExecuteResult> {
  return getToolManager().executeTool(id, args, context)
}

export function getToolDefinitions(): ToolDefinition[] {
  return getToolManager().getToolDefinitions()
}

export function searchTools(query: string): ToolDefinition[] {
  return getToolManager().searchTools(query)
}
