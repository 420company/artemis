/**
 * The live browser host: a detached process that owns one Chromium and
 * shares its DevTools pipe with local clients (see liveBrowser.ts for the
 * files it writes and cdpRouter.ts for the sharing rules).
 *
 * Besides serving clients it keeps the browser usable on its own, through a
 * monitor session of its own (not counted as a client):
 *
 * - every page gets the engine's viewport, time zone and locale (headless
 *   Chromium ignores the window size, and emulation set by one session is
 *   easily undone by another, so only the host sets it);
 * - a page whose renderer crashed is closed (and a blank page opened if it
 *   was the last), so a crash never breaks the next run's connection;
 * - `Artemis.setViewport` lets the platform server show a phone-sized page
 *   while the owner holds the browser from a phone, and is undone when the
 *   server asks, or disconnects.
 *
 * Clients that stop answering pings are dropped, so a half-open connection
 * never keeps the browser alive. Started by an engine run as
 * `node browserHost.js <config JSON>`; exits after the configured idle time
 * without clients, when Chromium exits, or on SIGTERM.
 */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CdpRouter, type ClientRole, type RouterClient } from './cdpRouter.js';
import { LIVE_FILES, isPidAlive, probeHost, readJsonFile, writeJsonFileAtomic, type HostConfig, type HostInfo, type ViewerInfo } from './liveBrowser.js';
import { attachWebSocket, handshakeResponse } from './wsFrames.js';

const MAX_CLIENTS = 8;
const IDLE_CHECK_MS = 5_000;
const PING_EVERY_MS = 20_000;
/** A client silent for this long (no message, no pong) is dropped. */
const SILENT_LIMIT_MS = 65_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

function chromeArgs(config: HostConfig): string[] {
  const viewport = config.viewport ?? DEFAULT_VIEWPORT;
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${config.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-component-update',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-blink-features=AutomationControlled',
    `--window-size=${viewport.width},${viewport.height}`,
    `--lang=${config.locale ?? 'zh-CN'}`,
    '--mute-audio',
    ...(config.headless ? ['--headless=new', '--hide-scrollbars'] : []),
    ...(config.userAgent ? [`--user-agent=${config.userAgent}`] : []),
    // Chromium refuses to start its sandbox as root (a development container).
    ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
    ...config.args,
    'about:blank',
  ];
  return [...new Set(args)];
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits while another Chromium (a previous host still shutting down) holds
 * the profile: its SingletonLock names host and pid.
 */
async function waitForProfile(profileDir: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let holder: string;
    try {
      holder = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));
    } catch {
      return;
    }
    const match = /^(.*)-(\d+)$/.exec(holder);
    if (!match || match[1] !== os.hostname() || !isPidAlive(Number(match[2]))) return;
    if (Date.now() > deadline) return;
    await sleep(200);
  }
}

interface Monitor {
  /** The monitor's own session on each page. */
  pages: Map<string, string>;
  /** Pages a viewer switched to a phone viewport, by viewer client id. */
  mobile: Map<string, { client: number; width: number; height: number }>;
}

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? '{}') as HostConfig;
  const dir = config.liveDir;
  const hostFile = path.join(dir, LIVE_FILES.host);
  const viewerFile = path.join(dir, LIVE_FILES.viewer);
  const errorFile = path.join(dir, 'host-error.txt');
  const viewport = config.viewport ?? DEFAULT_VIEWPORT;

  // Single instance: another live host already serves this directory, and
  // proves it with its token (a pid alone may belong to anything by now).
  const other = readJsonFile<HostInfo>(hostFile);
  if (other && other.pid !== process.pid && isPidAlive(other.pid) && typeof other.port === 'number' && (await probeHost(other.port, String(other.agentToken)))) {
    process.exit(0);
  }

  const fail = (message: string) => {
    try {
      fs.writeFileSync(errorFile, message.slice(0, 2000), { mode: 0o600 });
    } catch { /* nothing more to do */ }
    process.exit(1);
  };

  fs.mkdirSync(config.profileDir, { recursive: true, mode: 0o700 });
  await waitForProfile(config.profileDir);
  const chrome = spawn(config.executable, chromeArgs(config), {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(config.timezoneId ? { TZ: config.timezoneId } : {}) },
  });
  chrome.once('error', (err) => fail(`cannot start Chromium (${config.executable}): ${err.message}`));
  const toChrome = chrome.stdio[3] as Writable;
  const fromChrome = chrome.stdio[4] as Readable;

  const router = new CdpRouter((message) => {
    if (toChrome.writable) toChrome.write(`${JSON.stringify(message)}\0`);
  });
  let pending = '';
  fromChrome.setEncoding('utf8');
  fromChrome.on('data', (chunk: string) => {
    pending += chunk;
    let end = pending.indexOf('\0');
    while (end !== -1) {
      const text = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        router.fromBrowser(JSON.parse(text));
      } catch { /* a malformed message from the browser is skipped */ }
      end = pending.indexOf('\0');
    }
  });

  let server: http.Server | undefined;
  let shuttingDown = false;
  const removeFiles = () => {
    // Only our own files: a newer host may have replaced them.
    for (const file of [hostFile, viewerFile]) {
      if (readJsonFile<{ pid?: number }>(file)?.pid === process.pid) fs.rmSync(file, { force: true });
    }
  };
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Gone from the files and the port first: a run starting now starts a new
    // host, which waits for this Chromium to release the profile.
    removeFiles();
    server?.close();
    const exited = new Promise<void>((resolve) => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) resolve();
      else chrome.once('exit', () => resolve());
    });
    const within = (ms: number) => Promise.race([exited, sleep(ms)]);
    await Promise.race([router.call('Browser.close').catch(() => undefined), sleep(3_000)]);
    await within(3_000);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGTERM');
    await within(3_000);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
    await within(2_000);
    process.exit(code);
  };
  chrome.once('exit', () => {
    router.failAll('browser exited');
    if (!shuttingDown) {
      shuttingDown = true;
      removeFiles();
      process.exit(0);
    }
  });
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));

  try {
    await Promise.race([
      router.call('Browser.getVersion'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Chromium did not answer within 20 s')), 20_000)),
    ]);
  } catch (err) {
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
    fail(err instanceof Error ? err.message : String(err));
  }

  // ── the monitor: emulation for every page, crashed pages closed ─────────
  const monitor: Monitor = { pages: new Map(), mobile: new Map() };
  let monitorNext = 1;
  const monitorPending = new Map<number, (m: { result?: Record<string, unknown>; error?: unknown }) => void>();
  let monitorClient: RouterClient | undefined;
  const monitorCall = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = monitorNext++;
      monitorPending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result ?? {})));
      monitorClient?.receive(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const emulate = async (targetId: string) => {
    const session = monitor.pages.get(targetId);
    if (!session) return;
    const phone = monitor.mobile.get(targetId);
    await monitorCall(
      'Emulation.setDeviceMetricsOverride',
      phone
        ? { width: phone.width, height: phone.height, screenWidth: phone.width, screenHeight: phone.height, deviceScaleFactor: 2, mobile: true }
        : { width: viewport.width, height: viewport.height, screenWidth: viewport.width, screenHeight: viewport.height, deviceScaleFactor: 1, mobile: false },
      session,
    ).catch(() => undefined);
  };
  const watchPage = async (targetId: string) => {
    if (monitor.pages.has(targetId)) return;
    const { sessionId } = await monitorCall('Target.attachToTarget', { targetId, flatten: true }).catch(() => ({ sessionId: undefined }));
    if (typeof sessionId !== 'string') return;
    monitor.pages.set(targetId, sessionId);
    await emulate(targetId);
    if (config.timezoneId) await monitorCall('Emulation.setTimezoneOverride', { timezoneId: config.timezoneId }, sessionId).catch(() => undefined);
    if (config.locale) await monitorCall('Emulation.setLocaleOverride', { locale: config.locale }, sessionId).catch(() => undefined);
    // A page opened paused for an auto-attaching client must not wait for us.
    await monitorCall('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
  };
  const recoverCrash = async (targetId: string) => {
    monitor.pages.delete(targetId);
    monitor.mobile.delete(targetId);
    await monitorCall('Target.closeTarget', { targetId }).catch(() => undefined);
    const { targetInfos } = await monitorCall('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const pages = (targetInfos as { type: string }[]).filter((t) => t.type === 'page');
    if (pages.length === 0) await monitorCall('Target.createTarget', { url: 'about:blank' }).catch(() => undefined);
  };
  monitorClient = router.addClient(
    'agent',
    (text) => {
      const message = JSON.parse(text) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
      if (typeof message.id === 'number') {
        monitorPending.get(message.id)?.(message);
        monitorPending.delete(message.id);
        return;
      }
      const params = message.params ?? {};
      const info = params.targetInfo as { targetId?: string; type?: string } | undefined;
      if (message.method === 'Target.targetCreated' && info?.type === 'page' && info.targetId) void watchPage(info.targetId);
      else if (message.method === 'Target.targetCrashed' && typeof params.targetId === 'string') void recoverCrash(params.targetId);
      else if (message.method === 'Target.targetDestroyed' && typeof params.targetId === 'string') {
        monitor.pages.delete(params.targetId);
        monitor.mobile.delete(params.targetId);
      }
    },
    { internal: true },
  );
  await monitorCall('Target.setDiscoverTargets', { discover: true }).catch(() => undefined);
  const { targetInfos } = await monitorCall('Target.getTargets').catch(() => ({ targetInfos: [] }));
  for (const t of targetInfos as { targetId: string; type: string }[]) if (t.type === 'page') await watchPage(t.targetId);

  router.hostMethod = async (method, params, client) => {
    if (method !== 'Artemis.setViewport' || client.role !== 'viewer') throw new Error(`Unknown method: ${method}`);
    const targetId = String(params.targetId);
    if (params.mode === 'mobile') {
      const width = typeof params.width === 'number' ? params.width : 390;
      const height = typeof params.height === 'number' ? params.height : 844;
      monitor.mobile.set(targetId, { client: client.id, width, height });
    } else {
      monitor.mobile.delete(targetId);
    }
    await watchPage(targetId);
    await emulate(targetId);
    return {};
  };
  // A viewer that goes away gives its pages their normal size back.
  router.onDrop = (client) => {
    for (const [targetId, phone] of monitor.mobile) {
      if (phone.client !== client.id) continue;
      monitor.mobile.delete(targetId);
      void emulate(targetId);
    }
  };

  // ── serving clients ─────────────────────────────────────────────────────
  const agentToken = randomBytes(32).toString('base64url');
  const viewerToken = randomBytes(32).toString('base64url');
  const sockets = new Set<ReturnType<typeof attachWebSocket>>();
  server = http.createServer((_req, res) => {
    // No HTTP discovery endpoints: only the WebSocket upgrade with a token.
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket) => {
    const match = /^\/cdp\/([A-Za-z0-9_-]{43})$/.exec(req.url ?? '');
    let role: ClientRole | undefined;
    if (match?.[1]) {
      if (sameToken(match[1], agentToken)) role = 'agent';
      else if (sameToken(match[1], viewerToken)) role = 'viewer';
    }
    const accept = role ? handshakeResponse(req.headers) : undefined;
    if (shuttingDown || !role || !accept || sockets.size >= MAX_CLIENTS) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write(accept);
    // The callbacks only fire on later socket events, after `client` exists.
    const ws = attachWebSocket(
      socket,
      (text) => client.receive(text),
      () => {
        sockets.delete(ws);
        client.close();
      },
    );
    sockets.add(ws);
    const client = router.addClient(role, ws.send);
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const startedAt = new Date().toISOString();
  fs.rmSync(errorFile, { force: true });
  // The viewer file first: an engine waiting on host.json then finds both.
  writeJsonFileAtomic(viewerFile, { version: 1, pid: process.pid, port, token: viewerToken, startedAt } satisfies ViewerInfo, 0o640);
  writeJsonFileAtomic(hostFile, { version: 1, pid: process.pid, chromePid: chrome.pid ?? 0, port, agentToken, startedAt } satisfies HostInfo, 0o600);

  // Liveness: ping everyone; drop a client that stopped answering.
  setInterval(() => {
    const now = Date.now();
    for (const ws of sockets) {
      if (now - ws.lastSeen > SILENT_LIMIT_MS) ws.close();
      else ws.ping();
    }
  }, PING_EVERY_MS);
  setInterval(() => {
    if (router.clientCount === 0 && Date.now() - router.lastChange > config.idleMs) void shutdown(0);
  }, Math.min(IDLE_CHECK_MS, config.idleMs));
}

void main().catch((err: unknown) => {
  try {
    const dir = (JSON.parse(process.argv[2] ?? '{}') as HostConfig).liveDir;
    if (dir) fs.writeFileSync(path.join(dir, 'host-error.txt'), String(err instanceof Error ? err.message : err).slice(0, 2000), { mode: 0o600 });
  } catch { /* nothing more to do */ }
  process.exit(1);
});
