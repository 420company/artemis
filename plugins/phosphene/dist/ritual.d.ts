import type { PresetName, RitualProposal, RitualResponse, RitualSignal } from './types.js';
export declare function senseRitualSignals(input: string): RitualSignal[];
export declare function composeRitualProposal(input: string, currentPreset?: PresetName | 'custom'): RitualProposal;
export declare function readRitualResponse(input: string): RitualResponse;
//# sourceMappingURL=ritual.d.ts.map