/**
 * Images the model can see: files the user attached to a message
 * (`artemis execute --image <path>`) and images the agent looks at while it
 * works (the `view_image` tool: screenshots, generated pictures, uploads it
 * found in the workspace).
 *
 * User attachments ride on the first provider request of the run; images the
 * agent views ride on the request right after the tool call. Viewed images are
 * held in a queue owned by one run (see ViewedImageQueue), so nothing outlives
 * the run or reaches another session. Models that cannot see images never get
 * them: the tool fails and `--image` is rejected instead.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ImageAttachment, ImageMediaType } from '../providers/types.js';

/**
 * Raw bytes per image. Base64 grows the data by a third, and Anthropic rejects
 * an image whose base64 exceeds 5 MB, so 3.75 MB raw is the largest image every
 * supported provider accepts.
 */
export const MAX_IMAGE_BYTES = (5 * 1024 * 1024 * 3) / 4;
/** Images attached to one request at most. */
export const MAX_IMAGES_PER_REQUEST = 8;
/**
 * Raw image bytes attached to one request at most (about 20 MB once base64
 * encoded), well under the request-size caps of the providers (Anthropic 32 MB).
 */
export const MAX_REQUEST_IMAGE_BYTES = 15 * 1024 * 1024;

export class ImageInputError extends Error {}

/**
 * Every image format some consumer here accepts, identified from the file's
 * first bytes (extensions lie). Models see only ImageMediaType; image
 * generation references (Seedream) also take BMP, TIFF and HEIC/HEIF.
 */
export type SniffedImageType = ImageMediaType | 'image/bmp' | 'image/tiff' | 'image/heic' | 'image/heif';

/** BITMAPCOREHEADER, BITMAPINFOHEADER, V2, V3, V4 and V5 header sizes. */
const BMP_DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 108, 124]);

export function sniffAnyImageType(bytes: Uint8Array): SniffedImageType | undefined {
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
  if (b.length >= 18 && b[0] === 0x42 && b[1] === 0x4d) {
    // "BM" alone is too weak (any text file may start with it): also require a
    // plausible file size and a known DIB header size.
    const fileSize = (b[2]! | (b[3]! << 8) | (b[4]! << 16) | (b[5]! << 24)) >>> 0;
    const dibHeaderSize = (b[14]! | (b[15]! << 8) | (b[16]! << 16) | (b[17]! << 24)) >>> 0;
    if (fileSize >= 26 && BMP_DIB_HEADER_SIZES.has(dibHeaderSize)) return 'image/bmp';
  }
  if (
    b.length >= 4 &&
    ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
  ) {
    return 'image/tiff';
  }
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return 'image/heic';
    if (/^(mif1|msf1|heif)$/.test(brand)) return 'image/heif';
  }
  return undefined;
}

const MODEL_IMAGE_TYPES: ReadonlySet<SniffedImageType> = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The image type from the file's first bytes, limited to the formats models accept. */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | undefined {
  const type = sniffAnyImageType(bytes);
  return type && MODEL_IMAGE_TYPES.has(type) ? (type as ImageMediaType) : undefined;
}

/** Decoded size of an attachment, from its base64 length. */
export function imageByteSize(image: ImageAttachment): number {
  const data = image.data;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2).replace(/\.?0+$/, '')} MB`;
}

/**
 * Reads an image for the model. `absolutePath` must already be resolved (and,
 * for agent tools, checked against the workspace); `displayPath` is what error
 * messages and the label show. Throws ImageInputError with a reason the model
 * or user can act on.
 */
export async function loadImageFile(absolutePath: string, displayPath: string): Promise<ImageAttachment> {
  let size: number;
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new ImageInputError(`${displayPath} is not a file`);
    size = info.size;
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    throw new ImageInputError(`cannot read ${displayPath}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  if (size > MAX_IMAGE_BYTES) {
    throw new ImageInputError(`${displayPath} is ${formatMegabytes(size)}; images up to ${formatMegabytes(MAX_IMAGE_BYTES)} can be sent to the model (make a smaller copy first)`);
  }
  const bytes = await readFile(absolutePath);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ImageInputError(`${displayPath} is ${formatMegabytes(bytes.length)}; images up to ${formatMegabytes(MAX_IMAGE_BYTES)} can be sent to the model (make a smaller copy first)`);
  }
  const mediaType = sniffImageType(bytes);
  if (!mediaType) throw new ImageInputError(`${displayPath} is not a PNG, JPEG, GIF or WebP image`);
  return { data: bytes.toString('base64'), mediaType, label: `Image: ${displayPath}` };
}

/** Reads an image named relative to `cwd`, with no workspace restriction (the user named it on the command line). */
export async function loadImageForModel(filePath: string, cwd: string): Promise<ImageAttachment> {
  const absolute = path.resolve(cwd, filePath);
  return loadImageFile(absolute, path.relative(cwd, absolute) || path.basename(absolute));
}

/**
 * Loads the images a user attached to a prompt (`--image`). Fails before the
 * run starts when the model cannot see images or the images do not fit in one
 * request, because the user expects every one of them to be seen.
 */
export async function loadPromptImages(
  paths: readonly string[],
  cwd: string,
  model: { supportsImages?: boolean; name?: string },
): Promise<ImageAttachment[]> {
  if (paths.length === 0) return [];
  if (model.supportsImages !== true) {
    throw new ImageInputError(
      `The model${model.name ? ` ${model.name}` : ''} cannot see images, so --image cannot be used with it. ` +
        'Use a vision model, or set "supportsImages": true on its provider profile if it does accept images.',
    );
  }
  if (paths.length > MAX_IMAGES_PER_REQUEST) {
    throw new ImageInputError(`At most ${MAX_IMAGES_PER_REQUEST} images per message (got ${paths.length})`);
  }
  const images = await Promise.all(paths.map((p) => loadImageForModel(p, cwd)));
  const total = images.reduce((sum, image) => sum + imageByteSize(image), 0);
  if (total > MAX_REQUEST_IMAGE_BYTES) {
    throw new ImageInputError(`The images add up to ${formatMegabytes(total)}; at most ${formatMegabytes(MAX_REQUEST_IMAGE_BYTES)} can go with one message`);
  }
  return images;
}

/**
 * Keeps the newest images that fit in one request (count and total bytes).
 * Returns what was kept, in the original order, and what was left out.
 */
export function fitImagesToRequest(images: readonly ImageAttachment[]): { kept: ImageAttachment[]; dropped: ImageAttachment[] } {
  const kept: ImageAttachment[] = [];
  const dropped: ImageAttachment[] = [];
  let bytes = 0;
  for (let i = images.length - 1; i >= 0; i -= 1) {
    const image = images[i]!;
    const size = imageByteSize(image);
    if (kept.length < MAX_IMAGES_PER_REQUEST && bytes + size <= MAX_REQUEST_IMAGE_BYTES) {
      kept.unshift(image);
      bytes += size;
    } else {
      dropped.unshift(image);
    }
  }
  return { kept, dropped };
}

/**
 * Images one agent run queued with view_image, until the next provider request
 * of that run takes them. Each run creates its own queue, so images never
 * outlive the run or reach another run, session or sub-agent.
 */
export class ViewedImageQueue {
  private images: ImageAttachment[] = [];
  /**
   * Whether the model the run is talking to can see images. The run sets it
   * every turn; view_image fails while it is false.
   */
  acceptsImages = true;

  /**
   * Queues an image for the next request. When the queue would exceed the
   * per-request count or byte budget, the oldest queued images are dropped and
   * returned so the caller can say so.
   */
  add(image: ImageAttachment): ImageAttachment[] {
    const { kept, dropped } = fitImagesToRequest([...this.images, image]);
    this.images = kept;
    return dropped;
  }

  /** Removes and returns everything queued. */
  take(): ImageAttachment[] {
    const images = this.images;
    this.images = [];
    return images;
  }

  get size(): number {
    return this.images.length;
  }
}
