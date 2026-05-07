import type { SagaTransitionKind, SagaTransitionPlan } from './types.js';

// Transition catalog v2 — the FFmpeg-side compiler accepts either a native
// xfade transition name OR a custom expression. Custom expressions let us
// express eased crossfades, white-flash impacts, light-leak bell curves,
// whip-pan blurs, and speed ramps without restructuring the concat graph.
//
// Expressions follow xfade's contract: at each pixel, A is the source-A
// value, B is the source-B value, P is normalized progress (0 → 1) across
// the transition window, X/Y/W/H are coordinates and dimensions. Channels
// (Y/U/V or R/G/B) are evaluated independently — no channel-specific
// tinting from inside one expression. Channel tints come from filters
// applied OUTSIDE the xfade.

export type SagaTransitionDescriptor = {
  kind: SagaTransitionKind;
  // Either a native xfade transition name (when expression is null), or
  // null + an expression string for transition=custom.
  ffmpegXfade: string | null;
  // Custom expression for transition=custom. Takes precedence over
  // ffmpegXfade when set.
  expression?: string | null;
  intent: 'continuation' | 'disruption' | 'drift' | 'reveal' | 'energy';
  recommendedDurationMs: number;
  notes: string;
  // When true: this transition is rendered by Saga's WebGL shader path
  // (Playwright + GLSL fragment shader operating on extracted boundary
  // frames). The concat pipeline detects this flag and splices a
  // pre-rendered MP4 of the shader sequence between the surrounding
  // segments instead of using FFmpeg xfade.
  isShader?: boolean;
  // When true: the transition window blends two FROZEN frames (last frame
  // of A, first frame of B) — no motion confusion. Required for "soft"
  // transitions where motion-mixing creates the "polluted flashback frames"
  // artifact. The renderer extends each segment with tpad freeze frames
  // around the transition window so xfade only sees stills during the
  // crossover. Total output duration is sum(segments) + sum(holdFrameXfades),
  // not sum(segments) - sum(motionXfades).
  //
  // When false: classic motion-blend xfade — two motion streams blended
  // together. Right for kinetic transitions (flash, speed-ramp, whip-pan)
  // where the mixing IS the design intent.
  holdFrameMode?: boolean;
  // When true: route through Saga's clean-fade path — segment A fades out
  // to `cleanFadeColor` over half the transition window on its own tail,
  // then segment B fades in from the same color on its own head. The two
  // segments are NEVER simultaneously visible. This physically eliminates
  // the "polluted frame" artifact that motion-mixing xfade can produce on
  // visually-different shot pairs. cleanFadeMode wins over holdFrameMode
  // when both are set.
  cleanFadeMode?: boolean;
  // FFmpeg color spec ("black", "white", "#a08020"). Default "black".
  cleanFadeColor?: string;
};

// Easing helpers — embedded as FFmpeg expressions. The variable P is xfade's
// own progress 0-1; we re-shape it into T (eased progress) and then blend
// channels as A*(1-T) + B*T.

// sine in-out: T = 0.5 - 0.5*cos(P*PI)   (PI ~= 3.14159265)
const T_SINE = '(0.5-0.5*cos(P*3.14159265))';

// expo out: T = 1 - 2^(-10*P) (clamped at P>=0.999)
const T_EXPO_OUT = '(if(gte(P,0.999), 1, 1-pow(2,-10*P)))';

// Expo-out crossfade — fast exit from A, slow settle into B (good for
// energetic / push transitions).
const EXPR_CROSSFADE_EXPO = `A*(1-${T_EXPO_OUT})+B*${T_EXPO_OUT}`;

// White flash with peak at P=0.5 — used for high-impact register shifts.
// Phase 1 (P<0.5): A → white, progress 2*P
// Phase 2 (P>=0.5): white → B, progress 2*(P-0.5)
const EXPR_FLASH_WHITE = `if(lt(P,0.5), A*(1-2*P)+255*2*P, 255*(2-2*P)+B*(2*P-1))`;

// Light-leak — soft brightness lift around midpoint while crossfading.
//
// xfade applies the same expression to every channel of the pixel format.
// In YUV (xfade's default), Y is brightness centered around 0..255 but U/V
// are CHROMA centered around 128. A multiplicative boost (channel * 1.x)
// amplifies whatever chroma is present — pushing skin/midtones toward
// magenta/violet during the bell curve. Visible as the entire frame
// going purple at midpoint.
//
// Bell-curve additive lift on Y only is what we actually want, but we
// can't pick a single channel inside an xfade expression. The clean
// FFmpeg-side solution is a sine crossfade (which is mathematically
// channel-safe) — Saga's shader-based light-leak with proper additive
// bloom + lens flare is reserved for Phase B (WebGL shader port).
// Match-cut hold — keep A visible for the first 85% of the transition
// window then snap quickly to B. Earlier 70/30 split produced a visible
// "two clips drifting at once" feeling for ~120ms. 85/15 reads as a sharp
// anticipation cut without leaking the next clip into the held window.
//
// NOTE: this is a "soft hold" — A keeps playing at native speed during
// the held window. A true freeze-frame match cut requires a pre-roll
// `tpad=stop_mode=clone` filter, which is a future iteration.
const EXPR_MATCH_CUT_HOLD = `if(lt(P,0.85), A, A*(1-(P-0.85)/0.15)+B*(P-0.85)/0.15)`;

// Speed-ramp feel — biased toward holding A early, then accelerating into
// B. Previous pow(P, 0.45) made B 32% visible at P=0.1 which read as B
// "jumping in" too fast. pow(P, 0.85) keeps the ramp gentle until ~70% in.
const EXPR_SPEED_RAMP_FEEL = `A*(1-pow(P,0.85))+B*pow(P,0.85)`;

// Glitch: bell-curved noise displacement around the midpoint plus a sine
// crossfade. Earlier amplitude of 90 fully scrambled pixels (looked broken,
// not stylized). 30 reads as a tasteful digital artifact at the cut.
const EXPR_GLITCH = `min(255, max(0, (A*(1-${T_SINE})+B*${T_SINE}) + (mod(X*7+Y*11+P*97, 91)/91*2-1) * 4*P*(1-P)*30))`;

export const SAGA_TRANSITION_CATALOG: Record<SagaTransitionKind, SagaTransitionDescriptor> = {
  cut: {
    kind: 'cut',
    ffmpegXfade: null,
    expression: null,
    intent: 'disruption',
    recommendedDurationMs: 0,
    notes: 'Hard cut. Use for register shifts, energy beats, or new acts.',
  },
  crossfade: {
    kind: 'crossfade',
    ffmpegXfade: null,
    expression: null,
    intent: 'continuation',
    recommendedDurationMs: 400,
    notes: 'Clean fade-out → black → fade-in. The two segments are never simultaneously visible.',
    cleanFadeMode: true,
    cleanFadeColor: 'black',
  },
  dissolve: {
    kind: 'dissolve',
    ffmpegXfade: null,
    expression: null,
    intent: 'drift',
    recommendedDurationMs: 700,
    notes: 'Slower clean fade-out → black → fade-in. Dreamy bridge.',
    cleanFadeMode: true,
    cleanFadeColor: 'black',
  },
  'light-leak': {
    kind: 'light-leak',
    ffmpegXfade: null,
    expression: null,
    intent: 'continuation',
    recommendedDurationMs: 500,
    notes: 'Clean fade-out → warm white → fade-in. Cinematic Saga signature.',
    cleanFadeMode: true,
    cleanFadeColor: 'white',
  },
  'fade-black': {
    kind: 'fade-black',
    ffmpegXfade: null,
    expression: null,
    intent: 'reveal',
    recommendedDurationMs: 800,
    notes: 'Long clean fade-out → black → fade-in. Use to mark act breaks.',
    cleanFadeMode: true,
    cleanFadeColor: 'black',
  },
  'fade-white': {
    kind: 'fade-white',
    ffmpegXfade: null,
    expression: null,
    intent: 'reveal',
    recommendedDurationMs: 700,
    notes: 'Long clean fade-out → white → fade-in. Bright punctuation.',
    cleanFadeMode: true,
    cleanFadeColor: 'white',
  },
  'wipe-left': {
    kind: 'wipe-left',
    ffmpegXfade: 'wipeleft',
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 350,
    notes: 'Directional motion. Pairs well with sports / news / pace.',
  },
  'wipe-right': {
    kind: 'wipe-right',
    ffmpegXfade: 'wiperight',
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 350,
    notes: 'Mirror of wipe-left.',
  },
  'slide-up': {
    kind: 'slide-up',
    ffmpegXfade: 'slideup',
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 350,
    notes: 'Vertical reveal. Fits 9:16.',
  },
  'push-left': {
    kind: 'push-left',
    ffmpegXfade: 'smoothleft',
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 400,
    notes: 'Soft horizontal push.',
  },
  'push-right': {
    kind: 'push-right',
    ffmpegXfade: 'smoothright',
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 400,
    notes: 'Mirror of push-left.',
  },
  'circle-open': {
    kind: 'circle-open',
    ffmpegXfade: 'circleopen',
    expression: null,
    intent: 'reveal',
    recommendedDurationMs: 700,
    notes: 'Iris open. Story start / new chapter.',
  },
  'circle-close': {
    kind: 'circle-close',
    ffmpegXfade: 'circleclose',
    expression: null,
    intent: 'reveal',
    recommendedDurationMs: 700,
    notes: 'Iris close. Story end / chapter close.',
  },
  blur: {
    kind: 'blur',
    ffmpegXfade: 'hblur',
    expression: null,
    intent: 'drift',
    recommendedDurationMs: 600,
    notes: 'Native xfade horizontal blur transition.',
  },
  'zoom-in': {
    kind: 'zoom-in',
    ffmpegXfade: 'zoomin',
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 400,
    notes: 'Push into the next shot. Strong forward motion.',
  },
  'zoom-out': {
    kind: 'zoom-out',
    ffmpegXfade: null,
    expression: EXPR_CROSSFADE_EXPO,
    intent: 'reveal',
    recommendedDurationMs: 600,
    notes: 'Expo-eased crossfade — fast exit from A, slow settle into B.',
  },

  // === New v2 kinds ===
  flash: {
    kind: 'flash',
    ffmpegXfade: null,
    expression: EXPR_FLASH_WHITE,
    intent: 'energy',
    recommendedDurationMs: 100,
    notes: 'White flash sandwich — A → full white at midpoint → B. High-impact beat punctuation.',
  },
  'speed-ramp': {
    kind: 'speed-ramp',
    ffmpegXfade: null,
    expression: EXPR_SPEED_RAMP_FEEL,
    intent: 'energy',
    recommendedDurationMs: 300,
    notes: 'Strong ease-out (P^0.45) crossfade. Reads as a speed-ramp into the next shot.',
  },
  'whip-pan': {
    kind: 'whip-pan',
    ffmpegXfade: 'hrwind',
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 280,
    notes: 'Native xfade horizontal-right wind — feels like a whip pan to the right.',
  },
  'whip-pan-left': {
    kind: 'whip-pan-left',
    ffmpegXfade: 'hlwind',
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 280,
    notes: 'Native xfade horizontal-left wind — feels like a whip pan to the left.',
  },
  'match-cut': {
    kind: 'match-cut',
    ffmpegXfade: null,
    expression: EXPR_MATCH_CUT_HOLD,
    intent: 'reveal',
    recommendedDurationMs: 220,
    notes: 'Holds A for 70% of the window then snaps to B. Anticipation cut.',
  },
  glitch: {
    kind: 'glitch',
    ffmpegXfade: null,
    expression: EXPR_GLITCH,
    intent: 'disruption',
    recommendedDurationMs: 220,
    notes: 'Sine cross + pseudo-noise displacement around midpoint. Cyberpunk energy.',
  },
  'cinematic-fade': {
    kind: 'cinematic-fade',
    ffmpegXfade: null,
    expression: null,
    intent: 'drift',
    recommendedDurationMs: 800,
    notes: 'Long clean fade-out → black → fade-in. Emotional drift transitions.',
    cleanFadeMode: true,
    cleanFadeColor: 'black',
  },
  'iris-pulse': {
    kind: 'iris-pulse',
    ffmpegXfade: 'radial',
    expression: null,
    intent: 'reveal',
    recommendedDurationMs: 600,
    notes: 'Radial xfade — light pulses outward from center.',
  },
  'squeeze-h': {
    kind: 'squeeze-h',
    ffmpegXfade: 'squeezeh',
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 350,
    notes: 'Horizontal squeeze. Punchy beat transition.',
  },
  'squeeze-v': {
    kind: 'squeeze-v',
    ffmpegXfade: 'squeezev',
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 350,
    notes: 'Vertical squeeze. Variant for 9:16.',
  },
  'cover-down': {
    kind: 'cover-down',
    ffmpegXfade: 'coverdown',
    expression: null,
    intent: 'reveal',
    recommendedDurationMs: 400,
    notes: 'B slides in from above and covers A.',
  },
  'cover-up': {
    kind: 'cover-up',
    ffmpegXfade: 'coverup',
    expression: null,
    intent: 'reveal',
    recommendedDurationMs: 400,
    notes: 'B rises from below and covers A.',
  },
  'reveal-left': {
    kind: 'reveal-left',
    ffmpegXfade: 'revealleft',
    expression: null,
    intent: 'reveal',
    recommendedDurationMs: 400,
    notes: 'A slides off to the left, revealing B underneath.',
  },

  // === WebGL shader transitions (Phase B) ===
  'shader-light-leak': {
    kind: 'shader-light-leak',
    ffmpegXfade: null,
    expression: null,
    intent: 'continuation',
    recommendedDurationMs: 600,
    notes: 'Saga GLSL shader: warm horizontal light sweep + center kiss in clean RGB. Bypasses YUV channel-mixing artifacts.',
    isShader: true,
  },
  'shader-whip-pan': {
    kind: 'shader-whip-pan',
    ffmpegXfade: null,
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 350,
    notes: 'Saga GLSL shader: horizontal motion blur slide with warm seam streak.',
    isShader: true,
  },
  'shader-glitch': {
    kind: 'shader-glitch',
    ffmpegXfade: null,
    expression: null,
    intent: 'disruption',
    recommendedDurationMs: 320,
    notes: 'Saga GLSL shader: digital block tear, RGB channel split, scanlines, byte-error specks.',
    isShader: true,
  },
  'shader-cinematic-zoom': {
    kind: 'shader-cinematic-zoom',
    ffmpegXfade: null,
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 500,
    notes: 'Saga GLSL shader: radial zoom blur with edge chromatic aberration.',
    isShader: true,
  },
  'shader-domain-warp': {
    kind: 'shader-domain-warp',
    ffmpegXfade: null,
    expression: null,
    intent: 'drift',
    recommendedDurationMs: 700,
    notes: 'Saga GLSL shader: 2-pass fbm domain-warp morph with accent edge glow.',
    isShader: true,
  },
  'shader-ridged-burn': {
    kind: 'shader-ridged-burn',
    ffmpegXfade: null,
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 800,
    notes: 'Saga GLSL shader: ridged-noise burn front with hot accent fringe + sparks.',
    isShader: true,
  },
  'shader-sdf-iris': {
    kind: 'shader-sdf-iris',
    ffmpegXfade: null,
    expression: null,
    intent: 'reveal',
    recommendedDurationMs: 700,
    notes: 'Saga GLSL shader: signed-distance-field iris with glowing accent ring.',
    isShader: true,
  },
  'shader-ripple-waves': {
    kind: 'shader-ripple-waves',
    ffmpegXfade: null,
    expression: null,
    intent: 'drift',
    recommendedDurationMs: 600,
    notes: 'Saga GLSL shader: concentric radial ripple distortion + crossfade.',
    isShader: true,
  },
  'shader-gravitational-lens': {
    kind: 'shader-gravitational-lens',
    ffmpegXfade: null,
    expression: null,
    intent: 'disruption',
    recommendedDurationMs: 800,
    notes: 'Saga GLSL shader: pseudo black-hole pull with chromatic aberration and event-horizon darkening.',
    isShader: true,
  },
  'shader-chromatic-split': {
    kind: 'shader-chromatic-split',
    ffmpegXfade: null,
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 450,
    notes: 'Saga GLSL shader: RGB channels separate radially then recombine on B.',
    isShader: true,
  },
  'shader-swirl-vortex': {
    kind: 'shader-swirl-vortex',
    ffmpegXfade: null,
    expression: null,
    intent: 'drift',
    recommendedDurationMs: 700,
    notes: 'Saga GLSL shader: spiral rotation around center, unwinding into B.',
    isShader: true,
  },
  'shader-thermal-distortion': {
    kind: 'shader-thermal-distortion',
    ffmpegXfade: null,
    expression: null,
    intent: 'drift',
    recommendedDurationMs: 700,
    notes: 'Saga GLSL shader: vertical heat-shimmer noise drifting upward + warm tint.',
    isShader: true,
  },
  'shader-flash-through-white': {
    kind: 'shader-flash-through-white',
    ffmpegXfade: null,
    expression: null,
    intent: 'energy',
    recommendedDurationMs: 220,
    notes: 'Saga GLSL shader: triangular peak to clean RGB white at midpoint, then reveal B.',
    isShader: true,
  },
  'shader-cross-warp-morph': {
    kind: 'shader-cross-warp-morph',
    ffmpegXfade: null,
    expression: null,
    intent: 'drift',
    recommendedDurationMs: 800,
    notes: 'Saga GLSL shader: asymmetric noise warps A and B and crossfades through a noise mask.',
    isShader: true,
  },
};

export function isShaderTransition(kind: SagaTransitionKind): boolean {
  return Boolean(SAGA_TRANSITION_CATALOG[kind]?.isShader);
}

export function isCleanFadeTransition(kind: SagaTransitionKind): boolean {
  return Boolean(SAGA_TRANSITION_CATALOG[kind]?.cleanFadeMode);
}

export function cleanFadeColorFor(kind: SagaTransitionKind): string {
  return SAGA_TRANSITION_CATALOG[kind]?.cleanFadeColor ?? 'black';
}

export function describeTransition(kind: SagaTransitionKind): SagaTransitionDescriptor {
  return SAGA_TRANSITION_CATALOG[kind] ?? SAGA_TRANSITION_CATALOG.crossfade;
}

export function planTransition(kind: SagaTransitionKind, overrideMs?: number): SagaTransitionPlan {
  const descriptor = describeTransition(kind);
  const ms = typeof overrideMs === 'number' && overrideMs >= 0 ? overrideMs : descriptor.recommendedDurationMs;
  return { kind, durationMs: ms };
}

export function isHardCut(plan: SagaTransitionPlan): boolean {
  return plan.kind === 'cut' || plan.durationMs === 0;
}

// Compile the xfade filter portion of a single transition — used by concat.ts.
// Returns the `transition=...:duration=...:offset=...` argument body.
export function compileXfadeFilterArgs(options: {
  plan: SagaTransitionPlan;
  durationSeconds: number;
  offsetSeconds: number;
}): string {
  const descriptor = describeTransition(options.plan.kind);
  const dur = options.durationSeconds.toFixed(3);
  const off = options.offsetSeconds.toFixed(3);
  if (descriptor.expression) {
    // Custom expression. xfade's `expr=` parses semicolons specially in the
    // ffmpeg filtergraph, so we use single-quote escaping where needed.
    return `xfade=transition=custom:expr='${descriptor.expression}':duration=${dur}:offset=${off}`;
  }
  const transition = descriptor.ffmpegXfade ?? 'fade';
  return `xfade=transition=${transition}:duration=${dur}:offset=${off}`;
}
