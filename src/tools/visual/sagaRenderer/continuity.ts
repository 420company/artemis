import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { SagaContinuityBible, SagaSegmentInput } from './types.js';
import { resolveFfmpegBinaryPath, resolveFfprobeBinaryPath } from './concat.js';

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
  const markerRe = /(?:\[\s*\d+(?::\d{2})?\s*[-–—~至到]\s*\d+(?::\d{2})?\s*(?:秒|s|sec|seconds)?\s*\])|(?:(?:^|\n)\s*(?:scene|shot|segment)\s*#?\d+\b)|(?:(?:^|\n)\s*(?:镜头|段)\s*\d+\s*[·.、:：\-])|(?:(?:^|\n)\s*第\s*\d+\s*段)/i;
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
    'no character identity drift',
    'no unintended wardrobe drift for recurring characters',
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
  if (/environmental\s+(?:audio|sound)s?\s+only|ambient\s+(?:audio|sound)s?\s+only/i.test(story)) return true;
  if (/(?:music|score|soundtrack)\s+(?:is|are)\s+(?:added|overlaid|applied)\s+(?:in\s+)?post/i.test(story)) return true;
  return false;
}

function buildAudioLockBlock(): string {
  return '[AUDIO-LOCK — strict: emit environmental / diegetic sounds only (footsteps, wind, traffic, water, ambient room tone, voice if dialogue is present). Do NOT synthesize music, songs, instrumental backing tracks, scores, melodies, humming, or vocal performance. The user is overlaying music in post-production; AI-generated music here would conflict with the planned soundtrack.]';
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
  const cameraDefault = lockOffCamera
    ? 'absolutely locked-off tripod, no camera movement whatsoever — no pan, no tilt, no zoom, no dolly, no handheld shake'
    : 'controlled cinematic camera with stable handheld push-ins, locked establishing frames, and gentle dollies';
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

  const identityLines = [
    '[SAGA-CONTINUITY-POLICY: character/person identity is globally locked across the long video; scene/location continuity is selective and follows the user request/story logic]',
    characters.length > 0
      ? `[LOCKED-CHARACTERS: ${characters.join(' | ')}]`
      : '[CHARACTERS: same exact recurring identity as the previous shot — same face, hair, body, age, ethnicity/species, silhouette, and distinguishing features]',
    // Dedicated permanent-accessory lock — emitted BEFORE wardrobe/props so
    // it gets visual priority. Items here are part of the protagonist's
    // identity (eye mask, sunglasses, signature jewelry) and must persist
    // across every shot regardless of costume changes.
    accessoriesLock.length > 0
      ? `[ACCESSORY-LOCK — IDENTITY-DEFINING — these items are part of the protagonist's identity and MUST appear unchanged in every single shot, same position, same color, same style, NEVER removed, NEVER lifted, NEVER swapped, NEVER repositioned: ${accessoriesLock.join(' | ')}]`
      : '',
    wardrobe.length > 0
      ? `[LOCKED-WARDROBE: ${wardrobe.join(' | ')}]`
      : '[WARDROBE: same clothing/material cues for recurring characters unless the story explicitly changes costume]',
    props.length > 0
      ? `[LOCKED-PROPS: ${props.join(' | ')}]`
      : '[PROPS: no global prop lock; preserve only props that the story treats as recurring]',
    locations.length > 0
      ? `[LOCKED-LOCATIONS: ${locations.join(' | ')}]`
      : '[LOCATIONS: no global scene lock; maintain scene continuity only when a shot is meant to continue the same place]',
    palette.length > 0
      ? `[PALETTE: ${palette.join(' | ')}]`
      : '[PALETTE: cohesive cinematic color design, but not identical colors in every shot unless requested]',
    `[LIGHTING: ${lighting}]`,
    `[CAMERA: ${cameraLanguage}]`,
    `[MOOD: ${mood}]`,
    buildNegativeBlock(input.subtitleMode),
    detectsEnvironmentalAudioOnly(input.story) ? buildAudioLockBlock() : '',
  ];

  const sharedNotes = uniqueStrings(input.shotContinuityNotes ?? []);
  if (sharedNotes.length > 0) {
    identityLines.splice(1, 0, `[SHARED-CONTINUITY-NOTES: ${sharedNotes.slice(0, 6).join(' || ')}]`);
  }

  const identityCard = identityLines.filter(Boolean).join('\n');

  const bible = [
    'Saga long-form video continuity bible.',
    `Aspect ratio: ${input.ratio}.`,
    'Maintain character/person identity as a global hard rule across generated clips. Preserve face, silhouette, body traits, hair, and recurring wardrobe/material cues unless the user explicitly asks for transformation or multiple identities.',
    'Use selective scene continuity: when a story beat changes location, let the scene change happen deliberately; when the beat continues the same place, preserve the relevant location/environment anchors and visual through-line.',
    `Source story: ${compactSourceStoryForBible(extractGlobalContextFromStory(input.story))}`,
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
  // the long storyBeat. We surface it at the very top of the per-segment
  // prompt so the video model attends to position / orientation / motion /
  // shot size / camera at the strongest weight.
  openingFraming?: string;
}): string {
  const authored = options.authoredPrompt?.replace(/\s+/g, ' ').trim();

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

  const sourceShotText = [authored, options.storyBeat, options.visualPrompt, options.continuity, options.camera, options.title]
    .filter(Boolean)
    .join(' ');
  // Dialogue extraction — ONLY match quoted text that is preceded by an
  // explicit dialogue marker. Prior versions used a naive any-quoted-string
  // regex which grabbed random phrases like brand names ("Parts Unknown"),
  // quoted concepts ("中国街道"), or product names — none of which are
  // dialogue — and emitted them as "Quoted dialogue extracted ... preserve
  // verbatim" instructions to the model. The model then attempted to
  // lip-sync brand names, tripping the provider's audio content filter
  // and burying the real dialogue lines.
  //
  // New rule: a quoted string is treated as dialogue ONLY when it follows
  // a Chinese or English dialogue marker within ~20 characters:
  //   对白:  /  对白（...）:  /  台词:  /  旁白:  /  dialogue:  /  she says:  /  voiceover:
  // Allow surrounding markdown asterisks (**对白（...）**:) and trailing **
  // before the colon, which is how the user script formats annotation labels.
  const dialogueRe = /(?:\*{0,2})(?:对白|台词|旁白|dialogue|spoken\s*line|voiceover|she\s*(?:says|whispers|murmurs)|he\s*(?:says|whispers|murmurs))\s*(?:[（(][^）)]*[）)])?\s*(?:\*{0,2})\s*[:：][^"“]{0,30}["“]([^"“”]{1,120})["”]/gi;
  const quotedText = Array.from(sourceShotText.matchAll(dialogueRe))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const hasQuotedDialogue = quotedText.length > 0;
  const hasBrandOrReadableText = /(?:logo|brand|wordmark|signage|screen|ui|interface|caption|title card|on[- ]screen text|readable text|品牌|商标|标志|招牌|屏幕|界面|字幕|标题卡|展示文字|可读文字|中文|英文|文字)/i.test(sourceShotText);
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

  if (options.cleanDirect) {
    // cleanDirect strips DIRECTORIAL/AESTHETIC scaffolding (style lock,
    // aesthetic lock, reference-role-separation, default camera/continuity
    // boilerplate, frame-out hint) so the model gets a "raw" prompt.
    // It must NOT drop the hard CONTINUITY locks (identity card, bible,
    // character/accessory/prop/location anchors, explicit user brief lock,
    // scene-priority) — those are correctness rules, not aesthetic dressing,
    // and stripping them caused character/wardrobe/location drift across
    // long-video segments.
    const cleanMiddle: string[] = [];
    if (authored) {
      cleanMiddle.push(authored);
    } else {
      cleanMiddle.push(`Story beat (the dominant subject for the entire ${options.duration}s): ${options.storyBeat}`);
      cleanMiddle.push(`Visual direction: ${options.visualPrompt}`);
    }
    cleanMiddle.push(explicitBriefLock);
    if (options.continuity) cleanMiddle.push(`Continuity requirements: ${options.continuity}`);
    if (options.camera) cleanMiddle.push(`Camera and motion: ${options.camera}`);
    return [
      options.bible.identityCard,
      options.openingFraming ? `\n${options.openingFraming}` : '',
      options.bible.bible,
      scenePriority,
      `Shot ${options.shotIndex} of ${options.shotCount}, duration ${options.duration} seconds, title: ${options.title}.`,
      ...cleanMiddle,
      'no watermark',
    ].filter(Boolean).join('\n');
  }

  const styleLock = styleLockBlock(options.bible);

  const head = [
    options.bible.identityCard,
    options.openingFraming ? `\n${options.openingFraming}` : '',
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

  const aestheticLock = aestheticLockBlock(sourceShotText, options.bible);
  const middle: string[] = [];
  if (authored) {
    middle.push(authored);
  } else {
    middle.push(`Story beat (the dominant subject for the entire ${options.duration}s): ${options.storyBeat}`);
    middle.push(`Visual direction: ${options.visualPrompt}`);
  }
  middle.push(explicitBriefLock);
  middle.push(`Continuity requirements: ${options.continuity}`);
  middle.push(`Camera and motion: ${options.camera}`);

  if (options.mode === 'strong-vision') {
    middle.push(
      [
        '[REFERENCE-ROLE-SEPARATION]',
        'Use previous-frame references only for spatial continuity, pose momentum, camera direction, lighting direction, and environment layout.',
        'Do not inherit waxy skin, plastic highlights, over-smoothed facial material, mannequin faces, or CG-character surface quality from previous generated frames.',
        'When user-supplied reference images are present, treat them as the authority for recurring identity, wardrobe cues, and natural facial/material character.',
        '[/REFERENCE-ROLE-SEPARATION]',
      ].join('\n'),
    );
  }

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
    tail.push(
      [
        '[CONTINUITY-RESTATE — global character identity lock; preserve scene/location only when explicitly continuous]',
        ...lockedLines,
        options.bible.characters.length === 0 ? 'characters: same recurring identity as previous shot; no face/body/silhouette drift' : '',
        options.bible.wardrobe.length === 0 ? 'wardrobe: stable recurring-character clothing/material cues unless story changes costume' : '',
        `lighting: ${options.bible.lighting}`,
        `camera: ${options.bible.cameraLanguage}`,
        `mood: ${options.bible.mood}`,
        '[/CONTINUITY-RESTATE]',
      ]
        .join('\n'),
    );
    tail.push(styleLock); // second appearance for text-only mode
  }

  tail.push(
    [
      'Write one coherent video generation prompt. English direction is fine, but preserve any quoted dialogue, brand names, and requested on-screen Chinese text in the original language exactly.',
      'The storyBeat is the subject for the entire clip. The frame-out hints describe only the final ~0.5 s.',
      hasBrandOrReadableText
        ? 'Avoid subtitles, watermarks, and unrelated random text; user-specified logo/UI/readable text is allowed and must remain accurate.'
        : 'Avoid subtitles, readable text, logos, UI, and watermarks.',
    ].join(' '),
  );

  // Aesthetic lock is the very last block so it survives token truncation
  // on lower-context providers and serves as the visual quality anchor.
  tail.push(aestheticLock);

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
