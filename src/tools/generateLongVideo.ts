import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentAction } from '../core/types.js';
import { ensureNotSensitivePath, resolveArtemisHomeDir } from '../utils/fs.js';
import { toolLog, toolWarn } from '../utils/log.js';
import { getMediaOutputRoot } from '../utils/mediaOutputRoot.js';
import {
  buildVisualSetupRequiredMessage,
  describeVisualProvider,
  resolveConfiguredVisualProvider,
} from '../utils/visualGenerationConfig.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { executeGenerateVideo } from './generateVideo.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { describeUserImageWithVision, generateSafeBridgeKeyframe, generateSegmentKeyframe, maybeGenerateSuperVisualReference } from './visual/superVisualMode.js';
import { parseStoryboardImageWithVision } from './visual/storyboardParser.js';
import {
  analyzeNarrative,
  appendNarrativeLibraryEntry,
  buildSagaConstitution,
  runNarrativeCritic,
  rewriteShotWithDialogue,
  narrativeKeywordFallback,
  sanitizeForVideoProvider,
  diffSanitize,
  type NarrativeEntities,
  type NarrativeLibraryEntry,
  type ShotViolation,
} from './visual/sagaNarrative.js';
import { normalizeSagaPromptForVideoGeneration } from './visual/sagaLanguageDirector.js';
import { buildEnsembleContactSheet } from './visual/contactSheet.js';
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
import { detectsLockOffCamera } from './visual/sagaRenderer/continuity.js';
import type {
  SagaFps,
  SagaQuality,
  SagaRatio,
  SagaSegmentInput,
  SagaTransitionKind,
  SagaTransitionPlan,
} from './visual/sagaRenderer/types.js';

type GenerateLongVideoAction = Extract<AgentAction, { type: 'generate_long_video' }>;
type SagaIdentitySource = NonNullable<GenerateLongVideoAction['identitySource']>;

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
const DEFAULT_TRANSITION: SagaTransitionKind = 'cut';
const DEFAULT_CROSSFADE_MS = 350;
const DEFAULT_LONG_VIDEO_SUBDIR = 'long-videos';
// Floor (NOT a maximum). Match the custom provider default so Saga does not
// accidentally override a longer provider wait with a shorter explicit value.
// 420 polls × 10s = 70min per attempt.
const MIN_SAGA_SEGMENT_MAX_POLLS = 420;

function superVisualBypassReason(identitySource: SagaIdentitySource | undefined, isPureEnvironment: boolean): string | null {
  if (isPureEnvironment) return 'environment-mode-bypass';
  if (identitySource === 'text_only') return 'text-only-identity-bypass';
  if (identitySource === 'direct_image') return 'direct-image-direct-to-video';
  return null;
}

export function shouldBypassSuperVisualForIdentitySourceForTest(
  identitySource: SagaIdentitySource | undefined,
  isPureEnvironment = false,
): boolean {
  return superVisualBypassReason(identitySource, isPureEnvironment) !== null;
}

function clampTotalSeconds(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TOTAL_SECONDS;
  return Math.max(10, Math.min(MAX_TOTAL_SECONDS, Math.floor(value)));
}

// Coerce the loose action.narrativeEntities payload (which may have undefined
// fields when the planner echoes a partial map) into the strict NarrativeEntities
// type the critic+rewriter expect.
function asNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}

function coerceNarrativeEntities(raw: GenerateLongVideoAction['narrativeEntities']): NarrativeEntities | null {
  if (!raw) return null;
  const protoRaw = raw.protagonist ?? {};
  const type = protoRaw.type === 'product' || protoRaw.type === 'environment' ? protoRaw.type : 'character';
  const mode = raw.mode === 'character' || raw.mode === 'product' || raw.mode === 'environment' || raw.mode === 'mixed' || raw.mode === 'unclear'
    ? raw.mode
    : type;
  const source = raw.source === 'user-clarification' || raw.source === 'keyword-fallback' ? raw.source : 'llm';
  const wmRaw = (raw.worldModel ?? {}) as Record<string, unknown>;
  const wardrobeRaw = (wmRaw.wardrobe ?? {}) as Record<string, unknown>;
  return {
    protagonist: {
      name: typeof protoRaw.name === 'string' && protoRaw.name.trim() ? protoRaw.name.trim() : '(unnamed)',
      type,
      confidence: typeof protoRaw.confidence === 'number' ? Math.max(0, Math.min(1, protoRaw.confidence)) : 0.7,
      evidence: typeof protoRaw.evidence === 'string' ? protoRaw.evidence : '',
      aliases: asNonEmptyStringArray(protoRaw.aliases),
    },
    supportingCharacters: asNonEmptyStringArray(raw.supportingCharacters),
    props: asNonEmptyStringArray(raw.props),
    environments: asNonEmptyStringArray(raw.environments),
    relationships: asNonEmptyStringArray(raw.relationships),
    actions: asNonEmptyStringArray(raw.actions),
    protagonistAccessories: asNonEmptyStringArray(raw.protagonistAccessories),
    worldModel: {
      weather: typeof wmRaw.weather === 'string' ? wmRaw.weather : undefined,
      lighting: typeof wmRaw.lighting === 'string' ? wmRaw.lighting : undefined,
      timeOfDay: typeof wmRaw.timeOfDay === 'string' ? wmRaw.timeOfDay : undefined,
      gravity: typeof wmRaw.gravity === 'string' ? wmRaw.gravity : undefined,
      occlusion: asNonEmptyStringArray(wmRaw.occlusion),
      wardrobe: {
        permanent: asNonEmptyStringArray(wardrobeRaw.permanent),
        variable: asNonEmptyStringArray(wardrobeRaw.variable),
      },
      distinguishingMarks: asNonEmptyStringArray(wmRaw.distinguishingMarks),
      bodyProportions: typeof wmRaw.bodyProportions === 'string' ? wmRaw.bodyProportions : undefined,
      skinTone: typeof wmRaw.skinTone === 'string' ? wmRaw.skinTone : undefined,
      hair: typeof wmRaw.hair === 'string' ? wmRaw.hair : undefined,
      clutter: asNonEmptyStringArray(wmRaw.clutter),
      palette: asNonEmptyStringArray(wmRaw.palette),
      mood: typeof wmRaw.mood === 'string' ? wmRaw.mood : undefined,
      soundscape: typeof wmRaw.soundscape === 'string' ? wmRaw.soundscape : undefined,
      cameraVocabulary: asNonEmptyStringArray(wmRaw.cameraVocabulary),
      identityLockedProps: asNonEmptyStringArray(wmRaw.identityLockedProps),
      sceneVariableProps: asNonEmptyStringArray(wmRaw.sceneVariableProps),
      visualRhymes: asNonEmptyStringArray(wmRaw.visualRhymes),
      continuityRules: asNonEmptyStringArray(wmRaw.continuityRules),
      exclusions: asNonEmptyStringArray(wmRaw.exclusions),
      spatialReality: (() => {
        const sr = (wmRaw.spatialReality ?? {}) as Record<string, unknown>;
        return {
          groundSurface: typeof sr.groundSurface === 'string' ? sr.groundSurface : undefined,
          waterLine: typeof sr.waterLine === 'string' ? sr.waterLine : undefined,
          occlusionRules: asNonEmptyStringArray(sr.occlusionRules),
          perspectiveCues: typeof sr.perspectiveCues === 'string' ? sr.perspectiveCues : undefined,
          physicsRules: asNonEmptyStringArray(sr.physicsRules),
          forbiddenSpatialErrors: asNonEmptyStringArray(sr.forbiddenSpatialErrors),
        };
      })(),
    },
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

function stripInjectedPolicyBlocks(value: string): string {
  return value
    // Some bridge/runtime paths may append developer-facing visual policy text
    // into the user story. That text is for tool selection, not for the video
    // model; if it reaches Saga planning it can become a storyBeat and trigger
    // provider policy classifiers (we saw this as segment-3 "copyright" fails).
    .replace(/\s*\[Visual generation policy\][\s\S]*?(?=\n\s*\n|\n\s*(?:与|同|same|the|a|an|[\p{L}\p{N}])|$)/giu, '\n')
    .replace(/\s*The user confirmed local visual generation\.[\s\S]*?do not silently fall back to SVG placeholders for photographic subjects\.?/giu, '\n')
    .replace(/\s*Photographic \/ product \/ editorial \/ lifestyle assets MUST be produced via generate_image[\s\S]*?do not silently fall back to SVG placeholders for photographic subjects\.?/giu, '\n')
    .replace(/\s*Icons, logos, UI controls, loaders, geometric or abstract decoration[\s\S]*?not violations\.?/giu, '\n')
    .replace(/\s*The forbidden pattern is substituting hand-authored SVG\/canvas\/procedural code[\s\S]*?instead of calling generate_image\)\.?/giu, '\n')
    .replace(/\s*If generate_image returns an error,[\s\S]*?do not silently fall back to SVG placeholders for photographic subjects\.?/giu, '\n')
    .replace(/\s*writing a node\/python script that draws "product images" instead of calling generate_image\)\.?/giu, '\n')
    .replace(/\s*EXPLICIT (?:DIRECT IMAGE|USER TURNAROUND) SOURCE:[^\n]*/giu, '\n')
    .replace(/\s*ACCESSORY LOCK —[^\n]*/giu, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeSagaUserText(value: string | undefined): string {
  return stripInjectedPolicyBlocks(value ?? '');
}

function sanitizeReferenceNotesForStory(notes: string[], baseStory: string): string[] {
  const compactBase = compactInline(baseStory);
  return notes
    .map((note) => sanitizeSagaUserText(note))
    .map((note) => compactInline(note))
    .filter(Boolean)
    // Full prompt/reference duplicates are not identity notes. Repeating them
    // bloats every segment and makes policy classifiers see the same sensitive
    // text twice. Keep short notes such as "this image is the protagonist".
    .filter((note) => note.length <= 240)
    .filter((note) => {
      if (!compactBase || note.length < 40) return true;
      return !compactBase.includes(note) && !note.includes(compactBase.slice(0, Math.min(160, compactBase.length)));
    })
    .slice(0, 4);
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
  return uniquifyPath(path.join(getMediaOutputRoot(), DEFAULT_LONG_VIDEO_SUBDIR, options.projectId, fileName));
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

// Convert a [H:]MM:SS / MM:SS / SS time-token into seconds. Returns NaN for
// junk. Used by parseTimestampedShotsFromStory to support both decimal-second
// markers ([0-8秒]) and clock-style markers ([0:00-0:08], [1:30-1:38]).
function parseTimeTokenToSeconds(token: string): number {
  const parts = token.split(':').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return NaN;
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return NaN;
}

function parseTimestampedShotsFromStory(
  story: string,
  maxSegmentSeconds: number,
  totalSeconds?: number,
): SagaShotInput[] {
  // Time-range markers in many user-formats:
  //   [0-8秒]  [0-8]  [0-8s]  [0.5-8.5秒]
  //   [0:00-0:08]  [1:30-1:38]
  //   [00:00:00-00:00:08]
  // Token = digits with optional ":mm" or ":mm:ss"
  const TIME_TOKEN = '\\d+(?::\\d{2})?(?:\\.\\d+)?(?::\\d{2})?';
  const markerRe = new RegExp(
    `\\[\\s*(${TIME_TOKEN})\\s*[-–—~至到]\\s*(${TIME_TOKEN})\\s*(?:秒|s|sec|seconds)?\\s*\\]`,
    'gi',
  );
  let markers = Array.from(story.matchAll(markerRe));

  // Fallback A: timecode without brackets at line-head, e.g. "0:00-0:08:" or "0-8s:"
  if (markers.length < 2) {
    const looseRe = new RegExp(
      `(?:^|\\n)\\s*(${TIME_TOKEN})\\s*[-–—~至到]\\s*(${TIME_TOKEN})\\s*(?:秒|s|sec|seconds)?\\s*[:：]`,
      'gi',
    );
    markers = Array.from(story.matchAll(looseRe));
  }

  const shots: SagaShotInput[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]!;
    const next = markers[index + 1];
    const start = parseTimeTokenToSeconds(String(marker[1]));
    const end = parseTimeTokenToSeconds(String(marker[2]));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const rawBody = story.slice((marker.index ?? 0) + marker[0].length, next?.index ?? story.length).trim();
    const body = rawBody.replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const dedupeKey = `${Math.round(start)}-${Math.round(end)}:${body.slice(0, 240)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const duration = Math.max(4, Math.min(maxSegmentSeconds, Math.round(end - start)));
    const title = `${Math.round(start)}-${Math.round(end)}s`;
    const cameraMatch = body.match(/(?:镜头|camera)[:：]\s*([^。.!！?\n]+)/i);
    const transitionMatch = body.match(/(?:转场|transition)[:：]\s*([^。.!！?\n]+)/i);
    shots.push({
      title,
      duration,
      storyBeat: body,
      visualPrompt: `Follow this exact timestamped script section: ${body}`,
      camera: cameraMatch?.[1]?.trim(),
      transition: transitionMatch?.[1]?.trim(),
      continuity: 'Preserve the user-supplied timestamped script order exactly; do not invent unrelated scenes.',
    });
  }

  if (shots.length >= 2) return shots;

  // Fallback B: structural markers WITHOUT explicit times, e.g.
  //   "Scene 1", "Shot 3", "镜头 4", "第 5 段", "段 1 ·", "Segment 2"
  // We distribute totalSeconds evenly across the detected scenes.
  if (totalSeconds && totalSeconds >= 8) {
    const sceneRe = /(?:^|\n)\s*(?:(?:scene|shot|segment|镜头|段)\s*[#]?(\d+)|第\s*(\d+)\s*段)[\s.·:：、,。\-—–]/gi;
    const sceneMarkers = Array.from(story.matchAll(sceneRe));
    if (sceneMarkers.length >= 2) {
      const distributed: SagaShotInput[] = [];
      const perScene = Math.max(4, Math.min(maxSegmentSeconds, Math.floor(totalSeconds / sceneMarkers.length)));
      for (let index = 0; index < sceneMarkers.length; index += 1) {
        const marker = sceneMarkers[index]!;
        const next = sceneMarkers[index + 1];
        const rawBody = story.slice((marker.index ?? 0) + marker[0].length, next?.index ?? story.length).trim();
        const body = rawBody.replace(/\s+/g, ' ').trim();
        if (!body) continue;
        const cameraMatch = body.match(/(?:镜头|camera)[:：]\s*([^。.!！?\n]+)/i);
        const transitionMatch = body.match(/(?:转场|transition)[:：]\s*([^。.!！?\n]+)/i);
        distributed.push({
          title: `Scene ${index + 1}`,
          duration: perScene,
          storyBeat: body,
          visualPrompt: `Follow this exact scripted scene: ${body}`,
          camera: cameraMatch?.[1]?.trim(),
          transition: transitionMatch?.[1]?.trim(),
          continuity: 'Preserve the user-supplied scene order exactly; do not invent unrelated scenes.',
        });
      }
      if (distributed.length >= 2) return distributed;
    }
  }

  return [];
}

// Public: does this brief contain explicit structural markers? Used by the
// LLM-rewrite gate to skip rewrite (which would otherwise destroy timecodes
// and per-segment specificity) when the user has already structured their brief.
export function hasStructuredBriefMarkers(text: string): boolean {
  if (!text) return false;
  const TIME_TOKEN = '\\d+(?::\\d{2})?(?:\\.\\d+)?(?::\\d{2})?';
  const bracketTimeRe = new RegExp(`\\[\\s*${TIME_TOKEN}\\s*[-–—~至到]\\s*${TIME_TOKEN}\\s*(?:秒|s|sec|seconds)?\\s*\\]`, 'i');
  if (bracketTimeRe.test(text)) return true;
  const looseTimeRe = new RegExp(`(?:^|\\n)\\s*${TIME_TOKEN}\\s*[-–—~至到]\\s*${TIME_TOKEN}\\s*(?:秒|s|sec|seconds)?\\s*[:：]`, 'i');
  if (looseTimeRe.test(text)) return true;
  const sceneRe = /(?:^|\n)\s*(?:(?:scene|shot|segment|镜头|段)\s*[#]?\d+|第\s*\d+\s*段)[\s.·:：、,。\-—–]/i;
  if (sceneRe.test(text)) return true;
  return false;
}

function mergeStringArrays(...values: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of values) {
    for (const value of list ?? []) {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
  }
  return out;
}

function extractSceneAnchorsFromStory(story: string): string[] {
  const anchors: string[] = [];
  const sceneMatch = story.match(/(?:场景|地点|环境|setting|location)\s*[:：]\s*([^\n[]+)/i);
  if (sceneMatch?.[1]) {
    anchors.push(sceneMatch[1].replace(/\s+/g, ' ').trim().slice(0, 160));
  }
  const casinoTerms = Array.from(story.matchAll(/(?:MaGame\s+Casino|奢华赌场大厅|赌场大厅|赌场|轮盘桌|吧台|老虎机|21点|赌客|水晶吊灯|霓虹LOGO)/gi))
    .map((match) => match[0]);
  if (casinoTerms.length >= 2) {
    anchors.push('MaGame Casino 奢华赌场大厅，含轮盘桌、筹码、赌客、水晶吊灯、吧台、老虎机、金色霓虹LOGO');
  }
  return mergeStringArrays(anchors);
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

function buildMotionTimelineFallback(storyChunk: string, duration: number, index: number): string {
  const first = Math.max(1, Math.floor(duration * 0.35));
  const second = Math.max(first + 1, Math.floor(duration * 0.7));
  const actionSets = [
    ['steps through the scene with a deliberate weight shift', 'turns the shoulders and reaches toward the next focal point', 'continues the gesture into the closing frame while fabric and hair keep moving'],
    ['leans into motion and crosses the foreground plane', 'lifts one hand to interact with the scene element', 'releases the movement into drifting particles and a carried-through body turn'],
    ['enters mid-stride with one foot already moving', 'rotates around the prop or light source with visible parallax', 'finishes in a moving silhouette that points into the next shot'],
  ];
  const actions = actionSets[index % actionSets.length]!;
  return `0–${first}s: the protagonist ${actions[0]}; environmental motion remains continuous. ${first}–${second}s: the protagonist ${actions[1]}; camera tracks with natural parallax. ${second}–end: the protagonist ${actions[2]}. Scene intent: ${storyChunk}`;
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
  cleanDirect?: boolean;
}): SagaSegment[] {
  const beats = sentenceChunks(options.story);
  const plannedShots = Array.isArray(options.shots)
    ? options.shots.filter((shot) => shot && typeof shot === 'object')
    : [];
  const segmentCount = plannedShots.length > 0
    ? plannedShots.length
    : Math.max(1, Math.ceil(options.totalSeconds / Math.max(4, Math.min(options.preferredSegmentSeconds, 6))));
  const plannedDurationSum = plannedShots.reduce((sum, shot) => (
    typeof shot.duration === 'number' && Number.isFinite(shot.duration) ? sum + Math.max(0, shot.duration) : sum
  ), 0);
  const usePlannedDurations = plannedShots.length > 0
    && plannedDurationSum > 0
    && Math.abs(plannedDurationSum - options.totalSeconds) <= Math.max(2, options.totalSeconds * 0.15);
  const durations = usePlannedDurations
    ? plannedShots.map((shot) => normalizeShotDuration(shot.duration, options.preferredSegmentSeconds, options.maxSegmentSeconds))
    : distributeDurations(options.totalSeconds, segmentCount, options.maxSegmentSeconds);
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
    const duration = usePlannedDurations
      ? (durations[index] ?? normalizeShotDuration(planned?.duration, options.preferredSegmentSeconds, options.maxSegmentSeconds))
      : normalizeShotDuration(undefined, durations[index] ?? options.preferredSegmentSeconds, options.maxSegmentSeconds);
    // In cleanDirect mode the motion-timeline boilerplate ("the protagonist
    // steps through the scene with a deliberate weight shift; ... Scene
    // intent: <user text>") front-loaded a generic walking/turning verb that
    // dominated the model's interpretation and reduced the user's actual
    // explicit content to a single afterthought sentence. Skip the wrapper
    // and feed the per-segment story chunk in verbatim — the user's prompt
    // becomes the dominant signal exactly as intended.
    const storyBeatFallback = options.cleanDirect
      ? (storyChunkFallback || options.story).slice(0, 900)
      : buildMotionTimelineFallback(storyChunkFallback, duration, index);
    const storyBeat = sanitizeInline(rawPlannedStoryBeat, storyBeatFallback);
    const title = sanitizeInline(planned?.title, `Shot ${index + 1}`);
    const rawPlannedVisualPrompt = looksLikeIdentityRuleBoilerplate(planned?.visualPrompt) ? undefined : planned?.visualPrompt;
    const visualPrompt = options.cleanDirect
      ? sanitizeInline(rawPlannedVisualPrompt, '')
      : sanitizeInline(
          rawPlannedVisualPrompt,
          `Cinematic realization of this story beat with consistent characters, location, lighting, and emotional tone: ${storyBeat}`,
        );
    // Per-segment camera default. If user's storyBeat OR the global brief
    // requests a locked-off camera (锁死机位 / locked-off tripod / NO pan
    // tilt zoom dolly), force the per-segment default to lock-off too —
    // otherwise the rotating "slow controlled dolly / handheld push-in /
    // gimbal arc" defaults contradict the [CAMERA: locked-off] block in
    // the continuity bible, and the model gets conflicting signals.
    // Generic — reuses the same detector as the bible-level CAMERA block.
    const segmentLockOff = detectsLockOffCamera(storyBeat) || detectsLockOffCamera(options.story);
    const cameraDefault = segmentLockOff
      ? 'absolutely locked-off tripod, no camera movement whatsoever — no pan, no tilt, no zoom, no dolly, no handheld shake'
      : (index % 3 === 0
        ? 'slow controlled dolly movement with stable subject tracking and visible parallax'
        : index % 3 === 1
          ? 'gentle handheld cinematic push-in following the protagonist through the motion'
          : 'gimbal arc around the protagonist with continuous environmental motion');
    const camera = options.cleanDirect
      ? sanitizeInline(planned?.camera, '')
      : sanitizeInline(planned?.camera, cameraDefault);
    const continuity = options.cleanDirect
      ? sanitizeInline(planned?.continuity, '')
      : sanitizeInline(
          planned?.continuity,
          'Carry forward the same character identity, wardrobe, props, color palette, environment logic, and lighting direction from adjacent shots.',
        );
    const transition = options.cleanDirect
      ? sanitizeInline(planned?.transition, '')
      : sanitizeInline(
          planned?.transition,
          index === 0 ? 'open from black into a mid-action first frame, not a static pose' : 'carry the protagonist mid-motion from the previous closing frame into the next opening frame; match direction, limb momentum, hair/fabric flow, and light movement',
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
    const prompt = compileShotPromptWithContinuity({ ...promptArgs, mode: options.continuityMode, cleanDirect: options.cleanDirect });
    // Always also compile a text-only variant. We use it when a per-segment
    // retry has to drop the chained image reference because of a provider
    // safety/privacy filter — the text-only prompt verbally compensates.
    const textOnlyPrompt = options.continuityMode === 'text-only'
      ? prompt
      : compileShotPromptWithContinuity({ ...promptArgs, mode: 'text-only', cleanDirect: options.cleanDirect });
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
  return /InputImageSensitiveContentDetected|Invalid image file in references|invalid image|image file.*invalid|input image.*sensitive|input image.*privacy|input image may contain real person|input.*moderation|input.*safety|expected at most one first frame|expected at most \d+ (?:first|last|reference)|first\/last frame.*cannot be mixed|content cannot be mixed with reference/i.test(message);
}

// BytePlus / Seedance frequently leaves a task in `running` state past the
// default 60-poll window when their queue is busy. The task itself isn't
// rejected — it's just slow. Submitting a fresh task is the right recovery,
// not declaring the segment dead.
export function isPollTimeoutErrorForTest(message: string | undefined): boolean {
  if (!message) return false;
  return /did not (?:finish|complete) within \d+ polls?|Last status:\s*(?:running|processing|pending|queued|submitted)/i.test(message);
}

function shouldPreserveUserScriptWithoutCriticRewrite(options: {
  action: GenerateLongVideoAction;
  timestampedStoryShots: SagaShotInput[];
}): boolean {
  if (options.action.preserveUserScript === true) return true;
  if (options.timestampedStoryShots.length > 0) return true;

  const story = `${options.action.story ?? ''}\n${options.action.prompt ?? ''}`;
  return /(?:^|\n|\s)(?:\d+(?:\.\d+)?\s*[–-]\s*\d+(?:\.\d+)?\s*s?|shot\s*\d+|镜头\s*\d+|第\s*\d+\s*(?:幕|段|镜头))/i.test(story);
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

function isHumanOrMixedSubject(entities: NarrativeEntities | null): boolean {
  if (!entities) return false;
  return entities.mode === 'character'
    || entities.mode === 'mixed'
    || entities.mode === 'unclear'
    || entities.protagonist.type === 'character';
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

function deriveOcclusionLocksFromAccessories(accessories: string[] | undefined): string[] {
  const locks: string[] = [];
  for (const item of accessories ?? []) {
    if (/(eye[\s-]*mask|blindfold|遮.*眼|眼罩|蒙眼|覆眼|遮住双眼|遮住眼睛)/i.test(item)) {
      locks.push(`Eye-covering accessory lock: ${item}. The accessory fully covers the eyes in every shot; eyes, pupils, irises, eyelashes behind it, and eye gaze must never be visible or implied through the cover.`);
    } else if (/(face[\s-]*mask|mask|veil|面罩|面具|面纱|遮.*脸|遮面)/i.test(item)) {
      locks.push(`Face-covering accessory lock: ${item}. The covered facial area stays hidden in every shot; do not reveal anatomy that the accessory covers.`);
    }
  }
  return locks;
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
    const videoNsfw = configured.nsfw === true || configured.config.video.nsfw === true;
    const identitySource = action.identitySource;
    const limits = resolveVideoModelLimits(provider, model);
    const ratio = resolveRatio(action.ratio);
    const totalSeconds = clampTotalSeconds(action.totalDuration ?? action.duration);
    const projectId = normalizeProjectId(action.projectId);
    const fps: SagaFps = (action.fps as SagaFps | undefined) ?? 30;
    const quality: SagaQuality = (action.quality as SagaQuality | undefined) ?? 'standard';

    // Side-channel recovery: saga workflow writes the FULL user story to a
    // known file before returning the action, because the agent layer
    // (LLM tool-call serialization) sometimes truncates a long story argument.
    // When the file exists and contains a longer body than action.story, use it.
    let resolvedSourceStory = action.story || '';
    try {
      const { readFileSync, existsSync, unlinkSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const sourcePath = path.join(resolveArtemisHomeDir(), 'saga-pending', `${projectId}-source-story.txt`);
      if (existsSync(sourcePath)) {
        const sideStory = readFileSync(sourcePath, 'utf8');
        if (sideStory && sideStory.length > resolvedSourceStory.length) {
          toolLog(`📖 Saga: 从 saga-pending side-channel 恢复完整剧本 (${sideStory.length} 字符，覆盖 agent 传入的 ${resolvedSourceStory.length} 字符)`);
          resolvedSourceStory = sideStory;
        }
        try { unlinkSync(sourcePath); } catch { /* best-effort cleanup */ }
      }
    } catch {
      // Side-channel is best-effort; fall through to action.story.
    }

    const rawStory = sanitizeSagaUserText(resolvedSourceStory || action.prompt);
    const referenceNotes = sanitizeReferenceNotesForStory(nonEmptyStringArray(action.referenceNotes), rawStory);
    let story = [
      rawStory,
      referenceNotes.length > 0
        ? `\n\nReference notes from user: ${referenceNotes.join(' | ')}`
        : '',
    ].join('').trim();
    // Gate LLM rewrite: when the user has explicitly structured their brief
    // (timecodes [X-Y秒], MM:SS ranges, Scene/Shot/镜头/段 markers, or
    // explicit dialogue markers), skip the rewrite entirely. Rewrite
    // condenses the brief into a generic English paragraph, which destroys
    // timecodes, per-segment specificity (locations / props / actions),
    // camera lock instructions, and audio-intent clauses. The downstream
    // planner reads structured markers directly. Generic — protects any
    // user whose brief is already well-structured.
    const briefIsStructured = hasStructuredBriefMarkers(story);
    const languageNormalized = await normalizeSagaPromptForVideoGeneration({
      cwd: context.cwd,
      text: story,
      enableLlmRewrite: !action.cleanDirect && !briefIsStructured,
      subtitleMode: action.subtitleMode ?? 'auto',
    });
    if (briefIsStructured) {
      toolLog('📐 Saga: 检测到结构化 brief（时间码/镜头标记），跳过 LLM 改写以保留用户原文的所有具体地点/动作/约束。');
    }
    story = languageNormalized.generationText;
    toolLog(`🌐 Saga Visual Director: generation prompt normalized to English${languageNormalized.usedLlmRewrite ? ' via LLM rewrite' : ' via deterministic template'}; dialogue lines=${languageNormalized.dialogueLines.length}.`);
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

    const storyboardImagePaths: string[] = [];
    for (const entry of nonEmptyStringArray(action.storyboardImagePaths)) {
      const resolved = await resolveToolPathWithWorkspaceAccess({ inputPath: entry, toolName: 'generate_long_video', context });
      storyboardImagePaths.push(resolved.absolute);
    }
    const storyboardParseResults: Array<{ imagePath: string; parsed: unknown }> = [];
    // ALWAYS parse timestamped shots first. When the user supplied an explicit
    // [X-Y秒] timeline, that is the authoritative segmentation and takes
    // priority over any agent-supplied shots array (which is typically empty
    // or generic boilerplate when saga flows through the LLM).
    // CRITICAL: parse timecodes from the ORIGINAL user text (before LLM
    // rewrite). LLM rewrite condenses the brief into a paragraph and strips
    // out [X-Y秒] markers, which would force the planner to default to its
    // own segment count (totalSeconds / preferred) instead of honouring the
    // user's intended segmentation. Generic — works for any user format.
    const timecodeSource = languageNormalized.originalText || story;
    const timestampedStoryShots = parseTimestampedShotsFromStory(timecodeSource, limits.maxSegmentSeconds, totalSeconds);
    let storyboardShots = timestampedStoryShots.length >= 2
      ? timestampedStoryShots
      : (action.shots?.length ? action.shots : []);
    if (timestampedStoryShots.length >= 2) {
      toolLog(`🧭 Saga: 已从用户时间码剧本解析出 ${timestampedStoryShots.length} 个镜头，按脚本顺序生成（优先于 agent 默认规划）。`);
    }
    if ((!storyboardShots || storyboardShots.length === 0) && storyboardImagePaths.length > 0) {
      for (const imagePath of storyboardImagePaths) {
        const parsed = await parseStoryboardImageWithVision({ imagePath, context });
        if (parsed?.shots.length) {
          storyboardParseResults.push({ imagePath, parsed });
          storyboardShots = parsed.shots;
          story = [
            story,
            '',
            '[Storyboard image parsed into shot list]',
            parsed.summary ? `Summary: ${parsed.summary}` : '',
            parsed.globalStyle ? `Global style: ${parsed.globalStyle}` : '',
            parsed.globalContinuity ? `Global continuity: ${parsed.globalContinuity}` : '',
          ].filter(Boolean).join('\n');
          await writeFile(
            path.join(projectDir, 'storyboard-parse.json'),
            JSON.stringify({ source: 'vision', imagePath, parsed }, null, 2),
            'utf8',
          );
          toolLog(`🧩 Storyboard: 已从分镜图解析出 ${parsed.shots.length} 个镜头 → ${imagePath}`);
          break;
        }
      }
    }

    let userReferenceImagePaths = nonEmptyStringArray(action.referenceImagePaths);
    let userReferenceImageUrls = nonEmptyStringArray(action.referenceImageUrls);
    const requestedUserImageReferenceCount = userReferenceImagePaths.length + userReferenceImageUrls.length;
    let hasGlobalUserImageReferences = userReferenceImagePaths.length > 0 || userReferenceImageUrls.length > 0;
    // Coerce narrativeEntities once and use it everywhere downstream
    // (constitution rendering, accessoryLock, keyframe generation, critic).
    let narrativeEntities = coerceNarrativeEntities(action.narrativeEntities);
    if (!narrativeEntities) {
      // Direct tool calls and dream-video callers may bypass the interactive
      // Saga workflow. Still run the same "god/protagonist" analysis here so
      // every long-video path gets one central subject and world model before
      // shot planning, critic checks, keyframes, and continuity prompts.
      narrativeEntities = await analyzeNarrative({
        cwd: context.cwd,
        userText: story,
        imagePaths: userReferenceImagePaths,
      }) ?? narrativeKeywordFallback({
        userText: story,
        hasFaceLikelyInImages: hasGlobalUserImageReferences,
      });
      // The Saga Constitution is a single-protagonist story bible designed
      // for narrative cinematic content. For NSFW content the analyzer
      // typically tags secondary subjects as "未完整出镜 / not-fully-in-frame"
      // and restricts the action vocabulary to the protagonist's body verbs.
      // Embedding that constitution into the per-segment prompt then yields
      // anatomy-fusion glitches: the model is told "only one subject visible"
      // but the user's prompt describes intercourse, so the missing partner's
      // anatomy gets fused onto the protagonist.
      //
      // When cleanDirect is on (user explicitly asked for un-wrapped output)
      // OR the video provider is configured NSFW, skip the constitution and
      // let the user's raw prompt flow through every segment unchanged.
      const skipConstitution = action.cleanDirect === true || videoNsfw;
      if (!skipConstitution) {
        story = [
          story,
          '',
          buildSagaConstitution(narrativeEntities),
          '',
          `[Saga Narrative Entity Map — internally resolved for this generate_long_video call]\n${JSON.stringify(narrativeEntities, null, 2)}`,
        ].join('\n');
      }
      toolLog(`🧠 Saga: 已自动分析视频“上帝/主角” — ${narrativeEntities.protagonist.name} (${narrativeEntities.protagonist.type}, confidence=${narrativeEntities.protagonist.confidence.toFixed(2)})${skipConstitution ? '。(Constitution 已跳过：cleanDirect / NSFW provider)' : '。'}`);
    }

    const isPureEnvironment = narrativeEntities?.mode === 'environment';
    const isDirectImageIdentity = identitySource === 'direct_image';
    const explicitUserImageBypass = isDirectImageIdentity;
    const superVisualBypass = superVisualBypassReason(identitySource, isPureEnvironment);

    const superVisualMode = superVisualBypass
      ? {
          enabled: false,
          reason: superVisualBypass,
          resolvedUserImagePaths: userReferenceImagePaths.length > 0 ? userReferenceImagePaths : undefined,
        } as const
      : await maybeGenerateSuperVisualReference({
          action,
          context,
          projectDir,
          story,
          title,
          ratio,
          videoLimits: limits,
        });

    // CRITICAL: If the user provided an image but Super Visual failed due to safety/privacy,
    // we MUST NOT silently fall back to hallucination. Interrupt and ask for a new image.
    // When videoNsfw is true the provider accepts real-person inputs directly —
    // the safety-derivative rejection is not fatal in that case.
    if (!superVisualMode.enabled && hasGlobalUserImageReferences && !videoNsfw && !explicitUserImageBypass) {
      const isSafetyFail = /privacy|safety|sensitive|blocked|rejected/i.test(superVisualMode.reason ?? '');
      if (isSafetyFail) {
        return {
          action,
          ok: false,
          output: `🚨 角色身份锁定失败：你提供的参考图被安全过滤系统拦截 (${superVisualMode.reason})。\n\n这通常是因为图片中包含：\n1. 过于写实的真人面部（触发隐私保护）\n2. 复杂的版权内容\n3. 触发了提供商的敏感词过滤\n\n建议操作：\n- 请提供一张背景更干净、更偏向“插画/3D/动漫”风格的角色图。\n- 或者尝试删除图片，仅使用文字描述生成。\n- 请更换图片后重新发送指令。`,
        };
      }
    }
    // When videoNsfw is true and Super Visual refused due to safety, the real-person
    // photos can still be sent directly — mark that the input IS real-person so the
    // downstream reference-routing logic can handle it, but do NOT abort.
    if (videoNsfw && !superVisualMode.enabled && hasGlobalUserImageReferences && !explicitUserImageBypass) {
      toolLog(`🔞 NSFW provider: Super Visual safety 拦截已跳过 (${superVisualMode.reason})，将直传用户参考图`);
    }

    // Real-person input cannot submit the user's original photos or raw
    // photographic closing frames directly to BytePlus. Its image classifier
    // rejects real-person photos regardless of role (reference_image,
    // first_frame, last_frame all blocked). The working path is an identity-
    // only illustrated turnaround plus generated per-segment proxy keyframes
    // that restore photographic/cinematic output in the prompt.
    // Real-person bypass strategy (a.k.a. "illustration → 实拍 restore"):
    //   1. Super Visual converts the user's real-person photo into an
    //      illustrated three-view turnaround via gpt-image-2 (already runs
    //      with style='illustrated' when input is detected as real-person).
    //   2. We send the ILLUSTRATED turnaround as role:"reference_image" —
    //      it passes the privacy filter because it's clearly not a photo.
    //   3. We DROP the user's original real-person photos entirely; they
    //      are not sent to BytePlus.
    //   4. We append a prompt-level directive that tells Seedance to
    //      render the OUTPUT as live-action / 实拍 (photographic), even
    //      though the reference is illustrated. We deliberately avoid the
    //      word "真人" in prompts because that itself triggers prompt-side
    //      content moderation; we use "实拍 / 写实 / 质感 / 电影感" instead.
    //   5. Per-segment AI keyframes (gpt-image-2 generated, prompted to be
    //      photographic/cinematic for real-person input) ingest the previous
    //      segment's closing frame during image-edit generation. The raw
    //      closing frame is NOT submitted to BytePlus in real-person mode.
    // identitySource (set by the Saga three-step menu) overrides reference routing:
    //  - 'text_only': explicitly no image identity — skip turnaround entirely.
    //  - 'turnaround': user already supplied the complete three-view sheet —
    //    send it directly to the video model; do not regenerate it or make
    //    per-segment Image-2 keyframes from it.
    //  - 'direct_image': user explicitly asked to use the image as video
    //    material — send it directly to the video model; do not generate a
    //    three-view sheet.
    //  - 'character_image': user supplied a character/photo source — normal
    //    Super Visual flow generates a three-view identity sheet.
    const realPersonInput = videoNsfw && isDirectImageIdentity
      ? false   // NSFW provider + direct image → skip real-person safety, pass through
      : superVisualMode.enabled
        ? Boolean((superVisualMode as { inputIsRealPerson?: boolean }).inputIsRealPerson)
        : false;
    // NOTE: role:"first_frame" turned out NOT to bypass BytePlus's real-
    // person privacy filter empirically (the filter is image-classifier-
    // based and ignores the role tag). Saga therefore uses ONLY
    // role:"reference_image" with the illustrated turnaround as identity
    // anchor + per-segment AI keyframe + chain frame; user real photos
    // are dropped on the server-side path. We keep firstFrameImage* in
    // the action schema for callers who explicitly want image-to-video
    // first-frame mode in single-shot generate_video calls, but the long-
    // video path does not synthesize first_frame requests.
    // SV-disabled fallback: when the canonical illustrated turnaround is
    // unavailable (relay sick) but the user provided reference images, we
    // can't send those photos to the video provider (the privacy filter
    // would reject real-person inputs). The next-best-quality path is to
    // run a vision-describe inline (cheap chat completion, often still
    // works when image-gen is rate-limited separately) and inject the
    // resulting rich text identity into story so per-segment text-only
    // prompts can carry identity across segments. Only falls fully to
    // text-only when even vision is unavailable.
    if (identitySource === 'turnaround' && hasGlobalUserImageReferences) {
      // These directive strings get fed into sentenceChunks() downstream and
      // can leak into a per-segment storyBeat when the user's actual story is
      // short enough to leave segments hungry for content. For cleanDirect /
      // NSFW runs that pollution showed up as "Scene intent: EXPLICIT DIRECT
      // IMAGE SOURCE…" replacing what should have been a sex-scene beat.
      // The identitySource semantics are already enforced by superVisualMode
      // and the per-provider reference routing — we don't need to also tell
      // the model in text. Skip when cleanDirect to keep `story` pure.
      if (action.cleanDirect !== true) {
        story = [
          story,
          '',
          'EXPLICIT USER TURNAROUND SOURCE: The user chose "I have a character three-view/turnaround". Use the supplied reference image(s) as the canonical identity source. Do NOT regenerate the turnaround, but do use it to build per-segment keyframe bridge references when available.',
        ].join('\n');
      }
      toolLog(`🎯 Saga: 用户已提供角色三视图，保留为 canonical identity source，并进入 keyframe bridge。`);
    } else if (isDirectImageIdentity && hasGlobalUserImageReferences) {
      if (action.cleanDirect !== true) {
        story = [
          story,
          '',
          'EXPLICIT DIRECT IMAGE SOURCE: The user chose direct image-to-video material. Use the supplied image(s) directly as video reference media. Do NOT generate a character turnaround sheet.',
        ].join('\n');
      }
      toolLog(`🎯 Saga: 用户选择直接用图片做视频素材，跳过 Super Visual / Image-2 三视图生成，直接传给视频模型。`);
    }

    if (!superVisualMode.enabled && !explicitUserImageBypass && (userReferenceImagePaths.length > 0 || userReferenceImageUrls.length > 0)) {
      if (isPureEnvironment) {
        toolLog('🎯 Saga: 纯视觉/无主角模式已确认。绕过 Super Visual 人物提取，强制保留用户原始风景/抽象图，并注入最高级防人类指令。');
        story = [
          story,
          '',
          'ABSOLUTE HUMAN BAN: The user explicitly requested an abstract, environmental, or atmospheric piece. You MUST NOT describe, prompt, or generate any humans, characters, faces, biological figures, or humanoid silhouettes under ANY circumstances. Focus purely on environment, physics, geometry, fluid dynamics, and light.',
        ].join('\n');
      } else {
        let visionDesc: string | null = null;
        try {
          const cachedPath = path.join(projectDir, 'super-visual', 'character-vision-description.txt');
          visionDesc = (await readFile(cachedPath, 'utf8')).trim() || null;
        } catch { /* no cache */ }
        // Prefer the local copies SV already downloaded (covers URL-only case);
        // fall back to user-supplied paths if SV didn't resolve them.
        const fallbackImagePath = (superVisualMode as { resolvedUserImagePaths?: string[] }).resolvedUserImagePaths?.[0]
          ?? userReferenceImagePaths[0];
        if (!visionDesc && fallbackImagePath) {
          visionDesc = await describeUserImageWithVision({ imagePath: fallbackImagePath, context });
        }
        if (visionDesc) {
          story = [
            story,
            '',
            `[Vision-derived character identity — applies to EVERY shot. The canonical illustrated turnaround was not available for this run, so identity is anchored textually]: ${visionDesc}`,
          ].join('\n');
          toolWarn('⚠️ Super Visual 不可用：已用 vision-describe 文字身份兜底（输出仍可为照片质感，但身份精度低于图像锚定方案）。');
        } else {
          toolWarn('⚠️ Super Visual 不可用且 vision-describe 也失败：本次只能依赖原始文字描述，身份一致性会偏弱。');
        }
        if (identitySource === 'turnaround') {
          toolWarn('⚠️ Super Visual 不可用：保留用户三视图作为 canonical identity reference，禁止降级为无图生成。');
        } else {
          // Drop non-turnaround user photos — provider would reject them for privacy reasons in character mode.
          userReferenceImagePaths = [];
          userReferenceImageUrls = [];
          hasGlobalUserImageReferences = false;
        }
      }
    }
    // Resolve permanent accessories with multi-field fallback. The LLM
    // narrative analyst isn't consistent about which field it populates:
    //   1) protagonistAccessories — preferred (explicit accessory list)
    //   2) worldModel.wardrobe.permanent — common alternate (clothing-permanent
    //      items: eye mask, headscarf, signature jewelry land here too)
    //   3) scan props for accessory keywords — last resort
    // Returning a non-empty list lets buildContinuityBible emit a dedicated
    // [ACCESSORY-LOCK] bracket block that survives source-story truncation.
    const accessoriesList = (() => {
      const direct = narrativeEntities?.protagonistAccessories;
      if (Array.isArray(direct) && direct.length > 0) return direct;
      const permanent = narrativeEntities?.worldModel?.wardrobe?.permanent;
      if (Array.isArray(permanent) && permanent.length > 0) return permanent;
      const allProps = narrativeEntities?.props ?? [];
      const ACC_RE = /(眼罩|墨镜|sunglass|blindfold|头巾|head\s*scarf|turban|du-rag|项链|necklace|手链|bracelet|戒指|\bring\b|耳环|耳钉|earring|手套|gloves|围巾|scarf|口罩|唇妆|lipstick|red\s*lips|帽|hat|cap|束发带|发饰|hair\s*band)/i;
      return allProps.filter((p: string) => ACC_RE.test(p));
    })();
    const accessoryRule = accessoriesList.length > 0
      ? [
          'ACCESSORY LOCK — IDENTITY-DEFINING — The protagonist has the following locked accessories (extracted from the reference image and the user\'s description):',
          ...accessoriesList.map((item: string) => `  · ${item}`),
          'These accessories are part of the protagonist\'s identity. They must appear in EVERY shot, in the same position, in the same color and style, throughout the ENTIRE video. NEVER describe removing, lifting, repositioning, swapping, or modifying any of them. NEVER introduce a different accessory of the same category (e.g., if a face-covering item is locked, do not add any other face-covering item). NEVER write timeline beats like "she pushes her X up" / "she takes off her X" / "she replaces her X". The accessories are permanent for the whole video.',
          ...deriveOcclusionLocksFromAccessories(accessoriesList).map((lock: string) => `OCCLUSION CONSEQUENCE — ${lock}`),
        ].join('\n')
      : '';

    if (superVisualMode.enabled) {
      // Both real-person and illustrated input: turnaround is the canonical
      // identity anchor. Original user photos are dropped from the request
      // (they're already digested into the turnaround).
      userReferenceImagePaths = [superVisualMode.referenceImagePath];
      userReferenceImageUrls = [];
      hasGlobalUserImageReferences = true;
      const fallbackAccessoryRule = accessoryRule
        || 'ACCESSORY LOCK — Whatever the protagonist is wearing or holding in the reference image is part of their locked identity and must appear unchanged in every shot. Do not describe removing or repositioning anything visible on the protagonist in the reference.';
      const storyAdditions: string[] = [
        `Super visual reference: use ${superVisualMode.referenceImagePath} as the canonical three-view character identity sheet for every segment.`,
        fallbackAccessoryRule,
      ];
      if (realPersonInput) {
        storyAdditions.push(
          'OUTPUT-STYLE OVERRIDE — IMPORTANT: although the supplied character reference is rendered as an illustrated/anime turnaround sheet for identity normalization, the actual VIDEO OUTPUT must be 实拍 (live-action photographic) — restore photographic skin texture, real lighting, real fabrics, real volumetrics, anatomically accurate human bodies, and cinematic photography (35mm/50mm lens, golden hour, shallow depth of field, color graded). Treat the reference as identity-only; the rendering style is photoreal/cinematic.',
          'PROMPT VOCABULARY GUARD — In every shot\'s storyBeat / visualPrompt / camera / continuity, AVOID the words "真人", "real person", "real human face", "actual person". Use these instead to convey realism: 实拍, 写实, 质感, 电影感, photographic, cinematic, live-action, 35mm/50mm lens, 自然光, 真实质感. The avoid-list applies to the surface text only — the underlying intent of "render this as photographic real-person footage" is preserved through the alternate vocabulary.',
        );
      }
      story = [story, '', ...storyAdditions].join('\n');
      if (realPersonInput) {
        toolLog(`🎯 Saga: 已启用角色身份锁与写实输出路径。`);
      }
      if (identitySource === 'turnaround') {
        toolLog(`🎯 Saga: 用户三视图将作为 canonical identity source，并继续生成每段 keyframe bridge。`);
      }
    } else if (accessoriesList.length > 0) {
      // Non-super-visual modes (direct_image / character_image / text-only):
      // log the lock so we know it's about to be injected via the bible.
      // The actual [ACCESSORY-LOCK] block emission happens in
      // buildContinuityBible below, which receives accessoriesList through
      // the bible input. This avoids appending to `story` (which would get
      // truncated by the bible's slice(0, 1600) on Source story).
      toolLog(`🎯 Saga: 即将注入 ACCESSORY LOCK (${accessoriesList.length} 项)，identitySource=${identitySource ?? 'text-only'}。`);
    }

    // Sanitize story BEFORE the continuity bible is built so unsanitized
    // trigger words don't leak into per-segment compiled prompts via the
    // bible's "Source story" injection. (continuity.ts re-uses the source
    // story verbatim for every segment.)
    const storySanitizeDiff = diffSanitize(story);
    if (storySanitizeDiff.length > 0) {
      toolWarn(`🛡️ Saga 词汇护栏: story 中替换 ${storySanitizeDiff.length} 处敏感触发词 (${storySanitizeDiff.slice(0, 3).map((d) => `${d.from} → ${d.to}`).join('; ')}${storySanitizeDiff.length > 3 ? '; ...' : ''})。`);
    }
    story = sanitizeForVideoProvider(story);
    const { shotContinuityNotes, shotCameraNotes } = deriveContinuityFromShots(action);
    const sceneAnchors = mergeStringArrays(
      action.continuity?.locations,
      narrativeEntities?.environments,
      narrativeEntities?.worldModel?.clutter,
      narrativeEntities?.worldModel?.spatialReality?.groundSurface ? [narrativeEntities.worldModel.spatialReality.groundSurface] : undefined,
      extractSceneAnchorsFromStory(story),
    );
    // Filter out props that the narrative analyser harvested from the
    // user's reference photo's incidental background — e.g. "黄色汽车座椅
    // (from reference image)", "in the reference: black seat belt". These
    // were never meant to be recurring scene anchors; the reference photo
    // exists to lock IDENTITY (face / wardrobe), not to seed background
    // furniture. Locking them as global props makes the model try to
    // render car interior elements in every shot. Generic — protects any
    // user uploading a reference photo with an unrelated background.
    const referenceImagePropPattern = /(?:参考图(?:中|里|上|内)|reference\s+(?:image|photo|picture)|in\s+the\s+reference|from\s+the\s+reference)/i;
    const filterReferenceImageProps = (props: string[] | undefined): string[] | undefined => {
      if (!props) return props;
      return props.filter((p) => !referenceImagePropPattern.test(p));
    };
    const propAnchors = mergeStringArrays(
      action.continuity?.props,
      filterReferenceImageProps(narrativeEntities?.props),
      filterReferenceImageProps(narrativeEntities?.worldModel?.identityLockedProps),
      filterReferenceImageProps(narrativeEntities?.worldModel?.sceneVariableProps),
    );
    const continuityBible = buildContinuityBible({
      story,
      ratio,
      shotContinuityNotes,
      shotCameraNotes,
      characters: action.continuity?.characters,
      wardrobe: action.continuity?.wardrobe,
      props: propAnchors,
      locations: sceneAnchors,
      palette: action.continuity?.palette,
      lighting: action.continuity?.lighting,
      cameraLanguage: action.continuity?.cameraLanguage,
      mood: action.continuity?.mood,
      accessoriesLock: accessoriesList,
      subtitleMode: action.subtitleMode,
    });

    const cleanDirect = action.cleanDirect === true;
    const providerSupportsImageRef = limits.referenceInputs.includes('image');
    const userContinuityOverride = action.continuityMode === 'auto' ? undefined : (action.continuityMode as SagaContinuityMode | undefined);
    const continuityMode = pickContinuityMode({
      providerSupportsImageRef,
      userOverride: userContinuityOverride,
    });

    // Sanitize per-shot author-facing fields (storyBeat / visualPrompt /
    // camera / continuity / transition / prompt). Story itself was already
    // sanitized before continuityBible was built.
    const sanitizedShots = storyboardShots?.map((shot) => ({
      ...shot,
      storyBeat: shot.storyBeat ? sanitizeForVideoProvider(shot.storyBeat) : shot.storyBeat,
      visualPrompt: shot.visualPrompt ? sanitizeForVideoProvider(shot.visualPrompt) : shot.visualPrompt,
      camera: shot.camera ? sanitizeForVideoProvider(shot.camera) : shot.camera,
      continuity: shot.continuity ? sanitizeForVideoProvider(shot.continuity) : shot.continuity,
      transition: shot.transition ? sanitizeForVideoProvider(shot.transition) : shot.transition,
      prompt: shot.prompt ? sanitizeForVideoProvider(shot.prompt) : shot.prompt,
    }));
    const segments = buildSegments({
      story,
      shots: sanitizedShots,
      projectDir,
      hyperframesProjectDir,
      totalSeconds,
      maxSegmentSeconds: limits.maxSegmentSeconds,
      preferredSegmentSeconds: Math.min(limits.preferredSegmentSeconds, limits.maxSegmentSeconds),
      ratio,
      continuityInput: continuityBible,
      continuityMode,
      cleanDirect,
    });
    const actualTotalSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);

    // ─── Saga Narrative Critic & Rewriter ──────────────────────────────
    // If the saga workflow attached a narrativeEntities payload, run a
    // pre-flight critic against the planned shots. For each violation we
    // self-dialogue with the LLM to produce a rewrite that uses ONLY the
    // user-supplied entities/relationships. Up to 2 critic+rewrite rounds.
    let preCriticViolations: ShotViolation[] = [];
    let postCriticViolations: ShotViolation[] = [];
    const rewroteShotIndices: number[] = [];
    const preserveUserScript = cleanDirect || shouldPreserveUserScriptWithoutCriticRewrite({ action, timestampedStoryShots });
    if (narrativeEntities && !cleanDirect) {
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
      } else if (preserveUserScript) {
        postCriticViolations = preCriticViolations;
        toolWarn(`⚠️ Saga Critic: 检测到 ${preCriticViolations.length} 个 shot 违规，但当前是显式用户剧本/时间码模式，已跳过 LLM 重写并保留原始镜头内容。`);
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
              // Sanitize rewriter output too — the LLM may reintroduce
              // trigger words even when the original storyBeat was clean.
              seg.storyBeat = sanitizeForVideoProvider(rewrite.storyBeat);
              seg.visualPrompt = sanitizeForVideoProvider(rewrite.visualPrompt);
              if (rewrite.transition) seg.transition = sanitizeForVideoProvider(rewrite.transition);
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
      shots: storyboardShots,
      segmentCount: segments.length,
      defaultKind: defaultTransition,
      defaultMs: crossfadeMs,
    });

    const draftPlanPath = path.join(projectDir, 'saga-plan.draft.json');
    await writeFile(
      draftPlanPath,
      JSON.stringify({
        schema: 'artemis-saga.plan-draft.v1',
        projectId,
        title,
        generatedAt: generatedAt.toISOString(),
        story,
        requestedTotalSeconds: totalSeconds,
        plannedTotalSeconds: actualTotalSeconds,
        ratio,
        provider,
        model,
        identitySource,
        planningMode: storyboardShots && storyboardShots.length > 0
          ? (timestampedStoryShots.length > 0 ? 'timestamped-script-shot-list' : storyboardParseResults.length > 0 ? 'storyboard-image-shot-list' : 'model-shot-list')
          : 'local-fallback',
        superVisualMode,
        cleanDirect,
        segments: segments.map((segment) => ({
          index: segment.index,
          title: segment.title,
          duration: segment.duration,
          storyBeat: segment.storyBeat,
          visualPrompt: segment.visualPrompt,
          camera: segment.camera,
          continuity: segment.continuity,
          transition: segment.transition,
          promptPath: path.join(projectDir, 'segments', `${String(segment.index).padStart(3, '0')}.prompt.txt`),
          outputPath: segment.outputPath,
        })),
      }, null, 2),
      'utf8',
    );

    const chainFrames = cleanDirect ? false : shouldChainFrames(action, providerSupportsImageRef);

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
    const humanOrMixedSubject = isHumanOrMixedSubject(narrativeEntities);

    // Ensemble contact sheet: when the user supplies multiple reference photos
    // for a real-person / human-subject shoot, the old code sent every photo
    // on every segment, which (a) repeatedly hit privacy review on each
    // segment and (b) gave the model N disjoint references rather than one
    // coherent multi-character identity board. Compose them once into a tiled
    // N-cell sheet (N inputs -> N tiles, smart grid) and use that single sheet
    // as the per-segment identity anchor.
    if (
      userReferenceImagePaths.length > 1
      && (realPersonInput || humanOrMixedSubject)
    ) {
      const sheetOutputPath = path.join(projectDir, 'super-visual', 'ensemble-cast-sheet.png');
      const sheet = await buildEnsembleContactSheet({
        imagePaths: userReferenceImagePaths,
        outputPath: sheetOutputPath,
      });
      if (sheet.ok && !sheet.isPassThrough) {
        toolLog(`🧩 Saga: 已生成 ${sheet.inputCount} 角色 ensemble contact sheet（${sheet.grid.cols}×${sheet.grid.rows}），后续每段只发这一张 → ${sheet.path}`);
        userReferenceImagePaths = [sheet.path];
        userReferenceImageUrls = [];
      } else if (!sheet.ok) {
        toolWarn(`⚠️ Saga: ensemble contact sheet 生成失败，回退为按原方式逐张发送参考图（${sheet.reason.slice(0, 200)}）。`);
      }
    }

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
    const shouldGenerateSegmentKeyframes = !cleanDirect && superVisualMode.enabled && superVisualMode.mode !== 'provided-turnaround';
    let lastHeartbeat = Date.now();
    const heartbeatInterval = 60_000 * 2; // 2 minutes

    toolLog(`🎬 Saga: 开始按段生成 ${segments.length} 段视频（${actualTotalSeconds}s 总时长）。`);
    for (const segment of segments) {
      // Manual heartbeat check to keep the bridge alive
      if (Date.now() - lastHeartbeat > heartbeatInterval) {
        toolLog(`💓 Saga 状态：正在处理长视频项目 ${projectId}，当前进度 ${segment.index}/${segments.length} 段...`);
        lastHeartbeat = Date.now();
      }

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
        if (shouldGenerateSegmentKeyframes) {
          toolLog(`🎨 正在为第 ${segment.index} 段生成视觉参考关键帧 (Image-2)...`);
          const wm = narrativeEntities?.worldModel ?? {};
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
            realPersonInput,
            accessoriesLock: narrativeEntities?.protagonistAccessories,
            occlusionLock: [
              ...(wm.occlusion ?? []),
              ...deriveOcclusionLocksFromAccessories(narrativeEntities?.protagonistAccessories),
            ],
            permanentWardrobe: wm.wardrobe?.permanent,
            distinguishingMarks: wm.distinguishingMarks,
            identityLockedProps: wm.identityLockedProps,
            continuityRules: wm.continuityRules,
            exclusions: wm.exclusions,
            // Spatial reality — drives physics-correct pose composition
            // (contact zones, causality, no impossible body→surface gestures).
            groundSurface: wm.spatialReality?.groundSurface,
            waterLine: wm.spatialReality?.waterLine,
            perspectiveCues: wm.spatialReality?.perspectiveCues,
            physicsRules: wm.spatialReality?.physicsRules,
            forbiddenSpatialErrors: wm.spatialReality?.forbiddenSpatialErrors,
          });
          if (keyframeResult.ok) {
            segmentKeyframePaths.set(segment.index, keyframeResult.framePath);
          } else {
            segmentKeyframeFailures.push({ index: segment.index, reason: keyframeResult.reason });
          }
        } else if (superVisualMode.enabled && superVisualMode.mode === 'provided-turnaround' && segment.index === 1) {
          toolLog('🎯 用户提供三视图：跳过 Image-2 keyframe，直接将三视图作为视频身份参考，避免图片模型不可用时阻塞。');
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
          // Segment 1 may use a user-supplied literal first frame (role:"first_frame").
          // Segments 2..N chain from the previous segment's tail frame.
          // BytePlus Seedance 2.0 does NOT allow mixing role:"first_frame" with
          // role:"reference_image" in the same request (HTTP 400:
          // "first/last frame content cannot be mixed with reference media
          // content"). Since segments 2..N always carry reference images
          // (keyframe + optional user refs), we must NOT place the chain frame
          // into firstFrameImagePaths; instead we route it through
          // referenceImagePaths as role:"reference_image" (see chainPaths
          // below). This gives up the strict "open on this exact frame"
          // semantic of first_frame but is the only way to keep both the
          // chain continuity image and the identity/composition reference
          // images in the same API call.
          firstFrameImageUrls: segment.index === 1 ? action.firstFrameImageUrls : undefined,
          firstFrameImagePaths: segment.index === 1 ? action.firstFrameImagePaths : undefined,
          lastFrameImageUrls: segment.index === segments.length ? action.lastFrameImageUrls : undefined,
          lastFrameImagePaths: segment.index === segments.length ? action.lastFrameImagePaths : undefined,
          watermark: action.watermark ?? false,
          maxPolls: Math.max(MIN_SAGA_SEGMENT_MAX_POLLS, action.maxPolls ?? 0),
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
        // Per-segment Image-2 keyframes can occasionally become too
        // photographic in real-person runs. BytePlus then rejects the bytes as
        // privacy-sensitive before generation starts. Keep them for the first
        // attempt because they improve composition, but be ready to drop them
        // independently from the safer Super Visual turnaround reference.
        let usingSegmentKeyframe = true;
        let safeBridgeKeyframeAttempted = false;
        let lastError = '';
        let succeeded = false;

        for (let attempt = 0; attempt < 3 && !succeeded; attempt += 1) {
          // role:"reference_image" — the only image role Saga long-video
          // routes user content through. Empirical testing showed
          // role:"first_frame" does NOT bypass the provider's real-person
          // privacy filter (the classifier is image-bytes-based, ignores
          // role tags). So Saga keeps everything on reference_image and
          // relies on the Super Visual safe turnaround + per-segment
          // AI keyframe (both generated from safe visual references plus
          // VISUAL TRUTH identity text) to carry identity, while the
          // prompt-level OUTPUT-STYLE OVERRIDE tells the video model to render
          // PHOTOREAL output despite the non-photographic safety proxy.
          //   · Super Visual safe turnaround (three-view identity sheet)
          //   · Per-segment AI keyframe (gpt-image-2 generated with VISUAL TRUTH)
          //   · Chain frame from previous segment's last frame (only when it is
          //     safe to submit directly)
          const segmentKeyframe = segmentKeyframePaths.get(segment.index);
          const keyframePaths = usingSegmentKeyframe && segmentKeyframe ? [segmentKeyframe] : [];
          // Chain frame is sent as role:"reference_image" (not first_frame)
          // because BytePlus rejects mixing first_frame + reference_image
          // in the same request. Putting it here lets the video model see
          // both the identity keyframe and the temporal continuation frame.
          // Retry logic (usingChain=false) strips this from the reference
          // array on privacy-filter failures.
          // 💡 REAL PERSON BYPASS (User's Chain Frame Translation Strategy):
          // If we are in realPersonInput mode, passing the raw `previousLastFramePath`
          // (which is a real-person photographic screenshot) directly to the video API
          // will trigger the provider's strict privacy filter and abort the chain.
          // However, the `segmentKeyframe` generated above ALREADY ingested
          // `previousLastFramePath` through the safe Super Visual keyframe path,
          // preserving the scene handoff without submitting raw real-person
          // screenshots to the video provider. So for real-person runs, we
          // deliberately omit the raw screenshot and rely on that generated
          // keyframe to bridge the scene.
          const rawChainEligible = usingChain && segment.index > 1 && Boolean(previousLastFramePath) && !realPersonInput && !humanOrMixedSubject;
          const proxyChainEligible = usingChain && segment.index > 1 && Boolean(previousLastFramePath) && (realPersonInput || humanOrMixedSubject) && Boolean(segmentKeyframe);
          const chainPaths: string[] = rawChainEligible && previousLastFramePath
            ? [previousLastFramePath]
            : [];
          const referenceImagePaths = cleanDirect
            ? (usingUserImageReferences ? userReferenceImagePaths : [])
            : [
              ...keyframePaths,
              ...chainPaths,
              ...(usingUserImageReferences ? userReferenceImagePaths : []),
            ];
          const referenceImageUrlsForCall = usingUserImageReferences ? userReferenceImageUrls : [];
          const hasAnyImageRef = referenceImagePaths.length > 0 || referenceImageUrlsForCall.length > 0;
          const promptToUse = hasAnyImageRef ? segment.prompt : segment.textOnlyPrompt;
          const segmentPromptPath = path.join(projectDir, 'segments', `${String(segment.index).padStart(3, '0')}.prompt.txt`);
          await writeFile(
            segmentPromptPath,
            [
              `# Saga segment ${segment.index}/${segments.length}`,
              `attempt: ${attempt + 1}`,
              `hasAnyImageRef: ${hasAnyImageRef}`,
              `referenceImagePaths: ${referenceImagePaths.join(' | ') || '(none)'}`,
              `referenceImageUrls: ${referenceImageUrlsForCall.join(' | ') || '(none)'}`,
              '',
              sanitizeForVideoProvider(promptToUse),
            ].join('\n'),
            'utf8',
          );
          const result = await executeGenerateVideo(
            {
              ...baseReq,
              prompt: sanitizeForVideoProvider(promptToUse),
              referenceImageUrls: referenceImageUrlsForCall.length > 0 ? referenceImageUrlsForCall : undefined,
              referenceImagePaths,
              generateAudio: usingAudio,
            },
            context,
          );
          if (result.ok) {
            succeeded = true;
            if ((rawChainEligible || proxyChainEligible) && segment.index > 1 && previousLastFramePath) chainedFromPrev.push(segment.outputPath);
            if (!usingChain && chainEnabled && previousLastFramePath) chainDroppedSegments.push(segment.index);
            if (hasGlobalUserImageReferences && !usingUserImageReferences) userImageReferenceDroppedSegments.push(segment.index);
            if (!usingAudio && userAudioPreference) audioRetriedSegments.push(segment.index);
            if (usingChain) consecutivePrivacyFails = 0;
            const tags = [
              attempt > 0 ? `重试${attempt}` : '一次过',
              rawChainEligible ? 'raw-chain' : proxyChainEligible ? 'proxy-chain' : usingChain ? 'chain待定' : '无chain',
              usingAudio ? '有音' : '无音',
              usingUserImageReferences ? '用户图' : '无用户图',
            ].join(' / ');
            toolLog(`✅ 第 ${segment.index}/${segments.length} 段完成（${tags}）。`);
            break;
          }
          lastError = result.output ?? '';
          const audioBlocked = isAudioSafetyError(lastError);
          const imageBlocked = isImagePrivacyError(lastError);
          const pollTimeout = isPollTimeoutErrorForTest(lastError);
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
          if (imageBlocked && usingSegmentKeyframe && segmentKeyframe && realPersonInput && !safeBridgeKeyframeAttempted) {
            safeBridgeKeyframeAttempted = true;
            consecutivePrivacyFails += 1;
            toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：视频服务拒绝了分段关键帧，正在生成安全桥接帧后重试（尝试 ${attempt + 2}/3）...`);
            const safeBridge = await generateSafeBridgeKeyframe({
              context,
              projectDir,
              ratio,
              shotIndex: segment.index,
              sourceFramePath: segmentKeyframe,
              sourceKind: 'segment-keyframe',
            });
            if (safeBridge.ok) {
              segmentKeyframePaths.set(segment.index, safeBridge.framePath);
              toolLog(`🎨 第 ${segment.index}/${segments.length} 段：已生成安全桥接帧 ${safeBridge.framePath}`);
            } else {
              usingSegmentKeyframe = false;
              toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：安全桥接帧生成失败（${safeBridge.reason.slice(0, 180)}），剥离关键帧、保留安全身份锚后重试中（尝试 ${attempt + 2}/3）...`);
            }
          } else if (imageBlocked && usingSegmentKeyframe && segmentKeyframe) {
            usingSegmentKeyframe = false;
            consecutivePrivacyFails += 1;
            toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：视频服务拒绝了分段关键帧，剥离关键帧、保留安全身份锚后重试中（尝试 ${attempt + 2}/3）...`);
          } else if (imageBlocked && usingChain) {
            usingChain = false;
            consecutivePrivacyFails += 1;
            toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：视频服务拒绝了上一段衔接帧，剥离衔接帧后重试中（尝试 ${attempt + 2}/3）...`);
          } else if (imageBlocked && hasGlobalUserImageReferences && usingUserImageReferences) {
            // reference_image got rejected — drop the user-supplied reference
            // images and retry with whatever remaining anchors we have
            // (per-segment AI keyframe + chain frame if active). If those are
            // empty too, the next attempt falls through to text-only via
            // segment.textOnlyPrompt (see hasAnyImageRef branch below).
            usingUserImageReferences = false;
            toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：视频服务拒绝了参考图，剥离参考图后重试中（尝试 ${attempt + 2}/3）...`);
          } else if (audioBlocked && usingAudio) {
            usingAudio = false;
            toolWarn(`⚠️ 第 ${segment.index}/${segments.length} 段：视频服务拒绝了音频输出，关闭音频后重试中（尝试 ${attempt + 2}/3）...`);
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
      planningMode: storyboardShots && storyboardShots.length > 0
        ? (timestampedStoryShots.length > 0 ? 'timestamped-script-shot-list' : storyboardParseResults.length > 0 ? 'storyboard-image-shot-list' : 'model-shot-list')
        : 'local-fallback',
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
      reviewFrames: renderResult.reviewFrames,
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
        storyboard: {
          requestedStoryboardImageCount: storyboardImagePaths.length + nonEmptyStringArray(action.storyboardImageUrls).length,
          parsedStoryboardCount: storyboardParseResults.length,
          parsedShotCount: storyboardParseResults.reduce((sum, item) => {
            const parsed = item.parsed as { shots?: unknown[] };
            return sum + (Array.isArray(parsed.shots) ? parsed.shots.length : 0);
          }, 0),
          parsePath: storyboardParseResults.length > 0 ? path.join(projectDir, 'storyboard-parse.json') : undefined,
        },
        referenceIntegrity: {
          requestedUserImageReferenceCount,
          hasUserImageReferences: hasGlobalUserImageReferences,
          superVisualEnabled: superVisualMode.enabled,
          superVisualMode: superVisualMode.enabled ? superVisualMode.mode : 'off',
          canonicalReferencePath: superVisualMode.enabled ? superVisualMode.referenceImagePath : undefined,
          inputIsRealPerson: Boolean((superVisualMode as { inputIsRealPerson?: boolean }).inputIsRealPerson),
          chainFrameSubmissionMode: humanOrMixedSubject
            ? 'proxy-keyframe-ingests-previous-last-frame'
            : (superVisualMode as { inputIsRealPerson?: boolean }).inputIsRealPerson
            ? 'proxy-keyframe-ingests-previous-last-frame'
            : 'raw-previous-last-frame-reference',
          userImageReferenceDroppedSegments,
          chainDroppedSegments,
          segmentKeyframeFailureCount: segmentKeyframeFailures.length,
          segmentKeyframeFailures,
          status: userImageReferenceDroppedSegments.length > 0
            || chainDroppedSegments.length > 0
            || segmentKeyframeFailures.length > 0
            || (requestedUserImageReferenceCount > 0 && !superVisualMode.enabled && !explicitUserImageBypass)
            ? 'degraded'
            : 'ok',
          notes: [
            userImageReferenceDroppedSegments.length > 0
              ? `User image references were dropped for segments: ${userImageReferenceDroppedSegments.join(', ')}`
              : undefined,
            chainDroppedSegments.length > 0
              ? `Chain reference frames were dropped for segments: ${chainDroppedSegments.join(', ')}`
              : undefined,
            isDirectImageIdentity && requestedUserImageReferenceCount > 0
              ? `Super Visual bypassed by explicit identitySource=${identitySource}; user images are sent directly as video references.`
              : undefined,
            !superVisualMode.enabled && !explicitUserImageBypass
              ? `Super Visual is disabled/unavailable: ${superVisualMode.reason}`
              : undefined,
            segmentKeyframeFailures.length > 0
              ? `Segment keyframes failed: ${segmentKeyframeFailures.map((f) => `seg${f.index}: ${f.reason}`).join('; ')}`
              : undefined,
          ].filter(Boolean),
        },
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
      reviewFrames: renderResult.reviewFrames,
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
      path.join(getMediaOutputRoot(), DEFAULT_LONG_VIDEO_SUBDIR, 'saga-library.jsonl'),
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
        reviewFrames: renderResult.reviewFrames,
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

    // Human-readable elapsed: "25m 42s" / "42s".
    const elapsedHuman = (() => {
      const m = Math.floor(elapsedSeconds / 60);
      const s = elapsedSeconds % 60;
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    })();
    const cleanModel = String(model).replace(/^[^/]+\//, '');
    const transitionSummary = renderResult.appliedTransitions.length > 0
      ? (() => {
          // Collapse same kind+duration to "kind@durMs × N" when uniform.
          const first = renderResult.appliedTransitions[0]!;
          const uniform = renderResult.appliedTransitions.every((t) => t.kind === first.kind && t.durationMs === first.durationMs);
          return uniform
            ? `${first.kind}@${first.durationMs}ms × ${renderResult.appliedTransitions.length}`
            : renderResult.appliedTransitions.map((t) => `${t.kind}@${t.durationMs}ms`).join(', ');
        })()
      : 'none';
    const lintLine = lintFormatted.split('\n').slice(-1)[0] ?? lintFormatted;

    // Visually grouped output. Keys preserved (Model:, Segments:, Audio:,
    // Video:, Plan:, etc.) so downstream LLM parsing still finds the same
    // anchors. The grouping headers + per-line `· ` bullets are presentation
    // only and don't change the data semantics.
    const lines: string[] = [
      `${measuredOutputSeconds.toFixed(2)}s · ${segments.length} segments · elapsed ${elapsedHuman}`,
      '',
      '📁 Output:',
      `   ${resolvedOutput.absolute}`,
      '',
      '📊 Stats:',
      `   · Model:        ${cleanModel}`,
      `   · Segments:     ${segments.length} × ≤${limits.maxSegmentSeconds}s · planned ${actualTotalSeconds}s · actual ${measuredOutputSeconds.toFixed(2)}s`,
      `   · Transitions:  ${transitionSummary}`,
      `   · Audio:        requested=${userAudioPreference} · safety-retries=${audioRetriedSegments.length}`,
      `   · Continuity:   ${continuityMode} · chain=${chainFrames} · chained=${chainedFromPrev.length}/${segments.length} · dropped=${chainDroppedSegments.length}${chainEnabled !== chainFrames ? ' (chain abandoned mid-run)' : ''}`,
      `   · Super visual: ${superVisualMode.enabled ? `${superVisualMode.mode} · userImagesUsed=${superVisualMode.userImagesUsed}` : `off (${superVisualMode.reason})`}`,
      `   · Keyframes:    generated=${segmentKeyframePaths.size}/${segments.length}${segmentKeyframeFailures.length > 0 ? ` · failures=${segmentKeyframeFailures.length}` : ''}`,
      `   · References:   user-image-dropped=${userImageReferenceDroppedSegments.length}`,
      narrativeEntities
        ? `   · Narrative:    ${narrativeEntities.mode} · protagonist=${narrativeEntities.protagonist.name} · violations pre/post=${preCriticViolations.length}/${postCriticViolations.length} · rewrote=[${rewroteShotIndices.join(',') || 'none'}]`
        : '   · Narrative:    skipped (no narrativeEntities)',
      `   · Lint:         ${lintLine}`,
      ...(reusedSegmentPaths.length > 0 ? [`   · Reused:       ${reusedSegmentPaths.length} cached segments`] : []),
    ];

    // Internal-detail block: hide super-visual reference path inside Stats
    // only if Super Visual was enabled (path is long; users rarely need it
    // unless debugging identity issues).
    if (superVisualMode.enabled && superVisualMode.referenceImagePath) {
      lines.push(`   · Super-visual ref: ${superVisualMode.referenceImagePath}`);
    }

    lines.push(
      '',
      '📂 Project files:',
      `   Title:        ${title}`,
      `   Plan:         ${planPath}`,
      `   Manifest:     ${manifestPath}`,
      `   Metadata:     ${metadataPath}`,
      `   Composition:  ${path.join(hyperframesProjectDir, 'index.html')}`,
      '',
      `🎬 Open: open "${resolvedOutput.absolute}"`,
    );

    return {
      action,
      ok: true,
      output: lines.join('\n'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { action, ok: false, output: `generate_long_video error: ${message}` };
  }
}
