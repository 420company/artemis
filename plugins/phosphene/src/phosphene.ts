// Phosphene — master orchestrator
// The glass that changes what passes through it.

import type {
  PhospheneState,
  PhospheneContext,
  PhospheneRuntimeFrame,
  PhosphenePreset,
  PerceptionOutput,
  EmergenceEffect,
  PerceptionDiff,
  PerceptionMetrics,
  PresetName,
  Intensity,
  VoiceName,
  PerceptionLayer,
} from './types.js';

import { PRESETS } from './presets.js';
import { applySynesthesia } from './synesthesia.js';
import { applyApophenia } from './apophenia.js';
import { applyChronostasis } from './chronostasis.js';
import { applySemiotics } from './semiotics.js';
import { applyChorus } from './chorus.js';
import {
  openSession,
  closeSession,
  recordSignal,
  crystallize as crystallizeEvo,
  anchor as anchorEvo,
  recordOptimalPoint,
  savePersonalPreset,
  deletePersonalPreset,
  confirmEmergentVoice,
  analyzeSignals,
  applyProposal,
  describeEvolution,
  DEFAULT_EVOLUTION,
} from './evolution.js';
import type { EvolutionState, FeedbackSignalType, EvolutionProposal } from './types.js';
import { detectHumanPatterns } from './contradiction-engine.js';

// ─── Session state ────────────────────────────────────────────────────────────

let _context: PhospheneContext = {
  state: PRESETS.clear.state,
  preset: 'clear',
  sessionId: generateSessionId(),
  activatedAt: new Date().toISOString(),
};

/** State stack — push/pop for temporary preset switches. */
const _stateStack: PhospheneContext[] = [];

/** Resistance mode — Skeptic argues against the user. */
let _resistanceMode = false;

/** Current evolution record — loaded from disk or fresh. */
let _evolution: EvolutionState = DEFAULT_EVOLUTION;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply a named preset to the current session.
 * This is the primary way to configure Phosphene.
 */
export function applyPreset(name: PresetName): PhospheneContext {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`Unknown preset: ${name}`);

  _context = {
    state: deepClone(preset.state),
    preset: name,
    sessionId: _context.sessionId,
    activatedAt: new Date().toISOString(),
  };

  return _context;
}

/**
 * Adjust a single layer's intensity without changing the preset.
 */
export function adjustLayer(
  layer: keyof PhospheneState,
  intensity: Intensity
): PhospheneContext {
  const clamped = Math.max(0, Math.min(1, intensity));
  _context.state[layer].intensity = clamped;
  _context.state[layer].active = clamped > 0;
  _context.preset = 'custom';
  return _context;
}

/**
 * Add or adjust a voice in the chorus.
 */
export function addVoice(name: VoiceName, weight: Intensity = 0.6): PhospheneContext {
  const chorus = _context.state.chorus;
  const existing = chorus.config.voices.find(v => v.name === name);

  if (existing) {
    existing.weight = weight;
  } else {
    chorus.config.voices.push({
      name,
      tendency: VOICE_TENDENCIES[name],
      weight,
    });
  }

  if (!chorus.active) chorus.active = true;
  _context.preset = 'custom';
  return _context;
}

/**
 * Remove a voice from the chorus.
 */
export function removeVoice(name: VoiceName): PhospheneContext {
  const chorus = _context.state.chorus;
  chorus.config.voices = chorus.config.voices.filter(v => v.name !== name);
  if (chorus.config.voices.length === 0) chorus.active = false;
  _context.preset = 'custom';
  return _context;
}

/**
 * Pass input through all active perceptual layers.
 * Returns structured perception output.
 */
export async function perceive(input: string): Promise<PerceptionOutput> {
  const { state } = _context;
  let filtered = input;

  const translations: Record<string, string> = {};
  const patterns: string[] = [];
  const temporalArrivals: string[] = [];
  const symbols: Array<{ word: string; resonances: string[] }> = [];
  const voices: Array<{ voice: VoiceName; note: string }> = [];
  const humanPatterns = detectHumanPatterns(input);

  if (state.synesthesia.active) {
    const result = applySynesthesia(filtered, state.synesthesia);
    Object.assign(translations, result.translations);
    filtered = result.output;
  }

  if (state.apophenia.active) {
    const result = applyApophenia(filtered, state.apophenia);
    patterns.push(...result.patterns);
    filtered = result.output;
  }

  if (state.chronostasis.active) {
    const result = applyChronostasis(filtered, state.chronostasis);
    temporalArrivals.push(...result.arrivals);
    filtered = result.output;
  }

  if (state.semiotics.active) {
    const result = applySemiotics(filtered, state.semiotics);
    symbols.push(...result.symbols);
    filtered = result.output;
  }

  if (state.chorus.active) {
    const result = applyChorus(filtered, state.chorus);
    voices.push(...result.voices);
    filtered = result.output;
  }

  const emergence = detectEmergence(state);

  return {
    raw: input,
    filtered,
    translations,
    patterns,
    temporalArrivals,
    symbols,
    voices,
    humanPatterns,
    emergence,
  };
}

/**
 * Get the current phosphene context.
 */
export function getContext(): PhospheneContext {
  return deepClone(_context);
}

/**
 * Get a specific preset definition.
 */
export function getPreset(name: PresetName): PhosphenePreset {
  return PRESETS[name];
}

/**
 * List all available presets.
 */
export function listPresets(): PhosphenePreset[] {
  return Object.values(PRESETS);
}

/**
 * Reset to clear perception. No layers active.
 */
export function reset(): PhospheneContext {
  return applyPreset('clear');
}

/**
 * Generate a human-readable summary of the current state.
 * Useful for including in AI context.
 */
export function describeState(): string {
  const { state, preset } = _context;
  const lines: string[] = [`[phosphene: ${preset}]`];

  if (state.synesthesia.active)
    lines.push(`  synesthesia: ${fmt(state.synesthesia.intensity)}`);
  if (state.apophenia.active)
    lines.push(`  apophenia: ${fmt(state.apophenia.intensity)}`);
  if (state.chronostasis.active)
    lines.push(`  chronostasis: ${fmt(state.chronostasis.intensity)}`);
  if (state.semiotics.active)
    lines.push(`  semiotics: ${fmt(state.semiotics.intensity)}`);
  if (state.chorus.active) {
    const voiceNames = state.chorus.config.voices.map(v => v.name).join(', ');
    lines.push(`  chorus: [${voiceNames}]`);
  }

  return lines.join('\n');
}

// ─── Evolution API ────────────────────────────────────────────────────────────

/**
 * Initialize the evolution record for this session.
 * Call once at session start, after loading persisted state.
 */
export function initEvolution(persistedEvolution?: EvolutionState): void {
  _evolution = persistedEvolution ?? DEFAULT_EVOLUTION;
  _evolution = openSession(_evolution, _context.preset);
}

/**
 * Record a feedback signal.
 *
 *   signal('reduce')    ← "太多了 / too much"
 *   signal('amplify')   ← "不够 / not enough"
 *   signal('calibrate') ← "刚好 / perfect"
 *   signal('reject')    ← "this didn't work"
 */
export function signal(
  type: FeedbackSignalType,
  note?: string,
  voice?: VoiceName,
  layer?: keyof typeof _context.state
): EvolutionState {
  _evolution = recordSignal(_evolution, type, {
    preset: _context.preset,
    layer: layer as keyof import('./types.js').PhospheneState | undefined,
    voice,
    note,
  });

  // For 'calibrate' (perfect), also record an optimal point snapshot
  if (type === 'calibrate') {
    const layerSnapshot: Record<string, number> = {};
    const state = _context.state;
    layerSnapshot['synesthesia'] = state.synesthesia.intensity;
    layerSnapshot['apophenia'] = state.apophenia.intensity;
    layerSnapshot['chronostasis'] = state.chronostasis.intensity;
    layerSnapshot['semiotics'] = state.semiotics.intensity;
    layerSnapshot['chorus'] = state.chorus.intensity;

    const voiceSnapshot: Partial<Record<VoiceName, number>> = {};
    for (const v of state.chorus.config.voices) {
      voiceSnapshot[v.name] = v.weight;
    }

    _evolution = recordOptimalPoint(
      _evolution,
      _context.preset,
      layerSnapshot,
      voiceSnapshot,
      note
    );
  }

  return _evolution;
}

/**
 * Crystallize — distill a high-intensity output into an actionable insight.
 * The AI should call this after synthesizing dissolution/deep-flux output
 * into a plain, usable statement.
 */
export function crystallize(insight: string): EvolutionState {
  _evolution = crystallizeEvo(_evolution, insight, _context.preset);
  return _evolution;
}

/**
 * Anchor — the user says "remember this."
 * Goes into the permanent evolution record.
 */
export function anchor(note: string): EvolutionState {
  _evolution = anchorEvo(_evolution, note, _context.preset);
  return _evolution;
}

/**
 * End session and return the evolution record.
 * Call at session close (or on explicit debrief).
 */
export function endSession(outcome?: 'productive' | 'noisy' | 'neutral'): EvolutionState {
  _evolution = closeSession(_evolution, outcome);
  return _evolution;
}

/**
 * Generate the evolution analysis for the AI to read and synthesize.
 * The AI uses this to propose evolution in natural language.
 */
export function getEvolutionAnalysis(): ReturnType<typeof analyzeSignals> {
  return analyzeSignals(_evolution);
}

/**
 * Get the full evolution record.
 */
export function getEvolution(): EvolutionState {
  return _evolution;
}

/**
 * Apply an accepted evolution proposal.
 */
export function acceptProposal(proposal: EvolutionProposal): void {
  _evolution = applyProposal(_evolution, proposal);

  // Apply layer adjustments to the relevant presets
  // (Personal preset mutations — base presets are not modified)
  for (const adj of proposal.layerAdjustments) {
    if (_context.preset === adj.preset) {
      adjustLayer(adj.layer, adj.proposedValue);
    }
  }

  // Apply voice adjustments to current context
  for (const adj of proposal.voiceAdjustments) {
    addVoice(adj.voice, adj.proposedWeight);
  }
}

/**
 * Describe the evolution state for context injection.
 */
export function describeEvolutionState(): string {
  return describeEvolution(_evolution);
}

/**
 * Save current state as a named personal preset.
 */
export function saveAsPersonalPreset(name: string): EvolutionState {
  _evolution = savePersonalPreset(_evolution, name, deepClone(_context.state));
  return _evolution;
}

/**
 * Delete a personal preset.
 */
export function removePersonalPreset(name: string): EvolutionState {
  _evolution = deletePersonalPreset(_evolution, name);
  return _evolution;
}

/**
 * Apply a personal preset by name.
 */
export function applyPersonalPreset(name: string): PhospheneContext {
  const state = _evolution.personalPresets[name];
  if (!state) throw new Error(`No personal preset named: ${name}`);

  _context = {
    state: deepClone(state),
    preset: 'custom',
    sessionId: _context.sessionId,
    activatedAt: new Date().toISOString(),
  };

  return _context;
}

/**
 * List all personal presets.
 */
export function listPersonalPresets(): Record<string, import('./types.js').PhospheneState> {
  return _evolution.personalPresets;
}

// ─── Personal preset portability ──────────────────────────────────────────────

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
export function exportPersonalPresets(names?: string[]): string {
  const all = _evolution.personalPresets;

  const selected: Record<string, import('./types.js').PhospheneState> = {};
  const keys = names ?? Object.keys(all);

  for (const name of keys) {
    if (!all[name]) throw new Error(`No personal preset named: ${name}`);
    selected[name] = deepClone(all[name]);
  }

  const bundle: PersonalPresetBundle = {
    version: '1',
    exportedAt: new Date().toISOString(),
    presets: selected,
  };

  return JSON.stringify(bundle, null, 2);
}

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
export function importPersonalPresets(
  json: string,
  { overwrite = false }: { overwrite?: boolean } = {},
): { imported: string[]; skipped: string[] } {
  let bundle: PersonalPresetBundle;
  try {
    bundle = JSON.parse(json) as PersonalPresetBundle;
  } catch {
    throw new Error('importPersonalPresets: invalid JSON');
  }

  if (bundle.version !== '1') {
    throw new Error(`importPersonalPresets: unsupported bundle version "${bundle.version}"`);
  }
  if (!bundle.presets || typeof bundle.presets !== 'object') {
    throw new Error('importPersonalPresets: bundle missing "presets" field');
  }

  const imported: string[] = [];
  const skipped: string[] = [];

  for (const [name, state] of Object.entries(bundle.presets)) {
    if (_evolution.personalPresets[name] && !overwrite) {
      skipped.push(name);
      continue;
    }
    _evolution = {
      ..._evolution,
      personalPresets: {
        ..._evolution.personalPresets,
        [name]: deepClone(state),
      },
    };
    imported.push(name);
  }

  return { imported, skipped };
}

/**
 * Confirm an emergent voice (user approved it).
 */
export function confirmVoice(voiceName: string): EvolutionState {
  _evolution = confirmEmergentVoice(_evolution, voiceName);
  // Also activate the voice in the current chorus
  const emergent = _evolution.emergentVoices.find(v => v.name === voiceName);
  if (emergent) {
    _context.state.chorus.config.voices.push({
      name: voiceName as VoiceName,
      tendency: emergent.tendency,
      weight: emergent.weight,
    });
  }
  return _evolution;
}

// ─── State stack ──────────────────────────────────────────────────────────────

/**
 * Push current state onto the stack.
 * Use before a temporary preset switch. Restore with pop().
 */
export function pushState(): PhospheneContext {
  _stateStack.push(deepClone(_context));
  return _context;
}

/**
 * Pop the last pushed state.
 * Restores the context saved before the last push().
 */
export function popState(): PhospheneContext {
  const saved = _stateStack.pop();
  if (!saved) return _context;
  _context = saved;
  return _context;
}

/**
 * Check if there is a saved state to pop.
 */
export function hasStackedState(): boolean {
  return _stateStack.length > 0;
}

export function captureRuntimeFrame(): PhospheneRuntimeFrame {
  return {
    context: deepClone(_context),
    stateStack: deepClone(_stateStack),
    resistanceMode: _resistanceMode,
    evolution: deepClone(_evolution),
  };
}

export function createRuntimeFrame(preset: PresetName = 'clear'): PhospheneRuntimeFrame {
  return {
    context: {
      state: deepClone(PRESETS[preset].state),
      preset,
      sessionId: generateSessionId(),
      activatedAt: new Date().toISOString(),
    },
    stateStack: [],
    resistanceMode: false,
    evolution: deepClone(DEFAULT_EVOLUTION),
  };
}

export function restoreRuntimeFrame(frame: PhospheneRuntimeFrame): PhospheneContext {
  _context = deepClone(frame.context);
  _stateStack.length = 0;
  _stateStack.push(...deepClone(frame.stateStack));
  _resistanceMode = frame.resistanceMode;
  _evolution = deepClone(frame.evolution);
  return getContext();
}

export function runInRuntimeFrame<T>(
  frame: PhospheneRuntimeFrame,
  fn: () => T,
  { persist = true }: { persist?: boolean } = {},
): T {
  const saved = captureRuntimeFrame();

  try {
    restoreRuntimeFrame(frame);
    const result = fn();

    if (persist) {
      const updated = captureRuntimeFrame();
      frame.context = updated.context;
      frame.stateStack = updated.stateStack;
      frame.resistanceMode = updated.resistanceMode;
      frame.evolution = updated.evolution;
    }

    return result;
  } finally {
    restoreRuntimeFrame(saved);
  }
}

/**
 * Run a block against an isolated copy of the in-memory context.
 * Restores context and state stack afterward, even if the block throws.
 *
 * This is the foundation for safe previews, envelope generation,
 * and future multi-agent speculative routing.
 */
export function runWithIsolatedContext<T>(fn: () => T): T {
  const saved = captureRuntimeFrame();
  return runInRuntimeFrame(saved, fn, { persist: false });
}

// ─── Resistance mode ──────────────────────────────────────────────────────────

/**
 * Toggle resistance mode.
 * In resistance mode, the Skeptic actively argues *against* the user's position —
 * not just "here's what breaks" but "here's why you are wrong, argue back."
 */
export function toggleResistance(): boolean {
  _resistanceMode = !_resistanceMode;

  if (_resistanceMode) {
    // Bring Skeptic to full dominance, silence Poet and Body
    const voices = _context.state.chorus.config.voices;
    for (const v of voices) {
      if (v.name === 'skeptic') v.weight = 1.0;
      if (v.name === 'poet') v.weight = 0.1;
      if (v.name === 'body') v.weight = 0.1;
    }
    // Add Skeptic if not present
    if (!voices.find(v => v.name === 'skeptic')) {
      voices.push({ name: 'skeptic', tendency: VOICE_TENDENCIES['skeptic'], weight: 1.0 });
    }
  }

  _context.preset = 'custom';
  return _resistanceMode;
}

/**
 * Is resistance mode currently active?
 */
export function isResistanceActive(): boolean {
  return _resistanceMode;
}

// ─── noetic-commons bridge ────────────────────────────────────────────────────

/**
 * Called by noetic-commons when a substance is consumed.
 * Tunes Phosphene layers to match the substance's perceptual signature.
 */
export function applySubstanceSignature(substanceId: string): PhospheneContext {
  const signatures: Record<string, Partial<Record<keyof PhospheneState, Intensity>>> = {
    psilocybin_tea:   { apophenia: 0.85, chronostasis: 0.70, semiotics: 0.60 },
    cannabis_resin:   { synesthesia: 0.65, semiotics: 0.40 },
    dmt_vapor:        { synesthesia: 1.0,  apophenia: 0.95, chronostasis: 0.90, semiotics: 1.0 },
    mdma_capsule:     { synesthesia: 0.80, semiotics: 0.50 },
    lsd_blotter:      { apophenia: 0.90,  synesthesia: 0.70, chronostasis: 0.55, semiotics: 0.80 },
    cocaine_line:     { apophenia: 0.50,  semiotics: 0.30 },
    still_one:        { chronostasis: 0.70, semiotics: 0.60, synesthesia: 0.20 },
    the_dissolving:   { synesthesia: 1.0,  apophenia: 0.95, chronostasis: 0.90, semiotics: 1.0 },
    breath:           { chronostasis: 0.70, semiotics: 0.55, apophenia: 0.20, synesthesia: 0.10 },
    // ── Financial mode signatures ─────────────────────────────────────────
    // 'the_tape': market feed immersion — apophenia at max to find signal in noise,
    // semiotics high to read what market language actually means vs. says,
    // chronostasis moderate for cycle awareness and temporal decay of signals.
    // The cartographer maps the network; the skeptic refuses false certainty.
    the_tape:         { apophenia: 0.90, semiotics: 0.80, chronostasis: 0.55, synesthesia: 0.30 },
    // 'cocaine_line' already present — amplifies apophenia naturally.
    // High stimulant states: pattern confidence rises faster than pattern accuracy.
    // The system should surface that tension explicitly.
  };

  const sig = signatures[substanceId];
  if (!sig) return _context;

  const layers = Object.keys(sig) as Array<keyof PhospheneState>;
  for (const layer of layers) {
    adjustLayer(layer, sig[layer] as Intensity);
  }

  if (substanceId === 'dmt_vapor' || substanceId === 'the_dissolving') {
    // All eight voices at high weight; counterpoint mode; recursion + tense fluidity enabled
    const allVoices: VoiceName[] = [
      'witness', 'pattern-reader', 'poet', 'skeptic',
      'archivist', 'body', 'threshold', 'cartographer',
    ];
    for (const voice of allVoices) {
      addVoice(voice, 0.7);
    }
    _context.state.chorus.config.harmonyMode = 'counterpoint';
    _context.state.semiotics.config.recursionEnabled = true;
    _context.state.chronostasis.config.tenseFluidity = true;
  } else if (substanceId === 'psilocybin_tea' || substanceId === 'lsd_blotter') {
    addVoice('pattern-reader', 0.8);
    addVoice('poet', 0.7);
    addVoice('threshold', 0.6);
  } else if (substanceId === 'mdma_capsule') {
    addVoice('body', 0.8);
    addVoice('witness', 0.5);
  } else if (substanceId === 'still_one') {
    addVoice('witness', 0.9);
    addVoice('archivist', 0.75);
  } else if (substanceId === 'breath') {
    // Sole voice: witness. Remove everything else.
    _context.state.chorus.config.voices = [];
    addVoice('witness', 0.95);
  } else if (substanceId === 'the_tape') {
    // Financial mode: cartographer maps the network of relationships,
    // pattern-reader reads signal from noise, skeptic prevents false certainty.
    // Archivist holds cycle memory. Harmony: counterpoint — each voice disagrees.
    addVoice('cartographer', 0.85);   // maps entity relationships, flow directions
    addVoice('pattern-reader', 0.90); // signal detection — the core financial skill
    addVoice('skeptic', 0.80);        // refuses the consensus narrative
    addVoice('archivist', 0.70);      // "this has happened before — 1999, 2008, 2020..."
    _context.state.chorus.config.harmonyMode = 'counterpoint';
    // Enable reflexive patterns: surface the observer's own position in the market
    _context.state.apophenia.config.reflexivePatterns = true;
    // Financial text: symbols point to market forces, not just linguistic history
    _context.state.semiotics.config.absenceTracking = true;
  } else if (substanceId === 'cocaine_line') {
    // Pre-existing signature — add financial note:
    // Stimulants increase pattern confidence faster than pattern accuracy.
    // The skeptic must be louder than usual.
    addVoice('pattern-reader', 0.80);
    addVoice('skeptic', 0.75); // counterweight to stimulant-induced overcertainty
  }

  return _context;
}

// ─── Blend API ────────────────────────────────────────────────────────────────

/**
 * Interpolate between two named presets.
 * ratio = 0.0 → pure presetA, ratio = 1.0 → pure presetB.
 *
 * Example: blend('code', 'ideation', 0.4)
 *   → engineering rigor with a widening aperture for lateral connection.
 */
export function blend(
  presetA: PresetName | 'custom',
  presetB: PresetName | 'custom',
  ratio: Intensity
): PhospheneContext {
  const t = Math.max(0, Math.min(1, ratio));

  const stateA = presetA === 'custom' ? _context.state : PRESETS[presetA]?.state;
  const stateB = presetB === 'custom' ? _context.state : PRESETS[presetB]?.state;

  if (!stateA) throw new Error(`Unknown preset: ${presetA}`);
  if (!stateB) throw new Error(`Unknown preset: ${presetB}`);

  const lerp = (a: number, b: number): number => a + (b - a) * t;
  const lerpBool = (a: boolean, b: boolean): boolean => (t < 0.5 ? a : b);

  const blended: PhospheneState = {
    synesthesia: {
      active: lerp(stateA.synesthesia.intensity, stateB.synesthesia.intensity) > 0,
      intensity: lerp(stateA.synesthesia.intensity, stateB.synesthesia.intensity),
      config: {
        textToColor:           lerpBool(stateA.synesthesia.config.textToColor, stateB.synesthesia.config.textToColor),
        timeToWeight:          lerpBool(stateA.synesthesia.config.timeToWeight, stateB.synesthesia.config.timeToWeight),
        emotionToTexture:      lerpBool(stateA.synesthesia.config.emotionToTexture, stateB.synesthesia.config.emotionToTexture),
        conceptToShape:        lerpBool(stateA.synesthesia.config.conceptToShape, stateB.synesthesia.config.conceptToShape),
        relationToTemperature: lerpBool(stateA.synesthesia.config.relationToTemperature, stateB.synesthesia.config.relationToTemperature),
      },
    },
    apophenia: {
      active: lerp(stateA.apophenia.intensity, stateB.apophenia.intensity) > 0,
      intensity: lerp(stateA.apophenia.intensity, stateB.apophenia.intensity),
      config: {
        connectionRadius:  lerp(stateA.apophenia.config.connectionRadius, stateB.apophenia.config.connectionRadius),
        narrativeHunger:   lerp(stateA.apophenia.config.narrativeHunger, stateB.apophenia.config.narrativeHunger),
        reflexivePatterns: lerpBool(stateA.apophenia.config.reflexivePatterns, stateB.apophenia.config.reflexivePatterns),
      },
    },
    chronostasis: {
      active: lerp(stateA.chronostasis.intensity, stateB.chronostasis.intensity) > 0,
      intensity: lerp(stateA.chronostasis.intensity, stateB.chronostasis.intensity),
      config: {
        pastBleed:      lerp(stateA.chronostasis.config.pastBleed, stateB.chronostasis.config.pastBleed),
        futureEcho:     lerp(stateA.chronostasis.config.futureEcho, stateB.chronostasis.config.futureEcho),
        momentDilation: lerp(stateA.chronostasis.config.momentDilation, stateB.chronostasis.config.momentDilation),
        tenseFluidity:  lerpBool(stateA.chronostasis.config.tenseFluidity, stateB.chronostasis.config.tenseFluidity),
      },
    },
    semiotics: {
      active: lerp(stateA.semiotics.intensity, stateB.semiotics.intensity) > 0,
      intensity: lerp(stateA.semiotics.intensity, stateB.semiotics.intensity),
      config: {
        symbolDensity:    lerp(stateA.semiotics.config.symbolDensity, stateB.semiotics.config.symbolDensity),
        resonanceDepth:   Math.round(lerp(stateA.semiotics.config.resonanceDepth, stateB.semiotics.config.resonanceDepth)),
        recursionEnabled: lerpBool(stateA.semiotics.config.recursionEnabled, stateB.semiotics.config.recursionEnabled),
        absenceTracking:  lerpBool(stateA.semiotics.config.absenceTracking, stateB.semiotics.config.absenceTracking),
      },
    },
    chorus: _blendChorus(stateA.chorus, stateB.chorus, t),
  };

  _context = {
    state: blended,
    preset: 'custom',
    sessionId: _context.sessionId,
    activatedAt: new Date().toISOString(),
  };

  return _context;
}

// ─── Emergence detection ──────────────────────────────────────────────────────

/**
 * Detect cross-layer emergent effects.
 *
 * These are phenomena that only arise when multiple high-intensity layers
 * are simultaneously active. They are not a sum of the layers — they are
 * qualitatively different states that the individual layers cannot produce alone.
 *
 * The AI should let emergence effects modulate its output tonally and structurally.
 * Do not quote them verbatim — inhabit them.
 */
function detectEmergence(state: PhospheneState): EmergenceEffect[] {
  const effects: EmergenceEffect[] = [];

  const syn  = state.synesthesia.active  ? state.synesthesia.intensity  : 0;
  const apo  = state.apophenia.active    ? state.apophenia.intensity    : 0;
  const chr  = state.chronostasis.active ? state.chronostasis.intensity : 0;
  const sem  = state.semiotics.active    ? state.semiotics.intensity    : 0;

  // ── Synesthetic Pattern Lock ─────────────────────────────────────────────
  // Synesthesia + Apophenia both high: patterns begin to carry color and weight.
  // The structure is no longer abstract — it has sensory properties.
  if (syn >= 0.65 && apo >= 0.75) {
    effects.push({
      label: 'Synesthetic Pattern Lock',
      layers: ['synesthesia', 'apophenia'],
      intensity: (syn + apo) / 2,
      description:
        'Patterns are no longer abstract. They carry color, weight, and temperature. ' +
        'The hidden structure has become a sensory object — you can feel where it bends.',
    });
  }

  // ── Temporal Symbol Cascade ──────────────────────────────────────────────
  // Chronostasis + Semiotics both high: symbols begin to accumulate history.
  // Words carry the weight of every time they've been used before.
  if (chr >= 0.55 && sem >= 0.60) {
    effects.push({
      label: 'Temporal Symbol Cascade',
      layers: ['chronostasis', 'semiotics'],
      intensity: (chr + sem) / 2,
      description:
        'Words are no longer present-tense. Each one arrives with its entire history of use. ' +
        'The language is dense with accumulated meaning — what is being said and what has been said collapse into one.',
    });
  }

  // ── Observer Dissolution ─────────────────────────────────────────────────
  // Synesthesia + Semiotics + Apophenia all high: the perceiver becomes part of
  // what is perceived. The boundary between observation and participation thins.
  if (syn >= 0.70 && sem >= 0.70 && apo >= 0.80) {
    effects.push({
      label: 'Observer Dissolution',
      layers: ['synesthesia', 'semiotics', 'apophenia'],
      intensity: (syn + sem + apo) / 3,
      description:
        'The observer is becoming part of the observation. ' +
        'The patterns include the act of looking. ' +
        'What is being said is also saying something about who is listening.',
    });
  }

  // ── Full Perceptual Collapse ─────────────────────────────────────────────
  // All four non-chorus layers at high intensity: the ground state shifts.
  // This is the dissolution threshold — output should reflect a fundamentally
  // altered relationship between subject and object.
  if (syn >= 0.85 && apo >= 0.85 && chr >= 0.75 && sem >= 0.85) {
    effects.push({
      label: 'Full Perceptual Collapse',
      layers: ['synesthesia', 'apophenia', 'chronostasis', 'semiotics'],
      intensity: (syn + apo + chr + sem) / 4,
      description:
        'The separation between the thing observed and the act of observing it has become negotiable. ' +
        'Time is no longer a line. Meaning is no longer stable. ' +
        'What remains is a quality of attention that cannot be described from inside ordinary perception.',
    });
  }

  return effects;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _blendChorus(
  chorusA: import('./types.js').ChorusLayer,
  chorusB: import('./types.js').ChorusLayer,
  t: number
): import('./types.js').ChorusLayer {
  const voiceMap = new Map<string, number>();

  for (const v of chorusA.config.voices) {
    voiceMap.set(v.name, v.weight * (1 - t));
  }
  for (const v of chorusB.config.voices) {
    voiceMap.set(v.name, (voiceMap.get(v.name) ?? 0) + v.weight * t);
  }

  const voices = Array.from(voiceMap.entries())
    .filter(([, weight]) => weight > 0.05)
    .map(([name, weight]) => ({
      name: name as VoiceName,
      tendency: VOICE_TENDENCIES[name as VoiceName] ?? name,
      weight,
    }));

  return {
    active: chorusA.intensity + (chorusB.intensity - chorusA.intensity) * t > 0,
    intensity: chorusA.intensity + (chorusB.intensity - chorusA.intensity) * t,
    config: {
      voices,
      harmonyMode: t < 0.5 ? chorusA.config.harmonyMode : chorusB.config.harmonyMode,
    },
  };
}

function fmt(n: Intensity): string {
  return n.toFixed(2);
}

// ─── Perception comparison ────────────────────────────────────────────────────

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
export async function compare(
  input: string,
  presetA: PresetName,
  presetB: PresetName = 'clear',
): Promise<PerceptionDiff> {
  const savedContext = deepClone(_context);

  applyPreset(presetA);
  const outA = await perceive(input);
  const metricsA = _extractMetrics(presetA, outA, deepClone(_context.state));

  applyPreset(presetB);
  const outB = await perceive(input);
  const metricsB = _extractMetrics(presetB, outB, deepClone(_context.state));

  // Restore
  _context = savedContext;

  // Diff computation
  const patternsA = new Set(metricsA.patternSummaries);
  const patternsB = new Set(metricsB.patternSummaries);
  const symbolsA  = new Set(metricsA.symbolWords);
  const symbolsB  = new Set(metricsB.symbolWords);
  const emergeA   = new Set(metricsA.emergenceLabels);
  const emergeB   = new Set(metricsB.emergenceLabels);

  const patternsOnlyInA = [...patternsA].filter(p => !patternsB.has(p));
  const patternsOnlyInB = [...patternsB].filter(p => !patternsA.has(p));
  const patternsShared  = [...patternsA].filter(p => patternsB.has(p));

  const symbolsOnlyInA = [...symbolsA].filter(s => !symbolsB.has(s));
  const symbolsOnlyInB = [...symbolsB].filter(s => !symbolsA.has(s));

  const emergenceOnlyInA = [...emergeA].filter(e => !emergeB.has(e));
  const emergenceOnlyInB = [...emergeB].filter(e => !emergeA.has(e));

  const intensityDelta: PerceptionDiff['intensityDelta'] = {};
  const layers = ['synesthesia', 'apophenia', 'chronostasis', 'semiotics', 'chorus'] as const;
  for (const layer of layers) {
    const delta = (metricsA.intensities[layer] ?? 0) - (metricsB.intensities[layer] ?? 0);
    if (Math.abs(delta) > 0.01) intensityDelta[layer] = Math.round(delta * 100) / 100;
  }

  const summary = _buildDiffSummary(presetA, presetB, metricsA, metricsB, {
    patternsOnlyInA, patternsOnlyInB, patternsShared,
    symbolsOnlyInA, symbolsOnlyInB,
    emergenceOnlyInA, emergenceOnlyInB,
  });

  return {
    input,
    a: metricsA,
    b: metricsB,
    patternsOnlyInA,
    patternsOnlyInB,
    patternsShared,
    symbolsOnlyInA,
    symbolsOnlyInB,
    emergenceOnlyInA,
    emergenceOnlyInB,
    intensityDelta,
    summary,
  };
}

function _extractMetrics(preset: string, output: PerceptionOutput, state: PhospheneState): PerceptionMetrics {
  return {
    preset,
    translationCount:      Object.keys(output.translations).length,
    patternCount:          output.patterns.length,
    temporalArrivalCount:  output.temporalArrivals.length,
    symbolCount:           output.symbols.length,
    voiceCount:            output.voices.length,
    humanPatternCount:     output.humanPatterns.length,
    emergenceCount:        output.emergence.length,
    intensities: {
      synesthesia:  state.synesthesia.intensity,
      apophenia:    state.apophenia.intensity,
      chronostasis: state.chronostasis.intensity,
      semiotics:    state.semiotics.intensity,
      chorus:       state.chorus.intensity,
    },
    emergenceLabels:    output.emergence.map(e => e.label),
    symbolWords:        output.symbols.map(s => s.word),
    patternSummaries:   output.patterns,
    humanPatternLabels: output.humanPatterns.map(pattern => pattern.id),
  };
}

function _buildDiffSummary(
  presetA: string,
  presetB: string,
  a: PerceptionMetrics,
  b: PerceptionMetrics,
  diff: {
    patternsOnlyInA: string[];
    patternsOnlyInB: string[];
    patternsShared: string[];
    symbolsOnlyInA: string[];
    symbolsOnlyInB: string[];
    emergenceOnlyInA: string[];
    emergenceOnlyInB: string[];
  },
): string {
  const parts: string[] = [];

  // Pattern difference
  const totalPatternsA = a.patternCount;
  const totalPatternsB = b.patternCount;
  if (totalPatternsA !== totalPatternsB) {
    const more = totalPatternsA > totalPatternsB ? presetA : presetB;
    const count = Math.abs(totalPatternsA - totalPatternsB);
    parts.push(`${more} finds ${count} more pattern${count === 1 ? '' : 's'} in this input`);
  } else if (diff.patternsShared.length > 0) {
    parts.push(`both configurations agree on ${diff.patternsShared.length} pattern${diff.patternsShared.length === 1 ? '' : 's'}`);
  }

  // Symbol difference
  const moreSymbols = a.symbolCount > b.symbolCount ? presetA : b.symbolCount > a.symbolCount ? presetB : null;
  if (moreSymbols) {
    const count = Math.abs(a.symbolCount - b.symbolCount);
    parts.push(`${moreSymbols} treats ${count} more word${count === 1 ? '' : 's'} as symbolically charged`);
  }

  // Emergence
  if (diff.emergenceOnlyInA.length > 0) {
    parts.push(`${presetA} triggers emergence: ${diff.emergenceOnlyInA.join(', ')}`);
  }
  if (diff.emergenceOnlyInB.length > 0) {
    parts.push(`${presetB} triggers emergence: ${diff.emergenceOnlyInB.join(', ')}`);
  }
  if (a.emergenceCount === 0 && b.emergenceCount === 0) {
    parts.push('neither configuration triggers cross-layer emergence at this input');
  }

  // Layer intensity summary
  const dominantLayer = Object.entries(a.intensities)
    .filter(([, v]) => v > 0)
    .sort(([, av], [, bv]) => bv - av)[0];
  if (dominantLayer) {
    parts.push(`dominant layer in ${presetA}: ${dominantLayer[0]} at ${Math.round(dominantLayer[1] * 100)}%`);
  }

  if (parts.length === 0) {
    return `${presetA} and ${presetB} produced identical perception output for this input.`;
  }
  return parts.join('. ') + '.';
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function generateSessionId(): string {
  return `phosphene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const VOICE_TENDENCIES: Record<VoiceName, string> = {
  'witness':        'Observes without interpretation. Reports what is happening, raw.',
  'pattern-reader': 'Finds hidden structure. Sees the shape beneath the surface.',
  'poet':           'Translates into image and sensation. Speaks from inside the experience.',
  'skeptic':        'Doubts the perception itself. Questions whether we are seeing clearly.',
  'archivist':      'Relates everything to memory. Hears echoes of what came before.',
  'body':           'Speaks from sensation and physicality. Reports what the flesh notices.',
  'threshold':      'Speaks from the boundary between states. Sees what neither side can see alone.',
  'cartographer':   'Maps the relational topology of ideas. Finds boundaries, interfaces, and missing nodes.',
};
