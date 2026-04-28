import type { VisualModelConfig } from '../../../providers/types.js'
import {
  buildPlaceholderVisualProviderError,
  type GenerationResult,
  type VisualGenerationParams,
  type VisualProvider,
} from './interface.js'

export class GeminiProvider implements VisualProvider {
  readonly name = 'gemini'
  readonly supportsImages = true
  readonly supportsVideos = false

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
        model: params.model || 'gemini-2.5-flash-image',
        params: {},
      },
    }
  }
}
