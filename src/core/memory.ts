import type { SessionRecord } from './types.js'
import { summarizeOnce } from '../brain.js'
import { getMemoryProfile, MemoryEnhancementFactory } from './memoryEnhancement.js'
import {
  ensureMemoryMigrated,
  loadIndexText,
  saveMemory,
  trashMemory,
  scopesCollide,
  type MemoryScope,
} from '../storage/memoryFiles.js'

/**
 * Background memory curator (Mnemosyne v2).
 *
 * At session end, the model reads the conversation trajectory PLUS the current
 * memory indexes and emits an operation list — add / update / delete / skip —
 * instead of blindly appending. Semantic duplicates become updates, memories
 * contradicted by this session get deleted (to .trash), and facts already
 * recorded in the repo are skipped. Hard limits live in storage/memoryFiles.ts.
 */

type CuratorOp = {
  op?: string
  scope?: string
  name?: string
  description?: string
  category?: string
  content?: string
  reason?: string
}

export async function compressTrajectory(
  cwd: string,
  session: SessionRecord,
  _finalReply: string
): Promise<void> {
  try {
    const msgs = session.messages.filter(m => m.role === 'user' || m.role === 'assistant')
    if (msgs.length <= 1) return // Too short to have meaningful trajectory habits

    const transcript = msgs
      .map(m => `[${m.role.toUpperCase()}]: ${m.content || '<multi-modal action>'}`)
      .join('\n')

    await ensureMemoryMigrated(cwd)
    const collided = scopesCollide(cwd)
    const globalIndex = await loadIndexText(cwd, 'global')
    const projectIndex = collided ? '' : await loadIndexText(cwd, 'project')

    const prompt = `\
你是长期记忆策展器 (Memory Curator)。阅读对话轨迹，对照现有记忆索引，输出一组记忆操作。

现有全局记忆索引（跨项目偏好/用户身份）：
${globalIndex || '（空）'}

现有项目记忆索引（仅本项目的事实/约束/进展）：
${collided ? '（与全局同目录，统一写 global）' : (projectIndex || '（空）')}

规则：
- 只沉淀有长期复用价值的信息：用户偏好、明确反馈、工程约束、项目关键事实。一般性问答输出 []。
- 存之前先查索引：已有条目覆盖同一主题 → 用 update 更新该条目（name 用索引里的名字），不要新建重复条目。
- 本次对话推翻了某条现有记忆 → 对它输出 delete 并给 reason。
- 代码库/文档本身就能查到的信息不要存（skip）。
- 跨项目通用的写 scope "global"，仅本项目有效的写 scope "project"。
- 相对日期一律转成绝对日期。
- content 用 Markdown，尽量附一行 **Why:** 和 **How to apply:**，不超过 600 字。
- description 是一句话钩子，召回全靠它，必须具体。
- name 用短横线小写 slug（如 css-vanilla-only）。

严格输出 JSON 数组（可为空），不要输出其他文字：
[
  {"op": "add", "scope": "global", "name": "css-vanilla-only", "category": "preference", "description": "CSS 必须 Vanilla，禁 Tailwind", "content": "..."},
  {"op": "update", "scope": "project", "name": "existing-name", "description": "...", "content": "..."},
  {"op": "delete", "scope": "global", "name": "old-wrong", "reason": "用户已推翻"}
]
category 可选值：preference | feedback | project | reference | skill | architecture

对话轨迹：
\`\`\`
${transcript.slice(-24000)}
\`\`\``

    const rawExtraction = await summarizeOnce(prompt)
    const match = rawExtraction.match(/\[\s*(?:\{[\s\S]*\}\s*)?\]/m)
    if (!match) return

    let ops: CuratorOp[] = []
    try {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed)) ops = parsed
    } catch {
      return
    }
    if (ops.length === 0) return

    const applied: Array<{ content: string; category: string }> = []
    for (const op of ops.slice(0, 12)) {
      const scope: MemoryScope = collided ? 'global' : (op.scope === 'project' ? 'project' : 'global')
      const name = String(op.name ?? '').trim()
      if (!name) continue

      if (op.op === 'delete') {
        await trashMemory(cwd, scope, name)
        continue
      }
      if (op.op !== 'add' && op.op !== 'update') continue

      const content = String(op.content ?? '').trim()
      if (!content) continue
      const result = await saveMemory(cwd, scope, {
        name,
        description: String(op.description ?? '').trim() || content.slice(0, 100),
        category: op.category,
        content,
        source: 'trajectory-curator',
      })
      if (result.ok) applied.push({ content, category: String(op.category ?? 'preference') })
    }

    // Mirror applied writes into the optional RAG layer for semantic recall.
    if (applied.length > 0) {
      const profile = await getMemoryProfile(cwd)
      if (profile.enabled) {
        const memory = await MemoryEnhancementFactory.create(profile, cwd)
        await memory.initialize()
        for (const insight of applied) {
          await memory.addMemory(insight.content, {
            category: insight.category,
            source: 'trajectory-curator',
          })
        }
      }
    }
  } catch {
    // Passive background routine — must never crash the user terminal.
  }
}
