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
 * fetch) and kept in this process's memory, bound to its site, for the rest
 * of the run (a "confirm password" field needs it twice).
 *
 * Nothing the model receives may carry it: every tool outcome is redacted
 * at the one place results are recorded (core/agent.ts), in the forms a page
 * or a URL can echo it (as typed, percent-, form-, JSON- and HTML-encoded,
 * reversed, spaced out). Reads that could reach the field itself are
 * refused while a password is live (browser_evaluate touching values,
 * screenshots of a password field switched to text); screenshots mask the
 * fields.
 *
 * The placeholder syntax is the one the engine's credential store uses for
 * its own secrets (`{{credential:<name>}}`); names starting with `signup-`
 * belong to this module, and are resolved first.
 */

const PLACEHOLDER = /\{\{credential:signup-(su_[0-9a-f]{20})\}\}/g;

/** The data attribute put on fields a password was typed into. */
export const SECRET_FIELD_ATTRIBUTE = 'data-artemis-secret';

interface Resolved {
  password: string;
  /** Registrable domain of the sign-up. */
  site: string;
  /** Every form the password may be echoed in, longest first. */
  variants: string[];
}

/** Resolved passwords of this process, by sign-up id. */
const resolved = new Map<string, Resolved>();

export interface HostFetch {
  /** The sign-up's site (no secret), to check the page before the password is asked for. */
  site(signupId: string): Promise<string>;
  /** The password (once), with its site. */
  password(signupId: string): Promise<{ password: string; site: string }>;
}

let fetchFromHost: HostFetch | undefined;

/** Set by tools/agentIdentity.ts (it knows how to reach the host); tests may set their own. */
export function setIdentityCredentialSource(source: HostFetch | undefined): void {
  fetchFromHost = source;
}

export function hasIdentityPlaceholder(text: string | undefined): boolean {
  return typeof text === 'string' && /\{\{credential:signup-su_[0-9a-f]{20}\}\}/.test(text);
}

/** Whether a password was typed in this process (reads of fields are then restricted). */
export function hasLiveIdentitySecrets(): boolean {
  return resolved.size > 0;
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
    if (!resolved.has(id)) {
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
        resolved.set(id, { password: got.password, site: got.site, variants: secretVariants(got.password) });
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

/**
 * A browser_evaluate script that could read a typed password back (a field's
 * value, form data, a type switch) is refused while a password is live.
 */
export function evaluateTouchesSecrets(script: string): boolean {
  if (!resolved.size) return false;
  return /value|formdata|password|elements|type|attribute|select|clipboard|execcommand|innertext|textcontent|data-artemis-secret|form/i.test(script);
}

/** Tests only. */
export function forgetIdentityCredentials(): void {
  resolved.clear();
}
