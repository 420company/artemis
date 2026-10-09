import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { SagaContinuityBible, SagaSegmentInput } from './types.js';
import { resolveFfmpegBinaryPath, resolveFfprobeBinaryPath } from './concat.js';
import { buildSagaDialogueNote, extractSagaDialogueLines } from '../sagaLanguageDirector.js';

const execFileAsync = promisify(execFile);

// Continuity engine v2.
//
// Two execution modes selected automatically based on the provider's
// capabilities:
//
//  - "strong-vision" — provider accepts image references. Saga extracts the
//    last frame of segment N and feeds it to segment N+1 as a referenceImage.
//    A continuity card is still injected but the visual handoff
//    carries most of the load.
//
//  - "text-only" — provider rejects image refs. Saga compensates with
//    stronger verbal anchoring:
//      • repeat the character identity card near the head/tail
//      • inline concrete colors/materials when supplied
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
  /**
   * Permanent accessories that must appear on the protagonist in EVERY shot
   * (eye mask, sunglasses, headscarf, signature jewelry, etc.). Emitted as
   * a dedicated [ACCESSORY-LOCK] bracket block in the bible, BEFORE
   * LOCKED-PROPS, so it survives the source-story 1600-char truncation and
   * gets stronger weight than a generic prop mention.
   */
  accessoriesLock?: string[];
  /**
   * User's subtitle preference. When 'off' the NEGATIVE block is hardened
   * with extra constraints (no rendered text of quoted phrases, no song
   * lyric overlay, no on-screen English text labels) to prevent the video
   * model from spontaneously rendering quoted prompt fragments as on-screen
   * text. When 'always' the default "no subtitles" entry is removed so the
   * model is allowed to render dialogue captions.
   */
  subtitleMode?: 'auto' | 'always' | 'off';
};

function compactSourceStoryForBible(story: string | undefined): string {
  const normalized = (story ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const maxChars = 12000;
  if (normalized.length <= maxChars) return normalized;

  const head = normalized.slice(0, Math.floor(maxChars * 0.72));
  const tail = normalized.slice(-Math.floor(maxChars * 0.24));
  return `${head} … [SOURCE STORY CONTINUES; middle compacted only for continuity-bible size, segment storyBeats remain authoritative] … ${tail}`;
}

// Trim per-segment material out of the source story before it gets embedded
// in every per-segment prompt's continuity bible. The bible should carry
// GLOBAL context — overall narrative, picture specs, global tone, character
// lock, audio intent — not segment 17's dialogue or segment 6's bullet-time
// description, because those leak into segments 1/2/3 and the video model
// happily renders them where they don't belong (dialogue in segment 1,
// "slow motion" mood inside a brisk-pace shot, etc.). The per-segment
// storyBeat is already the authoritative spec for what to render IN this
// segment; the bible only needs the global wrapper.
//
// Strategy: keep everything before the FIRST `[N-M秒]` / `[N:NN-N:NN]` /
// `Scene N` / `段 N` style segment marker. That's where users put global
// notes. Everything after the first marker is per-segment material that
// belongs in its own segment's storyBeat (which already carries it). If
// the brief has no separating markers at all, fall back to the full text
// (legacy behaviour for unstructured briefs).
function extractGlobalContextFromStory(story: string | undefined): string {
  const raw = story ?? '';
  if (!raw) return '';
  const markerRe = /(?:\[\s*\d+(?::\d{2})?\s*[-–—~至到]\s*\d+(?::\d{2})?\s*(?:秒|s|sec|seconds)?\s*\])|(?:(?:^|\n)\s*(?:scene|shot|segment)\s*#?\d+\b)|(?:(?:^|\n)\s*(?:镜头|段)\s*\d+\s*[·.、:：-])|(?:(?:^|\n)\s*第\s*\d+\s*段)/i;
  const match = raw.match(markerRe);
  if (!match || typeof match.index !== 'number') {
    // No per-segment markers — brief is unstructured, fall back to the full
    // story so narrative context still reaches the bible (legacy behaviour).
    return raw;
  }
  const prefix = raw.slice(0, match.index).trim();
  // Even if the global prefix is tiny, prefer it over the full story: the
  // whole point of this trim is to stop per-segment material from leaking,
  // and bible.bible is allowed to be sparse — the identity card and per-
  // segment storyBeat carry the rest.
  return prefix;
}

// Build the NEGATIVE block, hardened against the on-screen-text failure mode
// when the user explicitly said "no subtitles" (and conversely loosened when
// they want subtitles rendered).
function buildNegativeBlock(subtitleMode: 'auto' | 'always' | 'off' | undefined): string {
  const baseEntries = [
    'no identity or wardrobe drift for recurring characters',
    'no accidental jump cuts inside continuous scenes',
    'no flicker',
    'no warped anatomy',
    'no melting objects',
    'no logos',
    'no UI',
    'no watermark',
  ];
  const subtitleEntries = subtitleMode === 'always'
    // User wants subtitles — keep "no readable text" off the list so dialogue
    // captions can render; the AESTHETIC-LOCK still discourages garbled text.
    ? []
    : subtitleMode === 'off'
      // Defense in depth: explicitly forbid the failure mode where the model
      // renders quoted prompt fragments (section headers, song lyrics, brand
      // names) as on-screen text.
      ? [
        'no readable text',
        'no subtitles',
        'no captions of any quoted phrase',
        'no rendered song lyrics',
        'no on-screen English text labels',
        'no section headers rendered as text',
      ]
      : ['no readable text', 'no subtitles'];
  return `[NEGATIVE: ${[...baseEntries, ...subtitleEntries].join(', ')}]`;
}

// Heuristic: does the brief explicitly request a locked-off / no-motion
// camera? Honoured to override the default cameraLanguage so the [CAMERA]
// directive in the continuity bible doesn't contradict the user's intent.
export function detectsLockOffCamera(story: string | undefined): boolean {
  if (!story) return false;
  const text = story.toLowerCase();
  if (/locked[-\s]?off\s*tripod|no\s+(?:pan|tilt|zoom|dolly|handheld)/i.test(text)) return true;
  if (/锁死.{0,6}(?:机位|三脚架|镜头)|完全锁死|镜头钉死|无任何镜头运动|no\s+camera\s+movement/i.test(story)) return true;
  return false;
}

// Heuristic: does the brief say "AI should generate environmental audio only"?
// Triggered by post-production music intent statements. When true, emit an
// [AUDIO-LOCK] block to stop the video model from hallucinating BGM / music /
// vocals — those are user's post-production overlays, NOT for AI to invent.
// Generic — works for any brief that signals "music is post, not AI".
export function detectsEnvironmentalAudioOnly(story: string | undefined): boolean {
  if (!story) return false;
  // Chinese signals
  if (/(?:音乐|BGM|配乐|soundtrack)[^。\n]{0,30}(?:后期|后期叠加|后期叠|post[-\s]?prod)/i.test(story)) return true;
  if (/(?:后期|后期叠加|post[-\s]?prod)[^。\n]{0,30}(?:音乐|BGM|配乐|soundtrack)/i.test(story)) return true;
  if (/只出环境音|仅环境音|只生成环境音|AI[^。\n]{0,20}(?:只出|仅出|只生成)[^。\n]{0,10}环境音/i.test(story)) return true;
  if (/不要\s*(?:BGM|配乐|背景音乐|音乐)|无\s*(?:BGM|背景音乐|配乐)|no\s+(?:bgm|music|soundtrack|instrumental)/i.test(story)) return true;
  // English signals
  // "ambience only", "ambient rain sounds only" — not "ambient light only".
  if (/environmental\s+(?:audio|sound)s?\s+only|\bambience\s+only\b|\bambient\b(?:\s+[\w-]+){0,2}?\s+(?:sounds?|audio|noises?)\s+only\b/i.test(story)) return true;
  // "music and dialogue are layered in post", "all music is added in post-production".
  if (/\b(?:music|bgm|score|soundtrack)\b[^.\n]{0,40}\b(?:added|overlaid|overlayed|layered|mixed|applied|laid)\b\s+(?:in\s+)?post(?:[-\s]?production)?\b/i.test(story)) return true;
  if (/\b(?:overlay|add|layer|mix)\b[^.\n]{0,30}\b(?:music|bgm|score|soundtrack)\b[^.\n]{0,20}\bin\s+post\b/i.test(story)) return true;
  return false;
}

function buildAudioLockBlock(): string {
  return '[AUDIO-LOCK — environmental / diegetic sounds only (footsteps, wind, water, room tone, dialogue). Do NOT synthesize music, songs, scores or humming: the soundtrack is added in post-production.]';
}

/** Longest shot content (beat and visual direction) a segment prompt opens with. */
export const SHOT_CONTENT_MAX_CHARS = 1600;

/** Longest identity card a segment prompt carries. */
export const IDENTITY_CARD_MAX_CHARS = 1200;

/** `fit` re-renders the entry within a given room when the card is still too long. */
type IdentityCardEntry = { text: string; dropRank?: number; fit?: (room: number) => string };

/** Shortest a lock item is cut to before items are left out. */
const MIN_LOCK_ITEM_CHARS = 40;

function clipText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * "[LABEL: a | b | …]" within maxChars: every item is shortened to an equal
 * share first, and items are left out (saying how many) only when even
 * MIN_LOCK_ITEM_CHARS each does not fit.
 */
function lockLine(label: string, items: string[], maxChars: number, separator = ' | '): string {
  const render = (parts: string[], more: number) => `[${label}: ${parts.join(separator)}${more > 0 ? ` (+${more} more)` : ''}]`;
  const full = render(items, 0);
  if (full.length <= maxChars) return full;
  for (let count = items.length; count >= 1; count -= 1) {
    const more = items.length - count;
    const overhead = render(new Array<string>(count).fill(''), more).length;
    const share = Math.floor((maxChars - overhead) / count);
    if (share >= MIN_LOCK_ITEM_CHARS) return render(items.slice(0, count).map((item) => clipText(item, share)), more);
  }
  const line = render(items.slice(0, 1), items.length - 1);
  return `${line.slice(0, Math.max(0, maxChars - 2)).trimEnd()}…]`;
}

/** Optional lines up to this rank go before the characters are shortened. */
const IDENTITY_CARD_OPTIONAL_RANK = 7;

function fitIdentityCard(entries: IdentityCardEntry[], maxChars: number): string {
  let active = entries.map((entry) => ({ ...entry }));
  const render = () => active.map((entry) => entry.text).join('\n');
  const dropUpTo = (maxRank: number) => {
    const droppable = active
      .filter((entry) => entry.dropRank !== undefined && entry.dropRank <= maxRank)
      .sort((a, b) => (a.dropRank ?? 0) - (b.dropRank ?? 0));
    for (const entry of droppable) {
      if (render().length <= maxChars) break;
      active = active.filter((candidate) => candidate !== entry);
    }
  };
  // Re-fit the flexible entries (the characters) into what is left.
  const refit = (floor: number) => {
    for (const entry of active) {
      const overflow = render().length - maxChars;
      if (overflow <= 0 || !entry.fit) continue;
      entry.text = entry.fit(Math.max(floor, entry.text.length - overflow));
    }
  };
  dropUpTo(IDENTITY_CARD_OPTIONAL_RANK);
  refit(240);
  dropUpTo(Number.POSITIVE_INFINITY);
  refit(80);
  const card = render();
  return card.length <= maxChars ? card : `${card.slice(0, maxChars - 1).trimEnd()}…`;
}

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
  const accessoriesLock = uniqueStrings(input.accessoriesLock ?? []);
  const lighting = pickFirstSentence(input.lighting, 'consistent natural cinematic lighting with stable key direction');
  const lockOffCamera = detectsLockOffCamera(input.story);
  const multiCityWalking = /(?:background\s+environment\s+seamlessly\s+cycles\s+through|背景\s*(?:会)?\s*连续穿过\s*4\s*个城市|四城连穿|多城连穿)/i.test(input.story ?? '');
  const cameraDefault = lockOffCamera || multiCityWalking
    ? 'absolutely locked-off tripod, no camera movement whatsoever — no pan, no tilt, no zoom, no dolly, no handheld shake'
    : 'controlled cinematic camera with subtle natural motion appropriate to the scene';
  const cameraLanguage = pickFirstSentence(
    // When the brief explicitly locks the camera, the default wins over
    // user.continuity.cameraLanguage too — directorial defaults shouldn't
    // override a hard user motion lock.
    lockOffCamera
      ? cameraDefault
      : (input.cameraLanguage ?? input.shotCameraNotes?.join('. ')),
    cameraDefault,
  );
  const mood = pickFirstSentence(input.mood, 'grounded cinematic, emotionally consistent across every shot');

  // The identity card leads every segment prompt, so it is kept within
  // IDENTITY_CARD_MAX_CHARS: each lock list has its own cap, and optional
  // lines (palette, mood, camera, lighting, shared notes, props, locations)
  // are dropped, lowest priority first, when the card is still too long.
  const sharedNotes = uniqueStrings(input.shotContinuityNotes ?? []);
  // A camera the brief locks (or states outright) and the audio lock are
  // user instructions, not defaults: they are never dropped, and they sit
  // before NEGATIVE so a cut prompt keeps them too.
  const cameraIsUserLock = lockOffCamera || Boolean(input.cameraLanguage?.trim());
  const identityEntryCandidates: Array<IdentityCardEntry | undefined> = [
    { text: '[SAGA-CONTINUITY-POLICY: every character keeps one identity across the whole video; scenes change only where the story says so]', dropRank: 10 },
    sharedNotes.length > 0 ? { text: lockLine('SHARED-CONTINUITY-NOTES', sharedNotes.slice(0, 6), 180, ' || '), dropRank: 5 } : undefined,
    characters.length > 0
      // Characters come first in the budget: their descriptions are shortened
      // to the room left after optional lines are dropped, before any
      // character is left out.
      ? { text: lockLine('LOCKED-CHARACTERS', characters, 600), fit: (room: number) => lockLine('LOCKED-CHARACTERS', characters, room) }
      : { text: '[CHARACTERS: same exact recurring identity as the previous shot — same face, hair, body, age, ethnicity/species, silhouette, and distinguishing features]' },
    // Dedicated permanent-accessory lock — emitted BEFORE wardrobe/props so
    // it gets visual priority. Items here are part of the protagonist's
    // identity (eye mask, sunglasses, signature jewelry) and must persist
    // across every shot regardless of costume changes.
    accessoriesLock.length > 0
      ? { text: lockLine('ACCESSORY-LOCK — identity-defining, same item, position and color in every shot, never removed, lifted or swapped', accessoriesLock, 300), dropRank: 9 }
      : undefined,
    {
      text: wardrobe.length > 0
        ? lockLine('LOCKED-WARDROBE', wardrobe, 160)
        : '[WARDROBE: same clothing/material cues for recurring characters unless the story explicitly changes costume]',
      // The generic line is the first to go when the characters carry their own wardrobe.
      dropRank: wardrobe.length === 0 && characters.length > 0 ? 6 : 8,
    },
    cameraIsUserLock ? { text: `[CAMERA: ${clipText(cameraLanguage, 160)}]` } : undefined,
    detectsEnvironmentalAudioOnly(input.story) ? { text: buildAudioLockBlock() } : undefined,
    // Generic default lines go first; what the brief states goes last.
    props.length > 0 ? { text: lockLine('LOCKED-PROPS', props, 140), dropRank: 6 } : { text: '[PROPS: no global prop lock; preserve only props that the story treats as recurring]', dropRank: 0 },
    locations.length > 0 ? { text: lockLine('LOCKED-LOCATIONS', locations, 140), dropRank: 7 } : { text: '[LOCATIONS: no global scene lock; maintain scene continuity only when a shot is meant to continue the same place]', dropRank: 0 },
    { text: palette.length > 0 ? lockLine('PALETTE', palette, 100) : '[PALETTE: cohesive cinematic color design, but not identical colors in every shot unless requested]', dropRank: palette.length > 0 ? 3 : 0 },
    { text: `[LIGHTING: ${clipText(lighting, 120)}]`, dropRank: input.lighting?.trim() ? 4 : 0 },
    cameraIsUserLock ? undefined : { text: `[CAMERA: ${clipText(cameraLanguage, 120)}]`, dropRank: 1 },
    { text: `[MOOD: ${clipText(mood, 100)}]`, dropRank: input.mood?.trim() ? 2 : 0 },
    { text: buildNegativeBlock(input.subtitleMode) },
  ];
  const identityEntries = identityEntryCandidates.filter((entry): entry is IdentityCardEntry => Boolean(entry));
  const identityCard = fitIdentityCard(identityEntries, IDENTITY_CARD_MAX_CHARS);

  const bible = [
    'Saga long-form video continuity bible.',
    `Aspect ratio: ${input.ratio}.`,
    'Maintain character/person identity as a global hard rule across generated clips. Preserve face, silhouette, body traits, hair, and recurring wardrobe/material cues unless the user explicitly asks for transformation or multiple identities.',
    'Use selective scene continuity: when a story beat changes location, let the scene change happen deliberately; when the beat continues the same place, preserve the relevant location/environment anchors and visual through-line.',
    `Source story: ${compactSourceStoryForBible(extractGlobalContextFromStory(input.story))}`,
  ].join(' ');

  return {
    identityCard,
    fitIdentityCard: (maxChars: number) => fitIdentityCard(identityEntries, Math.min(IDENTITY_CARD_MAX_CHARS, maxChars)),
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

// Aesthetic-Lock — production-quality anchors appended to every shot's prompt
// tail. Select by subject type: render-engine words help products/props/spaces,
// but can push people toward waxy/CG mannequin skin in chained long-video runs.
const HUMAN_AESTHETIC_LOCK_BLOCK = [
  '[AESTHETIC-LOCK: HUMAN-EDITORIAL]',
  'render: cinematic editorial photography look, natural facial material, organic skin micro-texture, subtle facial texture, realistic makeup texture, practical cinematic lighting, soft but natural skin highlights',
  'medium: 35mm or 50mm cinematic lens feel, Arri Alexa-class color science, subtle film grain, shallow depth of field where appropriate',
  'skin: preserve natural skin variation, avoid overly uniform smoothing, avoid porcelain-smooth surfaces, avoid synthetic CG skin',
  'physics: physically accurate gravity, realistic momentum, weight-aware motion, wind influence on hair and fabric, no time-warp, no frame-skipping artifacts',
  'integrity: anatomically coherent face and body, stable identity, natural eyes, stable hand and finger count, stable wardrobe/material cues for recurring characters and locked props',
  'forbidden: no waxy skin, no plastic skin, no mannequin face, no porcelain doll face, no rubber skin, no over-smoothed beauty filter, no CG-character look, no morphing, no melting, no flickering, no jittering, no extra limbs, no fused or warped fingers, no facial deformation, no garbled text, no readable subtitles, no logos, no UI overlays, no watermarks',
  '[/AESTHETIC-LOCK]',
].join('\n');

const PRODUCT_AESTHETIC_LOCK_BLOCK = [
  '[AESTHETIC-LOCK: PRODUCT-CINEMATIC]',
  'render: premium cinematic product imagery, ultra-high fidelity, UE5 cinematic / Unreal Lumen / Octane render quality, ray-traced reflections, global illumination, volumetric atmospheric light',
  'materials: physically based materials, accurate metal, glass, fabric, liquid, plastic, leather, gemstone, screen glow, polished surfaces, and reflective non-skin materials',
  'lighting: controlled studio lighting, luxury commercial highlights, precise shadow falloff, realistic caustics where appropriate',
  'medium: 50mm / 85mm product lens feel, macro detail, crisp edges, high-end advertising composition, subtle film grain where appropriate',
  'physics: physically accurate gravity, realistic momentum, weight-aware motion, fluid dynamics for liquids, no time-warp, no frame-skipping artifacts',
  'integrity: stable object geometry, accurate product/prop shape, stable material cues, no warped text, no melting objects, no flicker, no garbled text, no subtitles, no unrelated logos, no UI overlays, no watermarks',
  '[/AESTHETIC-LOCK]',
].join('\n');

const MIXED_HUMAN_COMMERCIAL_AESTHETIC_LOCK_BLOCK = [
  '[AESTHETIC-LOCK: MIXED-HUMAN-COMMERCIAL]',
  'human subject: cinematic editorial photography look, natural facial material, organic skin micro-texture, subtle facial texture, realistic makeup texture, soft practical lighting, no waxy skin, no plastic skin, no porcelain doll face, no CG-character skin',
  'environment and props: premium luxury commercial lighting, realistic glass and metal reflections, cinematic neon glow, physically plausible reflections on non-skin materials such as tables, chips, screens, jewelry, signage, vehicles, packaging, and polished surfaces',
  'medium: 35mm or 50mm cinematic lens feel, Arri Alexa-class color science, subtle film grain, shallow depth of field where appropriate',
  'physics: physically accurate gravity, realistic momentum, weight-aware motion, fluid dynamics for liquids, wind influence on hair and fabric, no time-warp, no frame-skipping artifacts',
  'integrity: anatomically coherent human structure, stable face identity, natural eyes, stable hand and finger count, stable wardrobe/material cues, stable prop geometry',
  'forbidden: no mannequin face, no doll-like skin, no rubber skin, no over-smoothed beauty filter, no CG-character look, no morphing, no melting, no flickering, no jittering, no extra limbs, no fused or warped fingers, no facial deformation, no garbled text, no random logos, no UI overlays, no watermarks',
  '[/AESTHETIC-LOCK]',
].join('\n');

type SagaAestheticSubject = 'human' | 'product' | 'mixed';

function detectAestheticSubject(text: string, bible: SagaContinuityBible): SagaAestheticSubject {
  const haystack = [text, bible.characters.join(' '), bible.wardrobe.join(' ')].join(' ').toLowerCase();
  const hasHuman = /(?:\b(?:person|people|human|woman|women|man|men|girl|boy|female|male|actor|actress|model|character|protagonist|portrait|face|skin|body|hair|eyes|lips|hands|dancer|host|hostess)\b|人物|真人|人像|女人|男人|女孩|男孩|女主|男主|角色|模特|演员|美女|脸|面部|皮肤|身体|头发|眼神|红唇|美腿|手指|胸口|锁骨)/i.test(haystack);
  const hasProduct = /(?:\b(?:product|object|prop|vehicle|car|watch|jewelry|gemstone|bottle|perfume|package|packaging|logo|signage|screen|phone|ui|interface|casino|roulette|chips?|cards?|slot|machine|architecture|building|room|interior|bar|table|glass|metal|neon|screen glow)\b|产品|物体|道具|汽车|手表|珠宝|宝石|瓶|香水|包装|标志|logo|招牌|屏幕|手机|界面|赌场|轮盘|筹码|纸牌|老虎机|建筑|室内|吧台|桌|玻璃|金属|霓虹)/i.test(haystack);
  if (hasHuman && hasProduct) return 'mixed';
  if (hasHuman) return 'human';
  return 'product';
}

function aestheticLockBlock(text: string, bible: SagaContinuityBible): string {
  const subject = detectAestheticSubject(text, bible);
  if (subject === 'human') return HUMAN_AESTHETIC_LOCK_BLOCK;
  if (subject === 'mixed') return MIXED_HUMAN_COMMERCIAL_AESTHETIC_LOCK_BLOCK;
  return PRODUCT_AESTHETIC_LOCK_BLOCK;
}

// Style-Lock — a compact restatement of the most lens-shaping anchors. Sits
// near the top of the prompt and is repeated near the tail so the model
// "sees" it twice.
function styleLockBlock(bible: SagaContinuityBible): string {
  const palette = bible.palette.length > 0 ? bible.palette.join(', ') : 'consistent palette across all shots';
  const wardrobe = bible.wardrobe.length > 0 ? bible.wardrobe.join('; ') : 'stable recurring-character wardrobe/material cues unless story changes costume';
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

// Compact aesthetic locks, used when the full block does not fit the
// model's prompt limit.
const COMPACT_AESTHETIC_LOCKS: Record<SagaAestheticSubject, string> = {
  human: '[AESTHETIC-LOCK: HUMAN-EDITORIAL — cinematic editorial photography, natural skin micro-texture, 35/50mm lens feel, subtle film grain; physically plausible motion; stable anatomy, hands and identity; no waxy or plastic skin, no CG look, no morphing, no flicker, no garbled text]',
  product: '[AESTHETIC-LOCK: PRODUCT-CINEMATIC — premium commercial lighting, accurate physically based materials and reflections, crisp stable geometry; physically plausible motion; no warped text, no melting, no flicker, no unrelated logos]',
  mixed: '[AESTHETIC-LOCK: MIXED-HUMAN-COMMERCIAL — natural skin micro-texture with premium commercial light on non-skin materials, 35/50mm lens feel, subtle film grain; stable anatomy, hands, identity and prop geometry; no waxy skin, no CG look, no morphing, no flicker, no garbled text]',
};

function compactStyleLockBlock(): string {
  return '[STYLE-LOCK: keep the palette, lighting, lens feel, wardrobe and mood stated above identical in every shot]';
}

/**
 * One block of a segment prompt. `keep` orders what goes when the prompt is
 * over its limit (lowest first); `compact` is a shorter form tried before the
 * block is left out; `clip` lets the block be cut to the room that is left.
 * Blocks without `keep` are never dropped.
 */
type PromptBlock = { text: string; keep?: number; compact?: string; clip?: boolean };

function renderBlocks(blocks: PromptBlock[]): string {
  return blocks.map((block) => block.text).filter(Boolean).join('\n');
}

/**
 * Fit the blocks within maxChars: clip the clippable ones, then use the
 * compact forms and then leave out blocks, lowest `keep` first. The identity
 * card is re-fitted last, so the shot content, the locks it carries and the
 * negative constraints are never cut off at the end.
 */
function fitPromptBlocks(blocks: PromptBlock[], maxChars: number, refitCard?: { block: PromptBlock; fit: (room: number) => string }): string {
  const active = blocks.map((block) => ({ ...block }));
  const length = () => renderBlocks(active).length;
  const byPriority = active
    .filter((block) => block.keep !== undefined && block.text)
    .sort((a, b) => (a.keep ?? 0) - (b.keep ?? 0));
  for (const block of byPriority) {
    if (length() <= maxChars) break;
    if (!block.clip) continue;
    const room = block.text.length - (length() - maxChars);
    block.text = room >= 160 ? `${block.text.slice(0, room - 1).trimEnd()}…` : '';
  }
  for (const block of byPriority) {
    if (length() <= maxChars) break;
    if (block.compact && block.compact.length < block.text.length) block.text = block.compact;
  }
  for (const block of byPriority) {
    if (length() <= maxChars) break;
    block.text = '';
  }
  const cardIndex = refitCard ? blocks.indexOf(refitCard.block) : -1;
  if (length() > maxChars && refitCard && cardIndex >= 0) {
    const card = active[cardIndex]!;
    card.text = refitCard.fit(Math.max(200, card.text.length - (length() - maxChars)));
  }
  const out = renderBlocks(active);
  return out.length <= maxChars ? out : `${out.slice(0, maxChars - 1).trimEnd()}…`;
}

/** The opening-framing block without its long header and closing reminder. */
function compactOpeningFraming(block: string): string {
  const lines = block.split('\n').filter((line) => line.trim() && !/These positional \/ directional cues/.test(line));
  const cues = lines.filter((line) => /^\s*·/.test(line));
  return ['🎯 OPENING FRAMING (highest priority for the opening frame):', ...cues].join('\n');
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, '').replace(/[“”"「」]/g, '').toLowerCase();
}

/** True when the visual direction only repeats the story beat ("Follow this exact … section: <beat>"). */
function repeatsStoryBeat(visualPrompt: string, storyBeat: string): boolean {
  const visual = normalizeForCompare(visualPrompt);
  const beat = normalizeForCompare(storyBeat);
  if (!visual || !beat) return false;
  return visual.includes(beat.slice(0, Math.min(beat.length, 200)));
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
  cleanDirect?: boolean;
  // High-priority positional / directional directive block assembled by
  // sagaFraming.extractOpeningFraming. Used to be only spliced into the
  // Image-2 KEYFRAME prompt (superVisualMode.buildSegmentKeyframePrompt),
  // but the video model also needs it: without this, the model defaults to
  // "subject centered + walking treadmill + half-body crop" regardless of
  // the brief's `画面左 5% / 中景全身 / RIGHTWARD` instructions buried in
  // the long storyBeat.
  openingFraming?: string;
  /** Story essence and picture specs from the brief's global sections. */
  globalExcerpt?: string;
  /** A shorter excerpt, used when the full one does not fit. */
  globalExcerptCompact?: string;
  /** World-anchor lines (guide §9.9) whose time range covers this segment. */
  worldAnchor?: string;
  /** A shorter world-anchor block (name and first lines), used when the full one does not fit. */
  worldAnchorCompact?: string;
  /**
   * Longest prompt to produce. Lower-priority blocks are shortened or left
   * out to fit; without it every block is emitted in full.
   */
  maxChars?: number;
  /** The user's subtitle choice; with "auto", a segment's own subtitle line may render. */
  subtitleMode?: 'auto' | 'always' | 'off';
  /**
   * "[原样直传]": the segment's text goes as written with only its own
   * dialogue note, no identity card or bible.
   */
  rawPassthrough?: boolean;
  /** One line saying the attached image is the identity reference (raw passthrough). */
  referenceNote?: string;
}): string {
  const authored = options.authoredPrompt?.replace(/\s+/g, ' ').trim();

  // SCENE-PRIORITY block — fixes the "stable final close frame on the phone
  // glow" hijack we observed in v1: the model would treat the closing-frame
  // instruction as the dominant subject for the entire clip.
  const scenePriority = [
    '[SCENE-PRIORITY]',
    `The storyBeat given above dominates ${options.duration} seconds of the clip — full duration.`,
    'The frame-out / transition instructions are LOW-PRIORITY hints describing only the final ~0.5 seconds of the clip.',
    'Do NOT make the closing-frame description the subject of the whole clip. The subject is the storyBeat.',
    '[/SCENE-PRIORITY]',
  ].join('\n');
  const scenePriorityCompact = `[SCENE-PRIORITY: the story beat above fills all ${options.duration} s; transition hints cover only the last ~0.5 s]`;

  const sourceShotText = [authored, options.storyBeat, options.visualPrompt, options.continuity, options.camera, options.title]
    .filter(Boolean)
    .join(' ');
  // Dialogue: only marked lines (guide §3.2). Bare quotes are brand names,
  // concepts, signs or lyrics, never speech.
  const shotLines = extractSagaDialogueLines(sourceShotText);
  const quotedText = shotLines.filter((line) => line.use !== 'subtitle').map((line) => line.text);
  const hasQuotedDialogue = quotedText.length > 0;
  const hasBrandOrReadableText = /(?:logo|brand|wordmark|signage|screen|ui|interface|caption|title card|on[- ]screen text|readable text|品牌|商标|标志|招牌|屏幕|界面|字幕|标题卡|展示文字|可读文字|中文|英文|文字)/i.test(sourceShotText);
  const hasWalkingMotion = /(?:walk|walking|stride|striding|step|stepping|move\s+right|rightward|向右|行走|走路|步态|迈步|穿行)/i.test(sourceShotText);
  const hasPoseConsistencyLanguage = /(?:same\s+pose|same\s+posture|identical\s+pose|hold\s+pose|保持同一姿势|同一姿势|姿势不变|始终保持|不变|locked\s+pose)/i.test(sourceShotText);
  const motionContinuityGuard = hasWalkingMotion && hasPoseConsistencyLanguage
    ? [
        '[MOTION-CONTINUITY DISAMBIGUATION — do not freeze the body]',
        'When the brief says the protagonist keeps the same posture / same gait while walking, interpret it as a continuous natural walking gait cycle with subtle limb swing, weight shift, hip/shoulder counter-rotation, hair/fabric motion, and footfalls across the full shot.',
        'It does NOT mean a still mannequin pose, frozen limbs, a static cutout, or the body locked in one exact frame while only the background changes.',
        'The camera may remain locked-off; the subject must still animate naturally in place/across frame according to the storyBeat.',
        '[/MOTION-CONTINUITY DISAMBIGUATION]',
      ].join('\n')
    : '';
  const dynamicLockLines = [
    options.bible.locations.length > 0 ? `Explicit location anchors extracted from this brief: ${options.bible.locations.join(' | ')}.` : '',
    options.bible.props.length > 0 ? `Explicit prop anchors extracted from this brief: ${options.bible.props.join(' | ')}.` : '',
    options.bible.characters.length > 0 ? `Explicit character / brand-name anchors extracted from this brief: ${options.bible.characters.join(' | ')}.` : '',
    quotedText.length > 0 ? `Quoted dialogue extracted from this brief, preserve verbatim: ${quotedText.map((value) => `“${value}”`).join(' | ')}.` : '',
  ].filter(Boolean);
  const explicitBriefLock = [
    '[EXPLICIT USER BRIEF LOCK — highest priority]',
    'Preserve every explicit location, prop, action, wardrobe, brand name, and quoted dialogue from the storyBeat / visual direction exactly; do not replace them with a generic room, bedroom, cafe, office, or unrelated interior unless the user explicitly asked for that environment.',
    ...dynamicLockLines,
    hasQuotedDialogue ? 'Dialogue rule: quoted text / 对白 is verbatim spoken audio. Keep the original line in quotes for lip-sync; do not translate, summarize, subtitle, or drop it.' : '',
    hasBrandOrReadableText ? 'Brand/text exception: preserve user-specified brand names, screen UI, logo, and requested Chinese display text when the brief explicitly asks for them; avoid only unrelated/random text.' : '',
    '[/EXPLICIT USER BRIEF LOCK]',
  ].filter(Boolean).join('\n');
  const explicitBriefLockCompact = `[EXPLICIT USER BRIEF LOCK: keep every named place, prop, action, wardrobe item${hasBrandOrReadableText ? ', requested sign or screen text' : ''} and marked dialogue exactly as written; never swap in a generic setting]`;

  // The shot's own content opens the prompt, ahead of the identity card and
  // the continuity bible (which repeats the whole source story). A prompt
  // that has to be shortened is cut from its lowest-priority blocks, so the
  // part that differs from shot to shot always survives.
  const shotHeader = `Shot ${options.shotIndex} of ${options.shotCount}, duration ${options.duration} seconds, title: ${options.title}.`;
  const storyBeatText = clipText(options.storyBeat ?? '', SHOT_CONTENT_MAX_CHARS - 400);
  // A timecoded shot's visual direction only repeats its beat; say it once.
  const visualDirection = options.visualPrompt && !repeatsStoryBeat(options.visualPrompt, options.storyBeat ?? '')
    ? `Visual direction: ${clipText(options.visualPrompt, Math.max(400, SHOT_CONTENT_MAX_CHARS - storyBeatText.length))}`
    : '';
  const shotContent: PromptBlock[] = authored
    ? [{ text: clipText(authored, SHOT_CONTENT_MAX_CHARS) }]
    : [
        { text: `Story beat (the dominant subject for the entire ${options.duration}s): ${storyBeatText}` },
        { text: visualDirection, keep: 72 },
      ];
  // Guide §3.5: with subtitles on "auto", a segment that marks a subtitle
  // line asks for that text on screen, so its negatives must not forbid it.
  const segmentShowsSubtitle = (options.subtitleMode ?? 'auto') === 'auto' && shotLines.some((line) => line.use === 'subtitle');
  const cardText = (card: string) => (segmentShowsSubtitle ? card.replace(/, no readable text|, no subtitles(?=[,\]])/g, '') : card);
  const cardBlock: PromptBlock = { text: cardText(options.bible.identityCard) };
  const fitCard = options.bible.fitIdentityCard;
  const refitCard = fitCard ? { block: cardBlock, fit: (room: number) => cardText(fitCard(room)) } : undefined;
  // cleanDirect and raw passthrough skip generate_video's dialogue note, so
  // the segment carries its own (this segment's lines only).
  const dialogueNote = options.cleanDirect || options.rawPassthrough
    ? buildSagaDialogueNote(options.storyBeat ?? '', options.subtitleMode)
    : '';
  const lockedCamera = /locked-off|no camera movement|锁死/i.test(options.camera ?? '');
  // The identity card's [CAMERA] already spells a locked camera out in full.
  const cameraLineCompact = lockedCamera && options.camera
    ? `Camera and motion: ${options.camera.split(/[,，;；—]/)[0]!.trim()} (as in [CAMERA])`
    : undefined;
  const globalBlocks: PromptBlock[] = [
    { text: options.openingFraming ? `\n${options.openingFraming}` : '', compact: options.openingFraming ? `\n${compactOpeningFraming(options.openingFraming)}` : undefined, keep: 90 },
    { text: options.worldAnchor ?? '', compact: options.worldAnchorCompact, keep: 88 },
    { text: options.globalExcerpt ?? '', compact: options.globalExcerptCompact, keep: 80 },
  ];
  const bibleBlock: PromptBlock = { text: options.bible.bible, keep: 5, clip: true };
  const finish = (blocks: PromptBlock[]) => (options.maxChars ? fitPromptBlocks(blocks, options.maxChars, refitCard) : renderBlocks(blocks));

  if (options.rawPassthrough) {
    // The script as written: the segment's own text, its dialogue note and,
    // when the user attached one, a line naming the identity reference.
    return finish([
      { text: dialogueNote, keep: 95 },
      { text: options.referenceNote ?? '', keep: 90 },
      { text: authored ?? (options.storyBeat ?? '').trim() },
    ]);
  }

  if (options.cleanDirect) {
    // cleanDirect strips DIRECTORIAL/AESTHETIC scaffolding (style lock,
    // aesthetic lock, reference-role-separation, default camera/continuity
    // boilerplate, frame-out hint) so the model gets a "raw" prompt.
    // It must NOT drop the hard CONTINUITY locks (identity card, bible,
    // character/accessory/prop/location anchors, explicit user brief lock,
    // scene-priority) — those are correctness rules, not aesthetic dressing,
    // and stripping them caused character/wardrobe/location drift across
    // long-video segments.
    return finish([
      { text: dialogueNote, keep: 95 },
      { text: shotHeader },
      ...shotContent,
      cardBlock,
      ...globalBlocks,
      { text: scenePriority, compact: scenePriorityCompact, keep: 60 },
      { text: explicitBriefLock, compact: explicitBriefLockCompact, keep: 70 },
      { text: options.continuity ? `Continuity requirements: ${options.continuity}` : '', keep: 40 },
      { text: options.camera ? `Camera and motion: ${options.camera}` : '', compact: cameraLineCompact, keep: lockedCamera ? 86 : 50 },
      bibleBlock,
      { text: 'no watermark' },
    ]);
  }

  const styleLock = styleLockBlock(options.bible);
  const withoutSubtitleBans = (text: string) => (segmentShowsSubtitle ? text.replace(/, no (?:readable )?subtitles(?=[,\n\]])/g, '') : text);
  const aestheticLock = withoutSubtitleBans(aestheticLockBlock(sourceShotText, options.bible));
  const aestheticCompact = withoutSubtitleBans(COMPACT_AESTHETIC_LOCKS[detectAestheticSubject(sourceShotText, options.bible)]);

  const blocks: PromptBlock[] = [
    { text: shotHeader },
    ...shotContent,
    cardBlock,
    ...globalBlocks,
    { text: styleLock, compact: compactStyleLockBlock(), keep: 55 },
    { text: scenePriority, compact: scenePriorityCompact, keep: 60 },
    // For text-only providers the previous shot's closing frame is described in words.
    { text: options.mode === 'text-only' && options.startingFrameAnchor ? options.startingFrameAnchor : '', keep: 65 },
    { text: motionContinuityGuard, keep: 35 },
    { text: explicitBriefLock, compact: explicitBriefLockCompact, keep: 70 },
    { text: `Continuity requirements: ${options.continuity}`, keep: 40 },
    { text: `Camera and motion: ${options.camera}`, compact: cameraLineCompact, keep: lockedCamera ? 86 : 50 },
  ];

  if (options.mode === 'strong-vision') {
    blocks.push({
      text: [
        '[REFERENCE-ROLE-SEPARATION]',
        'Use previous-frame references only for spatial continuity, lighting direction, and environment layout. Do not carry a previous scene subject into a new location unless the new storyBeat explicitly keeps that same subject visible. For multi-city walking scenes, preserve the subject identity and general walking rhythm, but let the body travel forward in frame instead of freezing at one position.',
        'Do not inherit waxy skin, plastic highlights, over-smoothed facial material, mannequin faces, or CG-character surface quality from previous generated frames.',
        'When user-supplied reference images are present, treat them as the authority for recurring identity, wardrobe cues, and natural facial/material character.',
        '[/REFERENCE-ROLE-SEPARATION]',
      ].join('\n'),
      compact: '[REFERENCE-ROLE-SEPARATION: reference frames carry identity, layout and light direction only; never inherit waxy or CG skin from them]',
      keep: 30,
    });
  }

  // FRAME-OUT block — explicitly declared as low-priority closing hint, not
  // a subject directive.
  blocks.push({
    text: options.transition
      ? ['[FRAME-OUT (low priority, applies to final ~0.5 seconds only)]', options.transition, '[/FRAME-OUT]'].join('\n')
      : '',
    keep: 25,
  });

  // Text-only mode: re-state character identity anchors at the tail so the model
  // attends to them again. Linguistic redundancy is the #1 lever for
  // text-only continuity.
  if (options.mode === 'text-only') {
    const lockedLines = [
      options.bible.characters.length > 0 ? `locked-characters: ${options.bible.characters.join(' | ')}` : '',
      options.bible.wardrobe.length > 0 ? `locked-wardrobe: ${options.bible.wardrobe.join(' | ')}` : '',
      options.bible.props.length > 0 ? `locked-props: ${options.bible.props.join(' | ')}` : '',
      options.bible.locations.length > 0 ? `locked-locations: ${options.bible.locations.join(' | ')}` : '',
    ].filter(Boolean);
    blocks.push({
      text: [
        '[CONTINUITY-RESTATE — global character identity lock; preserve scene/location only when explicitly continuous]',
        ...lockedLines,
        options.bible.characters.length === 0 ? 'characters: same recurring identity as previous shot; no face/body/silhouette drift' : '',
        options.bible.wardrobe.length === 0 ? 'wardrobe: stable recurring-character clothing/material cues unless story changes costume' : '',
        `lighting: ${options.bible.lighting}`,
        `camera: ${options.bible.cameraLanguage}`,
        `mood: ${options.bible.mood}`,
        '[/CONTINUITY-RESTATE]',
      ].filter(Boolean).join('\n'),
      keep: 15,
    });
    blocks.push({ text: styleLock, keep: 12 }); // second appearance for text-only mode
  }

  blocks.push({
    text: [
      'Write one coherent video generation prompt. English direction is fine, but preserve any quoted dialogue, brand names, and requested on-screen Chinese text in the original language exactly.',
      'The storyBeat is the subject for the entire clip. The frame-out hints describe only the final ~0.5 s.',
      hasBrandOrReadableText
        ? 'Avoid subtitles, watermarks, and unrelated random text; user-specified logo/UI/readable text is allowed and must remain accurate.'
        : 'Avoid subtitles, readable text, logos, UI, and watermarks.',
    ].join(' '),
    keep: 20,
  });

  // The aesthetic lock closes the prompt as the visual quality anchor; the
  // long continuity bible (which repeats the source story) goes before it
  // and is the first thing shortened.
  blocks.splice(blocks.length - 1, 0, bibleBlock);
  blocks.push({ text: aestheticLock, compact: aestheticCompact, keep: 45 });
  return finish(blocks);
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
      await execFileAsync(await resolveFfmpegBinaryPath(), args, { timeout: 60_000 });
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
      await resolveFfprobeBinaryPath(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', options.videoPath],
      { timeout: 30_000 },
    );
    const duration = Number.parseFloat(probe.stdout.trim());
    if (Number.isFinite(duration) && duration > 0.2) {
      const seek = Math.max(0, duration - 0.12).toFixed(2);
      await execFileAsync(
        await resolveFfmpegBinaryPath(),
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
