import { Agent } from 'undici';

// ── Unified transport retry engine ────────────────────────────────────────────
// Shared by all three provider channels (messages / openai / responses).
// Retries only happen BEFORE response headers are returned to the caller;
// once a Response is handed back, any mid-body failure is the caller's to
// surface (streams must never be silently re-sent — the consumed prefix
// would be duplicated).

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_TOTAL_BUDGET_MS = 120_000;
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 120_000;

export type RetryFetchOptions = {
  /** External cancellation signal; aborts both the request and backoff sleeps. */
  signal?: AbortSignal;
  /** Total attempt cap, including the first request. */
  maxAttempts?: number;
  /** Wall-clock retry budget; a delay that would exceed it stops retrying. */
  totalBudgetMs?: number;
  /** Separate, lower cap for 429 retries — rate-limit waits are long. */
  rateLimitMaxRetries?: number;
  /** Notified when a retry has been scheduled (after the failed attempt). */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  /**
   * 413 hook: return a replacement request body with inline images stripped
   * (retried once, not counted against the attempt budget), or null when
   * there is nothing to strip.
   */
  onPayloadTooLarge?: () => BodyInit | null;
};

function collectErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

function isAbortError(error: unknown): boolean {
  return collectErrorChain(error).some((entry) => {
    if (!(entry instanceof Error)) return false;
    const code = (entry as Error & { code?: unknown }).code;
    return entry.name === 'AbortError' || entry.name === 'TimeoutError' || code === 'ABORT_ERR';
  });
}

// Network-level failures (connection refused/reset, DNS, TLS, socket hangup)
// are retryable. Response-body deserialization failures are NOT — resending
// the same request would burn the whole budget re-producing the same parse
// error. The fetch layer buries the real cause under generic wrappers, so
// walk the cause chain before deciding.
function isRetryableNetworkError(error: unknown): boolean {
  const chain = collectErrorChain(error);
  if (chain.some((entry) => entry instanceof SyntaxError)) return false;
  return true;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

// Exponential backoff (1s, 2s, 4s, ..., capped 30s) with ±20% jitter to
// avoid thundering-herd retry storms.
function backoffWithJitterMs(attempt: number): number {
  const baseMs = Math.min(1000 * 2 ** Math.max(attempt - 1, 0), MAX_BACKOFF_MS);
  const jitterRange = baseMs / 5;
  return Math.round(baseMs - jitterRange + Math.random() * jitterRange * 2);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
      return;
    }
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// The final attempt bypasses the shared connection pool: a half-dead
// keep-alive socket can fail every pooled attempt identically, so give the
// last one a fresh connection. Agent.close() resolves after in-flight
// requests (including body streaming) complete, so fire-and-forget is safe.
async function fetchOnce(url: string, init: RequestInit, freshConnection: boolean): Promise<Response> {
  if (!freshConnection) return fetch(url, init);
  const agent = new Agent({ pipelining: 0, keepAliveTimeout: 1 });
  try {
    const response = await fetch(url, { ...init, dispatcher: agent } as RequestInit);
    void agent.close().catch(() => { /* ignore */ });
    return response;
  } catch (error) {
    void agent.close().catch(() => { /* ignore */ });
    throw error;
  }
}

export async function retryFetch(
  url: string,
  init: RequestInit,
  options: RetryFetchOptions = {},
): Promise<Response> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const budgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const rateLimitCap = options.rateLimitMaxRetries ?? DEFAULT_RATE_LIMIT_MAX_RETRIES;
  const startedAt = Date.now();
  let body = init.body;
  let rateLimitRetries = 0;
  let strippedPayload = false;

  for (let attempt = 1; ; ) {
    const finalAttempt = attempt >= maxAttempts;
    let response: Response;
    try {
      response = await fetchOnce(url, { ...init, body }, finalAttempt && attempt > 1);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      if (!isRetryableNetworkError(error) || finalAttempt) throw error;
      const delayMs = backoffWithJitterMs(attempt);
      if (Date.now() - startedAt + delayMs > budgetMs) throw error;
      options.onRetry?.(attempt, delayMs, 'network-error');
      await abortableSleep(delayMs, options.signal);
      attempt += 1;
      continue;
    }

    // 413: strip inline images and retry once, without consuming an attempt.
    if (response.status === 413 && !strippedPayload && options.onPayloadTooLarge) {
      const replacement = options.onPayloadTooLarge();
      if (replacement !== null) {
        strippedPayload = true;
        body = replacement;
        try { await response.text(); } catch { /* ignore */ }
        options.onRetry?.(attempt, 0, 'payload-too-large');
        continue;
      }
    }

    // Server retry hint: `false` suppresses retries even on retryable
    // statuses; `true` marks the response retryable regardless of status.
    const hint = response.headers.get('x-should-retry');
    const retryableStatus = hint === 'false'
      ? false
      : hint === 'true'
        || response.status === 408
        || response.status === 429
        || response.status >= 500;

    if (response.ok || !retryableStatus || finalAttempt) return response;

    const isRateLimit = response.status === 429;
    if (isRateLimit && rateLimitRetries >= rateLimitCap) return response;

    const delayMs = parseRetryAfterMs(response.headers.get('retry-after'))
      ?? backoffWithJitterMs(attempt);
    if (Date.now() - startedAt + delayMs > budgetMs) return response;

    if (isRateLimit) rateLimitRetries += 1;
    // Drain the failed body so the socket is released back to the pool.
    try { await response.text(); } catch { /* ignore */ }
    options.onRetry?.(attempt, delayMs, isRateLimit ? 'rate-limit' : `status-${response.status}`);
    await abortableSleep(delayMs, options.signal);
    attempt += 1;
  }
}

// ── Streaming idle timeout ────────────────────────────────────────────────────
// Detects streams that stay open but stop delivering meaningful content
// (text/thinking/tool-call deltas). SSE comments, pings, and keep-alive
// blank lines must NOT reset the timer — only real increments do.

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export class StreamIdleTimeoutError extends Error {
  readonly retryable = false;
  constructor(idleMs: number) {
    super(
      `Streaming response idle timeout: no meaningful data arrived for ${Math.round(idleMs / 1000)}s. `
      + 'The request was aborted and will not be retried automatically.',
    );
    this.name = 'StreamIdleTimeoutError';
  }
}

export class StreamInterruptedError extends Error {
  readonly retryable = false;
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `The response stream was interrupted before completion: ${detail}. `
      + 'Mid-stream failures are not retried automatically because the already-consumed output would be duplicated.',
    );
    this.name = 'StreamInterruptedError';
    this.cause = cause;
  }
}

export type StreamIdleGuard = {
  /** Pass to fetch so an idle timeout can abort the underlying request. */
  signal: AbortSignal;
  /** Race a reader.read() against the idle deadline. */
  race<T>(promise: Promise<T>): Promise<T>;
  /** Call when meaningful content arrives to reset the idle deadline. */
  touch(): void;
  /** Stop the timer and detach listeners. Always call from finally. */
  dispose(): void;
};

export function createStreamIdleGuard(options: {
  idleTimeoutMs?: number;
  externalSignal?: AbortSignal;
} = {}): StreamIdleGuard {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  let lastActivity = Date.now();
  let timedOutError: StreamIdleTimeoutError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingReject: ((reason: unknown) => void) | undefined;

  const onExternalAbort = (): void => {
    controller.abort(options.externalSignal?.reason);
  };
  if (options.externalSignal) {
    if (options.externalSignal.aborted) onExternalAbort();
    else options.externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const onTimer = (): void => {
    timer = undefined;
    const idleFor = Date.now() - lastActivity;
    if (idleFor < idleTimeoutMs) {
      timer = setTimeout(onTimer, idleTimeoutMs - idleFor);
      timer.unref?.();
      return;
    }
    timedOutError = new StreamIdleTimeoutError(idleTimeoutMs);
    controller.abort(timedOutError);
    pendingReject?.(timedOutError);
  };

  const armTimer = (): void => {
    if (timer || timedOutError) return;
    timer = setTimeout(onTimer, Math.max(lastActivity + idleTimeoutMs - Date.now(), 0));
    timer.unref?.();
  };

  return {
    signal: controller.signal,
    race<T>(promise: Promise<T>): Promise<T> {
      if (timedOutError) {
        promise.catch(() => { /* ignore */ });
        return Promise.reject(timedOutError);
      }
      armTimer();
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        pendingReject = (reason) => {
          if (settled) return;
          settled = true;
          promise.catch(() => { /* ignore */ });
          reject(reason);
        };
        promise.then(
          (value) => {
            if (settled) return;
            settled = true;
            pendingReject = undefined;
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            pendingReject = undefined;
            // The idle abort surfaces through the reader as a generic abort;
            // translate it back into the explicit idle-timeout error.
            reject(timedOutError ?? error);
          },
        );
      });
    },
    touch(): void {
      lastActivity = Date.now();
    },
    dispose(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pendingReject = undefined;
      options.externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}
