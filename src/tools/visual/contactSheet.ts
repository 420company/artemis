import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveFfmpegBinaryPath } from './sagaRenderer/concat.js';

const execFileAsync = promisify(execFile);

export interface BuildContactSheetOptions {
  imagePaths: string[];
  outputPath: string;
  tileMaxSide?: number;
}

export type ContactSheetResult =
  | {
      ok: true;
      path: string;
      isPassThrough: boolean;
      inputCount: number;
      grid: { cols: number; rows: number };
    }
  | { ok: false; reason: string };

export function computeGridDimensions(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

export async function buildEnsembleContactSheet(options: BuildContactSheetOptions): Promise<ContactSheetResult> {
  const { imagePaths, outputPath, tileMaxSide = 768 } = options;
  if (imagePaths.length === 0) return { ok: false, reason: 'no input images' };

  if (imagePaths.length === 1) {
    return {
      ok: true,
      path: imagePaths[0],
      isPassThrough: true,
      inputCount: 1,
      grid: { cols: 1, rows: 1 },
    };
  }

  const { cols, rows } = computeGridDimensions(imagePaths.length);
  const totalCells = cols * rows;
  const fillerCount = totalCells - imagePaths.length;

  await mkdir(path.dirname(outputPath), { recursive: true });

  const ffmpeg = await resolveFfmpegBinaryPath();

  const inputArgs: string[] = [];
  for (const p of imagePaths) inputArgs.push('-i', p);
  for (let i = 0; i < fillerCount; i++) {
    inputArgs.push('-f', 'lavfi', '-i', `color=c=black:s=${tileMaxSide}x${tileMaxSide}:d=1`);
  }

  const scaleChain: string[] = imagePaths.map(
    (_, i) =>
      `[${i}:v]scale=${tileMaxSide}:${tileMaxSide}:force_original_aspect_ratio=decrease,pad=${tileMaxSide}:${tileMaxSide}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[s${i}]`,
  );
  const fillerChain: string[] = [];
  for (let i = 0; i < fillerCount; i++) {
    const inputIdx = imagePaths.length + i;
    fillerChain.push(`[${inputIdx}:v]scale=${tileMaxSide}:${tileMaxSide},setsar=1[s${inputIdx}]`);
  }

  const refs: string[] = [];
  for (let i = 0; i < totalCells; i++) refs.push(`[s${i}]`);
  const concatStep = `${refs.join('')}concat=n=${totalCells}:v=1:a=0[seq]`;
  const tileStep = `[seq]tile=${cols}x${rows}[out]`;

  const filterComplex = [...scaleChain, ...fillerChain, concatStep, tileStep].join(';');

  const args = [
    ...inputArgs,
    '-filter_complex',
    filterComplex,
    '-map',
    '[out]',
    '-frames:v',
    '1',
    '-y',
    outputPath,
  ];

  try {
    await execFileAsync(ffmpeg, args, { timeout: 60_000 });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  try {
    const info = await stat(outputPath);
    if (!info.isFile() || info.size === 0) {
      return { ok: false, reason: `contact sheet not written (size=${info.size})` };
    }
  } catch (error) {
    return { ok: false, reason: `contact sheet missing: ${error instanceof Error ? error.message : String(error)}` };
  }

  return {
    ok: true,
    path: outputPath,
    isPassThrough: false,
    inputCount: imagePaths.length,
    grid: { cols, rows },
  };
}
