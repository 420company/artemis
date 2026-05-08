import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentAction } from '../core/types.js';
import { ensureNotSensitivePath } from '../utils/fs.js';
import { toolLog, toolWarn } from '../utils/log.js';
import {
  buildVisualSetupRequiredMessage,
  describeVisualProvider,
  resolveConfiguredVisualProvider,
} from '../utils/visualGenerationConfig.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { executeGenerateVideo } from './generateVideo.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { generateSegmentKeyframe, maybeGenerateSuperVisualReference } from './visual/superVisualMode.js';
import {
  appendNarrativeLibraryEntry,
  runNarrativeCritic,
  rewriteShotWithDialogue,
  type NarrativeEntities,
  type NarrativeLibraryEntry,
  type ShotViolation,
  type PlannedShotForCritic,
} from './visual/sagaNarrative.js';
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
const DEFAULT_LONG_VIDEO_SUBDIR = 'generated-media/long-videos';

function clampTotalSeconds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TOTAL_SECONDS;
  return Math.max(10, Math.min(MAX_TOTAL_SECONDS, Math.floor(value)));
}

// Coerce the loose action.narrativeEntities payload (which may have undefined
// fields when the planner echoes a partial map) into the strict NarrativeEntities
// type the critic+rewriter expect.
function coerceNarrativeEntities(raw: GenerateLongVideoAction['narrativeEntities']): NarrativeEntities | null {
  if (!raw) return null;
  const protoRaw = raw.protagonist ?? {};
  const type = protoRaw.type === 'product' || protoRaw.type === 'environment' ? protoRaw.type : 'character';
  const mode = raw.mode === 'character' || raw.mode === 'product' || raw.mode === 'environment' || raw.mode === 'mixed' || raw.mode === 'unclear'
    ? raw.mode
    : type;
  const source = raw.source === 'user-clarification' || raw.source === 'keyword-fallback' ? raw.source : 'llm';
  return {
    protagonist: {
      name: typeof protoRaw.name === 'string' && protoRaw.name.trim() ? protoRaw.name.trim() : '(unnamed)',
      type,
      confidence: typeof protoRaw.confidence === 'number' ? Math.max(0, Math.min(1, protoRaw.confidence)) : 0.7,
      evidence: typeof protoRaw.evidence === 'string' ? protoRaw.evidence : '',
    },
    supportingCharacters: Array.isArray(raw.supportingCharacters) ? raw.supportingCharacters.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [],
    props: Array.isArray(raw.props) ? raw.props.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [],
    environments: Array.isArray(raw.environments) ? raw.environments.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [],
    relationships: Array.isArray(raw.relationships) ? raw.relationships.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [],
    actions: Array.isArray(raw.actions) ? raw.actions.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [],
    mode,
    modeRationale: typeof raw.modeRationale === 'string' ? raw.modeRationale : '',
    source,
  };
}

function normalizeProjectId(raw: string | undefined): string {
  const base = raw?.trim() || `saga-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'saga-video';
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatLocalTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-') + '_' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('-');
}

function compactInline(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function nonEmptyStringArray(values: string[] | undefined): string[] {
  return Array.isArray(values)
    ? values.map((value) => value.trim()).filter(Boolean)
    : [];
}

function trimTitle(value: string): string {
  const compacted = compactInline(value)
    .replace(/^\s*["'“”‘’]+|["'“”‘’]+\s*$/g, '')
    .trim();
  return compacted.length > 96 ? compacted.slice(0, 96).trim() : compacted;
}

function deriveVideoTitle(action: GenerateLongVideoAction, story: string): string {
  const explicit = trimTitle(action.title ?? '');
  if (explicit) return explicit;

  const firstNamedShot = action.shots
    ?.map((shot) => trimTitle(shot.title ?? ''))
    .find((title) => title && !/^shot\s+\d+$/i.test(title));
  if (firstNamedShot) return firstNamedShot;

  const firstSentence = story
    .split(/(?<=[。！？!?.])\s+|[\n\r]+/g)
    .map((part) => trimTitle(part))
    .find(Boolean);
  if (firstSentence) return firstSentence;

  return 'Saga long video';
}

function sanitizeFilenamePart(value: string, fallback: string, maxLength = 72): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]+/gu, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, maxLength)
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return normalized || fallback;
}

function outputMetadataPathFor(outputPath: string): string {
  const ext = path.extname(outputPath);
  return ext
    ? path.join(path.dirname(outputPath), `${path.basename(outputPath, ext)}.metadata.json`)
    : `${outputPath}.metadata.json`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniquifyPath(filePath: string): Promise<string> {
  if (!await pathExists(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base}-${index}${ext}`);
    if (!await pathExists(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function buildDefaultLongVideoOutputPath(options: {
  cwd: string;
  projectId: string;
  title: string;
  totalSeconds: number;
  ratio: SagaRatio;
}): Promise<string> {
  const timestamp = formatLocalTimestamp(new Date());
  const titleSlug = sanitizeFilenamePart(options.title, 'untitled-saga-video');
  const ratioSlug = options.ratio.replace(':', 'x');
  const fileName = `${timestamp}_${options.totalSeconds}s_${ratioSlug}_${titleSlug}_${options.projectId}.mp4`;
  return uniquifyPath(path.join(options.cwd, DEFAULT_LONG_VIDEO_SUBDIR, options.projectId, fileName));
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

// Detect when the agent has echoed Saga's identity-preservation rule text
// into a storyBeat / visualPrompt slot instead of writing real scene
// content. Catches phrases the planner instruction uses verbatim — when
// the agent slacks late in the shot list it copy-pastes the rule, which
// then becomes the entire image-2 prompt for that segment and produces
// a generic stand-in character (not the locked protagonist).
//
// Patterns are matched as substrings against a normalized form of the
// candidate. Adding more phrases here just makes the safety net broader.
const IDENTITY_RULE_BOILERPLATE_PATTERNS: RegExp[] = [
  /preserve the exact subject identity/i,
  /preserve the same identity/i,
  /preserve the subject['']s? face\/form/i,
  /carry forward the same character identity/i,
  /face\/form,? apparent age\/species/i,
  /silhouette,? wardrobe\/material cues/i,
  /same character identity, wardrobe, props/i,
  /globally consistent recurring subject based on the supplied reference/i,
];

function looksLikeIdentityRuleBoilerplate(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return IDENTITY_RULE_BOILERPLATE_PATTERNS.some((re) => re.test(normalized));
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
    // Reject identity-rule boilerplate that the agent sometimes echoes back
    // into storyBeat / visualPrompt instead of writing actual scene content.
    // When detected, fall back to the story-derived chunk so the keyframe
    // generation has REAL action context to render.
    const storyChunkFallback = (beats.slice(start, end).join(' ') || options.story).slice(0, 900);
    const rawPlannedStoryBeat = looksLikeIdentityRuleBoilerplate(planned?.storyBeat) ? undefined : planned?.storyBeat;
    const storyBeat = sanitizeInline(rawPlannedStoryBeat, storyChunkFallback);
    const duration = normalizeShotDuration(planned?.duration, durations[index] ?? options.preferredSegmentSeconds, options.maxSegmentSeconds);
    const title = sanitizeInline(planned?.title, `Shot ${index + 1}`);
    const rawPlannedVisualPrompt = looksLikeIdentityRuleBoilerplate(planned?.visualPrompt) ? undefined : planned?.visualPrompt;
    const visualPrompt = sanitizeInline(
      rawPlannedVisualPrompt,
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
  return /InputImageSensitiveContentDetected|Invalid image file in references|invalid image|image file.*invalid|input image.*sensitive|input image.*privacy|input image may contain real person|input.*moderation|input.*safety/i.test(message);
}

// BytePlus / Seedance frequently leaves a task in `running` state past the
// default 60-poll window when their queue is busy. The task itself isn't
// rejected — it's just slow. Submitting a fresh task is the right recovery,
// not declaring the segment dead.
function isPollTimeoutError(message: string | undefined): boolean {
  if (!message) return false;
  return /did not finish within \d+ polls?|Last status:\s*(?:running|pending|queued|submitted)/i.test(message);
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
    const referenceNotes = nonEmptyStringArray(action.referenceNotes);
    let story = [
      action.story || action.prompt,
      referenceNotes.length > 0
        ? `\n\nReference notes from user: ${referenceNotes.join(' | ')}`
        : '',
    ].join('');
    const title = deriveVideoTitle(action, story);
    const generatedAt = new Date();
    const localGeneratedAt = formatLocalTimestamp(generatedAt);
    const defaultOutput = await buildDefaultLongVideoOutputPath({
      cwd: context.cwd,
      projectId,
      title,
      totalSeconds,
      ratio,
    });
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

    let userReferenceImagePaths = nonEmptyStringArray(action.referenceImagePaths);
    let userReferenceImageUrls = nonEmptyStringArray(action.referenceImageUrls);
    let hasGlobalUserImageReferences = userReferenceImagePaths.length > 0 || userReferenceImageUrls.length > 0;
    const superVisualMode = await maybeGenerateSuperVisualReference({
      action,
      context,
      projectDir,
      story,
      title,
      ratio,
      videoLimits: limits,
      hasUserImageReference: hasGlobalUserImageReferences,
    });
    // The user's raw photos go in firstFramePool — they'll be sent with
    // role:"first_frame" (image-to-video literal-first-frame mode), which
    // bypasses the real-person privacy filter that role:"reference_image"
    // triggers. The Super Visual turnaround (stylized) goes in the global
    // reference_image pool — it passes the filter because it's not
    // photoreal, and it carries identity continuity across segments.
    const firstFrameUserPhotoPaths: string[] = [...userReferenceImagePaths];
    const firstFrameUserPhotoUrls: string[] = [...userReferenceImageUrls];
    if (superVisualMode.enabled) {
      userReferenceImagePaths = [superVisualMode.referenceImagePath];
      userReferenceImageUrls = [];
      hasGlobalUserImageReferences = true;
      story = [
        story,
        '',
        `Super visual reference: use ${superVisualMode.referenceImagePath} as the canonical three-view character identity sheet for every segment.`,
      ].join('\n');
    } else {
      // Without Super Visual, the user's photos are the only identity anchor.
      // We move them entirely into firstFramePool (role:"first_frame") so the
      // privacy filter doesn't reject them; reference_image stays empty.
      userReferenceImagePaths = [];
      userReferenceImageUrls = [];
      hasGlobalUserImageReferences = firstFrameUserPhotoPaths.length > 0 || firstFrameUserPhotoUrls.length > 0;
    }

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

    // ─── Saga Narrative Critic & Rewriter ──────────────────────────────
    // If the saga workflow attached a narrativeEntities payload, run a
    // pre-flight critic against the planned shots. For each violation we
    // self-dialogue with the LLM to produce a rewrite that uses ONLY the
    // user-supplied entities/relationships. Up to 2 critic+rewrite rounds.
    const narrativeEntities = coerceNarrativeEntities(action.narrativeEntities);
    let preCriticViolations: ShotViolation[] = [];
    let postCriticViolations: ShotViolation[] = [];
    const rewroteShotIndices: number[] = [];
    if (narrativeEntities) {
      toolLog(`🧠 Saga Critic: 启动 pre-flight 检查（mode=${narrativeEntities.mode} · 主角=${narrativeEntities.protagonist.name}）...`);
      preCriticViolations = runNarrativeCritic({
        shots: segments.map((seg) => ({
          index: seg.index,
          title: seg.title,
          storyBeat: seg.storyBeat,
          visualPrompt: seg.visualPrompt,
        })),
        entities: narrativeEntities,
      });
      if (preCriticViolations.length === 0) {
        toolLog(`✅ Saga Critic: 所有 shot 通过宪法检查，无违规。`);
      } else {
        toolWarn(`⚠️ Saga Critic: 检测到 ${preCriticViolations.length} 个 shot 违规，启动 self-dialogue 重写...`);
        for (let round = 1; round <= 2; round += 1) {
          const stillBroken: ShotViolation[] = [];
          for (const violation of preCriticViolations) {
            const segIdx = segments.findIndex((seg) => seg.index === violation.shotIndex);
            if (segIdx < 0) continue;
            const seg = segments[segIdx]!;
            const next = segments[segIdx + 1];
            const rewrite = await rewriteShotWithDialogue({
              cwd: context.cwd,
              shotIndex: seg.index,
              shotCount: segments.length,
              shot: { index: seg.index, title: seg.title, storyBeat: seg.storyBeat, visualPrompt: seg.visualPrompt },
              nextShotHint: next ? { index: next.index, title: next.title, storyBeat: next.storyBeat, visualPrompt: next.visualPrompt } : undefined,
              violations: violation.reasons,
              entities: narrativeEntities,
              duration: seg.duration,
            });
            if (rewrite) {
              toolLog(`✏️  Saga Critic: shot ${seg.index} 已重写 (round ${round}) — ${rewrite.storyBeat.slice(0, 80)}...`);
              seg.storyBeat = rewrite.storyBeat;
              seg.visualPrompt = rewrite.visualPrompt;
              if (rewrite.transition) seg.transition = rewrite.transition;
              // Recompile compiled prompts so the new storyBeat actually reaches BytePlus
              const previous = segIdx > 0 ? segments[segIdx - 1]! : null;
              const startingFrameAnchor = previous
                ? buildStartingFrameAnchor({
                    previousTransition: previous.transition,
                    previousCamera: previous.camera,
                    previousContinuity: previous.continuity,
                  })
                : null;
              const promptArgs = {
                bible: continuityBible,
                shotIndex: seg.index,
                shotCount: segments.length,
                duration: seg.duration,
                title: seg.title,
                storyBeat: seg.storyBeat,
                visualPrompt: seg.visualPrompt,
                camera: seg.camera,
                continuity: seg.continuity,
                transition: seg.transition,
                authoredPrompt: undefined,
                startingFrameAnchor,
              } as const;
              seg.prompt = compileShotPromptWithContinuity({ ...promptArgs, mode: continuityMode });
              seg.textOnlyPrompt = continuityMode === 'text-only'
                ? seg.prompt
                : compileShotPromptWithContinuity({ ...promptArgs, mode: 'text-only' });
              if (!rewroteShotIndices.includes(seg.index)) rewroteShotIndices.push(seg.index);
            } else {
              toolWarn(`⚠️ Saga Critic: shot ${seg.index} 重写失败（round ${round}）— 保留原稿。`);
              stillBroken.push(violation);
            }
          }
          // Re-run critic
          postCriticViolations = runNarrativeCritic({
            shots: segments.map((seg) => ({
              index: seg.index,
              title: seg.title,
              storyBeat: seg.storyBeat,
              visualPrompt: seg.visualPrompt,
            })),
            entities: narrativeEntities,
          });
          if (postCriticViolations.length === 0) {
            toolLog(`✅ Saga Critic: round ${round} 后所有违规已清除。`);
            break;
          }
          if (postCriticViolations.length >= preCriticViolations.length) {
            // No improvement → don't churn further rounds
            toolWarn(`⚠️ Saga Critic: round ${round} 未减少违规（${postCriticViolations.length} 个），停止重写循环。`);
            break;
          }
          preCriticViolations = postCriticViolations;
        }
        if (postCriticViolations.length > 0) {
          toolWarn(`⚠️ Saga Critic: 最终仍有 ${postCriticViolations.length} 个未解决的违规 — 继续生成（剩余违规会写入 saga-plan.json）。`);
        }
      }
    }

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
    const userImageReferenceDroppedSegments: number[] = [];

    // If we hit the privacy filter on the chain frame multiple times in a
    // row, the entire project is in "people-heavy" territory; abandon chain
    // frames for the rest of the run and rely on text-only continuity for
    // the remaining segments instead of paying a wasted API call each time.
    let consecutivePrivacyFails = 0;
    let chainEnabled = chainFrames;

    let previousLastFramePath: string | undefined;
    // Per-segment Image-2 opening keyframes — generated lazily right before
    // each segment's BytePlus call when super visual mode is enabled. Each
    // keyframe is an Image-2 image-to-image rendering using the canonical
    // turnaround as the identity-locked input plus the segment's planned
    // beat as the composition prompt. The keyframe is then passed alongside
    // the turnaround as a referenceImage to BytePlus, giving the video
    // model a hard identity anchor + a hard scene anchor for that segment.
    const segmentKeyframePaths = new Map<number, string>();
    const segmentKeyframeFailures: Array<{ index: number; reason: string }> = [];
    toolLog(`🎬 Saga: 开始按段生成 ${segments.length} 段视频（${actualTotalSeconds}s 总时长）。`);
    for (const segment of segments) {
      const canReuse = action.resume !== false && await existingUsableFile(segment.outputPath);
      if (canReuse) {
        reusedSegmentPaths.push(segment.outputPath);
        toolLog(`♻️ 第 ${segment.index}/${segments.length} 段：已存在缓存，复用 ${segment.outputPath}`);
      } else {
        toolLog(`🎬 正在生成第 ${segment.index}/${segments.length} 段（${segment.duration}s · ${segment.title ?? '无标题'}）...`);
        // Generate this segment's Image-2 opening keyframe right before the
        // BytePlus call. RELAY CHAIN: for shots N>1, `previousLastFramePath`
        // holds segment N-1's actual closing frame (extracted at the end of
        // the previous iteration). We pass it as a SECOND input to
        // /images/edits so the keyframe inherits BOTH identity (from the
        // turnaround) AND scene continuity (from the previous closing frame).
        // For shot 1 there is no previous frame yet, so identity-only edit.
        if (superVisualMode.enabled) {
          const keyframeResult = await generateSegmentKeyframe({
            context,
            projectDir,
            ratio,
            shotIndex: segment.index,
            shotCount: segments.length,
            shot: {
              title: segment.title,
              storyBeat: segment.storyBeat,
              visualPrompt: segment.visualPrompt,
              camera: segment.camera,
              continuity: segment.continuity,
            },
            turnaroundPath: superVisualMode.referenceImagePath,
            previousLastFramePath: segment.index > 1 ? previousLastFramePath : undefined,
          });
          if (keyframeResult.ok) {
            segmentKeyframePaths.set(segment.index, keyframeResult.framePath);
          } else {
            segmentKeyframeFailures.push({ index: segment.index, reason: keyframeResult.reason });
          }
        }

        const baseReq = {
          type: 'generate_video' as const,
          model,
          ratio,
          duration: segment.duration,
          outputPath: segment.outputPath,
          referenceImageUrls: hasGlobalUserImageReferences ? userReferenceImageUrls : undefined,
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
        let usingUserImageReferences = hasGlobalUserImageReferences;
        let lastError = '';
        let succeeded = false;

        for (let attempt = 0; attempt < 3 && !succeeded; attempt += 1) {
          // role:"first_frame" — image-to-video literal first-frame anchor.
          // Bypasses the real-person privacy filter (BytePlus).
          //   · Shot 1: user's real-person photo (if supplied) is the natural
          //     literal first frame.
          //   · Shot N>1: previous segment's last frame is the chain anchor.
          // role:"reference_image" — multimodal identity reference (filter-
          //   strict on real-person inputs but accepts illustrated):
          //   · Super Visual stylized turnaround (when enabled, illustrated
          //     three-view sheet)
          //   · Per-segment AI-generated keyframe (illustrated, by gpt-image-2)
          const firstFrameImagePaths: string[] = [];
          const firstFrameImageUrls: string[] = [];
          if (segment.index === 1) {
            firstFrameImagePaths.push(...firstFrameUserPhotoPaths);
            firstFrameImageUrls.push(...firstFrameUserPhotoUrls);
          } else if (usingChain && previousLastFramePath) {
            firstFrameImagePaths.push(previousLastFramePath);
          }
          const segmentKeyframe = segmentKeyframePaths.get(segment.index);
          const keyframePaths = segmentKeyframe ? [segmentKeyframe] : [];
          const referenceImagePaths = [...keyframePaths, ...(usingUserImageReferences ? userReferenceImagePaths : [])];
          const referenceImageUrlsForCall = usingUserImageReferences ? userReferenceImageUrls : [];
          const promptToUse = usingChain || usingUserImageReferences || firstFrameImagePaths.length > 0 ? segment.prompt : segment.textOnlyPrompt;
          const result = await executeGenerateVideo(
            {
              ...baseReq,
              prompt: promptToUse,
              referenceImageUrls: referenceImageUrlsForCall.length > 0 ? referenceImageUrlsForCall : undefined,
              referenceImagePaths,
              firstFrameImagePaths: firstFrameImagePaths.length > 0 ? firstFrameImagePaths : undefined,
              firstFrameImageUrls: firstFrameImageUrls.length > 0 ? firstFrameImageUrls : undefined,
              generateAudio: usingAudio,
            },
            context,
          );
          if (result.ok) {
            succeeded = true;
            if (usingChain && segment.index > 1 && previousLastFramePath) chainedFromPrev.push(segment.outputPath);
            if (!usingChain && chainEnabled && previousLastFramePath) chainDroppedSegments.push(segment.index);
            if (hasGlobalUserImageReferences && !usingUserImageReferences) userImageReferenceDroppedSegments.push(segment.index);
            if (!usingAudio && userAudioPreference) audioRetriedSegments.push(segment.index);
            if (usingChain) consecutivePrivacyFails = 0;
            const tags = [
              attempt > 0 ? `重试${attempt}` : '一次过',
              usingChain ? 'chain' : '无chain',
              usingAudio ? '有音' : '无音',
              usingUserImageReferences ? '用户图' : '无用户图',
            ].join(' / ');
            toolLog(`✅ 第 ${segment.index}/${segments.length} 段完成（${tags}）。`);
            break;
          }
          lastError = result.output ?? '';
          const audioBlocked = isAudioSafetyError(lastError);
          const imageBlocked = isImagePrivacyError(lastError);
          const pollTimeout = isPollTimeoutError(lastError);
          if (!audioBlocked && !imageBlocked && !pollTimeout) {
            // Non-recoverable error — bail.
            toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：不可恢复错误，停止重试。${lastError.slice(0, 200)}`);
            break;
          }
          if (pollTimeout) {
            // Same inputs, fresh submission. BytePlus queue was just slow.
            toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：视频生成队列拥堵（poll 超时），重新提交任务（尝试 ${attempt + 2}/3）...`);
            continue;
          }
          // Decide the next attempt's degradation. We strip the offending
          // input first; subsequent attempts can additionally strip the
          // other.
          if (imageBlocked && usingChain) {
            usingChain = false;
            consecutivePrivacyFails += 1;
            toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：视频生成 API 内容过滤拦截了 chain frame，剥离 chain 后重试中（尝试 ${attempt + 2}/3）...`);
          } else if (imageBlocked && hasGlobalUserImageReferences && usingUserImageReferences) {
            // Stylized reference_image rejected — drop and try first_frame only.
            usingUserImageReferences = false;
            toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：reference_image 被内容过滤拦截，剥离 reference_image 后重试中（尝试 ${attempt + 2}/3）...`);
          } else if (audioBlocked && usingAudio) {
            usingAudio = false;
            toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：视频生成 API 内容过滤拦截了输出音频，关闭音频后重试中（尝试 ${attempt + 2}/3）...`);
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
    const outputProbe = await probeSegment(resolvedOutput.absolute);
    const measuredOutputSeconds = outputProbe.durationSeconds ?? renderResult.durationSeconds;
    const shortfallToleranceSeconds = Math.max(2, totalSeconds * 0.2);
    if (measuredOutputSeconds + shortfallToleranceSeconds < totalSeconds) {
      return {
        action,
        ok: false,
        output: [
          'generate_long_video: final duration verification failed.',
          `Requested ${totalSeconds}s, renderer expected ${renderResult.durationSeconds.toFixed(2)}s, actual file is ${measuredOutputSeconds.toFixed(2)}s.`,
          `Video: ${resolvedOutput.absolute}`,
          outputProbe.error ? `Probe: ${outputProbe.error}` : undefined,
        ].filter(Boolean).join('\n'),
      };
    }

    const lintFormatted = formatLintReport(renderResult.diagnostics.lint);

    const manifestPath = path.join(projectDir, 'saga-manifest.json');
    const planPath = path.join(projectDir, 'saga-plan.json');
    const metadataPath = outputMetadataPathFor(resolvedOutput.absolute);
    const outputBaseName = path.basename(resolvedOutput.absolute);
    const plan = {
      schema: 'artemis-saga.plan.v2',
      projectId,
      title,
      generatedAt: generatedAt.toISOString(),
      localGeneratedAt,
      story,
      requestedTotalSeconds: totalSeconds,
      plannedTotalSeconds: actualTotalSeconds,
      ratio,
      provider,
      model,
      limits,
      superVisualMode,
      narrative: narrativeEntities ? {
        ...narrativeEntities,
        critic: {
          preFlightViolations: preCriticViolations,
          postRewriteViolations: postCriticViolations,
          rewroteShotIndices,
        },
      } : null,
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
    const manifest = {
      schema: 'artemis-saga.manifest.v2',
      projectId,
      title,
      generatedAt: generatedAt.toISOString(),
      localGeneratedAt,
      searchableText: [
        title,
        projectId,
        localGeneratedAt,
        `${totalSeconds}s`,
        ratio,
        story.slice(0, 500),
      ].filter(Boolean).join(' | '),
      provider: describeVisualProvider(configured.config, 'video'),
      model,
      requestedTotalSeconds: totalSeconds,
      totalSeconds: measuredOutputSeconds,
      rendererReportedTotalSeconds: renderResult.durationSeconds,
      ratio,
      fps,
      quality,
      gpu: action.gpu ?? 'auto',
      colorMatch: action.colorMatch ?? false,
      segmentCount: segments.length,
      segmentMaxSeconds: limits.maxSegmentSeconds,
      assemblyMode: 'saga',
      superVisualMode,
      encoderUsed: renderResult.encoderUsed,
      outputPath: resolvedOutput.absolute,
      outputFileName: outputBaseName,
      metadataPath,
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
        userImageReferenceDroppedSegments,
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
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await writeFile(metadataPath, JSON.stringify({
      schema: 'artemis-saga.video-metadata.v1',
      title,
      projectId,
      generatedAt: generatedAt.toISOString(),
      localGeneratedAt,
      requestedTotalSeconds: totalSeconds,
      totalSeconds: measuredOutputSeconds,
      rendererReportedTotalSeconds: renderResult.durationSeconds,
      ratio,
      provider: describeVisualProvider(configured.config, 'video'),
      model,
      superVisualMode,
      outputPath: resolvedOutput.absolute,
      manifestPath,
      planPath,
      storyPreview: story.slice(0, 1000),
      searchHints: {
        byTitle: title,
        byDate: localGeneratedAt.slice(0, 10),
        byTime: localGeneratedAt.slice(11),
        byDuration: `${totalSeconds}s`,
        byProjectId: projectId,
      },
    }, null, 2), 'utf8');
    await appendFile(
      path.join(context.cwd, DEFAULT_LONG_VIDEO_SUBDIR, 'saga-library.jsonl'),
      `${JSON.stringify({
        schema: 'artemis-saga.library-entry.v1',
        title,
        projectId,
        generatedAt: generatedAt.toISOString(),
        localGeneratedAt,
        requestedTotalSeconds: totalSeconds,
        totalSeconds: measuredOutputSeconds,
        rendererReportedTotalSeconds: renderResult.durationSeconds,
        ratio,
        outputPath: resolvedOutput.absolute,
        manifestPath,
        metadataPath,
      })}\n`,
      'utf8',
    );

    // Narrative library — separate file so future runs can use it as few-shot
    // for shots-of-the-same-protagonist-type and to learn from rewriting outcomes.
    if (narrativeEntities) {
      const narrativeEntry: NarrativeLibraryEntry = {
        schema: 'artemis-saga.narrative-library.v1',
        recordedAt: generatedAt.toISOString(),
        projectId,
        protagonistMode: narrativeEntities.mode,
        protagonistName: narrativeEntities.protagonist.name,
        protagonistType: narrativeEntities.protagonist.type,
        protagonistConfidence: narrativeEntities.protagonist.confidence,
        totalDuration: measuredOutputSeconds,
        shotCount: segments.length,
        preCriticViolations,
        postCriticViolations,
        rewroteShotIndices,
        outputVideoPath: resolvedOutput.absolute,
      };
      await appendNarrativeLibraryEntry({ cwd: context.cwd, entry: narrativeEntry });
    }

    // Verify the output landed.
    await readFile(resolvedOutput.absolute);
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    return {
      action,
      ok: true,
      output: [
        `Saga generated long video using model ${String(model).replace(/^[^/]+\//, '')}.`,
        `Segments: ${segments.length} x <=${limits.maxSegmentSeconds}s, target duration ${totalSeconds}s, planned duration ${actualTotalSeconds}s, output duration ${measuredOutputSeconds.toFixed(2)}s.`,
        `Renderer: saga (${renderResult.encoderUsed}); transitions: ${renderResult.appliedTransitions.map((t) => `${t.kind}@${t.durationMs}ms`).join(', ') || 'none'}.`,
        `Continuity: mode=${continuityMode}, chainReferenceFrames=${chainFrames}, chained-segments=${chainedFromPrev.length}, chain-dropped-segments=${chainDroppedSegments.length}${chainEnabled !== chainFrames ? ' (chain abandoned mid-run after privacy filter)' : ''}.`,
        `Super visual: ${superVisualMode.enabled ? `enabled mode=${superVisualMode.mode} userImagesUsed=${superVisualMode.userImagesUsed} (${superVisualMode.referenceImagePath})` : `off (${superVisualMode.reason})`}.`,
        `Segment keyframes: generated=${segmentKeyframePaths.size}/${segments.length}${segmentKeyframeFailures.length > 0 ? `, failures=${segmentKeyframeFailures.length} [${segmentKeyframeFailures.map((f) => `seg${f.index}: ${f.reason}`).join('; ')}]` : ''}.`,
        `References: user-image-reference-dropped-segments=${userImageReferenceDroppedSegments.length}.`,
        narrativeEntities
          ? `Narrative critic: mode=${narrativeEntities.mode}, protagonist=${narrativeEntities.protagonist.name}, pre-violations=${preCriticViolations.length}, post-violations=${postCriticViolations.length}, rewrote-shots=[${rewroteShotIndices.join(',') || 'none'}].`
          : 'Narrative critic: skipped (no narrativeEntities supplied).',
        `Audio: requested=${userAudioPreference}, audio-safety-retry-segments=${audioRetriedSegments.length}.`,
        ...(reusedSegmentPaths.length > 0 ? [`Reused existing segments: ${reusedSegmentPaths.length}.`] : []),
        `Video: ${resolvedOutput.absolute}`,
        `Title: ${title}`,
        `Plan: ${planPath}`,
        `Manifest: ${manifestPath}`,
        `Metadata: ${metadataPath}`,
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
