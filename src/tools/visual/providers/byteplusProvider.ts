import type { VisualModelConfig } from '../../../providers/types.js'
import type { VisualProvider, VisualGenerationParams, VideoGenerationParams, GenerationResult } from './interface.js'
import { normalizeBytePlusMediaBaseUrl } from '../../byteplusMedia.js'

export class BytePlusProvider implements VisualProvider {
  readonly name = 'byteplus'
  readonly supportsImages = true
  readonly supportsVideos = true
  
  private config: VisualModelConfig
  private assetType: 'image' | 'video'
  private credentialsPromise: Promise<{ apiKey: string; baseUrl: string }>

  constructor(config: VisualModelConfig, assetType: 'image' | 'video') {
    this.config = config
    this.assetType = assetType
    this.credentialsPromise = this.resolveCredentials()
  }

  private async resolveCredentials(): Promise<{ apiKey: string; baseUrl: string }> {
    if (this.assetType === 'image') {
      return {
        apiKey: this.config.image.apiKey,
        baseUrl: normalizeBytePlusMediaBaseUrl(this.config.image.baseUrl)
      }
    } else {
      return {
        apiKey: this.config.video.apiKey,
        baseUrl: normalizeBytePlusMediaBaseUrl(this.config.video.baseUrl)
      }
    }
  }

  async generateImage(params: VisualGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now()
    try {
      const { apiKey, baseUrl } = await this.credentialsPromise
      const model = params.model || this.config.image.model || 'seedream-5-0-260128'
      const size = params.size || this.config.image.defaultParams.size || '2K'
      const count = params.count || 1
      
      const endpoint = `${baseUrl}/images/generations`
      const body: Record<string, unknown> = {
        model,
        prompt: params.prompt,
        size,
        response_format: 'url',
        watermark: params.watermark ?? this.config.image.defaultParams.watermark ?? false,
        stream: false,
      }
      
      if (count > 1) {
        body['sequential_image_generation'] = 'auto'
        body['sequential_image_generation_options'] = { max_images: count }
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      })

      const raw = await res.text()
      if (!res.ok) {
        throw new Error(`API request failed (HTTP ${res.status}): ${raw.slice(0, 500)}`)
      }

      const payload = JSON.parse(raw)
      const items = payload.data ?? []
      if (!items.length) {
        throw new Error(`API returned no images. ${payload.error?.message ?? ''}`.trim())
      }

      const item = items[0]
      if (!item?.url) {
        throw new Error('Response contained no downloadable URLs.')
      }

      const imageRes = await fetch(item.url)
      if (!imageRes.ok) {
        throw new Error(`Image download failed: HTTP ${imageRes.status}`)
      }

      const buf = await imageRes.arrayBuffer()
      
      const fs = await import('fs/promises')
      const path = await import('path')
      const os = await import('os')
      
      const tempDir = path.join(os.homedir(), '.artemis', 'assets', 'generated')
      await fs.mkdir(tempDir, { recursive: true })
      const imagePath = path.join(tempDir, `byteplus_image_${Date.now()}.png`)
      
      await fs.writeFile(imagePath, Buffer.from(buf))

      return {
        success: true,
        assetPath: imagePath,
        generationTime: Date.now() - startTime,
        modelInfo: {
          provider: this.name,
          model,
          params: {
            size,
            quality: this.config.image.defaultParams.quality,
            style: this.config.image.defaultParams.style,
            watermark: body.watermark,
            count
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
      const { apiKey, baseUrl } = await this.credentialsPromise
      const model = params.model || this.config.video.model || 'seedance-1-5-pro-251215'
      const ratio = params.ratio || '16:9'
      const duration = params.duration || 5
      
      const content: Array<Record<string, unknown>> = [
        { type: 'text', text: params.prompt },
      ]
      
      if (params.referenceImageUrls) {
        for (const url of params.referenceImageUrls) {
          if (typeof url === 'string' && url.trim()) {
            content.push({
              type: 'image_url',
              image_url: { url: url.trim() },
              role: 'reference_image',
            })
          }
        }
      }

      const createEndpoint = `${baseUrl}/contents/generations/tasks`
      const createBody = {
        model,
        content,
        ratio,
        duration,
        generate_audio: params.generateAudio !== false,
        watermark: params.watermark ?? this.config.video.defaultParams.watermark ?? false,
      }

      const createRes = await fetch(createEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(createBody),
      })

      const createRaw = await createRes.text()
      if (!createRes.ok) {
        throw new Error(`Task create failed (HTTP ${createRes.status}): ${createRaw.slice(0, 500)}`)
      }

      const createPayload = JSON.parse(createRaw)
      const taskId = createPayload.id ?? createPayload.task_id
      
      if (!taskId) {
        throw new Error(`No task id in response. ${createPayload.error?.message ?? ''}`.trim())
      }

      const statusEndpoint = `${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`
      let videoUrl: string | undefined
      let lastStatus = 'pending'
      const maxPolls = 60
      const pollIntervalMs = 5000

      for (let attempt = 0; attempt < maxPolls; attempt++) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
        
        const pollRes = await fetch(statusEndpoint, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        
        const pollRaw = await pollRes.text()
        if (!pollRes.ok) {
          throw new Error(`Poll failed (HTTP ${pollRes.status}): ${pollRaw.slice(0, 500)}`)
        }
        
        let pollPayload: any
        try {
          pollPayload = JSON.parse(pollRaw)
        } catch {
          continue
        }
        
        lastStatus = (pollPayload.status ?? '').toLowerCase()
        if (lastStatus === 'failed' || lastStatus === 'cancelled' || lastStatus === 'canceled') {
          throw new Error(`Task ${taskId} ended with status=${lastStatus}. ${pollPayload.error?.message ?? ''}`.trim())
        }
        
        const maybeUrl = 
          pollPayload.content?.video_url ??
          pollPayload.content?.url ??
          pollPayload.video_url ??
          pollPayload.url
          
        if (maybeUrl && (lastStatus === 'succeeded' || lastStatus === 'completed' || lastStatus === 'success' || lastStatus === '')) {
          videoUrl = maybeUrl
          break
        }
      }

      if (!videoUrl) {
        throw new Error(`Task ${taskId} did not finish within ${maxPolls} polls. Last status: ${lastStatus}.`)
      }

      const videoRes = await fetch(videoUrl)
      if (!videoRes.ok) {
        throw new Error(`Video download failed: HTTP ${videoRes.status}`)
      }

      const buf = await videoRes.arrayBuffer()
      
      const fs = await import('fs/promises')
      const path = await import('path')
      const os = await import('os')
      
      const tempDir = path.join(os.homedir(), '.artemis', 'assets', 'generated')
      await fs.mkdir(tempDir, { recursive: true })
      const videoPath = path.join(tempDir, `byteplus_video_${Date.now()}.mp4`)
      
      await fs.writeFile(videoPath, Buffer.from(buf))

      return {
        success: true,
        assetPath: videoPath,
        generationTime: Date.now() - startTime,
        modelInfo: {
          provider: this.name,
          model,
          params: {
            duration,
            ratio,
            quality: this.config.video.defaultParams.quality,
            style: this.config.video.defaultParams.style,
            generateAudio: createBody.generate_audio,
            watermark: createBody.watermark
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
}
