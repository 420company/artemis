/**
 * security/approvals.ts — hard approvals for sensitive actions.
 *
 * Some actions must never run on the model's word alone: high-risk shell
 * commands, deleting files outside the workspace, sending messages on the
 * owner's behalf, paying or buying, publishing or sharing outside, and the
 * model's own explicit questions (request_user_confirmation). Each falls into
 * an approval kind with a per-kind policy mode (approvals.json in the data
 * dir): `ask` (default), `allow` or `deny`.
 *
 * What "ask" does depends on the host:
 *  - interactive (CLI, chat bridges): the runtime's confirmation callback
 *    asks right away and the action runs only on a yes;
 *  - headless with suspension (`artemis execute`): the action is NOT run. A
 *    pending approval is stored in the session (the exact action and its
 *    digest), `[approval-request] {...}` is printed for the host, and the
 *    run ends with APPROVAL_REQUIRED_EXIT_CODE. The host keeps the digest and
 *    later runs `artemis execute --session <id> --approve <requestId>
 *    --signature <sig>` (or `--deny`): the answer is signed with the host's
 *    Ed25519 key over the request id, session, digest, decision and expiry;
 *    the engine only holds the public key (ARTEMIS_APPROVAL_PUBKEY), so the
 *    agent, which runs as the engine's user, cannot produce an answer. The
 *    stored action then runs exactly once and the model goes on;
 *  - anything else: the action is refused, as before this module existed.
 *
 * Tools that need an approval for something only they know about (a
 * purchase, a publish) call `requireApproval(kind, request)` from inside
 * their execute function; the same policy, suspension and single-use checks
 * apply. See src/docs/APPROVALS.md for the protocol.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { UiLocale } from '../cli/locale.js'
import type { AgentAction, SessionRecord } from '../core/types.js'
import type { ToolError } from '../tools/types.js'
import { resolveArtemisHomeDir, resolveDataRootDir } from '../utils/fs.js'
import { isSyntheticUserMessage } from '../core/compaction/language.js'
import { analyzeDeletes, describeHighRiskCommand, DESTRUCTIVE_TOKEN, isInsideWorkspace, isTemporaryPath, readOnlyServerCommand } from './shellRisk.js'

// ── Kinds, modes, policy ────────────────────────────────────────────────────

export const APPROVAL_KINDS = [
  'confirmation',
  'shell_high_risk',
  'delete_outside_workspace',
  'outbound_send',
  'payment',
  'publish',
  'external_action',
] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]
export type ApprovalMode = 'ask' | 'allow' | 'deny'
export type ApprovalRisk = 'low' | 'medium' | 'high'

/** Kinds the owner can set; `confirmation` (the model asking a question) always asks. */
export const CONFIGURABLE_APPROVAL_KINDS: readonly ApprovalKind[] = [
  'shell_high_risk',
  'delete_outside_workspace',
  'outbound_send',
  'payment',
  'publish',
  'external_action',
]

export const DEFAULT_APPROVAL_MODES: Readonly<Record<ApprovalKind, ApprovalMode>> = {
  confirmation: 'ask',
  shell_high_risk: 'ask',
  delete_outside_workspace: 'ask',
  outbound_send: 'ask',
  payment: 'ask',
  publish: 'ask',
  // An external service's tool that does not say it only reads.
  external_action: 'ask',
}

/** A pending approval expires after this long unless the policy says otherwise. */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60_000
const MIN_TTL_MS = 60_000
const MAX_TTL_MS = 7 * 24 * 60 * 60_000

/** `artemis execute` exit code: the run stopped at an approval request (nothing sensitive ran). */
export const APPROVAL_REQUIRED_EXIT_CODE = 10
/** `artemis execute --approve/--deny` exit code: the answer was refused (unknown, used, expired, changed). */
export const APPROVAL_REJECTED_EXIT_CODE = 11

export const APPROVAL_REQUEST_PREFIX = '[approval-request]'
export const APPROVAL_RESULT_PREFIX = '[approval-result]'
export const APPROVAL_ID_PATTERN = /^apr_[0-9a-f]{20}$/

/** Policy file name, looked up in the global data dir, then the workspace data dir (which wins). */
export const APPROVAL_POLICY_FILE = 'approvals.json'
/**
 * HMAC key that binds stored actions to their approval records. It lives
 * with the engine, so it only catches accidental edits; the boundary is the
 * host's signature (below) over the digest the host kept.
 */
export const APPROVAL_KEY_FILE = 'approvals.key'
/**
 * The host's Ed25519 public key (base64 SPKI DER). Requests created in a run
 * that had it are bound to it: only an answer signed with the matching
 * private key (which only the host holds) is accepted.
 */
export const APPROVAL_PUBKEY_ENV = 'ARTEMIS_APPROVAL_PUBKEY'
/** Set in the environment of every shell command the agent runs. */
export const AGENT_TOOL_ENV = 'ARTEMIS_AGENT_TOOL'
/** `off` turns headless suspension off (ask-mode actions are refused instead). */
export const APPROVALS_ENV = 'ARTEMIS_APPROVALS'
/**
 * The host's copy of the owner's policy (`{"modes":{…},"ttlMinutes":…}`),
 * applied over the policy files. A host keeps it where the agent cannot
 * write (the web server's own data dir) and passes it with every run.
 */
export const APPROVAL_POLICY_ENV = 'ARTEMIS_APPROVAL_POLICY'

export interface ApprovalPolicy {
  modes: Record<ApprovalKind, ApprovalMode>
  ttlMs: number
  /**
   * Per-service / per-tool modes for external (MCP) tools, keyed
   * `server/tool` or `server/*`; they win over the kind's mode.
   */
  tools: Record<string, ApprovalMode>
  /**
   * Per-tool modes from the policy files. They can only make a tool
   * stricter than what the host decided, never looser.
   */
  floors?: Record<string, ApprovalMode>
  /**
   * The connected services the host's connectors broker serves, by MCP
   * server id (`conn_<connection>`) → the broker's exact URL. The broker
   * asks the owner before every write on its own card, so a tool of such a
   * server runs without a second request here, but only when the live MCP
   * config still points that server at that URL (the config is the agent's
   * to write: a name alone proves nothing). Only the host's copy sets it.
   */
  connectorServers?: Record<string, string>
  /**
   * The host's own defaults for its tools (`artemis_online/*: allow`), apart
   * from the owner's entries in `tools`: a kind the owner turned off
   * (`deny`) wins over a default, never over the owner's own entry for
   * that exact tool. Only the host's copy sets it.
   */
  defaults?: Record<string, ApprovalMode>
  /**
   * The host's own MCP servers by id → their exact URL (`artemis_online`).
   * An `allow` for a tool of such a server (a default or an owner's entry)
   * holds only while the live MCP config still points that id at that URL;
   * otherwise the kind's mode applies. Only the host's copy sets it.
   */
  hostServers?: Record<string, string>
}

/** MCP server ids the host's connectors broker uses (`conn_<connection>`). */
export const CONNECTOR_SERVER = /^conn_[A-Za-z0-9_.-]{1,120}$/
const MAX_CONNECTOR_SERVERS = 200

/** The same URL, written either way (case of scheme and host, default port, trailing slash). */
export function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  try {
    const left = new URL(a)
    const right = new URL(b)
    if (!/^https?:$/.test(left.protocol) || left.username || left.password || right.username || right.password) return false
    const norm = (u: URL) => `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`
    return norm(left) === norm(right)
  } catch {
    return false
  }
}

function connectorServersOf(raw: unknown, ids: RegExp = CONNECTOR_SERVER): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [id, url] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_CONNECTOR_SERVERS)) {
    if (!ids.test(id) || typeof url !== 'string') continue
    try {
      if (/^https?:$/.test(new URL(url).protocol)) out[id] = url
    } catch {
      // Not a URL: ignored.
    }
  }
  return Object.keys(out).length ? out : undefined
}

function isMode(value: unknown): value is ApprovalMode {
  return value === 'ask' || value === 'allow' || value === 'deny'
}

export function isApprovalKind(value: unknown): value is ApprovalKind {
  return typeof value === 'string' && (APPROVAL_KINDS as readonly string[]).includes(value)
}

type PolicyData = Partial<{ modes: Record<string, unknown>; tools: Record<string, unknown>; ttlMinutes: unknown; connectorServers: unknown; defaults: unknown; hostServers: unknown }>

function readPolicyFile(file: string): PolicyData | undefined {
  try {
    return parsePolicy(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function parsePolicy(text: string): PolicyData | undefined {
  try {
    const raw = JSON.parse(text) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PolicyData) : undefined
  } catch {
    return undefined
  }
}

const STRICTNESS: Record<ApprovalMode, number> = { allow: 0, ask: 1, deny: 2 }
/** The stricter of two modes. */
function tighter(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return STRICTNESS[b] > STRICTNESS[a] ? b : a
}

const TOOL_KEY = /^[A-Za-z0-9_.-]{1,64}\/(?:\*|[A-Za-z0-9_.:-]{1,128})$/

/**
 * The policy for a workspace.
 *
 * The base is the host's copy (ARTEMIS_APPROVAL_POLICY: the owner's choices
 * as the web server keeps them, where the agent cannot write), or the
 * defaults (everything asks). The policy files (`<home>/approvals.json`,
 * `<workspace data root>/approvals.json`) can only TIGHTEN it: ask → deny,
 * allow → ask, a shorter expiry; never the other way, so a file the agent
 * can reach cannot relax anything. `confirmation` always asks.
 */
export function loadApprovalPolicy(cwd: string, env: NodeJS.ProcessEnv = process.env): ApprovalPolicy {
  const modes: Record<ApprovalKind, ApprovalMode> = { ...DEFAULT_APPROVAL_MODES }
  const tools: Record<string, ApprovalMode> = {}
  const floors: Record<string, ApprovalMode> = {}
  let ttlMs = DEFAULT_APPROVAL_TTL_MS
  const ttlOf = (data: PolicyData): number | undefined => {
    const minutes = Number(data.ttlMinutes)
    return Number.isFinite(minutes) && minutes > 0 ? Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, minutes * 60_000)) : undefined
  }
  const host = env[APPROVAL_POLICY_ENV]?.trim() ? parsePolicy(env[APPROVAL_POLICY_ENV]) : undefined
  if (host) {
    for (const [kind, mode] of Object.entries(host.modes && typeof host.modes === 'object' ? host.modes : {})) {
      if (isApprovalKind(kind) && kind !== 'confirmation' && isMode(mode)) modes[kind] = mode
    }
    for (const [key, mode] of Object.entries(host.tools && typeof host.tools === 'object' ? host.tools : {})) {
      if (TOOL_KEY.test(key) && isMode(mode)) tools[key] = mode
    }
    ttlMs = ttlOf(host) ?? ttlMs
  }
  // Only from the host's copy: a policy file the agent can write never names a broker, a default or a host server.
  const connectorServers = connectorServersOf(host?.connectorServers)
  const hostServers = connectorServersOf(host?.hostServers, /^[A-Za-z0-9_.-]{1,64}$/)
  const defaults: Record<string, ApprovalMode> = {}
  for (const [key, mode] of Object.entries(host?.defaults && typeof host.defaults === 'object' ? host.defaults : {})) {
    if (TOOL_KEY.test(key) && isMode(mode)) defaults[key] = mode
  }
  const files = [...new Set([path.join(resolveArtemisHomeDir(), APPROVAL_POLICY_FILE), path.join(resolveDataRootDir(cwd), APPROVAL_POLICY_FILE)])]
  for (const data of files.map((file) => readPolicyFile(file))) {
    if (!data) continue
    for (const [kind, mode] of Object.entries(data.modes && typeof data.modes === 'object' ? data.modes : {})) {
      if (isApprovalKind(kind) && kind !== 'confirmation' && isMode(mode)) modes[kind] = tighter(modes[kind], mode)
    }
    for (const [key, mode] of Object.entries(data.tools && typeof data.tools === 'object' ? data.tools : {})) {
      if (TOOL_KEY.test(key) && isMode(mode) && mode !== 'allow') floors[key] = tighter(floors[key] ?? 'allow', mode)
    }
    const fileTtl = ttlOf(data)
    if (fileTtl !== undefined) ttlMs = Math.min(ttlMs, fileTtl)
  }
  return {
    modes,
    ttlMs,
    tools,
    floors,
    ...(connectorServers ? { connectorServers } : {}),
    ...(Object.keys(defaults).length ? { defaults } : {}),
    ...(hostServers ? { hostServers } : {}),
  }
}

/** The URL the live MCP config gives a server (undefined for none, stdio, or an unreadable config). */
export async function liveMcpServerUrl(cwd: string, serverId: string): Promise<string | undefined> {
  try {
    const { McpServerStore } = await import('../mcp/store.js')
    const data = await new McpServerStore(cwd).load()
    const server = data.servers.find((entry) => entry.id === serverId)
    return server && server.transport !== 'stdio' ? server.url : undefined
  } catch {
    return undefined
  }
}

/** The id of a server the host names (a broker's or its own), and the URL it must be at. */
function namedServerUrl(policy: ApprovalPolicy, serverId: string): string | undefined {
  const own = (map: Record<string, string> | undefined) => (map && Object.prototype.hasOwnProperty.call(map, serverId) ? map[serverId] : undefined)
  return own(policy.hostServers) ?? own(policy.connectorServers)
}

/** Whether the gate needs the live URL of this tool's server (it is one the host names). */
export function needsServerUrl(policy: ApprovalPolicy, serverId: string): boolean {
  return namedServerUrl(policy, serverId) !== undefined
}

/**
 * The mode for an external tool:
 *  1. the owner's own entry for that exact tool;
 *  2. a kind the owner turned off (`deny`) — over every default and the
 *     broker's gate;
 *  3. the owner's entry for the service, the host's defaults for the tool
 *     and the service, a connected service the host's broker serves
 *     (allow), then the kind's mode.
 * A server the host names (its own, or a broker's) counts only at its URL
 * (`live.serverUrl`, from the config the call will use): elsewhere no
 * `allow` applies to it, whatever said so. Policy files only tighten.
 */
export function modeFor(policy: ApprovalPolicy, kind: ApprovalKind, toolKey?: string, live: { serverUrl?: string | undefined } = {}): ApprovalMode {
  if (kind === 'confirmation') return 'ask'
  if (!toolKey) return policy.modes[kind]
  const service = `${toolKey.split('/')[0]}/*`
  const serverId = toolKey.split('/')[0]!
  const named = namedServerUrl(policy, serverId)
  const atItsUrl = named !== undefined && sameUrl(named, live.serverUrl)
  // An `allow` for a named server that is not where the host said: not applied.
  const usable = (mode: ApprovalMode | undefined) => (mode === 'allow' && named !== undefined && !atItsUrl ? undefined : mode)
  // A connected service's writes are approved by the host's connectors broker on its own card.
  const brokerGate = Object.prototype.hasOwnProperty.call(policy.connectorServers ?? {}, serverId) && atItsUrl ? 'allow' : undefined
  const base =
    usable(policy.tools[toolKey]) ??
    (policy.modes[kind] === 'deny'
      ? 'deny'
      : (usable(policy.tools[service]) ?? usable(policy.defaults?.[toolKey]) ?? usable(policy.defaults?.[service]) ?? brokerGate ?? policy.modes[kind]))
  const floor = tighter(policy.floors?.[toolKey] ?? 'allow', policy.floors?.[service] ?? 'allow')
  return tighter(base, floor)
}

// ── Records ─────────────────────────────────────────────────────────────────

/** What the host shows the owner. Never contains the raw action. */
export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  title: string
  summary: string
  /**
   * The facts the owner approves, with stable keys (command, to, cc, bcc,
   * attachments, amount, currency, quantity, args, paths, ...). Never cut
   * silently: a value over MAX_DETAIL_CHARS is cut and `truncated` is set.
   */
  details: Record<string, string>
  /** A detail was too long to send in full (the host shows that, and approves on the full card only). */
  truncated?: boolean
  risk: ApprovalRisk
  createdAt: string
  expiresAt: string
  sessionId: string
  locale: UiLocale
  /**
   * sha256 of the exact stored action. The host keeps it and signs it into
   * its answer, so an action changed in the session files is refused.
   */
  actionDigest: string
  payloadDigest?: string
  /** `server/tool` of an external tool, for per-tool settings. */
  toolKey?: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'invalid'

/** Stored in the session (`session.approvals`). */
export interface PendingApproval extends ApprovalRequest {
  status: ApprovalStatus
  /** The exact action to run on approval. */
  action: AgentAction
  /** sha256 of the host's public key, when the run had one: only its signature answers. */
  hostBinding?: string
  /** The owner's message the request came from (the run continues on it). */
  requestMessageId?: string
  /** HMAC over what matters (see APPROVAL_KEY_FILE). */
  mac: string
  decidedAt?: string
  reason?: string
  /** Why it expired without an answer (`superseded`: the owner wrote again). */
  endedBy?: 'expired' | 'superseded'
}

/** What a resume hands to the run: the one action it may let through, once. */
export interface ApprovalGrant {
  id: string
  kind: ApprovalKind
  actionDigest: string
  payloadDigest?: string
}

/** Stable JSON: object keys sorted, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

let cachedKey: { file: string; key: Buffer } | undefined

/** The per-install HMAC key (created on first use, mode 0600). */
export function approvalKey(): Buffer {
  const file = path.join(resolveArtemisHomeDir(), APPROVAL_KEY_FILE)
  if (cachedKey?.file === file) return cachedKey.key
  let key: Buffer | undefined
  try {
    const text = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(text)) key = Buffer.from(text, 'hex')
  } catch {
    // Created below.
  }
  if (!key) {
    key = randomBytes(32)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    // A concurrent creator may have won: keep whichever is on disk.
    try {
      writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
    } catch {
      const text = readFileSync(file, 'utf8').trim()
      if (/^[0-9a-f]{64}$/.test(text)) key = Buffer.from(text, 'hex')
    }
  }
  cachedKey = { file, key }
  return key
}

function macOf(record: Omit<PendingApproval, 'mac' | 'status' | 'decidedAt' | 'reason' | 'endedBy'>): string {
  const bound = {
    v: 2,
    id: record.id,
    sessionId: record.sessionId,
    kind: record.kind,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    actionDigest: record.actionDigest,
    payloadDigest: record.payloadDigest ?? null,
    hostBinding: record.hostBinding ?? null,
  }
  return createHmac('sha256', approvalKey()).update(canonicalJson(bound)).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

/** The public part of a record (what `[approval-request]` carries). */
export function publicApproval(record: PendingApproval): ApprovalRequest {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    details: { ...record.details },
    ...(record.truncated ? { truncated: true } : {}),
    risk: record.risk,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    sessionId: record.sessionId,
    locale: record.locale,
    actionDigest: record.actionDigest,
    ...(record.payloadDigest ? { payloadDigest: record.payloadDigest } : {}),
    ...(record.toolKey ? { toolKey: record.toolKey } : {}),
  }
}

export function formatApprovalRequestLine(record: PendingApproval): string {
  return `${APPROVAL_REQUEST_PREFIX} ${JSON.stringify(publicApproval(record))}`
}

// ── The host's key and its signed answers ───────────────────────────────────

/** The host's public key from the environment, or undefined. */
export function hostApprovalKey(env: NodeJS.ProcessEnv = process.env): { key: KeyObject; id: string } | undefined {
  const raw = env[APPROVAL_PUBKEY_ENV]?.trim()
  if (!raw) return undefined
  try {
    const der = Buffer.from(raw, 'base64')
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') return undefined
    return { key, id: createHash('sha256').update(der).digest('hex') }
  } catch {
    return undefined
  }
}

/**
 * The bytes a host signs to answer a request (Ed25519, no prehash):
 * canonical JSON with sorted keys, e.g.
 * {"actionDigest":"…","approvalId":"apr_…","decision":"approve","expiresAt":"…","sessionId":"…","v":1}
 */
export function approvalAnswerPayload(answer: { approvalId: string; sessionId: string; actionDigest: string; decision: 'approve' | 'deny'; expiresAt: string }): Buffer {
  return Buffer.from(
    canonicalJson({ v: 1, approvalId: answer.approvalId, sessionId: answer.sessionId, actionDigest: answer.actionDigest, decision: answer.decision, expiresAt: answer.expiresAt }),
    'utf8',
  )
}

// ── User-facing text ────────────────────────────────────────────────────────

const t = (locale: UiLocale, zh: string, en: string) => (locale === 'zh-CN' ? zh : en)

function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

const PLATFORM_NAMES: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', wechat: '微信', all: '' }

/** Words of a tool name: `chat_postMessage` → chat post message; `eth_sendTransaction` → eth send transaction. */
/**
 * Letters from other scripts that look like Latin ones (Cyrillic, Greek and
 * a few others), so a tool named with them (`ѕend_mеssage`) is read as the
 * word it imitates. Full-width and styled letters are handled by NFKC.
 */
const CONFUSABLES: Record<string, string> = Object.fromEntries(
  [
    ['а', 'a'], ['в', 'b'], ['е', 'e'], ['ё', 'e'], ['к', 'k'], ['м', 'm'], ['н', 'h'], ['о', 'o'], ['р', 'p'], ['с', 'c'], ['т', 't'], ['у', 'y'], ['х', 'x'],
    ['ѕ', 's'], ['і', 'i'], ['ї', 'i'], ['ј', 'j'], ['ԁ', 'd'], ['ԛ', 'q'], ['ԝ', 'w'], ['ү', 'y'], ['һ', 'h'], ['ӏ', 'l'], ['ь', 'b'], ['п', 'n'], ['г', 'r'],
    ['А', 'A'], ['В', 'B'], ['Е', 'E'], ['К', 'K'], ['М', 'M'], ['Н', 'H'], ['О', 'O'], ['Р', 'P'], ['С', 'C'], ['Т', 'T'], ['Х', 'X'], ['Ѕ', 'S'], ['І', 'I'], ['Ј', 'J'], ['Ү', 'Y'],
    ['α', 'a'], ['β', 'b'], ['ε', 'e'], ['ι', 'i'], ['κ', 'k'], ['ν', 'v'], ['ο', 'o'], ['ρ', 'p'], ['τ', 't'], ['υ', 'u'], ['χ', 'x'], ['γ', 'y'],
    ['Α', 'A'], ['Β', 'B'], ['Ε', 'E'], ['Ζ', 'Z'], ['Η', 'H'], ['Ι', 'I'], ['Κ', 'K'], ['Μ', 'M'], ['Ν', 'N'], ['Ο', 'O'], ['Ρ', 'P'], ['Τ', 'T'], ['Υ', 'Y'], ['Χ', 'X'],
    ['ı', 'i'], ['ȷ', 'j'], ['ℓ', 'l'], ['ɡ', 'g'], ['ɑ', 'a'],
  ],
)

/** A tool name as the letters it shows: NFKC, accents and invisible characters removed, look-alike letters folded to Latin. */
export function foldToolName(name: string): string {
  return [...name.normalize('NFKC').normalize('NFD').replace(/\p{Mn}/gu, '').replace(/[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g, '')]
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join('')
    .normalize('NFC')
}

/** Every character outside printable ASCII as U+XXXX, so look-alikes and invisible ones show. */
function visibleName(name: string): string {
  return [...name].map((ch) => (/[\x20-\x7E]/.test(ch) ? ch : `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)).join('')
}

export function toolWords(name: string): string[] {
  return foldToolName(name)
    .replace(/^mcp__[^_]+__/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)
}

/** What the model or a tool needs approved, before it has an id. */
export interface ApprovalNeed {
  kind: ApprovalKind
  risk: ApprovalRisk
  details: Record<string, string>
  truncated?: boolean
  /** `server/tool` of an external tool (per-tool settings). */
  toolKey?: string
  /** Overrides the generated title / summary (a tool's own wording, or the model's question). */
  title?: string
  summary?: string
}

export function describeApprovalNeed(need: ApprovalNeed, locale: UiLocale): { title: string; summary: string } {
  const d = need.details
  const money = d.amount ? `${d.amount}${d.currency ? ` ${d.currency}` : ''}${d.quantity ? ` × ${d.quantity}` : ''}` : ''
  const generated = ((): { title: string; summary: string } => {
    switch (need.kind) {
      case 'confirmation':
        return { title: t(locale, '需要你确认', 'Your confirmation is needed'), summary: d.question ?? '' }
      case 'shell_high_risk':
        return {
          title: t(locale, '运行一条高风险命令', 'Run a high-risk command'),
          summary: t(
            locale,
            `这条命令${d.reasonZh ?? '有较高风险'}。只有你同意后才会运行。`,
            `This command ${d.reason ?? 'is high-risk'}. It runs only if you approve.`,
          ),
        }
      case 'delete_outside_workspace':
        return {
          title: t(locale, '删除或改写工作区以外的文件', 'Delete or overwrite files outside the workspace'),
          summary: d.paths
            ? t(locale, `涉及：${clip(d.paths, 160)}。无法恢复。`, `Affects: ${clip(d.paths, 160)}. This cannot be undone.`)
            : t(locale, '无法事先确定会删除哪些文件，只有你同意后才会运行。', 'Which files it removes cannot be known beforehand; it runs only if you approve.'),
        }
      case 'outbound_send':
        return {
          title: d.to ? t(locale, `代你发送到 ${clip(d.to, 60)}`, `Send to ${clip(d.to, 60)} on your behalf`) : t(locale, '代你对外发送消息', 'Send a message on your behalf'),
          summary: d.content
            ? t(locale, `内容：${clip(d.content, 160)}`, `Content: ${clip(d.content, 160)}`)
            : d.file
              ? t(locale, `文件：${d.file}`, `File: ${d.file}`)
              : t(locale, '发出后无法撤回。', 'Once sent it cannot be taken back.'),
        }
      case 'payment':
        return {
          title: t(locale, '付款或购买', 'Make a payment or purchase'),
          summary: money
            ? t(locale, `金额：${money}${d.merchant ? `，收款方：${d.merchant}` : ''}`, `Amount: ${money}${d.merchant ? `, to ${d.merchant}` : ''}`)
            : t(locale, '这一步会付款，只有你同意后才会进行。', 'This step makes a payment and runs only if you approve.'),
        }
      case 'publish':
        return {
          title: t(locale, '对外发布或分享', 'Publish or share outside'),
          summary: d.target
            ? t(locale, `发布到：${d.target}`, `Publish to: ${d.target}`)
            : t(locale, '发布后其他人可以看到。', 'Once published, others can see it.'),
        }
      case 'external_action':
        return {
          title: t(locale, `在外部服务执行操作：${clip(d.action ?? '', 40)}`, `Act in an outside service: ${clip(d.action ?? '', 40)}`),
          summary: t(
            locale,
            `服务「${d.service ?? ''}」没有说明这一步只读取数据，只有你同意后才会进行。`,
            `The service "${d.service ?? ''}" does not say this step only reads; it runs only if you approve.`,
          ),
        }
    }
  })()
  return {
    title: clip(need.title?.trim() || generated.title, 120),
    summary: clip(need.summary?.trim() || generated.summary, 600),
  }
}

// ── Classification ──────────────────────────────────────────────────────────

export interface ClassifyContext {
  cwd: string
  /** A chat bridge's own chat: sending media back to it is the reply itself, not an outbound send. */
  ownChat?: { platform?: string; targetId?: string }
  /** High-risk shell classifier (tools/runCommand.ts), injected to keep this module free of tool imports. */
  dangerousCommand?: (command: string) => { reason: string; reasonZh: string } | null
}

/** Extra rules: a tool (payment, publish, ...) registers how its actions are classified. */
export type ApprovalRule = (action: AgentAction, ctx: ClassifyContext) => ApprovalNeed | null
const extraRules: ApprovalRule[] = []

/** Hook point for tools added later (purchases, publishing): classify their actions. */
export function registerApprovalRule(rule: ApprovalRule): () => void {
  extraRules.push(rule)
  return () => {
    const index = extraRules.indexOf(rule)
    if (index >= 0) extraRules.splice(index, 1)
  }
}

/**
 * External tool name words. Read-only words (get, list, search, draft…)
 * never cancel these: `gmail_send_draft`, `search_and_buy` still ask.
 */
const PAYMENT_WORDS = new Set(['pay', 'payment', 'payments', 'purchase', 'checkout', 'buy', 'order', 'charge', 'transfer', 'withdraw', 'swap', 'trade', 'tip', 'donate', 'subscribe', 'invoice', 'refund', 'transaction', 'transactions', 'tx', 'sign', 'broadcast', 'mint', 'stake', 'bid'])
const OUTBOUND_WORDS = new Set(['send', 'post', 'reply', 'tweet', 'toot', 'email', 'mail', 'sms', 'dm', 'message', 'notify', 'invite', 'forward', 'submit', 'comment', 'respond'])
const PUBLISH_WORDS = new Set(['publish', 'share', 'deploy', 'release', 'upload', 'unpublish'])
const DESTRUCTIVE_WORDS = new Set(['delete', 'remove', 'drop', 'destroy', 'purge', 'truncate', 'wipe', 'erase', 'revoke', 'execute', 'exec', 'run', 'eval', 'write', 'update', 'overwrite', 'kill', 'terminate', 'reset', 'move', 'rename'])

/** Longest a single detail travels in full (it is cut beyond, and the request says so). */
export const MAX_DETAIL_CHARS = 20_000

function valueText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map((v) => (typeof v === 'string' ? v : typeof v === 'object' && v && 'name' in v ? String((v as { name: unknown }).name) : canonicalJson(v)))
    return parts.length ? parts.join(', ') : undefined
  }
  return canonicalJson(value)
}

function argText(args: Record<string, unknown> | undefined, ...names: string[]): string | undefined {
  for (const name of names) {
    const text = valueText(args?.[name])
    if (text) return text
  }
  return undefined
}

/** Details without blanks; a value over MAX_DETAIL_CHARS is cut and `truncated` set (never silently). */
function limitDetails(details: Record<string, string | undefined>): { details: Record<string, string>; truncated: boolean } {
  const out: Record<string, string> = {}
  let truncated = false
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === '') continue
    if (value.length > MAX_DETAIL_CHARS) {
      truncated = true
      out[key] = value.slice(0, MAX_DETAIL_CHARS)
    } else {
      out[key] = value
    }
  }
  return { details: out, truncated }
}

function need(kind: ApprovalKind, risk: ApprovalRisk, details: Record<string, string | undefined>, extra: Partial<ApprovalNeed> = {}): ApprovalNeed {
  const limited = limitDetails(details)
  return { kind, risk, details: limited.details, ...(limited.truncated ? { truncated: true } : {}), ...extra }
}

/** An external (MCP) tool call: classified by what its name says it does, and asked unless it is known to only read. */
export function classifyMcpCall(action: Extract<AgentAction, { type: 'mcp_call_tool' }>): ApprovalNeed | null {
  const words = toolWords(action.toolName)
  const has = (set: Set<string>) => words.some((w) => set.has(w))
  const args = action.args ?? {}
  const toolKey = `${action.serverId}/${action.toolName}`
  const base = {
    service: action.serverId,
    action: words.join(' '),
    // A name written with look-alike or invisible characters: the owner sees it as it really is.
    ...(foldToolName(action.toolName) !== action.toolName || /[^\x20-\x7E]/.test(action.toolName) ? { tool: visibleName(action.toolName) } : {}),
    // Everything the call carries, exactly (sorted keys): what the owner approves.
    args: canonicalJson(args),
  }
  if (has(PAYMENT_WORDS)) {
    return need('payment', 'high', {
      ...base,
      amount: argText(args, 'amount', 'value', 'total', 'price', 'amountWei', 'wei'),
      currency: argText(args, 'currency', 'token', 'asset', 'symbol', 'coin'),
      quantity: argText(args, 'quantity', 'qty', 'count'),
      merchant: argText(args, 'merchant', 'payee', 'recipient', 'to', 'seller'),
    }, { toolKey })
  }
  if (has(OUTBOUND_WORDS)) {
    return need('outbound_send', 'medium', {
      ...base,
      to: argText(args, 'to', 'recipient', 'recipients', 'chat', 'chatId', 'chat_id', 'channel', 'email', 'phone', 'user', 'url'),
      cc: argText(args, 'cc'),
      bcc: argText(args, 'bcc'),
      attachments: argText(args, 'attachments', 'attachment', 'files', 'file'),
      subject: argText(args, 'subject', 'title'),
      content: argText(args, 'text', 'body', 'message', 'content', 'html'),
    }, { toolKey })
  }
  if (has(PUBLISH_WORDS)) {
    return need('publish', 'medium', { ...base, target: argText(args, 'url', 'target', 'site', 'channel', 'name', 'title') }, { toolKey })
  }
  if (has(DESTRUCTIVE_WORDS)) return need('external_action', 'high', base, { toolKey })
  // Known to only read (the server's own annotation, never the model's word).
  if (action.readOnly === true) return null
  return need('external_action', 'medium', base, { toolKey })
}

/** True when a shell command tries to answer an approval itself (`artemis … --approve|--deny`). */
export function commandAnswersApproval(command: string): boolean {
  return /\bartemis\b[\s\S]{0,400}--(?:approve|deny)\b|--(?:approve|deny)\b[\s\S]{0,200}\bapr_[0-9a-f]/i.test(command)
}

/**
 * Whether an action needs an approval, and of which kind. Null for anything
 * that runs freely. When several apply, the riskiest kind wins.
 */
export function classifyApprovalNeed(action: AgentAction, ctx: ClassifyContext): ApprovalNeed | null {
  for (const rule of extraRules) {
    const found = rule(action, ctx)
    if (found) return found
  }
  switch (action.type) {
    case 'request_user_confirmation':
      return need('confirmation', 'medium', { question: action.question, screenshot: action.screenshotPath })
    case 'run_command': {
      const dangerous = ctx.dangerousCommand?.(action.command) ?? null
      const deletes = analyzeDeletes(action.command, ctx.cwd)
      if (dangerous) {
        return need('shell_high_risk', 'high', { command: action.command, reason: dangerous.reason, reasonZh: dangerous.reasonZh, paths: deletes.outside.join(', ') || undefined })
      }
      if (deletes.outside.length || deletes.unverifiable) {
        return need('delete_outside_workspace', 'high', {
          command: action.command,
          paths: deletes.outside.join(', ') || undefined,
          ...(deletes.unverifiable ? { unverifiable: deletes.unverifiable } : {}),
        })
      }
      return null
    }
    case 'bridge_send_image':
    case 'bridge_send_video': {
      const platform = action.platform ?? 'all'
      const own = ctx.ownChat
      if (own?.platform && own.platform === action.platform && (!action.targetId || action.targetId === own.targetId)) return null
      const file = action.type === 'bridge_send_image' ? action.imagePath : action.videoPath
      return need('outbound_send', 'medium', { to: PLATFORM_NAMES[platform] || undefined, file, content: action.caption, target: action.targetId })
    }
    case 'mcp_call_tool':
      return classifyMcpCall(action)
    // Office files and synthesized speech are written where the agent says:
    // inside the workspace (or the temp dir) that needs nothing; anywhere
    // else it would replace a file the owner may not have meant to touch.
    case 'create_presentation':
    case 'create_document':
    case 'create_spreadsheet':
    case 'synthesize_speech': {
      const target = outsideTarget(ctx, action.type === 'synthesize_speech' ? action.outputPath : action.path)
      return target ? need('delete_outside_workspace', 'high', { paths: target }) : null
    }
    // server_setup on a server the owner had the agent rent: setting it up
    // (keys, hardening, VPN, checks) is the task the owner asked for, and the
    // root password behind install_key is one the owner saved for exactly
    // that server, so those steps ask nothing more. forget_host_key asks the
    // owner itself (requireApproval, kind confirmation: always asks). `run`
    // is a command as root on the owner's server: only a short allowlist of
    // read-only commands with plain arguments runs freely
    // (readOnlyServerCommand); everything else asks, as a high-risk command.
    case 'server_setup': {
      const a = action as { action?: string; command?: unknown; host?: unknown }
      if (a.action !== 'run') return null
      const command = typeof a.command === 'string' ? a.command : ''
      if (readOnlyServerCommand(command)) return null
      const host = typeof a.host === 'string' ? a.host : undefined
      const risky = describeHighRiskCommand(command)
      if (risky) return need('shell_high_risk', 'high', { command, target: host, reason: risky.reason, reasonZh: risky.reasonZh })
      const shown = command.replace(/\d*>>?\s*\/dev\/null|\d*>&\d/g, '')
      if (DESTRUCTIVE_TOKEN.test(shown)) {
        return need('shell_high_risk', 'high', { command, target: host, reason: 'deletes or overwrites files on the server', reasonZh: '会删除或改写服务器上的文件' })
      }
      return need('shell_high_risk', 'medium', { command, target: host, reason: 'runs a command as root on the server', reasonZh: '会以管理员身份在服务器上运行一条命令' })
    }
    // A recognition program the agent names itself is a command like any other.
    case 'transcribe_audio':
      return action.command?.trim()
        ? need('shell_high_risk', 'high', {
          command: action.command,
          reason: 'runs a speech-recognition program the agent named',
          reasonZh: '会运行 agent 自己指定的语音识别程序',
        })
        : null
    default:
      return null
  }
}

/** A path outside the workspace and the temp dir (after following links), or undefined. */
function outsideTarget(ctx: ClassifyContext, raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const target = path.resolve(ctx.cwd, raw.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
  return isInsideWorkspace(ctx.cwd, target) || isTemporaryPath(target) ? undefined : target
}

/** Direct-tool names (interactive brain path) that are not AgentActions: delete_file / delete_directory / move_file. */
export function classifyDirectToolNeed(name: string, input: Record<string, unknown>, ctx: ClassifyContext): ApprovalNeed | null {
  const outside = (raw: unknown) => outsideTarget(ctx, raw)
  if (name === 'delete_file' || name === 'delete_directory') {
    const target = outside(input.path)
    return target ? need('delete_outside_workspace', 'high', { paths: target }) : null
  }
  if (name === 'move_file') {
    const targets = [outside(input.from), outside(input.to)].filter((p): p is string => !!p)
    return targets.length ? need('delete_outside_workspace', 'high', { paths: targets.join(', ') }) : null
  }
  return classifyApprovalNeed({ type: name, ...input } as AgentAction, ctx)
}

// ── Run-time gate ───────────────────────────────────────────────────────────

export type GateResult =
  | { ok: true; approvedKind?: ApprovalKind }
  | { ok: false; output: string; error: ToolError; pending?: PendingApproval }

export interface ApprovalRuntimeOptions {
  cwd: string
  locale: UiLocale
  policy: ApprovalPolicy
  /** Interactive hosts: ask now (true = approved). */
  ask?: (question: string) => Promise<boolean>
  /** Headless hosts that can stop and resume later. */
  suspend?: {
    session: SessionRecord
    persist: () => Promise<void>
    emit: (line: string) => void
    /** sha256 of the host's public key: only its signature can answer. */
    hostBinding?: string
  }
  /** The single action a resume may let through. */
  grant?: ApprovalGrant
  ownChat?: ClassifyContext['ownChat']
  dangerousCommand?: ClassifyContext['dangerousCommand']
  now?: () => Date
}

export class ApprovalRuntime {
  /** The request this run stopped at, if any. */
  pending: PendingApproval | undefined
  private grant: ApprovalGrant | undefined
  /** False while a step that cannot stop the run (the self-check's own command) is executing. */
  suspendable = true

  constructor(readonly options: ApprovalRuntimeOptions) {
    this.grant = options.grant
  }

  get classifyContext(): ClassifyContext {
    return {
      cwd: this.options.cwd,
      ...(this.options.ownChat ? { ownChat: this.options.ownChat } : {}),
      ...(this.options.dangerousCommand ? { dangerousCommand: this.options.dangerousCommand } : {}),
    }
  }

  get interactive(): boolean {
    return Boolean(this.options.ask)
  }

  /**
   * Classifies and checks an action before it runs, in the directory it
   * runs in. `resolved`: the MCP server entry the call will be made with
   * (read once by the caller); without it, the config in `cwd` is read.
   */
  async checkAction(action: AgentAction, cwd = this.options.cwd, resolved?: { url?: string }): Promise<GateResult> {
    const found = classifyApprovalNeed(action, { ...this.classifyContext, cwd })
    if (!found) return { ok: true }
    // A server the host names: its URL in the config the call uses.
    const serverUrl =
      action.type === 'mcp_call_tool' && needsServerUrl(this.options.policy, action.serverId)
        ? resolved
          ? resolved.url
          : await liveMcpServerUrl(cwd, action.serverId)
        : undefined
    return this.check(found, action, undefined, { serverUrl })
  }

  /** Applies the policy to one need of one action. */
  async check(found: ApprovalNeed, action: AgentAction, payloadDigest?: string, live: { serverUrl?: string | undefined } = {}): Promise<GateResult> {
    const { locale } = this.options
    const mode = modeFor(this.options.policy, found.kind, found.toolKey, live)
    const { title } = describeApprovalNeed(found, locale)
    if (mode === 'deny') {
      const message = t(
        locale,
        `已按你的设置拒绝：${title}。不要重试或换一种方式绕过，告诉用户这一步已被设置禁止。`,
        `Refused by the owner's settings: ${title}. Do not retry or work around it; tell the user this step is turned off in their settings.`,
      )
      return { ok: false, output: message, error: { code: 'approval_denied_by_policy', message, retryable: false } }
    }
    if (mode === 'allow') return { ok: true, approvedKind: found.kind }
    if (this.consumeGrant(found.kind, action, payloadDigest)) return { ok: true, approvedKind: found.kind }
    // The model's own question on an interactive host: the tool asks it itself (with its screenshot).
    // Only that tool: a tool's own confirmation (requireApproval, a payload) is asked here like any other.
    if (found.kind === 'confirmation' && this.options.ask && action.type === 'request_user_confirmation' && payloadDigest === undefined) return { ok: true }
    if (this.options.ask) {
      const { summary } = describeApprovalNeed(found, locale)
      const lines = [title, summary, ...Object.entries(found.details).filter(([k]) => k !== 'reasonZh' && k !== 'question').map(([k, v]) => `${k}: ${v}`)]
      const yes = await this.options.ask(lines.filter(Boolean).join('\n'))
      if (yes) return { ok: true, approvedKind: found.kind }
      const message = t(locale, `用户没有同意：${title}。停在这一步，不要重试。`, `The user did not approve: ${title}. Stop before this step; do not retry it.`)
      return { ok: false, output: message, error: { code: 'approval_declined', message, retryable: false } }
    }
    if (this.options.suspend && this.suspendable && !this.pending) {
      const record = this.createPending(found, action, payloadDigest)
      const store = this.options.suspend
      // The latest 50 records are kept (answered ones too: a second answer must find them used).
      store.session.approvals = [...(store.session.approvals ?? []).slice(-49), record]
      await store.persist()
      this.pending = record
      store.emit(formatApprovalRequestLine(record))
      const message = [
        `Waiting for the owner's approval (request ${record.id}: ${record.title}). The action has NOT run.`,
        'Do not retry it, do not try another way to do it, and do not ask again: the run pauses here and continues once the owner decides.',
      ].join(' ')
      return { ok: false, output: message, error: { code: 'approval_pending', message, retryable: false, details: { approvalId: record.id } }, pending: record }
    }
    const message = this.pending
      ? `Not run: another step of this run is already waiting for the owner's approval (${this.pending.id}). Wait for that decision first.`
      : t(
          locale,
          `这一步需要用户同意（${title}），但当前没有可以确认的渠道，所以没有执行。请告诉用户需要他确认什么。`,
          `This step needs the user's approval (${title}) but no approval channel is available here, so it did not run. Tell the user what needs their approval.`,
        )
    return { ok: false, output: message, error: { code: 'approval_unavailable', message, retryable: false } }
  }

  private consumeGrant(kind: ApprovalKind, action: AgentAction, payloadDigest?: string): boolean {
    const grant = this.grant
    if (!grant || grant.kind !== kind) return false
    if (payloadDigest !== undefined ? grant.payloadDigest !== payloadDigest : grant.actionDigest !== digestOf(action)) return false
    this.grant = undefined
    return true
  }

  private createPending(found: ApprovalNeed, action: AgentAction, payloadDigest?: string): PendingApproval {
    const { session, hostBinding } = this.options.suspend!
    const now = (this.options.now ?? (() => new Date()))()
    const { title, summary } = describeApprovalNeed(found, this.options.locale)
    const details = { ...found.details }
    delete details.reasonZh
    const requestMessageId = [...session.messages].reverse().find((m) => m.role === 'user' && !isSyntheticUserMessage(m))?.id
    const base = {
      id: `apr_${randomBytes(10).toString('hex')}`,
      kind: found.kind,
      title,
      summary,
      details,
      ...(found.truncated ? { truncated: true } : {}),
      risk: found.risk,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.options.policy.ttlMs).toISOString(),
      sessionId: session.rootSessionId ?? session.id,
      locale: this.options.locale,
      action,
      actionDigest: digestOf(action),
      ...(payloadDigest ? { payloadDigest } : {}),
      ...(found.toolKey ? { toolKey: found.toolKey } : {}),
      ...(hostBinding ? { hostBinding } : {}),
      ...(requestMessageId ? { requestMessageId } : {}),
    }
    return { ...base, status: 'pending', mac: macOf(base) }
  }
}

// ── Tool-facing API ─────────────────────────────────────────────────────────

interface ApprovalScope {
  runtime: ApprovalRuntime
  action: AgentAction
}
const scope = new AsyncLocalStorage<ApprovalScope>()

/** Whether this call is inside an agent run's approval gate (a run always has one). */
export function inApprovalRun(): boolean {
  return scope.getStore() !== undefined
}

/** Runs a tool with the approval gate of its run in reach (requireApproval). */
export function runInApprovalScope<T>(runtime: ApprovalRuntime | undefined, action: AgentAction, fn: () => Promise<T>): Promise<T> {
  return runtime ? scope.run({ runtime, action }, fn) : fn()
}

export interface RequireApprovalRequest {
  /** The thing to approve, exactly: what will be bought or published. A resume only lets the same payload through. */
  payload: unknown
  title?: string
  summary?: string
  details?: Record<string, string>
  risk?: ApprovalRisk
}

export type RequireApprovalResult = { ok: true } | { ok: false; output: string; error: ToolError }

/**
 * For tools: stop here unless the owner approved this exact payload. Use it
 * right before the irreversible step:
 *
 *   const gate = await requireApproval('publish', { payload: { site, files }, details: { target: url } })
 *   if (!gate.ok) return { action, ok: false, output: gate.output, error: gate.error }
 *
 * In a headless run this suspends the run; after `--approve` the same tool
 * call runs again and passes here once, for the same payload only. The
 * payload itself is shown under 详情 (as canonical JSON).
 */
export async function requireApproval(kind: ApprovalKind, request: RequireApprovalRequest): Promise<RequireApprovalResult> {
  const current = scope.getStore()
  const found = need(
    kind,
    request.risk ?? (kind === 'payment' || kind === 'delete_outside_workspace' || kind === 'shell_high_risk' ? 'high' : 'medium'),
    { ...(request.details ?? {}), args: canonicalJson(request.payload ?? null) },
    { ...(request.title ? { title: request.title } : {}), ...(request.summary ? { summary: request.summary } : {}) },
  )
  if (!current) {
    // Outside an agent run: only the policy can decide.
    const mode = modeFor(loadApprovalPolicy(process.cwd()), kind)
    if (mode === 'allow') return { ok: true }
    const message = `This step needs the owner's approval (${kind}) and none can be asked for here.`
    return { ok: false, output: message, error: { code: mode === 'deny' ? 'approval_denied_by_policy' : 'approval_unavailable', message, retryable: false } }
  }
  const gate = await current.runtime.check(found, current.action, digestOf(request.payload ?? null))
  return gate.ok ? { ok: true } : { ok: false, output: gate.output, error: gate.error }
}

// ── Resume ──────────────────────────────────────────────────────────────────

export type ApprovalRejection = 'approval_not_found' | 'approval_already_used' | 'approval_expired' | 'approval_tampered' | 'approval_unauthorized'

export class ApprovalResumeError extends Error {
  constructor(
    readonly code: ApprovalRejection,
    message: string,
  ) {
    super(message)
  }
}

export interface ApprovalAnswerProof {
  decision: 'approve' | 'deny'
  /** The host's Ed25519 signature over approvalAnswerPayload (base64 or base64url). */
  signature?: string
  /** The digest the host kept (optional without a signature; the signature covers it). */
  expectedDigest?: string
  /** The host's public key (default: ARTEMIS_APPROVAL_PUBKEY). */
  hostKey?: { key: KeyObject; id: string }
  now?: Date
}

/**
 * Checks an answer against the stored request: it exists in this session, is
 * still pending, has not expired, was not changed since it was stored, and,
 * when the run that asked had the host's public key, carries the host's
 * signature over this request, its digest and this decision. Throws
 * ApprovalResumeError; marks an expired or changed record so it can never be
 * used. Does not mark it decided: the caller does, before it acts.
 */
export function validateApprovalAnswer(session: SessionRecord, id: string, proof: ApprovalAnswerProof): PendingApproval {
  const record = (session.approvals ?? []).find((r) => r.id === id)
  if (!record || !APPROVAL_ID_PATTERN.test(id)) throw new ApprovalResumeError('approval_not_found', `No approval request ${id} in this conversation.`)
  if (record.status !== 'pending') {
    throw new ApprovalResumeError(record.status === 'expired' ? 'approval_expired' : record.status === 'invalid' ? 'approval_tampered' : 'approval_already_used', `Approval ${id} was already ${record.status}.`)
  }
  const { mac, status: _status, decidedAt: _decided, reason: _reason, endedBy: _ended, ...rest } = record
  if (!safeEqualHex(mac, macOf(rest)) || digestOf(record.action) !== record.actionDigest || !isApprovalKind(record.kind)) {
    record.status = 'invalid'
    throw new ApprovalResumeError('approval_tampered', `Approval ${id} does not match what was requested; it cannot be used.`)
  }
  if (proof.expectedDigest !== undefined && (!/^[0-9a-f]{64}$/.test(proof.expectedDigest) || !safeEqualHex(proof.expectedDigest, record.actionDigest))) {
    record.status = 'invalid'
    throw new ApprovalResumeError('approval_tampered', `Approval ${id} does not match what the host was shown; it cannot be used.`)
  }
  const hostKey = proof.hostKey ?? hostApprovalKey()
  if (record.hostBinding || proof.signature) {
    if (!hostKey || (record.hostBinding && !safeEqualHex(hostKey.id, record.hostBinding))) {
      throw new ApprovalResumeError('approval_unauthorized', `Approval ${id} can only be answered by the host that requested it.`)
    }
    const signature = proof.signature ? Buffer.from(proof.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64') : Buffer.alloc(0)
    let valid = false
    try {
      valid = signature.length === 64 && verifySignature(null, approvalAnswerPayload({
        approvalId: record.id,
        sessionId: record.sessionId,
        actionDigest: record.actionDigest,
        decision: proof.decision,
        expiresAt: record.expiresAt,
      }), hostKey.key, signature)
    } catch {
      valid = false
    }
    if (!valid) throw new ApprovalResumeError('approval_unauthorized', `Approval ${id} needs its host's signature for this answer.`)
  }
  const now = proof.now ?? new Date()
  if (Date.parse(record.expiresAt) <= now.getTime()) {
    record.status = 'expired'
    record.endedBy = 'expired'
    record.decidedAt = now.toISOString()
    throw new ApprovalResumeError('approval_expired', `Approval ${id} expired at ${record.expiresAt}.`)
  }
  return record
}

/**
 * The owner wrote again in this conversation: requests still waiting are
 * stale (the owner moved on). They expire, and the host says so.
 */
export function supersedePendingApprovals(session: SessionRecord, now = new Date()): PendingApproval[] {
  const ended: PendingApproval[] = []
  for (const record of session.approvals ?? []) {
    if (record.status !== 'pending') continue
    record.status = 'expired'
    record.endedBy = 'superseded'
    record.decidedAt = now.toISOString()
    ended.push(record)
  }
  return ended
}

/** The owner's message a request came from, for the run that continues after the answer. */
export function requestMessageOf(session: SessionRecord, record: PendingApproval): string | undefined {
  if (!record.requestMessageId) return undefined
  return session.messages.find((m) => m.id === record.requestMessageId)?.content
}

export function grantOf(record: PendingApproval): ApprovalGrant {
  return {
    id: record.id,
    kind: record.kind,
    actionDigest: record.actionDigest,
    ...(record.payloadDigest ? { payloadDigest: record.payloadDigest } : {}),
  }
}

/** True when an approval answer is being attempted from inside an agent's own tool process. */
export function answeringFromAgentTool(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_TOOL_ENV] === '1'
}

/** Locale for approval text: the owner's own words decide (CJK → Chinese). */
export function approvalLocaleFor(text: string | undefined, fallback: UiLocale): UiLocale {
  if (text && /[㐀-鿿]/.test(text)) return 'zh-CN'
  if (text && /[A-Za-z]{3,}/.test(text)) return 'en'
  return fallback
}

export function approvalPolicyPath(cwd: string): string {
  return path.join(resolveDataRootDir(cwd), APPROVAL_POLICY_FILE)
}

/** Whether a policy file exists for this workspace (diagnostics). */
export function hasApprovalPolicy(cwd: string): boolean {
  return existsSync(approvalPolicyPath(cwd)) || existsSync(path.join(resolveArtemisHomeDir(), APPROVAL_POLICY_FILE))
}
