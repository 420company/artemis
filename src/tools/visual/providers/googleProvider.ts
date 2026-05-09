/**
 * Google Veo (video) + Gemini (image) provider.
 *
 * Image: gemini-2.5-flash-image via :generateContent with responseModalities=["IMAGE"]
 * Video: veo-3.0-generate-preview via :predictLongRunning, then poll operations
 */

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import type { VisualModelConfig } from '../../../providers/types.js'
import type {
  GenerationResult,
  VideoGenerationParams,
  VisualGenerationParams,
  VisualProvider,
} from './interface.js'
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  VIDEO_CREATE_TIMEOUT_MS,
  VIDEO_POLL_TIMEOUT_MS,
  ASSET_DOWNLOAD_TIMEOUT_MS,
} from './timeouts.js'

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

function ensureApiKey(config: VisualModelConfig, assetType: 'image' | 'video'): string {
  const slot = assetType === 'image' ? config.image : config.video
  const key = slot.apiKey?.trim()
  if (!key) throw new Error('Google provider missing API key (set in Visual config).')
  return key
}

function resolveBaseUrl(config: VisualModelConfig, assetType: 'image' | 'video'): string {
  const slot = assetType === 'image' ? config.image : config.video
  const url = slot.baseUrl?.trim() || GOOGLE_API_BASE
  return url.replace(/\/$/, '')
}

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

function deriveOutputPath(filename: string): string {
  const dir = path.join(homedir(), 'Desktop')
  return path.join(dir, filename)
}

export class GoogleProvider implements VisualProvider {
  readonly name = 'google'
  readonly supportsImages = true
  readonly supportsVideos = true

  constructor(private readonly config: VisualModelConfig, private readonly assetType: 'image' | 'video') {}

  async generateImage(params: VisualGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now()
    const model = params.model || this.config.image.model || 'gemini-2.5-flash-image'
    try {
      const apiKey = ensureApiKey(this.config, 'image')
      const baseUrl = resolveBaseUrl(this.config, 'image')
      const endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        }),
        signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Google Gemini image API ${response.status}: ${body.slice(0, 400)}`)
      }

      type GeminiPart = { inlineData?: { data?: string; mimeType?: string }; text?: string }
      const data = await response.json() as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> }
      const parts = data.candidates?.[0]?.content?.parts ?? []
      const imagePart = parts.find(p => p.inlineData?.data)
      if (!imagePart?.inlineData?.data) {
        throw new Error('Google Gemini image API returned no image data.')
      }

      const ext = (imagePart.inlineData.mimeType || 'image/png').split('/')[1] || 'png'
      const filename = `gemini-${Date.now()}.${ext}`
      const assetPath = deriveOutputPath(filename)
      await writeFile(assetPath, Buffer.from(imagePart.inlineData.data, 'base64'))

      return {
        success: true,
        assetPath,
        generationTime: Date.now() - startTime,
        modelInfo: { provider: this.name, model, params: {} },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        error: message,
        generationTime: Date.now() - startTime,
        modelInfo: { provider: this.name, model, params: {} },
      }
    }
  }

  async generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now()
    const model = params.model || this.config.video.model || 'veo-3.0-generate-preview'
    try {
      const apiKey = ensureApiKey(this.config, 'video')
      const baseUrl = resolveBaseUrl(this.config, 'video')
      const startEndpoint = `${baseUrl}/models/${encodeURIComponent(model)}:predictLongRunning?key=${encodeURIComponent(apiKey)}`

      const aspectRatio = params.ratio || '16:9'
      const durationSeconds = typeof params.duration === 'number' && params.duration > 0 ? params.duration : 8

      const startResponse = await fetch(startEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt: params.prompt }],
          parameters: { aspectRatio, durationSeconds, personGeneration: 'allow_all' },
        }),
        signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_CREATE_TIMEOUT_MS)),
      })
      if (!startResponse.ok) {
        const body = await startResponse.text().catch(() => '')
        throw new Error(`Google Veo predict ${startResponse.status}: ${body.slice(0, 400)}`)
      }
      const startBody = await startResponse.json() as { name?: string }
      if (!startBody.name) throw new Error('Google Veo predict response missing operation name.')

      const operationName = startBody.name
      const pollEndpoint = `${baseUrl}/${operationName}?key=${encodeURIComponent(apiKey)}`

      // Poll up to ~10 minutes (Veo takes 1-3 minutes typically)
      const maxAttempts = 60
      const pollIntervalMs = 10_000
      let videoUri: string | undefined
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(pollIntervalMs, params.abortSignal)
        const pollResponse = await fetch(pollEndpoint, { signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_POLL_TIMEOUT_MS)) })
        if (!pollResponse.ok) {
          const body = await pollResponse.text().catch(() => '')
          throw new Error(`Google Veo poll ${pollResponse.status}: ${body.slice(0, 400)}`)
        }
        type Sample = { video?: { uri?: string } }
        const pollBody = await pollResponse.json() as {
          done?: boolean
          error?: { message?: string }
          response?: { generatedSamples?: Sample[]; generatedVideos?: Sample[] }
        }
        if (pollBody.error) throw new Error(pollBody.error.message ?? 'Veo operation failed.')
        if (pollBody.done) {
          const samples = pollBody.response?.generatedSamples ?? pollBody.response?.generatedVideos ?? []
          videoUri = samples[0]?.video?.uri
          break
        }
      }
      if (!videoUri) throw new Error('Google Veo did not return a video within the timeout.')

      const downloadUrl = videoUri.includes('?') ? `${videoUri}&key=${encodeURIComponent(apiKey)}` : `${videoUri}?key=${encodeURIComponent(apiKey)}`
      const downloadResponse = await fetch(downloadUrl, { signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS)) })
      if (!downloadResponse.ok) {
        throw new Error(`Failed to download Veo video: ${downloadResponse.status}`)
      }
      const buffer = Buffer.from(await downloadResponse.arrayBuffer())
      const filename = `veo-${Date.now()}.mp4`
      const assetPath = deriveOutputPath(filename)
      await writeFile(assetPath, buffer)

      return {
        success: true,
        assetPath,
        generationTime: Date.now() - startTime,
        modelInfo: { provider: this.name, model, params: { aspectRatio, durationSeconds } },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        error: message,
        generationTime: Date.now() - startTime,
        modelInfo: { provider: this.name, model, params: {} },
      }
    }
  }
}
