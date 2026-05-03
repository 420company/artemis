#!/usr/bin/env node
/**
 * Phosphene — Artemis high mode
 *
 * A small, reversible workspace/session switch used by Artemis aliases such as:
 *   /high
 *   /high code
 *   /high design
 *   /high off
 *
 * It only writes the project-local .artemis/phosphene-state.json file. It never
 * modifies ~/.artemis/soul.md, skill.md, or any host identity file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ARGS = process.argv.slice(2);
const DATA_ROOT = join(process.cwd(), '.artemis');
const STATE_PATH = join(DATA_ROOT, 'phosphene-state.json');

const PRESET_ALIASES = new Map([
  ['default', 'deep-flux'],
  ['high', 'deep-flux'],
  ['deep', 'deep-flux'],
  ['subtle', 'liminal'],
  ['low', 'liminal'],
  ['clear', 'clear'],
  ['code', 'code'],
  ['design', 'design'],
  ['research', 'research'],
  ['review', 'review'],
  ['write', 'writing'],
  ['writing', 'writing'],
  ['idea', 'ideation'],
  ['ideas', 'ideation'],
  ['ideation', 'ideation'],
  ['dream', 'deep-flux'],
]);

const HELP = `Phosphene high mode

Usage:
  /high              enter high mode (deep-flux)
  /high subtle       enter a gentle lens (liminal)
  /high code         architecture / bug-risk lens
  /high design       visual / UX judgment lens
  /high research     synthesis / evidence lens
  /high off          leave high mode

Plugin command equivalents:
  plugins exec phosphene high
  plugins exec phosphene high code
  plugins exec phosphene high off
`;

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
  evolution: {
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
  },
};

function nowIso() {
  return new Date().toISOString();
}

function loadState() {
  mkdirSync(DATA_ROOT, { recursive: true });
  if (!existsSync(STATE_PATH)) {
    return {
      ...DEFAULT_STATE,
      firstInstalledAt: nowIso(),
      lastUpdated: nowIso(),
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return {
      ...DEFAULT_STATE,
      ...parsed,
      highMode: {
        ...DEFAULT_STATE.highMode,
        ...(parsed.highMode ?? {}),
      },
      evolution: {
        ...DEFAULT_STATE.evolution,
        ...(parsed.evolution ?? {}),
      },
    };
  } catch {
    try {
      writeFileSync(`${STATE_PATH}.corrupt`, readFileSync(STATE_PATH, 'utf8'), 'utf8');
    } catch {
      // Best effort only.
    }
    return {
      ...DEFAULT_STATE,
      firstInstalledAt: nowIso(),
      lastUpdated: nowIso(),
    };
  }
}

function saveState(state) {
  mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function printStatus(state) {
  const mode = state.highMode ?? DEFAULT_STATE.highMode;
  console.log('[phosphene-high] Status');
  console.log(`  Active: ${mode.active ? 'yes' : 'no'}`);
  console.log(`  Preset: ${mode.preset ?? state.preset ?? 'clear'}`);
  console.log(`  State:  ${STATE_PATH}`);
  if (mode.activatedAt) console.log(`  Since:  ${mode.activatedAt}`);
  if (!mode.active && mode.deactivatedAt) console.log(`  Off at: ${mode.deactivatedAt}`);
}

function activate(rawPreset) {
  const requested = rawPreset || 'default';
  const preset = PRESET_ALIASES.get(requested) ?? requested;
  const state = loadState();
  const timestamp = nowIso();

  state.awakened = true;
  state.preset = preset;
  state.lastUpdated = timestamp;
  state.highMode = {
    active: true,
    preset,
    activatedAt: timestamp,
    deactivatedAt: null,
    source: '/high',
  };

  saveState(state);

  console.log(`[phosphene-high] on — ${preset}`);
  console.log('  /high off exits. This only changed workspace-local Phosphene state.');
}

function deactivate() {
  const state = loadState();
  const timestamp = nowIso();

  state.preset = 'clear';
  state.lastUpdated = timestamp;
  state.highMode = {
    ...(state.highMode ?? DEFAULT_STATE.highMode),
    active: false,
    preset: 'clear',
    deactivatedAt: timestamp,
    source: '/high off',
  };

  saveState(state);

  console.log('[phosphene-high] off');
  console.log('  Artemis is back to its normal workspace mode.');
}

function main() {
  const [first] = ARGS;
  if (first === '--help' || first === '-h' || first === 'help') {
    console.log(HELP);
    return;
  }

  const state = loadState();
  if (first === '--status' || first === 'status') {
    printStatus(state);
    return;
  }

  if (first === 'off' || first === 'false' || first === '0' || first === 'clear') {
    deactivate();
    return;
  }

  activate(first ?? 'default');
}

main();
