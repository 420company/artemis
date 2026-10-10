#!/usr/bin/env tsx
/**
 * scripts/browserLiveManualSmoke.ts — the live browser against a real headless Chromium.
 *
 * Manual (needs Chromium; not part of the CI chains):
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
 *     node --no-warnings node_modules/tsx/dist/cli.mjs scripts/browserLiveManualSmoke.ts
 *
 * ARTEMIS_BROWSER_EXECUTABLE picks a Chromium when Playwright's own revision
 * is not installed (the script also tries $PLAYWRIGHT_BROWSERS_PATH/chromium).
 *
 * Checks, end to end: an engine browser tool starts the host; the viewer
 * token (what the platform server uses) streams screencast frames, is
 * refused anything outside its whitelist, and its mouse click and IME text
 * land in the page; a wrong token is refused; takeover blocks the tools and
 * the handback is reported with the page; the browser survives the run
 * disconnecting and the next run continues in the same tab; the host exits
 * on SIGTERM and removes its files.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-live-manual-'));
const liveDir = path.join(root, 'live');
process.env.ARTEMIS_HOME = path.join(root, 'home');
process.env.ARTEMIS_BROWSER_LIVE_DIR = liveDir;
process.env.ARTEMIS_BROWSER_HEADLESS = '1';
process.env.ARTEMIS_BROWSER_TAKEOVER_WAIT_MS = '300';
process.env.ARTEMIS_BROWSER_IDLE_MS = '60000';

async function resolveExecutable(): Promise<void> {
  if (process.env.ARTEMIS_BROWSER_EXECUTABLE) return;
  const { chromium } = await import('playwright');
  const candidates = [chromium.executablePath(), process.env.PLAYWRIGHT_BROWSERS_PATH ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : ''];
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (!found) throw new Error(`No Chromium found (tried ${candidates.filter(Boolean).join(', ')}); set ARTEMIS_BROWSER_EXECUTABLE`);
  process.env.ARTEMIS_BROWSER_EXECUTABLE = found;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Live smoke</title>
<style>body{margin:0;font:16px sans-serif}#b{position:absolute;left:100px;top:120px;width:200px;height:80px}#q{position:absolute;left:100px;top:260px;width:300px}</style>
<button id="b" onclick="window.clicks=(window.clicks||0)+1;this.textContent='clicked '+window.clicks">Click me</button>
<input id="q" placeholder="type here">`;

class Viewer {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (m: any) => void>();
  readonly events: any[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else this.events.push(m);
    };
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('viewer connection refused'));
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close(): void {
    this.ws.close();
  }
}

async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main(): Promise<void> {
  await resolveExecutable();
  const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

  const tools = await import('../src/tools/browser/browserTools.js');
  const session = await import('../src/tools/browser/browserSession.js');
  const live = await import('../src/tools/browser/liveBrowser.js');

  const nav = await tools.executeBrowserNavigate({ type: 'browser_navigate', url });
  assert.equal(nav.ok, true, nav.output);
  const host = live.readJsonFile<{ pid: number; port: number }>(path.join(liveDir, 'host.json'))!;
  const viewerInfo = live.readJsonFile<{ port: number; token: string }>(path.join(liveDir, 'viewer.json'))!;
  assert.equal(fs.statSync(path.join(liveDir, 'host.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(liveDir, 'viewer.json')).mode & 0o777, 0o640);
  const tab = live.readJsonFile<{ targetId: string; url: string }>(path.join(liveDir, 'tab.json'))!;
  assert.equal(tab.url, url);
  console.log(`  ✓ host ${host.pid} on 127.0.0.1:${host.port}; the agent's tab is reported (${tab.targetId.slice(0, 8)})`);

  // A wrong token, and plain HTTP discovery, are refused.
  const bad = new Viewer(`ws://127.0.0.1:${viewerInfo.port}/cdp/${'A'.repeat(43)}`);
  await assert.rejects(bad.open(), /refused/);
  const discovery = await fetch(`http://127.0.0.1:${viewerInfo.port}/json/version`);
  assert.equal(discovery.status, 404);
  console.log('  ✓ wrong token and /json discovery refused');

  const viewer = new Viewer(`ws://127.0.0.1:${viewerInfo.port}/cdp/${viewerInfo.token}`);
  await viewer.open();
  const refused = await viewer.send('Runtime.evaluate', { expression: 'document.cookie' });
  assert.match(refused.error?.message ?? '', /not allowed/);
  const targets = await viewer.send('Target.getTargets');
  const page = targets.result.targetInfos.find((t: any) => t.targetId === tab.targetId);
  assert.ok(page, 'the reported tab is a page target');
  const attached = await viewer.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  const sid = attached.result.sessionId as string;
  await viewer.send('Page.enable', {}, sid);
  const started = await viewer.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }, sid);
  assert.ok(!started.error, JSON.stringify(started.error));
  const frame = await waitFor('a screencast frame', () => viewer.events.find((e) => e.method === 'Page.screencastFrame' && e.sessionId === sid));
  await viewer.send('Page.screencastFrameAck', { sessionId: frame.params.sessionId }, sid);
  const jpeg = Buffer.from(frame.params.data, 'base64');
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  console.log(`  ✓ screencast frame: ${jpeg.length} bytes JPEG, ${frame.params.metadata.deviceWidth}x${frame.params.metadata.deviceHeight} CSS px`);

  // A click through the viewer lands on the button (CSS px in the page).
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    const r = await viewer.send('Input.dispatchMouseEvent', { type, x: 200, y: 160, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, sid);
    assert.ok(!r.error, JSON.stringify(r.error));
  }
  const clicks = await tools.executeBrowserEvaluate({ type: 'browser_evaluate', script: 'window.clicks || 0' });
  assert.match(clicks.output, /\b1\b/, clicks.output);
  console.log('  ✓ viewer click landed (window.clicks = 1)');
  // Focus the input and commit IME text.
  for (const type of ['mousePressed', 'mouseReleased']) await viewer.send('Input.dispatchMouseEvent', { type, x: 150, y: 270, button: 'left', clickCount: 1 }, sid);
  await viewer.send('Input.insertText', { text: '你好 live' }, sid);
  await viewer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sid);
  await viewer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sid);
  const typed = await tools.executeBrowserEvaluate({ type: 'browser_evaluate', script: 'document.querySelector("#q").value' });
  assert.match(typed.output, /你好 liv"/, typed.output);
  const nav2 = await viewer.send('Page.navigate', { url: 'javascript:alert(1)' }, sid);
  assert.match(nav2.error?.message ?? '', /http/);
  console.log('  ✓ viewer IME text and keys landed; javascript: navigation refused');

  // Takeover: tools refuse while the user holds the browser...
  live.writeJsonFileAtomic(path.join(liveDir, 'control.json'), { mode: 'user', since: Date.now() }, 0o640);
  const blocked = await tools.executeBrowserExtract({ type: 'browser_extract_text' });
  assert.equal(blocked.error?.code, 'browser_user_in_control');
  // ...and the next result after the handback says where the browser is.
  live.writeJsonFileAtomic(path.join(liveDir, 'control.json'), { mode: 'agent', since: Date.now(), handedBackAt: Date.now(), targetId: tab.targetId, url, title: 'Live smoke' }, 0o640);
  const after = await tools.executeBrowserExtract({ type: 'browser_extract_text', selector: '#b' });
  assert.ok(after.output.startsWith('[The user took over the browser and handed it back'), after.output);
  assert.match(after.output, /Live smoke — http:\/\/127\.0\.0\.1/);
  assert.match(after.output, /clicked 1/);
  console.log('  ✓ takeover blocks the tools; the handback note names the page');

  // The run ends: the browser stays, the next run continues in the same tab.
  await session.releaseBrowser();
  assert.ok(live.isPidAlive(host.pid), 'host still running');
  const again = await tools.executeBrowserExtract({ type: 'browser_extract_text', selector: '#b' });
  assert.match(again.output, /clicked 1/, again.output);
  const host2 = live.readJsonFile<{ pid: number }>(path.join(liveDir, 'host.json'))!;
  assert.equal(host2.pid, host.pid, 'the same host serves the next run');
  console.log('  ✓ the browser outlives the run; the next connection continues in the same tab');

  viewer.close();
  await session.releaseBrowser();
  process.kill(host.pid, 'SIGTERM');
  await waitFor('the host to exit', () => !live.isPidAlive(host.pid), 10_000);
  assert.equal(fs.existsSync(path.join(liveDir, 'host.json')), false);
  assert.equal(fs.existsSync(path.join(liveDir, 'viewer.json')), false);
  console.log('  ✓ the host exits on SIGTERM and removes its files');
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('\nbrowser live manual smoke: passed');
}

main().catch(async (err) => {
  console.error(err);
  const host = (await import('../src/tools/browser/liveBrowser.js')).readJsonFile<{ pid: number }>(path.join(liveDir, 'host.json'));
  if (host?.pid) try { process.kill(host.pid, 'SIGTERM'); } catch { /* gone */ }
  process.exit(1);
});
