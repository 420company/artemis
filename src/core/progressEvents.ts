/**
 * core/progressEvents.ts — structured progress that rides along with the
 * agent's info lines.
 *
 * runAgent reports progress through `onInfo(message)`, one line each (stderr
 * for `artemis execute`). A line that has a structured meaning (a tool call,
 * a text chunk, the plan, a sub-agent, token usage, a long tool's heartbeat)
 * also passes the event as onInfo's second argument, in the same call:
 *
 *   onInfo('[tool:read_file] running', { type: 'tool_start', callId, tool, detail })
 *
 * Sub-agents get a wrapped onInfo (`childInfo`) that prefixes their lines
 * (`[agent:<role>] `) and adds who they are to the event's `agents` path. A
 * wrapper that drops the second argument only loses the event: the line,
 * which hosts rely on (run trust reads every `[tool:…]` line), is unchanged.
 *
 * The host-facing format built from these events is services/streamJson.ts
 * (`execute --output-format stream-json`).
 */

import { scrubSecrets } from '../security/credentialStore.js';
import { scrubInternalNamesStrict } from '../utils/internalNames.js';
import type { AgentAction, TaskItem } from './types.js';

/** One sub-agent in an event's path (outermost first). */
export interface AgentRef {
  /** Unique within the run (`a1`, `a2`, …). */
  id: string;
  /** Its role code (researcher, reviewer, builder, …); hosts show their own words for it. */
  role: string;
}

export type ToolEndStatus = 'ok' | 'failed' | 'denied' | 'blocked' | 'error';

export type ProgressEvent =
  /** Model text as it streams; `profile` is the agent profile that wrote it (only `main` is the answer). */
  | { type: 'text_delta'; text: string; profile?: string; agents?: AgentRef[] }
  | { type: 'tool_start'; callId: string; tool: string; detail?: string; agents?: AgentRef[] }
  | {
      type: 'tool_end';
      callId: string;
      tool: string;
      status: ToolEndStatus;
      /** A short line about the outcome (a failure's reason, an exit code). */
      summary?: string;
      /** Files the call wrote or produced (workspace paths as the tool reported them). */
      artifacts?: string[];
      agents?: AgentRef[];
    }
  | { type: 'heartbeat'; callId?: string; tool: string; elapsedSeconds: number; overdue?: boolean; agents?: AgentRef[] }
  | { type: 'todo'; items: TodoEventItem[]; agents?: AgentRef[] }
  | { type: 'subagent_start'; agent: AgentRef; task?: string; agents?: AgentRef[] }
  | { type: 'subagent_end'; agent: AgentRef; ok: boolean; summary?: string; agents?: AgentRef[] }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      totalTokens?: number;
      agents?: AgentRef[];
    }
  /** A long job made of parts (a long video's segments): n of N done, or part n started. */
  | { type: 'segment'; job: string; index: number; total: number; status: 'started' | 'done' | 'failed'; label?: string; agents?: AgentRef[] };

export interface TodoEventItem {
  id: string;
  content: string;
  status: TaskItem['status'];
}

export type InfoSink = (message: string, event?: ProgressEvent) => void;

let agentSeq = 0;

/** A new id for a sub-agent of this process. */
export function nextAgentRef(role: string): AgentRef {
  agentSeq += 1;
  return { id: `a${agentSeq}`, role: String(role).slice(0, 40) };
}

/** The same event as seen from one level up: `agent` is added to the front of its path. */
export function withAgent(event: ProgressEvent, agent: AgentRef): ProgressEvent {
  return { ...event, agents: [agent, ...(event.agents ?? [])] } as ProgressEvent;
}

/**
 * The onInfo a sub-agent gets: its lines carry `prefix` (exactly as before),
 * its events carry `agent`.
 */
export function childInfo(parent: InfoSink | undefined, prefix: string, agent: AgentRef): InfoSink | undefined {
  if (!parent) return undefined;
  return (message, event) => parent(`${prefix} ${message}`, event ? withAgent(event, agent) : undefined);
}

const MAX_DETAIL = 160;

function clip(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

/** Token-looking values in a command or URL (a bearer header, an API key), masked. */
export function maskTokens(text: string): string {
  return text
    .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ••••')
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd|auth)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&'"]+)/gi, '$1••••')
    .replace(/\b(?:sk|ak|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g, '••••');
}

/** Text a host may show the owner: one line, bounded, no stored secret or token, no internal name (strict: paths too). */
export function userText(text: unknown, max = MAX_DETAIL): string | undefined {
  if (typeof text !== 'string') return undefined;
  const cleaned = clip(scrubInternalNamesStrict(maskTokens(scrubSecrets(text))), max);
  return cleaned || undefined;
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a tool call is about, in a few words: the file, the command, the site,
 * the query. Never the content written, a password typed or a message body.
 */
export function toolDetail(action: AgentAction): string | undefined {
  const a = action as Record<string, unknown> & { type: string };
  switch (a.type) {
    case 'read_file':
    case 'write_file':
    case 'insert_in_file':
    case 'replace_in_file':
    case 'view_image':
      return userText(a.path);
    case 'list_files':
    case 'search_files':
      return userText([a.pattern, a.query].filter((v) => typeof v === 'string' && v).join(' '));
    case 'run_command':
      return userText(a.command, 120);
    case 'search_web':
    case 'lookup_docs':
    case 'deep_research':
      return userText(a.query);
    case 'browser_navigate':
    case 'browser_tabs':
      return hostOf(a.url);
    case 'delegate_task':
      return userText(a.task);
    case 'transcribe_audio':
      return userText(a.inputPath);
    case 'mcp_call_tool':
      return userText(typeof a.toolName === 'string' ? a.toolName : undefined, 80);
    case 'todo':
      return undefined;
    default:
      return undefined;
  }
}

const ARTIFACT_EXT = /\.(?:png|jpe?g|webp|gif|svg|mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg|pdf|pptx|docx|xlsx|csv|md|html?)$/i;
const PATH_IN_TEXT = /(?:^|[\s"'`(：:=])((?:\/|\.{1,2}\/|[A-Za-z0-9_-]+\/)[^\s"'`()<>|]{1,400}?\.(?:png|jpe?g|webp|gif|svg|mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg|pdf|pptx|docx|xlsx|csv|md|html?))(?=$|[\s"'`)，。,;])/gim;
const MAX_ARTIFACTS = 10;

/** Files a finished call wrote or produced: its own path fields, then file paths its output names. */
export function toolArtifacts(action: AgentAction, ok: boolean, payload: Record<string, unknown>, output: string): string[] | undefined {
  if (!ok) return undefined;
  const found: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const v = value.trim();
    if (!v || v.length > 400 || found.includes(v) || found.length >= MAX_ARTIFACTS) return;
    found.push(v);
  };
  const type = (action as { type: string }).type;
  if (type === 'write_file' || type === 'insert_in_file' || type === 'replace_in_file') add(payload.path);
  if (Array.isArray(payload.files)) payload.files.forEach(add);
  // Generators and document tools name what they saved in their output (other tools' output only mentions files).
  if (/^(?:generate_|create_)/.test(type) || type === 'synthesize_speech' || type === 'deep_research') {
    for (const match of output.slice(0, 20_000).matchAll(PATH_IN_TEXT)) {
      if (ARTIFACT_EXT.test(match[1]!)) add(match[1]);
    }
  }
  return found.length ? found : undefined;
}

/** A failed call's reason or a command's exit code, for the step list. */
export function toolEndSummary(ok: boolean, payload: Record<string, unknown>): string | undefined {
  if (!ok) return userText(payload.reason, 200);
  if (typeof payload.exit === 'number') return `exit ${payload.exit}`;
  return undefined;
}

/** The todo list as events carry it. */
export function todoEventItems(items: readonly TaskItem[]): TodoEventItem[] {
  return items.slice(0, 50).map((item) => ({
    id: String(item.id).slice(0, 40),
    content: userText(item.content, 200) ?? '',
    status: item.status,
  }));
}
