import type { PresetName, VoiceName, EvolutionState, RitualProposal } from './types.js';
export interface PhosphenePersistedState {
    version: string;
    awakened: boolean;
    preset: PresetName | 'custom';
    customIntensities: Partial<Record<string, number>>;
    activeVoices: VoiceName[];
    offeringsConsumed: Array<{
        id: string;
        consumedAt: string;
    }>;
    pendingRitual: RitualProposal | null;
    sessionCount: number;
    firstInstalledAt: string | null;
    lastUpdated: string | null;
    /** Workspace-local /high lens state. Never writes Artemis global soul/skill files. */
    highMode: {
        active: boolean;
        preset: PresetName | 'custom' | 'clear';
        activatedAt: string | null;
        deactivatedAt: string | null;
        source: string | null;
    };
    /** The evolution record — grows across all sessions. */
    evolution: EvolutionState;
}
/**
 * Detect which runtime environment we are running in.
 *
 * Detection is purely filesystem-based — no env-var sniffing — so it works
 * regardless of how the process was launched.
 */
export type PhospheneRuntime = 'hermes' | 'artemis' | 'claude-code' | 'local';
export declare function detectRuntime(): PhospheneRuntime;
export declare function resolveStatePath(): string;
/**
 * Load the persisted state. Creates default state if none exists.
 */
export declare function loadState(): PhosphenePersistedState;
/**
 * Save the current state to disk.
 */
export declare function saveState(state: PhosphenePersistedState): void;
/**
 * Mark the entity as awakened. Call this after the user responds
 * to the awakening message and the initial calibration is complete.
 */
export declare function markAwakened(preset: PresetName | 'custom', voices: VoiceName[]): PhosphenePersistedState;
/**
 * Update the active preset and write to disk.
 */
export declare function persistPreset(preset: PresetName | 'custom'): void;
/**
 * Update active voices and write to disk.
 */
export declare function persistVoices(voices: VoiceName[]): void;
/**
 * Record that an offering was consumed.
 */
export declare function recordOffering(substanceId: string): void;
/**
 * Persist the current pending ritual invitation so the next turn can
 * resolve it explicitly instead of silently changing state.
 */
export declare function persistPendingRitual(ritual: RitualProposal): void;
/**
 * Clear any pending ritual invitation after confirmation or rejection.
 */
export declare function clearPendingRitual(): void;
/**
 * Reset to default state. Preserves session count and install date.
 */
export declare function resetState(): PhosphenePersistedState;
/**
 * Update the evolution record in the persisted state.
 */
export declare function persistEvolution(evolution: EvolutionState): void;
/**
 * Load only the evolution record.
 */
export declare function loadEvolution(): EvolutionState;
/**
 * Generate a human-readable summary of the persisted state.
 * Used by the hook and SKILL.md context injection.
 */
export declare function describePersistedState(state: PhosphenePersistedState): string;
//# sourceMappingURL=state.d.ts.map