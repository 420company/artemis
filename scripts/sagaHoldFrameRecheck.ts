#!/usr/bin/env tsx
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
  const sourceDir = path.join(cwd, 'generated-media', 'long-videos', 'saga-hf-1778150504289', 'segments');
  const seg1 = path.join(sourceDir, '001.mp4');
  const seg2 = path.join(sourceDir, '002.mp4');
  const seg3 = path.join(sourceDir, '003.mp4');
  if (!(await ensureExists(seg1)) || !(await ensureExists(seg2)) || !(await ensureExists(seg3))) {
    console.error('source segments missing');
    process.exitCode = 1;
    return;
  }

  const projectId = 'saga-hf-recheck';
  const projectDir = path.join(cwd, 'generated-media', 'long-videos', projectId);
  const hyperframesProjectDir = path.join(projectDir, 'hyperframes');
  const outputPath = path.join(projectDir, 'final.mp4');
  await rm(projectDir, { recursive: true, force: true });
  await mkdir(path.join(hyperframesProjectDir, 'media', 'segments'), { recursive: true });

  const segments: SagaSegmentInput[] = [seg1, seg2, seg3].map((src, i): SagaSegmentInput => ({
    index: i + 1,
    title: `Recheck ${i + 1}`,
    duration: 5,
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

  const transitions = [planTransition('light-leak', 500), planTransition('crossfade', 500)];

  const result = await renderSagaProject({
    projectId,
    ratio: '9:16',
    fps: 30,
    segments,
    transitions,
    hyperframesProjectDir,
    outputPath,
    workDir: projectDir,
    identityCard: '[recheck]',
    bible: '',
    hasAudio: true,
    colorMatch: false,
    encode: { quality: 'standard', gpu: 'auto' },
  });

  console.log(JSON.stringify({
    ok: result.ok,
    reportedDurationSeconds: result.durationSeconds,
    encoderUsed: result.encoderUsed,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
