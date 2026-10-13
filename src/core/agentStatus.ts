/**
 * core/agentStatus.ts — what the agent is doing right now, from what really
 * runs (tool calls, waits), never from the model's prose.
 *
 * The headless host reads one stderr line per change:
 *
 *   [agent-status] {"phase":"working","activity":"filling_form","detail":"example.com","at":"…","seq":7}
 *
 *   phase     working | waiting_user | waiting_approval | done
 *   activity  a fixed code (see AGENT_ACTIVITIES); the host turns it into
 *             words in the owner's language ("正在填写信息")
 *   detail    optional, only ever a web site's host name ("example.com")
 *
 * Codes rather than sentences keep tool and system names out of the user's
 * view and let each client word them in its own style.
 */

import type { AgentAction } from './types.js';

export const AGENT_STATUS_PREFIX = '[agent-status]';

export type AgentPhase = 'working' | 'waiting_user' | 'waiting_approval' | 'done';

export const AGENT_ACTIVITIES = [
  'thinking',
  'browsing',
  'reading_page',
  'filling_form',
  'clicking',
  'searching',
  'reading_files',
  'writing_files',
  'running_command',
  'generating_image',
  'generating_video',
  'using_service',
  'sending',
  'setting_up_server',
  'waiting_for_server',
  'checking',
  'getting_code',
  'waiting_handoff',
  'waiting_secret',
  'waiting_unlock',
  'waiting_confirmation',
  'waiting_payment_approval',
  'waiting_send_approval',
  'waiting_publish_approval',
  'working',
  'done',
] as const;

export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];

export interface AgentStatus {
  phase: AgentPhase;
  activity: AgentActivity;
  /** A web site's host name, when the activity is about a page. */
  detail?: string;
}

export interface AgentStatusEvent extends AgentStatus {
  at: string;
  seq: number;
}

/** An http(s) URL's host name (without "www."), or undefined. Nothing else of the URL is ever shown. */
export function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return undefined;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9.-]{1,253}$/.test(host) && host.includes('.') ? host : undefined;
  } catch {
    return undefined;
  }
}

const SEND_WORDS = /send|post|reply|publish|tweet|message|mail|email|invite|share/i;

/** The status a tool call puts the agent in while it runs (undefined: no change). */
export function statusForAction(action: Pick<AgentAction, 'type'> & Record<string, unknown>): AgentStatus | undefined {
  const type = String(action.type);
  switch (type) {
    case 'post_update':
    case 'todo':
      // Talking to the user and updating the plan are not activities of their own.
      return undefined;
    case 'browser_navigate': {
      const detail = hostOf(action.url);
      return { phase: 'working', activity: 'browsing', ...(detail ? { detail } : {}) };
    }
    case 'browser_tabs': {
      const detail = hostOf(action.url);
      return { phase: 'working', activity: 'browsing', ...(detail ? { detail } : {}) };
    }
    case 'browser_type':
    case 'browser_form_input':
      return { phase: 'working', activity: 'filling_form' };
    case 'browser_click':
      return { phase: 'working', activity: 'clicking' };
    case 'browser_extract_text':
    case 'browser_screenshot':
    case 'browser_wait_for':
    case 'browser_evaluate':
    case 'browser_console':
    case 'browser_requests':
    case 'view_image':
      return { phase: 'working', activity: 'reading_page' };
    case 'browser_request_handoff':
      // The owner takes the browser over (sign in, a code, a human check).
      return { phase: 'waiting_user', activity: 'waiting_handoff' };
    case 'request_user_confirmation':
      return { phase: 'waiting_approval', activity: 'waiting_confirmation' };
    case 'search_web':
    case 'deep_research':
    case 'lookup_docs':
      return { phase: 'working', activity: 'searching' };
    case 'list_files':
    case 'read_file':
    case 'read_document':
    case 'search_files':
      return { phase: 'working', activity: 'reading_files' };
    case 'write_file':
    case 'insert_in_file':
    case 'replace_in_file':
    case 'apply_patch':
      return { phase: 'working', activity: 'writing_files' };
    case 'run_command':
      return { phase: 'working', activity: 'running_command' };
    case 'generate_image':
      return { phase: 'working', activity: 'generating_image' };
    case 'generate_video':
    case 'generate_long_video':
      return { phase: 'working', activity: 'generating_video' };
    case 'bridge_send_image':
    case 'bridge_send_video':
      return { phase: 'working', activity: 'sending' };
    case 'server_setup': {
      const act = String(action.action ?? '');
      if (act === 'wait_ready') return { phase: 'working', activity: 'waiting_for_server' };
      if (act === 'verify') return { phase: 'working', activity: 'checking' };
      if (act === 'forget_host_key') return { phase: 'waiting_approval', activity: 'waiting_confirmation' };
      if (act === 'list_servers' || act === 'record_server') return undefined;
      return { phase: 'working', activity: 'setting_up_server' };
    }
    case 'get_verification_code':
      return { phase: 'working', activity: 'getting_code' };
    case 'mcp_call_tool': {
      const tool = String(action.toolName ?? action.tool_name ?? action.tool ?? action.name ?? '');
      return { phase: 'working', activity: SEND_WORDS.test(tool) ? 'sending' : 'using_service' };
    }
    default:
      if (type.startsWith('mcp__')) return { phase: 'working', activity: SEND_WORDS.test(type) ? 'sending' : 'using_service' };
      if (type.startsWith('browser_')) return { phase: 'working', activity: 'browsing' };
      return { phase: 'working', activity: 'working' };
  }
}

/** The waiting status for a hard approval of this kind (see the engine's approvals). */
export function statusForApprovalKind(kind: string | undefined): AgentStatus {
  switch (kind) {
    case 'payment':
      return { phase: 'waiting_approval', activity: 'waiting_payment_approval' };
    case 'outbound_send':
      return { phase: 'waiting_approval', activity: 'waiting_send_approval' };
    case 'publish':
      return { phase: 'waiting_approval', activity: 'waiting_publish_approval' };
    default:
      return { phase: 'waiting_approval', activity: 'waiting_confirmation' };
  }
}

/**
 * How a run that ends now leaves the owner: waiting for their OK when the
 * answer ends with a confirmation card (a structured card the app shows with
 * buttons, not prose), else done. A card about paying shows as waiting for a
 * payment approval.
 */
export function statusAtEnd(reply: string): AgentStatus {
  // Asked the owner for their own secret (a request_owner_secret card): waiting for them to type it.
  if (/```secret[ \t]*\n/.test(reply)) return { phase: 'waiting_user', activity: 'waiting_secret' };
  // A secret the owner holds the key to (你持钥匙): waiting for them to unlock it.
  if (/```unlock[ \t]*\n/.test(reply)) return { phase: 'waiting_user', activity: 'waiting_unlock' };
  const cards = [...reply.matchAll(/```confirm[ \t]*\n([\s\S]*?)\n?```/g)];
  const last = cards.at(-1);
  if (!last) return { phase: 'done', activity: 'done' };
  let text = '';
  try {
    const card = JSON.parse(last[1] ?? '{}') as Record<string, unknown>;
    text = [card.title, card.detail, card.confirm].filter((v) => typeof v === 'string').join(' ');
  } catch {
    return { phase: 'done', activity: 'done' };
  }
  return /付款|支付|扣款|付费|下单|购买|充值|\bpay|purchase|checkout|charge/i.test(text)
    ? { phase: 'waiting_approval', activity: 'waiting_payment_approval' }
    : /发送|发给|发出|寄出|\bsend\b/i.test(text)
      ? { phase: 'waiting_approval', activity: 'waiting_send_approval' }
      : { phase: 'waiting_approval', activity: 'waiting_confirmation' };
}

export function formatAgentStatusLine(event: AgentStatusEvent): string {
  return `${AGENT_STATUS_PREFIX} ${JSON.stringify(event)}`;
}

export interface ToolActivityEvent {
  phase: 'start' | 'end';
  /** Identifies one call, so parallel calls end separately. */
  callId: string;
  action: Pick<AgentAction, 'type'> & Record<string, unknown>;
  ok?: boolean;
}

/**
 * Turns tool starts and ends into status lines: the most recently started
 * tool that is still running wins; with none running the agent is thinking.
 * A line is written only when the status changes.
 */
export class AgentStatusReporter {
  private readonly running = new Map<string, AgentStatus>();
  private last: AgentStatus | undefined;
  private seq = 0;
  private finished = false;

  constructor(
    private readonly emit: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): AgentStatus | undefined {
    return this.last;
  }

  /** The run started, or the model is choosing the next step. */
  thinking(): void {
    if (this.running.size === 0) this.set({ phase: 'working', activity: 'thinking' });
  }

  onToolActivity(event: ToolActivityEvent): void {
    if (this.finished) return;
    if (event.phase === 'start') {
      const status = statusForAction(event.action);
      if (!status) return;
      // Re-inserting keeps the map ordered by start time.
      this.running.delete(event.callId);
      this.running.set(event.callId, status);
      this.set(status);
      return;
    }
    if (!this.running.delete(event.callId)) return;
    const latest = [...this.running.values()].at(-1);
    this.set(latest ?? { phase: 'working', activity: 'thinking' });
  }

  /** The run is over: done, or stopped at something only the owner can answer. */
  finish(status: AgentStatus = { phase: 'done', activity: 'done' }): void {
    if (this.finished) return;
    this.running.clear();
    this.set(status);
    this.finished = true;
  }

  private set(status: AgentStatus): void {
    if (this.finished) return;
    if (this.last && this.last.phase === status.phase && this.last.activity === status.activity && this.last.detail === status.detail) return;
    this.last = status;
    this.seq += 1;
    this.emit(formatAgentStatusLine({ ...status, at: new Date(this.now()).toISOString(), seq: this.seq }));
  }
}
