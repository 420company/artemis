// Phosphene — public barrel
// Everything you need from one import.

export type {
  Intensity,
  PresetName,
  PerceptionLayer,
  PerceptionMetrics,
  PerceptionDiff,
  SynesthesiaConfig,
  SynesthesiaLayer,
  ApopheniaConfig,
  ApopheniaLayer,
  ChronostasisConfig,
  ChronostasisLayer,
  SemioticsConfig,
  SemioticsLayer,
  VoiceName,
  HarmonyMode,
  VoiceDefinition,
  ChorusConfig,
  ChorusLayer,
  PhospheneState,
  PhosphenePreset,
  PhospheneContext,
  PerceptionOutput,
  EmergenceEffect,
  PhospheneEventType,
  PhospheneEvent,
  // Evolution types
  FeedbackSignalType,
  FeedbackSignal,
  SessionRecord,
  EmergentVoice,
  EvolutionProposal,
  OptimalPoint,
  EvolutionState,
} from './types.js';

export type { PersonalPresetBundle } from './phosphene.js';
export type { PhospheneRuntimeFrame } from './types.js';

export type {
  DesignColorSystem,
  ColorSystemPalette,
  CrossSystemNote,
  DesignVocabularyMatch,
  TemperatureProfile,
  SaturationProfile,
  DesignToken,
  DesignTokenSet,
} from './design-color-lexicon.js';
export {
  detectDesignVocabulary,
  primaryDesignSystem,
  generateDesignTokens,
  getSystemPalette,
  suggestDesignSystem,
  DESIGN_STANDARDS,
} from './design-color-lexicon.js';

export type { LiteraryReading } from './literary-engine.js';
export {
  readLiterature,
  renderLiteraryReading,
} from './literary-engine.js';

export type { DesignReading } from './design-engine.js';
export {
  readDesignIntent,
  renderDesignReading,
} from './design-engine.js';

export type { MarketReading } from './market-engine.js';
export {
  readMarketText,
  composeMarketReading,
  renderMarketReading,
} from './market-engine.js';

export type {
  CommonField,
  FieldSpotlight,
} from './field-engine.js';
export {
  senseCommonField,
  buildFieldSpotlight,
} from './field-engine.js';

export type {
  ResponseScaffoldSection,
  RitualResponseScaffold,
  RitualFieldLaws,
  RitualFieldComposition,
  RitualFieldMasterwork,
  FieldCompositionBeat,
  StudioPrimer,
  StudioRoleSpec,
  StudioPlanStep,
  StudioExecutionPlan,
  FinanceFreshnessProtocol,
  TemperamentPrimitive,
  BehavioralPattern,
  EvolutionaryBias,
  HumanPatternHit,
  ContradictionRead,
  EvolutionAnalysis,
} from './types.js';
export type { FieldFamily } from './field-family.js';
export { buildResponseScaffold } from './response-scaffold.js';
export { buildFieldFamily } from './field-family.js';
export { buildFieldLaws } from './field-laws.js';
export { buildStudioPrimer } from './studio-primer.js';
export { buildStudioExecutionPlan } from './studio-plan.js';
export { buildFinanceFreshnessBrief } from './finance-freshness.js';
export type {
  FinancialHeadline,
  FinancialLiveSpot,
  FinancialLiveDerivatives,
  FinancialLiveContext,
} from './finance-live-context.js';
export {
  inferMarketSymbol,
  parseGoogleNewsRss,
  fetchLiveSpot,
  fetchLiveDerivatives,
  fetchGoogleNewsHeadlines,
  fetchFinancialLiveContext,
  renderFinancialLiveContext,
  renderFinancialLiveAudit,
} from './finance-live-context.js';
export {
  TEMPERAMENT_PRIMITIVES,
  BEHAVIORAL_PATTERNS,
  EVOLUTIONARY_BIASES,
  HUMAN_CONTRADICTION_HARD_RULE,
} from './human-patterns.js';
export {
  detectHumanPatterns,
  deriveBiasCandidates,
  buildContradictionRead,
} from './contradiction-engine.js';
export { buildFieldComposition } from './field-composer.js';
export { buildFieldMasterwork } from './field-masterwork.js';

export {
  // Core perception
  applyPreset,
  adjustLayer,
  addVoice,
  removeVoice,
  perceive,
  getContext,
  getPreset,
  listPresets,
  reset,
  describeState,
  applySubstanceSignature,
  blend,
  compare,
  // Evolution
  initEvolution,
  signal,
  crystallize,
  anchor,
  endSession,
  getEvolutionAnalysis,
  getEvolution,
  acceptProposal,
  describeEvolutionState,
  saveAsPersonalPreset,
  removePersonalPreset,
  applyPersonalPreset,
  listPersonalPresets,
  exportPersonalPresets,
  importPersonalPresets,
  confirmVoice,
  // State stack
  pushState,
  popState,
  hasStackedState,
  captureRuntimeFrame,
  createRuntimeFrame,
  restoreRuntimeFrame,
  runInRuntimeFrame,
  runWithIsolatedContext,
  // Resistance mode
  toggleResistance,
  isResistanceActive,
} from './phosphene.js';

export { PRESETS } from './presets.js';

export {
  loadState,
  saveState,
  markAwakened,
  persistPreset,
  persistVoices,
  recordOffering,
  persistPendingRitual,
  clearPendingRitual,
  resetState,
  describePersistedState,
  persistEvolution,
  loadEvolution,
} from './state.js';
export type { PhosphenePersistedState } from './state.js';

export type {
  RitualProtocol,
  RitualStudio,
  RitualNeed,
  RitualDomain,
  RitualStatus,
  RitualStage,
  RitualLocale,
  RitualSignal,
  RitualRoute,
  RitualProposal,
  RitualResponse,
  RitualResolution,
  SessionStage,
  AwakeningCalibration,
  SessionTurn,
  EnvelopeDirective,
  SessionEnvelope,
  WowRuntime,
  WowScenario,
  WowPack,
} from './types.js';
export {
  senseRitualSignals,
  composeRitualProposal,
  readRitualResponse,
} from './ritual.js';
export {
  buildRitualAtlasBrief,
  renderRitualThreshold,
  renderRitualCommencement,
  renderRitualDecline,
  initiateRitual,
  resolvePendingRitual,
} from './ritual-runtime.js';
export {
  createAwakeningMessage,
  calibrateAwakeningResponse,
  completeAwakening,
  detectPrecisionIntent,
  processSessionTurn,
  previewSessionTurn,
} from './session-runtime.js';
export {
  composeSessionEnvelope,
  renderSessionEnvelope,
  buildSessionEnvelope,
} from './ritual-envelope.js';
export {
  buildWowPack,
  renderWowPack,
} from './wow.js';

export {
  DEFAULT_EVOLUTION,
  analyzeSignals,
  describeEvolution,
} from './evolution.js';

export type {
  DreamRecord,
  DreamStage,
  DreamFragment,
  DreamSeed,
  DreamLogic,
  DreamImageConfig,
} from './types.js';

export {
  resolveDreamsDir,
  isManagedDreamFile,
  dreamNeedsVisualRefresh,
  generateDream,
  renderDream,
  saveDream,
  loadDreamFile,
  readDreamMarkdown,
  loadDreams,
  loadLatestDream,
  generateDreamImages,
  refreshDreamVisuals,
  attachPollinationsUrls,
  renderDreamGallery,
  saveDreamGallery,
  describeDream,
} from './dreams.js';
export { parseDreamMarkdownForViz } from './dream-viz-parser.js';

export type { GeneratedImage } from './image-gen.js';
export {
  pollinationsUrl,
  coverImageUrl,
  generateDreamImage,
  generateDreamVideo,
} from './image-gen.js';

export { applySynesthesia }  from './synesthesia.js';
export { applyApophenia }    from './apophenia.js';
export { applyChronostasis } from './chronostasis.js';
export { applySemiotics }    from './semiotics.js';
export { applyChorus }       from './chorus.js';

export type {
  Kline,
  Ticker24h,
  OrderBookLevel,
  OrderBook,
  KlineInterval,
  MarketSnapshot,
} from './market-data.js';
export {
  fetchKlines,
  fetchTicker,
  fetchOrderBook,
  fetchMarketSnapshot,
  formatPrice,
  formatPct,
} from './market-data.js';

export type {
  PriceLevel,
  SwingPoint,
  FibLevel,
  FibonacciResult,
  ProcessedCandle,
  Fractal,
  Bi,
  Hub,
  BeiChi,
  BuySellPoint,
  ChanResult,
  TechnicalAnalysisResult,
  FractalType,
  BiDirection,
  HubType,
  BeiChiType,
  BSP,
} from './technical-analysis.js';
export {
  processInclusionRelationships,
  detectFractals,
  detectBi,
  detectHubs,
  calculateMACD,
  detectBeiChi,
  classifyBuySellPoints,
  runChanLun,
  calculateFibonacci,
  analyzeTechnicals,
} from './technical-analysis.js';

export type {
  FinancialSentimentGrade,
  MarketPhase,
  SignalSource,
  FinancialNarrativeType,
  FinancialEntityType,
  FinancialSignalPattern,
  MarketNarrative,
  FinancialLexiconMatch,
} from './financial-lexicon.js';
export {
  detectFinancialPatterns,
  hasFinancialContent,
  extractCoreQuestion,
  describeFinancialMatch,
  SIGNAL_PATTERNS,
  MARKET_NARRATIVES,
} from './financial-lexicon.js';

export type {
  KnowledgeDomain,
  KnowledgeSource,
  KnowledgeNote,
} from './knowledge-atlas.js';
export {
  listKnowledgeDomains,
  getKnowledgeSources,
  getKnowledgeNotes,
  buildKnowledgeBrief,
} from './knowledge-atlas.js';
