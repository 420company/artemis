/**
 * The slice of the soundtrack a segment is filmed over.
 *
 * Seedance 2.5 takes an audio reference (videoCapabilities.ts declares
 * referenceInputs: ['image', 'video', 'audio']) and animates to it: the cut
 * points, the motion and a performer's timing follow the audio it is given.
 * Saga never used that. It carried a soundtrack only as far as the renderer,
 * which mixed the real track over silent footage at the end — so a music
 * video's picture was never actually on the beat, and whether it looked
 * synced was luck.
 *
 * Each segment needs its own slice, not the whole track: the model matches
 * what it hears to what it renders, and a 30-second clip handed three minutes
 * of music has no way to know which three seconds are its own.
 */

import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { toolWarn } from '../../utils/log.js';

const execFileAsync = promisify(execFile);

export type SegmentSoundtrackRequest = {
  /** The whole track. */
  soundtrackPath: string;
  /** Where in the track the film starts (the owner's soundtrackStartSec). */
  startOffsetSec: number;
  /** Where this segment starts, relative to the film. */
  segmentStartSec: number;
  segmentDurationSec: number;
  /** Where the slices are written. */
  outputDir: string;
  segmentIndex: number;
};

/**
 * Cuts the segment's own slice out of the track. Re-encoded to AAC rather
 * than stream-copied: a copy cuts at the nearest keyframe, which drifts the
 * slice by up to a frame of audio and is exactly the error that puts a lip
 * movement off the beat.
 */
export async function extractSegmentSoundtrack(
  request: SegmentSoundtrackRequest,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const start = Math.max(0, request.startOffsetSec + request.segmentStartSec);
  const duration = Math.max(0.1, request.segmentDurationSec);
  const outputPath = path.join(
    request.outputDir,
    `${String(request.segmentIndex).padStart(3, '0')}.soundtrack.m4a`,
  );
  try {
    await mkdir(request.outputDir, { recursive: true });
    const { resolveFfmpegBinaryPath } = await import('./sagaRenderer/concat.js');
    const ffmpeg = await resolveFfmpegBinaryPath();
    await execFileAsync(
      ffmpeg,
      [
        '-y',
        // -ss before -i seeks fast; -accurate_seek keeps it sample-exact.
        '-accurate_seek', '-ss', start.toFixed(3),
        '-i', request.soundtrackPath,
        '-t', duration.toFixed(3),
        '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k',
        outputPath,
      ],
      { timeout: 120_000 },
    );
    const info = await stat(outputPath);
    if (!info.isFile() || info.size === 0) {
      return { ok: false, reason: `slice not written (size=${info.size})` };
    }
    return { ok: true, path: outputPath };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether this run should hand each segment its slice of the music.
 *
 * Only when the provider says it takes audio: an unsupported reference is
 * either ignored (paid for, no effect) or rejected (the segment fails), and
 * neither is worth guessing about.
 */
export function soundtrackReferenceEligible(options: {
  referenceInputs: readonly string[];
  soundtrackPath?: string | undefined;
  /** Raw passthrough sends the script alone; it adds no references either. */
  verbatimSegments: boolean;
}): boolean {
  if (!options.soundtrackPath?.trim()) return false;
  if (options.verbatimSegments) return false;
  return options.referenceInputs.includes('audio');
}

/**
 * The model generating its own audio while being handed the real track would
 * put two soundtracks in one clip, and the renderer mixes the real one in
 * anyway. So a run that follows the music does not also invent sound.
 */
export function generateAudioWithSoundtrack(options: {
  usingSoundtrackReference: boolean;
  requested: boolean;
}): boolean {
  return options.usingSoundtrackReference ? false : options.requested;
}

/** Reported once per run, not per segment. */
export function logSoundtrackReference(segmentCount: number): void {
  toolWarn(`画面将跟随配乐：每段都收到它自己那一段音乐（共 ${segmentCount} 段）。`);
}
