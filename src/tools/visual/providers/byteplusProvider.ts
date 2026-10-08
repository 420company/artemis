import { resolveArtemisHomeDir } from '../../../utils/fs.js'
import type { VisualModelConfig } from '../../../providers/types.js'
import type { VisualProvider, VisualGenerationParams, VideoGenerationParams, GenerationResult } from './interface.js'
import { modelArkEndpoint, normalizeModelArkMediaBaseUrl } from '../../vidarMedia.js'
import { ImageApiError } from '../imageGenerationFailure.js'
import { GenerationApiError } from '../generationFailure.js'
import { baseUrlIsLoopback, downloadProviderAsset } from '../safeDownload.js'
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  VIDEO_CREATE_TIMEOUT_MS,
  VIDEO_POLL_TIMEOUT_MS,
  ASSET_DOWNLOAD_TIMEOUT_MS,
} from './timeouts.js'
import { normalizeVideoDurationForProvider, normalizeVideoResolution } from '../videoParams.js'
import {
  formatUnsupportedVideoReferences,
  getUnsupportedVideoReferences,
  isGeneratedAudioUnsupported,
  resolveVideoModelCapabilities,
} from '../videoCapabilities.js'
import { checkBytePlusReferenceSupport } from '../referenceImages.js'

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class BytePlusProvider implements VisualProvider {
  readonly name = 'byteplus'
  readonly supportsImages = true
  readonly supportsVideos = true
  readonly supportsImageReferences = true
  
  private config: VisualModelConfig
  private assetType: 'image' | 'video'

  constructor(config: VisualModelConfig, assetType: 'image' | 'video') {
    this.config = config
    this.assetType = assetType
  }

  // Resolved per call, inside each method's try, so a misconfigured base URL
  // becomes a failed result instead of an unhandled rejection.
  private async resolveCredentials(): Promise<{ apiKey: string; baseUrl: string }> {
    if (this.assetType === 'image') {
      return {
        apiKey: this.config.image.apiKey,
        baseUrl: normalizeModelArkMediaBaseUrl(this.config.image.baseUrl)
      }
    } else {
      return {
        apiKey: this.config.video.apiKey,
        baseUrl: normalizeModelArkMediaBaseUrl(this.config.video.baseUrl)
      }
    }
  }

  async generateImage(params: VisualGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now()
    try {
      const { apiKey, baseUrl } = await this.resolveCredentials()
      const model = params.model || this.config.image.model || 'seedream-5-0-260128'
      const size = params.size || this.config.image.defaultParams.size || '2K'
      const count = params.count || 1
      const referenceImages = params.referenceImages ?? []
      const referenceError = checkBytePlusReferenceSupport(model, referenceImages.length)
      if (referenceError) {
        throw new Error(referenceError)
      }
      
      const endpoint = modelArkEndpoint(baseUrl, 'images/generations')
      const body: Record<string, unknown> = {
        model,
        prompt: params.prompt,
        size,
        response_format: 'url',
        watermark: params.watermark ?? this.config.image.defaultParams.watermark ?? false,
        stream: false,
      }
      // ModelArk `image`: one URL/data URI as a string, several as an array.
      if (referenceImages.length === 1) {
        body.image = referenceImages[0]
      } else if (referenceImages.length > 1) {
        body.image = referenceImages
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
        signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
      })

      const raw = await res.text()
      if (!res.ok) {
        throw new ImageApiError(`API request failed (HTTP ${res.status}): ${raw.slice(0, 500)}`, res.status)
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

      let buf: Buffer
      try {
        buf = await downloadProviderAsset(item.url, {
          timeoutMs: ASSET_DOWNLOAD_TIMEOUT_MS,
          allowLoopback: baseUrlIsLoopback(baseUrl),
        })
      } catch (error) {
        throw new ImageApiError(
          `Image download failed: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          'download',
        )
      }
      
      const fs = await import('fs/promises')
      const path = await import('path')
      const os = await import('os')
      
      const tempDir = path.join(resolveArtemisHomeDir(), 'assets', 'generated')
      await fs.mkdir(tempDir, { recursive: true })
      const imagePath = path.join(tempDir, `byteplus_image_${Date.now()}.png`)
      
      await fs.writeFile(imagePath, buf)

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
        httpStatus: error instanceof ImageApiError ? error.status : undefined,
        failureStage: error instanceof ImageApiError ? error.stage : undefined,
        generationTime: Date.now() - startTime
      }
    }
  }

  async generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now()
    try {
      const { apiKey, baseUrl } = await this.resolveCredentials()
      const model = params.model || this.config.video.model || 'seedance-1-5-pro-251215'
      const ratio = params.ratio || '16:9'
      const duration = normalizeVideoDurationForProvider(params.duration, this.name, model)
      // Only a resolution the request asked for is sent. The configured
      // default is not: onboarding used to write 1080p there, and sending it
      // would bill every clip at 1080p; unset leaves the model's own default.
      const resolution = normalizeVideoResolution(params.resolution)
      const capabilities = resolveVideoModelCapabilities(this.name, model)
      const unsupportedReferences = getUnsupportedVideoReferences(params, capabilities)
      if (unsupportedReferences.length > 0) {
        throw new Error(
          `The selected video model does not accept ${formatUnsupportedVideoReferences(unsupportedReferences)}. Choose Seedance 2.0 Pro for full multimodal reference input.`,
        )
      }
      if (isGeneratedAudioUnsupported(params, capabilities)) {
        throw new Error('The selected video model cannot generate audio. Choose Seedance 2.0 Pro, or set generateAudio to false.')
      }
      
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

      // role:"first_frame" — image-to-video literal first-frame anchor.
      // Pins the exact opening frame of the generated video. Provider still
      // moderates this image; empirically it does NOT reliably bypass the
      // real-person privacy filter (the classifier inspects the bytes, not
      // the role tag). For real-person identity locking, prefer the Saga
      // long-video path which uses an illustrated turnaround as
      // role:"reference_image" + photoreal-output prompt directives.
      if (params.firstFrameImageUrls) {
        for (const url of params.firstFrameImageUrls) {
          if (typeof url === 'string' && url.trim()) {
            content.push({
              type: 'image_url',
              image_url: { url: url.trim() },
              role: 'first_frame',
            })
          }
        }
      }

      if (params.lastFrameImageUrls) {
        for (const url of params.lastFrameImageUrls) {
          if (typeof url === 'string' && url.trim()) {
            content.push({
              type: 'image_url',
              image_url: { url: url.trim() },
              role: 'last_frame',
            })
          }
        }
      }

      if (params.referenceVideoUrls) {
        for (const url of params.referenceVideoUrls) {
          if (typeof url === 'string' && url.trim()) {
            content.push({
              type: 'video_url',
              video_url: { url: url.trim() },
              role: 'reference_video',
            })
          }
        }
      }

      if (params.referenceAudioUrls) {
        for (const url of params.referenceAudioUrls) {
          if (typeof url === 'string' && url.trim()) {
            content.push({
              type: 'audio_url',
              audio_url: { url: url.trim() },
              role: 'reference_audio',
            })
          }
        }
      }

      const createEndpoint = modelArkEndpoint(baseUrl, 'contents/generations/tasks')
      const createBody = {
        model,
        content,
        ratio,
        duration,
        ...(resolution ? { resolution } : {}),
        generate_audio: capabilities.canGenerateAudio ? params.generateAudio !== false : false,
        watermark: params.watermark ?? this.config.video.defaultParams.watermark ?? false,
      }

      const createRes = await fetch(createEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(createBody),
        signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_CREATE_TIMEOUT_MS)),
      })

      const createRaw = await createRes.text()
      if (!createRes.ok) {
        throw new GenerationApiError(`Task create failed (HTTP ${createRes.status}): ${createRaw.slice(0, 500)}`, createRes.status)
      }

      const createPayload = JSON.parse(createRaw)
      const taskId = createPayload.id ?? createPayload.task_id
      
      if (!taskId) {
        throw new Error(`No task id in response. ${createPayload.error?.message ?? ''}`.trim())
      }

      const statusEndpoint = modelArkEndpoint(baseUrl, `contents/generations/tasks/${encodeURIComponent(taskId)}`)
      let videoUrl: string | undefined
      let lastStatus = 'pending'
      const maxPolls = 60
      const pollIntervalMs = 5000

      for (let attempt = 0; attempt < maxPolls; attempt++) {
        await sleep(pollIntervalMs, params.abortSignal)
        
        const pollRes = await fetch(statusEndpoint, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_POLL_TIMEOUT_MS)),
        })
        
        const pollRaw = await pollRes.text()
        if (!pollRes.ok) {
          throw new GenerationApiError(`Poll failed (HTTP ${pollRes.status}): ${pollRaw.slice(0, 500)}`, pollRes.status)
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

      let buf: Buffer
      try {
        buf = await downloadProviderAsset(videoUrl, {
          timeoutMs: ASSET_DOWNLOAD_TIMEOUT_MS,
          allowLoopback: baseUrlIsLoopback(baseUrl),
          signal: params.abortSignal,
        })
      } catch (error) {
        throw new GenerationApiError(`Video download failed: ${error instanceof Error ? error.message : String(error)}`, undefined, 'download')
      }
      
      const fs = await import('fs/promises')
      const path = await import('path')
      const os = await import('os')
      
      const tempDir = path.join(resolveArtemisHomeDir(), 'assets', 'generated')
      await fs.mkdir(tempDir, { recursive: true })
      const videoPath = path.join(tempDir, `byteplus_video_${Date.now()}.mp4`)
      
      await fs.writeFile(videoPath, buf)

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
            watermark: createBody.watermark,
            referenceImageCount: params.referenceImageUrls?.length ?? 0,
            referenceVideoCount: params.referenceVideoUrls?.length ?? 0,
            referenceAudioCount: params.referenceAudioUrls?.length ?? 0,
          }
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        httpStatus: error instanceof GenerationApiError ? error.status : undefined,
        failureStage: error instanceof GenerationApiError ? error.stage : undefined,
        generationTime: Date.now() - startTime
      }
    }
  }
}
