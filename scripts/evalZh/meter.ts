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

import type { ContextProbe, Usage } from './types.js'

export interface ResponseUsage {
  input: number
  output: number
}

function maxOf(text: string, keys: string[]): number {
  let best = 0
  for (const key of keys) {
    const re = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, 'g')
    for (let match = re.exec(text); match; match = re.exec(text)) best = Math.max(best, Number(match[1]))
  }
  return best
}

/**
 * Token usage of one provider response (JSON body or SSE stream), for the
 * OpenAI chat/responses, Anthropic messages and Gemini formats. Streams
 * repeat or accumulate usage, so the largest value per field wins.
 */
export function extractUsage(body: string): ResponseUsage | undefined {
  if (!/"(?:usage|usageMetadata)"/.test(body)) return undefined
  const openaiInput = maxOf(body, ['prompt_tokens', 'promptTokenCount'])
  // Anthropic reports cache reads/writes separately from input_tokens.
  const anthropicInput = maxOf(body, ['input_tokens']) + maxOf(body, ['cache_read_input_tokens']) + maxOf(body, ['cache_creation_input_tokens'])
  const input = Math.max(openaiInput, anthropicInput)
  const output = maxOf(body, ['completion_tokens', 'output_tokens', 'candidatesTokenCount'])
  if (input === 0 && output === 0) return undefined
  return { input, output }
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
  onUsage?: (usage: ResponseUsage) => void
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
      if (isModel && hasTools(text!)) this.recordMainRequest(text!)
      const response = await realFetch(input as RequestInfo, init)
      if (isModel) {
        this.usage.requests += 1
        const work = response.clone().text().then((body) => {
          const usage = extractUsage(body)
          if (!usage) return
          this.usage.inputTokens += usage.input
          this.usage.outputTokens += usage.output
          this.options.onUsage?.(usage)
        }, () => undefined)
        this.pending.add(work)
        void work.finally(() => this.pending.delete(work))
      }
      return response
    }
    globalThis.fetch = wrapped as typeof fetch
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
