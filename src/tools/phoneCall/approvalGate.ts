/**
 * The owner's approval of one phone call, the engine side.
 *
 * TODO(hard approvals): claude/hard-approval adds `requireApproval(kind,
 * request)` in src/security/approvals.ts. When it lands here:
 *  - add `phone_call` to APPROVAL_KINDS as an always-ask kind: NOT in
 *    CONFIGURABLE_APPROVAL_KINDS (there is no "always allow" for calls) and
 *    its mode fixed to `ask` like `confirmation`, plus its title/summary in
 *    describeApprovalNeed;
 *  - the owner's server then answers `approvalChannel: 'hard_approval'`
 *    (server/src/calls/service.ts, CallApprovalGate), and place_call stops
 *    the run here; after `--approve` the same tool call runs again, passes
 *    this gate once for the same payload, and the server's approvals service
 *    approves the call record (CallService.approve).
 * Until then the server answers `call_card`: the owner approves on the call
 * card in the web app (owner session only), and place_call waits for that
 * answer instead of stopping here. This adapter is only reached when the
 * server asked for a hard approval; without the module it refuses, so a
 * call never goes ahead on the agent's word.
 */
import type { ToolError } from '../types.js';

export interface PhoneCallApprovalRequest {
  callId: string;
  to: string;
  goal: string;
  maxMinutes?: number;
  zh: boolean;
}

export type PhoneCallGate = { ok: true } | { ok: false; output: string; error: ToolError };

type RequireApproval = (
  kind: string,
  request: { payload: unknown; title?: string; summary?: string; details?: Record<string, string>; risk?: 'low' | 'medium' | 'high' },
) => Promise<{ ok: true } | { ok: false; output: string; error: ToolError }>;

/** Resolved at run time, so this builds with or without the approvals module. */
const APPROVALS_MODULE = '../../security/approvals.js';

export async function loadRequireApproval(specifier = APPROVALS_MODULE): Promise<RequireApproval | undefined> {
  try {
    const mod = (await import(specifier)) as { requireApproval?: RequireApproval; isApprovalKind?: (k: unknown) => boolean };
    if (typeof mod.requireApproval !== 'function') return undefined;
    // The kind must be known to the approvals module, or a resume would be refused as tampered.
    if (typeof mod.isApprovalKind === 'function' && !mod.isApprovalKind('phone_call')) return undefined;
    return mod.requireApproval;
  } catch {
    return undefined;
  }
}

export async function requestPhoneCallApproval(request: PhoneCallApprovalRequest, load: () => Promise<RequireApproval | undefined> = () => loadRequireApproval()): Promise<PhoneCallGate> {
  const requireApproval = await load();
  if (!requireApproval) {
    const message = request.zh
      ? '需要用户批准这个电话，但这里没有可以批准的渠道，所以没有拨打。请告诉用户。'
      : 'This call needs the owner\'s approval and no approval channel is available here, so it was not placed. Tell the owner.';
    return { ok: false, output: message, error: { code: 'approval_unavailable', message, retryable: false } };
  }
  return requireApproval('phone_call', {
    // Exactly what is approved: this call record, this number, this purpose.
    payload: { callId: request.callId, to: request.to, goal: request.goal },
    title: request.zh ? `代你打电话给 ${request.to}` : `Phone ${request.to} on your behalf`,
    summary: request.zh ? `目的：${request.goal}` : `Purpose: ${request.goal}`,
    details: { to: request.to, goal: request.goal, ...(request.maxMinutes ? { maxMinutes: String(request.maxMinutes) } : {}), callId: request.callId },
    risk: 'high',
  });
}
