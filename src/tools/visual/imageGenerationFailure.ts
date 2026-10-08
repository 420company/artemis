// Turns a failed image-generation attempt into an honest, actionable tool
// result. generate_image never substitutes a web-scraped image for a failed
// generation; it reports why the generation failed so the user can act.
//
// The HTTP status comes only from the generation API call itself and is passed
// explicitly (ImageApiError / GenerationResult.httpStatus). It is never parsed
// out of free text, where a download's 403 would look like rejected
// credentials.

export type ImageGenerationFailureKind =
  | 'insufficient_balance'
  | 'payload_too_large'
  | 'content_rejected'
  | 'not_configured'
  | 'unauthorized'
  | 'download_failed'
  | 'upstream';

/** Where it failed: the generation request, or downloading the generated image. */
export type ImageGenerationStage = 'request' | 'download';

/** An error from an image provider that carries the generation API's HTTP status. */
export class ImageApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly stage: ImageGenerationStage = 'request',
  ) {
    super(message);
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

const MAX_DETAIL_CHARS = 400;

// A 401/403 counts as billing only with one of these codes; anything else is
// rejected credentials.
const BILLING_CODE_PATTERN = /ServiceOverdue|AccountOverdue|insufficient_balance/i;
const BALANCE_PATTERN =
  /insufficient[\s_-]*(?:balance|funds|credits?|quota)|InsufficientBalance|insufficient_quota|ServiceOverdue|AccountOverdue|account (?:balance )?(?:is )?overdue|overdue balance|payment required|balance (?:is )?too low|余额不足|欠费/i;
const PAYLOAD_TOO_LARGE_PATTERN =
  /payload too large|request entity too large|RequestTooLarge|request (?:body )?too large|body exceeded|exceeds the maximum (?:request|payload) size/i;
const CONTENT_REJECTED_PATTERN =
  /SensitiveContent|sensitive content|content[\s_-]*(?:policy|filter|moderation|safety|security)|moderation_blocked|content_policy_violation|safety (?:system|check|filter)|flagged by|内容安全|敏感|违规/i;
const NOT_CONFIGURED_PATTERN =
  /ARTEMIS_VISUAL_SETUP_REQUIRED|credentials not found|api key is not configured|missing api key|not configured|base url is required|base url is misconfigured|placeholder in this build/i;

export function classifyImageGenerationFailure(
  input: Pick<ImageGenerationFailureInput, 'detail' | 'status' | 'stage'>,
): ImageGenerationFailureKind {
  const detail = input.detail ?? '';
  const status = input.status;

  // The image was generated; only fetching the result failed.
  if (input.stage === 'download') return 'download_failed';
  // Our gateway answers 402 when the balance is too low.
  if (status === 402) return 'insufficient_balance';
  // ModelArk reports an overdue account as 403 OperationDenied.ServiceOverdue.
  if (status === 401 || status === 403) {
    return BILLING_CODE_PATTERN.test(detail) ? 'insufficient_balance' : 'unauthorized';
  }
  if (status === 413) return 'payload_too_large';
  if (BALANCE_PATTERN.test(detail)) return 'insufficient_balance';
  if (PAYLOAD_TOO_LARGE_PATTERN.test(detail)) return 'payload_too_large';
  // ModelArk/Seedream: 400 SensitiveContentDetected (and its .Category variants)
  // for prompts, input images and generated output; OpenAI: moderation_blocked.
  if (CONTENT_REJECTED_PATTERN.test(detail)) return 'content_rejected';
  if (NOT_CONFIGURED_PATTERN.test(detail)) return 'not_configured';
  return 'upstream';
}

/** Shortens a provider error body; prefers the JSON `error.code: error.message` pair when present. */
export function summarizeFailureDetail(detail: string): string {
  const text = (detail ?? '').trim();
  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      const err = parsed?.error ?? parsed;
      const code = typeof err?.code === 'string' ? err.code : undefined;
      const message = typeof err?.message === 'string' ? err.message : undefined;
      if (code || message) {
        const prefix = text.slice(0, jsonStart).trim();
        const summary = [code, message].filter(Boolean).join(': ');
        return truncate(prefix ? `${prefix} ${summary}` : summary);
      }
    } catch {
      // Not JSON (or truncated JSON): fall through to the raw text.
    }
  }
  return truncate(text.replace(/\s+/g, ' '));
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS - 1).trimEnd()}…` : text;
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
