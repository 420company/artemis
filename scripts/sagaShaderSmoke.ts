#!/usr/bin/env tsx
// Verify the Phase B Saga shader transition pipeline end-to-end against
// already-generated segments. Tests all 4 shader kinds through Playwright +
// GLSL + FFmpeg concat splice. No BytePlus API time required.

import path from 'node:path';
import { stat, mkdir, copyFile, rm } from 'node:fs/promises';
import { renderSagaProject } from '../src/tools/visual/sagaRenderer/index.js';
import { planTransition } from '../src/tools/visual/sagaRenderer/transitions.js';
import { closeSagaShaderBrowser } from '../src/tools/visual/sagaRenderer/shaderTransitions/index.js';
import type { SagaSegmentInput, SagaTransitionKind } from '../src/tools/visual/sagaRenderer/types.js';

const SHADER_KINDS: SagaTransitionKind[] = [
  'shader-light-leak',
  'shader-whip-pan',
  'shader-glitch',
  'shader-cinematic-zoom',
  'shader-domain-warp',
  'shader-ridged-burn',
  'shader-sdf-iris',
  'shader-ripple-waves',
  'shader-gravitational-lens',
  'shader-chromatic-split',
  'shader-swirl-vortex',
  'shader-thermal-distortion',
  'shader-flash-through-white',
  'shader-cross-warp-morph',
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
  const sourceDir = path.join(cwd, 'generated-media', 'long-videos', 'saga-hf-1778150504289', 'segments');
  const seg1 = path.join(sourceDir, '001.mp4');
  const seg2 = path.join(sourceDir, '002.mp4');
  if (!(await ensureExists(seg1)) || !(await ensureExists(seg2))) {
    console.error(`source segments missing under ${sourceDir}`);
    process.exitCode = 1;
    return;
  }

  const results: Array<{ kind: SagaTransitionKind; ok: boolean; durationS?: number; outputPath?: string; error?: string }> = [];

  for (const kind of SHADER_KINDS) {
    const projectId = `saga-shader-${kind.replace(/[^a-z0-9-]/g, '-')}`;
    const projectDir = path.join(cwd, 'generated-media', 'long-videos', '_shader-matrix', projectId);
    const hyperframesProjectDir = path.join(projectDir, 'hyperframes');
    const outputPath = path.join(projectDir, 'final.mp4');
    await rm(projectDir, { recursive: true, force: true });
    await mkdir(path.join(hyperframesProjectDir, 'media', 'segments'), { recursive: true });

    const segments: SagaSegmentInput[] = [seg1, seg2].map((src, i): SagaSegmentInput => ({
      index: i + 1,
      title: `Shader smoke ${i + 1}`,
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
        identityCard: '[shader-smoke]',
        bible: '',
        hasAudio: true,
        colorMatch: false,
        encode: { quality: 'standard', gpu: 'auto' },
      });
      results.push({ kind, ok: result.ok, durationS: result.durationSeconds, outputPath: result.outputPath });
    } catch (error) {
      results.push({ kind, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  await closeSagaShaderBrowser();

  console.log(`\nSaga shader matrix: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  for (const r of results) {
    if (r.ok) console.log(`  ✓ ${r.kind} (${r.durationS?.toFixed(2)}s) → ${r.outputPath}`);
    else console.log(`  ✗ ${r.kind}: ${r.error}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
