#!/usr/bin/env node
/**
 * Phosphene — Artemis plugin doctor
 *
 * Checks whether the plugin is installed in the shape expected by Artemis:
 *   <workspace>/plugins/phosphene/.artemis-plugin/plugin.json
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const WORKSPACE_ROOT = process.cwd();
const EXPECTED_ROOT = join(WORKSPACE_ROOT, 'plugins', 'phosphene');
const MANIFEST_PATH = join(PLUGIN_ROOT, '.artemis-plugin', 'plugin.json');

function ok(label, detail = '') {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function warn(label, detail = '') {
  console.log(`! ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, detail = '') {
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const manifest = readManifest();
  let failed = false;

  console.log('[phosphene-artemis] Doctor');
  console.log(`  Workspace: ${WORKSPACE_ROOT}`);
  console.log(`  Plugin:    ${PLUGIN_ROOT}`);
  console.log('');

  if (manifest?.name === 'phosphene') {
    ok('manifest present', relative(WORKSPACE_ROOT, MANIFEST_PATH));
  } else {
    fail('manifest missing or invalid', MANIFEST_PATH);
    failed = true;
  }

  for (const file of [
    'scripts/artemis-bootstrap.js',
    'scripts/artemis-activity.js',
    'scripts/artemis-after-workflow.js',
    'scripts/artemis-soul.js',
    'scripts/artemis-visual-status.js',
    'scripts/dream-daemon.js',
    'SKILL.md',
  ]) {
    const path = join(PLUGIN_ROOT, file);
    if (existsSync(path)) ok(file);
    else {
      fail(file, 'missing');
      failed = true;
    }
  }

  if (PLUGIN_ROOT === EXPECTED_ROOT) {
    ok('installed at Artemis workspace plugin path', 'plugins/phosphene');
  } else {
    warn('not installed at plugins/phosphene for this workspace');
    console.log('  To use from an Artemis workspace:');
    console.log(`  mkdir -p ${join(WORKSPACE_ROOT, 'plugins')}`);
    console.log(`  cp -R ${PLUGIN_ROOT} ${EXPECTED_ROOT}`);
    console.log('  Then run: plugins exec phosphene status');
  }

  if (failed) process.exit(1);
}

main();
