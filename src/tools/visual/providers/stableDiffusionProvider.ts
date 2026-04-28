import type { VisualModelConfig } from '../../../providers/types.js'
import {
  buildPlaceholderVisualProviderError,
  type GenerationResult,
  type VideoGenerationParams,
  type VisualGenerationParams,
  type VisualProvider,
} from './interface.js'

export class StableDiffusionProvider implements VisualProvider {
  readonly name = 'stable-diffusion'
  readonly supportsImages = true
  readonly supportsVideos = true

  constructor(
    _config: VisualModelConfig,
    _assetType: 'image' | 'video',
  ) {}

  async generateImage(params: VisualGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now()
    return {
      success: false,
      error: buildPlaceholderVisualProviderError(this.name, 'image'),
      generationTime: Date.now() - startTime,
      modelInfo: {
        provider: this.name,
        model: params.model || 'stable-diffusion-xl',
        params: {},
      },
    }
  }

  async generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now()
    return {
      success: false,
      error: buildPlaceholderVisualProviderError(this.name, 'video'),
      generationTime: Date.now() - startTime,
      modelInfo: {
        provider: this.name,
        model: params.model || 'stable-video-diffusion',
        params: {},
      },
    }
  }
}
