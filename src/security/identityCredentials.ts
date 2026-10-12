/**
 * security/identityCredentials.ts — passwords of the agent's own sign-ups
 * (tools/agentIdentity.ts), typed into the site without ever reaching the
 * model.
 *
 * begin_signup gives the model a placeholder, `{{credential:signup-<id>}}`.
 * browser_type / browser_form_input resolve it just before typing: the
 * password is fetched from the host once (the host hands each one out a
 * single time, never to a run an automation started) and kept in this
 * process's memory for the rest of the run (a "confirm password" field needs
 * it twice). Tool calls and the history keep the placeholder; any tool
 * output that would contain a resolved password (a page echoing it, a
 * script reading the field) is redacted back to the placeholder before it
 * is recorded.
 *
 * The placeholder syntax is the one the engine's credential store uses for
 * its own secrets (`{{credential:<name>}}`); names starting with `signup-`
 * belong to this module, and are resolved first.
 */

const PLACEHOLDER = /\{\{credential:signup-(su_[0-9a-f]{20})\}\}/g;

/** Resolved passwords of this process, by sign-up id. */
const resolved = new Map<string, string>();

export type HostFetch = (signupId: string) => Promise<string>;

let fetchFromHost: HostFetch | undefined;

/** Set by tools/agentIdentity.ts (it knows how to reach the host); tests may set their own. */
export function setIdentityCredentialSource(source: HostFetch | undefined): void {
  fetchFromHost = source;
}

export function hasIdentityPlaceholder(text: string | undefined): boolean {
  return typeof text === 'string' && /\{\{credential:signup-su_[0-9a-f]{20}\}\}/.test(text);
}

/** Replaces sign-up placeholders with the passwords, for typing only. */
export async function resolveIdentityPlaceholders(text: string): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  if (!hasIdentityPlaceholder(text)) return { ok: true, text };
  const ids = [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
  for (const id of ids) {
    if (resolved.has(id)) continue;
    // The identity tools register the host source when they load; a run that types first loads them here.
    if (!fetchFromHost) await import('../tools/agentIdentity.js').catch(() => undefined);
    if (!fetchFromHost) return { ok: false, message: 'Sign-up passwords are not available on this host.' };
    try {
      resolved.set(id, await fetchFromHost(id));
    } catch (err) {
      return { ok: false, message: `The password for this sign-up is not available: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true, text: text.replace(PLACEHOLDER, (_m, id: string) => resolved.get(id) ?? '') };
}

/** Puts placeholders back wherever a resolved password appears (before anything is recorded or shown). */
export function redactIdentitySecrets(text: string): string {
  if (!resolved.size || !text) return text;
  let out = text;
  for (const [id, password] of resolved) {
    if (password && out.includes(password)) out = out.split(password).join(`{{credential:signup-${id}}}`);
  }
  return out;
}

/** Tests only. */
export function forgetIdentityCredentials(): void {
  resolved.clear();
}
