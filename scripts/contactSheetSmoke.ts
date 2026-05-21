import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { buildEnsembleContactSheet, computeGridDimensions } from '../src/tools/visual/contactSheet.js';
import { resolveFfmpegBinaryPath, resolveFfprobeBinaryPath } from '../src/tools/visual/sagaRenderer/concat.js';

const execFileAsync = promisify(execFile);

async function makeTestImage(dir: string, name: string, color: string): Promise<string> {
  const out = path.join(dir, name);
  const ffmpeg = await resolveFfmpegBinaryPath();
  await execFileAsync(ffmpeg, [
    '-f', 'lavfi', '-i', `color=c=${color}:s=512x512:d=1`,
    '-frames:v', '1', '-y', out,
  ]);
  return out;
}

async function probeImageDimensions(file: string): Promise<{ w: number; h: number }> {
  const ffprobe = await resolveFfprobeBinaryPath();
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x',
    file,
  ]);
  const [w, h] = stdout.trim().split('x').map(Number);
  return { w, h };
}

async function main(): Promise<void> {
  assert.deepEqual(computeGridDimensions(1), { cols: 1, rows: 1 });
  assert.deepEqual(computeGridDimensions(2), { cols: 2, rows: 1 });
  assert.deepEqual(computeGridDimensions(3), { cols: 2, rows: 2 });
  assert.deepEqual(computeGridDimensions(4), { cols: 2, rows: 2 });
  assert.deepEqual(computeGridDimensions(5), { cols: 3, rows: 2 });
  assert.deepEqual(computeGridDimensions(6), { cols: 3, rows: 2 });
  assert.deepEqual(computeGridDimensions(7), { cols: 3, rows: 3 });
  assert.deepEqual(computeGridDimensions(9), { cols: 3, rows: 3 });
  assert.deepEqual(computeGridDimensions(10), { cols: 4, rows: 3 });

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'contact-sheet-smoke-'));
  try {
    const colors = ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'orange'];
    const allImages: string[] = [];
    for (let i = 0; i < colors.length; i++) {
      allImages.push(await makeTestImage(tmpRoot, `in-${i + 1}.png`, colors[i]));
    }

    // 1 input -> pass-through, no actual sheet rendered
    const singleSheet = path.join(tmpRoot, 'sheet-1.png');
    const r1 = await buildEnsembleContactSheet({ imagePaths: [allImages[0]], outputPath: singleSheet });
    assert.equal(r1.ok, true);
    if (r1.ok) {
      assert.equal(r1.isPassThrough, true);
      assert.equal(r1.path, allImages[0], 'single input should return original path');
      assert.deepEqual(r1.grid, { cols: 1, rows: 1 });
    }

    // Each N from 2..7: real sheet at cols*tile × rows*tile
    const tileMaxSide = 256;
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const sheetPath = path.join(tmpRoot, `sheet-${n}.png`);
      const result = await buildEnsembleContactSheet({
        imagePaths: allImages.slice(0, n),
        outputPath: sheetPath,
        tileMaxSide,
      });
      assert.equal(result.ok, true, `N=${n} sheet build failed`);
      if (!result.ok) continue;
      assert.equal(result.isPassThrough, false);
      assert.equal(result.path, sheetPath);
      assert.equal(result.inputCount, n);
      const expectedGrid = computeGridDimensions(n);
      assert.deepEqual(result.grid, expectedGrid, `N=${n} grid mismatch`);

      const info = await stat(sheetPath);
      assert.ok(info.size > 0, `N=${n} sheet file empty`);

      const dims = await probeImageDimensions(sheetPath);
      assert.equal(dims.w, expectedGrid.cols * tileMaxSide, `N=${n} width mismatch`);
      assert.equal(dims.h, expectedGrid.rows * tileMaxSide, `N=${n} height mismatch`);
    }

    console.log('contact sheet smoke ok');
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
