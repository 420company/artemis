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
import type { CollapseLedger, FileStateSnapshot } from './ledger.js'
import { loadFileArtifact } from './ledger.js'

// ─── Constants ──────────────────────────────────────────────────────

const MAX_FILES_TO_RESTORE = 8
// Tiered file snippet budgets — most-recent reads get full content so the
// model can actually act on them after compaction; older reads degrade to
// short hints. Old behavior gave every file 600 chars × 8 lines which was
// useless for any non-trivial file the model needed to edit.
const RECENT_FILES_FULL_CONTENT     = 3       // first N files get full content
const RECENT_FILES_MEDIUM           = 5       // first M files get medium content
const FILE_SNIPPET_CHARS_FULL       = 12_000
const FILE_SNIPPET_CHARS_MEDIUM     = 4_000
const FILE_SNIPPET_CHARS_OLD        = 600
const FILE_SNIPPET_LINES_FULL       = 200
const FILE_SNIPPET_LINES_MEDIUM     = 30
const FILE_SNIPPET_LINES_OLD        = 8
const TOOLS_SNIPPET_MAX = 2_000

function snippetBudgetFor(idx: number): { chars: number; lines: number } {
  if (idx < RECENT_FILES_FULL_CONTENT) return { chars: FILE_SNIPPET_CHARS_FULL, lines: FILE_SNIPPET_LINES_FULL }
  if (idx < RECENT_FILES_MEDIUM)       return { chars: FILE_SNIPPET_CHARS_MEDIUM, lines: FILE_SNIPPET_LINES_MEDIUM }
  return { chars: FILE_SNIPPET_CHARS_OLD, lines: FILE_SNIPPET_LINES_OLD }
}

// ─── Build recovery messages ───────────────────────────────────────

/**
 * Pending in-flight action — typically the last assistant text the model
 * emitted before compression. Preserving it verbatim means the model wakes
 * up knowing "what was I about to do" without needing to re-derive it from
 * tool history (which is what caused the rumination loop bug).
 *
 * v2 also carries a structured `lastTool` signal so that even when the
 * assistant's commentary is vague ("继续插入函数"), recovery still surfaces
 * the concrete tool + target the model was operating on.
 */
export interface PendingActionIntent {
  /** Verbatim assistant text — usually 1-2 sentences of intent */
  text: string
  /** When this was captured */
  capturedAt: string
  /** Structured signal about the last tool the model invoked */
  lastTool?: {
    /** Tool name (e.g. 'Edit', 'write_file', 'Bash') */
    name: string
    /** Best-effort target hint: file path, first 100 chars of command, etc. */
    target?: string
    /**
     * Did we observe a matching tool_result in the conversation tail?
     *   - 'success'  : tool result returned, no error markers
     *   - 'failure'  : tool result returned with error / non-zero / failure markers
     *   - 'pending'  : tool_use captured but no matching tool_result yet
     */
    outcome: 'success' | 'failure' | 'pending'
  }
}

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
    /** Last assistant intent before compression — survives micro-compact */
    pendingAction?: PendingActionIntent
  },
): Promise<SessionMessage[]> {
  const now = new Date().toISOString()
  const messages: SessionMessage[] = []
  const sections: string[] = []

  // 0. Restore in-flight intent FIRST so model immediately sees "what was I doing"
  const pendingSection = buildPendingActionSection(options?.pendingAction)
  if (pendingSection) {
    sections.push(pendingSection)
  }

  // 1. Restore file states
  const fileSection = await buildFileStateSection(ledger, options?.currentFileStates)
  if (fileSection) {
    sections.push(fileSection)
  }

  // 2. Do NOT restore ledger.planSnapshot.
  // Historical bug: compression summaries were persisted as planSnapshot and
  // later re-injected as "current plan", causing cross-project/task drift
  // (e.g. artemix plans resurfacing during Artemis Code work). Until there is
  // a real explicit plan store with project/session freshness metadata, the
  // recovery layer must never revive old plans.

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

// ─── Pending action section ─────────────────────────────────────────

function buildPendingActionSection(pending?: PendingActionIntent): string | null {
  if (!pending) return null
  const hasText = pending.text && pending.text.trim().length >= 10
  if (!hasText && !pending.lastTool) return null
  const PENDING_MAX_CHARS = 1_500
  const lines: string[] = [
    `🎯 压缩前你的进行中状态（${pending.capturedAt}）——若该动作已完成或用户已改方向请忽略：`,
  ]
  if (pending.lastTool) {
    const t = pending.lastTool
    const outcomeIcon = t.outcome === 'success' ? '✅'
                      : t.outcome === 'failure' ? '❌'
                      : '⏳'
    const targetLine = t.target ? `（${t.target}）` : ''
    lines.push(`  ${outcomeIcon} 最近调用工具：${t.name}${targetLine}（结果：${t.outcome}）`)
  }
  if (hasText) {
    const text = pending.text.length > PENDING_MAX_CHARS
      ? pending.text.slice(0, PENDING_MAX_CHARS) + '\n...[已截断]'
      : pending.text
    lines.push('  你的原话：')
    lines.push(text.split('\n').map(l => `    ${l}`).join('\n'))
  }
  return lines.join('\n')
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

  for (let i = 0; i < snapshots.length; i++) {
    const fs = snapshots[i]!
    const { chars: charBudget, lines: lineBudget } = snippetBudgetFor(i)
    const current = currentMap.get(fs.filePath)
    const changed = current && current.contentHash !== fs.contentHash
    const statusTag = changed ? ' ⚠️ 已变更' : ''
    const shortPath = fs.filePath.split('/').slice(-2).join('/')
    const tierTag = i < RECENT_FILES_FULL_CONTENT ? ' [全文]'
                  : i < RECENT_FILES_MEDIUM ? ' [中段]'
                  : ' [摘要]'

    let snippet: string
    if (fs.artifactPath) {
      const full = await loadFileArtifact(fs.artifactPath)
      if (full) {
        snippet = full.length > charBudget
          ? full.slice(0, charBudget) + '\n  ...[已截断]'
          : full
      } else {
        snippet = fs.headContent
      }
    } else {
      snippet = fs.headContent
    }

    // Apply line cap independently from char cap — previously the hardcoded
    // .slice(0, 8) silently capped every file at 8 lines regardless of budget.
    const snippetLines = snippet.split('\n')
    const cappedSnippet = snippetLines.length > lineBudget
      ? snippetLines.slice(0, lineBudget).join('\n') + '\n  ...[行数已截断]'
      : snippetLines.join('\n')

    lines.push(`  ${shortPath}${statusTag}${tierTag}`)
    // Indent each line by 4 spaces for visual nesting
    lines.push(cappedSnippet.split('\n').map(l => `    ${l}`).join('\n'))
  }

  return lines.join('\n')
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
