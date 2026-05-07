import { resolveConfiguredVisualProvider } from '../../utils/visualGenerationConfig.js';
import { resolveVideoModelLimits } from './videoModelLimits.js';

export type SagaWorkflowScope = 'cli' | 'bridge';

export type SagaWorkflowInput = {
  scope: SagaWorkflowScope;
  key: string;
  cwd: string;
  text: string;
  deliveryPlatform?: 'telegram' | 'discord' | 'wechat' | 'all';
  deliveryTargetId?: string;
  // When true, skip the long-video intent regex check and treat the text as
  // an explicit Saga long-video request. Used by the /sage slash command —
  // the user has already declared their intent, no ambiguity to resolve.
  forceIntent?: boolean;
};

export type SagaWorkflowOutcome =
  | { handled: false; prompt?: string }
  | { handled: true; reply: string };

type SagaWorkflowState = {
  scope: SagaWorkflowScope;
  cwd: string;
  originalText: string;
  targetDuration?: number;
  deliveryPlatform?: 'telegram' | 'discord' | 'wechat' | 'all';
  deliveryTargetId?: string;
  createdAt: number;
  updatedAt: number;
};

const WORKFLOWS = new Map<string, SagaWorkflowState>();
const WORKFLOW_TTL_MS = 30 * 60 * 1000;
const CANCEL_RE = /^(?:取消|算了|停止|不要了|cancel|stop)$/i;
const CONFIRM_DEFAULT_RE = /^(?:默认|建议|你定|自动|可以|好|好的|ok|yes|y|sure|default)$/i;

function normalizeKey(input: SagaWorkflowInput): string {
  return `${input.scope}:${input.key}`;
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function pruneExpiredWorkflows(): void {
  const now = Date.now();
  for (const [key, workflow] of WORKFLOWS) {
    if (now - workflow.updatedAt > WORKFLOW_TTL_MS) WORKFLOWS.delete(key);
  }
}

function hasLongVideoIntent(text: string): boolean {
  const normalized = compact(text);
  if (!normalized) return false;
  return [
    /(?:长视频|长片|完整视频|完整短片|完整影片|一整条视频|视频解决方案|生产链|剪辑链|剪成|剪辑成片)/i,
    /(?:生成|创建|制作|产出|做成|转成|变成)[\s\S]{0,100}(?:\d+\s*(?:分钟|分|秒|s|sec|seconds|min|minutes))[\s\S]{0,80}(?:视频|短片|影片|video|movie|clip)/i,
    /\b(?:long[-\s]?form|long|full|complete)\b[\s\S]{0,80}\b(?:video|movie|clip)\b/i,
    /\b(?:generate|create|make|produce|turn)\b[\s\S]{0,80}\b(?:long|full|complete)\b[\s\S]{0,80}\b(?:video|movie|clip)\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function extractTargetDuration(text: string): number | undefined {
  const normalized = compact(text);
  const zhMinute = normalized.match(/(\d{1,3})\s*(?:分钟|分)/);
  if (zhMinute) return Number.parseInt(zhMinute[1] ?? '', 10) * 60;
  const zhSecond = normalized.match(/(\d{1,4})\s*秒/);
  if (zhSecond) return Number.parseInt(zhSecond[1] ?? '', 10);
  const enMinute = normalized.match(/(\d{1,3})\s*(?:min|mins|minute|minutes)\b/i);
  if (enMinute) return Number.parseInt(enMinute[1] ?? '', 10) * 60;
  const enSecond = normalized.match(/(\d{1,4})\s*(?:s|sec|secs|second|seconds)\b/i);
  if (enSecond) return Number.parseInt(enSecond[1] ?? '', 10);
  return undefined;
}

function clampDuration(seconds: number | undefined): number | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  return Math.max(10, Math.min(600, Math.floor(seconds)));
}

function estimateDuration(text: string): number {
  const chars = compact(text).length;
  if (chars > 1600) return 180;
  if (chars > 900) return 120;
  if (chars > 450) return 90;
  return 60;
}

function extractRatio(text: string): string | undefined {
  if (/(?:竖屏|手机|抖音|tiktok|reels|shorts|9:16|portrait)/i.test(text)) return '9:16';
  if (/(?:方形|1:1|square)/i.test(text)) return '1:1';
  if (/(?:横屏|电影|youtube|16:9|landscape)/i.test(text)) return '16:9';
  return undefined;
}

async function buildDurationQuestion(state: SagaWorkflowState): Promise<string> {
  const configured = await resolveConfiguredVisualProvider(state.cwd, 'video');
  const modelLine = configured
    ? (() => {
        const limits = resolveVideoModelLimits(configured.config.video.provider, configured.model);
        return `当前视频模型：${configured.config.video.provider}/${configured.model}，单段上限约 ${limits.maxSegmentSeconds} 秒，Saga 会自动拆成多段再合成。`;
      })()
    : '当前没有检测到可用视频模型配置。';
  const estimated = estimateDuration(state.originalText);
  return [
    'Saga 已检测到你要做“长视频”。',
    modelLine,
    `我建议这个故事先做成 ${estimated} 秒。`,
    '请回复目标总时长，例如：60秒、90秒、2分钟；也可以回复“默认/自动”使用建议时长。',
    '回复“取消”放弃本次 Saga 长视频流程。',
  ].join('\n');
}

function buildGenerationPrompt(state: SagaWorkflowState): string {
  const targetDuration = clampDuration(state.targetDuration) ?? estimateDuration(state.originalText);
  const ratio = extractRatio(state.originalText) ?? '16:9';
  const projectId = `saga-${Date.now()}`;
  const lines = [
    state.originalText,
    '',
    '[Artemis Saga long video workflow]',
    'Call generate_long_video exactly once for this request.',
    `projectId: ${JSON.stringify(projectId)}`,
    `totalDuration: ${targetDuration}`,
    `ratio: ${JSON.stringify(ratio)}`,
    'assemblyMode: "saga"',
    'chainReferenceFrames: "auto"',
    'colorMatch: true',
    'generateAudio: true',
    'Before calling the tool, act as the Saga producer with a cinematic-director discipline:',
    '1. IDENTITY LOCK — Read the story and lock anchors that must NEVER change between shots: characters (face, age, ethnicity, build, hair, distinguishing features), wardrobe (every visible garment with concrete colors and materials — include hex codes when meaningful, e.g. "#1a2542 navy cotton hooded jacket"), persistent props (with materials), locations, palette (3-5 hex or named colors), lighting (key direction + temperature), camera language (focal feel, motion type), and overall mood. Pass them through the top-level continuity object: { characters, wardrobe, props, locations, palette, lighting, cameraLanguage, mood }. Saga will inject them verbatim into every shot prompt as an identity card so the model cannot drift.',
    '2. CONTINUITY MODE — Saga auto-selects: "strong-vision" (image-ref capable models, BytePlus Seedance/Veo) chains the previous segment\'s last frame into the next shot; "text-only" (Gen-3 / Kling text mode) compensates with triple-repeated identity anchors and starting-frame text descriptions. You do not configure this; just write strong identity anchors and Saga handles the rest.',
    '3. SHOTS — Plan a structured shots array. Each shot must include: title, duration, storyBeat, visualPrompt, camera, continuity, transition. Optionally a polished English `prompt` (Saga will inject identity card + style-lock + scene-priority + frame-out + aesthetic-lock around it). Optionally pick a transitionKind from the catalog in step 6.',
    '4. CINEMATIC VOCABULARY — In visualPrompt and camera, use influential industry words, not amateur ones. Pick from the catalogs below as appropriate for the beat:',
    '   • Camera movement: tracking shot, FPV drone, dolly zoom (Vertigo), Steadicam glide, crane, locked-off establishing, slow handheld push-in, whip pan, gimbal arc, micro dolly, snorricam',
    '   • Lens / framing: 24mm wide environmental, 35mm reportage, 50mm normal, 85mm portrait, 135mm telephoto compression, anamorphic 2.39:1 with horizontal flares, fisheye 14mm, macro 100mm',
    '   • Lighting: golden hour key, blue hour, magic hour, IMAX overhead skylight, hard key + bounce fill, soft window light, neon glow, candle warm 2200K, practical-only, volumetric beams through fog/haze, rim back-light',
    '   • Render targets: photoreal cinematic, UE5 Lumen, Octane GPU, ray-traced reflections, global illumination, subsurface scattering on skin, depth-of-field bokeh, optical lens distortion',
    '   • Stock / look: Kodak Portra 400 grain, IMAX 70mm grain, Arri Alexa LogC, Cinestill 800T halation, anamorphic flares, gentle film halation in highlights',
    '   • Action verbs (replace static descriptions with verbs of motion): drifts, lingers, sweeps, eases into, pulls back, presses in, breathes, settles, tilts, glides',
    '5. TIME-AXIS BEATS — For shots longer than 5 s, write storyBeat with explicit timing if it helps the model: "0–2s subject enters frame and grounds, 2–4s subject performs the main action, 4–6s lighting softens and we settle into a hold." DiT models reward explicit temporal arcs. The time slices are descriptive, not literal — Saga still wraps everything in the SCENE-PRIORITY block.',
    '5b. HEAD/TAIL VISUAL ECHO (match-cut planning) — This is the language-side companion of Saga\'s reference-frame chain. For every adjacent pair of shots, write shot N\'s `transition` field as a CONCRETE description of the closing frame (subject pose, framing, focal point, dominant color, camera angle, lighting key direction), then OPEN shot N+1\'s `visualPrompt` with a matching opening-frame description that visually rhymes — same subject pose, same framing or one consistent reframe, same color cast, same camera height. Even when the transition is a hard cut, this makes the boundary feel inevitable instead of jarring; with a clean-fade or shader transition it makes the post-fade reveal land on a frame the eye expects. The model also gets two visually coherent prompts to anchor on, which dramatically reduces "two unrelated worlds" drift.',
    '6. TRANSITIONS — Vary them deliberately. Two families:',
    '   FFmpeg classic (fast, no browser): cut, crossfade, dissolve, light-leak, fade-black, fade-white, wipe-left, wipe-right, slide-up, push-left, push-right, circle-open, circle-close, blur, zoom-in, zoom-out, flash, speed-ramp, whip-pan, whip-pan-left, match-cut, glitch, cinematic-fade, iris-pulse, squeeze-h, squeeze-v, cover-down, cover-up, reveal-left. The "soft" ones (crossfade/dissolve/light-leak/cinematic-fade/fade-black/fade-white) automatically use Saga\'s hold-frame mode — the xfade window is between two FROZEN boundary frames, so no motion-mixing pollution.',
    '   Saga GLSL shaders (Playwright + WebGL, ~1-2 s overhead per transition, premium quality): shader-light-leak (warm bloom + horizontal sweep), shader-whip-pan (motion blur slide), shader-glitch (block tear + RGB split + scanlines), shader-cinematic-zoom (radial zoom + edge chromatic aberration), shader-domain-warp (organic noise distortion), shader-ridged-burn (burning-paper edge with sparks), shader-sdf-iris (iris with glowing accent ring), shader-ripple-waves (concentric ripple distortion), shader-gravitational-lens (black-hole UV pull + chromatic aberration), shader-chromatic-split (radial RGB separation), shader-swirl-vortex (spiral rotation), shader-thermal-distortion (heat shimmer), shader-flash-through-white (clean RGB flash), shader-cross-warp-morph (asymmetric noise morph). All shader-* transitions are RGB-correct (no YUV color shift), and use hardware-accelerated WebGL.',
    '   Pick by intent: crossfade / light-leak / shader-light-leak / cinematic-fade / shader-domain-warp for "this continues" bridges; cut / match-cut / shader-flash-through-white for sharp register shifts; flash / speed-ramp / shader-whip-pan / shader-cinematic-zoom for energy; fade-black for act breaks; glitch / shader-glitch / shader-chromatic-split for cyber/tech beats; shader-ridged-burn / shader-sdf-iris for dramatic reveals; shader-gravitational-lens / shader-swirl-vortex for surreal beats. Using the same transition every shot reads as mechanical — vary kind AND intent across the project.',
    '7. SCENE-PRIORITY RULE — storyBeat is the subject for the FULL clip duration. The transition field describes ONLY the closing ~0.5 seconds. Do NOT let the closing-frame instruction become the subject of the whole clip. Saga explicitly marks the transition as low-priority in the model prompt.',
    '8. PHYSICS & FAILURE GUARDS — Saga\'s aesthetic-lock automatically appends physics anchors (physically accurate gravity, fluid dynamics, anatomically correct, no morphing / flickering / melting / extra limbs / facial deformation) to every prompt. You do NOT need to repeat these — focus your visualPrompt on the actual scene.',
    '9. SCENE-JUMP HANDLING — When the story has a hard location jump, insert at least one transition shot that bridges the two locations through a shared visual element (same character carrying same prop, same key light direction, same color cast) so the model has continuity to latch on to.',
    '10. DURATIONS — Shot durations must add up to the requested total duration; each shot must stay within the detected provider segment limit.',
    'Saga will generate each provider-safe clip, automatically chain the previous segment\'s last frame into the next shot as a reference image (when the model supports it), retry segments that fail audio or image safety filters with the offending input dropped, and assemble a final MP4 with eased / multi-stage transitions, loudness-normalized audio, and per-segment frame-trimmed inputs (no flashback frames at boundaries).',
    'Do not call generate_video manually for each segment unless generate_long_video is unavailable.',
  ];
  if (state.scope === 'bridge') {
    const sendArgs = [
      state.deliveryPlatform ? `platform: ${JSON.stringify(state.deliveryPlatform)}` : undefined,
      state.deliveryTargetId ? `targetId: ${JSON.stringify(state.deliveryTargetId)}` : undefined,
      'caption: "Saga long video is ready"',
    ].filter(Boolean).join(', ');
    lines.push(`After generate_long_video succeeds, immediately call bridge_send_video using the exact final video path from the tool output, with { ${sendArgs} }.`);
  }
  return lines.join('\n');
}

export async function handleSagaLongVideoWorkflow(input: SagaWorkflowInput): Promise<SagaWorkflowOutcome> {
  pruneExpiredWorkflows();
  const key = normalizeKey(input);
  const text = input.text.trim();
  const state = WORKFLOWS.get(key);

  if (state) {
    if (CANCEL_RE.test(text)) {
      WORKFLOWS.delete(key);
      return { handled: true, reply: '已取消 Saga 长视频生成流程。' };
    }
    const duration = clampDuration(extractTargetDuration(text));
    if (!duration && !CONFIRM_DEFAULT_RE.test(text)) {
      state.updatedAt = Date.now();
      return { handled: true, reply: await buildDurationQuestion(state) };
    }
    state.targetDuration = duration ?? estimateDuration(state.originalText);
    state.updatedAt = Date.now();
    WORKFLOWS.delete(key);
    return { handled: false, prompt: buildGenerationPrompt(state) };
  }

  if (!input.forceIntent && !hasLongVideoIntent(text)) {
    return { handled: false };
  }

  const configured = await resolveConfiguredVisualProvider(input.cwd, 'video');
  if (!configured) {
    return { handled: false };
  }

  const duration = clampDuration(extractTargetDuration(text));
  const nextState: SagaWorkflowState = {
    scope: input.scope,
    cwd: input.cwd,
    originalText: text,
    targetDuration: duration,
    deliveryPlatform: input.deliveryPlatform,
    deliveryTargetId: input.deliveryTargetId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (duration) {
    return { handled: false, prompt: buildGenerationPrompt(nextState) };
  }

  WORKFLOWS.set(key, nextState);
  return { handled: true, reply: await buildDurationQuestion(nextState) };
}
