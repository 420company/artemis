/**
 * tools/office/images.ts — pictures for slides and documents.
 *
 * Reads the size and type of a PNG, JPEG or GIF from its header (no image
 * library), and turns WebP, BMP and TIFF into PNG with ImageMagick when it is
 * installed, since Office files cannot carry them reliably. Anything else is
 * refused before ImageMagick ever sees it (the decoder is named explicitly,
 * so a file cannot pick a different coder by its content). A picture that
 * cannot be used becomes a warning, never a failed file: the slide gets a
 * placeholder instead.
 *
 * Paths go through the same gates as the other file tools
 * (createImageLoader): inside the workspace or the agent's own media folder,
 * anything else only after the workspace trust prompt, never a protected
 * directory, symlinks checked at their real target. URLs are not fetched.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureNotSensitivePath } from '../../utils/fs.js';
import { getMediaOutputRoot } from '../../utils/mediaOutputRoot.js';
import { isPathInsideWorkspace } from '../../utils/workspaceRoots.js';
import type { ToolExecutionContext } from '../types.js';
import { ensureWorkspaceForToolCandidate, resolveAbsoluteToolCandidate } from '../workspaceAccess.js';

const execFileAsync = promisify(execFile);

export interface LoadedImage {
  data: Buffer;
  type: 'png' | 'jpg' | 'gif';
  width: number;
  height: number;
}

/** Reads one picture named in a spec, or says why it cannot be used. */
export type ImageLoader = (requested: string) => Promise<LoadedImage | { error: string }>;

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export function imageInfo(data: Buffer): { type: LoadedImage['type']; width: number; height: number } | undefined {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { type: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 10 && data.toString('ascii', 0, 3) === 'GIF') {
    return { type: 'gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1]!;
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpg', height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  return undefined;
}

/** Formats converted to PNG, identified by their magic bytes; the value is ImageMagick's coder name. */
export function convertibleType(data: Buffer): 'webp' | 'bmp' | 'tiff' | undefined {
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (data.length >= 26 && data.toString('ascii', 0, 2) === 'BM') return 'bmp';
  if (data.length >= 8 && (data.toString('latin1', 0, 4) === 'II*\u0000' || data.toString('latin1', 0, 4) === 'MM\u0000*')) return 'tiff';
  return undefined;
}

async function convertToPng(file: string, coder: 'webp' | 'bmp' | 'tiff'): Promise<Buffer | undefined> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artemis-office-img-'));
  const out = path.join(dir, 'image.png');
  // The input coder is forced ("webp:file"), the first frame only, bounded.
  const args = ['-limit', 'memory', '256MiB', '-limit', 'disk', '512MiB', '-limit', 'time', '30', `${coder}:${file}[0]`, `png:${out}`];
  try {
    for (const bin of ['magick', 'convert']) {
      try {
        await execFileAsync(bin, args, { timeout: 30_000 });
        return await readFile(out);
      } catch {
        // Try the next binary name.
      }
    }
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The picture at an absolute, already-permitted path. */
export async function readImageFile(file: string, label: string): Promise<LoadedImage | { error: string }> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return { error: `image ${label}: not a file` };
    size = info.size;
  } catch {
    return { error: `image ${label}: file not found` };
  }
  if (size > MAX_IMAGE_BYTES) return { error: `image ${label}: larger than 30 MB` };
  let data: Buffer = await readFile(file);
  let info = imageInfo(data);
  if (!info) {
    const coder = convertibleType(data);
    if (!coder) return { error: `image ${label}: use a PNG, JPEG or GIF` };
    const converted = await convertToPng(file, coder);
    if (!converted) return { error: `image ${label}: could not convert it; use a PNG, JPEG or GIF` };
    data = converted;
    info = imageInfo(data);
  }
  if (!info || info.width <= 0 || info.height <= 0) return { error: `image ${label}: use a PNG, JPEG or GIF` };
  return { data, ...info };
}

/**
 * The image loader for one tool call: a path is allowed inside the
 * workspace or the media output folder (where generated pictures go), or
 * elsewhere after the workspace trust prompt (without switching the
 * workspace); never in a protected directory; a symlink is judged by its
 * real target. URLs are refused (download first, through the web tools).
 */
export function createImageLoader(context: ToolExecutionContext, toolName: string): ImageLoader {
  const permitted = async (candidate: string, requested: string): Promise<void> => {
    ensureNotSensitivePath(candidate, requested);
    if (isPathInsideWorkspace(context.cwd, candidate) || isPathInsideWorkspace(getMediaOutputRoot(), candidate)) return;
    await ensureWorkspaceForToolCandidate({ candidatePath: candidate, inputPath: requested, toolName, context, switchNow: false });
  };
  return async (requested) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(requested) && !/^file:\/\//i.test(requested)) {
      return { error: `image ${requested}: links are not fetched; download the picture into the workspace first and pass its path` };
    }
    try {
      const candidate = resolveAbsoluteToolCandidate(requested.replace(/^file:\/\//i, ''), context.cwd, context);
      await permitted(candidate, requested);
      const real = await realpath(candidate).catch(() => candidate);
      if (real !== candidate) await permitted(real, requested);
      return await readImageFile(real, requested);
    } catch (error) {
      return { error: `image ${requested}: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}
