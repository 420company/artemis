/**
 * utils/redact.ts — outbound secret/path redaction
 *
 * Scrubs known credential shapes, sensitive URL parts, and user-identifying
 * paths from any text that leaves the process (logs, telemetry, crash
 * reports). Patterns are anchored to assignment/header/prefix shapes so plain
 * prose ("the token expired") is never touched.
 */

export const REDACTED = '[REDACTED_SECRET]'
const REDACTED_URL_VALUE = 'redacted'
const REDACTED_USER_SEGMENT = '<user>'

/** Vendor API keys with sk-/sk_ prefixes and xAI keys. \b-anchored so task-/disk-/risk- survive. */
const API_KEY_PREFIX_RE = /\b(?:sk[-_]|xai-)[A-Za-z0-9_-]{20,}/g
/** AWS long-term (AKIA) and temporary (ASIA) access-key IDs. */
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
/** GitHub PATs: classic (ghp_/gho_/ghu_/ghs_/ghr_) + fine-grained (github_pat_). */
const GITHUB_TOKEN_RE = /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g
/** GitLab (glpat-) and Slack (xoxa-/xoxb-/xoxp-/xapp-) tokens. */
const VENDOR_TOKEN_RE = /\b(?:glpat-|xox[abp]-|xapp-)[A-Za-z0-9-]{10,}/g
/** Google API keys (AIza + 35 chars). */
const GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{35}/g
/** PEM private-key block (any key type), base64 body included. */
const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi
/** Bare JWT (eyJ…header.payload.signature) with no Bearer/sk- prefix. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
/** key: value / key=value shapes only; 8-char value floor avoids short false positives. */
const SECRET_ASSIGNMENT_RE =
  /\b(api[_-]?key|(?:access|refresh|id)[_-]token|token|secret|client[_-]secret|password)\b(\s*[:=]\s*)(["']?)[^\s"',&]{8,}/gi
/** Excludes trailing punctuation so backticks/brackets around a URL survive. */
const URL_RE = /https?:\/\/[^\s"'<>(){}[\],;`]+/g

const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token', 'api_key', 'assertion', 'auth', 'client_secret', 'code',
  'code_verifier', 'id_token', 'key', 'password', 'refresh_token',
  'requested_token', 'session_id', 'state', 'subject_token', 'token',
])

function redactOneUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  if (url.search) {
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, REDACTED_URL_VALUE)
      }
    }
  }
  return url.toString()
}

/** Replace known credential shapes with [REDACTED_SECRET] and scrub URLs. */
export function redactSecrets(input: string): string {
  if (!input) return input
  let s = input.replace(PEM_PRIVATE_KEY_RE, REDACTED)
  s = s.replace(API_KEY_PREFIX_RE, REDACTED)
  s = s.replace(AWS_ACCESS_KEY_RE, REDACTED)
  s = s.replace(GITHUB_TOKEN_RE, REDACTED)
  s = s.replace(VENDOR_TOKEN_RE, REDACTED)
  s = s.replace(GOOGLE_API_KEY_RE, REDACTED)
  s = s.replace(BEARER_TOKEN_RE, `Bearer ${REDACTED}`)
  s = s.replace(JWT_RE, REDACTED)
  s = s.replace(URL_RE, redactOneUrl)
  s = s.replace(SECRET_ASSIGNMENT_RE, `$1$2$3${REDACTED}`)
  return s
}

// ── user path folding ───────────────────────────────────────────────────────

const HOME_DIR: string = (process.env.HOME || process.env.USERPROFILE || '').trim()

const USERNAMES: string[] = (() => {
  const names: string[] = []
  for (const envVar of ['USERNAME', 'USER'] as const) {
    const name = (process.env[envVar] || '').trim()
    if (name.length >= 3 && !names.some((u) => u.toLowerCase() === name.toLowerCase())) {
      names.push(name)
    }
  }
  return names
})()

/** Backstop for headless contexts where $HOME/$USER are unset. */
const HOME_ROOT_USER_RE = /([/\\](?:Users|home)[/\\])([^/\\]+)/g

/**
 * True for any char that can't continue a path/username segment: letters,
 * digits and _/-/. continue one (`/Users/bob` won't fold into `/Users/bobby`),
 * everything else ends it (so `/Users/bob: denied` still collapses).
 */
function isSegmentBoundary(ch: string): boolean {
  return !/[\p{L}\p{N}_.-]/u.test(ch)
}

/** Whole-segment home → ~ so /Users/bob doesn't fold inside /Users/bobby. */
function replaceHomePrefix(input: string, home: string): string {
  let out = ''
  let rest = input
  for (let idx = rest.indexOf(home); idx >= 0; idx = rest.indexOf(home)) {
    const before = rest.slice(0, idx)
    const after = rest.slice(idx + home.length)
    const prevOk = before.length === 0 || isSegmentBoundary(before[before.length - 1]!)
    const nextOk = after.length === 0 || isSegmentBoundary(after[0]!)
    out += before + (prevOk && nextOk ? '~' : home)
    rest = after
  }
  return out + rest
}

/** Replace whole /- or \-delimited segments equal to a username with <user>. */
function redactUsernameSegments(value: string, usernames: string[]): string {
  const caseInsensitive = process.platform === 'win32'
  const matches = (segment: string): boolean =>
    usernames.some((u) => (caseInsensitive ? u.toLowerCase() === segment.toLowerCase() : u === segment))
  let out = ''
  let buf = ''
  for (const ch of value) {
    if (isSegmentBoundary(ch)) {
      out += (matches(buf) ? REDACTED_USER_SEGMENT : buf) + ch
      buf = ''
    } else {
      buf += ch
    }
  }
  return out + (matches(buf) ? REDACTED_USER_SEGMENT : buf)
}

/** Collapse $HOME to ~ and path segments equal to the OS username to <user>. */
export function redactUserPaths(input: string): string {
  if (!input) return input
  let s = input
  if (HOME_DIR && s.includes(HOME_DIR)) s = replaceHomePrefix(s, HOME_DIR)
  if (USERNAMES.length > 0) s = redactUsernameSegments(s, USERNAMES)
  // Regex backstop ONLY when env is unavailable; with env known it would
  // over-redact (/Users/Shared, REST /users/<id>, …).
  if (!HOME_DIR && USERNAMES.length === 0) s = s.replace(HOME_ROOT_USER_RE, `$1${REDACTED_USER_SEGMENT}`)
  return s
}

/** Full outbound scrub: secrets first, then user-identifying paths. */
export function redactText(input: string): string {
  if (!input) return input
  return redactUserPaths(redactSecrets(input))
}
