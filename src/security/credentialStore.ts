/**
 * security/credentialStore.ts — secrets the agent creates while working for
 * the user (a password for a sign-up form, an SSH key for a new server, a
 * VPN key), kept out of the conversation and bound to where they may be used.
 *
 * What the model sees: a credential's name, its kind, where it is bound and
 * its public part (an SSH public key). Never the secret.
 *
 * Use is narrow and bound:
 *   - `password` / `username`: typed into a web form only on the origin the
 *     credential is bound to (set when it is made, or at its first use), and
 *     only into a password field (a username field for `username`); for SSH,
 *     a `password` is used only as the login password of its bound host;
 *   - `ssh_key`: only for SSH logins, never typed or shown; tied to one
 *     host when made with one, otherwise usable for the several servers of
 *     one order (a key login reveals nothing secret to the server, unlike a
 *     password, which is why passwords are always bound);
 *   - `token` (VPN keys): only by the engine's own server setup.
 * Every secret handed out is remembered for the run and scrubbed from every
 * tool result (`scrubSecrets`), so a page that echoes it back, a console
 * message or a script reading the field never brings it into the history.
 *
 * Backends:
 *   - hosted (`ARTEMIS_CREDENTIAL_BROKER`, set by the web server for each
 *     run): the secrets live in the server's own data directory, which the
 *     agent's OS user cannot read; each use is checked there against the
 *     binding, for this run only (`BrokerCredentialStore`). The run's ticket
 *     comes from a one-time claim code (captureCredentialBroker), so it lives
 *     in this process's memory only, not in any environment;
 *   - local (the CLI): files under `<ARTEMIS_HOME>/agent-credentials` (0700
 *     directory, 0600 files), a protected path for the agent's file and
 *     shell tools.
 * A host can register its own backend (registerCredentialStore), e.g. a
 * vault that fills forms itself (origin-bound fill without handing the
 * secret to the engine at all).
 */

import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveArtemisHomeDir } from '../utils/fs.js';
import { inheritedMcpHeaders } from '../mcp/inheritedHeaders.js';

export type CredentialKind = 'password' | 'username' | 'ssh_key' | 'token';
export const CREDENTIAL_KINDS: readonly CredentialKind[] = ['password', 'username', 'ssh_key', 'token'];

/** Where a credential may be used: a web origin (https://shop.example) and/or an SSH host. */
export interface CredentialBindings {
  origin?: string;
  host?: string;
}

/** What may be shown: never the secret. */
export interface CredentialInfo {
  name: string;
  kind: CredentialKind;
  createdAt: string;
  bindings: CredentialBindings;
  /** An SSH public key, a VPN public key. */
  publicPart?: string;
  /** Short non-secret notes. */
  meta?: Record<string, string>;
}

export type CredentialPurpose =
  | { type: 'web'; origin: string; field: 'password' | 'username' }
  | { type: 'ssh'; host: string; as: 'key' | 'password' }
  | { type: 'internal'; use: 'vpn' };

export type CredentialErrorCode = 'invalid_name' | 'not_found' | 'exists' | 'wrong_kind' | 'wrong_origin' | 'wrong_host' | 'unavailable';

export type UseResult = { ok: true; secret: string; info: CredentialInfo } | { ok: false; code: CredentialErrorCode; message: string };

export interface CreateOptions {
  /** The secret itself (VPN keys made by the caller); omitted: the store makes one (passwords, SSH keys). */
  secret?: string;
  publicPart?: string;
  /** Password length (16–64, default 20). */
  length?: number;
  /** SSH key comment. */
  comment?: string;
  bindings?: CredentialBindings;
  meta?: Record<string, string>;
  /** Replace an existing credential of the same name (VPN keys refreshed by a re-run). */
  replace?: boolean;
}

export interface CredentialStore {
  /** Makes (or stores) a credential; returns what may be shown. Existing names fail with `exists` unless `replace`. */
  create(name: string, kind: CredentialKind, options?: CreateOptions): Promise<CredentialInfo>;
  describe(name: string): Promise<CredentialInfo | undefined>;
  list(): Promise<CredentialInfo[]>;
  /** The secret for this purpose, if the credential's kind and binding allow it (binding it on first use). */
  use(name: string, purpose: CredentialPurpose): Promise<UseResult>;
  remove(name: string): Promise<boolean>;
}

export const CREDENTIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A form value that is exactly one placeholder (nothing else may be typed with it). */
export const CREDENTIAL_PLACEHOLDER_ONLY = /^\{\{credential:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\}\}$/;
export const CREDENTIAL_PLACEHOLDER = /\{\{credential:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\}\}/;

export class CredentialError extends Error {
  constructor(readonly code: CredentialErrorCode, message: string) {
    super(message);
  }
}

function checkName(name: string): void {
  if (!CREDENTIAL_NAME.test(name)) throw new CredentialError('invalid_name', `Credential names use letters, digits, ".", "_" and "-" (at most 64): ${JSON.stringify(name)}`);
}

/** "https://Shop.Example:443/x" → "https://shop.example"; undefined unless http(s). */
export function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

export function normalizeHost(value: string | undefined): string | undefined {
  const host = value?.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host && /^[a-z0-9.:-]{1,253}$/.test(host) ? host : undefined;
}

/**
 * Whether `info` may serve `purpose`; `bind` is the binding to record on a
 * first use. Shared by every backend (the web server keeps its own copy of
 * these rules for the hosted store).
 */
export function checkUse(info: CredentialInfo, purpose: CredentialPurpose): { ok: true; bind?: CredentialBindings } | { ok: false; code: CredentialErrorCode; message: string } {
  if (purpose.type === 'internal') {
    return info.kind === 'token' ? { ok: true } : { ok: false, code: 'wrong_kind', message: `"${info.name}" is not a VPN key.` };
  }
  if (purpose.type === 'web') {
    const wanted: CredentialKind = purpose.field === 'username' ? 'username' : 'password';
    if (info.kind !== wanted) {
      return { ok: false, code: 'wrong_kind', message: `"${info.name}" is a ${info.kind}; only a ${wanted} can go into a ${purpose.field} field.` };
    }
    const origin = normalizeOrigin(purpose.origin);
    if (!origin) return { ok: false, code: 'wrong_origin', message: 'Credentials are only typed on http(s) pages.' };
    // A server password never goes into a web page, and the other way round.
    if (info.bindings.host && !info.bindings.origin) {
      return { ok: false, code: 'wrong_origin', message: `"${info.name}" is the password of server ${info.bindings.host}, not of a website. Nothing was typed.` };
    }
    if (info.bindings.origin && info.bindings.origin !== origin) {
      return { ok: false, code: 'wrong_origin', message: `"${info.name}" belongs to ${info.bindings.origin}, not ${origin}. Nothing was typed.` };
    }
    return info.bindings.origin ? { ok: true } : { ok: true, bind: { origin } };
  }
  const wanted: CredentialKind = purpose.as === 'key' ? 'ssh_key' : 'password';
  if (info.kind !== wanted) {
    return { ok: false, code: 'wrong_kind', message: `"${info.name}" is a ${info.kind}; SSH ${purpose.as === 'key' ? 'keys' : 'passwords'} only.` };
  }
  const host = normalizeHost(purpose.host);
  if (!host) return { ok: false, code: 'wrong_host', message: 'Invalid host.' };
  if (info.bindings.origin && !info.bindings.host) {
    return { ok: false, code: 'wrong_host', message: `"${info.name}" is the password of ${info.bindings.origin}, not of a server.` };
  }
  if (info.bindings.host && info.bindings.host !== host) {
    return { ok: false, code: 'wrong_host', message: `"${info.name}" belongs to ${info.bindings.host}, not ${host}.` };
  }
  if (info.kind === 'ssh_key') return { ok: true };
  return info.bindings.host ? { ok: true } : { ok: true, bind: { host } };
}

// ── secrets handed out this run, scrubbed from every tool result ──────────

const revealed = new Set<string>();

/** The ways a secret can come back out of a page or a request log, besides itself. */
export function secretEncodings(secret: string): string[] {
  const b64 = Buffer.from(secret, 'utf8').toString('base64');
  const html = secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return [
    secret,
    encodeURIComponent(secret),
    encodeURIComponent(secret).replace(/%20/g, '+'),
    JSON.stringify(secret).slice(1, -1),
    html,
    b64,
    b64.replace(/=+$/, ''),
    Buffer.from(secret, 'utf8').toString('base64url'),
    Buffer.from(secret, 'utf8').toString('hex'),
  ];
}

function remember(secret: string): void {
  for (const form of secretEncodings(secret)) if (form.length >= 6) revealed.add(form);
  // A multi-line secret (an SSH key) is also scrubbed line by line.
  for (const line of secret.split(/\r?\n/)) if (line.trim().length >= 16) revealed.add(line.trim());
}

/** The secrets handed out in this process (to mask them on a page before a screenshot of it). */
export function revealedSecrets(): string[] {
  return [...revealed];
}

/** Replaces every secret handed out in this process with •••• . */
export function scrubSecrets(text: string): string {
  if (!text || revealed.size === 0) return text;
  let out = text;
  for (const secret of [...revealed].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join('••••');
  }
  return out;
}

/** For tests. */
export function forgetRevealedSecrets(): void {
  revealed.clear();
}

/** The one way tools get a secret: checked, and remembered for scrubbing. */
export async function useCredential(name: string, purpose: CredentialPurpose, store: CredentialStore = getCredentialStore()): Promise<UseResult> {
  if (!CREDENTIAL_NAME.test(name)) return { ok: false, code: 'invalid_name', message: `Invalid credential name: ${JSON.stringify(name)}` };
  const resolver = [...resolvers].find(([prefix]) => name.startsWith(prefix))?.[1];
  if (resolver) {
    // Another module's secret (a sign-up password the host keeps): the same rules apply to it.
    const result = await resolver(name, purpose);
    if (!result.ok) return result;
    const verdict = checkUse(result.info, purpose);
    if (!verdict.ok) return verdict;
    remember(result.secret);
    return result;
  }
  const result = await store.use(name, purpose);
  if (result.ok) remember(result.secret);
  return result;
}

/**
 * Secrets another module keeps, by name prefix: e.g. the agent identity's
 * sign-up passwords (`{{credential:signup-…}}`), fetched from the host. They
 * go through the same path as the store's own: the binding in the returned
 * info is checked (origin, field kind), the secret is typed only where that
 * allows, and it is scrubbed from every tool result afterwards.
 */
export type CredentialResolver = (name: string, purpose: CredentialPurpose) => Promise<UseResult>;

const resolvers = new Map<string, CredentialResolver>();

export function registerCredentialResolver(prefix: string, resolver: CredentialResolver | undefined): void {
  if (resolver) resolvers.set(prefix, resolver);
  else resolvers.delete(prefix);
}

// ── generation ────────────────────────────────────────────────────────────

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_SYMBOLS = '-_.@#%+=';

/**
 * A strong password most sign-up forms accept: upper and lower case, digits
 * and a common symbol, no look-alike letters.
 */
export function generatePassword(length = 20): string {
  const chars: string[] = [];
  const pick = (set: string) => set[randomInt(set.length)]!;
  chars.push(pick('ABCDEFGHJKLMNPQRSTUVWXYZ'), pick('abcdefghijkmnopqrstuvwxyz'), pick('23456789'), pick(PASSWORD_SYMBOLS));
  while (chars.length < Math.max(12, length)) chars.push(pick(PASSWORD_ALPHABET));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

async function generated(kind: CredentialKind, options: CreateOptions): Promise<{ secret: string; publicPart?: string }> {
  if (options.secret !== undefined) return { secret: options.secret, ...(options.publicPart ? { publicPart: options.publicPart } : {}) };
  if (kind === 'password') return { secret: generatePassword(Math.max(16, Math.min(64, options.length ?? 20))) };
  if (kind === 'ssh_key') {
    const { generateSshKeyPair } = await import('../tools/serverSetup/keys.js');
    const pair = generateSshKeyPair((options.comment ?? 'agent').replace(/[^\w.@-]/g, '').slice(0, 64) || 'agent');
    return { secret: pair.privateKey, publicPart: pair.publicKey };
  }
  throw new CredentialError('unavailable', `A ${kind} must be given, not generated.`);
}

function cleanBindings(b: CredentialBindings | undefined): CredentialBindings {
  const origin = normalizeOrigin(b?.origin);
  const host = normalizeHost(b?.host);
  return { ...(origin ? { origin } : {}), ...(host ? { host } : {}) };
}

// ── local backend (the CLI) ───────────────────────────────────────────────

interface StoredFile {
  info: CredentialInfo;
  secret: string;
}

/** Where the local store keeps its files; a protected path for the agent's tools (utils/fs.ts). */
export function localCredentialsDir(): string {
  return process.env.ARTEMIS_CREDENTIALS_DIR?.trim() || path.join(resolveArtemisHomeDir(), 'agent-credentials');
}

export class FileCredentialStore implements CredentialStore {
  constructor(readonly dir: string = localCredentialsDir()) {}

  private ensure(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // another owner
    }
  }

  private file(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  private async read(name: string): Promise<StoredFile | undefined> {
    checkName(name);
    try {
      return JSON.parse(await readFile(this.file(name), 'utf8')) as StoredFile;
    } catch {
      return undefined;
    }
  }

  private async write(stored: StoredFile): Promise<void> {
    this.ensure();
    const temp = `${this.file(stored.info.name)}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(stored), { mode: 0o600 });
    await rename(temp, this.file(stored.info.name));
  }

  async create(name: string, kind: CredentialKind, options: CreateOptions = {}): Promise<CredentialInfo> {
    checkName(name);
    if (!CREDENTIAL_KINDS.includes(kind)) throw new CredentialError('wrong_kind', `Unknown kind ${kind}`);
    if (!options.replace && (await this.read(name))) throw new CredentialError('exists', `A credential named "${name}" already exists; pick another name.`);
    const made = await generated(kind, options);
    const info: CredentialInfo = {
      name,
      kind,
      createdAt: new Date().toISOString(),
      bindings: cleanBindings(options.bindings),
      ...(made.publicPart ? { publicPart: made.publicPart } : {}),
      ...(options.meta && Object.keys(options.meta).length ? { meta: options.meta } : {}),
    };
    await this.write({ info, secret: made.secret });
    return info;
  }

  async describe(name: string): Promise<CredentialInfo | undefined> {
    return (await this.read(name))?.info;
  }

  async list(): Promise<CredentialInfo[]> {
    if (!existsSync(this.dir)) return [];
    const out: CredentialInfo[] = [];
    for (const entry of (await readdir(this.dir)).sort()) {
      if (!entry.endsWith('.json')) continue;
      const name = entry.slice(0, -'.json'.length);
      if (!CREDENTIAL_NAME.test(name)) continue;
      const stored = await this.read(name);
      if (stored) out.push(stored.info);
    }
    return out;
  }

  async use(name: string, purpose: CredentialPurpose): Promise<UseResult> {
    const stored = await this.read(name);
    if (!stored) return { ok: false, code: 'not_found', message: `No credential named "${name}".` };
    stored.info.bindings ??= {};
    const verdict = checkUse(stored.info, purpose);
    if (!verdict.ok) return verdict;
    if (verdict.bind) {
      stored.info.bindings = { ...stored.info.bindings, ...verdict.bind };
      await this.write(stored);
    }
    return { ok: true, secret: stored.secret, info: stored.info };
  }

  async remove(name: string): Promise<boolean> {
    checkName(name);
    const had = existsSync(this.file(name));
    await rm(this.file(name), { force: true });
    return had;
  }
}

// ── hosted backend: the web server keeps the secrets ──────────────────────

/** The web server's credential broker for this run (`ARTEMIS_CREDENTIAL_BROKER` + the run's header). */
export class BrokerCredentialStore implements CredentialStore {
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async call<T>(op: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify({ op, ...body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new CredentialError('unavailable', `The credential service did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof data.error === 'string' && (['invalid_name', 'not_found', 'exists', 'wrong_kind', 'wrong_origin', 'wrong_host'] as string[]).includes(data.error) ? (data.error as CredentialErrorCode) : 'unavailable';
      throw new CredentialError(code, typeof data.message === 'string' ? data.message : `Credential service error ${res.status}`);
    }
    return data as T;
  }

  async create(name: string, kind: CredentialKind, options: CreateOptions = {}): Promise<CredentialInfo> {
    checkName(name);
    // SSH keys and passwords are made by the server; only VPN keys travel in.
    const body: Record<string, unknown> = { name, kind, bindings: cleanBindings(options.bindings) };
    if (options.secret !== undefined) body.secret = options.secret;
    if (options.publicPart) body.publicPart = options.publicPart;
    if (options.length) body.length = options.length;
    if (options.comment) body.comment = options.comment;
    if (options.meta) body.meta = options.meta;
    if (options.replace) body.replace = true;
    return (await this.call<{ info: CredentialInfo }>('create', body)).info;
  }

  async describe(name: string): Promise<CredentialInfo | undefined> {
    checkName(name);
    return (await this.call<{ info?: CredentialInfo }>('describe', { name })).info;
  }

  async list(): Promise<CredentialInfo[]> {
    return (await this.call<{ credentials: CredentialInfo[] }>('list', {})).credentials;
  }

  async use(name: string, purpose: CredentialPurpose): Promise<UseResult> {
    try {
      const data = await this.call<{ secret: string; info: CredentialInfo }>('use', { name, purpose });
      return { ok: true, secret: data.secret, info: data.info };
    } catch (err) {
      if (err instanceof CredentialError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
  }

  async remove(name: string): Promise<boolean> {
    return (await this.call<{ removed: boolean }>('remove', { name })).removed;
  }
}

let registered: CredentialStore | undefined;
/** The hosted broker: its address and the one-time claim code from the environment, then this run's ticket. */
let broker: { url: string; claim?: string; headers?: Record<string, string>; failed?: string } | undefined;

/** The header the broker reads this run's ticket from. */
export const CREDENTIAL_TICKET_HEADER = 'x-credential-ticket';

/** A host's own backend; undefined goes back to the default. */
export function registerCredentialStore(store: CredentialStore | undefined): void {
  registered = store;
}

/**
 * Takes the hosted broker's address and one-time claim code: from the
 * per-run headers the host handed over on an inherited descriptor (entry
 * `artemis_credentials`, see mcp/inheritedHeaders.ts), or, from an older
 * host, `ARTEMIS_CREDENTIAL_BROKER` = `{"url", "claim"}`, which is removed
 * from the environment so no tool or shell inherits it. The claim works
 * once (claimCredentialBroker trades it for the run's ticket, kept in this
 * process only).
 */
export function captureCredentialBroker(env: NodeJS.ProcessEnv = process.env, inherited: Record<string, string> = inheritedMcpHeaders(CREDENTIAL_ENTRY)): void {
  const raw = env.ARTEMIS_CREDENTIAL_BROKER?.trim();
  delete env.ARTEMIS_CREDENTIAL_BROKER;
  let url = inherited['x-credential-broker'] ?? '';
  let claim = inherited['x-credential-claim'] ?? '';
  if (!claim && raw) {
    try {
      const parsed = JSON.parse(raw) as { url?: unknown; claim?: unknown };
      url = typeof parsed.url === 'string' ? parsed.url : '';
      claim = typeof parsed.claim === 'string' ? parsed.claim : '';
    } catch {
      url = '';
      claim = '';
    }
  } else if (!claim) {
    return;
  }
  // Loopback only; anything else is refused rather than falling back to local files.
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?\//.test(url) || !claim) {
    broker = { url: '', failed: 'The credential service address is invalid.' };
    return;
  }
  broker = { url, claim };
}

/** The entry of the per-run headers that carries the credential service (not an MCP server). */
export const CREDENTIAL_ENTRY = 'artemis_credentials';

/** Trades the claim code for this run's ticket; before any tool runs. */
export async function claimCredentialBroker(fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<void> {
  if (!broker?.claim) return;
  const { url, claim } = broker;
  broker = { url };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'claim', claim }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ticket?: unknown };
    if (!res.ok || typeof data.ticket !== 'string') throw new Error(`status ${res.status}`);
    broker = { url, headers: { [CREDENTIAL_TICKET_HEADER]: data.ticket } };
  } catch (err) {
    broker = { url, failed: `The credential service refused this run (${err instanceof Error ? err.message : String(err)}).` };
  }
}

/** Every call fails: the hosted service is configured but not usable (never a silent local fallback). */
class UnavailableCredentialStore implements CredentialStore {
  constructor(private readonly reason: string) {}
  private fail(): never {
    throw new CredentialError('unavailable', this.reason);
  }
  async create(): Promise<CredentialInfo> {
    return this.fail();
  }
  async describe(): Promise<CredentialInfo | undefined> {
    return this.fail();
  }
  async list(): Promise<CredentialInfo[]> {
    return this.fail();
  }
  async use(): Promise<UseResult> {
    return { ok: false, code: 'unavailable', message: this.reason };
  }
  async remove(): Promise<boolean> {
    return this.fail();
  }
}

export function getCredentialStore(): CredentialStore {
  if (registered) return registered;
  if (broker?.headers) return new BrokerCredentialStore(broker.url, broker.headers);
  if (broker) return new UnavailableCredentialStore(broker.failed ?? 'The credential service is not ready.');
  return new FileCredentialStore();
}

/** For tests: back to no broker. */
export function resetCredentialBroker(): void {
  broker = undefined;
}

/** Which backend serves this process (for messages). */
export function credentialBackend(): 'registered' | 'hosted' | 'local' {
  return registered ? 'registered' : broker ? 'hosted' : 'local';
}
