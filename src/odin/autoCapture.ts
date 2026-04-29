/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * odin/autoCapture.ts — automatic skill capture after agentic tool loops
 *
 * When the assistant uses 5+ tools in a single turn, we automatically capture
 * the accomplishment as an Odin skill so the system "learns" from every
 * complex operation. This is the "auto-evolution" feature.
 */

import { randomUUID } from 'node:crypto'
import { OdinStore } from './store.js'
import type { SummarizeFn } from '../core/contextCompressor.js'

export interface ToolCallRecord {
  name: string
  args: Record<string, unknown>
  ok: boolean
}

const CAPTURE_PROMPT = (userInput: string, toolCalls: ToolCallRecord[]) => `\
你是一个大师级 AI 技能提炼专家。请分析以下 AI 操作过程，并将其提炼为一个高质量、可复用的技能资产。

用户请求：
${userInput.slice(0, 500)}

执行的工具序列（共 ${toolCalls.length} 次）：
${toolCalls.map((t, i) => `${i + 1}. ${t.name}(${summarizeArgs(t.args)}) → ${t.ok ? '✓' : '✗'}`).join('\n')}

请生成一个结构化的 JSON，包含以下字段：
{
  "name": "极简且具有专业感的技能名称（如：'React 性能瓶颈诊断', '跨模块权限重构'）",
  "summary": "一句话概括这个技能解决的核心问题",
  "tags": ["技术栈", "操作类型", "核心工具"],
  "principles": ["提炼出执行此类任务时的 3 条核心原则或最佳实践"],
  "markdown": "生成一份详细的 SKILL.md 内容，包含：# 技能名, ## 核心逻辑, ## 工具链路径, ## 避坑指南"
}
只返回 JSON 字符串。`

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).slice(0, 2)
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 30)}`).join(', ')
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/**
 * Auto-capture a skill from a completed agentic loop.
 * Fire-and-forget — caller should not await this.
 */
export async function autoCaptureSkill(opts: {
  userInput: string
  toolCalls: ToolCallRecord[]
  cwd: string
  summarize?: SummarizeFn
}): Promise<void> {
  const { userInput, toolCalls, cwd, summarize } = opts
  if (toolCalls.length < 5) return

  const store = new OdinStore(cwd)
  const now = new Date().toISOString()
  const slug = slugify(userInput || 'captured-skill')
  const id = `captured-${slug}-${Date.now()}`

  let name = userInput.slice(0, 40).trim() || 'Captured skill'
  let summary = `Auto-captured: ${toolCalls.map(t => t.name).join(', ')}`
  let tags = [...new Set(toolCalls.map(t => t.name))]
  let description = `Captured on ${now.slice(0, 10)}.\n\nTool sequence: ${toolCalls.map(t => t.name).join(' → ')}\n\nTriggered by: ${userInput.slice(0, 200)}`

  // Try LLM extraction if summarize is available
  if (summarize) {
    try {
      const prompt = CAPTURE_PROMPT(userInput, toolCalls)
      const raw = await summarize(prompt)
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { 
          name?: string; 
          summary?: string; 
          tags?: string[];
          principles?: string[];
          markdown?: string;
        }
        if (parsed.name) name = String(parsed.name).slice(0, 40)
        if (parsed.summary) summary = String(parsed.summary).slice(0, 120)
        if (Array.isArray(parsed.tags)) tags = parsed.tags.slice(0, 6).map(String)
        if (parsed.markdown) {
          description = parsed.markdown
          if (Array.isArray(parsed.principles)) {
            description += `\n\n## 核心原则\n${parsed.principles.map(p => `- ${p}`).join('\n')}`
          }
        }
      }
    } catch {
      // silent — use defaults
    }
  }

  await store.upsertSkill({
    id,
    name,
    summary,
    description,
    tags,
    source: 'captured',
    status: 'active',
    scope: 'local',
    confidence: 80, // Increased confidence for distilled skills
    readOnly: false,
    lineage: { parentSkillIds: [], captureQuery: userInput.slice(0, 100), revision: 0 },
    metadata: {
      toolCount: toolCalls.length,
      toolNames: toolCalls.map(t => t.name),
      capturedAt: now,
      isDistilled: true,
    },
  })

  // Record evolution event
  await store.recordEvolutionEvent({
    kind: 'auto-learn',
    outcome: 'success',
    skillIds: [id],
    summary: `Distilled high-quality skill "${name}" from ${toolCalls.length}-tool session`,
  })
}
