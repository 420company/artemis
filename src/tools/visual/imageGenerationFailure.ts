// Turns a failed image-generation attempt into an honest, actionable tool
// result. generate_image never substitutes a web-scraped image for a failed
// generation; it reports why the generation failed so the user can act.

export type ImageGenerationFailureKind =
  | 'insufficient_balance'
  | 'payload_too_large'
  | 'content_rejected'
  | 'not_configured'
  | 'unauthorized'
  | 'upstream';

export type ImageGenerationFailureInput = {
  /** Raw error text: provider error message, response body, or exception message. */
  detail: string;
  /** HTTP status when known. Otherwise it is parsed from `detail` when present. */
  status?: number;
  /** Which path failed, e.g. "configured visual API" or "BytePlus image API". */
  source?: string;
};

const MAX_DETAIL_CHARS = 400;

const BALANCE_PATTERN =
  /insufficient[\s_-]*(?:balance|funds|credits?|quota)|InsufficientBalance|insufficient_quota|ServiceOverdue|AccountOverdue|account (?:balance )?(?:is )?overdue|overdue balance|payment required|balance (?:is )?too low|top[\s-]?up|余额不足|欠费/i;
const PAYLOAD_TOO_LARGE_PATTERN =
  /payload too large|request entity too large|RequestTooLarge|request (?:body )?too large|body exceeded|exceeds the maximum (?:request|payload) size/i;
const CONTENT_REJECTED_PATTERN =
  /SensitiveContent|sensitive content|content[\s_-]*(?:policy|filter|moderation|safety|security)|moderation_blocked|content_policy_violation|safety (?:system|check|filter)|flagged by|内容安全|敏感|违规/i;
const NOT_CONFIGURED_PATTERN =
  /ARTEMIS_VISUAL_SETUP_REQUIRED|credentials not found|api key is not configured|missing api key|not configured|base url is required|placeholder in this build/i;

/** Extracts an HTTP status such as "HTTP 402", "(HTTP 413)" or "API 402:" from an error string. */
export function extractHttpStatus(detail: string): number | undefined {
  const match = /\b(?:HTTP|API)\s*\(?\s*([1-5]\d\d)\b/i.exec(detail);
  return match ? Number(match[1]) : undefined;
}

export function classifyImageGenerationFailure(
  input: Pick<ImageGenerationFailureInput, 'detail' | 'status'>,
): ImageGenerationFailureKind {
  const detail = input.detail ?? '';
  const status = input.status ?? extractHttpStatus(detail);

  // Billing first: our gateway answers 402, and ModelArk reports an overdue
  // account as 403 OperationDenied.ServiceOverdue.
  if (status === 402 || BALANCE_PATTERN.test(detail)) return 'insufficient_balance';
  if (status === 413 || PAYLOAD_TOO_LARGE_PATTERN.test(detail)) return 'payload_too_large';
  // ModelArk/Seedream: 400 SensitiveContentDetected (and its .Category variants)
  // for prompts, input images and generated output; OpenAI: moderation_blocked.
  if (CONTENT_REJECTED_PATTERN.test(detail)) return 'content_rejected';
  if (NOT_CONFIGURED_PATTERN.test(detail)) return 'not_configured';
  if (status === 401 || status === 403) return 'unauthorized';
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

export function describeImageGenerationFailure(kind: ImageGenerationFailureKind): string {
  switch (kind) {
    case 'insufficient_balance':
      return 'insufficient balance. The account balance is too low to generate images; ask the user to top up their balance, then retry.';
    case 'payload_too_large':
      return 'request too large (HTTP 413). Shorten the prompt or request fewer images, then retry.';
    case 'content_rejected':
      return "content rejected by the image service's safety filter. Tell the user, and only retry with a rephrased prompt that removes the flagged content; do not resend the same prompt.";
    case 'not_configured':
      return 'image generation is not configured. Ask the user to set up a visual provider (/config visual), then retry.';
    case 'unauthorized':
      return 'the image service rejected the credentials. Ask the user to check the visual provider API key (/config visual).';
    case 'upstream':
    default:
      return 'the image service or network failed. This is often temporary: retry once, and if it fails again tell the user.';
  }
}

export function formatImageGenerationFailure(input: ImageGenerationFailureInput): {
  kind: ImageGenerationFailureKind;
  output: string;
} {
  const kind = classifyImageGenerationFailure(input);
  const status = input.status ?? extractHttpStatus(input.detail ?? '');
  const detail = summarizeFailureDetail(input.detail ?? '') || 'unknown error';
  const statusText = status && !detail.includes(String(status)) ? ` (HTTP ${status})` : '';
  const sourceText = input.source ? `${input.source} failed${statusText}: ` : statusText ? `${statusText.trim()}: ` : '';
  return {
    kind,
    output: [
      `generate_image failed: ${describeImageGenerationFailure(kind)}`,
      `Details: ${sourceText}${detail}`,
      NO_SUBSTITUTE_NOTE,
    ].join('\n'),
  };
}
