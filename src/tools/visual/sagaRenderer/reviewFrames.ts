import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveFfmpegBinaryPath } from './concat.js';
import type { SagaSegmentInput } from './types.js';

const execFileAsync = promisify(execFile);

export type SagaReviewFramesResult = {
  ok: boolean;
  reviewDir: string;
  framePaths: string[];
  contactSheetPath?: string;
  error?: string;
};

function formatTimestamp(value: number): string {
  const fixed = Number(value.toFixed(1));
  return Number.isInteger(fixed) ? String(fixed) : fixed.toFixed(1);
}

function safeSeekTimes(segments: SagaSegmentInput[], totalSeconds: number): number[] {
  const out: number[] = [];
  let start = 0;
  for (const segment of segments) {
    const duration = Math.max(0, segment.duration);
    if (duration <= 0) continue;
    const candidates = [
      start + Math.min(0.5, Math.max(0.1, duration * 0.05)),
      start + duration * 0.3,
      start + duration * 0.6,
      start + Math.max(0.1, duration - 0.3),
    ];
    for (const candidate of candidates) {
      const clamped = Math.max(0, Math.min(totalSeconds - 0.05, candidate));
      if (!out.some((existing) => Math.abs(existing - clamped) < 0.05)) out.push(clamped);
    }
    start += duration;
  }
  return out;
}

export async function generateSagaReviewFrames(options: {
  videoPath: string;
  projectDir: string;
  segments: SagaSegmentInput[];
  totalSeconds: number;
}): Promise<SagaReviewFramesResult> {
  const reviewDir = path.join(options.projectDir, 'review-frames');
  const framePaths: string[] = [];
  try {
    await stat(options.videoPath);
    await mkdir(reviewDir, { recursive: true });
    const ffmpeg = await resolveFfmpegBinaryPath();
    const seekTimes = safeSeekTimes(options.segments, options.totalSeconds);
    for (const seek of seekTimes) {
      const label = formatTimestamp(seek);
      const framePath = path.join(reviewDir, `frame-${label}.jpg`);
      await execFileAsync(
        ffmpeg,
        ['-y', '-ss', seek.toFixed(3), '-i', options.videoPath, '-frames:v', '1', '-q:v', '2', framePath],
        { timeout: 60_000 },
      );
      framePaths.push(framePath);
    }

    const contactSheetPath = path.join(reviewDir, 'contact-sheet.jpg');
    if (framePaths.length > 0) {
      const listPath = path.join(reviewDir, 'contact-sheet-inputs.txt');
      const listBody = framePaths
        .map((framePath) => `file '${framePath.replace(/'/g, "'\\''")}'`)
        .join(os.EOL);
      await writeFile(listPath, listBody, 'utf8');
      await execFileAsync(
        ffmpeg,
        [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-vf', 'scale=480:-1,tile=4x3:padding=10:margin=10:color=white',
          '-frames:v', '1',
          '-q:v', '3',
          contactSheetPath,
        ],
        { timeout: 90_000 },
      );
    }

    return { ok: true, reviewDir, framePaths, contactSheetPath };
  } catch (error) {
    return {
      ok: false,
      reviewDir,
      framePaths,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
