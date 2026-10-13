/**
 * Approval gate for send_transaction (WP-16).
 * Its structure mirrors src/tools/phoneCall/approvalGate.ts.
 *
 * Rules:
 *  - The approvals module is loaded with a dynamic import. If it is absent, or
 *    it does not support the 'wallet_send' kind, the gate refuses. A send
 *    NEVER proceeds without an explicit approval.
 *  - The approval payload is exactly { chain, to, token, amount }. The approval
 *    is bound to this one payment, and the caller must send these same values
 *    (taken from the returned receipt).
 *  - The full recipient address is shown in the approval details. Only the
 *    summary line is shortened. This lets the user check every character and
 *    guards against address-poisoning lookalikes.
 */
import { createHash } from 'node:crypto';

import { asRecord, cleanText, displayToken, pickString, shortenAddress, t } from './walletConfig.js';

export interface WalletSendApprovalRequest {
  to: string;
  chain: string;
  token: string;
  amount: string;
  quoteId?: string | undefined;
  zh: boolean;
}

/** Exactly the fields the approval is bound to. */
export interface WalletSendApprovalPayload {
  chain: string;
  to: string;
  token: string;
  amount: string;
}

export interface WalletSendApprovalReceipt {
  approvalId?: string | undefined;
  payload: WalletSendApprovalPayload;
  /** sha256 over the canonical JSON of `payload`, so the gateway can verify the binding. */
  payloadDigest: string;
  quoteId?: string | undefined;
  approvedAt: string;
}

export type WalletSendGateResult =
  | { ok: true; receipt: WalletSendApprovalReceipt }
  | { ok: false; output: string; error: { code: string; message: string; retryable: boolean } };

interface ApprovalRequestInput {
  payload: WalletSendApprovalPayload;
  title: string;
  summary: string;
  details: Record<string, string>;
  risk: 'high';
}

type RequireApprovalFn = (kind: string, input: ApprovalRequestInput) => unknown;
type IsApprovalKindFn = (kind: string) => unknown;

const APPROVAL_KIND = 'wallet_send';
// A variable specifier keeps compilation and startup working when the approvals
// module has not shipped in this build. In that case the gate refuses.
const APPROVALS_MODULE = '../../security/approvals.js';

/**
 * Load requireApproval from the approvals module.
 * Returns null when the module is missing, malformed, or does not support the
 * 'wallet_send' kind.
 */
export async function loadRequireApproval(): Promise<RequireApprovalFn | null> {
  let mod: Record<string, unknown> | null;
  try {
    mod = asRecord(await import(APPROVALS_MODULE));
  } catch {
    return null;
  }
  if (!mod) return null;

  const isApprovalKind = mod.isApprovalKind;
  const requireApproval = mod.requireApproval;
  if (typeof isApprovalKind !== 'function' || typeof requireApproval !== 'function') return null;

  let supported = false;
  try {
    supported = (isApprovalKind as IsApprovalKindFn)(APPROVAL_KIND) === true;
  } catch {
    supported = false;
  }
  return supported ? (requireApproval as RequireApprovalFn) : null;
}

interface ApprovalDecision {
  approved: boolean;
  approvalId?: string | undefined;
  reason?: string | undefined;
}

function interpretDecision(result: unknown): ApprovalDecision {
  if (result === true) return { approved: true };
  const record = asRecord(result);
  if (!record) return { approved: false };

  const status = pickString(record.status, record.decision)?.toLowerCase();
  const approved =
    record.approved === true ||
    record.ok === true ||
    status === 'approved' ||
    status === 'granted' ||
    status === 'allowed';
  const approvalId = pickString(record.approvalId, record.id, record.receiptId, record.receipt);
  const reason = pickString(record.reason, record.message);
  return {
    approved,
    approvalId: approvalId ? cleanText(approvalId, 128) : undefined,
    reason: reason ? cleanText(reason, 300) : undefined,
  };
}

function digestPayload(payload: WalletSendApprovalPayload): string {
  // Fixed key order gives a canonical serialization.
  const canonical = JSON.stringify({
    amount: payload.amount,
    chain: payload.chain,
    to: payload.to,
    token: payload.token,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function errorText(error: unknown): string {
  return cleanText(error instanceof Error ? error.message : String(error), 300);
}

/**
 * Ask the user to approve one specific payment.
 * Resolves with a receipt only on an explicit approval. Every other outcome
 * (module missing, kind unsupported, denial, error) is a refusal.
 */
export async function requestWalletSendApproval(
  request: WalletSendApprovalRequest,
): Promise<WalletSendGateResult> {
  const { zh } = request;

  const requireApproval = await loadRequireApproval();
  if (!requireApproval) {
    return {
      ok: false,
      output: t(
        zh,
        '审批系统不可用或不支持钱包转账审批（wallet_send），已拒绝发送。未发送任何交易。',
        'The approval system is unavailable or does not support wallet_send approvals, so the transfer was refused. No transaction was sent.',
      ),
      error: {
        code: 'approval_unavailable',
        message: 'Approval module missing or wallet_send kind unsupported; refusing to send without approval',
        retryable: false,
      },
    };
  }

  const payload: WalletSendApprovalPayload = {
    chain: request.chain,
    to: request.to,
    token: request.token,
    amount: request.amount,
  };
  const tokenLabel = displayToken(payload.token);

  const details: Record<string, string> = {
    [t(zh, '链', 'Chain')]: payload.chain,
    [t(zh, '收款地址（完整）', 'Recipient (full address)')]: payload.to,
    [t(zh, '代币', 'Token')]: payload.token,
    [t(zh, '数量', 'Amount')]: payload.amount,
  };
  if (request.quoteId) details[t(zh, '报价 ID', 'Quote ID')] = request.quoteId;
  details[t(zh, '提示', 'Notice')] = t(
    zh,
    '链上转账一经广播不可撤销。请逐字核对完整收款地址。',
    'On-chain transfers cannot be reversed once broadcast. Verify the full recipient address character by character.',
  );

  let decision: unknown;
  try {
    decision = await requireApproval(APPROVAL_KIND, {
      payload,
      title: t(zh, '确认钱包转账', 'Confirm wallet transfer'),
      summary: t(
        zh,
        `向 ${shortenAddress(payload.to)} 发送 ${payload.amount} ${tokenLabel}（${payload.chain}）`,
        `Send ${payload.amount} ${tokenLabel} to ${shortenAddress(payload.to)} on ${payload.chain}`,
      ),
      details,
      risk: 'high',
    });
  } catch (error) {
    const message = errorText(error);
    return {
      ok: false,
      output: t(
        zh,
        `审批流程出错，已拒绝发送，未发送任何交易：${message}`,
        `The approval flow failed, so the transfer was refused. No transaction was sent: ${message}`,
      ),
      error: { code: 'approval_failed', message, retryable: false },
    };
  }

  const interpreted = interpretDecision(decision);
  if (!interpreted.approved) {
    const reason = interpreted.reason;
    return {
      ok: false,
      output: t(
        zh,
        `用户未批准此次转账，未发送任何交易。${reason ? `原因：${reason}` : ''}`,
        `The transfer was not approved. No transaction was sent.${reason ? ` Reason: ${reason}` : ''}`,
      ),
      error: {
        code: 'approval_denied',
        message: reason ?? 'wallet_send approval was not granted',
        retryable: false,
      },
    };
  }

  return {
    ok: true,
    receipt: {
      approvalId: interpreted.approvalId,
      payload,
      payloadDigest: digestPayload(payload),
      quoteId: request.quoteId,
      approvedAt: new Date().toISOString(),
    },
  };
}