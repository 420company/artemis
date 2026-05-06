import type { ToolDefinition, ToolPermissionCategory } from '../core/toolDef.js';

export type PermissionCheckResult = {
  allowed: boolean
  reason?: string
  requiresApproval?: boolean
}

export interface PermissionPolicy {
  category: ToolPermissionCategory
  check: (context: any) => PermissionCheckResult
}

export class YoloClassifier {
  private static sensitivePatterns = [
    /(ssh|private|secret|key|password|token|api.?key|secret.?key|access.?key)/i,
    /(rm|delete|remove|destroy|wipe|format)/i,
    /(exec|execute|run|bash|shell|command)/i,
    /(sudo|su|root|admin)/i,
    /(eval|exec|system)/i
  ]

  static isSensitiveCommand(command: string): boolean {
    return this.sensitivePatterns.some(pattern => pattern.test(command))
  }

  static classifyPermissionCategory(tool: ToolDefinition, action: any): ToolPermissionCategory {
    if (tool.permissionCategory === 'admin') {
      return 'admin'
    }

    if (tool.kind === 'shell' && action.command) {
      if (this.isSensitiveCommand(action.command)) {
        return 'sensitive'
      }
      if (['rm', 'rmdir', 'delete', 'format'].some(cmd => 
        action.command.toLowerCase().includes(cmd))) {
        return 'write'
      }
    }

    return tool.permissionCategory
  }

  static checkPermission(
    tool: ToolDefinition, 
    action: any, 
    context: any
  ): PermissionCheckResult {
    const category = this.classifyPermissionCategory(tool, action)
    
    switch (category) {
      case 'none':
        return { allowed: true }
      
      case 'read':
        return { allowed: true }
      
      case 'write':
        return { 
          allowed: context.permissionMode === 'full-access' || 
                  context.permissionMode === 'write',
          requiresApproval: context.permissionMode === 'ask'
        }
      
      case 'execute':
        return { 
          allowed: context.permissionMode === 'full-access',
          requiresApproval: true
        }
      
      case 'sensitive':
        return { 
          allowed: context.permissionMode === 'full-access',
          requiresApproval: true,
          reason: 'This action involves sensitive operations and requires approval'
        }
      
      case 'admin':
        return { 
          allowed: context.permissionMode === 'full-access' && 
                  context.isAdmin,
          requiresApproval: true,
          reason: 'This action requires admin privileges'
        }
      
      default:
        return { allowed: false, reason: 'Unknown permission category' }
    }
  }
}

export class PermissionManager {
  private policies: Map<ToolPermissionCategory, PermissionPolicy> = new Map()

  constructor() {
    this.initializeDefaultPolicies()
  }

  private initializeDefaultPolicies(): void {
    this.policies.set('none', {
      category: 'none',
      check: () => ({ allowed: true })
    })

    this.policies.set('read', {
      category: 'read',
      check: () => ({ allowed: true })
    })

    this.policies.set('write', {
      category: 'write',
      check: (context) => ({
        allowed: context.permissionMode === 'full-access' || 
                context.permissionMode === 'write',
        requiresApproval: context.permissionMode === 'ask'
      })
    })

    this.policies.set('execute', {
      category: 'execute',
      check: (context) => ({
        allowed: context.permissionMode === 'full-access',
        requiresApproval: true
      })
    })

    this.policies.set('sensitive', {
      category: 'sensitive',
      check: (context) => ({
        allowed: context.permissionMode === 'full-access',
        requiresApproval: true,
        reason: 'Sensitive operation'
      })
    })

    this.policies.set('admin', {
      category: 'admin',
      check: (context) => ({
        allowed: context.permissionMode === 'full-access' && context.isAdmin,
        requiresApproval: true,
        reason: 'Admin privileges required'
      })
    })
  }

  checkPermission(tool: ToolDefinition, action: any, context: any): PermissionCheckResult {
    return YoloClassifier.checkPermission(tool, action, context)
  }
}

export const permissionManager = new PermissionManager()
