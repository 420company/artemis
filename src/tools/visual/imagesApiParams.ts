// Request parameters for image models that take the OpenAI Images API shape
// (ids matched by isImagesApiImageModel) when they are configured on the
// ModelArk-style image provider, as a hosted server's image model is: the
// platform gateway forwards /images/generations and /images/edits to such a
// model's upstream. ModelArk models keep their own request shape.
//
// The Images API takes a fixed set of sizes ("1024x1024", "1536x1024",
// "1024x1536" or "auto"), a quality of low / medium / high / auto, `n`,
// `output_format`, `output_compression` and `background`, and always answers
// in base64 (`b64_json`); input images go to /images/edits as multipart
// files ("image[]").

/** Whether an image model id takes the Images API request shape. */
export function isImagesApiImageModel(model: string | undefined): boolean {
  return /(^|[/:])gpt-image/i.test((model ?? '').trim());
}

export type ImagesApiSize = '1024x1024' | '1536x1024' | '1024x1536' | 'auto';

const SQUARE: ImagesApiSize = '1024x1024';
const LANDSCAPE: ImagesApiSize = '1536x1024';
const PORTRAIT: ImagesApiSize = '1024x1536';

/** Wider or taller than this (width / height) is landscape or portrait. */
const ASPECT_TOLERANCE = 1.15;

function sizeForAspect(width: number, height: number): ImagesApiSize {
  if (!(width > 0 && height > 0)) return 'auto';
  const ratio = width / height;
  if (ratio >= ASPECT_TOLERANCE) return LANDSCAPE;
  if (ratio <= 1 / ASPECT_TOLERANCE) return PORTRAIT;
  return SQUARE;
}

/**
 * The Images API size for whatever the caller asked: one of its sizes as is;
 * "WIDTHxHEIGHT" pixels or a "16:9"-style ratio as the size of the nearest
 * aspect; "landscape" / "portrait" / "square"; and "auto" for a ModelArk
 * tier ("1K" / "2K" / "4K", where the model picks the aspect), anything
 * else, or nothing.
 */
export function imagesApiSize(size: string | undefined): ImagesApiSize {
  const s = (size ?? '').trim().toLowerCase();
  if (s === SQUARE || s === LANDSCAPE || s === PORTRAIT || s === 'auto') return s;
  if (s === 'landscape' || s === 'horizontal' || s === 'wide') return LANDSCAPE;
  if (s === 'portrait' || s === 'vertical' || s === 'tall') return PORTRAIT;
  if (s === 'square') return SQUARE;
  const pixels = /^(\d{2,5})\s*[x*×]\s*(\d{2,5})$/.exec(s);
  if (pixels) return sizeForAspect(Number(pixels[1]), Number(pixels[2]));
  const ratio = /^(\d{1,2}(?:\.\d+)?)\s*:\s*(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (ratio) return sizeForAspect(Number(ratio[1]), Number(ratio[2]));
  return 'auto';
}

export type ImagesApiQuality = 'low' | 'medium' | 'high' | 'auto';

/** low / medium / high / auto as is; "standard" is medium, "hd" / "ultra" high; anything else auto. */
export function imagesApiQuality(quality: string | undefined): ImagesApiQuality {
  const q = (quality ?? '').trim().toLowerCase();
  if (q === 'low' || q === 'medium' || q === 'high' || q === 'auto') return q;
  if (q === 'standard') return 'medium';
  if (q === 'hd' || q === 'ultra') return 'high';
  return 'auto';
}

/** png / jpeg / webp ("jpg" is jpeg), else undefined (the model's default, png). */
export function imagesApiOutputFormat(format: string | undefined): 'png' | 'jpeg' | 'webp' | undefined {
  const f = (format ?? '').trim().toLowerCase();
  if (f === 'jpg' || f === 'jpeg') return 'jpeg';
  if (f === 'png' || f === 'webp') return f;
  return undefined;
}

/** auto / opaque / transparent, else undefined. */
export function imagesApiBackground(background: string | undefined): 'auto' | 'opaque' | 'transparent' | undefined {
  const b = (background ?? '').trim().toLowerCase();
  return b === 'auto' || b === 'opaque' || b === 'transparent' ? b : undefined;
}

/** Input images one edit request takes at most. */
export const MAX_IMAGES_API_REFERENCES = 16;

export interface ImagesApiRequestInput {
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  outputCompression?: number;
  background?: string;
}

/**
 * The request fields (everything but the input images), as JSON values.
 * Always one image (`n` 1): callers save one image per call, and every image
 * the API makes is billed, so it never makes one nobody receives.
 */
export function imagesApiRequestFields(input: ImagesApiRequestInput): Record<string, string | number> {
  const fields: Record<string, string | number> = {
    model: input.model,
    prompt: input.prompt,
    n: 1,
    size: imagesApiSize(input.size),
    quality: imagesApiQuality(input.quality),
  };
  const format = imagesApiOutputFormat(input.outputFormat);
  if (format) fields.output_format = format;
  // Compression applies to jpeg and webp only.
  if ((format === 'jpeg' || format === 'webp') && typeof input.outputCompression === 'number' && Number.isFinite(input.outputCompression)) {
    fields.output_compression = Math.max(0, Math.min(100, Math.round(input.outputCompression)));
  }
  const background = imagesApiBackground(input.background);
  if (background) fields.background = background;
  return fields;
}

/** A base64 data URI's bytes and media type, or undefined for anything else. */
export function decodeDataUri(uri: string): { bytes: Buffer; type: string } | undefined {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/is.exec(uri.trim());
  if (!match) return undefined;
  return { type: match[1]!.toLowerCase(), bytes: Buffer.from(match[2]!, 'base64') };
}

const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** The multipart edit request: the fields, then each input image as an "image[]" file. */
export function imagesApiEditForm(input: ImagesApiRequestInput, images: Array<{ bytes: Buffer; type: string }>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(imagesApiRequestFields(input))) form.append(name, String(value));
  images.forEach((image, i) => {
    const ab = image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength) as ArrayBuffer;
    form.append('image[]', new Blob([ab], { type: image.type }), `reference-${i + 1}.${EXTENSION[image.type] ?? 'png'}`);
  });
  return form;
}

/** The file extension for an output format (png when none was asked for). */
export function imagesApiExtension(format: string | undefined): string {
  const f = imagesApiOutputFormat(format);
  return f === 'jpeg' ? '.jpg' : f === 'webp' ? '.webp' : '.png';
}
