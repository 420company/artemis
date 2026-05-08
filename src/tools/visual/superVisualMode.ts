import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
let relaySickUntil = 0;
function isRelaySick(): boolean { return Date.now() < relaySickUntil; }
function markRelaySick(reason: string): void {
  relaySickUntil = Date.now() + RELAY_SICK_COOLDOWN_MS;
  toolWarn(`⚠️ Super Visual: 标记 image relay 为 sick（10 分钟内跳过三视图生成）— 原因: ${reason.slice(0, 160)}`);
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
      mode: 'image-to-image' | 'text-to-image';
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

async function readImageAsBlob(filePath: string): Promise<{ blob: Blob; filename: string }> {
  const buffer = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/png';
  // Convert Node Buffer → ArrayBuffer for Blob.
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  return {
    blob: new Blob([ab], { type }),
    filename: path.basename(filePath),
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
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
        const { blob, filename } = await readImageAsBlob(filePath);
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
        const downloaded = await fetch(item.url);
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

export async function describeUserImageWithVision(options: {
  imagePath: string;
  context: ToolExecutionContext;
}): Promise<string | null> {
  // Resolve the chat/vision endpoint from the user's MAIN profile first;
  // only fall back to the image-provider's relay when no main profile is
  // configured. (Some users put main and image on different relays;
  // assuming they share fails silently.)
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let chatModel = 'gpt-5.5';
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
  if (!apiKey || !baseUrl) {
    const imageConfigured = await resolveConfiguredVisualProvider(options.context.cwd, 'image');
    if (!imageConfigured) return null;
    apiKey = imageConfigured.config.image.apiKey?.trim();
    baseUrl = imageConfigured.config.image.baseUrl?.trim();
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
    model: chatModel,
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

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const text = await res.text();
    let parsed: { choices?: Array<{ message?: { content?: unknown } }> };
    try { parsed = JSON.parse(text); } catch { return null; }
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const trimmed = content.replace(/\s+/g, ' ').trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
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
  hasUserImageReference: boolean;
}): Promise<SuperVisualModeResult> {
  if (options.action.superVisualMode === 'off') {
    return { enabled: false, reason: 'disabled by request' };
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
        ? (visionRealHit ? 'illustrated (auto · 真人输入 → 改插画风以避开内容过滤)' : 'photoreal (auto · 输入已是非真人风格)')
        : 'illustrated (auto · vision 不可用 → 保守默认插画以避免后续被内容过滤拦截)';
    toolLog(`🎨 Super Visual: 角色三视图风格 = ${effectiveStyle}`);
  }
  const promptPath = path.join(superVisualDir, 'character-turnaround.prompt.txt');
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
      if (/HTTP 5\d\d|upstream_error|rate.?limit|429/i.test(edit.error)) markRelaySick(edit.error);
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
    toolWarn(`⚠️ Super Visual: 角色三视图生成失败 — ${errorText}。Saga 将改用用户原图作为身份锚（可能触发视频生成 API 的内容过滤导致每段重试）。`);
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
  const withPreviousLastFrame = turnaroundExists && prevLastExists;

  // Re-load the vision description that the turnaround stage saved to disk
  // (if any) so this keyframe also gets the textual identity anchor.
  let visionDescription: string | undefined;
  try {
    const visionPath = path.join(superVisualDir, 'character-vision-description.txt');
    const content = await readFile(visionPath, 'utf8');
    if (content.trim()) visionDescription = content.trim();
  } catch {
    // no vision description file — that's OK, prompt just omits the section
  }

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
  });
  const promptPath = path.join(superVisualDir, `segment-${String(options.shotIndex).padStart(3, '0')}-keyframe.prompt.txt`);
  await writeFile(promptPath, prompt, 'utf8');

  const apiKey = imageConfigured.config.image.apiKey?.trim();
  const baseUrl = imageConfigured.config.image.baseUrl?.trim();

  if (apiKey && baseUrl && turnaroundExists) {
    // Order matters — turnaround first (identity), prev-last-frame second
    // (scene handoff). The prompt explicitly references this order.
    const inputImagePaths = withPreviousLastFrame
      ? [options.turnaroundPath, options.previousLastFramePath!]
      : [options.turnaroundPath];
    const edit = await postOpenAIImageEdit({
      baseUrl,
      apiKey,
      model: resolvedImageModel,
      prompt,
      inputImagePaths,
      size: options.ratio === '9:16' ? '1024x1536' : options.ratio === '1:1' ? '1024x1024' : '1536x1024',
      quality: 'high',
    });
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
