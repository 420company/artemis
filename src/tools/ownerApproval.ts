/**
 * tools/ownerApproval.ts — asking the owner before a step only they may allow.
 *
 * Uses the engine's hard-approval gate when it has one (security/approvals.ts:
 * a headless run stops, the owner answers a locked card); otherwise the
 * host's own confirmation (the interactive CLI); otherwise it refuses, so
 * the step never runs on the agent's word alone.
 */

export interface OwnerApprovalRequest {
  kind: 'confirmation';
  /** What the owner reads, in their language. */
  question: string;
  /** Exactly what will happen (part of the approval record). */
  payload: Record<string, unknown>;
}

export interface OwnerApprovalContext {
  requestUserConfirmation?: (request: { question: string }) => Promise<boolean>;
}

export async function requireOwnerApproval(ctx: OwnerApprovalContext, request: OwnerApprovalRequest): Promise<{ ok: true } | { ok: false; message: string }> {
  const gatePath = '../security/approvals.js';
  try {
    const mod = (await import(gatePath)) as {
      requireApproval?: (kind: string, req: { payload: unknown; details?: Record<string, string> }) => Promise<{ ok: boolean; output?: string; error?: { code?: string; message?: string } }>;
      inApprovalRun?: () => boolean;
    };
    if (typeof mod.requireApproval === 'function') {
      const gate = await mod.requireApproval(request.kind, { payload: request.payload, details: { question: request.question } });
      if (gate.ok) return { ok: true };
      // In a run, the run's gate decides. Outside any run it cannot ask
      // anyone; a host that asks the owner directly still may, unless the
      // policy denies it.
      const outsideRun = mod.inApprovalRun?.() === false && gate.error?.code === 'approval_unavailable';
      if (!outsideRun || !ctx.requestUserConfirmation) {
        return { ok: false, message: gate.output ?? gate.error?.message ?? 'Waiting for the owner to approve.' };
      }
    }
  } catch {
    // No approval gate in this engine.
  }
  if (ctx.requestUserConfirmation) {
    return (await ctx.requestUserConfirmation({ question: request.question })) ? { ok: true } : { ok: false, message: 'The owner did not approve it. Leave it as it is.' };
  }
  return { ok: false, message: 'This step needs the owner\'s approval, and nobody can approve it here. Tell the owner what happened and what you would do, then stop.' };
}
