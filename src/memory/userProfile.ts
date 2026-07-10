/**
 * memory/userProfile.ts — persistent user profile memory
 *
 * Analogous to Hermes Agent's USER.md.
 * Lives at ~/.artemis/memory/user_profile.md (Mnemosyne v2 layout; the legacy
 * ~/.artemis/user.md is migrated on first read and kept as user.md.legacy).
 * Injected as a frozen snapshot into the system prompt at session start.
 * Auto-updated at session end via LLM inference — with guards: an update that
 * shrinks the profile >40% is rejected (hallucination protection), and the
 * previous version is rotated into .bak files before every overwrite.
 */

import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises'
import { resolveArtemisHomeDir } from '../utils/fs.js'
import { join } from 'node:path'

const PROFILE_DIR = join(resolveArtemisHomeDir(), 'memory')
const PROFILE_PATH = join(PROFILE_DIR, 'user_profile.md')
const LEGACY_PROFILE_PATH = join(resolveArtemisHomeDir(), 'user.md')
const PROFILE_MAX_CHARS = 2_400  // ~600 tokens — keep it lean
const PROFILE_BAK_COUNT = 3
const SHRINK_GUARD_MIN_CHARS = 200
const SHRINK_GUARD_RATIO = 0.6

async function readIfExists(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return ''
  }
}

/** One-time move of the legacy ~/.artemis/user.md into the memory dir. */
async function migrateLegacyProfile(): Promise<string> {
  const legacy = await readIfExists(LEGACY_PROFILE_PATH)
  if (!legacy) return ''
  try {
    await mkdir(PROFILE_DIR, { recursive: true })
    await writeFile(PROFILE_PATH, legacy + '\n', 'utf8')
    await rename(LEGACY_PROFILE_PATH, `${LEGACY_PROFILE_PATH}.legacy`)
  } catch { /* fall back to reading legacy in place next time */ }
  return legacy
}

export async function loadUserProfile(): Promise<string> {
  const current = await readIfExists(PROFILE_PATH)
  if (current) return current
  return migrateLegacyProfile()
}

async function rotateBackups(): Promise<void> {
  for (let i = PROFILE_BAK_COUNT - 1; i >= 1; i--) {
    try {
      await rename(`${PROFILE_PATH}.bak${i}`, `${PROFILE_PATH}.bak${i + 1}`)
    } catch { /* missing generation — fine */ }
  }
  try {
    await copyFile(PROFILE_PATH, `${PROFILE_PATH}.bak1`)
  } catch { /* no current profile yet */ }
}

/**
 * Persist the profile. Returns false when the write was rejected by the
 * shrink guard (new content <60% of a substantial existing profile — the
 * usual signature of a hallucinated rewrite dropping accumulated facts).
 */
export async function saveUserProfile(content: string, opts: { allowShrink?: boolean } = {}): Promise<boolean> {
  const next = content.slice(0, PROFILE_MAX_CHARS).trimEnd()
  const existing = await loadUserProfile()
  if (
    !opts.allowShrink &&
    existing.length > SHRINK_GUARD_MIN_CHARS &&
    next.length < existing.length * SHRINK_GUARD_RATIO
  ) {
    return false
  }
  await mkdir(PROFILE_DIR, { recursive: true })
  await rotateBackups()
  await writeFile(PROFILE_PATH, next + '\n', 'utf8')
  return true
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
