/**
 * services/streamJson.ts — `artemis execute --output-format stream-json`.
 *
 * Stdout becomes a stream of JSON objects, one per line (NDJSON), each with
 * the format version `v` and a sequence number `seq`:
 *
 *   {"v":1,"seq":1,"type":"start","engine":"0.2.83","text":"reply"}
 *   {"v":1,"seq":2,"type":"todo","items":[{"id":"t1","content":"读配置","status":"in_progress"}]}
 *   {"v":1,"seq":3,"type":"tool_start","callId":"call_4","tool":"read_file","label":"读取文件","detail":"src/app.ts"}
 *   {"v":1,"seq":4,"type":"tool_end","callId":"call_4","tool":"read_file","status":"ok"}
 *   {"v":1,"seq":5,"type":"subagent_start","agent":{"id":"a1","role":"researcher"},"task":"…"}
 *   {"v":1,"seq":7,"type":"tool_start","callId":"call_5","tool":"search_web","agent":{"id":"a1","role":"researcher"},…}
 *   {"v":1,"seq":8,"type":"subagent_end","agent":{"id":"a1","role":"researcher"},"ok":true,"summary":"…"}
 *   {"v":1,"seq":9,"type":"usage","inputTokens":1200,"outputTokens":300}
 *   {"v":1,"seq":10,"type":"heartbeat","tool":"generate_long_video","callId":"call_6","elapsedSeconds":60}
 *   {"v":1,"seq":11,"type":"segment","job":"long_video","index":2,"total":6,"status":"done"}
 *   {"v":1,"seq":12,"type":"approval_request","request":{…the [approval-request] object…}}
 *   {"v":1,"seq":13,"type":"text_delta","text":"Hel"}
 *   {"v":1,"seq":14,"type":"text_reset"}
 *   {"v":1,"seq":15,"type":"result","sessionId":"…","turns":3,"durationMs":5120,"reply":"…"}
 *
 * `text_delta` is the answer as the user will read it, never the model's
 * raw output: of a JSON envelope (`{"reply":…,"actions":…}`) only the reply
 * string, decoded (core/replyStream.ts); `start` says so with
 * `"text":"reply"` (an engine without it streamed the raw output). A
 * `text_reset` says the text streamed so far is superseded: a later model
 * call of the run (after tools ran) started its own reply, and the deltas
 * that follow replace it. Best effort: the text since the last reset is
 * usually the result's reply, but not always (prose before an envelope, a
 * self-check's closing reply, native-tool rounds that are not streamed, a
 * repeated "reply" key); the result's reply is authoritative.
 *
 * The events come from the agent's info lines (core/progressEvents.ts): each
 * one is written in the same onInfo call that writes its stderr line, and
 * the stderr lines stay exactly as they are without the flag. Hosts that
 * check what a run did (artemis-online's run trust reads every `[tool:…]`
 * line, sub-agents' included) keep reading stderr; the stream is for showing
 * progress. Control lines (`[agent-update]`, `[agent-status]`,
 * `[browser-handoff]`, `[approval-result]`, `[approval-error]`, `CLI Error:`)
 * stay on stderr only. A hard approval request is mirrored as
 * `approval_request` with the very object its `[approval-request]` line
 * carries; it is still answered with `execute --approve/--deny`.
 *
 * Stdout is reserved for the stream: while it runs, everything else written
 * to stdout (console.log, a library printing) goes to stderr instead. The
 * closing panel is replaced by the `result` event. Unknown event types and
 * fields may be added within version 1; a breaking change bumps `v`.
 */

import { describeToolForUser, hasInternalProgressName, scrubInternalNamesStrict } from '../utils/internalNames.js';
import type { AgentRef, ProgressEvent } from '../core/progressEvents.js';

export const STREAM_JSON_VERSION = 1;
export const OUTPUT_FORMATS = ['text', 'stream-json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const APPROVAL_LINE = /^\[approval-request\] (\{.*\})\s*$/;
/** The longest reply a result carries (characters). */
export const MAX_RESULT_REPLY_CHARS = 2 * 1024 * 1024;
export const REDIRECTED_STDOUT_PREFIX = '[stdout]';

/** Bytes something else wrote to stdout, as prefixed stderr lines. */
export function redirectedStdout(chunk: unknown): string {
  const text = typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk);
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => `${REDIRECTED_STDOUT_PREFIX} ${line}\n`).join('');
}

/** Progress text, scrubbed once more on its way out (it is already, at its source). */
const clean = (text: unknown): string | undefined => (typeof text === 'string' && text ? scrubInternalNamesStrict(text) : undefined);
/** A step's detail (a path, a command): never rewritten, left out when it names an internal system. */
const detail = (text: unknown): string | undefined => (typeof text === 'string' && text && !hasInternalProgressName(text) ? text : undefined);

type Json = Record<string, unknown>;

export interface StreamJsonWriterOptions {
  /** Writes one line (default: the real stdout). */
  write?: (line: string) => void;
  locale?: 'zh-CN' | 'en';
}

export class StreamJsonWriter {
  private seq = 0;
  private readonly writeLine: (line: string) => void;
  private readonly locale: 'zh-CN' | 'en';
  private restoreStdout: (() => void) | undefined;

  constructor(options: StreamJsonWriterOptions = {}) {
    this.locale = options.locale ?? 'zh-CN';
    if (options.write) {
      this.writeLine = options.write;
    } else {
      // Stdout is the stream's alone: anything else written there goes to
      // stderr, each line prefixed, so it can never start a protocol line
      // (`[approval-request] …`, `[tool:…]`) the host reads there.
      const stdout = process.stdout;
      const original = stdout.write.bind(stdout) as (chunk: string) => boolean;
      const stderrWrite = process.stderr.write.bind(process.stderr) as (chunk: string) => boolean;
      stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        stderrWrite(redirectedStdout(chunk));
        const done = rest.find((arg) => typeof arg === 'function') as ((error?: Error | null) => void) | undefined;
        if (done) queueMicrotask(() => done());
        return true;
      }) as typeof stdout.write;
      this.restoreStdout = () => {
        stdout.write = original as typeof stdout.write;
      };
      this.writeLine = (line) => {
        original(line);
      };
    }
  }

  /** Puts stdout back (tests, and the end of the run). */
  close(): void {
    this.restoreStdout?.();
    this.restoreStdout = undefined;
  }

  /** Writes one event. */
  emit(type: string, fields: Json = {}): void {
    this.seq += 1;
    let line: string;
    try {
      line = JSON.stringify({ v: STREAM_JSON_VERSION, seq: this.seq, type, ...fields });
    } catch {
      return;
    }
    // JSON.stringify escapes newlines inside strings: one event is one line.
    this.writeLine(`${line}\n`);
  }

  start(fields: Json = {}): void {
    this.emit('start', fields);
  }

  /**
   * One info line of the run, with its event when it has one. Called for
   * every line, after the line itself went to stderr.
   */
  onInfo(message: string, event?: ProgressEvent): void {
    if (event) {
      this.fromEvent(event);
      return;
    }
    // The run's own (unprefixed) approval request: the same object, as an event.
    const approval = APPROVAL_LINE.exec(message);
    if (approval) {
      try {
        const request = JSON.parse(approval[1]!) as unknown;
        if (request && typeof request === 'object' && !Array.isArray(request)) this.emit('approval_request', { request });
      } catch {
        // Not JSON: stays a stderr line only.
      }
    }
  }

  private fromEvent(event: ProgressEvent): void {
    const path = event.agents ?? [];
    const agent: AgentRef | undefined = path.length ? path[path.length - 1] : undefined;
    const by = agent ? { agent } : {};
    switch (event.type) {
      case 'text_delta':
        if (!event.text) return;
        // Only the main agent's text is the answer. A sub-agent's raw text is
        // never streamed (it is model output, chunked mid-word, and could name
        // internal systems); its scrubbed summary comes with subagent_end.
        // Another profile's text (a review pass without a sub-agent wrapper)
        // is not shown either.
        if (!agent && (event.profile ?? 'main') === 'main') this.emit('text_delta', { text: event.text });
        return;
      case 'text_reset':
        if (!agent && (event.profile ?? 'main') === 'main') this.emit('text_reset');
        return;
      case 'tool_start':
        this.emit('tool_start', {
          callId: event.callId,
          tool: event.tool,
          label: describeToolForUser(event.tool, this.locale),
          ...(detail(event.detail) ? { detail: detail(event.detail) } : {}),
          ...by,
        });
        return;
      case 'tool_end':
        this.emit('tool_end', {
          callId: event.callId,
          tool: event.tool,
          status: event.status,
          ...(clean(event.summary) ? { summary: clean(event.summary) } : {}),
          ...(event.artifacts?.length ? { artifacts: event.artifacts } : {}),
          ...by,
        });
        return;
      case 'heartbeat':
        this.emit('heartbeat', {
          tool: event.tool,
          elapsedSeconds: event.elapsedSeconds,
          ...(event.callId ? { callId: event.callId } : {}),
          ...(event.overdue ? { overdue: true } : {}),
          ...by,
        });
        return;
      case 'todo':
        this.emit('todo', { items: event.items.map((item) => ({ ...item, content: clean(item.content) ?? '' })), ...by });
        return;
      case 'subagent_start': {
        // The started agent's parent is the innermost agent of the path, if any.
        this.emit('subagent_start', { agent: event.agent, ...(agent ? { parent: agent.id } : {}), ...(clean(event.task) ? { task: clean(event.task) } : {}) });
        return;
      }
      case 'subagent_end':
        this.emit('subagent_end', { agent: event.agent, ok: event.ok, ...(clean(event.summary) ? { summary: clean(event.summary) } : {}) });
        return;
      case 'usage': {
        const { type: _type, agents: _agents, ...counts } = event;
        this.emit('usage', { ...counts, ...by });
        return;
      }
      case 'segment': {
        const { type: _type, agents: _agents, label, ...segment } = event;
        this.emit('segment', { ...segment, ...(clean(label) ? { label: clean(label) } : {}), ...by });
        return;
      }
      default:
        return;
    }
  }

  /**
   * The run's end: what the closing panel says without the flag. The
   * session and turn count come first in the line (a host that cannot take a
   * huge line can still read them); a reply over MAX_RESULT_REPLY_CHARS is
   * cut, with `replyTruncated`.
   */
  result(fields: { sessionId: string; turns: number; durationMs: number; reply: string; approval?: unknown; contextNotices?: string[] }): void {
    const truncated = fields.reply.length > MAX_RESULT_REPLY_CHARS;
    this.emit('result', {
      sessionId: fields.sessionId,
      turns: fields.turns,
      durationMs: fields.durationMs,
      reply: truncated ? fields.reply.slice(0, MAX_RESULT_REPLY_CHARS) : fields.reply,
      ...(truncated ? { replyTruncated: true } : {}),
      ...(fields.approval ? { approval: fields.approval } : {}),
      ...(fields.contextNotices?.length ? { contextNotices: fields.contextNotices } : {}),
    });
  }
}
