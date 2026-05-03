import type { ContradictionRead, EvolutionAnalysis, EvolutionState, HumanPatternHit, RitualLocale } from './types.js';
type BaseEvolutionAnalysis = Omit<EvolutionAnalysis, 'contradictionPatterns' | 'suggestedBiases'>;
export declare function detectHumanPatterns(input: string): HumanPatternHit[];
export declare function deriveBiasCandidates(evolution: EvolutionState): import("./types.js").EvolutionaryBias[];
export declare function enrichEvolutionAnalysis(base: BaseEvolutionAnalysis, evolution: EvolutionState): EvolutionAnalysis;
export declare function buildContradictionRead(input: string, locale: RitualLocale, analysis?: Pick<EvolutionAnalysis, 'suggestedBiases'>): ContradictionRead | undefined;
export {};
//# sourceMappingURL=contradiction-engine.d.ts.map