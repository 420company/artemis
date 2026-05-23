import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { writeSagaComposition, ratioToSize } from './composition.js';
import { lintSagaComposition, formatLintReport, manifestPathFor } from './lint.js';
import { inspectSagaComposition } from './inspect.js';
import { concatWithSagaRenderer, ensureFfmpegAvailable, ensureSegmentReadable } from './concat.js';
import { resolveFfmpegBinaryPath, resolveFfprobeBinaryPath } from './concat.js';
import { generateSagaReviewFrames } from './reviewFrames.js';
import type {
  SagaCompositionSpec,
  SagaEncodeOptions,
  SagaFps,
  SagaRatio,
  SagaRenderResult,
  SagaSegmentInput,
  SagaTransitionPlan,
} from './types.js';

export type SagaRenderRequest = {
  projectId: string;
  ratio: SagaRatio;
  fps?: SagaFps;
  segments: SagaSegmentInput[];
  transitions: SagaTransitionPlan[];
  hyperframesProjectDir: string; // composition output dir (Saga keeps the legacy path name)
  outputPath: string;
  workDir: string;
  identityCard: string;
  bible: string;
  encode?: Partial<SagaEncodeOptions>;
  colorMatch?: boolean;
  hasAudio?: boolean;
  soundtrack?: {
    path?: string;
    url?: string;
    startSec?: number;
    volumeDb?: number;
    environmentVolumeDb?: number;
    fadeInSec?: number;
    fadeOutSec?: number;
  };
};

function hasDirectAudioUrl(url: string): boolean {
  return /\.(?:mp3|wav|m4a|aac|flac|ogg)(?:[?#].*)?$/i.test(url);
}

async function resolveSoundtrackPath(soundtrack: SagaRenderRequest['soundtrack'], workDir: string): Promise<string | undefined> {
  if (!soundtrack) return undefined;
  if (soundtrack.path?.trim()) return soundtrack.path.trim();
  const url = soundtrack.url?.trim();
  if (!url) return undefined;
  if (!hasDirectAudioUrl(url)) throw new Error('soundtrackUrl must be a directly downloadable audio file URL (mp3/wav/m4a/aac/flac/ogg). Platform playback links are not supported.');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download soundtrackUrl: HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType && !/(?:audio|octet-stream)/i.test(contentType)) throw new Error(`soundtrackUrl did not return audio content (${contentType}).`);
  const ext = path.extname(new URL(url).pathname) || '.mp3';
  const out = path.join(workDir, `soundtrack${ext}`);
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

export type SagaDuckZone = { start: number; end: number };

// Compute timecode windows where dialogue is present. Each window covers an
// entire saga segment whose storyBeat contains an explicit dialogue marker
// (对白/旁白/台词/dialogue/voiceover/...). Used by the ducked BGM mix to drop
// the music underneath the voice; segment-level granularity keeps the filter
// simple and survives planner drift (the model rarely respects sub-segment
// dialogue start/end seconds exactly).
export function computeDialogueDuckZones(segments: SagaSegmentInput[]): SagaDuckZone[] {
  const markerRe = /[*_]*(?:对白|台词|旁白|字幕|dialogue|spoken\s*dialogue|spoken\s*line|voice\s*over|voiceover|narration|subtitle|caption|she\s*(?:says|whispers|murmurs)|he\s*(?:says|whispers|murmurs)|她\s*(?:说|低声说)|他\s*(?:说|低声说))[*_]*\s*(?:[（(][^）)]{0,40}[）)])?\s*[*_]*\s*[:：]\s*[“"'‘][^”"'’]{1,240}[”"'’]/iu;
  const zones: SagaDuckZone[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const duration = Math.max(0, segment.duration);
    if (markerRe.test(segment.storyBeat)) {
      zones.push({ start: cursor, end: cursor + duration });
    }
    cursor += duration;
  }
  // Merge contiguous zones so the per-frame volume expression has fewer
  // between() branches.
  const merged: SagaDuckZone[] = [];
  for (const zone of zones) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(zone.start - last.end) < 0.05) {
      last.end = zone.end;
    } else {
      merged.push({ ...zone });
    }
  }
  return merged;
}

function buildDuckVolumeExpression(zones: SagaDuckZone[], duckGain: number, baseGain: number): string {
  if (zones.length === 0) return baseGain.toString();
  const conditions = zones
    .map((zone) => `between(t,${zone.start.toFixed(3)},${zone.end.toFixed(3)})`)
    .join('+');
  return `if(gt(${conditions}\\,0)\\,${duckGain}\\,${baseGain})`;
}

async function mixSoundtrackIntoVideo(options: {
  inputVideoPath: string;
  outputVideoPath: string;
  soundtrackPath: string;
  durationSeconds: number;
  startSec?: number;
  volumeDb?: number;
  environmentVolumeDb?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  // When set, the BGM is mixed at a quieter base level and further reduced
  // inside each duck zone so dialogue stays clearly audible underneath. The
  // original "cover" mix (no duckZones) keeps the old volume relationship.
  duckZones?: SagaDuckZone[];
}): Promise<string[]> {
  const ffmpeg = await resolveFfmpegBinaryPath();
  const ffprobe = await resolveFfprobeBinaryPath();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  let inputHasAudio = false;
  try {
    const probe = await execFileAsync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', options.inputVideoPath], { timeout: 30_000 });
    inputHasAudio = probe.stdout.trim().toLowerCase() === 'audio';
  } catch {
    inputHasAudio = false;
  }
  const start = Math.max(0, options.startSec ?? 0);
  const duration = Math.max(0.1, options.durationSeconds);
  const duckMode = Array.isArray(options.duckZones);
  // Ducked mix: env at original level so dialogue stays present, BGM at a
  // quieter base so it sits underneath, and an extra ~-10 dB drop inside
  // each dialogue zone. Cover mix keeps the legacy ratio (BGM 6 dB above env).
  const musicDb = options.volumeDb ?? (duckMode ? -16 : -12);
  const envDb = options.environmentVolumeDb ?? (duckMode ? 0 : -18);
  const fadeIn = Math.max(0, options.fadeInSec ?? 0.3);
  const fadeOut = Math.max(0, options.fadeOutSec ?? 1.0);
  const fadeOutStart = Math.max(0, duration - fadeOut);
  const duckExpr = duckMode
    ? buildDuckVolumeExpression(options.duckZones ?? [], 0.32, 1)
    : '1';
  const filter = [
    `${inputHasAudio ? '[0:a]' : '[2:a]'}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${envDb}dB,atrim=duration=${duration.toFixed(3)},asetpts=N/SR/TB[env]`,
    `[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=start=${start.toFixed(3)}:duration=${duration.toFixed(3)},asetpts=N/SR/TB,volume=${musicDb}dB${fadeIn > 0 ? `,afade=t=in:st=0:d=${fadeIn.toFixed(3)}` : ''}${fadeOut > 0 ? `,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}` : ''}${duckMode && (options.duckZones?.length ?? 0) > 0 ? `,volume=${duckExpr}:eval=frame` : ''},apad=whole_dur=${duration.toFixed(3)}[bgm]`,
    `[env][bgm]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[outa]`,
  ].join(';');
  const args = [
    '-y',
    '-i', options.inputVideoPath,
    '-i', options.soundtrackPath,
    ...(!inputHasAudio ? ['-f', 'lavfi', '-t', duration.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'] : []),
    '-filter_complex', filter,
    '-map', '0:v:0',
    '-map', '[outa]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    options.outputVideoPath,
  ];
  await execFileAsync(ffmpeg, args, { timeout: 30 * 60_000 });
  return args;
}

function buildDuckedOutputPath(outputPath: string): string {
  const ext = path.extname(outputPath);
  const base = outputPath.slice(0, outputPath.length - ext.length);
  return `${base}_bgm_ducked${ext}`;
}

export async function renderSagaProject(request: SagaRenderRequest): Promise<SagaRenderResult> {
  const ffmpeg = await ensureFfmpegAvailable();
  if (!ffmpeg.ok) {
    throw new Error(`saga-renderer requires FFmpeg. ${ffmpeg.error ?? ''}`.trim());
  }

  const { width, height } = ratioToSize(request.ratio);
  const fps: SagaFps = request.fps ?? 30;
  const totalSeconds = request.segments.reduce((sum, segment) => sum + segment.duration, 0);

  const composition: SagaCompositionSpec = {
    projectId: request.projectId,
    ratio: request.ratio,
    width,
    height,
    fps,
    totalSeconds,
    hasAudio: Boolean(request.hasAudio),
    segments: request.segments,
    transitions: request.transitions,
    identityCard: request.identityCard,
    bible: request.bible,
  };

  const compositionPaths = await writeSagaComposition({
    hyperframesProjectDir: request.hyperframesProjectDir,
    composition,
    segments: request.segments,
    generateAudio: Boolean(request.hasAudio),
  });

  const lintReport = await lintSagaComposition({
    composition,
    segments: request.segments,
    htmlPath: compositionPaths.htmlPath,
    manifestPath: manifestPathFor(compositionPaths.htmlPath),
    segmentsExist: ensureSegmentReadable,
  });

  if (lintReport.errors > 0) {
    throw new Error(`saga lint failed before render:\n${formatLintReport(lintReport)}`);
  }

  const inspectReport = inspectSagaComposition({
    htmlPath: compositionPaths.htmlPath,
    composition,
    segments: request.segments,
  });

  const encode: SagaEncodeOptions = {
    quality: request.encode?.quality ?? 'standard',
    fps,
    width,
    height,
    gpu: request.encode?.gpu ?? 'auto',
    crf: request.encode?.crf,
    videoBitrate: request.encode?.videoBitrate,
    audio: Boolean(request.hasAudio),
  };

  const concatTargetPath = request.soundtrack?.path || request.soundtrack?.url
    ? path.join(request.workDir, `pre-soundtrack-${path.basename(request.outputPath)}`)
    : request.outputPath;

  const concatResult = await concatWithSagaRenderer({
    segments: request.segments,
    transitions: request.transitions,
    outputPath: concatTargetPath,
    workDir: request.workDir,
    encode,
    colorMatch: request.colorMatch ?? false,
    hasAudio: Boolean(request.hasAudio),
  });

  let finalFfmpegArgs = concatResult.ffmpegArgs;
  let soundtrackApplied = false;
  let soundtrackPath: string | undefined;
  let soundtrackDuckedPath: string | undefined;
  let soundtrackOriginalPath: string | undefined;
  let duckZones: SagaDuckZone[] | undefined;
  if (request.soundtrack?.path || request.soundtrack?.url) {
    soundtrackPath = await resolveSoundtrackPath(request.soundtrack, request.workDir);
    if (soundtrackPath) {
      // Variant 1 — legacy cover mix: BGM louder than env (kept for users who
      // want the music-forward soundtrack).
      finalFfmpegArgs = await mixSoundtrackIntoVideo({
        inputVideoPath: concatTargetPath,
        outputVideoPath: request.outputPath,
        soundtrackPath,
        durationSeconds: concatResult.durationSeconds,
        startSec: request.soundtrack.startSec,
        volumeDb: request.soundtrack.volumeDb,
        environmentVolumeDb: request.soundtrack.environmentVolumeDb,
        fadeInSec: request.soundtrack.fadeInSec,
        fadeOutSec: request.soundtrack.fadeOutSec,
      });
      soundtrackApplied = true;
      // Variant 2 — ducked mix: BGM sits under the env mix, drops further
      // inside the dialogue zones detected from the script.
      duckZones = computeDialogueDuckZones(request.segments);
      const duckedOutputPath = buildDuckedOutputPath(request.outputPath);
      await mixSoundtrackIntoVideo({
        inputVideoPath: concatTargetPath,
        outputVideoPath: duckedOutputPath,
        soundtrackPath,
        durationSeconds: concatResult.durationSeconds,
        startSec: request.soundtrack.startSec,
        // Intentionally do NOT forward volumeDb / environmentVolumeDb here:
        // the ducked variant uses its own quieter base levels regardless of
        // the cover-mix levels the user picked.
        fadeInSec: request.soundtrack.fadeInSec,
        fadeOutSec: request.soundtrack.fadeOutSec,
        duckZones,
      });
      soundtrackDuckedPath = duckedOutputPath;
      // Variant 0 — concatenated original audio mix (no BGM), already written
      // by concat above as concatTargetPath. Surface it so the caller can
      // list all three deliverables instead of treating it as an internal
      // intermediate.
      soundtrackOriginalPath = concatTargetPath;
    }
  }

  return {
    ok: true,
    outputPath: request.outputPath,
    durationSeconds: concatResult.durationSeconds,
    ffmpegArgs: finalFfmpegArgs,
    soundtrackApplied,
    soundtrackPath,
    soundtrackDuckedPath,
    soundtrackOriginalPath,
    soundtrackDuckZones: duckZones,
    encoderUsed: concatResult.encoderName,
    appliedTransitions: concatResult.appliedTransitions,
    reviewFrames: await generateSagaReviewFrames({
      videoPath: request.outputPath,
      projectDir: request.workDir,
      segments: request.segments,
      totalSeconds: concatResult.durationSeconds,
    }),
    diagnostics: {
      lint: lintReport,
      inspect: inspectReport,
    },
  };
}

export type SagaRendererPaths = {
  htmlPath: string;
  runtimePath: string;
  designPath: string;
  manifestPath: string;
  readmePath: string;
};

export function defaultCompositionPathsFor(hyperframesProjectDir: string): SagaRendererPaths {
  return {
    htmlPath: path.join(hyperframesProjectDir, 'index.html'),
    runtimePath: path.join(hyperframesProjectDir, 'saga-runtime.js'),
    designPath: path.join(hyperframesProjectDir, 'design.md'),
    manifestPath: path.join(hyperframesProjectDir, 'saga.json'),
    readmePath: path.join(hyperframesProjectDir, 'README.md'),
  };
}

export { lintSagaComposition, formatLintReport } from './lint.js';
export { inspectSagaComposition } from './inspect.js';
export { describeTransition, planTransition } from './transitions.js';
export {
  buildContinuityBible,
  buildStartingFrameAnchor,
  compileShotPromptWithContinuity,
  extractLastFrame,
  chainFramePathFor,
  pickContinuityMode,
} from './continuity.js';
export type { SagaContinuityMode } from './continuity.js';
export { describeImageMotion } from './imageMotion.js';
export type * from './types.js';
