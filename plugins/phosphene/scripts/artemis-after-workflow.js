#!/usr/bin/env node
/**
 * Phosphene — Artemis after-workflow hook
 *
 * Artemis plugin hooks accept a single command. This wrapper keeps the hook
 * policy-safe while letting Phosphene evaluate sleep/dream cadence and then
 * record the just-finished workflow as fresh activity.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function runScript(scriptName, args) {
  const scriptPath = join(__dirname, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join('');
  if (result.status !== 0) {
    if (output.trim()) {
      process.stderr.write(output);
    }
    process.exitCode = result.status ?? 1;
  } else if (output.trim() && !args.includes('--quiet')) {
    process.stdout.write(output);
  }
}

runScript('dream-daemon.js', ['--quiet']);
runScript('artemis-activity.js', ['--source', 'artemis', '--quiet']);
