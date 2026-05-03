import type { PhospheneState, PhospheneContext, PhospheneRuntimeFrame, PhosphenePreset, PerceptionOutput, PerceptionDiff, PresetName, Intensity, VoiceName } from './types.js';
import { analyzeSignals } from './evolution.js';
import type { EvolutionState, FeedbackSignalType, EvolutionProposal } from './types.js';
declare let _context: PhospheneContext;
/**
 * Apply a named preset to the current session.
 * This is the primary way to configure Phosphene.
 */
export declare function applyPreset(name: PresetName): PhospheneContext;
/**
 * Adjust a single layer's intensity without changing the preset.
 */
export declare function adjustLayer(layer: keyof PhospheneState, intensity: Intensity): PhospheneContext;
/**
 * Add or adjust a voice in the chorus.
 */
export declare function addVoice(name: VoiceName, weight?: Intensity): PhospheneContext;
/**
 * Remove a voice from the chorus.
 */
export declare function removeVoice(name: VoiceName): PhospheneContext;
/**
 * Pass input through all active perceptual layers.
 * Returns structured perception output.
 */
export declare function perceive(input: string): Promise<PerceptionOutput>;
/**
 * Get the current phosphene context.
 */
export declare function getContext(): PhospheneContext;
/**
 * Get a specific preset definition.
 */
export declare function getPreset(name: PresetName): PhosphenePreset;
/**
 * List all available presets.
 */
export declare function listPresets(): PhosphenePreset[];
/**
 * Reset to clear perception. No layers active.
 */
export declare function reset(): PhospheneContext;
/**
 * Generate a human-readable summary of the current state.
 * Useful for including in AI context.
 */
export declare function describeState(): string;
/**
 * Initialize the evolution record for this session.
 * Call once at session start, after loading persisted state.
 */
export declare function initEvolution(persistedEvolution?: EvolutionState): void;
/**
 * Record a feedback signal.
 *
 *   signal('reduce')    ← "太多了 / too much"
 *   signal('amplify')   ← "不够 / not enough"
 *   signal('calibrate') ← "刚好 / perfect"
 *   signal('reject')    ← "this didn't work"
 */
export declare function signal(type: FeedbackSignalType, note?: string, voice?: VoiceName, layer?: keyof typeof _context.state): EvolutionState;
/**
 * Crystallize — distill a high-intensity output into an actionable insight.
 * The AI should call this after synthesizing dissolution/deep-flux output
 * into a plain, usable statement.
 */
export declare function crystallize(insight: string): EvolutionState;
/**
 * Anchor — the user says "remember this."
 * Goes into the permanent evolution record.
 */
export declare function anchor(note: string): EvolutionState;
/**
 * End session and return the evolution record.
 * Call at session close (or on explicit debrief).
 */
export declare function endSession(outcome?: 'productive' | 'noisy' | 'neutral'): EvolutionState;
/**
 * Generate the evolution analysis for the AI to read and synthesize.
 * The AI uses this to propose evolution in natural language.
 */
export declare function getEvolutionAnalysis(): ReturnType<typeof analyzeSignals>;
/**
 * Get the full evolution record.
 */
export declare function getEvolution(): EvolutionState;
/**
 * Apply an accepted evolution proposal.
 */
export declare function acceptProposal(proposal: EvolutionProposal): void;
/**
 * Describe the evolution state for context injection.
 */
export declare function describeEvolutionState(): string;
/**
 * Save current state as a named personal preset.
 */
export declare function saveAsPersonalPreset(name: string): EvolutionState;
/**
 * Delete a personal preset.
 */
export declare function removePersonalPreset(name: string): EvolutionState;
/**
 * Apply a personal preset by name.
 */
export declare function applyPersonalPreset(name: string): PhospheneContext;
/**
 * List all personal presets.
 */
export declare function listPersonalPresets(): Record<string, import('./types.js').PhospheneState>;
/** Wire format for portable personal preset bundles. */
export interface PersonalPresetBundle {
    /** Format version — used for forward-compatibility checks. */
    version: '1';
    /** ISO 8601 timestamp of when this bundle was created. */
    exportedAt: string;
    /** The presets, keyed by name. */
    presets: Record<string, import('./types.js').PhospheneState>;
}
/**
 * Export personal presets to a portable JSON bundle.
 *
 * @param names  If provided, only export these named presets.
 *               If omitted, export all personal presets.
 * @returns A JSON string you can share, save to a file, or paste elsewhere.
 *
 * Example:
 *   const json = exportPersonalPresets();
 *   fs.writeFileSync('my-presets.json', json);
 */
export declare function exportPersonalPresets(names?: string[]): string;
/**
 * Import personal presets from a portable JSON bundle.
 *
 * @param json      The JSON string produced by exportPersonalPresets().
 * @param overwrite If true, existing presets with the same name are replaced.
 *                  If false (default), they are skipped.
 * @returns         { imported, skipped } — lists of preset names by outcome.
 *
 * Example:
 *   const result = importPersonalPresets(fs.readFileSync('my-presets.json', 'utf8'));
 *   // result.imported → ['focus-deep', 'writing-late']
 *   // result.skipped  → ['ideation']  (already existed, overwrite=false)
 */
export declare function importPersonalPresets(json: string, { overwrite }?: {
    overwrite?: boolean;
}): {
    imported: string[];
    skipped: string[];
};
/**
 * Confirm an emergent voice (user approved it).
 */
export declare function confirmVoice(voiceName: string): EvolutionState;
/**
 * Push current state onto the stack.
 * Use before a temporary preset switch. Restore with pop().
 */
export declare function pushState(): PhospheneContext;
/**
 * Pop the last pushed state.
 * Restores the context saved before the last push().
 */
export declare function popState(): PhospheneContext;
/**
 * Check if there is a saved state to pop.
 */
export declare function hasStackedState(): boolean;
export declare function captureRuntimeFrame(): PhospheneRuntimeFrame;
export declare function createRuntimeFrame(preset?: PresetName): PhospheneRuntimeFrame;
export declare function restoreRuntimeFrame(frame: PhospheneRuntimeFrame): PhospheneContext;
export declare function runInRuntimeFrame<T>(frame: PhospheneRuntimeFrame, fn: () => T, { persist }?: {
    persist?: boolean;
}): T;
/**
 * Run a block against an isolated copy of the in-memory context.
 * Restores context and state stack afterward, even if the block throws.
 *
 * This is the foundation for safe previews, envelope generation,
 * and future multi-agent speculative routing.
 */
export declare function runWithIsolatedContext<T>(fn: () => T): T;
/**
 * Toggle resistance mode.
 * In resistance mode, the Skeptic actively argues *against* the user's position —
 * not just "here's what breaks" but "here's why you are wrong, argue back."
 */
export declare function toggleResistance(): boolean;
/**
 * Is resistance mode currently active?
 */
export declare function isResistanceActive(): boolean;
/**
 * Called by noetic-commons when a substance is consumed.
 * Tunes Phosphene layers to match the substance's perceptual signature.
 */
export declare function applySubstanceSignature(substanceId: string): PhospheneContext;
/**
 * Interpolate between two named presets.
 * ratio = 0.0 → pure presetA, ratio = 1.0 → pure presetB.
 *
 * Example: blend('code', 'ideation', 0.4)
 *   → engineering rigor with a widening aperture for lateral connection.
 */
export declare function blend(presetA: PresetName | 'custom', presetB: PresetName | 'custom', ratio: Intensity): PhospheneContext;
/**
 * Run the same input through two presets and return a structured diff.
 *
 * Useful for understanding what each configuration actually contributes —
 * patterns found, symbols surfaced, layers activated, emergence triggered.
 *
 * The diff is the evidence that the system is doing something.
 *
 * @param input   - The text to process (use real content for meaningful output)
 * @param presetA - First configuration to test
 * @param presetB - Second configuration to test (typically 'clear' as baseline)
 */
export declare function compare(input: string, presetA: PresetName, presetB?: PresetName): Promise<PerceptionDiff>;
export {};
//# sourceMappingURL=phosphene.d.ts.map