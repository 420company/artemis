/**
 * tools/office/images.ts — pictures for slides and documents.
 *
 * Reads the size and type of a PNG, JPEG or GIF from its header (no image
 * library), and turns other formats (WebP, BMP, TIFF) into PNG with
 * ImageMagick when it is installed, since Office files cannot carry them
 * reliably. A picture that cannot be used becomes a warning, never a failed
 * file: the slide gets a placeholder instead.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LoadedImage {
  data: Buffer;
  type: 'png' | 'jpg' | 'gif';
  width: number;
  height: number;
}

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

async function convertToPng(file: string): Promise<Buffer | undefined> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artemis-office-img-'));
  const out = path.join(dir, 'image.png');
  try {
    for (const [bin, args] of [['magick', [file + '[0]', out]], ['convert', [file + '[0]', out]]] as const) {
      try {
        await execFileAsync(bin, [...args], { timeout: 30_000 });
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

/** The picture at `requested` (relative to cwd), or a reason it cannot be used. */
export async function loadImage(requested: string, cwd: string): Promise<LoadedImage | { error: string }> {
  if (/^https?:\/\//i.test(requested)) return { error: `image ${requested}: download it into the workspace first and pass the file path` };
  const file = path.resolve(cwd, requested.replace(/^file:\/\//, ''));
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return { error: `image ${requested}: not a file` };
    size = info.size;
  } catch {
    return { error: `image ${requested}: file not found` };
  }
  if (size > MAX_IMAGE_BYTES) return { error: `image ${requested}: larger than 30 MB` };
  let data: Buffer = await readFile(file);
  let info = imageInfo(data);
  if (!info) {
    const converted = await convertToPng(file);
    if (converted) {
      data = converted;
      info = imageInfo(data);
    }
  }
  if (!info || info.width <= 0 || info.height <= 0) return { error: `image ${requested}: use a PNG, JPEG or GIF` };
  return { data, ...info };
}

/** The crop (fractions of each side) that makes an image cover a box of aspect `boxAspect` (w/h). */
export function coverCrop(width: number, height: number, boxAspect: number): { left: number; right: number; top: number; bottom: number } {
  const aspect = width / height;
  if (aspect > boxAspect) {
    const keep = boxAspect / aspect;
    const side = (1 - keep) / 2;
    return { left: side, right: side, top: 0, bottom: 0 };
  }
  const keep = aspect / boxAspect;
  const side = (1 - keep) / 2;
  return { left: 0, right: 0, top: side, bottom: side };
}
