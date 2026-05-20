import path from 'node:path';
import { writeSagaComposition, ratioToSize } from './composition.js';
import { lintSagaComposition, formatLintReport, manifestPathFor } from './lint.js';
import { inspectSagaComposition } from './inspect.js';
import { concatWithSagaRenderer, ensureFfmpegAvailable, ensureSegmentReadable } from './concat.js';
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
};

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

  const concatResult = await concatWithSagaRenderer({
    segments: request.segments,
    transitions: request.transitions,
    outputPath: request.outputPath,
    workDir: request.workDir,
    encode,
    colorMatch: request.colorMatch ?? false,
    hasAudio: Boolean(request.hasAudio),
  });

  return {
    ok: true,
    outputPath: request.outputPath,
    durationSeconds: concatResult.durationSeconds,
    ffmpegArgs: concatResult.ffmpegArgs,
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
