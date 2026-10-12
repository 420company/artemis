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
 *
 * Sign-up passwords: the tab typed into (only that one) is paused for the
 * viewer until it loads a new document, also after the password stops being
 * live; a URL carrying it (a GET form) never reaches the viewer or tab.json;
 * a "show password" toggle that swaps the field stays masked; another run's
 * logs and scripts are refused while it is live; a pause ends on its own
 * after ARTEMIS_BROWSER_SECRET_PAUSE_MS. Also: scripts are refused on a tab
 * the owner typed into until it navigates; a hung tab is closed instead of
 * the browser being restarted; agent connections leave slots for viewers.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
process.env.ARTEMIS_BROWSER_SECRET_PAUSE_MS = '20000';
process.env.ARTEMIS_BROWSER_SECRET_PAUSE_MAX_MS = '60000';

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
<input id="q" placeholder="type here">
<input id="pw" type="password" style="position:absolute;left:100px;top:320px;width:300px">
<div id="echo" style="position:absolute;left:100px;top:360px"></div>
<script>document.getElementById('pw').addEventListener('input', (e) => { document.getElementById('echo').textContent = e.target.value })</script>`;

/** A sign-up form: GET (the password ends up in the URL), an echo of what is typed, a "show" toggle that swaps the field. */
const SIGNUP_PAGE = `<!doctype html><meta charset="utf-8"><title>Sign up</title>
<form action="/done" method="get"><input name="user" value="me"><input id="pw" name="password" type="password"><button id="go">go</button></form>
<button id="pop" onclick="window.open('/popup')">pop</button>
<button id="show" onclick="const o=document.getElementById('pw');const n=document.createElement('input');n.id='pw';n.name='password';n.type='text';n.value=o.value;o.replaceWith(n)">show</button>
<div id="echo"></div>
<script>document.addEventListener('input', (e) => { if (e.target.id === 'pw') { document.getElementById('echo').textContent = 'strength of ' + e.target.value; console.log('typed ' + e.target.value) } })</script>`;

/** A page that changes its URL (8 KB query) and title (8 KB) every 20 ms. */
const CHURN_PAGE = `<!doctype html><title>churn</title><script>let i = 0; setInterval(() => { i++; history.replaceState(null, '', '/churn?' + i + 'x'.repeat(8180) + Math.random()); document.title = i + 'y'.repeat(8170) + Math.random() }, 20)</script>churn`;

/** A page whose renderer hangs shortly after loading. */
const HANG_PAGE = `<!doctype html><title>hang</title><script>setTimeout(() => { for (;;) {} }, 300)</script>hang`;

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
      } else {
        this.events.push(m);
        // Like the platform server: every frame is acknowledged, so the next one comes.
        if (m.method === 'Page.screencastFrame') this.ws.send(JSON.stringify({ id: this.nextId++, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId }, sessionId: m.sessionId }));
      }
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
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const body = pathname === '/signup' ? SIGNUP_PAGE : pathname === '/done' ? '<title>Done</title>done' : pathname === '/hang' ? HANG_PAGE : pathname === '/popup' ? '<title>Popup</title>popup' : pathname === '/churn' ? CHURN_PAGE : PAGE;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

  const tools = await import('../src/tools/browser/browserTools.js');
  const session = await import('../src/tools/browser/browserSession.js');
  const live = await import('../src/tools/browser/liveBrowser.js');
  /** Reads the page directly (the test's eyes; not the model's browser_evaluate). */
  const pageEval = async (expression: string): Promise<string> => JSON.stringify(await (await session.getActivePage()).evaluate(expression));

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
  const jpeg = Buffer.from(frame.params.data, 'base64');
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  console.log(`  ✓ screencast frame: ${jpeg.length} bytes JPEG, ${frame.params.metadata.deviceWidth}x${frame.params.metadata.deviceHeight} CSS px`);

  // A click through the viewer lands on the button (CSS px in the page).
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    const r = await viewer.send('Input.dispatchMouseEvent', { type, x: 200, y: 160, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, sid);
    assert.ok(!r.error, JSON.stringify(r.error));
  }
  const clicks = await pageEval('window.clicks || 0');
  assert.match(clicks, /\b1\b/, clicks);
  console.log('  ✓ viewer click landed (window.clicks = 1)');
  // Focus the input and commit IME text.
  for (const type of ['mousePressed', 'mouseReleased']) await viewer.send('Input.dispatchMouseEvent', { type, x: 150, y: 270, button: 'left', clickCount: 1 }, sid);
  await viewer.send('Input.insertText', { text: '你好 live' }, sid);
  await viewer.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sid);
  await viewer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sid);
  const typed = await pageEval('document.querySelector("#q").value');
  assert.match(typed, /你好 liv"/, typed);
  const nav2 = await viewer.send('Page.navigate', { url: 'javascript:alert(1)' }, sid);
  assert.match(nav2.error?.message ?? '', /http/);
  console.log('  ✓ viewer IME text and keys landed; javascript: navigation refused');
  // The owner typed into this tab: the model's scripts stay off it until it loads a new page.
  const ownerTyped = await tools.executeBrowserEvaluate({ type: 'browser_evaluate', script: 'document.querySelector("#q").value' });
  assert.equal(ownerTyped.error?.code, 'owner_typed', ownerTyped.output);
  assert.ok(!ownerTyped.output.includes('你好'));
  console.log('  ✓ browser_evaluate is refused on a tab the owner typed into');

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

  // Review regressions: the viewer cannot run script; the page has the engine's viewport;
  // a phone viewport set through the host is undone again.
  const before = await pageEval('document.title');
  await viewer.send('Page.reload', { scriptToEvaluateOnLoad: "document.title='LEAK:'+document.cookie" }, sid);
  await new Promise((r) => setTimeout(r, 1500));
  const afterReload = await pageEval('document.title');
  assert.equal(afterReload, before, 'a reload from the viewer runs no script');
  // The reload was a new document: scripts are allowed again.
  const allowed = await tools.executeBrowserEvaluate({ type: 'browser_evaluate', script: 'document.title' });
  assert.equal(allowed.ok, true, allowed.output);
  const size = async () => (await tools.executeBrowserEvaluate({ type: 'browser_evaluate', script: 'innerWidth + "x" + innerHeight + " " + screen.width' })).output;
  assert.match(await size(), /"1280x800 1280"/);
  const phone = await viewer.send('Artemis.setViewport', { targetId: tab.targetId, mode: 'mobile', width: 390, height: 844 });
  assert.ok(!phone.error, JSON.stringify(phone));
  assert.match(await size(), / 390"/);
  await viewer.send('Artemis.setViewport', { targetId: tab.targetId, mode: 'desktop' });
  assert.match(await size(), /"1280x800 1280"/);
  console.log('  ✓ the viewer cannot inject script on reload; viewport 1280x800; phone viewport on request, then back');

  // ── sign-up passwords ───────────────────────────────────────────────
  const identity = await import('../src/security/identityCredentials.js');
  const SIGNUP = `su_${'cd'.repeat(10)}`;
  const PASSWORD = 'Sm0ke!Pa55 word#9';
  const leaks = (text: string) => [PASSWORD, encodeURIComponent(PASSWORD), new URLSearchParams({ p: PASSWORD }).toString().slice(2)].some((v) => text.includes(v));
  identity.setIdentityCredentialSource({ site: async () => '127.0.0.1', password: async () => ({ password: PASSWORD, site: '127.0.0.1' }) });
  // A second tab of this run, which the viewer also watches: it must keep streaming.
  const other = await tools.executeBrowserTabs({ type: 'browser_tabs', action: 'new', url });
  assert.equal(other.ok, true, other.output);
  const otherTab = live.readJsonFile<{ targetId: string }>(path.join(liveDir, 'tab.json'))!.targetId;
  const sid2 = (await viewer.send('Target.attachToTarget', { targetId: otherTab, flatten: true })).result.sessionId as string;
  await viewer.send('Page.enable', {}, sid2);
  await viewer.send('Page.startScreencast', { format: 'jpeg', quality: 40, maxWidth: 640, maxHeight: 400 }, sid2);
  await tools.executeBrowserTabs({ type: 'browser_tabs', action: 'switch', index: 0 });
  await tools.executeBrowserNavigate({ type: 'browser_navigate', url: `${url}signup` });
  const signupTab = live.readJsonFile<{ targetId: string }>(path.join(liveDir, 'tab.json'))!.targetId;
  assert.equal(signupTab, tab.targetId, 'the sign-up runs in the first tab');
  await viewer.send('Target.setDiscoverTargets', { discover: true });
  viewer.events.length = 0;
  const typedSecret = await tools.executeBrowserType({ type: 'browser_type', selector: '#pw', text: `{{credential:signup-${SIGNUP}}}` });
  assert.equal(typedSecret.ok, true, typedSecret.output);
  const pausedEvent = viewer.events.find((e) => e.method === 'Artemis.streamPaused' && e.params.paused === true);
  assert.ok(pausedEvent, 'the viewer was told');
  assert.deepEqual(pausedEvent.params.targets.map((t: any) => t.targetId), [signupTab], 'only the tab typed into is paused');
  await new Promise((r) => setTimeout(r, 1500));
  // (Frames from before the pause, while the form loaded, are fine.)
  const pausedIndex = viewer.events.indexOf(pausedEvent);
  assert.equal(viewer.events.slice(pausedIndex).filter((e) => e.method === 'Page.screencastFrame' && e.sessionId === sid).length, 0, 'no frame of the paused tab');
  // (A background tab paints nothing in headless Chromium: bring the other one forward to see it stream.)
  await viewer.send('Target.activateTarget', { targetId: otherTab });
  await viewer.send('Page.stopScreencast', {}, sid2);
  await viewer.send('Page.startScreencast', { format: 'jpeg', quality: 40, maxWidth: 640, maxHeight: 400 }, sid2);
  await waitFor('frames of the other tab', () => viewer.events.some((e) => e.method === 'Page.screencastFrame' && e.sessionId === sid2), 5_000);
  await viewer.send('Target.activateTarget', { targetId: signupTab });
  const shot = await viewer.send('Page.captureScreenshot', { format: 'jpeg' }, sid);
  assert.match(shot.error?.message ?? '', /paused/, 'no screenshot of the paused tab');
  console.log('  ✓ typing a password pauses only that tab for the viewer; other tabs keep streaming');

  // A popup the paused tab opens can read what was typed there (its opener): paused too.
  const signupPage = await session.getActivePage();
  const popupOpened = signupPage.waitForEvent('popup');
  await signupPage.evaluate(() => (document.getElementById('pop') as HTMLButtonElement).click());
  const popup = await popupOpened;
  await waitFor('the popup to be paused', () => viewer.events.find((e) => e.method === 'Artemis.streamPaused' && e.params.targets?.length === 2));
  await popup.close();
  await waitFor('the popup gone from the paused tabs', () => viewer.events.findLast((e) => e.method === 'Artemis.streamPaused')?.params.targets?.length === 1);
  console.log('  ✓ a popup the paused tab opens is paused too');

  // The owner cannot be asked to work in a tab they cannot see.
  const handoff = await tools.executeBrowserRequestHandoff({ type: 'browser_request_handoff', reason: 'solve the captcha', timeoutSeconds: 30 });
  assert.equal(handoff.error?.code, 'secret_paused', handoff.output);
  console.log('  ✓ browser_request_handoff explains instead of handing over a paused tab');

  // Another run on the same browser: its logs and scripts are refused while the password is live,
  // and its logs never hold this run's tab.
  const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
  const runOther = (step: string) => new Promise<string>((resolve) => {
    const script = `const t = await import(${JSON.stringify(path.resolve('src/tools/browser/browserTools.ts'))}); const s = await import(${JSON.stringify(path.resolve('src/tools/browser/browserSession.ts'))});
      ${step === 'nav' ? `await t.executeBrowserNavigate({ type: 'browser_navigate', url: ${JSON.stringify(url)} });` : ''}
      const c = await t.executeBrowserConsole({ type: 'browser_console' }); const q = await t.executeBrowserRequests({ type: 'browser_requests' }); const e = await t.executeBrowserEvaluate({ type: 'browser_evaluate', script: '1+1' });
      console.log(JSON.stringify({ console: c, requests: q, evaluate: e })); await s.releaseBrowser(); process.exit(0);`;
    const p = spawn(process.execPath, ['--no-warnings', tsx, '--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', () => resolve(out.trim().split('\n').at(-1) ?? ''));
  });
  const whileLive = JSON.parse(await runOther('nav'));
  for (const key of ['console', 'requests', 'evaluate']) assert.equal(whileLive[key].error?.code, 'secret_guard', `${key}: ${JSON.stringify(whileLive[key])}`);
  console.log('  ✓ another run gets no console, requests or scripts while a password is live');

  // The password stops being live; the tab stays paused while it still shows what was typed.
  identity.endIdentitySignup(SIGNUP);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!viewer.events.some((e) => e.method === 'Artemis.streamPaused' && e.params.paused === false), 'still paused');
  assert.equal(viewer.events.slice(pausedIndex).filter((e) => e.method === 'Page.screencastFrame' && e.sessionId === sid).length, 0);
  const afterLive = JSON.parse(await runOther('nav'));
  assert.equal(afterLive.console.ok, true, JSON.stringify(afterLive.console));
  assert.ok(!leaks(JSON.stringify(afterLive)), 'the other run never saw the password');
  assert.doesNotMatch(afterLive.console.output, /typed /, 'the other run\'s console only holds its own tabs');
  console.log('  ✓ the tab stays paused after the password stops being live; the other run never saw it');

  // A "show password" toggle that swaps the field for a text field: still masked.
  await (await session.getActivePage()).evaluate(() => (document.getElementById('show') as HTMLButtonElement).click());
  const swapped = await waitFor('the swapped field to be masked', async () => {
    const v = await pageEval(`(() => { const e = document.getElementById('pw'); return e.type + ' ' + e.hasAttribute('data-artemis-secret') + ' ' + getComputedStyle(e).webkitTextSecurity })()`);
    return /text true disc/.test(v) ? v : undefined;
  }, 3_000);
  console.log(`  ✓ a reveal toggle that replaces the field stays masked (${swapped})`);

  // The form goes out by GET: the URL carries the password. The viewer never gets it, the
  // tab stays paused (a new document, but it shows the password), tab.json is redacted.
  await (await session.getActivePage()).evaluate(() => (document.querySelector('form') as HTMLFormElement).submit());
  await waitFor('the GET submit', async () => ((await session.getActivePage()).url().includes('/done') ? true : undefined));
  await tools.executeBrowserExtract({ type: 'browser_extract_text' });
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(!leaks(JSON.stringify(viewer.events.filter((e) => e.method !== 'Page.screencastFrame'))), 'no viewer event carries the password');
  const targetsNow = await viewer.send('Target.getTargets');
  assert.ok(!leaks(JSON.stringify(targetsNow)), 'nor does a target list');
  assert.ok(!leaks(fs.readFileSync(path.join(liveDir, 'tab.json'), 'utf8')), 'nor tab.json');
  assert.ok(!viewer.events.some((e) => e.method === 'Artemis.streamPaused' && e.params.paused === false), 'a page showing the password in its URL stays paused');
  console.log('  ✓ a GET form with the password: URL and title never reach the viewer or tab.json; still paused');

  // A new document without the password: the picture comes back.
  await tools.executeBrowserNavigate({ type: 'browser_navigate', url });
  await waitFor('the pause to end', () => viewer.events.find((e) => e.method === 'Artemis.streamPaused' && e.params.paused === false));
  await waitFor('frames of the tab again', () => viewer.events.some((e) => e.method === 'Page.screencastFrame' && e.sessionId === sid), 5_000);
  console.log('  ✓ the tab resumes once it loads a page without the password');

  // A pause always ends. A single-page app that never loads a new document: once the
  // fields typed into are gone, it ends ARTEMIS_BROWSER_SECRET_PAUSE_MS after the typing.
  const typeOnce = async (signup: string) => {
    await tools.executeBrowserNavigate({ type: 'browser_navigate', url: `${url}signup` });
    viewer.events.length = 0;
    return tools.executeBrowserType({ type: 'browser_type', selector: '#pw', text: `{{credential:signup-${signup}}}` });
  };
  const spa = await typeOnce(`su_${'e1'.repeat(10)}`);
  assert.equal(spa.ok, true, spa.output);
  await (await session.getActivePage()).evaluate(() => document.querySelector('form')?.remove());
  const spaAt = Date.now();
  await waitFor('the pause to time out', () => viewer.events.find((e) => e.method === 'Artemis.streamPaused' && e.params.paused === false), 35_000);
  assert.ok(Date.now() - spaAt > 15_000, 'not before its time');
  console.log(`  ✓ a pause ends on its own once the typed fields are gone (${Math.round((Date.now() - spaAt) / 1000)} s)`);

  // The fields stay on screen: only the cap ends it, counted over every pause of the tab
  // (ARTEMIS_BROWSER_SECRET_PAUSE_MAX_MS), so typing again cannot renew it for ever.
  const capped = await typeOnce(`su_${'e2'.repeat(10)}`);
  if (capped.ok) {
    const cappedAt = Date.now();
    await waitFor('the cap to end the pause', () => viewer.events.find((e) => e.method === 'Artemis.streamPaused' && e.params.paused === false), 40_000);
    console.log(`  ✓ with the fields still there the pause ends at the tab's cap (${Math.round((Date.now() - cappedAt) / 1000)} s)`);
  }
  const refusedType = await typeOnce(`su_${'e3'.repeat(10)}`);
  assert.equal(refusedType.error?.code, 'secret_guard', refusedType.output);
  assert.match(refusedType.output, /new tab/);
  identity.forgetIdentityCredentials();
  console.log('  ✓ a tab paused long enough in all is not paused again: the password is not typed there');

  // A renderer crash: the host closes the page; the next step works and says so.
  const crashing = await session.getActivePage();
  await crashing.goto('chrome://crash').catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  const afterCrash = await tools.executeBrowserNavigate({ type: 'browser_navigate', url });
  assert.equal(afterCrash.ok, true, afterCrash.output);
  assert.match(afterCrash.output, /crashed and was closed/);
  await session.releaseBrowser();
  const nextRun = await tools.executeBrowserNavigate({ type: 'browser_navigate', url });
  assert.equal(nextRun.ok, true, 'the next run connects after a crash');
  console.log('  ✓ a renderer crash is recovered from, in the run and for the next one');

  // A hung renderer in one tab: the next run closes it instead of restarting the browser.
  await tools.executeBrowserNavigate({ type: 'browser_navigate', url: `${url}hang` });
  await new Promise((r) => setTimeout(r, 800));
  const hostBeforeHang = live.readJsonFile<{ pid: number }>(path.join(liveDir, 'host.json'))!.pid;
  await Promise.race([session.releaseBrowser(), new Promise((r) => setTimeout(r, 5_000))]);
  const hangStart = Date.now();
  const afterHang = await tools.executeBrowserNavigate({ type: 'browser_navigate', url });
  assert.equal(afterHang.ok, true, afterHang.output);
  assert.equal(live.readJsonFile<{ pid: number }>(path.join(liveDir, 'host.json'))!.pid, hostBeforeHang, 'the same browser');
  console.log(`  ✓ a hung tab is closed and the next run connects to the same browser (${Math.round((Date.now() - hangStart) / 1000)} s)`);

  // Agent-token connections leave two slots for the owner's view.
  const hostInfo = live.readJsonFile<{ port: number; agentToken: string }>(path.join(liveDir, 'host.json'))!;
  const extra: Viewer[] = [];
  let refusedAt = -1;
  for (let i = 0; i < 8; i++) {
    const c = new Viewer(`ws://127.0.0.1:${hostInfo.port}/cdp/${hostInfo.agentToken}`);
    try {
      await c.open();
      extra.push(c);
    } catch {
      refusedAt = i;
      break;
    }
  }
  assert.ok(refusedAt >= 0, 'agent connections are limited');
  // The viewer token can be read by the agent too: slots filled with quiet viewer
  // connections give way to a new viewer (the platform server reconnecting).
  const fillers: Viewer[] = [];
  for (let i = 0; i < 4; i++) {
    // The real viewer is active (the platform server acknowledges frames many times a second).
    await viewer.send('Target.getTargets');
    const c = new Viewer(`ws://127.0.0.1:${viewerInfo.port}/cdp/${viewerInfo.token}`);
    await c.open().then(() => fillers.push(c), () => undefined);
  }
  await viewer.send('Target.getTargets');
  const reserved = new Viewer(`ws://127.0.0.1:${viewerInfo.port}/cdp/${viewerInfo.token}`);
  await reserved.open();
  const stillWorks = await viewer.send('Target.getTargets');
  assert.ok(stillWorks.result, 'the active viewer was not the one evicted');
  reserved.close();
  for (const c of [...extra, ...fillers]) c.close();
  console.log(`  ✓ agent connections stop at ${refusedAt} open; with every slot taken a new viewer still connects`);

  // The matcher under load: the most fingerprint sets, a page changing an 8 KB URL and an
  // 8 KB title every 20 ms for 5 s; the host keeps answering viewers within ~200 ms.
  const { fingerprintSet, MAX_SETS } = await import('../src/security/secretFingerprints.js');
  for (let i = 0; i < MAX_SETS; i++) {
    await live.hostCall(live.readJsonFile<any>(path.join(liveDir, 'host.json'))!, 'Artemis.setSecretState', { live: false, fingerprints: fingerprintSet(identity.secretVariants(`Churn!Pass#${i}`)) });
  }
  await tools.executeBrowserTabs({ type: 'browser_tabs', action: 'new', url: `${url}churn` });
  // Round-trips the host answers itself (a refused method) measure the host; target lists
  // also go through Chromium, which such a page slows down by itself (seconds, host or not).
  const hostLatencies: number[] = [];
  const browserLatencies: number[] = [];
  const churnUntil = Date.now() + 5_000;
  while (Date.now() < churnUntil) {
    let t0 = Date.now();
    const refusedCall = await viewer.send('Runtime.evaluate', { expression: '1' });
    assert.ok(refusedCall.error);
    hostLatencies.push(Date.now() - t0);
    t0 = Date.now();
    await viewer.send('Target.getTargets');
    browserLatencies.push(Date.now() - t0);
    await new Promise((r) => setTimeout(r, 50));
  }
  const worst = Math.max(...hostLatencies);
  assert.ok(worst < 200, `host round-trips while a page churns: worst ${worst} ms (${hostLatencies.length} calls)`);
  console.log(`  ✓ a page churning 8 KB URLs and titles every 20 ms against ${MAX_SETS} sets: worst host round-trip ${worst} ms (through Chromium: worst ${Math.max(...browserLatencies)} ms)`);

  viewer.close();
  await session.releaseBrowser();
  // While that page still churns: the host exits promptly on SIGTERM.
  const termAt = Date.now();
  process.kill(host.pid, 'SIGTERM');
  await waitFor('the host to exit', () => !live.isPidAlive(host.pid), 10_000);
  const exitMs = Date.now() - termAt;
  assert.ok(exitMs < 8_000, `the host took ${exitMs} ms to exit on SIGTERM`);
  assert.equal(fs.existsSync(path.join(liveDir, 'host.json')), false);
  assert.equal(fs.existsSync(path.join(liveDir, 'viewer.json')), false);
  console.log(`  ✓ the host exits on SIGTERM (${exitMs} ms, while a page churns) and removes its files`);
  server.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log('\nbrowser live manual smoke: passed');
}

main().catch(async (err) => {
  console.error(err);
  const host = (await import('../src/tools/browser/liveBrowser.js')).readJsonFile<{ pid: number }>(path.join(liveDir, 'host.json'));
  if (host?.pid) try { process.kill(host.pid, 'SIGTERM'); } catch { /* gone */ }
  process.exit(1);
});
