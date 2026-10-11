/**
 * security/credentialStore.ts — secrets the agent creates while working for
 * the user (an SSH key for a new server, a generated root password), kept
 * out of the conversation.
 *
 * The model only ever sees a credential's name and its public part (an SSH
 * public key). Tools resolve the secret themselves:
 *   - server_setup uses stored SSH keys and passwords (tools/serverSetup.ts);
 *   - browser_type / browser_form_input replace `{{credential:<name>}}` with
 *     the stored password while typing, so the clear text never appears in
 *     a tool call, a tool result or the history.
 *
 * Backend: a directory under the engine's home (`<ARTEMIS_HOME>/credentials`,
 * 0700, one 0600 file per credential). A host that keeps secrets in its own
 * vault (the platform's connector vault, run by a separate user) registers
 * another backend with registerCredentialStore(); the interface is all the
 * tools use, so nothing else changes.
 */

import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveArtemisHomeDir } from '../utils/fs.js';

export type CredentialKind = 'ssh_key' | 'password' | 'token';

/** What may be shown: never the secret. */
export interface CredentialInfo {
  name: string;
  kind: CredentialKind;
  createdAt: string;
  /** An SSH public key, for example. */
  publicPart?: string;
  /** Short non-secret notes (provider, host, user). */
  meta?: Record<string, string>;
}

export interface CredentialStore {
  put(name: string, kind: CredentialKind, secret: string, info?: { publicPart?: string; meta?: Record<string, string> }): Promise<CredentialInfo>;
  describe(name: string): Promise<CredentialInfo | undefined>;
  list(): Promise<CredentialInfo[]>;
  /** The secret itself, for tools only. */
  reveal(name: string): Promise<string | undefined>;
  /**
   * A file holding the secret with mode 0600 (ssh -i needs one), and a
   * cleanup to call when done (a no-op for the file backend).
   */
  materialize(name: string): Promise<{ path: string; cleanup: () => Promise<void> } | undefined>;
  remove(name: string): Promise<boolean>;
}

export const CREDENTIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CREDENTIAL_PLACEHOLDER = /\{\{credential:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\}\}/g;

export class CredentialError extends Error {
  constructor(readonly code: 'invalid_name' | 'not_found' | 'exists', message: string) {
    super(message);
  }
}

function checkName(name: string): void {
  if (!CREDENTIAL_NAME.test(name)) throw new CredentialError('invalid_name', `Credential names use letters, digits, ".", "_" and "-" (at most 64): ${JSON.stringify(name)}`);
}

interface StoredFile {
  info: CredentialInfo;
  secret: string;
}

export class FileCredentialStore implements CredentialStore {
  constructor(readonly dir: string = path.join(resolveArtemisHomeDir(), 'credentials')) {}

  private ensure(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // best effort (another owner)
    }
  }

  private file(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  private keyFile(name: string): string {
    return path.join(this.dir, `${name}.key`);
  }

  private async read(name: string): Promise<StoredFile | undefined> {
    checkName(name);
    try {
      return JSON.parse(await readFile(this.file(name), 'utf8')) as StoredFile;
    } catch {
      return undefined;
    }
  }

  async put(name: string, kind: CredentialKind, secret: string, extra: { publicPart?: string; meta?: Record<string, string> } = {}): Promise<CredentialInfo> {
    checkName(name);
    this.ensure();
    if (existsSync(this.file(name))) throw new CredentialError('exists', `A credential named "${name}" already exists; pick another name.`);
    const info: CredentialInfo = {
      name,
      kind,
      createdAt: new Date().toISOString(),
      ...(extra.publicPart ? { publicPart: extra.publicPart } : {}),
      ...(extra.meta && Object.keys(extra.meta).length ? { meta: extra.meta } : {}),
    };
    const temp = `${this.file(name)}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify({ info, secret } satisfies StoredFile), { mode: 0o600 });
    await rename(temp, this.file(name));
    if (kind === 'ssh_key') await writeFile(this.keyFile(name), secret.endsWith('\n') ? secret : `${secret}\n`, { mode: 0o600 });
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

  async reveal(name: string): Promise<string | undefined> {
    return (await this.read(name))?.secret;
  }

  async materialize(name: string): Promise<{ path: string; cleanup: () => Promise<void> } | undefined> {
    const stored = await this.read(name);
    if (!stored) return undefined;
    if (!existsSync(this.keyFile(name))) {
      this.ensure();
      await writeFile(this.keyFile(name), stored.secret.endsWith('\n') ? stored.secret : `${stored.secret}\n`, { mode: 0o600 });
    }
    return { path: this.keyFile(name), cleanup: async () => undefined };
  }

  async remove(name: string): Promise<boolean> {
    checkName(name);
    const had = existsSync(this.file(name));
    await rm(this.file(name), { force: true });
    await rm(this.keyFile(name), { force: true });
    return had;
  }
}

let registered: CredentialStore | undefined;

/** A host's own backend (e.g. its vault); undefined goes back to the file store. */
export function registerCredentialStore(store: CredentialStore | undefined): void {
  registered = store;
}

export function getCredentialStore(): CredentialStore {
  return registered ?? new FileCredentialStore(process.env.ARTEMIS_CREDENTIALS_DIR?.trim() || undefined);
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_SYMBOLS = '-_.@#%+=';

/**
 * A strong password most sign-up forms accept: 20 characters, upper and
 * lower case, digits and one or two common symbols, no look-alike letters.
 */
export function generatePassword(length = 20): string {
  const chars: string[] = [];
  const pick = (set: string) => set[randomInt(set.length)]!;
  chars.push(pick('ABCDEFGHJKLMNPQRSTUVWXYZ'), pick('abcdefghijkmnopqrstuvwxyz'), pick('23456789'), pick(PASSWORD_SYMBOLS));
  while (chars.length < Math.max(12, length)) chars.push(pick(PASSWORD_ALPHABET));
  // Fisher-Yates with a CSPRNG.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/**
 * Replaces `{{credential:<name>}}` placeholders with stored passwords or
 * tokens. Unknown names are an error (nothing is typed), so a typo never
 * types the placeholder itself into a form.
 */
export async function resolveCredentialPlaceholders(text: string, store: CredentialStore = getCredentialStore()): Promise<{ ok: true; text: string; used: string[] } | { ok: false; missing: string[] }> {
  const names = [...new Set([...text.matchAll(CREDENTIAL_PLACEHOLDER)].map((m) => m[1]!))];
  if (names.length === 0) return { ok: true, text, used: [] };
  const values = new Map<string, string>();
  const missing: string[] = [];
  for (const name of names) {
    const info = await store.describe(name);
    const secret = info && info.kind !== 'ssh_key' ? await store.reveal(name) : undefined;
    if (secret === undefined) missing.push(name);
    else values.set(name, secret);
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, text: text.replace(CREDENTIAL_PLACEHOLDER, (_m, name: string) => values.get(name) ?? ''), used: names };
}
