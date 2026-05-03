// Phosphene — evolution engine
//
// The AI is the evolution engine.
// This module accumulates signals, manages session records,
// and produces structured analysis that the AI uses to propose mutations.
//
// No machine learning. No external APIs.
// The intelligence is in the AI reading the accumulated record.

import type {
  EvolutionState,
  FeedbackSignal,
  FeedbackSignalType,
  SessionRecord,
  OptimalPoint,
  EmergentVoice,
  EvolutionProposal,
  EvolutionAnalysis,
  PhospheneState,
  VoiceName,
} from './types.js';
import { enrichEvolutionAnalysis } from './contradiction-engine.js';

// ─── Default state ────────────────────────────────────────────────────────────

export const DEFAULT_EVOLUTION: EvolutionState = {
  version: '1.0.0',
  feedbackHistory: [],
  sessionHistory: [],
  currentSession: null,
  personalPresets: {},
  voiceDrift: {},
  emergentVoices: [],
  crystallizedInsights: [],
  optimalPoints: [],
  appliedProposals: [],
  lastEvolvedAt: null,
  evolutionCount: 0,
};

// ─── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Open a new session. Called at the start of each conversation.
 */
export function openSession(
  evolution: EvolutionState,
  preset: string
): EvolutionState {
  const session: SessionRecord = {
    id: `session-${Date.now().toString(36)}`,
    startedAt: new Date().toISOString(),
    preset,
    signals: [],
    crystallized: [],
    anchored: [],
  };

  return { ...evolution, currentSession: session };
}

/**
 * Close the current session and archive it.
 */
export function closeSession(
  evolution: EvolutionState,
  outcome?: SessionRecord['outcome']
): EvolutionState {
  if (!evolution.currentSession) return evolution;

  const closed: SessionRecord = {
    ...evolution.currentSession,
    closedAt: new Date().toISOString(),
    outcome,
  };

  const history = [closed, ...evolution.sessionHistory].slice(0, 50);

  return {
    ...evolution,
    currentSession: null,
    sessionHistory: history,
  };
}

// ─── Feedback signals ─────────────────────────────────────────────────────────

/**
 * Record a feedback signal.
 * The lightest interaction — a single word from the user teaches the system.
 */
export function recordSignal(
  evolution: EvolutionState,
  type: FeedbackSignalType,
  context: {
    preset: string;
    layer?: keyof PhospheneState;
    voice?: VoiceName;
    note?: string;
  }
): EvolutionState {
  const signal: FeedbackSignal = {
    type,
    preset: context.preset,
    layer: context.layer,
    voice: context.voice,
    note: context.note,
    timestamp: new Date().toISOString(),
  };

  // Add to global history (capped at 500)
  const feedbackHistory = [...evolution.feedbackHistory, signal].slice(-500);

  // Add to current session if open
  let currentSession = evolution.currentSession;
  if (currentSession) {
    currentSession = {
      ...currentSession,
      signals: [...currentSession.signals, signal],
    };
  }

  return { ...evolution, feedbackHistory, currentSession };
}

// ─── Crystallization ──────────────────────────────────────────────────────────

/**
 * Crystallize an insight.
 * Distills a high-intensity output into something actionable and preserved.
 */
export function crystallize(
  evolution: EvolutionState,
  insight: string,
  preset: string
): EvolutionState {
  const updated = recordSignal(evolution, 'crystallize', { preset, note: insight });

  const crystallizedInsights = [
    ...updated.crystallizedInsights,
    `[${new Date().toISOString().slice(0, 10)}] ${insight}`,
  ].slice(-100);

  let currentSession = updated.currentSession;
  if (currentSession) {
    currentSession = {
      ...currentSession,
      crystallized: [...currentSession.crystallized, insight],
    };
  }

  return { ...updated, crystallizedInsights, currentSession };
}

/**
 * Anchor an explicit observation.
 * The user says "remember this" — it goes into the permanent record.
 */
export function anchor(
  evolution: EvolutionState,
  note: string,
  preset: string
): EvolutionState {
  const updated = recordSignal(evolution, 'anchor', { preset, note });

  let currentSession = updated.currentSession;
  if (currentSession) {
    currentSession = {
      ...currentSession,
      anchored: [...currentSession.anchored, note],
    };
  }

  return { ...updated, currentSession };
}

// ─── Optimal points ───────────────────────────────────────────────────────────

/**
 * Record an optimal point — the user said "perfect".
 * This is the ground truth the evolution engine optimizes toward.
 */
export function recordOptimalPoint(
  evolution: EvolutionState,
  preset: string,
  layerSnapshot: OptimalPoint['layerSnapshot'],
  voiceSnapshot: OptimalPoint['voiceSnapshot'],
  context?: string
): EvolutionState {
  const point: OptimalPoint = {
    preset,
    layerSnapshot,
    voiceSnapshot,
    timestamp: new Date().toISOString(),
    context,
  };

  const optimalPoints = [...evolution.optimalPoints, point].slice(-30);
  const withSignal = recordSignal(evolution, 'calibrate', { preset, note: context });

  return { ...withSignal, optimalPoints };
}

// ─── Personal presets ─────────────────────────────────────────────────────────

/**
 * Save the current state as a named personal preset.
 */
export function savePersonalPreset(
  evolution: EvolutionState,
  name: string,
  state: PhospheneState
): EvolutionState {
  return {
    ...evolution,
    personalPresets: {
      ...evolution.personalPresets,
      [name]: state,
    },
  };
}

/**
 * Delete a personal preset.
 */
export function deletePersonalPreset(
  evolution: EvolutionState,
  name: string
): EvolutionState {
  const { [name]: _removed, ...rest } = evolution.personalPresets;
  return { ...evolution, personalPresets: rest };
}

// ─── Emergent voices ──────────────────────────────────────────────────────────

/**
 * Confirm a proposed emergent voice.
 * Called when the user accepts an AI-proposed new voice.
 */
export function confirmEmergentVoice(
  evolution: EvolutionState,
  voiceName: string
): EvolutionState {
  const emergentVoices = evolution.emergentVoices.map(v =>
    v.name === voiceName ? { ...v, userConfirmed: true } : v
  );
  return { ...evolution, emergentVoices };
}

/**
 * Add a new emergent voice to the record.
 */
export function addEmergentVoice(
  evolution: EvolutionState,
  voice: Omit<EmergentVoice, 'emergedAt' | 'sessionsActive' | 'userConfirmed'>
): EvolutionState {
  const newVoice: EmergentVoice = {
    ...voice,
    emergedAt: new Date().toISOString(),
    sessionsActive: 0,
    userConfirmed: false,
  };

  return {
    ...evolution,
    emergentVoices: [...evolution.emergentVoices, newVoice],
  };
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

/**
 * Produce a structured analysis of accumulated signals.
 * This is what the AI reads to propose evolution.
 *
 * The analysis is plain data — the AI synthesizes it into
 * natural language proposals in the conversation.
 */
export function analyzeSignals(evolution: EvolutionState): EvolutionAnalysis {
  const { feedbackHistory, sessionHistory, optimalPoints, crystallizedInsights } = evolution;

  // Count signal types per preset
  const byPreset: Record<string, Record<FeedbackSignalType, number>> = {};
  for (const s of feedbackHistory) {
    if (!byPreset[s.preset]) {
      byPreset[s.preset] = {
        amplify: 0, reduce: 0, calibrate: 0,
        crystallize: 0, anchor: 0, reject: 0,
      };
    }
    byPreset[s.preset][s.type]++;
  }

  // Count signal types per voice
  const byVoice: Record<string, Record<FeedbackSignalType, number>> = {};
  for (const s of feedbackHistory) {
    if (!s.voice) continue;
    if (!byVoice[s.voice]) {
      byVoice[s.voice] = {
        amplify: 0, reduce: 0, calibrate: 0,
        crystallize: 0, anchor: 0, reject: 0,
      };
    }
    byVoice[s.voice][s.type]++;
  }

  // Count signal types per layer
  const byLayer: Record<string, Record<FeedbackSignalType, number>> = {};
  for (const s of feedbackHistory) {
    if (!s.layer) continue;
    const layer = s.layer as string;
    if (!byLayer[layer]) {
      byLayer[layer] = {
        amplify: 0, reduce: 0, calibrate: 0,
        crystallize: 0, anchor: 0, reject: 0,
      };
    }
    byLayer[layer][s.type]++;
  }

  // Most-used presets
  const presetFrequency: Record<string, number> = {};
  for (const s of sessionHistory) {
    presetFrequency[s.preset] = (presetFrequency[s.preset] ?? 0) + 1;
  }

  // Productive vs noisy sessions per preset
  const outcomeByPreset: Record<string, { productive: number; noisy: number; neutral: number }> = {};
  for (const s of sessionHistory) {
    if (!outcomeByPreset[s.preset]) {
      outcomeByPreset[s.preset] = { productive: 0, noisy: 0, neutral: 0 };
    }
    if (s.outcome) outcomeByPreset[s.preset][s.outcome]++;
  }

  const base = {
    totalSessions: sessionHistory.length,
    totalSignals: feedbackHistory.length,
    byPreset,
    byVoice,
    byLayer,
    presetFrequency,
    outcomeByPreset,
    optimalPoints,
    crystallizedInsights,
    recentAnchors: feedbackHistory
      .filter(s => s.type === 'anchor' && s.note)
      .slice(-10)
      .map(s => s.note as string),
  };

  return enrichEvolutionAnalysis(base, evolution);
}

// ─── Proposal application ─────────────────────────────────────────────────────

/**
 * Apply an accepted evolution proposal.
 * Records it in the evolution state. The actual preset/voice changes
 * are applied by the caller (phosphene.ts) using the proposal data.
 */
export function applyProposal(
  evolution: EvolutionState,
  proposal: EvolutionProposal
): EvolutionState {
  const appliedProposals = [...evolution.appliedProposals, proposal].slice(-20);

  let updated: EvolutionState = {
    ...evolution,
    appliedProposals,
    lastEvolvedAt: new Date().toISOString(),
    evolutionCount: evolution.evolutionCount + 1,
  };

  // Apply voice drift from the proposal
  if (proposal.voiceAdjustments.length > 0) {
    const voiceDrift = { ...evolution.voiceDrift };
    for (const adj of proposal.voiceAdjustments) {
      const current = voiceDrift[adj.voice] ?? 0;
      voiceDrift[adj.voice] = current + (adj.proposedWeight - adj.currentWeight);
    }
    updated = { ...updated, voiceDrift };
  }

  // Add emergent voice if proposed
  if (proposal.emergentVoiceProposal) {
    updated = addEmergentVoice(updated, proposal.emergentVoiceProposal);
  }

  return updated;
}

// ─── Serialization helper ─────────────────────────────────────────────────────

/**
 * Generate a human-readable evolution summary.
 * Injected into session context so the AI knows where it is in the evolution arc.
 */
export function describeEvolution(evolution: EvolutionState): string {
  const lines: string[] = [];
  const analysis = analyzeSignals(evolution);

  lines.push(`[phosphene evolution: v${evolution.evolutionCount} — ${evolution.sessionHistory.length} sessions]`);

  if (evolution.crystallizedInsights.length > 0) {
    lines.push(`crystallized insights: ${evolution.crystallizedInsights.length}`);
    // Show the last 3
    evolution.crystallizedInsights.slice(-3).forEach(i => lines.push(`  · ${i}`));
  }

  if (evolution.emergentVoices.length > 0) {
    const confirmed = evolution.emergentVoices.filter(v => v.userConfirmed);
    lines.push(`emergent voices: ${confirmed.map(v => v.name).join(', ') || 'none confirmed yet'}`);
  }

  if (evolution.personalPresets && Object.keys(evolution.personalPresets).length > 0) {
    lines.push(`personal presets: ${Object.keys(evolution.personalPresets).join(', ')}`);
  }

  if (evolution.optimalPoints.length > 0) {
    const last = evolution.optimalPoints[evolution.optimalPoints.length - 1];
    lines.push(`last optimal point: ${last.preset} at ${last.timestamp.slice(0, 10)}`);
  }

  if (analysis.contradictionPatterns.length > 0) {
    lines.push(`contradiction motifs: ${analysis.contradictionPatterns.map(pattern => pattern.id).join(', ')}`);
  }

  if (analysis.suggestedBiases.length > 0) {
    lines.push(`bias candidates: ${analysis.suggestedBiases.map(bias => bias.id).join(', ')}`);
  }

  return lines.join('\n');
}
