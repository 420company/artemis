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
 *   agent.json     0600, written by the engine: the last handback it told
 *                  the model about.
 *
 * Takeover is cooperative on the engine's side: while control.json says
 * 'user', browser tools wait a little and then report that the user is in
 * control, instead of touching the page. The platform server is the
 * authority for what the owner may do (it forwards input only while the
 * owner holds control).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
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
  const targetId = str(raw?.targetId);
  const url = str(raw?.url);
  const title = str(raw?.title);
  return {
    mode,
    since: num(raw?.since) ?? 0,
    ...(handedBackAt !== undefined ? { handedBackAt } : {}),
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

function readSeenHandback(dir: string): number {
  const raw = readJsonFile<{ seenHandbackAt?: number }>(path.join(dir, LIVE_FILES.agent));
  return typeof raw?.seenHandbackAt === 'number' ? raw.seenHandbackAt : 0;
}

function writeSeenHandback(dir: string, at: number): void {
  try {
    writeJsonFileAtomic(path.join(dir, LIVE_FILES.agent), { seenHandbackAt: at }, 0o600);
  } catch {
    // The note may then be repeated once; harmless.
  }
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
  return [
    `[The user took over the browser and handed it back${at ? ` at ${at} UTC` : ''}.`,
    page ? `It is now on: ${page.title ? `${page.title} — ` : ''}${page.url}.` : '',
    'Pages may have changed (for example the user signed in); check the page before relying on earlier observations.]',
  ].filter(Boolean).join(' ');
}

// ── handoff requests ────────────────────────────────────────────────────────

export interface HandoffEvent {
  id: string;
  status: 'waiting' | 'done' | 'expired';
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

function portOpen(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The running host, if host.json names a live process that answers. */
export async function runningHost(dir: string): Promise<HostInfo | undefined> {
  const host = readJsonFile<HostInfo>(path.join(dir, LIVE_FILES.host));
  if (!host || host.version !== 1 || !isPidAlive(host.pid) || typeof host.port !== 'number' || typeof host.agentToken !== 'string') return undefined;
  return (await portOpen(host.port)) ? host : undefined;
}

export function agentEndpoint(host: HostInfo): string {
  return `ws://127.0.0.1:${host.port}/cdp/${host.agentToken}`;
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
    const again = await runningHost(dir);
    if (again) return again;
    const child = spawn(process.execPath, [...process.execArgv, hostScript(), JSON.stringify(config)], {
      detached: true,
      stdio: 'ignore',
      env: hostEnv(),
      cwd: dir,
    });
    child.unref();
    let exited = false;
    child.once('exit', () => { exited = true; });
    while (Date.now() < deadline) {
      const host = readJsonFile<HostInfo>(path.join(dir, LIVE_FILES.host));
      if (host && host.pid === child.pid && (await portOpen(host.port))) return host;
      if (exited) {
        let reason = '';
        try {
          reason = fs.readFileSync(path.join(dir, 'host-error.txt'), 'utf8').trim();
        } catch { /* no reason recorded */ }
        throw new Error(`the browser host exited during startup: ${reason || 'unknown error (is Chromium installed?)'}`);
      }
      await defaultSleep(100);
    }
    throw new Error('timed out waiting for the browser to start');
  } finally {
    await fsp.rm(lockFile, { force: true });
  }
}
