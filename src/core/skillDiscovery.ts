import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillDefinition } from './skillManager.js'
import { SkillManager } from './skillManager.js'

export interface SkillUsageSummary {
  id: string
  name: string
  category: string
  description: string
  executable: boolean
  reason: string
}

export interface SkillRecommendation extends SkillUsageSummary {
  score: number
}

export interface SkillDetail extends SkillUsageSummary {
  path?: string
  usage: string[]
  preview: string[]
}

const SKILL_SYNONYMS: Array<[string, string[]]> = [
  ['无障碍', ['accessibility', 'a11y', 'wcag']],
  ['可访问', ['accessibility', 'a11y']],
  ['审计', ['audit', 'review']],
  ['检查', ['audit', 'check', 'review']],
  ['修复', ['fix', 'repair', 'remediation']],
  ['搜索引擎', ['seo', 'search']],
  ['性能', ['performance', 'perf']],
  ['安全', ['security', 'audit']],
  ['部署', ['deploy', 'deployment']],
  ['设计', ['design', 'ui', 'ux']],
  ['文案', ['copywriting', 'content']],
  ['测试', ['test', 'testing']],
  ['数据库', ['database', 'db']],
  ['接口', ['api']],
]

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'your', 'you', 'are', 'can',
  '帮我', '我要', '想要', '需要', '一个', '这个', '那个', '如何', '怎么', '一下', '进行', '处理',
])

function normalizeTokens(input: string): string[] {
  const lower = input.toLowerCase()
  const ascii = lower.match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []
  const cjk = input.match(/[\p{Script=Han}]{2,}/gu) ?? []
  const synonyms = SKILL_SYNONYMS.flatMap(([needle, mapped]) => input.includes(needle) ? mapped : [])
  return [...ascii, ...cjk, ...synonyms].filter(token => !STOP_WORDS.has(token))
}

function summarizeSkill(skill: SkillDefinition, rawConfig?: any): SkillUsageSummary {
  const toolChain = Array.isArray(rawConfig?.toolChain) ? rawConfig.toolChain : []
  const executable = skill.entryPoint === 'javascript'
    ? Boolean(rawConfig?.code)
    : skill.entryPoint === 'tool_chain'
      ? toolChain.length > 0
      : skill.entryPoint === 'shell'
        ? Boolean(rawConfig?.script)
        : false
  return {
    id: skill.id,
    name: skill.name,
    category: (skill.category ?? 'general').toLowerCase(),
    description: skill.description ?? '',
    executable,
    reason: executable ? 'executable' : 'instructional',
  }
}

async function findSkillsDir(cwd: string): Promise<string | undefined> {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills'),
    path.resolve(cwd, 'skills'),
    path.resolve(process.cwd(), 'skills'),
  ]
  return candidates.find(candidate => fs.existsSync(candidate))
}

export async function loadSkillDiscovery(cwd: string): Promise<{
  manager: SkillManager
  skills: SkillUsageSummary[]
  rawById: Map<string, any>
  skillsDir?: string
}> {
  const manager = new SkillManager()
  await manager.ready()
  const rawById = new Map<string, any>()
  const skillsDir = await findSkillsDir(cwd)
  if (skillsDir) {
    const entries = await fsp.readdir(skillsDir, { withFileTypes: true })
    await Promise.all(entries.filter(e => e.isDirectory()).map(async entry => {
      const jsonPath = path.join(skillsDir, entry.name, 'SKILL.json')
      try {
        const raw = JSON.parse(await fsp.readFile(jsonPath, 'utf8'))
        if (raw?.id) rawById.set(raw.id, raw)
      } catch {
        // SKILL.md-only skills are still usable as instructional skills.
      }
    }))
  }
  const skills = manager.getAllSkillDefinitions().map(skill => summarizeSkill(skill, rawById.get(skill.id)))
  return { manager, skills, rawById, skillsDir }
}

export function recommendSkills(skills: SkillUsageSummary[], intent: string, limit = 12): SkillRecommendation[] {
  const tokens = normalizeTokens(intent)
  if (tokens.length === 0) return []
  return skills.map(skill => {
    const haystack = [skill.id, skill.name, skill.category, skill.description].join(' ').toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (skill.id.toLowerCase().includes(token)) score += 8
      if (skill.name.toLowerCase().includes(token)) score += 6
      if (skill.category.toLowerCase().includes(token)) score += 3
      if (haystack.includes(token)) score += 2
    }
    if (skill.executable) score += 1
    return { ...skill, score }
  }).filter(skill => skill.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
}

export function groupSkillsByCategory(skills: SkillUsageSummary[]): Array<{ category: string; count: number; examples: SkillUsageSummary[] }> {
  const grouped = new Map<string, SkillUsageSummary[]>()
  for (const skill of skills) {
    const items = grouped.get(skill.category) ?? []
    items.push(skill)
    grouped.set(skill.category, items)
  }
  return [...grouped.entries()]
    .map(([category, items]) => ({ category, count: items.length, examples: items.slice(0, 5) }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
}

function extractUsageLines(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/)
  const usage: string[] = []
  let inCode = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode && (/^(\/|artemis\s|npm\s|pnpm\s|python\s|node\s|npx\s|bun\s)/.test(trimmed))) usage.push(trimmed)
    if (!inCode && /^(\/[-\w]+|artemis\s)/.test(trimmed)) usage.push(trimmed)
    if (usage.length >= 8) break
  }
  return usage
}

export async function getSkillDetail(cwd: string, idOrName: string): Promise<SkillDetail | undefined> {
  const { manager, rawById, skillsDir } = await loadSkillDiscovery(cwd)
  const needle = idOrName.toLowerCase()
  const skill = manager.getAllSkillDefinitions().find(candidate =>
    candidate.id.toLowerCase() === needle || candidate.name.toLowerCase() === needle,
  )
  if (!skill) return undefined
  const summary = summarizeSkill(skill, rawById.get(skill.id))
  const mdPath = skillsDir ? path.join(skillsDir, skill.id, 'SKILL.md') : undefined
  let usage: string[] = []
  let preview: string[] = []
  if (mdPath && fs.existsSync(mdPath)) {
    const markdown = await fsp.readFile(mdPath, 'utf8')
    usage = extractUsageLines(markdown)
    let inFrontmatter = false
    preview = markdown.split(/\r?\n/).filter((line, index) => {
      if (index === 0 && line.trim() === '---') {
        inFrontmatter = true
        return false
      }
      if (inFrontmatter && line.trim() === '---') {
        inFrontmatter = false
        return false
      }
      return !inFrontmatter && line.trim()
    }).slice(0, 16)
  }
  return { ...summary, path: mdPath, usage, preview }
}
