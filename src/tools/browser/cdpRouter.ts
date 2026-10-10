/**
 * Shares one Chromium DevTools pipe between several local clients.
 *
 * The live browser host starts Chromium with `--remote-debugging-pipe`, so
 * no TCP debugging port exists at all. Each client that connects to the
 * host (Playwright in an engine run, the platform server's viewer) gets its
 * own browser-level session from `Target.attachToBrowserTarget` and talks
 * to it as if it owned the whole connection:
 *
 * - message ids are rewritten per client, so ids never collide;
 * - a message without a sessionId goes to the client's own browser session,
 *   and a response or event on that session comes back without one;
 * - sessions a client attaches (directly, or through auto-attach) belong to
 *   it; a client can never send on, or hear from, another client's sessions.
 *
 * Viewer clients (the platform server) are limited to the methods in
 * VIEWER_METHODS: screencast, input, a few navigation calls and the tab
 * list. Everything else is refused here, in addition to the server's own
 * whitelist, so a leaked viewer token cannot read pages or cookies.
 */

export type ClientRole = 'agent' | 'viewer';

/** What a viewer may call. Kept in step with the platform server's whitelist. */
export const VIEWER_METHODS: ReadonlySet<string> = new Set([
  'Target.getTargets',
  'Target.getTargetInfo',
  'Target.setDiscoverTargets',
  'Target.attachToTarget',
  'Target.detachFromTarget',
  'Target.activateTarget',
  'Page.enable',
  'Page.startScreencast',
  'Page.stopScreencast',
  'Page.screencastFrameAck',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Page.navigate',
  'Page.reload',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
]);

/** Why a viewer message is refused, or undefined when it may go through. */
export function viewerRefusal(method: string, params: Record<string, unknown> | undefined): string | undefined {
  if (!VIEWER_METHODS.has(method)) return `Method not allowed for this client: ${method}`;
  if (method === 'Target.attachToTarget' && params?.flatten !== true) return 'Only flattened sessions are supported';
  if (method === 'Page.navigate') {
    const url = typeof params?.url === 'string' ? params.url : '';
    if (!/^https?:\/\//i.test(url)) return 'Only http(s) addresses can be opened';
  }
  return undefined;
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
}

interface Pending {
  method: string;
  client?: Client;
  clientId?: number;
  /** The sessionId the client wrote, if any (absent = its root session). */
  clientSession?: string;
  resolve?: (result: Record<string, unknown>) => void;
  reject?: (error: Error) => void;
}

export interface RouterClient {
  /** A text message from this client. */
  receive: (text: string) => void;
  /** The client went away: its sessions are detached. */
  close: () => void;
}

export class CdpRouter {
  private nextId = 1;
  private nextClient = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly owners = new Map<string, Client>();
  private readonly clients = new Set<Client>();
  /** Last time a client connected or disconnected (ms). */
  lastChange = Date.now();

  constructor(
    private readonly toBrowser: (message: CdpMessage) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get clientCount(): number {
    return this.clients.size;
  }

  /** A command from the host itself, on the root connection. */
  call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { method, resolve, reject });
      this.toBrowser({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }

  addClient(role: ClientRole, send: (text: string) => void): RouterClient {
    const client: Client = { id: this.nextClient++, role, send, queued: [], closed: false };
    this.clients.add(client);
    this.lastChange = this.now();
    this.call('Target.attachToBrowserTarget')
      .then((result) => {
        const sessionId = typeof result.sessionId === 'string' ? result.sessionId : undefined;
        if (!sessionId) throw new Error('no browser session');
        if (client.closed) {
          this.toBrowser({ id: this.nextId++, method: 'Target.detachFromTarget', params: { sessionId } });
          return;
        }
        client.root = sessionId;
        this.owners.set(sessionId, client);
        for (const message of client.queued.splice(0)) this.forward(client, message);
      })
      .catch(() => this.drop(client));
    return {
      receive: (text) => this.fromClient(client, text),
      close: () => this.drop(client),
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
    this.forward(client, message);
  }

  private forward(client: Client, message: CdpMessage): void {
    const reply = (error: string) =>
      client.send(JSON.stringify({ id: message.id, error: { code: -32601, message: error }, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
    if (client.role === 'viewer') {
      const refusal = viewerRefusal(message.method!, message.params);
      if (refusal) return reply(refusal);
    }
    let sessionId = client.root!;
    if (message.sessionId !== undefined) {
      if (typeof message.sessionId !== 'string' || this.owners.get(message.sessionId) !== client) {
        return reply('Session with given id not found.');
      }
      sessionId = message.sessionId;
    }
    const id = this.nextId++;
    this.pending.set(id, { method: message.method!, client, clientId: message.id!, ...(message.sessionId ? { clientSession: message.sessionId } : {}) });
    this.toBrowser({ id, method: message.method!, params: message.params ?? {}, sessionId });
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
    }
    const out: CdpMessage = { method: message.method!, params: message.params ?? {} };
    if (message.sessionId !== owner.root) out.sessionId = message.sessionId;
    owner.send(JSON.stringify(out));
    if (message.method === 'Target.detachedFromTarget') {
      const child = message.params?.sessionId;
      if (typeof child === 'string' && child !== owner.root) this.owners.delete(child);
    }
  }

  private drop(client: Client): void {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    this.lastChange = this.now();
    const sessions = [...this.owners.entries()].filter(([, owner]) => owner === client).map(([id]) => id);
    for (const id of sessions) this.owners.delete(id);
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
