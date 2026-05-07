#!/usr/bin/env tsx
import path from 'node:path';
import { stat } from 'node:fs/promises';
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
  const projectId = 'saga-renderer-only-smoke';
  const projectDir = path.join(cwd, 'generated-media', 'long-videos', projectId);
  const hyperframesProjectDir = path.join(projectDir, 'hyperframes');
  const outputPath = path.join(projectDir, 'final.mp4');

  // Reuse existing segments from the prior real-smoke run.
  const sourceProjectDir = path.join(cwd, 'generated-media', 'long-videos', 'saga-real-smoke-1778140938854');
  const seg1 = path.join(sourceProjectDir, 'segments', '001.mp4');
  const seg2 = path.join(sourceProjectDir, 'segments', '002.mp4');
  if (!(await ensureExists(seg1)) || !(await ensureExists(seg2))) {
    console.error(`source segments missing under ${sourceProjectDir}; run scripts/sagaContinuitySmoke.ts first`);
    process.exitCode = 1;
    return;
  }

  const segments: SagaSegmentInput[] = [
    {
      index: 1,
      title: 'Renderer test seg 1',
      duration: 10,
      storyBeat: 'reuse',
      visualPrompt: 'reuse',
      camera: 'reuse',
      continuity: 'reuse',
      transition: 'reuse',
      prompt: 'reuse',
      outputPath: seg1,
      mediaPath: path.join(hyperframesProjectDir, 'media', 'segments', '001.mp4'),
    },
    {
      index: 2,
      title: 'Renderer test seg 2',
      duration: 10,
      storyBeat: 'reuse',
      visualPrompt: 'reuse',
      camera: 'reuse',
      continuity: 'reuse',
      transition: 'reuse',
      prompt: 'reuse',
      outputPath: seg2,
      mediaPath: path.join(hyperframesProjectDir, 'media', 'segments', '002.mp4'),
    },
  ];

  // Copy segments into the composition media folder so the renderer is
  // self-contained.
  const { mkdir, copyFile } = await import('node:fs/promises');
  await mkdir(path.join(hyperframesProjectDir, 'media', 'segments'), { recursive: true });
  await copyFile(seg1, segments[0]!.mediaPath);
  await copyFile(seg2, segments[1]!.mediaPath);

  const transitions = [planTransition('light-leak', 350)];

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
    bible: 'test',
    hasAudio: false,
    colorMatch: false,
    encode: { quality: 'standard', gpu: 'auto' },
  });

  console.log(JSON.stringify({
    ok: result.ok,
    outputPath: result.outputPath,
    durationSeconds: result.durationSeconds,
    encoderUsed: result.encoderUsed,
    appliedTransitions: result.appliedTransitions,
    lint: {
      errors: result.diagnostics.lint.errors,
      warnings: result.diagnostics.lint.warnings,
      infos: result.diagnostics.lint.infos,
    },
    inspectSegmentCount: result.diagnostics.inspect.segmentCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
