import type { SessionMessage } from '../core/types.js';
import { createProviderFromConfig, normalizeProviderProtocol } from './factory.js';
import type {
  ChatProvider,
  ProviderConfig,
  ProviderNativeFunctionTool,
} from './types.js';

export type InlineProviderConfigInspection =
  | {
      status: 'none';
    }
  | {
      status: 'incomplete';
      missing: Array<'model' | 'baseUrl' | 'apiKey'>;
    }
  | {
      status: 'complete';
      config: ProviderConfig;
    };

export type ProviderProbeResult = {
  ok: boolean;
  latencyMs: number;
  message: string;
};

const NATIVE_TOOL_PROBE_NAME = 'artemis_native_tool_probe';

const NATIVE_TOOL_PROBE_DEF: ProviderNativeFunctionTool = {
  type: 'function',
  name: NATIVE_TOOL_PROBE_NAME,
  description: 'Internal compatibility probe. Call this function exactly once when instructed.',
  parameters: {
    type: 'object',
    properties: {
      probe: {
        type: 'string',
        description: 'Return the literal string "ok".',
      },
    },
    required: ['probe'],
  },
};

function isGoogleGeminiProvider(config: ProviderConfig, message: string): boolean {
  const lowerMessage = message.toLowerCase();
  const lowerBaseUrl = config.baseUrl.toLowerCase();
  return (
    lowerBaseUrl.includes('generativelanguage.googleapis.com') ||
    lowerMessage.includes('generativelanguage.googleapis.com') ||
    lowerMessage.includes('googleapis.com')
  );
}

function appendProbeDiagnosis(message: string, config: ProviderConfig, locale: 'zh-CN' | 'en' = 'en'): string {
  const lower = message.toLowerCase();
  const hints: string[] = [];
  const googleGemini = isGoogleGeminiProvider(config, message);
  const authenticationFailed =
    /401|403|unauthorized|forbidden|authentication|auth token|api key|invalid key|invalid_api_key|api_key_invalid/i.test(
      message,
    );
  const modelMismatch =
    /model|no such model|unknown model|model.*not found|does not exist/i.test(lower);
  const pathMismatch = /404|not found/i.test(lower) && !/model/i.test(lower);
  const protocolMismatch =
    /400|bad request|unsupported|anthropic-version|chat\/completions|messages|invalid request/i.test(
      lower,
    );
  const networkFailure =
    /timed out|timeout|econnrefused|enotfound|fetch failed|network|socket|connect/i.test(
      lower,
    );

  if (
    googleGemini &&
    /api_key_invalid|api key not valid|invalid api key|authentication/i.test(lower)
  ) {
    return locale === 'zh-CN' 
      ? [
          message,
          '可能的问题：这个 Google Gemini API 密钥无效，或未启用 Gemini API。',
          '请使用 Google AI Studio / Gemini API 提供的密钥，对应 generativelanguage.googleapis.com。',
          '如果您想使用其他供应商，请返回并切换供应商预设或基础 URL 后重试。',
        ].join('\n')
      : [
          message,
          'Likely issue: this Google Gemini API key is invalid or not enabled for the Gemini API.',
          'Use a key from Google AI Studio / Gemini API for generativelanguage.googleapis.com.',
          'If you meant to use another provider, go back and switch the provider preset or base URL before retrying.',
        ].join('\n');
  }

  if (authenticationFailed) {
    hints.push(locale === 'zh-CN' ? '可能的问题：认证失败。请检查 API 密钥或令牌。' : 'Likely issue: authentication failed. Check the API key or token.');
  }

  if (modelMismatch) {
    hints.push(locale === 'zh-CN' ? '可能的问题：模型名称对这个供应商来说不正确。' : 'Likely issue: the model name is incorrect for this provider.');
  }

  if (pathMismatch) {
    hints.push(
      locale === 'zh-CN' 
        ? `可能的问题：基础 URL 错误，或所选的 ${config.protocol} 协议与该端点不匹配。`
        : `Likely issue: the base URL is wrong, or the selected ${config.protocol} protocol does not match this endpoint.`,
    );
  }

  if (protocolMismatch && !authenticationFailed) {
    hints.push(
      locale === 'zh-CN' 
        ? '可能的问题：端点期望不同的协议。尝试在 OpenAI 兼容和 Messages 兼容之间切换。'
        : 'Likely issue: the endpoint expects a different protocol. Try switching between OpenAI-compatible and Messages-compatible.',
    );
  }

  if (networkFailure) {
    hints.push(locale === 'zh-CN' ? '可能的问题：URL 无法访问、被阻止，或者缺少正确的路径。' : 'Likely issue: the URL is unreachable, blocked, or missing the correct path.');
  }

  const uniqueHints = hints.filter((hint, index) => hints.indexOf(hint) === index);
  
  const sections = [
    locale === 'zh-CN' ? `\x1b[1;31m错误详情：\x1b[0m` : `\x1b[1;31mError Details:\x1b[0m`,
    message,
  ];

  if (uniqueHints.length > 0) {
    sections.push(locale === 'zh-CN' ? `\x1b[1;33m可能的诊断：\x1b[0m` : `\x1b[1;33mPossible Diagnosis:\x1b[0m`);
    sections.push(...uniqueHints.map(h => (locale === 'zh-CN' ? `• ${h}` : `• ${h}`)));
  }

  return sections.join('\n');
}

function normalizeProbeReply(text: string): string {
  return text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?。！？]+$/u, '')
    .trim()
    .toUpperCase();
}

/**
 * Some models (e.g. GLM 5.1 thinking, Qwen reasoning variants) do not return
 * the exact literal "OK" — they may prepend or append chain-of-thought text.
 * The connection probe asks for "OK"; if the model clearly intended to say OK,
 * the connection is verified.
 *
 * Known patterns:
 *   - GLM 5.1:   "OK\n---\nHello! How can I help you today?"
 *                (OK at the start, then model adds unprompted follow-up)
 *   - DeepThink: "... 2. Formulate the Output:\nOK"
 *                (chain-of-thought before OK)
 *   - Seedance:  "OK" with reasoning in a separate reasoning_content field
 *                (content field is clean, this case is already handled)
 */
function probeReplyLooksLikeOK(raw: string): boolean {
  const normalized = normalizeProbeReply(raw);
  if (normalized === 'OK') return true;
  // Match "OK" at the end of the text (chain-of-thought before OK)
  if (/(?:^|\s)OK$/.test(normalized)) return true;
  // Match "OK" at the start of the text (GLM 5.1 pattern: "OK\n---\n...")
  if (/^OK(?:\s|$)/.test(normalized)) return true;
  return false;
}

export function inspectInlineProviderConfig(config: {
  protocol?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}): InlineProviderConfigInspection {
  const hasAny =
    Boolean(config.model) || Boolean(config.baseUrl) || Boolean(config.apiKey);

  if (!hasAny) {
    return {
      status: 'none',
    };
  }

  const missing: Array<'model' | 'baseUrl' | 'apiKey'> = [];
  if (!config.model) {
    missing.push('model');
  }
  if (!config.baseUrl) {
    missing.push('baseUrl');
  }
  if (!config.apiKey) {
    missing.push('apiKey');
  }

  if (missing.length > 0) {
    return {
      status: 'incomplete',
      missing,
    };
  }

  const model = config.model as string;
  const baseUrl = config.baseUrl as string;
  const apiKey = config.apiKey as string;

    return {
      status: 'complete',
      config: {
        protocol: normalizeProviderProtocol(config.protocol),
        model,
        baseUrl,
        apiKey,
      },
    };
}

export async function probeProviderConfig(
  config: ProviderConfig,
  options?: {
    provider?: ChatProvider;
    timeoutMs?: number;
    locale?: 'zh-CN' | 'en';
  },
): Promise<ProviderProbeResult> {
  const provider =
    options?.provider ?? createProviderFromConfig(config);
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const locale = options?.locale ?? 'en';
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;

  const probeMessages: SessionMessage[] = [
    {
      id: 'provider-probe',
      role: 'user',
      content: 'Reply with exactly OK.',
      createdAt: new Date().toISOString(),
    },
  ];

  try {
    const response = await Promise.race([
      provider.complete(probeMessages),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Provider connection test timed out after ${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
    const latencyMs = Date.now() - startedAt;
    const text = response.text.trim();

    if (!probeReplyLooksLikeOK(text)) {
      const normalizedText = normalizeProbeReply(text);
      return {
        ok: false,
        latencyMs,
        message: appendProbeDiagnosis(
          normalizedText
            ? `Provider responded, but the probe reply was "${text.length > 200 ? text.slice(0, 200) + '…' : text}" instead of "OK".`
            : 'Provider responded with an empty reply.',
          config,
          locale,
        ),
      };
    }

    return {
      ok: true,
      latencyMs,
      message: `Provider connection test passed in ${latencyMs}ms.`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: appendProbeDiagnosis(
        error instanceof Error ? error.message : String(error),
        config,
        locale,
      ),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function probeProviderNativeToolCalls(
  config: ProviderConfig,
  options?: {
    provider?: ChatProvider;
    timeoutMs?: number;
    locale?: 'zh-CN' | 'en';
  },
): Promise<ProviderProbeResult> {
  const provider =
    options?.provider ?? createProviderFromConfig(config);
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const locale = options?.locale ?? 'en';
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;

  if (provider.supportsNativeToolCalls !== true) {
    return {
      ok: false,
      latencyMs: 0,
      message: [
        locale === 'zh-CN' ? '该客户端未声明支持原生工具调用。' : 'This client does not advertise native tool calling.',
        `Selected protocol: ${config.protocol}.`,
      ].join('\n'),
    };
  }

  const probeMessages: SessionMessage[] = [
    {
      id: 'provider-native-tool-probe',
      role: 'user',
      content: `Do not answer with text. Call the function ${NATIVE_TOOL_PROBE_NAME} exactly once with {"probe":"ok"}.`,
      createdAt: new Date().toISOString(),
    },
  ];

  try {
    const response = await Promise.race([
      provider.complete(probeMessages, {
        nativeFunctionTools: [NATIVE_TOOL_PROBE_DEF],
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Provider native tool probe timed out after ${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
    const latencyMs = Date.now() - startedAt;
    const matchingCall = (response.nativeToolCalls ?? []).find(
      (call) => call.name === NATIVE_TOOL_PROBE_NAME,
    );

    if (!matchingCall) {
      const text = response.text.trim();
      return {
        ok: false,
        latencyMs,
        message: [
          locale === 'zh-CN' ? 'Provider 已响应，但未发出所需的原生工具调用。' : 'Provider responded, but did not emit the required native tool call.',
          `Expected native tool: ${NATIVE_TOOL_PROBE_NAME}.`,
          `Text reply: ${text ? `"${text}"` : '(empty)'}.`,
          locale === 'zh-CN' ? `可能的问题：这个 ${config.protocol} 端点实际上不支持代理工作流的原生工具调用。` : `Likely issue: this ${config.protocol} endpoint does not actually support native tool calling for agent workflows.`,
        ].join('\n'),
      };
    }

    return {
      ok: true,
      latencyMs,
      message: `Provider native tool probe passed in ${latencyMs}ms.`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: appendProbeDiagnosis(
        error instanceof Error ? error.message : String(error),
        config,
        locale,
      ),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
