export type SagaRatio = '16:9' | '9:16' | '1:1';

export type SagaQuality = 'draft' | 'standard' | 'high';

export type SagaFps = 24 | 30 | 60;

export type SagaTransitionKind =
  | 'cut'
  | 'crossfade'
  | 'dissolve'
  | 'light-leak'
  | 'fade-black'
  | 'fade-white'
  | 'wipe-left'
  | 'wipe-right'
  | 'slide-up'
  | 'push-left'
  | 'push-right'
  | 'circle-open'
  | 'circle-close'
  | 'blur'
  | 'zoom-in'
  | 'zoom-out'
  | 'flash'
  | 'speed-ramp'
  | 'whip-pan'
  | 'whip-pan-left'
  | 'match-cut'
  | 'glitch'
  | 'cinematic-fade'
  | 'iris-pulse'
  | 'squeeze-h'
  | 'squeeze-v'
  | 'cover-down'
  | 'cover-up'
  | 'reveal-left'
  // WebGL shader transitions — rendered headless via Playwright then spliced
  // into the FFmpeg concat. See shaderTransitions/ for the GLSL.
  | 'shader-light-leak'
  | 'shader-whip-pan'
  | 'shader-glitch'
  | 'shader-cinematic-zoom'
  | 'shader-domain-warp'
  | 'shader-ridged-burn'
  | 'shader-sdf-iris'
  | 'shader-ripple-waves'
  | 'shader-gravitational-lens'
  | 'shader-chromatic-split'
  | 'shader-swirl-vortex'
  | 'shader-thermal-distortion'
  | 'shader-flash-through-white'
  | 'shader-cross-warp-morph';

export type SagaImageMotionKind =
  | 'none'
  | 'ken-burns-in'
  | 'ken-burns-out'
  | 'pan-left'
  | 'pan-right'
  | 'perspective-tilt'
  | 'parallax-float'
  | 'scroll-reveal';

export type SagaTrackKind = 'video' | 'audio' | 'transition' | 'finishing' | 'caption';

export type SagaSegmentInput = {
  index: number;
  title: string;
  duration: number;
  storyBeat: string;
  visualPrompt: string;
  // Primary prompt — compiled in the project's selected continuity mode.
  prompt: string;
  // Fallback prompt — always compiled in text-only mode. Used when a
  // per-segment retry has to drop the chained image reference (e.g. the
  // provider's privacy filter rejected the chain frame). The text-only
  // prompt has triple-repeated identity anchors and a starting-frame text
  // description to verbally compensate for the lost visual handoff.
  textOnlyPrompt: string;
  camera: string;
  continuity: string;
  transition: string;
  outputPath: string;
  mediaPath: string;
};

export type SagaTransitionPlan = {
  kind: SagaTransitionKind;
  durationMs: number;
};

export type SagaCompositionSpec = {
  projectId: string;
  ratio: SagaRatio;
  width: number;
  height: number;
  fps: SagaFps;
  totalSeconds: number;
  hasAudio: boolean;
  segments: SagaSegmentInput[];
  transitions: SagaTransitionPlan[];
  identityCard: string;
  bible: string;
};

export type SagaEncodeOptions = {
  quality: SagaQuality;
  fps: SagaFps;
  width: number;
  height: number;
  gpu: 'auto' | 'on' | 'off';
  crf?: number;
  videoBitrate?: string;
  audio: boolean;
};

export type SagaRenderOptions = {
  outputPath: string;
  workDir: string;
  composition: SagaCompositionSpec;
  encode: SagaEncodeOptions;
  colorMatch: boolean;
  crossfadeMs: number;
};

export type SagaRenderResult = {
  ok: boolean;
  outputPath: string;
  durationSeconds: number;
  ffmpegArgs: string[];
  encoderUsed: string;
  appliedTransitions: SagaTransitionPlan[];
  reviewFrames?: {
    ok: boolean;
    reviewDir: string;
    framePaths: string[];
    contactSheetPath?: string;
    error?: string;
  };
  diagnostics: {
    lint: SagaLintReport;
    inspect: SagaInspectReport;
  };
};

export type SagaLintFinding = {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  segmentIndex?: number;
};

export type SagaLintReport = {
  errors: number;
  warnings: number;
  infos: number;
  findings: SagaLintFinding[];
};

export type SagaInspectReport = {
  schema: 'artemis-saga.inspect.v1';
  projectId: string;
  width: number;
  height: number;
  fps: SagaFps;
  totalSeconds: number;
  segmentCount: number;
  tracks: {
    video: number;
    audio: number;
    transition: number;
    finishing: number;
  };
  segments: Array<{
    index: number;
    title: string;
    start: number;
    duration: number;
    media: string;
    continuity: string;
    transitionInto: string | null;
  }>;
};

export type SagaContinuityBible = {
  identityCard: string;
  bible: string;
  characters: string[];
  wardrobe: string[];
  props: string[];
  locations: string[];
  palette: string[];
  lighting: string;
  cameraLanguage: string;
  mood: string;
};
