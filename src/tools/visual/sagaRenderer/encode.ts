import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { SagaEncodeOptions, SagaQuality } from './types.js';

const execFileAsync = promisify(execFile);

// Quality presets picked to match Hyperframes' defaults: standard ≈ CRF 20,
// draft is fast (CRF 26 + ultrafast preset), high is CRF 16 + slow preset.
// When `videoBitrate` is provided we use bitrate mode and ignore CRF.

const QUALITY_DEFAULTS: Record<SagaQuality, { crf: number; preset: string; pixFmt: string }> = {
  draft: { crf: 26, preset: 'ultrafast', pixFmt: 'yuv420p' },
  standard: { crf: 20, preset: 'medium', pixFmt: 'yuv420p' },
  high: { crf: 16, preset: 'slow', pixFmt: 'yuv420p' },
};

export type SagaEncoderProfile = {
  // ffmpeg -c:v argument
  videoCodec: string;
  // human-readable name for diagnostics
  name: string;
  // arguments to append after -c:v that tune codec-specific knobs
  extraArgs: string[];
  // whether the codec is a hardware GPU encoder
  isGpu: boolean;
};

export async function detectAvailableEncoders(): Promise<SagaEncoderProfile[]> {
  // Always include libx264 as the safe baseline. Then probe ffmpeg for GPU
  // codecs. We don't fail if `ffmpeg -encoders` is unavailable — we just
  // return libx264 and let the caller choose.
  const baseline: SagaEncoderProfile = {
    videoCodec: 'libx264',
    name: 'libx264 (CPU)',
    extraArgs: [],
    isGpu: false,
  };
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 30_000 });
    const encoders: SagaEncoderProfile[] = [];
    if (process.platform === 'darwin' && /h264_videotoolbox/i.test(stdout)) {
      encoders.push({
        videoCodec: 'h264_videotoolbox',
        name: 'h264_videotoolbox (Apple GPU)',
        extraArgs: ['-allow_sw', '1'],
        isGpu: true,
      });
    }
    if (/h264_nvenc/i.test(stdout)) {
      encoders.push({
        videoCodec: 'h264_nvenc',
        name: 'h264_nvenc (NVIDIA GPU)',
        extraArgs: ['-rc', 'vbr', '-preset', 'p5'],
        isGpu: true,
      });
    }
    if (/h264_qsv/i.test(stdout)) {
      encoders.push({
        videoCodec: 'h264_qsv',
        name: 'h264_qsv (Intel Quick Sync)',
        extraArgs: [],
        isGpu: true,
      });
    }
    if (/h264_vaapi/i.test(stdout)) {
      // VAAPI requires an init device; we leave it out of the default list
      // because the call site would need to add `-vaapi_device` and a
      // `format=nv12,hwupload` filter chain. Power users can request it
      // explicitly later.
    }
    encoders.push(baseline);
    return encoders;
  } catch {
    return [baseline];
  }
}

export async function pickEncoder(options: SagaEncodeOptions): Promise<SagaEncoderProfile> {
  const encoders = await detectAvailableEncoders();
  if (options.gpu === 'off') {
    return encoders.find((profile) => !profile.isGpu) ?? encoders[encoders.length - 1]!;
  }
  if (options.gpu === 'on') {
    const gpu = encoders.find((profile) => profile.isGpu);
    if (gpu) return gpu;
  }
  // auto: prefer GPU when present, else CPU baseline.
  return encoders[0]!;
}

export function defaultEncodeOptions(opts: Partial<SagaEncodeOptions> & { width: number; height: number }): SagaEncodeOptions {
  return {
    quality: opts.quality ?? 'standard',
    fps: opts.fps ?? 30,
    width: opts.width,
    height: opts.height,
    gpu: opts.gpu ?? 'auto',
    crf: opts.crf,
    videoBitrate: opts.videoBitrate,
    audio: opts.audio ?? true,
  };
}

export type SagaCommonEncodeArgs = {
  args: string[];
  encoderName: string;
  isGpu: boolean;
};

export async function buildCommonEncodeArgs(options: SagaEncodeOptions): Promise<SagaCommonEncodeArgs> {
  const encoder = await pickEncoder(options);
  const preset = QUALITY_DEFAULTS[options.quality];
  const args: string[] = ['-c:v', encoder.videoCodec, ...encoder.extraArgs];

  // Bitrate vs CRF: bitrate wins when explicitly requested; when GPU encoders
  // don't honor CRF (NVENC, VideoToolbox) we translate quality → bitrate.
  if (options.videoBitrate) {
    args.push('-b:v', options.videoBitrate, '-maxrate', options.videoBitrate, '-bufsize', `${parseBitrate(options.videoBitrate) * 2}k`);
  } else if (encoder.isGpu) {
    const bitrate = qualityToBitrate(options.quality, options.width, options.height, options.fps);
    args.push('-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`);
  } else {
    const crf = options.crf ?? preset.crf;
    args.push('-preset', preset.preset, '-crf', String(crf));
  }
  args.push('-pix_fmt', preset.pixFmt, '-r', String(options.fps), '-movflags', '+faststart');
  if (options.audio) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-an');
  }
  return { args, encoderName: encoder.name, isGpu: encoder.isGpu };
}

function parseBitrate(spec: string): number {
  // Accept "10M", "5000k", "5000K", "5000".
  const trimmed = spec.trim();
  const num = Number.parseFloat(trimmed);
  if (!Number.isFinite(num)) return 5000;
  if (/m$/i.test(trimmed)) return Math.round(num * 1000);
  if (/k$/i.test(trimmed)) return Math.round(num);
  return Math.round(num);
}

function qualityToBitrate(quality: SagaQuality, width: number, height: number, fps: number): number {
  // Rough kbps target. For 1080p30: draft 4M, standard 8M, high 14M.
  const pixels = Math.max(1, width * height) / (1920 * 1080);
  const fpsMul = fps >= 50 ? 1.4 : fps <= 24 ? 0.85 : 1.0;
  const base = quality === 'draft' ? 4000 : quality === 'high' ? 14000 : 8000;
  return Math.round(base * pixels * fpsMul);
}

export function recommendedWorkerCount(options: { workers?: number }): number {
  if (typeof options.workers === 'number' && options.workers > 0) {
    return Math.max(1, Math.min(8, Math.floor(options.workers)));
  }
  // 4 workers is the Hyperframes-stated sweet spot for 1080p; bound by CPUs.
  return Math.max(1, Math.min(8, Math.floor(Math.max(2, os.cpus().length / 2))));
}
