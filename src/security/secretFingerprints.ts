/**
 * security/secretFingerprints.ts — recognising a secret in a text without
 * holding the secret.
 *
 * The live browser host (tools/browser/browserHost.ts) must keep a sign-up
 * password out of what the owner's view receives: a URL a GET form put it
 * in, a title a page echoed it into. The host is a separate process and
 * never gets the password. The engine sends it a salted fingerprint of each
 * form the password may be echoed in (identityCredentials.ts'
 * secretVariants): its length and an HMAC-SHA256 of it under a random salt.
 * The host checks every substring of that length of a URL or title against
 * them.
 */
import { createHmac, randomBytes } from 'node:crypto';

export interface FingerprintSet {
  /** Base64url salt, random per set. */
  salt: string;
  /** One per variant: its length (UTF-16 units) and its hex HMAC. */
  hashes: { n: number; h: string }[];
}

/** Longest text checked (a URL or title beyond this is cut). */
const MAX_CHECKED = 8_192;
/** Variants shorter than this are not fingerprinted (they would match by chance). */
const MIN_LENGTH = 4;
const MAX_SETS = 32;
const MAX_HASHES = 64;

function hmac(salt: string, text: string): string {
  return createHmac('sha256', Buffer.from(salt, 'base64url')).update(text, 'utf8').digest('hex').slice(0, 32);
}

/** The fingerprints of these variants under a new salt. */
export function fingerprintSet(variants: string[]): FingerprintSet {
  const salt = randomBytes(16).toString('base64url');
  const hashes = [...new Set(variants)]
    .filter((v) => v.length >= MIN_LENGTH && v.length <= MAX_CHECKED)
    .slice(0, MAX_HASHES)
    .map((v) => ({ n: v.length, h: hmac(salt, v) }));
  return { salt, hashes };
}

/** A set as received from another process, checked; undefined when malformed. */
export function parseFingerprintSet(raw: unknown): FingerprintSet | undefined {
  const value = raw as { salt?: unknown; hashes?: unknown } | undefined;
  if (!value || typeof value !== 'object' || typeof value.salt !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value.salt)) return undefined;
  if (!Array.isArray(value.hashes)) return undefined;
  const hashes = value.hashes
    .filter((x): x is { n: number; h: string } => {
      const e = x as { n?: unknown; h?: unknown };
      return !!e && typeof e.n === 'number' && Number.isInteger(e.n) && e.n >= MIN_LENGTH && e.n <= MAX_CHECKED && typeof e.h === 'string' && /^[0-9a-f]{32}$/.test(e.h);
    })
    .slice(0, MAX_HASHES)
    .map((e) => ({ n: e.n, h: e.h }));
  return hashes.length ? { salt: value.salt, hashes } : undefined;
}

/** Matches texts against the fingerprint sets it was given. */
export class FingerprintMatcher {
  private readonly sets: { salt: string; byLength: Map<number, Set<string>> }[] = [];
  private readonly cache = new Map<string, boolean>();

  get size(): number {
    return this.sets.length;
  }

  add(set: FingerprintSet): void {
    if (this.sets.some((s) => s.salt === set.salt)) return;
    const byLength = new Map<number, Set<string>>();
    for (const { n, h } of set.hashes) {
      if (!byLength.has(n)) byLength.set(n, new Set());
      byLength.get(n)!.add(h);
    }
    this.sets.push({ salt: set.salt, byLength });
    if (this.sets.length > MAX_SETS) this.sets.shift();
    this.cache.clear();
  }

  /** Whether the text contains one of the fingerprinted variants. */
  matches(text: string | undefined): boolean {
    if (!text || this.sets.length === 0) return false;
    const s = text.length > MAX_CHECKED ? text.slice(0, MAX_CHECKED) : text;
    const known = this.cache.get(s);
    if (known !== undefined) return known;
    let found = false;
    outer: for (const set of this.sets) {
      for (const [n, wanted] of set.byLength) {
        for (let i = 0; i + n <= s.length; i++) {
          if (wanted.has(hmac(set.salt, s.slice(i, i + n)))) {
            found = true;
            break outer;
          }
        }
      }
    }
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(s, found);
    return found;
  }
}
