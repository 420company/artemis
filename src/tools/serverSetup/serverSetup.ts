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
 *   install_wireguard  WireGuard server + client profiles (.conf) and QR codes (.png) under <ARTEMIS_HOME>/vpn-profiles/<server>/ (private; the reply gets vpn cards)
 *   verify             proves it works: SSH, the VPN service (and a real tunnel when this machine can), or a URL
 *   run                one command on the server
 *   list_servers / record_server   the inventory, so "再加一台" / "把东京那台关了" can follow
 *
 * SSH: on a hosted server the credential service runs it (the store's
 * `ssh`), as the server's OS user, so a key or root password never reaches
 * this process or the agent's user; only the output comes back. Without one
 * (the CLI) this process fetches the secret from its local store and runs
 * the system `ssh` (ARTEMIS_SSH_BIN overrides it, e.g. a test double). Tool
 * results carry only names, public keys, file paths and check results.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getCredentialStore, normalizeOrigin, useCredential, CREDENTIAL_NAME, type CredentialStore } from '../../security/credentialStore.js';
import { resolveArtemisHomeDir } from '../../utils/fs.js';
import { generateWireGuardKeyPair } from './keys.js';
import { encodeQr, qrToPng } from './qr.js';
import { hardenScript, installKeyScript, probeScript, removePeerScript, wireguardCheckScript, wireguardScript } from './scripts.js';

export type ServerSetupAction =
  | { type: 'server_setup'; action: 'create_key'; name: string; comment?: string; host?: string }
  | { type: 'server_setup'; action: 'forget_host_key'; host: string; port?: number }
  | { type: 'server_setup'; action: 'create_password'; name: string; length?: number; origin?: string; host?: string }
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
  /** The host's confirmation (the interactive CLI); see tools/ownerApproval.ts. */
  requestUserConfirmation?: (request: { question: string }) => Promise<boolean>;
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
  /** The server answered with another host key than the one recorded: maybe a reinstall, maybe someone in between. */
  hostKeyChanged?: boolean;
}

function knownHostsFile(): string {
  return path.join(resolveArtemisHomeDir(), 'agent-ssh', 'known_hosts');
}

/** Where device profiles go: the agent's own home, never the workspace (they hold private keys). */
export function vpnProfilesDir(): string {
  return path.join(resolveArtemisHomeDir(), 'vpn-profiles');
}

function sshRunOf(code: number | null, stdout: string, stderr: string, timedOut: boolean): SshRun {
  const steps = new Set([...stdout.matchAll(/^ARTEMIS_STEP (\w+) ok$/gm)].map((m) => m[1]!));
  const hostKeyChanged = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for .* has changed/i.test(stderr);
  return { code, stdout, stderr, steps, timedOut, hostKeyChanged };
}

/** The ssh client here, with a secret this process holds (the local store only). */
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
      resolve(sshRunOf(code, stdout, stderr, timedOut));
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

/**
 * How a session logs in: the name of a stored SSH key, or of a stored server
 * password with the key it installs (a password only bootstraps the key).
 */
type SshAuth = { key: string } | { password: string; installKey: string };

/** One session with a script; a credential problem comes back as the tool's failure. */
type Ssh = (script: string, timeoutMs: number) => Promise<SshRun | ServerSetupResult>;

function isFailure(run: SshRun | ServerSetupResult): run is ServerSetupResult {
  return 'ok' in run;
}

function credentialFailure(auth: SshAuth, code: string, message: string): ServerSetupResult {
  if (code === 'not_found') {
    return fail('credential_not_found', 'key' in auth ? `No SSH key named "${auth.key}". Make one with create_key first.` : `No password named "${auth.password}".`);
  }
  // A secret the owner holds the key to: the message carries the unlock card to show.
  if (code === 'locked') return fail('credential_locked', message);
  return fail('credential_refused', message);
}

/**
 * Sessions to one server with one stored credential, which must be bound to
 * this host (a password is bound at its first use, a key when made for it).
 * Hosted: the credential service runs ssh (as the server's user) and only
 * the output comes back. Local: the secret is fetched here, a key goes into a
 * private temporary file (0600 in a 0700 directory, removed right after).
 */
function sshWith(ctx: ServerSetupContext, store: CredentialStore, t: Target, auth: SshAuth): Ssh {
  const name = 'key' in auth ? auth.key : auth.password;
  const as = 'key' in auth ? 'key' : 'password';
  return async (script, timeoutMs) => {
    if (!CREDENTIAL_NAME.test(name)) return fail('invalid_input', 'key' in auth ? 'key must be the name of a key made with create_key' : 'password must be the name of a stored password');
    if (store.ssh) {
      const r = await store.ssh({ name, as, ...('installKey' in auth ? { installKey: auth.installKey } : {}), host: t.host, user: t.user, port: t.port, script, timeoutMs }, ctx.abortSignal);
      if (!r.ok) return r.code === 'unavailable' ? fail('ssh_unavailable', r.message, true) : credentialFailure(auth, r.code, r.message);
      return sshRunOf(r.code, r.stdout, r.stderr, r.timedOut);
    }
    const used = await useCredential(name, { type: 'ssh', host: t.host, as }, store);
    if (!used.ok) return credentialFailure(auth, used.code, used.message);
    if (as === 'password') return runSsh(ctx, t, { password: used.secret }, script, timeoutMs);
    const dir = await mkdtemp(path.join(tmpdir(), 'artemis-ssh-'));
    const file = path.join(dir, 'key');
    try {
      await chmod(dir, 0o700);
      await writeFile(file, used.secret.endsWith('\n') ? used.secret : `${used.secret}\n`, { mode: 0o600 });
      return await runSsh(ctx, t, { keyPath: file }, script, timeoutMs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function sshFailure(step: string, run: SshRun): ServerSetupResult {
  if (run.hostKeyChanged) {
    return fail(
      'host_key_changed',
      `${step}: the server answered with a different host key than before. That happens after a reinstall, but it can also mean someone is in between. Nothing was sent. Tell the owner; only after they confirm the server was reinstalled, run forget_host_key for this host (it asks the owner to approve) and try again.`,
    );
  }
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
        return { ok: true, output: `SSH key "${a.name}" already exists${existing.bindings.host ? ` (for ${existing.bindings.host})` : ''}.\nPublic key (paste this into the provider's SSH key field):\n${existing.publicPart}` };
      }
      if (existing) return fail('credential_exists', `A credential named "${a.name}" exists and is not an SSH key; pick another name.`);
      const host = a.host ? target({ host: a.host }) : undefined;
      if (typeof host === 'string') return fail('invalid_input', host);
      const info = await store.create(a.name, 'ssh_key', { comment: a.comment ?? `agent-${a.name}`, ...(host ? { bindings: { host: host.host } } : {}) });
      return {
        ok: true,
        output: `SSH key "${a.name}" created; the private key stays in the credential store. ${host ? `It works only for ${host.host}.` : 'It can log in to the servers of this order (one key for all of them is fine).'}\nPublic key (paste this into the provider's SSH key field):\n${info.publicPart ?? ''}`,
      };
    }
    case 'create_password': {
      if (!CREDENTIAL_NAME.test(a.name ?? '')) return fail('invalid_input', 'name: letters, digits, ".", "_" or "-"');
      const origin = a.origin ? normalizeOrigin(a.origin) : undefined;
      if (a.origin && !origin) return fail('invalid_input', 'origin: the web site the password is for, e.g. "https://www.example.com"');
      const host = a.host ? target({ host: a.host }) : undefined;
      if (typeof host === 'string') return fail('invalid_input', host);
      if (!origin && !host) return fail('invalid_input', 'Say where the password is for: origin (the site whose form takes it) and/or host (a server it logs in to).');
      const existing = await store.describe(a.name);
      if (existing) {
        return existing.kind === 'password'
          ? { ok: true, output: `A password named "${a.name}" already exists (for ${existing.bindings.origin ?? existing.bindings.host ?? 'its first use'}). Type {{credential:${a.name}}} into the password field there.` }
          : fail('credential_exists', `A credential named "${a.name}" exists and is not a password; pick another name.`);
      }
      const length = Math.max(16, Math.min(64, a.length ?? 20));
      await store.create(a.name, 'password', { length, bindings: { ...(origin ? { origin } : {}), ...(host ? { host: host.host } : {}) } });
      return {
        ok: true,
        output: `A strong ${length}-character password was stored as "${a.name}", bound to ${[origin, host?.host].filter(Boolean).join(' and ')}. Type exactly {{credential:${a.name}}} into the password field on that site (browser_type / browser_form_input): it is filled only into a password field there, and the real password never appears here. Never write it out for the user in chat.`,
      };
    }
    case 'forget_host_key':
      return forgetHostKey(a, ctx, store);
    case 'install_key': {
      const t = target(a);
      if (typeof t === 'string') return fail('invalid_input', t);
      if (!CREDENTIAL_NAME.test(a.password ?? '') || !CREDENTIAL_NAME.test(a.key ?? '')) return fail('invalid_input', 'password and key are credential names');
      const keyInfo = await store.describe(a.key);
      if (keyInfo?.kind !== 'ssh_key' || !keyInfo.publicPart) return fail('credential_not_found', `No SSH key named "${a.key}".`);
      // Only a password, and only for this server (bound at creation or here, at its first use).
      const run = await sshWith(ctx, store, t, { password: a.password, installKey: a.key })(installKeyScript(keyInfo.publicPart), 60_000);
      if (isFailure(run)) return run;
      if (!run.steps.has('install_key')) return sshFailure('Installing the key', run);
      return { ok: true, output: `Key "${a.key}" installed for ${t.user}@${t.host}. Use key "${a.key}" from now on.` };
    }
    case 'wait_ready': {
      const t = target(a);
      if (typeof t === 'string') return fail('invalid_input', t);
      const timeoutMs = Math.max(30, Math.min(1800, a.timeoutSeconds ?? 600)) * 1000;
      const deadline = Date.now() + timeoutMs;
      const ssh = sshWith(ctx, store, t, { key: a.key });
      let last: SshRun | undefined;
      let attempts = 0;
      while (Date.now() < deadline && !ctx.abortSignal?.aborted) {
        attempts++;
        const tried = await ssh(probeScript(), 30_000);
        if (isFailure(tried)) return tried;
        last = tried;
        if (last.steps.has('probe')) {
          const facts = tail(last.stdout);
          if (a.server) await updateServer(ctx, a.server, { host: t.host, user: t.user, port: t.port, key: a.key, status: 'active' });
          return { ok: true, output: `${t.host} is ready (SSH answered after ${attempts} attempt(s)).\n${facts}` };
        }
        // Not reachable yet is worth waiting for; a missing client or a changed host key is not.
        if (last.code === 127 || last.hostKeyChanged) break;
        await sleep(10_000);
      }
      return last ? sshFailure(`Waiting for ${t.host}`, last) : fail('ssh_timeout', `${t.host} did not answer in time.`, true);
    }
    case 'harden': {
      const t = target(a);
      if (typeof t === 'string') return fail('invalid_input', t);
      const extra = (a.extraPorts ?? []).filter((p) => /^\d{1,5}\/(tcp|udp)$/.test(p));
      const run = await sshWith(ctx, store, t, { key: a.key })(hardenScript({ sshPort: t.port, extraPorts: extra }), 15 * 60_000);
      if (isFailure(run)) return run;
      if (!run.steps.has('harden')) return sshFailure('Hardening', run);
      const servers = await readInventory(ctx);
      const known = Object.values(servers).find((s) => s.host === t.host);
      if (known) await updateServer(ctx, known.name, { hardened: true });
      return { ok: true, output: `Hardened ${t.host}: system updated, firewall on (open: ${[`${t.port}/tcp`, ...extra].join(', ')}), automatic security updates, password login off where a key is installed.\n${tail(run.stdout)}` };
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
      const run = await sshWith(ctx, store, t, { key: a.key })(`${a.command}\n`, timeoutMs);
      if (isFailure(run)) return run;
      const out = [tail(run.stdout), run.stderr.trim() ? `stderr: ${tail(run.stderr)}` : ''].filter(Boolean).join('\n');
      return run.code === 0 ? { ok: true, output: out || '(no output)' } : { ...sshFailure('The command', run), output: `exit ${run.code}\n${out}` };
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
  const kept = serverPublicKey ? await useCredential(serverKeyName, { type: 'internal', use: 'vpn' }, store) : undefined;
  let serverPrivate = kept?.ok ? kept.secret : undefined;
  if (!serverPrivate || !serverPublicKey) {
    const pair = generateWireGuardKeyPair();
    await store.create(serverKeyName, 'token', { secret: pair.privateKey, publicPart: pair.publicKey, meta: { server: a.server }, replace: true });
    serverPrivate = pair.privateKey;
    serverPublicKey = pair.publicKey;
  }
  const clients = [...(existing?.clients ?? [])];
  const used = new Set(clients.map((c) => Number(c.address.split('.')[3]?.split('/')[0])));
  // Hosted: the server keeps the profiles. Local: the agent's own home, never the
  // workspace: a profile holds the device's private key, so it must not end up
  // in 作品, a shared page or a site.
  const outDir = path.join(vpnProfilesDir(), a.server);
  if (!store.storeVpnProfile) {
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    await chmod(path.dirname(outDir), 0o700).catch(() => undefined);
    await chmod(outDir, 0o700).catch(() => undefined);
  }
  const created: string[] = [];
  for (const name of wanted) {
    if (clients.some((c) => c.name === name)) continue;
    let host = 2;
    while (used.has(host)) host++;
    if (host > 250) return fail('invalid_input', 'This server has no free VPN addresses left.');
    used.add(host);
    const pair = generateWireGuardKeyPair();
    const keyName = `${a.server}-wg-${name}`;
    await store.create(keyName, 'token', { secret: pair.privateKey, publicPart: pair.publicKey, meta: { server: a.server, device: name }, replace: true });
    clients.push({ name, address: `${subnet}.${host}/32`, publicKey: pair.publicKey, keyName, files: [] });
    created.push(name);
  }

  const run = await sshWith(ctx, store, t, { key: a.key })(wireguardScript({
    privateKey: serverPrivate!,
    listenPort,
    address: `${subnet}.1/24`,
    peers: clients.map((c) => ({ publicKey: c.publicKey, address: c.address })),
  }), 10 * 60_000);
  if (isFailure(run)) return run;
  if (!run.steps.has('wireguard')) return sshFailure('Setting up the VPN', run);

  // Device profiles and their QR codes, readable by the agent only (0600 in 0700 folders).
  const endpointHost = t.host.includes(':') ? `[${t.host}]` : t.host;
  for (const client of clients) {
    const key = await useCredential(client.keyName, { type: 'internal', use: 'vpn' }, store);
    if (!key.ok) continue;
    const conf = [
      '[Interface]',
      `PrivateKey = ${key.secret}`,
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
    client.files = [vpnCard(a.server, client.name)];
    // Hosted: the server keeps the profile (out of the agent user's reach); no file here.
    if (store.storeVpnProfile) {
      await store.storeVpnProfile(a.server, client.name, conf);
      continue;
    }
    const confFile = path.join(outDir, `${client.name}.conf`);
    const pngFile = path.join(outDir, `${client.name}-qr.png`);
    await writeFile(confFile, conf, { mode: 0o600 });
    await chmod(confFile, 0o600);
    await writeFile(pngFile, qrToPng(encodeQr(conf, 'M'), 8), { mode: 0o600 });
    await chmod(pngFile, 0o600);
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
  const cards = clients.map((c) => `${c.name}:\n${vpnCard(a.server, c.name)}`).join('\n');
  return {
    ok: true,
    output: [
      `VPN is running on ${t.host} (WireGuard, port ${listenPort}/udp). ${created.length ? `New device profiles: ${created.join(', ')}.` : 'No new devices; profiles refreshed.'}`,
      'The profiles hold private keys: they are kept privately and are never files in the workspace. To hand one to the user, put its card in your reply exactly as below (the app shows the QR code to scan and a download button; it is never shared or published):',
      cards,
      'Next: verify with check "wireguard" before telling the user it works.',
    ].join('\n'),
  };
}

/** The reply card the app turns into a QR code to scan and a download (never a file path). */
export function vpnCard(server: string, device: string): string {
  return '```vpn\n' + JSON.stringify({ server, device }) + '\n```';
}

/**
 * Forgets the recorded host key of a server, after the owner approved it: a
 * changed key may mean a reinstall, or someone in between.
 */
async function forgetHostKey(a: Extract<ServerSetupAction, { action: 'forget_host_key' }>, ctx: ServerSetupContext, store: CredentialStore): Promise<ServerSetupResult> {
  const t = target(a);
  if (typeof t === 'string') return fail('invalid_input', t);
  const { requireOwnerApproval } = await import('../ownerApproval.js');
  const approved = await requireOwnerApproval(ctx, {
    kind: 'confirmation',
    question: `服务器 ${t.host} 的身份指纹变了。只有在你确认这台服务器刚重装过的情况下，才忘掉旧指纹并重新信任它。要继续吗？`,
    payload: { action: 'forget_host_key', host: t.host, port: t.port },
  });
  if (!approved.ok) return fail('approval_required', approved.message);
  // Hosted: the trusted host keys are the server's (it runs the SSH), and it offers no way to change them from here.
  if (store.ssh) {
    return fail('not_supported', `The server that runs the SSH keeps the host keys. Tell the owner: the operator removes ${t.host} from that server's known hosts, then try again.`);
  }
  const file = knownHostsFile();
  const text = await readFile(file, 'utf8').catch(() => '');
  const marker = t.port === 22 ? t.host : `[${t.host}]:${t.port}`;
  const kept = text.split('\n').filter((line) => line && !line.split(' ')[0]!.split(',').includes(marker));
  await writeFile(file, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
  return { ok: true, output: `Forgot the old host key of ${t.host}. The next connection records the new one.` };
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
async function tunnelTest(ctx: ServerSetupContext, t: Target, ssh: Ssh, wg: NonNullable<ServerRecord['wireguard']>): Promise<string | undefined> {
  if (process.getuid?.() !== 0 || !(await commandExists('ip')) || !(await commandExists('wg')) || !(await commandExists('curl'))) return undefined;
  const pair = generateWireGuardKeyPair();
  const address = `${wg.subnet}.254/32`;
  const ns = `agentwg${randomBytes(3).toString('hex')}`;
  const added = await ssh(wireguardCheckScript({ listenPort: wg.listenPort, testPeer: { publicKey: pair.publicKey, address } }), 60_000);
  if (isFailure(added) || !added.steps.has('check')) return 'tunnel test skipped: could not add a test peer';
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
    await ssh(removePeerScript(pair.publicKey), 30_000);
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
  const ssh = sshWith(ctx, store, t, { key });
  if (a.check === 'ssh') {
    const run = await ssh(probeScript(), 30_000);
    if (isFailure(run)) return run;
    return run.steps.has('probe') ? { ok: true, output: `SSH works for ${t.user}@${t.host}.\n${tail(run.stdout)}` } : sshFailure('SSH check', run);
  }
  const wg = record?.wireguard;
  if (!wg) return fail('invalid_input', 'No VPN recorded for this server; run install_wireguard first.');
  const run = await ssh(wireguardCheckScript({ listenPort: wg.listenPort }), 60_000);
  if (isFailure(run)) return run;
  if (!run.steps.has('check')) return sshFailure('VPN check', run);
  const tunnel = await tunnelTest(ctx, t, ssh, wg);
  const verdict = tunnel?.startsWith('tunnel test failed') ? 'fail' : 'ok';
  const lines = [
    `VPN on ${t.host}: service active, listening on ${wg.listenPort}/udp.`,
    tail(run.stdout),
    tunnel ?? 'A tunnel from this machine was not possible here (needs root and WireGuard tools); the first phone connection will confirm it — ask the user to tell you if it does not connect.',
  ];
  return verdict === 'ok' ? { ok: true, output: lines.join('\n') } : fail('verify_failed', lines.join('\n'), true);
}
