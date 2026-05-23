import { resolveArtemisHomeDir } from '../../../utils/fs.js'
import os from 'node:os'
import path from 'node:path'
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
import { toolLog } from '../../../utils/log.js'

// Emit a progress line every Nth poll so the user can see the provider is
// being talked to (not hanging). Default 6 polls × 10s = one line per minute.
// Tunable upper bound on the chattiness inside the silent-poll loop.
const POLL_LOG_EVERY = 6

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

const OUTPUT_DIR = path.join(resolveArtemisHomeDir(), 'assets', 'generated')
const DEFAULT_POLL_INTERVAL_MS = 10_000
// 420 polls × 10s = 70 min hard cap per attempt. Empirically, dreamina-seedance
// processes long (800+ char) NSFW-with-anatomy-constraints prompts in 15-25 min;
// the prior 120-poll cap was too tight for those and cut off real generations
// that were still in 'processing'. The per-poll status log keeps long waits visible.
const DEFAULT_MAX_POLLS = 420

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
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
        signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
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

      // ─── Seedance / Wan protocol branch ───────────────────────────
      // Seedance uses POST /videos/generations + JSON content[] format.
      // Wan uses POST /videos/generations + JSON input format.
      // Both are supported by OpenAI-compatible proxy relays and native
      // BytePlus endpoints. The original /videos + FormData path
      // (generateVideoCustom) is for generic non-Seedance/Wan models only.
      if (isSeedanceModel(model)) {
        return this.generateVideoSeedance(params, apiKey, baseUrl, model, startedAt)
      }
      if (isWanModel(model)) {
        return this.generateVideoWan(params, apiKey, baseUrl, model, startedAt)
      }

      // ─── Original custom protocol (FormData + /videos) ────────────
      return this.generateVideoCustom(params, apiKey, baseUrl, model, startedAt)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        generationTime: Date.now() - startedAt,
      }
    }
  }

  /**
   * Wan 2.x API protocol — POST /videos/generations with JSON body
   * { model, duration, resolution, aspect_ratio, input: { prompt, media? }, parameters: { … } }
   * Poll: GET /videos/generations/{task_id}
   */
  private async generateVideoWan(
    params: VideoGenerationParams,
    apiKey: string,
    baseUrl: string,
    model: string,
    startedAt: number,
  ): Promise<GenerationResult> {
    try {
      const videoConfig = this.config.video
      const duration = params.duration ?? durationStringToNumber(videoConfig.defaultParams.duration)
      const durationNum = Math.max(1, Math.min(60, Math.floor(duration)))
      const ratio = params.ratio || '16:9'
      const promptExtend = videoConfig.nsfw === true
        ? false
        : (videoConfig.defaultParams as Record<string, unknown>).prompt_extend !== false

      // Local file paths are resolved and uploaded by generateVideo before the
      // provider is called. Provider protocol code should only send public URLs.

      // Build input.media array for reference images / first-frame
      const media: Array<{ type: string; url: string }> = []
      const allRefImageUrls = [
        ...(params.referenceImageUrls ?? []),
        ...(params.firstFrameImageUrls ?? []),
      ]
      for (const url of allRefImageUrls) {
        if (typeof url === 'string' && url.trim()) {
          media.push({ type: 'reference_image', url: url.trim() })
        }
      }
      // Wan 2.7-i2v uses first_frame role; if only 1 image and model is i2v, use first_frame
      if (media.length === 1 && /i2v$/i.test(model.trim())) {
        media[0].type = 'first_frame'
      }

      const input: Record<string, unknown> = { prompt: params.prompt }
      if (media.length > 0) {
        input.media = media
      }
      // Wan 2.6-i2v legacy: img_url at top of input
      if (allRefImageUrls.length === 1 && /^wan2\.6/i.test(model.trim())) {
        input.img_url = allRefImageUrls[0]
        delete input.media
      }
      // Wan 2.6-r2v legacy: reference_urls
      const allRefVideoUrls = params.referenceVideoUrls ?? []
      if (allRefVideoUrls.length > 0 && /^wan2\.6/i.test(model.trim())) {
        input.reference_urls = allRefVideoUrls
        delete input.media
      }

      const body: Record<string, unknown> = {
        model,
        duration: durationNum,
        resolution: videoConfig.defaultParams.resolution || '720p',
        aspect_ratio: ratio,
        input,
        parameters: {
          resolution: (videoConfig.defaultParams.resolution || '720p').toUpperCase(),
          ratio,
          duration: durationNum,
          prompt_extend: promptExtend,
          watermark: params.watermark === true,
        },
      }

      const createRes = await fetch(`${baseUrl}/videos/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_CREATE_TIMEOUT_MS)),
      })
      const createRaw = await createRes.text()
      if (!createRes.ok) {
        throw new Error(`Custom video create failed (HTTP ${createRes.status}): ${createRaw.slice(0, 800)}`)
      }

      let createPayload: WanVideoGenerationsResponse
      try {
        createPayload = JSON.parse(createRaw) as WanVideoGenerationsResponse
      } catch {
        throw new Error(`Custom video create response was invalid JSON: ${createRaw.slice(0, 500)}`)
      }

      const taskId = createPayload.id ?? createPayload.task_id
      if (!taskId) {
        throw new Error(`Custom video create response contained no id: ${createRaw.slice(0, 500)}`)
      }

      const extraParams = params as unknown as { maxPolls?: unknown; pollIntervalMs?: unknown }
      const maxPolls = typeof extraParams.maxPolls === 'number'
        ? Math.max(1, Math.floor(extraParams.maxPolls))
        : DEFAULT_MAX_POLLS
      const pollIntervalMs = typeof extraParams.pollIntervalMs === 'number'
        ? Math.max(2_000, Math.floor(extraParams.pollIntervalMs))
        : DEFAULT_POLL_INTERVAL_MS

      let videoUrl: string | undefined
      let lastStatus = 'pending'

      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        await abortableSleep(pollIntervalMs, params.abortSignal)
        const pollRes = await fetch(`${baseUrl}/videos/generations/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_POLL_TIMEOUT_MS)),
        })
        const pollRaw = await pollRes.text()
        if (!pollRes.ok) {
          throw new Error(`Custom video poll failed (HTTP ${pollRes.status}): ${pollRaw.slice(0, 800)}`)
        }
        let pollPayload: WanVideoGenerationsResponse
        try {
          pollPayload = JSON.parse(pollRaw) as WanVideoGenerationsResponse
        } catch {
          continue
        }
        lastStatus = (pollPayload.status ?? '').toLowerCase()
        if (lastStatus === 'failed' || lastStatus === 'cancelled' || lastStatus === 'canceled') {
          throw new Error(`Custom video ${taskId} failed. ${pollPayload.error?.message ?? ''}`.trim())
        }
        const maybeUrl = extractWanVideoUrl(pollPayload)
        if (maybeUrl && (lastStatus === 'succeeded' || lastStatus === 'completed' || lastStatus === 'success' || lastStatus === '')) {
          videoUrl = maybeUrl
          break
        }
        // Visibility: emit a status line every minute so the user knows the
        // provider is being talked to. Without this, a silent 'processing'
        // queue makes the whole tool look hung.
        if ((attempt + 1) % POLL_LOG_EVERY === 0) {
          const elapsedMin = Math.round(((attempt + 1) * pollIntervalMs) / 60_000)
          toolLog(`⏳ Custom video ${taskId}: poll ${attempt + 1}/${maxPolls} · status=${lastStatus || 'unknown'} · ${elapsedMin}min elapsed`)
        }
      }

      if (!videoUrl) {
        throw new Error(`Custom video ${taskId} did not complete within ${maxPolls} polls. Last status: ${lastStatus}.`)
      }

      const downloadRes = await fetch(videoUrl, {
        signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS)),
      })
      if (!downloadRes.ok) {
        throw new Error(`Custom video download failed (HTTP ${downloadRes.status})`)
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
            id: taskId,
            duration: durationNum,
            ratio,
            protocol: 'wan',
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

  /**
   * Seedance via OpenCrow — POST /videos/generations with BytePlus native JSON body
   * { model, content: [{type:"text",...}, {type:"image_url",...}], duration, resolution, ratio, generate_audio, … }
   * Poll: GET /videos/generations/{task_id}
   */
  private async generateVideoSeedance(
    params: VideoGenerationParams,
    apiKey: string,
    baseUrl: string,
    model: string,
    startedAt: number,
  ): Promise<GenerationResult> {
    try {
      const videoConfig = this.config.video
      const duration = params.duration ?? durationStringToNumber(videoConfig.defaultParams.duration)
      const durationNum = Math.max(1, Math.min(15, Math.floor(duration)))
      const ratio = params.ratio || '16:9'
      const promptExtend = videoConfig.nsfw === true
        ? false
        : (videoConfig.defaultParams as Record<string, unknown>).prompt_extend !== false

      // Local file paths are resolved and uploaded by generateVideo before the
      // provider is called. Seedance/Dreamina rejects data: URIs, so only public
      // URL fields are serialized here.

      // Build content array (BytePlus native format)
      const content: Array<Record<string, unknown>> = [
        { type: 'text', text: params.prompt },
      ]

      // Reference images
      const allRefImageUrls = [
        ...(params.referenceImageUrls ?? []),
      ]
      for (const url of allRefImageUrls) {
        content.push({
          type: 'image_url',
          image_url: { url },
          role: 'reference_image',
        })
      }

      // First-frame images
      const allFirstFrameUrls = [
        ...(params.firstFrameImageUrls ?? []),
      ]
      for (const url of allFirstFrameUrls) {
        content.push({
          type: 'image_url',
          image_url: { url },
          role: 'first_frame',
        })
      }

      // Last-frame images
      const allLastFrameUrls = [
        ...(params.lastFrameImageUrls ?? []),
      ]
      for (const url of allLastFrameUrls) {
        content.push({
          type: 'image_url',
          image_url: { url },
          role: 'last_frame',
        })
      }

      // Reference videos
      const allRefVideoUrls = [
        ...(params.referenceVideoUrls ?? []),
      ]
      for (const url of allRefVideoUrls) {
        content.push({
          type: 'video_url',
          video_url: { url },
          role: 'reference_video',
        })
      }

      // Reference audio
      const allRefAudioUrls = [
        ...(params.referenceAudioUrls ?? []),
      ]
      for (const url of allRefAudioUrls) {
        content.push({
          type: 'audio_url',
          audio_url: { url },
          role: 'reference_audio',
        })
      }

      const body: Record<string, unknown> = {
        model,
        content,
        duration: durationNum,
        resolution: videoConfig.defaultParams.resolution || '720p',
        ratio,
        generate_audio: params.generateAudio !== false && /^dreamina-seedance-2/i.test(model.trim()),
        prompt_extend: promptExtend,
        watermark: params.watermark === true,
      }

      const createRes = await fetch(`${baseUrl}/videos/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_CREATE_TIMEOUT_MS)),
      })
      const createRaw = await createRes.text()
      if (!createRes.ok) {
        throw new Error(`Custom video create failed (HTTP ${createRes.status}): ${createRaw.slice(0, 800)}`)
      }

      let createPayload: { id?: string; task_id?: string; status?: string; error?: { message?: string } }
      try {
        createPayload = JSON.parse(createRaw)
      } catch {
        throw new Error(`Custom video create response was invalid JSON: ${createRaw.slice(0, 500)}`)
      }

      const taskId = createPayload.id ?? createPayload.task_id
      if (!taskId) {
        throw new Error(`Custom video create response contained no id: ${createRaw.slice(0, 500)}`)
      }

      const extraParams = params as unknown as { maxPolls?: unknown; pollIntervalMs?: unknown }
      const maxPolls = typeof extraParams.maxPolls === 'number'
        ? Math.max(1, Math.floor(extraParams.maxPolls))
        : DEFAULT_MAX_POLLS
      const pollIntervalMs = typeof extraParams.pollIntervalMs === 'number'
        ? Math.max(2_000, Math.floor(extraParams.pollIntervalMs))
        : DEFAULT_POLL_INTERVAL_MS

      let videoUrl: string | undefined
      let lastStatus = 'pending'

      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        await abortableSleep(pollIntervalMs, params.abortSignal)
        const pollRes = await fetch(`${baseUrl}/videos/generations/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_POLL_TIMEOUT_MS)),
        })
        const pollRaw = await pollRes.text()
        if (!pollRes.ok) {
          throw new Error(`Custom video poll failed (HTTP ${pollRes.status}): ${pollRaw.slice(0, 800)}`)
        }
        let pollPayload: {
          id?: string
          status?: string
          content?: { video_url?: string; url?: string }
          video_url?: string
          url?: string
          error?: { message?: string }
        }
        try {
          pollPayload = JSON.parse(pollRaw)
        } catch {
          continue
        }
        lastStatus = (pollPayload.status ?? '').toLowerCase()
        if (lastStatus === 'failed' || lastStatus === 'cancelled' || lastStatus === 'canceled' || lastStatus === 'timeout') {
          throw new Error(`Custom video ${taskId} failed (status=${lastStatus}). ${pollPayload.error?.message ?? ''}`.trim())
        }
        const maybeUrl = pollPayload.content?.video_url ?? pollPayload.content?.url ?? pollPayload.video_url ?? pollPayload.url
        if (maybeUrl && (lastStatus === 'succeeded' || lastStatus === 'completed' || lastStatus === 'success')) {
          videoUrl = maybeUrl
          break
        }
        // Per-poll progress: one line per minute so silent 'processing'
        // queues no longer make the call look hung. This is the Seedance
        // path (dreamina-seedance-2-0-*) that the user is actively using.
        if ((attempt + 1) % POLL_LOG_EVERY === 0) {
          const elapsedMin = Math.round(((attempt + 1) * pollIntervalMs) / 60_000)
          toolLog(`⏳ 视频任务 ${taskId.slice(0, 12)}…: poll ${attempt + 1}/${maxPolls} · status=${lastStatus || 'unknown'} · ${elapsedMin}min elapsed`)
        }
      }

      if (!videoUrl) {
        throw new Error(`Custom video ${taskId} did not complete within ${maxPolls} polls. Last status: ${lastStatus}.`)
      }

      const downloadRes = await fetch(videoUrl, {
        signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS)),
      })
      if (!downloadRes.ok) {
        throw new Error(`Custom video download failed (HTTP ${downloadRes.status})`)
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
            id: taskId,
            duration: durationNum,
            ratio,
            protocol: 'seedance-opencrow',
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

  /**
   * Original custom video protocol — FormData + /videos endpoint
   */
  private async generateVideoCustom(
    params: VideoGenerationParams,
    apiKey: string,
    baseUrl: string,
    model: string,
    startedAt: number,
  ): Promise<GenerationResult> {
    try {
      const videoConfig = this.config.video
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
        signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_CREATE_TIMEOUT_MS)),
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

        await abortableSleep(pollIntervalMs, params.abortSignal)
        const pollRes = await fetch(`${baseUrl}/videos/${encodeURIComponent(videoId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_POLL_TIMEOUT_MS)),
        })
        const pollRaw = await pollRes.text()
        if (!pollRes.ok) {
          throw new Error(`Custom video poll failed (HTTP ${pollRes.status}): ${pollRaw.slice(0, 800)}`)
        }
        currentJob = parseVideoJob(pollRaw)
        if ((attempt + 1) % POLL_LOG_EVERY === 0) {
          const elapsedMin = Math.round(((attempt + 1) * pollIntervalMs) / 60_000)
          toolLog(`⏳ Custom video ${videoId}: poll ${attempt + 1}/${maxPolls} · status=${currentJob.status ?? 'unknown'} · ${elapsedMin}min elapsed`)
        }
      }

      const finalStatus = (currentJob.status ?? '').toLowerCase()
      if (finalStatus !== 'completed' && finalStatus !== 'succeeded' && finalStatus !== 'success') {
        throw new Error(`Custom video ${videoId} did not complete within ${maxPolls} polls. Last status: ${currentJob.status ?? 'unknown'}.`)
      }

      const downloadRes = await fetch(`${baseUrl}/videos/${encodeURIComponent(videoId)}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS)),
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
  const res = await fetch(url, { signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS) })
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

function isWanModel(model: string): boolean {
  return /^wan\d/i.test(model.trim())
}

function isSeedanceModel(model: string): boolean {
  const key = model.trim().toLowerCase()
  return key.startsWith('dreamina-seedance') || key.startsWith('seedance-')
}

type WanVideoGenerationsResponse = {
  id?: string
  task_id?: string
  status?: string
  content?: {
    video_url?: string
    url?: string
  }
  video_url?: string
  url?: string
  error?: { message?: string }
}

function extractWanVideoUrl(payload: WanVideoGenerationsResponse): string | undefined {
  return payload.content?.video_url ?? payload.content?.url ?? payload.video_url ?? payload.url
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
