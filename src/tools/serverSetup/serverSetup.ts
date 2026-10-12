/**
 * tools/serverSetup/serverSetup.ts — `server_setup`: what the agent needs to
 * set up a server it just rented for the user, end to end, without secrets
 * ever entering the conversation.
 *
 *   create_key         Ed25519 key pair in the credential store; returns the public key
 *   create_password    a strong password in the store; returns {{credential:<name>}} to type
 *   install_key        puts a stored key on a server that only has a root password
 *   wait_ready         polls until SSH answers (a new server takes minutes)
 *   harden             updates, firewall, automatic security updates, key-only SSH
 *   install_wireguard  WireGuard server + client profiles (.conf) and QR codes (.png) in the workspace
 *   verify             proves it works: SSH, the VPN service (and a real tunnel when this machine can), or a URL
 *   run                one command on the server
 *   list_servers / record_server   the inventory, so "再加一台" / "把东京那台关了" can follow
 *
 * SSH runs the system `ssh` (ARTEMIS_SSH_BIN overrides it, e.g. a test
 * double). Keys and passwords come from security/credentialStore.ts; tool
 * results carry only names, public keys, file paths and check results.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { generatePassword, getCredentialStore, CREDENTIAL_NAME, type CredentialStore } from '../../security/credentialStore.js';
import { resolveArtemisHomeDir } from '../../utils/fs.js';
import { generateSshKeyPair, generateWireGuardKeyPair } from './keys.js';
import { encodeQr, qrToPng } from './qr.js';
import { hardenScript, installKeyScript, probeScript, removePeerScript, wireguardCheckScript, wireguardScript } from './scripts.js';

export type ServerSetupAction =
  | { type: 'server_setup'; action: 'create_key'; name: string; comment?: string }
  | { type: 'server_setup'; action: 'create_password'; name: string; length?: number }
  | { type: 'server_setup'; action: 'install_key'; host: string; user?: string; port?: number; password: string; key: string }
  | { type: 'server_setup'; action: 'wait_ready'; host: string; user?: string; port?: number; key: string; timeoutSeconds?: number; server?: string }
  | { type: 'server_setup'; action: 'harden'; host: string; user?: string; port?: number; key: string; extraPorts?: string[] }
  | { type: 'server_setup'; action: 'install_wireguard'; host: string; user?: string; port?: number; key: string; server: string; clients?: string[] | number; listenPort?: number; dns?: string }
  | { type: 'server_setup'; action: 'verify'; check: 'ssh' | 'wireguard' | 'url'; host?: string; user?: string; port?: number; key?: string; server?: string; url?: string; expect?: string }
  | { type: 'server_setup'; action: 'run'; host: string; user?: string; port?: number; key: string; command: string; timeoutSeconds?: number }
  | { type: 'server_setup'; action: 'list_servers' }
  | { type: 'server_setup'; action: 'record_server'; server: string; host?: string; provider?: string; region?: string; offering?: string; purpose?: string; status?: 'active' | 'cancelled' | 'deleted'; notes?: string; key?: string; user?: string };

export interface ServerSetupResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string; retryable?: boolean };
}

export interface ServerSetupContext {
  cwd: string;
  abortSignal?: AbortSignal;
  /** Test seams. */
  store?: CredentialStore;
  inventoryFile?: string;
  sleep?: (ms: number) => Promise<void>;
  sshBin?: string;
}

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^\d{1,3}(?:\.\d{1,3}){3}$|^\[?[0-9A-Fa-f:]+\]?$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CLIENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const OUTPUT_TAIL = 2_000;

function fail(code: string, message: string, retryable = false): ServerSetupResult {
  return { ok: false, output: message, error: { code, message, retryable } };
}

// ── inventory ────────────────────────────────────────────────────────────

export interface ServerRecord {
  name: string;
  host?: string;
  user?: string;
  port?: number;
  key?: string;
  provider?: string;
  region?: string;
  offering?: string;
  purpose?: string;
  status: 'active' | 'cancelled' | 'deleted';
  notes?: string;
  hardened?: boolean;
  wireguard?: {
    listenPort: number;
    subnet: string;
    serverKey: string;
    serverPublicKey: string;
    clients: Array<{ name: string; address: string; publicKey: string; keyName: string; files: string[] }>;
  };
  createdAt: string;
  updatedAt: string;
}

function inventoryPath(ctx: ServerSetupContext): string {
  return ctx.inventoryFile ?? path.join(resolveArtemisHomeDir(), 'servers.json');
}

async function readInventory(ctx: ServerSetupContext): Promise<Record<string, ServerRecord>> {
  try {
    const parsed = JSON.parse(await readFile(inventoryPath(ctx), 'utf8')) as { servers?: Record<string, ServerRecord> };
    return parsed.servers ?? {};
  } catch {
    return {};
  }
}

async function writeInventory(ctx: ServerSetupContext, servers: Record<string, ServerRecord>): Promise<void> {
  const file = inventoryPath(ctx);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, servers }, null, 2), { mode: 0o600 });
  await rename(temp, file);
}

async function updateServer(ctx: ServerSetupContext, name: string, patch: Partial<ServerRecord>): Promise<ServerRecord> {
  const servers = await readInventory(ctx);
  const now = new Date().toISOString();
  const next: ServerRecord = { ...(servers[name] ?? { name, status: 'active', createdAt: now }), ...patch, name, updatedAt: now } as ServerRecord;
  servers[name] = next;
  await writeInventory(ctx, servers);
  return next;
}

/** Inventory without key names of other kinds: what the model may read. */
function describeServer(s: ServerRecord): string {
  const bits = [
    `${s.name}: ${s.status}`,
    s.host ? `host ${s.host}` : undefined,
    s.provider ? `provider ${s.provider}` : undefined,
    s.region ? `region ${s.region}` : undefined,
    s.offering ? `offering ${s.offering}` : undefined,
    s.purpose ? `purpose ${s.purpose}` : undefined,
    s.key ? `ssh key ${s.key} (user ${s.user ?? 'root'})` : undefined,
    s.hardened ? 'hardened' : undefined,
    s.wireguard ? `VPN port ${s.wireguard.listenPort}/udp, ${s.wireguard.clients.length} device profile(s): ${s.wireguard.clients.map((c) => c.name).join(', ')}` : undefined,
    s.notes ? `notes: ${s.notes}` : undefined,
  ].filter(Boolean);
  return bits.join('; ');
}

// ── ssh ──────────────────────────────────────────────────────────────────

interface Target {
  host: string;
  user: string;
  port: number;
}

function target(a: { host?: string; user?: string; port?: number }): Target | string {
  const host = (a.host ?? '').trim();
  if (!host || !HOST.test(host)) return 'host must be an IP address or a host name';
  const user = (a.user ?? 'root').trim();
  if (!USER.test(user)) return 'user must be a plain Unix user name';
  const port = a.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port must be 1-65535';
  return { host: host.replace(/^\[|\]$/g, ''), user, port };
}

interface SshRun {
  code: number | null;
  stdout: string;
  stderr: string;
  steps: Set<string>;
  timedOut: boolean;
}

function knownHostsFile(): string {
  return path.join(resolveArtemisHomeDir(), 'credentials', 'known_hosts');
}

async function runSsh(
  ctx: ServerSetupContext,
  t: Target,
  auth: { keyPath: string } | { password: string },
  script: string,
  timeoutMs: number,
): Promise<SshRun> {
  const bin = ctx.sshBin ?? process.env.ARTEMIS_SSH_BIN?.trim() ?? 'ssh';
  await mkdir(path.dirname(knownHostsFile()), { recursive: true, mode: 0o700 });
  const args = [
    '-p', String(t.port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${knownHostsFile()}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'LogLevel=ERROR',
  ];
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };
  // A test double (ARTEMIS_SSH_BIN) gets its own settings, nothing else.
  if (bin !== 'ssh') for (const [k, v] of Object.entries(process.env)) if (k.startsWith('ARTEMIS_SSH_FAKE_')) env[k] = v;
  let askpassDir: string | undefined;
  if ('keyPath' in auth) {
    args.push('-i', auth.keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes');
  } else {
    // Password login without a terminal: OpenSSH asks this helper, which
    // reads the password from its own environment (never the command line).
    askpassDir = await mkdtemp(path.join(tmpdir(), 'artemis-askpass-'));
    const helper = path.join(askpassDir, 'askpass.sh');
    await writeFile(helper, '#!/bin/sh\nprintf \'%s\\n\' "$ARTEMIS_ASKPASS_SECRET"\n', { mode: 0o700 });
    Object.assign(env, { SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0', ARTEMIS_ASKPASS_SECRET: auth.password });
    args.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1');
  }
  args.push(`${t.user}@${t.host}`, t.user === 'root' ? 'bash -s' : 'sudo -n bash -s');
  return new Promise<SshRun>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: false });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString('utf8')).slice(-200_000);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-50_000);
    });
    const done = (code: number | null) => {
      clearTimeout(timer);
      ctx.abortSignal?.removeEventListener('abort', onAbort);
      if (askpassDir) void rm(askpassDir, { recursive: true, force: true });
      const steps = new Set([...stdout.matchAll(/^ARTEMIS_STEP (\w+) ok$/gm)].map((m) => m[1]!));
      resolve({ code, stdout, stderr, steps, timedOut });
    };
    child.on('error', (err) => {
      stderr += String((err as NodeJS.ErrnoException).code === 'ENOENT' ? `ssh client not found (${bin}); install openssh-client` : err.message);
      done(127);
    });
    child.on('close', (code) => done(code));
    child.stdin.on('error', () => undefined);
    child.stdin.end(script);
  });
}

function tail(text: string): string {
  const clean = text.replace(/^ARTEMIS_STEP .*$/gm, '').trim();
  return clean.length > OUTPUT_TAIL ? `…${clean.slice(-OUTPUT_TAIL)}` : clean;
}

async function withKey<T>(store: CredentialStore, key: string, fn: (keyPath: string) => Promise<T>): Promise<T | ServerSetupResult> {
  if (!CREDENTIAL_NAME.test(key)) return fail('invalid_input', 'key must be the name of a key made with create_key');
  const info = await store.describe(key);
  if (!info || info.kind !== 'ssh_key') return fail('credential_not_found', `No SSH key named "${key}". Make one with create_key first.`);
  const file = await store.materialize(key);
  if (!file) return fail('credential_not_found', `No SSH key named "${key}".`);
  try {
    return await fn(file.path);
  } finally {
    await file.cleanup();
  }
}

function sshFailure(step: string, run: SshRun): ServerSetupResult {
  if (run.timedOut) return fail('ssh_timeout', `${step}: the server did not finish in time.\n${tail(run.stderr || run.stdout)}`, true);
  const why = tail(run.stderr) || tail(run.stdout) || `exit code ${run.code}`;
  const auth = /Permission denied|Authentication failed/i.test(run.stderr);
  const unreachable = /Connection refused|timed out|No route to host|Could not resolve|Connection closed/i.test(run.stderr);
  const code = run.code === 127 && /ssh client not found/.test(run.stderr) ? 'ssh_missing' : auth ? 'ssh_auth_failed' : unreachable ? 'ssh_unreachable' : 'remote_step_failed';
  return fail(code, `${step} failed: ${why}`, unreachable);
}

// ── actions ──────────────────────────────────────────────────────────────

export async function executeServerSetup(a: ServerSetupAction, ctx: ServerSetupContext): Promise<ServerSetupResult> {
  const store = ctx.store ?? getCredentialStore();
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  switch (a.action) {
    case 'create_key': {
      if (!CREDENTIAL_NAME.test(a.name ?? '')) return fail('invalid_input', 'name: letters, digits, ".", "_" or "-" (e.g. "vpn-tokyo-1")');
      const existing = await store.describe(a.name);
      if (existing?.kind === 'ssh_key' && existing.publicPart) {
        return { ok: true, output: `SSH key "${a.name}" already exists.\nPublic key (paste this into the provider's SSH key field):\n${existing.publicPart}` };
      }
      if (existing) return fail('credential_exists', `A credential named "${a.name}" exists and is not an SSH key; pick another name.`);
      const pair = generateSshKeyPair((a.comment ?? `agent-${a.name}`).replace(/[^\w.@-]/g, '').slice(0, 64) || 'agent');
      await store.put(a.name, 'ssh_key', pair.privateKey, { publicPart: pair.publicKey });
      return { ok: true, output: `SSH key "${a.name}" created; the private key stays in the credential store.\nPublic key (paste this into the provider's SSH key field):\n${pair.publicKey}` };
    }
    case 'create_password': {
      if (!CREDENTIAL_NAME.test(a.name ?? '')) return fail('invalid_input', 'name: letters, digits, ".", "_" or "-"');
      if (await store.describe(a.name)) return { ok: true, output: `A credential named "${a.name}" already exists. Type {{credential:${a.name}}} where the password goes.` };
      const length = Math.max(16, Math.min(64, a.length ?? 20));
      await store.put(a.name, 'password', generatePassword(length));
      return { ok: true, output: `A strong ${length}-character password was stored as "${a.name}". Type {{credential:${a.name}}} into the password field (browser_type / browser_form_input); the real password never appears here. Never write it out for the user in chat.` };
    }
    case 'install_key': {
      const t = target(a);
      if (typeof t === 'string') return fail('invalid_input', t);
      const password = await store.reveal(a.password);
      const keyInfo = await store.describe(a.key);
      if (password === undefined) return fail('credential_not_found', `No stored password named "${a.password}".`);
      if (!keyInfo?.publicPart) return fail('credential_not_found', `No SSH key named "${a.key}".`);
      const run = await runSsh(ctx, t, { password }, installKeyScript(keyInfo.publicPart), 60_000);
      if (!run.steps.has('install_key')) return sshFailure('Installing the key', run);
      return { ok: true, output: `Key "${a.key}" installed for ${t.user}@${t.host}. Use key "${a.key}" from now on.` };
    }
    case 'wait_ready': {
      const t = target(a);
      if (typeof t === 'string') return fail('invalid_input', t);
      const timeoutMs = Math.max(30, Math.min(1800, a.timeoutSeconds ?? 600)) * 1000;
      const deadline = Date.now() + timeoutMs;
      return withKey(store, a.key, async (keyPath) => {
        let last: SshRun | undefined;
        let attempts = 0;
        while (Date.now() < deadline && !ctx.abortSignal?.aborted) {
          attempts++;
          last = await runSsh(ctx, t, { keyPath }, probeScript(), 30_000);
          if (last.steps.has('probe')) {
            const facts = tail(last.stdout);
            if (a.server) await updateServer(ctx, a.server, { host: t.host, user: t.user, port: t.port, key: a.key, status: 'active' });
            return { ok: true, output: `${t.host} is ready (SSH answered after ${attempts} attempt(s)).\n${facts}` };
          }
          if (last.code === 127) break;
          await sleep(10_000);
        }
        return last ? sshFailure(`Waiting for ${t.host}`, last) : fail('ssh_timeout', `${t.host} did not answer in time.`, true);
      });
    }
    case 'harden': {
      const t = target(a);
      if (typeof t === 'string') return fail('invalid_input', t);
      const extra = (a.extraPorts ?? []).filter((p) => /^\d{1,5}\/(tcp|udp)$/.test(p));
      return withKey(store, a.key, async (keyPath) => {
        const run = await runSsh(ctx, t, { keyPath }, hardenScript({ sshPort: t.port, extraPorts: extra }), 15 * 60_000);
        if (!run.steps.has('harden')) return sshFailure('Hardening', run);
        const servers = await readInventory(ctx);
        const known = Object.values(servers).find((s) => s.host === t.host);
        if (known) await updateServer(ctx, known.name, { hardened: true });
        return { ok: true, output: `Hardened ${t.host}: system updated, firewall on (open: ${[`${t.port}/tcp`, ...extra].join(', ')}), automatic security updates, password login off where a key is installed.\n${tail(run.stdout)}` };
      });
    }
    case 'install_wireguard':
      return installWireGuard(a, ctx, store);
    case 'verify':
      return verify(a, ctx, store);
    case 'run': {
      const t = target(a);
      if (typeof t === 'string') return fail('invalid_input', t);
      if (!a.command?.trim()) return fail('invalid_input', 'command required');
      const timeoutMs = Math.max(5, Math.min(1800, a.timeoutSeconds ?? 300)) * 1000;
      return withKey(store, a.key, async (keyPath) => {
        const run = await runSsh(ctx, t, { keyPath }, `${a.command}\n`, timeoutMs);
        const out = [tail(run.stdout), run.stderr.trim() ? `stderr: ${tail(run.stderr)}` : ''].filter(Boolean).join('\n');
        return run.code === 0 ? { ok: true, output: out || '(no output)' } : { ...sshFailure('The command', run), output: `exit ${run.code}\n${out}` };
      });
    }
    case 'list_servers': {
      const servers = Object.values(await readInventory(ctx));
      return { ok: true, output: servers.length ? servers.map(describeServer).join('\n') : 'No servers recorded yet.' };
    }
    case 'record_server': {
      if (!SERVER_NAME.test(a.server ?? '')) return fail('invalid_input', 'server: a short name such as "vpn-tokyo-1"');
      const patch: Partial<ServerRecord> = {};
      for (const field of ['host', 'provider', 'region', 'offering', 'purpose', 'status', 'notes', 'key', 'user'] as const) {
        const value = a[field];
        if (typeof value === 'string' && value.trim()) (patch as Record<string, string>)[field] = value.trim().slice(0, 200);
      }
      const saved = await updateServer(ctx, a.server, patch);
      return { ok: true, output: `Recorded: ${describeServer(saved)}` };
    }
    default:
      return fail('invalid_input', 'unknown action');
  }
}

function clientNames(clients: string[] | number | undefined): string[] | string {
  if (clients === undefined) return ['phone'];
  if (typeof clients === 'number') {
    if (!Number.isInteger(clients) || clients < 1 || clients > 20) return 'clients: 1-20 devices';
    return clients === 1 ? ['phone'] : Array.from({ length: clients }, (_, i) => `device${i + 1}`);
  }
  const names = clients.map((c) => String(c).trim()).filter(Boolean);
  if (!names.length || names.length > 20 || names.some((n) => !CLIENT_NAME.test(n))) return 'clients: 1-20 device names (letters, digits, "-" or "_")';
  return [...new Set(names)];
}

async function installWireGuard(
  a: Extract<ServerSetupAction, { action: 'install_wireguard' }>,
  ctx: ServerSetupContext,
  store: CredentialStore,
): Promise<ServerSetupResult> {
  const t = target(a);
  if (typeof t === 'string') return fail('invalid_input', t);
  if (!SERVER_NAME.test(a.server ?? '')) return fail('invalid_input', 'server: a short name for this server, e.g. "vpn-tokyo-1"');
  const wanted = clientNames(a.clients);
  if (typeof wanted === 'string') return fail('invalid_input', wanted);
  const listenPort = a.listenPort ?? 51820;
  if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) return fail('invalid_input', 'listenPort: 1024-65535');
  const dns = (a.dns ?? '1.1.1.1, 8.8.8.8').replace(/[^0-9a-fA-F.:, ]/g, '');

  const servers = await readInventory(ctx);
  const existing = servers[a.server]?.wireguard;
  const subnet = existing?.subnet ?? '10.66.66';
  // The server key is kept so more devices can be added later.
  const serverKeyName = existing?.serverKey ?? `${a.server}-wg-server`;
  let serverPublicKey = existing?.serverPublicKey;
  let serverPrivate = await store.reveal(serverKeyName);
  if (!serverPrivate || !serverPublicKey) {
    const pair = generateWireGuardKeyPair();
    await store.remove(serverKeyName).catch(() => false);
    await store.put(serverKeyName, 'token', pair.privateKey, { publicPart: pair.publicKey, meta: { server: a.server } });
    serverPrivate = pair.privateKey;
    serverPublicKey = pair.publicKey;
  }
  const clients = [...(existing?.clients ?? [])];
  const used = new Set(clients.map((c) => Number(c.address.split('.')[3]?.split('/')[0])));
  const outDir = path.join(ctx.cwd, 'vpn', a.server);
  await mkdir(outDir, { recursive: true });
  const created: string[] = [];
  for (const name of wanted) {
    if (clients.some((c) => c.name === name)) continue;
    let host = 2;
    while (used.has(host)) host++;
    if (host > 250) return fail('invalid_input', 'This server has no free VPN addresses left.');
    used.add(host);
    const pair = generateWireGuardKeyPair();
    const keyName = `${a.server}-wg-${name}`;
    await store.remove(keyName).catch(() => false);
    await store.put(keyName, 'token', pair.privateKey, { publicPart: pair.publicKey, meta: { server: a.server, device: name } });
    clients.push({ name, address: `${subnet}.${host}/32`, publicKey: pair.publicKey, keyName, files: [] });
    created.push(name);
  }

  const run = await withKey(store, a.key, (keyPath) =>
    runSsh(ctx, t, { keyPath }, wireguardScript({
      privateKey: serverPrivate!,
      listenPort,
      address: `${subnet}.1/24`,
      peers: clients.map((c) => ({ publicKey: c.publicKey, address: c.address })),
    }), 10 * 60_000));
  if ('ok' in run) return run;
  if (!run.steps.has('wireguard')) return sshFailure('Setting up the VPN', run);

  // Client profiles and their QR codes (only new devices get files written; existing ones keep theirs).
  const endpointHost = t.host.includes(':') ? `[${t.host}]` : t.host;
  for (const client of clients) {
    const privateKey = await store.reveal(client.keyName);
    if (!privateKey) continue;
    const conf = [
      '[Interface]',
      `PrivateKey = ${privateKey}`,
      `Address = ${client.address}`,
      `DNS = ${dns}`,
      '',
      '[Peer]',
      `PublicKey = ${serverPublicKey}`,
      `Endpoint = ${endpointHost}:${listenPort}`,
      'AllowedIPs = 0.0.0.0/0, ::/0',
      'PersistentKeepalive = 25',
      '',
    ].join('\n');
    const confFile = path.join(outDir, `${client.name}.conf`);
    const pngFile = path.join(outDir, `${client.name}-qr.png`);
    await writeFile(confFile, conf, { mode: 0o600 });
    await chmod(confFile, 0o600);
    await writeFile(pngFile, qrToPng(encodeQr(conf, 'M'), 8));
    client.files = [path.relative(ctx.cwd, confFile), path.relative(ctx.cwd, pngFile)];
  }
  await updateServer(ctx, a.server, {
    host: t.host,
    user: t.user,
    port: t.port,
    key: a.key,
    status: 'active',
    purpose: servers[a.server]?.purpose ?? 'vpn',
    wireguard: { listenPort, subnet, serverKey: serverKeyName, serverPublicKey: serverPublicKey!, clients },
  });
  const listing = clients.map((c) => `- ${c.name}: ${c.files.join(' , ')}`).join('\n');
  return {
    ok: true,
    output: [
      `VPN is running on ${t.host} (WireGuard, port ${listenPort}/udp). ${created.length ? `New device profiles: ${created.join(', ')}.` : 'No new devices; profiles refreshed.'}`,
      'Profiles (give the user the QR code to scan in the WireGuard app; the .conf is for computers):',
      listing,
      'Next: verify with check "wireguard" before telling the user it works.',
    ].join('\n'),
  };
}

async function commandExists(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, name))) return true;
  }
  return false;
}

function runLocal(cmd: string, args: string[], input?: string, timeoutMs = 20_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 127, out });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

/**
 * A real tunnel from this machine: a temporary peer, a network namespace with
 * a WireGuard interface, and one HTTPS request through it. Needs root, `ip`
 * and `wg`; otherwise undefined (not possible here).
 */
async function tunnelTest(ctx: ServerSetupContext, t: Target, keyPath: string, wg: NonNullable<ServerRecord['wireguard']>): Promise<string | undefined> {
  if (process.getuid?.() !== 0 || !(await commandExists('ip')) || !(await commandExists('wg')) || !(await commandExists('curl'))) return undefined;
  const pair = generateWireGuardKeyPair();
  const address = `${wg.subnet}.254/32`;
  const ns = `agentwg${randomBytes(3).toString('hex')}`;
  const added = await runSsh(ctx, t, { keyPath }, wireguardCheckScript({ listenPort: wg.listenPort, testPeer: { publicKey: pair.publicKey, address } }), 60_000);
  if (!added.steps.has('check')) return 'tunnel test skipped: could not add a test peer';
  const dir = await mkdtemp(path.join(tmpdir(), 'artemis-wgtest-'));
  try {
    const keyFile = path.join(dir, 'key');
    await writeFile(keyFile, pair.privateKey, { mode: 0o600 });
    const host = t.host.includes(':') ? `[${t.host}]` : t.host;
    const steps: Array<[string, string[]]> = [
      ['ip', ['netns', 'add', ns]],
      ['ip', ['link', 'add', 'wgt0', 'type', 'wireguard']],
      ['ip', ['link', 'set', 'wgt0', 'netns', ns]],
      ['ip', ['netns', 'exec', ns, 'wg', 'set', 'wgt0', 'private-key', keyFile, 'peer', wg.serverPublicKey, 'endpoint', `${host}:${wg.listenPort}`, 'allowed-ips', '0.0.0.0/0']],
      ['ip', ['-n', ns, 'addr', 'add', address, 'dev', 'wgt0']],
      ['ip', ['-n', ns, 'link', 'set', 'lo', 'up']],
      ['ip', ['-n', ns, 'link', 'set', 'wgt0', 'up']],
      ['ip', ['-n', ns, 'route', 'add', 'default', 'dev', 'wgt0']],
    ];
    for (const [cmd, args] of steps) {
      const r = await runLocal(cmd, args);
      if (r.code !== 0) return `tunnel test skipped: ${cmd} ${args.slice(0, 3).join(' ')} failed`;
    }
    const probe = await runLocal('ip', ['netns', 'exec', ns, 'curl', '-s', '--max-time', '10', 'https://api.ipify.org']);
    const exitIp = probe.out.trim();
    return probe.code === 0 && exitIp ? `tunnel test: traffic leaves through ${exitIp}${exitIp === t.host ? ' (the server)' : ''}` : 'tunnel test failed: no traffic through the tunnel';
  } finally {
    await runLocal('ip', ['netns', 'del', ns]);
    await rm(dir, { recursive: true, force: true });
    await runSsh(ctx, t, { keyPath }, removePeerScript(pair.publicKey), 30_000);
  }
}

async function verify(a: Extract<ServerSetupAction, { action: 'verify' }>, ctx: ServerSetupContext, store: CredentialStore): Promise<ServerSetupResult> {
  if (a.check === 'url') {
    if (!a.url || !/^https?:\/\//i.test(a.url)) return fail('invalid_input', 'url: an http(s) address');
    try {
      const res = await fetch(a.url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      const body = await res.text();
      const found = a.expect ? body.includes(a.expect) : true;
      const ok = res.ok && found;
      return ok
        ? { ok: true, output: `${a.url} answers ${res.status}${a.expect ? ` and shows "${a.expect}"` : ''}.` }
        : fail('verify_failed', `${a.url} answered ${res.status}${a.expect && !found ? `, without "${a.expect}"` : ''}.`, true);
    } catch (err) {
      return fail('verify_failed', `${a.url} could not be loaded: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }
  const servers = await readInventory(ctx);
  const record = a.server ? servers[a.server] : Object.values(servers).find((s) => s.host === a.host);
  const t = target({ host: a.host ?? record?.host, user: a.user ?? record?.user, port: a.port ?? record?.port });
  if (typeof t === 'string') return fail('invalid_input', t);
  const key = a.key ?? record?.key;
  if (!key) return fail('invalid_input', 'key: the SSH key name for this server');
  return withKey(store, key, async (keyPath) => {
    if (a.check === 'ssh') {
      const run = await runSsh(ctx, t, { keyPath }, probeScript(), 30_000);
      return run.steps.has('probe') ? { ok: true, output: `SSH works for ${t.user}@${t.host}.\n${tail(run.stdout)}` } : sshFailure('SSH check', run);
    }
    const wg = record?.wireguard;
    if (!wg) return fail('invalid_input', 'No VPN recorded for this server; run install_wireguard first.');
    const run = await runSsh(ctx, t, { keyPath }, wireguardCheckScript({ listenPort: wg.listenPort }), 60_000);
    if (!run.steps.has('check')) return sshFailure('VPN check', run);
    const tunnel = await tunnelTest(ctx, t, keyPath, wg);
    const verdict = tunnel?.startsWith('tunnel test failed') ? 'fail' : 'ok';
    const lines = [
      `VPN on ${t.host}: service active, listening on ${wg.listenPort}/udp.`,
      tail(run.stdout),
      tunnel ?? 'A tunnel from this machine was not possible here (needs root and WireGuard tools); the first phone connection will confirm it — ask the user to tell you if it does not connect.',
    ];
    return verdict === 'ok' ? { ok: true, output: lines.join('\n') } : fail('verify_failed', lines.join('\n'), true);
  });
}
