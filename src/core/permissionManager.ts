/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars, @typescript-eslint/no-var-requires */
// 权限类型定义
export type PermissionMode = 'allow' | 'deny' | 'prompt'

export interface PermissionResult {
  allowed: boolean
  mode: PermissionMode
  message?: string
  expiresAt?: number
}

export interface AdditionalWorkingDirectory {
  path: string
  writable?: boolean
}

// 权限分类
export enum PermissionCategory {
  READ = 'read',
  WRITE = 'write',
  EXECUTE = 'execute',
  NETWORK = 'network',
  SYSTEM = 'system',
  PRIVILEGED = 'privileged'
}

// 权限配置
export interface PermissionConfig {
  category: PermissionCategory
  mode: PermissionMode
  allowedPaths?: string[]
  blockedPaths?: string[]
  expirationTime?: number
}

// 权限上下文
export interface PermissionContext {
  toolType: string
  action: any
  cwd: string
  workingDirectory: string
  userId?: string
  sessionId?: string
}

// 权限管理系统
export class PermissionManager {
  private permissions: Map<string, PermissionConfig> = new Map()
  private defaultPermissions: Map<PermissionCategory, PermissionMode> = new Map()

  constructor() {
    // 初始化默认权限
    this.initDefaultPermissions()
  }

  /**
   * 初始化默认权限
   */
  private initDefaultPermissions(): void {
    this.defaultPermissions.set(PermissionCategory.READ, 'allow')
    this.defaultPermissions.set(PermissionCategory.WRITE, 'prompt')
    this.defaultPermissions.set(PermissionCategory.EXECUTE, 'prompt')
    this.defaultPermissions.set(PermissionCategory.NETWORK, 'prompt')
    this.defaultPermissions.set(PermissionCategory.SYSTEM, 'deny')
    this.defaultPermissions.set(PermissionCategory.PRIVILEGED, 'deny')
  }

  /**
   * 设置权限
   */
  setPermission(category: PermissionCategory, mode: PermissionMode): void {
    this.defaultPermissions.set(category, mode)
  }

  /**
   * 为特定工具类型设置权限
   */
  setToolPermission(toolType: string, category: PermissionCategory, mode: PermissionMode): void {
    this.permissions.set(`${toolType}:${category}`, {
      category,
      mode,
      allowedPaths: [],
      blockedPaths: []
    })
  }

  /**
   * 获取权限配置
   */
  getPermission(category: PermissionCategory): PermissionMode {
    return this.defaultPermissions.get(category) || 'deny'
  }

  /**
   * 检查权限
   */
  checkPermission(context: PermissionContext): PermissionResult {
    const toolPermissionKey = `${context.toolType}:${this.getToolPermissionCategory(context.toolType)}`
    const toolPermission = this.permissions.get(toolPermissionKey)

    // 检查特定工具权限
    if (toolPermission) {
      return this.evaluatePermission(toolPermission, context)
    }

    // 检查默认权限
    const defaultMode = this.getPermission(this.getToolPermissionCategory(context.toolType))
    return {
      allowed: defaultMode === 'allow',
      mode: defaultMode
    }
  }

  /**
   * 评估权限配置
   */
  private evaluatePermission(
    config: PermissionConfig,
    context: PermissionContext
  ): PermissionResult {
    // 检查权限是否已过期
    if (config.expirationTime && Date.now() > config.expirationTime) {
      return {
        allowed: this.getPermission(config.category) === 'allow',
        mode: this.getPermission(config.category)
      }
    }

    // 检查路径限制
    if (context.action.path) {
      const normalizedPath = this.normalizePath(context.action.path, context.workingDirectory)
      
      // 检查禁止路径
      if (config.blockedPaths && config.blockedPaths.some(path => 
        normalizedPath.startsWith(this.normalizePath(path, context.workingDirectory))
      )) {
        return {
          allowed: false,
          mode: 'deny',
          message: `Path ${context.action.path} is blocked`
        }
      }

      // 检查允许路径
      if (config.allowedPaths && config.allowedPaths.length > 0 &&
          !config.allowedPaths.some(path => 
            normalizedPath.startsWith(this.normalizePath(path, context.workingDirectory))
          )) {
        return {
          allowed: false,
          mode: 'deny',
          message: `Path ${context.action.path} is not allowed`
        }
      }
    }

    return {
      allowed: config.mode === 'allow',
      mode: config.mode
    }
  }

  /**
   * 规范化路径
   */
  private normalizePath(path: string, workingDir: string): string {
    const { resolve, normalize } = require('path')
    return normalize(resolve(workingDir, path))
  }

  /**
   * 获取工具权限分类
   */
  private getToolPermissionCategory(toolType: string): PermissionCategory {
    switch (toolType) {
      case 'read_file':
      case 'list_files':
      case 'search_files':
      case 'lookup_docs':
        return PermissionCategory.READ

      case 'write_file':
      case 'insert_in_file':
      case 'replace_in_file':
      case 'apply_patch':
      case 'todo':
        return PermissionCategory.WRITE

      case 'run_command':
      case 'generate_image':
      case 'generate_video':
      case 'mcp':
      case 'agent':
      case 'notebook_worktree':
        return PermissionCategory.EXECUTE

      case 'http_request':
      case 'search':
      case 'web_scraper':
        return PermissionCategory.NETWORK

      case 'system':
      case 'computer':
        return PermissionCategory.SYSTEM

      default:
        return PermissionCategory.READ
    }
  }

  /**
   * 设置路径限制
   */
  setPathRestrictions(
    category: PermissionCategory,
    allowedPaths: string[],
    blockedPaths: string[]
  ): void {
    const config: PermissionConfig = {
      category,
      mode: this.getPermission(category),
      allowedPaths: allowedPaths.map(p => this.normalizePath(p, process.cwd())),
      blockedPaths: blockedPaths.map(p => this.normalizePath(p, process.cwd()))
    }
    
    this.permissions.set(`category:${category}`, config)
  }

  /**
   * 验证权限配置
   */
  validatePermissions(): string[] {
    const errors: string[] = []

    // 检查权限配置是否有效
    for (const [key, config] of this.permissions) {
      if (!config.category || !config.mode) {
        errors.push(`Invalid permission config: ${key}`)
      }
    }

    return errors
  }

  /**
   * 获取权限报告
   */
  getPermissionReport(): any {
    const report: any = {
      defaultPermissions: {},
      toolPermissions: {},
      pathRestrictions: []
    }

    // 添加默认权限
    this.defaultPermissions.forEach((mode, category) => {
      report.defaultPermissions[category] = mode
    })

    // 添加工具权限
    for (const [key, config] of this.permissions) {
      if (key.startsWith('category:')) {
        report.pathRestrictions.push({
          category: config.category,
          allowedPaths: config.allowedPaths,
          blockedPaths: config.blockedPaths
        })
      } else {
        report.toolPermissions[key] = config.mode
      }
    }

    return report
  }

  /**
   * 重置权限
   */
  resetPermissions(): void {
    this.permissions.clear()
    this.initDefaultPermissions()
  }
}

// 单例权限管理器
let permissionManagerInstance: PermissionManager | null = null

export function getPermissionManager(): PermissionManager {
  if (!permissionManagerInstance) {
    permissionManagerInstance = new PermissionManager()
  }
  return permissionManagerInstance
}

export function createPermissionManager(): PermissionManager {
  return new PermissionManager()
}

// 权限检查函数
export async function checkPermission(
  toolType: string,
  action: any,
  context: any
): Promise<PermissionResult> {
  const manager = getPermissionManager()
  
  return manager.checkPermission({
    toolType,
    action,
    cwd: context.cwd || process.cwd(),
    workingDirectory: context.workingDirectory || context.cwd || process.cwd(),
    userId: context.userId,
    sessionId: context.sessionId
  })
}

// 用户确认权限
export async function promptForPermission(
  toolType: string,
  action: any,
  context: any
): Promise<boolean> {
  const readline = require('readline')
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return new Promise((resolve) => {
    const message = `Allow ${toolType} ${action.path || ''}? (y/N): `
    
    rl.question(message, (answer: string) => {
      rl.close()
      resolve(answer.toLowerCase().trim() === 'y')
    })
  })
}
