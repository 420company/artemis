#!/usr/bin/env tsx
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderSagaShaderTransition, closeSagaShaderBrowser } from '../src/tools/visual/sagaRenderer/shaderTransitions/index.js';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const cwd = process.cwd();
  const sourceDir = path.join(cwd, 'generated-media', 'long-videos', 'saga-hf-1778150504289', 'segments');
  const seg1 = path.join(sourceDir, '001.mp4');
  const seg2 = path.join(sourceDir, '002.mp4');

  const tmpDir = path.join(cwd, 'generated-media', 'long-videos', '_shader-debug');
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  const lastFramePath = path.join(tmpDir, 'last.png');
  const firstFramePath = path.join(tmpDir, 'first.png');
  await execFileAsync('ffmpeg', ['-y', '-sseof', '-0.1', '-i', seg1, '-update', '1', '-frames:v', '1', '-q:v', '2', lastFramePath]);
  await execFileAsync('ffmpeg', ['-y', '-i', seg2, '-frames:v', '1', '-q:v', '2', firstFramePath]);
  console.log('Frames extracted to', tmpDir);

  console.log('Calling renderSagaShaderTransition...');
  const result = await renderSagaShaderTransition({
    shader: 'shader-light-leak',
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 0.6,
    imageAPath: lastFramePath,
    imageBPath: firstFramePath,
    outputDir: path.join(tmpDir, 'render'),
  });
  console.log('Result:', JSON.stringify(result, null, 2));
  await closeSagaShaderBrowser();
}

main().catch((error) => {
  console.error('TOP-LEVEL ERROR:', error);
  process.exitCode = 1;
});
