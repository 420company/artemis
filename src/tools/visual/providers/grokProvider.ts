import type { VisualModelConfig } from '../../../providers/types'
import {
  buildPlaceholderVisualProviderError,
  type GenerationResult,
  type VideoGenerationParams,
  type VisualGenerationParams,
  type VisualProvider,
} from './interface'

export class GrokProvider implements VisualProvider {
  readonly name = 'grok'
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
        model: params.model || 'grok-v1',
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
        model: params.model || 'grok-video',
        params: {},
      },
    }
  }
}
