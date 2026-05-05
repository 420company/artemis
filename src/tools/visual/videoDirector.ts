export type VideoDirectorProvider = 'byteplus' | 'openai' | 'google' | 'custom' | 'mock' | string;

export type VideoDirectorInput = {
  prompt: string;
  provider?: VideoDirectorProvider;
  model?: string;
  duration?: number;
  ratio?: string;
  referenceImageCount?: number;
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
const MAX_DIRECTED_PROMPT_CHARS = 1800;

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
    .replace(/["'`]+/g, '')
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

function providerProfile(provider?: string, model?: string): string {
  const key = `${provider ?? ''}/${model ?? ''}`.toLowerCase();
  if (key.includes('byteplus') || key.includes('seedance') || key.includes('dreamina')) {
    return 'BytePlus Seedance: concise English prompt, explicit action sequence, one camera move, stable subject continuity';
  }
  if (key.includes('openai') || key.includes('sora')) {
    return 'OpenAI video: shot type, subject, action, setting, lighting, and final frame clarity';
  }
  if (key.includes('google') || key.includes('veo')) {
    return 'Google Veo: cinematic shot description with clear subject, motion, environment, and coherent timing';
  }
  return 'Generic video model: structured cinematic prompt with subject, action, camera, lighting, and physical constraints';
}

function truncateDirectedPrompt(prompt: string): string {
  if (prompt.length <= MAX_DIRECTED_PROMPT_CHARS) return prompt;
  return `${prompt.slice(0, MAX_DIRECTED_PROMPT_CHARS - 80).trim()} Final frame remains stable, coherent, and cinematic.`;
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
  const referenceNote = input.referenceImageCount && input.referenceImageCount > 0
    ? `Preserve the identity, palette, composition hints, and key visual details from the ${input.referenceImageCount} reference image${input.referenceImageCount === 1 ? '' : 's'}.`
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

  const directedPrompt = truncateDirectedPrompt([
    `Source dream brief: ${originalPrompt}.`,
    `Director profile: ${profile}.`,
    `Focal point: ${focalPoint}.`,
    `Timeline: ${timeline}.`,
    `Camera: ${camera}.`,
    `Lighting and texture: ${lighting}.`,
    `Motion physics: ${physics}.`,
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
