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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CdpRouter, VIEWER_METHODS, viewerParams, viewerRefusal } from '../src/tools/browser/cdpRouter.js';
import {
  LIVE_DIR_ENV,
  LIVE_FILES,
  claimTab,
  probeHost,
  releaseTab,
  resetRunState,
  tabOwner,
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
  /** A fake browser behind the router: answers what the tests script, records the rest. */
  const fakeBrowser = () => {
    const sent: Record<string, any>[] = [];
    const answers: Record<string, (m: Record<string, any>) => Record<string, unknown> | undefined> = {};
    const router = new CdpRouter((m) => {
      const msg = m as Record<string, any>;
      sent.push(msg);
      const answer = answers[msg.method];
      const result = answer?.(msg);
      if (result) queueMicrotask(() => router.fromBrowser({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
    });
    return { router, sent, answers };
  };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const connect = async (router: CdpRouter, role: 'agent' | 'viewer', root: string, sent: Record<string, any>[], options: { internal?: boolean } = {}) => {
    const out: any[] = [];
    const client = router.addClient(role, (t) => out.push(JSON.parse(t)), options);
    const attach = sent.findLast((m) => m.method === 'Target.attachToBrowserTarget')!;
    router.fromBrowser({ id: attach.id, result: { sessionId: root } });
    await settle();
    return { client, out };
  };

  await check('per-client ids and browser sessions; responses and events routed back', async () => {
    const { router, sent } = fakeBrowser();
    const agent = await connect(router, 'agent', 'ROOT-A', sent);
    const viewer = await connect(router, 'viewer', 'ROOT-V', sent);
    assert.equal(router.clientCount, 2);
    sent.length = 0;
    agent.client.receive(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    viewer.client.receive(JSON.stringify({ id: 1, method: 'Target.getTargets', params: { filter: [{ type: 'browser' }] } }));
    await settle();
    const [a, v] = sent.splice(0);
    assert.equal(a!.sessionId, 'ROOT-A');
    assert.notEqual(a!.id, v!.id, 'host ids never collide');
    assert.deepEqual(v!.params, {}, 'unlisted parameters are dropped');
    router.fromBrowser({ id: a!.id, result: { product: 'Chrome' }, sessionId: 'ROOT-A' });
    router.fromBrowser({ id: v!.id, result: { targetInfos: [] }, sessionId: 'ROOT-V' });
    assert.deepEqual(agent.out, [{ id: 1, result: { product: 'Chrome' } }]);
    assert.deepEqual(viewer.out, [{ id: 1, result: { targetInfos: [] } }]);

    // Auto-attached child of the agent: its events go to the agent only.
    router.fromBrowser({ method: 'Target.attachedToTarget', params: { sessionId: 'CHILD-A', targetInfo: { type: 'page' } }, sessionId: 'ROOT-A' });
    router.fromBrowser({ method: 'Page.loadEventFired', params: {}, sessionId: 'CHILD-A' });
    assert.equal(agent.out.at(-2).method, 'Target.attachedToTarget');
    assert.equal(agent.out.at(-2).sessionId, undefined, 'root-session events carry no sessionId');
    assert.equal(agent.out.at(-1).sessionId, 'CHILD-A');
    assert.equal(viewer.out.length, 1);

    // Neither may use the other's sessions.
    viewer.client.receive(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url: 'https://a.example' }, sessionId: 'CHILD-A' }));
    await settle();
    assert.match(viewer.out.at(-1).error.message, /Session with given id not found/);
    viewer.client.receive(JSON.stringify({ id: 3, method: 'Target.detachFromTarget', params: { sessionId: 'CHILD-A' } }));
    await settle();
    assert.match(viewer.out.at(-1).error.message, /Session with given id not found/, 'cannot detach the agent from its page');
    agent.client.receive(JSON.stringify({ id: 9, method: 'Input.insertText', params: { text: 'x' }, sessionId: 'ROOT-V' }));
    await settle();
    assert.match(agent.out.at(-1).error.message, /Session with given id not found/);
    assert.equal(sent.length, 0, 'refused messages never reach the browser');

    // Disconnect: the viewer's sessions are detached and forgotten.
    viewer.client.close();
    assert.equal(router.clientCount, 1);
    assert.deepEqual(sent.splice(0).map((m) => [m.method, m.params.sessionId, m.sessionId]), [['Target.detachFromTarget', 'ROOT-V', undefined]]);
  });

  await check('viewer parameters are rebuilt from the whitelist: no script on reload, no editing commands, no filters', async () => {
    assert.deepEqual(viewerParams('Page.reload', { ignoreCache: true, scriptToEvaluateOnLoad: 'steal()' }), { params: { ignoreCache: true } });
    assert.deepEqual(viewerParams('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', commands: ['selectAll', 'copy'] }), { params: { type: 'rawKeyDown', key: 'a' } });
    assert.deepEqual(viewerParams('Page.navigate', { url: 'https://a.example/x', referrer: 'https://evil.example', frameId: 'F' }), { params: { url: 'https://a.example/x' } });
    assert.deepEqual(viewerParams('Target.setDiscoverTargets', { discover: true, filter: [{}] }), { params: { discover: true } });
    assert.deepEqual(viewerParams('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280 }), { params: { format: 'jpeg', quality: 60, maxWidth: 1280 } });
    for (const [method, params] of [
      ['Runtime.evaluate', { expression: 'document.cookie' }],
      ['Network.getAllCookies', {}],
      ['Storage.getCookies', {}],
      ['Browser.close', {}],
      ['Target.createTarget', { url: 'https://a.example' }],
      ['Target.setAutoAttach', { autoAttach: true }],
      ['Browser.setDownloadBehavior', { behavior: 'allow' }],
      ['Emulation.setDeviceMetricsOverride', { width: 1 }],
      ['Page.navigate', { url: 'javascript:alert(1)' }],
      ['Page.navigate', { url: 'file:///etc/passwd' }],
      ['Page.navigate', { url: 'http:file:///etc/passwd' }],
      ['Target.attachToTarget', { targetId: 'x' }],
      ['Input.dispatchMouseEvent', { type: 'mouseDragged', x: 1, y: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: Number.NaN, y: 1 }],
      ['Input.dispatchKeyEvent', { type: 'keyDown', text: 'too long text' }],
      ['Input.insertText', {}],
      ['Artemis.setViewport', { targetId: 'T', mode: 'tablet' }],
    ] as const) {
      assert.ok('error' in viewerParams(method, params as Record<string, unknown>), `${method} ${JSON.stringify(params)}`);
    }
    assert.ok(VIEWER_METHODS.has('Input.insertText'));
    assert.equal(viewerRefusal('Input.insertText', { text: '你好' }), undefined);

    // End to end through the router: what reaches the browser is the rebuilt call.
    const { router, sent } = fakeBrowser();
    const viewer = await connect(router, 'viewer', 'ROOT-V', sent);
    sent.length = 0;
    viewer.client.receive(JSON.stringify({ id: 1, method: 'Page.reload', params: { scriptToEvaluateOnLoad: 'steal()' } }));
    viewer.client.receive(JSON.stringify({ id: 2, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', text: 'a', commands: ['copy'] } }));
    await settle();
    assert.deepEqual(sent.map((m) => [m.method, m.params]), [['Page.reload', {}], ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: 'a' }]]);
  });

  await check('checks against the browser: only page targets, only http(s) history entries; order is kept', async () => {
    const { router, sent, answers } = fakeBrowser();
    answers['Target.getTargetInfo'] = (m) => ({ targetInfo: { targetId: m.params.targetId, type: m.params.targetId.startsWith('P') ? 'page' : 'service_worker' } });
    answers['Page.getNavigationHistory'] = () => ({ currentIndex: 1, entries: [{ id: 1, url: 'data:text/html,secret' }, { id: 2, url: 'https://a.example/' }] });
    answers['Target.attachToTarget'] = () => ({ sessionId: 'CHILD-V' });
    const viewer = await connect(router, 'viewer', 'ROOT-V', sent);
    viewer.client.receive(JSON.stringify({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'SW1', flatten: true } }));
    viewer.client.receive(JSON.stringify({ id: 2, method: 'Target.attachToTarget', params: { targetId: 'P1', flatten: true } }));
    await settle();
    assert.match(viewer.out.find((m) => m.id === 1).error.message, /Only page targets/);
    assert.deepEqual(viewer.out.find((m) => m.id === 2), { id: 2, result: { sessionId: 'CHILD-V' } });
    viewer.client.receive(JSON.stringify({ id: 3, method: 'Page.navigateToHistoryEntry', params: { entryId: 1 }, sessionId: 'CHILD-V' }));
    viewer.client.receive(JSON.stringify({ id: 4, method: 'Input.insertText', params: { text: 'after' }, sessionId: 'CHILD-V' }));
    viewer.client.receive(JSON.stringify({ id: 5, method: 'Page.navigateToHistoryEntry', params: { entryId: 2 }, sessionId: 'CHILD-V' }));
    await settle();
    assert.match(viewer.out.find((m) => m.id === 3).error.message, /http\(s\) history/);
    const forwarded = sent.filter((m) => m.method === 'Input.insertText' || m.method === 'Page.navigateToHistoryEntry');
    assert.deepEqual(forwarded.map((m) => [m.method, m.params]), [['Input.insertText', { text: 'after' }], ['Page.navigateToHistoryEntry', { entryId: 2 }]]);
  });

  await check('only attached, external clients keep the browser open; Artemis.* goes to the host', async () => {
    const { router, sent } = fakeBrowser();
    router.addClient('agent', () => undefined); // never gets its session
    assert.equal(router.clientCount, 0, 'a connection that never attached does not count');
    await connect(router, 'agent', 'ROOT-M', sent, { internal: true });
    assert.equal(router.clientCount, 0, 'the host monitor does not count');
    const viewer = await connect(router, 'viewer', 'ROOT-V', sent);
    assert.equal(router.clientCount, 1);
    const calls: unknown[] = [];
    router.hostMethod = async (method, params, client) => {
      calls.push([method, params, client.role]);
      return { ok: true };
    };
    sent.length = 0;
    viewer.client.receive(JSON.stringify({ id: 1, method: 'Artemis.setViewport', params: { targetId: 'P1', mode: 'mobile', width: 390, height: 844, extra: 1 } }));
    // The target check asks the browser first.
    await settle();
    const info = sent.find((m) => m.method === 'Target.getTargetInfo')!;
    router.fromBrowser({ id: info.id, result: { targetInfo: { type: 'page' } } });
    await settle();
    assert.deepEqual(calls, [['Artemis.setViewport', { targetId: 'P1', mode: 'mobile', width: 390, height: 844 }, 'viewer']]);
    assert.deepEqual(viewer.out.at(-1), { id: 1, result: { ok: true } });
    assert.ok(!sent.some((m) => String(m.method).startsWith('Artemis.')), 'never forwarded to Chromium');
  });

  /** A router whose host pauses the tabs in `paused` and treats texts containing `secret` as carrying the password. */
  const secretRouter = async () => {
    const env = fakeBrowser();
    const paused = new Set<string>();
    env.router.secrets = { isPaused: (t) => paused.has(t), sensitive: (text) => text.includes('S3CRET') };
    const agent = await connect(env.router, 'agent', 'ROOT-A', env.sent);
    const viewer = await connect(env.router, 'viewer', 'ROOT-V', env.sent);
    // The viewer watches two tabs: CHILD-1 shows P1, CHILD-2 shows P2.
    for (const [n, target] of [[10, 'P1'], [11, 'P2']] as const) {
      viewer.client.receive(JSON.stringify({ id: n, method: 'Target.attachToTarget', params: { targetId: target, flatten: true } }));
      await settle();
      const info = env.sent.findLast((m) => m.method === 'Target.getTargetInfo')!;
      env.router.fromBrowser({ id: info.id, result: { targetInfo: { type: 'page' } } });
      await settle();
      const attach = env.sent.findLast((m) => m.method === 'Target.attachToTarget')!;
      env.router.fromBrowser({ id: attach.id, result: { sessionId: target === 'P1' ? 'CHILD-1' : 'CHILD-2' } });
      await settle();
    }
    return { ...env, paused, agent, viewer };
  };

  await check('a paused tab sends viewers no frames, screenshots or page events; other tabs and agents are not affected', async () => {
    const { router, sent, paused, agent, viewer } = await secretRouter();
    router.fromBrowser({ method: 'Target.attachedToTarget', params: { sessionId: 'CHILD-A', targetInfo: { targetId: 'P1', type: 'page' } }, sessionId: 'ROOT-A' });
    paused.add('P1');
    router.pausedTargetsChanged([{ targetId: 'P1', since: 1234 }], true);
    assert.deepEqual(viewer.out.at(-1), { method: 'Artemis.streamPaused', params: { paused: true, reason: 'secret', targets: [{ targetId: 'P1', since: 1234 }] } });
    assert.equal(agent.out.some((m) => m.method === 'Artemis.streamPaused'), false, 'only viewers are told');
    sent.length = 0;
    const before = viewer.out.length;
    router.fromBrowser({ method: 'Page.screencastFrame', params: { data: 'SECRET-PIXELS', sessionId: 7 }, sessionId: 'CHILD-1' });
    router.fromBrowser({ method: 'Page.frameNavigated', params: { frame: { id: 'F', url: 'https://site.example/?q=1' } }, sessionId: 'CHILD-1' });
    assert.equal(viewer.out.length, before, 'nothing of the paused tab is forwarded');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(sent.map((m) => [m.method, m.params, m.sessionId]), [['Page.screencastFrameAck', { sessionId: 7 }, 'CHILD-1']], 'acknowledged by the router');
    // The other tab streams on.
    router.fromBrowser({ method: 'Page.screencastFrame', params: { data: 'ok', sessionId: 8 }, sessionId: 'CHILD-2' });
    assert.equal(viewer.out.at(-1).method, 'Page.screencastFrame');
    // The agent's own frames are not affected.
    router.fromBrowser({ method: 'Page.screencastFrame', params: { data: 'x', sessionId: 1 }, sessionId: 'CHILD-A' });
    assert.equal(agent.out.at(-1).method, 'Page.screencastFrame');
    viewer.client.receive(JSON.stringify({ id: 50, method: 'Page.captureScreenshot', params: {}, sessionId: 'CHILD-1' }));
    await settle();
    assert.match(viewer.out.at(-1).error.message, /paused/);
    viewer.client.receive(JSON.stringify({ id: 51, method: 'Page.getNavigationHistory', params: {}, sessionId: 'CHILD-1' }));
    await settle();
    assert.match(viewer.out.at(-1).error.message, /paused/, 'history names URLs too');
    // A viewer that connects meanwhile is told at once.
    const late = await connect(router, 'viewer', 'ROOT-L', sent);
    assert.equal(late.out[0].params.paused, true);
    paused.delete('P1');
    router.pausedTargetsChanged([], false);
    assert.deepEqual(viewer.out.at(-1), { method: 'Artemis.streamPaused', params: { paused: false, reason: 'secret', targets: [] } });
    router.fromBrowser({ method: 'Page.screencastFrame', params: { data: 'ok', sessionId: 9 }, sessionId: 'CHILD-1' });
    assert.equal(viewer.out.at(-1).method, 'Page.screencastFrame');
  });

  await check('viewers never read a paused tab\'s URL or title, nor any URL or title carrying the password', async () => {
    const { router, sent, paused, viewer } = await secretRouter();
    paused.add('P1');
    router.pausedTargetsChanged([{ targetId: 'P1', since: 1 }], true);
    router.fromBrowser({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'P1', type: 'page', url: 'https://site.example/signup', title: 'Sign up' } }, sessionId: 'ROOT-V' });
    assert.deepEqual(viewer.out.at(-1).params.targetInfo, { targetId: 'P1', type: 'page', url: '', title: '' });
    router.fromBrowser({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'P2', type: 'page', url: 'https://other.example/?password=S3CRET', title: 'Echo S3CRET' } }, sessionId: 'ROOT-V' });
    assert.deepEqual(viewer.out.at(-1).params.targetInfo, { targetId: 'P2', type: 'page', url: '', title: '' }, 'a URL with the password is blanked anywhere');
    router.fromBrowser({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'P2', type: 'page', url: 'https://other.example/', title: 'Other' } }, sessionId: 'ROOT-V' });
    assert.deepEqual(viewer.out.at(-1).params.targetInfo, { targetId: 'P2', type: 'page', url: 'https://other.example/', title: 'Other' });
    router.fromBrowser({ method: 'Page.navigatedWithinDocument', params: { frameId: 'F', url: 'https://other.example/#S3CRET' }, sessionId: 'CHILD-2' });
    assert.equal(viewer.out.at(-1).params.url, '');
    viewer.client.receive(JSON.stringify({ id: 60, method: 'Target.getTargets', params: {} }));
    await settle();
    const list = sent.findLast((m) => m.method === 'Target.getTargets')!;
    router.fromBrowser({ id: list.id, result: { targetInfos: [{ targetId: 'P1', type: 'page', url: 'https://site.example/signup', title: 'Sign up' }, { targetId: 'P2', type: 'page', url: 'https://other.example/', title: 'Other' }] } });
    assert.deepEqual(viewer.out.at(-1).result.targetInfos.map((t: any) => [t.url, t.title]), [['', ''], ['https://other.example/', 'Other']]);
  });

  await check('a viewer screenshot asked for before a pause began is not delivered', async () => {
    const { router, sent, paused, viewer } = await secretRouter();
    viewer.client.receive(JSON.stringify({ id: 70, method: 'Page.captureScreenshot', params: { format: 'png' }, sessionId: 'CHILD-2' }));
    await settle();
    const shot = sent.findLast((m) => m.method === 'Page.captureScreenshot')!;
    paused.add('P2');
    router.pausedTargetsChanged([{ targetId: 'P2', since: 2 }], true);
    router.fromBrowser({ id: shot.id, result: { data: 'PIXELS-AFTER-PAUSE' }, sessionId: 'CHILD-2' });
    assert.equal(viewer.out.at(-1).id, 70);
    assert.match(viewer.out.at(-1).error.message, /paused/);
    assert.ok(!JSON.stringify(viewer.out).includes('PIXELS-AFTER-PAUSE'));
    // Without a pause in between, screenshots arrive as usual.
    paused.clear();
    router.pausedTargetsChanged([], false);
    viewer.client.receive(JSON.stringify({ id: 71, method: 'Page.captureScreenshot', params: {}, sessionId: 'CHILD-2' }));
    await settle();
    const next = sent.findLast((m) => m.method === 'Page.captureScreenshot')!;
    router.fromBrowser({ id: next.id, result: { data: 'OK' }, sessionId: 'CHILD-2' });
    assert.deepEqual(viewer.out.at(-1), { id: 71, result: { data: 'OK' }, sessionId: 'CHILD-2' });
  });

  await check('viewer input names the tab it went to (the host keeps scripts off it afterwards)', async () => {
    const { router, viewer } = await secretRouter();
    const typed: string[] = [];
    router.onViewerInput = (t) => typed.push(t);
    viewer.client.receive(JSON.stringify({ id: 80, method: 'Input.insertText', params: { text: 'hunter2' }, sessionId: 'CHILD-2' }));
    viewer.client.receive(JSON.stringify({ id: 81, method: 'Page.enable', params: {}, sessionId: 'CHILD-1' }));
    await settle();
    assert.deepEqual(typed, ['P2']);
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
  await check('handback notes are per run: each run hears about a handback once, a new run not about old ones', async () => {
    const dir = tempLiveDir();
    resetRunState();
    writeControl(dir, { mode: 'agent', since: 5, handedBackAt: 5, url: 'https://a.example/' });
    const first = await browserGate(dir, { waitMs: 0 });
    assert.equal(first.state === 'free' && first.handback?.handedBackAt, 5);
    // Another run starting later: that handback was reported already.
    resetRunState();
    assert.deepEqual(await browserGate(dir, { waitMs: 0 }), { state: 'free' });
    // Two runs alive at the time of a new handback: each hears about it.
    writeControl(dir, { mode: 'agent', since: 9, handedBackAt: 9 });
    const runA = await browserGate(dir, { waitMs: 0 });
    resetRunState(); // run B, a separate process, started before the handback was reported to A
    fs.writeFileSync(path.join(dir, LIVE_FILES.agent), JSON.stringify({ seenHandbackAt: 5 }));
    const runB = await browserGate(dir, { waitMs: 0 });
    assert.equal(runA.state === 'free' && !!runA.handback, true);
    assert.equal(runB.state === 'free' && !!runB.handback, true);
  });
  await check('a takeover the server ended is not reported as a handback', () => {
    const idle = handbackNote({ mode: 'agent', since: 0, handedBackAt: Date.UTC(2026, 9, 10, 8, 30), endedBy: 'idle', url: 'https://a.example/' });
    assert.match(idle, /did not hand it back/);
    assert.match(idle, /timed out/);
    assert.match(idle, /may not have finished/);
    const owner = handbackNote({ mode: 'agent', since: 0, handedBackAt: 1, endedBy: 'owner' });
    assert.match(owner, /handed it back/);
    assert.doesNotMatch(owner, /did not/);
    const restart = handbackNote({ mode: 'agent', since: 0, handedBackAt: 1, endedBy: 'restart' });
    assert.match(restart, /platform restarted/);
    assert.doesNotMatch(restart, /view closed/, 'a restart is not the view closing');
    assert.match(handbackNote({ mode: 'agent', since: 0, handedBackAt: 1, endedBy: 'closed' }), /view closed/);
    const dir = tempLiveDir();
    writeControl(dir, { mode: 'agent', since: 1, handedBackAt: 1, endedBy: 'idle' });
    assert.equal(readControl(dir).endedBy, 'idle');
    writeControl(dir, { mode: 'agent', since: 1, endedBy: 'hacked' });
    assert.equal(readControl(dir).endedBy, undefined);
  });
  await check('tabs are claimed per run: another live run keeps its tab; a dead one does not', () => {
    const dir = tempLiveDir();
    assert.equal(claimTab(dir, 'T1'), true);
    assert.equal(tabOwner(dir, 'T1'), undefined, 'our own claim');
    // A tab claimed by another live process (our parent stands in for it).
    writeJsonFileAtomic(path.join(dir, LIVE_FILES.claims, 'T2.json'), { pid: process.ppid }, 0o600);
    assert.equal(tabOwner(dir, 'T2'), process.ppid);
    assert.equal(claimTab(dir, 'T2'), false);
    releaseTab(dir, 'T2');
    assert.ok(fs.existsSync(path.join(dir, LIVE_FILES.claims, 'T2.json')), 'never releases another run\'s tab');
    // A claim by a process that is gone is free.
    writeJsonFileAtomic(path.join(dir, LIVE_FILES.claims, 'T3.json'), { pid: 2 ** 22 + 7 }, 0o600);
    assert.equal(claimTab(dir, 'T3'), true);
    releaseTab(dir, 'T1');
    assert.ok(!fs.existsSync(path.join(dir, LIVE_FILES.claims, 'T1.json')));
    assert.equal(claimTab(dir, '../escape'), false);
    // A dead run's claim is never removed by releasing (only broken by a new claim).
    writeJsonFileAtomic(path.join(dir, LIVE_FILES.claims, 'T4.json'), { pid: 2 ** 22 + 9 }, 0o600);
    releaseTab(dir, 'T4');
    assert.ok(fs.existsSync(path.join(dir, LIVE_FILES.claims, 'T4.json')));
    // An unreadable claim is broken once it is old.
    fs.writeFileSync(path.join(dir, LIVE_FILES.claims, 'T5.json'), '{half');
    assert.equal(claimTab(dir, 'T5'), false, 'a fresh unreadable claim may be one being written');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, LIVE_FILES.claims, 'T5.json'), old, old);
    assert.equal(claimTab(dir, 'T5'), true);
  });
  await check('claiming is atomic: of runs racing for a free or stale tab, exactly one gets it', async () => {
    const { spawn } = await import('node:child_process');
    const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
    const module = path.resolve('src/tools/browser/liveBrowser.ts');
    for (const stale of [false, true]) {
      const dir = tempLiveDir();
      fs.mkdirSync(path.join(dir, LIVE_FILES.claims));
      if (stale) writeJsonFileAtomic(path.join(dir, LIVE_FILES.claims, 'RACE.json'), { pid: 2 ** 22 + 11 }, 0o600);
      // Each racer stays alive until all have answered (a winner that exited would leave a stale claim).
      const script = `const m = await import(${JSON.stringify(module)}); const go = Number(process.argv[1]); while (Date.now() < go) {} console.log(m.claimTab(${JSON.stringify(dir)}, 'RACE') ? 'won' : 'lost'); setTimeout(() => process.exit(0), 60000);`;
      const go = Date.now() + 4_000;
      const racers: import('node:child_process').ChildProcess[] = [];
      const results = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve) => {
        const p = spawn(process.execPath, ['--no-warnings', tsx, '--input-type=module', '-e', script, String(go)], { stdio: ['ignore', 'pipe', 'inherit'] });
        racers.push(p);
        let out = '';
        p.stdout.on('data', (d) => {
          out += d;
          if (out.includes('\n')) resolve(out.trim());
        });
        p.on('exit', () => resolve(out.trim()));
      })));
      for (const p of racers) p.kill('SIGKILL');
      assert.equal(results.filter((r) => r === 'won').length, 1, `${stale ? 'stale' : 'free'} tab: ${results.join(',')}`);
    }
  });
  await check('a malformed control file counts as the agent holding the browser', async () => {
    const dir = tempLiveDir();
    fs.writeFileSync(path.join(dir, LIVE_FILES.control), '{not json');
    assert.equal(readControl(dir).mode, 'agent');
    writeControl(dir, { mode: 'owner?', since: 'x', url: 42 });
    assert.deepEqual(readControl(dir), { mode: 'agent', since: 0 });
  });

  console.log('sign-up password fingerprints');
  await check('the host recognises a password in a URL or title from fingerprints, without the password', async () => {
    const { fingerprintSet, parseFingerprintSet, FingerprintMatcher } = await import('../src/security/secretFingerprints.js');
    const { secretVariants } = await import('../src/security/identityCredentials.js');
    const password = 'Pw!Leak 99&x';
    const set = fingerprintSet(secretVariants(password));
    assert.ok(!JSON.stringify(set).includes('Leak'), 'the set does not carry the password');
    const parsed = parseFingerprintSet(JSON.parse(JSON.stringify(set)));
    assert.ok(parsed);
    const m = new FingerprintMatcher();
    m.add(parsed);
    const form = new URLSearchParams({ user: 'me', password }).toString();
    assert.equal(m.matches(`https://site.example/login?${form}`), true, 'form-encoded in a GET URL');
    assert.equal(m.matches(`https://site.example/#${encodeURIComponent(password)}`), true);
    assert.equal(m.matches(`Welcome ${password}`), true);
    assert.equal(m.matches('https://site.example/login?user=me'), false);
    assert.equal(m.matches(''), false);
    assert.equal(parseFingerprintSet({ salt: 'x', hashes: [] }), undefined);
    assert.equal(parseFingerprintSet({ salt: 'a'.repeat(22), hashes: [{ n: 2, h: '0'.repeat(32) }] }), undefined, 'short variants are not accepted');
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
      // The logs wait too: what the owner does while holding the browser is not read.
      for (const result of [await tools.executeBrowserConsole({ type: 'browser_console' }), await tools.executeBrowserRequests({ type: 'browser_requests' })]) {
        assert.equal(result.error?.code, 'browser_user_in_control');
      }
      // No browser was started for them.
      assert.equal(fs.existsSync(path.join(dir, LIVE_FILES.host)), false);
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
  await check('a host is only trusted when it answers the token handshake (pids and ports get reused)', async () => {
    const token = 'k'.repeat(43);
    const server = http.createServer((_q, r) => r.writeHead(404).end());
    server.on('upgrade', (req, socket) => {
      const ok = req.url === `/cdp/${token}` && handshakeResponse(req.headers);
      if (ok) socket.write(ok);
      else socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    assert.equal(await probeHost(port, token), true);
    assert.equal(await probeHost(port, 'x'.repeat(43)), false);
    server.close();
    const plain = http.createServer((_q, r) => r.writeHead(200).end('something else'));
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()));
    assert.equal(await probeHost((plain.address() as { port: number }).port, token), false, 'an open port is not a host');
    plain.close();
    assert.equal(await probeHost(1, token, 500), false);
  });
  await check('pongs count as signs of life', () => {
    let pongs = 0;
    const decoder = new FrameDecoder({ onText: () => undefined, onClose: () => undefined, onPong: () => pongs++ }, () => undefined);
    decoder.push(clientFrame(0xa, Buffer.alloc(0)));
    assert.equal(pongs, 1);
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
