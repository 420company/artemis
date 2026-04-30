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
      'gpt-5.5-mini',
      'gpt-5.5-nano',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.2',
      'gpt-5.2-codex',
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
    ],
    notes: {
      zh: ['OpenAI 官方接口。', '标准 API 文档当前列出 gpt-5.5 / 5.4 / 5.2 / 5.1 / 5 系列、gpt-5-codex 系列，以及 gpt-4.1 / o3 / o4-mini。'],
      en: ['Official OpenAI API.', 'The current standard API docs list the GPT-5.5 / 5.4 / 5.2 / 5.1 / 5 line, GPT-5-Codex variants, plus GPT-4.1 / o3 / o4-mini.'],
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
      zh: ['DeepSeek 官方接口，OpenAI-compatible。', '官方已发布 deepseek-v4-pro / deepseek-v4-flash；deepseek-chat / deepseek-reasoner 目前仍可用，但官方已宣布将在 2026-07-24 停止。'],
      en: ['Official DeepSeek API, OpenAI-compatible.', 'DeepSeek now exposes deepseek-v4-pro and deepseek-v4-flash; deepseek-chat and deepseek-reasoner still work today but are scheduled for removal on 2026-07-24.'],
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
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash-preview-09-2025',
      'gemini-2.5-flash-lite-preview-09-2025',
    ],
    notes: {
      zh: ['Google Gemini OpenAI-compatible 接口。', '当前官方主线是 Gemini 2.5 Pro / Flash / Flash-Lite。'],
      en: ['Google Gemini via OpenAI-compatible endpoint.', 'The current official mainline is Gemini 2.5 Pro / Flash / Flash-Lite.'],
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
      zh: ['Moonshot AI 官方接口，OpenAI-compatible。', '当前官方首页主推 kimi-k2.6、kimi-k2.5、kimi-k2。'],
      en: ['Official Moonshot AI API, OpenAI-compatible.', 'The current Moonshot front page leads with kimi-k2.6, kimi-k2.5, and kimi-k2.'],
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
      zh: ['api.kimi.com Coding Plan 与 Moonshot API。', 'sk-kimi- 开头 key 可切到 coding endpoint。'],
      en: ['api.kimi.com Coding Plan and Moonshot API.', 'sk-kimi-* keys may route to the coding endpoint.'],
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
      zh: ['MiniMax global direct API，Hermes 走 Anthropic-style endpoint。'],
      en: ['MiniMax global direct API via Anthropic-style endpoint in Hermes.'],
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
      zh: ['智谱 AI / Z.ai 官方接口，OpenAI-compatible。', '当前官方 API 参考主线为 glm-5.1 / glm-5-turbo / glm-5 / glm-4.7 系列。'],
      en: ['Zhipu AI / Z.ai official API, OpenAI-compatible.', 'The current official API reference centers on glm-5.1 / glm-5-turbo / glm-5 and the GLM-4.7 family.'],
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
      zh: ['Zhipu / Z.AI 直连接口。', '可用 GLM_API_KEY / ZAI_API_KEY。'],
      en: ['Zhipu / Z.AI direct API.', 'Can use GLM_API_KEY / ZAI_API_KEY.'],
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
      zh: ['聚合多家模型，单个 API key 即可访问数百个模型。', '模型名格式：provider/model-name。'],
      en: ['Aggregate router — access hundreds of models with one API key.', 'Model format: provider/model-name.'],
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
      zh: ['Nous Research 订阅入口；Hermes 中支持托管工具网关。', '如使用 OAuth/订阅登录，后续需要补专门认证适配。'],
      en: ['Nous Research subscription endpoint; Hermes supports managed tool gateway.', 'OAuth/subscription login needs a dedicated auth adapter.'],
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
      zh: ['Vercel AI Gateway，OpenAI-compatible。', 'Hermes 标注为 200+ models，$5 free credit，无 markup。'],
      en: ['Vercel AI Gateway, OpenAI-compatible.', 'Hermes lists it as 200+ models, $5 free credit, no markup.'],
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
      zh: ['Hermes 通过 Codex OAuth 认证。', '当前 Artemis 先保存为 provider 配置；OAuth 自动登录需后续接入。'],
      en: ['Hermes authenticates this through Codex OAuth.', 'Artemis stores this as a provider profile first; OAuth automation can be added later.'],
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
      zh: ['复用本地 Qwen CLI 登录。', '需要后续接入 OAuth token 读取。'],
      en: ['Reuses local Qwen CLI login.', 'Needs a token reader adapter for full OAuth support.'],
    },
    runtimeReady: false,
  },
  {
    id: 'google-gemini-cli',
    label:        { zh: 'Google Gemini OAuth + Code Assist', en: 'Google Gemini OAuth + Code Assist' },
    defaultAlias: { zh: 'Gemini OAuth 模型', en: 'Gemini OAuth model' },
    protocol: 'openai',
    baseUrl: 'cloudcode-pa://google',
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    notes: {
      zh: ['Hermes 通过 Google OAuth + Code Assist 使用，可支持免费层。', '当前先记录路由信息。'],
      en: ['Hermes uses Google OAuth + Code Assist and can support the free tier.', 'This currently records the route metadata.'],
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
      'gemini-2.5-pro',
      'grok-code-fast-1',
    ],
    notes: {
      zh: ['使用 GITHUB_TOKEN、GH_TOKEN 或 Copilot token。', 'Hermes 可从 gh auth token 复用。'],
      en: ['Uses GITHUB_TOKEN, GH_TOKEN, or a Copilot token.', 'Hermes can reuse gh auth token.'],
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
      zh: ['Hermes 通过 `copilot --acp --stdio` 子进程接入。', '当前先保存配置元数据。'],
      en: ['Hermes spawns `copilot --acp --stdio`.', 'This currently stores metadata first.'],
    },
    runtimeReady: false,
  },

  // ── Direct and OpenAI-compatible providers from Hermes ───────────────────
  {
    id: 'xiaomi',
    label:        { zh: 'XiaoMi MiMo', en: 'XiaoMi MiMo' },
    defaultAlias: { zh: 'MiMo 模型', en: 'MiMo model' },
    protocol: 'openai',
    baseUrl: 'https://api.mimo-v2.com/v1',
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
      zh: ['MiMo-V2 / V2.5 模型，OpenAI-compatible。', '官方 Quick Start 使用 https://api.mimo-v2.com/v1 和 api-key 请求头。'],
      en: ['MiMo-V2 / V2.5 models, OpenAI-compatible.', 'The official Quick Start uses https://api.mimo-v2.com/v1 and the api-key header.'],
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
      zh: ['兼容你截图中的 Hermes provider 项。', '英文迁移文档使用 https://api.stepfun.ai/v1；官方示例模型包括 step-3.5-flash / step-3.5-flash-2603 / step-3 / step-2-16k。'],
      en: ['Compatibility entry for the Hermes provider shown in your screenshot.', 'The current English migration guide uses https://api.stepfun.ai/v1 and shows step-3.5-flash / step-3.5-flash-2603 / step-3 / step-2-16k as official examples.'],
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
      zh: ['open models，Hermes 标注为 $10/month subscription。', '官方文档按模型切分端点：MiniMax 走 Messages，其余当前公开模型走 Chat Completions。'],
      en: ['Open models, listed by Hermes as a $10/month subscription.', 'Official docs split endpoints by model family: MiniMax uses Messages, and the other currently listed models use Chat Completions.'],
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
    ],
    notes: {
      zh: [
        'BytePlus，OpenAI-compatible。',
        'Coding Plan 需将 baseUrl 改为 /api/coding/v3；Seed 2.0 模型使用真实模型名 seed-2-0-pro-260328 / seed-2-0-lite-260228 / seed-2-0-mini-260215。',
        '图像 / 视频生成请单独配置 visualProfile；不再默认复用主/副模型 API key。',
        '自定义部署填 Endpoint ID（ep- 开头）。',
      ],
      en: [
        'BytePlus, OpenAI-compatible.',
        'Coding Plan: switch baseUrl to /api/coding/v3; Seed 2.0 entries use the real model names seed-2-0-pro-260328 / seed-2-0-lite-260228 / seed-2-0-mini-260215.',
        'Configure image/video generation separately in visualProfile; main/secondary provider keys are no longer reused automatically.',
        'Custom deployments: use a deployed Endpoint ID (ep-...).',
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
