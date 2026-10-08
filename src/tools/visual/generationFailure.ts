// Classifies a failed image or video generation from the generation API's
// HTTP status and its error text, so generate_image, generate_video and Saga
// report the same cause the same way.
//
// The HTTP status comes only from the generation API call itself and is passed
// explicitly (GenerationApiError / GenerationResult.httpStatus). It is never
// parsed out of free text, where a download's 403 would look like rejected
// credentials.

export type GenerationFailureKind =
  | 'insufficient_balance'
  | 'rate_limited'
  | 'payload_too_large'
  | 'content_rejected'
  | 'not_configured'
  | 'unauthorized'
  | 'download_failed'
  | 'timeout'
  | 'upstream';

/** Where it failed: the generation request, or downloading the generated asset. */
export type GenerationStage = 'request' | 'download';

/** An error from a visual provider that carries the generation API's HTTP status. */
export class GenerationApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly stage: GenerationStage = 'request',
  ) {
    super(message);
    this.name = 'GenerationApiError';
  }
}

export type GenerationFailureInput = {
  /** Raw error text: provider error message, response body, or exception message. */
  detail: string;
  /** HTTP status of the generation API call, when there was one. */
  status?: number;
  /** Defaults to 'request'. */
  stage?: GenerationStage;
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
const RATE_LIMIT_PATTERN =
  /rate[\s_-]*limit|too many requests|RateLimitExceeded|QuotaExceeded|quota exceeded|request limit|限流|请求过于频繁/i;
const TIMEOUT_PATTERN =
  /did not (?:finish|complete) within|timed out|\btimeout\b|deadline exceeded|超时/i;
const NOT_CONFIGURED_PATTERN =
  /ARTEMIS_VISUAL_SETUP_REQUIRED|credentials not found|api key is not configured|missing api key|not configured|base url is required|base url is misconfigured|placeholder in this build/i;

export function classifyGenerationFailure(input: GenerationFailureInput): GenerationFailureKind {
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
  if (status === 429) return 'rate_limited';
  if (BALANCE_PATTERN.test(detail)) return 'insufficient_balance';
  if (PAYLOAD_TOO_LARGE_PATTERN.test(detail)) return 'payload_too_large';
  // ModelArk/Seedream: 400 SensitiveContentDetected (and its .Category variants)
  // for prompts, input images and generated output; OpenAI: moderation_blocked.
  if (CONTENT_REJECTED_PATTERN.test(detail)) return 'content_rejected';
  if (NOT_CONFIGURED_PATTERN.test(detail)) return 'not_configured';
  if (RATE_LIMIT_PATTERN.test(detail)) return 'rate_limited';
  if (TIMEOUT_PATTERN.test(detail)) return 'timeout';
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

