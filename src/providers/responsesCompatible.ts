import type { SessionMessage } from '../core/types.js';
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

  if (response.status === 401 || response.status === 403) {
    lines.push(
      [
        'Hint: the API key was rejected.',
        'Check that this BytePlus key is valid and allowed to access the selected model.',
      ].join(' '),
    );
  }

  if (response.status === 404) {
    lines.push(
      [
        'Hint: this client uses the BytePlus Responses API and appends /responses.',
        `Check that the base URL (${config.baseUrl}) is the BytePlus /api/v3 root, not a chat-only or coding-only path.`,
      ].join(' '),
    );
  }

  if (response.status === 400) {
    lines.push(
      [
        `Hint: verify that the selected model (${config.model}) is a Responses-capable BytePlus model for ${config.baseUrl.replace(/\/+$/, '')}/responses.`,
        'Chat-completions models and Coding-only endpoints can return 400-level request errors here.',
      ].join(' '),
    );
  }

  return lines.join('\n');
}

function buildProviderTransportErrorMessage(
  error: unknown,
  config: ProviderConfig,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    `Provider request failed before an HTTP response was received: ${message}`,
    `Requested URL root: ${config.baseUrl}`,
    `Requested model: ${config.model}`,
    'Hint: check the BytePlus base URL, local network access, and any proxy or gateway settings.',
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
    let response: Response;
    const payload: Record<string, unknown> = {
      model: this.config.model,
    };

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

    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new Error(buildProviderTransportErrorMessage(error, this.config));
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(buildProviderErrorMessage(response, body, this.config));
    }

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
