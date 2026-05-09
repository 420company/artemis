import { pickLocale, type UiLocale } from '../cli/locale.js'
import type { ProviderApiKeyHeader, ProviderProtocol } from './types.js'

export type ProviderPresetId = string

export type ProviderPreset = {
  id: ProviderPresetId
  /** Provider display name — keep English-only, no mixed Chinese/English. */
  label: { zh: string; en: string }
  defaultAlias: { zh: string; en: string }
  runtimeReady?: boolean
  protocol?: ProviderProtocol
  /** baseUrl is appended with /chat/completions, /responses, or /v1/messages by the runtime. */
  baseUrl?: string
  /** Defaults to Authorization: Bearer. Some OpenAI-compatible APIs document api-key instead. */
  apiKeyHeader?: ProviderApiKeyHeader
  suggestedModels: string[]
  notes: { zh: string[]; en: string[] }
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── Anthropic ─────────────────────────────────────────────────────────────
  {
    id: 'messages',
    label:        { zh: 'Anthropic',        en: 'Anthropic' },
    defaultAlias: { zh: 'Claude 模型',               en: 'Claude model' },
    protocol: 'messages',
    baseUrl: 'https://api.anthropic.com',
    suggestedModels: [
      'claude-opus-4-1-20250805',
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-haiku-20241022',
    ],
    notes: {
      zh: ['Anthropic 官方 Messages API。', '当前官方模型主线为 Claude Opus 4.1、Opus 4、Sonnet 4，以及 Claude 3.7 Sonnet / 3.5 Haiku。'],
      en: ['Official Anthropic Messages API.', 'Current Anthropic model line includes Claude Opus 4.1, Opus 4, Sonnet 4, plus Claude 3.7 Sonnet and 3.5 Haiku.'],
    },
  },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  {
    id: 'openai',
    label:        { zh: 'OpenAI',   en: 'OpenAI' },
    defaultAlias: { zh: 'OpenAI 模型', en: 'OpenAI model' },
    protocol: 'openai',
    // Endpoint: https://api.openai.com/v1/chat/completions
    baseUrl: 'https://api.openai.com/v1',
    suggestedModels: [
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.5-mini',
      'gpt-5.5-nano',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.1',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5-codex',
      'gpt-5-chat-latest',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4o',
      'gpt-4o-mini',
      'o3',
      'o3-mini',
      'o4-mini',
      // ── Image generation ──
      'gpt-5.4-image-2',
      'gpt-5-image',
      'gpt-5-image-mini',
      // ── Audio / multimodal ──
      'gpt-audio',
      'gpt-audio-mini',
      'gpt-4o-audio-preview',
      // ── Embedding (memory / RAG) ──
      'text-embedding-3-large',
      'text-embedding-3-small',
    ],
    notes: {
      zh: [
        'OpenAI 官方接口，涵盖聊天、代码、图像、语音和嵌入模型。',
        '推荐 gpt-5.5-pro（旗舰）或 gpt-5.5（日常）。',
        '支持图像生成（gpt-5.4-image-2 等）、语音对话（gpt-audio 系列）和嵌入检索。',
      ],
      en: [
        'Official OpenAI API — chat, code, image, audio, and embedding models.',
        'Recommended: gpt-5.5-pro (flagship) or gpt-5.5 (everyday).',
        'Supports image generation (gpt-5.4-image-2 etc.), voice (gpt-audio series), and embeddings.',
      ],
    },
  },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  {
    id: 'deepseek',
    label:        { zh: 'DeepSeek',   en: 'DeepSeek' },
    defaultAlias: { zh: 'DeepSeek 模型', en: 'DeepSeek model' },
    protocol: 'openai',
    // Endpoint: https://api.deepseek.com/chat/completions
    baseUrl: 'https://api.deepseek.com',
    suggestedModels: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
    notes: {
      zh: ['DeepSeek 官方接口。', '推荐 deepseek-v4-pro 或 deepseek-v4-flash；旧版 deepseek-chat / deepseek-reasoner 将于 2026-07-24 停服。'],
      en: ['Official DeepSeek API.', 'Recommended: deepseek-v4-pro or deepseek-v4-flash; legacy deepseek-chat / deepseek-reasoner retire on 2026-07-24.'],
    },
  },

  // ── Google Gemini ─────────────────────────────────────────────────────────
  {
    id: 'google-gemini',
    label:        { zh: 'Google Gemini',   en: 'Google Gemini' },
    defaultAlias: { zh: 'Gemini 模型',      en: 'Gemini model' },
    protocol: 'openai',
    // Endpoint: https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    suggestedModels: [
      'gemini-3.1-pro-preview',
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      // ── Image generation ──
      'gemini-3.1-flash-image-preview',
      'gemini-3-pro-image-preview',
      // ── Embedding (memory / RAG) ──
      'gemini-embedding-2-preview',
    ],
    notes: {
      zh: [
        'Google Gemini 官方接口，涵盖聊天、图像生成和嵌入模型。',
        '推荐 Gemini 3.x 系列；2.5 系列为经济备选。',
        '支持图像生成和多模态嵌入检索。',
      ],
      en: [
        'Official Google Gemini API — chat, image generation, and embedding models.',
        'Recommended: Gemini 3.x series; 2.5 series as cost-effective fallback.',
        'Supports image generation and multimodal embeddings.',
      ],
    },
  },

  // ── Kimi (Moonshot AI) ────────────────────────────────────────────────────
  {
    id: 'kimi',
    label:        { zh: 'Kimi (Moonshot AI)',   en: 'Kimi (Moonshot AI)' },
    defaultAlias: { zh: 'Kimi 模型',             en: 'Kimi model' },
    protocol: 'openai',
    // Endpoint: https://api.moonshot.ai/v1/chat/completions
    baseUrl: 'https://api.moonshot.ai/v1',
    suggestedModels: [
      'kimi-k2.6',
      'kimi-k2.5',
      'kimi-k2',
      'moonshot-v1-128k',
      'moonshot-v1-32k',
      'moonshot-v1-8k',
    ],
    notes: {
      zh: ['Moonshot AI 官方接口。', '推荐 kimi-k2.6 或 kimi-k2.5。'],
      en: ['Official Moonshot AI API.', 'Recommended: kimi-k2.6 or kimi-k2.5.'],
    },
  },
  {
    id: 'kimi-coding',
    label:        { zh: 'Kimi Coding Plan', en: 'Kimi Coding Plan' },
    defaultAlias: { zh: 'Kimi Coding 模型', en: 'Kimi Coding model' },
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    suggestedModels: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    notes: {
      zh: ['Kimi Coding Plan，专注代码场景。'],
      en: ['Kimi Coding Plan, focused on coding scenarios.'],
    },
  },
  {
    id: 'kimi-coding-cn',
    label:        { zh: 'Kimi China', en: 'Kimi China' },
    defaultAlias: { zh: 'Kimi CN 模型', en: 'Kimi CN model' },
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    suggestedModels: ['kimi-k2.5', 'kimi-k2', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
    notes: {
      zh: ['Moonshot 国内直连接口。'],
      en: ['Moonshot China direct API.'],
    },
  },

  // ── MiniMax ───────────────────────────────────────────────────────────────
  {
    id: 'minimax',
    label:        { zh: 'MiniMax', en: 'MiniMax' },
    defaultAlias: { zh: 'MiniMax 模型', en: 'MiniMax model' },
    protocol: 'messages',
    baseUrl: 'https://api.minimax.io/anthropic',
    suggestedModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed'],
    notes: {
      zh: ['MiniMax 国际版，涵盖 M2.7 / M2.5 / M2.1 系列。'],
      en: ['MiniMax International — M2.7 / M2.5 / M2.1 series.'],
    },
  },
  {
    id: 'minimax-cn',
    label:        { zh: 'MiniMax China', en: 'MiniMax China' },
    defaultAlias: { zh: 'MiniMax CN 模型', en: 'MiniMax CN model' },
    protocol: 'messages',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    suggestedModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed'],
    notes: {
      zh: ['MiniMax 国内直连接口。'],
      en: ['MiniMax China direct API.'],
    },
  },

  // ── Zhipu AI (GLM) ───────────────────────────────────────────────────────
  {
    id: 'glm',
    label:        { zh: 'Zhipu AI (GLM)',   en: 'Zhipu AI (GLM)' },
    defaultAlias: { zh: 'GLM 模型',         en: 'GLM model' },
    protocol: 'openai',
    // Endpoint: https://open.bigmodel.cn/api/paas/v4/chat/completions
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    suggestedModels: [
      'glm-5.1',
      'glm-5-turbo',
      'glm-5',
      'glm-4.7',
      'glm-4.7-flash',
      'glm-4.7-flashx',
      'glm-4.5-air',
      'glm-4.5-flash',
    ],
    notes: {
      zh: ['智谱 AI 官方接口。', '推荐 glm-5.1 或 glm-5-turbo。'],
      en: ['Official Zhipu AI API.', 'Recommended: glm-5.1 or glm-5-turbo.'],
    },
  },
  {
    id: 'zai',
    label:        { zh: 'Z.AI / GLM', en: 'Z.AI / GLM' },
    defaultAlias: { zh: 'Z.AI 模型', en: 'Z.AI model' },
    protocol: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    suggestedModels: ['glm-5.1', 'glm-5-turbo', 'glm-5', 'glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx', 'glm-4.5-air', 'glm-4.5-flash'],
    notes: {
      zh: ['Z.AI 海外版直连接口。'],
      en: ['Z.AI International direct API.'],
    },
  },

  // ── OpenRouter ────────────────────────────────────────────────────────────
  {
    id: 'openrouter',
    label:        { zh: 'OpenRouter',   en: 'OpenRouter' },
    defaultAlias: { zh: 'OpenRouter 模型', en: 'OpenRouter model' },
    protocol: 'openai',
    // Endpoint: https://openrouter.ai/api/v1/chat/completions
    baseUrl: 'https://openrouter.ai/api/v1',
    suggestedModels: [
      'openai/gpt-5.5-pro',
      'openai/gpt-5.5',
      'anthropic/claude-opus-4.1',
      'google/gemini-2.5-pro',
      'deepseek/deepseek-v4-pro',
      'moonshotai/kimi-k2.6',
      'z-ai/glm-5.1',
    ],
    notes: {
      zh: ['聚合路由，一个 API key 访问数百个模型。'],
      en: ['Aggregate router — access hundreds of models with one API key.'],
    },
  },

  // ── Nous Portal ───────────────────────────────────────────────────────────
  {
    id: 'nous',
    label:        { zh: 'Nous Portal', en: 'Nous Portal' },
    defaultAlias: { zh: 'Nous Portal 模型', en: 'Nous Portal model' },
    protocol: 'openai',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    suggestedModels: [
      'moonshotai/kimi-k2.6',
      'anthropic/claude-opus-4.1',
      'anthropic/claude-sonnet-4',
      'openai/gpt-5.4',
      'google/gemini-2.5-pro',
      'qwen/qwen3-coder-480b-a35b-instruct',
      'deepseek/deepseek-v4-pro',
      'z-ai/glm-5.1',
    ],
    notes: {
      zh: ['Nous Research 订阅制模型服务。'],
      en: ['Nous Research subscription-based model service.'],
    },
    runtimeReady: false,
  },

  // ── Vercel AI Gateway ─────────────────────────────────────────────────────
  {
    id: 'ai-gateway',
    label:        { zh: 'Vercel AI Gateway', en: 'Vercel AI Gateway' },
    defaultAlias: { zh: 'Vercel AI Gateway 模型', en: 'Vercel AI Gateway model' },
    protocol: 'openai',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    suggestedModels: [
      'openai/gpt-5.5',
      'anthropic/claude-opus-4.1',
      'google/gemini-2.5-pro',
      'deepseek/deepseek-v4-pro',
      'moonshotai/kimi-k2.6',
    ],
    notes: {
      zh: ['Vercel AI Gateway，200+ 模型，含 $5 免费额度。'],
      en: ['Vercel AI Gateway — 200+ models, $5 free credit.'],
    },
  },

  // ── OpenAI Codex / OAuth-style providers ─────────────────────────────────
  {
    id: 'openai-codex',
    label:        { zh: 'OpenAI Codex', en: 'OpenAI Codex' },
    defaultAlias: { zh: 'OpenAI Codex 模型', en: 'OpenAI Codex model' },
    protocol: 'openai',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    suggestedModels: ['gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5-codex'],
    notes: {
      zh: ['OpenAI Codex 代码模型，需 Codex OAuth 认证。'],
      en: ['OpenAI Codex code models, requires Codex OAuth.'],
    },
    runtimeReady: false,
  },
  {
    id: 'qwen-oauth',
    label:        { zh: 'Qwen OAuth', en: 'Qwen OAuth' },
    defaultAlias: { zh: 'Qwen OAuth 模型', en: 'Qwen OAuth model' },
    protocol: 'openai',
    baseUrl: 'https://portal.qwen.ai/v1',
    suggestedModels: ['qwen3-coder-next', 'qwen3.6-plus', 'qwen3.5-plus', 'qwen-max'],
    notes: {
      zh: ['Qwen 官方 OAuth 模型，需 Qwen CLI 登录。'],
      en: ['Official Qwen OAuth models, requires Qwen CLI login.'],
    },
    runtimeReady: false,
  },
  {
    id: 'google-gemini-cli',
    label:        { zh: 'Google Gemini OAuth + Code Assist', en: 'Google Gemini OAuth + Code Assist' },
    defaultAlias: { zh: 'Gemini OAuth 模型', en: 'Gemini OAuth model' },
    protocol: 'openai',
    baseUrl: 'cloudcode-pa://google',
    suggestedModels: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro'],
    notes: {
      zh: ['Google Gemini OAuth + Code Assist，可享免费额度。'],
      en: ['Google Gemini OAuth + Code Assist, free tier available.'],
    },
    runtimeReady: false,
  },
  {
    id: 'copilot',
    label:        { zh: 'GitHub Copilot', en: 'GitHub Copilot' },
    defaultAlias: { zh: 'Copilot 模型', en: 'Copilot model' },
    protocol: 'openai',
    baseUrl: 'https://api.githubcopilot.com',
    suggestedModels: [
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5.1-codex',
      'claude-opus-4.1',
      'claude-sonnet-4',
      'gemini-3.1-pro-preview',
      'gemini-3-pro-preview',
      'grok-code-fast-1',
    ],
    notes: {
      zh: ['GitHub Copilot，需 GitHub / Copilot token。'],
      en: ['GitHub Copilot, requires GitHub / Copilot token.'],
    },
    runtimeReady: false,
  },
  {
    id: 'copilot-acp',
    label:        { zh: 'GitHub Copilot ACP', en: 'GitHub Copilot ACP' },
    defaultAlias: { zh: 'Copilot ACP 模型', en: 'Copilot ACP model' },
    protocol: 'openai',
    baseUrl: 'acp://copilot',
    suggestedModels: ['gpt-5.2', 'gpt-5.2-codex', 'claude-sonnet-4'],
    notes: {
      zh: ['GitHub Copilot ACP 子进程协议。'],
      en: ['GitHub Copilot ACP subprocess protocol.'],
    },
    runtimeReady: false,
  },

  // ── Direct and OpenAI-compatible providers from Hermes ───────────────────
  {
    id: 'xiaomi',
    label:        { zh: 'XiaoMi MiMo', en: 'XiaoMi MiMo' },
    defaultAlias: { zh: 'MiMo 模型', en: 'MiMo model' },
    protocol: 'openai',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKeyHeader: 'api-key',
    suggestedModels: [
      'mimo-v2.5-pro',
      'mimo-v2-pro',
      'mimo-v2.5',
      'mimo-v2-omni',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voicedesign',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2-tts',
      'mimo-v2-flash',
    ],
    notes: {
      zh: ['小米 MiMo-V2 / V2.5 系列，涵盖聊天、TTS 语音合成和多模态模型。'],
      en: ['XiaoMi MiMo-V2 / V2.5 series — chat, TTS voice synthesis, and multimodal models.'],
    },
  },
  {
    id: 'nvidia',
    label:        { zh: 'NVIDIA NIM', en: 'NVIDIA NIM' },
    defaultAlias: { zh: 'NVIDIA NIM 模型', en: 'NVIDIA NIM model' },
    protocol: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    suggestedModels: [
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
      'deepseek-ai/deepseek-r1-0528',
      'qwen/qwen3-coder-480b-a35b-instruct',
      'openai/gpt-oss-120b',
    ],
    notes: {
      zh: ['NVIDIA build.nvidia.com 或本地 NIM。'],
      en: ['NVIDIA build.nvidia.com or local NIM.'],
    },
  },
  {
    id: 'huggingface',
    label:        { zh: 'Hugging Face Inference Providers', en: 'Hugging Face Inference Providers' },
    defaultAlias: { zh: 'Hugging Face 模型', en: 'Hugging Face model' },
    protocol: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    suggestedModels: [
      'Qwen/Qwen3-30B-A3B-Instruct-2507',
      'Qwen/Qwen3-Next-80B-A3B-Instruct',
      'deepseek-ai/DeepSeek-R1',
      'deepseek-ai/DeepSeek-V3.1-Terminus',
      'zai-org/GLM-5',
    ],
    notes: {
      zh: ['Hugging Face router，支持多家 inference providers。'],
      en: ['Hugging Face router across multiple inference providers.'],
    },
  },
  {
    id: 'stepfun',
    label:        { zh: 'StepFun Step Plan', en: 'StepFun Step Plan' },
    defaultAlias: { zh: 'StepFun 模型', en: 'StepFun model' },
    protocol: 'openai',
    baseUrl: 'https://api.stepfun.ai/v1',
    suggestedModels: ['step-3.5-flash-2603', 'step-3.5-flash', 'step-3', 'step-2-16k'],
    notes: {
      zh: ['阶跃星辰 StepFun 官方接口。', '推荐 step-3.5-flash 或 step-3。'],
      en: ['Official StepFun API.', 'Recommended: step-3.5-flash or step-3.'],
    },
  },
  {
    id: 'alibaba',
    label:        { zh: 'Alibaba Cloud / DashScope Coding', en: 'Alibaba Cloud / DashScope Coding' },
    defaultAlias: { zh: 'DashScope 模型', en: 'DashScope model' },
    protocol: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    suggestedModels: ['qwen3-coder-next', 'qwen3.6-plus', 'qwen3.5-plus', 'qwen-max', 'qwen-plus'],
    notes: {
      zh: ['DashScope OpenAI-compatible 接口，Qwen 与多 provider。'],
      en: ['DashScope OpenAI-compatible endpoint for Qwen and multi-provider routing.'],
    },
  },
  {
    id: 'ollama-cloud',
    label:        { zh: 'Ollama Cloud', en: 'Ollama Cloud' },
    defaultAlias: { zh: 'Ollama Cloud 模型', en: 'Ollama Cloud model' },
    protocol: 'openai',
    baseUrl: 'https://ollama.com/v1',
    suggestedModels: ['gpt-oss:120b-cloud', 'gpt-oss:20b-cloud', 'qwen3-coder:480b-cloud', 'qwen3-coder:30b', 'llama3.3:70b'],
    notes: {
      zh: ['Ollama 云端 open models。'],
      en: ['Ollama cloud-hosted open models.'],
    },
  },
  {
    id: 'arcee',
    label:        { zh: 'Arcee AI', en: 'Arcee AI' },
    defaultAlias: { zh: 'Arcee 模型', en: 'Arcee model' },
    protocol: 'openai',
    baseUrl: 'https://api.arcee.ai/api/v1',
    suggestedModels: ['trinity-large-preview', 'trinity-mini'],
    notes: {
      zh: ['Arcee Trinity 模型直连接口。', 'Arcee 官方 API 当前仅公开 trinity-large-preview 与 trinity-mini。'],
      en: ['Arcee Trinity direct API.', 'The current Arcee API exposes trinity-large-preview and trinity-mini.'],
    },
  },
  {
    id: 'kilocode',
    label:        { zh: 'Kilo Code', en: 'Kilo Code' },
    defaultAlias: { zh: 'Kilo Code 模型', en: 'Kilo Code model' },
    protocol: 'openai',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    suggestedModels: ['anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6', 'openai/gpt-5.2', 'google/gemini-3-pro', 'z-ai/glm-5'],
    notes: {
      zh: ['Kilo Gateway API。'],
      en: ['Kilo Gateway API.'],
    },
  },
  {
    id: 'opencode-zen',
    label:        { zh: 'OpenCode Zen', en: 'OpenCode Zen' },
    defaultAlias: { zh: 'OpenCode Zen 模型', en: 'OpenCode Zen model' },
    protocol: 'openai',
    baseUrl: 'https://opencode.ai/zen/v1',
    suggestedModels: [
      'gpt-5.4',
      'gpt-5.4-pro',
      'gpt-5.4-mini',
      'gpt-5.2-codex',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'glm-5.1',
      'kimi-k2.5',
      'qwen3.6-plus',
      'minimax-m2.5',
    ],
    notes: {
      zh: ['35+ curated models，按量付费。', '官方文档按模型切分端点：GPT 走 Responses，Claude 走 Messages，其它 OpenAI-compatible 模型走 Chat Completions。Gemini 仍需走其专用端点，因此不放进默认建议列表。'],
      en: ['35+ curated models, pay as you go.', 'Official docs split endpoints by model family: GPT uses Responses, Claude uses Messages, and other OpenAI-compatible models use Chat Completions. Gemini still uses its own provider-specific endpoint, so it is not included in the default suggestion list.'],
    },
  },
  {
    id: 'opencode-go',
    label:        { zh: 'OpenCode Go', en: 'OpenCode Go' },
    defaultAlias: { zh: 'OpenCode Go 模型', en: 'OpenCode Go model' },
    protocol: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    suggestedModels: [
      'glm-5.1',
      'glm-5',
      'kimi-k2.5',
      'mimo-v2-pro',
      'mimo-v2-omni',
      'minimax-m2.7',
      'minimax-m2.5',
      'qwen3.6-plus',
      'qwen3.5-plus',
    ],
    notes: {
      zh: ['Kilo Code 订阅制模型服务，$10/月。'],
      en: ['Kilo Code subscription-based model service, $10/month.'],
    },
  },
  {
    id: 'bedrock',
    label:        { zh: 'AWS Bedrock', en: 'AWS Bedrock' },
    defaultAlias: { zh: 'Bedrock 模型', en: 'Bedrock model' },
    protocol: 'messages',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    suggestedModels: [
      'anthropic.claude-opus-4-1',
      'anthropic.claude-sonnet-4-5',
      'amazon.nova-pro-v1:0',
      'deepseek.r1-v1:0',
    ],
    notes: {
      zh: ['Claude、Nova、Llama、DeepSeek；IAM/API key 认证需后续专门适配。'],
      en: ['Claude, Nova, Llama, DeepSeek; IAM/API-key auth needs a dedicated adapter.'],
    },
    runtimeReady: false,
  },

  // ── Mistral ────────────────────────────────────────────────────────────────
  {
    id: 'mistral',
    label:        { zh: 'Mistral',   en: 'Mistral' },
    defaultAlias: { zh: 'Mistral 模型', en: 'Mistral model' },
    protocol: 'openai',
    // Endpoint: https://api.mistral.ai/v1/chat/completions
    baseUrl: 'https://api.mistral.ai/v1',
    suggestedModels: [
      'mistral-large-latest',
      'mistral-medium-latest',
      'mistral-small-latest',
      'codestral-latest',
      'pixtral-large-latest',
      // ── Embedding ──
      'mistral-embed',
      // ── TTS ──
      'voxtral-mini-latest',
    ],
    notes: {
      zh: [
        'Mistral AI 官方接口，OpenAI-compatible。',
        '推荐 mistral-large-latest（旗舰）或 mistral-small-latest（日常）。',
        'Embedding：mistral-embed，可用于记忆增强或 RAG。',
        'TTS：voxtral-mini-latest，支持零样本语音克隆和多语言。',
      ],
      en: [
        'Official Mistral AI API, OpenAI-compatible.',
        'Recommended: mistral-large-latest (flagship) or mistral-small-latest (everyday).',
        'Embedding: mistral-embed for memory enhancement or RAG.',
        'TTS: voxtral-mini-latest with zero-shot voice cloning and multilingual support.',
      ],
    },
  },

  // ── BytePlus (international) ──────────────────────────────────────────────
  {
    id: 'byteplus',
    label:        { zh: 'BytePlus',   en: 'BytePlus' },
    defaultAlias: { zh: 'BytePlus 模型', en: 'BytePlus model' },
    protocol: 'openai',
    // General endpoint:     https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions
    // Coding Plan endpoint: https://ark.ap-southeast.bytepluses.com/api/coding/v3/chat/completions
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    suggestedModels: [
      'seed-2-0-pro-260328',
      'seed-2-0-lite-260228',
      'seed-2-0-mini-260215',
      'bytedance-seed-code',
      'glm-5.1',
      'glm-4.7',
      'kimi-k2.5',
      'gpt-oss-120b',
      'ark-code-latest',
      'seed-2-0-code-preview-260328',
      'seed-1-8-251228',
      'seed-1-6-250915',
      'seed-1-6-flash-250715',
      'glm-4-7-251222',
      'deepseek-v3-2-251201',
      'gpt-oss-120b-250805',
      // ── Embedding (memory / RAG) ──
      'skylark-embedding-vision-251215',
      'skylark-embedding-vision-250615',
      'skylark-embedding-vision-250328',
    ],
    notes: {
      zh: [
        'BytePlus 国际版 ModelArk，涵盖代码、推理、聊天和嵌入模型。',
        '推荐 Seed 2.0 系列或 glm-5.1。',
        '支持 Skylark 嵌入模型（记忆增强）和自定义私有部署。',
      ],
      en: [
        'BytePlus International ModelArk — code, reasoning, chat, and embedding models.',
        'Recommended: Seed 2.0 series or glm-5.1.',
        'Supports Skylark embedding models (memory enhancement) and custom private deployments.',
      ],
    },
  },

  // ── Ollama ────────────────────────────────────────────────────────────────
  {
    id: 'ollama',
    label:        { zh: 'Ollama',   en: 'Ollama' },
    defaultAlias: { zh: '本地 Ollama 模型', en: 'Local Ollama model' },
    protocol: 'openai',
    // Endpoint: http://localhost:11434/v1/chat/completions
    baseUrl: 'http://localhost:11434/v1',
    suggestedModels: [
      'qwen3-coder:30b',
      'qwen2.5-coder:7b',
      'deepseek-r1:8b',
      'deepseek-r1:7b',
      'llama3.3:70b',
      'llama3.1:8b',
      'gpt-oss:20b',
      'gpt-oss:120b',
    ],
    notes: {
      zh: ['本地模型服务，API key 可留空。', '确保 Ollama 已在本机运行（ollama serve）。'],
      en: ['Local model service — API key can be empty.', 'Make sure Ollama is running locally (ollama serve).'],
    },
  },

  // ── Custom ────────────────────────────────────────────────────────────────
  {
    id: 'custom',
    label:        { zh: '自定义',   en: 'Custom' },
    defaultAlias: { zh: '自定义模型', en: 'Custom model' },
    suggestedModels: [],
    notes: {
      zh: ['自定义 Base URL、协议、API key 和模型名称。', '适用于任何 OpenAI-compatible 或 Anthropic Messages-compatible 接口。'],
      en: ['Enter any Base URL, protocol, API key, and model name.', 'Works with any OpenAI-compatible or Anthropic Messages-compatible API.'],
    },
  },
]

export function getProviderPreset(id: ProviderPresetId): ProviderPreset {
  return (
    PROVIDER_PRESETS.find(p => p.id === id) ??
    PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]
  )
}

export function formatProviderPresetLabel(preset: ProviderPreset, locale: UiLocale = 'en'): string {
  return pickLocale(locale, preset.label)
}

export function formatProviderPresetDefaultAlias(preset: ProviderPreset, locale: UiLocale = 'en'): string {
  return pickLocale(locale, preset.defaultAlias)
}
