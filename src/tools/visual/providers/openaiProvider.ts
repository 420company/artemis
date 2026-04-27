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

type OpenAIImageResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
  error?: { message?: string };
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

      const res = await fetch(`${normalizeBaseUrl(imageConfig.baseUrl, 'openai')}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(`OpenAI image generation failed (HTTP ${res.status}): ${raw.slice(0, 800)}`);
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
            size: body.size,
            quality,
            outputFormat,
            outputCompression,
            background,
            count: body.n,
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

        await sleep(pollIntervalMs);
        const pollRes = await fetch(`${baseUrl}/videos/${encodeURIComponent(videoId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
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
  return base.replace(/\/+$/, '');
}

async function downloadUrl(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
