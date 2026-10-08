/**
 * Images the model can see: files the user attached to a message
 * (`artemis execute --image <path>`) and images the agent looks at while it
 * works (the `view_image` tool: screenshots, generated pictures, uploads it
 * found in the workspace).
 *
 * Attachments ride on the next provider request of the run, the same way
 * the interactive chat sends pasted images. Providers that cannot take
 * images never get them.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ImageAttachment, ImageMediaType } from '../providers/types.js';

/** Base64 grows the bytes by a third; providers cap requests near 20 MB. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Images attached to one request at most. */
export const MAX_IMAGES_PER_REQUEST = 8;

export class ImageInputError extends Error {}

/** The image type from the file's first bytes (extensions lie). */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

/** Reads an image for the model. Throws ImageInputError with a reason the model or user can act on. */
export async function loadImageForModel(filePath: string, cwd: string): Promise<ImageAttachment> {
  const absolute = path.resolve(cwd, filePath);
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new ImageInputError(`${filePath} is not a file`);
    size = info.size;
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    throw new ImageInputError(`cannot read ${filePath}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  if (size > MAX_IMAGE_BYTES) {
    throw new ImageInputError(`${filePath} is ${(size / 1024 / 1024).toFixed(1)} MB; images up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB can be viewed (make a smaller copy first)`);
  }
  const bytes = await readFile(absolute);
  const mediaType = sniffImageType(bytes);
  if (!mediaType) throw new ImageInputError(`${filePath} is not a PNG, JPEG, GIF or WebP image`);
  return { data: bytes.toString('base64'), mediaType, label: `Image: ${path.relative(cwd, absolute) || path.basename(absolute)}` };
}

/** Images a run queued with view_image, by session, until the next provider request takes them. */
const queued = new Map<string, ImageAttachment[]>();

export function queueImage(sessionId: string, image: ImageAttachment): number {
  const list = queued.get(sessionId) ?? [];
  list.push(image);
  // Keep the newest few: older ones the model already chose to look past.
  while (list.length > MAX_IMAGES_PER_REQUEST) list.shift();
  queued.set(sessionId, list);
  return list.length;
}

export function takeQueuedImages(sessionId: string): ImageAttachment[] {
  const list = queued.get(sessionId) ?? [];
  queued.delete(sessionId);
  return list;
}
