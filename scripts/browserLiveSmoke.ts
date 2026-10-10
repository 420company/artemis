#!/usr/bin/env tsx
/**
 * scripts/browserLiveSmoke.ts — the live browser (watch + take over), no Chromium needed.
 *
 *   - WebSocket framing (wsFrames.ts): handshake, masked and fragmented
 *     client frames, ping/pong, close, oversize messages;
 *   - the CDP multiplexer (cdpRouter.ts) against a fake browser: per-client
 *     ids and browser sessions, session isolation, auto-attached children,
 *     the viewer whitelist, cleanup on disconnect;
 *   - takeover state (liveBrowser.ts): tools wait and then refuse while the
 *     user is in control, a handback is reported once, with the page;
 *   - handoff requests: the `[browser-handoff]` stderr line and the wait
 *     for the user to take over and hand back;
 *   - the browser tools themselves in live mode, while the user holds the
 *     browser (no browser is launched), and browser_request_handoff outside
 *     live mode;
 *   - the host's environment carries no keys.
 *
 * The real-browser check is scripts/browserLiveManualSmoke.ts.
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/browserLiveSmoke.ts
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpRouter, VIEWER_METHODS, viewerRefusal } from '../src/tools/browser/cdpRouter.js';
import {
  LIVE_DIR_ENV,
  LIVE_FILES,
  browserGate,
  emitHandoff,
  handbackNote,
  handoffLine,
  hostEnv,
  readControl,
  userInControlMessage,
  waitForHandback,
  writeJsonFileAtomic,
} from '../src/tools/browser/liveBrowser.js';
import { FrameDecoder, acceptKey, encodeFrame, handshakeResponse } from '../src/tools/browser/wsFrames.js';
import { findInternalNames } from '../src/utils/internalNames.js';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

/** A masked client frame, as a browser or Node client sends it. */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!));
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0, 0x80 | len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (len >= 126 && len < 65536) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else if (len >= 65536) {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([head, mask, masked]);
}

function tempLiveDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-live-smoke-'));
}

function writeControl(dir: string, control: Record<string, unknown>): void {
  writeJsonFileAtomic(path.join(dir, LIVE_FILES.control), control, 0o640);
}

async function main(): Promise<void> {
  console.log('wsFrames');
  await check('handshake answers the RFC 6455 accept key and rejects a bad key', () => {
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    const ok = handshakeResponse({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' });
    assert.match(ok ?? '', /^HTTP\/1\.1 101 [\s\S]*Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n\r\n$/);
    assert.equal(handshakeResponse({ 'sec-websocket-key': 'short' }), undefined);
    assert.equal(handshakeResponse({}), undefined);
  });
  await check('decoder: masked text, fragments, split chunks, ping, close', () => {
    const texts: string[] = [];
    const replies: Buffer[] = [];
    let closed = false;
    const decoder = new FrameDecoder({ onText: (t) => texts.push(t), onClose: () => { closed = true; } }, (f) => replies.push(f));
    const big = 'x'.repeat(70_000);
    const all = Buffer.concat([
      clientFrame(1, Buffer.from('{"id":1}')),
      clientFrame(1, Buffer.from('你'), false),
      clientFrame(9, Buffer.from('p')), // a ping between fragments
      clientFrame(0, Buffer.from('好')),
      clientFrame(1, Buffer.from(big)),
    ]);
    // Byte by byte for the first part, then the rest at once.
    for (let i = 0; i < 40; i++) decoder.push(all.subarray(i, i + 1));
    decoder.push(all.subarray(40));
    assert.deepEqual(texts, ['{"id":1}', '你好', big]);
    assert.deepEqual(replies[0], encodeFrame(0xa, Buffer.from('p')));
    decoder.push(clientFrame(8, Buffer.from([0x03, 0xe8])));
    assert.equal(closed, true);
  });
  await check('decoder: unmasked frames and oversize messages are protocol errors', () => {
    const decoder = new FrameDecoder({ onText: () => undefined, onClose: () => undefined }, () => undefined, 1024);
    assert.throws(() => decoder.push(Buffer.from([0x81, 0x01, 0x41])), /masked/);
    const small = new FrameDecoder({ onText: () => undefined, onClose: () => undefined }, () => undefined, 1024);
    assert.throws(() => small.push(clientFrame(1, Buffer.alloc(2048))), /too large/);
  });
  await check('encoder: length forms', () => {
    assert.equal(encodeFrame(1, Buffer.alloc(10)).length, 12);
    assert.equal(encodeFrame(1, Buffer.alloc(300)).length, 304);
    assert.equal(encodeFrame(1, Buffer.alloc(70_000)).length, 70_010);
  });

  console.log('cdpRouter');
  await check('per-client ids and browser sessions; responses and events routed back', async () => {
    const toBrowser: Record<string, any>[] = [];
    const router = new CdpRouter((m) => toBrowser.push(m as Record<string, any>));
    const agentOut: any[] = [];
    const viewerOut: any[] = [];
    const agent = router.addClient('agent', (t) => agentOut.push(JSON.parse(t)));
    const viewer = router.addClient('viewer', (t) => viewerOut.push(JSON.parse(t)));
    assert.equal(router.clientCount, 2);
    // Both ask for a browser session first.
    const [attachA, attachV] = toBrowser.splice(0);
    assert.equal(attachA?.method, 'Target.attachToBrowserTarget');
    agent.receive(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); // queued until the session exists
    router.fromBrowser({ id: attachA!.id, result: { sessionId: 'ROOT-A' } });
    router.fromBrowser({ id: attachV!.id, result: { sessionId: 'ROOT-V' } });
    await new Promise((r) => setImmediate(r));
    const sent = toBrowser.splice(0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.sessionId, 'ROOT-A');
    assert.equal(sent[0]!.method, 'Browser.getVersion');
    viewer.receive(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
    const vSent = toBrowser.splice(0)[0]!;
    assert.notEqual(vSent.id, sent[0]!.id, 'host ids never collide');
    router.fromBrowser({ id: sent[0]!.id, result: { product: 'Chrome' }, sessionId: 'ROOT-A' });
    router.fromBrowser({ id: vSent.id, result: { targetInfos: [] }, sessionId: 'ROOT-V' });
    assert.deepEqual(agentOut, [{ id: 1, result: { product: 'Chrome' } }]);
    assert.deepEqual(viewerOut, [{ id: 1, result: { targetInfos: [] } }]);

    // Auto-attached child of the agent: its events go to the agent only.
    router.fromBrowser({ method: 'Target.attachedToTarget', params: { sessionId: 'CHILD-A', targetInfo: { type: 'page' } }, sessionId: 'ROOT-A' });
    router.fromBrowser({ method: 'Page.loadEventFired', params: {}, sessionId: 'CHILD-A' });
    assert.equal(agentOut.at(-2).method, 'Target.attachedToTarget');
    assert.equal(agentOut.at(-2).sessionId, undefined, 'root-session events carry no sessionId');
    assert.equal(agentOut.at(-1).sessionId, 'CHILD-A');
    assert.equal(viewerOut.length, 1);

    // The viewer cannot use the agent's sessions, nor non-whitelisted methods.
    viewer.receive(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url: 'https://a.example' }, sessionId: 'CHILD-A' }));
    assert.match(viewerOut.at(-1).error.message, /Session with given id not found/);
    viewer.receive(JSON.stringify({ id: 3, method: 'Runtime.evaluate', params: { expression: 'document.cookie' } }));
    assert.match(viewerOut.at(-1).error.message, /not allowed/);
    viewer.receive(JSON.stringify({ id: 4, method: 'Network.getAllCookies' }));
    assert.match(viewerOut.at(-1).error.message, /not allowed/);
    assert.equal(toBrowser.length, 0, 'refused messages never reach the browser');

    // The viewer attaches to a page itself: that session is its own.
    viewer.receive(JSON.stringify({ id: 5, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } }));
    const attach = toBrowser.splice(0)[0]!;
    router.fromBrowser({ id: attach.id, result: { sessionId: 'CHILD-V' }, sessionId: 'ROOT-V' });
    viewer.receive(JSON.stringify({ id: 6, method: 'Page.startScreencast', params: { format: 'jpeg' }, sessionId: 'CHILD-V' }));
    const start = toBrowser.splice(0)[0]!;
    assert.equal(start.sessionId, 'CHILD-V');
    router.fromBrowser({ id: start.id, result: {}, sessionId: 'CHILD-V' });
    assert.deepEqual(viewerOut.at(-1), { id: 6, result: {}, sessionId: 'CHILD-V' });
    router.fromBrowser({ method: 'Page.screencastFrame', params: { data: 'abc', sessionId: 1 }, sessionId: 'CHILD-V' });
    assert.equal(viewerOut.at(-1).method, 'Page.screencastFrame');
    assert.equal(agentOut.some((m) => m.method === 'Page.screencastFrame'), false);

    // The agent cannot hijack the viewer's session either.
    agent.receive(JSON.stringify({ id: 9, method: 'Input.insertText', params: { text: 'x' }, sessionId: 'CHILD-V' }));
    assert.match(agentOut.at(-1).error.message, /Session with given id not found/);

    // Disconnect: the viewer's sessions are detached and forgotten.
    viewer.close();
    assert.equal(router.clientCount, 1);
    const detaches = toBrowser.splice(0);
    assert.deepEqual(detaches.map((m) => [m.method, m.params.sessionId, m.sessionId]), [
      ['Target.detachFromTarget', 'CHILD-V', 'ROOT-V'],
      ['Target.detachFromTarget', 'ROOT-V', undefined],
    ]);
    router.fromBrowser({ method: 'Page.screencastFrame', params: {}, sessionId: 'CHILD-V' });
    assert.equal(viewerOut.at(-1).method, 'Page.screencastFrame');
    assert.equal(viewerOut.filter((m) => m.method === 'Page.screencastFrame').length, 1, 'nothing after close');
  });
  await check('viewer whitelist: only screencast, input, tab and navigation calls; http(s) only', () => {
    for (const m of ['Runtime.evaluate', 'Network.getCookies', 'Storage.getCookies', 'Browser.close', 'Target.createTarget', 'Target.setAutoAttach', 'Page.setDownloadBehavior', 'Browser.setDownloadBehavior', 'DOM.getDocument', 'Fetch.enable']) {
      assert.ok(!VIEWER_METHODS.has(m), m);
    }
    assert.equal(viewerRefusal('Page.navigate', { url: 'javascript:alert(1)' }), 'Only http(s) addresses can be opened');
    assert.equal(viewerRefusal('Page.navigate', { url: 'file:///etc/passwd' }), 'Only http(s) addresses can be opened');
    assert.equal(viewerRefusal('Page.navigate', { url: 'https://example.com' }), undefined);
    assert.match(viewerRefusal('Target.attachToTarget', { targetId: 'x' }) ?? '', /flattened/);
    assert.equal(viewerRefusal('Input.insertText', { text: '你好' }), undefined);
  });
  await check('a client that leaves before its session exists is cleaned up', () => {
    const toBrowser: Record<string, any>[] = [];
    const router = new CdpRouter((m) => toBrowser.push(m as Record<string, any>));
    const c = router.addClient('agent', () => undefined);
    const attach = toBrowser.splice(0)[0]!;
    c.close();
    assert.equal(router.clientCount, 0);
    router.fromBrowser({ id: attach.id, result: { sessionId: 'LATE' } });
    return new Promise<void>((resolve) => setImmediate(() => {
      assert.deepEqual(toBrowser.map((m) => [m.method, m.params.sessionId]), [['Target.detachFromTarget', 'LATE']]);
      resolve();
    }));
  });

  console.log('takeover state');
  await check('no control file: the agent has the browser', async () => {
    const dir = tempLiveDir();
    assert.equal(readControl(dir).mode, 'agent');
    assert.deepEqual(await browserGate(dir, { waitMs: 0 }), { state: 'free' });
  });
  await check('user in control: the gate waits, then refuses', async () => {
    const dir = tempLiveDir();
    writeControl(dir, { mode: 'user', since: 1_000 });
    let clock = 10_000;
    const sleeps: number[] = [];
    const gate = await browserGate(dir, { waitMs: 3_000, pollMs: 1_000, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
    assert.deepEqual(gate, { state: 'user', since: 1_000 });
    assert.deepEqual(sleeps, [1_000, 1_000, 1_000]);
    const text = userInControlMessage(1_000, 1_000 + 5 * 60_000);
    assert.match(text, /user is controlling the browser/);
    assert.match(text, /5 min ago/);
    assert.match(text, /browser_request_handoff/);
  });
  await check('the user hands back while a tool waits: it goes on, with the handback once', async () => {
    const dir = tempLiveDir();
    writeControl(dir, { mode: 'user', since: 1_000 });
    let clock = 10_000;
    const gate = await browserGate(dir, {
      waitMs: 30_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        writeControl(dir, { mode: 'agent', since: clock, handedBackAt: clock, url: 'https://shop.example/account', title: 'My account', targetId: 'T9' });
      },
    });
    assert.equal(gate.state, 'free');
    assert.equal(gate.state === 'free' && gate.handback?.targetId, 'T9');
    // Reported once only.
    assert.deepEqual(await browserGate(dir, { waitMs: 0 }), { state: 'free' });
    const note = handbackNote({ mode: 'agent', since: 0, handedBackAt: Date.UTC(2026, 9, 10, 8, 30), url: 'https://shop.example/account', title: 'My account' });
    assert.match(note, /handed it back at 08:30 UTC/);
    assert.match(note, /My account — https:\/\/shop\.example\/account/);
    assert.match(note, /check the page/);
  });
  await check('a malformed control file counts as the agent holding the browser', async () => {
    const dir = tempLiveDir();
    fs.writeFileSync(path.join(dir, LIVE_FILES.control), '{not json');
    assert.equal(readControl(dir).mode, 'agent');
    writeControl(dir, { mode: 'owner?', since: 'x', url: 42 });
    assert.deepEqual(readControl(dir), { mode: 'agent', since: 0 });
  });

  console.log('handoff');
  await check('[browser-handoff] line: one line of JSON, newlines removed, long text cut', () => {
    const line = handoffLine({ id: 'h1', status: 'waiting', reason: '请登录\n然后点「交还」', url: 'https://a.example/login', title: 'x'.repeat(400) });
    assert.ok(line.startsWith('[browser-handoff] {'));
    assert.ok(!line.includes('\n'));
    const payload = JSON.parse(line.slice('[browser-handoff] '.length));
    assert.equal(payload.reason, '请登录 然后点「交还」');
    assert.equal(payload.status, 'waiting');
    assert.equal(payload.title.length, 300);
    const out: string[] = [];
    emitHandoff({ id: 'h1', status: 'done' }, (l) => out.push(l));
    assert.deepEqual(out, ['[browser-handoff] {"id":"h1","status":"done"}\n']);
    assert.deepEqual(findInternalNames(line), []);
  });
  await check('waitForHandback: handed back, never taken, still in control', async () => {
    const dir = tempLiveDir();
    let clock = 50_000;
    const step = (after: (t: number) => void) => async (ms: number) => { clock += ms; after(clock); };
    const handed = await waitForHandback(dir, 50_000, 60_000, {
      now: () => clock,
      sleep: step((t) => writeControl(dir, t < 52_000 ? { mode: 'user', since: t } : { mode: 'agent', since: t, handedBackAt: t, targetId: 'T2' })),
    });
    assert.equal(handed.outcome, 'handed_back');
    assert.equal(handed.control.targetId, 'T2');
    // A tool after it does not repeat the handback note.
    assert.deepEqual(await browserGate(dir, { waitMs: 0 }), { state: 'free' });

    const dir2 = tempLiveDir();
    // An old handback (before the request) does not count.
    writeControl(dir2, { mode: 'agent', since: 1, handedBackAt: 1 });
    const never = await waitForHandback(dir2, 50_000, 3_000, { now: () => clock, sleep: async (ms) => { clock += ms; } });
    assert.equal(never.outcome, 'not_taken');
    writeControl(dir2, { mode: 'user', since: clock });
    const holding = await waitForHandback(dir2, clock, 3_000, { now: () => clock, sleep: async (ms) => { clock += ms; } });
    assert.equal(holding.outcome, 'still_in_control');
    const controller = new AbortController();
    controller.abort();
    assert.equal((await waitForHandback(dir2, clock, 60_000, { signal: controller.signal })).outcome, 'aborted');
  });

  console.log('browser tools in live mode');
  await check('while the user holds the browser, page tools refuse without touching it', async () => {
    const dir = tempLiveDir();
    writeControl(dir, { mode: 'user', since: Date.now() });
    const before = { live: process.env[LIVE_DIR_ENV], wait: process.env.ARTEMIS_BROWSER_TAKEOVER_WAIT_MS };
    process.env[LIVE_DIR_ENV] = dir;
    process.env.ARTEMIS_BROWSER_TAKEOVER_WAIT_MS = '0';
    try {
      const tools = await import('../src/tools/browser/browserTools.js');
      for (const result of [
        await tools.executeBrowserExtract({ type: 'browser_extract_text' }),
        await tools.executeBrowserNavigate({ type: 'browser_navigate', url: 'https://example.com' }),
        await tools.executeBrowserClick({ type: 'browser_click', text: 'Buy' }),
      ]) {
        assert.equal(result.ok, false);
        assert.equal(result.error?.code, 'browser_user_in_control');
        assert.match(result.output, /user is controlling the browser/);
      }
      // No browser was started for them.
      assert.equal(fs.existsSync(path.join(dir, LIVE_FILES.host)), false);
      // Local buffers stay readable.
      assert.equal((await tools.executeBrowserConsole({ type: 'browser_console' })).ok, true);
    } finally {
      if (before.live === undefined) delete process.env[LIVE_DIR_ENV];
      else process.env[LIVE_DIR_ENV] = before.live;
      if (before.wait === undefined) delete process.env.ARTEMIS_BROWSER_TAKEOVER_WAIT_MS;
      else process.env.ARTEMIS_BROWSER_TAKEOVER_WAIT_MS = before.wait;
    }
  });
  await check('browser_request_handoff outside live mode asks the model to hand the step to the user in its reply', async () => {
    const before = process.env[LIVE_DIR_ENV];
    delete process.env[LIVE_DIR_ENV];
    try {
      const tools = await import('../src/tools/browser/browserTools.js');
      const missing = await tools.executeBrowserRequestHandoff({ type: 'browser_request_handoff', reason: ' ' });
      assert.equal(missing.error?.code, 'invalid_input');
      const result = await tools.executeBrowserRequestHandoff({ type: 'browser_request_handoff', reason: 'Please sign in' });
      assert.equal(result.ok, true);
      assert.match(result.output, /Ask the user in your reply/);
    } finally {
      if (before !== undefined) process.env[LIVE_DIR_ENV] = before;
    }
  });
  await check('the tool is registered with a schema, a label and a permission category', async () => {
    const { getToolDefinition } = await import('../src/tools/registry.js');
    const { buildActionParametersSchema } = await import('../src/core/providerNativeTools.js');
    const { describeToolForUser } = await import('../src/utils/internalNames.js');
    const { getAllowedActionTypesForProfile } = await import('../src/core/agentProfiles.js');
    const tool = getToolDefinition('browser_request_handoff');
    assert.ok(tool?.execute);
    assert.ok(tool.validate({ type: 'browser_request_handoff' } as never).length > 0);
    assert.deepEqual(tool.validate({ type: 'browser_request_handoff', reason: '请登录' } as never), []);
    assert.deepEqual((buildActionParametersSchema('browser_request_handoff' as never) as { required?: string[] }).required, ['reason']);
    assert.equal(describeToolForUser('browser_request_handoff', 'zh-CN'), '请你接管浏览器');
    assert.ok(getAllowedActionTypesForProfile('main').includes('browser_request_handoff' as never));
  });

  console.log('host');
  await check('the host and Chromium get no keys from the engine environment', () => {
    const env = hostEnv({
      PATH: '/usr/bin',
      HOME: '/home/a',
      TZ: 'Asia/Shanghai',
      PLAYWRIGHT_BROWSERS_PATH: '/opt/pw',
      OPENAI_API_KEY: 'sk-test',
      ARTEMIS_ONLINE_RUN: 'marker',
      GATEWAY_KEY: 'g',
      AWS_SECRET_ACCESS_KEY: 's',
    });
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'TZ']);
  });
  await check('files are written atomically with exact modes', () => {
    const dir = tempLiveDir();
    const file = path.join(dir, 'x.json');
    writeJsonFileAtomic(file, { a: 1 }, 0o600);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    writeJsonFileAtomic(file, { a: 2 }, 0o640);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });
    assert.deepEqual(fs.readdirSync(dir), ['x.json']);
  });

  console.log(`\nbrowser live smoke: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
