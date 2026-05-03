import type { EvolutionState, FeedbackSignalType, SessionRecord, OptimalPoint, EmergentVoice, EvolutionProposal, EvolutionAnalysis, PhospheneState, VoiceName } from './types.js';
export declare const DEFAULT_EVOLUTION: EvolutionState;
/**
 * Open a new session. Called at the start of each conversation.
 */
export declare function openSession(evolution: EvolutionState, preset: string): EvolutionState;
/**
 * Close the current session and archive it.
 */
export declare function closeSession(evolution: EvolutionState, outcome?: SessionRecord['outcome']): EvolutionState;
/**
 * Record a feedback signal.
 * The lightest interaction — a single word from the user teaches the system.
 */
export declare function recordSignal(evolution: EvolutionState, type: FeedbackSignalType, context: {
    preset: string;
    layer?: keyof PhospheneState;
    voice?: VoiceName;
    note?: string;
}): EvolutionState;
/**
 * Crystallize an insight.
 * Distills a high-intensity output into something actionable and preserved.
 */
export declare function crystallize(evolution: EvolutionState, insight: string, preset: string): EvolutionState;
/**
 * Anchor an explicit observation.
 * The user says "remember this" — it goes into the permanent record.
 */
export declare function anchor(evolution: EvolutionState, note: string, preset: string): EvolutionState;
/**
 * Record an optimal point — the user said "perfect".
 * This is the ground truth the evolution engine optimizes toward.
 */
export declare function recordOptimalPoint(evolution: EvolutionState, preset: string, layerSnapshot: OptimalPoint['layerSnapshot'], voiceSnapshot: OptimalPoint['voiceSnapshot'], context?: string): EvolutionState;
/**
 * Save the current state as a named personal preset.
 */
export declare function savePersonalPreset(evolution: EvolutionState, name: string, state: PhospheneState): EvolutionState;
/**
 * Delete a personal preset.
 */
export declare function deletePersonalPreset(evolution: EvolutionState, name: string): EvolutionState;
/**
 * Confirm a proposed emergent voice.
 * Called when the user accepts an AI-proposed new voice.
 */
export declare function confirmEmergentVoice(evolution: EvolutionState, voiceName: string): EvolutionState;
/**
 * Add a new emergent voice to the record.
 */
export declare function addEmergentVoice(evolution: EvolutionState, voice: Omit<EmergentVoice, 'emergedAt' | 'sessionsActive' | 'userConfirmed'>): EvolutionState;
/**
 * Produce a structured analysis of accumulated signals.
 * This is what the AI reads to propose evolution.
 *
 * The analysis is plain data — the AI synthesizes it into
 * natural language proposals in the conversation.
 */
export declare function analyzeSignals(evolution: EvolutionState): EvolutionAnalysis;
/**
 * Apply an accepted evolution proposal.
 * Records it in the evolution state. The actual preset/voice changes
 * are applied by the caller (phosphene.ts) using the proposal data.
 */
export declare function applyProposal(evolution: EvolutionState, proposal: EvolutionProposal): EvolutionState;
/**
 * Generate a human-readable evolution summary.
 * Injected into session context so the AI knows where it is in the evolution arc.
 */
export declare function describeEvolution(evolution: EvolutionState): string;
//# sourceMappingURL=evolution.d.ts.map