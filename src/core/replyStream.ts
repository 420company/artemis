/**
 * core/replyStream.ts — the part of a model's streamed output the user sees.
 *
 * The agent's model answers with the JSON response contract
 * (`{"reply":"…","done":true,"actions":[…],"tasks":[…],…}`, sometimes in a
 * ```json fence), or, when it ignores the contract, with plain text, maybe
 * followed by tool-call markup. The answer the run ends with is the parsed
 * `reply` (agent.ts tryParseEnvelope), so the raw deltas are never shown:
 * ReplyStreamFilter turns the raw deltas of one model call into deltas of
 * that reply, as they arrive.
 *
 *  - An envelope: only the value of its top-level "reply" string, decoded
 *    (`\n`, `\"`, `\\`, `\uXXXX`, surrogate pairs) wherever the chunks split
 *    it. Every other field (actions, tasks, claims, plan, done), a "reply"
 *    nested in an action, and anything after the envelope never show.
 *  - Plain text: as it is, without the whitespace at either end (the parsed
 *    reply is trimmed), up to the first tool-call markup or embedded
 *    envelope; nothing after that.
 *  - Tool-call markup only: nothing.
 *
 * Text that may still turn out to be the start of an envelope or of markup
 * is held until it is clear, so the concatenated output is the reply the
 * run ends with (not a draft that changes at the end). Pure; no I/O.
 */

/** Tags that start tool-call markup (agent.ts extractXmlToolCalls / stripXmlToolCalls). */
const TOOL_TAGS = ['call', 'invoke', 'action', 'actions', 'function', 'function_calls', 'toolcall', 'toolcalls', 'tool_calls'];
/** Keys that make a JSON object inside prose an envelope (agent.ts: an embedded one needs reply or actions). */
const ENVELOPE_KEYS = ['reply', 'actions'];

type Match = 'match' | 'partial' | 'none';

const isSpace = (char: string): boolean => char === ' ' || char === '\n' || char === '\r' || char === '\t';

/** `<tag` followed by a space, `>` or `/`, for a tool-call tag (`partial`: could still become one). */
function toolTagAt(text: string, at: number): Match {
  if (text[at] !== '<') return 'none';
  let partial = false;
  for (const tag of TOOL_TAGS) {
    const want = `<${tag}`;
    const have = text.slice(at, at + want.length + 1);
    if (have.length <= want.length) {
      if (want.startsWith(have)) partial = true;
      continue;
    }
    if (!have.startsWith(want)) continue;
    const next = have[want.length]!;
    if (isSpace(next) || next === '>' || next === '/') return 'match';
  }
  return partial ? 'partial' : 'none';
}

/** `{ "reply":` or `{ "actions":`, maybe after a ```json fence (`partial`: could still become one). */
function envelopeAt(text: string, at: number): Match {
  let i = at;
  if (text[i] === '`') {
    const fence = text.slice(i, i + 3);
    if (fence.length < 3) return '```'.startsWith(fence) ? 'partial' : 'none';
    if (fence !== '```') return 'none';
    i += 3;
    const lang = text.slice(i, i + 4).toLowerCase();
    if (lang === 'json') i += 4;
    else if (lang.length < 4 && 'json'.startsWith(lang)) return 'partial';
    else if (!isSpace(lang[0]!)) return 'none';
  }
  while (i < text.length && isSpace(text[i]!)) i += 1;
  if (i >= text.length) return 'partial';
  if (text[i] !== '{') return 'none';
  i += 1;
  while (i < text.length && isSpace(text[i]!)) i += 1;
  if (i >= text.length) return 'partial';
  if (text[i] !== '"') return 'none';
  i += 1;
  let key = '';
  while (i < text.length && text[i] !== '"') {
    key += text[i];
    i += 1;
    if (!ENVELOPE_KEYS.some((k) => k.startsWith(key))) return 'none';
  }
  if (i >= text.length) return 'partial';
  if (!ENVELOPE_KEYS.includes(key)) return 'none';
  i += 1;
  while (i < text.length && isSpace(text[i]!)) i += 1;
  if (i >= text.length) return 'partial';
  return text[i] === ':' ? 'match' : 'none';
}

function markupAt(text: string, at: number, envelopes: boolean): Match {
  const char = text[at];
  if (char === '<') return toolTagAt(text, at);
  if (envelopes && (char === '{' || char === '`')) return envelopeAt(text, at);
  return 'none';
}

/**
 * Prose as it streams: passed through up to the first tool-call markup (or,
 * for plain text, an embedded envelope), after which nothing is. `trim`:
 * whitespace at either end is never emitted (the start's is dropped, the
 * end's held until more text follows it), as the parsed reply is trimmed.
 * An envelope's reply is kept as written and only loses tool-call markup
 * (agent.ts buildEnvelopeFromParsedObject).
 */
class ProseGuard {
  private held = '';
  private started = false;
  private stopped = false;

  constructor(private readonly kind: 'text' | 'reply') {}

  private get trim(): boolean {
    return this.kind === 'text';
  }

  push(text: string): string {
    if (this.stopped || !text) return '';
    let buffer = this.held + text;
    this.held = '';
    if (this.trim && !this.started) {
      let i = 0;
      while (i < buffer.length && isSpace(buffer[i]!)) i += 1;
      buffer = buffer.slice(i);
      if (!buffer) return '';
      this.started = true;
    }
    let out = '';
    for (let i = 0; i < buffer.length; i += 1) {
      const found = markupAt(buffer, i, this.kind === 'text');
      if (found === 'match') {
        this.stopped = true;
        return this.release(out, true);
      }
      if (found === 'partial') {
        this.held = buffer.slice(i);
        return this.release(out, false);
      }
      out += buffer[i];
    }
    return this.release(out, false);
  }

  /** The end of the text: what was held only because it might have been markup. */
  end(): string {
    if (this.stopped) return '';
    const rest = this.held;
    this.held = '';
    if (!rest) return '';
    return this.trim ? rest.trimEnd() : rest;
  }

  /** Emits `out`, holding its trailing whitespace (trim) until something follows it. */
  private release(out: string, final: boolean): string {
    if (!this.trim) return out;
    const kept = out.trimEnd();
    if (!final) this.held = out.slice(kept.length) + this.held;
    return kept;
  }
}

/**
 * The top-level "reply" string of a JSON object as it streams, decoded. A
 * tolerant scanner, not a validator: it tracks nesting and strings only.
 */
class EnvelopeReply {
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** At depth 1: the next string is a key. */
  private expectKey = false;
  private collectingKey = false;
  private key = '';
  /** The key of the value about to start (after its colon), at depth 1. */
  private valueKey: string | undefined;
  private awaitingColon = false;
  private inReply = false;
  private replyDone = false;
  private closed = false;
  /** Inside the reply: an escape being read (`\u` and its hex digits). */
  private escape: string | undefined;
  /** A high surrogate waiting for its low half. */
  private high: string | undefined;

  push(text: string): string {
    let out = '';
    for (let i = 0; i < text.length && !this.closed; i += 1) {
      const char = text[i]!;
      if (this.inReply) {
        out += this.replyChar(char);
        continue;
      }
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
          if (this.collectingKey) this.key += char;
        } else if (char === '\\') {
          this.escaped = true;
        } else if (char === '"') {
          this.inString = false;
          if (this.collectingKey) {
            this.collectingKey = false;
            this.awaitingColon = true;
          }
        } else if (this.collectingKey) {
          this.key += char;
        }
        continue;
      }
      if (this.depth === 0) {
        // Before the object: only its opening brace counts.
        if (char === '{') {
          this.depth = 1;
          this.expectKey = true;
        }
        continue;
      }
      if (isSpace(char)) continue;
      if (this.depth === 1 && this.awaitingColon) {
        this.awaitingColon = false;
        if (char === ':') {
          this.valueKey = this.key;
          continue;
        }
      }
      if (this.depth === 1 && this.valueKey !== undefined) {
        const key = this.valueKey;
        this.valueKey = undefined;
        if (key === 'reply' && char === '"' && !this.replyDone) {
          this.inReply = true;
          continue;
        }
      }
      if (char === '"') {
        this.inString = true;
        if (this.depth === 1 && this.expectKey) {
          this.expectKey = false;
          this.collectingKey = true;
          this.key = '';
        }
        continue;
      }
      if (char === '{' || char === '[') {
        this.depth += 1;
        continue;
      }
      if (char === '}' || char === ']') {
        this.depth -= 1;
        if (this.depth <= 0) this.closed = true;
        continue;
      }
      if (char === ',' && this.depth === 1) this.expectKey = true;
    }
    return out;
  }

  /** A reply cut off mid-way (the stream ended): a held high surrogate goes out alone. */
  end(): string {
    const rest = this.high ?? '';
    this.high = undefined;
    return rest;
  }

  private replyChar(char: string): string {
    if (this.escape !== undefined) {
      if (this.escape === '') {
        if (char === 'u') {
          this.escape = 'u';
          return '';
        }
        this.escape = undefined;
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
        return this.unit(simple[char] ?? char);
      }
      if (!/[0-9a-fA-F]/.test(char)) {
        // Not an escape after all: keep what was written.
        const written = `\\${this.escape}${char}`;
        this.escape = undefined;
        return this.unit(written);
      }
      this.escape += char;
      if (this.escape.length < 5) return '';
      const code = Number.parseInt(this.escape.slice(1), 16);
      this.escape = undefined;
      return this.unit(String.fromCharCode(code));
    }
    if (char === '\\') {
      this.escape = '';
      return '';
    }
    if (char === '"') {
      this.inReply = false;
      this.replyDone = true;
      return this.end();
    }
    return this.unit(char);
  }

  /** One decoded piece: a high surrogate waits for the low one after it. */
  private unit(text: string): string {
    let out = '';
    if (this.high !== undefined) {
      const first = text.charCodeAt(0);
      out = this.high;
      this.high = undefined;
      if (first >= 0xdc00 && first <= 0xdfff) return out + text;
    }
    const last = text.charCodeAt(text.length - 1);
    if (text.length > 0 && last >= 0xd800 && last <= 0xdbff) {
      this.high = text.slice(-1);
      return out + text.slice(0, -1);
    }
    return out + text;
  }
}

type Mode = 'detect' | 'envelope' | 'text' | 'none';

/** One model call's raw deltas in, the deltas of its user-visible reply out. */
export class ReplyStreamFilter {
  private mode: Mode = 'detect';
  private pending = '';
  private envelope: EnvelopeReply | undefined;
  private prose: ProseGuard | undefined;

  push(delta: string): string {
    if (!delta) return '';
    switch (this.mode) {
      case 'envelope':
        return this.prose!.push(this.envelope!.push(delta));
      case 'text':
        return this.prose!.push(delta);
      case 'none':
        return '';
      default:
        return this.detect(delta);
    }
  }

  /** The model call ended: whatever was held only because more might follow. */
  end(): string {
    if (this.mode === 'detect') {
      const rest = this.pending;
      this.pending = '';
      if (!rest.trim()) return '';
      // Never completed as an envelope or markup start: it was text.
      this.mode = 'text';
      this.prose = new ProseGuard('text');
      return this.prose.push(rest) + this.prose.end();
    }
    if (this.mode === 'envelope') return this.prose!.push(this.envelope!.end()) + this.prose!.end();
    if (this.mode === 'text') return this.prose!.end();
    return '';
  }

  private detect(delta: string): string {
    this.pending += delta;
    const text = this.pending.trimStart();
    if (!text) return '';
    const first = text[0]!;
    if (first === '{') return this.startEnvelope(text);
    if (first === '`') {
      // A ```json fence around the envelope, or a code block that starts a plain reply.
      const fence = /^(`{1,3})([a-zA-Z]*)/.exec(text)!;
      const rest = text.slice(fence[0].length);
      if (fence[1]!.length < 3) {
        if (!rest) return '';
      } else if (!rest.trim()) {
        return '';
      } else if (rest.trimStart()[0] === '{' && /^(?:json)?$/i.test(fence[2]!)) {
        return this.startEnvelope(text.slice(text.indexOf('{')));
      }
    } else if (first === '<') {
      const tag = toolTagAt(text, 0);
      if (tag === 'partial') return '';
      if (tag === 'match') {
        // Tool-call markup only (or first): the reply is the prose left around it.
        this.mode = 'none';
        this.pending = '';
        return '';
      }
    }
    this.mode = 'text';
    this.pending = '';
    this.prose = new ProseGuard('text');
    return this.prose.push(text);
  }

  private startEnvelope(text: string): string {
    this.mode = 'envelope';
    this.pending = '';
    this.envelope = new EnvelopeReply();
    // The reply is the string as written (untrimmed); markup inside it is cut.
    this.prose = new ProseGuard('reply');
    return this.prose.push(this.envelope.push(text));
  }
}

/** The visible reply of a whole raw output at once (tests; the same as pushing it in one piece). */
export function visibleReplyOf(raw: string): string {
  const filter = new ReplyStreamFilter();
  return filter.push(raw) + filter.end();
}
