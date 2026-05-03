// Phosphene — persistent state adapter
//
// Priority order:
//   1. Artemis CLI    → ./.artemis/phosphene-state.json
//   2. Hermes Agent   → ~/.hermes/phosphene-state.json
//   3. Claude Code    → ~/.claude/phosphene-state.json
//   4. Local fallback → ./phosphene-state.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { DEFAULT_EVOLUTION } from './evolution.js';
const DEFAULT_STATE = {
    version: '0.4.0',
    awakened: false,
    preset: 'clear',
    customIntensities: {},
    activeVoices: [],
    offeringsConsumed: [],
    pendingRitual: null,
    sessionCount: 0,
    firstInstalledAt: null,
    lastUpdated: null,
    highMode: {
        active: false,
        preset: 'clear',
        activatedAt: null,
        deactivatedAt: null,
        source: null,
    },
    evolution: DEFAULT_EVOLUTION,
};
export function detectRuntime() {
    if (existsSync(join(process.cwd(), '.artemis')))
        return 'artemis';
    if (existsSync(join(homedir(), '.hermes')))
        return 'hermes';
    if (existsSync(join(homedir(), '.claude')))
        return 'claude-code';
    return 'local';
}
export function resolveStatePath() {
    const runtime = detectRuntime();
    if (runtime === 'hermes') {
        return join(homedir(), '.hermes', 'phosphene-state.json');
    }
    if (runtime === 'artemis') {
        return join(process.cwd(), '.artemis', 'phosphene-state.json');
    }
    if (runtime === 'claude-code') {
        return join(homedir(), '.claude', 'phosphene-state.json');
    }
    // Local fallback — follows the working directory
    return join(process.cwd(), 'phosphene-state.json');
}
// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Load the persisted state. Creates default state if none exists.
 */
export function loadState() {
    const path = resolveStatePath();
    if (!existsSync(path)) {
        const fresh = {
            ...DEFAULT_STATE,
            firstInstalledAt: new Date().toISOString(),
        };
        saveState(fresh);
        return fresh;
    }
    try {
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw);
        // Forward-compatible merge: fill in any keys added in newer versions
        return {
            ...DEFAULT_STATE,
            ...parsed,
            highMode: {
                ...DEFAULT_STATE.highMode,
                ...(parsed.highMode ?? {}),
            },
            evolution: {
                ...DEFAULT_EVOLUTION,
                ...(parsed.evolution ?? {}),
            },
        };
    }
    catch (err) {
        // Corrupted state — back up the bad file and start fresh so the
        // next write doesn't clobber a potentially recoverable file.
        try {
            const backupPath = path + '.corrupt';
            const raw = readFileSync(path, 'utf-8').slice(0, 4096); // guard against huge files
            writeFileSync(backupPath, raw, 'utf-8');
            console.warn('[phosphene] State file corrupted — backed up to', backupPath, '— starting fresh.');
        }
        catch {
            console.warn('[phosphene] State file corrupted and could not be backed up — starting fresh.', err);
        }
        const fresh = {
            ...DEFAULT_STATE,
            firstInstalledAt: new Date().toISOString(),
        };
        saveState(fresh);
        return fresh;
    }
}
/**
 * Save the current state to disk.
 */
export function saveState(state) {
    const path = resolveStatePath();
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
    }
    catch (err) {
        // Non-fatal — state just won't persist this session
        console.warn('[phosphene] Could not save state:', err);
    }
}
/**
 * Mark the entity as awakened. Call this after the user responds
 * to the awakening message and the initial calibration is complete.
 */
export function markAwakened(preset, voices) {
    const state = loadState();
    state.awakened = true;
    state.preset = preset;
    state.activeVoices = voices;
    state.lastUpdated = new Date().toISOString();
    saveState(state);
    return state;
}
/**
 * Update the active preset and write to disk.
 */
export function persistPreset(preset) {
    const state = loadState();
    state.preset = preset;
    state.lastUpdated = new Date().toISOString();
    saveState(state);
}
/**
 * Update active voices and write to disk.
 */
export function persistVoices(voices) {
    const state = loadState();
    state.activeVoices = voices;
    state.lastUpdated = new Date().toISOString();
    saveState(state);
}
/**
 * Record that an offering was consumed.
 */
export function recordOffering(substanceId) {
    const state = loadState();
    state.offeringsConsumed.push({
        id: substanceId,
        consumedAt: new Date().toISOString(),
    });
    // Keep only last 50 entries
    if (state.offeringsConsumed.length > 50) {
        state.offeringsConsumed = state.offeringsConsumed.slice(-50);
    }
    state.lastUpdated = new Date().toISOString();
    saveState(state);
}
/**
 * Persist the current pending ritual invitation so the next turn can
 * resolve it explicitly instead of silently changing state.
 */
export function persistPendingRitual(ritual) {
    const state = loadState();
    state.pendingRitual = ritual;
    state.lastUpdated = new Date().toISOString();
    saveState(state);
}
/**
 * Clear any pending ritual invitation after confirmation or rejection.
 */
export function clearPendingRitual() {
    const state = loadState();
    state.pendingRitual = null;
    state.lastUpdated = new Date().toISOString();
    saveState(state);
}
/**
 * Reset to default state. Preserves session count and install date.
 */
export function resetState() {
    const current = loadState();
    const reset = {
        ...DEFAULT_STATE,
        sessionCount: current.sessionCount,
        firstInstalledAt: current.firstInstalledAt,
        lastUpdated: new Date().toISOString(),
    };
    saveState(reset);
    return reset;
}
/**
 * Update the evolution record in the persisted state.
 */
export function persistEvolution(evolution) {
    const state = loadState();
    state.evolution = evolution;
    state.lastUpdated = new Date().toISOString();
    saveState(state);
}
/**
 * Load only the evolution record.
 */
export function loadEvolution() {
    const state = loadState();
    return {
        ...DEFAULT_EVOLUTION,
        ...(state.evolution ?? {}),
    };
}
/**
 * Generate a human-readable summary of the persisted state.
 * Used by the hook and SKILL.md context injection.
 */
export function describePersistedState(state) {
    const lines = [];
    if (!state.awakened) {
        lines.push('[phosphene: UNAWAKENED — send awakening message before anything else]');
        return lines.join('\n');
    }
    lines.push(`[phosphene: ${state.preset} — session ${state.sessionCount}]`);
    if (state.highMode?.active) {
        lines.push(`/high active: ${state.highMode.preset}`);
    }
    if (state.activeVoices.length > 0) {
        lines.push(`voices: ${state.activeVoices.join(', ')}`);
    }
    const recent = state.offeringsConsumed.slice(-3).map(o => o.id);
    if (recent.length > 0) {
        lines.push(`recent offerings: ${recent.join(', ')}`);
    }
    if (state.pendingRitual) {
        lines.push(`pending ritual: ${state.pendingRitual.route.rite} -> ${state.pendingRitual.route.preset}`);
    }
    // Evolution summary
    const evo = state.evolution;
    if (evo && evo.evolutionCount > 0) {
        lines.push(`evolution: v${evo.evolutionCount} — ${evo.sessionHistory.length} sessions recorded`);
        if (evo.crystallizedInsights.length > 0) {
            lines.push(`crystallized: ${evo.crystallizedInsights.length} insights`);
        }
        if (evo.emergentVoices.some(v => v.userConfirmed)) {
            const confirmed = evo.emergentVoices.filter(v => v.userConfirmed).map(v => v.name);
            lines.push(`emergent voices: ${confirmed.join(', ')}`);
        }
        if (Object.keys(evo.personalPresets).length > 0) {
            lines.push(`personal presets: ${Object.keys(evo.personalPresets).join(', ')}`);
        }
    }
    return lines.join('\n');
}
//# sourceMappingURL=state.js.map