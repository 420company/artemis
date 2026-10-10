/**
 * The live browser host: a detached process that owns one Chromium and
 * shares its DevTools pipe with local clients (see liveBrowser.ts for the
 * files it writes and cdpRouter.ts for the sharing rules).
 *
 * Started by an engine run as `node browserHost.js <config JSON>`; exits
 * after the configured idle time without clients, when Chromium exits, or
 * on SIGTERM. Never started by hand.
 */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CdpRouter, type ClientRole } from './cdpRouter.js';
import { LIVE_FILES, isPidAlive, readJsonFile, writeJsonFileAtomic, type HostConfig, type HostInfo, type ViewerInfo } from './liveBrowser.js';
import { attachWebSocket, handshakeResponse } from './wsFrames.js';

const MAX_CLIENTS = 8;
const IDLE_CHECK_MS = 5_000;

function chromeArgs(config: HostConfig): string[] {
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
    '--window-size=1280,800',
    '--lang=zh-CN',
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

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? '{}') as HostConfig;
  const dir = config.liveDir;
  const hostFile = path.join(dir, LIVE_FILES.host);
  const viewerFile = path.join(dir, LIVE_FILES.viewer);
  const errorFile = path.join(dir, 'host-error.txt');

  // Single instance: another live host already serves this directory.
  const other = readJsonFile<HostInfo>(hostFile);
  if (other && other.pid !== process.pid && isPidAlive(other.pid)) process.exit(0);

  const fail = (message: string) => {
    try {
      fs.writeFileSync(errorFile, message.slice(0, 2000), { mode: 0o600 });
    } catch { /* nothing more to do */ }
    process.exit(1);
  };

  fs.mkdirSync(config.profileDir, { recursive: true, mode: 0o700 });
  const chrome = spawn(config.executable, chromeArgs(config), {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env: process.env,
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

  let shuttingDown = false;
  const cleanup = () => {
    for (const file of [hostFile, viewerFile, path.join(dir, LIVE_FILES.tab)]) {
      // Only our own files: a newer host may have replaced them.
      const owner = readJsonFile<{ pid?: number }>(file);
      if (file.endsWith(LIVE_FILES.tab) || owner?.pid === process.pid) fs.rmSync(file, { force: true });
    }
  };
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.race([router.call('Browser.close').catch(() => undefined), new Promise((r) => setTimeout(r, 3_000))]);
    if (chrome.exitCode === null) chrome.kill('SIGTERM');
    cleanup();
    process.exit(code);
  };
  chrome.once('exit', () => {
    router.failAll('browser exited');
    if (!shuttingDown) {
      shuttingDown = true;
      cleanup();
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

  const agentToken = randomBytes(32).toString('base64url');
  const viewerToken = randomBytes(32).toString('base64url');
  const server = http.createServer((_req, res) => {
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
    if (!role || !accept || router.clientCount >= MAX_CLIENTS) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write(accept);
    // The callbacks only fire on later socket events, after `client` exists.
    const ws = attachWebSocket(
      socket,
      (text) => client.receive(text),
      () => client.close(),
    );
    const client = router.addClient(role, ws.send);
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const startedAt = new Date().toISOString();
  fs.rmSync(errorFile, { force: true });
  // The viewer file first: an engine waiting on host.json then finds both.
  writeJsonFileAtomic(viewerFile, { version: 1, pid: process.pid, port, token: viewerToken, startedAt } satisfies ViewerInfo, 0o640);
  writeJsonFileAtomic(hostFile, { version: 1, pid: process.pid, chromePid: chrome.pid ?? 0, port, agentToken, startedAt } satisfies HostInfo, 0o600);

  setInterval(() => {
    if (router.clientCount === 0 && Date.now() - router.lastChange > config.idleMs) void shutdown(0);
  }, Math.min(IDLE_CHECK_MS, config.idleMs)).unref?.();
}

void main().catch((err: unknown) => {
  try {
    const dir = (JSON.parse(process.argv[2] ?? '{}') as HostConfig).liveDir;
    if (dir) fs.writeFileSync(path.join(dir, 'host-error.txt'), String(err instanceof Error ? err.message : err).slice(0, 2000), { mode: 0o600 });
  } catch { /* nothing more to do */ }
  process.exit(1);
});
