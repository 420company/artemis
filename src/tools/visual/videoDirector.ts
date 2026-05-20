export type VideoDirectorProvider = 'byteplus' | 'openai' | 'google' | 'custom' | 'mock' | string;

export type VideoDirectorInput = {
  prompt: string;
  provider?: VideoDirectorProvider;
  model?: string;
  duration?: number;
  ratio?: string;
  referenceImageCount?: number;
  referenceVideoCount?: number;
  referenceAudioCount?: number;
  firstFrameImageCount?: number;
  lastFrameImageCount?: number;
};

export type VideoDirectorResult = {
  originalPrompt: string;
  directedPrompt: string;
  providerProfile: string;
  focalPoint: string;
  camera: string;
  lighting: string;
  physics: string;
  constraints: string;
};

type SceneKind = 'portrait' | 'product' | 'environment' | 'abstract';

const MAX_SOURCE_PROMPT_CHARS = 900;
const MAX_DIRECTED_PROMPT_CHARS = 2600;

const PERSON_HINTS = [
  'person',
  'people',
  'woman',
  'man',
  'girl',
  'boy',
  'portrait',
  'face',
  'body',
  'human',
  '人物',
  '角色',
  '主角',
  '主人公',
  '女主',
  '男主',
  '女孩',
  '男孩',
  '女人',
  '男人',
  '人像',
  '脸',
  '身体',
];

const PRODUCT_HINTS = [
  'product',
  'drink',
  'bottle',
  'phone',
  'watch',
  'car',
  'shoe',
  'jewelry',
  'food',
  '产品',
  '饮料',
  '杯',
  '手机',
  '手表',
  '汽车',
  '鞋',
  '珠宝',
  '食物',
];

const ENVIRONMENT_HINTS = [
  'city',
  'street',
  'forest',
  'ocean',
  'mountain',
  'temple',
  'church',
  'room',
  'ruins',
  'landscape',
  '城市',
  '街',
  '森林',
  '海',
  '山',
  '寺',
  '教堂',
  '房间',
  '废墟',
  '风景',
];

function cleanPrompt(prompt: string): string {
  return prompt
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/`+/g, '')
    .trim()
    .slice(0, MAX_SOURCE_PROMPT_CHARS);
}

function includesAny(prompt: string, hints: string[]): boolean {
  const lower = prompt.toLowerCase();
  return hints.some((hint) => lower.includes(hint.toLowerCase()));
}

function detectSceneKind(prompt: string): SceneKind {
  if (includesAny(prompt, PRODUCT_HINTS)) return 'product';
  if (includesAny(prompt, PERSON_HINTS)) return 'portrait';
  if (includesAny(prompt, ENVIRONMENT_HINTS)) return 'environment';
  return 'abstract';
}

function extractKeywords(prompt: string): string[] {
  return prompt
    .split(/[,\n;，、。|/]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function buildFocalPoint(prompt: string, kind: SceneKind): string {
  const keywords = extractKeywords(prompt);
  const source = keywords.length ? keywords.slice(0, 3).join(', ') : prompt;
  switch (kind) {
    case 'portrait':
      return `one clearly defined subject with stable facial structure and body proportions, centered around: ${source}`;
    case 'product':
      return `one hero object with crisp silhouette, readable material, and controlled reflections: ${source}`;
    case 'environment':
      return `one dominant environmental focal point with readable depth layers: ${source}`;
    default:
      return `one symbolic dream focal point, not a collage of unrelated objects: ${source}`;
  }
}

function buildTimeline(duration: number, kind: SceneKind): string {
  const finalSecond = Math.max(4, Math.min(20, Math.floor(duration || 5)));
  if (finalSecond <= 5) {
    return [
      '0-2 seconds: establish the focal point with restrained motion and clear spatial depth',
      '2-4 seconds: introduce one primary physical action that evolves naturally',
      `4-${finalSecond} seconds: resolve on a stable cinematic final frame without sudden scene changes`,
    ].join('; ');
  }
  if (finalSecond <= 8) {
    return [
      '0-2 seconds: establish location, scale, and focal point',
      '2-5 seconds: the subject performs one coherent action with visible cause and effect',
      `5-${finalSecond} seconds: camera settles into a polished final composition`,
    ].join('; ');
  }
  const middle = kind === 'product'
    ? '4-8 seconds: controlled macro details reveal texture, condensation, reflections, or mechanical precision'
    : '4-8 seconds: the environment reacts through light, wind, particles, or atmospheric movement';
  return [
    '0-2 seconds: cinematic establishing shot with a single focal point',
    '2-4 seconds: camera movement begins slowly and locks onto the subject',
    middle,
    `8-${finalSecond} seconds: resolve with a clean hero frame and stable object boundaries`,
  ].join('; ');
}

function buildCamera(kind: SceneKind, ratio?: string): string {
  const framing = ratio === '9:16' ? 'vertical composition with strong foreground-midground-background separation' : 'wide cinematic composition with readable depth';
  switch (kind) {
    case 'portrait':
      return `slow push-in portrait shot, 50mm to 85mm lens feel, shallow depth of field, ${framing}`;
    case 'product':
      return `controlled macro tracking shot with a subtle slow orbit, crisp focus pull, ${framing}`;
    case 'environment':
      return `slow tracking shot through the scene, no chaotic cuts, stable horizon, ${framing}`;
    default:
      return `slow dolly-in dream shot with one continuous camera move, ${framing}`;
  }
}

function buildLighting(kind: SceneKind, prompt: string): string {
  const neon = /neon|cyber|赛博|霓虹/i.test(prompt);
  const water = /water|rain|ocean|sea|lake|雨|水|海/i.test(prompt);
  const metal = /metal|chrome|robot|machine|机械|金属/i.test(prompt);
  const base = neon
    ? 'motivated neon key light, volumetric haze, controlled bloom'
    : 'motivated cinematic key light, soft rim light, volumetric atmosphere';
  const reflections = water || metal
    ? ', ray-traced style reflections across wet or metallic surfaces'
    : '';
  const material = kind === 'portrait'
    ? ', natural skin subsurface scattering where people appear'
    : ', tactile material detail with believable roughness and specular response';
  return `${base}${reflections}${material}`;
}

function buildPhysics(kind: SceneKind): string {
  switch (kind) {
    case 'portrait':
      return 'physically accurate gravity, stable anatomy, subtle cloth and hair motion, no limb drift';
    case 'product':
      return 'physically accurate weight, controlled inertia, believable liquid or particle motion only when relevant';
    case 'environment':
      return 'physically accurate gravity, wind-driven atmosphere, particles move with consistent direction and scale';
    default:
      return 'physically plausible dream logic, stable object boundaries, smooth continuous motion';
  }
}

/**
 * Fibonacci composition — use the golden ratio (1.618) as the master formula
 * for visual composition and camera timing.
 */
function buildFibonacciComposition(kind: SceneKind): string {
  const focalPoints = kind === 'portrait'
    ? 'Place the subject\'s eyes, hands, and key props on Fibonacci spiral intersections (golden-ratio power points).'
    : kind === 'product'
      ? 'Position the hero object at a golden-ratio intersection; let reflections and specular highlights follow the spiral.'
      : 'Anchor the dominant visual mass at a golden-ratio power point; let secondary elements trail along the spiral.';
  return [
    focalPoints,
    'For camera motion, use Fibonacci-based acceleration beats (1s, 1s, 2s, 3s, 5s) for organic velocity — slow start, gradual build, smooth settle.',
    'Background elements and set dressing must obey natural perspective falloff (Z-depth scaling); no arbitrary scaling glitches.',
  ].join(' ');
}

/**
 * Spatial depth & realistic scale — enforce physically plausible 2D/3D depth
 * relationships between subject, environment, and background.
 */
function buildSpatialDepth(kind: SceneKind, prompt: string): string {
  const hasIndoor = /room|bedroom|kitchen|bathroom|indoor|室内|房间|卧室|厨房|浴室/i.test(prompt);
  const hasOutdoor = /street|city|park|beach|forest|outdoor|街道|城市|公园|海滩|森林/i.test(prompt);
  const envContext = hasIndoor
    ? 'Indoor: character must fit doorframes, furniture, and ceiling height at realistic human scale.'
    : hasOutdoor
      ? 'Outdoor: character scale must be consistent with street furniture, vehicles, buildings, and background people.'
      : '';
  const portraitScale = kind === 'portrait'
    ? ' The protagonist\'s head-to-body ratio, limb proportions, and spatial footprint relative to nearby objects must match real human anatomy — no "giant syndrome" or disproportionate scaling.'
    : '';
  return [
    `Maintain readable depth layers: foreground (closest to camera), midground (subject zone), background (environment). Each layer must have distinct parallax and focus level.`,
    `Subject-to-environment scale must be physically grounded: the character's height and volume relative to doorframes, furniture, vehicles, buildings, background people, and horizon line must be consistent and realistic.${envContext}${portraitScale}`,
    'Z-depth perspective falloff: objects farther from camera shrink at optically correct rates; no flat cardboard-cutout background.',
  ].join(' ');
}

/**
 * Intelligent creative extension ("brain-completion") logic:
 * - User-specified conditions (scene, costume, action, mood, etc.) are MANDATORY.
 * - AI may INVENT details the user did NOT specify, but ONLY those that are
 *   logically required by the specified conditions (e.g., user says "rainy
 *   street" → AI must add wet surfaces, puddles, umbrellas — even though user
 *   didn't mention them — because rain logically implies them).
 * - If the user specifies NOTHING beyond a subject, AI has full creative
 *   freedom to design environment, mood, and action.
 * - The key rule: AI never OVERRIDES a user condition, but it MUST fill in
 *   all the implicit consequences of user conditions.
 */
function buildIntelligentExtension(_prompt: string): string {
  return [
    'Creative extension rule: every condition the user explicitly specified (scene, costume, action, mood, transition, prop) is non-negotiable and must appear exactly as described.',
    'AI may invent details the user did NOT mention, but only those that are logically entailed by the specified conditions — e.g., "rain" implies wet surfaces, puddles, umbrellas; "bedroom at night" implies warm lamp light, rumpled sheets, intimate scale.',
    'If the user specified no conditions beyond a subject, AI has full creative freedom to design environment, mood, and action.',
    'Never override or contradict a user-specified condition; always fill in the implicit physical and atmospheric consequences of what the user did specify.',
  ].join(' ');
}

function providerProfile(provider?: string, model?: string): string {
  const key = `${provider ?? ''}/${model ?? ''}`.toLowerCase();
  if (key.includes('byteplus') || key.includes('seedance') || key.includes('dreamina')) {
    return 'Seedance 2.0 Pro: timestamp storyboard, explicit reference usage, camera language, sound design, and negative constraints';
  }
  if (key.includes('openai') || key.includes('sora')) {
    return 'OpenAI video: shot type, subject, action, setting, lighting, and final frame clarity';
  }
  if (key.includes('google') || key.includes('veo')) {
    return 'Google Veo: cinematic shot description with clear subject, motion, environment, and coherent timing';
  }
  return 'Generic video model: structured cinematic prompt with subject, action, camera, lighting, and physical constraints';
}

function isSeedanceProfile(provider?: string, model?: string): boolean {
  const key = `${provider ?? ''}/${model ?? ''}`.toLowerCase();
  return key.includes('byteplus') || key.includes('seedance') || key.includes('dreamina');
}

function buildSeedanceTechnicalSpec(duration: number, ratio?: string): string {
  const aspect = ratio?.trim() || '16:9';
  const orientation = aspect === '9:16' ? '竖屏' : aspect === '1:1' ? '方形构图' : '横屏';
  return `${orientation}${aspect}, 24fps, ${duration}秒, cinematic lighting, high fidelity, no watermark.`;
}

function buildSeedanceReferencePlan(input: VideoDirectorInput): string {
  const parts: string[] = [];
  const referenceImageCount = Math.max(0, input.referenceImageCount ?? 0);
  const firstFrameImageCount = Math.max(0, input.firstFrameImageCount ?? 0);
  const lastFrameImageCount = Math.max(0, input.lastFrameImageCount ?? 0);
  const referenceVideoCount = Math.max(0, input.referenceVideoCount ?? 0);
  const referenceAudioCount = Math.max(0, input.referenceAudioCount ?? 0);
  if (referenceImageCount > 0) {
    parts.push(`Reference declaration: Image 1-${referenceImageCount} are reference images for character identity, product materials, scene anchors, or visual style; preserve exact subject silhouette, materials, palette, and composition cues.`);
  }
  if (firstFrameImageCount > 0) {
    parts.push(`Keyframe declaration: First Frame Image 1-${firstFrameImageCount} pins the literal opening frame; animate only the requested motion and match lighting, color temperature, and depth of field.`);
  }
  if (lastFrameImageCount > 0) {
    parts.push(`Keyframe declaration: Last Frame Image 1-${lastFrameImageCount} pins the target closing frame; make the middle motion a single physically plausible arc toward it.`);
  }
  if (referenceVideoCount > 0) {
    parts.push(`Reference declaration: reference videos / Video Clip 1-${referenceVideoCount} control camera motion, action rhythm, transitions, pacing, and continuity; do not randomly copy unrelated subjects.`);
  }
  if (referenceAudioCount > 0) {
    parts.push(`Reference declaration: reference audio / Audio Clip 1-${referenceAudioCount} controls music tempo, voice tone, ambience, Foley texture, and beat-synced motion.`);
  }
  return parts.length > 0
    ? parts.join(' ')
    : 'No external references: AI must still follow the full Seedance 2.0 production spec — create a self-contained scene with one named protagonist or hero object, one explicit identity lock, one coherent action chain, one continuous camera idea, intentional sound design, and a stable final frame.';
}

function buildSeedanceAutoCreativeSpec(prompt: string, kind: SceneKind): string {
  const asksForAiCreation = /自己|自动|AI|ai|创造|创作|编|故事|剧情|角色|随便|发挥|脑补|generate|invent|create/i.test(prompt);
  const identity = kind === 'portrait'
    ? 'Invent exactly one primary protagonist if the user did not name one; give them stable age range, face shape, hair, wardrobe, body proportions, emotional state, and one memorable visual motif. Keep face, hair, clothing, accessories, and body scale identical across every shot.'
    : kind === 'product'
      ? 'Invent or refine exactly one hero product if the user did not specify details; lock silhouette, material, logo/text absence, color palette, scale, and surface behavior across every shot.'
      : kind === 'environment'
        ? 'Invent exactly one dominant environment focal point if the user did not specify details; lock geography, time of day, weather, light direction, scale, and atmospheric physics across every shot.'
        : 'Invent exactly one central subject if the user did not specify details; lock its silhouette, palette, scale, and symbolic role across the whole clip.';
  const story = asksForAiCreation
    ? 'AI-created story rule: build a compact three-beat micro-story — setup, motion/change, payoff — inside the requested duration. Do not introduce extra protagonists, unrelated subplots, sudden genre swaps, or random visual gags.'
    : 'Completion rule: only add implied details that strengthen the user brief; preserve every explicit user condition and never replace the requested subject, mood, scene, or action.';
  return `Auto creative spec: ${identity} ${story} Every invented detail must serve subject + action + scene + style + emotion; write the result as if directing Seedance 2.0, not as generic decoration.`;
}

function buildSeedanceSoundPlan(prompt: string, referenceAudioCount: number): string {
  const quotedDialogue = /["“”][^"“”]{2,}["“”]/.test(prompt);
  const hasDialogue = /dialogue|line|quote|台词|对白|旁白|说|讲|念|voice/i.test(prompt);
  const hasMusic = /music|beat|song|mv|音乐|卡点|节拍|旋律|配乐/i.test(prompt);
  if (quotedDialogue) {
    return 'Sound design: generated audio enabled; treat quoted text as verbatim dialogue or voice-over, preserve the quotation content exactly, explicitly lip-sync mouth movement to the spoken language phonemes, and add matching room tone/Foley.';
  }
  if (referenceAudioCount > 0 || hasMusic) {
    return 'Sound design: generated audio enabled; sync movement cuts, impacts, ambience, and camera emphasis to the music or reference rhythm.';
  }
  if (hasDialogue) {
    return 'Sound design: generated audio enabled; keep dialogue short, emotionally tagged, and synchronized with mouth/action timing; include ambience and key sound effects.';
  }
  return 'Sound design: generated audio enabled; add natural ambience, material sounds, movement accents, and a restrained cinematic bed.';
}

function buildSeedanceNegativePrompt(kind: SceneKind): string {
  const anatomy = kind === 'portrait'
    ? ', no extra limbs, no face drift, no broken hands'
    : '';
  return `Negative constraints: no subtitles, no text overlays, no logos, no watermark, no random morphing, no flicker, no melting objects, no duplicate subjects${anatomy}.`;
}

function buildSeedanceScenarioStrategy(prompt: string, kind: SceneKind): string {
  if (/product|drink|bottle|phone|watch|car|shoe|jewelry|food|产品|商品|广告|饮料|手机|手表|汽车|鞋|珠宝|美食/i.test(prompt)) {
    return 'Scenario strategy: advertising/product film; show hero object first, reveal texture through macro detail, then finish with a clean product hero frame.';
  }
  if (/dialogue|drama|short drama|台词|对白|短剧|剧情|反转|女主|男主|总裁/i.test(prompt)) {
    return 'Scenario strategy: short drama; separate visual beats from dialogue beats, keep actor emotion readable, and make each line short enough for the shot timing.';
  }
  if (/music|beat|mv|dance|音乐|卡点|舞蹈|节拍|旋律/i.test(prompt)) {
    return 'Scenario strategy: music video; align scene changes, pose changes, and camera emphasis to beat points without chaotic cuts.';
  }
  if (/one take|long take|一镜到底|连续镜头/i.test(prompt)) {
    return 'Scenario strategy: one-take long shot; no hard cuts, use occlusion, camera travel, and spatial transitions to move between moments.';
  }
  if (kind === 'environment') {
    return 'Scenario strategy: cinematic environment; maintain readable depth layers and let atmosphere, light, particles, and wind carry motion.';
  }
  return 'Scenario strategy: narrative cinematic clip; one coherent action chain with visible cause and effect.';
}

function buildSeedanceDirectedPrompt(input: VideoDirectorInput, profile: string): string {
  const originalPrompt = cleanPrompt(input.prompt);
  const kind = detectSceneKind(originalPrompt);
  const duration = typeof input.duration === 'number' && Number.isFinite(input.duration) ? input.duration : 5;
  const focalPoint = buildFocalPoint(originalPrompt, kind);
  const timeline = buildTimeline(duration, kind);
  const camera = buildCamera(kind, input.ratio);
  const lighting = buildLighting(kind, originalPrompt);
  const physics = buildPhysics(kind);
  const fibonacci = buildFibonacciComposition(kind);
  const spatial = buildSpatialDepth(kind, originalPrompt);
  const extension = buildIntelligentExtension(originalPrompt);
  const referencePlan = buildSeedanceReferencePlan(input);
  const autoCreative = buildSeedanceAutoCreativeSpec(originalPrompt, kind);
  const soundPlan = buildSeedanceSoundPlan(originalPrompt, input.referenceAudioCount ?? 0);
  const scenario = buildSeedanceScenarioStrategy(originalPrompt, kind);
  const negative = buildSeedanceNegativePrompt(kind);

  return truncateDirectedPrompt([
    `Seedance 2.0 Pro optimized prompt.`,
    `Technical spec: ${buildSeedanceTechnicalSpec(duration, input.ratio)}`,
    `Source brief: ${originalPrompt}.`,
    `Director profile: ${profile}.`,
    scenario,
    `Reference usage: ${referencePlan}`,
    autoCreative,
    soundPlan,
    `single clear focal point: ${focalPoint}.`,
    `Timestamp storyboard: ${timeline}.`,
    `Camera language: ${camera}.`,
    `Fibonacci composition: ${fibonacci}.`,
    `Lighting and texture: ${lighting}.`,
    `Motion physics: ${physics}.`,
    `Spatial depth & scale: ${spatial}.`,
    extension,
    negative,
    `Final frame: stable, cinematic, visually coherent, with physically plausible continuity.`,
  ].join(' '));
}

function truncateDirectedPrompt(prompt: string): string {
  if (prompt.length <= MAX_DIRECTED_PROMPT_CHARS) return prompt;
  return `${prompt.slice(0, MAX_DIRECTED_PROMPT_CHARS - 160).trim()} Negative constraints: no subtitles, no text overlays, no logos, no watermark, no random morphing, no flicker. Final frame remains physically plausible, stable, coherent, and cinematic.`;
}

export function buildDirectedVideoPrompt(input: VideoDirectorInput): VideoDirectorResult {
  const originalPrompt = cleanPrompt(input.prompt);
  const kind = detectSceneKind(originalPrompt);
  const duration = typeof input.duration === 'number' && Number.isFinite(input.duration) ? input.duration : 5;
  const focalPoint = buildFocalPoint(originalPrompt, kind);
  const timeline = buildTimeline(duration, kind);
  const camera = buildCamera(kind, input.ratio);
  const lighting = buildLighting(kind, originalPrompt);
  const physics = buildPhysics(kind);
  const profile = providerProfile(input.provider, input.model);
  if (isSeedanceProfile(input.provider, input.model)) {
    const directedPrompt = buildSeedanceDirectedPrompt(input, profile);
    return {
      originalPrompt,
      directedPrompt,
      providerProfile: profile,
      focalPoint,
      camera,
      lighting,
      physics,
      constraints: buildSeedanceNegativePrompt(kind),
    };
  }

  const referenceCount =
    (input.referenceImageCount ?? 0) +
    (input.referenceVideoCount ?? 0) +
    (input.referenceAudioCount ?? 0);
  const referenceNote = referenceCount > 0
    ? `Preserve the identity, motion language, sound cues, palette, composition hints, and key details from the provided reference assets.`
    : 'No collage behavior: invent only details that support the central scene.';
  const constraints = [
    'ultra-high fidelity cinematic video',
    'single clear focal point',
    'stable object boundaries',
    'consistent lighting direction',
    'no random morphing',
    'no flicker',
    'no melting objects',
    'no extra limbs or distorted anatomy',
  ].join(', ');

  const fibonacci = buildFibonacciComposition(kind);
  const spatial = buildSpatialDepth(kind, originalPrompt);
  const extension = buildIntelligentExtension(originalPrompt);

  const directedPrompt = truncateDirectedPrompt([
    `Source dream brief: ${originalPrompt}.`,
    `Director profile: ${profile}.`,
    extension,
    `Focal point: ${focalPoint}.`,
    `Timeline: ${timeline}.`,
    `Camera: ${camera}.`,
    `Fibonacci composition: ${fibonacci}.`,
    `Lighting and texture: ${lighting}.`,
    `Motion physics: ${physics}.`,
    `Spatial depth & scale: ${spatial}.`,
    referenceNote,
    `Quality constraints: ${constraints}.`,
  ].join(' '));

  return {
    originalPrompt,
    directedPrompt,
    providerProfile: profile,
    focalPoint,
    camera,
    lighting,
    physics,
    constraints,
  };
}
