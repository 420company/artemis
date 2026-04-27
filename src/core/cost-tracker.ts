// 使用统计
export interface UsageStats {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cost: number
}

// API 使用记录
export interface APIUsageRecord {
  id: string
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
  endpoint: string
  duration: number
}

// 成本配置
export interface CostConfig {
  model?: string
  maxBudget?: number
  rateLimit?: number
}

// 成本跟踪器
export class CostTracker {
  private config: CostConfig
  private usageRecords: APIUsageRecord[] = []
  
  constructor(config: Partial<CostConfig> = {}) {
    this.config = {
      model: 'claude-3-haiku',
      maxBudget: 100.0,
      rateLimit: 100,
      ...config
    }
  }

  /**
   * 记录 API 使用
   */
  recordAPIUsage(record: Partial<APIUsageRecord>): APIUsageRecord {
    const newRecord: APIUsageRecord = {
      id: record.id || Math.random().toString(36).substr(2, 9),
      timestamp: record.timestamp || Date.now(),
      model: record.model || this.config.model!,
      inputTokens: record.inputTokens || 0,
      outputTokens: record.outputTokens || 0,
      cost: record.cost || this.calculateCost(record),
      endpoint: record.endpoint || 'chat',
      duration: record.duration || 0
    }

    this.usageRecords.push(newRecord)
    return newRecord
  }

  /**
   * 计算成本
   */
  calculateCost(record?: Partial<APIUsageRecord>): number {
    const model = record?.model || this.config.model!
    const inputTokens = record?.inputTokens || 0
    const outputTokens = record?.outputTokens || 0

    // Claude 模型定价（美元）
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-3-opus-20240229': {
        input: 15.0 / 1_000_000,
        output: 75.0 / 1_000_000
      },
      'claude-3-sonnet-20240229': {
        input: 3.0 / 1_000_000,
        output: 15.0 / 1_000_000
      },
      'claude-3-haiku-20240307': {
        input: 0.25 / 1_000_000,
        output: 1.25 / 1_000_000
      },
      'claude-2.1': {
        input: 8.0 / 1_000_000,
        output: 24.0 / 1_000_000
      },
      'claude-2': {
        input: 8.0 / 1_000_000,
        output: 24.0 / 1_000_000
      }
    }

    const modelPricing = pricing[model] || pricing['claude-3-haiku-20240307']
    return (inputTokens * modelPricing.input) + (outputTokens * modelPricing.output)
  }

  /**
   * 获取总使用量
   */
  getTotalUsage(): UsageStats {
    return this.usageRecords.reduce((total, record) => ({
      totalTokens: total.totalTokens + record.inputTokens + record.outputTokens,
      inputTokens: total.inputTokens + record.inputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      cost: total.cost + record.cost
    }), {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0
    })
  }

  /**
   * 获取会话使用量（最后 N 分钟）
   */
  getSessionUsage(minutes: number = 60): UsageStats {
    const startTime = Date.now() - (minutes * 60 * 1000)
    
    const sessionRecords = this.usageRecords.filter(
      record => record.timestamp > startTime
    )

    return sessionRecords.reduce((total, record) => ({
      totalTokens: total.totalTokens + record.inputTokens + record.outputTokens,
      inputTokens: total.inputTokens + record.inputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      cost: total.cost + record.cost
    }), {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0
    })
  }

  /**
   * 获取使用记录
   */
  getUsageRecords(limit: number = 50): APIUsageRecord[] {
    return this.usageRecords.slice(-limit).reverse()
  }

  /**
   * 检查预算
   */
  checkBudget(): boolean {
    const totalCost = this.getTotalUsage().cost
    return this.config.maxBudget ? totalCost < this.config.maxBudget : true
  }

  /**
   * 获取成本报告
   */
  getCostReport(): any {
    const totalUsage = this.getTotalUsage()
    
    return {
      model: this.config.model,
      totalUsage,
      averageCostPerToken: totalUsage.totalTokens > 0 
        ? (totalUsage.cost / totalUsage.totalTokens * 1_000_000).toFixed(2) + ' per million tokens'
        : '0',
      mostExpensiveCall: this.getMostExpensiveCall(),
      callsPerModel: this.getCallsPerModel()
    }
  }

  /**
   * 获取最昂贵的调用
   */
  getMostExpensiveCall(): APIUsageRecord | null {
    if (this.usageRecords.length === 0) {
      return null
    }

    return this.usageRecords.reduce((max, record) => 
      record.cost > max.cost ? record : max
    )
  }

  /**
   * 获取按模型统计的调用
   */
  getCallsPerModel(): Record<string, number> {
    const stats: Record<string, number> = {}
    
    this.usageRecords.forEach(record => {
      if (!stats[record.model]) {
        stats[record.model] = 0
      }
      stats[record.model]++
    })

    return stats
  }

  /**
   * 重置使用记录
   */
  reset(): void {
    this.usageRecords = []
  }

  /**
   * 导出使用记录（JSON）
   */
  exportToJSON(): string {
    return JSON.stringify(this.usageRecords, null, 2)
  }

  /**
   * 导入使用记录
   */
  importFromJSON(data: string): void {
    try {
      const records = JSON.parse(data)
      if (Array.isArray(records)) {
        this.usageRecords = [...this.usageRecords, ...records]
      }
    } catch (error) {
      console.error('Failed to import usage records:', error)
    }
  }
}

// 导出单例实例
let costTrackerInstance: CostTracker | null = null

export function getCostTracker(config?: Partial<CostConfig>): CostTracker {
  if (!costTrackerInstance) {
    costTrackerInstance = new CostTracker(config)
  }
  return costTrackerInstance
}

// 工厂函数
export function createCostTracker(config?: Partial<CostConfig>): CostTracker {
  return new CostTracker(config)
}

// 便利函数
export function recordAPIUsage(record: Partial<APIUsageRecord>): APIUsageRecord {
  return getCostTracker().recordAPIUsage(record)
}

export function calculateCost(record?: Partial<APIUsageRecord>): number {
  return getCostTracker().calculateCost(record)
}

export function getTotalUsage(): UsageStats {
  return getCostTracker().getTotalUsage()
}

export function checkBudget(): boolean {
  return getCostTracker().checkBudget()
}
