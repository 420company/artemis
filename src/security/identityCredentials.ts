/**
 * security/identityCredentials.ts — passwords of the agent's own sign-ups
 * (tools/agentIdentity.ts), typed into the site without ever reaching the
 * model.
 *
 * begin_signup gives the model a placeholder, `{{credential:signup-<id>}}`.
 * browser_type / browser_form_input resolve it just before typing, and only:
 *   - into an `<input type="password">`,
 *   - on a page (the field's own frame) of the sign-up's site: the host
 *     returns the site with the password, and the frame's host must be that
 *     registrable domain or below it.
 * The password is fetched from the host once (a one-time nonce, then the
 * password; the host refuses runs an automation started and a second
 * fetch) and kept in this process's memory, bound to its site, while it is
 * live (a "confirm password" field needs it twice).
 *
 * Live: from that fetch until the run ends (the outermost runAgent returns),
 * finish_signup records the outcome, or the sign-up expires — whichever
 * comes first. While any password is live, page scripts and the console /
 * request logs are refused outright (browser_evaluate, browser_console,
 * browser_requests; navigating to a script URL): a hard rule, not a filter
 * of what a script looks like. The console / request logs record nothing
 * while a password is live (not even a request started then that finishes
 * later) and are cleared as it goes live and as it stops being live.
 * After that the password no longer resolves, but redaction still needs
 * it: the forms it can be echoed in (the plain value among them) stay in
 * this process's memory until it exits, because the page's field still
 * holds the value and a script may read it once scripts are allowed again.
 *
 * Nothing the model receives may carry it: every tool outcome is redacted
 * at the one place results are recorded (core/agent.ts), in the forms a page
 * or a URL can echo it (as typed, percent-, form-, JSON- and HTML-encoded,
 * reversed, spaced out) — defence in depth behind the rule above, and it
 * stays on after the password stops being live. Screenshots mask the fields
 * and are refused while a marked field is switched to text.
 *
 * The placeholder syntax is the one the engine's credential store uses for
 * its own secrets (`{{credential:<name>}}`); names starting with `signup-`
 * belong to this module, and are resolved first.
 */

import { fingerprintSet, type FingerprintSet } from './secretFingerprints.js';

const PLACEHOLDER = /\{\{credential:signup-(su_[0-9a-f]{20})\}\}/g;

/** The data attribute put on fields a password was typed into. */
export const SECRET_FIELD_ATTRIBUTE = 'data-artemis-secret';

interface Resolved {
  /** Emptied when the password stops being live. */
  password: string;
  /** Registrable domain of the sign-up. */
  site: string;
  /** Every form the password may be echoed in, longest first (kept for redaction). */
  variants: string[];
  /** When the sign-up expires (ms since epoch). */
  liveUntil: number;
  /** The run ended or the sign-up was finished. */
  ended: boolean;
}

/** Without an expiry from the host, a sign-up is taken to last this long (the host's default). */
const DEFAULT_LIVE_MS = 2 * 60 * 60 * 1000;
/** And never longer than this, whatever the host says. */
const MAX_LIVE_MS = 24 * 60 * 60 * 1000;

/** The message the model gets for any refused script or log read while a password is live. */
export const LIVE_SECRET_REFUSAL = '密码填写期间不能运行网页脚本或读取控制台/请求记录。A sign-up password is in use: page scripts and the console / request logs are off until finish_signup (or the end of this run). Read the page with browser_extract_text or a screenshot.';

/** Resolved passwords of this process, by sign-up id. */
const resolved = new Map<string, Resolved>();

export interface HostFetch {
  /** The sign-up's site (no secret), to check the page before the password is asked for. */
  site(signupId: string): Promise<string>;
  /** The password (once), with its site and when the sign-up expires. */
  password(signupId: string): Promise<{ password: string; site: string; expiresAt?: string | null }>;
}

let fetchFromHost: HostFetch | undefined;

/** Set by tools/agentIdentity.ts (it knows how to reach the host); tests may set their own. */
export function setIdentityCredentialSource(source: HostFetch | undefined): void {
  fetchFromHost = source;
}

export function hasIdentityPlaceholder(text: string | undefined): boolean {
  return typeof text === 'string' && /\{\{credential:signup-su_[0-9a-f]{20}\}\}/.test(text);
}

function isLive(entry: Resolved, now = Date.now()): boolean {
  return !entry.ended && now < entry.liveUntil;
}

type LiveWindowListener = (edge: 'start' | 'end') => void;
const liveWindowListeners: LiveWindowListener[] = [];

/**
 * Called when a password goes live and when one stops being live (finish,
 * run end). The browser tools clear their console / request logs on both,
 * so nothing recorded around the live window can be read later.
 */
export function onIdentityLiveWindow(listener: LiveWindowListener): void {
  liveWindowListeners.push(listener);
}

function notifyLiveWindow(edge: 'start' | 'end'): void {
  for (const listener of liveWindowListeners) {
    try {
      listener(edge);
    } catch {
      /* a listener must not break typing or finishing */
    }
  }
}

function end(entry: Resolved): void {
  entry.ended = true;
  entry.password = '';
  notifyLiveWindow('end');
}

/** Whether a sign-up password is live in this process (page scripts and log reads are then refused). */
export function hasLiveIdentitySecrets(now = Date.now()): boolean {
  for (const entry of resolved.values()) if (isLive(entry, now)) return true;
  return false;
}

/** Whether a sign-up password was ever typed in this process (screenshots keep masking its fields). */
export function hasTypedIdentitySecrets(): boolean {
  return resolved.size > 0;
}

/** finish_signup recorded an outcome: that sign-up's password is no longer live. */
export function endIdentitySignup(signupId: string): void {
  const entry = resolved.get(signupId);
  if (entry && !entry.ended) end(entry);
}

let runDepth = 0;

/**
 * Called as a run starts (runAgent; sub-agents nest inside it); the returned
 * function, as it ends. When the outermost run ends, every password stops
 * being live.
 */
export function enterIdentityRun(): () => void {
  runDepth += 1;
  let left = false;
  return () => {
    if (left) return;
    left = true;
    runDepth = Math.max(0, runDepth - 1);
    if (runDepth === 0) for (const entry of resolved.values()) if (!entry.ended) end(entry);
  };
}

function liveUntilFrom(expiresAt: string | null | undefined, now = Date.now()): number {
  const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(at)) return now + DEFAULT_LIVE_MS;
  return Math.min(at, now + MAX_LIVE_MS);
}

const htmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The forms a page, a URL or a script may echo a password in. */
export function secretVariants(password: string): string[] {
  const chars = [...password];
  const form = new URLSearchParams({ x: password }).toString().slice(2);
  const set = new Set<string>([
    password,
    encodeURIComponent(password),
    encodeURI(password),
    form,
    form.replace(/%20/g, '+'),
    JSON.stringify(password).slice(1, -1),
    htmlEscape(password),
    htmlEscape(password).replace(/&#39;/g, '&#x27;'),
    [...chars].reverse().join(''),
    chars.join(' '),
    chars.join(','),
    chars.join(', '),
    chars.join('\n'),
    chars.join(''),
  ]);
  return [...set].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
}

/** Whether `host` is the sign-up's registrable domain or a host below it (the host gives the registrable domain). */
export function hostBelongsTo(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const s = site.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}

/**
 * Replaces sign-up placeholders with the passwords, for typing only, into
 * a password field on the sign-up's own site.
 */
export async function resolveIdentityPlaceholders(
  text: string,
  field?: { inputType: string; frameUrl: string },
): Promise<{ ok: true; text: string; secret: boolean } | { ok: false; message: string }> {
  if (!hasIdentityPlaceholder(text)) return { ok: true, text, secret: false };
  if (!field || field.inputType !== 'password') {
    return { ok: false, message: 'A sign-up password is only typed into a password field (<input type="password">).' };
  }
  let frameHost = '';
  try {
    frameHost = new URL(field.frameUrl).hostname;
  } catch {
    frameHost = '';
  }
  const ids = [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
  for (const id of ids) {
    const known = resolved.get(id);
    if (known && !isLive(known)) {
      return { ok: false, message: 'This sign-up\'s password is no longer available here (the sign-up was finished, expired, or belongs to an earlier run). Ask the owner, or begin a new sign-up.' };
    }
    if (!known) {
      // The identity tools register the host source when they load; a run that types first loads them here.
      if (!fetchFromHost) await import('../tools/agentIdentity.js').catch(() => undefined);
      if (!fetchFromHost) return { ok: false, message: 'Sign-up passwords are not available on this host.' };
      // Check the page before asking for the password: on a wrong site it is never fetched.
      let site: string;
      try {
        site = await fetchFromHost.site(id);
      } catch (err) {
        return { ok: false, message: `This sign-up is not available: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!frameHost || !hostBelongsTo(frameHost, site)) {
        return { ok: false, message: `This sign-up's password is only typed on ${site}; this field is on ${frameHost || 'an unknown page'}.` };
      }
      try {
        const got = await fetchFromHost.password(id);
        if (got.site !== site) return { ok: false, message: 'The sign-up changed; start it again.' };
        resolved.set(id, { password: got.password, site: got.site, variants: secretVariants(got.password), liveUntil: liveUntilFrom(got.expiresAt), ended: false });
        notifyLiveWindow('start');
      } catch (err) {
        return { ok: false, message: `The password for this sign-up is not available: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const entry = resolved.get(id)!;
    if (!frameHost || !hostBelongsTo(frameHost, entry.site)) {
      return { ok: false, message: `This sign-up's password is only typed on ${entry.site}; this field is on ${frameHost || 'an unknown page'}.` };
    }
  }
  return { ok: true, text: text.replace(PLACEHOLDER, (_m, id: string) => resolved.get(id)?.password ?? ''), secret: true };
}

/**
 * Salted fingerprints of every form the passwords typed in this process may
 * be echoed in (secretFingerprints.ts): the live browser host uses them to
 * keep a URL or title carrying one out of the owner's view, without ever
 * holding a password. Undefined before any password was typed.
 */
export function identityFingerprints(): FingerprintSet | undefined {
  if (!resolved.size) return undefined;
  return fingerprintSet([...resolved.values()].flatMap((entry) => entry.variants));
}

/** Puts placeholders back wherever a resolved password appears, in any of its echoed forms. */
export function redactIdentitySecrets(text: string): string {
  if (!resolved.size || !text) return text;
  let out = text;
  for (const [id, entry] of resolved) {
    for (const variant of entry.variants) {
      if (out.includes(variant)) out = out.split(variant).join(`{{credential:signup-${id}}}`);
    }
  }
  return out;
}

/** Every string in a value (a tool outcome: output, error message, details, …), redacted. */
export function redactIdentitySecretsDeep<T>(value: T, depth = 0): T {
  if (!resolved.size || depth > 8) return value;
  if (typeof value === 'string') return redactIdentitySecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactIdentitySecretsDeep(v, depth + 1)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactIdentitySecretsDeep(v, depth + 1);
    return out as T;
  }
  return value;
}

/** Tests only. */
export function forgetIdentityCredentials(): void {
  resolved.clear();
  runDepth = 0;
}
