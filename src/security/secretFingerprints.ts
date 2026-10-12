/**
 * security/secretFingerprints.ts — recognising a secret in a text without
 * holding the secret.
 *
 * The live browser host (tools/browser/browserHost.ts) must keep a sign-up
 * password out of what the owner's view receives: a URL a GET form put it
 * in, a title a page echoed it into. The host is a separate process and
 * never gets the password. The engine sends it a salted fingerprint of each
 * form the password may be echoed in (identityCredentials.ts'
 * secretVariants): its length, a keyed rolling hash (Rabin–Karp, the base
 * derived from the salt) and an HMAC-SHA256 under the salt. One salt per
 * engine process; each run's set replaces its previous one.
 *
 * Matching must stay cheap, since a page can change its URL and title many
 * times a second and the host serves every client from one thread: the
 * rolling hash slides over the text in one pass per variant length, and
 * the HMAC is only computed where it hits. A URL's path, query and
 * fragment are checked (not its scheme and host), and the title. Work
 * is bounded per text and per second; past that, `check` answers
 * 'unknown', and callers fail closed (they blank the text).
 */
import { createHmac, randomBytes } from 'node:crypto';

export interface FingerprintSet {
  /** Base64url salt (one per engine process). */
  salt: string;
  /** One per variant: its length (UTF-16 units), its keyed rolling hash and its hex HMAC. */
  hashes: { n: number; r: number; h: string }[];
}

/** Longest text checked (a URL or title beyond this is cut). */
const MAX_CHECKED = 8_192;
/** Variants shorter than this are not fingerprinted (they would match by chance). */
const MIN_LENGTH = 4;
/** Sets kept by the host (one per run; the oldest goes). */
export const MAX_SETS = 8;
const MAX_HASHES = 256;
/** A prime below 2^26: products of two residues stay exact in a double. */
const MOD = 67_108_859;
/** Matching time allowed per second; past it, texts are 'unknown' until the next second. */
const BUDGET_MS_PER_SECOND = 50;

function hmac(salt: string, text: string): string {
  return createHmac('sha256', Buffer.from(salt, 'base64url')).update(text, 'utf8').digest('hex').slice(0, 32);
}

/** The rolling hash's base, derived from the salt (2 .. MOD-1). */
function rollingBase(salt: string): number {
  const bytes = createHmac('sha256', Buffer.from(salt, 'base64url')).update('rolling-base').digest();
  return 2 + (bytes.readUInt32BE(0) % (MOD - 3));
}

function rollingHash(text: string, base: number): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * base + text.charCodeAt(i)) % MOD;
  return h;
}

/** A new random salt (the engine keeps one per process). */
export function newFingerprintSalt(): string {
  return randomBytes(16).toString('base64url');
}

/** The fingerprints of these variants under `salt`. */
export function fingerprintSet(variants: string[], salt = newFingerprintSalt()): FingerprintSet {
  const base = rollingBase(salt);
  const hashes = [...new Set(variants)]
    .filter((v) => v.length >= MIN_LENGTH && v.length <= MAX_CHECKED)
    .slice(0, MAX_HASHES)
    .map((v) => ({ n: v.length, r: rollingHash(v, base), h: hmac(salt, v) }));
  return { salt, hashes };
}

/** A set as received from another process, checked; undefined when malformed. */
export function parseFingerprintSet(raw: unknown): FingerprintSet | undefined {
  const value = raw as { salt?: unknown; hashes?: unknown } | undefined;
  if (!value || typeof value !== 'object' || typeof value.salt !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value.salt)) return undefined;
  if (!Array.isArray(value.hashes)) return undefined;
  const hashes = value.hashes
    .filter((x): x is { n: number; r: number; h: string } => {
      const e = x as { n?: unknown; r?: unknown; h?: unknown };
      return !!e
        && typeof e.n === 'number' && Number.isInteger(e.n) && e.n >= MIN_LENGTH && e.n <= MAX_CHECKED
        && typeof e.r === 'number' && Number.isInteger(e.r) && e.r >= 0 && e.r < MOD
        && typeof e.h === 'string' && /^[0-9a-f]{32}$/.test(e.h);
    })
    .slice(0, MAX_HASHES)
    .map((e) => ({ n: e.n, r: e.r, h: e.h }));
  return hashes.length ? { salt: value.salt, hashes } : undefined;
}

/**
 * The part of a URL a password can land in: everything after the origin
 * (path, query and fragment). The scheme and host are left out.
 */
export function urlValuePart(url: string): string {
  const scheme = url.indexOf('://');
  if (scheme === -1) return url;
  const rest = url.slice(scheme + 3);
  const at = rest.search(/[/?#]/);
  return at === -1 ? '' : rest.slice(at);
}

interface CompiledSet {
  salt: string;
  base: number;
  /** By variant length: its rolling hashes and HMACs. */
  byLength: Map<number, { rolling: Set<number>; hmacs: Set<string>; pow: number }>;
}

export type FingerprintCheck = 'yes' | 'no' | 'unknown';

/** Matches texts against the fingerprint sets it was given (one per key: a run). */
export class FingerprintMatcher {
  private readonly sets = new Map<string | number, CompiledSet>();
  private readonly cache = new Map<string, boolean>();
  private windowStart = 0;
  private spentMs = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get size(): number {
    return this.sets.size;
  }

  /** Sets (or replaces) the fingerprints of one key (a run). */
  set(key: string | number, set: FingerprintSet): void {
    const base = rollingBase(set.salt);
    const byLength = new Map<number, { rolling: Set<number>; hmacs: Set<string>; pow: number }>();
    for (const { n, r, h } of set.hashes) {
      let entry = byLength.get(n);
      if (!entry) {
        let pow = 1;
        for (let i = 1; i < n; i++) pow = (pow * base) % MOD;
        entry = { rolling: new Set(), hmacs: new Set(), pow };
        byLength.set(n, entry);
      }
      entry.rolling.add(r);
      entry.hmacs.add(h);
    }
    this.sets.delete(key);
    this.sets.set(key, { salt: set.salt, base, byLength });
    while (this.sets.size > MAX_SETS) this.sets.delete(this.sets.keys().next().value!);
    this.cache.clear();
  }

  /** Adds a set under its own salt (tests, benchmarks). */
  add(set: FingerprintSet): void {
    this.set(set.salt, set);
  }

  /**
   * Whether the text contains one of the fingerprinted variants; 'unknown'
   * when the time budget for this second is spent (callers blank the text).
   */
  check(text: string | undefined): FingerprintCheck {
    if (!text || this.sets.size === 0) return 'no';
    const s = text.length > MAX_CHECKED ? text.slice(0, MAX_CHECKED) : text;
    const known = this.cache.get(s);
    if (known !== undefined) return known ? 'yes' : 'no';
    const start = this.now();
    if (start - this.windowStart >= 1_000) {
      this.windowStart = start;
      this.spentMs = 0;
    }
    if (this.spentMs >= BUDGET_MS_PER_SECOND) return 'unknown';
    const found = this.scan(s);
    this.spentMs += this.now() - start;
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(s, found);
    return found ? 'yes' : 'no';
  }

  /** check(), with 'unknown' counted as a match (fail closed). */
  matches(text: string | undefined): boolean {
    return this.check(text) !== 'no';
  }

  private scan(s: string): boolean {
    for (const set of this.sets.values()) {
      const { base } = set;
      for (const [n, { rolling, hmacs, pow }] of set.byLength) {
        if (n > s.length) continue;
        let h = 0;
        for (let i = 0; i < n; i++) h = (h * base + s.charCodeAt(i)) % MOD;
        for (let i = 0; ; i++) {
          if (rolling.has(h) && hmacs.has(hmac(set.salt, s.slice(i, i + n)))) return true;
          if (i + n >= s.length) break;
          const out = (s.charCodeAt(i) * pow) % MOD;
          h = (((h - out + MOD) % MOD) * base + s.charCodeAt(i + n)) % MOD;
        }
      }
    }
    return false;
  }
}
