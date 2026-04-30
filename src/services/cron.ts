/* eslint-disable @typescript-eslint/no-unused-vars, prefer-const */
import path from 'node:path'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveDataRootDir, pathExists, ensureDir } from '../utils/fs.js'
import { SessionStore } from '../storage/sessions.js'
import { runAgent } from '../core/agent.js'
import { PermissionManager } from '../security/permissions.js'
import { createProviderRouter } from '../providers/router.js'
import { ProviderStore } from '../providers/store.js'
import { createTrackedProviderFromConfig } from '../providers/telemetry.js'

const execFileAsync = promisify(execFile)

export interface CronJob {
  id: string
  name: string
  schedule: 'daily' | 'hourly'
  lastRunAt?: string
  task: (cwd: string) => Promise<string>
}

export interface CronSchedulerSettings {
  enabled: boolean
  lastRun: Record<string, string>
}

function normalizeCronSettings(raw: unknown): CronSchedulerSettings {
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    if ('lastRun' in record) {
      return {
        enabled: record.enabled !== false,
        lastRun: record.lastRun && typeof record.lastRun === 'object'
          ? record.lastRun as Record<string, string>
          : {},
      }
    }

    // Backward compatibility with the old file shape:
    // { "repo-audit": "2026-..." }
    const lastRun: Record<string, string> = {}
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string') {
        lastRun[key] = value
      }
    }
    return { enabled: true, lastRun }
  }

  return { enabled: true, lastRun: {} }
}

/**
 * Artemis Cron Scheduler — Surpassing Hermes with engineering-focused automation.
 */
export class CronScheduler {
  private readonly configPath: string
  private jobs: CronJob[] = []

  constructor(private readonly cwd: string) {
    this.configPath = path.join(resolveDataRootDir(cwd), 'cron-config.json')
    this.initDefaultJobs()
  }

  private initDefaultJobs() {
    this.jobs = [
      {
        id: 'repo-audit',
        name: 'Daily Repository Audit',
        schedule: 'daily',
        task: async (cwd) => this.runRepoAudit(cwd)
      }
    ]
  }

  async getSettings(): Promise<CronSchedulerSettings> {
    await ensureDir(path.dirname(this.configPath))
    if (!(await pathExists(this.configPath))) {
      return { enabled: true, lastRun: {} }
    }
    try {
      return normalizeCronSettings(JSON.parse(await readFile(this.configPath, 'utf8')))
    } catch {
      return { enabled: true, lastRun: {} }
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const settings = await this.getSettings()
    await ensureDir(path.dirname(this.configPath))
    await writeFile(
      this.configPath,
      JSON.stringify({ ...settings, enabled }, null, 2),
      'utf8',
    )
  }

  getJobs(): CronJob[] {
    return [...this.jobs]
  }

  private async runRepoAudit(cwd: string): Promise<string> {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { readdir, stat } = await import('node:fs/promises')
    const execFileAsync = promisify(execFile)

    try {
      let diffText = ''

      // 1. Try Git Log first
      const diffResult = await execFileAsync('git', ['log', '--since=24 hours ago', '--patch', '--max-count=50', '--no-merges'], { cwd }).catch(() => ({ stdout: '' }))
      diffText = diffResult.stdout.trim()

      // 2. Vibe-Coder Fallback: Native MTime Check if Git fails or is uninitialized
      if (!diffText) {
        let recentFiles: string[] = []
        const cutoff = Date.now() - 24 * 60 * 60 * 1000
        
        const walkDir = async (currentDir: string) => {
          if (recentFiles.length > 80) return // Cap output length safely
          const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => [])
          for (const entry of entries) {
            if (['node_modules', '.git', '.artemis', 'dist', 'build', '.next'].includes(entry.name)) continue
            const fullPath = path.join(currentDir, entry.name)
            if (entry.isDirectory()) {
              await walkDir(fullPath)
            } else if (entry.isFile()) {
              const fileStat = await stat(fullPath).catch(() => null)
              if (fileStat && fileStat.mtimeMs > cutoff) {
                // Return relative paths to save context window tokens
                recentFiles.push(path.relative(cwd, fullPath) || entry.name)
              }
            }
          }
        }
        await walkDir(cwd)
        if (recentFiles.length > 0) {
          diffText = `[Vibe Fallback: File modifications detected without Git]\nFollowing files modified in the last 24h:\n- ${recentFiles.join('\n- ')}`
        }
      }

      if (!diffText) {
        return 'No code changes detected in the last 24 hours. Daily summary bypassed to save API quotas.'
      }

      // 3. Ultra-Low Token Secretary Summarizer Pipeline
      const prompt = `\
你是一个友好的清晨项目助手/传话简书。请基于过去24小时的代码变动（或被修改的文件记录），给用户做一段 50 字以内、简练但带有正向情绪价值的早安总结早报。
绝对不要做代码审查、不要挑错、不要提及潜在风险。只要大概概括“昨天主要推进了什么模块/动了什么主要文件”即可。

记录片段如下：
\`\`\`
${diffText.slice(0, 16000)}
\`\`\``

      const { summarizeOnce } = await import('../brain.js')
      // Fallback if AI summary fails, so cron doesn't stall purely due to API
      // drops. Log to stderr so the failure is visible in cron logs.
      const reply = await summarizeOnce(prompt).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[cron] summarizeOnce failed in code-changes job: ${msg}`)
        return `[系统传声筒] 过去24小时内系统代码有变化，但摘要分析暂不可用：${msg}`
      })

      return reply
    } catch (err) {
      return `Push notification failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async checkAndRun(): Promise<boolean> {
    const settings = await this.getSettings()
    if (!settings.enabled) return false
    const state = { ...settings.lastRun }

    const now = new Date()
    let changed = false

    for (const job of this.jobs) {
      const lastRun = state[job.id] ? new Date(state[job.id]) : new Date(0)
      const diffMs = now.getTime() - lastRun.getTime()
      
      let shouldRun = false
      if (job.schedule === 'daily' && diffMs > 24 * 60 * 60 * 1000) shouldRun = true
      if (job.schedule === 'hourly' && diffMs > 60 * 60 * 1000) shouldRun = true

      if (shouldRun) {
        const report = await job.task(this.cwd)
        state[job.id] = now.toISOString()
        changed = true
        // In a real scenario, this would be pushed to Telegram/Discord via Bragi
        // For now, we save it to a report file
        const reportDir = path.join(resolveDataRootDir(this.cwd), 'reports')
        await ensureDir(reportDir)
        const reportPath = path.join(reportDir, `${job.id}-${now.toISOString().slice(0,10)}.md`)
        const reportContent = `# ${job.name} - ${now.toISOString()}\n\n${report}`
        await writeFile(reportPath, reportContent, 'utf8')

        // Send outbound notification to Bragi bridges. Log failure so user
        // can spot misconfigured channels in cron logs (was silent before).
        try {
          const { sendBragiBroadcast } = await import('../bragi/outbound.js')
          await sendBragiBroadcast(this.cwd, `[系统自动化报表]\n${job.name}\n\n${report}`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[cron] Bragi broadcast failed for "${job.name}": ${msg}`)
        }
      }
    }

    if (changed) {
      await writeFile(this.configPath, JSON.stringify({ ...settings, lastRun: state }, null, 2), 'utf8')
    }
    return changed
  }
}
