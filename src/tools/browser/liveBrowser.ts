/**
 * Live browser mode: one long-lived Chromium the owner can watch and take
 * over from the web app, shared by every engine run on the machine.
 *
 * Enabled when ARTEMIS_BROWSER_LIVE_DIR names a directory (the platform
 * server sets it for its runs). Without it the browser tools behave as
 * before: Playwright launches a private Chromium for this process.
 *
 * Processes and files (all in the live directory):
 *
 *   browser host   A small detached Node process (browserHost.ts) that owns
 *                  Chromium through `--remote-debugging-pipe`, so there is no
 *                  DevTools TCP port at all. It serves CDP to local clients
 *                  on 127.0.0.1:<random port>, and only on a path that
 *                  carries a 256-bit token. It outlives the run that
 *                  started it and exits after ARTEMIS_BROWSER_IDLE_MS
 *                  (default 10 minutes) without any client.
 *   host.json      0600, this user only: pid, port and the agent token
 *                  (full CDP). Read by engine runs to connect Playwright.
 *   viewer.json    0640: port and the viewer token. The viewer token only
 *                  allows screencast, input and a few navigation calls (see
 *                  cdpRouter.ts). Group-readable so a server running as
 *                  another user in a shared group can read it.
 *   tab.json       0640, written by the engine: the tab the agent works in.
 *   control.json   Written by the platform server: who controls the
 *                  browser ('agent' or 'user'), and when the user last
 *                  handed it back. The engine only reads it.
 *   agent.json     0600, written by the engine: the last handback a run
 *                  told its model about (each run also remembers its own).
 *   claims/        0600, one file per tab an engine run works in (its pid):
 *                  each run has its own tabs; a finished run leaves its last
 *                  tab unclaimed for the owner and the next run.
 *
 * Takeover is cooperative on the engine's side: while control.json says
 * 'user', browser tools wait a little and then report that the user is in
 * control, instead of touching the page. The platform server is the
 * authority for what the owner may do (it forwards input only while the
 * owner holds control).
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIVE_DIR_ENV = 'ARTEMIS_BROWSER_LIVE_DIR';

export const LIVE_FILES = {
  host: 'host.json',
  viewer: 'viewer.json',
  tab: 'tab.json',
  control: 'control.json',
  agent: 'agent.json',
  lock: 'spawn.lock',
  claims: 'claims',
} as const;

export interface HostInfo {
  version: 1;
  pid: number;
  chromePid: number;
  port: number;
  agentToken: string;
  startedAt: string;
}

export interface ViewerInfo {
  version: 1;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export interface ControlState {
  mode: 'agent' | 'user';
  /** When the mode last changed (ms). */
  since: number;
  /** When the user last handed the browser back (ms). */
  handedBackAt?: number;
  /**
   * How the last takeover ended: the owner handed back, or the server took
   * it back (no input for a while, the server restarted, the browser closed).
   */
  endedBy?: 'owner' | 'idle' | 'restart' | 'closed';
  /** The tab the user left the browser on. */
  targetId?: string;
  url?: string;
  title?: string;
}

export interface TabReport {
  targetId?: string;
  url: string;
  title: string;
  updatedAt: number;
}

/** The live directory, or undefined when live mode is off. */
export function liveDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[LIVE_DIR_ENV]?.trim();
  return raw ? path.resolve(raw) : undefined;
}

export function readJsonFile<T>(file: string): T | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Writes through a temporary file and rename, so readers never see half a file. */
export function writeJsonFileAtomic(file: string, data: unknown, mode: number): void {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode });
  // umask may have narrowed the mode; set it exactly.
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function ensureLiveDir(dir: string): void {
  // 0750: the owner and (when provisioning sets a shared group) the server.
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
}

export function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readControl(dir: string): ControlState {
  const raw = readJsonFile<Partial<ControlState>>(path.join(dir, LIVE_FILES.control));
  const mode = raw?.mode === 'user' ? 'user' : 'agent';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 2000) : undefined);
  const handedBackAt = num(raw?.handedBackAt);
  const endedBy = raw?.endedBy === 'idle' || raw?.endedBy === 'restart' || raw?.endedBy === 'closed' || raw?.endedBy === 'owner' ? raw.endedBy : undefined;
  const targetId = str(raw?.targetId);
  const url = str(raw?.url);
  const title = str(raw?.title);
  return {
    mode,
    since: num(raw?.since) ?? 0,
    ...(handedBackAt !== undefined ? { handedBackAt } : {}),
    ...(endedBy ? { endedBy } : {}),
    ...(targetId ? { targetId } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
  };
}

export function writeTabReport(dir: string, tab: Omit<TabReport, 'updatedAt'>, now = Date.now()): void {
  try {
    writeJsonFileAtomic(path.join(dir, LIVE_FILES.tab), { ...tab, updatedAt: now }, 0o640);
  } catch {
    // Best effort: the viewer then simply follows the first tab.
  }
}

/**
 * The last handback this run told its model about. Per run: concurrent runs
 * each hear about a handback once. A new run starts from the last one any
 * run reported (agent.json), so an old handback is not repeated.
 */
const seenByRun = new Map<string, number>();

function readSeenHandback(dir: string): number {
  const known = seenByRun.get(dir);
  if (known !== undefined) return known;
  const raw = readJsonFile<{ seenHandbackAt?: number }>(path.join(dir, LIVE_FILES.agent));
  const at = typeof raw?.seenHandbackAt === 'number' ? raw.seenHandbackAt : 0;
  seenByRun.set(dir, at);
  return at;
}

function writeSeenHandback(dir: string, at: number): void {
  seenByRun.set(dir, at);
  try {
    const raw = readJsonFile<{ seenHandbackAt?: number }>(path.join(dir, LIVE_FILES.agent));
    if (typeof raw?.seenHandbackAt === 'number' && raw.seenHandbackAt >= at) return;
    writeJsonFileAtomic(path.join(dir, LIVE_FILES.agent), { seenHandbackAt: at }, 0o600);
  } catch {
    // The next run may then hear about it once more; harmless.
  }
}

/** Forgets this process's per-run state (tests). */
export function resetRunState(): void {
  seenByRun.clear();
}

// ── takeover gate ───────────────────────────────────────────────────────────

export interface GateOptions {
  /** How long a tool waits for the user to hand back before giving up (default 30 s). */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export type GateResult =
  | { state: 'free'; handback?: ControlState }
  | { state: 'user'; since: number };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait time for browser tools while the user is in control (ARTEMIS_BROWSER_TAKEOVER_WAIT_MS). */
export function takeoverWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ARTEMIS_BROWSER_TAKEOVER_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 10 * 60_000) : 30_000;
}

/**
 * Before a browser tool touches the page: free, or the user is in control
 * (after waiting up to `waitMs` for them to hand back). A handback the model
 * has not heard about yet comes back once as `handback`.
 */
export async function browserGate(dir: string, options: GateOptions = {}): Promise<GateResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 1_000;
  const deadline = now() + (options.waitMs ?? takeoverWaitMs());
  let control = readControl(dir);
  while (control.mode === 'user') {
    if (now() >= deadline || options.signal?.aborted) return { state: 'user', since: control.since };
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    control = readControl(dir);
  }
  return consumeHandback(dir, control);
}

function consumeHandback(dir: string, control: ControlState): GateResult {
  if (control.handedBackAt && control.handedBackAt > readSeenHandback(dir)) {
    writeSeenHandback(dir, control.handedBackAt);
    return { state: 'free', handback: control };
  }
  return { state: 'free' };
}

/** What the model reads when it calls a browser tool while the user is in control. */
export function userInControlMessage(since: number, now = Date.now()): string {
  const minutes = since ? Math.max(0, Math.round((now - since) / 60_000)) : 0;
  return [
    `The user is controlling the browser right now (they took over ${minutes ? `${minutes} min ago` : 'just now'}, for example to sign in or solve a check).`,
    'Do not use the browser until they hand it back. If you need them to finish a step there, call browser_request_handoff and wait;',
    'otherwise continue with other work, or tell the user what you are waiting for.',
  ].join(' ');
}

/** The note added to the first browser tool result after a handback. */
export function handbackNote(control: ControlState, current?: { url: string; title: string }): string {
  const at = control.handedBackAt ? new Date(control.handedBackAt).toISOString().slice(11, 16) : '';
  const page = current ?? (control.url ? { url: control.url, title: control.title ?? '' } : undefined);
  const ended = control.endedBy === 'idle'
    ? 'timed out after a while without input'
    : control.endedBy === 'restart'
      ? 'ended because the platform restarted'
      : 'ended when the browser view closed';
  const how = !control.endedBy || control.endedBy === 'owner'
    ? `[The user took over the browser and handed it back${at ? ` at ${at} UTC` : ''}.`
    : `[The user took over the browser, but did not hand it back: the takeover ${ended}${at ? ` at ${at} UTC` : ''}. They may not have finished what they were doing.`;
  return [
    how,
    page ? `It is now on: ${page.title ? `${page.title} — ` : ''}${page.url}.` : '',
    'Pages may have changed (for example the user signed in); check the page before relying on earlier observations.]',
  ].filter(Boolean).join(' ');
}

// ── handoff requests ────────────────────────────────────────────────────────

export interface HandoffEvent {
  id: string;
  /** done: handed back; timeout: the takeover ended without a handback; expired: no longer waited for. */
  status: 'waiting' | 'done' | 'timeout' | 'expired';
  reason?: string;
  url?: string;
  title?: string;
}

/** The structured line the platform server turns into a card. */
export function handoffLine(event: HandoffEvent): string {
  const clean = (s: string | undefined, max: number) => (s === undefined ? undefined : s.replace(/[\r\n]+/g, ' ').slice(0, max));
  const payload = {
    id: event.id,
    status: event.status,
    ...(event.reason !== undefined ? { reason: clean(event.reason, 500) } : {}),
    ...(event.url !== undefined ? { url: clean(event.url, 2000) } : {}),
    ...(event.title !== undefined ? { title: clean(event.title, 300) } : {}),
  };
  return `[browser-handoff] ${JSON.stringify(payload)}`;
}

export function emitHandoff(event: HandoffEvent, write: (line: string) => void = (line) => process.stderr.write(line)): void {
  write(`${handoffLine(event)}\n`);
}

export type HandbackOutcome = 'handed_back' | 'not_taken' | 'still_in_control' | 'aborted';

/**
 * Waits for the user to take over and hand back (a handback after `since`).
 * The handback is marked as seen: the tool result already tells the model.
 */
export async function waitForHandback(
  dir: string,
  since: number,
  timeoutMs: number,
  options: { pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<{ outcome: HandbackOutcome; control: ControlState }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 1_000;
  const deadline = now() + timeoutMs;
  for (;;) {
    const control = readControl(dir);
    if (control.mode === 'agent' && control.handedBackAt && control.handedBackAt >= since) {
      writeSeenHandback(dir, control.handedBackAt);
      return { outcome: 'handed_back', control };
    }
    if (options.signal?.aborted) return { outcome: 'aborted', control };
    if (now() >= deadline) return { outcome: control.mode === 'user' ? 'still_in_control' : 'not_taken', control };
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

export function newHandoffId(): string {
  return randomUUID();
}

// ── the host process ────────────────────────────────────────────────────────

export interface HostConfig {
  liveDir: string;
  executable: string;
  profileDir: string;
  headless: boolean;
  args: string[];
  userAgent?: string;
  idleMs: number;
  /** Applied to every page by the host (the engine's former context options). */
  viewport?: { width: number; height: number };
  timezoneId?: string;
  locale?: string;
  /** How long a tab stays paused after the last password typing at most (tests; default 3 minutes). */
  secretPauseMs?: number;
  /** How long a tab may be paused in all, across pauses (tests; default 4 x secretPauseMs). */
  secretPauseMaxMs?: number;
}

/** The host's answer when a tab may not be paused again (it was paused long enough in all). */
export const PAUSE_USED_UP = 'pause_used_up: this tab has been paused for a password long enough';

/** ARTEMIS_BROWSER_SECRET_PAUSE_MS, for tests: how long a password pause lasts at most. */
export function secretPauseMs(env: NodeJS.ProcessEnv = process.env, name = 'ARTEMIS_BROWSER_SECRET_PAUSE_MS'): number | undefined {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.min(raw, 3_600_000) : undefined;
}

/** Idle time before the host closes the browser (ARTEMIS_BROWSER_IDLE_MS, default 10 minutes). */
export function browserIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ARTEMIS_BROWSER_IDLE_MS);
  return Number.isFinite(raw) && raw >= 5_000 ? Math.min(raw, 24 * 3600_000) : 10 * 60_000;
}

/** Environment passed to the host and Chromium: what a browser needs, none of the engine's keys. */
export function hostEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|FONTCONFIG_[A-Z_]+|PLAYWRIGHT_BROWSERS_PATH|SYSTEMROOT|WINDIR|APPDATA|LOCALAPPDATA|PROGRAMFILES|TEMP|TMP)$/;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && keep.test(key)) out[key] = value;
  }
  return out;
}

function hostScript(): string {
  // Next to this module: .ts under tsx (development, tests), .js when built.
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return fileURLToPath(new URL(`./browserHost${ext}`, import.meta.url));
}

/**
 * Whether a live host answers on this port with this token: a WebSocket
 * handshake that must succeed (101). A port that is merely open, or a pid
 * that is alive, proves nothing (both are reused).
 */
export function probeHost(port: number, token: string, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      req.destroy();
      resolve(ok);
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/cdp/${token}`,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') },
      timeout: timeoutMs,
    });
    req.on('upgrade', (_res, socket) => {
      // Close politely so the host drops the probe at once.
      socket.end(Buffer.from([0x88, 0x82, 0, 0, 0, 0, 0x03, 0xe8]));
      finish(true);
    });
    req.on('response', () => finish(false));
    req.on('timeout', () => finish(false));
    req.on('error', () => finish(false));
    req.end();
  });
}

/** The running host, if host.json names a live process that answers with its token. */
export async function runningHost(dir: string): Promise<HostInfo | undefined> {
  const host = readJsonFile<HostInfo>(path.join(dir, LIVE_FILES.host));
  if (!host || host.version !== 1 || !isPidAlive(host.pid) || typeof host.port !== 'number' || typeof host.agentToken !== 'string') return undefined;
  return (await probeHost(host.port, host.agentToken)) ? host : undefined;
}

export function agentEndpoint(host: HostInfo): string {
  return `ws://127.0.0.1:${host.port}/cdp/${host.agentToken}`;
}

/**
 * One call to the host on a connection of its own (no Playwright): used
 * when Playwright cannot connect, to ask the host to close hung pages
 * (`Artemis.probePages`). Rejects when the host does not answer in time.
 */
export function hostCall(host: HostInfo, method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(agentEndpoint(host));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(result ?? {});
    };
    const timer = setTimeout(() => finish(new Error(`the browser host did not answer ${method}`)), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onerror = () => finish(new Error('cannot reach the browser host'));
    ws.onclose = () => finish(new Error('the browser host closed the connection'));
    ws.onmessage = (event) => {
      let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }
      if (message.id !== 1) return;
      if (message.error) finish(new Error(message.error.message ?? 'host error'));
      else finish(undefined, message.result);
    };
  });
}

/**
 * Returns a running host, starting one when needed. Concurrent runs agree
 * through an exclusive lock file; a stale lock (older than 30 s) is broken.
 */
export async function ensureHost(config: HostConfig, options: { timeoutMs?: number } = {}): Promise<HostInfo> {
  const dir = config.liveDir;
  ensureLiveDir(dir);
  const existing = await runningHost(dir);
  if (existing) return existing;
  // A host the platform runs (ARTEMIS_BROWSER_HOST=managed, `artemis
  // browser-host`): it starts and restarts the host in a process group (and
  // cgroup) of its own, so a run's end never takes it down; a run only waits
  // for it and never starts one itself.
  if (hostManaged()) {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      await defaultSleep(200);
      const host = await runningHost(dir);
      if (host) return host;
    }
    throw new Error('the browser is not running (the platform starts it); try again in a moment');
  }
  const lockFile = path.join(dir, LIVE_FILES.lock);
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let locked = false;
  while (!locked) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
      locked = true;
    } catch {
      // Another run is starting the host: wait for it, or break a stale lock.
      const host = await runningHost(dir);
      if (host) return host;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > 30_000) fs.rmSync(lockFile, { force: true });
      } catch { /* gone already */ }
      if (Date.now() > deadline) throw new Error('timed out waiting for the browser to start');
      await defaultSleep(200);
    }
  }
  try {
    // Twice at most: a host that finds a (stale) other host exits 0 without
    // writing its own files; the stale files are then removed and it starts again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const again = await runningHost(dir);
      if (again) return again;
      const child = spawn(process.execPath, [...process.execArgv, hostScript(), JSON.stringify(config)], {
        detached: true,
        stdio: 'ignore',
        env: hostEnv(),
        cwd: dir,
      });
      child.unref();
      let exitCode: number | null | undefined;
      child.once('exit', (code) => { exitCode = code; });
      let retry = false;
      while (Date.now() < deadline && !retry) {
        const host = readJsonFile<HostInfo>(path.join(dir, LIVE_FILES.host));
        if (host && host.pid === child.pid && (await probeHost(host.port, host.agentToken))) return host;
        if (exitCode !== undefined) {
          if (exitCode === 0) {
            const running = await runningHost(dir);
            if (running) return running;
            removeHostFiles(dir);
            retry = true;
            break;
          }
          let reason = '';
          try {
            reason = fs.readFileSync(path.join(dir, 'host-error.txt'), 'utf8').trim();
          } catch { /* no reason recorded */ }
          throw new Error(`the browser host exited during startup: ${reason || 'unknown error (is Chromium installed?)'}`);
        }
        await defaultSleep(100);
      }
      if (!retry) break;
    }
    throw new Error('timed out waiting for the browser to start');
  } finally {
    await fsp.rm(lockFile, { force: true });
  }
}

/** Whether the platform runs the host (runs never start one: ensureHost waits for it). */
export function hostManaged(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOST_MODE_ENV]?.trim() === 'managed';
}

/** ARTEMIS_BROWSER_HOST=managed: the platform starts the host (`artemis browser-host`). */
export const HOST_MODE_ENV = 'ARTEMIS_BROWSER_HOST';

/**
 * Runs a host in the foreground (`artemis browser-host`): the host is a
 * child of this process, in its process group, and this process exits with
 * it. SIGTERM and SIGINT are passed on. A host that finds another one
 * running exits at once (0).
 */
export function runHostForeground(config: HostConfig): Promise<number> {
  ensureLiveDir(config.liveDir);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, hostScript(), JSON.stringify(config)], {
      stdio: 'ignore',
      env: hostEnv(),
      cwd: config.liveDir,
    });
    const pass = (sig: NodeJS.Signals) => () => {
      try {
        child.kill(sig);
      } catch { /* gone */ }
    };
    process.on('SIGTERM', pass('SIGTERM'));
    process.on('SIGINT', pass('SIGINT'));
    child.once('error', () => resolve(1));
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Removes host.json and viewer.json (a host that is gone, or one being replaced). */
export function removeHostFiles(dir: string): void {
  for (const name of [LIVE_FILES.host, LIVE_FILES.viewer]) fs.rmSync(path.join(dir, name), { force: true });
}

/**
 * Stops a host that does not work (a connection to it timed out): SIGTERM,
 * then SIGKILL to the host and its Chromium, then removes its files, so the
 * next ensureHost starts a fresh one.
 */
export async function stopHost(dir: string, host: HostInfo, graceMs = 6_000): Promise<void> {
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch { /* gone */ }
  };
  signal(host.pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (isPidAlive(host.pid) && Date.now() < deadline) await defaultSleep(100);
  signal(host.pid, 'SIGKILL');
  if (host.chromePid) signal(host.chromePid, 'SIGKILL');
  const current = readJsonFile<HostInfo>(path.join(dir, LIVE_FILES.host));
  if (!current || current.pid === host.pid) removeHostFiles(dir);
}

// ── tabs: each run works in its own ─────────────────────────────────────────

function claimFile(dir: string, targetId: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,64}$/.test(targetId) ? path.join(dir, LIVE_FILES.claims, `${targetId}.json`) : undefined;
}

/** The pid of the live run that works in this tab, if another one does. */
export function tabOwner(dir: string, targetId: string): number | undefined {
  const file = claimFile(dir, targetId);
  const claim = file ? readJsonFile<{ pid?: number }>(file) : undefined;
  return claim?.pid && claim.pid !== process.pid && isPidAlive(claim.pid) ? claim.pid : undefined;
}

/**
 * Claims a tab for this run; false when another live run has it.
 *
 * Atomic: the claim is written to a file of its own and linked into place,
 * which fails when a claim exists. A claim whose run is gone is broken
 * explicitly, under a short lock, after checking again that it is still
 * that dead run's: two runs never both own a tab.
 */
export function claimTab(dir: string, targetId: string): boolean {
  const file = claimFile(dir, targetId);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = readJsonFile<{ pid?: number }>(file);
    if (existing?.pid === process.pid) return true;
    if (existing && isPidAlive(existing.pid)) return false;
    if (linkClaim(file)) return true;
    // A claim is there: a live run's (it lost the race to us), or a dead one's to break.
    if (!breakStaleClaim(file)) return readJsonFile<{ pid?: number }>(file)?.pid === process.pid;
  }
  return false;
}

function linkClaim(file: string): boolean {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
    fs.linkSync(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Removes a claim whose run is gone (or that cannot be read and is old); false when it is a live run's. */
function breakStaleClaim(file: string): boolean {
  const lock = `${file}.lock`;
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch {
    // Someone else is breaking it; a lock left by a dead run is old and goes.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true });
    } catch { /* gone already */ }
    return false;
  }
  try {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return true;
    }
    const claim = readJsonFile<{ pid?: number }>(file);
    const stale = claim ? !isPidAlive(claim.pid) : Date.now() - stat.mtimeMs > 10_000;
    if (!stale) return false;
    fs.rmSync(file, { force: true });
    return true;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Gives a tab up (the run ended, or the tab closed): only this run's own claim. */
export function releaseTab(dir: string, targetId: string): void {
  const file = claimFile(dir, targetId);
  if (!file) return;
  if (readJsonFile<{ pid?: number }>(file)?.pid === process.pid) fs.rmSync(file, { force: true });
}
