import type { SessionMessage } from '../core/types.js';
import { normalizeUiLocale, type UiLocale } from '../cli/locale.js';
import { retryFetch } from './retryFetch.js';
import type {
  ChatProvider,
  ProviderConfig,
  ProviderNativeFunctionTool,
  ProviderNativeToolCall,
  ProviderNativeToolOutput,
  ProviderRequestOptions,
  ProviderResponse,
} from './types.js';

type ResponsesInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string };

type ResponsesInputItem = {
  role: 'user' | 'assistant' | 'system';
  content: Array<ResponsesInputContent>;
};

function injectImagesIntoInput(
  input: Array<ResponsesInputItem | ResponsesFunctionCallOutputItem>,
  attachments: import('./types.ts').ImageAttachment[],
): void {
  if (attachments.length === 0) return;
  let lastUserIdx = -1;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (item && 'role' in item && item.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return;

  const userItem = input[lastUserIdx] as ResponsesInputItem;
  const imageBlocks: ResponsesInputContent[] = attachments.map((img) => ({
    type: 'input_image',
    image_url: `data:${img.mediaType};base64,${img.data}`,
  }));
  (input[lastUserIdx] as ResponsesInputItem) = {
    role: userItem.role,
    content: [...imageBlocks, ...userItem.content],
  };
}

type ResponsesFunctionCallOutputItem = {
  type: 'function_call_output';
  call_id: string;
  output: string;
};

const IMAGE_OMITTED_PLACEHOLDER = '[image omitted due to request size]';

function stripImagesFromResponsesInput(input: unknown): unknown[] | null {
  if (!Array.isArray(input)) return null;
  let strippedAny = false;
  const nextInput = input.map((item) => {
    const content = (item as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return item;
    let changed = false;
    const nextContent = content.map((block) => {
      if ((block as { type?: unknown } | null)?.type !== 'input_image') return block;
      changed = true;
      return { type: 'input_text', text: IMAGE_OMITTED_PLACEHOLDER };
    });
    if (!changed) return item;
    strippedAny = true;
    return { ...(item as Record<string, unknown>), content: nextContent };
  });
  return strippedAny ? nextInput : null;
}

function buildProviderErrorMessage(
  response: Response,
  body: string,
  config: ProviderConfig,
  locale: UiLocale,
): string {
  const zh = locale === 'zh-CN';
  const lines = [
    zh
      ? `连接测试没有通过：${response.status} ${response.statusText}`
      : `Connection test failed: ${response.status} ${response.statusText}`,
  ];

  const trimmedBody = body.trim();
  if (trimmedBody) {
    lines.push(formatProviderErrorBody(trimmedBody, locale));
  }

  if (response.status === 401 || response.status === 403) {
    lines.push(
      zh
        ? [
            '可能原因：API Key 无效，或者当前 Key 没有使用所选模型的权限。',
            '请检查 BytePlus 控制台里的 Key、模型权限和额度状态。',
          ].join(' ')
        : [
            'Possible cause: the API key is invalid, or this key is not allowed to use the selected model.',
            'Check the key, model permissions, and quota status in the BytePlus console.',
          ].join(' '),
    );
  }

  if (response.status === 404) {
    lines.push(
      [
        zh ? '可能原因：接口地址不匹配。' : 'Possible cause: the API endpoint does not match this model.',
        zh
          ? `请使用 BytePlus /api/v3 根地址，不要填聊天专用或代码专用路径。当前地址：${config.baseUrl}`
          : `Use the BytePlus /api/v3 root URL, not a chat-only or coding-only path. Current URL: ${config.baseUrl}`,
      ].join(' '),
    );
  }

  if (response.status === 400) {
    lines.push(
      [
        zh
          ? '可能原因：所选模型和接口类型不匹配，或请求格式被服务端拒绝。'
          : 'Possible cause: the selected model does not match this API type, or the server rejected the request format.',
        zh
          ? `当前模型：${config.model}；当前地址：${config.baseUrl.replace(/\/+$/, '')}/responses。`
          : `Current model: ${config.model}; current URL: ${config.baseUrl.replace(/\/+$/, '')}/responses.`,
      ].join(' '),
    );
  }

  return lines.join('\n');
}

function resolveProviderMessageLocale(options?: ProviderRequestOptions): UiLocale {
  return options?.locale ?? normalizeUiLocale(process.env.ARTEMIS_LOCALE);
}

function formatProviderErrorBody(body: string, locale: 'zh-CN' | 'en'): string {
  const zh = locale === 'zh-CN';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; param?: unknown } };
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : '';
    const param = typeof parsed.error?.param === 'string' ? parsed.error.param : '';

    if (param === 'input.content.text' || message.includes('input.content.text')) {
      return zh
        ? '服务端提示：请求内容格式不符合该模型要求，缺少必要的文本内容。'
        : 'Server message: the request content format does not match this model; required text content is missing.';
    }

    if (message) {
      return zh ? `服务端提示：${message}` : `Server message: ${message}`;
    }
  } catch {
    // Keep the original body when the provider did not return JSON.
  }

  return body;
}

function buildProviderTransportErrorMessage(
  error: unknown,
  config: ProviderConfig,
  locale: UiLocale,
): string {
  const zh = locale === 'zh-CN';
  const message = error instanceof Error ? error.message : String(error);
  return zh
    ? [
        `还没有收到服务端响应：${message}`,
        `当前地址：${config.baseUrl}`,
        `当前模型：${config.model}`,
        '请检查网络连接、代理设置，以及 BytePlus 接口地址是否可访问。',
      ].join('\n')
    : [
        `No response was received from the server: ${message}`,
        `Current URL: ${config.baseUrl}`,
        `Current model: ${config.model}`,
        'Check your network connection, proxy settings, and whether the BytePlus endpoint is reachable.',
      ].join('\n');
}

function mapMessage(message: SessionMessage): ResponsesInputItem | null {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `[tool:${message.name ?? 'unknown'}]\n${message.content}`,
        },
      ],
    };
  }

  if (
    message.role !== 'system' &&
    message.role !== 'user' &&
    message.role !== 'assistant'
  ) {
    return null;
  }

  return {
    role: message.role,
    content: [
      {
        type: 'input_text',
        text: message.content,
      },
    ],
  };
}

function mapToolOutput(
  entry: ProviderNativeToolOutput,
): ResponsesFunctionCallOutputItem {
  return {
    type: 'function_call_output',
    call_id: entry.callId,
    output: entry.output,
  };
}

function collectTextFromUnknown(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextFromUnknown(entry));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const collected: string[] = [];

    if (typeof record.output_text === 'string') {
      collected.push(record.output_text);
    }

    if (typeof record.text === 'string') {
      collected.push(record.text);
    }

    if (typeof record.content === 'string') {
      collected.push(record.content);
    }

    if (record.content) {
      collected.push(...collectTextFromUnknown(record.content));
    }

    if (record.output) {
      collected.push(...collectTextFromUnknown(record.output));
    }

    if (record.message) {
      collected.push(...collectTextFromUnknown(record.message));
    }

    return collected;
  }

  return [];
}

function extractText(json: Record<string, unknown>): string {
  const text = collectTextFromUnknown(json)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return text;
}

function extractNativeToolCalls(
  json: Record<string, unknown>,
): ProviderNativeToolCall[] {
  const output = Array.isArray(json.output) ? json.output : [];
  const calls: ProviderNativeToolCall[] = [];

  for (const entry of output) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    if (
      record.type === 'function_call' &&
      typeof record.name === 'string' &&
      typeof record.arguments === 'string' &&
      typeof record.call_id === 'string'
    ) {
      calls.push({
        name: record.name,
        arguments: record.arguments,
        callId: record.call_id,
      });
    }
  }

  return calls;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class ResponsesCompatibleProvider implements ChatProvider {
  readonly supportsNativeToolCalls = true;
  readonly supportsImages = true;

  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async complete(
    messages: SessionMessage[],
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const startedAt = Date.now();
    const locale = resolveProviderMessageLocale(options);
    let response: Response;
    const payload: Record<string, unknown> = {
      model: this.config.model,
    };

    // Responses API reasoning (o-series / gpt-5 family). gpt-5.6+ takes
    // xhigh/max natively (GA 2026-07-09). 'ultra' is a MODE, not an effort
    // level (4 parallel agents + synthesis, gpt-5.6+ Responses only); OpenAI
    // docs still call it 'pro', so on a 400 we retry with the alternate name
    // and finally fall back to plain max effort.
    const fullScaleModel = /^gpt-5\.[6-9]/i.test(this.config.model);
    let reasoningCandidates: Array<Record<string, unknown> | undefined> = [undefined];
    if (this.config.effort && /^(o[134](-|\.|$)|gpt-5)/i.test(this.config.model)) {
      if (this.config.effort === 'ultra') {
        reasoningCandidates = fullScaleModel
          ? [{ mode: 'ultra' }, { mode: 'pro' }, { effort: 'xhigh' }]
          : [{ effort: 'high' }];
      } else {
        // Upstream-verified (2026-07-10): effort tops out at xhigh; 'max' is
        // not a real effort value even on gpt-5.6.
        reasoningCandidates = [{
          effort: fullScaleModel
            ? (this.config.effort === 'max' ? 'xhigh' : this.config.effort)
            : this.config.effort === 'xhigh' || this.config.effort === 'max' ? 'high' : this.config.effort,
        }];
      }
    }

    if (options?.previousResponseId) {
      payload.previous_response_id = options.previousResponseId;
      payload.input = (options.toolOutputs ?? []).map(mapToolOutput);
    } else {
      const input: Array<ResponsesInputItem | ResponsesFunctionCallOutputItem> = messages
        .map(mapMessage)
        .filter((entry): entry is ResponsesInputItem => entry !== null);
      if (options?.imageAttachments?.length) {
        injectImagesIntoInput(input, options.imageAttachments);
      }
      payload.input = input;
    }

    if ((options?.nativeFunctionTools?.length ?? 0) > 0) {
      payload.tools = options?.nativeFunctionTools as ProviderNativeFunctionTool[];
    }

    let attemptResponse: Response | undefined;
    for (let attempt = 0; attempt < reasoningCandidates.length; attempt++) {
      const reasoning = reasoningCandidates[attempt];
      if (reasoning) payload.reasoning = reasoning;
      else delete payload.reasoning;
      try {
        attemptResponse = await retryFetch(`${this.config.baseUrl.replace(/\/$/, '')}/responses`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: options?.abortSignal,
        }, {
          signal: options?.abortSignal,
          onRetry: options?.onRetry,
          onPayloadTooLarge: () => {
            const strippedInput = stripImagesFromResponsesInput(payload.input);
            if (!strippedInput) return null;
            payload.input = strippedInput;
            return JSON.stringify(payload);
          },
        });
      } catch (error) {
        if (options?.abortSignal?.aborted) {
          throw error;
        }
        throw new Error(buildProviderTransportErrorMessage(error, this.config, locale));
      }
      if (attemptResponse.ok) break;
      const body = await attemptResponse.text();
      // Only parameter rejections are worth a downgrade retry.
      if (attemptResponse.status === 400 && attempt < reasoningCandidates.length - 1) continue;
      throw new Error(buildProviderErrorMessage(attemptResponse, body, this.config, locale));
    }
    response = attemptResponse!;

    const json = (await response.json()) as Record<string, unknown>;
    const text = extractText(json);
    const nativeToolCalls = extractNativeToolCalls(json);

    if (!text && nativeToolCalls.length === 0) {
      throw new Error('Provider returned an empty responses payload.');
    }

    const usageRecord =
      json.usage && typeof json.usage === 'object'
        ? (json.usage as Record<string, unknown>)
        : undefined;
    const promptTokens =
      asNumber(usageRecord?.input_tokens) ?? asNumber(usageRecord?.prompt_tokens);
    const completionTokens =
      asNumber(usageRecord?.output_tokens) ?? asNumber(usageRecord?.completion_tokens);
    const totalTokens =
      asNumber(usageRecord?.total_tokens) ??
      (typeof promptTokens === 'number' && typeof completionTokens === 'number'
        ? promptTokens + completionTokens
        : undefined);

    return {
      text,
      raw: json,
      model: typeof json.model === 'string' ? json.model : this.config.model,
      responseId: typeof json.id === 'string' ? json.id : undefined,
      nativeToolCalls,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs: Math.max(Date.now() - startedAt, 0),
        firstResponseMs: Math.max(Date.now() - startedAt, 0),
      },
    };
  }
}
