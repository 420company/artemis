import type { AgentRole, SessionMessage } from '../core/types.js';
import type { UiLocale } from '../cli/locale.js';

export type ProviderProtocol = 'openai' | 'messages' | 'responses';
export type ProviderApiKeyHeader = 'authorization' | 'api-key' | 'x-api-key';

/**
 * Reasoning effort level, mirroring Anthropic's output_config.effort scale.
 * Providers translate per protocol: Anthropic sends output_config.effort
 * (clamping levels the model doesn't support), OpenAI-protocol reasoning
 * models get reasoning_effort (xhigh/max clamp to high), everything else
 * silently ignores it.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ProviderConfig = {
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiKeyHeader?: ProviderApiKeyHeader;
  /** Optional reasoning effort. Unset = provider/API default (Anthropic: high). */
  effort?: EffortLevel;
};

export type ProviderProfileTelemetry = {
  sampleCount: number;
  successCount: number;
  errorCount: number;
  lastStatus?: 'ok' | 'error';
  lastRecordedAt?: string;
  lastDurationMs?: number;
  avgDurationMs?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
  lastFirstResponseMs?: number;
  avgFirstResponseMs?: number;
  minFirstResponseMs?: number;
  maxFirstResponseMs?: number;
  lastError?: string;
};

export type ProviderProfile = ProviderConfig & {
  id: string;
  label?: string;
  contextLength?: number;
  /** Where contextLength came from. models-api means provider metadata, known-model means Artemis fallback rules. */
  contextLengthSource?: 'models-api' | 'known-model' | 'manual';
  contextLengthCheckedAt?: string;
  telemetry?: ProviderProfileTelemetry;
};

export type ProviderNativeFunctionTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ProviderNativeToolCall = {
  name: string;
  arguments: string;
  callId: string;
};

export type ProviderNativeToolOutput = {
  callId: string;
  output: string;
};

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export type ImageAttachment = {
  /** Base64-encoded image data (no data-URI prefix). */
  data: string;
  mediaType: ImageMediaType;
  /** Optional hint injected as a text prefix before the image. */
  label?: string;
  /** Optional original URL, when the bridge received the image from a public/CDN attachment. */
  sourceUrl?: string;
};

export type ProviderRequestOptions = {
  /** UI language selected by the user during Artemis setup. */
  locale?: UiLocale;
  nativeFunctionTools?: ProviderNativeFunctionTool[];
  previousResponseId?: string;
  toolOutputs?: ProviderNativeToolOutput[];
  /**
   * Reasoning-phase activity hook. Some models (e.g. deepseek-reasoner) emit
   * `reasoning_content` deltas for ~10s before any visible content arrives.
   * Callers can subscribe to these to surface a "thinking" indicator instead
   * of a frozen "generating…" bubble.
   */
  onReasoning?: (delta: string) => void;
  /**
   * When true, a streaming provider may temporarily hold back early text until
   * it can tell whether the response is actually using native tools. This is a
   * targeted UX guard for coding/file intents: it prevents "run cat/ls and
   * paste the output" text from flashing on-screen before the runtime can
   * detect and block it.
   */
  guardStreamingText?: boolean;
  /**
   * Images to attach to the last user message.
   * Only applied on turn 1 of a conversation.
   * Ignored if the provider does not support images.
   */
  imageAttachments?: ImageAttachment[];
  /**
   * Optional cancellation signal. Interactive runtimes use this to stop an
   * in-flight model request as soon as the user sends a correction/interjection.
   */
  abortSignal?: AbortSignal;
};

export type ProviderTarget = 'main' | AgentRole;

export type ProviderStoreData = {
  profiles: ProviderProfile[];
  defaultMainProfileId?: string;
  specialistProfileId?: string;
  visualProfile?: VisualModelConfig;
  memoryProfile?: MemoryEnhancementConfig;
  customProviders?: CustomProviderConfig[];
  auxiliaryModels?: Partial<Record<AuxiliaryModelTask, AuxiliaryModelRoute>>;
  setup?: ArtemisSetupConfig;
};

export type CustomProviderConfig = {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader?: ProviderApiKeyHeader;
  model: string;
  contextLength?: number;
  contextLengthSource?: 'models-api' | 'known-model' | 'manual';
  contextLengthCheckedAt?: string;
};

export type AuxiliaryModelTask =
  | 'vision'
  | 'compression'
  | 'web_extract'
  | 'session_search'
  | 'approval'
  | 'mcp'
  | 'flush_memories'
  | 'title_generation'
  | 'skills_hub';

export type AuxiliaryModelRoute = {
  mode: 'auto' | 'provider' | 'custom';
  providerProfileId?: string;
  protocol?: ProviderProtocol;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

export type SessionSetupConfig = {
  sessionReset: {
    mode: 'both' | 'idle' | 'daily' | 'never';
    idleMinutes?: number;
    dailyHour?: number;
  };
}

export type AgentSetupConfig = {
  maxIterations: number;
  toolProgress: 'off' | 'new' | 'all' | 'verbose';
  compression: {
    enabled: boolean;
    /** Optional manual trigger ratio. When omitted, Artemis uses adaptive 55/65/70% thresholds by model window. */
    threshold?: number;
  };
  sessionReset: {
    mode: 'both' | 'idle' | 'daily' | 'never';
    idleMinutes?: number;
    dailyHour?: number;
  };
};

export type TerminalSetupConfig = {
  backend: 'local' | 'docker' | 'modal' | 'ssh' | 'daytona' | 'singularity';
  cwd?: string;
  dockerImage?: string;
  modalMode?: 'auto' | 'managed' | 'direct';
  daytonaImage?: string;
  singularityImage?: string;
  ssh?: {
    host?: string;
    user?: string;
    port?: number;
    keyPath?: string;
  };
  resources?: {
    persistent?: boolean;
    cpu?: number;
    memoryMb?: number;
    diskMb?: number;
  };
};

export type VoiceSetupConfig = {
  stt: {
    enabled: boolean;
    provider: 'local' | 'openai' | 'mistral';
    engine?: 'auto' | 'whisper.cpp' | 'openai-whisper';
    command?: string;
    modelPath?: string;
    localModel?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
    language?: string;
    openaiModel?: 'whisper-1' | 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe';
    mistralModel?: 'voxtral-mini-latest' | 'voxtral-mini-2602';
    apiKey?: string;
  };
  tts: {
    provider: 'edge' | 'elevenlabs' | 'openai' | 'xai' | 'minimax' | 'mistral' | 'gemini' | 'neutts' | 'kittentts';
    apiKey?: string;
    voice?: string;
    model?: string;
  };
  voice: {
    recordKey: string;
    maxRecordingSeconds: number;
    autoTts: boolean;
    beepEnabled: boolean;
    silenceThreshold: number;
    silenceDuration: number;
  };
};

export type ToolSetupConfig = {
  enabled: Record<string, boolean>;
  providers: Record<string, string>;
};

export type ProviderRotationConfig = {
  strategy: 'fill_first' | 'round_robin' | 'random';
};

export type ArtemisSetupConfig = {
  agent: AgentSetupConfig;
  terminal: TerminalSetupConfig;
  voice: VoiceSetupConfig;
  tools: ToolSetupConfig;
  providerRotation?: Partial<Record<string, ProviderRotationConfig>>;
  migrations?: {
    imageGenDefaultEnabled?: boolean;
  };
};

export type MemoryEnhancementConfig = {
  enabled: boolean;
  provider: 'byteplus' | 'openai' | 'google' | 'mistral' | 'local' | 'none';
  config?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    /** Embedding dimensions override (e.g. 1024 for text-embedding-3-small with dims). */
    dimensions?: number;
  };
};

export type VidarAssetHostingConfig = {
  enabled: boolean;
  provider: 's3' | 'r2';
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  publicBaseUrl?: string;
  prefix?: string;
  maxUploadMegabytes?: number;
};

export type VisualModelConfig = {
  enabled: boolean;
  image: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    defaultParams: ImageGenerationParams;
    /** When true, this image model accepts NSFW/adult content (nudity, erotica).
     *  Artemis will skip safety-derivative turnaround generation and pass
     *  user images directly, trusting the provider's own policy. */
    nsfw?: boolean;
    /** Chat+vision model name on this relay used for "vision-describe"
     *  (read an image, produce a text description). Different from `model`,
     *  which is for image GENERATION (e.g. gpt-image-2). When omitted,
     *  Artemis tries `gpt-5.4-mini` first, then `gpt-5.4`, then `gpt-4o`. */
    visionModel?: string;
  };
  video: {
    enabled: boolean;
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    defaultParams: VideoGenerationParams;
    /** When true, this video model accepts NSFW/adult content (nudity, erotica).
     *  Artemis will pass user reference images directly without illustrated
     *  safety-derivative intermediaries. */
    nsfw?: boolean;
  };
  assetHosting?: VidarAssetHostingConfig;
};

export type ImageGenerationParams = {
  size: string;
  quality: 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'ultra';
  style: 'realistic' | 'animated' | 'artistic' | 'minimalist';
  watermark: boolean;
  outputFormat?: 'png' | 'jpeg' | 'webp';
  outputCompression?: number;
  background?: 'auto' | 'opaque' | 'transparent';
};

export type VideoGenerationParams = {
  duration: '5s' | '7s' | '10s' | '15s';
  resolution: '720p' | '1080p' | '4k';
  quality: 'standard' | 'high' | 'ultra';
  style: 'realistic' | 'animated' | 'abstract';
  format: 'mp4' | 'webm';
  framerate: '24fps' | '30fps' | '60fps';
  watermark: boolean;
};

export type PromptIO = {
  available: boolean;
  ask(prompt: string, mask?: boolean): Promise<string>;
  choose?<T>(options: {
    title: string;
    choices: Array<{
      label: string;
      value: T;
      description?: string;
    }>;
    initialIndex?: number;
    hint?: string;
  }): Promise<T>;
  write(message: string): void;
  close?(): void;
};

export type ProviderResponse = {
  text: string;
  raw: unknown;
  model?: string;
  responseId?: string;
  nativeToolCalls?: ProviderNativeToolCall[];
  /**
   * Full reasoning/thinking chain emitted by models such as DeepSeek-R1.
   * Must be stored in the session and passed back to the API verbatim in the
   * next assistant message — omitting it causes HTTP 400 on DeepSeek endpoints.
   */
  reasoningContent?: string;
  /**
   * Raw content block array from Anthropic responses (used when extended
   * thinking is enabled). Carries `thinking` blocks with signatures that
   * must be replayed bit-for-bit on the next request for tool_use loops.
   * Only set by the Anthropic Messages provider.
   */
  rawContentBlocks?: any[];
  /**
   * True when `text` was emitted incrementally via the stream callback during
   * the call (real SSE). False or undefined means the caller is responsible
   * for emitting `text` if it wants users to see it. This distinction matters
   * when `completeStream` falls back to a non-streaming JSON body — callers
   * that intercept replies (e.g. deflection guards) need a chance to decide
   * before the user sees anything.
   */
  streamed?: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    /** Whether token counts came from provider usage or local fallback estimation. */
    source?: 'provider' | 'estimated';
    durationMs?: number;
    firstResponseMs?: number;
    profileId?: string;
    profileLabel?: string;
    protocol?: ProviderProtocol;
  };
};

export interface ChatProvider {
  readonly supportsNativeToolCalls?: boolean;
  /** True if the provider accepts image attachments via ProviderRequestOptions.imageAttachments. */
  readonly supportsImages?: boolean;
  complete(
    messages: SessionMessage[],
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse>;
  /**
   * Optional streaming variant. When present, brain.ts will call this instead of complete()
   * so that token deltas are emitted incrementally via onChunk.
   */
  completeStream?(
    messages: SessionMessage[],
    onChunk: (delta: string) => void,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse>;
}
