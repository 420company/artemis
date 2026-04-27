/**
 * core/bundle.ts — "Bundle" prompt enhancement layer.
 *
 * Rewrites free-form user input into a sharper, more precise prompt that the
 * main agent can act on efficiently. Triggered in `auto` mode when input is
 * long and descriptive, or on demand via /bundle.
 *
 * Transparent by design: the user always sees the original vs enhanced
 * version and approves which one to send. No silent rewrites.
 */

import type { BundleMode, BundleModelChoice } from '../cli/settings.js'
import { createProviderFromConfig } from '../providers/factory.js'
import type { ProviderConfig } from '../providers/types.js'
import type { SessionMessage } from './types.js'

// ─── public types ─────────────────────────────────────────────────────────────

export interface BundleTriggerSettings {
  enabled: boolean
  mode: BundleMode
  minLength: number
}

export interface BundleRequest {
  text: string
  locale: 'zh-CN' | 'en'
  mainConfig?: ProviderConfig
  brainConfig?: ProviderConfig
  modelChoice: BundleModelChoice
}

export interface BundleResult {
  enhanced: string
  model: string
  usedChoice: BundleModelChoice
}

// ─── heuristics: should we even try to polish? ────────────────────────────────

const SHORT_AFFIRMATIVES = new Set([
  'y', 'n', 'yes', 'no', 'ok', 'okay', 'sure', 'continue', 'go', 'run',
  '是', '否', '好', '好的', '继续', '行', '可以', '不用', '算了',
])

export function shouldAutoBundle(input: string, settings: BundleTriggerSettings): boolean {
  if (!settings.enabled || settings.mode !== 'auto') return false
  const trimmed = input.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('/')) return false          // slash commands bypass
  if (trimmed.startsWith('!')) return false          // bang-shell bypass
  if (trimmed.startsWith('@')) return false          // file mention bypass
  if (trimmed.length < settings.minLength) return false
  if (SHORT_AFFIRMATIVES.has(trimmed.toLowerCase())) return false
  // Skip if the input already looks like a structured prompt (has multi-line
  // structure and a goal/steps format) — user already did the work.
  if (/^(goal|目标|任务|steps|步骤)[:：]/im.test(trimmed)) return false
  return true
}

// ─── the rewrite prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT_ZH = `你是 Artemis 的提示词增强器 Bundle。

把用户的自然语言需求，重写为一段**清晰、结构化、可执行**的技术提示词，供编程助手使用。

规则：
1. 保留用户原意，禁止添加他们没说过的技术方案或虚构需求
2. 补齐可推断的上下文：目标、输入、期望产出、约束
3. 如果用户提到文件路径、命令、错误信息、特定技术栈，原样保留
4. 输出格式：
   - "目标"（1-2 句概括）
   - "关键细节"（bullet 列表，列出用户明确说过的事实和约束）
   - "期望产出"（列出用户希望看到的结果）
5. 不要加寒暄、不要解释自己做了什么、不要包代码块围栏
6. 只输出重写后的提示词本身，用中文

用户原始输入：
<<<
{INPUT}
>>>`

const SYSTEM_PROMPT_EN = `You are Bundle, Artemis's prompt enhancer.

Rewrite the user's free-form request into a clear, structured, actionable technical prompt for a coding assistant.

Rules:
1. Preserve the user's original intent — do not invent requirements or solutions they didn't state
2. Fill in inferable context: goal, inputs, expected outputs, constraints
3. Keep file paths, commands, error messages, and tech stacks verbatim
4. Output format:
   - "Goal" (1-2 sentences)
   - "Key details" (bullet list of facts and constraints the user stated)
   - "Expected output" (bullet list of what the user wants to see)
5. No greetings, no meta-explanation, no code-fence wrapping
6. Output only the rewritten prompt itself, in English

User input:
<<<
{INPUT}
>>>`

// ─── runner ───────────────────────────────────────────────────────────────────

export async function runBundle(req: BundleRequest): Promise<BundleResult> {
  const config = pickConfig(req)
  if (!config) {
    throw new Error('Bundle: no provider config available for the requested choice')
  }

  const systemTemplate = req.locale === 'zh-CN' ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN
  const prompt = systemTemplate.replace('{INPUT}', req.text.trim())

  const provider = createProviderFromConfig(config)
  const messages: SessionMessage[] = [
    {
      id: `bundle-${Date.now()}`,
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
    },
  ]

  const response = await provider.complete(messages)

  const enhanced = response.text.trim()
  if (!enhanced) {
    throw new Error('Bundle: rewrite returned empty')
  }

  return {
    enhanced,
    model: response.model ?? config.model,
    usedChoice: req.mainConfig && config === req.mainConfig ? 'main' : 'brain',
  }
}

function pickConfig(req: BundleRequest): ProviderConfig | undefined {
  // Honor user choice when possible, fall back to the other if unavailable.
  if (req.modelChoice === 'main') return req.mainConfig ?? req.brainConfig
  return req.brainConfig ?? req.mainConfig
}
