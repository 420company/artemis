/**
 * send_transaction — Engine-side wallet tool (WP-16)
 *
 * HIGH-RISK: this tool moves real funds via the artemis-online gateway
 * (`POST /wallet/send`, issued through `walletRequest`). Once submitted, an
 * on-chain transfer is irreversible.
 *
 * permissionCategory: 'execute'
 * approval kind:      'wallet_send' — the user's approval is bound to the exact
 *                     {chain, to, token, amount} tuple (plus quoteId if given).
 *                     All values are strictly validated and normalized BEFORE
 *                     the approval prompt; the normalized values are what the
 *                     user sees AND what is sent to the gateway (what is shown
 *                     is what is sent — no spoofed display).
 *
 * Flow:
 *   0. Strict input validation via normalizeChain / normalizeAddress /
 *      normalizeToken / normalizeAmount / normalizeQuoteId (fail-closed).
 *   1. resolvePlatformWallet() → if not configured, return "unavailable".
 *   2. config.approvalSecret is required → if missing, refuse (fail-closed).
 *   3. checkWalletKillSwitch() → if disabled (or state cannot be verified), refuse.
 *   4. requestWalletSendApproval({to, chain, token, amount, quoteId, zh, approvalSecret})
 *      → if not approved, return the gate's result verbatim.
 *   5. walletRequest(config, '/wallet/send', POST { chain, to, token, amount,
 *      quoteId?, approval: { token, nonce, expiresAt, digest } }),
 *      parse { txHash?, status?, message? }, report the result.
 *
 * Error policy: walletRequest handles URL joining, timeouts, response-size
 * limits, non-JSON bodies, HTTP error mapping and secret scrubbing; its
 * WalletConfigError is converted via walletFailure().
 * Note that any retry goes through this tool again and therefore requires a
 * fresh user approval — there is no silent automatic resubmission.
 *
 * Security notes:
 *   - The apiKey is never logged or output (walletRequest scrubs it).
 *   - Amounts are strings end-to-end; no floating-point math.
 *   - Addresses are shown truncated (0x1234…abcd) in human-readable output.
 */

import type { AgentAction } from '../../core/types.js';
import type { ToolExecutionContext, ToolExecutionResult } from '../types.js';
import {
  resolvePlatformWallet,
  checkWalletKillSwitch,
  WalletConfigError,
  walletRequest,
  walletFailure,
  normalizeChain,
  normalizeAddress,
  normalizeToken,
  normalizeAmount,
  normalizeQuoteId,
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

function clip(text: string): string {
  return text.length > MAX_RELAYED_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_RELAYED_MESSAGE_LENGTH)}…`
    : text;
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

interface ApprovalReceipt {
  approvalToken: string;
  approvalNonce: string;
  approvalExpiresAt: string | number;
  payloadDigest: string;
}

/**
 * Extract the approval receipt from the gate result. Accepts either
 * `{ ok: true, receipt: {...} }` or the receipt fields on the result itself.
 * Returns null (→ fail-closed) if any field is missing or malformed.
 */
function extractReceipt(approval: unknown): ApprovalReceipt | null {
  if (!approval || typeof approval !== 'object') return null;
  const a = approval as Record<string, unknown>;
  const source =
    a.receipt && typeof a.receipt === 'object' ? (a.receipt as Record<string, unknown>) : a;
  const { approvalToken, approvalNonce, approvalExpiresAt, payloadDigest } = source;
  if (!isNonEmptyString(approvalToken)) return null;
  if (!isNonEmptyString(approvalNonce)) return null;
  if (!isNonEmptyString(payloadDigest)) return null;
  if (
    !(typeof approvalExpiresAt === 'number' && Number.isFinite(approvalExpiresAt)) &&
    !isNonEmptyString(approvalExpiresAt)
  ) {
    return null;
  }
  return {
    approvalToken,
    approvalNonce,
    approvalExpiresAt: approvalExpiresAt as string | number,
    payloadDigest,
  };
}

function retryHint(zh: boolean): string {
  return t(
    zh,
    '交易可能已提交也可能未提交，重试前请先核实钱包余额或交易记录，避免重复转账。重试需重新调用本工具并重新审批，不会自动重发。',
    'The transaction may or may not have been submitted — verify the wallet balance/history before retrying to avoid a duplicate transfer. A retry must go through this tool again with a fresh approval; nothing is resent automatically.',
  );
}

/** Append the retry hint to retryable failures produced by walletFailure(). */
function withRetryHint(result: ToolExecutionResult, zh: boolean): ToolExecutionResult {
  const r = result as unknown as Record<string, unknown>;
  const error =
    r.error && typeof r.error === 'object' ? (r.error as Record<string, unknown>) : undefined;
  if (error?.retryable === true && typeof r.output === 'string') {
    const hint = retryHint(zh);
    return {
      ...(r as object),
      output: `${r.output}\n${hint}`,
      error: {
        ...error,
        message: typeof error.message === 'string' ? `${error.message}\n${hint}` : error.message,
      },
    } as unknown as ToolExecutionResult;
  }
  return result;
}

export async function executeSendTransaction(
  action: SendTransactionAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const zh = deriveZh(context);

  // ---- 0. strict validation + normalization (before any approval prompt) ----
  const chain = normalizeChain(action.chain);
  const to = normalizeAddress(action.to);
  const token = normalizeToken(action.token);
  const amount = normalizeAmount(action.amount);
  const quoteIdProvided = action.quoteId !== undefined;
  const normalizedQuoteId = quoteIdProvided ? normalizeQuoteId(action.quoteId) : undefined;

  const invalid: string[] = [];
  if (chain === null) invalid.push('chain');
  if (to === null) invalid.push('to');
  if (token === null) invalid.push('token');
  if (amount === null) invalid.push('amount');
  if (quoteIdProvided && normalizedQuoteId === null) invalid.push('quoteId');
  if (chain === null || to === null || token === null || amount === null || normalizedQuoteId === null) {
    const msg = t(
      zh,
      `参数缺失或格式无效：${invalid.join(', ')}。请检查链名称、收款地址、代币以及数量（大于 0 的十进制字符串，例如 "0.25"）。`,
      `Missing or invalid parameter(s): ${invalid.join(', ')}. Check chain, recipient address, token, and amount (a positive decimal string, e.g. "0.25").`,
    );
    return fail(msg, 'WALLET_INVALID_INPUT', msg, false);
  }
  const quoteId: string | undefined = normalizedQuoteId ?? undefined;

  // ---- 1. resolve config ----------------------------------------------
  let config: Awaited<ReturnType<typeof resolvePlatformWallet>>;
  try {
    config = await resolvePlatformWallet();
  } catch (err) {
    if (err instanceof WalletConfigError) {
      return walletFailure(err, zh) as unknown as ToolExecutionResult;
    }
    const detail = clip(err instanceof Error ? err.message : String(err));
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

  // ---- 2. approval secret is mandatory (fail closed) ---------------------
  const approvalSecret = config.approvalSecret;
  if (!isNonEmptyString(approvalSecret)) {
    const msg = t(
      zh,
      '钱包配置错误：未配置 wallet.approvalSecret，无法签发审批令牌，出于安全考虑拒绝转账。请在配置中设置 wallet.approvalSecret 后重试。',
      'Wallet configuration error: wallet.approvalSecret is not configured, so approval tokens cannot be issued; refusing to send for safety. Set wallet.approvalSecret in the configuration and try again.',
    );
    return fail(msg, 'WALLET_CONFIG_ERROR', msg, false);
  }

  // ---- 3. kill switch (fail closed) -----------------------------------
  try {
    const ks = await checkWalletKillSwitch(config);
    if (!ks.enabled) {
      const reason = isNonEmptyString(ks.message) ? clip(ks.message) : undefined;
      const msg = t(
        zh,
        `钱包功能已被停用，拒绝转账${reason ? `：${reason}` : '。'}`,
        `Wallet functionality is disabled; refusing to send${reason ? `: ${reason}` : '.'}`,
      );
      return fail(msg, 'WALLET_DISABLED', msg, false);
    }
  } catch (err) {
    const detail = clip(err instanceof Error ? err.message : String(err));
    const retryable = !(err instanceof WalletConfigError);
    const msg = t(
      zh,
      `无法确认钱包开关状态，出于安全考虑拒绝转账：${detail}`,
      `Could not verify wallet kill-switch state; refusing to send for safety: ${detail}`,
    );
    return fail(msg, 'WALLET_KILL_SWITCH_ERROR', msg, retryable);
  }

  // ---- 4. approval (bound to exact normalized chain/to/token/amount) ----
  const approval = await requestWalletSendApproval(
    {
      to,
      chain,
      token,
      amount,
      quoteId,
      zh,
    },
    approvalSecret,
  );
  if (!approval.ok) {
    return approval as unknown as ToolExecutionResult;
  }
  const receipt = extractReceipt(approval);
  if (!receipt) {
    const msg = t(
      zh,
      '审批凭证缺失或无效，出于安全考虑拒绝转账。',
      'Approval receipt is missing or invalid; refusing to send for safety.',
    );
    return fail(msg, 'WALLET_APPROVAL_ERROR', msg, false);
  }

  // ---- 5. POST /wallet/send -------------------------------------------
  // The payload uses exactly the normalized values that were approved above.
  let body: unknown;
  try {
    body = await walletRequest(config, '/wallet/send', {
      method: 'POST',
      body: {
        chain,
        to,
        token,
        amount,
        ...(quoteId ? { quoteId } : {}),
        approval: {
          token: receipt.approvalToken,
          nonce: receipt.approvalNonce,
          expiresAt: receipt.approvalExpiresAt,
          digest: receipt.payloadDigest,
        },
      },
      timeoutMs: SEND_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof WalletConfigError) {
      return withRetryHint(walletFailure(err, zh) as unknown as ToolExecutionResult, zh);
    }
    const detail = clip(err instanceof Error ? err.message : String(err));
    const msg = t(
      zh,
      `转账请求失败（网络错误）：${detail}。${retryHint(true)}`,
      `Send request failed (network error): ${detail}. ${retryHint(false)}`,
    );
    return fail(zh ? msg : msg, 'WALLET_NETWORK_ERROR', msg, true);
  }

  const parsed =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const txHash = isNonEmptyString(parsed.txHash) ? parsed.txHash.trim() : undefined;
  const txStatus = isNonEmptyString(parsed.status) ? parsed.status.trim() : undefined;
  const gatewayMessage = isNonEmptyString(parsed.message) ? clip(parsed.message) : undefined;

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
