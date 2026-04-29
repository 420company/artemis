#!/usr/bin/env node
import * as readline from 'readline/promises'
import { getQueryEngine } from '../core/queryEngine'
import { getSessionManager } from '../core/sessionManager'
import { getCostTracker } from '../core/cost-tracker'

export class ArtemisCLI {
  private rl: readline.Interface
  private queryEngine = getQueryEngine()
  private sessionManager = getSessionManager()
  private costTracker = getCostTracker()
  
  private sessionId: string
  
  constructor(_options: any = {}) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'Artemis > '
    })
    
    this.sessionId = this.sessionManager.createSession()
    
    this.initialize()
  }
  
  private initialize(): void {
    console.log('🚀 Artemis v0.5.7 - AI 编程助手')
    console.log('================================')
    console.log('类型 "help" 查看命令列表')
    console.log('类型 "quit" 或按 Ctrl+C 退出')
    console.log()
    
    this.rl.prompt()
    
    this.rl.on('line', (line) => {
      this.handleInput(line.trim())
    })
    
    this.rl.on('close', () => {
      this.cleanup()
    })
  }
  
  private async handleInput(input: string): Promise<void> {
    if (!input) {
      this.rl.prompt()
      return
    }
    
    const command = input.toLowerCase().split(' ')[0]
    
    switch (command) {
      case 'quit':
      case 'exit':
        this.rl.close()
        return
        
      case 'help':
        this.showHelp()
        break
        
      case 'clear':
        this.clearScreen()
        break
        
      case 'stats':
        this.showStats()
        break
        
      case 'session':
        this.showSessionInfo()
        break
        
      case 'cost':
        this.showCostInfo()
        break
        
      default:
        await this.handleQuery(input)
    }
    
    this.rl.prompt()
  }
  
  private showHelp(): void {
    console.log()
    console.log('可用命令:')
    console.log('  help      - 显示此帮助信息')
    console.log('  clear     - 清空屏幕')
    console.log('  stats     - 显示会话统计信息')
    console.log('  session   - 显示会话信息')
    console.log('  cost      - 显示成本统计信息')
    console.log('  quit/exit - 退出应用程序')
    console.log()
    console.log('示例查询:')
    console.log('  "创建一个 Hello World Python 文件"')
    console.log('  "查看 package.json 文件内容"')
    console.log('  "运行 npm install"')
    console.log()
  }
  
  private clearScreen(): void {
    process.stdout.write('\x1B[2J\x1B[0f')
  }
  
  private showStats(): void {
    const costTracker = getCostTracker()
    const cost = costTracker.getTotalUsage()
    
    console.log()
    console.log('📊 会话统计:')
    console.log('============')
    console.log(`总成本: $${cost.cost.toFixed(4)}`)
    console.log(`总令牌数: ${cost.totalTokens}`)
    console.log(`输入令牌: ${cost.inputTokens}`)
    console.log(`输出令牌: ${cost.outputTokens}`)
    console.log(`平均成本每百万令牌: $${(cost.cost / cost.totalTokens * 1_000_000).toFixed(2)}`)
    console.log()
  }
  
  private showSessionInfo(): void {
    const session = this.sessionManager.getSession(this.sessionId)
    
    if (session) {
      console.log()
      console.log('🔄 会话信息:')
      console.log('============')
      console.log(`会话ID: ${session.sessionId}`)
      console.log(`创建时间: ${new Date(session.creationTime).toLocaleString()}`)
      console.log(`最后活跃时间: ${new Date(session.lastActivityTime).toLocaleString()}`)
      console.log(`消息数: ${session.messages.length}`)
      console.log()
    }
  }
  
  private showCostInfo(): void {
    const costTracker = getCostTracker()
    const costReport = costTracker.getCostReport()
    
    console.log()
    console.log('💰 成本信息:')
    console.log('============')
    console.log(`使用模型: ${costReport.model}`)
    console.log(`总使用量: ${costReport.totalUsage.totalTokens} 令牌`)
    console.log(`总成本: $${costReport.totalUsage.cost.toFixed(4)}`)
    console.log(`平均成本每百万令牌: ${costReport.averageCostPerToken}`)
    console.log()
    console.log('按模型统计的调用:')
    
    Object.entries(costReport.callsPerModel).forEach(([model, count]) => {
      console.log(`  ${model}: ${count} 次`)
    })
    
    if (costReport.mostExpensiveCall) {
      console.log()
      console.log('最昂贵的调用:')
      console.log(`  成本: $${costReport.mostExpensiveCall.cost.toFixed(4)}`)
      console.log(`  模型: ${costReport.mostExpensiveCall.model}`)
      console.log(`  输入令牌: ${costReport.mostExpensiveCall.inputTokens}`)
      console.log(`  输出令牌: ${costReport.mostExpensiveCall.outputTokens}`)
    }
    
    console.log()
  }
  
  private async handleQuery(input: string): Promise<void> {
    try {
      console.log()
      console.log('🤔 处理查询中...')
      
      const result = await this.queryEngine.executeQuery(input)
      
      if (result.error) {
        console.log(`❌ 错误: ${result.error}`)
      } else {
        console.log('✅ 查询完成')
        console.log()
        console.log(result.response?.content || '处理完成')
        console.log()
        console.log(`⏱️  执行时间: ${result.durationMs}ms`)
        console.log(`💲 成本: $${result.cost.toFixed(4)}`)
        console.log()
      }
    } catch (error) {
      console.log()
      console.log(`❌ 错误: ${error instanceof Error ? error.message : String(error)}`)
      console.log()
    }
  }
  
  private cleanup(): void {
    console.log()
    console.log('👋 再见!')
    
    const costTracker = getCostTracker()
    const totalCost = costTracker.getTotalUsage().cost
    
    if (totalCost > 0) {
      console.log(`💲 会话总成本: $${totalCost.toFixed(4)}`)
    }
    
    process.exit(0)
  }
}
