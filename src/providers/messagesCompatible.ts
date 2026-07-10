import type { SessionMessage } from '../core/types.js';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import type {
  ChatProvider,
  ProviderConfig,
  ProviderRequestOptions,
  ProviderResponse,
} from './types.js';

function cleanProviderBody(body: string): string {
  return body.trim();
}

function buildProviderErrorMessage(
  response: Response,
  body: string,
  config: ProviderConfig,
  locale: UiLocale = 'en',
): string {
  const lines = [
    pickLocale(locale, {
      zh: `连接测试没有通过：${response.status} ${response.statusText}`,
      en: `Connection test failed: ${response.status} ${response.statusText}`,
    }),
  ];

  const trimmedBody = cleanProviderBody(body);
  if (trimmedBody) {
    lines.push(pickLocale(locale, {
      zh: `服务端提示：${trimmedBody}`,
      en: `Server message: ${trimmedBody}`,
    }));
  }

  if (response.status === 404) {
    lines.push(pickLocale(locale, {
      zh: `没有找到对应的 Messages 接口。请确认 Base URL 是该服务的根地址；Artemis 会自动在后面加上 /v1/messages。当前 Base URL：${config.baseUrl}`,
      en: `The Messages endpoint was not found. Make sure the Base URL is the provider root; Artemis adds /v1/messages automatically. Current Base URL: ${config.baseUrl}`,
    }));
  }

  if (response.status === 401 || response.status === 403) {
    lines.push(pickLocale(locale, {
      zh: 'API key 没有通过校验。请确认 key 没有输错，并且当前账号有权限使用所选模型。',
      en: 'The API key was rejected. Check that the key is correct and that your account can use the selected model.',
    }));
  }

  if (response.status === 429) {
    lines.push(pickLocale(locale, {
      zh: '请求触发了限速或额度限制（已自动重试仍未恢复）。请稍后再试，或切换模型/API 配置。',
      en: 'The request hit a rate or quota limit (automatic retries did not recover). Retry later, or switch to another model/API profile.',
    }));
  }

  if (response.status === 529) {
    lines.push(pickLocale(locale, {
      zh: '服务端暂时过载（已自动重试仍未恢复）。请稍后再试。',
      en: 'The service is temporarily overloaded (automatic retries did not recover). Retry shortly.',
    }));
  }

  if (response.status === 400) {
    lines.push(pickLocale(locale, {
      zh: `请求格式没有被服务接受。请确认模型 ${config.model} 适用于当前 Messages 接口：${config.baseUrl}`,
      en: `The service did not accept the request format. Make sure model ${config.model} works with this Messages endpoint: ${config.baseUrl}`,
    }));
  }

  return lines.join('\n');
}

function buildProviderTransportErrorMessage(
  error: unknown,
  config: ProviderConfig,
  locale: UiLocale = 'en',
): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    pickLocale(locale, {
      zh: `还没有收到服务响应，连接就中断了：${message}`,
      en: `The connection stopped before the service returned a response: ${message}`,
    }),
    pickLocale(locale, {
      zh: `当前 Base URL：${config.baseUrl}`,
      en: `Current Base URL: ${config.baseUrl}`,
    }),
    pickLocale(locale, {
      zh: `当前模型：${config.model}`,
      en: `Current model: ${config.model}`,
    }),
    pickLocale(locale, {
      zh: '请检查 Base URL、网络连接，以及代理或网关设置。',
      en: 'Check the Base URL, network connection, and any proxy or gateway settings.',
    }),
  ].join('\n');
}

type AnthropicContentBlockObject = { type: string; [key: string]: unknown };
type AnthropicMessageContent = string | AnthropicContentBlockObject[];

// ── Model capability detection ────────────────────────────────────────────────
// This provider can face any Messages-compatible endpoint (official Anthropic,
// gateways, proxies). Modern-Claude-only request parameters are gated on the
// model id so legacy models and non-Claude gateways keep the old request shape.

// Models that support adaptive thinking (Claude 4.6 family and newer).
const ADAPTIVE_THINKING_MODELS = /^claude-(fable-5|mythos-5|sonnet-5|opus-4[.-][678]|sonnet-4[.-]6)/i;
// Models whose thinking display defaults to "omitted" — opt back into
// summarized text so the UI can show reasoning progress. (The `display` field
// itself is only accepted from Opus 4.7 onward; the 4.6 family already
// defaults to summarized and must not receive the field.)
const OMITTED_DISPLAY_MODELS = /^claude-(fable-5|mythos-5|sonnet-5|opus-4[.-][78])/i;
// Claude 4.x era models (64K+ output ceilings, higher when streaming).
const CLAUDE_4X_MODELS = /^claude-(opus-4|sonnet-4|haiku-4)/i;
// Effort support tiers: the param exists from Opus 4.5; `max` needs the 4.6
// family; `xhigh` needs Opus 4.7+ / Sonnet 5 / Fable 5. Unsupported levels
// clamp to `high` rather than erroring; unsupported models drop the param.
const EFFORT_MODELS = /^claude-(fable-5|mythos-5|sonnet-5|opus-4[.-][5678]|sonnet-4[.-]6)/i;
const EFFORT_MAX_MODELS = /^claude-(fable-5|mythos-5|sonnet-5|opus-4[.-][678]|sonnet-4[.-]6)/i;
const EFFORT_XHIGH_MODELS = /^claude-(fable-5|mythos-5|sonnet-5|opus-4[.-][78])/i;

function resolveEffortParam(model: string, effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  if (!EFFORT_MODELS.test(model)) return undefined;
  if (effort === 'ultra') effort = 'max'; // ultra is OpenAI-only; Anthropic tops out at max
  if (effort === 'xhigh' && !EFFORT_XHIGH_MODELS.test(model)) return 'high';
  if (effort === 'max' && !EFFORT_MAX_MODELS.test(model)) return 'high';
  return effort;
}

function buildThinkingParam(model: string): Record<string, unknown> | undefined {
  if (!ADAPTIVE_THINKING_MODELS.test(model)) return undefined;
  return OMITTED_DISPLAY_MODELS.test(model)
    ? { type: 'adaptive', display: 'summarized' }
    : { type: 'adaptive' };
}

function resolveMaxTokens(model: string, streaming: boolean): number {
  if (ADAPTIVE_THINKING_MODELS.test(model)) {
    // 128K ceilings on the modern family; keep non-streaming under HTTP
    // timeout territory (~16K) and give streaming room for thinking + output.
    return streaming ? 64_000 : 16_000;
  }
  if (CLAUDE_4X_MODELS.test(model)) {
    return streaming ? 32_000 : 16_000;
  }
  // Unknown / legacy / non-Claude gateway models: conservative ceiling.
  return 8_192;
}

// ── Retry with backoff ────────────────────────────────────────────────────────

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
      return;
    }
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  abortSignal?: AbortSignal,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      lastError = error;
      if (attempt === MAX_ATTEMPTS) throw error;
      await abortableSleep(Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS), abortSignal);
      continue;
    }
    if (!isRetryableStatus(response.status) || attempt === MAX_ATTEMPTS) {
      return response;
    }
    // Honor retry-after (seconds) when the server sends one; otherwise back off
    // exponentially. Drain the failed body so the socket is released.
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : NaN;
    const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec >= 0
      ? Math.min(retryAfterSec * 1000, MAX_RETRY_DELAY_MS)
      : Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
    try { await response.text(); } catch { /* ignore */ }
    await abortableSleep(delayMs, abortSignal);
  }
  throw lastError ?? new Error('Request failed after retries.');
}

// ── Message mapping ───────────────────────────────────────────────────────────

function mapMessage(message: SessionMessage): { role: 'user' | 'assistant'; content: AnthropicMessageContent } {
  // Tool result → Anthropic tool_result content block
  if (message.role === 'tool' && message.toolUseId) {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: message.toolUseId, content: message.content ?? '' }],
    };
  }
  if (message.role === 'tool') {
    // Fallback: plain user message
    return { role: 'user', content: `[tool:${message.name ?? 'unknown'}]\n${message.content}` };
  }
  // Assistant with raw content blocks from a previous Anthropic response —
  // pass them back unmodified. REQUIRED for extended thinking + tool_use
  // loops: thinking blocks carry signatures that Anthropic verifies, and the
  // spec mandates "the entire sequence of consecutive thinking blocks must
  // match the outputs generated by the model during the original request;
  // you can't rearrange or modify the sequence".
  if (message.role === 'assistant' && message.rawContentBlocks?.length) {
    return { role: 'assistant', content: message.rawContentBlocks as AnthropicContentBlockObject[] };
  }
  // Assistant with OpenAI-style toolCalls → convert to Anthropic tool_use blocks
  if (message.role === 'assistant' && message.toolCalls?.length) {
    const blocks: AnthropicContentBlockObject[] = [];
    if (message.content) {
      blocks.push({ type: 'text', text: message.content });
    }
    for (const tc of message.toolCalls) {
      let input: unknown = {};
      try { input = JSON.parse(tc.arguments); } catch { input = {}; }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }
    return { role: 'assistant', content: blocks };
  }
  if (message.role === 'assistant') {
    return { role: 'assistant', content: message.content };
  }
  return { role: 'user', content: message.content };
}

function injectImagesIntoMessages(
  mapped: Array<{ role: 'user' | 'assistant'; content: AnthropicMessageContent }>,
  attachments: import('./types.ts').ImageAttachment[],
): void {
  let lastUserIdx = -1;
  for (let i = mapped.length - 1; i >= 0; i -= 1) {
    if (mapped[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0 || attachments.length === 0) return;

  const existingText = mapped[lastUserIdx]!.content;
  const textStr = typeof existingText === 'string' ? existingText : '';
  const imageBlocks = attachments.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
    ...(img.label ? { _label: img.label } : {}),
  }));
  mapped[lastUserIdx] = {
    role: 'user',
    content: [...imageBlocks, { type: 'text', text: textStr }],
  };
}

// Prompt caching: mark the last block of the newest user message so the whole
// conversation prefix is cached (system + tools already carry their own
// markers — 3 of the 4 allowed breakpoints in total). Clones the touched
// message/blocks so stored session state (rawContentBlocks) is never mutated;
// otherwise markers would accumulate across turns and blow the 4-breakpoint cap.
function addConversationCacheBreakpoint(
  mapped: Array<{ role: 'user' | 'assistant'; content: AnthropicMessageContent }>,
): void {
  for (let i = mapped.length - 1; i >= 0; i -= 1) {
    const msg = mapped[i]!;
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      if (!msg.content) return;
      mapped[i] = {
        role: 'user',
        content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }],
      };
      return;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const blocks = [...msg.content];
      const last = blocks[blocks.length - 1]!;
      blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
      mapped[i] = { role: 'user', content: blocks };
      return;
    }
    return;
  }
}

function extractText(content: AnthropicContentBlockObject[] | undefined): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((entry) => (entry?.type === 'text' && typeof entry.text === 'string' ? entry.text : ''))
    .filter(Boolean)
    .join('\n');
}

function buildRefusalError(locale: UiLocale | undefined, explanation?: string): Error {
  const base = pickLocale(locale ?? 'en', {
    zh: '模型出于安全策略拒绝了本次请求（stop_reason: refusal）。请调整请求内容后重试。',
    en: 'The model declined this request for safety reasons (stop_reason: refusal). Adjust the request and try again.',
  });
  return new Error(explanation ? `${base}\n${explanation}` : base);
}

type ParsedMessage = {
  text: string;
  raw: unknown;
  model?: string;
  stopReason?: string;
  stopExplanation?: string;
  nativeToolCalls?: Array<{ name: string; arguments: string; callId: string }>;
  rawContentBlocks?: AnthropicContentBlockObject[];
  promptTokens?: number;
  completionTokens?: number;
};

function parseMessageJson(json: {
  model?: string;
  stop_reason?: string;
  stop_details?: { explanation?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  content?: AnthropicContentBlockObject[];
}): ParsedMessage {
  const text = extractText(json.content);
  const toolUseBlocks = (json.content ?? []).filter((b) => b.type === 'tool_use');
  const nativeToolCalls = toolUseBlocks.length
    ? toolUseBlocks.map((b) => ({
        name: typeof b.name === 'string' ? b.name : '',
        arguments: JSON.stringify(b.input ?? {}),
        callId: typeof b.id === 'string' ? b.id : '',
      }))
    : undefined;

  // Capture raw content blocks for round-trip (extended thinking signatures,
  // unknown future block types). Caller stores these on the assistant
  // SessionMessage so mapMessage() can replay them verbatim next turn.
  const rawContentBlocks = Array.isArray(json.content) && json.content.length > 0
    ? json.content
    : undefined;

  return {
    text,
    raw: json,
    model: typeof json.model === 'string' ? json.model : undefined,
    stopReason: typeof json.stop_reason === 'string' ? json.stop_reason : undefined,
    stopExplanation: typeof json.stop_details?.explanation === 'string' ? json.stop_details.explanation : undefined,
    nativeToolCalls,
    rawContentBlocks,
    promptTokens: json.usage?.input_tokens,
    completionTokens: json.usage?.output_tokens,
  };
}

export class MessagesCompatibleProvider implements ChatProvider {
  readonly supportsImages = true;
  readonly supportsNativeToolCalls = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  private buildRequestBody(
    messages: SessionMessage[],
    options: ProviderRequestOptions | undefined,
    streaming: boolean,
  ): Record<string, unknown> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join('\n\n');
    const messagesApiMessages = messages
      .filter((message) => message.role !== 'system')
      .map(mapMessage);

    if (options?.imageAttachments?.length) {
      injectImagesIntoMessages(messagesApiMessages, options.imageAttachments);
    }
    addConversationCacheBreakpoint(messagesApiMessages);

    // Build tools in Anthropic Messages API format (input_schema, not parameters)
    const anthropicTools = options?.nativeFunctionTools?.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.parameters,
    }));
    // Prompt caching: mark the last tool definition so Anthropic caches the
    // entire stable tools prefix. Saves ~90% on tool-definition input tokens
    // for subsequent requests in the same server-side session.
    if (anthropicTools?.length) {
      const last = anthropicTools[anthropicTools.length - 1]!;
      (last as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    }

    // Prompt caching: send system prompt as content blocks with cache_control
    // so Anthropic caches the stable prefix. On cache hit, input_tokens for
    // the system prompt drop to ~1/10 of the full price.
    const systemBlocks = system
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : undefined;

    const thinking = buildThinkingParam(this.config.model);
    const effort = resolveEffortParam(this.config.model, this.config.effort);

    return {
      model: this.config.model,
      max_tokens: resolveMaxTokens(this.config.model, streaming),
      ...(streaming ? { stream: true } : {}),
      ...(thinking ? { thinking } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      ...(systemBlocks ? { system: systemBlocks } : {}),
      messages: messagesApiMessages,
      ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
    };
  }

  private async postMessages(
    body: Record<string, unknown>,
    options?: ProviderRequestOptions,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetchWithRetry(
        `${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: options?.abortSignal,
        },
        options?.abortSignal,
      );
    } catch (error) {
      if (options?.abortSignal?.aborted) {
        throw error;
      }
      throw new Error(buildProviderTransportErrorMessage(error, this.config, options?.locale));
    }

    if (!response.ok) {
      const errBody = await response.text();
      const err = new Error(buildProviderErrorMessage(response, errBody, this.config, options?.locale));
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }
    return response;
  }

  private finishResponse(
    parsed: ParsedMessage,
    options: ProviderRequestOptions | undefined,
    startedAt: number,
    firstResponseMs?: number,
    streamed?: boolean,
  ): ProviderResponse {
    if (parsed.stopReason === 'refusal') {
      throw buildRefusalError(options?.locale, parsed.stopExplanation);
    }
    if (!parsed.text && !parsed.nativeToolCalls?.length) {
      const detail = parsed.stopReason ? ` (stop_reason: ${parsed.stopReason})` : '';
      throw new Error(`Provider returned an empty completion payload${detail}.`);
    }

    return {
      text: parsed.text,
      raw: parsed.raw,
      model: parsed.model ?? this.config.model,
      nativeToolCalls: parsed.nativeToolCalls,
      rawContentBlocks: parsed.rawContentBlocks,
      ...(streamed !== undefined ? { streamed } : {}),
      usage: {
        promptTokens: parsed.promptTokens,
        completionTokens: parsed.completionTokens,
        totalTokens:
          typeof parsed.promptTokens === 'number' && typeof parsed.completionTokens === 'number'
            ? parsed.promptTokens + parsed.completionTokens
            : undefined,
        durationMs: Math.max(Date.now() - startedAt, 0),
        firstResponseMs: Math.max((firstResponseMs ?? Date.now()) - startedAt, 0),
      },
    };
  }

  async complete(
    messages: SessionMessage[],
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const startedAt = Date.now();
    const body = this.buildRequestBody(messages, options, false);
    const response = await this.postMessages(body, options);
    const json = (await response.json()) as Parameters<typeof parseMessageJson>[0];
    return this.finishResponse(parseMessageJson(json), options, startedAt);
  }

  // ── Streaming (SSE) ─────────────────────────────────────────────────────────
  async completeStream(
    messages: SessionMessage[],
    onChunk: (delta: string) => void,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const startedAt = Date.now();
    const body = this.buildRequestBody(messages, options, true);
    const response = await this.postMessages(body, options);

    // Some gateways accept `stream: true` but reply with plain JSON. Fall back
    // to non-streaming parsing; streamed=false tells the caller it still owns
    // text emission (deflection guards etc. rely on this).
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const json = (await response.json()) as Parameters<typeof parseMessageJson>[0];
      return this.finishResponse(parseMessageJson(json), options, startedAt, undefined, false);
    }
    if (!response.body) {
      throw new Error('Provider returned no response body for streaming request.');
    }

    // When guardStreamingText is set, hold all text back and return
    // streamed=false so the runtime can inspect the reply before display.
    const emitText = options?.guardStreamingText === true ? undefined : onChunk;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const blocks: AnthropicContentBlockObject[] = [];
    const partialToolJson = new Map<number, string>();
    let responseModel: string | undefined;
    let stopReason: string | undefined;
    let stopExplanation: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let firstResponseMs: number | undefined;
    let emittedVisibleText = false;

    const handleEvent = (payload: Record<string, unknown>): void => {
      const type = payload.type;
      if (type === 'error') {
        const errInfo = payload.error as { message?: string } | undefined;
        throw new Error(errInfo?.message || 'Provider returned a stream error event.');
      }
      if (type === 'message_start') {
        const msg = payload.message as { model?: string; usage?: { input_tokens?: number } } | undefined;
        if (typeof msg?.model === 'string') responseModel = msg.model;
        if (typeof msg?.usage?.input_tokens === 'number') promptTokens = msg.usage.input_tokens;
        return;
      }
      if (type === 'content_block_start') {
        const index = payload.index as number;
        const block = payload.content_block as AnthropicContentBlockObject;
        blocks[index] = { ...block };
        if (block.type === 'tool_use') partialToolJson.set(index, '');
        return;
      }
      if (type === 'content_block_delta') {
        const index = payload.index as number;
        const delta = payload.delta as Record<string, unknown>;
        const block = blocks[index];
        if (!block) return;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`;
          if (delta.text) {
            firstResponseMs ??= Date.now();
            if (emitText) {
              emittedVisibleText = true;
              emitText(delta.text);
            }
          }
          return;
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
          firstResponseMs ??= Date.now();
          if (delta.thinking) options?.onReasoning?.(delta.thinking);
          return;
        }
        if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          block.signature = `${typeof block.signature === 'string' ? block.signature : ''}${delta.signature}`;
          return;
        }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          partialToolJson.set(index, `${partialToolJson.get(index) ?? ''}${delta.partial_json}`);
          return;
        }
        return;
      }
      if (type === 'content_block_stop') {
        const index = payload.index as number;
        const block = blocks[index];
        const partial = partialToolJson.get(index);
        if (block?.type === 'tool_use' && typeof partial === 'string') {
          try { block.input = partial ? JSON.parse(partial) : {}; } catch { block.input = {}; }
        }
        return;
      }
      if (type === 'message_delta') {
        const delta = payload.delta as { stop_reason?: string; stop_details?: { explanation?: string } } | undefined;
        const usage = payload.usage as { output_tokens?: number } | undefined;
        if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
        if (typeof delta?.stop_details?.explanation === 'string') stopExplanation = delta.stop_details.explanation;
        if (typeof usage?.output_tokens === 'number') completionTokens = usage.output_tokens;
      }
    };

    const processBuffer = (final: boolean): void => {
      for (;;) {
        const sep = buffer.indexOf('\n\n');
        if (sep < 0) {
          if (final && buffer.trim()) {
            // Trailing event without terminator — try to process it anyway.
            const chunk = buffer;
            buffer = '';
            for (const line of chunk.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const data = trimmed.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              try { handleEvent(JSON.parse(data) as Record<string, unknown>); } catch (e) {
                if (e instanceof SyntaxError) continue;
                throw e;
              }
            }
          }
          return;
        }
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try { handleEvent(JSON.parse(data) as Record<string, unknown>); } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        processBuffer(false);
      }
      buffer += decoder.decode();
      processBuffer(true);
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }

    const content = blocks.filter((b): b is AnthropicContentBlockObject => Boolean(b));
    const parsed = parseMessageJson({
      model: responseModel,
      stop_reason: stopReason,
      stop_details: stopExplanation ? { explanation: stopExplanation } : undefined,
      usage: { input_tokens: promptTokens, output_tokens: completionTokens },
      content,
    });
    return this.finishResponse(parsed, options, startedAt, firstResponseMs, emittedVisibleText);
  }
}
