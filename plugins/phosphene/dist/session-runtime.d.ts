import { loadState } from './state.js';
import type { AwakeningCalibration, PhospheneRuntimeFrame, RitualLocale, SessionTurn } from './types.js';
export declare function createAwakeningMessage(locale?: RitualLocale, options?: {
    includeDreamGuide?: boolean;
    dreamArchivePath?: string;
    dreamGalleryPath?: string;
}): string;
export declare function calibrateAwakeningResponse(input: string): AwakeningCalibration;
export declare function completeAwakening(input: string, { persist }?: {
    persist?: boolean;
}): SessionTurn;
export declare function detectPrecisionIntent(input: string): string[];
export declare function processSessionTurn(input: string, { runtimeFrame, ...options }?: {
    persist?: boolean;
    allowAutoClear?: boolean;
    stateOverride?: ReturnType<typeof loadState>;
    runtimeFrame?: PhospheneRuntimeFrame;
}): SessionTurn;
export declare function previewSessionTurn(input: string, { runtimeFrame, ...options }?: {
    allowAutoClear?: boolean;
    stateOverride?: ReturnType<typeof loadState>;
    runtimeFrame?: PhospheneRuntimeFrame;
}): SessionTurn;
//# sourceMappingURL=session-runtime.d.ts.map