import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentAction } from '../core/types.js';
import { ensureNotSensitivePath } from '../utils/fs.js';
import {
  buildVisualSetupRequiredMessage,
  describeVisualProvider,
  resolveConfiguredVisualProvider,
} from '../utils/visualGenerationConfig.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { executeGenerateVideo } from './generateVideo.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { resolveVideoModelLimits } from './visual/videoModelLimits.js';
import {
  buildContinuityBible,
  buildStartingFrameAnchor,
  chainFramePathFor,
  compileShotPromptWithContinuity,
  describeTransition,
  extractLastFrame,
  formatLintReport,
  pickContinuityMode,
  planTransition,
  renderSagaProject,
} from './visual/sagaRenderer/index.js';
import type { SagaContinuityMode } from './visual/sagaRenderer/continuity.js';
import type {
  SagaFps,
  SagaQuality,
  SagaRatio,
  SagaSegmentInput,
  SagaTransitionKind,
  SagaTransitionPlan,
} from './visual/sagaRenderer/types.js';

type GenerateLongVideoAction = Extract<AgentAction, { type: 'generate_long_video' }>;

type SagaSegment = SagaSegmentInput;

type SagaShotInput = NonNullable<GenerateLongVideoAction['shots']>[number];

type SegmentProbe = {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  error?: string;
};

const execFileAsync = promisify(execFile);
const DEFAULT_RATIO: SagaRatio = '16:9';
const DEFAULT_TOTAL_SECONDS = 60;
const MAX_TOTAL_SECONDS = 600;
const DEFAULT_TRANSITION: SagaTransitionKind = 'crossfade';
const DEFAULT_CROSSFADE_MS = 250;

function clampTotalSeconds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TOTAL_SECONDS;
  return Math.max(10, Math.min(MAX_TOTAL_SECONDS, Math.floor(value)));
}

function normalizeProjectId(raw: string | undefined): string {
  const base = raw?.trim() || `saga-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'saga-video';
}

function resolveRatio(raw: string | undefined): SagaRatio {
  const normalized = raw?.trim();
  if (normalized === '9:16' || normalized === '1:1' || normalized === '16:9') return normalized;
  return DEFAULT_RATIO;
}

function sentenceChunks(story: string): string[] {
  const normalized = story.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const parts = normalized
    .split(/(?<=[。！？!?.])\s+|[\n\r]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;

  const chunks: string[] = [];
  for (let index = 0; index < normalized.length; index += 220) {
    chunks.push(normalized.slice(index, index + 220).trim());
  }
  return chunks.filter(Boolean);
}

function sanitizeInline(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}

function normalizeShotDuration(value: number | undefined, fallback: number, maxSegmentSeconds: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.max(4, Math.min(maxSegmentSeconds, Math.floor(fallback)));
  }
  return Math.max(4, Math.min(maxSegmentSeconds, Math.floor(value)));
}

function distributeDurations(totalSeconds: number, segmentCount: number, maxSegmentSeconds: number): number[] {
  const durations: number[] = [];
  let remaining = totalSeconds;
  for (let index = 0; index < segmentCount; index += 1) {
    const slotsLeft = segmentCount - index;
    const next = Math.min(maxSegmentSeconds, Math.max(4, Math.ceil(remaining / slotsLeft)));
    durations.push(next);
    remaining -= next;
  }
  return durations;
}

function buildSegments(options: {
  story: string;
  shots?: SagaShotInput[];
  projectDir: string;
  hyperframesProjectDir: string;
  totalSeconds: number;
  maxSegmentSeconds: number;
  preferredSegmentSeconds: number;
  ratio: SagaRatio;
  continuityInput: ReturnType<typeof buildContinuityBible>;
  continuityMode: SagaContinuityMode;
}): SagaSegment[] {
  const beats = sentenceChunks(options.story);
  const plannedShots = Array.isArray(options.shots)
    ? options.shots.filter((shot) => shot && typeof shot === 'object')
    : [];
  const segmentCount = plannedShots.length > 0
    ? plannedShots.length
    : Math.max(1, Math.ceil(options.totalSeconds / options.preferredSegmentSeconds));
  const durations = distributeDurations(options.totalSeconds, segmentCount, options.maxSegmentSeconds);
  const segments: SagaSegment[] = [];

  // Resolve all per-shot fields up front so we can use shot N-1's transition
  // as shot N's starting-frame anchor.
  type Resolved = {
    title: string; duration: number; storyBeat: string; visualPrompt: string;
    camera: string; continuity: string; transition: string; planned: SagaShotInput | undefined;
  };
  const resolved: Resolved[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const start = Math.floor((index * beats.length) / segmentCount);
    const end = Math.max(start + 1, Math.floor(((index + 1) * beats.length) / segmentCount));
    const planned = plannedShots[index];
    const storyBeat = sanitizeInline(
      planned?.storyBeat,
      (beats.slice(start, end).join(' ') || options.story).slice(0, 900),
    );
    const duration = normalizeShotDuration(planned?.duration, durations[index] ?? options.preferredSegmentSeconds, options.maxSegmentSeconds);
    const title = sanitizeInline(planned?.title, `Shot ${index + 1}`);
    const visualPrompt = sanitizeInline(
      planned?.visualPrompt,
      `Cinematic realization of this story beat with consistent characters, location, lighting, and emotional tone: ${storyBeat}`,
    );
    const camera = sanitizeInline(
      planned?.camera,
      index % 3 === 0 ? 'slow controlled dolly movement with stable subject tracking' : index % 3 === 1 ? 'gentle handheld cinematic push-in with natural parallax' : 'locked-off establishing composition with subtle environmental motion',
    );
    const continuity = sanitizeInline(
      planned?.continuity,
      'Carry forward the same character identity, wardrobe, props, color palette, environment logic, and lighting direction from adjacent shots.',
    );
    const transition = sanitizeInline(
      planned?.transition,
      index === 0 ? 'open from black with a stable first frame' : 'cut cleanly from the previous stable final frame',
    );
    resolved.push({ title, duration, storyBeat, visualPrompt, camera, continuity, transition, planned });
  }

  for (let index = 0; index < segmentCount; index += 1) {
    const r = resolved[index]!;
    const previous = index > 0 ? resolved[index - 1]! : null;
    const startingFrameAnchor = previous
      ? buildStartingFrameAnchor({
          previousTransition: previous.transition,
          previousCamera: previous.camera,
          previousContinuity: previous.continuity,
        })
      : null;
    const number = String(index + 1).padStart(3, '0');
    const promptArgs = {
      bible: options.continuityInput,
      shotIndex: index + 1,
      shotCount: segmentCount,
      duration: r.duration,
      title: r.title,
      storyBeat: r.storyBeat,
      visualPrompt: r.visualPrompt,
      camera: r.camera,
      continuity: r.continuity,
      transition: r.transition,
      authoredPrompt: r.planned?.prompt,
      startingFrameAnchor,
    } as const;
    const prompt = compileShotPromptWithContinuity({ ...promptArgs, mode: options.continuityMode });
    // Always also compile a text-only variant. We use it when a per-segment
    // retry has to drop the chained image reference because of a provider
    // safety/privacy filter — the text-only prompt verbally compensates.
    const textOnlyPrompt = options.continuityMode === 'text-only'
      ? prompt
      : compileShotPromptWithContinuity({ ...promptArgs, mode: 'text-only' });
    segments.push({
      index: index + 1,
      duration: r.duration,
      title: r.title,
      storyBeat: r.storyBeat,
      visualPrompt: r.visualPrompt,
      prompt,
      textOnlyPrompt,
      camera: r.camera,
      continuity: r.continuity,
      transition: r.transition,
      outputPath: path.join(options.projectDir, 'segments', `${number}.mp4`),
      mediaPath: path.join(options.hyperframesProjectDir, 'media', 'segments', `${number}.mp4`),
    });
  }

  return segments;
}

// Provider error classification — used to decide which fallback to apply.
function isAudioSafetyError(message: string | undefined): boolean {
  if (!message) return false;
  return /output audio.*sensitive|audio.*safety|audio.*moderation/i.test(message);
}

function isImagePrivacyError(message: string | undefined): boolean {
  if (!message) return false;
  return /InputImageSensitiveContentDetected|input image.*sensitive|input image.*privacy|input image may contain real person|input.*moderation|input.*safety/i.test(message);
}

function buildTransitionPlans(options: {
  shots?: SagaShotInput[];
  segmentCount: number;
  defaultKind: SagaTransitionKind;
  defaultMs: number;
}): SagaTransitionPlan[] {
  const plans: SagaTransitionPlan[] = [];
  for (let index = 0; index < options.segmentCount - 1; index += 1) {
    const planned = options.shots?.[index + 1];
    const kind = (planned?.transitionKind as SagaTransitionKind | undefined) ?? options.defaultKind;
    const descriptor = describeTransition(kind);
    const ms = options.defaultMs ?? descriptor.recommendedDurationMs;
    plans.push(planTransition(kind, ms));
  }
  return plans;
}

async function existingUsableFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 1024;
  } catch {
    return false;
  }
}

async function probeSegment(filePath: string): Promise<SegmentProbe> {
  try {
    const info = await stat(filePath);
    const probe: SegmentProbe = {
      path: filePath,
      exists: info.isFile(),
      sizeBytes: info.size,
    };
    if (!info.isFile()) {
      return probe;
    }
    try {
      const result = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height:format=duration',
        '-of',
        'json',
        filePath,
      ], {
        timeout: 30_000,
      });
      const parsed = JSON.parse(result.stdout || '{}') as {
        streams?: Array<{ width?: number; height?: number }>;
        format?: { duration?: string };
      };
      const video = parsed.streams?.[0];
      const duration = Number.parseFloat(parsed.format?.duration ?? '');
      if (Number.isFinite(duration)) probe.durationSeconds = Number(duration.toFixed(2));
      if (Number.isFinite(video?.width)) probe.width = video?.width;
      if (Number.isFinite(video?.height)) probe.height = video?.height;
    } catch (error) {
      probe.error = `ffprobe failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return probe;
  } catch (error) {
    return {
      path: filePath,
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function shouldChainFrames(action: GenerateLongVideoAction, providerSupportsImageRef: boolean): boolean {
  const mode = action.chainReferenceFrames ?? 'auto';
  if (mode === 'off') return false;
  if (mode === 'always') return providerSupportsImageRef;
  // auto: chain whenever the provider can accept image references.
  return providerSupportsImageRef;
}

function deriveContinuityFromShots(action: GenerateLongVideoAction): {
  shotContinuityNotes: string[];
  shotCameraNotes: string[];
} {
  const shotContinuityNotes: string[] = [];
  const shotCameraNotes: string[] = [];
  for (const shot of action.shots ?? []) {
    if (shot?.continuity) shotContinuityNotes.push(shot.continuity);
    if (shot?.camera) shotCameraNotes.push(shot.camera);
  }
  return { shotContinuityNotes, shotCameraNotes };
}

export async function executeGenerateLongVideo(
  action: GenerateLongVideoAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const started = Date.now();
  try {
    const configured = await resolveConfiguredVisualProvider(context.cwd, 'video');
    if (!configured) {
      return { action, ok: false, output: buildVisualSetupRequiredMessage('video') };
    }

    const provider = configured.config.video.provider;
    const model = action.model?.trim() || configured.model || configured.config.video.model;
    const limits = resolveVideoModelLimits(provider, model);
    const ratio = resolveRatio(action.ratio);
    const totalSeconds = clampTotalSeconds(action.totalDuration ?? action.duration);
    const projectId = normalizeProjectId(action.projectId);
    const fps: SagaFps = (action.fps as SagaFps | undefined) ?? 30;
    const quality: SagaQuality = (action.quality as SagaQuality | undefined) ?? 'standard';
    const defaultOutput = path.join(context.cwd, 'generated-media', 'long-videos', `${projectId}`, 'final.mp4');
    const targetRaw = action.outputPath ?? defaultOutput;
    const resolvedOutput = await resolveToolPathWithWorkspaceAccess({
      inputPath: targetRaw,
      toolName: 'generate_long_video',
      context,
    });
    if (context.permissionMode !== 'full-access') {
      ensureNotSensitivePath(resolvedOutput.absolute, targetRaw);
    }

    const projectDir = path.dirname(resolvedOutput.absolute);
    const hyperframesProjectDir = path.join(projectDir, 'hyperframes');
    await mkdir(path.join(projectDir, 'segments'), { recursive: true });
    await mkdir(path.join(hyperframesProjectDir, 'media', 'segments'), { recursive: true });

    const story = action.story || action.prompt;
    const { shotContinuityNotes, shotCameraNotes } = deriveContinuityFromShots(action);
    const continuityBible = buildContinuityBible({
      story,
      ratio,
      shotContinuityNotes,
      shotCameraNotes,
      characters: action.continuity?.characters,
      wardrobe: action.continuity?.wardrobe,
      props: action.continuity?.props,
      locations: action.continuity?.locations,
      palette: action.continuity?.palette,
      lighting: action.continuity?.lighting,
      cameraLanguage: action.continuity?.cameraLanguage,
      mood: action.continuity?.mood,
    });

    const providerSupportsImageRef = limits.referenceInputs.includes('image');
    const userContinuityOverride = action.continuityMode === 'auto' ? undefined : (action.continuityMode as SagaContinuityMode | undefined);
    const continuityMode = pickContinuityMode({
      providerSupportsImageRef,
      userOverride: userContinuityOverride,
    });

    const segments = buildSegments({
      story,
      shots: action.shots,
      projectDir,
      hyperframesProjectDir,
      totalSeconds,
      maxSegmentSeconds: limits.maxSegmentSeconds,
      preferredSegmentSeconds: Math.min(limits.preferredSegmentSeconds, limits.maxSegmentSeconds),
      ratio,
      continuityInput: continuityBible,
      continuityMode,
    });
    const actualTotalSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);

    const defaultTransition: SagaTransitionKind = (action.defaultTransition as SagaTransitionKind | undefined) ?? DEFAULT_TRANSITION;
    const crossfadeMs = typeof action.crossfadeMs === 'number' && action.crossfadeMs >= 0 ? action.crossfadeMs : DEFAULT_CROSSFADE_MS;
    const transitionPlans = buildTransitionPlans({
      shots: action.shots,
      segmentCount: segments.length,
      defaultKind: defaultTransition,
      defaultMs: crossfadeMs,
    });

    const chainFrames = shouldChainFrames(action, providerSupportsImageRef);

    // Audio is on by default unless the caller explicitly disabled it; we
    // retry with audio off if the provider's safety filter rejects the
    // audio for a particular segment.
    const userAudioPreference = action.generateAudio ?? limits.canGenerateAudio;

    const generatedPaths: string[] = [];
    const reusedSegmentPaths: string[] = [];
    const chainedFromPrev: string[] = [];
    const audioRetriedSegments: number[] = [];
    const chainDroppedSegments: number[] = [];

    // If we hit the privacy filter on the chain frame multiple times in a
    // row, the entire project is in "people-heavy" territory; abandon chain
    // frames for the rest of the run and rely on text-only continuity for
    // the remaining segments instead of paying a wasted API call each time.
    let consecutivePrivacyFails = 0;
    let chainEnabled = chainFrames;

    let previousLastFramePath: string | undefined;
    for (const segment of segments) {
      const canReuse = action.resume !== false && await existingUsableFile(segment.outputPath);
      if (canReuse) {
        reusedSegmentPaths.push(segment.outputPath);
      } else {
        const baseImagePaths = segment.index === 1 ? action.referenceImagePaths ?? [] : [];
        const baseReq = {
          type: 'generate_video' as const,
          model,
          ratio,
          duration: segment.duration,
          outputPath: segment.outputPath,
          referenceImageUrls: segment.index === 1 ? action.referenceImageUrls : undefined,
          referenceVideoUrls: segment.index === 1 ? action.referenceVideoUrls : undefined,
          referenceAudioUrls: segment.index === 1 ? action.referenceAudioUrls : undefined,
          referenceVideoPaths: segment.index === 1 ? action.referenceVideoPaths : undefined,
          referenceAudioPaths: segment.index === 1 ? action.referenceAudioPaths : undefined,
          watermark: action.watermark,
          maxPolls: action.maxPolls,
          pollIntervalMs: action.pollIntervalMs,
        };

        // Build the retry plan. We try at most three attempts per segment:
        //   1) full strength (chain + audio)
        //   2) strip the offending input based on which safety filter fired
        //   3) strip both
        // Each attempt also swaps to the text-only prompt when the chain
        // image is being dropped, so the verbal handoff compensates.
        let usingChain = chainEnabled && previousLastFramePath !== undefined;
        let usingAudio = userAudioPreference;
        let lastError = '';
        let succeeded = false;

        for (let attempt = 0; attempt < 3 && !succeeded; attempt += 1) {
          const chainPaths = usingChain && previousLastFramePath ? [previousLastFramePath] : [];
          const referenceImagePaths = [...chainPaths, ...baseImagePaths];
          const promptToUse = usingChain ? segment.prompt : segment.textOnlyPrompt;
          const result = await executeGenerateVideo(
            { ...baseReq, prompt: promptToUse, referenceImagePaths, generateAudio: usingAudio },
            context,
          );
          if (result.ok) {
            succeeded = true;
            if (usingChain && chainPaths.length > 0) chainedFromPrev.push(segment.outputPath);
            if (!usingChain && chainEnabled && previousLastFramePath) chainDroppedSegments.push(segment.index);
            if (!usingAudio && userAudioPreference) audioRetriedSegments.push(segment.index);
            if (usingChain) consecutivePrivacyFails = 0;
            break;
          }
          lastError = result.output ?? '';
          const audioBlocked = isAudioSafetyError(lastError);
          const imageBlocked = isImagePrivacyError(lastError);
          if (!audioBlocked && !imageBlocked) {
            // Non-recoverable error — bail.
            break;
          }
          // Decide the next attempt's degradation. We strip the offending
          // input first; subsequent attempts can additionally strip the
          // other.
          if (imageBlocked && usingChain) {
            usingChain = false;
            consecutivePrivacyFails += 1;
          } else if (audioBlocked && usingAudio) {
            usingAudio = false;
          } else {
            // Both have already been stripped on a prior attempt and we're
            // still failing; nothing more to try.
            break;
          }
        }

        if (!succeeded) {
          return {
            action,
            ok: false,
            output: `generate_long_video: segment ${segment.index}/${segments.length} failed.\n${lastError}`,
          };
        }

        // After 2 consecutive image-privacy failures, this entire project
        // is people-heavy enough that further chain attempts will keep
        // failing. Drop chain frames for the remaining segments to save
        // wasted API calls.
        if (consecutivePrivacyFails >= 2 && chainEnabled) {
          chainEnabled = false;
        }
      }

      // Copy segment into the composition's media directory so the project
      // is self-contained.
      await writeFile(segment.mediaPath, await readFile(segment.outputPath));
      generatedPaths.push(segment.outputPath);

      // Extract last frame of this segment to chain into the next one.
      if (chainFrames) {
        const framePath = chainFramePathFor(segment, projectDir);
        const framed = await extractLastFrame({ videoPath: segment.outputPath, outputPath: framePath });
        previousLastFramePath = framed.ok ? framed.framePath : undefined;
      }
    }

    const segmentProbes = await Promise.all(segments.map((segment) => probeSegment(segment.outputPath)));

    // Render via the Saga renderer (FFmpeg pipeline + composition + lint + inspect).
    const renderResult = await renderSagaProject({
      projectId,
      ratio,
      fps,
      segments,
      transitions: transitionPlans,
      hyperframesProjectDir,
      outputPath: resolvedOutput.absolute,
      workDir: projectDir,
      identityCard: continuityBible.identityCard,
      bible: continuityBible.bible,
      // Output has audio when the user wanted it AND at least one segment
      // produced audio successfully (the renderer will fill silent gaps for
      // segments that failed the audio retry).
      hasAudio: userAudioPreference && audioRetriedSegments.length < segments.length,
      colorMatch: action.colorMatch ?? false,
      encode: {
        quality,
        fps,
        gpu: action.gpu ?? 'auto',
        crf: action.crf,
        videoBitrate: action.videoBitrate,
      },
    });

    const lintFormatted = formatLintReport(renderResult.diagnostics.lint);

    const manifestPath = path.join(projectDir, 'saga-manifest.json');
    const planPath = path.join(projectDir, 'saga-plan.json');
    const plan = {
      schema: 'artemis-saga.plan.v2',
      projectId,
      story,
      requestedTotalSeconds: totalSeconds,
      plannedTotalSeconds: actualTotalSeconds,
      ratio,
      provider,
      model,
      limits,
      planningMode: action.shots && action.shots.length > 0 ? 'model-shot-list' : 'local-fallback',
      continuity: {
        mode: continuityMode,
        identityCard: continuityBible.identityCard,
        bible: continuityBible.bible,
        characters: continuityBible.characters,
        wardrobe: continuityBible.wardrobe,
        props: continuityBible.props,
        locations: continuityBible.locations,
        palette: continuityBible.palette,
        lighting: continuityBible.lighting,
        cameraLanguage: continuityBible.cameraLanguage,
        mood: continuityBible.mood,
      },
      chainReferenceFrames: chainFrames,
      transitions: transitionPlans,
      shots: segments.map((segment) => ({
        index: segment.index,
        title: segment.title,
        duration: segment.duration,
        storyBeat: segment.storyBeat,
        visualPrompt: segment.visualPrompt,
        camera: segment.camera,
        continuity: segment.continuity,
        transition: segment.transition,
        prompt: segment.prompt,
      })),
    };
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
    await writeFile(manifestPath, JSON.stringify({
      schema: 'artemis-saga.manifest.v2',
      projectId,
      provider: describeVisualProvider(configured.config, 'video'),
      model,
      requestedTotalSeconds: totalSeconds,
      totalSeconds: renderResult.durationSeconds,
      ratio,
      fps,
      quality,
      gpu: action.gpu ?? 'auto',
      colorMatch: action.colorMatch ?? false,
      segmentCount: segments.length,
      segmentMaxSeconds: limits.maxSegmentSeconds,
      assemblyMode: 'saga',
      encoderUsed: renderResult.encoderUsed,
      outputPath: resolvedOutput.absolute,
      planPath,
      compositionPath: path.join(hyperframesProjectDir, 'index.html'),
      designPath: path.join(hyperframesProjectDir, 'design.md'),
      runtimePath: path.join(hyperframesProjectDir, 'saga-runtime.js'),
      compositionManifestPath: path.join(hyperframesProjectDir, 'saga.json'),
      readmePath: path.join(hyperframesProjectDir, 'README.md'),
      hyperframesProjectDir,
      transitions: renderResult.appliedTransitions,
      diagnostics: {
        lint: renderResult.diagnostics.lint,
        inspect: renderResult.diagnostics.inspect,
      },
      qualityProbes: {
        probes: segmentProbes,
        reusedSegmentCount: reusedSegmentPaths.length,
        chainedSegmentCount: chainedFromPrev.length,
        chainDroppedSegments,
        audioRetriedSegments,
        userAudioPreference,
        continuityMode,
        chainAbandonedMidRun: chainEnabled !== chainFrames,
      },
      segments: segments.map((segment) => ({
        index: segment.index,
        title: segment.title,
        duration: segment.duration,
        outputPath: segment.outputPath,
        mediaPath: segment.mediaPath,
        storyBeat: segment.storyBeat,
        visualPrompt: segment.visualPrompt,
        camera: segment.camera,
        continuity: segment.continuity,
        transition: segment.transition,
        prompt: segment.prompt,
      })),
    }, null, 2), 'utf8');

    // Verify the output landed.
    await readFile(resolvedOutput.absolute);
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    return {
      action,
      ok: true,
      output: [
        `Saga generated long video via ${describeVisualProvider(configured.config, 'video')}.`,
        `Segments: ${segments.length} x <=${limits.maxSegmentSeconds}s, target duration ${totalSeconds}s, planned duration ${actualTotalSeconds}s, output duration ${renderResult.durationSeconds.toFixed(2)}s.`,
        `Renderer: saga (${renderResult.encoderUsed}); transitions: ${renderResult.appliedTransitions.map((t) => `${t.kind}@${t.durationMs}ms`).join(', ') || 'none'}.`,
        `Continuity: mode=${continuityMode}, chainReferenceFrames=${chainFrames}, chained-segments=${chainedFromPrev.length}, chain-dropped-segments=${chainDroppedSegments.length}${chainEnabled !== chainFrames ? ' (chain abandoned mid-run after privacy filter)' : ''}.`,
        `Audio: requested=${userAudioPreference}, audio-safety-retry-segments=${audioRetriedSegments.length}.`,
        ...(reusedSegmentPaths.length > 0 ? [`Reused existing segments: ${reusedSegmentPaths.length}.`] : []),
        `Video: ${resolvedOutput.absolute}`,
        `Plan: ${planPath}`,
        `Manifest: ${manifestPath}`,
        `Composition: ${path.join(hyperframesProjectDir, 'index.html')}`,
        `Lint: ${lintFormatted.split('\n').slice(-1)[0] ?? lintFormatted}`,
        `Elapsed: ${elapsedSeconds}s`,
      ].join('\n'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { action, ok: false, output: `generate_long_video error: ${message}` };
  }
}
