/**
 * Shared configuration, HTTP, validation and display helpers for the
 * engine-side wallet tools (WP-16).
 *
 * Registry note: this module is not a tool. It holds the shared helpers for
 * get_balance and swap_quote (permissionCategory 'read') and for
 * send_transaction (high risk, approval-gated).
 *
 * Configuration is read ONLY from the GLOBAL providers.json through
 * createGlobalProviderStore(). A workspace providers.json is never consulted.
 * The shape follows src/core/platformSpeech.ts:
 *
 *   { "wallet": { "provider": "platform", "enabled": true,
 *                 "baseUrl": "https://<gateway>/v1", "apiKey": "ak-…" } }
 *
 * A missing section, `enabled: false`, a non-platform provider or an invalid
 * baseUrl/apiKey all resolve to "wallet unavailable". Nothing throws past the
 * tool boundary.
 *
 * Security:
 *  - The apiKey is only ever placed in the Authorization header. It is never
 *    put into tool output, error messages or logs. Gateway messages are
 *    scrubbed of it before they are relayed.
 *  - Amounts are validated decimal strings. No float math is done on money.
 *  - Gateway-supplied display strings are stripped of control characters and
 *    length-capped before they reach the model context.
 */
import { createGlobalProviderStore } from '../../providers/store.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type WalletErrorCode =
  | 'insufficient_balance'
  | 'rate_limited'
  | 'unavailable'
  | 'unreachable'
  | 'unauthorized'
  | 'failed';

export interface WalletErrorOptions {
  status?: number | undefined;
  gatewayCode?: string | undefined;
  retryable?: boolean | undefined;
}

export class WalletConfigError extends Error {
  readonly code: WalletErrorCode;
  readonly status: number | undefined;
  readonly gatewayCode: string | undefined;
  readonly retryable: boolean;

  constructor(code: WalletErrorCode, message: string, options: WalletErrorOptions = {}) {
    super(message);
    this.name = 'WalletConfigError';
    this.code = code;
    this.status = options.status;
    this.gatewayCode = options.gatewayCode;
    this.retryable = options.retryable ?? (code === 'rate_limited' || code === 'unreachable');
  }
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/** Bilingual helper: returns the Chinese text when `zh` is true, else English. */
export function t(zh: boolean, zhText: string, enText: string): string {
  return zh ? zhText : enText;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readField(source: unknown, key: string): unknown {
  const record = asRecord(source);
  return record ? record[key] : undefined;
}

/** First non-empty (trimmed) string among the candidates. */
export function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** Strip control characters from untrusted display text and cap its length. */
export function cleanText(value: string, max = 80): string {
  // eslint-disable-next-line no-control-regex
  return truncate(value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim(), max);
}

function scrub(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join('[redacted]');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

/**
 * Derive the language flag. Looks for an explicit language hint on the action
 * or the execution context. Defaults to English (zh=false) when there is none.
 */
export function resolveZh(action: unknown, context: unknown): boolean {
  const candidates = [
    readField(action, 'language'),
    readField(context, 'language'),
    readField(context, 'locale'),
    readField(context, 'lang'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().toLowerCase().startsWith('zh');
    }
  }
  return false;
}

/** Best-effort abort signal from the execution context (if the engine provides one). */
export function contextSignal(context: unknown): AbortSignal | undefined {
  for (const key of ['signal', 'abortSignal']) {
    const value = readField(context, key);
    if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PlatformWalletConfig {
  /** Normalised gateway base URL, always ending in `/v1` (no trailing slash). */
  readonly baseUrl: string;
  readonly apiKey: string;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/**
 * Normalise the configured base URL. Requires https (plain http is accepted
 * only for loopback development gateways). Rejects embedded credentials.
 * Ensures the URL ends with `/v1` so endpoint paths below are `/wallet/...`.
 */
function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
  if (!secure) return null;
  if (url.username || url.password) return null;
  url.search = '';
  url.hash = '';
  let base = url.toString().replace(/\/+$/, '');
  if (!/\/v1$/.test(base)) base = `${base}/v1`;
  return base;
}

/**
 * Extract the platform wallet config from the loaded global provider store data.
 * Returns null when the wallet section is missing, disabled or invalid.
 */
export function walletConfigFromStore(data: unknown): PlatformWalletConfig | null {
  const root = asRecord(data);
  if (!root) return null;
  const section = asRecord(root.wallet) ?? asRecord(readField(root.data, 'wallet'));
  if (!section) return null;
  if (section.enabled === false) return null;
  if (section.provider !== undefined && section.provider !== 'platform') return null;

  const rawBaseUrl = section.baseUrl;
  const rawApiKey = section.apiKey;
  if (typeof rawBaseUrl !== 'string' || typeof rawApiKey !== 'string') return null;

  const apiKey = rawApiKey.trim();
  if (!apiKey || /\s/.test(apiKey)) return null;

  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!baseUrl) return null;

  return { baseUrl, apiKey };
}

/**
 * Resolve the platform wallet config from the GLOBAL providers.json.
 * Throws WalletConfigError('unavailable') when the wallet is not configured or
 * is disabled. Callers convert that into a tool result with walletFailure().
 */
export async function resolvePlatformWallet(): Promise<PlatformWalletConfig> {
  let loaded: unknown;
  try {
    const store = createGlobalProviderStore();
    loaded = await store.load();
  } catch {
    throw new WalletConfigError('unavailable', 'Could not read the global providers.json');
  }
  const config = walletConfigFromStore(loaded);
  if (!config) {
    throw new WalletConfigError(
      'unavailable',
      'Wallet provider is not configured or is disabled (global providers.json → "wallet")',
    );
  }
  return config;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_RELAYED_MESSAGE_CHARS = 500;

export interface WalletRequestOptions {
  method?: 'GET' | 'POST' | undefined;
  query?: Record<string, string> | undefined;
  body?: unknown;
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

function gatewayError(status: number, body: unknown, apiKey: string): WalletConfigError {
  const record = asRecord(body);
  const errorField = record?.error;
  const errorRecord = asRecord(errorField);
  const gatewayCode = pickString(errorRecord?.code, record?.code);
  const message =
    pickString(errorRecord?.message, typeof errorField === 'string' ? errorField : undefined, record?.message) ??
    `HTTP ${status}`;
  const relayed = truncate(scrub(message, apiKey), MAX_RELAYED_MESSAGE_CHARS);
  const code = (gatewayCode ?? '').toLowerCase();
  const options: WalletErrorOptions = { status, gatewayCode };

  if (status === 402 || code.includes('insufficient')) {
    return new WalletConfigError('insufficient_balance', relayed, options);
  }
  if (status === 401 || status === 403) return new WalletConfigError('unauthorized', relayed, options);
  if (status === 429) return new WalletConfigError('rate_limited', relayed, options);
  if (status === 503 || code.includes('disabled') || code.includes('unavailable')) {
    return new WalletConfigError('unavailable', relayed, options);
  }
  if (status === 502 || status === 504) return new WalletConfigError('unreachable', relayed, options);
  return new WalletConfigError('failed', relayed, options);
}

/**
 * Perform an authenticated JSON request against the wallet gateway.
 * `path` is relative to the `/v1` base, e.g. '/wallet/balances'.
 * Resolves with the parsed JSON body. Throws WalletConfigError otherwise.
 */
export async function walletRequest(
  config: PlatformWalletConfig,
  path: string,
  options: WalletRequestOptions = {},
): Promise<unknown> {
  const url = new URL(`${config.baseUrl}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    Accept: 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  const external = options.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    const cancelled = external?.aborted === true;
    const timedOut = controller.signal.aborted && !cancelled;
    const message = cancelled
      ? 'Wallet gateway request was cancelled'
      : timedOut
        ? `Wallet gateway did not respond within ${timeoutMs} ms`
        : `Wallet gateway request failed: ${scrub(errorMessage(error), config.apiKey)}`;
    throw new WalletConfigError('unreachable', message, { retryable: !cancelled });
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }

  if (text.length > MAX_RESPONSE_CHARS) {
    throw new WalletConfigError('failed', 'Wallet gateway response too large', { status: response.status });
  }

  let parsed: unknown;
  let parsedOk = false;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
      parsedOk = true;
    } catch {
      parsedOk = false;
    }
  }

  if (!response.ok) {
    throw gatewayError(response.status, parsedOk ? parsed : undefined, config.apiKey);
  }
  if (!parsedOk) {
    throw new WalletConfigError('failed', 'Wallet gateway returned a non-JSON response', {
      status: response.status,
    });
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

export interface WalletPlatformStatus {
  enabled: boolean;
  message?: string | undefined;
}

/**
 * GET /v1/wallet/platform → { enabled, message? }.
 * Throws WalletConfigError when the status cannot be determined. Callers that
 * move funds MUST treat a throw as "disabled" (fail closed).
 */
export async function checkWalletKillSwitch(
  config: PlatformWalletConfig,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<WalletPlatformStatus> {
  const raw = await walletRequest(config, '/wallet/platform', { timeoutMs: 10_000, signal: options.signal });
  const record = asRecord(raw);
  if (!record || typeof record.enabled !== 'boolean') {
    throw new WalletConfigError('failed', 'Wallet gateway returned a malformed platform status');
  }
  const message = pickString(record.message);
  return message
    ? { enabled: record.enabled, message: cleanText(scrub(message, config.apiKey), MAX_RELAYED_MESSAGE_CHARS) }
    : { enabled: record.enabled };
}

// ---------------------------------------------------------------------------
// Input validation (strict; amounts stay strings)
// ---------------------------------------------------------------------------

const CHAIN_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BECH32_ADDRESS_RE = /^[a-z]{1,15}1[02-9ac-hj-np-z]{6,90}$/;
const TOKEN_SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const AMOUNT_RE = /^(?:0|[1-9]\d{0,59})(?:\.\d{1,36})?$/;
const QUOTE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function normalizeChain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const chain = value.trim().toLowerCase();
  return CHAIN_RE.test(chain) ? chain : null;
}

export function isWalletAddress(value: string): boolean {
  return EVM_ADDRESS_RE.test(value) || BASE58_ADDRESS_RE.test(value) || BECH32_ADDRESS_RE.test(value);
}

/** Accepts EVM hex (0x + 40 hex), base58 (Solana/Tron style) or bech32 addresses. */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  return isWalletAddress(address) ? address : null;
}

/** A token is either a contract/mint address or a short ticker symbol. */
export function normalizeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (isWalletAddress(token)) return token;
  return TOKEN_SYMBOL_RE.test(token) ? token : null;
}

/** Positive plain decimal string ("1", "0.5", "1250.000001"). No exponents, no floats. */
export function normalizeAmount(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const amount = value.trim();
  if (!AMOUNT_RE.test(amount)) return null;
  return /[1-9]/.test(amount) ? amount : null;
}

/** undefined → not supplied; null → supplied but invalid. */
export function normalizeQuoteId(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const quoteId = value.trim();
  if (!quoteId) return undefined;
  return QUOTE_ID_RE.test(quoteId) ? quoteId : null;
}

export function addressesEqual(a: string, b: string): boolean {
  if (EVM_ADDRESS_RE.test(a) && EVM_ADDRESS_RE.test(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** `0x1234567890…` → `0x1234…abcd`. Short strings are returned unchanged. */
export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Symbols are shown as-is. Token addresses are shortened. */
export function displayToken(token: string): string {
  return isWalletAddress(token) ? shortenAddress(token) : token;
}

// ---------------------------------------------------------------------------
// Failure results
// ---------------------------------------------------------------------------

export interface WalletFailure {
  ok: false;
  output: string;
  error: { code: string; message: string; retryable: boolean };
}

export function failure(code: string, output: string, message: string, retryable = false): WalletFailure {
  return { ok: false, output, error: { code, message, retryable } };
}

export function invalidInput(zh: boolean, zhText: string, enText: string): WalletFailure {
  return failure('invalid_input', t(zh, `参数错误：${zhText}`, `Invalid input: ${enText}`), enText, false);
}

function describeCode(code: WalletErrorCode, zh: boolean): string {
  switch (code) {
    case 'insufficient_balance':
      return t(zh, '余额不足', 'Insufficient balance');
    case 'rate_limited':
      return t(zh, '请求过于频繁，请稍后再试', 'Rate limited by the wallet gateway; try again later');
    case 'unavailable':
      return t(
        zh,
        '钱包功能当前不可用（请检查全局 providers.json 中的 wallet 配置）',
        'Wallet tools are unavailable (check the "wallet" section of the global providers.json)',
      );
    case 'unreachable':
      return t(zh, '无法连接钱包网关', 'Could not reach the wallet gateway');
    case 'unauthorized':
      return t(
        zh,
        '钱包网关鉴权失败（请检查 wallet.apiKey）',
        'Wallet gateway rejected the credentials (check wallet.apiKey)',
      );
    case 'failed':
    default:
      return t(zh, '钱包请求失败', 'Wallet request failed');
  }
}

/** Convert any thrown error into a localized failure. Gateway messages are relayed verbatim. */
export function walletFailure(error: unknown, zh: boolean): WalletFailure {
  if (error instanceof WalletConfigError) {
    const label = describeCode(error.code, zh);
    const output = error.message ? `${label}${t(zh, '：', ': ')}${error.message}` : label;
    return failure(error.code, output, error.message || label, error.retryable);
  }
  const message = truncate(errorMessage(error), MAX_RELAYED_MESSAGE_CHARS);
  return failure('failed', `${describeCode('failed', zh)}${t(zh, '：', ': ')}${message}`, message, false);
}