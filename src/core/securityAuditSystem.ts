import type { ToolDefinition } from '../core/toolDef.js';
import type { AgentAction } from '../core/types.js';
import { getToolDefinition } from '../tools/registry.js';

/**
 * 审计事件接口
 */
export interface AuditEvent {
  id: string;
  timestamp: string;
  eventType: AuditEventType;
  actor: string;
  action: string;
  target?: string;
  result: string;
  duration?: number;
  metadata?: any;
}

/**
 * 审计事件类型
 */
export type AuditEventType = 
  | 'user_authentication'
  | 'tool_execution'
  | 'skill_execution'
  | 'query_execution'
  | 'system_action'
  | 'configuration_change'
  | 'security_alert'
  | 'error';

/**
 * 审计级别
 */
export type AuditLevel = 'info' | 'warning' | 'error' | 'critical';

/**
 * 安全审计系统类
 */
export class SecurityAuditSystem {
  private auditLog: AuditEvent[] = [];
  private maxLogSize: number = 10000;
  private logFile: string = './artemis-audit.log';

  /**
   * 记录审计事件（别名方法，向后兼容）
   */
  logAuditEvent(eventType: AuditEventType, options: any = {}): AuditEvent {
    return this.logEvent(eventType, options.actor || 'unknown', options.action || 'unknown', options);
  }

  /**
   * 记录审计事件
   */
  logEvent(eventType: AuditEventType, actor: string, action: string, options: any = {}): AuditEvent {
    const event: AuditEvent = {
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      eventType,
      actor,
      action,
      target: options.target,
      result: options.result || 'success',
      duration: options.duration,
      metadata: options.metadata,
    };

    // 添加到审计日志
    this.auditLog.push(event);

    // 限制日志大小
    if (this.auditLog.length > this.maxLogSize) {
      this.auditLog = this.auditLog.slice(this.auditLog.length - this.maxLogSize);
    }

    // 写入到文件
    this.writeToLogFile(event);

    return event;
  }

  /**
   * 检查权限
   */
  hasPermission(toolType: string): boolean {
    const tool = getToolDefinition(toolType);
    if (!tool) {
      return false;
    }

    // 简单的权限检查：默认允许所有工具
    return true;
  }

  /**
   * 获取所有权限
   */
  getPermissions(): { [key: string]: boolean } {
    const permissions: { [key: string]: boolean } = {};
    // 这里应该从配置或数据库中获取权限信息
    // 现在我们简单地返回所有工具的默认权限
    return permissions;
  }

  /**
   * 记录工具执行事件
   */
  logToolExecution(action: AgentAction, actor: string, result: any): AuditEvent {
    const tool = getToolDefinition(action.type);
    
    return this.logEvent('tool_execution', actor, `Executing tool: ${action.type}`, {
      target: tool?.description,
      result: result.ok ? 'success' : 'failure',
      duration: result.duration,
      metadata: {
        toolType: action.type,
        parameters: action,
        executionTime: result.duration,
        output: result.output,
      },
    });
  }

  /**
   * 记录技能执行事件
   */
  logSkillExecution(skillId: string, actor: string, result: any): AuditEvent {
    return this.logEvent('skill_execution', actor, `Executing skill: ${skillId}`, {
      result: result.success ? 'success' : 'failure',
      duration: result.duration,
      metadata: {
        skillId,
        inputs: result.inputs,
        executionTime: result.duration,
        output: result.output,
        logs: result.logs,
      },
    });
  }

  /**
   * 记录查询执行事件
   */
  logQueryExecution(query: string, actor: string, result: any): AuditEvent {
    return this.logEvent('query_execution', actor, `Executing query: ${query}`, {
      result: result.success ? 'success' : 'failure',
      duration: result.metadata?.executionTime,
      metadata: {
        query,
        queryType: result.metadata?.queryType,
        executionTime: result.metadata?.executionTime,
        source: result.metadata?.source,
        data: result.data,
        error: result.error,
      },
    });
  }

  /**
   * 记录系统事件
   */
  logSystemAction(action: string, actor: string, result: any = 'success'): AuditEvent {
    return this.logEvent('system_action', actor, action, {
      result,
      metadata: {
        action,
      },
    });
  }

  /**
   * 记录安全警报
   */
  logSecurityAlert(message: string, severity: AuditLevel, metadata: any = {}): AuditEvent {
    return this.logEvent('security_alert', 'system', message, {
      result: severity,
      metadata,
    });
  }

  /**
   * 记录错误事件
   */
  logError(error: Error, actor: string, context: any = {}): AuditEvent {
    return this.logEvent('error', actor, error.message, {
      result: 'failure',
      metadata: {
        stack: error.stack,
        context,
      },
    });
  }

  /**
   * 生成事件ID
   */
  private generateEventId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * 获取审计事件列表
   */
  getAuditEvents(): AuditEvent[] {
    return this.auditLog;
  }

  /**
   * 获取安全统计信息
   */
  getSecurityStats(): any {
    const stats = {
      totalEvents: this.auditLog.length,
      byType: {} as any,
      byResult: {} as any,
    };

    this.auditLog.forEach(event => {
      // 按事件类型统计
      if (!stats.byType[event.eventType]) {
        stats.byType[event.eventType] = 0;
      }
      stats.byType[event.eventType]++;

      // 按结果统计
      if (!stats.byResult[event.result]) {
        stats.byResult[event.result] = 0;
      }
      stats.byResult[event.result]++;
    });

    return stats;
  }

  /**
   * 写入到日志文件
   */
  private writeToLogFile(event: AuditEvent): void {
    // 使用 ES 模块的 fs 替代 require
    import('fs').then(fs => {
      try {
        if (!fs.existsSync('./logs')) {
          fs.mkdirSync('./logs', { recursive: true });
        }

        const logLine = JSON.stringify(event) + '\n';
        fs.appendFileSync(`./logs/${this.logFile}`, logLine, 'utf8');
      } catch (error) {
        console.warn('Failed to write audit log:', error);
      }
    }).catch(error => {
      console.warn('Failed to write audit log:', error);
    });
  }

  /**
   * 查询审计日志
   */
  queryAuditLog(filter: any = {}): AuditEvent[] {
    let results = [...this.auditLog];
    const matches = (value: string | undefined, expected: unknown): boolean => {
      if (expected === undefined || expected === null) return true;
      if (Array.isArray(expected)) return expected.includes(value);
      return value === expected;
    };

    // 按事件类型过滤
    if (filter.eventType) {
      results = results.filter(event => matches(event.eventType, filter.eventType));
    }

    // 按参与者过滤
    if (filter.actor) {
      results = results.filter(event => event.actor === filter.actor);
    }

    // 按结果过滤
    if (filter.result) {
      results = results.filter(event => matches(event.result, filter.result));
    }

    // 按时间范围过滤
    if (filter.startTime) {
      const startTime = new Date(filter.startTime);
      results = results.filter(event => new Date(event.timestamp) >= startTime);
    }

    if (filter.endTime) {
      const endTime = new Date(filter.endTime);
      results = results.filter(event => new Date(event.timestamp) <= endTime);
    }

    // 按目标过滤
    if (filter.target) {
      results = results.filter(event => event.target?.includes(filter.target));
    }

    // 排序
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // 分页
    if (filter.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  /**
   * 获取审计统计信息
   */
  getAuditStatistics(): any {
    const stats = {
      totalEvents: this.auditLog.length,
      eventsByType: {} as Record<string, number>,
      eventsByResult: {} as Record<string, number>,
      recentEvents: {
        lastHour: 0,
        last24Hours: 0,
        last7Days: 0,
      },
    };

    // 事件类型统计
    this.auditLog.forEach(event => {
      stats.eventsByType[event.eventType] = (stats.eventsByType[event.eventType] || 0) + 1;
      stats.eventsByResult[event.result] = (stats.eventsByResult[event.result] || 0) + 1;
    });

    // 最近事件统计
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    this.auditLog.forEach(event => {
      const eventTime = new Date(event.timestamp);
      
      if (eventTime >= oneHourAgo) {
        stats.recentEvents.lastHour++;
      }
      
      if (eventTime >= oneDayAgo) {
        stats.recentEvents.last24Hours++;
      }
      
      if (eventTime >= oneWeekAgo) {
        stats.recentEvents.last7Days++;
      }
    });

    return stats;
  }

  /**
   * 分析安全趋势
   */
  analyzeSecurityTrends(): any {
    const trends = {
      securityAlerts: [] as Array<{ timestamp: string; message: string; severity: string }>,
      failureRate: {} as Record<string, string | number>,
      highRiskEvents: [] as Array<{ timestamp: string; type: string; action: string; severity: string }>,
    };

    // 安全警报趋势
    const securityAlerts = this.queryAuditLog({
      eventType: 'security_alert',
      endTime: new Date().toISOString(),
      startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    trends.securityAlerts = securityAlerts.map(alert => ({
      timestamp: alert.timestamp,
      message: alert.action,
      severity: alert.result,
    }));

    // 失败率分析
    const allEvents = this.queryAuditLog({
      endTime: new Date().toISOString(),
      startTime: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });

    const eventTypes = new Set(allEvents.map(event => event.eventType));
    eventTypes.forEach(type => {
      const typeEvents = allEvents.filter(event => event.eventType === type);
      const failures = typeEvents.filter(event => event.result === 'failure' || event.result === 'error');
      
      trends.failureRate[type] = typeEvents.length > 0 
        ? (failures.length / typeEvents.length * 100).toFixed(2)
        : 0;
    });

    // 高风险事件
    const highRiskEvents = this.queryAuditLog({
      eventType: ['security_alert', 'error'],
      result: ['critical', 'failure'],
      endTime: new Date().toISOString(),
      startTime: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });

    trends.highRiskEvents = highRiskEvents.map(event => ({
      timestamp: event.timestamp,
      type: event.eventType,
      action: event.action,
      severity: event.result,
    }));

    return trends;
  }

  /**
   * 生成审计报告
   */
  generateAuditReport(): string {
    const stats = this.getAuditStatistics();
    const trends = this.analyzeSecurityTrends();

    return `
# Artemis Audit Report
Generated: ${new Date().toISOString()}

## Overview
- Total Events: ${stats.totalEvents}
- Last Hour: ${stats.recentEvents.lastHour}
- Last 24 Hours: ${stats.recentEvents.last24Hours}
- Last 7 Days: ${stats.recentEvents.last7Days}

## Events by Type
${Object.entries(stats.eventsByType).map(([type, count]) => `  - ${type}: ${count}`).join('\n')}

## Events by Result
${Object.entries(stats.eventsByResult).map(([result, count]) => `  - ${result}: ${count}`).join('\n')}

## Failure Rates (last 24 hours)
${Object.entries(trends.failureRate).map(([type, rate]) => `  - ${type}: ${rate}%`).join('\n')}

## Security Alerts (last 7 days)
${trends.securityAlerts.length > 0 ? 
  trends.securityAlerts.map((alert: any) => `  - ${alert.timestamp}: [${alert.severity}] ${alert.message}`).join('\n') : 
  '  No security alerts'}

## High Risk Events (last 24 hours)
${trends.highRiskEvents.length > 0 ? 
  trends.highRiskEvents.map((event: any) => `  - ${event.timestamp}: [${event.severity}] ${event.action}`).join('\n') : 
  '  No high risk events'}
    `.trim();
  }

  /**
   * 导出审计日志
   */
  exportAuditLog(): string {
    return JSON.stringify(this.auditLog, null, 2);
  }

  /**
   * 清理旧日志
   */
  cleanUpOldLogs(daysToKeep: number = 30): void {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    this.auditLog = this.auditLog.filter(event => new Date(event.timestamp) > cutoffDate);
    
    console.log(`Cleaned up audit log: removed events older than ${daysToKeep} days`);
  }
}

/**
 * 安全审计工具定义
 */
export const securityAuditToolDef: ToolDefinition = {
  type: 'security_audit',
  description: 'Security audit and monitoring tool',
  kind: 'agent',
  executionMode: 'blocking',
  permissionCategory: 'sensitive',
  parallelSafe: true,
  validate: (action: any) => {
    const errors: string[] = [];
    if (!action?.action) {
      errors.push('Missing action');
    } else if (!['query', 'stats', 'trends', 'report', 'export', 'cleanup'].includes(action.action)) {
      errors.push('Invalid action');
    }
    if (action.action === 'cleanup' && (typeof action.daysToKeep !== 'number' || action.daysToKeep < 1 || action.daysToKeep > 365)) {
      errors.push('daysToKeep must be a number between 1 and 365');
    }
    return errors;
  },
  execute: async (action: any, context: any): Promise<{ ok: boolean; output: string }> => {
    try {
      const auditSystem = new SecurityAuditSystem();
      
      switch (action.action) {
        case 'query':
          const results = auditSystem.queryAuditLog(action.filters || {});
          return {
            ok: true,
            output: JSON.stringify(results, null, 2),
          };
          
        case 'stats':
          const stats = auditSystem.getAuditStatistics();
          return {
            ok: true,
            output: JSON.stringify(stats, null, 2),
          };
          
        case 'trends':
          const trends = auditSystem.analyzeSecurityTrends();
          return {
            ok: true,
            output: JSON.stringify(trends, null, 2),
          };
          
        case 'report':
          const report = auditSystem.generateAuditReport();
          return {
            ok: true,
            output: report,
          };
          
        case 'export':
          const exportData = auditSystem.exportAuditLog();
          return {
            ok: true,
            output: exportData,
          };
          
        case 'cleanup':
          const daysToKeep = action.daysToKeep || 30;
          auditSystem.cleanUpOldLogs(daysToKeep);
          return {
            ok: true,
            output: `Audit log cleaned up - kept logs for last ${daysToKeep} days`,
          };
          
        default:
          return {
            ok: false,
            output: `Unknown action: ${action.action}`,
          };
      }
    } catch (error) {
      return {
        ok: false,
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
