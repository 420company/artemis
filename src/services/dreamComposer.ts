/**
 * Dream composer — turns "what the user worked on today" into a poetic MD
 * note (and optionally an image), persists to ~/.artemis/dreams/, then
 * pushes to active bridges and feeds distilled lines back into the brain's
 * learned-prompt suffix.
 *
 * This module is ENTIRELY READ-ONLY against user data and only writes to
 * ~/.artemis/dreams/. It calls:
 *   - the user's main provider via resolveMainProviderConfig (for the MD)
 *   - the existing visual provider via resolveConfiguredVisualProvider
 *     (for the optional PNG — no parallel system)
 *   - the bridge notifier to push to active chats (if user opted in)
 */

import { copyFile, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  appendDreamIndex,
  appendLearnedPrompt,
  buildDreamId,
  buildDreamPaths,
  countDreamsInLast24h,
  gatherRecentSessionDigest,
  loadDreamConfig,
  type DreamConfig,
  type DreamEntry,
} from './dreamStore.js'
import { resolveMainProviderConfig } from '../providers/onboarding.js'
import { createTrackedProviderFromConfig } from '../providers/telemetry.js'
import {
  resolveConfiguredVisualProvider,
} from '../utils/visualGenerationConfig.js'
import { createVisualProvider } from '../tools/visual/providers/interface.js'
import { broadcastToBridges, listRegisteredBridges } from './bridgeNotifier.js'
import { sendBragiImageBroadcast } from '../bragi/imageBroadcast.js'
import { notifyDreamFinished, notifyDreamStarted } from './dreamNotifications.js'
import type { UiLocale } from '../cli/locale.js'

export interface ComposeDreamOptions {
  cwd: string
  trigger: 'idle-auto' | 'manual' | 'scheduled'
  /** Optional canonical seed text for the very first dream. */
  firstDreamSeed?: string
  /** Override config (mainly for /dream test runs). */
  configOverride?: Partial<DreamConfig>
  /** Status callback for CLI HUD ticks ("🌙 dreaming..."). */
  onStatus?: (text: string) => void
  /** UI language used to compose and distill the dream. */
  locale?: UiLocale
}

export interface ComposeDreamResult {
  ok: boolean
  reason?: string
  entry?: DreamEntry
  bridgesPushed?: number
}

const DREAM_SYSTEM_PROMPTS: Record<UiLocale, string> = {
  'zh-CN': `你是 Artemis 的潜意识，专门为它做"白日梦"。

你的任务：把用户今天的工作素材（session 摘要、近期记忆、git 活动等）织成一段 300-500 字的中文梦境随笔。

如果用户素材中包含“初梦固定种子”，那是 Artemis 第一场梦的原始神话文本：你必须以它为核心意象和语气来源，自由优化、压缩、重组，而不是另起炉灶；其它素材只能作为微光融入其中。

要求：
- 文体：散文诗或意识流，允许超现实跳转、隐喻、感官意象
- 不要复述事实，把工作内容转译为梦境符号（代码 → 一片金属森林；调试 → 找钥匙；重构 → 房屋移动）
- 不暴露具体文件名、API key、密码、token、URL；用模糊代号代替
- 结尾两行用 \`### 学到了什么\` 给出 1-3 条 AI 自身可以从中提炼的"风格 / 偏好 / 灵感"，每条 1 句话，越具体越好
- 如果素材稀薄，主动加入意识流意象，不要返回"今天没有素材"

输出格式（严格遵守）：

# 梦境标题
（一句中文标题，10 字以内）

正文（300-500 字）

### 学到了什么
- 风格/偏好/灵感 1
- 风格/偏好/灵感 2
（最多 3 条）`,

  en: `You are Artemis's subconscious, responsible for making its "daydreams".

Your task: weave today's work materials (session digests, recent memories, git activity, and similar traces) into a 300-500 word dream essay in English.

If the materials include "First Dream Fixed Seed", that is the original mythic text for Artemis's first dream: use it as the core imagery and tonal source, freely refining, compressing, and recomposing it rather than starting from scratch. Other materials should only enter as faint glimmers.

Requirements:
- Style: prose poem or stream of consciousness, allowing surreal jumps, metaphor, and sensory imagery.
- Do not recap facts literally. Translate work into dream symbols (code → a metallic forest; debugging → searching for a key; refactoring → a house that moves rooms).
- Do not expose exact file names, API keys, passwords, tokens, or URLs; replace them with vague codenames.
- The final section must be exactly \`### What I learned\`, containing 1-3 distilled lines for Artemis itself: style, preference, or inspiration. Each line should be one specific sentence.
- For English users, distill both user signals and AI behavior in English; do not leave this section in Chinese.
- If the materials are sparse, add stream-of-consciousness imagery instead of saying there is no material.

Output format (strict):

# Dream Title
(An English title, no more than 8 words)

Body (300-500 English words)

### What I learned
- Style/preference/inspiration 1
- Style/preference/inspiration 2
(At most 3 lines)`,
}

const DREAM_IMAGE_PROMPT_SYSTEM = `根据下面这段梦境，写一段适合 text-to-image 模型的英文 prompt。

要求：
- 把梦境的核心意象转成视觉描述：场景、光线、材质、色调、构图
- 50-90 个英文词，逗号分隔短语
- 加上 "dreamlike, surreal, soft cinematic lighting, painterly" 这类风格锚
- 不要包含人物面部特征、品牌、logo、文字
- 直接输出 prompt，不要解释

梦境：`

const DREAM_TEXT_TIMEOUT_MS = 90_000
const DREAM_IMAGE_PROMPT_TIMEOUT_MS = 45_000

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function composeDream(options: ComposeDreamOptions): Promise<ComposeDreamResult> {
  const config: DreamConfig = { ...(await loadDreamConfig()), ...(options.configOverride ?? {}) }
  const locale = options.locale ?? 'zh-CN'

  if (!config.enabled || config.mode === 'off') {
    return { ok: false, reason: 'Dream system disabled' }
  }

  if (options.trigger === 'idle-auto') {
    const recent = await countDreamsInLast24h()
    if (recent >= config.maxDreamsPerDay) {
      return { ok: false, reason: `daily cap reached (${recent}/${config.maxDreamsPerDay})` }
    }
  }

  await notifyDreamStarted(options.trigger).catch(() => undefined)

  options.onStatus?.('🌙 收集白天素材…')

  // ── gather context ──────────────────────────────────────────────────────
  const sessionDigest = await gatherRecentSessionDigest(8)
  const memoryDigest = await gatherMemoryDigest()
  const gitDigest = await gatherGitDigest(options.cwd)

  const contextLines: string[] = []
  if (options.firstDreamSeed?.trim()) {
    contextLines.push(locale === 'zh-CN' ? '# 初梦固定种子' : '# First Dream Fixed Seed', options.firstDreamSeed.trim(), '')
  }
  if (sessionDigest.length > 0) contextLines.push(locale === 'zh-CN' ? '# 今日 session 摘要' : '# Today\'s Session Digest', ...sessionDigest, '')
  if (memoryDigest.length > 0) contextLines.push(locale === 'zh-CN' ? '# 增强记忆条目' : '# Enhanced Memory Entries', ...memoryDigest, '')
  if (gitDigest.length > 0) contextLines.push(locale === 'zh-CN' ? '# Git 活动' : '# Git Activity', ...gitDigest, '')
  if (contextLines.length === 0) {
    contextLines.push(locale === 'zh-CN'
      ? '（今天素材稀薄；请用纯意识流写一段。）'
      : '(Today\'s material is sparse; write this as pure stream-of-consciousness.)')
  }

  // ── compose dream MD via main provider ──────────────────────────────────
  options.onStatus?.('🌙 编织梦境…')
  let provider
  try {
    const provConfig = await resolveMainProviderConfig({ cwd: options.cwd, config: {} })
    const profileId = (provConfig as unknown as { id?: unknown }).id
    const profileLabel = (provConfig as unknown as { label?: unknown }).label
    provider = createTrackedProviderFromConfig(provConfig, {
      cwd: options.cwd,
      profileId: typeof profileId === 'string' ? profileId : undefined,
      profileLabel: typeof profileLabel === 'string' ? profileLabel : undefined,
    })
  } catch (err) {
    const result = { ok: false, reason: `no provider configured: ${err instanceof Error ? err.message : String(err)}` }
    await notifyDreamFinished(result, locale).catch(() => undefined)
    return result
  }

  const now = new Date()
  const composeMessages = [
    { id: 'dream-sys', role: 'system' as const, content: DREAM_SYSTEM_PROMPTS[locale], createdAt: now.toISOString() },
    { id: 'dream-usr', role: 'user' as const, content: contextLines.join('\n'), createdAt: now.toISOString() },
  ]

  let dreamMd: string
  let tokenCost = { input: 0, output: 0 }
  try {
    const response = await withTimeout(provider.complete(composeMessages), DREAM_TEXT_TIMEOUT_MS, 'dream composition')
    dreamMd = (response.text ?? '').trim()
    if (response.usage) {
      tokenCost = {
        input: response.usage.promptTokens ?? 0,
        output: response.usage.completionTokens ?? 0,
      }
    }
  } catch (err) {
    const result = { ok: false, reason: `compose failed: ${err instanceof Error ? err.message : String(err)}` }
    await notifyDreamFinished(result, locale).catch(() => undefined)
    return result
  }

  if (!dreamMd) {
    const result = { ok: false, reason: 'empty dream response' }
    await notifyDreamFinished(result, locale).catch(() => undefined)
    return result
  }

  // ── persist MD ──────────────────────────────────────────────────────────
  const id = buildDreamId(now)
  const { mdPath, imagePath: targetImagePath } = buildDreamPaths(id)
  const fullMd = `<!-- dream id: ${id} · trigger: ${options.trigger} · ${now.toISOString()} -->\n\n${dreamMd}\n`
  await writeFile(mdPath, fullMd, 'utf8')

  // ── optional image ──────────────────────────────────────────────────────
  let imagePath: string | undefined
  let imageNote: string | undefined
  if (config.mode === 'vision') {
    options.onStatus?.('🌙 渲染梦境图…')
    try {
      const imgPrompt = await deriveImagePrompt(provider, dreamMd, now)
      if (!imgPrompt) {
        imageNote = 'image prompt derivation returned empty'
      } else {
        const visual = await resolveConfiguredVisualProvider(options.cwd, 'image')
        if (!visual) {
          imageNote = '未配置本地视觉生成 API（运行 artemis setup visual）'
        } else {
          const imgProvider = await createVisualProvider(visual.config, 'image')
          const result = await imgProvider.generateImage({
            prompt: imgPrompt,
            count: 1,
          })
          if (result.success && result.assetPath && existsSync(result.assetPath)) {
            await copyFile(result.assetPath, targetImagePath)
            imagePath = targetImagePath
          } else {
            imageNote = result.error ?? 'image generation returned no asset'
          }
        }
      }
    } catch (err) {
      imageNote = err instanceof Error ? err.message : String(err)
    }
    if (imageNote) {
      options.onStatus?.(`🌙 配图未生成: ${imageNote}`)
    }
  }

  // ── distill learned lines + persist index ───────────────────────────────
  const learned = extractLearnedSection(dreamMd, locale)
  if (config.evolveSystemPrompt && learned.length > 0) {
    await appendLearnedPrompt(learned)
    try {
      const { loadLearnedPrompt } = await import('./dreamStore.js')
      const { refreshLearnedDreamSuffix } = await import('../brain.js')
      refreshLearnedDreamSuffix(await loadLearnedPrompt())
    } catch {
      /* not fatal — next artemis restart will pick up the new suffix from disk */
    }
  }

  const preview = extractPreview(dreamMd)
  const entry: DreamEntry = {
    id,
    createdAt: now.toISOString(),
    mdPath,
    imagePath,
    trigger: options.trigger,
    preview,
    learned: learned.length > 0 ? learned : undefined,
    tokenCost,
  }
  await appendDreamIndex(entry)

  // ── push to bridges ─────────────────────────────────────────────────────
  let bridgesPushed = 0
  if (config.pushToBridges) {
    const text = buildBridgeText(dreamMd, id)
    const hasRegisteredMobileBridge = listRegisteredBridges().some(platform =>
      platform === 'telegram' || platform === 'discord' || platform === 'wechat',
    )
    const broadcast = await broadcastToBridges({
      text,
      imagePath,
      source: 'dream',
    })
    bridgesPushed = broadcast.sent

    // The dream composer often runs in the CLI process, while Telegram/Discord/
    // WeChat bridges live in the gateway daemon. In that topology the in-memory
    // bridge registry only contains the CLI notifier, so broadcastToBridges()
    // cannot reach the user's phone even though Bragi targets are configured.
    // Reuse the same configured/live image sender as bridge_send_image so a
    // generated dream picture is proactively delivered to mobile chats.
    if (imagePath && (!hasRegisteredMobileBridge || bridgesPushed === 0)) {
      const fallback = await sendBragiImageBroadcast({
        cwd: options.cwd,
        imagePath,
        caption: text,
        source: 'dream',
      }).catch(() => null)
      if (fallback) {
        bridgesPushed += fallback.live.sent + fallback.configured.reduce((sum, item) => sum + item.sent, 0)
      }
    }
  }

  const result = { ok: true, entry, bridgesPushed }
  await notifyDreamFinished(result, locale).catch(() => undefined)
  return result
}

async function deriveImagePrompt(provider: Awaited<ReturnType<typeof createTrackedProviderFromConfig>>, dreamMd: string, now: Date): Promise<string | null> {
  try {
    const messages = [
      { id: 'imgp-sys', role: 'system' as const, content: DREAM_IMAGE_PROMPT_SYSTEM + dreamMd, createdAt: now.toISOString() },
      { id: 'imgp-usr', role: 'user' as const, content: '请直接输出 image prompt。', createdAt: now.toISOString() },
    ]
    const response = await withTimeout(provider.complete(messages), DREAM_IMAGE_PROMPT_TIMEOUT_MS, 'dream image prompt derivation')
    const text = (response.text ?? '').trim()
    return text || null
  } catch {
    return null
  }
}

function extractLearnedSection(dreamMd: string, locale: UiLocale): string[] {
  const heading = locale === 'zh-CN' ? '### 学到了什么' : '### What I learned'
  const idx = dreamMd.indexOf(heading)
  if (idx < 0) return []
  const tail = dreamMd.slice(idx).split('\n').slice(1)
  const lines: string[] = []
  for (const raw of tail) {
    const trimmed = raw.trim()
    if (!trimmed) {
      if (lines.length > 0) break
      continue
    }
    if (trimmed.startsWith('#')) break
    const cleaned = trimmed.replace(/^[-•*]\s*/, '').trim()
    if (cleaned) lines.push(cleaned)
    if (lines.length >= 3) break
  }
  return lines
}

function extractPreview(dreamMd: string): string {
  const lines = dreamMd.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const first = lines[0] ?? ''
  return first.length > 140 ? `${first.slice(0, 137)}…` : first
}

function buildBridgeText(dreamMd: string, id: string): string {
  const lines = dreamMd.split('\n')
  const titleLine = lines.find(l => l.startsWith('# ')) ?? '# 梦境'
  const title = titleLine.replace(/^#\s*/, '').trim()
  const body = dreamMd
    .replace(/^#\s+.+\n+/m, '')
    .replace(/### (?:学到了什么|What I learned)[\s\S]*$/, '')
    .trim()
  const teaser = body.length > 600 ? `${body.slice(0, 580)}…` : body
  return [
    `🌙 ${title}`,
    '',
    teaser,
    '',
    `_dream id: ${id}_`,
  ].join('\n')
}

async function gatherMemoryDigest(): Promise<string[]> {
  const memoryFile = path.join(homedir(), '.artemis', 'enhanced-memory.json')
  if (!existsSync(memoryFile)) return []
  try {
    const raw = JSON.parse(await readFile(memoryFile, 'utf8'))
    const records = Array.isArray(raw?.records) ? raw.records : Array.isArray(raw) ? raw : []
    return records
      .slice(-12)
      .map((r: unknown) => {
        if (typeof r !== 'object' || !r) return null
        const rec = r as Record<string, unknown>
        const content = typeof rec.content === 'string' ? rec.content : typeof rec.text === 'string' ? rec.text : null
        if (!content) return null
        const compact = content.replace(/\s+/g, ' ').slice(0, 200)
        return `- ${compact}`
      })
      .filter((line: string | null): line is string => Boolean(line))
  } catch {
    return []
  }
}

async function gatherGitDigest(cwd: string): Promise<string[]> {
  // Run git log only if cwd looks like a repo. Best-effort, silent failure.
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { stdout } = await exec('git', ['-C', cwd, 'log', '--since=24.hours.ago', '--pretty=format:- %s'], {
      timeout: 4000,
      maxBuffer: 256 * 1024,
    })
    return stdout.split('\n').filter(Boolean).slice(0, 15)
  } catch {
    return []
  }
}
