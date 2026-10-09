// Turns a failed image-generation attempt into an honest, actionable tool
// result. generate_image never substitutes a web-scraped image for a failed
// generation; it reports why the generation failed so the user can act.
//
// The cause is classified by generationFailure.ts, shared with video.

import {
  classifyGenerationFailure,
  GenerationApiError,
  summarizeFailureDetail,
  type GenerationFailureInput,
  type GenerationFailureKind,
  type GenerationStage,
} from './generationFailure.js';

export { summarizeFailureDetail };

export type ImageGenerationFailureKind = GenerationFailureKind;

/** Where it failed: the generation request, or downloading the generated image. */
export type ImageGenerationStage = GenerationStage;

/** An error from an image provider that carries the generation API's HTTP status. */
export class ImageApiError extends GenerationApiError {
  constructor(message: string, status?: number, stage: ImageGenerationStage = 'request') {
    super(message, status, stage);
    this.name = 'ImageApiError';
  }
}

export type ImageGenerationFailureInput = {
  /** Raw error text: provider error message, response body, or exception message. */
  detail: string;
  /** HTTP status of the generation API call, when there was one. */
  status?: number;
  /** Defaults to 'request'. */
  stage?: ImageGenerationStage;
  /** Which path failed, e.g. "configured visual API" or "BytePlus image API". */
  source?: string;
  /** Reference images were sent, so size problems may come from them. */
  hasReferences?: boolean;
};

export function classifyImageGenerationFailure(input: GenerationFailureInput): ImageGenerationFailureKind {
  return classifyGenerationFailure(input);
}

const NO_SUBSTITUTE_NOTE =
  'No image was created. Do not substitute a downloaded web image unless the user explicitly asks for one.';

export function describeImageGenerationFailure(
  kind: ImageGenerationFailureKind,
  options: { hasReferences?: boolean } = {},
): string {
  switch (kind) {
    case 'insufficient_balance':
      return 'insufficient balance. The account balance is too low to generate images; ask the user to top up their balance, then retry.';
    case 'payload_too_large':
      return options.hasReferences
        ? 'request too large (HTTP 413). Use fewer reference images or smaller/compressed copies of them, or shorten the prompt, then retry.'
        : 'request too large (HTTP 413). Shorten the prompt or request fewer images, then retry.';
    case 'content_rejected':
      return "content rejected by the image service's safety filter. Tell the user, and only retry with a rephrased prompt that removes the flagged content; do not resend the same prompt.";
    case 'not_configured':
      return 'image generation is not configured correctly. Ask the user to set up the visual provider (/config visual), then retry.';
    case 'unauthorized':
      return 'the image service rejected the credentials. Ask the user to check the visual provider API key (/config visual).';
    case 'rate_limited':
      return 'the image service is rate-limiting requests. Wait a minute, then retry once; if it fails again, tell the user.';
    case 'timeout':
      return 'the image service did not answer in time. Retry once; if it fails again, tell the user.';
    case 'download_failed':
      return 'the image was generated (and may have been billed) but could not be downloaded. Retry once; if it fails again, tell the user the result URL could not be fetched.';
    case 'upstream':
    default:
      return 'the image service or network failed. This is often temporary: retry once, and if it fails again tell the user.';
  }
}

/** The reason line and the details line, without the "No image was created" note. */
export function describeImageGenerationFailureParts(input: ImageGenerationFailureInput): {
  kind: ImageGenerationFailureKind;
  reason: string;
  details: string;
} {
  const kind = classifyImageGenerationFailure(input);
  const detail = summarizeFailureDetail(input.detail ?? '') || 'unknown error';
  const statusText = input.status && !detail.includes(String(input.status)) ? ` (HTTP ${input.status})` : '';
  const sourceText = input.source ? `${input.source} failed${statusText}: ` : statusText ? `${statusText.trim()}: ` : '';
  return {
    kind,
    reason: describeImageGenerationFailure(kind, { hasReferences: input.hasReferences }),
    details: `Details: ${sourceText}${detail}`,
  };
}

export function formatImageGenerationFailure(input: ImageGenerationFailureInput): {
  kind: ImageGenerationFailureKind;
  output: string;
} {
  const parts = describeImageGenerationFailureParts(input);
  return {
    kind: parts.kind,
    output: [`generate_image failed: ${parts.reason}`, parts.details, NO_SUBSTITUTE_NOTE].join('\n'),
  };
}
