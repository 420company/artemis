import { execFile } from 'node:child_process';
import { writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  cleanFadeColorFor,
  compileXfadeFilterArgs,
  describeTransition,
  isCleanFadeTransition,
  isHardCut,
  isShaderTransition,
} from './transitions.js';
import type {
  SagaEncodeOptions,
  SagaSegmentInput,
  SagaTransitionPlan,
} from './types.js';
import { buildCommonEncodeArgs } from './encode.js';
import { renderSagaShaderTransition, type SagaShaderName } from './shaderTransitions/index.js';

const execFileAsync = promisify(execFile);

// Resolve the ffmpeg / ffprobe binary path. The Saga gateway daemon is
// launched by launchd with a minimal PATH (just /usr/bin:/bin), so a bare
// `ffmpeg` spawn ENOENTs. We probe a list of common install locations
// once and cache the absolute path. Falls back to the bare name on the
// off-chance PATH does include it (interactive runs work that way).
let cachedFfmpegPath: string | null = null;
let cachedFfprobePath: string | null = null;

async function probeBinary(name: 'ffmpeg' | 'ffprobe'): Promise<string> {
  const candidates = [
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/bin/${name}`,
    `/snap/bin/${name}`,
    name, // last-resort PATH lookup
  ];
  const { stat } = await import('node:fs/promises');
  for (const candidate of candidates) {
    if (candidate === name) return candidate; // PATH lookup happens at spawn time
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try next
    }
  }
  return name;
}

async function ffmpegPath(): Promise<string> {
  if (cachedFfmpegPath !== null) return cachedFfmpegPath;
  cachedFfmpegPath = await probeBinary('ffmpeg');
  return cachedFfmpegPath;
}

async function ffprobePath(): Promise<string> {
  if (cachedFfprobePath !== null) return cachedFfprobePath;
  cachedFfprobePath = await probeBinary('ffprobe');
  return cachedFfprobePath;
}

export async function resolveFfmpegBinaryPath(): Promise<string> {
  return ffmpegPath();
}

export async function resolveFfprobeBinaryPath(): Promise<string> {
  return ffprobePath();
}

// Build an FFmpeg invocation that:
//
//  1. Takes N input segments
//  2. Normalizes each to identical width/height/fps/SAR (xfade and concat
//     require it; mismatched inputs is the #1 cause of "weird stutters")
//  3. Optionally applies a per-segment colorbalance pass to flatten lighting
//     drift between adjacent generated clips
//  4. Chains xfade for video and acrossfade for audio between every adjacent
//     pair (when the transition isn't a hard cut)
//  5. Re-encodes once into the output, using the picked encoder
//
// The price is one re-encode of every frame. For 60 s of 1080p that's
// roughly 5-15 s on a modern CPU and faster with GPU. Hyperframes pays the
// same price; this isn't a Saga regression.

export type SagaConcatInput = {
  segments: SagaSegmentInput[];
  transitions: SagaTransitionPlan[]; // transitions[i] applies between segments[i] and segments[i+1]
  outputPath: string;
  workDir: string;
  encode: SagaEncodeOptions;
  colorMatch: boolean;
  hasAudio: boolean;
};

export type SagaConcatResult = {
  outputPath: string;
  ffmpegArgs: string[];
  encoderName: string;
  isGpu: boolean;
  appliedTransitions: SagaTransitionPlan[];
  durationSeconds: number;
};

function escConcatPath(p: string): string {
  return p.replace(/'/g, "'\\''");
}

async function probeAudio(filePath: string): Promise<boolean> {
  try {
    const result = await execFileAsync(
      await ffprobePath(),
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', filePath],
      { timeout: 30_000 },
    );
    return result.stdout.trim().toLowerCase() === 'audio';
  } catch {
    return false;
  }
}

async function probeDurationSeconds(filePath: string): Promise<number | null> {
  try {
    const result = await execFileAsync(
      await ffprobePath(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
      { timeout: 30_000 },
    );
    const value = Number.parseFloat(result.stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function concatWithSagaRenderer(input: SagaConcatInput): Promise<SagaConcatResult> {
  if (input.segments.length === 0) {
    throw new Error('saga-renderer: no segments to concat');
  }

  // When any transition is a Saga GLSL shader, route to the shader-aware
  // concat path: pre-render each shader as an intermediate MP4 between the
  // two boundary frames, then hard-concat segments and shader MP4s. Other
  // transition kinds in the same project degrade to hard cuts in this path
  // (mixed shader+xfade is a future iteration).
  const hasShader = input.transitions.some((t) => isShaderTransition(t.kind));
  const hasMotionBlendXfade = input.transitions.some((t) => {
    if (isShaderTransition(t.kind)) return false;
    if (isHardCut(t)) return false;
    if (isCleanFadeTransition(t.kind)) return false;
    return true;
  });

  if (hasShader && hasMotionBlendXfade) {
    // Mixed: prefer shader path which handles non-shader transitions as
    // hard cuts. Future iteration may interleave xfade segments.
    return concatWithShaderTransitions(input);
  }
  if (hasShader) {
    return concatWithShaderTransitions(input);
  }
  // No motion-blend xfade and no shader → clean-fade path. Sequential
  // fade-out + fade-in per segment, NO overlap. Physically impossible to
  // see a frame from a different segment during the transition.
  if (!hasMotionBlendXfade) {
    return concatWithCleanFades(input);
  }
  // Otherwise: existing xfade chain (motion-blend transitions present).
  const allDurations = input.segments.map((segment) => segment.duration);
  const totalDuration = allDurations.reduce((sum, d) => sum + d, 0);
  const allHardCuts = input.transitions.every(isHardCut);

  // Audio handling v2: if SOME segments have audio and OTHERS don't, we no
  // longer drop the entire audio track. Instead, segments without audio
  // get filled with silent placeholders (aevalsrc=0) so the timeline keeps
  // a continuous audio stream. Final output has audio whenever at least
  // ONE segment has audio.
  let outputAudio = input.hasAudio && input.encode.audio;
  let audioFlags: boolean[] = [];
  if (outputAudio) {
    audioFlags = await Promise.all(input.segments.map((segment) => probeAudio(segment.outputPath)));
    if (audioFlags.every((flag) => !flag)) {
      // Truly no audio anywhere — degrade to silent encode.
      outputAudio = false;
    }
  }
  const encode: SagaEncodeOptions = { ...input.encode, audio: outputAudio };

  // Fast path: 1 segment, just transcode it through the encoder.
  if (input.segments.length === 1) {
    const common = await buildCommonEncodeArgs(encode);
    const args = ['-y', '-i', input.segments[0]!.outputPath, '-vf', normalizationVf(encode), ...common.args, input.outputPath];
    await execFileAsync(await ffmpegPath(), args, { timeout: 30 * 60_000 });
    return {
      outputPath: input.outputPath,
      ffmpegArgs: args,
      encoderName: common.encoderName,
      isGpu: common.isGpu,
      appliedTransitions: [],
      durationSeconds: totalDuration,
    };
  }

  // Hard-cut-only path: simpler concat demuxer + one re-encode pass to
  // unify codec params. Faster than a full xfade graph and identical
  // visually for cut transitions.
  if (allHardCuts) {
    const listPath = path.join(input.workDir, 'segments.ffconcat');
    await writeFile(
      listPath,
      ['ffconcat version 1.0', ...input.segments.map((segment) => `file '${escConcatPath(segment.outputPath)}'`)].join('\n'),
      'utf8',
    );
    const common = await buildCommonEncodeArgs(encode);
    const args = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-vf',
      normalizationVf(encode),
      ...common.args,
      input.outputPath,
    ];
    await execFileAsync(await ffmpegPath(), args, { timeout: 30 * 60_000 });
    return {
      outputPath: input.outputPath,
      ffmpegArgs: args,
      encoderName: common.encoderName,
      isGpu: common.isGpu,
      appliedTransitions: input.transitions,
      durationSeconds: totalDuration,
    };
  }

  // xfade path: build the filter graph.
  const inputs: string[] = [];
  for (const segment of input.segments) {
    inputs.push('-i', segment.outputPath);
  }

  // Add a single silent-audio source as an additional ffmpeg input. We will
  // splice it into the audio chain wherever a segment lacks an audio track.
  const silentInputIndex = encode.audio ? input.segments.length : -1;
  if (encode.audio) {
    // -f lavfi -t MAX -i anullsrc=channel_layout=stereo:sample_rate=48000
    // We size it to the longest possible duration, then atrim per use.
    const totalForSilent = Math.max(1, Math.ceil(totalDuration + 5));
    inputs.push('-f', 'lavfi', '-t', String(totalForSilent), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  // Probe each segment's true duration. BytePlus and other providers often
  // produce streams a few hundredths of a second longer than the planned
  // duration. If we use the planned duration as the xfade offset, FFmpeg
  // happily reads the extra trailing frames and shows them inside the
  // transition window — that's the "flashback frame" the user sees. We
  // force-trim each input to the planned duration so the xfade math is
  // exact and no leftover content can leak into the transition.
  const probedDurations = await Promise.all(input.segments.map((segment) => probeDurationSeconds(segment.outputPath)));
  const plannedDurations = input.segments.map((segment) => segment.duration);

  // For each segment, compute the start-pad and end-pad freeze-frame durations
  // contributed by adjacent hold-frame transitions. These pads make the
  // transition window blend two FROZEN frames instead of two streams of
  // motion — which is the core fix for "polluted/flashback frames" the user
  // sees with motion-blend xfades on visually-different shot pairs.
  const startPads: number[] = new Array(input.segments.length).fill(0);
  const endPads: number[] = new Array(input.segments.length).fill(0);
  const holdFrameFlags: boolean[] = new Array(input.transitions.length).fill(false);
  for (let i = 0; i < input.transitions.length; i += 1) {
    const plan = input.transitions[i]!;
    const desc = describeTransition(plan.kind);
    const transitionDuration = Math.max(0.05, plan.durationMs / 1000);
    const useHoldFrame = Boolean(desc.holdFrameMode) && !isHardCut(plan);
    holdFrameFlags[i] = useHoldFrame;
    if (useHoldFrame) {
      endPads[i] = transitionDuration; // seg i: append frozen-last-frame for X
      startPads[i + 1] = transitionDuration; // seg i+1: prepend frozen-first-frame for X
    }
  }

  const filterParts: string[] = [];
  for (let i = 0; i < input.segments.length; i += 1) {
    const colorPart = input.colorMatch ? ',colorbalance=rs=0.02:gs=0.0:bs=-0.02' : '';
    const segmentDuration = plannedDurations[i]!;
    const segmentDurationStr = segmentDuration.toFixed(3);
    const startPad = startPads[i]!;
    const endPad = endPads[i]!;
    // Video pipeline: scale → pad → fps lock → trim to exact planned
    // duration → setpts → optional start/end freeze-frame pad → setpts.
    // tpad start_mode=clone clones the FIRST frame backwards; stop_mode=clone
    // clones the LAST frame forwards. The result for a hold-frame transition:
    // during the xfade window, A is on its (frozen) last frame and B is on
    // its (frozen) first frame. The xfade cross between two stills is clean
    // by construction — no motion can mix.
    //
    // FFmpeg 8.1 quirk: tpad's `start_duration` / `stop_duration` only add
    // one frame regardless of value. Using `start=N` / `stop=N` (frame
    // count) works correctly. We compute frame count = duration_seconds * fps.
    // Both pads are combined into a single tpad call so the trailing
    // setpts re-bases to 0 once.
    const startFrames = Math.round(startPad * encode.fps);
    const endFrames = Math.round(endPad * encode.fps);
    const tpadOptions: string[] = [];
    if (startFrames > 0) tpadOptions.push(`start_mode=clone`, `start=${startFrames}`);
    if (endFrames > 0) tpadOptions.push(`stop_mode=clone`, `stop=${endFrames}`);
    const tpadChain = tpadOptions.length > 0 ? `,tpad=${tpadOptions.join(':')},setpts=PTS-STARTPTS` : '';
    const vf = `[${i}:v]${normalizationVf(encode)},trim=duration=${segmentDurationStr},setpts=PTS-STARTPTS${colorPart}${tpadChain},setsar=1[v${i}]`;
    filterParts.push(vf);
    if (encode.audio) {
      // Audio padding for hold-frame transitions: we extend audio with a
      // SHORT silent gap (apad with a target duration) instead of cloning
      // the last sample — silence reads as a natural "breath" at the
      // transition. Combined with a 30ms afade at each cut boundary
      // (anti-pop, lifted from video-use's editing skill) this prevents
      // both audio clicks and jarring volume mismatches.
      const totalAudioDur = segmentDuration + startPad + endPad;
      const totalAudioDurStr = totalAudioDur.toFixed(3);
      if (audioFlags[i]) {
        // For real audio: format → loudnorm → trim → afade in/out (30ms
        // anti-pop) → apad to total dur with start-pad of silent leading.
        // We use adelay to push the real audio start by startPad seconds,
        // then apad to fill end with silence — equivalent to surrounding
        // the audio with silent pads.
        const startPadMs = Math.round(startPad * 1000);
        const delay = startPadMs > 0 ? `,adelay=${startPadMs}|${startPadMs}` : '';
        const fadeIn = `,afade=t=in:st=${startPad.toFixed(3)}:d=0.03`;
        const fadeOut = `,afade=t=out:st=${(startPad + segmentDuration - 0.03).toFixed(3)}:d=0.03`;
        filterParts.push(
          `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${segmentDurationStr},asetpts=N/SR/TB,loudnorm=I=-16:TP=-1.5:LRA=11${delay}${fadeIn}${fadeOut},apad=whole_dur=${totalAudioDurStr}[a${i}]`,
        );
      } else {
        // Silent placeholder for the full padded duration.
        filterParts.push(
          `[${silentInputIndex}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${totalAudioDurStr},asetpts=N/SR/TB[a${i}]`,
        );
      }
    }
  }

  // xfade chain. For hold-frame transitions, the offset lands on the
  // boundary between A's main content and A's end-pad freeze region — so
  // the xfade window blends two stills. For motion-blend transitions, the
  // offset still eats X seconds out of A's main content (classic xfade).
  //
  // Output cumulative-duration math:
  //  - hold-frame:  out_len += D_{i+1} + X_i  (X added between segments)
  //  - motion-blend: out_len += D_{i+1} - X_i  (X subtracted via overlap)
  //  - hard-cut:    handled as motion-blend with X≈0
  let videoLabel = 'v0';
  let audioLabel = 'a0';
  let outLen = plannedDurations[0]! + endPads[0]!; // length of seg0_extended

  for (let i = 1; i < input.segments.length; i += 1) {
    const plan = input.transitions[i - 1] ?? { kind: 'crossfade', durationMs: 250 };
    const transitionDuration = Math.max(0.05, plan.durationMs / 1000);
    const useHoldFrame = holdFrameFlags[i - 1];
    const segNextExtended = plannedDurations[i]! + startPads[i]! + endPads[i]!;
    let offset: number;
    if (useHoldFrame) {
      // xfade lives entirely inside the freeze pads on both sides.
      offset = outLen - transitionDuration; // start of A's end-pad freeze
      // After this xfade, output continues with B from time = startPad onwards
      outLen = offset + segNextExtended;
    } else {
      // Motion-blend: classic xfade, eats X out of A's tail and B's head.
      offset = outLen - transitionDuration;
      outLen = offset + segNextExtended; // segNextExtended has 0 pads in this branch
    }
    const audioCrossfadeDuration = Math.max(transitionDuration, Math.min(1.5, transitionDuration * 1.5 + 0.2));
    const nextVideo = `vx${i}`;
    const xfadeArgs = compileXfadeFilterArgs({
      plan,
      durationSeconds: transitionDuration,
      offsetSeconds: offset,
    });
    filterParts.push(`[${videoLabel}][v${i}]${xfadeArgs}[${nextVideo}]`);
    videoLabel = nextVideo;
    if (encode.audio) {
      const nextAudio = `ax${i}`;
      filterParts.push(
        `[${audioLabel}][a${i}]acrossfade=d=${audioCrossfadeDuration.toFixed(3)}:c1=tri:c2=tri[${nextAudio}]`,
      );
      audioLabel = nextAudio;
    }
  }
  void probedDurations;

  const filterComplex = filterParts.join(';');
  const common = await buildCommonEncodeArgs(encode);
  const args = [
    '-y',
    ...inputs,
    '-filter_complex',
    filterComplex,
    '-map',
    `[${videoLabel}]`,
    ...(encode.audio ? ['-map', `[${audioLabel}]`] : []),
    ...common.args,
    input.outputPath,
  ];

  await execFileAsync(await ffmpegPath(), args, { timeout: 60 * 60_000 });

  // Final output duration mirrors the FFmpeg filter-graph math:
  //   sum(D_i)  +  sum(X_i where transition i is hold-frame)
  //              -  sum(X_i where transition i is motion-blend)
  // Hold-frame ADDS the transition window (segments are bridged by frozen
  // pads), motion-blend SUBTRACTS it (segments overlap).
  let finalDuration = totalDuration;
  for (let i = 0; i < input.transitions.length; i += 1) {
    const plan = input.transitions[i]!;
    const transitionDuration = Math.max(0.05, plan.durationMs / 1000);
    if (holdFrameFlags[i]) {
      finalDuration += transitionDuration;
    } else if (!isHardCut(plan)) {
      finalDuration -= transitionDuration;
    }
  }

  return {
    outputPath: input.outputPath,
    ffmpegArgs: args,
    encoderName: common.encoderName,
    isGpu: common.isGpu,
    appliedTransitions: input.transitions,
    durationSeconds: Math.max(0, finalDuration),
  };
}

function normalizationVf(encode: SagaEncodeOptions): string {
  // Letterbox / pillarbox to preserve aspect ratio while normalizing dimensions.
  return [
    `scale=${encode.width}:${encode.height}:force_original_aspect_ratio=decrease`,
    `pad=${encode.width}:${encode.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${encode.fps}`,
  ].join(',');
}

// ─── Clean-fade concat path ──────────────────────────────────────────────
// For each soft transition between adjacent segments, segment A's tail
// fades OUT to a target color (black/white/gold) over half the transition
// duration, and segment B's head fades IN from the same color over the
// other half. The two segments are NEVER simultaneously visible — the
// transition window contains, in order: A in motion → A tinted color →
// (instantaneous) → B tinted color → B in motion.
//
// Audio mirrors the visual: each boundary gets an `afade` out on A's tail
// and an `afade` in on B's head, both matched to the visual fade duration.
// Even when two segments have visibly different ambient audio, this
// produces a smooth "drop to silence then come back" that feels like a
// deliberate edit, not a jarring jump.
//
// Hard-cuts and shader transitions are also supported in this path —
// hard-cuts insert no fade, shader transitions splice a pre-rendered
// shader MP4 between the segments.

async function concatWithCleanFades(input: SagaConcatInput): Promise<SagaConcatResult> {
  const totalDuration = input.segments.reduce((sum, segment) => sum + segment.duration, 0);
  let outputAudio = input.hasAudio && input.encode.audio;
  let audioFlags: boolean[] = [];
  if (outputAudio) {
    audioFlags = await Promise.all(input.segments.map((segment) => probeAudio(segment.outputPath)));
    if (audioFlags.every((flag) => !flag)) outputAudio = false;
  }
  const encode: SagaEncodeOptions = { ...input.encode, audio: outputAudio };

  // Pre-compute per-segment fade-out (right boundary) and fade-in (left
  // boundary) parameters from adjacent transitions. Each fade is HALF the
  // transition duration — so a 400 ms crossfade means seg A fades out for
  // 200 ms then seg B fades in for 200 ms. The total transition window is
  // the full 400 ms but no overlap, hence the "clean" property.
  type FadeSpec = { halfDur: number; color: string };
  const endFade: (FadeSpec | null)[] = new Array(input.segments.length).fill(null);
  const startFade: (FadeSpec | null)[] = new Array(input.segments.length).fill(null);
  for (let i = 0; i < input.transitions.length; i += 1) {
    const plan = input.transitions[i]!;
    if (!isCleanFadeTransition(plan.kind)) continue;
    const halfDur = Math.max(0.05, (plan.durationMs / 1000) / 2);
    const color = cleanFadeColorFor(plan.kind);
    endFade[i] = { halfDur, color };
    startFade[i + 1] = { halfDur, color };
  }

  // Pre-render any shader transitions (mixed clean-fade + shader is supported).
  const shaderDir = path.join(input.workDir, 'shader-transitions');
  const shaderRenders: Array<{ mp4: string; durationS: number; kind: string } | null> = [];
  const { mkdir } = await import('node:fs/promises');
  for (let i = 0; i < input.transitions.length; i += 1) {
    const plan = input.transitions[i]!;
    if (!isShaderTransition(plan.kind)) {
      shaderRenders.push(null);
      continue;
    }
    const transitionDur = Math.max(0.1, plan.durationMs / 1000);
    const tDir = path.join(shaderDir, `t${String(i).padStart(2, '0')}-${plan.kind}`);
    await mkdir(tDir, { recursive: true });
    const lastFramePath = path.join(tDir, 'last-frame.png');
    const firstFramePath = path.join(tDir, 'first-frame.png');
    const lastOk = await extractLastFrameToPng(input.segments[i]!.outputPath, lastFramePath);
    const firstOk = await extractFirstFrameToPng(input.segments[i + 1]!.outputPath, firstFramePath);
    if (!lastOk || !firstOk) {
      shaderRenders.push(null);
      continue;
    }
    const result = await renderSagaShaderTransition({
      shader: plan.kind as SagaShaderName,
      width: encode.width,
      height: encode.height,
      fps: encode.fps,
      durationSeconds: transitionDur,
      imageAPath: lastFramePath,
      imageBPath: firstFramePath,
      outputDir: tDir,
    });
    if (result.ok) shaderRenders.push({ mp4: result.intermediateMp4, durationS: transitionDur, kind: plan.kind });
    else shaderRenders.push(null);
  }

  const segmentInputs = input.segments.map((s) => s.outputPath);
  const shaderInputs = shaderRenders.filter((r): r is { mp4: string; durationS: number; kind: string } => r !== null).map((r) => r.mp4);
  const inputArgs: string[] = [];
  for (const seg of segmentInputs) inputArgs.push('-i', seg);
  for (const sh of shaderInputs) inputArgs.push('-i', sh);
  const totalForSilent = Math.max(2, Math.ceil(totalDuration + shaderRenders.reduce((sum, r) => sum + (r?.durationS ?? 0), 0) + 5));
  if (encode.audio) inputArgs.push('-f', 'lavfi', '-t', String(totalForSilent), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');

  const N = input.segments.length;
  const silentInputIdx = N + shaderInputs.length;
  let shaderInputCursor = 0;
  const shaderInputIdxByTransition: (number | null)[] = shaderRenders.map((r) => {
    if (!r) return null;
    return N + (shaderInputCursor++);
  });

  const filterParts: string[] = [];

  for (let i = 0; i < N; i += 1) {
    const segDur = input.segments[i]!.duration;
    const segDurStr = segDur.toFixed(3);
    const colorPart = input.colorMatch ? ',colorbalance=rs=0.02:gs=0.0:bs=-0.02' : '';

    // Optional fade-in at start (color-locked)
    const fadeInSpec = startFade[i];
    const fadeInPart = fadeInSpec
      ? `,fade=t=in:st=0:d=${fadeInSpec.halfDur.toFixed(3)}:color=${fadeInSpec.color}`
      : '';
    // Optional fade-out at end (color-locked)
    const fadeOutSpec = endFade[i];
    const fadeOutPart = fadeOutSpec
      ? `,fade=t=out:st=${(segDur - fadeOutSpec.halfDur).toFixed(3)}:d=${fadeOutSpec.halfDur.toFixed(3)}:color=${fadeOutSpec.color}`
      : '';

    filterParts.push(
      `[${i}:v]${normalizationVf(encode)},trim=duration=${segDurStr},setpts=PTS-STARTPTS${colorPart}${fadeInPart}${fadeOutPart},setsar=1[v_seg_${i}]`,
    );
    if (encode.audio) {
      // Audio fades match the video fade durations. We always also keep a
      // ~30 ms anti-pop afade at the very edge in case the recorded audio
      // boundary has a click — a longer fade subsumes it gracefully.
      const aFadeInDur = fadeInSpec ? fadeInSpec.halfDur : 0.03;
      const aFadeOutDur = fadeOutSpec ? fadeOutSpec.halfDur : 0.03;
      const aFadeIn = `,afade=t=in:st=0:d=${aFadeInDur.toFixed(3)}`;
      const aFadeOut = `,afade=t=out:st=${(segDur - aFadeOutDur).toFixed(3)}:d=${aFadeOutDur.toFixed(3)}`;
      if (audioFlags[i]) {
        filterParts.push(
          `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${segDurStr},asetpts=N/SR/TB,loudnorm=I=-16:TP=-1.5:LRA=11${aFadeIn}${aFadeOut},apad=whole_dur=${segDurStr}[a_seg_${i}]`,
        );
      } else {
        filterParts.push(
          `[${silentInputIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${segDurStr},asetpts=N/SR/TB[a_seg_${i}]`,
        );
      }
    }
  }

  // Per-shader streams (when present) — normalize + silent audio of matching duration.
  for (let i = 0; i < input.transitions.length; i += 1) {
    const render = shaderRenders[i];
    if (!render) continue;
    const inputIdx = shaderInputIdxByTransition[i]!;
    filterParts.push(`[${inputIdx}:v]${normalizationVf(encode)},setpts=PTS-STARTPTS,setsar=1[v_sh_${i}]`);
    if (encode.audio) {
      filterParts.push(
        `[${silentInputIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${render.durationS.toFixed(3)},asetpts=N/SR/TB[a_sh_${i}]`,
      );
    }
  }

  // Build temporal-order concat list. Clean-fade transitions DO NOT add a
  // separate piece — they're absorbed into the segments' own fade-out and
  // fade-in. Hard cuts also add nothing. Shader transitions DO add a
  // separate intermediate piece.
  const orderedVideoLabels: string[] = [];
  const orderedAudioLabels: string[] = [];
  for (let i = 0; i < N; i += 1) {
    orderedVideoLabels.push(`[v_seg_${i}]`);
    if (encode.audio) orderedAudioLabels.push(`[a_seg_${i}]`);
    if (i < input.transitions.length && shaderRenders[i]) {
      orderedVideoLabels.push(`[v_sh_${i}]`);
      if (encode.audio) orderedAudioLabels.push(`[a_sh_${i}]`);
    }
  }
  const totalConcatPieces = orderedVideoLabels.length;

  filterParts.push(`${orderedVideoLabels.join('')}concat=n=${totalConcatPieces}:v=1:a=0[outv]`);
  if (encode.audio) {
    filterParts.push(`${orderedAudioLabels.join('')}concat=n=${totalConcatPieces}:v=0:a=1[outa]`);
  }

  const common = await buildCommonEncodeArgs(encode);
  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex',
    filterParts.join(';'),
    '-map', '[outv]',
    ...(encode.audio ? ['-map', '[outa]'] : []),
    ...common.args,
    input.outputPath,
  ];

  await execFileAsync(await ffmpegPath(), args, { timeout: 60 * 60_000 });

  // Clean-fade transitions add zero net duration (they fade in-place
  // within segments). Shader transitions add their full duration.
  const shaderTotal = shaderRenders.reduce((sum, r) => sum + (r?.durationS ?? 0), 0);
  const finalDuration = totalDuration + shaderTotal;

  return {
    outputPath: input.outputPath,
    ffmpegArgs: args,
    encoderName: common.encoderName,
    isGpu: common.isGpu,
    appliedTransitions: input.transitions,
    durationSeconds: Math.max(0, finalDuration),
  };
}

// ─── Shader-aware concat path ────────────────────────────────────────────
// Pre-renders each shader transition as an intermediate MP4, then hard-
// concatenates segments and shader MP4s using FFmpeg's `concat` filter
// (not the demuxer — segments may have different SAR/codec params and
// the filter normalizes them in one pass).

async function extractFirstFrameToPng(filePath: string, outputPath: string): Promise<boolean> {
  try {
    await execFileAsync(await ffmpegPath(), ['-y', '-i', filePath, '-frames:v', '1', '-q:v', '2', outputPath], {
      timeout: 30_000,
    });
    const info = await stat(outputPath);
    return info.isFile() && info.size > 1024;
  } catch {
    return false;
  }
}

async function extractLastFrameToPng(filePath: string, outputPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      await ffmpegPath(),
      ['-y', '-sseof', '-0.1', '-i', filePath, '-update', '1', '-frames:v', '1', '-q:v', '2', outputPath],
      { timeout: 30_000 },
    );
    const info = await stat(outputPath);
    return info.isFile() && info.size > 1024;
  } catch {
    return false;
  }
}

async function concatWithShaderTransitions(input: SagaConcatInput): Promise<SagaConcatResult> {
  const totalDuration = input.segments.reduce((sum, segment) => sum + segment.duration, 0);
  let outputAudio = input.hasAudio && input.encode.audio;
  let audioFlags: boolean[] = [];
  if (outputAudio) {
    audioFlags = await Promise.all(input.segments.map((segment) => probeAudio(segment.outputPath)));
    if (audioFlags.every((flag) => !flag)) {
      outputAudio = false;
    }
  }
  const encode: SagaEncodeOptions = { ...input.encode, audio: outputAudio };

  // Pre-render shader transitions. Each rendered MP4 sits between segments
  // i and i+1 in the final concat. On shader render failure for a given
  // transition we fall back to "no shader" (a hard cut for that boundary).
  const shaderDir = path.join(input.workDir, 'shader-transitions');
  const shaderRenders: Array<{ mp4: string; durationS: number; kind: string } | null> = [];
  const { mkdir } = await import('node:fs/promises');
  for (let i = 0; i < input.transitions.length; i += 1) {
    const plan = input.transitions[i]!;
    if (!isShaderTransition(plan.kind)) {
      shaderRenders.push(null);
      continue;
    }
    const transitionDur = Math.max(0.1, plan.durationMs / 1000);
    const tDir = path.join(shaderDir, `t${String(i).padStart(2, '0')}-${plan.kind}`);
    // Ensure the per-transition directory exists BEFORE ffmpeg tries to
    // write boundary frame PNGs into it. Skipping this caused a silent
    // fallback to no-shader concat in earlier iterations.
    await mkdir(tDir, { recursive: true });
    const lastFramePath = path.join(tDir, 'last-frame.png');
    const firstFramePath = path.join(tDir, 'first-frame.png');
    const lastOk = await extractLastFrameToPng(input.segments[i]!.outputPath, lastFramePath);
    const firstOk = await extractFirstFrameToPng(input.segments[i + 1]!.outputPath, firstFramePath);
    if (!lastOk || !firstOk) {
      shaderRenders.push(null);
      continue;
    }
    const result = await renderSagaShaderTransition({
      shader: plan.kind as SagaShaderName,
      width: encode.width,
      height: encode.height,
      fps: encode.fps,
      durationSeconds: transitionDur,
      imageAPath: lastFramePath,
      imageBPath: firstFramePath,
      outputDir: tDir,
    });
    if (result.ok) {
      shaderRenders.push({ mp4: result.intermediateMp4, durationS: transitionDur, kind: plan.kind });
    } else {
      shaderRenders.push(null);
    }
  }

  // Inputs to FFmpeg: every segment + every successfully rendered shader MP4
  // + one silent audio source for filling shader-window audio gaps.
  const segmentInputs = input.segments.map((s) => s.outputPath);
  const shaderInputs = shaderRenders.filter((r): r is { mp4: string; durationS: number; kind: string } => r !== null).map((r) => r.mp4);
  const inputArgs: string[] = [];
  for (const seg of segmentInputs) inputArgs.push('-i', seg);
  for (const sh of shaderInputs) inputArgs.push('-i', sh);
  // Silent audio source for shader gaps.
  const totalForSilent = Math.max(2, Math.ceil(totalDuration + shaderRenders.reduce((sum, r) => sum + (r?.durationS ?? 0), 0) + 5));
  if (encode.audio) {
    inputArgs.push('-f', 'lavfi', '-t', String(totalForSilent), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  // Filter graph:
  //   per-segment: scale/pad/fps/trim/setsar/setpts → [v_seg_i]
  //   per-shader:  scale/pad/fps/setsar/setpts → [v_sh_j]
  //   per-segment audio: real-audio (with loudnorm + 30ms anti-pop fades) or silent
  //   per-shader audio: silent of shader duration
  //   final video: concat=n=K:v=1:a=0
  //   final audio: concat=n=K:v=0:a=1
  const filterParts: string[] = [];
  const N = input.segments.length;
  const silentInputIdx = N + shaderInputs.length; // anullsrc is the LAST input (if present)

  // Map "shader index in input list" so we can reference [N+k:v]
  let shaderInputCursor = 0;
  const shaderInputIdxByTransition: (number | null)[] = shaderRenders.map((r) => {
    if (!r) return null;
    return N + (shaderInputCursor++);
  });

  // Build per-segment normalized streams
  for (let i = 0; i < N; i += 1) {
    const segDur = input.segments[i]!.duration.toFixed(3);
    const colorPart = input.colorMatch ? ',colorbalance=rs=0.02:gs=0.0:bs=-0.02' : '';
    filterParts.push(
      `[${i}:v]${normalizationVf(encode)},trim=duration=${segDur},setpts=PTS-STARTPTS${colorPart},setsar=1[v_seg_${i}]`,
    );
    if (encode.audio) {
      if (audioFlags[i]) {
        filterParts.push(
          `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${segDur},asetpts=N/SR/TB,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.03,afade=t=out:st=${(input.segments[i]!.duration - 0.03).toFixed(3)}:d=0.03,apad=whole_dur=${segDur}[a_seg_${i}]`,
        );
      } else {
        filterParts.push(
          `[${silentInputIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${segDur},asetpts=N/SR/TB[a_seg_${i}]`,
        );
      }
    }
  }

  // Build per-shader normalized streams + silent audio fillers (for shader windows)
  for (let i = 0; i < input.transitions.length; i += 1) {
    const render = shaderRenders[i];
    if (!render) continue;
    const inputIdx = shaderInputIdxByTransition[i]!;
    filterParts.push(
      `[${inputIdx}:v]${normalizationVf(encode)},setpts=PTS-STARTPTS,setsar=1[v_sh_${i}]`,
    );
    if (encode.audio) {
      filterParts.push(
        `[${silentInputIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${render.durationS.toFixed(3)},asetpts=N/SR/TB[a_sh_${i}]`,
      );
    }
  }

  // Final concat: interleave segments and shader streams in temporal order
  const orderedVideoLabels: string[] = [];
  const orderedAudioLabels: string[] = [];
  for (let i = 0; i < N; i += 1) {
    orderedVideoLabels.push(`[v_seg_${i}]`);
    if (encode.audio) orderedAudioLabels.push(`[a_seg_${i}]`);
    if (i < input.transitions.length && shaderRenders[i]) {
      orderedVideoLabels.push(`[v_sh_${i}]`);
      if (encode.audio) orderedAudioLabels.push(`[a_sh_${i}]`);
    }
  }
  const totalConcatPieces = orderedVideoLabels.length;

  filterParts.push(
    `${orderedVideoLabels.join('')}concat=n=${totalConcatPieces}:v=1:a=0[outv]`,
  );
  if (encode.audio) {
    filterParts.push(
      `${orderedAudioLabels.join('')}concat=n=${totalConcatPieces}:v=0:a=1[outa]`,
    );
  }

  const common = await buildCommonEncodeArgs(encode);
  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[outv]',
    ...(encode.audio ? ['-map', '[outa]'] : []),
    ...common.args,
    input.outputPath,
  ];

  await execFileAsync(await ffmpegPath(), args, { timeout: 60 * 60_000 });

  // Final duration: segments + successfully-rendered shader durations.
  const shaderTotal = shaderRenders.reduce((sum, r) => sum + (r?.durationS ?? 0), 0);
  const finalDuration = totalDuration + shaderTotal;

  return {
    outputPath: input.outputPath,
    ffmpegArgs: args,
    encoderName: common.encoderName,
    isGpu: common.isGpu,
    appliedTransitions: input.transitions.map((t, i) => ({
      kind: t.kind,
      durationMs: shaderRenders[i] ? Math.round(shaderRenders[i]!.durationS * 1000) : 0,
    })),
    durationSeconds: Math.max(0, finalDuration),
  };
}

export async function ensureFfmpegAvailable(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const result = await execFileAsync(await ffmpegPath(), ['-hide_banner', '-version'], { timeout: 30_000 });
    const firstLine = (result.stdout || '').split(/\r?\n/)[0] ?? '';
    return { ok: true, version: firstLine };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function ensureSegmentReadable(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 1024;
  } catch {
    return false;
  }
}
