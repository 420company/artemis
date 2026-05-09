import os from 'node:os';
import path from 'node:path';
import type { VisualModelConfig } from '../../../providers/types.js';
import {
  defaultVisualBaseUrlForProvider,
  defaultVisualModelForProvider,
} from '../../../utils/visualGenerationConfig.js';
import type {
  GenerationResult,
  VideoGenerationParams,
  VisualGenerationParams,
  VisualProvider,
} from './interface.js';
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  VIDEO_CREATE_TIMEOUT_MS,
  VIDEO_POLL_TIMEOUT_MS,
  ASSET_DOWNLOAD_TIMEOUT_MS,
} from './timeouts.js';

type OpenAIImageResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
  error?: { message?: string; type?: string; code?: string; param?: string };
};

type OpenAIVideoJob = {
  id?: string;
  status?: string;
  progress?: number;
  error?: { message?: string };
};

const IMAGE_OUTPUT_DIR = path.join(os.homedir(), '.artemis', 'assets', 'generated');
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_POLLS = 90;

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class OpenAIProvider implements VisualProvider {
  readonly name = 'openai';
  readonly supportsImages = true;
  readonly supportsVideos = true;

  private readonly config: VisualModelConfig;

  constructor(config: VisualModelConfig) {
    this.config = config;
  }

  async generateImage(params: VisualGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now();
    try {
      const imageConfig = this.config.image;
      const apiKey = imageConfig.apiKey?.trim();
      if (!apiKey) {
        throw new Error('OpenAI image API key is not configured.');
      }

      const model = params.model || imageConfig.model || defaultVisualModelForProvider('openai', 'image');
      const body: Record<string, unknown> = {
        model,
        prompt: params.prompt,
        n: Math.max(1, Math.min(4, Math.floor(params.count ?? 1))),
        size: mapOpenAIImageSize(params.size || imageConfig.defaultParams.size),
      };
      const quality = mapOpenAIImageQuality(model, params.quality || imageConfig.defaultParams.quality);
      if (quality) {
        body.quality = quality;
      }
      const outputFormat = mapOpenAIOutputFormat(params.outputFormat || imageConfig.defaultParams.outputFormat);
      if (outputFormat) {
        body.output_format = outputFormat;
      }
      const outputCompression = mapOpenAIOutputCompression(
        params.outputCompression ?? imageConfig.defaultParams.outputCompression,
        outputFormat,
      );
      if (outputCompression !== undefined) {
        body.output_compression = outputCompression;
      }
      const background = mapOpenAIImageBackground(model, params.background || imageConfig.defaultParams.background);
      if (background) {
        body.background = background;
      }

      const endpoint = `${normalizeBaseUrl(imageConfig.baseUrl, 'openai')}/images/generations`;
      let effectiveBody = body;
      let res = await postOpenAIImageGeneration(endpoint, apiKey, effectiveBody);
      let raw = await res.text();
      if (!res.ok && shouldRetryOpenAIImageMinimalRequest({
        status: res.status,
        raw,
        baseUrl: imageConfig.baseUrl,
        body: effectiveBody,
      })) {
        effectiveBody = { model, prompt: params.prompt };
        res = await postOpenAIImageGeneration(endpoint, apiKey, effectiveBody);
        raw = await res.text();
      }
      // OpenAI-compatible relays (e.g. http://69.5.20.196:8080/v1) periodically
      // return HTTP 429/500/502/503/504 during transient OpenAI hiccups. Retry
      // up to 2 more times with exponential backoff before surfacing the error.
      const transientStatuses = new Set([429, 500, 502, 503, 504]);
      let transientAttempts = 0;
      while (!res.ok && transientStatuses.has(res.status) && transientAttempts < 2) {
        transientAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 2000 * transientAttempts));
        res = await postOpenAIImageGeneration(endpoint, apiKey, effectiveBody);
        raw = await res.text();
      }
      if (!res.ok) {
        throw new Error(buildOpenAIImageError({
          status: res.status,
          raw,
          baseUrl: imageConfig.baseUrl,
          model,
        }));
      }

      let payload: OpenAIImageResponse;
      try {
        payload = JSON.parse(raw) as OpenAIImageResponse;
      } catch {
        throw new Error(`OpenAI image generation returned invalid JSON: ${raw.slice(0, 500)}`);
      }

      const item = payload.data?.[0];
      if (!item) {
        throw new Error(`OpenAI image generation returned no image. ${payload.error?.message ?? ''}`.trim());
      }

      const buffer = item.b64_json
        ? Buffer.from(item.b64_json, 'base64')
        : item.url
          ? await downloadUrl(item.url)
          : null;
      if (!buffer) {
        throw new Error('OpenAI image response contained neither b64_json nor url.');
      }

      const imagePath = path.join(IMAGE_OUTPUT_DIR, `openai_image_${Date.now()}${extensionForOpenAIOutputFormat(outputFormat)}`);
      await writeFileEnsured(path.dirname(imagePath), path.basename(imagePath), buffer);

      return {
        success: true,
        assetPath: imagePath,
        generationTime: Date.now() - startTime,
        modelInfo: {
          provider: this.name,
          model,
          params: {
            size: effectiveBody.size,
            quality: effectiveBody.quality,
            outputFormat: effectiveBody.output_format,
            outputCompression: effectiveBody.output_compression,
            background: effectiveBody.background,
            count: effectiveBody.n,
            revisedPrompt: item.revised_prompt,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        generationTime: Date.now() - startTime,
      };
    }
  }

  async generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
    const startTime = Date.now();
    try {
      const videoConfig = this.config.video;
      const apiKey = videoConfig.apiKey?.trim();
      if (!apiKey) {
        throw new Error('OpenAI video API key is not configured.');
      }

      const model = params.model || videoConfig.model || defaultVisualModelForProvider('openai', 'video');
      const baseUrl = normalizeBaseUrl(videoConfig.baseUrl, 'openai');
      const seconds = mapOpenAIVideoSeconds(params.duration ?? durationStringToNumber(videoConfig.defaultParams.duration));
      const size = mapOpenAIVideoSize({
        model,
        ratio: params.ratio,
        resolution: videoConfig.defaultParams.resolution,
      });

      const body = new FormData();
      body.append('model', model);
      body.append('prompt', params.prompt);
      body.append('seconds', seconds);
      body.append('size', size);

      const createRes = await fetch(`${baseUrl}/videos`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_CREATE_TIMEOUT_MS)),
      });
      const createRaw = await createRes.text();
      if (!createRes.ok) {
        throw new Error(`OpenAI video create failed (HTTP ${createRes.status}): ${createRaw.slice(0, 800)}`);
      }

      const createJob = parseVideoJob(createRaw);
      const videoId = createJob.id;
      if (!videoId) {
        throw new Error(`OpenAI video create response contained no id: ${createRaw.slice(0, 500)}`);
      }

      const extraParams = params as unknown as { maxPolls?: unknown; pollIntervalMs?: unknown };
      const maxPolls = typeof extraParams.maxPolls === 'number'
        ? Math.max(1, Math.floor(extraParams.maxPolls))
        : DEFAULT_MAX_POLLS;
      const pollIntervalMs = typeof extraParams.pollIntervalMs === 'number'
        ? Math.max(2_000, Math.floor(extraParams.pollIntervalMs))
        : DEFAULT_POLL_INTERVAL_MS;

      let job = createJob;
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        const status = (job.status ?? '').toLowerCase();
        if (status === 'completed' || status === 'succeeded' || status === 'success') {
          break;
        }
        if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
          throw new Error(`OpenAI video ${videoId} failed. ${job.error?.message ?? ''}`.trim());
        }

        await abortableSleep(pollIntervalMs, params.abortSignal);
        const pollRes = await fetch(`${baseUrl}/videos/${encodeURIComponent(videoId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(VIDEO_POLL_TIMEOUT_MS)),
        });
        const pollRaw = await pollRes.text();
        if (!pollRes.ok) {
          throw new Error(`OpenAI video poll failed (HTTP ${pollRes.status}): ${pollRaw.slice(0, 800)}`);
        }
        job = parseVideoJob(pollRaw);
      }

      const finalStatus = (job.status ?? '').toLowerCase();
      if (finalStatus !== 'completed' && finalStatus !== 'succeeded' && finalStatus !== 'success') {
        throw new Error(`OpenAI video ${videoId} did not complete within ${maxPolls} polls. Last status: ${job.status ?? 'unknown'}.`);
      }

      const downloadRes = await fetch(`${baseUrl}/videos/${encodeURIComponent(videoId)}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: combineAbortSignals(params.abortSignal, AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS)),
      });
      if (!downloadRes.ok) {
        const detail = await downloadRes.text().catch(() => '');
        throw new Error(`OpenAI video download failed (HTTP ${downloadRes.status}): ${detail.slice(0, 800)}`);
      }

      const buffer = Buffer.from(await downloadRes.arrayBuffer());
      const videoPath = path.join(IMAGE_OUTPUT_DIR, `openai_video_${Date.now()}.mp4`);
      await writeFileEnsured(path.dirname(videoPath), path.basename(videoPath), buffer);

      return {
        success: true,
        assetPath: videoPath,
        generationTime: Date.now() - startTime,
        modelInfo: {
          provider: this.name,
          model,
          params: {
            id: videoId,
            seconds,
            size,
            progress: job.progress,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        generationTime: Date.now() - startTime,
      };
    }
  }
}

function normalizeBaseUrl(raw: string | undefined, provider: string): string {
  const fallback = defaultVisualBaseUrlForProvider(provider);
  const base = raw?.trim() || fallback;
  const normalized = base.replace(/\/+$/, '');
  if (provider.toLowerCase() === 'openai') {
    return normalized
      .replace(/\/images\/generations$/i, '')
      .replace(/\/videos$/i, '');
  }
  return normalized;
}

async function downloadUrl(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function postOpenAIImageGeneration(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
  });
}

async function writeFileEnsured(dir: string, fileName: string, buffer: Buffer): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), buffer);
}

function mapOpenAIImageSize(size: string | undefined): string {
  const normalized = (size || '').trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (/^\d{3,5}x\d{3,5}$/.test(normalized)) {
    return normalized;
  }
  if (normalized === '1k') return '1024x1024';
  if (normalized === '2k') return '2048x2048';
  if (normalized === '4k') return '3840x2160';
  if (normalized === 'portrait') return '1024x1536';
  if (normalized === 'landscape') {
    return '1536x1024';
  }
  if (normalized === '720p') return '1280x720';
  if (normalized === '1080p') return '2048x1152';
  return '1024x1024';
}

function mapOpenAIImageQuality(model: string, quality: string | undefined): string | undefined {
  const normalized = (quality || '').toLowerCase();
  if (model.toLowerCase().startsWith('dall-e-3')) {
    return normalized === 'high' || normalized === 'ultra' ? 'hd' : 'standard';
  }
  if (normalized === 'auto') return 'auto';
  if (normalized === 'ultra' || normalized === 'high') return 'high';
  if (normalized === 'standard') return 'medium';
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') return normalized;
  return undefined;
}

function mapOpenAIOutputFormat(format: string | undefined): 'png' | 'jpeg' | 'webp' | undefined {
  const normalized = (format || '').trim().toLowerCase();
  if (normalized === 'jpg' || normalized === 'jpeg') return 'jpeg';
  if (normalized === 'png' || normalized === 'webp') return normalized;
  return undefined;
}

function mapOpenAIOutputCompression(
  compression: number | undefined,
  outputFormat: 'png' | 'jpeg' | 'webp' | undefined,
): number | undefined {
  if (outputFormat !== 'jpeg' && outputFormat !== 'webp') {
    return undefined;
  }
  if (typeof compression !== 'number' || !Number.isFinite(compression)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round(compression)));
}

function mapOpenAIImageBackground(model: string, background: string | undefined): 'auto' | 'opaque' | 'transparent' | undefined {
  const normalized = (background || '').trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized !== 'auto' && normalized !== 'opaque' && normalized !== 'transparent') {
    return undefined;
  }
  if (model.toLowerCase() === 'gpt-image-2' && normalized === 'transparent') {
    throw new Error('gpt-image-2 does not support background: "transparent". Use background: "auto" or "opaque".');
  }
  return normalized;
}

function buildOpenAIImageError(options: {
  status: number;
  raw: string;
  baseUrl: string | undefined;
  model: string;
}): string {
  const payload = parseOpenAIErrorPayload(options.raw);
  const error = payload?.error;
  const parts = [`OpenAI image generation failed (HTTP ${options.status})`];
  if (error?.message) {
    parts.push(error.message);
  } else if (options.raw.trim()) {
    parts.push(options.raw.slice(0, 800));
  }
  if (error?.type) {
    parts.push(`type=${error.type}`);
  }
  if (error?.code) {
    parts.push(`code=${error.code}`);
  }
  if (error?.param) {
    parts.push(`param=${error.param}`);
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl, 'openai');
  if (options.status === 502 && error?.type === 'upstream_error') {
    if (isOfficialOpenAIBaseUrl(baseUrl)) {
      parts.push('OpenAI returned a temporary upstream 502; retry later, or test a neutral prompt to separate service availability from prompt/content issues');
    } else {
      parts.push(`The configured image base URL is an OpenAI-compatible relay (${describeBaseUrl(baseUrl)}), not api.openai.com; the relay returned upstream_error before exposing the real upstream failure`);
      parts.push(`Verify the relay supports POST /v1/images/generations for ${options.model}, can reach OpenAI, and uses an organization verified for GPT Image models`);
    }
  }

  return parts.join('. ');
}

function shouldRetryOpenAIImageMinimalRequest(options: {
  status: number;
  raw: string;
  baseUrl: string | undefined;
  body: Record<string, unknown>;
}): boolean {
  const payload = parseOpenAIErrorPayload(options.raw);
  const baseUrl = normalizeBaseUrl(options.baseUrl, 'openai');
  return options.status === 502 &&
    payload?.error?.type === 'upstream_error' &&
    !isOfficialOpenAIBaseUrl(baseUrl) &&
    Object.keys(options.body).some((key) => key !== 'model' && key !== 'prompt');
}

function parseOpenAIErrorPayload(raw: string): OpenAIImageResponse | null {
  try {
    return JSON.parse(raw) as OpenAIImageResponse;
  } catch {
    return null;
  }
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function describeBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return baseUrl;
  }
}

function extensionForOpenAIOutputFormat(format: 'png' | 'jpeg' | 'webp' | undefined): string {
  if (format === 'jpeg') return '.jpg';
  if (format === 'webp') return '.webp';
  return '.png';
}

function durationStringToNumber(duration: string): number {
  const n = Number.parseInt(duration, 10);
  return Number.isFinite(n) ? n : 8;
}

function mapOpenAIVideoSeconds(duration: number): string {
  const allowed = [4, 8, 12, 16, 20];
  const requested = Math.max(1, Math.floor(duration));
  return String(allowed.find((value) => value >= requested) ?? allowed[allowed.length - 1]);
}

function mapOpenAIVideoSize(options: {
  model: string;
  ratio?: string;
  resolution?: string;
}): string {
  const portrait = options.ratio === '9:16' || options.ratio === 'portrait';
  const pro = options.model.toLowerCase().includes('pro');
  const highResolution = options.resolution === '1080p' || options.resolution === '4k';
  if (pro && highResolution) {
    return portrait ? '1080x1920' : '1920x1080';
  }
  return portrait ? '720x1280' : '1280x720';
}

function parseVideoJob(raw: string): OpenAIVideoJob {
  try {
    return JSON.parse(raw) as OpenAIVideoJob;
  } catch {
    throw new Error(`OpenAI video response was invalid JSON: ${raw.slice(0, 500)}`);
  }
}

