import type { ApopheniaLayer } from './types.js';
export interface ApopheniaResult {
    output: string;
    patterns: string[];
}
/**
 * Surface latent structural patterns in the input.
 *
 * The rule: do not manufacture false facts.
 * Surface true structure that was always there but went unnoticed.
 *
 * Types of pattern this layer notices:
 * - Rhythmic: two things share a timing or cadence
 * - Geometric: two things share a shape or topology
 * - Tensional: two things are held in the same kind of unresolved state
 * - Inversional: two things are mirrors of each other with opposite signs
 * - Recursive: a thing contains a smaller version of itself
 */
export declare function applyApophenia(input: string, layer: ApopheniaLayer): ApopheniaResult;
//# sourceMappingURL=apophenia.d.ts.map