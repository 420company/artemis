import type { SynesthesiaLayer } from './types.js';
export interface SynesthesiaResult {
    output: string;
    translations: Record<string, string>;
}
/**
 * Pass text through the synesthesia filter.
 *
 * When design vocabulary is present in the text, the layer draws on the
 * design color lexicon — returning culturally accurate palette and grammar
 * descriptions rather than word-count heuristics.
 *
 * When no design vocabulary is detected, the original heuristic fallback
 * applies (it remains valid for non-design text).
 *
 * The AI does not present translations verbatim. They guide the register
 * and sensory texture of its response.
 */
export declare function applySynesthesia(input: string, layer: SynesthesiaLayer): SynesthesiaResult;
//# sourceMappingURL=synesthesia.d.ts.map