/**
 * Recognising "the request is larger than the model's context window"
 * across providers, so the runtime can compact and retry once instead of
 * failing (or, on bridges, failing the same way on every later message).
 *
 * Shapes covered (status 400/413/422 or a message without status):
 * - OpenAI and compatible gateways: code context_length_exceeded,
 *   "This model's maximum context length is N tokens".
 * - Anthropic: "prompt is too long: N tokens > M maximum",
 *   "input length and `max_tokens` exceed context limit".
 * - Gemini: "The input token count (N) exceeds the maximum number of tokens
 *   allowed (M)".
 * - BytePlus / Volcengine Ark: "Total tokens of image and text exceed max
 *   message tokens", "...exceeds the model's context window/length".
 * - Others seen in the wild: DashScope "Range of input length should be",
 *   Moonshot "exceeded model token limit", plain 413 Payload Too Large.
 */

const OVERFLOW_PATTERNS: RegExp[] = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context (?:window|length|limit)[^.\n]{0,40}(?:exceed|too (?:long|large|small))/i,
  /exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context (?:window|length|limit)/i,
  /prompt is too long/i,
  /input (?:is )?too long/i,
  /input length and `?max_tokens`? exceed/i,
  /too many (?:input )?tokens/i,
  /input token count[^.\n]{0,60}exceeds/i,
  /exceeds? the maximum number of tokens/i,
  /exceed(?:s|ed)? max(?:imum)? message tokens/i,
  /(?:exceeded|exceeds?) (?:the )?model(?:'s)? token limit/i,
  /range of input length should be/i,
  /reduce the length of the messages/i,
  /request (?:entity )?too large/i,
  /payload too large/i,
  /上下文(?:长度|窗口)?[^。\n]{0,20}(?:超出|超过|过长)/,
  /(?:超出|超过)[^。\n]{0,20}(?:上下文|最大长度|最大 ?token)/,
]

/** Signals that look like overflow wording but mean rate limiting. */
const NOT_OVERFLOW = /rate.?limit|tokens per (?:min|minute|day)|\bTPM\b|\bRPM\b|quota/i

function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null
  for (const candidate of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return undefined
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function isContextOverflowError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof ContextOverflowError) return true
  const status = statusOf(error)
  if (status === 413) return true
  if (status !== undefined && status !== 400 && status !== 422) return false
  const message = messageOf(error)
  if (NOT_OVERFLOW.test(message)) return false
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))
}

/** Raised when a request still does not fit after a forced compaction. */
export class ContextOverflowError extends Error {
  readonly code = 'context_overflow'
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'ContextOverflowError'
    this.cause = cause
  }
}

export function buildContextOverflowMessage(language: 'zh' | 'en', detail: string): string {
  return language === 'zh'
    ? `请求超出了模型的上下文窗口；已自动压缩历史并重试一次，仍然失败。会话历史已保存为压缩后的版本，可以直接继续发送消息；如果仍然失败，请缩短本条消息或减少附件。（${detail}）`
    : `The request exceeded the model's context window. The history was compacted automatically and the request retried once, but it still failed. The compacted history has been saved, so you can keep going; if it fails again, shorten this message or attach less. (${detail})`
}
