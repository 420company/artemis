/**
 * swap_quote — Engine-side wallet tool (WP-16)
 *
 * QUOTE ONLY: this tool requests a swap price quote from the wallet gateway
 * (`/wallet/swap-quote`). It never signs, submits, or broadcasts a
 * transaction, and it moves no funds.
 *
 * permissionCategory: 'read'
 *
 * Flow:
 *   0. Strictly normalize inputs (chain / from / to / amount) via walletConfig
 *      helpers; any invalid value → WALLET_INVALID_INPUT.
 *   1. resolvePlatformWallet() → if not configured, return an "unavailable" result.
 *   2. checkWalletKillSwitch() → if disabled, refuse.
 *   3. walletRequest(config, '/wallet/swap-quote', { query }) — URL building,
 *      auth headers, timeout and error mapping are centralized there (no manual
 *      URL concatenation, which previously produced a duplicated version prefix).
 *   4. Validate that the response contains `amountOut`.
 *   5. Return a bilingual (Chinese-primary) summary; `data` holds the full quote.
 *
 * Security notes:
 *   - The apiKey is handled exclusively by walletRequest; this tool never reads,
 *     logs, or outputs it.
 *   - Amounts are handled strictly as strings; no floating-point math is done.
 *   - Addresses are shown truncated (0x1234…abcd) in human-readable output.
 */

import type { AgentAction } from '../../core/types.js';
import type { ToolExecutionContext, ToolExecutionResult } from '../types.js';
import {
  resolvePlatformWallet,
  checkWalletKillSwitch,
  WalletConfigError,
  normalizeChain,
  normalizeToken,
  normalizeAmount,
  walletRequest,
  walletFailure,
} from './walletConfig.js';

export const SWAP_QUOTE_DESCRIPTION = [
  '获取代币兑换报价（仅报价，不会发送任何交易，不会动用资金）。',
  '参数：chain（链名称，如 ethereum / base）、from（卖出代币符号或合约地址）、',
  'to（买入代币符号或合约地址）、amount（卖出数量，十进制字符串，例如 "1.5"）。',
  '返回：预计获得数量 amountOut、价格影响 priceImpactBps（如有）、报价过期时间 expiresAt、quoteId（如有）。',
  '如需实际执行转账，请使用 send_transaction（需要用户审批）。',
  '',
  'Get a token swap quote (QUOTE ONLY — no transaction is sent, no funds move).',
  'Params: chain, from, to, amount (decimal string). Returns amountOut, priceImpactBps (if any), expiresAt, quoteId (if any).',
].join('\n');

type SwapQuoteAction = Extract<AgentAction, { type: 'swap_quote' }>;

interface SwapQuoteResponse {
  amountOut: string;
  amountIn?: string;
  priceImpactBps?: number | string;
  expiresAt?: string | number;
  quoteId?: string;
  from?: string;
  to?: string;
  chain?: string;
  [key: string]: unknown;
}

const QUOTE_TIMEOUT_MS = 15_000;

function t(zh: boolean, zhText: string, enText: string): string {
  return zh ? zhText : enText;
}

function deriveZh(context: ToolExecutionContext): boolean {
  const c = context as unknown as Record<string, unknown> | null | undefined;
  if (!c || typeof c !== 'object') return false;
  if (typeof c.zh === 'boolean') return c.zh;
  const nested =
    c.config && typeof c.config === 'object' ? (c.config as Record<string, unknown>) : undefined;
  const candidates: unknown[] = [
    c.locale,
    c.language,
    c.lang,
    nested?.locale,
    nested?.language,
    nested?.lang,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim().toLowerCase().startsWith('zh');
    }
  }
  return false;
}

function truncateAddress(value: string): string {
  const v = value.trim();
  if (/^0x[0-9a-fA-F]{8,}$/.test(v)) {
    return `${v.slice(0, 6)}…${v.slice(-4)}`;
  }
  if (v.length > 16 && !/\s/.test(v)) {
    return `${v.slice(0, 6)}…${v.slice(-4)}`;
  }
  return v;
}

function fail(output: string, code: string, message: string, retryable: boolean): ToolExecutionResult {
  return {
    ok: false,
    output,
    error: { code, message, retryable },
  } as ToolExecutionResult;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function amountToString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function formatExpiresAt(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Heuristic: seconds vs milliseconds epoch.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return String(v);
  }
  return undefined;
}

function displayToken(value: string): string {
  return truncateAddress(value);
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function executeSwapQuote(
  action: SwapQuoteAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const zh = deriveZh(context);

  // ---- 0. strict input validation ---------------------------------------
  const chain = normalizeChain(action.chain);
  const from = normalizeToken(action.from);
  const to = normalizeToken(action.to);
  const amount = normalizeAmount(action.amount);

  const invalid: string[] = [];
  if (chain === null) invalid.push('chain');
  if (from === null) invalid.push('from');
  if (to === null) invalid.push('to');
  if (amount === null) invalid.push('amount');
  if (chain === null || from === null || to === null || amount === null) {
    const msg = t(
      zh,
      `参数缺失或无效：${invalid.join(', ')}（amount 必须是大于 0 的十进制数字字符串，例如 "1.5"）。`,
      `Missing or invalid parameter(s): ${invalid.join(', ')} (amount must be a positive decimal string, e.g. "1.5").`,
    );
    return fail(msg, 'WALLET_INVALID_INPUT', msg, false);
  }
  if (from.toLowerCase() === to.toLowerCase()) {
    const msg = t(zh, '卖出与买入代币不能相同。', 'The "from" and "to" tokens must differ.');
    return fail(msg, 'WALLET_INVALID_INPUT', msg, false);
  }

  // ---- 1. resolve config ----------------------------------------------
  let config: Awaited<ReturnType<typeof resolvePlatformWallet>>;
  try {
    config = await resolvePlatformWallet();
  } catch (err) {
    if (err instanceof WalletConfigError) {
      return walletFailure(err, zh) as ToolExecutionResult;
    }
    const detail = errorDetail(err);
    const msg = t(zh, `钱包配置错误：${detail}`, `Wallet configuration error: ${detail}`);
    return fail(msg, 'WALLET_CONFIG_ERROR', msg, false);
  }
  if (!config) {
    const msg = t(
      zh,
      '平台钱包不可用：尚未配置钱包网关（baseUrl / apiKey）。',
      'Platform wallet unavailable: wallet gateway (baseUrl / apiKey) is not configured.',
    );
    return fail(msg, 'WALLET_UNAVAILABLE', msg, false);
  }

  // ---- 2. kill switch ---------------------------------------------------
  try {
    const ks = await checkWalletKillSwitch(config);
    if (!ks.enabled) {
      const reason = isNonEmptyString(ks.message) ? ks.message : undefined;
      const msg = t(
        zh,
        `钱包功能已被停用，拒绝执行${reason ? `：${reason}` : '。'}`,
        `Wallet functionality is disabled; refusing${reason ? `: ${reason}` : '.'}`,
      );
      return fail(msg, 'WALLET_DISABLED', msg, false);
    }
  } catch (err) {
    if (err instanceof WalletConfigError) {
      return walletFailure(err, zh) as ToolExecutionResult;
    }
    const detail = errorDetail(err);
    const msg = t(
      zh,
      `无法确认钱包开关状态，出于安全考虑拒绝执行：${detail}`,
      `Could not verify wallet kill-switch state; refusing for safety: ${detail}`,
    );
    return fail(msg, 'WALLET_KILL_SWITCH_ERROR', msg, true);
  }

  // ---- 3. request quote -------------------------------------------------
  let body: unknown;
  try {
    body = await walletRequest(config, '/wallet/swap-quote', {
      query: { chain, from, to, amount },
      timeoutMs: QUOTE_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof WalletConfigError) {
      return walletFailure(err, zh) as ToolExecutionResult;
    }
    const detail = errorDetail(err);
    const msg = t(
      zh,
      `获取报价失败：${detail}`,
      `Failed to fetch swap quote: ${detail}`,
    );
    return fail(msg, 'WALLET_NETWORK_ERROR', msg, true);
  }

  // ---- 4. validate ------------------------------------------------------
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const msg = t(
      zh,
      '网关返回了无法解析的报价响应。',
      'Gateway returned an unparseable quote response.',
    );
    return fail(msg, 'WALLET_BAD_RESPONSE', msg, true);
  }
  const raw = body as Record<string, unknown>;
  const quoteSource =
    raw.quote && typeof raw.quote === 'object' && !Array.isArray(raw.quote)
      ? (raw.quote as Record<string, unknown>)
      : raw;
  const amountOut = amountToString(quoteSource.amountOut);
  if (!amountOut) {
    const msg = t(
      zh,
      '报价响应缺少 amountOut 字段。',
      'Quote response is missing the amountOut field.',
    );
    return fail(msg, 'WALLET_BAD_RESPONSE', msg, true);
  }

  const quote: SwapQuoteResponse = { ...quoteSource, amountOut };
  const amountIn = amountToString(quoteSource.amountIn) ?? amount;
  const priceImpact = quoteSource.priceImpactBps;
  const priceImpactStr =
    typeof priceImpact === 'number' && Number.isFinite(priceImpact)
      ? String(priceImpact)
      : typeof priceImpact === 'string' && priceImpact.trim().length > 0
        ? priceImpact.trim()
        : undefined;
  const expiresAt = formatExpiresAt(quoteSource.expiresAt);
  const quoteId = isNonEmptyString(quoteSource.quoteId) ? quoteSource.quoteId : undefined;

  // ---- 5. output --------------------------------------------------------
  const fromDisplay = displayToken(from);
  const toDisplay = displayToken(to);
  const lines: string[] = [
    t(zh, '兑换报价（仅报价，未发送任何交易）', 'Swap quote (QUOTE ONLY — no transaction sent)'),
    t(zh, `链：${chain}`, `Chain: ${chain}`),
    t(zh, `兑换：${fromDisplay} → ${toDisplay}`, `Pair: ${fromDisplay} → ${toDisplay}`),
    t(zh, `卖出数量：${amountIn} ${fromDisplay}`, `Amount in: ${amountIn} ${fromDisplay}`),
    t(zh, `预计获得：${amountOut} ${toDisplay}`, `Amount out: ${amountOut} ${toDisplay}`),
  ];
  if (priceImpactStr !== undefined) {
    lines.push(
      t(zh, `价格影响：${priceImpactStr} bps`, `Price impact: ${priceImpactStr} bps`),
    );
  }
  if (expiresAt) {
    lines.push(t(zh, `报价过期时间：${expiresAt}`, `Expires at: ${expiresAt}`));
  }
  if (quoteId) {
    lines.push(t(zh, `报价 ID：${quoteId}`, `Quote ID: ${quoteId}`));
  }

  return {
    ok: true,
    output: lines.join('\n'),
    data: quote,
  } as ToolExecutionResult;
}
