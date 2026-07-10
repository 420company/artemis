/**
 * services/goalRunner.ts — long-horizon autonomous goals (Artemis Goal Mode)
 *
 * A goal is a persistent objective the agent keeps advancing across sessions,
 * restarts, and days. The design borrows the long-task pattern from harness
 * agents: STATE LIVES IN THE GOAL FILE, NOT THE CONTEXT. Every tick spawns a
 * fresh headless agent session that reads the goal + progress log, advances
 * ONE concrete step with full tool access, then reports back via strict
 * marker lines that we parse and persist:
 *
 *   GOAL_STATUS: continue | done | blocked
 *   GOAL_PROGRESS: <what this step accomplished>
 *   GOAL_NEXT: <the next concrete step>
 *
 * Ticks can run in a foreground loop (`artemis goal run`) or ride the cron
 * scheduler for goals flagged autoTick — the "keeps working while you sleep"
 * mode.
 */

import path from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { resolveDataRootDir, ensureDir } from '../utils/fs.js'

export type GoalStatus = 'active' | 'paused' | 'done' | 'blocked'

export interface GoalIteration {
  at: string
  status: 'continue' | 'done' | 'blocked'
  progress: string
  next: string
  turns: number
}

export interface GoalRecord {
  id: string
  title: string
  goal: string
  status: GoalStatus
  autoTick: boolean
  maxIterations: number
  createdAt: string
  updatedAt: string
  iterations: GoalIteration[]
  statusReason?: string
}

const MAX_PROMPT_ITERATIONS = 10
const DEFAULT_MAX_ITERATIONS = 50
const TICK_MAX_TURNS = 60

export class GoalStore {
  private readonly filePath: string

  constructor(cwd: string) {
    this.filePath = path.join(resolveDataRootDir(cwd), 'goals.json')
  }

  async load(): Promise<GoalRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async save(goals: GoalRecord[]): Promise<void> {
    await ensureDir(path.dirname(this.filePath))
    const tmp = `${this.filePath}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(goals, null, 2), 'utf8')
    await rename(tmp, this.filePath)
  }

  async add(goalText: string, opts: { title?: string; autoTick?: boolean; maxIterations?: number } = {}): Promise<GoalRecord> {
    const goals = await this.load()
    const now = new Date().toISOString()
    const record: GoalRecord = {
      id: `g${Date.now().toString(36)}`,
      title: (opts.title ?? goalText).slice(0, 80),
      goal: goalText,
      status: 'active',
      autoTick: opts.autoTick ?? false,
      maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      createdAt: now,
      updatedAt: now,
      iterations: [],
    }
    goals.push(record)
    await this.save(goals)
    return record
  }

  async get(id: string): Promise<GoalRecord | undefined> {
    const goals = await this.load()
    return goals.find((g) => g.id === id || g.id === `g${id}`)
  }

  async update(record: GoalRecord): Promise<void> {
    const goals = await this.load()
    const idx = goals.findIndex((g) => g.id === record.id)
    if (idx === -1) return
    goals[idx] = { ...record, updatedAt: new Date().toISOString() }
    await this.save(goals)
  }

  async remove(id: string): Promise<boolean> {
    const goals = await this.load()
    const next = goals.filter((g) => g.id !== id && g.id !== `g${id}`)
    if (next.length === goals.length) return false
    await this.save(next)
    return true
  }
}

// ── tick prompt / reply protocol ────────────────────────────────────────────

export function buildTickPrompt(goal: GoalRecord): string {
  const recent = goal.iterations.slice(-MAX_PROMPT_ITERATIONS)
  const progressLog = recent.length
    ? recent
        .map((it, i) => `${goal.iterations.length - recent.length + i + 1}. [${it.at.slice(0, 16)}] ${it.progress}${it.next ? `\n   下一步计划: ${it.next}` : ''}`)
        .join('\n')
    : '（还没有任何进展，这是第一步）'

  return `\
你正在推进一个长期目标（Goal Mode 第 ${goal.iterations.length + 1} 次迭代）。

【目标】
${goal.goal}

【已有进展】
${progressLog}

【本次任务】
用工具实际推进一步——优先做「下一步计划」里的事，除非现场检查后发现更该做别的。原则：
- 一次只推进一个具体的、可验证的步骤，别贪多。
- 先验证上次进展是否真实生效（文件在不在、命令过不过），再往下走。
- 遇到只有用户能解决的事（要密码、要付款、要决策），停下来标记 blocked。
- 目标已经完成就标记 done，不要为了继续而继续。

【收尾格式】回复的最后必须是这三行（严格照抄格式）：
GOAL_STATUS: continue | done | blocked 三选一
GOAL_PROGRESS: 这一步实际完成了什么（一句话，要具体）
GOAL_NEXT: 下一步该做什么（done 时写"无"）`
}

export function parseTickReply(reply: string): { status: 'continue' | 'done' | 'blocked'; progress: string; next: string } {
  const pick = (marker: string): string => {
    const match = reply.match(new RegExp(`${marker}:\\s*(.+)`, 'i'))
    return match ? match[1].trim() : ''
  }
  const rawStatus = pick('GOAL_STATUS').toLowerCase()
  const status = rawStatus.includes('done') ? 'done' : rawStatus.includes('block') ? 'blocked' : 'continue'
  const progress = pick('GOAL_PROGRESS') || reply.trim().split('\n').pop()?.slice(0, 200) || '(无进展摘要)'
  const next = pick('GOAL_NEXT')
  return { status, progress: progress.slice(0, 300), next: next.slice(0, 300) }
}

// ── tick execution ──────────────────────────────────────────────────────────

export interface TickResult {
  iteration: GoalIteration
  goalStatus: GoalStatus
  reply: string
}

/**
 * Advance a goal by one iteration in a fresh headless agent session
 * (PRODUCER permissions, full tool access). State continuity comes from the
 * progress log embedded in the prompt, so context never grows unbounded.
 */
export async function runGoalTick(
  cwd: string,
  goal: GoalRecord,
  opts: { onInfo?: (message: string) => void } = {},
): Promise<TickResult> {
  const { resolveMainProviderConfig } = await import('../providers/onboarding.js')
  const { createTrackedProviderFromConfig } = await import('../providers/telemetry.js')
  const { createProviderRouter } = await import('../providers/router.js')
  const { PermissionManager } = await import('../security/permissions.js')
  const { SessionStore } = await import('../storage/sessions.js')
  const { runAgent } = await import('../core/agent.js')

  const providerConfig = await resolveMainProviderConfig({
    cwd,
    config: {},
    onInfo: opts.onInfo ?? (() => undefined),
  })
  const provider = createTrackedProviderFromConfig(providerConfig, { cwd })
  const permissionManager = new PermissionManager('PRODUCER', false)
  const providerRouter = await createProviderRouter({
    cwd,
    mainProvider: provider,
    onInfo: opts.onInfo ?? (() => undefined),
  })
  const sessionStore = new SessionStore(cwd)
  const session = sessionStore.createSession({
    title: `Goal ${goal.id}: ${goal.title.slice(0, 40)} · tick ${goal.iterations.length + 1}`,
  })

  const result = await runAgent(session, buildTickPrompt(goal), {
    cwd,
    provider,
    sessionStore,
    permissionManager,
    maxTurns: TICK_MAX_TURNS,
    profile: 'main',
    appendUserMessage: true,
    ensureSpecialistProvider: providerRouter.ensureSpecialistProvider,
    resolveProvider: providerRouter.resolveProvider,
    onInfo: opts.onInfo,
  })

  const parsed = parseTickReply(result.reply)
  const iteration: GoalIteration = {
    at: new Date().toISOString(),
    status: parsed.status,
    progress: parsed.progress,
    next: parsed.next,
    turns: result.turns,
  }

  goal.iterations.push(iteration)
  let goalStatus: GoalStatus = goal.status
  if (parsed.status === 'done') {
    goalStatus = 'done'
    goal.statusReason = parsed.progress
  } else if (parsed.status === 'blocked') {
    goalStatus = 'blocked'
    goal.statusReason = parsed.next || parsed.progress
  } else if (goal.iterations.length >= goal.maxIterations) {
    goalStatus = 'paused'
    goal.statusReason = `达到迭代上限 ${goal.maxIterations}，自动暂停（resume 可继续）`
  }
  goal.status = goalStatus

  return { iteration, goalStatus, reply: result.reply }
}

/** Run consecutive ticks until done/blocked/paused or the tick budget runs out. */
export async function runGoalLoop(
  cwd: string,
  goalId: string,
  opts: {
    maxTicks?: number
    onTick?: (goal: GoalRecord, tick: TickResult) => void
    onInfo?: (message: string) => void
  } = {},
): Promise<GoalRecord> {
  const store = new GoalStore(cwd)
  const maxTicks = Math.max(1, Math.min(50, opts.maxTicks ?? 10))

  for (let i = 0; i < maxTicks; i++) {
    const goal = await store.get(goalId)
    if (!goal) throw new Error(`goal ${goalId} not found`)
    if (goal.status !== 'active') return goal

    const tick = await runGoalTick(cwd, goal, { onInfo: opts.onInfo })
    await store.update(goal)
    opts.onTick?.(goal, tick)
    if (goal.status !== 'active') return goal
  }

  const final = await new GoalStore(cwd).get(goalId)
  if (!final) throw new Error(`goal ${goalId} not found`)
  return final
}

/** Cron hook: advance every active autoTick goal by one iteration. */
export async function runAutoTickGoals(cwd: string): Promise<string> {
  const store = new GoalStore(cwd)
  const goals = await store.load()
  const eligible = goals.filter((g) => g.status === 'active' && g.autoTick)
  if (eligible.length === 0) return 'no auto-tick goals'

  const lines: string[] = []
  for (const goal of eligible) {
    try {
      const tick = await runGoalTick(cwd, goal, {})
      await store.update(goal)
      lines.push(`[${goal.id}] ${goal.title}: ${tick.iteration.progress} (→ ${goal.status})`)
    } catch (err) {
      lines.push(`[${goal.id}] tick failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return lines.join('\n')
}
