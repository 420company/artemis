/**
 * Approval gate for send_transaction (WP-16).
 * Its structure mirrors src/tools/phoneCall/approvalGate.ts.
 *
 * Rules:
 *  - The approvals module is loaded with a dynamic import. If it is absent, or
 *    it does not support the 'wallet_send' kind, the gate refuses. A send
 *    NEVER proceeds without an explicit approval.
 *  - Approval interpretation is fail-closed. The approvals module contract
 *    (src/security/approvals.ts) is:
 *      RequireApprovalResult = { ok: true } | { ok: false; output: string; error: ToolError }
 *    Only `{ ok: true }` means the user approved the exact payload. Every other
 *    shape is treated as "not approved".
 *  - The approval payload is exactly { chain, to, token, amount }. The approval
 *    is bound to this one payment, and the caller must send these same values
 *    (taken from the returned receipt).
 *  - After approval, the gate issues a short-lived HMAC-signed approval token
 *    that binds { chain, to, token, amount, quoteId?, nonce, exp }. The gateway
 *    must verify this token before executing any send.
 *  - The full recipient address is shown in the approval details. Only the
 *    summary line is shortened. This lets the user check every character and
 *    guards against address-poisoning lookalikes.
 */
import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
  /** base64url(canonicalJson) + '.' + hex(HMAC-SHA256(secret, canonicalJson)). */
  approvalToken: string;
  /** One-time nonce embedded in the token; the gateway stores it to prevent replay. */
  approvalNonce: string;
  /** Unix timestamp (seconds) after which the token is no longer valid. */
  approvalExpiresAt: number;
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

/** Approval token lifetime in seconds. */
const APPROVAL_TOKEN_TTL_SECONDS = 300;
/** Approval token format version. */
const APPROVAL_TOKEN_VERSION = 1;

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

export interface ApprovalDecision {
  approved: boolean;
  approvalId?: string | undefined;
  reason?: string | undefined;
}

function extractApprovalId(record: Record<string, unknown>): string | undefined {
  const approvalId = pickString(record.approvalId, record.id, record.receiptId);
  return approvalId ? cleanText(approvalId, 128) : undefined;
}

function extractReason(record: Record<string, unknown>): string | undefined {
  const reason = pickString(record.reason, record.message);
  return reason ? cleanText(reason, 300) : undefined;
}

/**
 * Fail-closed interpretation of the approvals module result.
 * Only `{ ok: true }` (with no denial signal) counts as approved. Any denial
 * signal wins over `ok: true`. Anything unrecognized is a refusal.
 */
export function interpretDecision(result: unknown): ApprovalDecision {
  const record = asRecord(result);
  if (!record) return { approved: false };

  const status = pickString(record.status, record.decision)?.toLowerCase() ?? '';
  const deniedSignal =
    record.approved === false ||
    record.ok === false ||
    /^(denied|deny|rejected|reject|cancelled|canceled|cancel|expired|invalid)$/.test(status);

  if (deniedSignal) {
    return {
      approved: false,
      approvalId: extractApprovalId(record),
      reason: extractReason(record),
    };
  }

  if (record.ok === true) {
    return {
      approved: true,
      approvalId: extractApprovalId(record),
      reason: extractReason(record),
    };
  }

  return { approved: false };
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

/** Serialize a flat object with keys sorted alphabetically (canonical form). */
function canonicalJson(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return JSON.stringify(sorted);
}

interface IssuedApprovalToken {
  token: string;
  nonce: string;
  exp: number;
}

function issueApprovalToken(
  approvalSecret: string,
  payload: WalletSendApprovalPayload,
  quoteId: string | undefined,
): IssuedApprovalToken {
  const nonce = randomBytes(16).toString('hex');
  const exp = Math.floor(Date.now() / 1000) + APPROVAL_TOKEN_TTL_SECONDS;
  const payloadObj: Record<string, unknown> = {
    v: APPROVAL_TOKEN_VERSION,
    chain: payload.chain,
    to: payload.to,
    token: payload.token,
    amount: payload.amount,
    ...(quoteId ? { quoteId } : {}),
    nonce,
    exp,
  };
  const canonical = canonicalJson(payloadObj);
  const mac = createHmac('sha256', approvalSecret).update(canonical).digest('hex');
  const token = `${Buffer.from(canonical, 'utf8').toString('base64url')}.${mac}`;
  return { token, nonce, exp };
}

/**
 * ============================================================================
 * GATEWAY REFERENCE IMPLEMENTATION
 * 移植到 artemis-online gateway/src/walletControl.ts
 * Port to artemis-online gateway/src/walletControl.ts
 * ============================================================================
 *
 * This function only covers steps 1 and 3 below. The gateway MUST implement
 * all five steps before executing a wallet send:
 *
 *  1. 验 mac / Verify the MAC: recompute HMAC-SHA256(secret, canonicalJson)
 *     and compare with timingSafeEqual (after checking buffer lengths).
 *  2. 防重放 / Prevent replay: the `nonce` must be stored gateway-side as
 *     one-time use (e.g. a store keyed by nonce with TTL >= exp). A nonce
 *     that has already been seen MUST be rejected.
 *  3. 查 exp / Check expiry: `exp` (unix seconds) must be > now.
 *  4. 比对 payload / Bind to the request: the token payload's chain, to,
 *     token and amount MUST exactly equal the request body's fields
 *     (strict string equality, no normalization that could hide a mismatch).
 *     If a quoteId is present in either, they must also match.
 *  5. 强制令牌 / Require the token: POST /v1/wallet/send MUST require an
 *     approvalToken. An apiKey alone MUST NOT be enough to authorize a send.
 *
 * Returns the decoded payload object on a valid, unexpired token, else null.
 */
export function verifyApprovalTokenForGateway(
  secret: string,
  token: string,
): Record<string, unknown> | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  if (typeof token !== 'string' || token.length === 0) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, givenMac] = parts as [string, string];
  if (!encodedPayload || !/^[0-9a-f]{64}$/.test(givenMac)) return null;

  let canonical: string;
  try {
    canonical = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!canonical) return null;

  const expectedMac = createHmac('sha256', secret).update(canonical).digest('hex');
  const expectedBuf = Buffer.from(expectedMac, 'hex');
  const givenBuf = Buffer.from(givenMac, 'hex');
  if (expectedBuf.length !== givenBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, givenBuf)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    return null;
  }
  const payload = asRecord(parsed);
  if (!payload) return null;
  if (payload.v !== APPROVAL_TOKEN_VERSION) return null;

  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (exp <= Math.floor(Date.now() / 1000)) return null;

  if (
    typeof payload.chain !== 'string' ||
    typeof payload.to !== 'string' ||
    typeof payload.token !== 'string' ||
    typeof payload.amount !== 'string' ||
    typeof payload.nonce !== 'string'
  ) {
    return null;
  }

  return payload;
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
  approvalSecret: string,
): Promise<WalletSendGateResult> {
  const { zh } = request;

  if (typeof approvalSecret !== 'string' || approvalSecret.length === 0) {
    return {
      ok: false,
      output: t(
        zh,
        '未配置审批签名密钥，无法签发审批令牌，已拒绝发送。未发送任何交易。',
        'No approval signing secret is configured, so an approval token cannot be issued and the transfer was refused. No transaction was sent.',
      ),
      error: {
        code: 'approval_unavailable',
        message: 'Approval signing secret missing; refusing to send without a signed approval token',
        retryable: false,
      },
    };
  }

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

  const issued = issueApprovalToken(approvalSecret, payload, request.quoteId);

  return {
    ok: true,
    receipt: {
      approvalId: interpreted.approvalId,
      payload,
      payloadDigest: digestPayload(payload),
      quoteId: request.quoteId,
      approvedAt: new Date().toISOString(),
      approvalToken: issued.token,
      approvalNonce: issued.nonce,
      approvalExpiresAt: issued.exp,
    },
  };
}
