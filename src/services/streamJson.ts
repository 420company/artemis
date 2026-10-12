/**
 * services/streamJson.ts — `artemis execute --output-format stream-json`.
 *
 * Stdout becomes a stream of JSON objects, one per line (NDJSON), each with
 * the format version `v` and a sequence number `seq`:
 *
 *   {"v":1,"seq":1,"type":"start","engine":"0.2.81"}
 *   {"v":1,"seq":2,"type":"todo","items":[{"id":"t1","content":"读配置","status":"in_progress"}]}
 *   {"v":1,"seq":3,"type":"tool_start","callId":"call_4","tool":"read_file","label":"读取文件","detail":"src/app.ts"}
 *   {"v":1,"seq":4,"type":"tool_end","callId":"call_4","tool":"read_file","status":"ok"}
 *   {"v":1,"seq":5,"type":"subagent_start","agent":{"id":"a1","role":"researcher"},"task":"…"}
 *   {"v":1,"seq":6,"type":"subagent_delta","agent":{"id":"a1","role":"researcher"},"text":"…"}
 *   {"v":1,"seq":7,"type":"tool_start","callId":"call_5","tool":"search_web","agent":{"id":"a1","role":"researcher"},…}
 *   {"v":1,"seq":8,"type":"subagent_end","agent":{"id":"a1","role":"researcher"},"ok":true}
 *   {"v":1,"seq":9,"type":"usage","inputTokens":1200,"outputTokens":300}
 *   {"v":1,"seq":10,"type":"heartbeat","tool":"generate_long_video","callId":"call_6","elapsedSeconds":60}
 *   {"v":1,"seq":11,"type":"segment","job":"long_video","index":2,"total":6,"status":"done"}
 *   {"v":1,"seq":12,"type":"approval_request","request":{…the [approval-request] object…}}
 *   {"v":1,"seq":13,"type":"text_delta","text":"Hel"}
 *   {"v":1,"seq":14,"type":"result","sessionId":"…","turns":3,"durationMs":5120,"reply":"…"}
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

import { describeToolForUser } from '../utils/internalNames.js';
import type { AgentRef, ProgressEvent } from '../core/progressEvents.js';

export const STREAM_JSON_VERSION = 1;
export const OUTPUT_FORMATS = ['text', 'stream-json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const APPROVAL_LINE = /^\[approval-request\] (\{.*\})\s*$/;

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
      // Stdout is the stream's alone: anything else written there goes to stderr.
      const stdout = process.stdout;
      const original = stdout.write.bind(stdout) as (chunk: string) => boolean;
      const stderrWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
      stdout.write = ((chunk: unknown, ...rest: unknown[]) => (stderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof stdout.write;
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
        if (agent) this.emit('subagent_delta', { agent, text: event.text });
        // Only the main agent's text is the answer; another profile's (a
        // review pass run without a sub-agent wrapper) is not shown.
        else if ((event.profile ?? 'main') === 'main') this.emit('text_delta', { text: event.text });
        return;
      case 'tool_start':
        this.emit('tool_start', {
          callId: event.callId,
          tool: event.tool,
          label: describeToolForUser(event.tool, this.locale),
          ...(event.detail ? { detail: event.detail } : {}),
          ...by,
        });
        return;
      case 'tool_end':
        this.emit('tool_end', {
          callId: event.callId,
          tool: event.tool,
          status: event.status,
          ...(event.summary ? { summary: event.summary } : {}),
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
        this.emit('todo', { items: event.items, ...by });
        return;
      case 'subagent_start': {
        // The started agent's parent is the innermost agent of the path, if any.
        this.emit('subagent_start', { agent: event.agent, ...(agent ? { parent: agent.id } : {}), ...(event.task ? { task: event.task } : {}) });
        return;
      }
      case 'subagent_end':
        this.emit('subagent_end', { agent: event.agent, ok: event.ok, ...(event.summary ? { summary: event.summary } : {}) });
        return;
      case 'usage': {
        const { type: _type, agents: _agents, ...counts } = event;
        this.emit('usage', { ...counts, ...by });
        return;
      }
      case 'segment': {
        const { type: _type, agents: _agents, ...segment } = event;
        this.emit('segment', { ...segment, ...by });
        return;
      }
      default:
        return;
    }
  }

  /** The run's end: what the closing panel says without the flag. */
  result(fields: { sessionId: string; turns: number; durationMs: number; reply: string; approval?: unknown; contextNotices?: string[] }): void {
    this.emit('result', {
      sessionId: fields.sessionId,
      turns: fields.turns,
      durationMs: fields.durationMs,
      reply: fields.reply,
      ...(fields.approval ? { approval: fields.approval } : {}),
      ...(fields.contextNotices?.length ? { contextNotices: fields.contextNotices } : {}),
    });
  }
}
