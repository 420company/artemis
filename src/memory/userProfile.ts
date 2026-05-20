/**
 * memory/userProfile.ts — persistent user profile memory (user.md)
 *
 * Analogous to Hermes Agent's USER.md.
 * Stores user identity, preferences, and habits in ~/.artemis/user.md.
 * Injected as a frozen snapshot into the system prompt at session start.
 * Auto-updated at session end via LLM inference.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolveArtemisHomeDir } from '../utils/fs.js'
import { join } from 'node:path'

const PROFILE_PATH = join(resolveArtemisHomeDir(), 'user.md')
const PROFILE_MAX_CHARS = 2_400  // ~600 tokens — keep it lean

export async function loadUserProfile(): Promise<string> {
  try {
    const text = await readFile(PROFILE_PATH, 'utf8')
    return text.trim()
  } catch {
    return ''
  }
}

export async function saveUserProfile(content: string): Promise<void> {
  await mkdir(resolveArtemisHomeDir(), { recursive: true })
  await writeFile(PROFILE_PATH, content.slice(0, PROFILE_MAX_CHARS).trimEnd() + '\n', 'utf8')
}

/** Format user profile for injection into the system prompt. */
export function formatProfileForPrompt(profile: string): string {
  if (!profile.trim()) return ''
  return `\n\n---\n# 用户档案 (User Profile)\n\n${profile.trim()}`
}

export type SummarizeFn = (prompt: string) => Promise<string>

/**
 * Auto-update user profile based on recent conversation.
 *
 * Only updates if conversation has enough signal (>= minMessages pairs).
 * Returns updated profile text WITHOUT saving — caller decides when to persist.
 */
export async function autoUpdateUserProfile(opts: {
  recentMessages: Array<{ role: string; content: string }>
  existingProfile: string
  summarize: SummarizeFn
  minMessages?: number
}): Promise<string | null> {
  const { recentMessages, existingProfile, summarize, minMessages = 4 } = opts

  // Only update if there's enough conversation signal
  const userMsgs = recentMessages.filter(m => m.role === 'user')
  if (userMsgs.length < minMessages) return null

  const snippet = recentMessages
    .slice(-20)  // last 20 messages
    .map(m => `[${m.role}] ${m.content.slice(0, 300)}`)
    .join('\n')

  const prompt = `\
你是一个分析助手。请根据以下对话，更新用户档案，只记录有价值的长期信息。

${existingProfile ? `现有用户档案：\n${existingProfile}\n\n` : '（暂无现有档案）\n\n'}最近对话（节选）：
${snippet}

请输出更新后的用户档案（Markdown 格式，最多 400 字）。只记录以下类型的信息（如果可从对话中可靠推断）：
- 用户的角色/职业/背景
- 技术栈偏好（语言、框架、工具）
- 工作风格/习惯
- 沟通偏好（简洁/详细，中文/英文等）
- 其他值得跨会话记住的偏好

规则：
- 如果没有新信息，原样返回现有档案
- 不要编造或推测不确定的信息
- 只输出档案内容，不要解释`

  try {
    const result = await summarize(prompt)
    const trimmed = result.trim()
    if (!trimmed) return null
    return trimmed.slice(0, PROFILE_MAX_CHARS)
  } catch {
    return null
  }
}
