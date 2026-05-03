/**
 * The 7-point sentiment spectrum from FinGPT research.
 * More accurate than binary or ternary classification for financial text.
 * Maps positive integer values to bullish pressure, negative to bearish.
 */
export type FinancialSentimentGrade = 'strong-negative' | 'moderate-negative' | 'mild-negative' | 'neutral' | 'mild-positive' | 'moderate-positive' | 'strong-positive';
/**
 * The six structural phases of a market cycle.
 * From RLSP research: price-aligned pattern detection across 620k+ headlines.
 */
export type MarketPhase = 'accumulation' | 'markup' | 'distribution' | 'topping' | 'markdown' | 'bear-rally';
/**
 * The source type of a financial signal.
 * Different sources carry different temporal weight and reliability.
 */
export type SignalSource = 'price-action' | 'sec-filing' | 'earnings-call' | 'analyst-note' | 'news-wire' | 'social-media' | 'insider-flow' | 'options-flow';
/**
 * A financial narrative archetype — the recurring story structures
 * that markets tell about companies. From FinGPT relation extraction
 * and market structure analysis.
 */
export type FinancialNarrativeType = 'growth' | 'turnaround' | 'disruption' | 'commodity-cycle' | 'regulatory' | 'capital-allocation' | 'contagion' | 'rerating';
/**
 * Financial entity types. From FinGPT NER: Person, Organization, Location.
 * Extended with market-relevant subtypes.
 */
export type FinancialEntityType = 'company' | 'sector' | 'index' | 'commodity' | 'currency' | 'rate-instrument' | 'regulator' | 'executive' | 'analyst' | 'fund';
/**
 * A single financial signal pattern — the atomic unit of detection.
 */
export interface FinancialSignalPattern {
    id: string;
    label: string;
    /** Keywords and phrases that indicate this signal. */
    triggers: string[];
    /** The sentiment grade this signal typically carries. */
    sentimentBias: FinancialSentimentGrade;
    /** How quickly this signal decays in relevance (in hours). */
    halfLifeHours: number;
    /** Which narrative types this signal is commonly part of. */
    narratives: FinancialNarrativeType[];
    /** Source reliability — how often this signal type is validated by price action. */
    signalQuality: 'high' | 'medium' | 'low' | 'context-dependent';
    /** The question this signal answers. The perceptual frame it opens. */
    coreQuestion: string;
}
/**
 * A market narrative — a story structure with its associated signals.
 */
export interface MarketNarrative {
    type: FinancialNarrativeType;
    label: string;
    description: string;
    /** Linguistic tells — phrases that signal this narrative is active. */
    linguisticSignals: string[];
    /** Typical duration in market time. */
    typicalDuration: string;
    /** What usually ends this narrative. */
    terminalCondition: string;
    /** The emotional arc the market experiences during this narrative. */
    emotionalArc: string;
    /** What a perceptive observer notices that others miss. */
    hiddenStructure: string;
}
/**
 * A matched result from financial lexicon detection.
 */
export interface FinancialLexiconMatch {
    signals: FinancialSignalPattern[];
    narratives: MarketNarrative[];
    sentimentGrade: FinancialSentimentGrade | null;
    dominantPhase: MarketPhase | null;
    entityMentions: Array<{
        text: string;
        type: FinancialEntityType;
    }>;
    /** The multi-agent synthesis — three analytical perspectives. */
    agentPerspectives: {
        researcher: string;
        analyst: string;
        advisor: string;
    } | null;
    /** Dissemination weight — how widely this content appears to have spread. */
    disseminationScore: number;
}
declare const SIGNAL_PATTERNS: FinancialSignalPattern[];
declare const MARKET_NARRATIVES: MarketNarrative[];
/**
 * Detect financial patterns, signals, and narratives in text.
 *
 * Applies the full financial lexicon:
 * - Signal pattern matching (earnings, guidance, flows, macro)
 * - 7-point FinGPT sentiment grading
 * - Market phase detection
 * - Entity extraction (indices, rates, commodities, regulators)
 * - Dissemination scoring
 * - Three-agent perspective synthesis
 */
export declare function detectFinancialPatterns(text: string): FinancialLexiconMatch;
/**
 * Check if text has any financial content worth processing.
 * Fast pre-filter before running the full detection.
 */
export declare function hasFinancialContent(text: string): boolean;
/**
 * Get the core question this financial text is asking.
 * The meta-signal beneath the surface signals.
 */
export declare function extractCoreQuestion(match: FinancialLexiconMatch): string;
/**
 * Format a financial lexicon match for injection into AI context.
 * Used by apophenia and semiotics layers when financial content is detected.
 */
export declare function describeFinancialMatch(match: FinancialLexiconMatch): string;
export { SIGNAL_PATTERNS, MARKET_NARRATIVES };
//# sourceMappingURL=financial-lexicon.d.ts.map