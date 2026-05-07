#!/usr/bin/env tsx
// Sanity-test every transition kind by piping the same 2 source segments
// through Saga's renderer with each transition kind. We don't assert visual
// quality — we just verify the FFmpeg filtergraph compiles and produces a
// valid mp4 for each kind. Custom xfade expressions are easy to typo, this
// catches that fast without burning a full BytePlus run.

import path from 'node:path';
import { stat, mkdir, copyFile, rm } from 'node:fs/promises';
import { renderSagaProject } from '../src/tools/visual/sagaRenderer/index.js';
import { planTransition } from '../src/tools/visual/sagaRenderer/transitions.js';
import type { SagaSegmentInput, SagaTransitionKind } from '../src/tools/visual/sagaRenderer/types.js';

const TRANSITIONS: SagaTransitionKind[] = [
  'crossfade',
  'dissolve',
  'light-leak',
  'fade-black',
  'fade-white',
  'wipe-left',
  'wipe-right',
  'slide-up',
  'push-left',
  'push-right',
  'circle-open',
  'circle-close',
  'blur',
  'zoom-in',
  'zoom-out',
  'flash',
  'speed-ramp',
  'whip-pan',
  'whip-pan-left',
  'match-cut',
  'glitch',
  'cinematic-fade',
  'iris-pulse',
  'squeeze-h',
  'squeeze-v',
  'cover-down',
  'cover-up',
  'reveal-left',
];

async function ensureExists(p: string): Promise<boolean> {
  try {
    const info = await stat(p);
    return info.isFile() && info.size > 1024;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const sourceDir = path.join(cwd, 'generated-media', 'long-videos', 'saga-real-smoke-1778140938854', 'segments');
  const seg1 = path.join(sourceDir, '001.mp4');
  const seg2 = path.join(sourceDir, '002.mp4');
  if (!(await ensureExists(seg1)) || !(await ensureExists(seg2))) {
    console.error(`source segments missing under ${sourceDir}`);
    process.exitCode = 1;
    return;
  }

  const results: Array<{ kind: SagaTransitionKind; ok: boolean; encoder?: string; durationS?: number; error?: string }> = [];

  for (const kind of TRANSITIONS) {
    const projectId = `saga-trans-${kind.replace(/[^a-z0-9-]/gi, '-')}`;
    const projectDir = path.join(cwd, 'generated-media', 'long-videos', '_transition-matrix', projectId);
    const hyperframesProjectDir = path.join(projectDir, 'hyperframes');
    const outputPath = path.join(projectDir, 'final.mp4');
    await rm(projectDir, { recursive: true, force: true });
    await mkdir(path.join(hyperframesProjectDir, 'media', 'segments'), { recursive: true });
    const segments: SagaSegmentInput[] = [
      {
        index: 1,
        title: 'A',
        duration: 8,
        storyBeat: '',
        visualPrompt: '',
        camera: '',
        continuity: '',
        transition: '',
        prompt: '',
        outputPath: seg1,
        mediaPath: path.join(hyperframesProjectDir, 'media', 'segments', '001.mp4'),
      },
      {
        index: 2,
        title: 'B',
        duration: 8,
        storyBeat: '',
        visualPrompt: '',
        camera: '',
        continuity: '',
        transition: '',
        prompt: '',
        outputPath: seg2,
        mediaPath: path.join(hyperframesProjectDir, 'media', 'segments', '002.mp4'),
      },
    ];
    await copyFile(seg1, segments[0]!.mediaPath);
    await copyFile(seg2, segments[1]!.mediaPath);

    const transitions = [planTransition(kind)];
    try {
      const result = await renderSagaProject({
        projectId,
        ratio: '9:16',
        fps: 30,
        segments,
        transitions,
        hyperframesProjectDir,
        outputPath,
        workDir: projectDir,
        identityCard: '[test]',
        bible: '',
        hasAudio: false,
        colorMatch: false,
        encode: { quality: 'draft', gpu: 'auto' },
      });
      results.push({
        kind,
        ok: result.ok,
        encoder: result.encoderUsed,
        durationS: result.durationSeconds,
      });
    } catch (error) {
      results.push({ kind, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log(`Transition matrix: ${ok.length}/${results.length} passed`);
  for (const r of failed) {
    console.log(`  ✗ ${r.kind}: ${r.error}`);
  }
  for (const r of ok) {
    console.log(`  ✓ ${r.kind} (${r.durationS?.toFixed(2)}s, ${r.encoder})`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
