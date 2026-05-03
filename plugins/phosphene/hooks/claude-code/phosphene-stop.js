#!/usr/bin/env node
/**
 * Phosphene — Claude Code Stop hook
 *
 * Fires when Claude Code ends a session (Stop event).
 * Closes the open session record, derives outcome from signal balance,
 * archives it into evolution history, and checks evolution readiness.
 *
 * Install:
 *   cp ~/.claude/phosphene-stop.js (or symlink from the phosphene repo)
 *   Add to your project's .claude/settings.json:
 *
 *   {
 *     "hooks": {
 *       "Stop": [{
 *         "matcher": "",
 *         "hooks": [{ "type": "command", "command": "node ~/.claude/phosphene-stop.js" }]
 *       }]
 *     }
 *   }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Path resolution ──────────────────────────────────────────────────────────

function resolveStatePath() {
  const hermes = join(homedir(), '.hermes');
  const claude = join(homedir(), '.claude');
  if (existsSync(hermes)) return join(hermes, 'phosphene-state.json');
  if (existsSync(claude)) return join(claude, 'phosphene-state.json');
  return join(process.cwd(), 'phosphene-state.json');
}

const STATE_PATH = resolveStatePath();

// ─── State I/O ────────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  mkdirSync(join(STATE_PATH, '..'), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ─── Session close ────────────────────────────────────────────────────────────

function deriveOutcome(signals = []) {
  const positive = signals.filter(s => ['calibrate', 'crystallize', 'anchor'].includes(s.type)).length;
  const negative = signals.filter(s => s.type === 'reject').length;
  const noise    = signals.filter(s => ['amplify', 'reduce'].includes(s.type)).length;
  if (positive > 0 && positive > negative) return 'productive';
  if (negative >= 2 && negative > positive) return 'noisy';
  if (noise > 3) return 'noisy';
  return 'neutral';
}

function checkEvolutionReadiness(evolution) {
  const SIGNAL_THRESHOLD  = 20;
  const SESSION_THRESHOLD = 5;

  const lastEvolvedAt = evolution.lastEvolvedAt;
  const history       = evolution.sessionHistory ?? [];
  const allSignals    = evolution.feedbackHistory ?? [];

  const sessionsSince = lastEvolvedAt
    ? history.filter(s => (s.startedAt ?? '') > lastEvolvedAt).length
    : history.length;

  const signalsSince = lastEvolvedAt
    ? allSignals.filter(s => (s.timestamp ?? '') > lastEvolvedAt).length
    : allSignals.length;

  if (sessionsSince >= SESSION_THRESHOLD && signalsSince >= SIGNAL_THRESHOLD) {
    return { sessionsSince, signalsSince };
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const state = loadState();
if (!state || !state.evolution) process.exit(0);

const evolution = state.evolution;
const now = new Date().toISOString();

// Close open session
if (evolution.currentSession) {
  const session = evolution.currentSession;
  session.closedAt = now;
  session.outcome  = deriveOutcome(session.signals ?? []);

  const history = [session, ...(evolution.sessionHistory ?? [])].slice(0, 50);
  evolution.currentSession  = null;
  evolution.sessionHistory  = history;
}

state.evolution  = evolution;
state.lastUpdated = now;
saveState(state);

// Evolution readiness notice (printed to stdout — Claude Code can read it)
const ready = checkEvolutionReadiness(evolution);
if (ready) {
  process.stdout.write(
    `\n[phosphene] Evolution ready: ${ready.signalsSince} signals, ` +
    `${ready.sessionsSince} sessions accumulated. ` +
    `Say "phosphene evolve" at the start of your next session.\n`
  );
}

// ── Trigger dream daemon in background ────────────────────────────────────────
// The daemon checks its own timing/probability conditions before dreaming.
// Runs detached so it doesn't block the Stop hook from completing.
const daemonPath = join(__dirname, '../../scripts/dream-daemon.js');
if (existsSync(daemonPath)) {
  const child = spawn(process.execPath, [daemonPath], {
    detached:  true,
    stdio:     'ignore',
    // Pass the dreams log path via env so the daemon can log to it
    env: { ...process.env },
  });
  child.unref(); // don't wait for it
}
