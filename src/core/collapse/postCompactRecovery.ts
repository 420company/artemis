/**
 * collapse/postCompactRecovery.ts — Restore critical context after compaction
 *
 * When contextCompressor runs, it replaces old messages with a summary.
 * But the model loses:
 *   - What files it has read / modified
 *   - What plan it was following
 *   - What tools / MCP servers are available
 *   - What skills / instructions were loaded
 *
 * This module reconstructs "attachment messages" that re-inject those
 * essentials, so the model can continue without "失忆" or "串台".
 *
 * Design follows ClaudeCode's compact → attachment pipeline:
 *   compact.ts:541-585 re-attaches files, plan, tools, MCP, skills
 */

import type { SessionMessage } from '../types.js'
import type { CollapseLedger, FileStateSnapshot, PlanSnapshot } from './ledger.js'
import { loadFileArtifact } from './ledger.js'

// ─── Constants ──────────────────────────────────────────────────────

const MAX_FILES_TO_RESTORE = 8
const FILE_SNIPPET_CHARS = 600
const PLAN_MAX_CHARS = 2_000
const TOOLS_SNIPPET_MAX = 2_000

// ─── Build recovery messages ───────────────────────────────────────

/**
 * Given the current ledger state, build SessionMessage[] that
 * should be appended after the compression summary so the model
 * has essential context to continue working.
 */
export async function buildPostCompactRecoveryMessages(
  ledger: CollapseLedger,
  options?: {
    /** Current file states (freshly read) — used to detect changes since collapse */
    currentFileStates?: FileStateSnapshot[]
    /** Whether we're in a plan mode */
    planMode?: boolean
  },
): Promise<SessionMessage[]> {
  const now = new Date().toISOString()
  const messages: SessionMessage[] = []
  const sections: string[] = []

  // 1. Restore file states
  const fileSection = await buildFileStateSection(ledger, options?.currentFileStates)
  if (fileSection) {
    sections.push(fileSection)
  }

  // 2. Restore plan
  const planSection = buildPlanSection(ledger.planSnapshot)
  if (planSection) {
    sections.push(planSection)
  }

  // 3. Restore tool / MCP context
  const toolSection = buildToolContextSection(ledger)
  if (toolSection) {
    sections.push(toolSection)
  }

  // 4. Restore skill context
  const skillSection = buildSkillSection(ledger)
  if (skillSection) {
    sections.push(skillSection)
  }

  if (sections.length === 0) return messages

  // Create a single recovery message so it doesn't flood the conversation
  const recoveryContent = [
    '═══ 压缩后上下文恢复 ═══',
    '以下是从上次压缩中恢复的关键上下文，确保你可以无缝继续工作：',
    '',
    ...sections,
    '═══ 恢复内容结束 ═══',
  ].join('\n')

  messages.push({
    id: `recovery-${Date.now()}`,
    role: 'user',
    content: recoveryContent,
    createdAt: now,
  })

  return messages
}

// ─── File state section ─────────────────────────────────────────────

async function buildFileStateSection(
  ledger: CollapseLedger,
  currentFileStates?: FileStateSnapshot[],
): Promise<string | null> {
  const snapshots = ledger.fileStates.slice(0, MAX_FILES_TO_RESTORE)
  if (snapshots.length === 0) return null

  const lines: string[] = ['📂 已读取文件状态：']
  const currentMap = new Map(
    (currentFileStates ?? []).map(fs => [fs.filePath, fs]),
  )

  for (const fs of snapshots) {
    const current = currentMap.get(fs.filePath)
    const changed = current && current.contentHash !== fs.contentHash
    const statusTag = changed ? ' ⚠️ 已变更' : ''
    const shortPath = fs.filePath.split('/').slice(-2).join('/')

    let snippet: string
    if (fs.artifactPath) {
      const full = await loadFileArtifact(fs.artifactPath)
      snippet = full
        ? full.slice(0, FILE_SNIPPET_CHARS) + (full.length > FILE_SNIPPET_CHARS ? '\n  ...[truncated]' : '')
        : fs.headContent
    } else {
      snippet = fs.headContent
    }

    lines.push(`  ${shortPath}${statusTag}`)
    lines.push(`    ${snippet.split('\n').slice(0, 8).join('\n    ')}`)
  }

  return lines.join('\n')
}

// ─── Plan section ───────────────────────────────────────────────────

function buildPlanSection(plan?: PlanSnapshot): string | null {
  if (!plan) return null
  const truncated = plan.content.length > PLAN_MAX_CHARS
    ? plan.content.slice(0, PLAN_MAX_CHARS) + '\n...[plan truncated]'
    : plan.content
  return `📋 当前计划 (status: ${plan.status}):\n${truncated}`
}

// ─── Tool / MCP context section ─────────────────────────────────────

function buildToolContextSection(ledger: CollapseLedger): string | null {
  const parts: string[] = []

  if (ledger.activeTools.length > 0) {
    const toolList = ledger.activeTools.slice(0, 40).join(', ')
    parts.push(`🔧 可用工具：${toolList.length > TOOLS_SNIPPET_MAX ? toolList.slice(0, TOOLS_SNIPPET_MAX) + '...' : toolList}`)
  }

  if (ledger.activeMcpServers.length > 0) {
    parts.push(`🔌 已连接 MCP 服务：${ledger.activeMcpServers.join(', ')}`)
  }

  return parts.length > 0 ? parts.join('\n') : null
}

// ─── Skill section ─────────────────────────────────────────────────

function buildSkillSection(ledger: CollapseLedger): string | null {
  if (ledger.activeSkills.length === 0) return null
  return `🧠 已加载技能：${ledger.activeSkills.join(', ')}`
}

// ─── Session cleanup ────────────────────────────────────────────────

/**
 * Called when a session ends. Clears the ledger from memory
 * but preserves it on disk for potential session restore.
 */
export function prepareForSessionRestore(
  ledger: CollapseLedger,
): Record<string, unknown> {
  return {
    collapseEntryCount: ledger.entries.length,
    lastCollapseAt: ledger.entries.at(-1)?.collapsedAt,
    fileStatesCount: ledger.fileStates.length,
    hasPlan: !!ledger.planSnapshot,
    activeTools: ledger.activeTools,
    activeMcpServers: ledger.activeMcpServers,
  }
}
