/**
 * Vision helper: lets a model that cannot see images still work with them.
 *
 * When the main model is text-only but the provider store names a vision
 * profile (`visionProfileId`, stored like `specialistProfileId`), images go to
 * that profile once and the main model gets a faithful text description:
 *
 *   - user attachments (`--image`, web uploads, bridge/pasted images) become a
 *     text part "[Image N description by vision helper — ...]" in the user's
 *     message, and the main request carries no image parts;
 *   - `view_image` returns the description as its tool result.
 *
 * Without a helper the user's images become a short note asking the model to
 * tell the user, so the run never fails just because the plan cannot read
 * images. One helper instance belongs to one run: its description cache
 * (keyed by the image content hash) never outlives the run.
 *
 * Used by both runAgent (core/agent.ts: headless, web, workflows) and think()
 * (brain.ts: bridges and the CLI).
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SessionMessage } from './types.js';
import type { ChatProvider, ImageAttachment, ProviderProfile } from '../providers/types.js';
import { fitImagesToRequest, imageByteSize, MAX_IMAGE_BYTES } from './imageInput.js';
import { modelSupportsImages } from '../providers/imageSupport.js';
import { ProviderStore } from '../providers/store.js';
import { createTrackedProviderFromConfig } from '../providers/telemetry.js';
import { resolveArtemisHomeDir } from '../utils/fs.js';

/** Output budget for one image's description. */
export const VISION_HELPER_MAX_TOKENS_PER_IMAGE = 1500;
/** Output budget for one helper call, however many images it carries. */
export const VISION_HELPER_MAX_TOKENS_PER_CALL = 6000;
/** The user's message is context for the helper, not something to answer; keep it short. */
const MAX_CONTEXT_CHARS = 4000;

export type VisionDescription =
  | { ok: true; text: string }
  | { ok: false; error: string };

export type VisionHelper = {
  /** Profile id (or model) of the helper, for logs. */
  readonly label: string;
  /**
   * Describes each image, in order. Images already described in this run come
   * from the cache; the others go to the vision model in a single call.
   * Never throws: a failed image comes back as `{ ok: false }`.
   */
  describe(images: readonly ImageAttachment[], context?: VisionHelperContext): Promise<VisionDescription[]>;
};

export type VisionHelperContext = {
  /** The user's message, so the description covers what the user asks about. */
  userText?: string;
  /** UI language, used when the user's message has no text to take the language from. */
  locale?: string;
};

/** Content hash of an image, the cache key. */
export function hashImage(image: ImageAttachment): string {
  return createHash('sha256').update(image.mediaType).update('\0').update(image.data).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function message(role: SessionMessage['role'], content: string): SessionMessage {
  return { id: `vision-${role}-${Math.random().toString(36).slice(2, 10)}`, role, content, createdAt: nowIso() };
}

/** The user's own words: workflow runs wrap them after a "--- USER REQUEST ---" marker. */
function userRequestText(text: string | undefined): string {
  const raw = text ?? '';
  const marker = '--- USER REQUEST ---';
  const index = raw.lastIndexOf(marker);
  const request = (index >= 0 ? raw.slice(index + marker.length) : raw).trim();
  return request.length > MAX_CONTEXT_CHARS ? `${request.slice(0, MAX_CONTEXT_CHARS)}…` : request;
}

function languageName(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  return /^zh/i.test(locale) ? 'Chinese' : /^en/i.test(locale) ? 'English' : locale;
}

function buildInstruction(count: number, context: VisionHelperContext | undefined): string {
  const fallbackLanguage = languageName(context?.locale);
  return [
    'You are the eyes of an assistant that cannot see images. It will rely only on your description, so be faithful and detailed, and never invent what is not visible.',
    'Describe:',
    '- the subjects and what is happening;',
    '- the layout and composition (what is where);',
    '- all visible text, transcribed verbatim (OCR), keeping line breaks where they matter;',
    '- colours, style and medium (photo, screenshot, diagram, drawing, ...);',
    '- charts and tables as data (axes, labels, values, rows and columns);',
    "- anything relevant to the user's question below.",
    "Do not answer the user's question; only describe what the image shows.",
    `Write in the language of the user's message${fallbackLanguage ? ` (if it has no text, in ${fallbackLanguage})` : ''}.`,
    count > 1
      ? `There are ${count} images. Start each image's description with a line "### Image k" (k = 1 to ${count}, in the order given).`
      : '',
  ].filter(Boolean).join('\n');
}

/** Splits a multi-image reply on its "### Image k" headings; undefined when it does not match. */
function splitDescriptions(text: string, count: number): string[] | undefined {
  if (count === 1) return [text.trim()];
  const heading = /^\s*#{1,6}\s*Image\s+(\d+)\b[^\n]*$/gim;
  const marks: Array<{ index: number; end: number; n: number }> = [];
  for (let match = heading.exec(text); match; match = heading.exec(text)) {
    marks.push({ index: match.index, end: match.index + match[0].length, n: Number(match[1]) });
  }
  if (marks.length !== count) return undefined;
  const parts: string[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    if (marks[i]!.n !== i + 1) return undefined;
    parts.push(text.slice(marks[i]!.end, marks[i + 1]?.index ?? text.length).trim());
  }
  return parts.every(Boolean) ? parts : undefined;
}

/**
 * A helper around a ChatProvider that can see images. Create one per run: the
 * cache lives as long as the helper.
 */
export function createVisionHelper(
  provider: ChatProvider,
  options: { label?: string; onInfo?: (message: string) => void } = {},
): VisionHelper {
  const cache = new Map<string, string>();
  const label = options.label ?? 'vision';
  return {
    label,
    async describe(images, context) {
      const keys = images.map(hashImage);
      const pending: Array<{ key: string; image: ImageAttachment }> = [];
      for (let i = 0; i < images.length; i += 1) {
        const key = keys[i]!;
        if (!cache.has(key) && !pending.some((entry) => entry.key === key)) pending.push({ key, image: images[i]! });
      }
      // Results of this call that are not cached (failures, or a batch the
      // model described without per-image headings).
      const uncached = new Map<string, VisionDescription>();
      if (pending.length > 0) {
        const userText = userRequestText(context?.userText);
        const request = [
          message('system', buildInstruction(pending.length, context)),
          message('user', [
            userText ? `The user's message (context only, do not answer it):\n${userText}` : 'The user sent the image(s) without a message.',
            '',
            pending.length > 1 ? `Describe the ${pending.length} attached images.` : 'Describe the attached image.',
          ].join('\n')),
        ];
        try {
          const response = await provider.complete(request, {
            imageAttachments: pending.map((entry) => entry.image),
            maxOutputTokens: Math.min(VISION_HELPER_MAX_TOKENS_PER_IMAGE * pending.length, VISION_HELPER_MAX_TOKENS_PER_CALL),
          });
          const text = (response.text ?? '').trim();
          if (!text) throw new Error('the vision model returned an empty description');
          const parts = splitDescriptions(text, pending.length);
          if (parts) {
            pending.forEach((entry, i) => cache.set(entry.key, parts[i]!));
          } else {
            // Described together without the per-image headings: the whole
            // text goes with the first image, the others point at it.
            pending.forEach((entry, i) => uncached.set(entry.key, {
              ok: true,
              text: i === 0 ? text : '(described together with the first of these images above)',
            }));
          }
          options.onInfo?.(`[vision] ${label} described ${pending.length} image(s)`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          options.onInfo?.(`[vision] ${label} failed: ${reason}`);
          for (const entry of pending) uncached.set(entry.key, { ok: false, error: reason });
        }
      }
      return keys.map((key): VisionDescription => {
        const cached = cache.get(key);
        if (cached !== undefined) return { ok: true, text: cached };
        return uncached.get(key) ?? { ok: false, error: 'no description' };
      });
    },
  };
}

/**
 * The profile `visionProfileId` names, resolved like the specialist profile:
 * the cwd-local store first, then the global ~/.artemis store. Only a profile
 * whose model can see images qualifies.
 */
export async function resolveVisionProfile(cwd: string): Promise<{ profile: ProviderProfile; storeCwd: string } | undefined> {
  const candidates = [path.resolve(cwd), resolveArtemisHomeDir()];
  for (const storeCwd of candidates) {
    try {
      const store = new ProviderStore(storeCwd);
      const data = await store.load();
      const profile = store.getProfile(data, data.visionProfileId);
      if (profile) return modelSupportsImages(profile) ? { profile, storeCwd } : undefined;
    } catch {
      // An unreadable store means no helper from it.
    }
  }
  return undefined;
}

/** A fresh helper (own cache) for the configured vision profile, or undefined when none is usable. */
export async function loadVisionHelper(
  cwd: string,
  options: { onInfo?: (message: string) => void } = {},
): Promise<VisionHelper | undefined> {
  const resolved = await resolveVisionProfile(cwd);
  if (!resolved) return undefined;
  const { profile, storeCwd } = resolved;
  const provider = createTrackedProviderFromConfig(profile, {
    cwd: storeCwd,
    profileId: profile.id,
    profileLabel: profile.label ?? profile.id,
  });
  return createVisionHelper(provider, { label: profile.id, onInfo: options.onInfo });
}

/** Memoizes a helper lookup, so one run resolves (and caches through) one helper. */
export function memoizeVisionHelper(
  load: () => Promise<VisionHelper | undefined>,
): () => Promise<VisionHelper | undefined> {
  let pending: Promise<VisionHelper | undefined> | undefined;
  return () => {
    pending ??= load().catch(() => undefined);
    return pending;
  };
}

/** A name for an image in notes: its file name when known. */
export function imageDisplayName(image: ImageAttachment, index: number): string {
  const fromLabel = image.label?.replace(/^Image:\s*/i, '').trim();
  if (fromLabel) return fromLabel;
  if (image.sourceUrl) {
    try {
      const base = path.posix.basename(new URL(image.sourceUrl).pathname);
      if (base) return base;
    } catch {
      // not a URL
    }
  }
  return `image ${index + 1}`;
}

/** Shown to the main model when no helper exists and the model cannot see images. */
export function formatNoVisionNote(images: readonly ImageAttachment[]): string {
  const names = images.map(imageDisplayName).join(', ');
  return `[The user attached ${images.length} image(s) (file names: ${names}) but this plan cannot read images. Tell the user briefly and continue with the text.]`;
}

export type PreparedUserImages = {
  /** Text to add to the user's message (descriptions or a note); undefined when images pass through unchanged. */
  note?: string;
  /** Images still to send with the request: empty once they were turned into text. */
  images: ImageAttachment[];
};

/**
 * Turns the user's images into text for a model that cannot see them: the
 * helper's descriptions when a helper exists, else a short note. A model that
 * can see images gets them unchanged. Never throws.
 */
export async function prepareUserImagesForModel(input: {
  userText: string;
  images: readonly ImageAttachment[] | undefined;
  modelSeesImages: boolean;
  getHelper: () => Promise<VisionHelper | undefined>;
  locale?: string;
  onInfo?: (message: string) => void;
}): Promise<PreparedUserImages> {
  const images = [...(input.images ?? [])];
  if (images.length === 0 || input.modelSeesImages) return { images };

  let helper: VisionHelper | undefined;
  try {
    helper = await input.getHelper();
  } catch {
    helper = undefined;
  }
  if (!helper) {
    input.onInfo?.(`[images] the model cannot see images and no vision helper is configured; ${images.length} image(s) replaced by a note`);
    return { note: formatNoVisionNote(images), images: [] };
  }

  // #9's limits still apply: no image over the per-image cap, and only what
  // fits one request goes to the helper.
  const oversized = new Set(images.filter((image) => imageByteSize(image) > MAX_IMAGE_BYTES));
  const { kept } = fitImagesToRequest(images.filter((image) => !oversized.has(image)));
  const sendable = new Set(kept);
  const described = await helper.describe(kept, { userText: input.userText, locale: input.locale });
  const blocks = images.map((image, index) => {
    const n = index + 1;
    const name = imageDisplayName(image, index);
    if (!sendable.has(image)) {
      const why = oversized.has(image) ? 'it is larger than the per-image limit' : 'it is over the per-message image limit';
      return `[Image ${n} (${name}): the attached image could not be read, because ${why}. Tell the user briefly and continue with the text.]`;
    }
    const result = described[kept.indexOf(image)];
    if (result?.ok) {
      return `[Image ${n} description by vision helper — the main model cannot see images]\n${result.text}`;
    }
    return `[Image ${n} (${name}): the attached image could not be read (the vision helper failed). Tell the user briefly and continue with the text.]`;
  });
  return { note: blocks.join('\n\n'), images: [] };
}

/**
 * How a run shows images to its provider. The candidate tried first (the
 * worker, for a sub-agent) sees them directly when it can; otherwise the
 * vision helper describes them; otherwise, when another routed candidate (the
 * main profile) can see them, the images go natively and the router sends
 * that request to it. A text-only model never receives image parts.
 */
export async function resolveImageRoute(
  provider: Pick<ChatProvider, 'supportsImages' | 'primarySupportsImages'>,
  getHelper: () => Promise<VisionHelper | undefined>,
): Promise<{ native: boolean; helper?: VisionHelper }> {
  const anySees = provider.supportsImages === true;
  const primarySees = provider.primarySupportsImages ?? anySees;
  if (primarySees) return { native: true };
  const helper = await getHelper();
  if (helper) return { native: false, helper };
  return { native: anySees };
}

/** One image's description for view_image; rejects with the reason when the helper failed. */
export async function describeSingleImage(
  helper: VisionHelper,
  image: ImageAttachment,
  context?: VisionHelperContext,
): Promise<string> {
  const [result] = await helper.describe([image], context);
  if (!result?.ok) throw new Error(result?.error ?? 'no description');
  return result.text;
}

/** The user's text with the image note appended as its own text part. */
export function appendImageNote(text: string, note: string | undefined): string {
  if (!note) return text;
  return text.trim() ? `${text}\n\n${note}` : note;
}
