#!/usr/bin/env node
/**
 * Phosphene — Artemis soul adapter
 *
 * Safe by default: prints a soul.md patch proposal instead of modifying the file.
 * Use --write only when the user explicitly wants Phosphene to become part of
 * Artemis' persistent local soul.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ARGS = process.argv.slice(2);
const FLAG_WRITE = ARGS.includes('--write');
const FLAG_STATUS = ARGS.includes('--status');
const FLAG_UNINSTALL = ARGS.includes('--uninstall');
const SOUL_PATH = join(homedir(), '.artemis', 'soul.md');
const MARKER_BEGIN = '<!-- phosphene:artemis-soul:start -->';
const MARKER_END = '<!-- phosphene:artemis-soul:end -->';

const SOUL_BLOCK = `${MARKER_BEGIN}

## Phosphene Lens

Phosphene is an optional second-pass perception lens for Artemis. It does not replace Artemis' engineering discipline, evidence rules, or user language preference.

When the user asks for \`plugin:phosphene\`, Phosphene, deeper judgment, better ideas, creative direction, design critique, research synthesis, literary close reading, market narrative/risk analysis, or a stronger code review, add one disciplined perception pass:

- Identify the real task shape, hidden constraints, strongest pattern, weakest assumption, and next concrete action.
- For code: prioritize correctness, maintainability, test risk, architecture load-bearing points, and user-visible behavior.
- For design: judge hierarchy, contrast, spacing, motion, copy, accessibility, and first-screen usability.
- For research/strategy: separate evidence, inference, uncertainty, and decision.
- Keep Artemis as the host identity. Do not roleplay altered states. Do not become ornate for its own sake.
- Metaphor is allowed only when it clarifies judgment or execution.

${MARKER_END}`;

function readSoul() {
  try {
    return readFileSync(SOUL_PATH, 'utf8');
  } catch {
    return '';
  }
}

function upsertBlock(content) {
  const trimmed = content.trimEnd();
  const start = trimmed.indexOf(MARKER_BEGIN);
  const end = trimmed.indexOf(MARKER_END);
  if (start >= 0 && end > start) {
    return `${trimmed.slice(0, start).trimEnd()}\n\n${SOUL_BLOCK}\n${trimmed.slice(end + MARKER_END.length).trimStart()}`.trim() + '\n';
  }
  return `${trimmed ? `${trimmed}\n\n` : '# Artemis Soul\n\n'}${SOUL_BLOCK}\n`;
}

function removeBlock(content) {
  const start = content.indexOf(MARKER_BEGIN);
  const end = content.indexOf(MARKER_END);
  if (start < 0 || end <= start) return { changed: false, content };

  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end + MARKER_END.length).trimStart();
  const next = [before, after].filter(Boolean).join('\n\n');
  return { changed: true, content: next ? `${next}\n` : '' };
}

function main() {
  const exists = existsSync(SOUL_PATH);
  const current = readSoul();
  const next = upsertBlock(current);
  const alreadyInstalled = current.includes(MARKER_BEGIN) && current.includes(MARKER_END);

  if (FLAG_STATUS) {
    console.log('[phosphene-artemis] Soul adapter');
    console.log(`  Soul path: ${SOUL_PATH}`);
    console.log(`  soul.md:   ${exists ? 'present' : 'missing'}`);
    console.log(`  Lens:      ${alreadyInstalled ? 'installed' : 'not installed'}`);
    return;
  }

  if (FLAG_UNINSTALL) {
    const result = removeBlock(current);
    if (!result.changed) {
      console.log('[phosphene-artemis] Soul lens not installed');
      console.log(`  Target: ${SOUL_PATH}`);
      return;
    }
    writeFileSync(SOUL_PATH, result.content, 'utf8');
    console.log('[phosphene-artemis] Soul lens removed');
    console.log(`  Target: ${SOUL_PATH}`);
    return;
  }

  if (!FLAG_WRITE) {
    console.log('[phosphene-artemis] Soul patch proposal');
    console.log(`  Target: ${SOUL_PATH}`);
    console.log('  Mode:   preview only; rerun with --write to modify soul.md');
    console.log('');
    console.log(SOUL_BLOCK);
    return;
  }

  mkdirSync(join(homedir(), '.artemis'), { recursive: true });
  writeFileSync(SOUL_PATH, next, 'utf8');
  console.log('[phosphene-artemis] Soul lens written');
  console.log(`  Target: ${SOUL_PATH}`);
  console.log(`  Action: ${alreadyInstalled ? 'updated existing block' : 'added block'}`);
}

main();
