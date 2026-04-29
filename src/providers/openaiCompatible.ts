/* eslint-disable @typescript-eslint/no-unused-vars */
import type { SessionMessage } from '../core/types.js';
import type {
  ChatProvider,
  ProviderApiKeyHeader,
  ProviderConfig,
  ProviderRequestOptions,
  ProviderResponse,
} from './types.js';

function buildProviderErrorMessage(
  response: Response,
  body: string,
  config: ProviderConfig,
): string {
  const lines = [
    `Provider request failed: ${response.status} ${response.statusText}`,
  ];

  const trimmedBody = body.trim();
  if (trimmedBody) {
    lines.push(trimmedBody);
  }

  const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, '');
  const lowerBody = trimmedBody.toLowerCase();
  const googleGemini =
    normalizedBaseUrl.toLowerCase().includes('generativelanguage.googleapis.com') ||
    lowerBody.includes('generativelanguage.googleapis.com') ||
    lowerBody.includes('googleapis.com');

  if (
    response.status === 404 &&
    /\/api\/coding$/i.test(normalizedBaseUrl)
  ) {
    lines.push(
      [
        'Hint: this client is OpenAI-compatible and appends /chat/completions.',
        'For BytePlus Coding Plan, use the OpenAI-compatible base URL ending in /api/coding/v3.',
        'The plain /api/coding base URL is for a different compatibility mode.',
      ].join(' '),
    );
  }

  if (response.status === 401) {
    lines.push(
      [
        'Hint: the API key was rejected.',
        'Check that ARTEMIS_API_KEY is correct for this provider and that the key still has access to the selected model.',
      ].join(' '),
    );
  }

  if (response.status === 403) {
    lines.push(
      [
        'Hint: the request was forbidden.',
        'Check that this key and account are allowed to use the selected model and base URL.',
      ].join(' '),
    );
  }

  if (response.status === 429) {
    lines.push(
      [
        'Hint: the provider rate-limited or quota-limited this request.',
        'Wait and retry, or switch to another model/profile before re-running artemis doctor --test-providers.',
      ].join(' '),
    );
  }

  if (response.status === 400) {
    if (
      googleGemini &&
      /api_key_invalid|api key not valid|invalid api key|authentication/i.test(lowerBody)
    ) {
      lines.push(
        [
          'Hint: Google Gemini rejected this API key.',
          'Use a Google AI Studio / Gemini API key for generativelanguage.googleapis.com.',
        ].join(' '),
      );
    } else {
      lines.push(
        [
          `Hint: verify the selected model (${config.model}) matches this base URL (${normalizedBaseUrl}).`,
          'A model/base-URL mismatch commonly returns 400-level request errors.',
        ].join(' '),
      );
    }
  }

  return lines.join('\n');
}

function buildProviderTransportErrorMessage(
  error: unknown,
  config: ProviderConfig,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [
    `Provider request failed before an HTTP response was received: ${message}`,
    `Requested URL root: ${config.baseUrl}`,
    `Requested model: ${config.model}`,
  ];

  if (/ENOTFOUND|getaddrinfo/i.test(message)) {
    lines.push(
      'Hint: the provider host could not be resolved. Check the base URL and the local network connection.',
    );
  } else if (/ECONNREFUSED/i.test(message)) {
    lines.push(
      'Hint: the provider endpoint refused the connection. Check the base URL and make sure the remote service is listening.',
    );
  } else if (/timed out|ETIMEDOUT|timeout/i.test(message)) {
    lines.push(
      'Hint: the provider did not respond in time. Retry, or test the same profile with artemis doctor --test-providers.',
    );
  } else if (/fetch failed/i.test(message)) {
    lines.push(
      'Hint: the request could not be completed. Check the base URL, network access, and any local proxy or gateway settings.',
    );
  }

  return lines.join('\n');
}

type OpenAIMessageContent = string | Array<{ type: string; [key: string]: unknown }>;

export function buildApiKeyHeaders(
  apiKey: string,
  header: ProviderApiKeyHeader = 'authorization',
): Record<string, string> {
  const trimmed = apiKey.trim();
  if (!trimmed) return {};
  if (header === 'api-key') return { 'api-key': trimmed };
  if (header === 'x-api-key') return { 'x-api-key': trimmed };
  return { authorization: `Bearer ${trimmed}` };
}

const UNSUPPORTED_SCHEMA_META_KEYS = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$defs',
  '$ref',
  '$comment',
  'definitions',
]);

const SCHEMA_OBJECT_KEYWORDS = new Set([
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'items',
]);

const SCHEMA_ARRAY_KEYWORDS = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'prefixItems',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Per-model rules for the `reasoning_content` field on assistant messages
 * sent in multi-turn conversations. The three reasoning model families have
 * INCOMPATIBLE requirements — getting this wrong returns HTTP 400 either way.
 *
 * Verified against official docs (2026-04-28):
 *
 *   - DeepSeek-Reasoner / R1 (api-docs.deepseek.com/guides/reasoning_model):
 *     "if the `reasoning_content` field is included in the sequence of input
 *      messages, the API will return a 400 error."
 *     → MUST STRIP reasoning_content from inputs.
 *
 *   - DeepSeek-V4 (newer, e.g. deepseek-v4-pro / deepseek-v4-flash):
 *     400 error message says: "The `reasoning_content` in the thinking mode
 *     must be passed back to the API."
 *     → MUST FORCE reasoning_content (with empty fallback) on every assistant
 *     message including those without original reasoning.
 *
 *   - Everything else (default): preserve when present, omit when absent.
 *     Includes OpenAI o-series (reasoning is internal, no echo needed),
 *     Z.AI GLM, Qwen reasoning variants, etc. Conservative middle ground —
 *     matches behavior most providers expect.
 *
 * Note: order matters. We check `deepseek-v4` before `reasoner` because the
 * former wants force, the latter wants strip.
 */
type ReasoningContentMode = 'strip' | 'force' | 'preserve';

function getReasoningContentMode(model: string | undefined): ReasoningContentMode {
  const m = (model ?? '').toLowerCase();
  // DeepSeek V4 thinking family — REQUIRES reasoning_content
  if (m.includes('deepseek-v4') || (m.includes('deepseek') && m.includes('-v4'))) return 'force';
  // DeepSeek Reasoner / R1 family — REJECTS reasoning_content in inputs
  if (m.includes('deepseek-reasoner') || m.includes('deepseek-r1') || m.endsWith('-r1') || m.includes('/deepseek-r1')) return 'strip';
  // Default: preserve if present, omit if not
  return 'preserve';
}

interface MapMessageOptions {
  /** Per-model handling of reasoning_content in assistant messages. */
  reasoningMode?: ReasoningContentMode;
}

function mapMessage(message: SessionMessage, opts: MapMessageOptions = {}): Record<string, unknown> {
  const mode = opts.reasoningMode ?? 'preserve';

  // Tool result: use OpenAI's native tool message format when toolUseId is present
  if (message.role === 'tool') {
    if (message.toolUseId) {
      return { role: 'tool', tool_call_id: message.toolUseId, content: message.content ?? '' };
    }
    // Fallback: inject as user message for providers that don't support tool role
    return { role: 'user', content: `[tool:${message.name ?? 'unknown'}]\n${message.content}` };
  }
  // Build the reasoning_content fragment based on per-model mode. Pulled out
  // so both assistant branches share the same logic.
  const reasoningField = (() => {
    if (mode === 'strip') return {}; // deepseek-reasoner: NEVER include
    if (mode === 'force') return { reasoning_content: message.reasoningContent ?? '' }; // deepseek-v4: ALWAYS include
    // 'preserve': keep if present, omit if absent
    return message.reasoningContent ? { reasoning_content: message.reasoningContent } : {};
  })();

  // Assistant with OpenAI-style tool_calls
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      ...reasoningField,
      tool_calls: message.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  // Plain assistant message
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...reasoningField,
    };
  }
  return { role: message.role, content: message.content };
}

export function sanitizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const sanitizeNode = (node: Record<string, unknown>): Record<string, unknown> => {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_SCHEMA_META_KEYS.has(key)) {
        continue;
      }

      if (key === 'properties' && isRecord(value)) {
        const sanitizedProps: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          sanitizedProps[propName] = isRecord(propSchema)
            ? sanitizeNode(propSchema)
            : propSchema;
        }
        sanitized[key] = sanitizedProps;
        continue;
      }

      if (SCHEMA_OBJECT_KEYWORDS.has(key) && isRecord(value)) {
        sanitized[key] = sanitizeNode(value);
        continue;
      }

      if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
        sanitized[key] = value.map((entry) => (isRecord(entry) ? sanitizeNode(entry) : entry));
        continue;
      }

      sanitized[key] = value;
    }

    return sanitized;
  };

  const sanitized = sanitizeNode({ ...schema });
  if (sanitized.type === undefined && isRecord(sanitized.properties)) {
    sanitized.type = 'object';
  }
  if (sanitized.type !== 'object') {
    sanitized.type = 'object';
  }
  return sanitized;
}

function injectImagesIntoMessages(
  mapped: Array<{ role: string; content: OpenAIMessageContent }>,
  attachments: import('./types.ts').ImageAttachment[],
  config: ProviderConfig
): void {
  let lastUserIdx = -1
  for (let i = mapped.length - 1; i >= 0; i -= 1) {
    if (mapped[i]!.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0 || attachments.length === 0) return

  const existingText = mapped[lastUserIdx]!.content
  const textStr = typeof existingText === 'string' ? existingText : ''

  // Detect provider variant
  const modelLower = config.model.toLowerCase()
  const baseUrlLower = config.baseUrl.toLowerCase()

  const isDeepSeek = modelLower.includes('deepseek') || baseUrlLower.includes('deepseek')
  const isAnthropic = modelLower.includes('claude') || baseUrlLower.includes('anthropic')
  const isGoogle = baseUrlLower.includes('generativelanguage.googleapis.com')
  const isQwen = modelLower.includes('qwen')

  const imageBlocks: unknown[] = []

  for (const img of attachments) {
    if (isDeepSeek) {
      // DeepSeek uses non-standard format, only accepts base64 directly in text
      imageBlocks.push({
        type: 'text',
        text: `![image](data:${img.mediaType};base64,${img.data})`
      })
    } else if (isAnthropic) {
      // Anthropic image format
      imageBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.data
        }
      })
    } else if (isGoogle) {
      // Gemini format
      imageBlocks.push({
        inlineData: {
          mimeType: img.mediaType,
          data: img.data
        }
      })
    } else {
      // Standard OpenAI format - works for OpenAI, GPT-4o, Ark, Mistral, Llama 3, etc
      imageBlocks.push({
        type: 'image_url',
        image_url: { url: `data:${img.mediaType};base64,${img.data}` }
      })
    }
  }

  if (isDeepSeek) {
    // DeepSeek does NOT support array content at all. Embed images inline.
    mapped[lastUserIdx] = {
      role: 'user',
      content: textStr + '\n\n' + imageBlocks.map(b => (b as {text: string}).text).join('\n')
    } as any
  } else if (isGoogle) {
    mapped[lastUserIdx] = {
      role: 'user',
      parts: [ { text: textStr }, ...imageBlocks ]
    } as any
  } else {
    // Standard implementation
    const textBlock = textStr ? [{ type: 'text', text: textStr }] : []
    mapped[lastUserIdx] = {
      role: 'user',
      content: [...textBlock, ...imageBlocks] as any
    }
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          'text' in entry &&
          typeof entry.text === 'string'
        ) {
          return entry.text;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly supportsImages = true;
  readonly supportsNativeToolCalls = true;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  // ── Streaming (SSE) ───────────────────────────────────────────────────────

  async completeStream(
    messages: SessionMessage[],
    onChunk: (delta: string) => void,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const startedAt = Date.now()
    const reasoningMode = getReasoningContentMode(this.config.model)
    const mapped = messages.map((m) => mapMessage(m, { reasoningMode })) as Array<{ role: string; content: OpenAIMessageContent }>
    if (options?.imageAttachments?.length) {
      injectImagesIntoMessages(mapped as any, options.imageAttachments, this.config)
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: mapped,
    }
    if (options?.nativeFunctionTools?.length) {
      body['tools'] = options.nativeFunctionTools.map((t) => ({
        type: 'function',
        function: { 
          name: t.name, 
          description: t.description, 
          parameters: sanitizeToolSchema(t.parameters) 
        },
      }))
    }

    let response: Response
    try {
      response = await fetch(
        `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...buildApiKeyHeaders(this.config.apiKey, this.config.apiKeyHeader),
          },
          body: JSON.stringify(body),
        },
      )
    } catch (error) {
      throw new Error(buildProviderTransportErrorMessage(error, this.config))
    }

    if (!response.ok) {
      const errBody = await response.text()
      throw new Error(buildProviderErrorMessage(response, errBody, this.config))
    }

    // Some OpenAI-compatible endpoints accept `stream: true` in the request but
    // still reply with a plain `application/json` body (our own runtime smoke
    // mock is one example; a few third-party gateways do the same). Treat any
    // non-SSE content type as a non-streaming response and hand the full body
    // back to the caller without emitting text yet. That preserves the
    // brain's ability to intercept deflection/pseudo-tool replies before the
    // user sees them.
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      return await this.parseNonStreamingBody(response, startedAt)
    }

    if (!response.body) {
      throw new Error('Provider returned no response body for streaming request.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''
    let fullReasoningContent = ''
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0
    let firstResponseMs: number | undefined
    let responseModel = this.config.model
    const guardStreamingText = options?.guardStreamingText === true
    let pendingGuardText = ''
    let releasedGuardText = !guardStreamingText
    let emittedVisibleText = false
        // Tool calls arrive as indexed delta fragments; concatenate arguments per index.
    // ALL PROVIDERS BREAK THE INDEX FIELD. DO NOT TRUST IT.
    // Correct algorithm: tool deltas always arrive in order, append to current open slot
    const toolSlots: Array<{ id: string; name: string; arguments: string }> = []

    const emitVisibleText = (text: string): void => {
      if (!text) return
      firstResponseMs ??= Math.max(Date.now() - startedAt, 0)
      emittedVisibleText = true
      onChunk(text)
    }

    const releaseGuardedText = (): void => {
      if (releasedGuardText) return
      releasedGuardText = true
      if (pendingGuardText) {
        emitVisibleText(pendingGuardText)
        pendingGuardText = ''
      }
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') continue
        if (!trimmed.startsWith('data: ')) continue

        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed.slice(6))
        } catch {
          continue
        }

        const p = parsed as Record<string, unknown>

        const choices = p['choices'] as Array<Record<string, unknown>> | undefined
        const deltaObj = choices?.[0]?.['delta'] as Record<string, unknown> | undefined

        const contentDelta = deltaObj?.['content']
        if (typeof contentDelta === 'string' && contentDelta) {
          fullText += contentDelta
          if (releasedGuardText) {
            emitVisibleText(contentDelta)
          } else {
            pendingGuardText += contentDelta
          }
        }

        // DeepSeek-reasoner (and other reasoning models) emit `reasoning_content`
        // deltas before any visible `content` arrives. Accumulate the full chain
        // so it can be stored in the session and echoed back on the next turn —
        // DeepSeek's API requires it and returns HTTP 400 without it.
        const reasoningDelta = deltaObj?.['reasoning_content']
        if (typeof reasoningDelta === 'string' && reasoningDelta) {
          fullReasoningContent += reasoningDelta
          firstResponseMs ??= Math.max(Date.now() - startedAt, 0)
          if (options?.onReasoning) {
            options.onReasoning(reasoningDelta)
          }
        }

        const toolCallsDelta = deltaObj?.['tool_calls'] as Array<Record<string, unknown>> | undefined
        if (Array.isArray(toolCallsDelta)) {
          if (toolCallsDelta.length > 0) {
            firstResponseMs ??= Math.max(Date.now() - startedAt, 0)
            releaseGuardedText()
          }

          for (const tcDelta of toolCallsDelta) {
            // Do NOT use the index field. It is broken on DeepSeek, Qwen, Anthropic, OpenRouter.
            // All providers send tool deltas in exact order. We always append to the last open slot.
            let idx: number
            if (typeof tcDelta['index'] === 'number') {
              idx = tcDelta['index'] as number
            } else {
              // Missing index = append to last existing slot, or create new if last has name already
              if (toolSlots.length === 0 || toolSlots[toolSlots.length - 1].name) {
                idx = toolSlots.length
              } else {
                idx = toolSlots.length - 1
              }
            }

            while (toolSlots.length <= idx) {
              toolSlots.push({ id: '', name: '', arguments: '' })
            }

            const slot = toolSlots[idx]!

            if (typeof tcDelta['id'] === 'string') slot.id = tcDelta['id'] as string
            const fn = tcDelta['function'] as Record<string, unknown> | undefined
            if (fn) {
              if (typeof fn['name'] === 'string' && fn['name']) slot.name = fn['name'] as string
              if (typeof fn['arguments'] === 'string') slot.arguments += fn['arguments'] as string
            }
          }
        }

        if (typeof p['model'] === 'string') responseModel = p['model']

        const usage = p['usage'] as Record<string, unknown> | undefined
        if (usage) {
          promptTokens    = (usage['prompt_tokens']     as number | undefined) ?? promptTokens
          completionTokens = (usage['completion_tokens'] as number | undefined) ?? completionTokens
          totalTokens     = (usage['total_tokens']      as number | undefined) ?? totalTokens
        }
      }
    }

    // Filter out completely empty tool slots that the model sometimes emits as separators
    const nativeToolCalls = toolSlots.length > 0
      ? toolSlots
          .map((slot) => ({ name: slot.name, arguments: slot.arguments, callId: slot.id }))
          .filter(slot => slot.name && slot.name.trim())
      : undefined

    // It is completely normal for the final stream chunk to carry only finish_reason and nothing else
    // All OpenAI compatible providers do this. We MUST NOT throw here. Just return empty.
    // Upstream will handle empty responses correctly.

    return {
      text: fullText,
      raw: null,
      model: responseModel,
      nativeToolCalls,
      reasoningContent: fullReasoningContent || undefined,
      streamed: emittedVisibleText,
      usage: {
        promptTokens:     promptTokens || undefined,
        completionTokens: completionTokens || undefined,
        totalTokens:      totalTokens || undefined,
        durationMs: Math.max(Date.now() - startedAt, 0),
        firstResponseMs,
      },
    }
  }

  private async parseNonStreamingBody(
    response: Response,
    startedAt: number,
  ): Promise<ProviderResponse> {
    type OpenAIToolCall = { id: string; type: string; function: { name: string; arguments: string } }
    const json = (await response.json()) as {
      model?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: string; tool_calls?: OpenAIToolCall[] } }>
    }

    const message = json.choices?.[0]?.message
    const text = extractText(message?.content) || ''
    const rawToolCalls = message?.tool_calls
    const reasoningContent = typeof message?.reasoning_content === 'string' && message.reasoning_content
      ? message.reasoning_content
      : undefined
    const nativeToolCalls = rawToolCalls?.map((tc) => ({
      name: tc.function.name,
      arguments: tc.function.arguments,
      callId: tc.id,
    }))

    // It is completely normal for the final chunk to carry only finish_reason and nothing else
    // All OpenAI compatible providers do this. We MUST NOT throw here. Just return empty.

    // `streamed: false` tells the caller the text has NOT been emitted via
    // onChunk — they can intercept (e.g. runtime-guard deflection) before
    // showing anything to the user. This preserves the same contract as
    // `complete()` for gateways that accept stream:true but reply with JSON.
    return {
      text,
      raw: json,
      model: typeof json.model === 'string' ? json.model : this.config.model,
      nativeToolCalls,
      reasoningContent,
      streamed: false,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
        durationMs: Math.max(Date.now() - startedAt, 0),
        firstResponseMs: Math.max(Date.now() - startedAt, 0),
      },
    }
  }

  async complete(
    messages: SessionMessage[],
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const startedAt = Date.now();
    const reasoningMode = getReasoningContentMode(this.config.model);
    const mapped = messages.map((m) => mapMessage(m, { reasoningMode }));
    if (options?.imageAttachments?.length) {
      injectImagesIntoMessages(mapped as any, options.imageAttachments, this.config)
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: mapped,
    };

    // Attach function tools when provided
    if (options?.nativeFunctionTools?.length) {
      body['tools'] = options.nativeFunctionTools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: sanitizeToolSchema(t.parameters),
        },
      }));
    }

    let response: Response;
    try {
      response = await fetch(
        `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...buildApiKeyHeaders(this.config.apiKey, this.config.apiKeyHeader),
          },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      throw new Error(buildProviderTransportErrorMessage(error, this.config));
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(buildProviderErrorMessage(response, body, this.config));
    }

    type OpenAIToolCall = { id: string; type: string; function: { name: string; arguments: string } };
    const json = (await response.json()) as {
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: Array<{
        message?: { content?: unknown; reasoning_content?: string; tool_calls?: OpenAIToolCall[] };
      }>;
    };

    const message = json.choices?.[0]?.message;
    const text = extractText(message?.content) || '';
    const rawToolCalls = message?.tool_calls;
    const reasoningContent = typeof message?.reasoning_content === 'string' && message.reasoning_content
      ? message.reasoning_content
      : undefined;

    // Parse native tool calls from the response
    const nativeToolCalls = rawToolCalls?.map((tc) => ({
      name: tc.function.name,
      arguments: tc.function.arguments,
      callId: tc.id,
    }));

    // It is completely normal for the final chunk to carry only finish_reason and nothing else
    // All OpenAI compatible providers do this. We MUST NOT throw here. Just return empty.

    return {
      text,
      raw: json,
      model: typeof json.model === 'string' ? json.model : this.config.model,
      nativeToolCalls,
      reasoningContent,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
        durationMs: Math.max(Date.now() - startedAt, 0),
        firstResponseMs: Math.max(Date.now() - startedAt, 0),
      },
    };
  }
}
