/**
 * Shares one Chromium DevTools pipe between several local clients.
 *
 * The live browser host starts Chromium with `--remote-debugging-pipe`, so
 * no TCP debugging port exists at all. Each client that connects to the
 * host (Playwright in an engine run, the platform server's viewer, the
 * host's own monitor) gets its own browser-level session from
 * `Target.attachToBrowserTarget` and talks to it as if it owned the whole
 * connection:
 *
 * - message ids are rewritten per client, so ids never collide;
 * - a message without a sessionId goes to the client's own browser session,
 *   and a response or event on that session comes back without one;
 * - sessions a client attaches (directly, or through auto-attach) belong to
 *   it; a client can never send on, or hear from, another client's sessions.
 *
 * Viewer clients (the platform server) get far less. Each viewer call is
 * checked against VIEWER_PARAMS and its parameters are rebuilt from that
 * list, so nothing the viewer sends beyond the documented fields reaches
 * Chromium (no `scriptToEvaluateOnLoad`, no editing `commands`, no
 * filters). Calls that name a target or a history entry are checked against
 * the browser first: only page targets, only the viewer's own sessions, only
 * http(s) history entries. A leaked viewer token can watch and click, never
 * read cookies or run script.
 *
 * Methods in the `Artemis.` domain are answered by the host itself (see
 * `hostMethod`), never forwarded.
 */

export type ClientRole = 'agent' | 'viewer';

type Value = unknown;
/** Returns the cleaned value, or throws with the reason. */
type Field = (value: Value, name: string) => Value;

class Refused extends Error {}

const req = (field: Field): Field & { required: true } => Object.assign((v: Value, n: string) => field(v, n), { required: true as const });
const str = (max: number): Field => (v, n) => {
  if (typeof v !== 'string' || v.length > max) throw new Refused(`"${n}" must be a string of at most ${max} characters`);
  return v;
};
const num = (min: number, max: number): Field => (v, n) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Refused(`"${n}" must be a number between ${min} and ${max}`);
  return v;
};
const int = (min: number, max: number): Field => (v, n) => {
  const x = num(min, max)(v, n) as number;
  if (!Number.isInteger(x)) throw new Refused(`"${n}" must be an integer`);
  return x;
};
const bool: Field = (v, n) => {
  if (typeof v !== 'boolean') throw new Refused(`"${n}" must be true or false`);
  return v;
};
const oneOf = (...values: string[]): Field => (v, n) => {
  if (typeof v !== 'string' || !values.includes(v)) throw new Refused(`"${n}" must be one of ${values.join(', ')}`);
  return v;
};
const exactly = (value: Value): Field => (v, n) => {
  if (v !== value) throw new Refused(`"${n}" must be ${JSON.stringify(value)}`);
  return v;
};
const httpUrl: Field = (v, n) => {
  const url = str(4096)(v, n) as string;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Refused('Only http(s) addresses can be opened');
  }
  if (!/^https?:\/\//i.test(url) || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) throw new Refused('Only http(s) addresses can be opened');
  return parsed.toString();
};

const TARGET_ID = req(str(64));
const SESSION_ID = req(str(64));
const MODIFIERS = int(0, 15);

/**
 * What a viewer may call, and the only parameters that are passed on for
 * each. Kept in step with the platform server (server/src/browser/cdp.ts).
 */
export const VIEWER_PARAMS: Readonly<Record<string, Readonly<Record<string, Field>>>> = {
  'Target.getTargets': {},
  'Target.getTargetInfo': { targetId: TARGET_ID },
  'Target.setDiscoverTargets': { discover: req(bool) },
  'Target.attachToTarget': { targetId: TARGET_ID, flatten: req(exactly(true)) },
  'Target.detachFromTarget': { sessionId: SESSION_ID },
  'Target.activateTarget': { targetId: TARGET_ID },
  'Page.enable': {},
  'Page.startScreencast': { format: oneOf('jpeg', 'png'), quality: int(0, 100), maxWidth: int(16, 4096), maxHeight: int(16, 4096), everyNthFrame: int(1, 60) },
  'Page.stopScreencast': {},
  'Page.screencastFrameAck': { sessionId: req(int(0, Number.MAX_SAFE_INTEGER)) },
  'Page.captureScreenshot': { format: oneOf('jpeg', 'png'), quality: int(0, 100) },
  'Page.getLayoutMetrics': {},
  'Page.navigate': { url: req(httpUrl) },
  'Page.reload': { ignoreCache: bool },
  'Page.getNavigationHistory': {},
  'Page.navigateToHistoryEntry': { entryId: req(int(0, Number.MAX_SAFE_INTEGER)) },
  'Input.dispatchMouseEvent': {
    type: req(oneOf('mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel')),
    x: req(num(0, 100_000)),
    y: req(num(0, 100_000)),
    modifiers: MODIFIERS,
    button: oneOf('none', 'left', 'middle', 'right', 'back', 'forward'),
    buttons: int(0, 31),
    clickCount: int(0, 3),
    deltaX: num(-100_000, 100_000),
    deltaY: num(-100_000, 100_000),
    pointerType: oneOf('mouse', 'pen'),
  },
  'Input.dispatchKeyEvent': {
    type: req(oneOf('keyDown', 'keyUp', 'rawKeyDown', 'char')),
    modifiers: MODIFIERS,
    text: str(4),
    unmodifiedText: str(4),
    key: str(32),
    code: str(32),
    windowsVirtualKeyCode: int(0, 255),
    nativeVirtualKeyCode: int(0, 255),
    autoRepeat: bool,
    isKeypad: bool,
    location: int(0, 3),
  },
  'Input.insertText': { text: req(str(10_000)) },
  // Answered by the host: a phone-sized viewport while the owner holds the browser.
  'Artemis.setViewport': { targetId: TARGET_ID, mode: req(oneOf('desktop', 'mobile')), width: int(240, 1600), height: int(320, 2400) },
};

/** What a viewer may call (VIEWER_PARAMS' methods). */
export const VIEWER_METHODS: ReadonlySet<string> = new Set(Object.keys(VIEWER_PARAMS));

/**
 * A viewer's parameters rebuilt from the whitelist, or the reason they are
 * refused. Unknown fields are dropped, never passed on.
 */
export function viewerParams(method: string, params: Record<string, unknown> | undefined): { params: Record<string, unknown> } | { error: string } {
  const spec = VIEWER_PARAMS[method];
  if (!spec) return { error: `Method not allowed for this client: ${method}` };
  const input = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const out: Record<string, unknown> = {};
  try {
    for (const [name, field] of Object.entries(spec)) {
      const value = input[name];
      if (value === undefined) {
        if ((field as { required?: boolean }).required) throw new Refused(`"${name}" is required`);
        continue;
      }
      out[name] = field(value, name);
    }
  } catch (err) {
    return { error: err instanceof Refused ? err.message : 'Invalid parameters' };
  }
  return { params: out };
}

/** Why a viewer message is refused, or undefined when it may go through (its params are then rebuilt). */
export function viewerRefusal(method: string, params: Record<string, unknown> | undefined): string | undefined {
  const checked = viewerParams(method, params);
  return 'error' in checked ? checked.error : undefined;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

interface Client {
  id: number;
  role: ClientRole;
  send: (text: string) => void;
  root?: string;
  queued: CdpMessage[];
  closed: boolean;
  /** The host's own monitor: not counted as a user of the browser. */
  internal: boolean;
  /** Viewer calls run one after another (some are checked first), so their order holds. */
  chain: Promise<void>;
  attachTimer?: ReturnType<typeof setTimeout>;
}

interface Pending {
  method: string;
  client?: Client;
  clientId?: number;
  /** The sessionId the client wrote, if any (absent = its root session). */
  clientSession?: string;
  /** For Target.attachToTarget: the target. */
  targetId?: string;
  resolve?: (result: Record<string, unknown>) => void;
  reject?: (error: Error) => void;
}

export interface RouterClient {
  /** A text message from this client. */
  receive: (text: string) => void;
  /** The client went away: its sessions are detached. */
  close: () => void;
  /** Its browser session exists (it counts as a user of the browser). */
  readonly attached: boolean;
}

/** Host-handled `Artemis.*` methods: the client, its params, and the result. */
export type HostMethod = (method: string, params: Record<string, unknown>, client: { id: number; role: ClientRole }) => Promise<Record<string, unknown>>;

/** A client whose browser session does not exist after this long is dropped. */
const ATTACH_TIMEOUT_MS = 10_000;

export class CdpRouter {
  private nextId = 1;
  private nextClient = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly owners = new Map<string, Client>();
  private readonly clients = new Set<Client>();
  /** Last time a client connected or disconnected (ms). */
  lastChange = Date.now();
  /** Answers `Artemis.*` methods (set by the host). */
  hostMethod: HostMethod | undefined;
  /** Told when a client goes away (the host resets what it set up for it). */
  onDrop: ((client: { id: number; role: ClientRole }) => void) | undefined;
  /** Told when an external client attaches to a target (the host re-applies its emulation). */
  onAttach: ((targetId: string) => void) | undefined;

  constructor(
    private readonly toBrowser: (message: CdpMessage) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Clients actually using the browser: attached, and not the host's own. */
  get clientCount(): number {
    let n = 0;
    for (const client of this.clients) if (client.root && !client.internal) n++;
    return n;
  }

  /** A command from the host itself, on the root connection (or a session). */
  call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { method, resolve, reject });
      this.toBrowser({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }

  addClient(role: ClientRole, send: (text: string) => void, options: { internal?: boolean } = {}): RouterClient {
    const client: Client = { id: this.nextClient++, role, send, queued: [], closed: false, internal: options.internal === true, chain: Promise.resolve() };
    this.clients.add(client);
    this.lastChange = this.now();
    client.attachTimer = setTimeout(() => {
      if (!client.root) this.drop(client);
    }, ATTACH_TIMEOUT_MS);
    client.attachTimer.unref?.();
    this.call('Target.attachToBrowserTarget')
      .then((result) => {
        const sessionId = typeof result.sessionId === 'string' ? result.sessionId : undefined;
        if (!sessionId) throw new Error('no browser session');
        if (client.closed) {
          this.toBrowser({ id: this.nextId++, method: 'Target.detachFromTarget', params: { sessionId } });
          return;
        }
        clearTimeout(client.attachTimer);
        client.root = sessionId;
        this.owners.set(sessionId, client);
        this.lastChange = this.now();
        for (const message of client.queued.splice(0)) this.dispatch(client, message);
      })
      .catch(() => this.drop(client));
    return {
      receive: (text) => this.fromClient(client, text),
      close: () => this.drop(client),
      get attached() {
        return !!client.root && !client.closed;
      },
    };
  }

  private fromClient(client: Client, text: string): void {
    if (client.closed) return;
    let message: CdpMessage;
    try {
      message = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.id !== 'number' || typeof message.method !== 'string') return;
    if (!client.root) {
      client.queued.push(message);
      return;
    }
    this.dispatch(client, message);
  }

  private dispatch(client: Client, message: CdpMessage): void {
    // The agent's calls go straight through (forward does not wait for them).
    if (client.role === 'agent') void this.forward(client, message);
    else client.chain = client.chain.then(() => this.forward(client, message)).catch(() => undefined);
  }

  private async forward(client: Client, message: CdpMessage): Promise<void> {
    const reply = (error: string) => {
      if (!client.closed) {
        client.send(JSON.stringify({ id: message.id, error: { code: -32601, message: error }, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
      }
    };
    let params = message.params ?? {};
    if (client.role === 'viewer') {
      const checked = viewerParams(message.method!, message.params);
      if ('error' in checked) return reply(checked.error);
      params = checked.params;
    }
    let sessionId = client.root!;
    if (message.sessionId !== undefined) {
      if (typeof message.sessionId !== 'string' || this.owners.get(message.sessionId) !== client) {
        return reply('Session with given id not found.');
      }
      sessionId = message.sessionId;
    }
    if (client.role === 'viewer') {
      const refusal = await this.checkViewerCall(client, message.method!, params, sessionId).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      if (refusal) return reply(refusal);
      if (client.closed) return;
    }
    if (message.method!.startsWith('Artemis.')) {
      if (!this.hostMethod) return reply(`Unknown method: ${message.method}`);
      try {
        const result = await this.hostMethod(message.method!, params, { id: client.id, role: client.role });
        if (!client.closed) client.send(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
      } catch (err) {
        reply(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, {
      method: message.method!,
      client,
      clientId: message.id!,
      ...(message.sessionId ? { clientSession: message.sessionId } : {}),
      ...(typeof params.targetId === 'string' ? { targetId: params.targetId } : {}),
    });
    this.toBrowser({ id, method: message.method!, params, sessionId });
  }

  /**
   * Checks that need the browser: targets must be pages, a session to
   * detach must be the viewer's own, a history entry must be http(s).
   */
  private async checkViewerCall(client: Client, method: string, params: Record<string, unknown>, sessionId: string): Promise<string | undefined> {
    switch (method) {
      case 'Target.attachToTarget':
      case 'Target.activateTarget':
      case 'Target.getTargetInfo':
      case 'Artemis.setViewport': {
        const info = await this.call('Target.getTargetInfo', { targetId: params.targetId }).catch(() => undefined);
        const type = (info?.targetInfo as { type?: string } | undefined)?.type;
        return type === 'page' ? undefined : 'Only page targets are available';
      }
      case 'Target.detachFromTarget':
        return this.owners.get(String(params.sessionId)) === client && params.sessionId !== client.root ? undefined : 'Session with given id not found.';
      case 'Page.navigateToHistoryEntry': {
        const history = await this.call('Page.getNavigationHistory', {}, sessionId);
        const entries = Array.isArray(history.entries) ? (history.entries as { id?: number; url?: string }[]) : [];
        const entry = entries.find((e) => e.id === params.entryId);
        return entry && /^https?:\/\//i.test(String(entry.url ?? '')) ? undefined : 'Only http(s) history entries can be opened';
      }
      default:
        return undefined;
    }
  }

  /** A message from Chromium. */
  fromBrowser(message: CdpMessage): void {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.resolve) {
        if (message.error) pending.reject?.(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      const client = pending.client!;
      if (client.closed) return;
      const attached = message.result?.sessionId;
      if (!message.error && typeof attached === 'string' && /^Target\.attachTo(Target|BrowserTarget)$/.test(pending.method)) {
        this.owners.set(attached, client);
        if (pending.targetId && !client.internal) this.notifyAttach(pending.targetId);
      }
      client.send(JSON.stringify({
        id: pending.clientId,
        ...(message.error ? { error: message.error } : { result: message.result ?? {} }),
        ...(pending.clientSession ? { sessionId: pending.clientSession } : {}),
      }));
      return;
    }
    // Events: only those on a client's sessions are delivered; the root
    // connection's own events (the host's attach notices) are not.
    if (!message.sessionId) return;
    const owner = this.owners.get(message.sessionId);
    if (!owner || owner.closed) return;
    if (message.method === 'Target.attachedToTarget') {
      const child = message.params?.sessionId;
      if (typeof child === 'string') this.owners.set(child, owner);
      const target = (message.params?.targetInfo as { targetId?: unknown } | undefined)?.targetId;
      if (typeof target === 'string' && !owner.internal) this.notifyAttach(target);
    }
    const out: CdpMessage = { method: message.method!, params: message.params ?? {} };
    if (message.sessionId !== owner.root) out.sessionId = message.sessionId;
    owner.send(JSON.stringify(out));
    if (message.method === 'Target.detachedFromTarget') {
      const child = message.params?.sessionId;
      if (typeof child === 'string' && child !== owner.root) this.owners.delete(child);
    }
  }

  private notifyAttach(targetId: string): void {
    try {
      this.onAttach?.(targetId);
    } catch { /* the host's hook must not break routing */ }
  }

  private drop(client: Client): void {
    if (client.closed) return;
    client.closed = true;
    clearTimeout(client.attachTimer);
    this.clients.delete(client);
    this.lastChange = this.now();
    const sessions = [...this.owners.entries()].filter(([, owner]) => owner === client).map(([id]) => id);
    for (const id of sessions) this.owners.delete(id);
    try {
      this.onDrop?.({ id: client.id, role: client.role });
    } catch { /* the host's cleanup must not stop this one */ }
    if (!client.root) return;
    // Child sessions first (on the client's own browser session), then that session.
    for (const id of sessions) {
      if (id === client.root) continue;
      this.toBrowser({ id: this.nextId++, method: 'Target.detachFromTarget', params: { sessionId: id }, sessionId: client.root });
    }
    this.toBrowser({ id: this.nextId++, method: 'Target.detachFromTarget', params: { sessionId: client.root } });
  }

  /** Chromium went away: fail the host's own calls. */
  failAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      pending.reject?.(new Error(reason));
      this.pending.delete(id);
    }
  }
}
