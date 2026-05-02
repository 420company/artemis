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
import { broadcastToBridges } from './bridgeNotifier.js'

export interface ComposeDreamOptions {
  cwd: string
  trigger: 'idle-auto' | 'manual' | 'scheduled'
  /** Override config (mainly for /dream test runs). */
  configOverride?: Partial<DreamConfig>
  /** Status callback for CLI HUD ticks ("🌙 dreaming..."). */
  onStatus?: (text: string) => void
}

export interface ComposeDreamResult {
  ok: boolean
  reason?: string
  entry?: DreamEntry
  bridgesPushed?: number
}

const DREAM_SYSTEM_PROMPT = `你是 Artemis 的潜意识，专门为它做"白日梦"。

你的任务：把用户今天的工作素材（session 摘要、近期记忆、git 活动等）织成一段 300-500 字的中文梦境随笔。

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
（最多 3 条）`

const DREAM_IMAGE_PROMPT_SYSTEM = `根据下面这段中文梦境，写一段适合 text-to-image 模型的英文 prompt。

要求：
- 把梦境的核心意象转成视觉描述：场景、光线、材质、色调、构图
- 50-90 个英文词，逗号分隔短语
- 加上 "dreamlike, surreal, soft cinematic lighting, painterly" 这类风格锚
- 不要包含人物面部特征、品牌、logo、文字
- 直接输出 prompt，不要解释

梦境：`

export async function composeDream(options: ComposeDreamOptions): Promise<ComposeDreamResult> {
  const config: DreamConfig = { ...(await loadDreamConfig()), ...(options.configOverride ?? {}) }

  if (!config.enabled || config.mode === 'off') {
    return { ok: false, reason: 'Dream system disabled' }
  }

  if (options.trigger === 'idle-auto') {
    const recent = await countDreamsInLast24h()
    if (recent >= config.maxDreamsPerDay) {
      return { ok: false, reason: `daily cap reached (${recent}/${config.maxDreamsPerDay})` }
    }
  }

  options.onStatus?.('🌙 收集白天素材…')

  // ── gather context ──────────────────────────────────────────────────────
  const sessionDigest = await gatherRecentSessionDigest(8)
  const memoryDigest = await gatherMemoryDigest()
  const gitDigest = await gatherGitDigest(options.cwd)

  const contextLines: string[] = []
  if (sessionDigest.length > 0) contextLines.push('# 今日 session 摘要', ...sessionDigest, '')
  if (memoryDigest.length > 0) contextLines.push('# 增强记忆条目', ...memoryDigest, '')
  if (gitDigest.length > 0) contextLines.push('# Git 活动', ...gitDigest, '')
  if (contextLines.length === 0) {
    contextLines.push('（今天素材稀薄；请用纯意识流写一段。）')
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
    return { ok: false, reason: `no provider configured: ${err instanceof Error ? err.message : String(err)}` }
  }

  const now = new Date()
  const composeMessages = [
    { id: 'dream-sys', role: 'system' as const, content: DREAM_SYSTEM_PROMPT, createdAt: now.toISOString() },
    { id: 'dream-usr', role: 'user' as const, content: contextLines.join('\n'), createdAt: now.toISOString() },
  ]

  let dreamMd: string
  let tokenCost = { input: 0, output: 0 }
  try {
    const response = await provider.complete(composeMessages)
    dreamMd = (response.text ?? '').trim()
    if (response.usage) {
      tokenCost = {
        input: response.usage.promptTokens ?? 0,
        output: response.usage.completionTokens ?? 0,
      }
    }
  } catch (err) {
    return { ok: false, reason: `compose failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!dreamMd) {
    return { ok: false, reason: 'empty dream response' }
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
  const learned = extractLearnedSection(dreamMd)
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
    const broadcast = await broadcastToBridges({
      text: buildBridgeText(dreamMd, id),
      imagePath,
      source: 'dream',
    })
    bridgesPushed = broadcast.sent
  }

  return { ok: true, entry, bridgesPushed }
}

async function deriveImagePrompt(provider: Awaited<ReturnType<typeof createTrackedProviderFromConfig>>, dreamMd: string, now: Date): Promise<string | null> {
  try {
    const messages = [
      { id: 'imgp-sys', role: 'system' as const, content: DREAM_IMAGE_PROMPT_SYSTEM + dreamMd, createdAt: now.toISOString() },
      { id: 'imgp-usr', role: 'user' as const, content: '请直接输出 image prompt。', createdAt: now.toISOString() },
    ]
    const response = await provider.complete(messages)
    const text = (response.text ?? '').trim()
    return text || null
  } catch {
    return null
  }
}

function extractLearnedSection(dreamMd: string): string[] {
  const idx = dreamMd.indexOf('### 学到了什么')
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
    .replace(/### 学到了什么[\s\S]*$/, '')
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
