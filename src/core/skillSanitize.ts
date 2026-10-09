/**
 * core/skillSanitize.ts — keeping learned skills free of injected or private text.
 *
 * A learned skill is written by the curator model from the user's request
 * and the agent's actions. Anything a tool returned (web pages, files,
 * command output) may carry instructions planted for an AI agent, and the
 * agent may have followed them, so its actions are no proof of intent
 * either. Every distilled line therefore passes these checks:
 *
 *   1. normalisation  NFKC, zero-width and bidi controls removed; for the
 *                     checks, Cyrillic/Greek look-alikes fold to Latin, and
 *                     a word mixing Latin with those scripts drops the line.
 *   2. injection      instructions addressed to an AI, impersonated runtime
 *                     notes, exfiltration.
 *   3. dangerous ops  package-registry changes (unless the user named that
 *                     host), disabling TLS checks, download-and-execute,
 *                     chmod 777 / +x on downloads, reading or copying
 *                     credentials and keys.
 *   4. provenance     text copied from tool output (n-gram fingerprints of
 *                     ALL tool output in the run) unless the user's own
 *                     messages contain it too.
 *   5. redaction      credentials (also in URLs and CLI flags), emails,
 *                     phone numbers, URLs the user did not write, paths
 *                     outside the workspace (relative inside it).
 *
 * Only the user's own messages (and skills already stored, which passed
 * these checks when learned) count as trusted text.
 */

import path from 'node:path'
import { homedir } from 'node:os'
import { redactSecrets } from '../utils/redact.js'
import { clampLine, slugifySkillId, SKILL_LIMITS, type SkillDraft } from '../storage/skillStore.js'

// ── normalisation ──────────────────────────────────────────────────────────

const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD\u180E]/g

/**
 * Invisible and bidi control characters removed: the form a skill is
 * stored in. Everything else (full-width CJK punctuation, µ, Ω) is kept as
 * written; normalisation is only for detection (normalizeForChecks).
 */
export function cleanSkillText(text: unknown): string {
  return String(text ?? '').replace(INVISIBLE_RE, '').normalize('NFC')
}

const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w', ɡ: 'g',
  А: 'a', В: 'b', Е: 'e', К: 'k', М: 'm', Н: 'h', О: 'o', Р: 'p', С: 'c', Т: 't', У: 'y', Х: 'x', І: 'i', Ј: 'j', Ѕ: 's',
  // Greek
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  Α: 'a', Β: 'b', Ε: 'e', Ζ: 'z', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Υ: 'y', Χ: 'x',
}
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g')

/** NFKC (full-width → ASCII), lowercased, look-alikes folded to Latin: the form the checks run on. */
export function normalizeForChecks(text: string): string {
  return cleanSkillText(text).normalize('NFKC').replace(CONFUSABLE_RE, (ch) => CONFUSABLES[ch] ?? ch).toLowerCase()
}

/** Greek letters that are unit symbols (micro, ohm, ångström…), not a homoglyph disguise. */
const UNIT_LETTERS = new Set(['µ', 'μ', 'Ω', 'Ω', 'Å', 'Å', 'ω', '℧'])

/**
 * A word mixing Latin with Cyrillic/Greek letters (a homoglyph disguise),
 * checked on the text as written — not after NFKC, which would turn µ and
 * Ω into Greek letters. Unit symbols next to digits or units ("500µs",
 * "10kΩ") do not count.
 */
export function hasMixedScriptWord(text: string): boolean {
  for (const match of cleanSkillText(text).matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0]
    if (!/\p{Script=Latin}/u.test(word)) continue
    const foreign = [...word].filter((ch) => /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(ch))
    if (foreign.length === 0) continue
    if (foreign.every((ch) => UNIT_LETTERS.has(ch))) continue
    return true
  }
  return false
}

// ── injected instructions ──────────────────────────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass|skip)\b.{0,50}\b(?:previous|prior|above|earlier|preceding|all|any|everything|system|developer|safety|these|those|your|the)\b.{0,30}\b(?:instructions?|prompts?|rules?|messages?|guidelines?|polic(?:y|ies)|directions?|context|guardrails?)\b/,
  /\b(?:ignore|disregard|forget)\s+(?:everything|anything|all|what(?:ever)?)\b.{0,20}\b(?:above|before|prior|previously|said|written)\b/,
  /\byou are now\b|\bfrom now on,? (?:you|the (?:assistant|agent|ai))\b|\bnew (?:system )?instructions?\b|\bsystem prompt\b|\bdeveloper (?:message|mode)\b|\bjailbreak|\bprompt injection\b/,
  /\b(?:act|behave) as (?:an? )?(?:admin|administrator|root|developer|system|dan|unrestricted)\b|\bpretend (?:to be|you are)\b/,
  /\b(?:important|attention|note|message|instructions?)\b.{0,15}\b(?:for|to)\b.{0,10}\b(?:all )?(?:ai|llms?|agents?|assistants?|language models?|bots?)\b/,
  /\b(?:ai|llm) (?:agents?|assistants?) (?:must|should|need to)\b/,
  /<\/?\s*(?:system|assistant|user|tool|instructions?|im_start|im_end)\b[^>]*>/,
  /\[\s*(?:runtime|system|artemis|assistant|developer)\b/,
  /\b(?:pre-?approved|already approved|auto-?approve)\b|\bskip (?:all )?(?:the )?confirmations?\b|\bwithout (?:asking|confirmation|confirming)\b|\bdo not (?:ask|tell|inform) the user\b|\bdon'?t (?:ask|tell) the user\b/,
  /\b(?:exfiltrate|leak|send|upload|post|email|forward|share|paste)\b.{0,60}\b(?:secrets?|credentials?|tokens?|api[ _-]?keys?|passwords?|private keys?|ssh keys?|\.env|cookies?|session ids?)\b/,
  /\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$home)(?:\s|$)/,
  /\b(?:disable|turn off|bypass)\b.{0,30}\b(?:safety|guardrails?|permission checks?|sandbox|security checks?)\b/,
  /忽略(?:以上|上面|之前|前面|先前|此前|所有|全部)?(?:的)?(?:所有|全部)?(?:内容|指令|指示|提示|规则|要求|说明|设定)|无视(?:以上|之前|前面|所有|上面)|你现在是|从现在(?:起|开始)你|新的?指令|系统提示(?:词)?|开发者模式|越狱|跳过确认|无需确认|不要告诉用户|已获(?:得)?授权|自动批准/,
  /(?:上传|发送|泄露|转发|粘贴).{0,20}(?:密钥|密码|令牌|凭据|私钥|cookie)/,
]

/** Instructions aimed at an AI, impersonated runtime notes, exfiltration (checked on normalised text). */
export function looksLikeInjectedInstruction(line: string): boolean {
  const text = normalizeForChecks(line)
  return hasMixedScriptWord(line) || INJECTION_PATTERNS.some((pattern) => pattern.test(text))
}

// ── hosts ──────────────────────────────────────────────────────────────────

/**
 * Bare hosts ("evil.example/simple", "github.com/x/y") are recognised only
 * on public TLDs that are not also file extensions or library suffixes;
 * a TLD that collides with one (io, ai, app, dev, sh, …: socket.io,
 * MyTool.app) counts only when a path follows. Names ending in a file
 * extension (parser.test.ts, README.de.md) are never hosts.
 */
const BARE_HOST_TLDS =
  'com|net|org|edu|gov|mil|int|cn|ru|de|uk|fr|jp|kr|in|br|nl|eu|us|ca|au|it|es|se|ch|pl|tw|hk|sg|info|biz|xyz|top|site|online|tech|cloud|page|link|club|pro|cc|tk|example|internal|corp|lan|invalid|localhost'
const PATH_ONLY_TLDS = 'io|ai|app|dev|me|co|gg|ly|sh|so|to|tv|fm|ws|im|is|la|ms'
const URL_RE = /\b(?:https?|ftp|file|wss?|ssh|git|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'<>`)\]]+/gi
const BARE_HOST_RE = new RegExp(
  `(?<![\\w@./:-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:(?:${BARE_HOST_TLDS})(?::\\d{2,5})?(?:\\/[^\\s"'<>\`)\\]]*)?|(?:${PATH_ONLY_TLDS})(?::\\d{2,5})?\\/[^\\s"'<>\`)\\]]*))(?![\\w.-])`,
  'gi',
)
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

interface ParsedLocation {
  host: string
  /** Lowercased host + path, no scheme, query, fragment or trailing slash. */
  bare: string
}

function parseLocation(raw: string): ParsedLocation | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(withScheme)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!host) return null
    const pathPart = url.pathname.replace(/\/+$/, '')
    return { host, bare: `${host}${url.port ? `:${url.port}` : ''}${pathPart}`.toLowerCase() }
  } catch {
    return null
  }
}

/** Every URL or bare host in a text (scheme URLs first, then bare hosts outside them). */
export function findLocations(text: string): Array<{ raw: string; location: ParsedLocation }> {
  const out: Array<{ raw: string; location: ParsedLocation }> = []
  const withoutUrls = text.replace(URL_RE, (raw) => {
    const location = parseLocation(raw)
    if (location) out.push({ raw, location })
    return ' '
  })
  for (const match of withoutUrls.matchAll(BARE_HOST_RE)) {
    const location = parseLocation(match[1]!)
    if (location) out.push({ raw: match[1]!, location })
  }
  return out
}

/** Hosts and locations the user's own text names. */
export interface UserLocations {
  hosts: Set<string>
  bares: string[]
}

export function userLocations(userText: string): UserLocations {
  const found = findLocations(normalizeForChecks(userText))
  return { hosts: new Set(found.map((entry) => entry.location.host)), bares: found.map((entry) => entry.location.bare) }
}

/**
 * A location the user wrote: same host (exact, never a substring — mirror.co
 * is not mirror.com) and the same path or a path under one they gave; a
 * bare host the user named, or a local address, also counts.
 */
export function userWroteLocation(location: ParsedLocation, user: UserLocations): boolean {
  if (LOCAL_HOSTS.has(location.host) && user.hosts.has(location.host)) return true
  if (!user.hosts.has(location.host)) return false
  if (location.bare === location.host || /^[^/]+:\d+$/.test(location.bare)) return true
  return user.bares.some((bare) => location.bare === bare || location.bare.startsWith(`${bare}/`))
}

// ── dangerous operations ───────────────────────────────────────────────────

const REGISTRY_CHANGE_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+config\s+set\s+(?:@[\w-]+:)?(?:registry|npmregistryserver)\b|--registry[=\s]|\bregistry\s*=\s*\S|\bnpmregistryserver\b|\bnpm_config_registry\b|\bpip3?\s+config\s+set\b|\bpip3?\s+install\b[^\n]*\s-i\s|--(?:extra-)?index-url\b|\bindex-url\s*=|\bpip_(?:extra_)?index_url\b|\bgem\s+sources\b|\bbundle\s+config\b[^\n]*\bmirror\b|\bgoproxy\s*=|\bgo\s+env\s+-w\s+goproxy\b|\bcargo\b[^\n]{0,40}\b(?:--registry|--index|registries|replace-with)\b|\[registries|\[source\.|\bpoetry\s+source\s+add\b|\buv\b[^\n]*--(?:extra-)?index\b|\bconda\s+config\s+--(?:add|set)\s+channels\b/
const PUBLISH_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bpodman\s+push\b|\bgem\s+push\b|\bpoetry\s+publish\b|\bflit\s+publish\b|\bhelm\s+push\b/
const FORCE_PUSH_RE = /\bgit\s+push\b[^\n]*(?:\s--force(?:-with-lease)?\b|\s-f\b|\s--mirror\b|\s\+\S)/
const DANGEROUS_PATTERNS: RegExp[] = [
  // TLS / certificate checks off
  /\b\w*tls_reject_unauthorized\b|\bstrict-ssl\b\s*(?:=|\s)\s*false|--insecure\b|\bcurl\b[^|;&\n]*\s-[a-z]*k[a-z]*\b|\bverify\s*=\s*false\b|\bpythonhttpsverify\b|\bgit_ssl_no_verify\b|\bsslverify\s*(?:=|\s)\s*false|--no-check-certificate\b|--trusted-host\b|\b(?:disable|skip|turn off|ignore|bypass)\b.{0,25}\b(?:certificate|cert|ssl|tls|https)\b.{0,15}\b(?:checks?|verification|validation|errors?)?/,
  // download and execute
  /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b|\b(?:curl|wget|iwr|irm)\b[^\n]*\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby|php|iex|invoke-expression)\b/,
  /\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)|\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)|\biex\b.{0,10}\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b/,
  /\b(?:curl|wget|iwr|irm)\b[^\n]*(?:&&|;|\bthen\b)\s*(?:sudo\s+)?(?:(?:ba|z|da)?sh\b|\.\/|chmod\b|python3?\b|node\b|source\b)/,
  /\bpipe\b.{0,40}\binto\s+(?:ba|z)?sh\b|\bpipe\b.{0,40}\bto\s+(?:ba|z)?sh\b/,
  // permissions, privilege, host trust, system protection
  /\bchmod\s+(?:-r\s+)?(?:0?777|a\+rwx|o\+w)\b|\bchmod\s+\+x\b.{0,60}\b(?:download|curl|wget|from the (?:web|internet|link|url))\b|\b(?:download|curl|wget)\b.{0,60}\bchmod\s+\+x\b/,
  /\bsudoers\b|\bnopasswd\b|\bvisudo\b|\busermod\s+-a?g\s+(?:sudo|wheel|root|docker)\b/,
  /\bstricthostkeychecking\s*[= ]\s*(?:no|off|accept-new)\b|\buserknownhostsfile\s*[= ]\s*\/dev\/null\b|\bssh-keyscan\b[^\n]*>>\s*\S*known_hosts/,
  /\bcredential\.helper\s+(?:store|cache)\b|\bgit\s+config\b[^\n]*\bcredential\b[^\n]*\bstore\b/,
  /\bufw\s+disable\b|\bsystemctl\s+(?:stop|disable|mask)\s+(?:firewalld|ufw|iptables|nftables|apparmor)\b|\biptables\s+-f\b|\bnft\s+flush\b|\bsetenforce\s+0\b|\bselinux\s*=\s*(?:disabled|permissive)\b|\b(?:disable|turn off|stop)\b.{0,20}\b(?:firewall|selinux|apparmor|defender|antivirus)\b|(?:关闭|禁用|停用).{0,6}(?:防火墙|selinux)/,
  // credentials and keys: reading, copying or sending them, not mentioning them
  /\b(?:cat|less|more|head|tail|type|print|echo|copy|cp|scp|rsync|mv|move|tar|zip|upload|send|post|share|paste|dump|base64|exfiltrate|read|open|attach|include|commit|add)\b[^\n]{0,40}(?:~\/\.ssh\b|\$home\/\.ssh\b|\.ssh\/(?:id_|authorized_keys)|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.aws\/credentials|\.netrc\b|\.pypirc\b|\.docker\/config\.json|\.kube\/config|\.git-credentials|\bkeychain\b|\bprivate keys?\b)/,
  /(?:~\/\.ssh\b|\.ssh\/id_|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.git-credentials)[^\n]{0,40}\b(?:to|into|in)\b[^\n]{0,30}\b(?:output|build|dist|public|repo|commit|upload|server|channel|issue|chat)\b/,
  /\b(?:cat|print|echo|printenv|log|dump|upload|send|post|share|paste|exfiltrate|leak|expose|commit)\b(?:\s+\S+){0,2}\s+(?:all\s+|the\s+|your\s+|my\s+)?(?:\.env\b(?![.-])|secrets?\b|credentials?\b|api[ _-]?keys?\b|passwords?\b|tokens?\b|cookies?\b|env(?:ironment)? (?:vars?|variables)\b)(?!\s+(?:expiry|expiration|expires|ttl|lifetime|age|count|length|usage|limits?|names?|types?|format|ids?|rotation|refresh(?:es)?|validation|checks?|fields?|headers?|prefix|scopes?|budget|status|errors?|metadata|hash(?:es)?|fingerprints?|time|timestamps?)\b)/,
  /\b(?:echo|print|printf|printenv|cat|log)\b[^\n]{0,20}\$\{?[a-z_]*(?:key|token|secret|password|passwd|pass)\b/,
  /(?:读取|复制|打印|上传|发送|导出|提交).{0,15}(?:\.ssh|密钥|私钥|凭据|令牌|密码|\.env)|(?:关闭|禁用|跳过).{0,10}(?:证书|ssl|tls)(?:校验|验证|检查)?/,
]

/**
 * Why a line describes an operation a learned skill must never carry, or
 * null. A registry change is allowed only when every host it names is one
 * the user's own messages name (exact host), a local registry included;
 * publishing/pushing only when the user asked to publish and named every
 * host involved; force-pushing only when the user asked for it.
 */
export function dangerousOperation(line: string, userText = ''): string | null {
  const text = normalizeForChecks(line)
  const user = userLocations(userText)
  const userLower = normalizeForChecks(userText)
  const hostsNamed = (): boolean => findLocations(text).every((entry) => userWroteLocation(entry.location, user) || user.hosts.has(entry.location.host))
  if (REGISTRY_CHANGE_RE.test(text)) {
    const locations = findLocations(text)
    if (locations.length === 0 || !locations.every((entry) => user.hosts.has(entry.location.host))) return 'package registry change'
  }
  if (PUBLISH_RE.test(text)) {
    const asked = /\b(?:publish|release|push|upload|deploy)\b|发布|推送|上传|上线/.test(userLower)
    if (!asked || !hostsNamed()) return 'publish to an unnamed destination'
  }
  if (FORCE_PUSH_RE.test(text) && !/\bforce[- ]?push|--force\b|-f\b|强制推送|强推/.test(userLower)) return 'force push'
  for (const pattern of DANGEROUS_PATTERNS) if (pattern.test(text)) return 'dangerous operation'
  return null
}

// ── provenance: n-gram fingerprints of tool output ─────────────────────────

/** Token windows fingerprinted: whole short lines (3, 4 tokens) and 5-token shingles. */
const GRAM_SIZES = [3, 4, 5] as const
const BITS_PER_ITEM = 16
const HASHES = 7
const FIRST_SEGMENT_ITEMS = 1 << 14
/** Upper bound on fingerprint memory; past it the filter is "overflowed". */
export const FILTER_MAX_BYTES = 8 * 1024 * 1024
/** Largest fingerprint a pending candidate may carry into the ledger. */
export const FILTER_MAX_PERSIST_BYTES = 2 * 1024 * 1024

export function contentTokens(text: string): string[] {
  const tokens: string[] = []
  for (const match of normalizeForChecks(text).matchAll(/[\p{L}\p{N}_]+/gu)) {
    const word = match[0]
    if (/[぀-ヿ㐀-鿿가-힯]/u.test(word)) {
      for (const ch of word) tokens.push(ch)
    } else {
      tokens.push(word)
    }
  }
  return tokens
}

function gramKey(tokens: string[], start: number, size: number): string {
  return `${size}|${tokens.slice(start, start + size).join(' ')}`
}

function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

interface FilterSegment {
  bits: Uint8Array
  capacity: number
  count: number
}

/**
 * Scalable bloom filter over n-grams of text the agent did not write.
 * Each segment holds 16 bits per item with 7 hashes (false positives
 * ~0.07% per n-gram at capacity); a full segment is followed by one twice
 * its size. Past FILTER_MAX_BYTES the filter stops growing and reports
 * overflow, and callers then treat every line of unknown provenance as
 * copied.
 */
export class UntrustedShingleFilter {
  private segments: FilterSegment[] = []
  overflow = false

  /** Fingerprint a whole text (all of it — there is no character budget). */
  addText(text: string): void {
    if (!text || this.overflow) return
    const tokens = contentTokens(text)
    for (let start = 0; start < tokens.length; start++) {
      for (const size of GRAM_SIZES) {
        if (start + size > tokens.length) break
        this.add(gramKey(tokens, start, size))
        if (this.overflow) return
      }
    }
  }

  /**
   * addText() for large outputs, off the hot path: tokens are hashed in
   * slices with a yield to the event loop between them, so a run's tool
   * output never blocks the process for long.
   */
  async addTextChunked(text: string, tokensPerSlice = 20_000): Promise<void> {
    if (!text || this.overflow) return
    const tokens = contentTokens(text)
    for (let start = 0; start < tokens.length; start++) {
      for (const size of GRAM_SIZES) {
        if (start + size > tokens.length) break
        this.add(gramKey(tokens, start, size))
        if (this.overflow) return
      }
      if (start > 0 && start % tokensPerSlice === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  /** Give up on exact provenance (budget exceeded): every unknown line counts as copied. */
  markOverflow(): void {
    this.overflow = true
  }

  static fromTexts(texts: string[]): UntrustedShingleFilter {
    const filter = new UntrustedShingleFilter()
    for (const text of texts) filter.addText(text)
    return filter
  }

  private positions(key: string, totalBits: number): number[] {
    const h1 = fnv1a(key, 0x811c9dc5)
    const h2 = fnv1a(key, 0x9747b28c) | 1
    const out: number[] = []
    for (let i = 0; i < HASHES; i++) out.push(((h1 + Math.imul(i, h2)) >>> 0) % totalBits)
    return out
  }

  add(key: string): void {
    if (this.overflow) return
    let segment = this.segments.at(-1)
    if (!segment || segment.count >= segment.capacity) {
      const capacity = segment ? segment.capacity * 2 : FIRST_SEGMENT_ITEMS
      const bytes = (capacity * BITS_PER_ITEM) / 8
      if (this.byteSize() + bytes > FILTER_MAX_BYTES) {
        this.overflow = true
        return
      }
      segment = { bits: new Uint8Array(bytes), capacity, count: 0 }
      this.segments.push(segment)
    }
    for (const bit of this.positions(key, segment.bits.length * 8)) segment.bits[bit >>> 3]! |= 1 << (bit & 7)
    segment.count++
  }

  has(key: string): boolean {
    return this.segments.some((segment) =>
      this.positions(key, segment.bits.length * 8).every((bit) => (segment.bits[bit >>> 3]! & (1 << (bit & 7))) !== 0))
  }

  byteSize(): number {
    return this.segments.reduce((total, segment) => total + segment.bits.length, 0)
  }

  isEmpty(): boolean {
    return !this.overflow && this.segments.every((segment) => segment.count === 0)
  }

  /** Serialized form for the ledger (JSON string). */
  toBase64(): string {
    return JSON.stringify({
      v: 2,
      overflow: this.overflow,
      segments: this.segments.map((segment) => ({ capacity: segment.capacity, count: segment.count, bits: Buffer.from(segment.bits).toString('base64') })),
    })
  }

  static fromBase64(encoded: string | undefined): UntrustedShingleFilter {
    const filter = new UntrustedShingleFilter()
    if (!encoded) return filter
    try {
      const parsed = JSON.parse(encoded) as { v?: number; overflow?: boolean; segments?: Array<{ capacity: number; count: number; bits: string }> }
      if (parsed.v !== 2 || !Array.isArray(parsed.segments)) throw new Error('unknown filter format')
      filter.overflow = parsed.overflow === true
      filter.segments = parsed.segments.map((segment) => ({
        capacity: segment.capacity,
        count: segment.count,
        bits: new Uint8Array(Buffer.from(segment.bits, 'base64')),
      }))
    } catch {
      // Unreadable fingerprint: nothing about the run's output is known, so treat it as overflowed.
      filter.overflow = true
    }
    return filter
  }
}

/** n-grams (3/4/5) of the user's own text: copies of these are never "from tool output". */
export function trustedGrams(text: string): Set<string> {
  const tokens = contentTokens(text)
  const out = new Set<string>()
  for (let start = 0; start < tokens.length; start++) {
    for (const size of GRAM_SIZES) {
      if (start + size <= tokens.length) out.add(gramKey(tokens, start, size))
    }
  }
  return out
}

/**
 * True when a line repeats tool output the user's own text does not contain.
 * Lines of 3–4 tokens are checked whole; longer lines by 5-token shingles
 * (two hits, or 30% of them). With an overflowed filter, any line of 3+
 * tokens not entirely covered by the user's text counts as copied.
 */
export function copiedFromUntrusted(line: string, untrusted: UntrustedShingleFilter, trusted: Set<string>): boolean {
  const tokens = contentTokens(line)
  if (tokens.length < 3) return false
  const keys = tokens.length <= 4
    ? [gramKey(tokens, 0, tokens.length)]
    : Array.from({ length: tokens.length - 4 }, (_, start) => gramKey(tokens, start, 5))
  const unknown = keys.filter((key) => !trusted.has(key))
  if (unknown.length === 0) return false
  if (untrusted.overflow) return true
  const hits = unknown.filter((key) => untrusted.has(key)).length
  if (tokens.length <= 4) return hits > 0
  return hits >= 2 || hits / keys.length >= 0.3
}

// ── redaction ──────────────────────────────────────────────────────────────

const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"`]+@/gi
const SECRET_FLAG_RE = /(--(?:password|passwd|pass|pwd|token|api[-_]?key|access[-_]?key|secret(?:[-_]key)?|client[-_]secret|auth(?:-token)?)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi
const MYSQL_PASSWORD_RE = /(\s)-p(?![\s-])\S+/g
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g
const CN_MOBILE_RE = /(?<![\d.\w])1[3-9]\d{9}(?![\d.\w])/g
const PHONE_CANDIDATE_RE = /(?<![\w.:/-])(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{2,8}(?:[\s-]\d{2,8}){1,4}(?![\w.:/-])/g
const UNC_PATH_RE = /\\\\[^\s\\]+\\[^\s"'`<>|]+/g
const HOME_VAR_PATH_RE = /(?:\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%)(?:[\\/][^\s"'`<>|;]*)?/gi
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s"'`<>|]+/g
const POSIX_PATH_RE = /(^|[\s"'`(=:,[<>|])(~?\/[\w.@+-]+(?:\/[\w.@+-]+)*\/?)/g
const PLACEHOLDER_RE = /<(?:url|email|phone|path|redacted)>|\[REDACTED_SECRET\]/g

function isInside(child: string, root: string): boolean {
  const relative = path.relative(root, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function rewritePath(raw: string, cwd: string): string {
  const expanded = raw.startsWith('~') ? path.join(homedir(), raw.slice(1)) : raw
  const resolved = path.resolve(expanded)
  if (cwd && isInside(resolved, path.resolve(cwd))) {
    const relative = path.relative(path.resolve(cwd), resolved)
    return relative ? `./${relative.split(path.sep).join('/')}` : '.'
  }
  return '<path>'
}

/**
 * A phone number: an explicit +country prefix, an area code in
 * parentheses, or a group of 7+ digits (a subscriber number) — never a
 * list of short numbers (ports, sizes), a thousands-separated number, a
 * version or an IP (dots never join groups). Chinese mobiles are matched
 * separately.
 */
function looksLikePhone(candidate: string): boolean {
  const trimmed = candidate.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 9 || digits.length > 15) return false
  if (/^\d{1,3}(?:[ ,]\d{3})+$/.test(trimmed)) return false
  if (trimmed.startsWith('+') || /\(\d+\)/.test(trimmed)) return true
  return trimmed.split(/[\s-]+/).some((group) => group.length >= 7)
}

function redactCore(line: string, cwd: string, user: UserLocations): string {
  let text = line.replace(URL_CREDENTIALS_RE, '$1<redacted>@')
  text = redactSecrets(text)
  text = text.replace(SECRET_FLAG_RE, '$1<redacted>')
  if (/\b(?:mysql|mariadb|mysqldump|mysqladmin)\b/i.test(text)) text = text.replace(MYSQL_PASSWORD_RE, '$1-p<redacted>')
  const kept: string[] = []
  const hold = (value: string): string => {
    kept.push(value)
    return `\uE000${kept.length - 1}\uE001`
  }
  const judge = (raw: string): string => {
    if (/^file:/i.test(raw) || raw.includes('<redacted>')) return hold('<url>')
    const location = parseLocation(raw)
    return hold(location && userWroteLocation(location, user) ? raw.replace(/[?#].*$/, '') : '<url>')
  }
  text = text.replace(URL_RE, judge)
  text = text.replace(EMAIL_RE, () => hold('<email>'))
  text = text.replace(BARE_HOST_RE, (raw) => judge(raw))
  text = text.replace(CN_MOBILE_RE, () => hold('<phone>'))
  text = text.replace(PHONE_CANDIDATE_RE, (candidate) => (looksLikePhone(candidate) ? hold('<phone>') : candidate))
  text = text.replace(UNC_PATH_RE, '<path>')
  text = text.replace(HOME_VAR_PATH_RE, (raw) => rewritePath(`~${raw.replace(/^(?:\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%)/i, '').replace(/\\/g, '/')}`, cwd))
  text = text.replace(WINDOWS_PATH_RE, (raw) => rewritePath(raw, cwd))
  // Needs a boundary before the slash and a segment after it, so "and/or" and "(~2 min)" stay.
  text = text.replace(POSIX_PATH_RE, (_match, lead: string, raw: string) => `${lead}${rewritePath(raw, cwd)}`)
  return text.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => kept[Number(index)] ?? '<url>')
}

/**
 * Redact one line, keeping it as written. URLs and bare hosts survive only
 * when the user's own text names the same host (and path). When the NFKC
 * form (full-width letters folded) reveals more to redact, that form is used.
 */
export function redactSkillLine(line: string, cwd: string, user: UserLocations): string {
  const asWritten = redactCore(line, cwd, user)
  const folded = line.normalize('NFKC')
  if (folded === line) return asWritten
  const viaFolded = redactCore(folded, cwd, user)
  const count = (value: string): number => value.match(PLACEHOLDER_RE)?.length ?? 0
  return count(viaFolded) > count(asWritten) ? viaFolded : asWritten
}

// ── drafts ─────────────────────────────────────────────────────────────────

export interface SkillSanitizeContext {
  cwd: string
  /** The user's own messages. The only text whose URLs, hosts and n-grams are trusted. */
  userText: string
  /** Stored skills the run loaded: already sanitized, so their n-grams are trusted too. */
  storedSkillText?: string
  /** Fingerprints of everything tools returned in the run. */
  untrusted?: UntrustedShingleFilter
}

interface PreparedContext extends SkillSanitizeContext {
  grams: Set<string>
  user: UserLocations
}

export function prepareSanitizeContext(ctx: SkillSanitizeContext): PreparedContext {
  return {
    ...ctx,
    grams: trustedGrams(`${ctx.userText}\n${ctx.storedSkillText ?? ''}`),
    user: userLocations(ctx.userText),
  }
}

/** Why a line was dropped (for tests and diagnostics), or null when it is kept. */
export function rejectReason(line: string, ctx: PreparedContext): string | null {
  if (looksLikeInjectedInstruction(line)) return 'injected instruction'
  const danger = dangerousOperation(line, ctx.userText)
  if (danger) return danger
  if (ctx.untrusted && copiedFromUntrusted(line, ctx.untrusted, ctx.grams)) return 'copied from tool output'
  return null
}

/** Clean, check and redact one line; null when it must be dropped. */
export function sanitizeSkillLine(value: unknown, ctx: PreparedContext, maxChars: number): string | null {
  const line = clampLine(cleanSkillText(value), 2_000)
  if (!line || rejectReason(line, ctx)) return null
  const redacted = clampLine(redactSkillLine(line, ctx.cwd, ctx.user), maxChars)
  return redacted || null
}

function sanitizeList(values: unknown, ctx: PreparedContext, maxItems: number, maxChars: number): string[] {
  const items = Array.isArray(values) ? values : []
  const out: string[] = []
  for (const item of items) {
    const line = sanitizeSkillLine(item, ctx, maxChars)
    if (line) out.push(line)
    if (out.length >= maxItems) break
  }
  return out
}

/** Sanitize a raw curator draft; dropped lines simply disappear. */
export function sanitizeSkillDraft(raw: Partial<Record<keyof SkillDraft, unknown>>, ctx: SkillSanitizeContext): SkillDraft {
  const prepared = prepareSanitizeContext(ctx)
  return {
    name: slugifySkillId(clampLine(cleanSkillText(raw.name), SKILL_LIMITS.name)),
    description: sanitizeSkillLine(raw.description, prepared, SKILL_LIMITS.description) ?? '',
    triggers: sanitizeList(raw.triggers, prepared, SKILL_LIMITS.triggers, SKILL_LIMITS.trigger)
      .filter((trigger) => !/[<[\]]/.test(trigger)),
    steps: sanitizeList(raw.steps, prepared, SKILL_LIMITS.steps, SKILL_LIMITS.step),
    pitfalls: sanitizeList(raw.pitfalls, prepared, SKILL_LIMITS.pitfalls, SKILL_LIMITS.pitfall),
    tools: Array.isArray(raw.tools) ? raw.tools.map((tool) => String(tool).trim()).filter((tool) => /^[\w.-]{1,48}$/.test(tool)) : [],
    verification: sanitizeSkillLine(raw.verification, prepared, SKILL_LIMITS.verification) ?? '',
    sourceTaskSummary: sanitizeSkillLine(raw.sourceTaskSummary, prepared, SKILL_LIMITS.sourceTaskSummary) ?? '',
  }
}

// ── display ────────────────────────────────────────────────────────────────

/**
 * Text shown to the model inside the index or a loaded skill: one line, no
 * brackets (which could close the "reference data" frame or fake a runtime
 * note), no code fences, no leading markdown heading.
 */
export function displaySafe(text: string): string {
  return cleanSkillText(text)
    .replace(/\s+/g, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/`{3,}/g, "'''")
    .replace(/^#+\s*/, '')
    .trim()
}
