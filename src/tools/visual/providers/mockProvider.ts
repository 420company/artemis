import { resolveArtemisHomeDir } from '../../../utils/fs.js'
import type { VisualModelConfig } from '../../../providers/types.js'
import type { VisualProvider, VisualGenerationParams, VideoGenerationParams, GenerationResult } from './interface.js'

export class MockProvider implements VisualProvider {
  readonly name = 'mock'
  readonly supportsImages = true
  readonly supportsVideos = true
  
  private config: VisualModelConfig
  private assetType: 'image' | 'video'

  constructor(config: VisualModelConfig, assetType: 'image' | 'video') {
    this.config = config
    this.assetType = assetType
  }

  async generateImage(params: VisualGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now()
    try {
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      const svgContent = this.generateSVGPlaceholder(params.prompt)
      
      const fs = await import('fs/promises')
      const path = await import('path')
      const os = await import('os')
      
      const tempDir = path.join(resolveArtemisHomeDir(), 'assets', 'generated')
      await fs.mkdir(tempDir, { recursive: true })
      
      const timestamp = Date.now()
      const imagePath = path.join(tempDir, `mock_image_${timestamp}.svg`)
      
      await fs.writeFile(imagePath, svgContent)

      return {
        success: true,
        assetPath: imagePath,
        generationTime: Date.now() - startTime,
        modelInfo: {
          provider: this.name,
          model: params.model || 'mock-image',
          params: {
            size: params.size || '2K',
            quality: params.quality || this.config.image.defaultParams.quality,
            style: params.style || this.config.image.defaultParams.style,
            watermark: params.watermark ?? false,
            count: params.count || 1
          }
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        generationTime: Date.now() - startTime
      }
    }
  }

  async generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now()
    try {
      await new Promise(resolve => setTimeout(resolve, 3000))
      
      const fs = await import('fs/promises')
      const path = await import('path')
      const os = await import('os')
      
      const tempDir = path.join(resolveArtemisHomeDir(), 'assets', 'generated')
      await fs.mkdir(tempDir, { recursive: true })
      
      const timestamp = Date.now()
      const videoPath = path.join(tempDir, `mock_video_${timestamp}.txt`)
      
      await fs.writeFile(videoPath, `Mock video content: ${params.prompt}`)

      return {
        success: true,
        assetPath: videoPath,
        generationTime: Date.now() - startTime,
        modelInfo: {
          provider: this.name,
          model: params.model || 'mock-video',
          params: {
            duration: params.duration || 5,
            ratio: params.ratio || '16:9',
            quality: params.quality || this.config.video.defaultParams.quality,
            style: params.style || this.config.video.defaultParams.style,
            generateAudio: params.generateAudio !== false,
            watermark: params.watermark ?? false
          }
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        generationTime: Date.now() - startTime
      }
    }
  }

  private generateSVGPlaceholder(prompt: string): string {
    const colors = [
      { bg: '#1a1a1a', text: '#fff' },
      { bg: '#e8d5d5', text: '#333' },
      { bg: '#f5f5f5', text: '#333' },
      { bg: '#2a1a1a', text: '#fff' },
      { bg: '#000000', text: '#fff' },
      { bg: '#c9a961', text: '#333' },
      { bg: '#f8f0e3', text: '#333' },
    ]
    
    const color = colors[Math.floor(Math.random() * colors.length)]
    const title = prompt.substring(0, 50) + (prompt.length > 50 ? '...' : '')
    
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">
  <rect width="1200" height="1600" fill="${color.bg}"/>
  <text x="600" y="800" font-family="Arial" font-size="48" fill="${color.text}" text-anchor="middle" dominant-baseline="middle">
    ${title}
  </text>
  <text x="600" y="900" font-family="Arial" font-size="24" fill="${color.text}" text-anchor="middle" dominant-baseline="middle" opacity="0.7">
    Mock Provider - SVG Placeholder
  </text>
</svg>
  `.trim()
  }
}
