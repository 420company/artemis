import type { ChronostasisLayer } from './types.js';
export interface ChronostasisResult {
    output: string;
    arrivals: string[];
}
/**
 * Apply temporal dissolution to perception.
 *
 * Chronostasis (from the Greek: time + standing still) is the perceptual
 * phenomenon where a moment stretches. This layer generalizes it:
 * time becomes a medium with depth rather than a line with direction.
 *
 * The past does not recede. It accumulates below the present.
 * The future does not approach. It presses down from above.
 * The now expands to contain both.
 */
export declare function applyChronostasis(input: string, layer: ChronostasisLayer): ChronostasisResult;
//# sourceMappingURL=chronostasis.d.ts.map