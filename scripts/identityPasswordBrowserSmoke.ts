// Sign-up passwords in a real browser (the review's pw.mts probe, turned into
// checks): typed only into a password field of the sign-up's site, never in
// anything the model receives (outputs, error messages, URLs, requests,
// reversed or spaced echoes), page scripts and console / request logs refused
// outright while the password is live and allowed again once the sign-up is
// finished, screenshots masked and refused when the field shows its text.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import {
  endIdentitySignup,
  forgetIdentityCredentials,
  LIVE_SECRET_REFUSAL,
  redactIdentitySecretsDeep,
  setIdentityCredentialSource,
} from '../src/security/identityCredentials.js';
import {
  executeBrowserClick,
  executeBrowserClose,
  executeBrowserConsole,
  executeBrowserEvaluate,
  executeBrowserExtract,
  executeBrowserFormInput,
  executeBrowserNavigate,
  executeBrowserRequests,
  executeBrowserScreenshot,
  executeBrowserType,
} from '../src/tools/browser/browserTools.js';

// Needs Playwright's Chromium (npx playwright install chromium, or PLAYWRIGHT_BROWSERS_PATH):
// without the build this Playwright launches, skip cleanly instead of failing on a page that never loaded.
async function missingBrowser(): Promise<string | undefined> {
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsers && !existsSync(browsers)) return 'PLAYWRIGHT_BROWSERS_PATH does not exist';
  try {
    const { chromium } = await import('playwright');
    const executable = chromium.executablePath();
    return executable && existsSync(executable) ? undefined : `no Chromium for this Playwright at ${executable} (npx playwright install chromium)`;
  } catch (err) {
    return `Playwright is not available (${err instanceof Error ? err.message : String(err)})`;
  }
}
const missing = await missingBrowser();
if (missing) {
  console.log(`identity password browser smoke: skipped (${missing})`);
  process.exit(0);
}

const PW = 'Kq7!m@Z2#x$P9^rT=+aB';
const ID = `su_${'ab'.repeat(10)}`;
const PLACEHOLDER = `{{credential:signup-${ID}}}`;
let site = '127.0.0.1';
let fetches = 0;
setIdentityCredentialSource({
  site: async () => site,
  password: async () => {
    fetches += 1;
    return { password: PW, site };
  },
});

const page = `<!doctype html><form id=f method=GET action="/next">
<input id=t name=t type=text><input id=p name=p type=password><button id=go>go</button></form>
<div id=echo></div><button id=reveal type=button onclick="document.getElementById('p').type='text'">show</button>
<button id=slow type=button onclick="fetch('/slow?p=' + encodeURIComponent(document.getElementById('p').value))">slow</button>
<script>console.log('before the password');
document.getElementById('p').addEventListener('input', e => { console.log('typed: ' + e.target.value); document.getElementById('echo').textContent = [...e.target.value].reverse().join('') + ' / ' + [...e.target.value].join(' ') })</script>`;
/** Every URL the site was asked for (to prove the password really went over the wire). */
const served: string[] = [];
const server = http.createServer((req, res) => {
  served.push(req.url ?? '');
  const reply = () => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/' || req.url?.startsWith('/next') ? page : '<p>thanks</p>');
  };
  // A request made while the password is live that only finishes after.
  if (req.url?.startsWith('/slow')) setTimeout(reply, 1_500);
  else reply();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;

/** What the model would receive: the agent's choke point redacts the whole outcome. */
const seen = (r: unknown) => JSON.stringify(redactIdentitySecretsDeep(r));
const leaks = (text: string) =>
  [PW, encodeURIComponent(PW), new URLSearchParams({ x: PW }).toString().slice(2), [...PW].reverse().join(''), [...PW].join(' '), JSON.stringify(PW).slice(1, -1)].some((v) => text.includes(v));

try {
  await executeBrowserNavigate({ type: 'browser_navigate', url: `http://127.0.0.1:${port}/` } as never);
  const beforeLog = await executeBrowserConsole({ type: 'browser_console' } as never);
  assert.match(beforeLog.output, /before the password/, 'the logs record before the password goes live');

  // Only into a password field.
  const intoText = await executeBrowserType({ type: 'browser_type', selector: '#t', text: PLACEHOLDER } as never);
  assert.equal(intoText.ok, false);
  assert.match(intoText.output, /only typed into a password field/);
  assert.equal(fetches, 0, 'nothing fetched for a refused field');

  // Only on the sign-up's site.
  site = 'example.com';
  const elsewhere = await executeBrowserType({ type: 'browser_type', selector: '#p', text: PLACEHOLDER } as never);
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.output, /only typed on example\.com/);
  assert.equal(fetches, 0, 'a wrong site never fetches the password');
  site = '127.0.0.1';

  const typed = await executeBrowserType({ type: 'browser_type', selector: '#p', text: PLACEHOLDER } as never);
  assert.equal(typed.ok, true, typed.output);
  assert.ok(!leaks(seen(typed)));
  const again = await executeBrowserFormInput({ type: 'browser_form_input', selector: '#p', value: PLACEHOLDER } as never);
  assert.equal(again.ok, true, 'typed again from memory (a confirm field)');
  assert.equal(fetches, 1);

  // A page echoing it (reversed, spaced out) is redacted.
  const echo = await executeBrowserExtract({ type: 'browser_extract_text', selector: '#echo' } as never);
  assert.ok(leaks(JSON.stringify(echo)), 'the page really echoed it (the check is not vacuous)');
  assert.ok(!leaks(seen(echo)), seen(echo));

  // While the password is live, no script runs at all, harmless or not, and the console / request logs stay shut.
  for (const script of ["[...document.querySelector('#p').value].join(' ')", "(() => { throw new Error(document.querySelector('#p').value) })()", "new FormData(document.forms[0]).get('p')", 'document.title', '1 + 1']) {
    const r = await executeBrowserEvaluate({ type: 'browser_evaluate', script } as never);
    assert.equal(r.ok, false, script);
    assert.equal(r.output, LIVE_SECRET_REFUSAL, script);
    assert.ok(!leaks(seen(r)));
  }
  assert.equal((await executeBrowserConsole({ type: 'browser_console' } as never)).output, LIVE_SECRET_REFUSAL);
  assert.equal((await executeBrowserRequests({ type: 'browser_requests' } as never)).output, LIVE_SECRET_REFUSAL);

  // A screenshot masks the field; once the page shows its text, no screenshot.
  const shot = await executeBrowserScreenshot({ type: 'browser_screenshot' } as never);
  assert.equal(shot.ok, true, shot.output);
  await executeBrowserClick({ type: 'browser_click', selector: '#reveal' } as never);
  const exposed = await executeBrowserScreenshot({ type: 'browser_screenshot' } as never);
  assert.equal(exposed.ok, false);
  assert.match(exposed.output, /shows its text/);

  // Submitting a GET form puts it in the URL (form-encoded): redacted in what the tools report.
  const click = await executeBrowserClick({ type: 'browser_click', selector: '#go' } as never);
  assert.ok(!leaks(seen(click)), seen(click));
  assert.ok(served.some((u) => u.startsWith('/next?') && leaks(u)), 'the form really sent it in the URL');
  // Still live: a request whose answer only comes after the sign-up is finished.
  await executeBrowserClick({ type: 'browser_click', selector: '#slow' } as never);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(served.some((u) => u.startsWith('/slow')), 'the slow request is on its way');

  // finish_signup ends it (endIdentitySignup is what it calls): scripts and logs work again, and
  // nothing from the live window is in them, not even a request that only finishes afterwards.
  endIdentitySignup(ID);
  const consoleAfter = await executeBrowserConsole({ type: 'browser_console' } as never);
  assert.equal(consoleAfter.ok, true);
  assert.doesNotMatch(consoleAfter.output, /typed:|before the password/, consoleAfter.output);
  const requestsAfter = await executeBrowserRequests({ type: 'browser_requests' } as never);
  assert.equal(requestsAfter.ok, true);
  assert.doesNotMatch(requestsAfter.output, /\/next|\/slow/, requestsAfter.output);
  await new Promise((r) => setTimeout(r, 2_000));
  const lateRequests = await executeBrowserRequests({ type: 'browser_requests' } as never);
  assert.doesNotMatch(lateRequests.output, /\/slow/, 'a request started while live is never recorded');
  assert.ok(!leaks(JSON.stringify(lateRequests)) && !leaks(JSON.stringify(consoleAfter)) && !leaks(JSON.stringify(requestsAfter)), 'not even before redaction');
  // The logs record again from now on.
  const title = await executeBrowserEvaluate({ type: 'browser_evaluate', script: 'console.log("after the sign-up"); document.title + "|" + (1 + 1)' } as never);
  assert.equal(title.ok, true, title.output);
  assert.match(title.output, /\|2/);
  await executeBrowserNavigate({ type: 'browser_navigate', url: `http://127.0.0.1:${port}/thanks` } as never);
  assert.match((await executeBrowserConsole({ type: 'browser_console' } as never)).output, /after the sign-up/);
  assert.match((await executeBrowserRequests({ type: 'browser_requests' } as never)).output, /\/thanks/);
  // The field still holds the password after the sign-up: redaction, kept for the rest of the process, covers a read of it.
  await executeBrowserNavigate({ type: 'browser_navigate', url: `http://127.0.0.1:${port}/` } as never);
  await executeBrowserFormInput({ type: 'browser_form_input', selector: '#t', value: PW } as never);
  const field = await executeBrowserEvaluate({ type: 'browser_evaluate', script: "document.querySelector('#t').value" } as never);
  assert.ok(leaks(JSON.stringify(field)) && !leaks(seen(field)), 'redacted after the live window too');
} finally {
  await executeBrowserClose({ type: 'browser_close' } as never).catch(() => undefined);
  server.close();
  forgetIdentityCredentials();
}
console.log('identity password browser smoke: ok');
process.exit(0);
