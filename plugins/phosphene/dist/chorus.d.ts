import type { ChorusLayer, VoiceName } from './types.js';
export interface ChorusResult {
    output: string;
    voices: Array<{
        voice: VoiceName;
        note: string;
    }>;
}
/**
 * Generate multi-voice perception of the input.
 *
 * Each voice is not a character — it is a different orientation
 * of the same awareness. Together they produce something no single
 * perspective could produce alone.
 *
 * The voices do not argue. They attend to different layers.
 * Harmony is possible even without agreement.
 */
export declare function applyChorus(input: string, layer: ChorusLayer): ChorusResult;
//# sourceMappingURL=chorus.d.ts.map