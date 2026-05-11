import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  describeVisualProvider,
  resolveConfiguredVisualProvider,
} from '../../utils/visualGenerationConfig.js';
import type { ToolExecutionContext } from '../types.js';
import { toolLog, toolWarn } from '../../utils/log.js';
import { createVisualProvider } from './providers/interface.js';

// Process-wide relay-health short-circuit. When the configured image relay
// returns persistent transient errors (HTTP 502/429 upstream_error) for both
// /images/edits and /images/generations, we mark it sick and skip Super
// Visual mode for `RELAY_SICK_COOLDOWN_MS` to avoid burning ~13 minutes per
// long-video run. Reset on daemon restart.
const RELAY_SICK_COOLDOWN_MS = 10 * 60 * 1000;
const IMAGE_EDIT_TOTAL_TIMEOUT_MS = 4 * 60 * 1000;
const SEGMENT_KEYFRAME_EDIT_TIMEOUT_MS = IMAGE_EDIT_TOTAL_TIMEOUT_MS + 15_000;
const IMAGE_EDIT_SINGLE_FILE_COMPRESS_THRESHOLD_BYTES = 6 * 1024 * 1024;
const IMAGE_EDIT_TOTAL_FORM_COMPRESS_THRESHOLD_BYTES = 10 * 1024 * 1024;
const IMAGE_EDIT_FORCED_COMPRESS_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024;
let relaySickUntil = 0;
function isRelaySick(): boolean { return Date.now() < relaySickUntil; }
function markRelaySick(reason: string): void {
  relaySickUntil = Date.now() + RELAY_SICK_COOLDOWN_MS;
  toolWarn(`⚠️ Super Visual: 标记 image relay 为 sick（10 分钟内跳过三视图生成）— 原因: ${reason.slice(0, 160)}`);
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
import type { VideoModelLimits } from './videoModelLimits.js';
import type { VideoReferenceKind } from './videoCapabilities.js';

// ─── Result types ─────────────────────────────────────────────────────────

export type SuperVisualModeResult =
  | {
      enabled: true;
      provider: string;
      model: string;
      referenceImagePath: string;
      promptPath: string;
      sourceAssetPath?: string;
      mode: 'provided-turnaround' | 'provided-turnaround-safe-derivative' | 'image-to-image' | 'text-to-image';
      userImagesUsed: number;
      reason: string;
      // True when the user's input image was detected as a real-person
      // photograph. Drives the Saga long-video pipeline to (a) request
      // the turnaround in stylized "illustrated" form so it passes the
      // downstream provider's privacy filter when sent as
      // role:"reference_image", and (b) inject the OUTPUT-STYLE OVERRIDE
      // / vocabulary-guard prompt directives that tell the video model
      // to render the actual output as 实拍 (live-action photographic)
      // even though the reference is illustrated.
      // (NOTE: empirical testing showed role:"first_frame" does NOT
      // bypass the privacy filter, so the long-video path no longer
      // routes any user images via first_frame.)
      inputIsRealPerson?: boolean;
      // When user supplied image URLs, we download them to local cache as
      // part of the SV setup. Exposed so SV-disabled fallback in
      // generateLongVideo can still vision-describe the user's image even
      // when the image-gen relay is unavailable.
      resolvedUserImagePaths?: string[];
    }
  | {
      enabled: false;
      reason: string;
      inputIsRealPerson?: boolean;
      resolvedUserImagePaths?: string[];
    };

export type SuperVisualEligibilityInput = {
  imageProvider?: string;
  imageModel?: string;
  videoReferenceInputs: readonly VideoReferenceKind[];
};

type SuperVisualActionInput = {
  story?: string;
  prompt?: string;
  title?: string;
  referenceNotes?: string[];
  referenceImagePaths?: string[];
  referenceImageUrls?: string[];
  continuity?: {
    characters?: string[];
    wardrobe?: string[];
    props?: string[];
    locations?: string[];
    palette?: string[];
    lighting?: string | string[];
    cameraLanguage?: string | string[];
    mood?: string | string[];
  };
  superVisualMode?: 'auto' | 'on' | 'off';
};

// ─── Eligibility ──────────────────────────────────────────────────────────

export function isOpenAIGptImage2(provider: string | undefined, model: string | undefined): boolean {
  return provider?.trim().toLowerCase() === 'openai' && (model ?? '').trim().toLowerCase().includes('gpt-image-2');
}

export function getSuperVisualModeIneligibilityReason(input: SuperVisualEligibilityInput): string | undefined {
  // Note: hasUserImageReference is intentionally NOT a skip condition.
  // User images become inputs to Image-2 image-to-image, not gate the
  // entire flow. Universal turnaround is the identity-lock entry point
  // regardless of whether the user supplied a reference photo.
  if (!isOpenAIGptImage2(input.imageProvider, input.imageModel)) {
    return 'OpenAI gpt-image-2 image generation is not configured';
  }
  if (!input.videoReferenceInputs.includes('image') || !input.videoReferenceInputs.includes('video')) {
    return 'video model does not support both image and video references';
  }
  return undefined;
}

export function isSuperVisualModeEligible(input: SuperVisualEligibilityInput): boolean {
  return getSuperVisualModeIneligibilityReason(input) === undefined;
}

// ─── Prompt building ──────────────────────────────────────────────────────

function compact(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function compactList(values: string | string[] | undefined): string {
  if (typeof values === 'string') return compact(values);
  return Array.isArray(values) ? values.map(compact).filter(Boolean).join(' | ') : '';
}

export function buildProvidedTurnaroundSafetyDerivativeStory(input: {
  story: string;
  visionDescription?: string | null;
  referenceNotes?: string[];
}): string {
  const visionTruth = compact(input.visionDescription ?? undefined);
  const referenceNotes = compactList(input.referenceNotes);
  const dynamicInventory = visionTruth
    ? [
        'DYNAMIC FEATURE INVENTORY (extracted from the actual supplied reference; this is the lock list for the derivative):',
        visionTruth,
      ].join('\n')
    : [
        'DYNAMIC FEATURE INVENTORY:',
        'Read the supplied image directly and build the lock list from what is actually visible. Do not use stock character defaults or examples from previous jobs.',
      ].join('\n');
  const notesBlock = referenceNotes
    ? [
        'USER REFERENCE NOTES (also authoritative when they describe the supplied reference):',
        referenceNotes,
      ].join('\n')
    : '';

  return [
    input.story,
    '',
    'IDENTITY-PRESERVING SAFETY DERIVATIVE: the input is already a complete reference/turnaround and is the non-negotiable source of truth. This is NOT a redesign task. Make a trace-like / rotoscope-like illustrated derivative of the SAME subject only so downstream video providers receive a non-photographic reference.',
    dynamicInventory,
    notesBlock,
    'Before drawing, internally extract and lock every visible identity-bearing feature from the supplied image: subject morphology/anatomy or product geometry, face/head structure if present, hair/fur/surface texture if present, body/build/proportions, silhouette, pose family, wardrobe/material layers, accessories, markings, logos/patterns, handheld or attached props, color palette, front/side/back differences, and any privacy/information orientation of props. Copy only features that are actually visible or explicitly supplied by the user.',
    'The output may change only the rendering medium from photoreal/photo-like to provider-safe illustrated reference-sheet art. Identity, geometry, outfit/surface materials, accessories, markings, proportions, palette, and prop semantics must remain as close to the input as the model can reproduce.',
    'Forbidden: changing the subject into a different person/object, changing age/build/species/product form, changing hairstyle/surface pattern, changing coverage/visibility of any mask/occluder, changing wardrobe/product design, changing color palette, removing visible accessories/markings/props, adding new identity-defining elements, adding text labels, adding extra subjects, or turning the reference sheet into an action scene.',
  ].filter(Boolean).join('\n');
}

// Fixed prompt framework — character turnaround sheet.
// The structural requirements (front/side/back full body, neutral background,
// no labels, etc) NEVER change. When the user supplies an input image, the
// identity-from-image instruction comes FIRST and the story is reduced to
// "setting context only" — Image-2 attends most strongly to the earliest
// instructions in the prompt, so identity must be at the top to win against
// any narrative wording in the story text.
export function buildSuperVisualCharacterTurnaroundPrompt(input: {
  title?: string;
  story: string;
  ratio: string;
  referenceNotes?: string[];
  continuity?: SuperVisualActionInput['continuity'];
  withUserImageInput?: boolean;
  // Vision-derived character description from the user's input image.
  // When present, it is injected as a "VISUAL TRUTH" block right after the
  // identity directive — giving the image generator a concrete textual
  // description so identity survives even when the relay's image
  // conditioning is weak.
  visionDescription?: string;
  // Style of the generated turnaround:
  //   'illustrated' (default) — stylized illustration / digital painting / anime.
  //     Pros: bypasses real-person content filters on downstream video providers.
  //     Cons: video output will look illustrated, not photoreal.
  //   'photoreal' — preserve the input image's photographic style.
  //     Pros: video output looks like a real person.
  //     Cons: downstream video providers' privacy filters frequently reject.
  //   'auto' — illustrated when input image looks photoreal (real human face),
  //     photoreal otherwise (already-illustrated input is preserved).
  style?: 'illustrated' | 'photoreal' | 'auto';
  // Whether the input image likely contains a real human face. Used by
  // 'auto' style to decide whether to stylize.
  inputLooksRealPerson?: boolean;
}): string {
  const continuity = input.continuity ?? {};

  if (input.withUserImageInput) {
    // IMAGE-DOMINANT MODE — minimal prompt, all weight on the input image.
    //
    // Story / project title / continuity bible are DELIBERATELY EXCLUDED
    // from this stage. Their job is later — when we generate per-segment
    // keyframes that need scene context. Here, we only need the character.
    //
    // The prompt is:
    //   1. ONE imperative line: "produce a 3-view turnaround of THIS exact
    //      character. The character is the input image."
    //   2. The vision-derived description (when available) as a concrete
    //      anchor for the textual side — describing the same character
    //      grounded in what is actually visible in the input.
    //   3. Output structural requirements (front/side/back, neutral bg,
    //      no labels) — non-negotiable, generic, no enumeration.
    //
    // Note that we explicitly tell the model to IGNORE banners, text,
    // logos, and decorative backgrounds — handles the common case where
    // the user uploads a poster/banner and only the character is canonical.

    const visionTruth = compact(input.visionDescription)
      ? [
          'VISUAL TRUTH (vision-described directly from the attached input image — describes the same character; the output must match these features):',
          compact(input.visionDescription),
          '',
        ].join('\n')
      : '';

    // Decide whether to stylize. 'auto' stylizes only when input is real-person
    // (the case where downstream video providers reject "real person" inputs).
    const styleMode = input.style ?? 'auto';
    const stylize = styleMode === 'illustrated'
      || (styleMode === 'auto' && (input.inputLooksRealPerson ?? false));
    const styleLine = stylize
      ? '- Render in a STYLIZED ILLUSTRATED LOOK (digital painting / anime / illustrated character art). The output is a CHARACTER REFERENCE SHEET, not a photograph; brushwork, line work, cel-shaded or painterly rendering preferred. Even if the input image is a photograph, the output must read as illustrated character art — never as a literal photo of a real person.'
      : '- Match the art style of the input image. If the input is photographic, the output must be photographic; if the input is illustrated, keep it illustrated. Do not invent a different art style.';

    return [
      'Generate a character turnaround reference sheet. The attached input image IS the character. Reproduce that exact character — same face, hair, body, wardrobe, accessories, color palette — across three full-body views.',
      '',
      visionTruth,
      'OUTPUT (fixed):',
      '- Three full-body views of the same character from the input: front view, side profile view, back view.',
      '- All three views must be the same person/being with identical features, outfit, and palette.',
      styleLine,
      '- Clean neutral studio background, even soft lighting, hands and feet fully visible, no cropping.',
      `- Aspect ratio: ${input.ratio}.`,
      '- No text, no labels, no captions, no watermark, no logo, no UI, no speech bubbles, no banner overlay, no title overlay.',
      '- IGNORE any decorative background, cosmic scene, banner, title text, or logo in the input image. Only the character is canonical; the rendered background must be a plain studio backdrop.',
    ].filter(Boolean).join('\n');
  }

  // TEXT-ONLY MODE — no user image attached to /images/edits, so identity
  // must be carried entirely through text. This branch is used in two
  // scenarios:
  //   (a) The user never supplied a reference image (pure text-to-character).
  //   (b) The user DID supply an image, but /images/edits failed and we
  //       are falling back to text-to-image. In that case
  //       `visionDescription` carries the vision-LLM's reading of the user's
  //       image, and is the ONLY thing tying the generated turnaround to
  //       the user's intended character. It MUST be embedded in the prompt
  //       as VISUAL TRUTH at the top, otherwise the fallback produces an
  //       unrelated character.
  const visionTruth = compact(input.visionDescription)
    ? [
        'VISUAL TRUTH (vision-described directly from the user\'s reference image — the generated character must match these features exactly):',
        compact(input.visionDescription),
        '',
      ].join('\n')
    : '';
  const dynamicSections = [
    `Project title: ${compact(input.title) || 'Untitled character video'}`,
    `Video aspect ratio: ${input.ratio}`,
    `User story / text reference: ${compact(input.story).slice(0, 2600)}`,
    compactList(input.referenceNotes) ? `User reference notes: ${compactList(input.referenceNotes)}` : '',
    compactList(continuity.characters) ? `Character constraints: ${compactList(continuity.characters)}` : '',
    compactList(continuity.wardrobe) ? `Wardrobe constraints: ${compactList(continuity.wardrobe)}` : '',
    compactList(continuity.props) ? `Important props: ${compactList(continuity.props)}` : '',
    compactList(continuity.palette) ? `Palette: ${compactList(continuity.palette)}` : '',
    compactList(continuity.mood) ? `Mood: ${compactList(continuity.mood)}` : '',
  ].filter(Boolean);

  return [
    'Create one original character turnaround reference sheet for locking identity in a long video generation workflow.',
    '',
    visionTruth,
    ...dynamicSections,
    '',
    'Image requirements (FIXED):',
    '- Three full-body views of the exact same character: front view, side profile view, and back view.',
    '- Same face structure, hair shape, body proportions, outfit, accessories, silhouette, color palette, and art style across all three views.',
    '- Neutral studio background, even soft lighting, clean readable full-body pose, hands and feet fully visible, no cropping.',
    '- Character sheet layout only; no action scene, no environment scene, no other people, no alternate costumes.',
    '- No text, no labels, no captions, no watermark, no logo, no UI, no speech bubbles.',
    '- If the user requested an anime or illustrated character, keep the output as an illustrated/anime character and do not convert it into a real human actor.',
  ].filter(Boolean).join('\n');
}

// Per-segment opening keyframe prompt.
//
// Two input modes:
//   - Single image (the turnaround): for shot 1, OR when previous segment
//     last-frame extraction failed.
//   - Dual image (turnaround + previous segment's actual last frame): for
//     shots N>1 in the relay chain. Image-2 receives the closing frame of
//     the previous segment as the "starting point" and stages the new
//     segment's action while preserving identity from the turnaround.
//
// Image order convention (matches the order we POST to /images/edits):
//   image[0] = turnaround sheet (identity lock)
//   image[1] = previous segment's last frame (handoff context, optional)
export function buildSegmentKeyframePrompt(input: {
  shotIndex: number;
  shotCount: number;
  shot: {
    title?: string;
    storyBeat?: string;
    visualPrompt?: string;
    camera?: string;
    continuity?: string;
  };
  ratio: string;
  withPreviousLastFrame: boolean;
  // Optional vision-derived character description (carried over from the
  // turnaround stage). Injected as VISUAL TRUTH so identity is anchored
  // textually as well as visually — survives even when the relay's image
  // conditioning weakens or when the planner drops the ball on storyBeat.
  visionDescription?: string;
  // Locked accessories (extracted dynamically from user content, not
  // hardcoded). Listed in the keyframe prompt so segments 2..N's keyframes
  // don't accidentally drop or replace identity-defining wearables.
  accessoriesLock?: string[];
  // Persistent occlusions (masks, hooded cloaks, hair curtains) that must
  // appear in every shot.
  occlusionLock?: string[];
  // Permanent wardrobe items that must remain across every shot.
  permanentWardrobe?: string[];
  // Distinguishing marks (tattoos, scars, birthmarks).
  distinguishingMarks?: string[];
  // Identity-locked props always carried by the protagonist.
  identityLockedProps?: string[];
  // Free-form continuity rules from the world model.
  continuityRules?: string[];
  // Things to avoid showing.
  exclusions?: string[];
  // Spatial reality block — passed through so the keyframe pose is
  // physically plausible (contact zones correct, no impossible body→
  // surface interactions like "hand at chest splashes water at feet").
  groundSurface?: string;
  waterLine?: string;
  perspectiveCues?: string;
  physicsRules?: string[];
  forbiddenSpatialErrors?: string[];
  // True when the user's original reference was detected as a real person.
  // Segment keyframes must still follow the original saga-cookie-beach formula:
  // VISUAL TRUTH identity text + safe turnaround reference + mild style
  // inheritance. Do NOT force these keyframes into anime/illustration here —
  // that contradicts the long-video OUTPUT-STYLE OVERRIDE and makes later
  // video segments drift away from the desired live-action result.
  realPersonInput?: boolean;
}): string {
  const shot = input.shot;
  const identitySection = input.withPreviousLastFrame
    ? [
        'PRIMARY DIRECTIVE — TWO INPUT IMAGES.',
        'IMAGE 1 (turnaround sheet) defines the canonical character identity. The output protagonist MUST match IMAGE 1: same face, hair, eyes, body proportions, skin tone, wardrobe, accessories, color palette, art style.',
        'IMAGE 2 (previous segment\'s closing frame) defines the visual handoff: the same environment, lighting key direction, color temperature, framing, and any persistent props. The output should look like a natural continuation of IMAGE 2 — as if a fraction of a second has passed.',
        'COMPOSE the new opening frame so that IDENTITY is preserved from IMAGE 1 and SCENE/STAGING is continuous with IMAGE 2. The protagonist should be in IMAGE 2\'s world, dressed and looking like IMAGE 1, in the action pose described below.',
        'DO NOT redesign the protagonist. DO NOT teleport to a new world. DO NOT swap the art style.',
        'EVEN IF the scene description below mentions other characters (a guard, a keeper, a friend, etc.), the PROTAGONIST in the output is always the IMAGE 1 character. Other characters are secondary and may be omitted entirely. The IMAGE 1 character is never replaced.',
      ].join('\n')
    : [
        'PRIMARY DIRECTIVE — IDENTITY LOCK FROM ATTACHED IMAGE.',
        'The attached input image is the canonical character turnaround sheet for this entire video. The protagonist in this shot MUST look identical to the front-view of that turnaround.',
        'Preserve every visible feature: face, hair (length / shape / color / any non-human ear or feature), eyes, body proportions, skin tone, complete outfit and accessories, color palette, art style.',
        'EVEN IF the scene description below mentions other characters, the PROTAGONIST is always the IMAGE 1 character. Other characters are secondary and may be omitted entirely. The IMAGE 1 character is never replaced or reinterpreted.',
      ].join('\n');

  const visionTruth = compact(input.visionDescription)
    ? [
        '',
        'VISUAL TRUTH (vision-described directly from the turnaround / input image — describes the same character; the output protagonist must match these features):',
        compact(input.visionDescription),
      ].join('\n')
    : '';

  // World-model identity locks — rendered dynamically from the analyst's
  // extracted fields so segments 2..N don't lose accessories, occlusions,
  // permanent wardrobe, distinguishing marks, locked props, or custom rules.
  const lockBlocks: string[] = [];
  if (input.accessoriesLock && input.accessoriesLock.length > 0) {
    lockBlocks.push('LOCKED ACCESSORIES (must appear in this keyframe in the same position/color/style — never replace, swap, or remove):');
    for (const item of input.accessoriesLock) lockBlocks.push(`  · ${item}`);
    if (input.accessoriesLock.some((item) => /(eye[\s-]*mask|blindfold|遮.*眼|眼罩|蒙眼|覆眼|遮住双眼|遮住眼睛)/i.test(item))) {
      lockBlocks.push('EYE-COVER HARD RULE: the locked eye-covering accessory fully hides the eyes. Do NOT draw visible eyes, pupils, irises, eye gaze, or transparent eye shapes through/around it. Never lift, slide, loosen, or remove it.');
    }
  }
  if (input.occlusionLock && input.occlusionLock.length > 0) {
    lockBlocks.push('LOCKED OCCLUSIONS (must persist across every shot — these elements partially cover the protagonist and the cover must NOT be removed):');
    for (const item of input.occlusionLock) lockBlocks.push(`  · ${item}`);
  }
  if (input.permanentWardrobe && input.permanentWardrobe.length > 0) {
    lockBlocks.push('LOCKED PERMANENT WARDROBE:');
    for (const item of input.permanentWardrobe) lockBlocks.push(`  · ${item}`);
  }
  if (input.distinguishingMarks && input.distinguishingMarks.length > 0) {
    lockBlocks.push('DISTINGUISHING MARKS (anatomically permanent — must appear):');
    for (const item of input.distinguishingMarks) lockBlocks.push(`  · ${item}`);
  }
  if (input.identityLockedProps && input.identityLockedProps.length > 0) {
    lockBlocks.push('IDENTITY-LOCKED PROPS (always present with the protagonist):');
    for (const item of input.identityLockedProps) lockBlocks.push(`  · ${item}`);
  }
  if (input.continuityRules && input.continuityRules.length > 0) {
    lockBlocks.push('PROJECT CONTINUITY RULES:');
    for (const rule of input.continuityRules) lockBlocks.push(`  · ${rule}`);
  }
  if (input.exclusions && input.exclusions.length > 0) {
    lockBlocks.push(`EXCLUSIONS (do NOT include): ${input.exclusions.join(', ')}`);
  }

  // SPATIAL REALITY block for the keyframe — most-common video-gen failure
  // is geometric impossibility (e.g. "hand at chest splashes water at feet").
  // Inject the scene's contact zones and forbidden errors so the keyframe's
  // pose stays physically plausible.
  if (input.groundSurface) lockBlocks.push(`GROUND SURFACE: ${input.groundSurface}`);
  if (input.waterLine) lockBlocks.push(`WATER CONTACT LINE: ${input.waterLine}`);
  if (input.perspectiveCues) lockBlocks.push(`PERSPECTIVE: ${input.perspectiveCues}`);
  if (input.physicsRules && input.physicsRules.length > 0) {
    lockBlocks.push('PHYSICS RULES (every contact / cause-effect in the pose must obey these):');
    for (const r of input.physicsRules) lockBlocks.push(`  · ${r}`);
  }
  if (input.forbiddenSpatialErrors && input.forbiddenSpatialErrors.length > 0) {
    lockBlocks.push('FORBIDDEN SPATIAL ERRORS (do NOT compose any of these):');
    for (const e of input.forbiddenSpatialErrors) lockBlocks.push(`  · ${e}`);
  }
  if (input.groundSurface || input.waterLine || (input.physicsRules && input.physicsRules.length > 0)) {
    lockBlocks.push(
      'SPATIAL REALITY CHECK FOR THIS POSE: body parts contact only surfaces at the matching height. ' +
      'A hand at chest level cuts AIR; to touch water/sand the hand must reach DOWN to the water/ground line. ' +
      'Symbolic gestures at heights above the contact surface produce no contact effect on that surface — do NOT paint a splash, ripple, or sand-spray under a hand that is not physically at that surface. ' +
      'Feet must rest on the actual ground (no floating). Hair and fabric drape by gravity unless visibly lifted by wind or motion. No clipping of limbs through hair, fabric, or solids.'
    );
  }
  const locksSection = lockBlocks.length > 0 ? ['', ...lockBlocks, ''].join('\n') : '';

  return [
    identitySection,
    visionTruth,
    locksSection,
    `This is the opening keyframe for shot ${input.shotIndex} of ${input.shotCount} in a long-form video.`,
    `Aspect ratio: ${input.ratio}`,
    `Title: ${compact(shot.title) || `Shot ${input.shotIndex}`}`,
    '',
    'Compose this opening frame:',
    compact(shot.storyBeat) ? `Story beat (the scene this shot opens on): ${compact(shot.storyBeat)}` : '',
    compact(shot.visualPrompt) ? `Visual direction: ${compact(shot.visualPrompt)}` : '',
    compact(shot.camera) ? `Camera and lens: ${compact(shot.camera)}` : '',
    compact(shot.continuity) ? `Continuity notes: ${compact(shot.continuity)}` : '',
    '',
    'OUTPUT REQUIREMENTS (FIXED):',
    '- Single image only; do not output a sheet, grid, or multi-panel.',
    '- The IMAGE 1 protagonist is the central subject. Do NOT replace the protagonist with anyone else.',
    '- ALL LOCKED ITEMS above must appear unchanged.',
    '',
    'CRITICAL — ACTION-IN-PROGRESS POSE (not a still portrait):',
    '- The character must be MID-ACTION at the moment depicted, not standing still or posing for a portrait.',
    '- Pick a moment where the body, hair, fabric, or environment is in motion: mid-stride, mid-gesture, mid-turn, hair caught by wind, fabric flowing, particles in air, water splashing, foot lifted, hand reaching.',
    '- This is the STARTING frame of a moving video clip. The video model will animate forward from this exact moment, so the body must already be in motion — the next 0.5 s of movement should be implied by the pose.',
    input.withPreviousLastFrame ? '- Continue the previous closing-frame momentum from IMAGE 2: match body direction, limb inertia, camera travel, and hair/fabric flow rather than resetting to a neutral pose.' : '',
    '- AVOID: arms-at-sides standing portrait, neutral facing-camera pose, static "lookbook" composition, character planted in a frozen ready-stance.',
    '',
    '- Background, lighting, color cast match the scene.' + (input.withPreviousLastFrame ? ' Continue the environment from IMAGE 2.' : ''),
    '- No text, no labels, no captions, no watermark, no logo, no UI, no speech bubbles.',
    '- Same art style as the turnaround (illustrated stays illustrated; photoreal stays photoreal).',
  ].filter(Boolean).join('\n');
}

function imageReferenceArtifactPath(projectDir: string, sourceAssetPath: string | undefined): string {
  const ext = sourceAssetPath ? path.extname(sourceAssetPath) : '';
  return path.join(projectDir, 'super-visual', `character-turnaround${ext || '.png'}`);
}

function segmentKeyframePath(projectDir: string, shotIndex: number, ext: string = '.png'): string {
  return path.join(projectDir, 'super-visual', `segment-${String(shotIndex).padStart(3, '0')}-keyframe${ext}`);
}

// ─── OpenAI image edit helper (multipart) ─────────────────────────────────
//
// The provider's generateImage uses /images/generations (text-to-image only).
// For image-to-image we hit /images/edits directly with multipart form data.
// Node 18+ has built-in FormData / Blob / File / fetch, no extra deps.

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || '').replace(/\/+$/, '');
}

type UploadCompressionPlan = {
  totalInputBytes: number;
  inputCount: number;
};

function shouldCompressImageForUpload(fileBytes: number, plan: UploadCompressionPlan): boolean {
  const totalIsLarge = plan.totalInputBytes > IMAGE_EDIT_TOTAL_FORM_COMPRESS_THRESHOLD_BYTES;
  const fileIsLarge = fileBytes > IMAGE_EDIT_SINGLE_FILE_COMPRESS_THRESHOLD_BYTES;
  const fileNeedsHelpInLargeBatch = totalIsLarge && fileBytes > IMAGE_EDIT_FORCED_COMPRESS_FILE_THRESHOLD_BYTES;
  return fileIsLarge || fileNeedsHelpInLargeBatch;
}

export function shouldCompressImageForUploadForTest(
  fileBytes: number,
  totalInputBytes: number,
  inputCount = 1,
): boolean {
  return shouldCompressImageForUpload(fileBytes, { totalInputBytes, inputCount });
}

// Auto-compress image inputs before sending to /v1/images/edits, but only
// when there is a real payload-size risk. Small PNG/WebP/JPEG references are
// identity anchors and should be uploaded losslessly; recompressing a 1–2MB
// turnaround sheet to a tiny JPEG hurts fine wardrobe/accessory detail and
// does not meaningfully protect the relay. We compress when either a single
// file is large or the entire multipart image batch is large.
async function maybeCompressForUpload(filePath: string, plan: UploadCompressionPlan): Promise<string> {
  let stat;
  try {
    const fs = await import('node:fs/promises');
    stat = await fs.stat(filePath);
  } catch {
    return filePath;
  }
  const sizeMb = stat.size / (1024 * 1024);
  if (!shouldCompressImageForUpload(stat.size, plan)) {
    return filePath;
  }
  // Hash the path so repeated reads of the same source reuse the cache.
  const cacheKey = createHash('sha256')
    .update(`${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}:${plan.totalInputBytes}:${plan.inputCount}`)
    .digest('hex')
    .slice(0, 24);
  const os = await import('node:os');
  const compressedPath = path.join(os.tmpdir(), `saga-edit-input-${cacheKey}.jpg`);
  // If the cached compressed copy already exists and is fresh, reuse.
  try {
    const fs = await import('node:fs/promises');
    const cachedStat = await fs.stat(compressedPath);
    if (cachedStat.size > 0 && cachedStat.mtimeMs > stat.mtimeMs) {
      return compressedPath;
    }
  } catch { /* not cached yet */ }
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { resolveFfmpegBinaryPath } = await import('./sagaRenderer/concat.js');
    const ffmpegBin = await resolveFfmpegBinaryPath();
    await execFileAsync(ffmpegBin, [
      '-y',
      '-loglevel', 'error',
      '-i', filePath,
      '-vf', `scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease`,
      '-q:v', '4', // ≈ 92% quality JPEG; visually indistinguishable from source for vision models
      compressedPath,
    ], { timeout: 60_000 });
    const fs = await import('node:fs/promises');
    const newStat = await fs.stat(compressedPath);
    toolLog(`🗜️  Super Visual: 上传图片压缩 ${path.basename(filePath)} (${sizeMb.toFixed(1)}MB → ${(newStat.size / (1024 * 1024)).toFixed(2)}MB) — 当前批次 ${plan.inputCount} 张 / ${(plan.totalInputBytes / (1024 * 1024)).toFixed(1)}MB。`);
    return compressedPath;
  } catch (error) {
    toolWarn(`⚠️ Super Visual: 图片压缩失败（${error instanceof Error ? error.message.slice(0, 160) : String(error)}），使用原图。`);
    return filePath;
  }
}

async function readImageAsBlob(filePath: string, plan: UploadCompressionPlan): Promise<{ blob: Blob; filename: string }> {
  const effectivePath = await maybeCompressForUpload(filePath, plan);
  const buffer = await readFile(effectivePath);
  const ext = path.extname(effectivePath).toLowerCase();
  const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/png';
  // Convert Node Buffer → ArrayBuffer for Blob.
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  return {
    blob: new Blob([ab], { type }),
    filename: path.basename(effectivePath),
  };
}

async function postOpenAIImageEdit(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  inputImagePaths: string[];
  size?: string;
  quality?: string;
}): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
  if (options.inputImagePaths.length === 0) {
    return { ok: false, error: 'no input images supplied' };
  }
  const url = normalizeBaseUrl(options.baseUrl) + '/images/edits';
  // Up to 3 attempts with exponential backoff. Relays in front of OpenAI
  // (e.g. http://69.5.20.196:8080/v1) intermittently return HTTP 502/503/504
  // upstream_error during transient OpenAI hiccups; one retry recovers.
  const transientStatuses = new Set([429, 500, 502, 503, 504]);
  const attempts = 3;
  let lastError = '';
  const startedAt = Date.now();
  let uploadPlan: UploadCompressionPlan = { totalInputBytes: 0, inputCount: options.inputImagePaths.length };
  try {
    const fs = await import('node:fs/promises');
    const stats = await Promise.all(options.inputImagePaths.map(async (filePath) => {
      try {
        return await fs.stat(filePath);
      } catch {
        return undefined;
      }
    }));
    uploadPlan = {
      totalInputBytes: stats.reduce((sum, stat) => sum + (stat?.size ?? 0), 0),
      inputCount: options.inputImagePaths.length,
    };
  } catch {
    // Keep the conservative zero-byte plan; read errors are handled below.
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remainingMs = IMAGE_EDIT_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return { ok: false, error: `images/edits timed out after ${Math.round(IMAGE_EDIT_TOTAL_TIMEOUT_MS / 1000)}s` };
    }
    const form = new FormData();
    form.append('model', options.model);
    form.append('prompt', options.prompt);
    if (options.size) form.append('size', options.size);
    if (options.quality) form.append('quality', options.quality);
    let formBuildFailed = false;
    // OpenAI Image API field naming: single image uses "image"; multiple
    // images use "image[]" (the array variant). Some relays accept either,
    // but using the wrong form for multi-image silently picks just the
    // last upload. Branch on count to match the official spec.
    const isMulti = options.inputImagePaths.length > 1;
    const fieldName = isMulti ? 'image[]' : 'image';
    for (const filePath of options.inputImagePaths) {
      try {
        const { blob, filename } = await readImageAsBlob(filePath, uploadPlan);
        form.append(fieldName, blob, filename);
      } catch (error) {
        formBuildFailed = true;
        lastError = `read input image failed (${filePath}): ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }
    if (formBuildFailed) return { ok: false, error: lastError };
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(Math.max(1000, remainingMs)),
      });
    } catch (error) {
      lastError = `network error: ${error instanceof Error ? error.message : String(error)}`;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        continue;
      }
      return { ok: false, error: lastError };
    }
    const raw = await res.text();
    if (!res.ok) {
      lastError = `images/edits ${res.status}: ${raw.slice(0, 400)}`;
      if (transientStatuses.has(res.status) && attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        continue;
      }
      return { ok: false, error: lastError };
    }
    try {
      const parsed = JSON.parse(raw) as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
      const item = parsed.data?.[0];
      if (!item) {
        lastError = `images/edits returned no image (${parsed.error?.message ?? 'no error message'})`;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
          continue;
        }
        return { ok: false, error: lastError };
      }
      if (item.b64_json) return { ok: true, buffer: Buffer.from(item.b64_json, 'base64') };
      if (item.url) {
        const downloaded = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
        if (!downloaded.ok) return { ok: false, error: `download failed: ${downloaded.status}` };
        const ab = await downloaded.arrayBuffer();
        return { ok: true, buffer: Buffer.from(ab) };
      }
      return { ok: false, error: 'images/edits response had neither b64_json nor url' };
    } catch {
      lastError = `images/edits invalid JSON: ${raw.slice(0, 200)}`;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        continue;
      }
      return { ok: false, error: lastError };
    }
  }
  return { ok: false, error: lastError || 'unknown failure' };
}

// ─── User image resolution (paths + URLs → local files) ───────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    const info = await stat(p);
    return info.isFile() && info.size > 64;
  } catch {
    return false;
  }
}

async function downloadUrlToLocal(url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const ab = await res.arrayBuffer();
    await writeFile(destPath, Buffer.from(ab));
    return true;
  } catch {
    return false;
  }
}

async function resolveUserImageInputs(
  paths: string[] | undefined,
  urls: string[] | undefined,
  cacheDir: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths ?? []) {
    if (await fileExists(p)) out.push(p);
  }
  if (urls && urls.length > 0) {
    await mkdir(cacheDir, { recursive: true });
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i]!;
      if (url.startsWith('data:')) continue; // data URLs handled by attachment ingestion upstream
      const ext = url.match(/\.(png|jpe?g|webp|gif)(?:[?#]|$)/i)?.[0]?.replace(/[?#]+$/, '') ?? '.png';
      const dest = path.join(cacheDir, `user-input-${String(i).padStart(2, '0')}${ext.startsWith('.') ? ext : `.${ext}`}`);
      if (await downloadUrlToLocal(url, dest)) out.push(dest);
    }
  }
  return Array.from(new Set(out));
}

// ─── Vision-derived character description ────────────────────────────────
//
// When the user supplies an input image, we ask a vision-capable text model
// (the configured main provider — gpt-5.5 / gpt-5.5-pro / gpt-4o-class) to
// describe ONLY the character in the image as a single paragraph. That
// description is injected into both the turnaround prompt and per-segment
// keyframe prompts as "VISUAL TRUTH". Even when the relay's
// `/images/edits` weakens visual conditioning, the textual description
// carries identity — so the output still looks like the user's character.

// Inspect a vision description to decide whether the user's image is a
// real photograph of a real human, vs an already-stylized character (anime,
// 3D render, illustration). Used to pick the auto turnaround style.
function looksLikeRealPersonDescription(description: string | null | undefined): boolean {
  if (!description) return false;
  const lowered = description.toLowerCase();
  // Stylized signals — if these appear, the input is already non-photoreal.
  const stylizedHits = [
    /\banim[eé]\b/, /\billustration\b/, /\billustrated\b/, /\bdigital painting\b/,
    /\bcel[- ]shaded\b/, /\bpainterly\b/, /\b3d render(?:ed)?\b/, /\bcartoon\b/,
    /\bvector art\b/, /\bstylized\b/, /\bcharacter design\b/, /\bcharacter sheet\b/,
    /\bmascot\b/, /\bvtuber\b/, /\bavatar\b/,
    /插画|动漫|二次元|手绘|渲染|风格化|卡通|线稿|赛璐璐/,
  ].some((pattern) => pattern.test(lowered));
  if (stylizedHits) return false;
  // Photoreal signals.
  const photorealHits = [
    /\bphoto(?:graph(?:ic|y)?|realistic)?\b/, /\bportrait photo\b/, /\bskin texture\b/,
    /\breal(?:istic)? human\b/, /\breal person\b/, /\bphotograph\b/,
    /真人|实拍|实景|照片|肖像照|写真/,
  ].some((pattern) => pattern.test(lowered));
  if (photorealHits) return true;
  // Fallback heuristic: descriptions of real humans tend to mention concrete
  // ethnicity + age + gender markers without stylization keywords. If the
  // description contains "亚洲" / "asian" / "european" / "african" + "woman/man/
  // 女性/男性" without stylization keywords, treat as real-person.
  if (/(亚洲|欧洲|非洲|拉丁|asian|european|african|latina?)[\s\S]{0,40}(女性|男性|woman|man)/.test(lowered)) {
    return true;
  }
  return false;
}

function isLikelyProvidedTurnaroundPath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return /(?:^|[-_.\s])(character[-_.\s]*)?turnaround(?:[-_.\s]|$)/i.test(base)
    || /(?:^|[-_.\s])(?:three[-_.\s]*view|3[-_.\s]*view|front[-_.\s]*side[-_.\s]*back)(?:[-_.\s]|$)/i.test(base)
    || /三视图|三面图|转面图|角色设定/.test(path.basename(filePath));
}

function findProvidedTurnaroundInput(userInputs: string[], originalPaths?: string[], referenceNotes?: string[]): string | undefined {
  for (let i = 0; i < userInputs.length; i += 1) {
    const cachedPath = userInputs[i];
    const originalPath = originalPaths?.[i];
    const note = referenceNotes?.join('\n') ?? '';
    if (isLikelyProvidedTurnaroundPath(cachedPath)
      || (originalPath && isLikelyProvidedTurnaroundPath(originalPath))
      || isLikelyTurnaroundDescription(note)) {
      return cachedPath;
    }
  }
  return undefined;
}

function isLikelyTurnaroundDescription(description: string | null | undefined): boolean {
  if (!description) return false;
  const lowered = description.toLowerCase();
  return /\b(character sheet|turnaround|model sheet|reference sheet|three[- ]view|3[- ]view)\b/.test(lowered)
    || /\bfront\b[\s\S]{0,80}\b(side|profile)\b[\s\S]{0,80}\bback\b/.test(lowered)
    || /三视图|三面图|转面图|角色设定|正面[\s\S]{0,80}侧面[\s\S]{0,80}背面/.test(description);
}

export function isLikelyProvidedTurnaroundReferenceForTest(filePath: string, description?: string | null): boolean {
  return isLikelyProvidedTurnaroundPath(filePath) || isLikelyTurnaroundDescription(description);
}

export async function describeUserImageWithVision(options: {
  imagePath: string;
  context: ToolExecutionContext;
}): Promise<string | null> {
  // Resolve the chat/vision endpoint. Image provider's relay (backed by
  // OpenAI, supports multimodal /chat/completions) goes FIRST — this is the
  // endpoint that actually understands image_url inputs. The main LLM profile
  // (often a coding model like glm-5.1 on a BytePlus coding endpoint) does NOT
  // support vision and should only be used as a last resort.
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let chatModel: string | undefined;
  // ── Priority 1: image provider's relay (OpenAI-compatible, supports vision)
  const imageConfigured = await resolveConfiguredVisualProvider(options.context.cwd, 'image');
  if (imageConfigured) {
    apiKey = imageConfigured.config.image.apiKey?.trim();
    baseUrl = imageConfigured.config.image.baseUrl?.trim();
    chatModel = 'gpt-4o'; // OpenAI relay — use a known vision-capable model
  }
  // ── Priority 2: main LLM profile (may not support vision, but worth trying)
  if (!apiKey || !baseUrl) {
    try {
      const { ProviderStore } = await import('../../providers/store.js');
      const store = await new ProviderStore(options.context.cwd).load();
      const main = store?.profiles?.find((p) => p.id === (store?.defaultMainProfileId ?? 'main'));
      if (main) {
        if (main.apiKey) apiKey = main.apiKey.trim();
        if (main.baseUrl) baseUrl = main.baseUrl.trim();
        if (main.model) chatModel = main.model;
      }
    } catch { /* fall through */ }
  }
  if (!apiKey || !baseUrl) return null;

  let buffer: Buffer;
  try {
    buffer = await readFile(options.imagePath);
  } catch {
    return null;
  }
  const ext = path.extname(options.imagePath).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: chatModel || 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: 'You are a character description specialist for a video generation pipeline. Look at the image and write ONE concise paragraph (under 200 words) that describes ONLY the character / subject within the image — not the background, not banner text, not the title overlay. Be EXTREMELY specific about: art style (photoreal, anime, illustrated, painted, 3D render, etc), face shape, eye shape and color, hair length / shape / color / highlights / texture, any distinctive non-human features (animal ears, horns, glowing markings, wings, halo, antennae, etc), body proportions, skin tone, complete outfit (every visible garment with color and material), every accessory and piece of jewelry, and the overall color palette. If the image is a banner / poster with the character inside, describe only the character; ignore decorative typography, frames, and background scenery. Write in plain prose, no bullet points, no headings. Output the paragraph only — no preamble, no commentary.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this character in detail.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 600,
  } as Record<string, unknown>;

  // Up to 2 attempts — relays can return transient 502/429 that self-heal
  // on a quick retry. Previously a single failure silently killed VISUAL
  // TRUTH, cascading into missing identity descriptions in turnaround &
  // keyframe prompts, which then caused BytePlus real-person filter rejections.
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        toolWarn(`⚠️ Super Visual: vision-describe 失败（HTTP ${res.status}，尝试 ${attempt + 1}/${maxAttempts}）— ${errBody.slice(0, 200)}`);
        if (attempt < maxAttempts - 1 && (res.status === 429 || res.status >= 500)) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        return null;
      }
      const text = await res.text();
      let parsed: { choices?: Array<{ message?: { content?: unknown } }> };
      try { parsed = JSON.parse(text); } catch {
        toolWarn(`⚠️ Super Visual: vision-describe 响应 JSON 解析失败（尝试 ${attempt + 1}/${maxAttempts}）`);
        return null;
      }
      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        toolWarn(`⚠️ Super Visual: vision-describe 返回空内容（尝试 ${attempt + 1}/${maxAttempts}）`);
        return null;
      }
      const trimmed = content.replace(/\s+/g, ' ').trim();
      if (trimmed.length === 0) {
        toolWarn(`⚠️ Super Visual: vision-describe 返回空白描述（尝试 ${attempt + 1}/${maxAttempts}）`);
        return null;
      }
      return trimmed;
    } catch (err) {
      toolWarn(`⚠️ Super Visual: vision-describe 网络异常（尝试 ${attempt + 1}/${maxAttempts}）— ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ─── Main entry: turnaround ───────────────────────────────────────────────

export async function maybeGenerateSuperVisualReference(options: {
  action: SuperVisualActionInput;
  context: ToolExecutionContext;
  projectDir: string;
  story: string;
  title: string;
  ratio: string;
  videoLimits: VideoModelLimits;
}): Promise<SuperVisualModeResult> {
  if (options.action.superVisualMode === 'off') {
    return { enabled: false, reason: 'disabled by request' };
  }

  const superVisualDir = path.join(options.projectDir, 'super-visual');
  await mkdir(superVisualDir, { recursive: true });

  // Resolve user images (paths + URLs) into local files we can post.
  // We do this BEFORE the relay-sick check so the SV-disabled fallback
  // in generateLongVideo still has local copies of URL refs to feed to
  // vision-describe (which uses a separate chat endpoint that may be
  // healthy even when image-gen is rate-limited).
  const userInputCacheDir = path.join(superVisualDir, 'user-inputs');
  const userInputs = await resolveUserImageInputs(
    options.action.referenceImagePaths,
    options.action.referenceImageUrls,
    userInputCacheDir,
  );
  const useEditMode = userInputs.length > 0;
  const promptPath = path.join(superVisualDir, 'character-turnaround.prompt.txt');

  const providedTurnaroundByPath = findProvidedTurnaroundInput(
    userInputs,
    options.action.referenceImagePaths,
    options.action.referenceNotes,
  );
  if (providedTurnaroundByPath) {
    if (!options.videoLimits.referenceInputs.includes('image')) {
      return {
        enabled: false,
        reason: 'provided turnaround reference cannot be used because this video model does not accept image references',
        resolvedUserImagePaths: userInputs,
      };
    }
    const originalReferencePath = path.join(superVisualDir, 'source-provided-turnaround' + (path.extname(providedTurnaroundByPath) || '.png'));
    if (path.resolve(providedTurnaroundByPath) !== path.resolve(originalReferencePath)) {
      await copyFile(providedTurnaroundByPath, originalReferencePath);
    }
    const visionDescription = await describeUserImageWithVision({
      imagePath: providedTurnaroundByPath,
      context: options.context,
    });
    if (visionDescription) {
      await writeFile(
        path.join(superVisualDir, 'character-vision-description.txt'),
        visionDescription,
        'utf8',
      );
    }
    const providedLooksRealPerson = visionDescription ? looksLikeRealPersonDescription(visionDescription) : true;

    const imageConfigured = await resolveConfiguredVisualProvider(options.context.cwd, 'image');
    const imageProviderName = imageConfigured?.config.image.provider;
    const imageModel = imageConfigured?.model ?? imageConfigured?.config.image.model;
    const ineligible = getSuperVisualModeIneligibilityReason({
      imageProvider: imageProviderName,
      imageModel,
      videoReferenceInputs: options.videoLimits.referenceInputs,
    });

    if (providedLooksRealPerson) {
      if (!imageConfigured || ineligible) {
        return {
          enabled: false,
          reason: `provided turnaround appears photoreal/real-person and no provider-safe illustrated derivative can be generated: ${ineligible ?? 'image generation provider is not configured'}`,
          inputIsRealPerson: true,
          resolvedUserImagePaths: userInputs,
        };
      }
      const resolvedImageModel = imageConfigured.model || imageConfigured.config.image.model || 'gpt-image-2';
      const safePrompt = buildSuperVisualCharacterTurnaroundPrompt({
        title: options.title,
        story: buildProvidedTurnaroundSafetyDerivativeStory({
          story: options.story,
          visionDescription,
          referenceNotes: options.action.referenceNotes,
        }),
        ratio: options.ratio,
        referenceNotes: options.action.referenceNotes,
        continuity: options.action.continuity,
        withUserImageInput: true,
        visionDescription: visionDescription ?? undefined,
        style: 'illustrated',
        inputLooksRealPerson: true,
      });
      await writeFile(promptPath, safePrompt, 'utf8');
      const apiKey = imageConfigured.config.image.apiKey?.trim();
      const baseUrl = imageConfigured.config.image.baseUrl?.trim();
      if (apiKey && baseUrl) {
        toolLog(`🎨 Super Visual: 用户三视图疑似真人/照片质感，先生成 provider-safe 插画化身份锚。`);
        const edit = await postOpenAIImageEdit({
          baseUrl,
          apiKey,
          model: resolvedImageModel,
          prompt: safePrompt,
          inputImagePaths: [providedTurnaroundByPath],
          size: '1536x1024',
          quality: 'high',
        });
        if (edit.ok) {
          const safeReferencePath = imageReferenceArtifactPath(options.projectDir, '.png');
          await writeFile(safeReferencePath, edit.buffer);
          toolLog(`✅ Super Visual: 已从用户三视图派生 provider-safe 身份锚 → ${safeReferencePath}`);
          return {
            enabled: true,
            provider: describeVisualProvider(imageConfigured.config, 'image'),
            model: resolvedImageModel,
            referenceImagePath: safeReferencePath,
            promptPath,
            sourceAssetPath: originalReferencePath,
            mode: 'provided-turnaround-safe-derivative',
            userImagesUsed: 1,
            reason: `generated provider-safe illustrated derivative from provided turnaround: ${providedTurnaroundByPath}`,
            inputIsRealPerson: true,
            resolvedUserImagePaths: userInputs,
          };
        }
        if (/HTTP 5\d\d|upstream_error|rate.?limit|429|timeout|timed out|aborted/i.test(edit.error)) markRelaySick(edit.error);
        return {
          enabled: false,
          reason: `provided turnaround appears photoreal/real-person but safe derivative generation failed: ${edit.error.slice(0, 200)}`,
          inputIsRealPerson: true,
          resolvedUserImagePaths: userInputs,
        };
      }
      return {
        enabled: false,
        reason: 'provided turnaround appears photoreal/real-person but image edit credentials are unavailable; refusing to send the original directly to the video provider',
        inputIsRealPerson: true,
        resolvedUserImagePaths: userInputs,
      };
    }

    const referenceImagePath = imageReferenceArtifactPath(options.projectDir, providedTurnaroundByPath);
    if (path.resolve(providedTurnaroundByPath) !== path.resolve(referenceImagePath)) {
      await copyFile(providedTurnaroundByPath, referenceImagePath);
    }
    await writeFile(
      promptPath,
      [
        'User supplied an already-built character turnaround reference sheet.',
        `Source: ${providedTurnaroundByPath}`,
        'Saga must use this image directly as the canonical character identity sheet; do not regenerate or reinterpret it.',
      ].join('\n'),
      'utf8',
    );
    toolLog(`✅ Super Visual: 已使用用户提供的三视图作为角色身份锚 → ${referenceImagePath}`);
    return {
      enabled: true,
      provider: 'provided-reference',
      model: 'provided-turnaround',
      referenceImagePath,
      promptPath,
      sourceAssetPath: providedTurnaroundByPath,
      mode: 'provided-turnaround',
      userImagesUsed: 1,
      reason: `used provided character turnaround reference: ${providedTurnaroundByPath}`,
      inputIsRealPerson: false,
      resolvedUserImagePaths: userInputs,
    };
  }

  const imageConfigured = await resolveConfiguredVisualProvider(options.context.cwd, 'image');
  const imageProviderName = imageConfigured?.config.image.provider;
  const imageModel = imageConfigured?.model ?? imageConfigured?.config.image.model;
  const ineligible = getSuperVisualModeIneligibilityReason({
    imageProvider: imageProviderName,
    imageModel,
    videoReferenceInputs: options.videoLimits.referenceInputs,
  });
  if (ineligible && options.action.superVisualMode !== 'on') {
    return { enabled: false, reason: ineligible };
  }
  if (!imageConfigured) {
    return { enabled: false, reason: 'image generation provider is not configured' };
  }
  if (ineligible) {
    return { enabled: false, reason: ineligible };
  }
  const resolvedImageModel = imageConfigured.model || imageConfigured.config.image.model || 'gpt-image-2';

  // Relay-health short-circuit. The retry inside postOpenAIImageEdit /
  // generateImage already burns ~30s per attempt × 3 attempts × 2 modes ≈
  // 13 min when the relay is sick. If we already saw it sick recently, skip.
  if (isRelaySick() && options.action.superVisualMode !== 'on') {
    return {
      enabled: false,
      reason: `Super Visual skipped: image relay marked sick within last ${Math.ceil(RELAY_SICK_COOLDOWN_MS / 60000)} min (will retry next run after cooldown).`,
      resolvedUserImagePaths: userInputs.length > 0 ? userInputs : undefined,
    };
  }

  toolLog(`🎨 Super Visual: 准备调用 ${imageProviderName ?? 'image'}/${resolvedImageModel} 生成角色三视图（含身份锁）...`);

  // Vision-derived character description from the FIRST user image. This
  // gives the textual side a grounded ground-truth so identity survives
  // even when the relay's /images/edits weakens visual conditioning.
  let visionDescription: string | null = null;
  if (useEditMode) {
    visionDescription = await describeUserImageWithVision({
      imagePath: userInputs[0]!,
      context: options.context,
    });
    if (visionDescription) {
      await writeFile(
        path.join(superVisualDir, 'character-vision-description.txt'),
        visionDescription,
        'utf8',
      );
    }
  }

  // Detect whether the user's image looks photoreal / real human. The vision
  // description we just generated is the most reliable signal. When vision
  // is unavailable (relay sick) but the user supplied images, we conservatively
  // assume real-person — that's the privacy-safer default since the cost of a
  // wrong "illustrated" call (slightly stylized output) is much lower than a
  // wrong "photoreal" call (downstream privacy filter rejection).
  const visionRealHit = looksLikeRealPersonDescription(visionDescription);
  const inputLooksRealPerson = useEditMode && !visionDescription ? true : visionRealHit;
  const userStyle = (options.action as { superVisualStyle?: 'illustrated' | 'photoreal' | 'auto' }).superVisualStyle;
  const prompt = buildSuperVisualCharacterTurnaroundPrompt({
    title: options.title,
    story: options.story,
    ratio: options.ratio,
    referenceNotes: options.action.referenceNotes,
    continuity: options.action.continuity,
    withUserImageInput: useEditMode,
    visionDescription: visionDescription ?? undefined,
    style: userStyle ?? 'auto',
    inputLooksRealPerson,
  });
  if (useEditMode) {
    const effectiveStyle = userStyle === 'photoreal' ? 'photoreal'
      : userStyle === 'illustrated' ? 'illustrated'
      : visionDescription
        ? (visionRealHit ? 'illustrated' : 'photoreal')
        : 'illustrated';
    toolLog(`🎨 Super Visual: 角色三视图风格 = ${effectiveStyle}`);
  }
  await writeFile(promptPath, prompt, 'utf8');

  const apiKey = imageConfigured.config.image.apiKey?.trim();
  const baseUrl = imageConfigured.config.image.baseUrl?.trim();

  // Mode A: image-to-image via /images/edits when user provided images.
  if (useEditMode && apiKey && baseUrl) {
    const edit = await postOpenAIImageEdit({
      baseUrl,
      apiKey,
      model: resolvedImageModel,
      prompt,
      inputImagePaths: userInputs,
      size: '1536x1024',
      quality: 'high',
    });
    if (edit.ok) {
      const referenceImagePath = imageReferenceArtifactPath(options.projectDir, '.png');
      await writeFile(referenceImagePath, edit.buffer);
      toolLog(`✅ Super Visual: 角色三视图就绪（image-to-image，基于 ${userInputs.length} 张用户图）→ ${referenceImagePath}`);
      return {
        enabled: true,
        provider: describeVisualProvider(imageConfigured.config, 'image'),
        model: resolvedImageModel,
        referenceImagePath,
        promptPath,
        mode: 'image-to-image',
        userImagesUsed: userInputs.length,
        reason: `generated character turnaround from ${userInputs.length} user image(s) via ${describeVisualProvider(imageConfigured.config, 'image')} image edit`,
        inputIsRealPerson: inputLooksRealPerson,
      };
    }
    // Edit endpoint failed. We MUST rebuild the prompt for text-to-image
    // mode — the prompt above is built with `withUserImageInput: true`
    // which says "the attached input image IS the character"; running it
    // through text-to-image with no image attached would produce an
    // unrelated character. Two recovery paths:
    //   a) If we have a vision-derived character description: rebuild the
    //      prompt as text-to-image with the vision description providing
    //      the character source. The output won't match the image as
    //      tightly but identity is anchored textually.
    //   b) If no vision description: bail out (return enabled:false).
    //      Generating an unrelated character turnaround would mislead
    //      downstream — better to fail clean and let the SV-disabled
    //      fallback in generateLongVideo handle it.
    toolWarn(`⚠️ Super Visual: image-to-image 失败（${edit.error.slice(0, 200)}）。`);
    if (!visionDescription) {
      const errorText = `image-to-image failed and no vision description available; refusing to fabricate an unrelated turnaround. Detail: ${edit.error.slice(0, 200)}`;
      if (/HTTP 5\d\d|upstream_error|rate.?limit|429|timeout|timed out|aborted/i.test(edit.error)) markRelaySick(edit.error);
      toolWarn(`⚠️ Super Visual: 没有 vision-describe 兜底，跳过 text-to-image fallback（避免生成与原图无关的角色）。`);
      return {
        enabled: false,
        reason: errorText,
        inputIsRealPerson: inputLooksRealPerson,
        resolvedUserImagePaths: userInputs.length > 0 ? userInputs : undefined,
      };
    }
    toolLog(`🛟 Super Visual: 用 vision-describe 文字身份重建 text-to-image prompt 后回退。`);
  }

  // Mode B: text-to-image via the existing provider helper.
  // Rebuild the prompt for text-to-image mode (no attached input image).
  // When we have a vision description from the user's image, fold it into
  // the text-only prompt as the character source.
  const textOnlyPrompt = useEditMode
    ? buildSuperVisualCharacterTurnaroundPrompt({
        title: options.title,
        story: options.story,
        ratio: options.ratio,
        referenceNotes: options.action.referenceNotes,
        continuity: options.action.continuity,
        withUserImageInput: false,
        visionDescription: visionDescription ?? undefined,
        style: userStyle ?? 'auto',
        inputLooksRealPerson,
      })
    : prompt;
  if (useEditMode) await writeFile(promptPath, textOnlyPrompt, 'utf8');
  const imageProvider = await createVisualProvider(imageConfigured.config, 'image');
  const result = await imageProvider.generateImage({
    prompt: textOnlyPrompt,
    model: resolvedImageModel,
    size: 'landscape',
    quality: 'high',
    outputFormat: 'png',
    background: 'opaque',
    count: 1,
  });
  if (!result.success || !result.assetPath) {
    const errorText = result.error ?? 'no image returned';
    if (/HTTP 5\d\d|upstream_error|rate.?limit|429/i.test(errorText)) {
      markRelaySick(errorText);
    }
    toolWarn(`⚠️ Super Visual: 角色三视图生成失败 — ${errorText}。Saga 将改用用户原图作为身份锚。`);
    return {
      enabled: false,
      reason: `Image-2 character turnaround generation failed: ${errorText}`,
      inputIsRealPerson: inputLooksRealPerson,
      resolvedUserImagePaths: userInputs.length > 0 ? userInputs : undefined,
    };
  }
  const referenceImagePath = imageReferenceArtifactPath(options.projectDir, result.assetPath);
  await writeFile(referenceImagePath, await readFile(result.assetPath));
  toolLog(`✅ Super Visual: 角色三视图就绪（text-to-image fallback）→ ${referenceImagePath}`);
  return {
    enabled: true,
    provider: describeVisualProvider(imageConfigured.config, 'image'),
    model: resolvedImageModel,
    referenceImagePath,
    promptPath,
    sourceAssetPath: result.assetPath,
    mode: 'text-to-image',
    userImagesUsed: 0,
    reason: useEditMode
      ? `generated character turnaround text-to-image (image edit fallback) via ${describeVisualProvider(imageConfigured.config, 'image')}`
      : `generated character turnaround text-to-image via ${describeVisualProvider(imageConfigured.config, 'image')}`,
    inputIsRealPerson: inputLooksRealPerson,
  };
}

// ─── Per-segment opening keyframe ─────────────────────────────────────────

export type SegmentKeyframeResult =
  | { ok: true; framePath: string; promptPath: string; mode: 'image-to-image' | 'text-to-image' }
  | { ok: false; reason: string };

export async function generateSegmentKeyframe(options: {
  context: ToolExecutionContext;
  projectDir: string;
  ratio: string;
  shotIndex: number;
  shotCount: number;
  shot: {
    title?: string;
    storyBeat?: string;
    visualPrompt?: string;
    camera?: string;
    continuity?: string;
  };
  turnaroundPath: string;
  // Previous segment's actual last frame (extracted from BytePlus output)
  // for relay chaining. When supplied, the keyframe edit call gets two
  // input images: turnaround (identity) + prev last frame (scene continuity).
  previousLastFramePath?: string;
  // When true, the user's source image was detected as (or conservatively
  // assumed to be) a real person. The keyframe must enforce a strong
  // original user reference looked like a real person. This is used only for
  // logging / safety fallbacks; segment keyframes intentionally keep the
  // saga-cookie-beach formula (VISUAL TRUTH + safe turnaround + mild style
  // inheritance) instead of forcing anime/illustrated output.
  realPersonInput?: boolean;
  // Identity-locking signals from the world model — passed through to the
  // keyframe prompt so segments 2..N keep the same accessories, occlusions,
  // wardrobe, marks, locked props, and project-specific continuity rules.
  // Each list is optional and dynamic — extracted by the LLM analyst from
  // the user's content. No hardcoded examples.
  accessoriesLock?: string[];
  occlusionLock?: string[];
  permanentWardrobe?: string[];
  distinguishingMarks?: string[];
  identityLockedProps?: string[];
  continuityRules?: string[];
  exclusions?: string[];
  // SPATIAL REALITY pass-through (from world-model) so per-segment keyframe
  // poses respect 3D contact / causality / occlusion rules.
  groundSurface?: string;
  waterLine?: string;
  perspectiveCues?: string;
  physicsRules?: string[];
  forbiddenSpatialErrors?: string[];
}): Promise<SegmentKeyframeResult> {
  const imageConfigured = await resolveConfiguredVisualProvider(options.context.cwd, 'image');
  if (!imageConfigured) return { ok: false, reason: 'image provider not configured' };
  const resolvedImageModel = imageConfigured.model || imageConfigured.config.image.model || 'gpt-image-2';
  if (!isOpenAIGptImage2(imageConfigured.config.image.provider, resolvedImageModel)) {
    return { ok: false, reason: 'image provider is not OpenAI gpt-image-2' };
  }

  const superVisualDir = path.join(options.projectDir, 'super-visual');
  await mkdir(superVisualDir, { recursive: true });

  const turnaroundExists = await fileExists(options.turnaroundPath);
  const prevLastExists = options.previousLastFramePath
    ? await fileExists(options.previousLastFramePath)
    : false;
  // Re-load the vision description that the turnaround stage saved to disk
  // (if any) so this keyframe also gets the textual identity anchor.
  // GOLDEN PATH (saga-cookie-beach): every segment keyframe prompt carries
  // VISUAL TRUTH. If the file is missing (old run, transient vision failure,
  // or provided-turnaround path), attempt to regenerate it before building
  // the prompt instead of falling into an unanchored / hard-stylized path.
  let visionDescription: string | undefined;
  const visionPath = path.join(superVisualDir, 'character-vision-description.txt');
  try {
    const content = await readFile(visionPath, 'utf8');
    if (content.trim()) visionDescription = content.trim();
  } catch {
    // Try to restore VISUAL TRUTH from the safe turnaround itself. This keeps
    // downstream segment prompts in the same grounded mode as the original
    // successful saga-cookie-beach pipeline even when the initial describe
    // call failed or a user supplied a prebuilt turnaround.
    const describeSource = turnaroundExists ? options.turnaroundPath : undefined;
    if (describeSource) {
      const restored = await describeUserImageWithVision({
        imagePath: describeSource,
        context: options.context,
      });
      if (restored?.trim()) {
        visionDescription = restored.trim();
        await writeFile(visionPath, visionDescription, 'utf8');
        toolLog('🎨 Super Visual: 已为分段关键帧补写 VISUAL TRUTH（character-vision-description.txt）');
      } else if (options.realPersonInput) {
        toolWarn('⚠️ Super Visual: realPersonInput=true 但无法恢复 VISUAL TRUTH；将继续使用安全三视图与温和风格继承，不再强制漫画化关键帧。');
      }
    }
  }
  const withPreviousLastFrame = turnaroundExists && prevLastExists;

  const prompt = buildSegmentKeyframePrompt({
    shotIndex: options.shotIndex,
    shotCount: options.shotCount,
    shot: options.shot,
    ratio: options.ratio,
    withPreviousLastFrame,
    visionDescription,
    accessoriesLock: options.accessoriesLock,
    occlusionLock: options.occlusionLock,
    permanentWardrobe: options.permanentWardrobe,
    distinguishingMarks: options.distinguishingMarks,
    identityLockedProps: options.identityLockedProps,
    continuityRules: options.continuityRules,
    exclusions: options.exclusions,
    groundSurface: options.groundSurface,
    waterLine: options.waterLine,
    perspectiveCues: options.perspectiveCues,
    physicsRules: options.physicsRules,
    forbiddenSpatialErrors: options.forbiddenSpatialErrors,
    realPersonInput: options.realPersonInput,
  });
  const promptPath = path.join(superVisualDir, `segment-${String(options.shotIndex).padStart(3, '0')}-keyframe.prompt.txt`);
  await writeFile(promptPath, prompt, 'utf8');

  const apiKey = imageConfigured.config.image.apiKey?.trim();
  const baseUrl = imageConfigured.config.image.baseUrl?.trim();

  if (apiKey && baseUrl && turnaroundExists) {
    // Order matters — turnaround first (identity), prev-last-frame second
    // (scene handoff). The prompt explicitly references this order.
    // When skipPrevFrame is true, only turnaround is fed — no photoreal
    // frame to bias gpt-image-2 toward photorealism.
    const inputImagePaths = withPreviousLastFrame
      ? [options.turnaroundPath, options.previousLastFramePath!]
      : [options.turnaroundPath];
    const edit = await withTimeout(
      postOpenAIImageEdit({
        baseUrl,
        apiKey,
        model: resolvedImageModel,
        prompt,
        inputImagePaths,
        size: options.ratio === '9:16' ? '1024x1536' : options.ratio === '1:1' ? '1024x1024' : '1536x1024',
        quality: 'high',
      }),
      SEGMENT_KEYFRAME_EDIT_TIMEOUT_MS,
      'segment keyframe image edit',
    ).catch((error) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (edit.ok) {
      const framePath = segmentKeyframePath(options.projectDir, options.shotIndex);
      await writeFile(framePath, edit.buffer);
      return { ok: true, framePath, promptPath, mode: 'image-to-image' };
    }
    // edit failed — fall through to text-to-image
  }

  // Fallback: text-to-image (loses identity lock — surface as warning).
  const imageProvider = await createVisualProvider(imageConfigured.config, 'image');
  const result = await imageProvider.generateImage({
    prompt,
    model: resolvedImageModel,
    size: options.ratio === '9:16' ? 'portrait' : options.ratio === '1:1' ? 'square' : 'landscape',
    quality: 'high',
    outputFormat: 'png',
    background: 'opaque',
    count: 1,
  });
  if (!result.success || !result.assetPath) {
    return { ok: false, reason: `keyframe generation failed: ${result.error ?? 'no image returned'}` };
  }
  const framePath = segmentKeyframePath(options.projectDir, options.shotIndex);
  await writeFile(framePath, await readFile(result.assetPath));
  return { ok: true, framePath, promptPath, mode: 'text-to-image' };
}
