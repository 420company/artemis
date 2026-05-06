import { GoogleGenAI } from '@google/genai';
import {
  DEFAULT_GEMINI_DEEP_RESEARCH_AGENT,
  type CliSettings,
} from '../cli/settings.js';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import { buildPanel } from '../cli/ui.js';

const DEFAULT_MAX_POLLS = 120;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export type GeminiDeepResearchConfig = {
  apiKey: string;
  agent: string;
  maxPolls: number;
  pollIntervalMs: number;
};

type GeminiInteractionOutput = {
  type?: string;
  text?: string;
};

type GeminiInteractionUsage = {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_tokens?: number;
};

type GeminiInteraction = {
  id: string;
  agent?: string;
  status?: string;
  outputs?: GeminiInteractionOutput[];
  usage?: GeminiInteractionUsage;
  error?: {
    message?: string;
    code?: string;
  };
};

export type GeminiDeepResearchClient = {
  createInteraction(options: {
    prompt: string;
    agent: string;
    systemInstruction?: string;
  }): Promise<GeminiInteraction>;
  getInteraction(interactionId: string): Promise<GeminiInteraction>;
};

export type GeminiDeepResearchResult = {
  interactionId: string;
  agent: string;
  status: string;
  text: string;
  usage?: GeminiInteractionUsage;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getApiKeyFromEnv(): string | undefined {
  return process.env.ARTEMIS_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
    ? Math.max(1, Math.round(value))
    : fallback;
}

function buildInteractionText(interaction: GeminiInteraction): string {
  const text = (interaction.outputs ?? [])
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (text) {
    return text;
  }

  return interaction.error?.message?.trim() || 'No text output returned.';
}

export function resolveGeminiDeepResearchConfig(
  settings: CliSettings,
): GeminiDeepResearchConfig {
  const apiKey = getApiKeyFromEnv() || settings.geminiApiKey;
  if (!apiKey) {
    throw new Error(
      'Gemini Deep Research is not configured. Run `artemis deep-research-config` once or set ARTEMIS_GEMINI_API_KEY.',
    );
  }

  return {
    apiKey,
    agent:
      settings.geminiDeepResearchAgent || DEFAULT_GEMINI_DEEP_RESEARCH_AGENT,
    maxPolls: DEFAULT_MAX_POLLS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
}

export function createGoogleGenAIResearchClient(
  config: GeminiDeepResearchConfig,
): GeminiDeepResearchClient {
  const client = new GoogleGenAI({
    apiKey: config.apiKey,
    apiVersion: 'v1beta',
  });

  return {
    async createInteraction(options) {
      return await client.interactions.create({
        agent: options.agent,
        input: options.prompt,
        system_instruction: options.systemInstruction,
        background: true,
        store: true,
        agent_config: {
          type: 'deep-research',
          thinking_summaries: 'auto',
        },
      }) as GeminiInteraction;
    },
    async getInteraction(interactionId) {
      return await client.interactions.get(interactionId) as GeminiInteraction;
    },
  };
}

export async function runGeminiDeepResearch(options: {
  prompt: string;
  settings: CliSettings;
  systemInstruction?: string;
  maxPolls?: number;
  pollIntervalMs?: number;
  client?: GeminiDeepResearchClient;
}): Promise<GeminiDeepResearchResult> {
  const config = resolveGeminiDeepResearchConfig(options.settings);
  const client = options.client ?? createGoogleGenAIResearchClient(config);
  const maxPolls = normalizePositiveInteger(
    options.maxPolls,
    config.maxPolls,
  );
  const pollIntervalMs = normalizePositiveInteger(
    options.pollIntervalMs,
    config.pollIntervalMs,
  );

  let interaction = await client.createInteraction({
    prompt: options.prompt,
    agent: config.agent,
    systemInstruction: options.systemInstruction,
  });

  if (!interaction.id) {
    throw new Error('Gemini Deep Research did not return an interaction id.');
  }

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const status = interaction.status ?? 'unknown';
    if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'incomplete'
    ) {
      return {
        interactionId: interaction.id,
        agent: interaction.agent ?? config.agent,
        status,
        text: buildInteractionText(interaction),
        usage: interaction.usage,
      };
    }

    await sleep(pollIntervalMs);
    interaction = await client.getInteraction(interaction.id);
  }

  return {
    interactionId: interaction.id,
    agent: interaction.agent ?? config.agent,
    status: interaction.status ?? 'in_progress',
    text: buildInteractionText(interaction),
    usage: interaction.usage,
  };
}

export function formatGeminiDeepResearchReport(options: {
  query: string;
  result: GeminiDeepResearchResult;
  locale?: UiLocale;
}): string {
  const locale = options.locale ?? 'en';
  const lines = [
    `${pickLocale(locale, {
      zh: '查询',
      en: 'query',
    })}: ${options.query}`,
    `agent: ${options.result.agent}`,
    `${pickLocale(locale, {
      zh: '交互 ID',
      en: 'interaction',
    })}: ${options.result.interactionId}`,
    `${pickLocale(locale, {
      zh: '状态',
      en: 'status',
    })}: ${options.result.status}`,
  ];

  if (options.result.usage) {
    lines.push(
      `- tokens: input=${options.result.usage.total_input_tokens ?? 0} output=${options.result.usage.total_output_tokens ?? 0} thought=${options.result.usage.total_thought_tokens ?? 0} total=${options.result.usage.total_tokens ?? 0}`,
    );
  }

  return [
    buildPanel(
      pickLocale(locale, {
        zh: 'Artemis Gemini Deep Research',
        en: 'Artemis Gemini Deep Research',
      }),
      lines,
    ),
    '',
    options.result.text ||
      pickLocale(locale, {
        zh: '未返回文本结果。',
        en: 'No text output returned.',
      }),
  ].join('\n');
}
