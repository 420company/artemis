/**
 * send_transaction — Engine-side wallet tool (WP-16)
 *
 * HIGH-RISK: this tool moves real funds via the artemis-online gateway
 * (`POST /v1/wallet/send`). Once submitted, an on-chain transfer is
 * irreversible.
 *
 * permissionCategory: 'execute'
 * approval kind:      'wallet_send' — the user's approval is bound to the exact
 *                     {chain, to, token, amount} tuple (plus quoteId if given).
 *                     The values sent to the gateway are the very same values
 *                     that were shown to and approved by the user; nothing is
 *                     re-read or mutated between approval and submission.
 *
 * Flow:
 *   1. resolvePlatformWallet() → if not configured, return "unavailable".
 *   2. checkWalletKillSwitch() → if disabled (or state cannot be verified), refuse.
 *   3. requestWalletSendApproval({to, chain, token, amount, quoteId, zh})
 *      → if not approved, return the gate's result verbatim.
 *   4. POST /v1/wallet/send { chain, to, token, amount, quoteId } with Bearer auth,
 *      parse { txHash?, status?, message? }, report the result.
 *
 * Error policy: gateway messages are relayed (with the apiKey redacted);
 * retryable=false for HTTP 4xx, retryable=true for HTTP 5xx / network errors.
 * Note that any retry goes through this tool again and therefore requires a
 * fresh user approval — there is no silent automatic resubmission.
 *
 * Security notes:
 *   - The apiKey is only placed in the Authorization header; never logged or output.
 *   - Amounts are strings end-to-end; no floating-point math.
 *   - Addresses are shown truncated (0x1234…abcd) in human-readable output.
 */

import type { AgentAction } from '../../core/types.js';
import type { ToolExecutionContext, ToolExecutionResult } from '../types.js';
import {
  resolvePlatformWallet,
  checkWalletKillSwitch,
  WalletConfigError,
} from './walletConfig.js';
import { requestWalletSendApproval } from './approvalGate.js';

export const SEND_TRANSACTION_DESCRIPTION = [
  '【高风险】从平台钱包发送代币转账（真实资金、链上不可撤销）。',
  '每次调用都需要用户明确审批，审批内容绑定到确切的 链 / 收款地址 / 代币 / 数量。',
  '参数：chain（链名称）、to（收款地址）、token（代币符号或合约地址）、',
  'amount（数量，十进制字符串，例如 "0.25"）、quoteId（可选，来自 swap_quote 的报价 ID）。',
  '返回：交易哈希 txHash 与状态 status。仅在用户明确要求转账时使用。',
  '',
  '[HIGH-RISK] Send a token transfer from the platform wallet (real funds, irreversible).',
  'Every call requires explicit user approval bound to the exact chain/to/token/amount.',
  'Params: chain, to, token, amount (decimal string), quoteId (optional). Returns txHash and status.',
].join('\n');

type SendTransactionAction = Extract<AgentAction, { type: 'send_transaction' }>;

const SEND_TIMEOUT_MS = 60_000;
const DECIMAL_AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_RELAYED_MESSAGE_LENGTH = 500;
const FAILED_STATUSES = new Set(['failed', 'rejected', 'error', 'reverted', 'cancelled', 'canceled']);

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

function redact(text: string, apiKey: string): string {
  let out = text;
  if (apiKey.length > 0) {
    out = out.split(apiKey).join('[REDACTED]');
  }
  if (out.length > MAX_RELAYED_MESSAGE_LENGTH) {
    out = `${out.slice(0, MAX_RELAYED_MESSAGE_LENGTH)}…`;
  }
  return out;
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

function extractGatewayMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (isNonEmptyString(b.message)) return b.message;
  if (isNonEmptyString(b.error)) return b.error;
  if (b.error && typeof b.error === 'object') {
    const e = b.error as Record<string, unknown>;
    if (isNonEmptyString(e.message)) return e.message;
  }
  return undefined;
}

function parseJsonSafe(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function executeSendTransaction(
  action: SendTransactionAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const zh = deriveZh(context);

  const chain = typeof action.chain === 'string' ? action.chain.trim() : '';
  const to = typeof action.to === 'string' ? action.to.trim() : '';
  const token = typeof action.token === 'string' ? action.token.trim() : '';
  const amount = typeof action.amount === 'string' ? action.amount.trim() : '';
  const quoteId =
    typeof action.quoteId === 'string' && action.quoteId.trim().length > 0
      ? action.quoteId.trim()
      : undefined;

  // ---- input validation (before any approval prompt) ----------------------
  const missing: string[] = [];
  if (!chain) missing.push('chain');
  if (!to) missing.push('to');
  if (!token) missing.push('token');
  if (!amount) missing.push('amount');
  if (missing.length > 0) {
    const msg = t(
      zh,
      `缺少必要参数：${missing.join(', ')}`,
      `Missing required parameter(s): ${missing.join(', ')}`,
    );
    return fail(msg, 'WALLET_INVALID_INPUT', msg, false);
  }
  if (!DECIMAL_AMOUNT_RE.test(amount) || /^0(?:\.0+)?$/.test(amount)) {
    const msg = t(
      zh,
      `无效的数量 "${amount}"：必须是大于 0 的十进制数字字符串（例如 "0.25"）。`,
      `Invalid amount "${amount}": must be a positive decimal string (e.g. "0.25").`,
    );
    return fail(msg, 'WALLET_INVALID_INPUT', msg, false);
  }
  if (/\s/.test(to)) {
    const msg = t(zh, '收款地址格式无效（包含空白字符）。', 'Invalid recipient address (contains whitespace).');
    return fail(msg, 'WALLET_INVALID_INPUT', msg, false);
  }
  if (/^0x/i.test(to) && !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    const msg = t(
      zh,
      `收款地址格式无效：${truncateAddress(to)}（EVM 地址应为 0x 开头的 40 位十六进制）。`,
      `Invalid recipient address: ${truncateAddress(to)} (EVM addresses must be 0x + 40 hex chars).`,
    );
    return fail(msg, 'WALLET_INVALID_INPUT', msg, false);
  }

  // ---- 1. resolve config ----------------------------------------------
  let config: Awaited<ReturnType<typeof resolvePlatformWallet>>;
  try {
    config = await resolvePlatformWallet();
  } catch (err) {
    const detail =
      err instanceof WalletConfigError || err instanceof Error ? err.message : String(err);
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
  const apiKey = config.apiKey;

  // ---- 2. kill switch (fail closed) -----------------------------------
  try {
    const ks = await checkWalletKillSwitch(config);
    if (!ks.enabled) {
      const reason = ks.message ? redact(ks.message, apiKey) : undefined;
      const msg = t(
        zh,
        `钱包功能已被停用，拒绝转账${reason ? `：${reason}` : '。'}`,
        `Wallet functionality is disabled; refusing to send${reason ? `: ${reason}` : '.'}`,
      );
      return fail(msg, 'WALLET_DISABLED', msg, false);
    }
  } catch (err) {
    const detail = redact(err instanceof Error ? err.message : String(err), apiKey);
    const retryable = !(err instanceof WalletConfigError);
    const msg = t(
      zh,
      `无法确认钱包开关状态，出于安全考虑拒绝转账：${detail}`,
      `Could not verify wallet kill-switch state; refusing to send for safety: ${detail}`,
    );
    return fail(msg, 'WALLET_KILL_SWITCH_ERROR', msg, retryable);
  }

  // ---- 3. approval (bound to exact chain/to/token/amount) -------------
  const approval = await requestWalletSendApproval({ to, chain, token, amount, quoteId, zh });
  if (!approval.ok) {
    return approval as ToolExecutionResult;
  }

  // ---- 4. POST /v1/wallet/send ----------------------------------------
  // The payload uses exactly the values that were approved above.
  const payload: { chain: string; to: string; token: string; amount: string; quoteId?: string } = {
    chain,
    to,
    token,
    amount,
  };
  if (quoteId) payload.quoteId = quoteId;

  const url = `${config.baseUrl.replace(/\/+$/, '')}/v1/wallet/send`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let status: number;
  let bodyText: string;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    status = res.status;
    bodyText = await res.text();
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    const detail = aborted
      ? t(zh, `请求超时（${SEND_TIMEOUT_MS / 1000} 秒）`, `request timed out after ${SEND_TIMEOUT_MS / 1000}s`)
      : redact(err instanceof Error ? err.message : String(err), apiKey);
    const msg = t(
      zh,
      `转账请求失败（网络错误）：${detail}。交易可能已提交也可能未提交，重试前请先核实钱包余额或交易记录，避免重复转账。`,
      `Send request failed (network error): ${detail}. The transaction may or may not have been submitted — verify the wallet balance/history before retrying to avoid a duplicate transfer.`,
    );
    return fail(msg, 'WALLET_NETWORK_ERROR', msg, true);
  } finally {
    clearTimeout(timer);
  }

  const body = parseJsonSafe(bodyText);

  if (status < 200 || status >= 300) {
    const gatewayMsg = extractGatewayMessage(body) ?? (bodyText.trim() || `HTTP ${status}`);
    const relayed = redact(gatewayMsg, apiKey);
    const retryable = status >= 500;
    const msg = t(
      zh,
      `网关拒绝或未能完成转账（HTTP ${status}）：${relayed}`,
      `Gateway rejected or failed the transfer (HTTP ${status}): ${relayed}`,
    );
    return fail(msg, 'WALLET_GATEWAY_ERROR', msg, retryable);
  }

  const parsed =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const txHash = isNonEmptyString(parsed.txHash) ? parsed.txHash.trim() : undefined;
  const txStatus = isNonEmptyString(parsed.status) ? parsed.status.trim() : undefined;
  const gatewayMessage = isNonEmptyString(parsed.message)
    ? redact(parsed.message, apiKey)
    : undefined;

  if (txStatus && FAILED_STATUSES.has(txStatus.toLowerCase())) {
    const msg = t(
      zh,
      `转账未成功（状态：${txStatus}）${gatewayMessage ? `：${gatewayMessage}` : ''}${txHash ? `\n交易哈希：${txHash}` : ''}`,
      `Transfer did not succeed (status: ${txStatus})${gatewayMessage ? `: ${gatewayMessage}` : ''}${txHash ? `\nTx hash: ${txHash}` : ''}`,
    );
    return fail(msg, 'WALLET_SEND_FAILED', msg, false);
  }

  const toDisplay = truncateAddress(to);
  const tokenDisplay = truncateAddress(token);
  const lines: string[] = [
    t(zh, '转账已提交', 'Transfer submitted'),
    t(zh, `链：${chain}`, `Chain: ${chain}`),
    t(zh, `收款地址：${toDisplay}`, `Recipient: ${toDisplay}`),
    t(zh, `数量：${amount} ${tokenDisplay}`, `Amount: ${amount} ${tokenDisplay}`),
  ];
  if (quoteId) {
    lines.push(t(zh, `报价 ID：${quoteId}`, `Quote ID: ${quoteId}`));
  }
  lines.push(
    txHash
      ? t(zh, `交易哈希：${txHash}`, `Tx hash: ${txHash}`)
      : t(zh, '交易哈希：暂未返回（交易可能仍在排队处理）', 'Tx hash: not yet available (transaction may still be queued)'),
  );
  lines.push(t(zh, `状态：${txStatus ?? '未知'}`, `Status: ${txStatus ?? 'unknown'}`));
  if (gatewayMessage) {
    lines.push(t(zh, `网关消息：${gatewayMessage}`, `Gateway message: ${gatewayMessage}`));
  }

  return {
    ok: true,
    output: lines.join('\n'),
    data: { txHash: txHash ?? null, status: txStatus ?? 'unknown' },
  } as ToolExecutionResult;
}