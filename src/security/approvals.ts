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
 *    pending approval is stored in the session (the exact action, bound by
 *    an HMAC), `[approval-request] {...}` is printed for the host, and the
 *    run ends with APPROVAL_REQUIRED_EXIT_CODE. The host later runs
 *    `artemis execute --session <id> --approve <requestId>` (or `--deny`),
 *    which executes exactly the stored action once, then lets the model go on;
 *  - anything else: the action is refused, as before this module existed.
 *
 * Tools that need an approval for something only they know about (a
 * purchase, a publish) call `requireApproval(kind, request)` from inside
 * their execute function; the same policy, suspension and single-use checks
 * apply. See docs/APPROVALS.md for the protocol.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type { UiLocale } from '../cli/locale.js'
import type { AgentAction, SessionRecord } from '../core/types.js'
import type { ToolError } from '../tools/types.js'
import { resolveArtemisHomeDir, resolveDataRootDir } from '../utils/fs.js'

// ── Kinds, modes, policy ────────────────────────────────────────────────────

export const APPROVAL_KINDS = [
  'confirmation',
  'shell_high_risk',
  'delete_outside_workspace',
  'outbound_send',
  'payment',
  'publish',
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
]

export const DEFAULT_APPROVAL_MODES: Readonly<Record<ApprovalKind, ApprovalMode>> = {
  confirmation: 'ask',
  shell_high_risk: 'ask',
  delete_outside_workspace: 'ask',
  outbound_send: 'ask',
  payment: 'ask',
  publish: 'ask',
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
/** HMAC key that binds stored actions to their approval records. */
export const APPROVAL_KEY_FILE = 'approvals.key'
/**
 * Host binding: a host (the web server) may pass a per-run secret in this
 * variable. It is removed from the environment before any tool runs, and a
 * request created in that run can only be answered by a process that
 * presents the same secret.
 */
export const APPROVAL_HOST_SECRET_ENV = 'ARTEMIS_APPROVAL_SECRET'
/** Set in the environment of every shell command the agent runs. */
export const AGENT_TOOL_ENV = 'ARTEMIS_AGENT_TOOL'
/** `off` turns headless suspension off (ask-mode actions are refused instead). */
export const APPROVALS_ENV = 'ARTEMIS_APPROVALS'

export interface ApprovalPolicy {
  modes: Record<ApprovalKind, ApprovalMode>
  ttlMs: number
}

function isMode(value: unknown): value is ApprovalMode {
  return value === 'ask' || value === 'allow' || value === 'deny'
}

export function isApprovalKind(value: unknown): value is ApprovalKind {
  return typeof value === 'string' && (APPROVAL_KINDS as readonly string[]).includes(value)
}

function readPolicyFile(file: string): Partial<{ modes: Record<string, unknown>; ttlMinutes: unknown }> | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, never>) : undefined
  } catch {
    return undefined
  }
}

/**
 * The policy for a workspace: defaults, then `<home>/approvals.json`, then
 * `<workspace data root>/approvals.json`. Unknown kinds and modes are
 * ignored; `confirmation` always asks.
 */
export function loadApprovalPolicy(cwd: string): ApprovalPolicy {
  const modes: Record<ApprovalKind, ApprovalMode> = { ...DEFAULT_APPROVAL_MODES }
  let ttlMs = DEFAULT_APPROVAL_TTL_MS
  const files = [path.join(resolveArtemisHomeDir(), APPROVAL_POLICY_FILE), path.join(resolveDataRootDir(cwd), APPROVAL_POLICY_FILE)]
  for (const file of [...new Set(files)]) {
    const data = readPolicyFile(file)
    if (!data) continue
    const given = data.modes && typeof data.modes === 'object' ? data.modes : {}
    for (const [kind, mode] of Object.entries(given)) {
      if (isApprovalKind(kind) && kind !== 'confirmation' && isMode(mode)) modes[kind] = mode
    }
    const minutes = Number(data.ttlMinutes)
    if (Number.isFinite(minutes) && minutes > 0) ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, minutes * 60_000))
  }
  return { modes, ttlMs }
}

// ── Records ─────────────────────────────────────────────────────────────────

/** What the host shows the owner. Never contains the raw action. */
export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  title: string
  summary: string
  /** Plain facts under 详情; stable keys (command, reason, paths, to, content, file, amount, ...). */
  details: Record<string, string>
  risk: ApprovalRisk
  createdAt: string
  expiresAt: string
  sessionId: string
  locale: UiLocale
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'invalid'

/** Stored in the session (`session.approvals`). */
export interface PendingApproval extends ApprovalRequest {
  status: ApprovalStatus
  /** The exact action to run on approval. */
  action: AgentAction
  /** sha256 of the canonical action. */
  actionDigest: string
  /** For a tool's own requireApproval(): sha256 of the canonical payload it asked about. */
  payloadDigest?: string
  /** sha256 of the host secret, when the run had one. */
  hostBinding?: string
  /** HMAC over everything above that matters; any change makes the record unusable. */
  mac: string
  decidedAt?: string
  reason?: string
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

/** The per-install HMAC key (created on first use, mode 0600, never shown to the model). */
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

function macOf(record: Omit<PendingApproval, 'mac' | 'status' | 'decidedAt' | 'reason'>): string {
  const bound = {
    v: 1,
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
    risk: record.risk,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    sessionId: record.sessionId,
    locale: record.locale,
  }
}

export function formatApprovalRequestLine(record: PendingApproval): string {
  return `${APPROVAL_REQUEST_PREFIX} ${JSON.stringify(publicApproval(record))}`
}

// ── Host secret ─────────────────────────────────────────────────────────────

let hostSecret: { value: string | undefined } | undefined

/**
 * Reads the host's per-run secret once and removes it from this process's
 * environment, so no tool, shell or MCP server the agent starts inherits it.
 */
export function takeHostApprovalSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!hostSecret) {
    const value = env[APPROVAL_HOST_SECRET_ENV]?.trim()
    hostSecret = { value: value && value.length >= 16 ? value : undefined }
  }
  delete env[APPROVAL_HOST_SECRET_ENV]
  return hostSecret.value
}

/** Tests only. */
export function resetHostApprovalSecretForTests(): void {
  hostSecret = undefined
  cachedKey = undefined
}

export function hostBindingOf(secret: string | undefined): string | undefined {
  return secret ? createHash('sha256').update(`artemis-approval-host:${secret}`).digest('hex') : undefined
}

// ── User-facing text ────────────────────────────────────────────────────────

const t = (locale: UiLocale, zh: string, en: string) => (locale === 'zh-CN' ? zh : en)

function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

const PLATFORM_NAMES: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', wechat: '微信', all: '' }

/** "send_email" → "send email": tool code names never reach the owner as identifiers. */
function plainWords(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** What the model or a tool needs approved, before it has an id. */
export interface ApprovalNeed {
  kind: ApprovalKind
  risk: ApprovalRisk
  details: Record<string, string>
  /** Overrides the generated title / summary (a tool's own wording, or the model's question). */
  title?: string
  summary?: string
}

export function describeApprovalNeed(need: ApprovalNeed, locale: UiLocale): { title: string; summary: string } {
  const d = need.details
  const generated = (() => {
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
          title: t(locale, '删除工作区以外的文件', 'Delete files outside the workspace'),
          summary: t(locale, `将删除：${clip(d.paths ?? '', 160)}。删除后无法恢复。`, `Will delete: ${clip(d.paths ?? '', 160)}. This cannot be undone.`),
        }
      case 'outbound_send':
        return {
          title: d.to ? t(locale, `代你发送到 ${d.to}`, `Send to ${d.to} on your behalf`) : t(locale, '代你对外发送消息', 'Send a message on your behalf'),
          summary: d.content
            ? t(locale, `内容：${clip(d.content, 160)}`, `Content: ${clip(d.content, 160)}`)
            : d.file
              ? t(locale, `文件：${d.file}`, `File: ${d.file}`)
              : t(locale, '发出后无法撤回。', 'Once sent it cannot be taken back.'),
        }
      case 'payment':
        return {
          title: t(locale, '付款或购买', 'Make a payment or purchase'),
          summary: d.amount
            ? t(locale, `金额：${d.amount}${d.merchant ? `，收款方：${d.merchant}` : ''}`, `Amount: ${d.amount}${d.merchant ? `, to ${d.merchant}` : ''}`)
            : t(locale, '这一步会花钱，只有你同意后才会进行。', 'This step spends money and runs only if you approve.'),
        }
      case 'publish':
        return {
          title: t(locale, '对外发布或分享', 'Publish or share outside'),
          summary: d.target
            ? t(locale, `发布到：${d.target}`, `Publish to: ${d.target}`)
            : t(locale, '发布后其他人可以看到。', 'Once published, others can see it.'),
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

const OUTBOUND_TOOL = /(?:^|[_\-.])(?:send|post|reply|tweet|toot|email|mail|sms|dm|message|notify|invite|forward)(?:$|[_\-.])/i
const PAYMENT_TOOL = /(?:^|[_\-.])(?:pay|payment|purchase|checkout|buy|order|charge|transfer|withdraw|swap|trade|tip|donate|subscribe)(?:$|[_\-.])/i
const PUBLISH_TOOL = /(?:^|[_\-.])(?:publish|share|deploy|release|upload|unpublish)(?:$|[_\-.])/i
const READ_ONLY_TOOL = /(?:^|[_\-.])(?:get|list|search|read|fetch|find|query|lookup|status|preview|draft|quote|estimate|history)(?:$|[_\-.])/i

const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'trash-put', 'srm'])
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'nohup', 'nice', 'time', 'exec'])

/** Splits a shell command into simple-command word lists (quotes respected; no expansion). */
function shellSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let quote: '"' | "'" | undefined
  let hasWord = false
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length) segments.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = undefined
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      word += command[++i]
      hasWord = true
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') {
      endSegment()
      continue
    }
    if (ch === ' ' || ch === '\t') {
      endWord()
      continue
    }
    word += ch
    hasWord = true
  }
  endSegment()
  return segments
}

function expandHome(word: string): string | undefined {
  const home = homedir()
  const expanded = word.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home)
  // Any other variable or a command substitution: the real target is unknown here.
  if (/\$/.test(expanded)) return undefined
  return expanded
}

function isTemporaryPath(target: string): boolean {
  const roots = [...new Set([path.resolve(tmpdir()), '/tmp', '/var/tmp'])]
  return roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`)) && !roots.includes(target)
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Targets of `rm`-like commands (and `find … -delete`) that resolve outside the workspace. */
export function deletesOutsideWorkspace(command: string, cwd: string): string[] {
  const outside: string[] = []
  for (const segment of shellSegments(command)) {
    let i = 0
    while (i < segment.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i]!) || WRAPPERS.has(segment[i]!))) i++
    const name = path.basename(segment[i] ?? '')
    const args = segment.slice(i + 1)
    let targets: string[] = []
    if (DELETE_COMMANDS.has(name)) {
      let afterDashes = false
      for (const arg of args) {
        if (!afterDashes && arg === '--') {
          afterDashes = true
          continue
        }
        if (!afterDashes && arg.startsWith('-')) continue
        targets.push(arg)
      }
    } else if (name === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')) {
      const deletes = args.includes('-delete') || args.some((a, k) => (a === '-exec' || a === '-execdir') && DELETE_COMMANDS.has(path.basename(args[k + 1] ?? '')))
      if (deletes) {
        for (const arg of args) {
          if (arg.startsWith('-') || arg === '!' || arg === '(') break
          targets.push(arg)
        }
        if (targets.length === 0) targets = ['.']
      }
    }
    for (const raw of targets) {
      const expanded = expandHome(raw)
      if (expanded === undefined) continue
      const resolved = path.resolve(cwd, expanded.replace(/\*.*$/, '') || '.')
      if (isInside(cwd, resolved) && !/(^|\/)\.\.(\/|$)/.test(path.relative(cwd, resolved))) continue
      if (isTemporaryPath(resolved)) continue
      outside.push(expanded)
    }
  }
  return [...new Set(outside)]
}

/** True when a shell command tries to answer an approval itself (`artemis … --approve|--deny`). */
export function commandAnswersApproval(command: string): boolean {
  return /\bartemis\b[\s\S]{0,400}--(?:approve|deny)\b|--(?:approve|deny)\b[\s\S]{0,200}\bapr_[0-9a-f]/i.test(command)
}

function argText(args: Record<string, unknown> | undefined, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args?.[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (Array.isArray(value) && value.length && value.every((v) => typeof v === 'string')) return value.join(', ')
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function compact(details: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(details)) if (value !== undefined && value !== '') out[key] = clip(value, 1_000)
  return out
}

/**
 * Whether an action needs an approval, and of which kind. Null for anything
 * that runs freely. When several apply, the riskiest kind wins.
 */
export function classifyApprovalNeed(action: AgentAction, ctx: ClassifyContext): ApprovalNeed | null {
  for (const rule of extraRules) {
    const need = rule(action, ctx)
    if (need) return need
  }
  switch (action.type) {
    case 'request_user_confirmation':
      return {
        kind: 'confirmation',
        risk: 'medium',
        details: compact({ question: action.question, screenshot: action.screenshotPath }),
      }
    case 'run_command': {
      const dangerous = ctx.dangerousCommand?.(action.command) ?? null
      const deletes = deletesOutsideWorkspace(action.command, ctx.cwd)
      if (dangerous) {
        return {
          kind: 'shell_high_risk',
          risk: 'high',
          details: compact({ command: action.command, reason: dangerous.reason, reasonZh: dangerous.reasonZh, paths: deletes.join(', ') || undefined }),
        }
      }
      if (deletes.length) {
        return { kind: 'delete_outside_workspace', risk: 'high', details: compact({ command: action.command, paths: deletes.join(', ') }) }
      }
      return null
    }
    case 'bridge_send_image':
    case 'bridge_send_video': {
      const platform = action.platform ?? 'all'
      const own = ctx.ownChat
      if (own?.platform && own.platform === action.platform && (!action.targetId || action.targetId === own.targetId)) return null
      const file = action.type === 'bridge_send_image' ? action.imagePath : action.videoPath
      return {
        kind: 'outbound_send',
        risk: 'medium',
        details: compact({
          to: PLATFORM_NAMES[platform] || undefined,
          file,
          content: action.caption,
          target: action.targetId,
        }),
      }
    }
    case 'mcp_call_tool': {
      if (action.readOnly === true) return null
      const tool = action.toolName
      const words = plainWords(tool)
      const args = action.args
      const base = { service: action.serverId, action: words }
      if (PAYMENT_TOOL.test(tool) && !READ_ONLY_TOOL.test(tool)) {
        return {
          kind: 'payment',
          risk: 'high',
          details: compact({ ...base, amount: argText(args, 'amount', 'total', 'price', 'value'), merchant: argText(args, 'merchant', 'to', 'recipient', 'payee') }),
        }
      }
      if (OUTBOUND_TOOL.test(tool) && !READ_ONLY_TOOL.test(tool)) {
        return {
          kind: 'outbound_send',
          risk: 'medium',
          details: compact({
            ...base,
            to: argText(args, 'to', 'recipient', 'recipients', 'chat', 'chatId', 'channel', 'email', 'phone', 'user'),
            subject: argText(args, 'subject', 'title'),
            content: argText(args, 'text', 'body', 'message', 'content', 'html'),
          }),
        }
      }
      if (PUBLISH_TOOL.test(tool) && !READ_ONLY_TOOL.test(tool)) {
        return { kind: 'publish', risk: 'medium', details: compact({ ...base, target: argText(args, 'url', 'target', 'site', 'channel', 'name', 'title') }) }
      }
      return null
    }
    default:
      return null
  }
}

/** Direct-tool names (interactive brain path) that are not AgentActions: delete_file / delete_directory. */
export function classifyDirectToolNeed(name: string, input: Record<string, unknown>, ctx: ClassifyContext): ApprovalNeed | null {
  if (name === 'delete_file' || name === 'delete_directory') {
    const raw = typeof input.path === 'string' ? input.path : ''
    const expanded = raw ? expandHome(raw) : undefined
    if (!expanded) return null
    const resolved = path.resolve(ctx.cwd, expanded)
    if (isInside(ctx.cwd, resolved) || isTemporaryPath(resolved)) return null
    return { kind: 'delete_outside_workspace', risk: 'high', details: compact({ paths: resolved }) }
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

  /** Classifies and checks an action before it runs. */
  async checkAction(action: AgentAction, cwd = this.options.cwd): Promise<GateResult> {
    const need = classifyApprovalNeed(action, { ...this.classifyContext, cwd })
    return need ? this.check(need, action) : { ok: true }
  }

  /** Applies the policy to one need of one action. */
  async check(need: ApprovalNeed, action: AgentAction, payloadDigest?: string): Promise<GateResult> {
    const { locale } = this.options
    const mode = need.kind === 'confirmation' ? 'ask' : this.options.policy.modes[need.kind]
    const { title } = describeApprovalNeed(need, locale)
    if (mode === 'deny') {
      const message = t(
        locale,
        `已按你的设置拒绝：${title}。不要重试或换一种方式绕过，告诉用户这一步已被设置禁止。`,
        `Refused by the owner's settings: ${title}. Do not retry or work around it; tell the user this step is turned off in their settings.`,
      )
      return { ok: false, output: message, error: { code: 'approval_denied_by_policy', message, retryable: false } }
    }
    if (mode === 'allow') return { ok: true, approvedKind: need.kind }
    if (this.consumeGrant(need.kind, action, payloadDigest)) return { ok: true, approvedKind: need.kind }
    // The model's own question on an interactive host: the tool asks it itself (with its screenshot).
    if (need.kind === 'confirmation' && this.options.ask) return { ok: true }
    if (this.options.ask) {
      const { summary } = describeApprovalNeed(need, locale)
      const lines = [title, summary, ...Object.entries(need.details).filter(([k]) => k !== 'reasonZh' && k !== 'question').map(([k, v]) => `${k}: ${v}`)]
      const yes = await this.options.ask(lines.filter(Boolean).join('\n'))
      if (yes) return { ok: true, approvedKind: need.kind }
      const message = t(locale, `用户没有同意：${title}。停在这一步，不要重试。`, `The user did not approve: ${title}. Stop before this step; do not retry it.`)
      return { ok: false, output: message, error: { code: 'approval_declined', message, retryable: false } }
    }
    if (this.options.suspend && this.suspendable && !this.pending) {
      const record = this.createPending(need, action, payloadDigest)
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

  private createPending(need: ApprovalNeed, action: AgentAction, payloadDigest?: string): PendingApproval {
    const { session, hostBinding } = this.options.suspend!
    const now = (this.options.now ?? (() => new Date()))()
    const { title, summary } = describeApprovalNeed(need, this.options.locale)
    const details = { ...need.details }
    delete details.reasonZh
    const base = {
      id: `apr_${randomBytes(10).toString('hex')}`,
      kind: need.kind,
      title,
      summary,
      details,
      risk: need.risk,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.options.policy.ttlMs).toISOString(),
      sessionId: session.rootSessionId ?? session.id,
      locale: this.options.locale,
      action,
      actionDigest: digestOf(action),
      ...(payloadDigest ? { payloadDigest } : {}),
      ...(hostBinding ? { hostBinding } : {}),
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
 * call runs again and passes here once, for the same payload only.
 */
export async function requireApproval(kind: ApprovalKind, request: RequireApprovalRequest): Promise<RequireApprovalResult> {
  const current = scope.getStore()
  const need: ApprovalNeed = {
    kind,
    risk: request.risk ?? (kind === 'payment' || kind === 'delete_outside_workspace' || kind === 'shell_high_risk' ? 'high' : 'medium'),
    details: compact(request.details ?? {}),
    ...(request.title ? { title: request.title } : {}),
    ...(request.summary ? { summary: request.summary } : {}),
  }
  if (!current) {
    // Outside an agent run: only the policy can decide.
    const mode = kind === 'confirmation' ? 'ask' : loadApprovalPolicy(process.cwd()).modes[kind]
    if (mode === 'allow') return { ok: true }
    const message = `This step needs the owner's approval (${kind}) and none can be asked for here.`
    return { ok: false, output: message, error: { code: mode === 'deny' ? 'approval_denied_by_policy' : 'approval_unavailable', message, retryable: false } }
  }
  const gate = await current.runtime.check(need, current.action, digestOf(request.payload ?? null))
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

/**
 * Checks an answer against the stored request: it exists in this session, is
 * still pending, has not expired, was not changed since it was stored, and
 * (when the run was host-bound) comes from the same host. Throws
 * ApprovalResumeError; marks an expired or changed record so it can never be
 * used. Does not mark it decided: the caller does, before it acts.
 */
export function validateApprovalAnswer(
  session: SessionRecord,
  id: string,
  options: { now?: Date; hostSecret?: string } = {},
): PendingApproval {
  const record = (session.approvals ?? []).find((r) => r.id === id)
  if (!record || !APPROVAL_ID_PATTERN.test(id)) throw new ApprovalResumeError('approval_not_found', `No approval request ${id} in this conversation.`)
  if (record.status !== 'pending') {
    throw new ApprovalResumeError(record.status === 'expired' ? 'approval_expired' : record.status === 'invalid' ? 'approval_tampered' : 'approval_already_used', `Approval ${id} was already ${record.status}.`)
  }
  const { mac, status: _status, decidedAt: _decided, reason: _reason, ...rest } = record
  const expected = macOf(rest)
  if (!safeEqualHex(mac, expected) || digestOf(record.action) !== record.actionDigest || !isApprovalKind(record.kind)) {
    record.status = 'invalid'
    throw new ApprovalResumeError('approval_tampered', `Approval ${id} does not match what was requested; it cannot be used.`)
  }
  if (record.hostBinding) {
    const given = hostBindingOf(options.hostSecret)
    if (!given || !safeEqualHex(given, record.hostBinding)) {
      throw new ApprovalResumeError('approval_unauthorized', `Approval ${id} can only be answered by the host that requested it.`)
    }
  }
  const now = options.now ?? new Date()
  if (Date.parse(record.expiresAt) <= now.getTime()) {
    record.status = 'expired'
    record.decidedAt = now.toISOString()
    throw new ApprovalResumeError('approval_expired', `Approval ${id} expired at ${record.expiresAt}.`)
  }
  return record
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
