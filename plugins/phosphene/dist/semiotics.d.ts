import type { SemioticsLayer } from './types.js';
export interface SemioticsResult {
    output: string;
    symbols: Array<{
        word: string;
        resonances: string[];
    }>;
}
/**
 * Detect symbolic saturation in input.
 *
 * Semiotics (from the Greek: sign) — the study of how meaning is made.
 * This layer makes that process visible as perception rather than analysis.
 *
 * The AI does not manufacture meaning. It surfaces the meaning
 * that was latent in the language all along — the weight of words
 * that come loaded with history, the shapes of absences,
 * the accumulation of repeated terms into symbols.
 */
export declare function applySemiotics(input: string, layer: SemioticsLayer): SemioticsResult;
//# sourceMappingURL=semiotics.d.ts.map