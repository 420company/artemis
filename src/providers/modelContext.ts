import { buildApiKeyHeaders } from './openaiCompatible.js'
import type { ProviderApiKeyHeader, ProviderProfile } from './types.js'

type ModelMetadata = Record<string, unknown>

export type ModelContextLengthSource = 'models-api' | 'known-model' | 'manual' | 'unknown'

export type ModelContextDetectionResult = {
  contextLength?: number
  source: ModelContextLengthSource
  checkedAt: string
}

function normalizeContextLength(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : undefined
}

function readNestedNumber(obj: unknown, path: string[]): number | undefined {
  let current = obj
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return normalizeContextLength(current)
}

const EXACT_MODEL_CONTEXT_LENGTHS: Record<string, number> = {
  // Anthropic Claude
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4.8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4.7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4.6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4.6': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-opus-4-1-20250805': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-sonnet-4-20250514': 200_000,

  // OpenAI family
  'gpt-5.6-sol': 1_000_000,
  'gpt-5.5': 1_000_000,
  'gpt-5.5-pro': 1_000_000,
  'gpt-5.5-mini': 1_000_000,
  'gpt-5.5-nano': 1_000_000,
  'gpt-5.4': 1_000_000,
  'gpt-5.4-pro': 1_000_000,
  'gpt-5.4-mini': 1_000_000,
  'gpt-5.4-nano': 1_000_000,
  'gpt-5.2': 1_000_000,
  'gpt-5.2-codex': 1_000_000,
  'gpt-5.1': 1_000_000,
  'gpt-5.1-codex': 1_000_000,
  'gpt-5.1-codex-max': 1_000_000,
  'gpt-5.1-codex-mini': 1_000_000,
  'gpt-5': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-5-nano': 400_000,
  'gpt-5-codex': 400_000,
  'gpt-5-chat-latest': 400_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  'gpt-4.1-nano': 1_000_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4o-audio-preview': 128_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
  'gpt-oss-120b': 128_000,
  'gpt-oss-120b-250805': 128_000,

  // Google Gemini
  'gemini-3.5': 2_000_000,
  'gemini-3.5-flash': 1_000_000,
  'gemini-3.1-pro-preview': 2_000_000,
  'gemini-3-pro-preview': 2_000_000,
  'gemini-3-flash-preview': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.5-flash-lite': 1_000_000,

  // Moonshot / Kimi
  'moonshot-v1-128k': 128_000,
  'moonshot-v1-32k': 32_000,
  'moonshot-v1-8k': 8_000,
  'kimi-k2.6': 128_000,
  'kimi-k2.5': 128_000,
  'kimi-k2': 128_000,

  // BytePlus / ModelArk presets
  'seed-2-0-pro-260328': 128_000,
  'seed-2-0-lite-260228': 128_000,
  'seed-2-0-mini-260215': 128_000,
  'seed-2-0-code-preview-260328': 128_000,
  'seed-1-8-251228': 128_000,
  'seed-1-6-250915': 128_000,
  'seed-1-6-flash-250715': 128_000,
  'ark-code-latest': 128_000,
  'bytedance-seed-code': 128_000,
  'glm-5.1': 1_000_000,
  'glm-5-turbo': 1_000_000,
  'glm-5': 1_000_000,
  'glm-4.7': 128_000,
  'glm-4.7-flash': 128_000,
  'glm-4.7-flashx': 128_000,
  'glm-4.5-air': 128_000,
  'glm-4.5-flash': 128_000,
  'glm-4-7-251222': 128_000,
  'deepseek-v3-2-251201': 128_000,

  // Other common provider presets
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  // DeepSeek-V4 series (Pro + Flash) ship a 1,048,576-token window per DeepSeek
  // official spec. Earlier hardcoded 128K choked the worker summarizer.
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'codestral-latest': 256_000,
  'mistral-large-latest': 128_000,
  'mistral-medium-latest': 128_000,
  'mistral-small-latest': 128_000,
  'pixtral-large-latest': 128_000,
  'qwen-max': 128_000,
  'qwen-plus': 128_000,
  'qwen3-coder-next': 128_000,
  'qwen3.6-plus': 128_000,
  'qwen3.5-plus': 128_000,
  'step-2-16k': 16_000,
  'step-3': 128_000,
  'step-3.5-flash': 128_000,
  'step-3.5-flash-2603': 128_000,
  'amazon.nova-pro-v1:0': 300_000,
}

function normalizeKnownModelName(model: string): string {
  const raw = model.trim().toLowerCase()
  if (!raw) return ''
  const withoutProvider = raw.includes('/') ? raw.split('/').pop() ?? raw : raw
  return withoutProvider.replace(/^anthropic[.-]/, '')
}

export function inferKnownModelContextLength(model: string): number | undefined {
  const m = normalizeKnownModelName(model)
  if (!m) return undefined

  const exact = EXACT_MODEL_CONTEXT_LENGTHS[m]
  if (exact) return exact

  // ── Anthropic Claude ──────────────────────────────────────────────────────
  if (m.includes('claude-opus-4-7') || m.includes('claude-opus-4.7')) return 1_000_000
  if (m.includes('claude-sonnet-4-6') || m.includes('claude-sonnet-4.6')) return 1_000_000
  if (m.includes('claude-haiku-4-5') || m.includes('claude-haiku-4.5')) return 200_000
  if (m.includes('claude')) return 200_000

  // ── OpenAI GPT ───────────────────────────────────────────────────────────
  if (m.includes('gpt-5.6')) return 1_000_000
  if (m.includes('gpt-5.5')) return 1_000_000
  if (m.includes('gpt-5.4')) return 1_000_000
  if (m.includes('gpt-5.1') || m.includes('gpt-5.2')) return 1_000_000
  if (m.includes('gpt-5')) return 400_000
  if (m.includes('gpt-4.1')) return 1_000_000
  if (m.includes('o3') || m.includes('o4-mini')) return 200_000
  if (m.includes('gpt-4o') || m.includes('gpt-4-turbo')) return 128_000
  if (m.includes('gpt-4')) return 128_000
  if (m.includes('gpt-3.5')) return 16_000
  if (m.includes('gpt-oss')) return 128_000

  // ── Google Gemini ────────────────────────────────────────────────────────
  if (m.includes('gemini-3.5') && !m.includes('flash')) return 2_000_000
  if (m.includes('gemini-3.1-pro') || m.includes('gemini-3-pro-preview')) return 2_000_000
  if (m.includes('gemini-3') || m.includes('gemini-2')) return 1_000_000
  if (m.includes('gemini-1.5')) return 1_000_000
  if (m.includes('gemini')) return 1_000_000

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  // V4 series (incl. -pro / -flash) = 1,048,576-token window; V3 and chat/
  // reasoner remain 128K.
  if (m.includes('deepseek-v4') || m.includes('deepseek-v5')) return 1_000_000
  if (m.includes('deepseek')) return 128_000

  // ── Kimi / Moonshot ──────────────────────────────────────────────────────
  if (m.includes('kimi')) return 128_000
  if (m.includes('moonshot-v1-128k')) return 128_000
  if (m.includes('moonshot-v1-32k')) return 32_000
  if (m.includes('moonshot-v1-8k')) return 8_000
  if (m.includes('moonshot')) return 128_000

  // ── GLM / Zhipu ──────────────────────────────────────────────────────────
  if (m.includes('glm-5')) return 1_000_000
  if (m.includes('glm')) return 128_000

  // ── Qwen / DashScope ─────────────────────────────────────────────────────
  if (m.includes('qwen')) return 128_000

  // ── BytePlus / Seed / Ark ────────────────────────────────────────────────
  if (m.includes('seed-') || m.includes('ark-') || m.includes('bytedance')) return 128_000

  // ── Mistral ──────────────────────────────────────────────────────────────
  if (m.includes('codestral')) return 256_000
  if (m.includes('mistral')) return 128_000

  // ── MiniMax ──────────────────────────────────────────────────────────────
  if (m.includes('minimax')) return 1_000_000

  // ── XiaoMi MiMo ──────────────────────────────────────────────────────────
  if (m.includes('mimo')) return 128_000

  // ── StepFun ──────────────────────────────────────────────────────────────
  if (m.includes('step-')) return 128_000

  // ── AWS Bedrock ──────────────────────────────────────────────────────────
  if (m.includes('nova')) return 300_000

  // ── xAI Grok ─────────────────────────────────────────────────────────────
  if (m.includes('grok')) return 128_000

  // ── Llama ────────────────────────────────────────────────────────────────
  if (m.includes('llama')) return 128_000

  return undefined
}

function buildModelsUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl)
    const cleanPath = url.pathname.replace(/\/+$/, '')
    if (cleanPath.endsWith('/models')) return url.toString()
    if (cleanPath.endsWith('/chat/completions')) {
      url.pathname = cleanPath.slice(0, -'/chat/completions'.length) + '/models'
      return url.toString()
    }
    if (cleanPath.endsWith('/responses')) {
      url.pathname = cleanPath.slice(0, -'/responses'.length) + '/models'
      return url.toString()
    }
    url.pathname = `${cleanPath || ''}/models`
    return url.toString()
  } catch {
    return undefined
  }
}

function extractModelContextLength(metadata: ModelMetadata): number | undefined {
  const directKeys = [
    'context_length',
    'contextLength',
    'context_window',
    'contextWindow',
    'max_context_length',
    'maxContextLength',
    'max_context_tokens',
    'maxContextTokens',
    'max_input_tokens',
    'maxInputTokens',
    'input_token_limit',
    'inputTokenLimit',
    'max_model_len',
    'maxModelLen',
    'n_ctx',
  ]
  for (const key of directKeys) {
    const value = normalizeContextLength(metadata[key])
    if (value) return value
  }

  const nestedPaths = [
    ['model_details', 'context_length'],
    ['model_details', 'max_context_tokens'],
    ['details', 'context_length'],
    ['details', 'max_context_tokens'],
    ['capabilities', 'context_length'],
    ['capabilities', 'max_context_tokens'],
    ['limits', 'context_length'],
    ['limits', 'max_context_tokens'],
    ['metadata', 'context_length'],
    ['metadata', 'max_context_tokens'],
  ]
  for (const nestedPath of nestedPaths) {
    const value = readNestedNumber(metadata, nestedPath)
    if (value) return value
  }

  return undefined
}

async function fetchModelMetadata(
  profile: Pick<ProviderProfile, 'baseUrl' | 'apiKey' | 'apiKeyHeader' | 'model'>,
): Promise<ModelMetadata | undefined> {
  const url = buildModelsUrl(profile.baseUrl)
  if (!url) return undefined

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...buildApiKeyHeaders(profile.apiKey, profile.apiKeyHeader as ProviderApiKeyHeader | undefined),
    }
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) return undefined
    const body = await response.json() as unknown
    const data = typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : []
    for (const entry of data) {
      if (typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === profile.model) {
        return entry as ModelMetadata
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

export async function detectModelContextLength(
  profile: Pick<ProviderProfile, 'baseUrl' | 'apiKey' | 'apiKeyHeader' | 'model'>,
): Promise<ModelContextDetectionResult> {
  const checkedAt = new Date().toISOString()
  const metadata = await fetchModelMetadata(profile)
  if (metadata) {
    const fromMetadata = extractModelContextLength(metadata)
    if (fromMetadata) {
      return { contextLength: fromMetadata, source: 'models-api', checkedAt }
    }
  }

  const known = inferKnownModelContextLength(profile.model)
  if (known) {
    return { contextLength: known, source: 'known-model', checkedAt }
  }

  return { source: 'unknown', checkedAt }
}

export async function enrichProfileContextLength<T extends Pick<ProviderProfile, 'baseUrl' | 'apiKey' | 'apiKeyHeader' | 'model' | 'contextLength'>>(
  profile: T,
  options?: { preserveManual?: boolean },
): Promise<T & { contextLength?: number; contextLengthSource?: Exclude<ModelContextLengthSource, 'unknown'>; contextLengthCheckedAt?: string }> {
  if (options?.preserveManual && profile.contextLength) {
    return {
      ...profile,
      contextLengthSource: 'manual',
      contextLengthCheckedAt: new Date().toISOString(),
    }
  }

  const detected = await detectModelContextLength(profile)
  if (!detected.contextLength || detected.source === 'unknown') {
    return profile
  }

  return {
    ...profile,
    contextLength: detected.contextLength,
    contextLengthSource: detected.source,
    contextLengthCheckedAt: detected.checkedAt,
  }
}
