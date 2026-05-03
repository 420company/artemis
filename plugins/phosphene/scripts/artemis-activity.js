#!/usr/bin/env node
/**
 * Phosphene — Artemis activity heartbeat
 *
 * Records interaction / work timestamps into the local Artemis phosphene state
 * so the autonomous dream daemon can tell the difference between active work
 * and a true idle window.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ARGS = process.argv.slice(2);
const FLAG_QUIET = ARGS.includes('--quiet');
const FLAG_STATUS = ARGS.includes('--status');
const SOURCE_INDEX = ARGS.indexOf('--source');
const SOURCE = SOURCE_INDEX >= 0 ? (ARGS[SOURCE_INDEX + 1] ?? 'artemis') : 'artemis';

const DATA_ROOT = join(process.cwd(), '.artemis');
const STATE_PATH = join(DATA_ROOT, 'phosphene-state.json');

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
  lastActivityAt: null,
  lastActivitySource: null,
  lastDreamAt: null,
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
    const fresh = {
      ...DEFAULT_STATE,
      firstInstalledAt: nowIso(),
      lastUpdated: nowIso(),
    };
    writeFileSync(STATE_PATH, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }

  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return {
      ...DEFAULT_STATE,
      ...parsed,
      evolution: {
        ...DEFAULT_STATE.evolution,
        ...(parsed.evolution ?? {}),
      },
    };
  } catch {
    const fresh = {
      ...DEFAULT_STATE,
      firstInstalledAt: nowIso(),
      lastUpdated: nowIso(),
    };
    writeFileSync(STATE_PATH, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }
}

function saveState(state) {
  mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function printStatus(state) {
  console.log('[phosphene-artemis] Activity');
  console.log(`  State:        ${STATE_PATH}`);
  console.log(`  Last activity:${state.lastActivityAt ?? 'none'}`);
  console.log(`  Source:       ${state.lastActivitySource ?? 'none'}`);
  console.log(`  Last dream:   ${state.lastDreamAt ?? 'never'}`);
}

function main() {
  const state = loadState();

  if (FLAG_STATUS) {
    printStatus(state);
    return;
  }

  const touched = {
    ...state,
    lastActivityAt: nowIso(),
    lastActivitySource: SOURCE,
    lastUpdated: nowIso(),
  };
  saveState(touched);

  if (!FLAG_QUIET) {
    console.log('[phosphene-artemis] Activity heartbeat recorded');
    console.log(`  Source: ${SOURCE}`);
    console.log(`  At:     ${touched.lastActivityAt}`);
  }
}

main();
