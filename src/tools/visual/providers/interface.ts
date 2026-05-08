import type { VisualModelConfig } from '../../../providers/types.js'

// ─── ASSET GENERATION INTERFACE ───────────────────────────────────────────────

export interface VisualGenerationParams {
  prompt: string
  model?: string
  size?: string
  quality?: string
  style?: string
  outputFormat?: string
  outputCompression?: number
  background?: string
  watermark?: boolean
  count?: number
}

export interface VideoGenerationParams extends VisualGenerationParams {
  duration?: number
  ratio?: string
  generateAudio?: boolean
  referenceImageUrls?: string[]
  referenceVideoUrls?: string[]
  referenceAudioUrls?: string[]
  referenceImagePaths?: string[]
  referenceVideoPaths?: string[]
  referenceAudioPaths?: string[]
  // Image-to-video first-frame anchor (role: "first_frame" in BytePlus
  // multimodal request shape) — pins the literal opening frame of the
  // video. Provider may still apply content moderation to the image;
  // empirical testing shows it does NOT reliably bypass the real-person
  // privacy filter (the classifier is image-bytes-based, not role-based).
  firstFrameImageUrls?: string[]
  // Image-to-video last-frame anchor (role: "last_frame").
  lastFrameImageUrls?: string[]
  watermark?: boolean
}

export interface GenerationResult {
  success: boolean
  assetPath?: string
  error?: string
  generationTime?: number
  modelInfo?: {
    provider: string
    model: string
    params: Record<string, any>
  }
}

export interface VisualProvider {
  readonly name: string
  readonly supportsImages: boolean
  readonly supportsVideos: boolean
  
  generateImage(params: VisualGenerationParams): Promise<GenerationResult>
  generateVideo?(params: VideoGenerationParams): Promise<GenerationResult>
}

export type VisualProviderStatus = 'stable' | 'placeholder' | 'test'

// ─── PROVIDER FACTORY ───────────────────────────────────────────────────────

export async function createVisualProvider(config: VisualModelConfig, assetType: 'image' | 'video'): Promise<VisualProvider> {
  const providerName = assetType === 'image' ? config.image.provider.toLowerCase() : config.video.provider.toLowerCase()
  
  switch (providerName) {
    case 'byteplus': {
      const byteplusModule = await import('./byteplusProvider.js')
      return new byteplusModule.BytePlusProvider(config, assetType)
    }
    
    case 'openai': {
      const openaiModule = await import('./openaiProvider.js')
      return new openaiModule.OpenAIProvider(config)
    }
    
    case 'stable-diffusion': {
      const stableDiffusionModule = await import('./stableDiffusionProvider.js')
      return new stableDiffusionModule.StableDiffusionProvider(config, assetType)
    }
    
    case 'gemini': {
      const geminiModule = await import('./geminiProvider.js')
      return new geminiModule.GeminiProvider(config, assetType)
    }

    case 'google': {
      const googleModule = await import('./googleProvider.js')
      return new googleModule.GoogleProvider(config, assetType)
    }
    
    case 'grok': {
      const grokModule = await import('./grokProvider.js')
      return new grokModule.GrokProvider(config, assetType)
    }
    
    case 'custom': {
      const customModule = await import('./customProvider.js')
      return new customModule.CustomProvider(config)
    }
    
    case 'mock': {
      const mockModule = await import('./mockProvider.js')
      return new mockModule.MockProvider(config, assetType)
    }
    
    default:
      throw new Error(`Unsupported visual provider: ${providerName}`)
  }
}

// ─── PROVIDER REGISTRY ─────────────────────────────────────────────────────

export const VISUAL_PROVIDERS = [
  {
    name: 'byteplus',
    label: 'Vidar Visual',
    description: 'BytePlus ModelArk Seedream 图片生成与 Seedance 视频生成适配器',
    status: 'stable' as const,
    supportsImages: true,
    supportsVideos: true,
    defaultModel: {
      image: 'seedream-5-0-260128',
      video: 'seedance-1-5-pro-251215'
    }
  },
  {
    name: 'openai',
    label: 'OpenAI GPT Image + Sora',
    description: 'OpenAI GPT Image 2 图片生成和 Sora 2 视频生成',
    status: 'stable' as const,
    supportsImages: true,
    supportsVideos: true,
    defaultModel: {
      image: 'gpt-image-2',
      video: 'sora-2'
    }
  },
  {
    name: 'stable-diffusion',
    label: 'Stable Diffusion',
    description: '占位适配器：当前未接入真实 Stable Diffusion 图片/视频 API',
    status: 'placeholder' as const,
    supportsImages: true,
    supportsVideos: true,
    defaultModel: {
      image: 'stable-diffusion-xl',
      video: 'stable-video-diffusion'
    }
  },
  {
    name: 'gemini',
    label: 'Google Gemini',
    description: '占位适配器：当前未接入真实 Gemini 视觉 API',
    status: 'placeholder' as const,
    supportsImages: true,
    supportsVideos: false,
    defaultModel: {
      image: 'gemini-1.5-pro',
      video: 'none'
    }
  },
  {
    name: 'google',
    label: 'Google Veo + Gemini Image',
    description: 'Google Generative AI: Veo 3 视频生成 + Gemini 2.5 Flash Image 图片生成',
    status: 'stable' as const,
    supportsImages: true,
    supportsVideos: true,
    defaultModel: {
      image: 'gemini-2.5-flash-image',
      video: 'veo-3.0-generate-preview'
    }
  },
  {
    name: 'grok',
    label: 'xAI Grok',
    description: '占位适配器：当前未接入真实 Grok 图像/视频 API',
    status: 'placeholder' as const,
    supportsImages: true,
    supportsVideos: true,
    defaultModel: {
      image: 'grok-v1',
      video: 'grok-video'
    }
  },
  {
    name: 'mock',
    label: 'Mock Provider',
    description: '模拟生成器（用于测试和演示）',
    status: 'test' as const,
    supportsImages: true,
    supportsVideos: true,
    defaultModel: {
      image: 'mock-image',
      video: 'mock-video'
    }
  },
  {
    name: 'custom',
    label: 'Custom API',
    description: '自定义视觉模型 API（OpenAI-compatible，可分别配置图片/视频）',
    status: 'stable' as const,
    supportsImages: true,
    supportsVideos: true,
    defaultModel: {
      image: 'custom',
      video: 'custom'
    }
  }
]

// ─── UTILITY FUNCTIONS ─────────────────────────────────────────────────────

export function getProviderByName(name: string) {
  return VISUAL_PROVIDERS.find(p => p.name.toLowerCase() === name.toLowerCase())
}

export function isProviderSupported(name: string) {
  return VISUAL_PROVIDERS.some(p => p.name.toLowerCase() === name.toLowerCase())
}

export function getAvailableProviders() {
  return VISUAL_PROVIDERS.filter(p => p.status === 'stable')
}

export function isPlaceholderVisualProvider(name: string): boolean {
  return getProviderByName(name)?.status === 'placeholder'
}

export function getVisualProviderSupportNote(
  name: string,
  locale: 'zh' | 'en' = 'en',
): string | null {
  switch (name.toLowerCase()) {
    case 'stable-diffusion':
    case 'gemini':
    case 'grok':
      return locale === 'zh'
        ? '当前仓库里该视觉 provider 仍是占位实现，尚未接入真实 API。若目标服务是完全私有协议，需要单独编写 provider 适配器。'
        : 'This visual provider is still a placeholder in this build and does not call a real API yet. Fully private protocols still need a dedicated provider adapter.'
    case 'google':
      return locale === 'zh'
        ? 'Google Veo 视频生成是 Long-running operation：调用后会轮询状态（通常需要 1-3 分钟），完成后视频会保存到桌面。需要 Google AI Studio API key。'
        : 'Google Veo video uses a long-running operation API and polls for completion (typically 1-3 minutes). The video is saved to your Desktop. Requires a Google AI Studio API key.'
    case 'custom':
      return locale === 'zh'
        ? 'custom 仅支持 OpenAI-compatible 图片/视频接口。若你的服务不是这套协议，仍需单独编写 provider 适配器。'
        : 'The custom provider only supports OpenAI-compatible image/video APIs. If your service uses a private protocol, it still needs a dedicated provider adapter.'
    case 'mock':
      return locale === 'zh'
        ? 'mock 仅用于测试和演示，不会调用真实视觉 API。'
        : 'The mock provider is for tests and demos only and does not call a real visual API.'
    default:
      return null
  }
}

export function buildPlaceholderVisualProviderError(
  name: string,
  assetType: 'image' | 'video',
): string {
  const providerLabel = getProviderByName(name)?.label ?? name
  return `${providerLabel} ${assetType} provider is still a placeholder in this build and does not call a real API. Use BytePlus, OpenAI, custom (OpenAI-compatible), or implement a dedicated provider adapter for this service.`
}
