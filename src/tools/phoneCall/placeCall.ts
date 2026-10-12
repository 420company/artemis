/**
 * place_call — the agent phones someone on the owner's behalf: book a
 * table, ask a shop about stock or opening hours, follow up with customer
 * service.
 *
 * The engine never dials. On the hosted platform the owner's server keeps
 * the call (its record, the owner's approval, the transcript) and the
 * platform gateway places it through its telephony provider, with the
 * provider keys kept off this machine. This tool:
 *
 *   1. refuses what must never be called (emergency services) at once;
 *   2. hands the brief to the owner's server (the unlisted
 *      `phone_call_request` tool of its MCP endpoint); the server renders
 *      the approval card from the brief and waits for the owner;
 *   3. if the server works with hard approvals, stops the run at
 *      `requireApproval('phone_call', …)` (approvalGate.ts); otherwise it
 *      waits while the owner answers on the call card;
 *   4. follows the call to its end and returns the outcome (what was
 *      agreed, booked, learned) and the transcript.
 *
 * Interim status ("正在拨号…", "通话中 1:23", "已挂断") is on the owner's
 * call card, from the server; the run's heartbeat keeps a long call alive.
 */
import type { AgentAction } from '../../core/types.js';
import type { ToolExecutionContext, ToolExecutionResult } from '../types.js';
import { requestPhoneCallApproval } from './approvalGate.js';
import { callHostRpc, CallHostError, resolveCallHost, type CallHost } from './host.js';
import { quickNumberCheck } from './phone.js';

type PlaceCallAction = Extract<AgentAction, { type: 'place_call' }>;

/** How long the tool waits for the owner to approve before it hands back. */
export const APPROVAL_WAIT_MS = 15 * 60_000;
/** Each status poll waits this long at the server for a change. */
const POLL_SECONDS = 25;

const FINAL = new Set(['denied', 'expired', 'completed', 'busy', 'no_answer', 'failed', 'canceled']);

export const PLACE_CALL_DESCRIPTION = [
  'Phone a business or person on the owner\'s behalf (book a table, ask about stock or opening hours, follow up with customer service).',
  'Only when the owner asked for a call. The owner must approve each call on a card first; nothing is dialed before that.',
  'Write a precise brief: `goal`; `allowed_facts` (what you may tell them, e.g. the name for the booking); `forbidden` (what you must not share);',
  '`may_agree_to` (acceptable alternatives, e.g. "19:00-20:30"). Never include card numbers, passwords or ID numbers in any field.',
  'The callee is told first that an AI assistant is calling on the owner\'s behalf. Emergency numbers are never called.',
  'The tool waits for the approval and the call, then returns the outcome and the transcript; tell the owner the result in a sentence or two.',
].join(' ');

const t = (zh: boolean, a: string, b: string) => (zh ? a : b);

function fail(action: PlaceCallAction, code: string, message: string): ToolExecutionResult {
  return { action, ok: false, output: message, error: { code, message, retryable: false } };
}

/** Words for the codes the server and platform answer with (the model relays them). */
function refusalText(code: string, zh: boolean, fallback: string): string {
  const text: Record<string, [string, string]> = {
    emergency_number: ['紧急电话（报警、急救、火警等）不会代拨，请用户自己立刻拨打。', 'Emergency numbers are never called by the assistant; the owner must call them directly.'],
    premium_number: ['这是付费声讯或高风险号段，不会拨打。', 'This is a premium-rate or high-risk number; it is never called.'],
    invalid_number: ['号码看起来不对，请向用户确认带国家/地区代码的完整号码。', 'The number looks wrong; ask the owner for the full number with its country code.'],
    calls_unavailable: ['平台现在不提供代打电话（未开通、当前方案不含或暂时不可用）。请告诉用户。', 'Phone calls are not available on the platform right now (not enabled, not in the plan, or temporarily down). Tell the owner.'],
    approval_pending: ['这个对话里已经有一个电话在等用户批准，先等那个结果。', 'A call in this conversation is already waiting for the owner\'s approval; wait for it.'],
    too_many_requests: ['最近一小时请求的电话太多了，稍后再试。', 'Too many call requests in the last hour; try later.'],
    invalid_request: ['电话说明不完整或太长：', 'The call brief is incomplete or too long: '],
  };
  const pair = text[code];
  if (!pair) return fallback;
  return code === 'invalid_request' ? `${pair[zh ? 0 : 1]}${fallback}` : pair[zh ? 0 : 1];
}

interface CallView {
  callId: string;
  status: string;
  to?: string;
  approval?: string;
  approvalChannel?: 'call_card' | 'hard_approval';
  ownerReason?: string;
  liveState?: string;
  durationSeconds?: number;
  endReason?: string;
  outcome?: { result: string; summary: string; details: Record<string, string>; followUp?: string };
  error?: { code: string; message: string };
  transcript?: string;
  maxMinutes?: number;
}

function resultText(view: CallView, zh: boolean): string {
  const lines: string[] = [];
  if (view.status === 'denied') {
    lines.push(t(zh, `用户拒绝了这个电话${view.ownerReason ? `，理由：${view.ownerReason}` : ''}。不要再次发起，除非用户要求。`, `The owner declined the call${view.ownerReason ? ` (reason: ${view.ownerReason})` : ''}. Do not request it again unless they ask.`));
    return lines.join('\n');
  }
  if (view.status === 'expired') return t(zh, '用户没有及时批准，这个电话请求已失效。', 'The owner did not approve in time; the request expired.');
  if (view.error) lines.push(t(zh, `电话没有打出去：${refusalText(view.error.code, zh, view.error.message)}`, `The call was not made: ${refusalText(view.error.code, zh, view.error.message)}`));
  lines.push(t(zh, `通话状态：${view.status}${view.endReason ? `（${view.endReason}）` : ''}${view.durationSeconds ? `，时长 ${view.durationSeconds} 秒` : ''}。`, `Call status: ${view.status}${view.endReason ? ` (${view.endReason})` : ''}${view.durationSeconds ? `, ${view.durationSeconds} s` : ''}.`));
  if (view.outcome) {
    lines.push(t(zh, `结果：${view.outcome.result}。${view.outcome.summary}`, `Outcome: ${view.outcome.result}. ${view.outcome.summary}`));
    const details = Object.entries(view.outcome.details ?? {});
    if (details.length) lines.push(details.map(([k, v]) => `- ${k}: ${v}`).join('\n'));
    if (view.outcome.followUp) lines.push(t(zh, `需要用户跟进：${view.outcome.followUp}`, `For the owner to do: ${view.outcome.followUp}`));
  }
  if (view.transcript) lines.push(t(zh, `通话记录：\n${view.transcript}`, `Transcript:\n${view.transcript}`));
  lines.push(t(zh, '用一两句话把结果告诉用户；完整记录在用户的通话卡片里。不要编造对方没说过的确认。', 'Tell the owner the result in a sentence or two; the full transcript is on their call card. Never invent a confirmation the other side did not give.'));
  return lines.join('\n');
}

export interface PlaceCallDeps {
  host?: CallHost;
  rpc?: typeof callHostRpc;
  now?: () => number;
  approvalWaitMs?: number;
}

export async function executePlaceCall(action: PlaceCallAction, context: ToolExecutionContext, deps: PlaceCallDeps = {}): Promise<ToolExecutionResult> {
  const zh = (action.language ?? (context.locale === 'en' ? 'en' : 'zh')) !== 'en';
  const quick = quickNumberCheck(action.to);
  if (!quick.ok) return fail(action, quick.code, refusalText(quick.code, zh, quick.code));
  if (!action.goal?.trim()) return fail(action, 'invalid_request', t(zh, '缺少电话目的（goal）。', 'The call needs a goal.'));

  const host = deps.host ?? (await resolveCallHost(context.cwd));
  if (!host) {
    return fail(action, 'calls_unavailable', t(zh, '这里不能代打电话：只有在线平台上的 agent 才能打电话。请告诉用户。', 'Phone calls are not available here: only agents on the online platform can place calls. Tell the owner.'));
  }
  const rpc = deps.rpc ?? callHostRpc;
  const now = deps.now ?? Date.now;
  const signal = context.abortSignal;

  let view: CallView;
  try {
    view = (await rpc(host, 'phone_call_request', {
      to: action.to,
      goal: action.goal,
      ...(action.brief ? { brief: action.brief } : {}),
      language: zh ? 'zh' : 'en',
      ...(action.allowedFacts?.length ? { allowed_facts: action.allowedFacts } : {}),
      ...(action.forbidden?.length ? { forbidden: action.forbidden } : {}),
      ...(action.mayAgreeTo?.length ? { may_agree_to: action.mayAgreeTo } : {}),
      ...(action.calleeName ? { callee_name: action.calleeName } : {}),
      ...(action.onBehalfOf ? { on_behalf_of: action.onBehalfOf } : {}),
      ...(action.maxMinutes ? { max_minutes: action.maxMinutes } : {}),
      ...(context.sessionId ? { session_id: context.sessionId } : {}),
    }, { signal })) as unknown as CallView;
  } catch (err) {
    if (err instanceof CallHostError) return fail(action, err.code, refusalText(err.code, zh, err.message));
    return fail(action, 'calls_unavailable', t(zh, `没能联系到平台：${String(err)}`, `Could not reach the platform: ${String(err)}`));
  }

  if (view.approvalChannel === 'hard_approval') {
    const gate = await requestPhoneCallApproval({ callId: view.callId, to: view.to ?? action.to, goal: action.goal, maxMinutes: view.maxMinutes ?? action.maxMinutes, zh });
    if (!gate.ok) return { action, ok: false, output: gate.output, error: gate.error };
  }

  // Wait for the owner's answer, then for the call itself.
  const approvalDeadline = now() + (deps.approvalWaitMs ?? APPROVAL_WAIT_MS);
  const callBudgetMs = ((view.maxMinutes ?? action.maxMinutes ?? 10) + 5) * 60_000;
  let callDeadline: number | undefined;
  while (!FINAL.has(view.status)) {
    if (signal?.aborted) break;
    if (view.status === 'awaiting_approval' && now() > approvalDeadline) break;
    if (view.status !== 'awaiting_approval') callDeadline ??= now() + callBudgetMs;
    if (callDeadline !== undefined && now() > callDeadline) break;
    try {
      view = (await rpc(host, 'phone_call_status', { call_id: view.callId, wait_seconds: POLL_SECONDS }, { signal })) as unknown as CallView;
    } catch (err) {
      if (signal?.aborted) break;
      if (err instanceof CallHostError && err.code === 'not_found') return fail(action, 'not_found', t(zh, '找不到这个电话了。', 'The call is gone.'));
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  if (!FINAL.has(view.status)) {
    const pending = view.status === 'awaiting_approval';
    const message = pending
      ? t(zh, `电话（${view.callId}）还在等用户在通话卡片上批准。批准后会自动拨出，结束后结果会通知你。现在告诉用户需要他在卡片上批准，然后结束这一轮，不要重复发起。`, `The call (${view.callId}) is still waiting for the owner's approval on its card. Once approved it is placed automatically and you will be told the result. Tell the owner to approve it on the card and end this turn; do not request it again.`)
      : t(zh, `电话（${view.callId}）还在进行（${view.status}）。结束后结果会通知你；用户可以在卡片上看实时字幕或挂断。`, `The call (${view.callId}) is still going (${view.status}). You will be told the result when it ends; the owner can follow the captions or hang up on its card.`);
    return { action, ok: true, output: message, data: view };
  }
  const ok = view.status === 'completed' && view.outcome?.result !== 'not_achieved';
  return { action, ok: ok || view.status === 'denied' || view.status === 'expired' || view.status === 'no_answer' || view.status === 'busy', output: resultText(view, zh), data: view };
}
