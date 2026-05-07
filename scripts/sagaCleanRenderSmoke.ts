#!/usr/bin/env tsx
// Verify the v3 trim + loudnorm + tuned-transition pipeline against the
// existing saga-v2 segments (which actually have audio). Compares with the
// previous run's "flashback" mismatch.

import path from 'node:path';
import { stat, mkdir, copyFile, rm } from 'node:fs/promises';
import { renderSagaProject } from '../src/tools/visual/sagaRenderer/index.js';
import { planTransition } from '../src/tools/visual/sagaRenderer/transitions.js';
import type { SagaSegmentInput } from '../src/tools/visual/sagaRenderer/types.js';

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
  const sourceDir = path.join(cwd, 'generated-media', 'long-videos', 'saga-v2-1778145970855', 'segments');
  const seg1 = path.join(sourceDir, '001.mp4');
  const seg2 = path.join(sourceDir, '002.mp4');
  const seg3 = path.join(sourceDir, '003.mp4');
  if (!(await ensureExists(seg1)) || !(await ensureExists(seg2)) || !(await ensureExists(seg3))) {
    console.error(`source segments missing under ${sourceDir}`);
    process.exitCode = 1;
    return;
  }

  const projectId = 'saga-clean-render-smoke';
  const projectDir = path.join(cwd, 'generated-media', 'long-videos', projectId);
  const hyperframesProjectDir = path.join(projectDir, 'hyperframes');
  const outputPath = path.join(projectDir, 'final.mp4');
  await rm(projectDir, { recursive: true, force: true });
  await mkdir(path.join(hyperframesProjectDir, 'media', 'segments'), { recursive: true });

  const segments: SagaSegmentInput[] = [seg1, seg2, seg3].map((src, i): SagaSegmentInput => ({
    index: i + 1,
    title: `Smoke ${i + 1}`,
    duration: 8,
    storyBeat: '',
    visualPrompt: '',
    camera: '',
    continuity: '',
    transition: '',
    prompt: '',
    textOnlyPrompt: '',
    outputPath: src,
    mediaPath: path.join(hyperframesProjectDir, 'media', 'segments', `${String(i + 1).padStart(3, '0')}.mp4`),
  }));
  for (const segment of segments) {
    await copyFile(segment.outputPath, segment.mediaPath);
  }

  const transitions = [planTransition('match-cut', 400), planTransition('speed-ramp', 400)];

  const result = await renderSagaProject({
    projectId,
    ratio: '9:16',
    fps: 30,
    segments,
    transitions,
    hyperframesProjectDir,
    outputPath,
    workDir: projectDir,
    identityCard: '[smoke]',
    bible: '',
    hasAudio: true,
    colorMatch: true,
    encode: { quality: 'standard', gpu: 'auto' },
  });

  console.log(JSON.stringify({
    ok: result.ok,
    outputPath: result.outputPath,
    durationSeconds: result.durationSeconds,
    encoderUsed: result.encoderUsed,
    appliedTransitions: result.appliedTransitions,
    lint: result.diagnostics.lint,
    inspectSegmentCount: result.diagnostics.inspect.segmentCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
