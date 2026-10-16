/**
 * core/replyStream.ts — the part of a model's streamed output the user sees.
 *
 * The agent's model answers with the JSON response contract
 * (`{"reply":"…","done":true,"actions":[…],"tasks":[…],…}`, sometimes in a
 * ```json fence), or, when it ignores the contract, with plain text, maybe
 * with tool-call markup. The answer the run ends with is the parsed `reply`
 * (agent.ts tryParseEnvelope), so the raw deltas are never shown:
 * ReplyStreamFilter turns the raw deltas of one model call into deltas of
 * that reply, as they arrive.
 *
 *  - An envelope: only the value of its top-level "reply" string, decoded
 *    (`\n`, `\"`, `\\`, `\uXXXX`, surrogate pairs) wherever the chunks split
 *    it. Every other field (actions, tasks, claims, plan, done), a "reply"
 *    nested in an action, and anything after the envelope never show. An
 *    object that turns out not to be an envelope (`{a, b} is a set.`, a
 *    JSON answer) is shown as the text it is once that is clear.
 *  - Plain text: as it is, without the whitespace at either end (the parsed
 *    reply is trimmed). A tool-call block (a complete `<invoke name="…">…
 *    </invoke>`, `<toolcall name="…">…</toolcall>`, … as agent.ts reads
 *    them) is left out; an envelope at the end of the text (after prose,
 *    maybe in a ```json fence) is never shown. A tag or a JSON object that
 *    turns out to be neither (`<call it done`, `<action android:name=…/>`,
 *    a JSON example followed by more prose) is shown once that is clear.
 *
 * Text that may still turn out to be an envelope or markup is held until it
 * is clear. Best effort: the run's final reply is authoritative (prose before
 * an envelope, for one, is streamed but not part of the reply). Pure; no I/O.
 */

/** The fields that make a JSON object the response envelope (agent.ts isAssistantEnvelopeLike). */
const ENVELOPE_KEYS = ['reply', 'actions', 'done', 'plan', 'tasks', 'claims'];

const isSpace = (char: string): boolean => char === ' ' || char === '\n' || char === '\r' || char === '\t';

function parsedObject(json: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isEnvelopeLike = (value: Record<string, unknown> | undefined): boolean =>
  !!value && ENVELOPE_KEYS.some((key) => key in value);

type Match = 'match' | 'partial' | 'none';

/**
 * `{ "<envelope key>":`, maybe after a ```json fence: where the object
 * starts (`brace`), or `partial` while it could still become one.
 */
function envelopeStart(text: string): { match: Match; brace: number } {
  const none = { match: 'none' as const, brace: -1 };
  const partial = { match: 'partial' as const, brace: -1 };
  let i = 0;
  if (text[0] === '`') {
    const fence = text.slice(0, 3);
    if (fence.length < 3) return '```'.startsWith(fence) ? partial : none;
    if (fence !== '```') return none;
    i = 3;
    const lang = text.slice(i, i + 4).toLowerCase();
    if (lang === 'json') i += 4;
    else if (lang.length < 4 && 'json'.startsWith(lang)) return partial;
    else if (!isSpace(lang[0]!)) return none;
  }
  while (i < text.length && isSpace(text[i]!)) i += 1;
  if (i >= text.length) return partial;
  if (text[i] !== '{') return none;
  const brace = i;
  i += 1;
  while (i < text.length && isSpace(text[i]!)) i += 1;
  if (i >= text.length) return partial;
  if (text[i] !== '"') return none;
  i += 1;
  let key = '';
  while (i < text.length && text[i] !== '"') {
    key += text[i];
    i += 1;
    if (!ENVELOPE_KEYS.some((k) => k.startsWith(key))) return none;
  }
  if (i >= text.length) return partial;
  if (!ENVELOPE_KEYS.includes(key)) return none;
  i += 1;
  while (i < text.length && isSpace(text[i]!)) i += 1;
  if (i >= text.length) return partial;
  return text[i] === ':' ? { match: 'match', brace } : none;
}

// ── Tool-call markup, as agent.ts extractXmlToolCalls / stripXmlToolCalls read it ──

/** Tags whose block is one call when it names its tool. */
const BLOCK_TAGS = ['call', 'invoke', 'action', 'function', 'toolcall'];
/** Bare tags around calls (`<function_calls>…</function_calls>`). */
const WRAPPER_TAGS = ['function_calls', 'toolcalls', 'tool_calls', 'actions'];
const TAGS = [...BLOCK_TAGS, ...WRAPPER_TAGS];
/** The attribute naming the tool, per tag. */
const TOOL_NAME: Record<string, RegExp> = {
  call: /\s(?:call|name|tool|tool_name)\s*=\s*["'][A-Za-z_][\w-]*["']/,
  invoke: /\sname\s*=\s*["'][A-Za-z_]\w*["']/,
  action: /\sname\s*=\s*["'][A-Za-z_]\w*["']/,
  function: /\sname\s*=\s*["'][A-Za-z_]\w*["']/,
  toolcall: /\sname\s*=\s*["'][A-Za-z_][\w-]*["']/,
};
/** An opening tag's attributes, all quoted. */
const ATTRIBUTES = /^(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*$/;
/** The same, still being written. */
const ATTRIBUTES_SO_FAR = /^(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*(?:\s+(?:[\w:.-]+(?:\s*(?:=\s*(?:"[^"]*|'[^']*)?)?)?)?)?\s*$/;
/** A call block inside a wrapper. */
const CALL_BLOCK = /<(call|invoke|action|function|toolcall)\s[^>]*>[\s\S]*?<\/\1>|<toolcall>[\s\S]*?<\/toolcall>/;
/** Longest opening tag waited for. */
const MAX_OPEN_TAG = 1000;

/**
 * What the text held from its start is: `wait` (not clear yet), `text`
 * (the first `length` characters are text), or `skip` (the first `length`
 * characters are never shown).
 */
type Verdict = { kind: 'wait' } | { kind: 'text'; length: number } | { kind: 'skip'; length: number };
const WAIT: Verdict = { kind: 'wait' };
const text = (length: number): Verdict => ({ kind: 'text', length });

/** Where to look for a candidate's end from (scanning a long candidate once, not at every delta). */
interface CandidateState {
  searchFrom: number;
  json?: { pos: number; depth: number; inString: boolean; escaped: boolean; closedAt?: number };
}

/** `held` starts with `<`: a complete tool-call block, or not. */
function toolMarkup(held: string, atEnd: boolean, state: CandidateState): Verdict {
  const name = /^<([A-Za-z_]*)/.exec(held)![1]!;
  const nameEnd = name.length + 1;
  if (nameEnd >= held.length) return !atEnd && TAGS.some((tag) => tag.startsWith(name)) ? WAIT : text(1);
  if (!TAGS.includes(name)) return text(1);
  const wrapper = WRAPPER_TAGS.includes(name);
  if (wrapper && held[nameEnd] !== '>') return text(1);
  const gt = held.indexOf('>', nameEnd);
  if (gt < 0) {
    const soFar = held.slice(nameEnd);
    return atEnd || soFar.length > MAX_OPEN_TAG || !ATTRIBUTES_SO_FAR.test(soFar) ? text(1) : WAIT;
  }
  const attributes = held.slice(nameEnd, gt);
  if (!wrapper && !(ATTRIBUTES.test(attributes) && (TOOL_NAME[name]!.test(attributes) || (name === 'toolcall' && attributes === '')))) return text(1);
  const closing = `</${name}>`;
  const close = held.indexOf(closing, Math.max(gt + 1, state.searchFrom - closing.length));
  if (close < 0) {
    // A block never closed is no call (agent.ts): text, at the end.
    state.searchFrom = held.length;
    return atEnd ? text(1) : WAIT;
  }
  if (wrapper && !CALL_BLOCK.test(held.slice(gt + 1, close))) return text(1);
  return { kind: 'skip', length: close + closing.length };
}

/**
 * `held` starts with `{` or a backtick: an envelope that ends the text
 * (agent.ts: one after prose counts only then, and only with reply or
 * actions), or not. `{a, b}`, a JSON example followed by more prose: text.
 */
function embeddedEnvelope(held: string, atEnd: boolean, state: CandidateState): Verdict {
  const start = envelopeStart(held);
  if (start.match === 'none') return text(1);
  if (start.match === 'partial') return atEnd ? text(1) : WAIT;
  const scan = (state.json ??= { pos: start.brace, depth: 0, inString: false, escaped: false });
  for (; scan.closedAt === undefined && scan.pos < held.length; scan.pos += 1) {
    const char = held[scan.pos]!;
    if (scan.inString) {
      if (scan.escaped) scan.escaped = false;
      else if (char === '\\') scan.escaped = true;
      else if (char === '"') scan.inString = false;
    } else if (char === '"') scan.inString = true;
    else if (char === '{' || char === '[') scan.depth += 1;
    else if (char === '}' || char === ']') {
      scan.depth -= 1;
      if (scan.depth === 0) scan.closedAt = scan.pos + 1;
    }
  }
  if (scan.closedAt === undefined) return atEnd ? text(held.length) : WAIT;
  const closedAt = scan.closedAt;
  const object = parsedObject(held.slice(start.brace, closedAt));
  if (!isEnvelopeLike(object) || !('reply' in object! || 'actions' in object!)) return text(closedAt);
  // Only whitespace and a closing fence may follow it.
  let rest = held.slice(closedAt).trimStart();
  if (rest.startsWith('```')) rest = rest.slice(3);
  else if (rest && '```'.startsWith(rest)) return atEnd ? text(closedAt) : WAIT;
  if (rest.trim()) return text(closedAt);
  return atEnd ? { kind: 'skip', length: held.length } : WAIT;
}

/**
 * Prose as it streams. `text`: a plain answer (trimmed at both ends, tool
 * calls left out, an envelope at its end never shown). `reply`: an
 * envelope's reply string, kept as written but for tool calls in it
 * (agent.ts buildEnvelopeFromParsedObject).
 */
class ProseGuard {
  /** Text not yet shown: empty, or starting with a candidate. */
  private held = '';
  private state: CandidateState = { searchFrom: 0 };
  private shownAny = false;
  /** Trailing whitespace, shown once text follows it (text kind). */
  private space = '';

  constructor(private readonly kind: 'text' | 'reply') {}

  push(chunk: string): string {
    if (!chunk) return '';
    this.held += chunk;
    return this.drain(false);
  }

  /** The end of the text: every candidate is decided. */
  end(): string {
    const out = this.drain(true);
    this.space = '';
    return out;
  }

  private drain(atEnd: boolean): string {
    let out = '';
    for (;;) {
      const at = this.nextCandidate();
      if (at < 0) {
        out += this.held;
        this.held = '';
        break;
      }
      if (at > 0) {
        out += this.held.slice(0, at);
        this.held = this.held.slice(at);
        this.state = { searchFrom: 0 };
      }
      const verdict = this.held[0] === '<' ? toolMarkup(this.held, atEnd, this.state) : embeddedEnvelope(this.held, atEnd, this.state);
      if (verdict.kind === 'wait') break;
      if (verdict.kind === 'text') out += this.held.slice(0, verdict.length);
      this.held = this.held.slice(verdict.length);
      this.state = { searchFrom: 0 };
    }
    return this.show(out);
  }

  /** Where the next possible candidate starts (`<`; for plain text also `{` and a backtick). */
  private nextCandidate(): number {
    for (let i = 0; i < this.held.length; i += 1) {
      const char = this.held[i];
      if (char === '<' || (this.kind === 'text' && (char === '{' || char === '`'))) return i;
    }
    return -1;
  }

  private show(out: string): string {
    if (this.kind === 'reply') return out;
    if (!this.shownAny) out = out.trimStart();
    if (!out) return '';
    const body = out.trimEnd();
    if (!body) {
      this.space += out;
      return '';
    }
    const shown = this.space + body;
    this.space = out.slice(body.length);
    this.shownAny = true;
    return shown;
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
  /** Characters taken so far. */
  private taken = 0;
  /** Where the object closed (characters into the whole input), once it did. */
  closedAt: number | undefined;
  /** Whether any reply text came out. */
  emitted = false;

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
        if (this.depth <= 0) {
          this.closed = true;
          this.closedAt = this.taken + i + 1;
        }
        continue;
      }
      if (char === ',' && this.depth === 1) this.expectKey = true;
    }
    this.taken += text.length;
    if (out) this.emitted = true;
    return out;
  }

  /** A reply cut off mid-way (the stream ended): a held high surrogate goes out alone. */
  end(): string {
    const rest = this.high ?? '';
    this.high = undefined;
    if (rest) this.emitted = true;
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

type Mode = 'detect' | 'envelope' | 'text';

/** One model call's raw deltas in, the deltas of its user-visible reply out. */
export class ReplyStreamFilter {
  private mode: Mode = 'detect';
  private pending = '';
  /** Envelope mode: the output from its first character, should it turn out not to be one. */
  private source = '';
  /** Envelope mode: where the object starts in `source` (after a fence). */
  private brace = 0;
  private envelope: EnvelopeReply | undefined;
  /** Envelope mode: settled (an envelope; nothing after it shows). */
  private confirmed = false;
  private prose: ProseGuard | undefined;

  push(delta: string): string {
    if (!delta) return '';
    switch (this.mode) {
      case 'envelope':
        return this.envelopeDelta(delta);
      case 'text':
        return this.prose!.push(delta);
      default:
        return this.detect(delta);
    }
  }

  /** The model call ended: whatever was held only because more might follow. */
  end(): string {
    if (this.mode === 'detect') {
      const rest = this.pending.trimStart();
      this.pending = '';
      if (!rest) return '';
      return this.asText(rest) + this.prose!.end();
    }
    if (this.mode === 'envelope') {
      // Never closed: an envelope cut off (what it said stands), or text that started with `{`.
      if (!this.confirmed && !this.envelope!.emitted) return this.asText(this.source) + this.prose!.end();
      return this.prose!.push(this.envelope!.end()) + this.prose!.end();
    }
    return this.prose!.end();
  }

  private detect(delta: string): string {
    this.pending += delta;
    const text = this.pending.trimStart();
    if (!text) return '';
    const first = text[0]!;
    if (first === '{') return this.startEnvelope(text, 0);
    if (first === '`') {
      // A ```json fence around the envelope, or a code block that starts a plain reply.
      const fence = /^(`{1,3})([a-zA-Z]*)/.exec(text)!;
      const rest = text.slice(fence[0].length);
      if (fence[1]!.length < 3) {
        if (!rest) return '';
      } else if (!rest.trim()) {
        return '';
      } else if (rest.trimStart()[0] === '{' && /^(?:json)?$/i.test(fence[2]!)) {
        return this.startEnvelope(text, text.indexOf('{'));
      }
    }
    this.pending = '';
    return this.asText(text);
  }

  private asText(text: string): string {
    this.mode = 'text';
    this.prose = new ProseGuard('text');
    return this.prose.push(text);
  }

  private startEnvelope(text: string, brace: number): string {
    this.mode = 'envelope';
    this.pending = '';
    this.source = '';
    this.brace = brace;
    this.envelope = new EnvelopeReply();
    // The reply is the string as written (untrimmed); tool calls in it are left out.
    this.prose = new ProseGuard('reply');
    return this.envelopeDelta(text);
  }

  private envelopeDelta(delta: string): string {
    if (this.confirmed) return '';
    const before = this.source.length;
    this.source += delta;
    const from = Math.max(0, this.brace - before);
    const out = this.prose!.push(this.envelope!.push(delta.slice(from)));
    const closedAt = this.envelope!.closedAt;
    if (closedAt === undefined) return out;
    const object = this.source.slice(this.brace, this.brace + closedAt);
    if (isEnvelopeLike(parsedObject(object)) || this.envelope!.emitted) {
      // The envelope (or as good as: its reply is out): nothing after it shows.
      this.confirmed = true;
      return out;
    }
    // Not an envelope after all (`{a, b} is a set.`, a JSON answer): the text it is.
    return out + this.asText(this.source);
  }
}

/** The visible reply of a whole raw output at once (tests; the same as pushing it in one piece). */
export function visibleReplyOf(raw: string): string {
  const filter = new ReplyStreamFilter();
  return filter.push(raw) + filter.end();
}
