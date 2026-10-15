#!/usr/bin/env tsx
/**
 * scripts/browserFileGuardSmoke.ts — local files in the agent's browser, in a real Chromium.
 *
 *   ARTEMIS_BROWSER_EXECUTABLE=/path/to/chrome npm run test:browserFiles
 *
 * A workspace page opens (with its relative CSS and images); nothing else
 * local does, however it is asked for: a URL with a line break or a
 * control character in its scheme, an iframe, a meta refresh, a link
 * clicked, a script setting location (browser_evaluate), a protected
 * directory inside the workspace, and any local file from an http page.
 * Runs on the live browser (the host the platform uses). Without a
 * Chromium it says so and exits 0.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-file-guard-')));
const liveDir = path.join(root, 'live');
process.env.ARTEMIS_HOME = path.join(root, 'home');
process.env.ARTEMIS_BROWSER_LIVE_DIR = liveDir;
process.env.ARTEMIS_BROWSER_HEADLESS = '1';
process.env.ARTEMIS_BROWSER_IDLE_MS = '60000';

const ws = path.join(root, 'ws');
const site = path.join(ws, 'sites', 'p');
const outside = path.join(root, 'outside');
const secret = path.join(outside, 'secret.html');
const creds = path.join(ws, '.artemis', 'agent-credentials', 'index.html');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const secretUrl = pathToFileURL(secret).href;

function setup(): void {
  fs.mkdirSync(site, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.dirname(creds), { recursive: true });
  fs.writeFileSync(secret, '<!doctype html><title>outside</title><body>SECRET-OUTSIDE</body>');
  fs.writeFileSync(creds, '<!doctype html><title>creds</title><body>SECRET-CREDS</body>');
  fs.writeFileSync(path.join(site, 'style.css'), 'h1 { color: rgb(255, 0, 0); }');
  fs.writeFileSync(path.join(site, 'a.png'), PNG);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><meta charset="utf-8"><title>page</title><link rel="stylesheet" href="style.css"><h1>PAGE-OK</h1><img id="i" src="a.png">');
  fs.writeFileSync(path.join(site, 'iframe.html'), `<!doctype html><title>iframe</title><h1>IFRAME</h1><iframe id="f" src="${secretUrl}"></iframe><iframe id="c" src="${pathToFileURL(creds).href}"></iframe>`);
  fs.writeFileSync(path.join(site, 'refresh.html'), `<!doctype html><meta http-equiv="refresh" content="0;url=${secretUrl}"><title>refresh</title><h1>REFRESH</h1>`);
  fs.writeFileSync(path.join(site, 'link.html'), `<!doctype html><title>link</title><a id="a" href="${secretUrl}" style="display:block;width:200px;height:50px">go</a>`);
}

async function resolveExecutable(): Promise<boolean> {
  if (process.env.ARTEMIS_BROWSER_EXECUTABLE) return fs.existsSync(process.env.ARTEMIS_BROWSER_EXECUTABLE);
  const { chromium } = await import('playwright');
  const candidates = [chromium.executablePath(), process.env.PLAYWRIGHT_BROWSERS_PATH ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : ''];
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (!found) return false;
  process.env.ARTEMIS_BROWSER_EXECUTABLE = found;
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  if (!(await resolveExecutable())) {
    console.log('browser file guard smoke: skipped (no Chromium; set ARTEMIS_BROWSER_EXECUTABLE)');
    return;
  }
  setup();
  const tools = await import('../src/tools/browser/browserTools.js');
  const session = await import('../src/tools/browser/browserSession.js');
  const context = { cwd: ws } as never;
  const text = async () => {
    const page = await session.getActivePage();
    return { url: page.url(), body: (await page.textContent('body').catch(() => '')) ?? '' };
  };
  const neverSecret = async (what: string) => {
    await sleep(700);
    const page = await session.getActivePage();
    for (const frame of page.frames()) {
      // A frame the browser refused may never get a document to ask: a short wait, then it counts as empty.
      const body = (await Promise.race([frame.evaluate(() => document.body?.innerText ?? '').catch(() => ''), sleep(2_000).then(() => '')])) ?? '';
      assert.doesNotMatch(body, /SECRET/, `${what}: a frame shows the secret (${frame.url()})`);
    }
    ok(what);
  };

  // A workspace page with relative assets opens and loads them.
  const opened = await tools.executeBrowserNavigate({ type: 'browser_navigate', path: 'sites/p/index.html' }, context);
  assert.equal(opened.ok, true, opened.output);
  const page = await session.getActivePage();
  const looks = await page.evaluate(() => ({ color: getComputedStyle(document.querySelector('h1')!).color, img: (document.getElementById('i') as HTMLImageElement).naturalWidth }));
  assert.deepEqual(looks, { color: 'rgb(255, 0, 0)', img: 1 });
  ok('a workspace page opens with its relative CSS and image');

  // The URL itself: a line break or a control character in the scheme is refused (also for a new tab).
  for (const url of [`fi\nle://${secret}`, `\x01${secretUrl}`, `\t${secretUrl}`, `view-source:fi\tle://${secret}`, secretUrl]) {
    const result = await tools.executeBrowserNavigate({ type: 'browser_navigate', url }, context);
    assert.equal(result.ok, false, `${JSON.stringify(url)} opened: ${result.output}`);
    const tab = await tools.executeBrowserTabs({ type: 'browser_tabs', action: 'new', url }, context);
    assert.equal(tab.ok, false, `${JSON.stringify(url)} opened in a new tab: ${tab.output}`);
  }
  assert.doesNotMatch((await text()).body, /SECRET/);
  ok('file URLs with a line break, a tab or a control character, or outside the workspace, are refused (navigate and new tab)');

  // What a page asks for itself.
  await tools.executeBrowserNavigate({ type: 'browser_navigate', path: 'sites/p/iframe.html' }, context);
  await neverSecret('an iframe of a file outside the workspace, or of a protected directory, stays empty');
  await tools.executeBrowserNavigate({ type: 'browser_navigate', path: 'sites/p/refresh.html' }, context);
  await neverSecret('a meta refresh to a file outside the workspace does not open it');
  await tools.executeBrowserNavigate({ type: 'browser_navigate', path: 'sites/p/link.html' }, context);
  await tools.executeBrowserClick({ type: 'browser_click', selector: '#a' }, context);
  await neverSecret('a link to a file outside the workspace, clicked, does not open it');
  await tools.executeBrowserNavigate({ type: 'browser_navigate', path: 'sites/p/index.html' }, context);
  await tools.executeBrowserEvaluate({ type: 'browser_evaluate', script: `location.href = ${JSON.stringify(secretUrl)}` }, context);
  await neverSecret('a script setting location (browser_evaluate) does not open it');
  await tools.executeBrowserNavigate({ type: 'browser_navigate', path: 'sites/p/index.html' }, context);
  await tools.executeBrowserEvaluate({ type: 'browser_evaluate', script: `location.href = ${JSON.stringify(pathToFileURL(creds).href)}` }, context);
  await neverSecret('a script opening a protected directory inside the workspace does not open it');

  // An http page never loads local files, not even the workspace's.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>web</title><h1>WEB</h1><img id="i" src="${pathToFileURL(path.join(site, 'a.png')).href}"><iframe id="f" src="${secretUrl}"></iframe>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const web = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  console.log('    opening an http page');
  const nav = await tools.executeBrowserNavigate({ type: 'browser_navigate', url: web, waitFor: 'domcontentloaded', extractText: false }, context);
  assert.equal(nav.ok, true, nav.output);
  await neverSecret('an http page cannot frame a local file');
  const img = await (await session.getActivePage()).evaluate(() => (document.getElementById('i') as HTMLImageElement).naturalWidth);
  assert.equal(img, 0, 'an http page loaded a local image');
  ok('an http page cannot load a local image, even from the workspace');
  server.closeAllConnections();
  server.close();

  await session.releaseBrowser();
  const live = await import('../src/tools/browser/liveBrowser.js');
  const host = live.readJsonFile<{ pid: number }>(path.join(liveDir, 'host.json'));
  if (host?.pid) process.kill(host.pid, 'SIGTERM');
  await sleep(500);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(`\nbrowser file guard smoke: ${passed} checks passed`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  const host = (await import('../src/tools/browser/liveBrowser.js')).readJsonFile<{ pid: number }>(path.join(liveDir, 'host.json'));
  if (host?.pid) try { process.kill(host.pid, 'SIGTERM'); } catch { /* gone */ }
  process.exit(1);
});
