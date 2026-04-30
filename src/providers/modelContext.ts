import { buildApiKeyHeaders } from './openaiCompatible.js'
import type { ProviderApiKeyHeader, ProviderProfile } from './types.js'

type ModelMetadata = Record<string, unknown>

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

export function inferKnownModelContextLength(model: string): number | undefined {
  const m = model.trim().toLowerCase()
  if (!m) return undefined
  if (m.includes('gpt-5.5')) return 1_000_000
  if (m.includes('gpt-4.1')) return 1_000_000
  if (m.includes('gpt-5')) return 400_000
  if (m.includes('gemini-1.5') || m.includes('gemini-2')) return 1_000_000
  if (m.includes('claude')) return 200_000
  if (m.includes('o4-mini')) return 200_000
  if (m.includes('gpt-4o') || m.includes('gpt-4-turbo')) return 128_000
  if (m.includes('deepseek') || m.includes('kimi') || m.includes('moonshot')) return 128_000
  if (m.includes('qwen') || m.includes('glm')) return 128_000
  if (m.includes('seed-') || m.includes('ark-') || m.includes('bytedance')) return 128_000
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
): Promise<{ contextLength?: number; source: 'models-api' | 'known-model' | 'unknown' }> {
  const metadata = await fetchModelMetadata(profile)
  if (metadata) {
    const fromMetadata = extractModelContextLength(metadata)
    if (fromMetadata) {
      return { contextLength: fromMetadata, source: 'models-api' }
    }
  }

  const known = inferKnownModelContextLength(profile.model)
  if (known) {
    return { contextLength: known, source: 'known-model' }
  }

  return { source: 'unknown' }
}
