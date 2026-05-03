#!/usr/bin/env node
/**
 * Phosphene — Artemis bootstrap
 *
 * Ensures an Artemis project has the local phosphene state file plus the dream
 * archive skeleton ready before or between workflows.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ARGS = process.argv.slice(2);
const FLAG_QUIET = ARGS.includes('--quiet');
const FLAG_STATUS = ARGS.includes('--status');

const DATA_ROOT = join(process.cwd(), '.artemis');
const STATE_PATH = join(DATA_ROOT, 'phosphene-state.json');
const DREAMS_DIR = join(DATA_ROOT, 'dreams');
const IMAGES_DIR = join(DREAMS_DIR, 'images');
const INDEX_PATH = join(DREAMS_DIR, 'index.md');
const GALLERY_PATH = join(DREAMS_DIR, 'gallery.html');

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

function ensureStateFile() {
  mkdirSync(DATA_ROOT, { recursive: true });

  if (!existsSync(STATE_PATH)) {
    const state = {
      ...DEFAULT_STATE,
      firstInstalledAt: nowIso(),
      lastUpdated: nowIso(),
    };
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    return { created: true, state };
  }

  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    const state = {
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
      lastUpdated: nowIso(),
    };
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    return { created: false, state };
  } catch {
    const state = {
      ...DEFAULT_STATE,
      firstInstalledAt: nowIso(),
      lastUpdated: nowIso(),
    };
    try {
      writeFileSync(`${STATE_PATH}.corrupt`, readFileSync(STATE_PATH, 'utf8'), 'utf8');
    } catch {
      // Best effort only.
    }
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    return { created: true, state, recoveredFromCorruption: true };
  }
}

function ensureDreamArchive() {
  mkdirSync(IMAGES_DIR, { recursive: true });

  if (!existsSync(INDEX_PATH)) {
    writeFileSync(
      INDEX_PATH,
      `# Dream Archive

*The dream system is active. The first dream will be written after the first idle window resolves into sleep.*

| Date | Stage | Preset | Intensity | Fragments | File |
|------|-------|--------|-----------|-----------|------|
| - | - | - | - | - | - |
`,
      'utf8',
    );
  }

  if (!existsSync(GALLERY_PATH)) {
    writeFileSync(
      GALLERY_PATH,
      `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Phosphene Dream Archive</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0d1117;
        --panel: #161b22;
        --line: #30363d;
        --text: #e6edf3;
        --muted: #8b949e;
        --accent: #7ee787;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: radial-gradient(circle at top, #182030 0%, var(--bg) 56%);
        color: var(--text);
        font: 16px/1.6 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 760px;
        margin: 0 auto;
        padding: 64px 24px 80px;
      }
      .panel {
        background: color-mix(in srgb, var(--panel) 92%, transparent);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 24px;
      }
      h1 { margin: 0 0 12px; font-size: 32px; }
      p { margin: 0 0 12px; color: var(--muted); }
      code, a { color: var(--accent); }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>Dream System Active</h1>
        <p>The local Phosphene dream archive has been initialized for this Artemis workspace.</p>
        <p>Archive folder: <code>${DREAMS_DIR}</code></p>
        <p>Images folder: <code>${IMAGES_DIR}</code></p>
        <p>Index: <a href="./index.md">Open archive index</a></p>
      </section>
    </main>
  </body>
</html>`,
      'utf8',
    );
  }
}

function printStatus() {
  console.log('[phosphene-artemis] Status');
  console.log(`  Data root:  ${DATA_ROOT}`);
  console.log(`  State:      ${STATE_PATH}`);
  console.log(`  Dreams:     ${DREAMS_DIR}`);
  console.log(`  Gallery:    ${GALLERY_PATH}`);
  console.log(`  State file: ${existsSync(STATE_PATH) ? 'present' : 'missing'}`);
  console.log(`  Gallery:    ${existsSync(GALLERY_PATH) ? 'present' : 'missing'}`);
}

function main() {
  if (FLAG_STATUS) {
    printStatus();
    return;
  }

  const result = ensureStateFile();
  ensureDreamArchive();

  if (!FLAG_QUIET) {
    console.log('[phosphene-artemis] Bootstrap ready');
    console.log(`  Data root: ${DATA_ROOT}`);
    console.log(`  State:     ${STATE_PATH}`);
    console.log(`  Dreams:    ${DREAMS_DIR}`);
    console.log(`  Gallery:   ${GALLERY_PATH}`);
    if (result.recoveredFromCorruption) {
      console.log('  State recovery: rebuilt from corrupted file');
    } else {
      console.log(`  State file: ${result.created ? 'created' : 'updated'}`);
    }
  }
}

main();
