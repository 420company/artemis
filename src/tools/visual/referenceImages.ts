// Reference images for generate_image (Seedream image-to-image / multi-image
// reference). The ModelArk images API takes them in the `image` field as a
// single string or an array, each an http(s) URL or a base64 data URI of the
// form `data:image/<lowercase format>;base64,<data>`. Seedream 4.x/5.x accept
// up to 14 references, and references plus generated images must not exceed
// 15. Local files are read from the workspace, checked to really be images,
// size-capped, and inlined as data URIs.

import { readFile, stat } from 'node:fs/promises';
import { sniffAnyImageType } from '../../core/imageInput.js';
import { ensureNotSensitivePath } from '../../utils/fs.js';
import { resolveToolPathWithWorkspaceAccess } from '../workspaceAccess.js';
import type { ToolExecutionContext } from '../types.js';

/** Seedream 4.x/5.x: at most 14 reference images per request. */
export const MAX_REFERENCE_IMAGES = 14;
/** Seedream: at most 15 images in and out of one request. */
export const MAX_REFERENCE_PLUS_OUTPUT_IMAGES = 15;
/** Per-image cap, matching the provider's 10 MB input limit. */
export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
/**
 * Total cap for inlined files. Base64 grows data by 4/3, so 15 MiB of files
 * is about 20 MiB of JSON, which stays under the platform gateway's 25 MiB
 * request body limit.
 */
export const MAX_TOTAL_REFERENCE_BYTES = 15 * 1024 * 1024;

export class ReferenceImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceImageError';
  }
}

/** Accepts an array, a JSON-stringified array, or a single string; trims, drops empties, de-duplicates. */
export function normalizeReferenceImagesArg(raw: unknown): string[] {
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        value = [trimmed];
      }
    } else {
      value = [trimmed];
    }
  }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const item = entry.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function isRemoteImageReference(entry: string): boolean {
  return /^https?:\/\//i.test(entry);
}

/**
 * Identifies an image by its leading bytes (the shared sniffer in
 * core/imageInput.ts). Returns the data-URI media type, or undefined when it
 * is not a format Seedream accepts.
 */
export function sniffImageMimeType(buf: Uint8Array): string | undefined {
  return sniffAnyImageType(buf);
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Turns the model's `referenceImages` entries into values for the provider's
 * `image` field. Paths are resolved like read_file (workspace containment and
 * the protected-path check); URLs pass through for the provider to fetch.
 */
export async function resolveReferenceImages(
  raw: unknown,
  context: ToolExecutionContext,
  options: { outputCount?: number } = {},
): Promise<string[]> {
  const entries = normalizeReferenceImagesArg(raw);
  if (entries.length === 0) return [];
  if (entries.length > MAX_REFERENCE_IMAGES) {
    throw new ReferenceImageError(
      `referenceImages has ${entries.length} entries; the image API accepts at most ${MAX_REFERENCE_IMAGES}. Pick the most relevant ones.`,
    );
  }
  const outputCount = Math.max(1, options.outputCount ?? 1);
  if (entries.length + outputCount > MAX_REFERENCE_PLUS_OUTPUT_IMAGES) {
    throw new ReferenceImageError(
      `${entries.length} reference image(s) plus ${outputCount} output image(s) exceeds the image API limit of ${MAX_REFERENCE_PLUS_OUTPUT_IMAGES} per request. Use fewer references or a lower count.`,
    );
  }

  const resolved: string[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (isRemoteImageReference(entry)) {
      resolved.push(entry);
      continue;
    }
    if (/^data:/i.test(entry) || /^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      throw new ReferenceImageError(
        `referenceImages entry "${entry.slice(0, 60)}" is not supported: use a workspace file path or an http(s) URL.`,
      );
    }

    const { absolute } = await resolveToolPathWithWorkspaceAccess({
      inputPath: entry,
      toolName: 'generate_image',
      context,
    });
    if (context.permissionMode !== 'full-access') {
      ensureNotSensitivePath(absolute, entry);
    }

    const { dataUri, size } = await readReferenceImageAsDataUri(absolute, entry, totalBytes);
    totalBytes += size;
    resolved.push(dataUri);
  }
  return resolved;
}

/**
 * Reads one local reference image as a data URI, with the same checks for
 * every caller: a regular file, under the per-image cap, the running total
 * under the total cap, and really an image Seedream accepts.
 */
async function readReferenceImageAsDataUri(
  absolute: string,
  label: string,
  bytesSoFar: number,
): Promise<{ dataUri: string; size: number }> {
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new ReferenceImageError(`Reference image ${label} is not a file.`);
    }
    size = info.size;
  } catch (error) {
    if (error instanceof ReferenceImageError) throw error;
    throw new ReferenceImageError(`Reference image not found: ${label}`);
  }
  if (size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new ReferenceImageError(
      `Reference image ${label} is ${formatMiB(size)}; the limit is ${formatMiB(MAX_REFERENCE_IMAGE_BYTES)} per image. Resize or compress it first.`,
    );
  }
  if (bytesSoFar + size > MAX_TOTAL_REFERENCE_BYTES) {
    throw new ReferenceImageError(
      `Reference images total more than ${formatMiB(MAX_TOTAL_REFERENCE_BYTES)}; use fewer or smaller images.`,
    );
  }
  const buf = await readFile(absolute);
  const mimeType = sniffImageMimeType(buf);
  if (!mimeType) {
    throw new ReferenceImageError(
      `Reference image ${label} is not a supported image (PNG, JPEG, WebP, GIF, BMP, TIFF or HEIC/HEIF).`,
    );
  }
  return { dataUri: `data:${mimeType};base64,${buf.toString('base64')}`, size };
}

/**
 * Data URIs for local images the pipeline itself produced or already
 * resolved (Saga's turnaround sheets, previous-segment frames, user
 * references resolved by generate_long_video). They are absolute paths under
 * the project directory, so no workspace lookup applies; every other check of
 * resolveReferenceImages does.
 */
export async function localImagesToReferenceDataUris(absolutePaths: readonly string[]): Promise<string[]> {
  if (absolutePaths.length > MAX_REFERENCE_IMAGES) {
    throw new ReferenceImageError(
      `${absolutePaths.length} reference images; the image API accepts at most ${MAX_REFERENCE_IMAGES}.`,
    );
  }
  const out: string[] = [];
  let totalBytes = 0;
  for (const absolute of absolutePaths) {
    const { dataUri, size } = await readReferenceImageAsDataUri(absolute, absolute, totalBytes);
    totalBytes += size;
    out.push(dataUri);
  }
  return out;
}

/**
 * How many reference images a ModelArk image model accepts: Seedream 3.0
 * text-to-image takes none, SeedEdit 3.0 image-to-image takes one, and
 * Seedream 4.x/5.x take up to 14.
 */
export function bytePlusImageModelReferenceLimit(model: string): number {
  const id = model.toLowerCase();
  if (/t2i/.test(id)) return 0;
  if (/seededit|i2i/.test(id)) return 1;
  return MAX_REFERENCE_IMAGES;
}

/** Returns an error message when `model` cannot take `count` reference images, otherwise undefined. */
export function checkBytePlusReferenceSupport(model: string, count: number): string | undefined {
  if (count === 0) return undefined;
  const limit = bytePlusImageModelReferenceLimit(model);
  if (limit === 0) {
    return `image model ${model} is text-to-image only and does not accept referenceImages. Use a Seedream 4.x/5.x model, or omit referenceImages.`;
  }
  if (count > limit) {
    return `image model ${model} accepts at most ${limit} reference image(s); got ${count}.`;
  }
  return undefined;
}
