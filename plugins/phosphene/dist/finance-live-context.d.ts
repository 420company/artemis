import type { RitualLocale } from './types.js';
export interface FinancialHeadline {
    title: string;
    url: string;
    publisher: string;
    publishedAt: string | null;
}
export interface FinancialLiveSpot {
    symbol: string;
    lastPrice: number;
    priceChangePct: number;
    volume: number;
    fetchedAt: string;
    source: string;
}
export interface FinancialLiveDerivatives {
    symbol: string;
    fundingRate: number | null;
    markPrice: number | null;
    openInterest: number | null;
    fetchedAt: string;
    source: string;
}
export interface FinancialLiveContext {
    query: string;
    locale: RitualLocale;
    referenceTimeIso: string;
    symbol?: string;
    spot?: FinancialLiveSpot;
    derivatives?: FinancialLiveDerivatives;
    headlines: FinancialHeadline[];
    warnings: string[];
}
export declare function inferMarketSymbol(input: string): string | undefined;
export declare function fetchLiveSpot(symbol: string): Promise<FinancialLiveSpot>;
export declare function fetchLiveDerivatives(symbol: string): Promise<FinancialLiveDerivatives>;
export declare function parseGoogleNewsRss(xml: string): FinancialHeadline[];
export declare function fetchGoogleNewsHeadlines(query: string): Promise<FinancialHeadline[]>;
export declare function fetchFinancialLiveContext(input: string, options?: {
    locale?: RitualLocale;
    referenceTime?: string | Date;
    symbol?: string;
}): Promise<FinancialLiveContext>;
export declare function renderFinancialLiveContext(context: FinancialLiveContext): string;
export declare function renderFinancialLiveAudit(context: FinancialLiveContext): string;
//# sourceMappingURL=finance-live-context.d.ts.map