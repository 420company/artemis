/**
 * scripts/evalZh/meter.ts — the worker's view of model traffic.
 *
 * Wraps globalThis.fetch (every provider in src/providers calls it) to:
 *   - meter tokens of EVERY model call (main, helpers, sub-agents, judge)
 *     from the usage the provider itself reports, JSON or SSE;
 *   - check what the engine actually sent to the main model (context probes:
 *     a recalled memory, a learned-skill index, a fact that survived
 *     compaction, an attached image);
 *   - in mock mode, refuse every non-loopback request, so the eval never
 *     touches the network (search backends, update checks, ...).
 */

import { isContinuationSummaryText } from '../../src/core/compaction/continuation.js'
import type { ContextProbe, Usage } from './types.js'

/**
 * Token usage of one response, split the way providers bill it. `input` is
 * every input token (the context sent): uncached + cache reads + cache
 * writes. `cacheWrite5m` / `cacheWrite1h` are the parts of `cacheWrite`
 * with a known lifetime, when the provider reports them.
 */
export interface ResponseUsage {
  input: number
  output: number
  uncached: number
  cacheRead: number
  cacheWrite: number
  cacheWrite5m?: number
  cacheWrite1h?: number
}

/** What a model request was for. */
export type RequestKind = 'main' | 'summarizer' | 'helper'

function maxOf(text: string, keys: string[]): number {
  let best = 0
  for (const key of keys) {
    const re = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, 'g')
    for (let match = re.exec(text); match; match = re.exec(text)) best = Math.max(best, Number(match[1]))
  }
  return best
}

const has = (text: string, key: string): boolean => new RegExp(`"${key}"\\s*:\\s*\\d`).test(text)

/**
 * Token usage of one provider response (JSON body or SSE stream), for the
 * OpenAI chat/responses, Anthropic messages and Gemini formats. Streams
 * repeat or accumulate usage, so the largest value per field wins.
 *
 *   DeepSeek              prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
 *   OpenAI chat, Gemini   prompt_tokens / promptTokenCount include cached
 *                         tokens (prompt_tokens_details.cached_tokens,
 *                         cachedContentTokenCount; gateways may add
 *                         cache_write_tokens or cache_creation_input_tokens)
 *   Anthropic messages    input_tokens is the uncached part; cache reads and
 *                         writes are separate (cache_creation.ephemeral_5m/1h)
 *   OpenAI responses      input_tokens includes input_tokens_details.cached_tokens
 */
export function extractUsage(body: string): ResponseUsage | undefined {
  if (!/"(?:usage|usageMetadata)"/.test(body)) return undefined
  const output = maxOf(body, ['completion_tokens', 'output_tokens', 'candidatesTokenCount'])
  const write5m = maxOf(body, ['ephemeral_5m_input_tokens'])
  const write1h = maxOf(body, ['ephemeral_1h_input_tokens'])
  const ttl = {
    ...(has(body, 'ephemeral_5m_input_tokens') ? { cacheWrite5m: write5m } : {}),
    ...(has(body, 'ephemeral_1h_input_tokens') ? { cacheWrite1h: write1h } : {}),
  }
  let input: number
  let cacheRead: number
  let cacheWrite: number
  let uncached: number
  if (has(body, 'prompt_tokens') || has(body, 'promptTokenCount')) {
    input = maxOf(body, ['prompt_tokens', 'promptTokenCount'])
    cacheRead = Math.min(input, maxOf(body, ['cached_tokens', 'cachedContentTokenCount', 'cache_read_input_tokens', 'prompt_cache_hit_tokens']))
    cacheWrite = Math.min(input - cacheRead, maxOf(body, ['cache_write_tokens', 'cache_creation_input_tokens']))
    uncached = input - cacheRead - cacheWrite
  } else if (has(body, 'cache_read_input_tokens') || has(body, 'cache_creation_input_tokens') || !has(body, 'cached_tokens')) {
    uncached = maxOf(body, ['input_tokens'])
    cacheRead = maxOf(body, ['cache_read_input_tokens'])
    cacheWrite = Math.max(maxOf(body, ['cache_creation_input_tokens']), write5m + write1h)
    input = uncached + cacheRead + cacheWrite
  } else {
    input = maxOf(body, ['input_tokens'])
    cacheRead = Math.min(input, maxOf(body, ['cached_tokens']))
    cacheWrite = 0
    uncached = input - cacheRead
  }
  if (input === 0 && output === 0) return undefined
  return { input, output, uncached, cacheRead, cacheWrite, ...ttl }
}

function partText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    const p = part as { text?: unknown; content?: unknown }
    return typeof p?.text === 'string' ? p.text : typeof p?.content === 'string' ? p.content : ''
  }).join('\n')
}

/** Text of the newest message of a request (chat/messages `messages`, responses `input`, Gemini `contents`). */
export function lastMessageText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { messages?: unknown[]; input?: unknown; contents?: unknown[] }
    const list = Array.isArray(parsed.messages) ? parsed.messages : Array.isArray(parsed.input) ? parsed.input : Array.isArray(parsed.contents) ? parsed.contents : []
    const last = list.at(-1) as { content?: unknown; parts?: unknown } | undefined
    if (!last) return typeof parsed.input === 'string' ? parsed.input : ''
    return partText(last.content ?? last.parts)
  } catch {
    return ''
  }
}

/**
 * Main turn (tools attached), compaction summary, or another helper call.
 * Only the newest message decides a summary (the continuation's tagged
 * instruction, or the cold summarizer's request), so a history that merely
 * quotes either is still a main turn.
 */
export function classifyRequest(text: string): RequestKind {
  const last = lastMessageText(text)
  if (isContinuationSummaryText(last)) return 'summarizer'
  if (last.includes('<new_messages>') && /Output only the summary|只输出摘要本身/.test(last)) return 'summarizer'
  return hasTools(text) ? 'main' : 'helper'
}

/** "400 invalid_request_error", "429 rate_limit_error", "529", … from a failed response. */
export function apiErrorKind(status: number, body: string): string {
  let type: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; code?: unknown } | string; type?: unknown }
    const error = typeof parsed.error === 'object' && parsed.error ? parsed.error : undefined
    const candidate = error?.type ?? error?.code ?? (typeof parsed.type === 'string' && parsed.type !== 'error' ? parsed.type : undefined)
    if (typeof candidate === 'string' && /^[\w.-]{1,60}$/.test(candidate)) type = candidate
  } catch { /* not JSON */ }
  return type ? `${status} ${type}` : String(status)
}

/** An error event inside a 200 stream ("stream overloaded_error"), if any. */
export function streamErrorKind(body: string): string | undefined {
  if (!/^\s*(?:data|event):/.test(body)) return undefined
  const match = body.match(/data:\s*\{(?:"type"\s*:\s*"error"\s*,\s*)?"error"\s*:\s*\{[^}]*?"(?:type|code)"\s*:\s*"([\w.-]{1,60})"/)
  if (match) return `stream ${match[1]}`
  return /data:\s*\{(?:"type"\s*:\s*"error"\s*,\s*)?"error"\s*:/.test(body) ? 'stream error' : undefined
}

function modelOf(text: string, url: URL | undefined): string | undefined {
  try {
    const parsed = JSON.parse(text) as { model?: unknown }
    if (typeof parsed.model === 'string') return parsed.model
  } catch { /* fall through */ }
  // Gemini names the model in the path: /v1beta/models/<model>:generateContent
  return url?.pathname.match(/\/models\/([^/:]+)/)?.[1]
}

/** Add one response's usage to a running total. */
export function addResponseUsage(into: Usage, usage: ResponseUsage, kind: RequestKind): void {
  into.inputTokens += usage.input
  into.outputTokens += usage.output
  into.uncachedInputTokens = (into.uncachedInputTokens ?? 0) + usage.uncached
  into.cacheReadTokens = (into.cacheReadTokens ?? 0) + usage.cacheRead
  into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + usage.cacheWrite
  if (usage.cacheWrite5m !== undefined) into.cacheWrite5mTokens = (into.cacheWrite5mTokens ?? 0) + usage.cacheWrite5m
  if (usage.cacheWrite1h !== undefined) into.cacheWrite1hTokens = (into.cacheWrite1hTokens ?? 0) + usage.cacheWrite1h
  if (kind === 'summarizer') {
    into.summarizerRequests = (into.summarizerRequests ?? 0) + 1
    into.summarizerInputTokens = (into.summarizerInputTokens ?? 0) + usage.input
  }
}

function bodyText(body: unknown): string | undefined {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  return undefined
}

function isLoopback(url: URL): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
}

/** A model request: has a conversation in one of the provider formats. */
function looksLikeModelRequest(text: string): boolean {
  return /"(?:messages|input|contents)"\s*:/.test(text) && /"model"\s*:|"contents"\s*:/.test(text)
}

function hasTools(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { tools?: unknown }
    return Array.isArray(parsed.tools) && parsed.tools.length > 0
  } catch {
    return false
  }
}

export interface MeterOptions {
  offline: boolean
  probes: ContextProbe[]
  onUsage?: (usage: ResponseUsage, request: { kind: RequestKind; model?: string }) => void
  /** A model request that failed: HTTP status (and error type), or "network". */
  onApiError?: (kind: string, request: { model?: string }) => void
}

export class TrafficMeter {
  readonly usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0 }
  readonly blockedHosts = new Set<string>()
  readonly probeHits: Record<string, { first: boolean; last: boolean; any: boolean }> = {}
  mainRequests = 0
  private readonly pending = new Set<Promise<void>>()
  private readonly compiled: Array<{ id: string; re: RegExp }>

  constructor(private readonly options: MeterOptions) {
    this.compiled = options.probes.map((probe) => ({ id: probe.id, re: new RegExp(probe.pattern, probe.flags ?? '') }))
    for (const probe of options.probes) this.probeHits[probe.id] = { first: false, last: false, any: false }
  }

  install(): void {
    const realFetch = globalThis.fetch.bind(globalThis)
    const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      let url: URL | undefined
      try { url = new URL(href) } catch { /* relative or odd URL: let fetch decide */ }
      if (this.options.offline && url && !isLoopback(url)) {
        this.blockedHosts.add(url.host)
        throw new TypeError(`fetch failed: network disabled in eval mock mode (${url.host})`)
      }
      const text = bodyText(init?.body)
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const isModel = method === 'POST' && text !== undefined && looksLikeModelRequest(text)
      const kind = isModel ? classifyRequest(text!) : 'helper'
      const model = isModel ? modelOf(text!, url) : undefined
      // Compaction summaries carry tools and the history too, but are not main turns.
      if (isModel && kind === 'main') this.recordMainRequest(text!)
      let response: Response
      try {
        response = await realFetch(input as RequestInfo, init)
      } catch (error) {
        const aborted = init?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')
        if (isModel && !aborted) this.recordApiError('network', model)
        throw error
      }
      if (isModel) {
        this.usage.requests += 1
        const status = response.status
        const work = response.clone().text().then((body) => {
          if (status >= 400) {
            this.recordApiError(apiErrorKind(status, body), model)
            return
          }
          const streamError = streamErrorKind(body)
          if (streamError) this.recordApiError(streamError, model)
          const usage = extractUsage(body)
          if (!usage) return
          addResponseUsage(this.usage, usage, kind)
          this.options.onUsage?.(usage, { kind, ...(model ? { model } : {}) })
        }, () => undefined)
        this.pending.add(work)
        void work.finally(() => this.pending.delete(work))
      }
      return response
    }
    globalThis.fetch = wrapped as typeof fetch
  }

  private recordApiError(kind: string, model: string | undefined): void {
    this.usage.apiErrors = { ...(this.usage.apiErrors ?? {}), [kind]: (this.usage.apiErrors?.[kind] ?? 0) + 1 }
    this.options.onApiError?.(kind, model ? { model } : {})
  }

  private recordMainRequest(text: string): void {
    this.mainRequests += 1
    // JSON escapes non-ASCII as-is but escapes quotes/newlines; probes run on the decoded text too.
    let decoded = text
    try { decoded = JSON.stringify(JSON.parse(text), null, 0).replace(/\\n/g, '\n') } catch { /* keep raw */ }
    for (const { id, re } of this.compiled) {
      re.lastIndex = 0
      const hit = re.test(decoded)
      const entry = this.probeHits[id]!
      if (this.mainRequests === 1) entry.first = hit
      entry.last = hit
      entry.any = entry.any || hit
    }
  }

  /** Wait for usage parsing of responses still being read. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }
}
