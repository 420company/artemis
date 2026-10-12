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
 *   server asks, or disconnects;
 * - sign-up passwords (security/identityCredentials.ts) never show in the
 *   owner's live view (`Artemis.setSecretState`, agent only): before a run
 *   types one, the tab it types into is paused for viewers (no frames, no
 *   URL or title) until that tab has loaded a new document, or for at most
 *   SECRET_PAUSE_MS after the last typing (and SECRET_PAUSE_MAX_MS in all,
 *   so a paused tab cannot blind the owner for good). The tab keeps masking
 *   password fields and the fields typed into, also when a page switches
 *   such a field to text or replaces it. A URL or title that carries the
 *   password (a GET form) is blanked for viewers and pauses its tab again;
 *   the host recognises it from salted fingerprints, never the password
 *   (security/secretFingerprints.ts);
 * - engine runs ask it (`Artemis.getSecretState`) whether any run has a
 *   password live, which tabs are paused, and which tabs the owner typed
 *   into during a takeover (until they load a new document);
 * - a page whose renderer hangs is closed when a run asks
 *   (`Artemis.probePages`), so one hung tab never makes the next run restart
 *   the whole browser.
 *
 * None of this is a hard boundary against the model: the engine runs as the
 * same user as the host and could, in principle, reach the browser around
 * it. It keeps the owner's view and other runs clear of a password the
 * engine handles correctly, and limits what a misbehaving run can do (a
 * pause always ends; two connection slots are kept for viewers).
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
import { FingerprintMatcher, parseFingerprintSet } from '../../security/secretFingerprints.js';
import { CdpRouter, type ClientRole, type RouterClient } from './cdpRouter.js';
import { LIVE_FILES, isPidAlive, probeHost, readJsonFile, writeJsonFileAtomic, type HostConfig, type HostInfo, type ViewerInfo } from './liveBrowser.js';
import { attachWebSocket, handshakeResponse } from './wsFrames.js';

const MAX_CLIENTS = 8;
/** Connection slots agent-token clients may not take (kept for the owner's view). */
const VIEWER_RESERVED = 2;
/** A paused tab resumes this long after the last typing at the latest (ARTEMIS_BROWSER_SECRET_PAUSE_MS). */
const SECRET_PAUSE_MS = 3 * 60_000;
/** And never stays paused longer than this in all. */
const SECRET_PAUSE_MAX_FACTOR = 4;
/** Host calls of its own give up after this long (a hung page must not stall the monitor). */
const MONITOR_CALL_MS = 10_000;
const VALID_TARGET = /^[A-Za-z0-9_-]{1,64}$/;
const IDLE_CHECK_MS = 5_000;
const PING_EVERY_MS = 20_000;
/** A client silent for this long (no message, no pong) is dropped. */
const SILENT_LIMIT_MS = 65_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/**
 * Masks secret fields in every document of a tab: password inputs and the
 * fields a sign-up password was typed into (identityCredentials.ts marks
 * them), in an isolated world, and again whenever the page replaces it.
 * The values those fields held are remembered (in the isolated world only),
 * and any field that later shows one of them is marked too: a "show
 * password" toggle that swaps the field for a text field stays masked.
 */
export const SECRET_MASK_SOURCE = `(() => {
  const ATTR = 'data-artemis-secret';
  const css = '[' + ATTR + '], [' + ATTR + '] *, input[type="password"] { -webkit-text-security: disc !important; }';
  const values = new Set();
  const add = () => {
    const root = document.head || document.documentElement;
    if (!root || document.getElementById('__artemis_secret_mask')) return;
    const style = document.createElement('style');
    style.id = '__artemis_secret_mask';
    style.textContent = css;
    root.appendChild(style);
  };
  const isField = (n) => n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement;
  const remember = (n) => {
    if (isField(n) && n.value && (n.hasAttribute(ATTR) || (n instanceof HTMLInputElement && n.type.toLowerCase() === 'password'))) values.add(n.value);
  };
  const sweep = () => {
    for (const n of document.querySelectorAll('input, textarea')) {
      remember(n);
      if (n.value && values.has(n.value) && !n.hasAttribute(ATTR)) n.setAttribute(ATTR, '1');
    }
  };
  add();
  document.addEventListener('input', (e) => remember(e.target), true);
  document.addEventListener('change', (e) => remember(e.target), true);
  new MutationObserver(() => {
    add();
    sweep();
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: [ATTR, 'type', 'value'] });
  sweep();
  setInterval(sweep, 400);
})();`;

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

interface Paused {
  since: number;
  /** The last typing (an engine run renewing the pause). */
  renewedAt: number;
  /** The document the pause belongs to: a new one ends it. */
  loaderId?: string;
}

interface Monitor {
  /** The monitor's own session on each page, and the page of each session. */
  pages: Map<string, string>;
  sessionTarget: Map<string, string>;
  /** Each page's current document (main frame loader id), URL and title. */
  loaders: Map<string, string>;
  info: Map<string, { url: string; title: string }>;
  /** Engine runs (client ids) with a sign-up password live. */
  secretsLive: Set<number>;
  /** The last secret-state sequence number of each run: an older report never wins. */
  seq: Map<number, number>;
  /** Tabs a sign-up password was typed into: their secret fields stay masked. */
  masked: Set<string>;
  /** Tabs viewers must not see now. */
  paused: Map<string, Paused>;
  /** Documents already paused once for showing a password in their URL or title. */
  autoPaused: Set<string>;
  /** Tabs the owner typed into during a takeover, with the document they typed in. */
  ownerTyped: Map<string, string | undefined>;
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
  const monitor: Monitor = {
    pages: new Map(),
    sessionTarget: new Map(),
    loaders: new Map(),
    info: new Map(),
    mobile: new Map(),
    secretsLive: new Set(),
    seq: new Map(),
    masked: new Set(),
    paused: new Map(),
    autoPaused: new Set(),
    ownerTyped: new Map(),
  };
  const fingerprints = new FingerprintMatcher();
  const pauseMs = config.secretPauseMs && config.secretPauseMs >= 1_000 ? config.secretPauseMs : SECRET_PAUSE_MS;
  const pauseMaxMs = pauseMs * SECRET_PAUSE_MAX_FACTOR;
  let monitorNext = 1;
  const monitorPending = new Map<number, (m: { result?: Record<string, unknown>; error?: unknown }) => void>();
  let monitorClient: RouterClient | undefined;
  const monitorCall = (method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = MONITOR_CALL_MS) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = monitorNext++;
      const timer = setTimeout(() => {
        monitorPending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      monitorPending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result ?? {});
      });
      monitorClient?.receive(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const emulate = async (targetId: string) => {
    const session = monitor.pages.get(targetId);
    if (!session) return;
    const phone = monitor.mobile.get(targetId);
    await monitorCall(
      'Emulation.setDeviceMetricsOverride',
      phone
        ? { width: phone.width, height: phone.height, screenWidth: phone.width, screenHeight: phone.height, deviceScaleFactor: 3, mobile: true }
        : { width: viewport.width, height: viewport.height, screenWidth: viewport.width, screenHeight: viewport.height, deviceScaleFactor: 1, mobile: false },
      session,
    ).catch(() => undefined);
  };
  const forget = (targetId: string) => {
    const session = monitor.pages.get(targetId);
    if (session) monitor.sessionTarget.delete(session);
    monitor.pages.delete(targetId);
    monitor.mobile.delete(targetId);
    monitor.masked.delete(targetId);
    monitor.loaders.delete(targetId);
    monitor.info.delete(targetId);
    monitor.ownerTyped.delete(targetId);
    if (monitor.paused.delete(targetId)) pausedChanged(false);
  };
  const watching = new Map<string, Promise<void>>();
  const watchPage = (targetId: string): Promise<void> => {
    if (monitor.pages.has(targetId)) return Promise.resolve();
    const running = watching.get(targetId);
    if (running) return running;
    const work = (async () => {
      const { sessionId } = await monitorCall('Target.attachToTarget', { targetId, flatten: true }).catch(() => ({ sessionId: undefined }));
      if (typeof sessionId !== 'string') return;
      monitor.pages.set(targetId, sessionId);
      monitor.sessionTarget.set(sessionId, targetId);
      await emulate(targetId);
      if (config.timezoneId) await monitorCall('Emulation.setTimezoneOverride', { timezoneId: config.timezoneId }, sessionId).catch(() => undefined);
      if (config.locale) await monitorCall('Emulation.setLocaleOverride', { locale: config.locale }, sessionId).catch(() => undefined);
      // A page opened paused for an auto-attaching client must not wait for us.
      await monitorCall('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
      // Which document it shows: a new one ends a pause, and the owner's typed tabs.
      await monitorCall('Page.enable', {}, sessionId).catch(() => undefined);
      const tree = await monitorCall('Page.getFrameTree', {}, sessionId).catch(() => undefined);
      const frame = (tree?.frameTree as { frame?: { loaderId?: string; url?: string } } | undefined)?.frame;
      if (frame?.loaderId && !monitor.loaders.has(targetId)) monitor.loaders.set(targetId, frame.loaderId);
    })().finally(() => watching.delete(targetId));
    watching.set(targetId, work);
    return work;
  };

  // ── sign-up passwords: paused tabs ──────────────────────────────────────
  const pausedChanged = (newlyPaused: boolean) => {
    router.pausedTargetsChanged([...monitor.paused].map(([targetId, p]) => ({ targetId, since: p.since })), newlyPaused);
  };
  const showsSecret = (targetId: string) => {
    const info = monitor.info.get(targetId);
    return !!info && (fingerprints.matches(info.url) || fingerprints.matches(info.title));
  };
  /** A tab whose URL or title carries a password is paused (once per document). */
  const pauseIfShowingSecret = (targetId: string) => {
    if (monitor.paused.has(targetId) || !showsSecret(targetId)) return;
    const loaderId = monitor.loaders.get(targetId);
    const key = `${targetId}:${loaderId ?? ''}`;
    if (monitor.autoPaused.has(key)) return;
    monitor.autoPaused.add(key);
    if (monitor.autoPaused.size > 1_000) monitor.autoPaused.clear();
    const now = Date.now();
    monitor.paused.set(targetId, { since: now, renewedAt: now, ...(loaderId ? { loaderId } : {}) });
    pausedChanged(true);
  };
  /** A tab loaded a new document: a pause for the old one ends, unless the new one shows the password too. */
  const newDocument = (targetId: string, loaderId: string, url: string | undefined) => {
    monitor.loaders.set(targetId, loaderId);
    if (url !== undefined) monitor.info.set(targetId, { url, title: monitor.info.get(targetId)?.title ?? '' });
    const typed = monitor.ownerTyped.get(targetId);
    if (monitor.ownerTyped.has(targetId) && typed !== loaderId) monitor.ownerTyped.delete(targetId);
    const paused = monitor.paused.get(targetId);
    if (!paused || paused.loaderId === loaderId) return;
    if (url !== undefined && fingerprints.matches(url)) {
      paused.loaderId = loaderId;
      return;
    }
    monitor.paused.delete(targetId);
    pausedChanged(false);
  };
  // A pause always ends: SECRET_PAUSE_MS after the last typing, SECRET_PAUSE_MAX_MS in all.
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [targetId, p] of monitor.paused) {
      if (now - p.renewedAt > pauseMs || now - p.since > pauseMaxMs) {
        monitor.paused.delete(targetId);
        changed = true;
      }
    }
    if (changed) pausedChanged(false);
  }, Math.min(2_000, pauseMs)).unref();

  const recoverCrash = async (targetId: string) => {
    forget(targetId);
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
      const info = params.targetInfo as { targetId?: string; type?: string; url?: string; title?: string } | undefined;
      if ((message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') && info?.type === 'page' && info.targetId) {
        monitor.info.set(info.targetId, { url: String(info.url ?? ''), title: String(info.title ?? '') });
        if (message.method === 'Target.targetCreated') void watchPage(info.targetId);
        pauseIfShowingSecret(info.targetId);
      } else if (message.method === 'Target.targetCrashed' && typeof params.targetId === 'string') void recoverCrash(params.targetId);
      else if (message.method === 'Target.targetDestroyed' && typeof params.targetId === 'string') forget(params.targetId);
      else if (message.method === 'Page.frameNavigated' && typeof (message as { sessionId?: string }).sessionId === 'string') {
        const frame = params.frame as { parentId?: string; loaderId?: string; url?: string } | undefined;
        const targetId = monitor.sessionTarget.get((message as { sessionId?: string }).sessionId!);
        if (targetId && frame && !frame.parentId && frame.loaderId) newDocument(targetId, frame.loaderId, frame.url);
      }
    },
    { internal: true },
  );
  await monitorCall('Target.setDiscoverTargets', { discover: true }).catch(() => undefined);
  const { targetInfos } = await monitorCall('Target.getTargets').catch(() => ({ targetInfos: [] }));
  for (const t of targetInfos as { targetId: string; type: string }[]) if (t.type === 'page') await watchPage(t.targetId);

  /** Installs the mask in a tab (now and in every later document); throws when it could not. */
  const maskSecrets = async (targetId: string) => {
    if (monitor.masked.has(targetId)) return;
    await watchPage(targetId);
    const session = monitor.pages.get(targetId);
    if (!session) throw new Error('Unknown tab');
    await monitorCall('Page.addScriptToEvaluateOnNewDocument', { source: SECRET_MASK_SOURCE, runImmediately: true, worldName: 'artemis-secret-mask' }, session);
    // Marked only once it is in place: a failed attempt is tried again next time.
    monitor.masked.add(targetId);
  };
  const secretState = () => ({
    live: monitor.secretsLive.size > 0,
    paused: [...monitor.paused.keys()],
    ownerTyped: [...monitor.ownerTyped.keys()],
  });
  /** Closes pages whose renderer does not answer (a hung script); a blank page is left if none remain. */
  const probePages = async (timeoutMs: number) => {
    const { targetInfos } = await monitorCall('Target.getTargets', {}, undefined, timeoutMs);
    const pages = (targetInfos as { targetId: string; type: string }[]).filter((t) => t.type === 'page');
    const hung: string[] = [];
    await Promise.all(pages.map(async ({ targetId }) => {
      try {
        await Promise.race([watchPage(targetId), sleep(timeoutMs)]);
        const session = monitor.pages.get(targetId);
        if (!session) throw new Error('not attached');
        await monitorCall('Runtime.evaluate', { expression: '1', returnByValue: true }, session, timeoutMs);
      } catch {
        hung.push(targetId);
      }
    }));
    for (const targetId of hung) {
      forget(targetId);
      await monitorCall('Target.closeTarget', { targetId }, undefined, timeoutMs).catch(() => undefined);
    }
    if (hung.length && hung.length === pages.length) await monitorCall('Target.createTarget', { url: 'about:blank' }).catch(() => undefined);
    return { checked: pages.length, closed: hung };
  };
  router.secrets = {
    isPaused: (targetId) => monitor.paused.has(targetId),
    sensitive: (text) => fingerprints.matches(text),
  };
  // The owner typing in a tab during a takeover: the engine keeps scripts off it until it loads a new document.
  router.onViewerInput = (targetId) => {
    if (!monitor.ownerTyped.has(targetId)) monitor.ownerTyped.set(targetId, monitor.loaders.get(targetId));
  };
  router.hostMethod = async (method, params, client) => {
    if (method === 'Artemis.getSecretState' && client.role === 'agent') return secretState();
    if (method === 'Artemis.probePages' && client.role === 'agent') {
      const timeoutMs = typeof params.timeoutMs === 'number' ? Math.min(15_000, Math.max(500, params.timeoutMs)) : 5_000;
      return probePages(timeoutMs);
    }
    if (method === 'Artemis.setSecretState' && client.role === 'agent') {
      if (typeof params.live !== 'boolean') throw new Error('"live" must be true or false');
      // Reports arrive in order per run; a late one never undoes a newer one.
      if (typeof params.seq === 'number') {
        if (params.seq <= (monitor.seq.get(client.id) ?? -1)) return secretState();
        monitor.seq.set(client.id, params.seq);
      }
      const set = parseFingerprintSet(params.fingerprints);
      if (set) fingerprints.add(set);
      const pause = Array.isArray(params.pause) ? params.pause.filter((t): t is string => typeof t === 'string' && VALID_TARGET.test(t)).slice(0, 16) : [];
      let newlyPaused = false;
      for (const targetId of pause) {
        // The mask first: the password is typed only once it is in place.
        await maskSecrets(targetId);
        const now = Date.now();
        const loaderId = monitor.loaders.get(targetId);
        const current = monitor.paused.get(targetId);
        if (current) {
          if (now - current.since < pauseMaxMs) current.renewedAt = now;
          if (loaderId) current.loaderId = loaderId;
        } else {
          monitor.paused.set(targetId, { since: now, renewedAt: now, ...(loaderId ? { loaderId } : {}) });
          newlyPaused = true;
        }
      }
      if (params.live) monitor.secretsLive.add(client.id);
      else monitor.secretsLive.delete(client.id);
      if (pause.length) pausedChanged(newlyPaused);
      // New fingerprints: a tab already showing the password is paused now.
      if (set) for (const targetId of monitor.info.keys()) pauseIfShowingSecret(targetId);
      return secretState();
    }
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
  // A client that attaches to a page may reset its emulation (Playwright does
  // on connect): the host's viewport is applied again once it has settled.
  router.onAttach = (targetId) => {
    for (const delay of [300, 1_500]) setTimeout(() => void emulate(targetId), delay);
  };
  // A viewer that goes away gives its pages their normal size back.
  router.onDrop = (client) => {
    // A run that ends ends its live password (its process is gone); its
    // paused tabs stay paused until they load a new document or time out.
    monitor.secretsLive.delete(client.id);
    monitor.seq.delete(client.id);
    for (const [targetId, phone] of monitor.mobile) {
      if (phone.client !== client.id) continue;
      monitor.mobile.delete(targetId);
      void emulate(targetId);
    }
  };

  // ── serving clients ─────────────────────────────────────────────────────
  const agentToken = randomBytes(32).toString('base64url');
  const viewerToken = randomBytes(32).toString('base64url');
  type Socket = ReturnType<typeof attachWebSocket>;
  /** Open connections, with their role and when they last sent a message (not a pong). */
  const sockets = new Map<Socket, { role: ClientRole; lastMessage: number }>();
  let agentSockets = 0;
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
    if (shuttingDown || !role || !accept) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (sockets.size >= MAX_CLIENTS && role === 'viewer') {
      // Full: a new viewer takes the place of the viewer connection quiet
      // for longest (connections opened just to fill the slots go first).
      let quietest: Socket | undefined;
      for (const [ws, info] of sockets) {
        if (info.role === 'viewer' && (!quietest || info.lastMessage < sockets.get(quietest)!.lastMessage)) quietest = ws;
      }
      if (quietest) {
        sockets.delete(quietest);
        quietest.close();
      }
    }
    // Agent-token clients never take the last slots: the owner's view can always connect.
    if (sockets.size >= MAX_CLIENTS || (role === 'agent' && agentSockets >= MAX_CLIENTS - VIEWER_RESERVED)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write(accept);
    const info = { role, lastMessage: Date.now() };
    // The callbacks only fire on later socket events, after `client` exists.
    const ws = attachWebSocket(
      socket,
      (text) => {
        info.lastMessage = Date.now();
        client.receive(text);
      },
      () => {
        sockets.delete(ws);
        if (role === 'agent') agentSockets--;
        client.close();
      },
    );
    sockets.set(ws, info);
    if (role === 'agent') agentSockets++;
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
    for (const ws of sockets.keys()) {
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
