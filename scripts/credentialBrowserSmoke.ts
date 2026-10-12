/**
 * Stored credentials in a real browser (H2): a password is typed only on
 * the origin it is bound to and only into a password field, a username only
 * into a username/email field, and no browser tool result ever carries the
 * secret back (a page echoing it, a console line, a script reading it).
 *
 * Needs a Playwright Chromium; prints "skipped" without one.
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/credentialBrowserSmoke.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-browser-'));
process.env.ARTEMIS_HOME = path.join(tmp, 'home');
process.env.ARTEMIS_BROWSER_HEADLESS = '1';
delete process.env.ARTEMIS_CREDENTIALS_DIR;
delete process.env.ARTEMIS_CREDENTIAL_BROKER;

const { chromium } = await import('playwright');
if (!fs.existsSync(chromium.executablePath())) {
  console.log('credential browser smoke: skipped (no Chromium for Playwright)');
  process.exit(0);
}

const { getCredentialStore, forgetRevealedSecrets } = await import('../src/security/credentialStore.js');
const tools = await import('../src/tools/browser/browserTools.js');
const { scrubToolResult } = await import('../src/core/agent.js');

// The page echoes whatever is typed into its body and its console: the worst case.
const page = `<!doctype html><meta charset="utf-8"><title>Sign up</title>
<form>
  <input id="user" name="username" autocomplete="username">
  <input id="pw" type="password" name="password">
  <input id="note" name="comment">
  <textarea id="bio"></textarea>
</form>
<div id="echo"></div>
<script>
  for (const el of document.querySelectorAll('input,textarea')) el.addEventListener('input', () => {
    document.getElementById('echo').textContent = 'typed: ' + el.value;
    console.log('typed ' + el.value);
  });
</script>`;
const serve = () =>
  new Promise<http.Server>((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
const site = await serve();
const other = await serve();
const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/signup`;
const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/signup`;

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}`);
    throw error;
  }
}

const run = async <R extends { output?: string; error?: { message?: string } }>(p: Promise<R>) => scrubToolResult(await p);

let failed: unknown;
try {
  const store = getCredentialStore();
  await store.create('shop-pw', 'password', { bindings: { origin: siteUrl } });
  await store.create('shop-user', 'username', { secret: 'agent.signup.7741@example.test', bindings: { origin: siteUrl } });
  await store.create('server-pw', 'password', { bindings: { host: '198.51.100.7' } });
  const secret = JSON.parse(fs.readFileSync(path.join(process.env.ARTEMIS_HOME!, 'agent-credentials', 'shop-pw.json'), 'utf8')).secret as string;
  assert.ok(secret.length >= 16);

  await test('a bound password goes into the password field on its own origin, and nowhere else (H2)', async () => {
    assert.equal((await run(tools.executeBrowserNavigate({ type: 'browser_navigate', url: siteUrl }))).ok, true);
    const typed = await run(tools.executeBrowserType({ type: 'browser_type', selector: '#pw', text: '{{credential:shop-pw}}' }));
    assert.equal(typed.ok, true, typed.output);
    // Not into a text field, not as part of a longer value, not a server password.
    for (const [selector, text] of [['#note', '{{credential:shop-pw}}'], ['#bio', '{{credential:shop-pw}}'], ['#user', '{{credential:shop-pw}}'], ['#pw', 'x{{credential:shop-pw}}'], ['#pw', '{{credential:server-pw}}']] as const) {
      const refused = await run(tools.executeBrowserType({ type: 'browser_type', selector, text }));
      assert.equal(refused.ok, false, `${text} into ${selector}`);
    }
    const form = await run(tools.executeBrowserFormInput({ type: 'browser_form_input', selector: '#note', value: '{{credential:shop-pw}}' }));
    assert.equal(form.ok, false);
    const user = await run(tools.executeBrowserType({ type: 'browser_type', selector: '#user', text: '{{credential:shop-user}}' }));
    assert.equal(user.ok, true, user.output);
    const userAsPassword = await run(tools.executeBrowserType({ type: 'browser_type', selector: '#pw', text: '{{credential:shop-user}}' }));
    assert.equal(userAsPassword.ok, false);
    // Another origin: refused before anything is typed.
    await run(tools.executeBrowserNavigate({ type: 'browser_navigate', url: otherUrl }));
    const elsewhere = await run(tools.executeBrowserType({ type: 'browser_type', selector: '#pw', text: '{{credential:shop-pw}}' }));
    assert.equal(elsewhere.ok, false);
    assert.match(elsewhere.output, /Nothing was typed/);
    assert.equal(await (await import('../src/tools/browser/browserSession.js')).getActivePage().then((p) => p.inputValue('#pw')), '');
  });

  await test('no browser tool result carries the secret back (H2)', async () => {
    await run(tools.executeBrowserNavigate({ type: 'browser_navigate', url: siteUrl }));
    assert.equal((await run(tools.executeBrowserType({ type: 'browser_type', selector: '#pw', text: '{{credential:shop-pw}}' }))).ok, true);
    const results = [
      await run(tools.executeBrowserExtract({ type: 'browser_extract_text' })),
      await run(tools.executeBrowserExtract({ type: 'browser_extract_text', selector: '#echo' })),
      await run(tools.executeBrowserConsole({ type: 'browser_console' })),
      await run(tools.executeBrowserNavigate({ type: 'browser_navigate', url: siteUrl, extractText: true })),
    ];
    for (const r of results) assert.ok(!r.output.includes(secret), r.output);
    assert.ok(results.some((r) => r.output.includes('••••')), 'the echo is there, masked');
    // A password field is never read back; a screenshot masks the echo, and the page is put back after.
    const field = await run(tools.executeBrowserExtract({ type: 'browser_extract_text', selector: '#pw' }));
    assert.equal(field.error?.code, 'credential_field_locked');
    const { getActivePage } = await import('../src/tools/browser/browserSession.js');
    const page = await getActivePage();
    await page.fill('#note', 'typed: ' + secret);
    await page.evaluate(() => document.querySelector('#note')!.dispatchEvent(new Event('input')));
    const unmask = await tools.maskSecretsForScreenshot(page);
    assert.ok(!(await page.textContent('#echo'))?.includes(secret), 'masked while the picture is taken')
    assert.ok(!(await page.inputValue('#note')).includes(secret))
    await unmask();
    const shot = await run(tools.executeBrowserScreenshot({ type: 'browser_screenshot' }));
    assert.equal(shot.ok, true, shot.output);
    assert.ok((await page.textContent('#echo'))?.includes(secret), 'the page is put back after the picture');
    // Scripts do not run on a site where a credential was typed.
    const evaluated = await run(tools.executeBrowserEvaluate({ type: 'browser_evaluate', script: "document.querySelector('#pw').value" }));
    assert.equal(evaluated.error?.code, 'credential_page_locked');
  });
} catch (error) {
  failed = error;
} finally {
  forgetRevealedSecrets();
  await tools.executeBrowserClose({ type: 'browser_close' }).catch(() => undefined);
  site.close();
  other.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) {
  console.error(failed);
  process.exit(1);
}
console.log(`credential browser smoke: ${passed} passed`);
// The agent module keeps timers alive; this script is done.
process.exit(0);
