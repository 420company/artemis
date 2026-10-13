/**
 * `http_request` — send an HTTP(S) request and return the response.
 *
 * WP-2: this tool was declared as a stub (no `execute`) and removed in the
 * engine cleanup. This file provides the real executor.
 *
 * Security model:
 * - SSRF protection: the hostname is resolved via DNS BEFORE connecting and
 *   every resolved IP is checked against private/loopback/link-local/reserved
 *   ranges — including IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`)
 *   and deprecated IPv4-compatible (`::127.0.0.1`) forms, whose embedded IPv4
 *   is unwrapped and checked against the IPv4 blocklist. The request is then
 *   issued through node:http(s) with a custom `lookup` that pins the socket
 *   to the single pre-validated IP, so a DNS-rebinding race between the
 *   check and the connect cannot divert the socket. TLS SNI and the Host
 *   header still carry the original hostname, so virtual hosting keeps
 *   working. Each redirect hop is re-resolved and re-validated.
 * - Only http: and https: schemes are allowed; URLs with embedded
 *   credentials (userinfo) are rejected on every hop.
 * - Redirects: max 5, followed manually.
 * - Method whitelist: GET, POST, HEAD.
 * - Timeout: configurable per hop (default 30s, absolute deadline covering
 *   DNS + connect + headers + body) plus a 10s inactivity watchdog: if no
 *   bytes arrive for 10s the request is aborted (slow-drip resistant).
 * - Response body cap: 5 MiB (prevents memory exhaustion).
 * - Sensitive headers (`cookie`, `proxy-authorization`, `host`,
 *   `connection`, `content-length`, `transfer-encoding`) cannot be set by
 *   the caller. `Authorization` requires the explicit `authHeader` field
 *   (rejected when passed via `headers`) and is stripped on cross-origin
 *   redirects.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequestFn } from 'node:http';
import { request as httpsRequestFn } from 'node:https';
import { isIP } from 'node:net';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 10_000;
const INACTIVITY_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'HEAD']);

/** IPv4 ranges that must never be fetched (SSRF). */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16 (link-local incl. cloud metadata),
  // 172.16.0.0/12, 192.168.0.0/16, 192.0.2.0/24 (TEST-NET-1), 198.51.100.0/24 (TEST-NET-2),
  // 203.0.113.0/24 (TEST-NET-3), 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved)
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * If `ip` is an IPv4-mapped (`::ffff:0:0/96`) or IPv4-compatible (`::/96`,
 * deprecated) IPv6 address, return the embedded IPv4 in dotted-decimal form.
 * Otherwise return null. (C1 fix: these forms used to bypass the filter.)
 */
function unwrapEmbeddedIPv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  let tail: string | null = null;
  if (lower.startsWith('::ffff:')) {
    // Compressed mapped form: ::ffff:127.0.0.1 or ::ffff:7f00:1
    tail = lower.slice('::ffff:'.length);
  } else if (/^(?:0{1,4}:){5}ffff:/.test(lower)) {
    // Full form: 0:0:0:0:0:ffff:127.0.0.1 (first 80 bits must be zero)
    tail = lower.replace(/^(?:0{1,4}:){5}ffff:/, '');
  } else if (lower.startsWith('::')) {
    // Deprecated IPv4-compatible ::/96 — only when the tail is exactly 32 bits.
    const rest = lower.slice(2);
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(rest) || /^[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(rest)) {
      tail = rest;
    }
  }
  if (tail === null || tail.length === 0) return null;
  if (tail.includes('.')) return tail; // dotted form — validated by isBlockedIPv4
  // Hex form: each 16-bit group padded individually (e.g. ::ffff:c0a8:101 -> c0a8:0101).
  const groups = tail.split(':');
  if (groups.length === 0 || groups.length > 2) return null;
  const hex = groups.map((g) => g.padStart(4, '0')).join('');
  if (!/^[0-9a-f]{8}$/.test(hex)) return null;
  const n = parseInt(hex, 16);
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/** IPv6: block loopback, unspecified, link-local, unique-local, multicast, and any embedded-IPv4 that is blocked. */
function isBlockedIPv6(ip: string): boolean {
  const mapped = unwrapEmbeddedIPv4(ip);
  if (mapped !== null) return isBlockedIPv4(mapped);
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc00:') || lower.startsWith('fd00:')) return true; // unique-local
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIPv4(ip);
  if (v === 6) return isBlockedIPv6(ip);
  return true; // unparseable -> block
}

/** Run a promise with a hard timeout. Used to keep DNS inside the time budget. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface PinnedTarget {
  /** Original hostname as in the URL (drives TLS SNI and the Host header). */
  hostname: string;
  /** Pre-validated IP the socket must connect to — never re-resolved. */
  ip: string;
  family: 4 | 6;
}

/**
 * Resolve a hostname and return the single pinned IP to connect to, throwing
 * if the literal IP or ALL resolved IPs are in blocked ranges.
 */
async function resolveAndPin(hostname: string, dnsTimeoutMs: number): Promise<PinnedTarget> {
  // Literal IP: check directly. Strip IPv6 brackets first (URL.hostname keeps them).
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const literalFamily = isIP(bare);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedIp(bare)) {
      throw new Error(`SSRF blocked: ${hostname} is a private/reserved address`);
    }
    return { hostname: bare, ip: bare, family: literalFamily };
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await withTimeout(
      dnsLookup(hostname, { all: true }),
      dnsTimeoutMs,
      `DNS resolution timed out for ${hostname}`,
    );
  } catch (e) {
    if (e instanceof Error && /timed out/.test(e.message)) throw e;
    throw new Error(`DNS resolution failed for ${hostname}`);
  }
  const allowed = records.filter((r) => !isBlockedIp(r.address));
  if (allowed.length === 0) {
    throw new Error(`SSRF blocked: ${hostname} resolves only to private/reserved addresses`);
  }
  const pick = allowed[0]!;
  return { hostname, ip: pick.address, family: pick.family === 6 ? 6 : 4 };
}

class HttpToolError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'HttpToolError';
    this.code = code;
    this.retryable = retryable;
  }
}

function timeoutError(ms: number): Error {
  const e = new Error(`Request timed out after ${ms}ms`) as Error & { code?: string };
  e.code = 'TIMEOUT';
  return e;
}

function inactivityError(): Error {
  const e = new Error(
    `No data received for ${INACTIVITY_TIMEOUT_MS / 1000}s (stalled response)`,
  ) as Error & { code?: string };
  e.code = 'INACTIVITY';
  return e;
}

function bodyTooLargeError(): Error {
  const e = new Error(`Response body exceeds ${MAX_BODY_BYTES} bytes cap`) as Error & { code?: string };
  e.code = 'BODY_TOO_LARGE';
  return e;
}

interface PinnedResponse {
  status: number;
  statusText: string;
  /** Lower-cased header names. */
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/**
 * Issue one HTTP request against a pinned target. The custom `lookup` makes
 * node:http(s) connect to the pre-validated IP only — DNS is never consulted
 * again for this socket, closing the DNS-rebinding TOCTOU. TLS SNI and the
 * Host header still use the original hostname from the URL.
 *
 * Timing: an absolute per-hop deadline (`timeoutMs`) covers DNS-independent
 * work (connect → headers → body), and a 10s inactivity watchdog aborts the
 * request if no bytes arrive for 10s (slow-drip resistant).
 */
function fetchPinned(
  target: PinnedTarget,
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
  callerSignal?: AbortSignal,
): Promise<PinnedResponse> {
  const requestFn = url.protocol === 'https:' ? httpsRequestFn : httpRequestFn;
  return new Promise<PinnedResponse>((resolve, reject) => {
    let done = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(deadlineTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      fn();
    };
    const fail = (err: Error) => finish(() => reject(err));

    const deadlineTimer = setTimeout(() => {
      req.destroy();
      fail(timeoutError(init.timeoutMs));
    }, init.timeoutMs);
    deadlineTimer.unref?.();

    const armInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        req.destroy();
        fail(inactivityError());
      }, INACTIVITY_TIMEOUT_MS);
      inactivityTimer.unref?.();
    };

    const onCallerAbort = () => {
      req.destroy();
      fail(new Error('Request aborted by caller'));
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (callerSignal?.aborted) {
      fail(new Error('Request aborted by caller'));
      return;
    }

    const headers: Record<string, string> = { ...init.headers };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
      headers['user-agent'] = 'artemis http_request';
    }
    let bodyBuf: Buffer | undefined;
    if (init.body !== undefined) {
      bodyBuf = Buffer.from(init.body, 'utf-8');
      headers['content-length'] = String(bodyBuf.byteLength);
    }

    let req: ReturnType<typeof httpRequestFn>;
    try {
      req = requestFn(
        url,
        {
          method: init.method,
          headers,
          agent: false, // fresh socket per request; never reuse a pooled socket
          // Pin DNS: connect ONLY to the pre-validated IP. Node's Happy Eyeballs
          // path calls lookup with `{ all: true }` and expects an array back.
          lookup: (
            _hostname: string,
            options: { all?: boolean },
            callback: (
              err: Error | null,
              address: string | Array<{ address: string; family: number }>,
              family?: number,
            ) => void,
          ) => {
            if (options?.all) {
              callback(null, [{ address: target.ip, family: target.family }]);
            } else {
              callback(null, target.ip, target.family);
            }
          },
        },
        (res) => {
          armInactivity(); // headers arrived; now watch body progress
          const chunks: Buffer[] = [];
          let total = 0;
          let tooLarge = false;
          res.on('data', (chunk: Buffer) => {
            armInactivity();
            if (tooLarge) return;
            total += chunk.byteLength;
            if (total > MAX_BODY_BYTES) {
              tooLarge = true;
              req.destroy();
              fail(bodyTooLargeError());
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (tooLarge) return;
            const respHeaders: Record<string, string | string[]> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v !== undefined) respHeaders[k.toLowerCase()] = v;
            }
            finish(() =>
              resolve({
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? '',
                headers: respHeaders,
                body: Buffer.concat(chunks),
              }),
            );
          });
          res.on('error', (err) => {
            req.destroy();
            fail(err instanceof Error ? err : new Error(String(err)));
          });
        },
      );
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    armInactivity(); // cover connect + time-to-first-byte stalls
    req.end(bodyBuf);
  });
}

/** Reject non-http(s) schemes and embedded credentials. Applied on EVERY hop (M1). */
function assertUsableUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpToolError(
      'invalid_scheme',
      `Only http: and https: URLs are allowed (got ${url.protocol})`,
    );
  }
  if (url.username || url.password) {
    throw new HttpToolError('invalid_url', 'URLs with embedded credentials are not allowed');
  }
}

function firstHeader(headers: Record<string, string | string[]>, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export interface HttpRequestAction {
  type: 'http_request';
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /**
   * Value for the `Authorization` header. Must be passed explicitly via this
   * field — `headers` may not contain `authorization` (rejected). Stripped on
   * cross-origin redirects.
   */
  authHeader?: string;
  body?: string;
  timeoutMs?: number;
}

/** Structured result for programmatic consumers (e.g. web_scraper). */
export interface HttpRawResult {
  status: number;
  statusText: string;
  /** Lower-cased header names, multi-values joined with ", ". */
  headers: Record<string, string>;
  bodyText: string;
  finalUrl: string;
}

function validateAction(action: HttpRequestAction): {
  method: string;
  startUrl: URL;
  headers: Record<string, string>;
  timeoutMs: number;
} {
  if (!action || typeof action !== 'object') {
    throw new HttpToolError('invalid_action', 'Action must be an object.');
  }
  if (action.method !== undefined && typeof action.method !== 'string') {
    throw new HttpToolError('invalid_method', '`method` must be a string.');
  }
  const method = (action.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new HttpToolError(
      'invalid_method',
      `Unsupported HTTP method: ${method}. Allowed: GET, POST, HEAD.`,
    );
  }
  if (typeof action.url !== 'string' || action.url.length === 0) {
    throw new HttpToolError('invalid_url', '`url` must be a non-empty string.');
  }
  let startUrl: URL;
  try {
    startUrl = new URL(action.url);
  } catch {
    throw new HttpToolError('invalid_url', `Invalid URL: ${action.url}`);
  }
  assertUsableUrl(startUrl);

  const rawHeaders = action.headers ?? {};
  if (typeof rawHeaders !== 'object' || rawHeaders === null || Array.isArray(rawHeaders)) {
    throw new HttpToolError('invalid_headers', '`headers` must be an object mapping strings to strings.');
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof v !== 'string') {
      throw new HttpToolError('invalid_headers', `\`headers["${k}"]\` must be a string.`);
    }
    if (k.toLowerCase() === 'authorization') {
      throw new HttpToolError(
        'invalid_headers',
        'Pass credentials via the explicit `authHeader` field, not `headers.authorization`.',
      );
    }
    headers[k] = v;
  }
  // Never let the caller smuggle hop-by-hop / spoofable / credential headers.
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (
      lk === 'host' ||
      lk === 'connection' ||
      lk === 'content-length' ||
      lk === 'transfer-encoding' ||
      lk === 'cookie' ||
      lk === 'proxy-authorization'
    ) {
      delete headers[k];
    }
  }
  if (action.authHeader !== undefined) {
    if (typeof action.authHeader !== 'string' || action.authHeader.length === 0) {
      throw new HttpToolError('invalid_headers', '`authHeader` must be a non-empty string.');
    }
    headers['authorization'] = action.authHeader;
  }
  if (action.body !== undefined && typeof action.body !== 'string') {
    throw new HttpToolError('invalid_body', '`body` must be a string.');
  }
  if (action.timeoutMs !== undefined && !Number.isInteger(action.timeoutMs)) {
    throw new HttpToolError('invalid_timeout', '`timeoutMs` must be an integer number of milliseconds.');
  }
  const timeoutMs = Math.min(Math.max(action.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), 120_000);
  return { method, startUrl, headers, timeoutMs };
}

function toHttpToolError(error: unknown): HttpToolError {
  if (error instanceof HttpToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  if (code === 'TIMEOUT' || code === 'INACTIVITY') {
    return new HttpToolError('timeout', message, true);
  }
  if (code === 'BODY_TOO_LARGE') {
    return new HttpToolError('body_too_large', message, false);
  }
  if (/^SSRF blocked/.test(message)) {
    return new HttpToolError('ssrf_blocked', message, false);
  }
  if (/DNS resolution/.test(message)) {
    return new HttpToolError('dns_failed', message, true);
  }
  if (/aborted/i.test(message)) {
    return new HttpToolError('aborted', message, false);
  }
  return new HttpToolError('request_failed', message, false);
}

/** Convert a thrown error into a ToolExecutionResult failure. */
export function httpToolErrorResult(action: unknown, error: unknown): ToolExecutionResult {
  const e = toHttpToolError(error);
  return {
    action: action as unknown as ToolExecutionResult['action'],
    ok: false,
    output: `http_request failed: ${e.message}`,
    error: { code: e.code, message: e.message, retryable: e.retryable },
  };
}

/**
 * Structured variant: throws HttpToolError on failure, returns the parsed
 * response on success (including non-2xx statuses — the caller decides).
 */
export async function executeHttpRequestRaw(
  action: HttpRequestAction,
  context: ToolExecutionContext,
): Promise<HttpRawResult> {
  const { method, startUrl, headers, timeoutMs } = validateAction(action);
  const dnsTimeoutMs = Math.min(DNS_TIMEOUT_MS, timeoutMs);

  let current = startUrl;
  let prevOrigin = startUrl.origin;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertUsableUrl(current); // M1: re-validate scheme + userinfo on every hop
    const target = await resolveAndPin(current.hostname, dnsTimeoutMs);

    const res = await fetchPinned(
      target,
      current,
      {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : action.body,
        timeoutMs,
      },
      context.abortSignal,
    );

    if (res.status >= 300 && res.status < 400) {
      const location = firstHeader(res.headers, 'location');
      if (!location) {
        throw new HttpToolError('bad_redirect', `Redirect (${res.status}) without Location header`);
      }
      if (hop === MAX_REDIRECTS) {
        throw new HttpToolError('too_many_redirects', `Too many redirects (>${MAX_REDIRECTS})`);
      }
      const next = new URL(location, current);
      // Strip Authorization when leaving the previous hop's origin.
      if (next.origin !== prevOrigin) {
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'authorization') delete headers[k];
        }
      }
      prevOrigin = next.origin;
      current = next;
      continue;
    }

    const flatHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      flatHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    return {
      status: res.status,
      statusText: res.statusText,
      headers: flatHeaders,
      bodyText: res.body.toString('utf-8'),
      finalUrl: current.toString(),
    };
  }
  throw new HttpToolError('request_failed', 'No response received');
}

export async function executeHttpRequest(
  action: HttpRequestAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  try {
    const raw = await executeHttpRequestRaw(action, context);
    const ok = raw.status >= 200 && raw.status < 300;
    const summary = [
      `HTTP ${raw.status} ${raw.statusText}`,
      `URL: ${raw.finalUrl}`,
      `Content-Type: ${raw.headers['content-type'] ?? '(none)'}`,
      `Body: ${Buffer.byteLength(raw.bodyText, 'utf-8')} bytes`,
      '',
      raw.bodyText,
    ].join('\n');
    return {
      action: action as unknown as ToolExecutionResult['action'],
      ok,
      output: summary,
      ...(ok
        ? {}
        : {
            error: {
              code: 'http_error',
              message: `HTTP ${raw.status}`,
              retryable: raw.status >= 500 || raw.status === 429,
            },
          }),
    };
  } catch (error) {
    return httpToolErrorResult(action, error);
  }
}
