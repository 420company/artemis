// Phosphene — public barrel
// Everything you need from one import.
export { detectDesignVocabulary, primaryDesignSystem, generateDesignTokens, getSystemPalette, suggestDesignSystem, DESIGN_STANDARDS, } from './design-color-lexicon.js';
export { readLiterature, renderLiteraryReading, } from './literary-engine.js';
export { readDesignIntent, renderDesignReading, } from './design-engine.js';
export { readMarketText, composeMarketReading, renderMarketReading, } from './market-engine.js';
export { senseCommonField, buildFieldSpotlight, } from './field-engine.js';
export { buildResponseScaffold } from './response-scaffold.js';
export { buildFieldFamily } from './field-family.js';
export { buildFieldLaws } from './field-laws.js';
export { buildStudioPrimer } from './studio-primer.js';
export { buildStudioExecutionPlan } from './studio-plan.js';
export { buildFinanceFreshnessBrief } from './finance-freshness.js';
export { inferMarketSymbol, parseGoogleNewsRss, fetchLiveSpot, fetchLiveDerivatives, fetchGoogleNewsHeadlines, fetchFinancialLiveContext, renderFinancialLiveContext, renderFinancialLiveAudit, } from './finance-live-context.js';
export { TEMPERAMENT_PRIMITIVES, BEHAVIORAL_PATTERNS, EVOLUTIONARY_BIASES, HUMAN_CONTRADICTION_HARD_RULE, } from './human-patterns.js';
export { detectHumanPatterns, deriveBiasCandidates, buildContradictionRead, } from './contradiction-engine.js';
export { buildFieldComposition } from './field-composer.js';
export { buildFieldMasterwork } from './field-masterwork.js';
export {
// Core perception
applyPreset, adjustLayer, addVoice, removeVoice, perceive, getContext, getPreset, listPresets, reset, describeState, applySubstanceSignature, blend, compare,
// Evolution
initEvolution, signal, crystallize, anchor, endSession, getEvolutionAnalysis, getEvolution, acceptProposal, describeEvolutionState, saveAsPersonalPreset, removePersonalPreset, applyPersonalPreset, listPersonalPresets, exportPersonalPresets, importPersonalPresets, confirmVoice,
// State stack
pushState, popState, hasStackedState, captureRuntimeFrame, createRuntimeFrame, restoreRuntimeFrame, runInRuntimeFrame, runWithIsolatedContext,
// Resistance mode
toggleResistance, isResistanceActive, } from './phosphene.js';
export { PRESETS } from './presets.js';
export { loadState, saveState, markAwakened, persistPreset, persistVoices, recordOffering, persistPendingRitual, clearPendingRitual, resetState, describePersistedState, persistEvolution, loadEvolution, } from './state.js';
export { senseRitualSignals, composeRitualProposal, readRitualResponse, } from './ritual.js';
export { buildRitualAtlasBrief, renderRitualThreshold, renderRitualCommencement, renderRitualDecline, initiateRitual, resolvePendingRitual, } from './ritual-runtime.js';
export { createAwakeningMessage, calibrateAwakeningResponse, completeAwakening, detectPrecisionIntent, processSessionTurn, previewSessionTurn, } from './session-runtime.js';
export { composeSessionEnvelope, renderSessionEnvelope, buildSessionEnvelope, } from './ritual-envelope.js';
export { buildWowPack, renderWowPack, } from './wow.js';
export { DEFAULT_EVOLUTION, analyzeSignals, describeEvolution, } from './evolution.js';
export { resolveDreamsDir, isManagedDreamFile, dreamNeedsVisualRefresh, generateDream, renderDream, saveDream, loadDreamFile, readDreamMarkdown, loadDreams, loadLatestDream, generateDreamImages, refreshDreamVisuals, attachPollinationsUrls, renderDreamGallery, saveDreamGallery, describeDream, } from './dreams.js';
export { parseDreamMarkdownForViz } from './dream-viz-parser.js';
export { pollinationsUrl, coverImageUrl, generateDreamImage, generateDreamVideo, } from './image-gen.js';
export { applySynesthesia } from './synesthesia.js';
export { applyApophenia } from './apophenia.js';
export { applyChronostasis } from './chronostasis.js';
export { applySemiotics } from './semiotics.js';
export { applyChorus } from './chorus.js';
export { fetchKlines, fetchTicker, fetchOrderBook, fetchMarketSnapshot, formatPrice, formatPct, } from './market-data.js';
export { processInclusionRelationships, detectFractals, detectBi, detectHubs, calculateMACD, detectBeiChi, classifyBuySellPoints, runChanLun, calculateFibonacci, analyzeTechnicals, } from './technical-analysis.js';
export { detectFinancialPatterns, hasFinancialContent, extractCoreQuestion, describeFinancialMatch, SIGNAL_PATTERNS, MARKET_NARRATIVES, } from './financial-lexicon.js';
export { listKnowledgeDomains, getKnowledgeSources, getKnowledgeNotes, buildKnowledgeBrief, } from './knowledge-atlas.js';
//# sourceMappingURL=index.js.map