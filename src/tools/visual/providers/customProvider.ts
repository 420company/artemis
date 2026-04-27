import os from 'node:os'
import path from 'node:path'
import type { VisualModelConfig } from '../../../providers/types.js'
import type {
  GenerationResult,
  VideoGenerationParams,
  VisualGenerationParams,
  VisualProvider,
} from './interface.js'

type CustomImageResponse = {
  data?: Array<{
    b64_json?: string
    url?: string
  }>
  error?: { message?: string }
}

type CustomVideoJob = {
  id?: string
  status?: string
  progress?: number
  error?: { message?: string }
}

const OUTPUT_DIR = path.join(os.homedir(), '.artemis', 'assets', 'generated')
const DEFAULT_POLL_INTERVAL_MS = 10_000
const DEFAULT_MAX_POLLS = 90

export class CustomProvider implements VisualProvider {
  readonly name = 'custom'
  readonly supportsImages = true
  readonly supportsVideos = true

  private readonly config: VisualModelConfig

  constructor(config: VisualModelConfig) {
    this.config = config
  }

  async generateImage(params: VisualGenerationParams): Promise<GenerationResult> {
    const startedAt = Date.now()
    try {
      const imageConfig = this.config.image
      const apiKey = imageConfig.apiKey?.trim()
      const baseUrl = normalizeRequiredBaseUrl(imageConfig.baseUrl, 'image')
      if (!apiKey) {
        throw new Error('Custom image API key is not configured.')
      }

      const model = params.model || imageConfig.model || 'custom-image'
      const body: Record<string, unknown> = {
        model,
        prompt: params.prompt,
        n: Math.max(1, Math.min(4, Math.floor(params.count ?? 1))),
        size: mapImageSize(params.size || imageConfig.defaultParams.size),
      }

      const quality = mapImageQuality(params.quality || imageConfig.defaultParams.quality)
      if (quality) {
        body.quality = quality
      }
      if (params.style || imageConfig.defaultParams.style) {
        body.style = params.style || imageConfig.defaultParams.style
      }

      const res = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      })
      const raw = await res.text()
      if (!res.ok) {
        throw new Error(`Custom image generation failed (HTTP ${res.status}): ${raw.slice(0, 800)}`)
      }

      let payload: CustomImageResponse
      try {
        payload = JSON.parse(raw) as CustomImageResponse
      } catch {
        throw new Error(`Custom image API returned invalid JSON: ${raw.slice(0, 500)}`)
      }

      const item = payload.data?.[0]
      if (!item) {
        throw new Error(`Custom image API returned no image. ${payload.error?.message ?? ''}`.trim())
      }

      const buffer = item.b64_json
        ? Buffer.from(item.b64_json, 'base64')
        : item.url
          ? await downloadUrl(item.url)
          : null
      if (!buffer) {
        throw new Error('Custom image response contained neither b64_json nor url.')
      }

      const imagePath = path.join(OUTPUT_DIR, `custom_image_${Date.now()}.png`)
      await writeFileEnsured(imagePath, buffer)

      return {
        success: true,
        assetPath: imagePath,
        generationTime: Date.now() - startedAt,
        modelInfo: {
          provider: this.name,
          model,
          params: {
            size: body.size,
            quality,
            count: body.n,
          },
        },
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        generationTime: Date.now() - startedAt,
      }
    }
  }

  async generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
    const startedAt = Date.now()
    try {
      const videoConfig = this.config.video
      const apiKey = videoConfig.apiKey?.trim()
      const baseUrl = normalizeRequiredBaseUrl(videoConfig.baseUrl, 'video')
      if (!apiKey) {
        throw new Error('Custom video API key is not configured.')
      }
      if (!videoConfig.enabled) {
        throw new Error('Custom video API is disabled in visualProfile.video.enabled.')
      }

      const model = params.model || videoConfig.model || 'custom-video'
      const seconds = mapVideoSeconds(params.duration ?? durationStringToNumber(videoConfig.defaultParams.duration))
      const size = mapVideoSize({
        ratio: params.ratio,
        resolution: videoConfig.defaultParams.resolution,
      })

      const body = new FormData()
      body.append('model', model)
      body.append('prompt', params.prompt)
      body.append('seconds', seconds)
      body.append('size', size)

      const createRes = await fetch(`${baseUrl}/videos`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      })
      const createRaw = await createRes.text()
      if (!createRes.ok) {
        throw new Error(`Custom video create failed (HTTP ${createRes.status}): ${createRaw.slice(0, 800)}`)
      }

      const job = parseVideoJob(createRaw)
      const videoId = job.id
      if (!videoId) {
        throw new Error(`Custom video create response contained no id: ${createRaw.slice(0, 500)}`)
      }

      const extraParams = params as unknown as { maxPolls?: unknown; pollIntervalMs?: unknown }
      const maxPolls = typeof extraParams.maxPolls === 'number'
        ? Math.max(1, Math.floor(extraParams.maxPolls))
        : DEFAULT_MAX_POLLS
      const pollIntervalMs = typeof extraParams.pollIntervalMs === 'number'
        ? Math.max(2_000, Math.floor(extraParams.pollIntervalMs))
        : DEFAULT_POLL_INTERVAL_MS

      let currentJob = job
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        const status = (currentJob.status ?? '').toLowerCase()
        if (status === 'completed' || status === 'succeeded' || status === 'success') {
          break
        }
        if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
          throw new Error(`Custom video ${videoId} failed. ${currentJob.error?.message ?? ''}`.trim())
        }

        await sleep(pollIntervalMs)
        const pollRes = await fetch(`${baseUrl}/videos/${encodeURIComponent(videoId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        const pollRaw = await pollRes.text()
        if (!pollRes.ok) {
          throw new Error(`Custom video poll failed (HTTP ${pollRes.status}): ${pollRaw.slice(0, 800)}`)
        }
        currentJob = parseVideoJob(pollRaw)
      }

      const finalStatus = (currentJob.status ?? '').toLowerCase()
      if (finalStatus !== 'completed' && finalStatus !== 'succeeded' && finalStatus !== 'success') {
        throw new Error(`Custom video ${videoId} did not complete within ${maxPolls} polls. Last status: ${currentJob.status ?? 'unknown'}.`)
      }

      const downloadRes = await fetch(`${baseUrl}/videos/${encodeURIComponent(videoId)}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!downloadRes.ok) {
        const detail = await downloadRes.text().catch(() => '')
        throw new Error(`Custom video download failed (HTTP ${downloadRes.status}): ${detail.slice(0, 800)}`)
      }

      const buffer = Buffer.from(await downloadRes.arrayBuffer())
      const videoPath = path.join(OUTPUT_DIR, `custom_video_${Date.now()}.mp4`)
      await writeFileEnsured(videoPath, buffer)

      return {
        success: true,
        assetPath: videoPath,
        generationTime: Date.now() - startedAt,
        modelInfo: {
          provider: this.name,
          model,
          params: {
            id: videoId,
            seconds,
            size,
            progress: currentJob.progress,
          },
        },
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        generationTime: Date.now() - startedAt,
      }
    }
  }
}

function normalizeRequiredBaseUrl(raw: string | undefined, assetKind: 'image' | 'video'): string {
  const base = raw?.trim().replace(/\/+$/, '')
  if (!base) {
    throw new Error(`Custom ${assetKind} base URL is required.`)
  }
  return base
}

async function downloadUrl(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

async function writeFileEnsured(filePath: string, buffer: Buffer): Promise<void> {
  const fs = await import('node:fs/promises')
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, buffer)
}

function mapImageSize(size: string | undefined): string {
  const normalized = (size || '').trim().toLowerCase()
  if (/^\d{3,5}x\d{3,5}$/.test(normalized)) {
    return normalized
  }
  if (normalized === 'portrait') return '1024x1536'
  if (normalized === 'landscape' || normalized === '2k' || normalized === '4k' || normalized === '720p' || normalized === '1080p') {
    return '1536x1024'
  }
  return '1024x1024'
}

function mapImageQuality(quality: string | undefined): string | undefined {
  const normalized = (quality || '').toLowerCase()
  if (normalized === 'ultra' || normalized === 'high') return 'high'
  if (normalized === 'standard') return 'medium'
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') return normalized
  return undefined
}

function durationStringToNumber(duration: string): number {
  const n = Number.parseInt(duration, 10)
  return Number.isFinite(n) ? n : 8
}

function mapVideoSeconds(duration: number): string {
  const allowed = [4, 8, 12, 16, 20]
  const requested = Math.max(1, Math.floor(duration))
  return String(allowed.find((value) => value >= requested) ?? allowed[allowed.length - 1])
}

function mapVideoSize(options: {
  ratio?: string
  resolution?: string
}): string {
  const portrait = options.ratio === '9:16' || options.ratio === 'portrait'
  const highResolution = options.resolution === '1080p' || options.resolution === '4k'
  if (highResolution) {
    return portrait ? '1080x1920' : '1920x1080'
  }
  return portrait ? '720x1280' : '1280x720'
}

function parseVideoJob(raw: string): CustomVideoJob {
  try {
    return JSON.parse(raw) as CustomVideoJob
  } catch {
    throw new Error(`Custom video response was invalid JSON: ${raw.slice(0, 500)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
