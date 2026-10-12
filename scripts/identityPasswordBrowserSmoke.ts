// Sign-up passwords in a real browser (the review's pw.mts probe, turned into
// checks): typed only into a password field of the sign-up's site, never in
// anything the model receives (outputs, error messages, URLs, requests,
// reversed or spaced echoes), reads of the field refused, screenshots masked
// and refused when the field shows its text.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import {
  forgetIdentityCredentials,
  redactIdentitySecretsDeep,
  setIdentityCredentialSource,
} from '../src/security/identityCredentials.js';
import {
  executeBrowserClick,
  executeBrowserClose,
  executeBrowserEvaluate,
  executeBrowserExtract,
  executeBrowserFormInput,
  executeBrowserNavigate,
  executeBrowserRequests,
  executeBrowserScreenshot,
  executeBrowserType,
} from '../src/tools/browser/browserTools.js';

// Needs Playwright's Chromium (npx playwright install chromium, or PLAYWRIGHT_BROWSERS_PATH).
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (browsers && !existsSync(browsers)) {
  console.log('identity password browser smoke: skipped (PLAYWRIGHT_BROWSERS_PATH does not exist)');
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
<script>document.getElementById('p').addEventListener('input', e => { document.getElementById('echo').textContent = [...e.target.value].reverse().join('') + ' / ' + [...e.target.value].join(' ') })</script>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url === '/' ? page : '<p>thanks</p>');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;

/** What the model would receive: the agent's choke point redacts the whole outcome. */
const seen = (r: unknown) => JSON.stringify(redactIdentitySecretsDeep(r));
const leaks = (text: string) =>
  [PW, encodeURIComponent(PW), new URLSearchParams({ x: PW }).toString().slice(2), [...PW].reverse().join(''), [...PW].join(' '), JSON.stringify(PW).slice(1, -1)].some((v) => text.includes(v));

try {
  await executeBrowserNavigate({ type: 'browser_navigate', url: `http://127.0.0.1:${port}/` } as never);

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

  // Scripts that could read the field are refused, including one that throws the value.
  for (const script of ["[...document.querySelector('#p').value].join(' ')", "(() => { throw new Error(document.querySelector('#p').value) })()", "new FormData(document.forms[0]).get('p')"]) {
    const r = await executeBrowserEvaluate({ type: 'browser_evaluate', script } as never);
    assert.equal(r.ok, false, script);
    assert.ok(!leaks(seen(r)));
  }

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
  const requests = await executeBrowserRequests({ type: 'browser_requests', pattern: 'next' } as never);
  assert.ok(leaks(JSON.stringify(click)) || leaks(JSON.stringify(requests)), 'the URL really carried it');
  assert.ok(!leaks(seen(requests)), seen(requests));
  const href = await executeBrowserEvaluate({ type: 'browser_evaluate', script: 'location.href' } as never);
  assert.ok(!leaks(seen(href)), seen(href));
} finally {
  await executeBrowserClose({ type: 'browser_close' } as never).catch(() => undefined);
  server.close();
  forgetIdentityCredentials();
}
console.log('identity password browser smoke: ok');
process.exit(0);
