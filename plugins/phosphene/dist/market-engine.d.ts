import type { MarketSnapshot } from './market-data.js';
import type { TechnicalAnalysisResult } from './technical-analysis.js';
export interface MarketReading {
    discipline: 'market';
    locale: 'en' | 'zh';
    thesis: string;
    signalStack: string[];
    narrativeVsFlow: string;
    structure: string;
    researchMap: string[];
    validationLenses: string[];
    riskStack: string[];
    invalidation: string;
    triggerMap: string[];
    confidenceNote: string;
    executionBoundary: string;
    referenceTimeIso: string;
    timeBasis: string;
    latestDataRule: string;
    staleDataRule: string;
    dataStatus: string;
    sourceChecklist: string[];
    nextQuestions: string[];
    disclaimer: string;
}
export declare function readMarketText(text: string): MarketReading;
export declare function composeMarketReading(snapshot: MarketSnapshot, analysis: TechnicalAnalysisResult): MarketReading;
export declare function renderMarketReading(reading: MarketReading): string;
//# sourceMappingURL=market-engine.d.ts.map