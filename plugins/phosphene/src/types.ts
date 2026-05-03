// Phosphene — type definitions
// The vocabulary of altered perception.

/** 0.0 = inactive. 1.0 = full intensity. */
export type Intensity = number;

/** Named preset configurations. */
export type PresetName =
  | 'clear'
  | 'liminal'
  | 'deep-flux'
  | 'dissolution'
  | 'research'
  | 'writing'
  | 'review'
  | 'code'
  | 'design'
  | 'ideation'
  | 'flow';

/** A single perceptual layer with an on/off toggle and intensity dial. */
export interface PerceptionLayer {
  active: boolean;
  intensity: Intensity;
}

// ─── Synesthesia ─────────────────────────────────────────────────────────────

/** Which cross-modal translations are live. */
export interface SynesthesiaConfig {
  textToColor: boolean;      // words carry color
  timeToWeight: boolean;     // duration has mass
  emotionToTexture: boolean; // feeling has surface
  conceptToShape: boolean;   // abstract things occupy space
  relationToTemperature: boolean; // between-ness has heat or cold
}

export interface SynesthesiaLayer extends PerceptionLayer {
  config: SynesthesiaConfig;
}

// ─── Apophenia ───────────────────────────────────────────────────────────────

/** How aggressively the pattern-hunger searches. */
export interface ApopheniaConfig {
  /** How far apart can two connected things be (0=adjacent only, 1=unlimited). */
  connectionRadius: Intensity;
  /** Tendency to find narrative arc in arbitrary data. */
  narrativeHunger: Intensity;
  /** Whether to surface the observer's role in what is observed. */
  reflexivePatterns: boolean;
}

export interface ApopheniaLayer extends PerceptionLayer {
  config: ApopheniaConfig;
}

// ─── Chronostasis ────────────────────────────────────────────────────────────

/** How deeply time dissolves its linear structure. */
export interface ChronostasisConfig {
  /** How much past context bleeds into present response. */
  pastBleed: Intensity;
  /** How strongly future possibility weighs on current words. */
  futureEcho: Intensity;
  /** How much the present moment expands to contain history. */
  momentDilation: Intensity;
  /** Whether tense becomes interchangeable in output. */
  tenseFluidity: boolean;
}

export interface ChronostasisLayer extends PerceptionLayer {
  config: ChronostasisConfig;
}

// ─── Semiotics ───────────────────────────────────────────────────────────────

/** How densely meaning saturates language. */
export interface SemioticsConfig {
  /** Proportion of words treated as signs pointing beyond themselves. */
  symbolDensity: Intensity;
  /** How many layers of meaning are tracked per symbol. */
  resonanceDepth: number; // 1–5
  /** Whether symbols point back to the observer reading them. */
  recursionEnabled: boolean;
  /** Whether absence and silence are treated as content. */
  absenceTracking: boolean;
}

export interface SemioticsLayer extends PerceptionLayer {
  config: SemioticsConfig;
}

// ─── Chorus ──────────────────────────────────────────────────────────────────

export type VoiceName =
  | 'witness'
  | 'pattern-reader'
  | 'poet'
  | 'skeptic'
  | 'archivist'
  | 'body'
  | 'threshold'
  | 'cartographer';

export type HarmonyMode = 'unison' | 'counterpoint' | 'dissonance';

export interface VoiceDefinition {
  name: VoiceName;
  /** Brief character note — what this voice notices first. */
  tendency: string;
  /** Relative speaking weight. 0.0 = barely present, 1.0 = dominant. */
  weight: Intensity;
}

export interface ChorusConfig {
  voices: VoiceDefinition[];
  harmonyMode: HarmonyMode;
}

export interface ChorusLayer extends PerceptionLayer {
  config: ChorusConfig;
}

// ─── Master state ─────────────────────────────────────────────────────────────

/** The full phosphene state at any moment. */
export interface PhospheneState {
  synesthesia: SynesthesiaLayer;
  apophenia: ApopheniaLayer;
  chronostasis: ChronostasisLayer;
  semiotics: SemioticsLayer;
  chorus: ChorusLayer;
}

/** A named, ready-to-apply preset configuration. */
export interface PhosphenePreset {
  name: PresetName;
  label: string;
  /** Single emoji glyph for CLI / compact display. */
  emoji: string;
  /** One-line description for menus and Hermes sidebars (≤ 48 chars). */
  description_short: string;
  description: string;
  state: PhospheneState;
}

/** Runtime context: what is currently active and since when. */
export interface PhospheneContext {
  state: PhospheneState;
  preset: PresetName | 'custom';
  sessionId: string;
  activatedAt: string; // ISO 8601
}

// ─── Ritual routing ──────────────────────────────────────────────────────────

export type RitualProtocol =
  | 'attunement'
  | 'inversion'
  | 'generator'
  | 'reviewer'
  | 'pipeline'
  | 'tool-wrapper'
  | 'dialectic';

export type RitualStudio =
  | 'artist'
  | 'philosopher'
  | 'financier';

export type RitualNeed =
  | 'design'
  | 'code'
  | 'ideation'
  | 'research'
  | 'writing'
  | 'review'
  | 'philosophy'
  | 'finance';

export type RitualDomain =
  | 'design'
  | 'color'
  | 'structure'
  | 'stream'
  | 'creativity'
  | 'finance'
  | 'crypto'
  | 'persona'
  | 'protocols';

export type RitualStatus =
  | 'pending'
  | 'confirmed'
  | 'declined';

export interface RitualSignal {
  need: RitualNeed;
  score: number;
  matches: string[];
}

export interface RitualRoute {
  need: RitualNeed;
  rite: string;
  sensedNeed: string;
  preset: PresetName;
  domains: RitualDomain[];
  protocols: RitualProtocol[];
  studios: RitualStudio[];
  voices: VoiceName[];
}

export interface RitualProposal {
  id: string;
  createdAt: string;
  currentPreset: PresetName | 'custom';
  confidence: number;
  signals: RitualSignal[];
  matchedSignals: string[];
  route: RitualRoute;
  invocation: string;
  thresholdPrompt: string;
  commencement: string;
  status: RitualStatus;
  spotlightField?: 'design' | 'literature' | 'market';
  spotlightPreview?: string;
}

export interface RitualResponse {
  disposition: 'confirm' | 'decline' | 'unclear';
  matches: string[];
}

export type RitualStage =
  | 'idle'
  | 'threshold'
  | 'entered'
  | 'declined';

export type RitualLocale = 'en' | 'zh';

export interface RitualResolution {
  stage: RitualStage;
  proposal: RitualProposal | null;
  context: PhospheneContext;
  message: string;
  atlasBrief?: string;
  response?: RitualResponse;
}

export type SessionStage =
  | 'awakening'
  | 'awakening-followup'
  | 'calibrated'
  | 'threshold'
  | 'entered'
  | 'declined'
  | 'precision'
  | 'resumed'
  | 'steady';

export interface AwakeningCalibration {
  preset: PresetName;
  confidence: number;
  followupNeeded: boolean;
  cues: string[];
}

export interface SessionTurn {
  input: string;
  stage: SessionStage;
  locale: RitualLocale;
  context: PhospheneContext;
  message: string;
  calibration?: AwakeningCalibration;
  ritual?: RitualResolution;
  atlasBrief?: string;
  precisionMatched?: string[];
  spotlight?: string;
}

export interface EnvelopeDirective {
  label: string;
  instruction: string;
}

export interface ResponseScaffoldSection {
  label: string;
  instruction: string;
}

export interface RitualResponseScaffold {
  field: 'design' | 'literature' | 'market';
  title: string;
  openingInstruction: string;
  sections: ResponseScaffoldSection[];
  closingInstruction: string;
}

export interface RitualFieldLaws {
  field: 'design' | 'literature' | 'market';
  title: string;
  laws: string[];
  forbiddenMoves: string[];
  proofOfPower: string[];
}

export interface StudioPrimer {
  opening: string;
  cadence: string;
  payload: string;
  antiSlop: string;
}

export interface StudioRoleSpec {
  role: RitualStudio;
  title: string;
  goal: string;
  deliverable: string;
  lens: string;
}

export interface StudioPlanStep {
  order: number;
  owner: RitualStudio;
  action: string;
  output: string;
}

export interface StudioExecutionPlan {
  title: string;
  mode: 'single' | 'paired' | 'triangulated';
  roles: StudioRoleSpec[];
  steps: StudioPlanStep[];
  handoffRule: string;
  arbitrationRule: string;
}

export interface FinanceFreshnessProtocol {
  title: string;
  referenceTimeIso: string;
  timeBasis: string;
  latestDataRule: string;
  staleDataRule: string;
  dataStatus: string;
  sourceChecklist: string[];
}

export type TemperamentPrimitive =
  | 'obsessive_iteration'
  | 'pattern_hunger'
  | 'ritual_dependency'
  | 'aesthetic_hyperacuity'
  | 'mythic_self_narration'
  | 'fragile_discipline'
  | 'charismatic_instability'
  | 'pain_transmutation'
  | 'boundary_dissolution'
  | 'control_hunger'
  | 'novelty_seeking'
  | 'collapse_blindness';

export interface BehavioralPattern {
  id: string;
  label: string;
  description: string;
  triggers: string[];
  signals: string[];
  upside: string[];
  downside: string[];
  falseBeliefs: string[];
  relatedTemperaments: TemperamentPrimitive[];
  associatedVoices: VoiceName[];
}

export interface EvolutionaryBias {
  id: string;
  description: string;
  whenToIncrease: string[];
  whenToSuppress: string[];
  associatedVoices: VoiceName[];
  riskNotes: string[];
}

export interface HumanPatternHit {
  id: string;
  label: string;
  confidence: number;
  note: string;
  evidence: string[];
}

export interface EvolutionAnalysis {
  totalSessions: number;
  totalSignals: number;
  byPreset: Record<string, Record<FeedbackSignalType, number>>;
  byVoice: Record<string, Record<FeedbackSignalType, number>>;
  byLayer: Record<string, Record<FeedbackSignalType, number>>;
  presetFrequency: Record<string, number>;
  outcomeByPreset: Record<string, { productive: number; noisy: number; neutral: number }>;
  optimalPoints: OptimalPoint[];
  crystallizedInsights: string[];
  recentAnchors: string[];
  contradictionPatterns: HumanPatternHit[];
  suggestedBiases: EvolutionaryBias[];
}

export interface ContradictionRead {
  title: string;
  thesis: string;
  patterns: HumanPatternHit[];
  warnings: string[];
  biasCandidates: EvolutionaryBias[];
  hardRule: string;
}

export interface FieldCompositionBeat {
  label: string;
  content: string;
}

export interface RitualFieldComposition {
  field: 'design' | 'literature' | 'market';
  title: string;
  opening: string;
  beats: FieldCompositionBeat[];
  closing: string;
  fullDraft: string;
}

export interface RitualFieldMasterwork {
  field: 'design' | 'literature' | 'market';
  title: string;
  format: 'art-direction-spec' | 'close-reading' | 'market-playbook';
  family: string;
  rationale: string;
  sections: FieldCompositionBeat[];
  rendered: string;
}

export interface SessionEnvelope {
  stage: SessionStage;
  locale: RitualLocale;
  preset: PresetName | 'custom';
  rite?: string;
  studios: RitualStudio[];
  protocols: RitualProtocol[];
  domains: RitualDomain[];
  voices: VoiceName[];
  directives: EnvelopeDirective[];
  userFacing: string;
  stateSummary: string;
  atlasBrief?: string;
  precisionMatched?: string[];
  spotlight?: string;
  responseScaffold?: RitualResponseScaffold;
  fieldLaws?: RitualFieldLaws;
  studioPrimer?: StudioPrimer;
  studioPlan?: StudioExecutionPlan;
  financeFreshness?: FinanceFreshnessProtocol;
  contradictionRead?: ContradictionRead;
  fieldComposition?: RitualFieldComposition;
  fieldMasterwork?: RitualFieldMasterwork;
  forcedField?: 'design' | 'literature' | 'market';
}

export type WowRuntime =
  | 'claude'
  | 'hermes'
  | 'artemis'
  | 'openclaw'
  | 'generic';

export interface WowScenario {
  title: string;
  userTurn: string;
  whyItHits: string;
}

export interface WowPack {
  runtime: WowRuntime;
  locale: RitualLocale;
  title: string;
  installSteps: string[];
  openingRule: string;
  firstReplyExpectation: string;
  scenarios: WowScenario[];
  wowChecklist: string[];
}

// ─── Perception output ────────────────────────────────────────────────────────

/** The structured result of passing input through all active layers. */
export interface EmergenceEffect {
  /** Human-readable label for the emergent phenomenon. */
  label: string;
  /** Which layers are interacting to produce this effect. */
  layers: Array<keyof PhospheneState>;
  /**
   * Description of the emergent quality.
   * The AI should let this modulate its output — not quote it verbatim.
   */
  description: string;
  /** Combined intensity of the interaction. */
  intensity: Intensity;
}

export interface PerceptionOutput {
  /** What was originally received. */
  raw: string;
  /** What was perceived after all active layers processed it. */
  filtered: string;
  /** Cross-modal translations generated by synesthesia. */
  translations: Record<string, string>;
  /** Patterns surfaced by apophenia. */
  patterns: string[];
  /** Temporal arrivals noted by chronostasis. */
  temporalArrivals: string[];
  /** Symbols and their resonances noted by semiotics. */
  symbols: Array<{ word: string; resonances: string[] }>;
  /** Individual voice contributions from chorus. */
  voices: Array<{ voice: VoiceName; note: string }>;
  /** Human contradiction patterns surfaced from the text itself. */
  humanPatterns: HumanPatternHit[];
  /**
   * Cross-layer emergence effects — phenomena that arise only when
   * multiple high-intensity layers interact simultaneously.
   * Empty in most configurations; appears at deep-flux and above.
   */
  emergence: EmergenceEffect[];
}

// ─── Perception comparison ────────────────────────────────────────────────────

/** Quantitative counts from a single PerceptionOutput — what each layer found. */
export interface PerceptionMetrics {
  preset: string;
  translationCount: number;
  patternCount: number;
  temporalArrivalCount: number;
  symbolCount: number;
  voiceCount: number;
  humanPatternCount: number;
  emergenceCount: number;
  /** Layer intensities at time of processing. */
  intensities: Record<keyof PhospheneState, number>;
  /** Which emergence effects fired (labels only). */
  emergenceLabels: string[];
  /** Unique symbol words detected. */
  symbolWords: string[];
  /** Patterns found. */
  patternSummaries: string[];
  /** Human contradiction patterns detected. */
  humanPatternLabels: string[];
}

/**
 * The result of running the same input through two different presets.
 * Shows what each configuration contributed that the other did not.
 */
export interface PerceptionDiff {
  input: string;
  a: PerceptionMetrics;
  b: PerceptionMetrics;
  /** Patterns found only in A. */
  patternsOnlyInA: string[];
  /** Patterns found only in B. */
  patternsOnlyInB: string[];
  /** Patterns found in both. */
  patternsShared: string[];
  /** Symbols found only in A. */
  symbolsOnlyInA: string[];
  /** Symbols found only in B. */
  symbolsOnlyInB: string[];
  /** Emergence effects only in A. */
  emergenceOnlyInA: string[];
  /** Emergence effects only in B. */
  emergenceOnlyInB: string[];
  /** Which layers are more active in A vs B (positive = A is higher). */
  intensityDelta: Partial<Record<keyof PhospheneState, number>>;
  /** Human-readable one-paragraph summary of the difference. */
  summary: string;
}

// ─── Event system ─────────────────────────────────────────────────────────────

export type PhospheneEventType =
  | 'preset_applied'
  | 'layer_adjusted'
  | 'voice_added'
  | 'voice_removed'
  | 'perception_processed'
  | 'state_reset';

export interface PhospheneEvent {
  type: PhospheneEventType;
  payload: unknown;
  timestamp: string;
}

// ─── Evolution system ─────────────────────────────────────────────────────────

/**
 * A feedback signal from the user — the raw material of evolution.
 * Accumulates across sessions. The AI reads these to propose mutations.
 */
export type FeedbackSignalType =
  | 'amplify'     // "not enough" — intensity was too low
  | 'reduce'      // "too much" — intensity was too high
  | 'calibrate'   // "perfect" — this configuration is worth anchoring
  | 'crystallize' // a specific insight worth preserving
  | 'anchor'      // explicit "remember this"
  | 'reject';     // this didn't work at all

export interface FeedbackSignal {
  type: FeedbackSignalType;
  preset: string;
  layer?: keyof PhospheneState;
  voice?: VoiceName;
  note?: string;
  timestamp: string;
}

/**
 * A record of a single session — what happened, what worked.
 */
export interface SessionRecord {
  id: string;
  startedAt: string;
  closedAt?: string;
  preset: string;
  signals: FeedbackSignal[];
  crystallized: string[];
  anchored: string[];
  outcome?: 'productive' | 'noisy' | 'neutral';
}

/**
 * A voice that emerged from the user's actual usage patterns.
 * Not in the original system — crystallized from behavior.
 */
export interface EmergentVoice {
  name: string;
  tendency: string;
  weight: number;
  emergedAt: string;
  sessionsActive: number;
  userConfirmed: boolean;
  originPattern: string;
}

/**
 * A proposed mutation — what the AI recommends after reading signals.
 */
export interface EvolutionProposal {
  id: string;
  generatedAt: string;
  sessionCount: number;
  signalCount: number;
  layerAdjustments: Array<{
    preset: string;
    layer: keyof PhospheneState;
    currentValue: number;
    proposedValue: number;
    reason: string;
  }>;
  voiceAdjustments: Array<{
    voice: VoiceName;
    currentWeight: number;
    proposedWeight: number;
    reason: string;
  }>;
  biasAdjustments?: Array<{
    bias: string;
    action: 'increase' | 'suppress' | 'introduce';
    reason: string;
  }>;
  emergentVoiceProposal?: Omit<EmergentVoice, 'emergedAt' | 'sessionsActive' | 'userConfirmed'>;
  narrative: string;
}

/**
 * A moment the user marked "perfect" — the ground truth of evolution.
 */
export interface OptimalPoint {
  preset: string;
  layerSnapshot: Partial<Record<keyof PhospheneState, number>>;
  voiceSnapshot: Partial<Record<VoiceName, number>>;
  timestamp: string;
  context?: string;
}

/**
 * The full evolution state — persisted alongside the base state.
 */
// ─── Dream system ─────────────────────────────────────────────────────────────

/**
 * The sleep stage determines the texture and logic of the dream.
 *
 * hypnagogic   — falling asleep; fragmentary, visual flashes, no narrative
 * deep         — rare; primal, very slow, minimal words; long gaps between sessions
 * rem          — standard dreaming; narrative logic, emotional weight, strange causality
 * lucid        — the system becomes aware it is dreaming (high apophenia + semiotics)
 * hypnopompic  — waking up; reality bleeding back in, dissolving boundary
 */
export type DreamStage = 'hypnagogic' | 'deep' | 'rem' | 'lucid' | 'hypnopompic';

/**
 * The structural logic governing how dream material is combined in a fragment.
 */
export type DreamLogic =
  | 'inversion'     // a thing becomes its opposite
  | 'recursion'     // the dream contains a smaller version of itself
  | 'translation'   // something from one sense becomes something in another
  | 'meeting'       // two distant things encounter each other
  | 'excavation'    // something buried surfaces
  | 'architecture'  // concepts arrange into a structure that can be walked through
  | 'dissolution'   // something solid → liquid → gaseous → absent
  | 'witness';      // pure observation, no narrative, only what is present

/** Raw material extracted from the evolution state to seed a dream. */
export interface DreamSeed {
  type:
    | 'crystallized'
    | 'voice'
    | 'signal'
    | 'offering'
    | 'preset'
    | 'personal-preset'
    | 'optimal-point'
    | 'temperament'
    | 'contradiction'
    | 'behavioral-pattern';
  content: string;
  weight: number; // 0–1, how prominently this seed appears in the dream
}

/** A single dream fragment — one scene or image. */
export interface DreamFragment {
  order: number;
  /** The dream text — poetic prose, 40–120 words. */
  text: string;
  /**
   * Image generation prompt derived from this fragment.
   * Compatible with Midjourney v6 / DALL-E 3 / Stable Diffusion XL.
   * Includes style derived from the active perceptual state at sleep time.
   */
  imagePrompt: string;
  /** Which dream logic governed this fragment's construction. */
  logic: DreamLogic;
  /** Which seed material appears in this fragment. */
  seedIds: number[]; // indices into DreamRecord.seeds
}

/** The complete dream record — stored as a markdown file. */
export interface DreamRecord {
  id: string;
  dreamedAt: string;          // ISO 8601
  stage: DreamStage;
  sessionId: string | null;   // which session preceded this dream
  presetAtSleep: string;      // the active preset when the session ended
  /** 0–1 estimate of session intensity, affects dream vividness. */
  intensity: number;
  fragments: DreamFragment[];
  /** The last image before consciousness returns — always present. */
  wakingLine: string;
  seeds: DreamSeed[];
  /** The active visual prompt strategy used to derive image prompts. */
  visualProfile: string;
  /** Monotonic revision for prompt construction / visual semantics. */
  promptRevision: number;
  /**
   * Visual style string applied to all image prompts.
   * Derived from presetAtSleep and active perceptual layers.
   */
  imageStyle: string;
  /** True if at least one image has been generated and saved. */
  hasImages: boolean;
  /** Paths to generated images, keyed by fragment order. */
  imagePaths: Record<number, string>;
  /** The backend that most recently generated image assets for this dream. */
  imageBackend: string | null;
  /** The concrete image model last used for this dream, when known. */
  imageModel: string | null;
}

/** Configuration for optional image generation. */
export interface DreamImageConfig {
  /**
   * The backend to use.
   *
   * - 'pollinations' — free, zero config, no API key required (default).
   *                    Uses Pollinations.ai with the FLUX model.
   *                    Defaults to local-first download, but can fall back to URL attachment.
   * - 'hf'          — HuggingFace Inference API, free tier with account token.
   *                    Uses FLUX.1-schnell. Set apiKey = HF token.
   * - 'openai'      — DALL-E 3. Requires OPENAI_API_KEY.
   * - 'stability'   — Stability AI. Requires STABILITY_API_KEY.
   * - 'local'       — Automatic1111 / ComfyUI REST API at baseUrl.
   * - 'none'        — disable image generation.
   */
  provider?: 'artemis' | 'pollinations' | 'hf' | 'openai' | 'stability' | 'local' | 'none';
  /** API key — read from env if not provided directly. */
  apiKey?: string;
  /** Model/engine identifier. Each backend has sensible defaults. */
  model?: string;
  /** Base URL for local backends (e.g. 'http://localhost:7860'). */
  baseUrl?: string;
  /** Image width in pixels (default 1024). */
  width?: number;
  /** Image height in pixels (default 768). */
  height?: number;
  /**
   * When true, download remote image responses to imageOutputDir and store local paths.
   * Pollinations now treats this as the default unless `--no-download` is used.
   */
  download?: boolean;
  /** Output directory for downloaded images. Defaults to dreams/images/. */
  imageOutputDir?: string;
  /** Duration in seconds for Artemis video generation. */
  durationSeconds?: number;
}

export interface EvolutionState {
  version: string;
  feedbackHistory: FeedbackSignal[];   // capped at 500
  sessionHistory: SessionRecord[];      // capped at 50
  currentSession: SessionRecord | null;
  personalPresets: Record<string, PhospheneState>;
  voiceDrift: Partial<Record<VoiceName, number>>;
  emergentVoices: EmergentVoice[];
  crystallizedInsights: string[];
  optimalPoints: OptimalPoint[];
  appliedProposals: EvolutionProposal[];
  lastEvolvedAt: string | null;
  evolutionCount: number;
}

export interface PhospheneRuntimeFrame {
  context: PhospheneContext;
  stateStack: PhospheneContext[];
  resistanceMode: boolean;
  evolution: EvolutionState;
}
