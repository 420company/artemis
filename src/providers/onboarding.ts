import { CliSettingsStore } from '../cli/settings.js';
import { homedir } from 'node:os';
import { ensureUiLocaleConfigured } from '../cli/localeSetup.js';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import { choosePromptOption } from '../cli/prompt.js';
import { buildPanel } from '../cli/ui.js';
import { formatProviderProtocolLabel } from './factory.js';
import { formatProviderProfileTelemetry } from './telemetry.js';
import { buildApiKeyHeaders } from './openaiCompatible.js';
import {
  inspectInlineProviderConfig,
  probeProviderConfig,
  probeProviderNativeToolCalls,
} from './health.js';
import {
  PROVIDER_PRESETS,
  formatProviderPresetDefaultAlias,
  formatProviderPresetLabel,
  type ProviderPreset,
} from './presets.js';
import { ProviderStore } from './store.js';
import type {
  PromptIO,
  ProviderApiKeyHeader,
  ProviderConfig,
  ProviderProfile,
  ProviderProtocol,
  ProviderStoreData,
} from './types.js';

const BACK = '__back__' as const;
type ProtocolChoice = ProviderProtocol | 'auto';

type PromptProfileOptions = {
  heading: string;
  defaultAlias: string;
  defaultIdPrefix: string;
  cancellationLabel: string;
  fixedId?: string;
  defaultProtocol?: ProviderProtocol;
  defaultBaseUrl?: string;
  defaultModel?: string;
  defaultApiKey?: string;
};

type PromptedProviderProfileResult = {
  profile: ProviderProfile;
  autoDetectProtocol: boolean;
};

type ResolvedPreset = {
  preset: ProviderPreset;
  providerLabel: string;
  defaultAlias: string;
  suggestedModels: string[];
  notes: string[];
  defaultProtocol?: ProviderProtocol;
  baseUrls?: Partial<Record<ProviderProtocol, string[]>>;
  apiKeyHeader?: ProviderApiKeyHeader;
};

type BytePlusFamily =
  | 'coding'
  | 'chat'
  | 'responses'
  | 'image'
  | 'video'
  | 'embedding'
  | 'memory'
  | 'unknown';

type OpenCodeZenFamily = 'responses' | 'messages' | 'chat' | 'unsupported';
type OpenCodeGoFamily = 'messages' | 'chat';

function normalizeOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function slugifyProfileId(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function buildUniqueProfileId(data: ProviderStoreData, requestedId: string): string {
  const existing = new Set(data.profiles.map((profile) => profile.id));
  if (!existing.has(requestedId)) {
    return requestedId;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const nextId = `${requestedId}-${index}`;
    if (!existing.has(nextId)) {
      return nextId;
    }
  }
  return `${requestedId}-${Date.now()}`;
}

function maskApiKey(apiKey: string): string {
  return apiKey.length <= 8
    ? `${apiKey.slice(0, 2)}****`
    : `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}

function detectBytePlusFamily(model: string): BytePlusFamily {
  const lower = model.trim().toLowerCase();
  if (!lower) return 'unknown';
  if (/seed-2-0-(lite|pro|mini)-|seed-2-0-code-preview-/i.test(lower)) return 'responses';
  if (/seedream-/i.test(lower)) return 'image';
  if (/seedance-/i.test(lower)) return 'video';
  if (/skylark-embedding-/i.test(lower)) return 'embedding';
  if (/ark-code-latest|dola-seed-2\.0-(pro|lite|code)$|bytedance-seed-code|kimi-k2\.5$|kimi-k2-thinking$|glm-5\.1$|glm-4\.7$|gpt-oss-120b(?:-[0-9]+)?$/i.test(lower)) return 'coding';
  if (/deepseek-|kimi-k2-thinking-|gpt-oss-120b-|skylark-pro-|seed-1-8-|seed-1-6-|seed-1-6-flash-|glm-4-7-/i.test(lower)) return 'chat';
  return 'unknown';
}

function alignBytePlus(
  protocol: ProviderProtocol,
  baseUrl: string,
  model: string,
): { protocol: ProviderProtocol; baseUrl: string; family: BytePlusFamily } {
  const family = detectBytePlusFamily(model);
  let nextProtocol = protocol;
  let nextBaseUrl = baseUrl;
  if (family === 'chat') {
    nextProtocol = 'openai';
    if (nextBaseUrl.toLowerCase().includes('ark.ap-southeast.bytepluses.com')) {
      nextBaseUrl = 'https://ark.ap-southeast.bytepluses.com/api/v3';
    }
  } else if (family === 'coding') {
    if (nextProtocol === 'messages') {
      if (nextBaseUrl.toLowerCase().includes('ark.ap-southeast.bytepluses.com')) {
        nextBaseUrl = 'https://ark.ap-southeast.bytepluses.com/api/coding';
      }
    } else {
      nextProtocol = 'openai';
      if (nextBaseUrl.toLowerCase().includes('ark.ap-southeast.bytepluses.com')) {
        nextBaseUrl = 'https://ark.ap-southeast.bytepluses.com/api/coding/v3';
      }
    }
  } else if (family === 'responses') {
    nextProtocol = 'responses';
    if (nextBaseUrl.toLowerCase().includes('ark.ap-southeast.bytepluses.com')) {
      nextBaseUrl = 'https://ark.ap-southeast.bytepluses.com/api/v3';
    }
  }
  return { protocol: nextProtocol, baseUrl: nextBaseUrl, family };
}

function detectOpenCodeZenFamily(model: string): OpenCodeZenFamily {
  const lower = model.trim().toLowerCase();
  if (!lower) return 'chat';
  if (lower.startsWith('gpt-')) return 'responses';
  if (lower.startsWith('claude-')) return 'messages';
  if (lower.startsWith('gemini-')) return 'unsupported';
  return 'chat';
}

function alignOpenCodeZen(
  model: string,
): {
  protocol?: ProviderProtocol;
  baseUrl?: string;
  family: OpenCodeZenFamily;
  guardrail?: string[];
} {
  const family = detectOpenCodeZenFamily(model);
  if (family === 'responses') {
    return {
      family,
      protocol: 'responses',
      baseUrl: 'https://opencode.ai/zen/v1',
    };
  }
  if (family === 'messages') {
    return {
      family,
      protocol: 'messages',
      baseUrl: 'https://opencode.ai/zen',
    };
  }
  if (family === 'unsupported') {
    return {
      family,
      guardrail: [
        'This OpenCode Zen model uses a provider-specific endpoint that the current Artemis runtime does not speak directly.',
        'For Gemini models, use the native Google Gemini provider instead of OpenCode Zen.',
      ],
    };
  }
  return {
    family,
    protocol: 'openai',
    baseUrl: 'https://opencode.ai/zen/v1',
  };
}

function detectOpenCodeGoFamily(model: string): OpenCodeGoFamily {
  const lower = model.trim().toLowerCase();
  if (lower.startsWith('minimax-')) return 'messages';
  return 'chat';
}

function alignOpenCodeGo(
  model: string,
): { protocol: ProviderProtocol; baseUrl: string; family: OpenCodeGoFamily } {
  const family = detectOpenCodeGoFamily(model);
  if (family === 'messages') {
    return {
      family,
      protocol: 'messages',
      baseUrl: 'https://opencode.ai/zen/go',
    };
  }
  return {
    family,
    protocol: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
  };
}

async function resolveLocale(options: {
  cwd: string;
  promptIO?: PromptIO;
  onInfo?: (message: string) => void;
}): Promise<UiLocale> {
  if (options.promptIO?.available) {
    return ensureUiLocaleConfigured(options);
  }
  return (await new CliSettingsStore(options.cwd).load()).uiLocale;
}

async function askText(
  promptIO: PromptIO | undefined,
  prompt: string,
  defaultValue?: string,
  mask = false,
): Promise<string> {
  const raw = (await promptIO?.ask(prompt, mask)) ?? ''
  return normalizeOptional(raw) ?? defaultValue ?? ''
}

function buildModelsUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl.trim());
    const path = url.pathname.replace(/\/+$/, '');
    if (path.endsWith('/models')) {
      return url.toString();
    }
    if (path.endsWith('/chat/completions')) {
      url.pathname = path.slice(0, -'/chat/completions'.length) + '/models';
      return url.toString();
    }
    if (path.endsWith('/responses')) {
      url.pathname = path.slice(0, -'/responses'.length) + '/models';
      return url.toString();
    }
    url.pathname = `${path || ''}/models`;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function probeOpenAiModelIds(
  baseUrl: string,
  apiKey: string,
  apiKeyHeader?: ProviderApiKeyHeader,
): Promise<string[]> {
  const url = buildModelsUrl(baseUrl);
  if (!url) return [];
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...buildApiKeyHeaders(apiKey, apiKeyHeader),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return [];
    const body = await response.json() as unknown;
    const data = typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [];
    return data
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string') {
          return (entry as { id: string }).id;
        }
        return '';
      })
      .filter(Boolean)
      .slice(0, 200);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function askProviderPreset(
  promptIO: PromptIO | undefined,
  locale: UiLocale,
): Promise<ProviderPreset | typeof BACK> {
  const runtimeReadyPresets = PROVIDER_PRESETS.filter((preset) => preset.runtimeReady !== false)
  return choosePromptOption<ProviderPreset | typeof BACK>(promptIO, {
    title: pickLocale(locale, { zh: '选择 Provider', en: 'Choose provider' }),
    initialIndex: 0,
    escapeValue: BACK,
    choices: [
      ...runtimeReadyPresets.map((preset) => ({
        label: formatProviderPresetLabel(preset, locale),
        value: preset,
      })),
      { label: pickLocale(locale, { zh: '取消', en: 'Cancel' }), value: BACK },
    ],
  });
}

async function resolvePreset(
  promptIO: PromptIO | undefined,
  locale: UiLocale,
  preset: ProviderPreset,
): Promise<ResolvedPreset | typeof BACK> {
  if (preset.id !== 'byteplus') {
    return {
      preset,
      providerLabel: formatProviderPresetLabel(preset, locale),
      defaultAlias: formatProviderPresetDefaultAlias(preset, locale),
      suggestedModels: preset.suggestedModels,
      notes: preset.notes[locale === 'zh-CN' ? 'zh' : 'en'],
      defaultProtocol: preset.protocol,
      baseUrls: preset.protocol && preset.baseUrl ? { [preset.protocol]: [preset.baseUrl] } : undefined,
      apiKeyHeader: preset.apiKeyHeader,
    };
  }

  const family = await choosePromptOption(promptIO, {
    title: pickLocale(locale, { zh: '选择 BytePlus 用途', en: 'Choose the BytePlus profile type' }),
    initialIndex: 0,
    escapeValue: BACK,
    choices: [
      {
        label: 'Coding',
        value: 'coding' as const,
        description: pickLocale(locale, {
          zh: '写代码、改代码、工具调用',
          en: 'Code generation, edits, and tool calling',
        }),
      },
      {
        label: 'Chat / Reasoning',
        value: 'chat' as const,
        description: pickLocale(locale, {
          zh: '普通聊天和推理模型',
          en: 'General chat and reasoning models',
        }),
      },
      {
        label: 'Responses + MCP',
        value: 'responses' as const,
        description: pickLocale(locale, {
          zh: 'Responses API / MCP 场景',
          en: 'Responses API and MCP workflows',
        }),
      },
      { label: pickLocale(locale, { zh: '返回', en: 'Back' }), value: BACK },
    ],
  });

  if (family === BACK) {
    return BACK;
  }

  if (family === 'coding') {
    return {
      preset,
      providerLabel: 'BytePlus Coding',
      defaultAlias: pickLocale(locale, { zh: 'BytePlus Coding 模型', en: 'BytePlus Coding model' }),
      suggestedModels: [
        'ark-code-latest',
        'dola-seed-2.0-pro',
        'dola-seed-2.0-lite',
        'dola-seed-2.0-code',
        'bytedance-seed-code',
        'glm-5.1',
        'glm-4.7',
        'kimi-k2.5',
        'gpt-oss-120b',
      ],
      notes: [
        pickLocale(locale, {
          zh: '默认使用 Coding 接口（/api/coding/v3）；官方 Quick Start 明确列出 dola-seed-2.0-pro / dola-seed-2.0-lite / bytedance-seed-code / glm-4.7 / kimi-k2.5 / gpt-oss-120b，这里额外保留你提供的海外端点可见模型 dola-seed-2.0-code / glm-5.1 作为补充。',
          en: 'Uses the Coding endpoint (/api/coding/v3) by default. The official Quick Start explicitly lists dola-seed-2.0-pro / dola-seed-2.0-lite / bytedance-seed-code / glm-4.7 / kimi-k2.5 / gpt-oss-120b; this picker also keeps dola-seed-2.0-code / glm-5.1 because they appeared in the international endpoint inventory you provided.',
        }),
      ],
      defaultProtocol: 'openai',
      baseUrls: {
        openai: ['https://ark.ap-southeast.bytepluses.com/api/coding/v3'],
      },
    };
  }

  if (family === 'chat') {
    return {
      preset,
      providerLabel: 'BytePlus Chat / Reasoning',
      defaultAlias: pickLocale(locale, { zh: 'BytePlus 推理模型', en: 'BytePlus reasoning model' }),
      suggestedModels: [
        'seed-1-8-251228',
        'seed-1-6-250915',
        'seed-1-6-flash-250715',
        'glm-4-7-251222',
        'deepseek-v3-2-251201',
        'gpt-oss-120b-250805',
      ],
      notes: [
        pickLocale(locale, {
          zh: '默认使用常规聊天接口（/api/v3）；推荐列表已按海外版 ModelArk 当前通用文本模型同步。',
          en: 'Uses the standard chat endpoint (/api/v3) by default; the suggested list matches the current international ModelArk text lineup.',
        }),
      ],
      defaultProtocol: 'openai',
      baseUrls: { openai: ['https://ark.ap-southeast.bytepluses.com/api/v3'] },
    };
  }

  return {
    preset,
    providerLabel: 'BytePlus Responses',
    defaultAlias: pickLocale(locale, { zh: 'BytePlus Responses 模型', en: 'BytePlus Responses model' }),
    suggestedModels: [
      'seed-2-0-pro-260328',
      'seed-2-0-lite-260228',
      'seed-2-0-mini-260215',
      'seed-2-0-code-preview-260328',
    ],
    notes: [
      pickLocale(locale, {
        zh: '默认使用 Responses 接口（/api/v3/responses）；seed-2.0 系列与 code-preview 已按海外版官方模型表同步。',
        en: 'Uses the Responses endpoint (/api/v3/responses) by default; the Seed 2.0 line and code-preview model match the official international model list.',
      }),
    ],
    defaultProtocol: 'responses',
    baseUrls: { responses: ['https://ark.ap-southeast.bytepluses.com/api/v3'] },
  };
}

async function askProtocol(
  promptIO: PromptIO | undefined,
  locale: UiLocale,
  defaultValue: ProtocolChoice,
  allowAuto: boolean,
): Promise<ProtocolChoice | typeof BACK> {
  const choices = [
    ...(allowAuto
      ? [{ label: pickLocale(locale, { zh: '自动探测', en: 'Auto-detect' }), value: 'auto' as const }]
      : []),
    { label: 'OpenAI-compatible', value: 'openai' as const },
    { label: 'Messages-compatible', value: 'messages' as const },
    { label: 'Responses API', value: 'responses' as const },
    { label: pickLocale(locale, { zh: '返回', en: 'Back' }), value: BACK },
  ];

  const initialIndex = Math.max(
    choices.findIndex((choice) => choice.value === defaultValue),
    0,
  );

  return choosePromptOption(promptIO, {
    title: pickLocale(locale, { zh: '选择 Provider 协议', en: 'Choose provider protocol' }),
    initialIndex,
    escapeValue: BACK,
    choices,
  });
}

async function askBaseUrl(
  promptIO: PromptIO | undefined,
  locale: UiLocale,
  baseUrls: string[],
  defaultValue?: string,
): Promise<string | typeof BACK> {
  const choices = [
    ...((defaultValue && !baseUrls.includes(defaultValue)) ? [defaultValue, ...baseUrls] : baseUrls).map((url) => ({
      label: url,
      value: url,
    })),
    { label: pickLocale(locale, { zh: '自定义 URL', en: 'Custom URL' }), value: '__custom__' },
    { label: pickLocale(locale, { zh: '返回', en: 'Back' }), value: BACK },
  ];
  const selected = await choosePromptOption(promptIO, {
    title: pickLocale(locale, { zh: '选择 API URL', en: 'Choose API URL' }),
    initialIndex: 0,
    escapeValue: BACK,
    choices,
  });
  if (selected === BACK) return BACK;
  return selected === '__custom__'
    ? askText(promptIO, pickLocale(locale, { zh: '输入 API URL: ', en: 'API URL: ' }), defaultValue)
    : selected;
}

async function askModel(
  promptIO: PromptIO | undefined,
  locale: UiLocale,
  models: string[],
  defaultValue?: string,
): Promise<string | typeof BACK> {
  const choices = [
    ...((defaultValue && !models.includes(defaultValue)) ? [defaultValue, ...models] : models).map((model) => ({
      label: model,
      value: model,
    })),
    { label: pickLocale(locale, { zh: '自定义模型', en: 'Custom model' }), value: '__custom__' },
    { label: pickLocale(locale, { zh: '返回', en: 'Back' }), value: BACK },
  ];
  const selected = await choosePromptOption(promptIO, {
    title: pickLocale(locale, { zh: '选择模型', en: 'Choose model' }),
    initialIndex: 0,
    escapeValue: BACK,
    choices,
  });
  if (selected === BACK) return BACK;
  return selected === '__custom__'
    ? askText(promptIO, pickLocale(locale, { zh: '输入模型名: ', en: 'Model name: ' }), defaultValue)
    : selected;
}

export async function promptForProviderProfile(
  promptIO: PromptIO | undefined,
  data: ProviderStoreData,
  options: PromptProfileOptions,
  locale: UiLocale = 'en',
): Promise<PromptedProviderProfileResult | undefined> {
  for (;;) {
    const preset = await askProviderPreset(promptIO, locale);
    if (preset === BACK) return undefined;

    const resolved = await resolvePreset(promptIO, locale, preset);
    if (resolved === BACK) continue;

    promptIO?.write(
      buildPanel(options.heading, [
        `Provider: ${resolved.providerLabel}`,
        ...resolved.notes,
      ]),
    );

    const alias =
      await askText(
        promptIO,
        pickLocale(locale, { zh: '显示名称（留空使用默认）: ', en: 'Display name (leave blank for default): ' }),
        options.defaultAlias || resolved.defaultAlias,
      ) || resolved.defaultAlias;

    const protocolChoice =
      resolved.defaultProtocol ??
      (await askProtocol(
        promptIO,
        locale,
        options.defaultProtocol ?? 'openai',
        preset.id === 'custom',
      ));
    if (protocolChoice === BACK) continue;

    let protocol: ProviderProtocol = protocolChoice === 'auto' ? 'openai' : protocolChoice;
    const baseUrl = await askBaseUrl(
      promptIO,
      locale,
      resolved.baseUrls?.[protocol] ?? [],
      options.defaultBaseUrl,
    );
    if (baseUrl === BACK) continue;

    let finalBaseUrl = baseUrl;
    let apiKey = '';
    if (preset.id === 'custom') {
      apiKey = await askText(
        promptIO,
        pickLocale(locale, { zh: 'API key（可选，用于 /models 探测和后续调用）: ', en: 'API key (optional, used for /models probing and calls): ' }),
        options.defaultApiKey,
        true,
      );
    }

    let probedModels: string[] = [];
    if (preset.id === 'custom') {
      promptIO?.write(
        buildPanel(options.heading, [
          `Provider: ${resolved.providerLabel}`,
          `Base URL: ${finalBaseUrl}`,
          pickLocale(locale, { zh: '正在尝试读取 /models 列表。失败也可以手动输入模型名。', en: 'Trying to read /models. If it fails, you can still type a model name.' }),
        ]),
      );
      probedModels = await probeOpenAiModelIds(finalBaseUrl, apiKey, resolved.apiKeyHeader);
      promptIO?.write(
        buildPanel(options.heading, [
          `Provider: ${resolved.providerLabel}`,
          `Base URL: ${finalBaseUrl}`,
          probedModels.length > 0
            ? pickLocale(locale, { zh: `已发现 ${probedModels.length} 个模型。`, en: `Found ${probedModels.length} model(s).` })
            : pickLocale(locale, { zh: '未能读取模型列表；继续手动输入模型名。', en: 'Could not read the model list; continuing with manual model entry.' }),
        ]),
      );
    }

    let finalModel: string | undefined;
    let contextLength: number | undefined;
    for (;;) {
      const model = await askModel(
        promptIO,
        locale,
        probedModels.length > 0 ? probedModels : resolved.suggestedModels,
        options.defaultModel,
      );
      if (model === BACK) break;
      if (preset.id === 'byteplus') {
        const aligned = alignBytePlus(protocol, finalBaseUrl, model);
        if (aligned.family === 'image' || aligned.family === 'video' || aligned.family === 'embedding') {
          promptIO?.write(
            buildPanel('Provider guardrail', [
              'This model cannot be used as a main chat provider.',
              aligned.family === 'image'
                ? 'Use an image-generation endpoint instead.'
                : aligned.family === 'video'
                  ? 'Use a video-generation endpoint instead.'
                  : 'Use an embedding or retrieval endpoint instead.',
            ]),
          );
          continue;
        }
        protocol = aligned.protocol;
        finalBaseUrl = aligned.baseUrl;
      } else if (preset.id === 'opencode-zen') {
        const aligned = alignOpenCodeZen(model);
        if (aligned.guardrail) {
          promptIO?.write(
            buildPanel('Provider guardrail', aligned.guardrail),
          );
          continue;
        }
        protocol = aligned.protocol ?? protocol;
        finalBaseUrl = aligned.baseUrl ?? finalBaseUrl;
      } else if (preset.id === 'opencode-go') {
        const aligned = alignOpenCodeGo(model);
        protocol = aligned.protocol;
        finalBaseUrl = aligned.baseUrl;
      }
      finalModel = model;
      break;
    }
    if (!finalModel) continue;

    if (preset.id === 'custom') {
      const contextRaw = await askText(
        promptIO,
        pickLocale(locale, { zh: 'Context length tokens（留空自动）: ', en: 'Context length in tokens (blank = auto): ' }),
      );
      const normalized = contextRaw.trim().toLowerCase().replace(/k$/, '000');
      const parsedContext = Number(normalized);
      if (Number.isFinite(parsedContext) && parsedContext > 0) {
        contextLength = Math.round(parsedContext);
      }
    } else {
      apiKey = await askText(
        promptIO,
        pickLocale(locale, { zh: 'API key: ', en: 'API key: ' }),
        options.defaultApiKey,
        true,
      );
    }

    const requestedId = options.fixedId ?? slugifyProfileId(alias, options.defaultIdPrefix);
    const id = options.fixedId ? requestedId : buildUniqueProfileId(data, requestedId);

    return {
      profile: {
        id,
        label: alias,
        protocol,
        baseUrl: finalBaseUrl,
        model: finalModel,
        apiKey,
        apiKeyHeader: resolved.apiKeyHeader,
        contextLength,
      },
      autoDetectProtocol: protocolChoice === 'auto',
    };
  }
}

// Run an async probe while showing a live progress panel. The panel redraws
// every 500ms with a spinner, elapsed-time counter, and a growing bar so the
// user can tell the CLI hasn't frozen. Output goes through promptIO.write so
// the onboarding alt-screen stays in sync.
async function runWithProgress<T>(
  promptIO: PromptIO | undefined,
  locale: UiLocale,
  message: string,
  task: () => Promise<T>,
): Promise<T> {
  if (!promptIO) return task();

  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const BAR_TOTAL = 24;
  const EXPECTED_MS = 30_000; // calibrated so the bar creeps but won't finish
  const start = Date.now();
  let tick = 0;
  let done = false;

  const title = pickLocale(locale, { zh: '正在验证 Provider', en: 'Verifying provider' });
  const hint = pickLocale(locale, {
    zh: '提示：慢速网络或冷启动的边缘模型首次验证可能较久，请勿关闭窗口。',
    en: 'Note: slow networks or cold-start edge models can take a while — keep the window open.',
  });

  const isTTY = process.stdout.isTTY ?? false;
  let panelLineCount = 0;

  const writePanel = (panel: string, isFirst: boolean) => {
    if (!isTTY || isFirst) {
      promptIO.write(panel + '\n');
      panelLineCount = panel.split('\n').length + 1;
    } else {
      // Move cursor up to start of previous panel and overwrite each line in place
      const lines = panel.split('\n');
      const up = `\x1b[${panelLineCount}A`;
      const overwrite = lines.map(l => `\r\x1b[2K${l}`).join('\n');
      // Pad with blank cleared lines if new panel is shorter than previous
      const pad = panelLineCount - lines.length - 1;
      const clearRemainder = pad > 0 ? '\n' + Array.from({ length: pad }, () => '\r\x1b[2K').join('\n') : '';
      promptIO.write(up + overwrite + clearRemainder + '\n');
      panelLineCount = Math.max(panelLineCount, lines.length + 1);
    }
  };

  let isFirst = true;
  const render = () => {
    if (done) return;
    const elapsed = Date.now() - start;
    const spin = SPINNER[tick % SPINNER.length]!;
    const pct = Math.min(0.95, elapsed / EXPECTED_MS);
    const filled = Math.round(BAR_TOTAL * pct);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_TOTAL - filled);
    const seconds = (elapsed / 1000).toFixed(1);
    writePanel(buildPanel(title, [
      `${spin}  ${message}`,
      '',
      `    ${bar}   ${seconds}s`,
      '',
      hint,
    ]), isFirst);
    isFirst = false;
    tick += 1;
  };

  render();
  const timer = setInterval(render, 500);
  try {
    const result = await task();
    done = true;
    clearInterval(timer);
    const elapsedFinal = ((Date.now() - start) / 1000).toFixed(1);
    writePanel(buildPanel(title, [
      `✓  ${pickLocale(locale, { zh: '验证完成', en: 'Verification complete' })}  (${elapsedFinal}s)`,
    ]), false);
    return result;
  } catch (err) {
    done = true;
    clearInterval(timer);
    throw err;
  }
}

export async function promptForVerifiedProviderProfile(
  promptIO: PromptIO | undefined,
  data: ProviderStoreData,
  options: PromptProfileOptions,
  locale: UiLocale = 'en',
): Promise<ProviderProfile | undefined> {
  let promptOptions = options;
  for (;;) {
    const prompted = await promptForProviderProfile(promptIO, data, promptOptions, locale);
    if (!prompted) return undefined;

    const protocols: ProviderProtocol[] = prompted.autoDetectProtocol
      ? ['openai', 'messages']
      : [prompted.profile.protocol];
    const failures: string[] = [];
    for (const protocol of protocols) {
      const protocolLabel = formatProviderProtocolLabel(protocol, locale);
      const profile = { ...prompted.profile, protocol };
      const probe = await runWithProgress(
        promptIO,
        locale,
        pickLocale(locale, {
          zh: `正在连接 ${protocolLabel}，首次探测可能需要 20–60 秒，请耐心等待…`,
          en: `Connecting to ${protocolLabel}. The first probe can take 20–60 seconds — please hold on…`,
        }),
        () => probeProviderConfig(profile, { locale }),
      );
      if (!probe.ok) {
        failures.push(`${protocolLabel}: ${probe.message}`);
        continue;
      }

      const nativeToolProbe = await runWithProgress(
        promptIO,
        locale,
        pickLocale(locale, {
          zh: `连接成功（${probe.latencyMs}ms）。正在验证原生工具调用…`,
          en: `Connection OK (${probe.latencyMs}ms). Verifying native tool calls…`,
        }),
        () => probeProviderNativeToolCalls(profile, { locale }),
      );
      if (nativeToolProbe.ok) {
        return profile;
      }
      failures.push(
        `${protocolLabel}: connection OK (${probe.latencyMs}ms), but native tool calling failed.\n${nativeToolProbe.message}`,
      );
    }

    promptIO?.write(buildPanel('Provider connection test failed', failures));
    const next = await choosePromptOption(promptIO, {
      title: pickLocale(locale, { zh: '连接测试失败，下一步？', en: 'Connection test failed. What next?' }),
      initialIndex: 0,
      choices: [
        { label: pickLocale(locale, { zh: '修改配置', en: 'Edit configuration' }), value: 'edit' as const },
        { label: pickLocale(locale, { zh: '重试测试', en: 'Retry probe' }), value: 'retry' as const },
        { label: pickLocale(locale, { zh: '取消', en: 'Cancel' }), value: 'cancel' as const },
      ],
    });
    if (next === 'cancel') return undefined;
    if (next === 'edit') {
      promptOptions = {
        ...promptOptions,
        defaultAlias: prompted.profile.label ?? promptOptions.defaultAlias,
        defaultProtocol: prompted.profile.protocol,
        defaultBaseUrl: prompted.profile.baseUrl,
        defaultModel: prompted.profile.model,
        defaultApiKey: prompted.profile.apiKey,
        fixedId: prompted.profile.id,
      };
    }
  }
}

export async function resolveMainProviderConfig(options: {
  cwd: string;
  config: { protocol?: string; model?: string; baseUrl?: string; apiKey?: string };
  promptIO?: PromptIO;
  onInfo?: (message: string) => void;
}): Promise<ProviderConfig> {
  const inline = inspectInlineProviderConfig(options.config);
  if (inline.status === 'complete') return inline.config;
  if (inline.status === 'incomplete') {
    throw new Error(`Provide the missing ARTEMIS_* values together: ${inline.missing.join(', ')}.`);
  }

  const store = new ProviderStore(options.cwd);
  const data = await store.load();
  const mainProfile = store.getDefaultMainProfile(data);
  if (mainProfile) return mainProfile;

  const globalStore = new ProviderStore(homedir());
  const globalData = await globalStore.load();
  const globalMainProfile = globalStore.getDefaultMainProfile(globalData);
  if (globalMainProfile) return globalMainProfile;

  if (options.promptIO?.available !== true) {
    throw new Error('No execution provider is configured. Run artemis interactively or provide ARTEMIS_MODEL, ARTEMIS_BASE_URL, and ARTEMIS_API_KEY together.');
  }

  const locale = await resolveLocale(options);
  const profile = await promptForVerifiedProviderProfile(
    options.promptIO,
    data,
    {
      heading: pickLocale(locale, { zh: 'Execution API 设置（execution / main）', en: 'Execution API setup (execution / main)' }),
      defaultAlias: pickLocale(locale, { zh: '执行模型', en: 'Execution model' }),
      defaultIdPrefix: 'executor',
      cancellationLabel: pickLocale(locale, { zh: '取消配置', en: 'cancel setup' }),
      fixedId: 'executor',
    },
    locale,
  );
  if (!profile) {
    throw new Error('Provider setup cancelled before an execution API was saved.');
  }

  const nextData = await store.upsertProfile(profile);
  nextData.defaultMainProfileId = profile.id;
  await store.save(nextData);
  options.onInfo?.(`[providers] execution API saved as ${profile.label ?? profile.id} (${profile.model})`);
  return profile;
}

export function formatDoubleModelStatus(
  store: ProviderStore,
  data: ProviderStoreData,
  locale: UiLocale = 'en',
): string {
  const main = store.getDefaultMainProfile(data);
  const brain = store.getProfile(data, data.specialistProfileId);
  return [
    pickLocale(locale, { zh: 'Doublekill 状态', en: 'Doublekill status' }),
    main
      ? `Execution API: ${main.label ?? main.id} (${main.model})`
      : 'Execution API: not configured',
    brain
      ? `Raven API: ${brain.label ?? brain.id} (${brain.model})`
      : 'Raven API: not configured',
    main && brain
      ? pickLocale(locale, {
          zh: 'Bifrost 已就绪。Forge 负责执行，Raven 负责规划、研究和评审。',
          en: 'Bifrost is ready. Forge handles execution while Raven handles planning, research, and review.',
        })
      : pickLocale(locale, {
          zh: '运行 /bifrost 可补全双模型模式。',
          en: 'Run /bifrost to finish dual-model setup.',
        }),
  ].join('\n');
}

export async function ensureDoubleModelSetup(options: {
  cwd: string;
  promptIO?: PromptIO;
  onInfo?: (message: string) => void;
}): Promise<{
  mainProfile?: ProviderProfile;
  specialistProfile?: ProviderProfile;
  message: string;
}> {
  const locale = await resolveLocale(options);
  const store = new ProviderStore(options.cwd);
  let data = await store.load();
  let main = store.getDefaultMainProfile(data);
  let brain = store.getProfile(data, data.specialistProfileId);

  if (main && brain) {
    return { mainProfile: main, specialistProfile: brain, message: formatDoubleModelStatus(store, data, locale) };
  }

  if (options.promptIO?.available !== true) {
    return {
      mainProfile: main,
      specialistProfile: brain,
      message: [
        formatDoubleModelStatus(store, data, locale),
        '',
        'Open local interactive mode and run /bifrost to finish both the Execution API and the Raven API.',
      ].join('\n'),
    };
  }

  if (!main) {
    main = await promptForVerifiedProviderProfile(
      options.promptIO,
      data,
      {
        heading: pickLocale(locale, { zh: 'Execution API 设置（execution / main）', en: 'Execution API setup (execution / main)' }),
        defaultAlias: pickLocale(locale, { zh: '执行模型', en: 'Execution model' }),
        defaultIdPrefix: 'executor',
        cancellationLabel: 'cancel',
        fixedId: 'executor',
      },
      locale,
    );
    if (!main) {
      return { message: 'Bifrost setup cancelled before the Execution API was saved.' };
    }
    data = await store.upsertProfile(main);
    data.defaultMainProfileId = main.id;
    await store.save(data);
    options.onInfo?.(`[providers] execution API saved as ${main.label ?? main.id} (${main.model})`);
  }

  if (!brain) {
    brain = await promptForVerifiedProviderProfile(
      options.promptIO,
      data,
      {
        heading: pickLocale(locale, { zh: 'Raven API 设置（brain / specialist）', en: 'Raven API setup (brain / specialist)' }),
        defaultAlias: pickLocale(locale, { zh: 'Raven 模型', en: 'Raven model' }),
        defaultIdPrefix: 'brain',
        cancellationLabel: 'cancel',
        fixedId: 'brain',
        defaultBaseUrl: main.baseUrl,
        defaultApiKey: main.apiKey,
      },
      locale,
    );
    if (!brain) {
      return { mainProfile: main, message: 'Bifrost setup cancelled before the Raven API was saved.' };
    }
    data = await store.upsertProfile(brain);
    data.specialistProfileId = brain.id;
    if (!data.defaultMainProfileId) {
      data.defaultMainProfileId = main.id;
    }
    await store.save(data);
    options.onInfo?.(`[providers] Raven API saved as ${brain.label ?? brain.id} (${brain.model})`);
  }

  return {
    mainProfile: main,
    specialistProfile: brain,
    message: [
      formatDoubleModelStatus(store, data, locale),
      '',
      buildPanel('Bifrost next steps', [
        'Run artemis doctor --test-providers to verify both APIs before sharing this setup.',
        'Then start the CLI and confirm athena, niko, and contest route to the expected model.',
      ]),
    ].join('\n'),
  };
}

export function formatProviderStore(
  data: ProviderStoreData,
  locale: UiLocale = 'en',
): string {
  if (data.profiles.length === 0) {
    return pickLocale(locale, {
      zh: '没有已保存的 provider profiles。',
      en: 'No provider profiles configured.',
    });
  }

  const lines = ['Provider profiles'];
  for (const profile of data.profiles) {
    const tags: string[] = [];
    if (profile.id === data.defaultMainProfileId) tags.push('main');
    if (profile.id === data.specialistProfileId) tags.push('specialist');
    lines.push(`- ${profile.label ?? profile.id} [${tags.length > 0 ? tags.join(', ') : 'saved'}]`);
    lines.push(`  id=${profile.id}`);
    lines.push(`  protocol=${formatProviderProtocolLabel(profile.protocol, locale)}`);
    lines.push(`  model=${profile.model}`);
    lines.push(`  url=${profile.baseUrl}`);
    lines.push(`  key=${maskApiKey(profile.apiKey)}`);
    lines.push(`  ${formatProviderProfileTelemetry(profile.telemetry)}`);
  }
  return lines.join('\n');
}
