import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { SagaContinuityBible, SagaSegmentInput } from './types.js';

const execFileAsync = promisify(execFile);

// Continuity engine v2.
//
// Two execution modes selected automatically based on the provider's
// capabilities:
//
//  - "strong-vision" — provider accepts image references. Saga extracts the
//    last frame of segment N and feeds it to segment N+1 as a referenceImage.
//    Identity card is still injected but the visual handoff carries most of
//    the load.
//
//  - "text-only" — provider rejects image refs. Saga compensates with
//    aggressive verbal anchoring:
//      • triple-repeat the identity card (head, mid, tail of the prompt)
//      • inline hex color codes and numerical body attributes
//      • prepend a [STARTING-FRAME-ANCHOR] block derived from the previous
//        shot's `transition` field so the model sees an explicit visual
//        handoff in text
//      • add a Style-Lock block that repeats lighting, lens, and color
//        language verbatim across every shot
//
// The user does NOT configure which mode runs — Saga picks based on
// `limits.referenceInputs.includes('image')`.

export type SagaContinuityMode = 'strong-vision' | 'text-only';

export type SagaBibleInput = {
  story: string;
  ratio: string;
  shotContinuityNotes?: string[];
  shotCameraNotes?: string[];
  characters?: string[];
  wardrobe?: string[];
  props?: string[];
  locations?: string[];
  palette?: string[];
  lighting?: string;
  cameraLanguage?: string;
  mood?: string;
};

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function pickFirstSentence(value: string | undefined, fallback: string): string {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  const match = text.match(/^[^.!?。！？]{0,180}[.!?。！？]?/);
  return (match?.[0] ?? text).slice(0, 180);
}

export function buildContinuityBible(input: SagaBibleInput): SagaContinuityBible {
  const characters = uniqueStrings(input.characters ?? []);
  const wardrobe = uniqueStrings(input.wardrobe ?? []);
  const props = uniqueStrings(input.props ?? []);
  const locations = uniqueStrings(input.locations ?? []);
  const palette = uniqueStrings(input.palette ?? []);
  const lighting = pickFirstSentence(input.lighting, 'consistent natural cinematic lighting with stable key direction');
  const cameraLanguage = pickFirstSentence(
    input.cameraLanguage ?? input.shotCameraNotes?.join('. '),
    'controlled cinematic camera with stable handheld push-ins, locked establishing frames, and gentle dollies',
  );
  const mood = pickFirstSentence(input.mood, 'grounded cinematic, emotionally consistent across every shot');

  const identityLines = [
    '[SAGA-CONTINUITY: same world, same people, same wardrobe, same props, same lighting, same camera language across every shot]',
    characters.length > 0
      ? `[CHARACTERS: ${characters.join(' | ')}]`
      : '[CHARACTERS: same exact identity as the previous shot — same face, hair, body, age, ethnicity]',
    wardrobe.length > 0
      ? `[WARDROBE: ${wardrobe.join(' | ')}]`
      : '[WARDROBE: same exact clothes, same fabric, same colors as the previous shot]',
    props.length > 0
      ? `[PROPS: ${props.join(' | ')}]`
      : '[PROPS: same handheld objects and persistent set pieces as the previous shot]',
    locations.length > 0
      ? `[LOCATIONS: ${locations.join(' | ')}]`
      : '[LOCATIONS: continuous from the previous shot — same architecture, materials, signage, and weather]',
    palette.length > 0
      ? `[PALETTE: ${palette.join(' | ')}]`
      : '[PALETTE: same dominant colors and color temperature as the previous shot]',
    `[LIGHTING: ${lighting}]`,
    `[CAMERA: ${cameraLanguage}]`,
    `[MOOD: ${mood}]`,
    '[NEGATIVE: no identity drift, no wardrobe change, no scene jump, no flicker, no warped anatomy, no melting objects, no readable text, no subtitles, no logos, no UI, no watermark]',
  ];

  const sharedNotes = uniqueStrings(input.shotContinuityNotes ?? []);
  if (sharedNotes.length > 0) {
    identityLines.splice(1, 0, `[SHARED-CONTINUITY-NOTES: ${sharedNotes.slice(0, 6).join(' || ')}]`);
  }

  const identityCard = identityLines.join('\n');

  const bible = [
    'Saga long-form video continuity bible.',
    `Aspect ratio: ${input.ratio}.`,
    'Maintain consistent characters, wardrobe, locations, color palette, lighting direction, material details, and camera language across every generated clip.',
    'When a story beat changes the location, treat the new place as adjacent in the same world — preserve identity, lighting temperature shift, and a clear visual through-line.',
    `Source story: ${input.story.replace(/\s+/g, ' ').trim().slice(0, 1600)}`,
  ].join(' ');

  return {
    identityCard,
    bible,
    characters,
    wardrobe,
    props,
    locations,
    palette,
    lighting,
    cameraLanguage,
    mood,
  };
}

// Aesthetic-Lock — production-quality anchors appended to every shot's
// prompt tail. Distilled from cinematic-prompting practice on DiT-class
// video models (BytePlus Seedance, Kling, Veo, Runway Gen-3, Sora).
// These tokens do double duty:
//   • positive anchors push the model toward photoreal/UE5/IMAX render
//     targets and physically grounded motion
//   • physics-explicit failure-mode anchors ("no morphing / no flickering /
//     no melting / no extra limbs / anatomically correct") guard against
//     the model's most common video artifacts. DiT models are not as
//     responsive to a separate "negative_prompt" channel as SD-class
//     models, so we encode the guards as positive constraints.
const SAGA_AESTHETIC_LOCK_BLOCK = [
  '[AESTHETIC-LOCK]',
  'render: photoreal cinematic image, ultra-high fidelity, UE5 cinematic / Unreal Lumen / Octane render quality, ray-traced reflections, global illumination, subsurface scattering on skin, volumetric atmospheric light',
  'medium: 35mm or 50mm cinematic lens feel, anamorphic-friendly framing, IMAX 70mm film grain texture, Arri Alexa-class color science, shallow depth of field where appropriate',
  'physics: physically accurate gravity, realistic momentum, weight-aware motion, fluid dynamics for liquids, wind influence on hair and fabric, no time-warp, no frame-skipping artifacts',
  'integrity: anatomically correct human structure, stable hand and finger count, identity-locked face, locked wardrobe geometry, materials hold their identity across the clip',
  'forbidden: no morphing, no melting, no flickering, no jittering, no extra limbs, no fused or warped fingers, no facial deformation, no garbled text, no readable subtitles, no logos, no UI overlays, no watermarks',
  '[/AESTHETIC-LOCK]',
].join('\n');

// Style-Lock — a compact restatement of the most lens-shaping anchors. Sits
// near the top of the prompt and is repeated near the tail so the model
// "sees" it twice.
function styleLockBlock(bible: SagaContinuityBible): string {
  const palette = bible.palette.length > 0 ? bible.palette.join(', ') : 'consistent palette across all shots';
  const wardrobe = bible.wardrobe.length > 0 ? bible.wardrobe.join('; ') : 'same wardrobe across shots';
  return [
    '[STYLE-LOCK]',
    `palette: ${palette}`,
    `lighting: ${bible.lighting}`,
    `camera: ${bible.cameraLanguage}`,
    `wardrobe: ${wardrobe}`,
    `mood: ${bible.mood}`,
    '[/STYLE-LOCK]',
  ].join('\n');
}

// Build a textual "starting frame anchor" — for text-only providers we
// derive what the next shot's first frame should look like from the
// previous shot's planner-authored `transition` field. If the planner
// followed the v2 prompt, that field describes the closing pose / framing
// / lighting which the next clip should pick up identically.
export function buildStartingFrameAnchor(options: {
  previousTransition?: string;
  previousCamera?: string;
  previousContinuity?: string;
}): string | null {
  const transition = options.previousTransition?.replace(/\s+/g, ' ').trim();
  if (!transition) return null;
  const lines = [
    '[STARTING-FRAME-ANCHOR — the first frame of THIS clip must match the last frame of the previous clip]',
    `previous-clip-final-frame: ${transition}`,
  ];
  if (options.previousContinuity) {
    lines.push(`previous-clip-continuity: ${options.previousContinuity.slice(0, 280)}`);
  }
  if (options.previousCamera) {
    lines.push(`previous-clip-camera: ${options.previousCamera.slice(0, 200)}`);
  }
  lines.push('[/STARTING-FRAME-ANCHOR]');
  return lines.join('\n');
}

// Compose the FINAL prompt. mode determines whether we lean on text or on
// the chained image reference for visual handoff.
export function compileShotPromptWithContinuity(options: {
  bible: SagaContinuityBible;
  mode: SagaContinuityMode;
  shotIndex: number;
  shotCount: number;
  duration: number;
  title: string;
  storyBeat: string;
  visualPrompt: string;
  camera: string;
  continuity: string;
  transition: string;
  authoredPrompt?: string;
  startingFrameAnchor?: string | null;
}): string {
  const authored = options.authoredPrompt?.replace(/\s+/g, ' ').trim();
  const styleLock = styleLockBlock(options.bible);

  // SCENE-PRIORITY block — fixes the "stable final close frame on the phone
  // glow" hijack we observed in v1: the model would treat the closing-frame
  // instruction as the dominant subject for the entire clip.
  const scenePriority = [
    '[SCENE-PRIORITY]',
    `The storyBeat described below dominates ${options.duration} seconds of the clip — full duration.`,
    'The frame-out / transition instructions are LOW-PRIORITY hints describing only the final ~0.5 seconds of the clip.',
    'Do NOT make the closing-frame description the subject of the whole clip. The subject is the storyBeat.',
    '[/SCENE-PRIORITY]',
  ].join('\n');

  const head = [
    options.bible.identityCard,
    options.bible.bible,
    styleLock,
    scenePriority,
    `Shot ${options.shotIndex} of ${options.shotCount}, duration ${options.duration} seconds, title: ${options.title}.`,
  ];

  // For text-only providers, repeat the most identity-critical line near
  // the top AND near the bottom. Plus inject the starting-frame anchor
  // (which is the planner's previous-shot transition field).
  if (options.mode === 'text-only' && options.startingFrameAnchor) {
    head.push(options.startingFrameAnchor);
  }

  const middle: string[] = [];
  if (authored) {
    middle.push(authored);
  } else {
    middle.push(`Story beat (the dominant subject for the entire ${options.duration}s): ${options.storyBeat}`);
    middle.push(`Visual direction: ${options.visualPrompt}`);
  }
  middle.push(`Continuity requirements: ${options.continuity}`);
  middle.push(`Camera and motion: ${options.camera}`);

  // FRAME-OUT block — explicitly declared as low-priority closing hint, not
  // a subject directive.
  middle.push(
    [
      '[FRAME-OUT (low priority, applies to final ~0.5 seconds only)]',
      options.transition,
      '[/FRAME-OUT]',
    ].join('\n'),
  );

  const tail: string[] = [];

  // Text-only mode: re-state identity anchors at the tail so the model
  // attends to them again. Linguistic redundancy is the #1 lever for
  // text-only continuity.
  if (options.mode === 'text-only') {
    tail.push(
      [
        '[CONTINUITY-RESTATE — same person, same wardrobe, same props, same lighting, same camera language as the previous shot]',
        options.bible.characters.length > 0 ? `characters: ${options.bible.characters.join(' | ')}` : '',
        options.bible.wardrobe.length > 0 ? `wardrobe: ${options.bible.wardrobe.join(' | ')}` : '',
        options.bible.props.length > 0 ? `props: ${options.bible.props.join(' | ')}` : '',
        '[/CONTINUITY-RESTATE]',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    tail.push(styleLock); // second appearance for text-only mode
  }

  tail.push(
    'Write one coherent video generation prompt in polished English. The storyBeat is the subject for the entire clip. The frame-out hints describe only the final ~0.5 s. Avoid subtitles, readable text, logos, UI, and watermarks.',
  );

  // Aesthetic lock is the very last block so it survives token truncation
  // on lower-context providers and serves as the visual quality anchor.
  tail.push(SAGA_AESTHETIC_LOCK_BLOCK);

  return [...head, ...middle, ...tail].join('\n');
}

// Extract the LAST frame of a finished segment as a PNG. This frame becomes
// the start-frame anchor for the next segment via image-to-video conditioning.
export async function extractLastFrame(options: {
  videoPath: string;
  outputPath: string;
}): Promise<{ ok: true; framePath: string } | { ok: false; error: string }> {
  try {
    await stat(options.videoPath);
  } catch {
    return { ok: false, error: `source video not found: ${options.videoPath}` };
  }

  const tryArgs: string[][] = [
    ['-y', '-sseof', '-0.1', '-i', options.videoPath, '-update', '1', '-frames:v', '1', '-q:v', '2', options.outputPath],
    ['-y', '-sseof', '-0.4', '-i', options.videoPath, '-update', '1', '-frames:v', '1', '-q:v', '2', options.outputPath],
  ];

  let lastError = '';
  for (const args of tryArgs) {
    try {
      await execFileAsync('ffmpeg', args, { timeout: 60_000 });
      const info = await stat(options.outputPath);
      if (info.size > 1024) {
        return { ok: true, framePath: options.outputPath };
      }
      lastError = `produced empty frame (${info.size} bytes)`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  try {
    const probe = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', options.videoPath],
      { timeout: 30_000 },
    );
    const duration = Number.parseFloat(probe.stdout.trim());
    if (Number.isFinite(duration) && duration > 0.2) {
      const seek = Math.max(0, duration - 0.12).toFixed(2);
      await execFileAsync(
        'ffmpeg',
        ['-y', '-ss', seek, '-i', options.videoPath, '-frames:v', '1', '-q:v', '2', options.outputPath],
        { timeout: 60_000 },
      );
      const info = await stat(options.outputPath);
      if (info.size > 1024) {
        return { ok: true, framePath: options.outputPath };
      }
      lastError = `fallback frame too small (${info.size} bytes)`;
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  return { ok: false, error: `extractLastFrame failed: ${lastError}` };
}

export function chainFramePathFor(segment: SagaSegmentInput, projectDir: string): string {
  const number = String(segment.index).padStart(3, '0');
  return path.join(projectDir, 'segments', `${number}.last-frame.png`);
}

// Decide which continuity mode to run based on provider capabilities.
export function pickContinuityMode(options: {
  providerSupportsImageRef: boolean;
  userOverride?: SagaContinuityMode;
}): SagaContinuityMode {
  if (options.userOverride) return options.userOverride;
  return options.providerSupportsImageRef ? 'strong-vision' : 'text-only';
}
