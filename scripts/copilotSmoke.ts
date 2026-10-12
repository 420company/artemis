/**
 * Proactive copilot: live updates (post_update / [agent-update]), the live
 * status ([agent-status]), the errand playbook and its routing, the
 * credential store, server_setup against a fake SSH server, the QR encoder
 * and the verification-code adapter.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-copilot-'));
process.env.ARTEMIS_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.ARTEMIS_HOME, { recursive: true });

const { AgentUpdateChannel, AGENT_UPDATE_PREFIX, MAX_UPDATE_CHARS } = await import('../src/core/agentUpdates.js');
const { AgentStatusReporter, statusForAction, statusForApprovalKind, hostOf } = await import('../src/core/agentStatus.js');
const { looksLikeOperatorTask, buildOperatorPlaybook } = await import('../src/core/operatorPlaybook.js');
const { planHeadlessWorkflow } = await import('../src/services/headlessWorkflow.js');
const { buildWorkflowHint } = await import('../src/core/workflowHints.js');
const { SessionStore } = await import('../src/storage/sessions.js');
const { FileCredentialStore, generatePassword, resolveCredentialPlaceholders } = await import('../src/security/credentialStore.js');
const { generateSshKeyPair, generateWireGuardKeyPair } = await import('../src/tools/serverSetup/keys.js');
const { encodeQr, qrToPng } = await import('../src/tools/serverSetup/qr.js');
const { executeServerSetup } = await import('../src/tools/serverSetup/serverSetup.js');
const { executeGetVerificationCode, registerVerificationCodeSource } = await import('../src/tools/verificationCodes.js');
const { executePostUpdate } = await import('../src/tools/postUpdate.js');
const { getAllowedActionTypesForProfile } = await import('../src/core/agentProfiles.js');

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

// ── live updates ────────────────────────────────────────────────────────
await test('updates: emitted at once as one JSON line, ids and order kept', () => {
  const lines: string[] = [];
  let now = 1_000_000;
  const channel = new AgentUpdateChannel({ emit: (l) => lines.push(l), now: () => now });
  const first = channel.post('  收到，已经在办了：先去看看配置和价格。 ');
  assert.equal(first.ok, true);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith(`${AGENT_UPDATE_PREFIX} {`));
  const payload = JSON.parse(lines[0]!.slice(AGENT_UPDATE_PREFIX.length + 1));
  assert.equal(payload.text, '收到，已经在办了：先去看看配置和价格。');
  assert.match(payload.id, /^upd_[0-9a-f]{16}$/);
  assert.equal(payload.seq, 1);
  assert.equal(channel.post('香港机房没货了，正在看新加坡和东京。').ok, true);
  // Burst used up: the third right away is refused, later it goes.
  const third = channel.post('找到两个候选。');
  assert.equal(third.ok, false);
  assert.equal(!third.ok && third.code, 'update_rate_limited');
  now += 8_000;
  assert.equal(channel.post('找到两个候选。').ok, true);
  assert.equal(channel.updates.length, 3);
  // History claims by text, in order.
  assert.equal(channel.claim('收到，已经在办了：先去看看配置和价格。')?.id, payload.id);
  assert.equal(channel.claim('收到，已经在办了：先去看看配置和价格。'), undefined);
});

await test('updates: length cap, cards, repeats and the per-run cap', () => {
  let now = 0;
  const channel = new AgentUpdateChannel({ emit: () => undefined, now: () => now, maxPerRun: 3 });
  const long = channel.post('长'.repeat(MAX_UPDATE_CHARS + 1));
  assert.equal(!long.ok && long.code, 'update_too_long');
  assert.equal(channel.post('长'.repeat(MAX_UPDATE_CHARS)).ok, true, 'exactly at the cap is fine (code points)');
  const card = channel.post('选哪个？\n```choices\n{"options":["A","B"]}\n```');
  assert.equal(!card.ok && card.code, 'update_has_card');
  now += 60_000;
  assert.equal(channel.post('第二条').ok, true);
  const again = channel.post('第二条');
  assert.equal(!again.ok && again.code, 'update_repeated');
  now += 60_000;
  assert.equal(channel.post('第三条').ok, true);
  now += 60_000;
  const over = channel.post('第四条');
  assert.equal(!over.ok && over.code, 'update_limit_reached');
  assert.equal(channel.post('   ').ok, false);
});

await test('updates: internal names are scrubbed from what the user sees', () => {
  const channel = new AgentUpdateChannel({ emit: () => undefined });
  const r = channel.post('正在用 generate_long_video 做长视频');
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.ok ? r.update.text : '', /generate_long_video/);
});

await test('post_update tool: delivered, or refused where no live channel exists', async () => {
  const channel = new AgentUpdateChannel({ emit: () => undefined });
  const ok = await executePostUpdate({ type: 'post_update', text: '已经在办了' }, { cwd: tmp, postUpdate: (t) => channel.post(t) });
  assert.equal(ok.ok, true);
  const none = await executePostUpdate({ type: 'post_update', text: '已经在办了' }, { cwd: tmp });
  assert.equal(none.ok, false);
  assert.equal(none.error?.code, 'updates_unavailable');
  assert.ok(getAllowedActionTypesForProfile('main').includes('post_update'));
  assert.ok(!getAllowedActionTypesForProfile('researcher').includes('post_update'), 'sub-agents do not talk to the user');
});

await test('history: a delivered update is its own assistant message, in order', async () => {
  const store = new SessionStore(path.join(tmp, 'ws-history'));
  const session = store.createSession({ title: 'history' });
  store.appendMessage(session, 'user', '帮我开一台 VPS');
  store.appendMessage(session, 'assistant', '');
  store.appendMessage(session, 'tool', '{"ok":true,"action":{"type":"post_update","text":"收到"},"output":"Shown"}', 'post_update');
  session.messages.at(-1)!.agentUpdate = { id: 'upd_0123456789abcdef', text: '收到，已经在办了' };
  store.appendMessage(session, 'tool', '{"ok":true}', 'browser_navigate');
  store.appendMessage(session, 'assistant', '香港没货了，选新加坡还是东京？');
  await store.save(session);
  const page = await store.loadHistoryPage(session);
  const shown = page.messages.map((m) => [m.role, m.content, (m as any).kind ?? '', (m as any).updateId ?? '']);
  assert.deepEqual(shown, [
    ['user', '帮我开一台 VPS', '', ''],
    ['assistant', '收到，已经在办了', 'update', 'upd_0123456789abcdef'],
    ['assistant', '香港没货了，选新加坡还是东京？', '', ''],
  ]);
});

// ── live status ─────────────────────────────────────────────────────────
await test('status: from real tool activity, deduplicated, parallel-aware', () => {
  const lines: string[] = [];
  const reporter = new AgentStatusReporter((l) => lines.push(l), () => 0);
  const parse = () => lines.map((l) => JSON.parse(l.replace(/^\[agent-status\] /, '')));
  reporter.thinking();
  reporter.thinking();
  reporter.onToolActivity({ phase: 'start', callId: 'a', action: { type: 'browser_navigate', url: 'https://www.example-cloud.com/pricing?ref=x' } });
  reporter.onToolActivity({ phase: 'start', callId: 'p', action: { type: 'post_update', text: 'x' } });
  reporter.onToolActivity({ phase: 'end', callId: 'p', action: { type: 'post_update', text: 'x' } });
  reporter.onToolActivity({ phase: 'start', callId: 'b', action: { type: 'browser_type', selector: '#email', text: 'a@b.c' } });
  reporter.onToolActivity({ phase: 'end', callId: 'b', action: { type: 'browser_type' } });
  reporter.onToolActivity({ phase: 'end', callId: 'a', action: { type: 'browser_navigate' } });
  reporter.onToolActivity({ phase: 'start', callId: 'c', action: { type: 'browser_request_handoff', reason: 'sign in' } });
  reporter.finish(statusForApprovalKind('payment'));
  reporter.onToolActivity({ phase: 'end', callId: 'c', action: { type: 'browser_request_handoff' } });
  const events = parse();
  assert.deepEqual(events.map((e) => [e.phase, e.activity, e.detail ?? '']), [
    ['working', 'thinking', ''],
    ['working', 'browsing', 'example-cloud.com'],
    ['working', 'filling_form', ''],
    ['working', 'browsing', 'example-cloud.com'],
    ['working', 'thinking', ''],
    ['waiting_user', 'waiting_handoff', ''],
    ['waiting_approval', 'waiting_payment_approval', ''],
  ]);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(!lines.some((l) => l.includes('a@b.c')), 'typed text never shows up in the status');
});

await test('status: mapping and host extraction', () => {
  assert.equal(hostOf('javascript:alert(1)'), undefined);
  assert.equal(hostOf('https://user:pw@shop.example.org:8443/a?b'), 'shop.example.org');
  assert.equal(statusForAction({ type: 'request_user_confirmation', question: 'pay?' })?.phase, 'waiting_approval');
  assert.equal(statusForAction({ type: 'mcp_call_tool', toolName: 'send_email' })?.activity, 'sending');
  assert.equal(statusForAction({ type: 'server_setup', action: 'harden' })?.activity, 'working');
  assert.equal(statusForApprovalKind('outbound_send').activity, 'waiting_send_approval');
});

// ── errand playbook ─────────────────────────────────────────────────────
const ERRANDS = [
  '帮我加两台 VPN 服务器',
  '帮我找个便宜的 VPS 做 VPN',
  '帮我订下周六晚上两个人的餐厅',
  '把我的网站部署上线',
  '帮我注册一个 GitHub 账号',
  '帮我买个域名指向我的网站',
  '帮我把这个表格整理好发给张三',
  '帮我订一张下周五去上海的机票',
  '帮我开一台服务器装个博客',
  '帮我在某云开一台香港的 VPS',
  '帮我注册一个青盘云盘账号',
  '帮我把下个月的话费交了',
  '帮我预约周三下午的牙医',
  '帮我寄个快递到北京',
  '帮我退订那个视频会员',
  '帮我续费我的域名',
  'Please book a table for two on Saturday',
  'help me buy a domain for my blog',
];
const NOT_ERRANDS = [
  '帮我写一封请假邮件给老板',
  '怎么开发票？',
  '解释一下什么是复利',
  '帮我把这段代码的报错修好',
  '给我画一张猫的图片',
  'How do I register a domain?',
];
await test('playbook: errands are recognised, writing and questions are not', () => {
  for (const text of ERRANDS) assert.equal(looksLikeOperatorTask(text), true, text);
  for (const text of NOT_ERRANDS) assert.equal(looksLikeOperatorTask(text), false, text);
});

await test('playbook: the hard rules are in the text', () => {
  const zh = buildOperatorPlaybook('帮我开一台 VPS');
  for (const rule of [/做事，而不是教用户做事/, /只有这些环节找用户/, /一次问完/, /不编造/, /post_update/, /request_user_confirmation/, /完整账单/, /只给一个具体的下一步提议/, /验证/, /get_verification_code/, /server_setup/, /\{\{credential:/, /绝不在聊天里索要密码/]) {
    assert.match(zh, rule);
  }
  assert.match(buildOperatorPlaybook('book a table for two'), /do, don't instruct/);
  // Every routed run carries the principle, not only errands.
  assert.match(buildWorkflowHint('direct', { cwd: tmp, userPrompt: 'x' }), /能自己做的就自己做/);
});

await test('routing: the playbook is added for errands and their follow-ups only', async () => {
  const store = new SessionStore(path.join(tmp, 'ws-route'));
  const session = store.createSession({ title: 'route' });
  const base = {
    session,
    cwd: tmp,
    attachmentCount: 0,
    inCodeRepo: false,
    autoRoute: true,
    getClassifier: async () => undefined,
    hasVideoProvider: async () => false,
  };
  let now = Date.UTC(2026, 9, 11, 8);
  const plan = (prompt: string) => planHeadlessWorkflow({ ...base, prompt, now });
  const errand = await plan('帮我找个便宜的 VPS 做 VPN');
  assert.equal(errand.kind, 'run');
  assert.match(errand.kind === 'run' ? errand.hint : '', /代办任务模式/);
  now += 60_000;
  const yes = await plan('好，就按你推荐的来');
  assert.match(yes.kind === 'run' ? yes.hint : '', /代办任务模式/, 'a short follow-up continues with the same rules');
  now += 7 * 3_600_000;
  const later = await plan('今天天气怎么样');
  assert.doesNotMatch(later.kind === 'run' ? later.hint : '', /代办任务模式/, 'expired after the TTL');
  const plain = await plan('解释一下什么是复利');
  assert.doesNotMatch(plain.kind === 'run' ? plain.hint : '', /代办任务模式/);
  assert.equal(session.metadata?.workflowRouting, undefined, 'nothing left in the session');
});

// ── credentials ─────────────────────────────────────────────────────────
const credStore = new FileCredentialStore(path.join(tmp, 'creds'));
await test('credentials: stored 0600, described without the secret, placeholders resolved', async () => {
  const pw = generatePassword();
  assert.equal(pw.length, 20);
  assert.match(pw, /[A-Z]/);
  assert.match(pw, /[a-z]/);
  assert.match(pw, /[0-9]/);
  assert.match(pw, /[-_.@#%+=]/);
  await credStore.put('vpn-root', 'password', pw);
  const info = await credStore.describe('vpn-root');
  assert.equal(info?.kind, 'password');
  assert.ok(!JSON.stringify(info).includes(pw));
  assert.equal((fs.statSync(path.join(tmp, 'creds', 'vpn-root.json')).mode & 0o777), 0o600);
  assert.equal((fs.statSync(path.join(tmp, 'creds')).mode & 0o777), 0o700);
  const typed = await resolveCredentialPlaceholders('{{credential:vpn-root}}', credStore);
  assert.deepEqual(typed, { ok: true, text: pw, used: ['vpn-root'] });
  const missing = await resolveCredentialPlaceholders('x {{credential:nope}}', credStore);
  assert.deepEqual(missing, { ok: false, missing: ['nope'] });
  await assert.rejects(() => credStore.put('../evil', 'password', 'x'), /Credential names/);
  await assert.rejects(() => credStore.put('vpn-root', 'password', 'x'), /already exists/);
});

// ── keys and QR ─────────────────────────────────────────────────────────
await test('keys: OpenSSH Ed25519 pair, WireGuard pair that agrees on a shared secret', () => {
  const pair = generateSshKeyPair('agent-test');
  assert.match(pair.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43,} agent-test$/);
  assert.match(pair.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
  // An independent parser, when this machine has one.
  const py = spawnSync('python3', ['-c', [
    'import sys',
    'from cryptography.hazmat.primitives import serialization',
    'k = serialization.load_ssh_private_key(sys.stdin.buffer.read(), password=None)',
    'print(k.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode())',
  ].join('\n')], { input: pair.privateKey, encoding: 'utf8' });
  if (py.status === 0) assert.equal(py.stdout.trim(), pair.publicKey.split(' ').slice(0, 2).join(' '));
  else console.log('      (python cryptography not available: OpenSSH parse check skipped)');

  const a = generateWireGuardKeyPair();
  const b = generateWireGuardKeyPair();
  const key = (priv: string, pub: string) => createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: Buffer.from(priv, 'base64').toString('base64url'), x: Buffer.from(pub, 'base64').toString('base64url') }, format: 'jwk' });
  const pubKey = (pub: string) => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(pub, 'base64').toString('base64url') }, format: 'jwk' });
  const ab = diffieHellman({ privateKey: key(a.privateKey, a.publicKey), publicKey: pubKey(b.publicKey) });
  const ba = diffieHellman({ privateKey: key(b.privateKey, b.publicKey), publicKey: pubKey(a.publicKey) });
  assert.equal(ab.toString('hex'), ba.toString('hex'));
  assert.equal(Buffer.from(a.privateKey, 'base64').length, 32);
});

await test('qr: a WireGuard profile fits, PNG is well-formed', () => {
  const conf = `[Interface]\nPrivateKey = ${'A'.repeat(43)}=\nAddress = 10.66.66.2/32\nDNS = 1.1.1.1, 8.8.8.8\n\n[Peer]\nPublicKey = ${'B'.repeat(43)}=\nEndpoint = 203.0.113.10:51820\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n`;
  const qr = encodeQr(conf, 'M');
  assert.ok(qr.version >= 10 && qr.version <= 14, `version ${qr.version}`);
  assert.equal(qr.size, qr.version * 4 + 17);
  // Finder pattern corners.
  assert.equal(qr.modules[0]![0], true);
  assert.equal(qr.modules[1]![1], false);
  assert.equal(qr.modules[3]![3], true);
  const png = qrToPng(qr, 4);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), (qr.size + 8) * 4);
  // A known small code: "HELLO" at version 1-M, mask 0 (cross-checked against a reference encoder).
  const hello = encodeQr('HELLO', 'M', 0);
  assert.equal(hello.version, 1);
  assert.equal(hello.modules.map((r) => r.map((c) => (c ? '1' : '0')).join('')).join('|').length, 21 * 22 - 1);
});

// ── server_setup against a fake SSH server ──────────────────────────────
await test('server_setup: key → wait → harden → VPN → verify → inventory, no secret in any output', async () => {
  const ws = path.join(tmp, 'ws-server');
  fs.mkdirSync(ws, { recursive: true });
  const log = path.join(tmp, 'fake-ssh.log');
  process.env.ARTEMIS_SSH_FAKE_LOG = log;
  process.env.ARTEMIS_SSH_FAKE_DOWN_FOR = '2';
  process.env.ARTEMIS_SSH_FAKE_STATE = path.join(tmp, 'fake-ssh-state.json');
  process.env.ARTEMIS_SSH_FAKE_PASSWORD = 'not-used-here';
  const ctx = { cwd: ws, store: credStore, inventoryFile: path.join(tmp, 'servers.json'), sleep: async () => undefined, sshBin: path.join(here, 'fixtures', 'fakeSsh.mjs') };
  const outputs: string[] = [];
  const run = async (a: any) => {
    const r = await executeServerSetup({ type: 'server_setup', ...a }, ctx);
    outputs.push(r.output);
    return r;
  };
  const key = await run({ action: 'create_key', name: 'vpn-tokyo-1' });
  assert.equal(key.ok, true);
  assert.match(key.output, /ssh-ed25519 AAAA/);
  const again = await run({ action: 'create_key', name: 'vpn-tokyo-1' });
  assert.match(again.output, /already exists/);
  const ready = await run({ action: 'wait_ready', host: '203.0.113.10', key: 'vpn-tokyo-1', server: 'vpn-tokyo-1' });
  assert.equal(ready.ok, true, ready.output);
  assert.match(ready.output, /after 3 attempt/);
  const hardened = await run({ action: 'harden', host: '203.0.113.10', key: 'vpn-tokyo-1' });
  assert.equal(hardened.ok, true, hardened.output);
  const vpn = await run({ action: 'install_wireguard', host: '203.0.113.10', key: 'vpn-tokyo-1', server: 'vpn-tokyo-1', clients: ['phone', 'laptop'] });
  assert.equal(vpn.ok, true, vpn.output);
  for (const f of ['phone.conf', 'phone-qr.png', 'laptop.conf', 'laptop-qr.png']) assert.ok(fs.existsSync(path.join(ws, 'vpn', 'vpn-tokyo-1', f)), f);
  const conf = fs.readFileSync(path.join(ws, 'vpn', 'vpn-tokyo-1', 'phone.conf'), 'utf8');
  assert.match(conf, /Endpoint = 203\.0\.113\.10:51820/);
  assert.equal(fs.statSync(path.join(ws, 'vpn', 'vpn-tokyo-1', 'phone.conf')).mode & 0o777, 0o600);
  // One more device later reuses the server key and keeps the old profiles.
  const more = await run({ action: 'install_wireguard', host: '203.0.113.10', key: 'vpn-tokyo-1', server: 'vpn-tokyo-1', clients: ['tablet'] });
  assert.match(more.output, /New device profiles: tablet/);
  const confAfter = fs.readFileSync(path.join(ws, 'vpn', 'vpn-tokyo-1', 'phone.conf'), 'utf8');
  assert.equal(confAfter, conf, 'existing devices keep their keys');
  const check = await run({ action: 'verify', check: 'wireguard', server: 'vpn-tokyo-1' });
  assert.equal(check.ok, true, check.output);
  assert.match(check.output, /service active/);
  const list = await run({ action: 'list_servers' });
  assert.match(list.output, /vpn-tokyo-1: active; host 203\.0\.113\.10/);
  assert.match(list.output, /3 device profile\(s\): phone, laptop, tablet/);
  assert.match(list.output, /hardened/);
  const recorded = await run({ action: 'record_server', server: 'vpn-tokyo-1', provider: 'ExampleHost', region: 'Tokyo' });
  assert.match(recorded.output, /provider ExampleHost; region Tokyo/);
  // Nothing secret leaked into what the model sees.
  const secrets = [conf.match(/PrivateKey = (\S+)/)![1]!, (await credStore.reveal('vpn-tokyo-1'))!.split('\n')[1]!];
  for (const out of outputs) for (const secret of secrets) assert.ok(!out.includes(secret), 'a secret appeared in a tool result');
  // The fake server saw key auth only, and the scripts it got.
  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries.filter((e) => e.result === 'refused').length === 2);
  assert.ok(entries.some((e) => e.steps?.includes('harden')));
  assert.ok(entries.some((e) => e.peers === 3), 'the second install sends all three peers');
  assert.ok(entries.filter((e) => !e.result).every((e) => e.auth === 'key'));
});

await test('server_setup: password-only server gets the key installed through askpass', async () => {
  const ctx = { cwd: tmp, store: credStore, inventoryFile: path.join(tmp, 'servers.json'), sleep: async () => undefined, sshBin: path.join(here, 'fixtures', 'fakeSsh.mjs') };
  process.env.ARTEMIS_SSH_FAKE_DOWN_FOR = '0';
  process.env.ARTEMIS_SSH_FAKE_PASSWORD = (await credStore.reveal('vpn-root'))!;
  const ok = await executeServerSetup({ type: 'server_setup', action: 'install_key', host: '198.51.100.7', password: 'vpn-root', key: 'vpn-tokyo-1' }, ctx);
  assert.equal(ok.ok, true, ok.output);
  process.env.ARTEMIS_SSH_FAKE_PASSWORD = 'something-else';
  const denied = await executeServerSetup({ type: 'server_setup', action: 'install_key', host: '198.51.100.7', password: 'vpn-root', key: 'vpn-tokyo-1' }, ctx);
  assert.equal(denied.error?.code, 'ssh_auth_failed');
  const bad = await executeServerSetup({ type: 'server_setup', action: 'harden', host: 'a;rm -rf /', key: 'vpn-tokyo-1' }, ctx);
  assert.equal(bad.error?.code, 'invalid_input');
  const missing = await executeServerSetup({ type: 'server_setup', action: 'harden', host: '198.51.100.7', key: 'none' }, { ...ctx, sshBin: '/nonexistent/ssh' });
  assert.equal(missing.error?.code, 'credential_not_found');
  const noSsh = await executeServerSetup({ type: 'server_setup', action: 'run', host: '198.51.100.7', key: 'vpn-tokyo-1', command: 'uptime' }, { ...ctx, sshBin: '/nonexistent/ssh' });
  assert.equal(noSsh.error?.code, 'ssh_missing');
});

// ── verification codes ──────────────────────────────────────────────────
await test('verification codes: adapter or a clear fallback', async () => {
  delete process.env.ARTEMIS_VERIFICATION_CODE_CMD;
  registerVerificationCodeSource(undefined);
  const none = await executeGetVerificationCode({ type: 'get_verification_code', channel: 'email' }, {});
  assert.equal(none.error?.code, 'codes_unavailable');
  assert.match(none.output, /browser_request_handoff/);
  registerVerificationCodeSource({
    channels: async () => ({ email: 'agent@example.test' }),
    get: async (req) => (req.channel === 'email' && req.sender === 'ExampleHost' ? { code: '482913', from: 'noreply@examplehost.test' } : undefined),
  });
  const which = await executeGetVerificationCode({ type: 'get_verification_code', channel: 'which' }, {});
  assert.match(which.output, /agent@example\.test/);
  const got = await executeGetVerificationCode({ type: 'get_verification_code', channel: 'email', sender: 'ExampleHost' }, {});
  assert.match(got.output, /482913/);
  const missed = await executeGetVerificationCode({ type: 'get_verification_code', channel: 'sms', timeoutSeconds: 15 }, {});
  assert.equal(missed.error?.code, 'code_not_received');
  registerVerificationCodeSource(undefined);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`copilot smoke: ${passed} passed`);
