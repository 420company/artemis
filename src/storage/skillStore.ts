/**
 * storage/skillStore.ts — learned skills (procedural long-term memory)
 *
 * A learned skill is a reusable procedure the curator distilled from a run
 * that verifiably succeeded: when to use it, the steps, pitfalls, the tools
 * involved and how the result was verified. Skills live next to the
 * Mnemosyne memories, one JSON file per skill:
 *
 *   global  → <artemis home>/memory/skills/<id>.json
 *   project → <data root of cwd>/memory/skills/<id>.json
 *
 * Chat bridges keep one partition per chat (global memory dir,
 * skills/chats/<hash>/), so one chat's procedures never reach another.
 *
 * Writes are atomic (tmp file + rename) and every read-modify-write runs
 * under a per-scope lock file (skills/.lock, shared with other processes).
 * Hard limits are enforced here, not trusted to the model: at most
 * SKILL_MAX_COUNT skills per scope (the least useful one moves to
 * skills/.trash/), at most SKILL_MAX_BYTES per serialized skill, and a new
 * skill that matches an existing one is merged into it (version bump; the
 * previous version is kept in skills/.versions/ so a complaint can roll it
 * back) instead of duplicated. The trash keeps the newest 50 files for at
 * most 30 days. Listings are cached per process and invalidated by the
 * directory's mtime.
 *
 * The skill ledger (per session, in the data root) carries what one run
 * hands to the next user message: the skills it loaded and learned, and for
 * a run that finished but was not verified, the candidate that an explicit
 * confirmation may turn into a skill.
 */

import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir, rename, unlink, stat } from 'node:fs/promises'
import { ensureDir, resolveDataRootDir } from '../utils/fs.js'
import { memoryDirForScope, scopesCollide, tokenizeForRecall, type MemoryScope } from './memoryFiles.js'
import { withSessionLock } from './sessionLock.js'

/** global / project, or one chat bridge partition ("chat-<hash>"). */
export type SkillScope = MemoryScope | `chat-${string}`

/** A skill as the ledger and the run recorder refer to it. */
export interface SkillRef {
  id: string
  scope: SkillScope
}

export interface SkillRecord {
  id: string
  name: string
  /** One line: when to use this skill. The index shows only this. */
  description: string
  /** Keywords that suggest the skill is relevant. */
  triggers: string[]
  steps: string[]
  pitfalls: string[]
  /** Tool names the procedure uses. */
  tools: string[]
  /** How the result was (and should be) verified. */
  verification: string
  /** One-line summary of the task the skill was learned from. */
  sourceTaskSummary: string
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  /** Times the skill was loaded with load_skill. */
  uses: number
  /** Verified runs (or confirmed runs) that loaded the skill. */
  successes: number
  /** Runs that loaded the skill and drew negative user feedback. */
  failures: number
  version: number
  /** Directory the record was read from; not serialized. */
  scope?: SkillScope
}

/** Fields the curator supplies; counters and timestamps are the store's. */
export type SkillDraft = Pick<
  SkillRecord,
  'name' | 'description' | 'triggers' | 'steps' | 'pitfalls' | 'tools' | 'verification' | 'sourceTaskSummary'
>

export const SKILL_MAX_COUNT = 200
export const SKILL_MAX_BYTES = 4_096
export const SKILL_LIMITS = {
  name: 64,
  description: 160,
  trigger: 32,
  triggers: 12,
  step: 300,
  steps: 12,
  pitfall: 240,
  pitfalls: 8,
  tool: 48,
  tools: 12,
  verification: 300,
  sourceTaskSummary: 240,
} as const
/** Name/description/trigger overlap above which a new skill merges into an existing one. */
export const SKILL_MERGE_SIMILARITY = 0.5
/** Recency half-life used by the eviction utility, in days. */
const UTILITY_HALF_LIFE_DAYS = 45

const SKILLS_DIR = 'skills'
const TRASH_DIR = '.trash'
const SKILL_FILE_RE = /^[\p{L}\p{N}-]+\.json$/u

/** Partition for one chat of a bridge (platform + chat id). */
export function chatSkillScope(partition: string): SkillScope {
  return `chat-${createHash('sha1').update(partition).digest('hex').slice(0, 16)}`
}

export function skillsDirForScope(cwd: string, scope: SkillScope): string {
  if (scope.startsWith('chat-')) return join(memoryDirForScope(cwd, 'global'), SKILLS_DIR, 'chats', scope.slice(5))
  return join(memoryDirForScope(cwd, scope as MemoryScope), SKILLS_DIR)
}

/**
 * Scopes a run reads, most specific first: a chat partition alone (bridges
 * never see other chats' or the owner's global skills), else project then
 * global (one when both resolve to the same dir).
 */
export function skillScopesForCwd(cwd: string, partition?: SkillScope): SkillScope[] {
  if (partition?.startsWith('chat-')) return [partition]
  return scopesCollide(cwd) ? ['global'] : ['project', 'global']
}

export function slugifySkillId(raw: string): string {
  const slug = String(raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SKILL_LIMITS.name)
    .replace(/-+$/g, '')
  if (slug) return slug
  const digest = createHash('sha1').update(String(raw ?? '')).digest('hex').slice(0, 8)
  return `skill-${digest}`
}

// ── normalization ──────────────────────────────────────────────────────────

/** One line, collapsed whitespace, at most `max` characters. */
export function clampLine(value: unknown, max: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function lineKey(line: string): string {
  return line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Clamp each entry, drop empties and case/punctuation-insensitive duplicates. */
export function clampList(value: unknown, maxItems: number, maxChars: number): string[] {
  const items = Array.isArray(value) ? value : (typeof value === 'string' && value.trim() ? [value] : [])
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const line = clampLine(item, maxChars)
    const key = lineKey(line)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= maxItems) break
  }
  return out
}

/** Merge two lists (dedupe); when over the cap keep the newest (last) entries. */
function mergeListsKeepNewest(older: string[], newer: string[], maxItems: number, maxChars: number): string[] {
  const merged = clampList([...older, ...newer], Number.MAX_SAFE_INTEGER, maxChars)
  return merged.slice(Math.max(0, merged.length - maxItems))
}

function nonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function isoOr(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : ''
  return text && Number.isFinite(Date.parse(text)) ? text : fallback
}

export function normalizeSkillDraft(raw: Partial<SkillDraft>): SkillDraft {
  return {
    name: clampLine(raw.name, SKILL_LIMITS.name),
    description: clampLine(raw.description, SKILL_LIMITS.description),
    triggers: clampList(raw.triggers, SKILL_LIMITS.triggers, SKILL_LIMITS.trigger).map((t) => t.toLowerCase()),
    steps: clampList(raw.steps, SKILL_LIMITS.steps, SKILL_LIMITS.step),
    pitfalls: clampList(raw.pitfalls, SKILL_LIMITS.pitfalls, SKILL_LIMITS.pitfall),
    tools: clampList(raw.tools, SKILL_LIMITS.tools, SKILL_LIMITS.tool),
    verification: clampLine(raw.verification, SKILL_LIMITS.verification),
    sourceTaskSummary: clampLine(raw.sourceTaskSummary, SKILL_LIMITS.sourceTaskSummary),
  }
}

/** Parse a stored record; null when it is not a usable skill. */
export function parseSkillRecord(raw: unknown, fallbackId: string, scope?: SkillScope): SkillRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const draft = normalizeSkillDraft(input as Partial<SkillDraft>)
  if (!draft.description || draft.steps.length === 0) return null
  const id = slugifySkillId(typeof input.id === 'string' && input.id ? input.id : fallbackId)
  const now = new Date().toISOString()
  const createdAt = isoOr(input.createdAt, now)
  return {
    id,
    ...draft,
    name: draft.name || id,
    createdAt,
    updatedAt: isoOr(input.updatedAt, createdAt),
    ...(typeof input.lastUsedAt === 'string' && Number.isFinite(Date.parse(input.lastUsedAt)) ? { lastUsedAt: input.lastUsedAt } : {}),
    uses: nonNegativeInt(input.uses),
    successes: nonNegativeInt(input.successes),
    failures: nonNegativeInt(input.failures),
    version: Math.max(1, nonNegativeInt(input.version)),
    ...(scope ? { scope } : {}),
  }
}

export function serializeSkill(record: SkillRecord): string {
  const { scope: _scope, ...stored } = record
  return `${JSON.stringify(stored, null, 2)}\n`
}

export function skillByteSize(record: SkillRecord): number {
  return Buffer.byteLength(serializeSkill(record), 'utf8')
}

/**
 * Shrink a record until it fits SKILL_MAX_BYTES: oldest pitfalls first, then
 * trailing steps (never below two), then the summary and triggers. Null when
 * it still does not fit.
 */
export function fitSkillToBytes(record: SkillRecord, maxBytes = SKILL_MAX_BYTES): SkillRecord | null {
  const next: SkillRecord = { ...record, steps: [...record.steps], pitfalls: [...record.pitfalls], triggers: [...record.triggers] }
  while (skillByteSize(next) > maxBytes) {
    if (next.pitfalls.length > 0) next.pitfalls.shift()
    else if (next.steps.length > 2) next.steps.pop()
    else if (next.sourceTaskSummary) next.sourceTaskSummary = ''
    else if (next.triggers.length > 0) next.triggers.pop()
    else return null
  }
  return next
}

// ── IO ─────────────────────────────────────────────────────────────────────

const VERSIONS_DIR = '.versions'
const VERSIONS_KEPT = 3
const TRASH_KEPT = 50
const TRASH_MAX_AGE_MS = 30 * 86_400_000
const LOCK_TIMEOUT_MS = 15_000

async function atomicWrite(filePath: string, data: string): Promise<void> {
  await ensureDir(dirname(filePath))
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, filePath)
}

function skillFile(cwd: string, scope: SkillScope, id: string): string {
  return join(skillsDirForScope(cwd, scope), `${id}.json`)
}

/**
 * Run a read-modify-write on one scope under its lock file (re-entrant in
 * one async chain; other processes and other chains in this one wait).
 */
export async function withSkillLock<T>(cwd: string, scope: SkillScope, fn: () => Promise<T>): Promise<T> {
  const dir = skillsDirForScope(cwd, scope)
  await ensureDir(dir)
  try {
    return await withSessionLock(join(dir, '.lock'), fn, { timeoutMs: LOCK_TIMEOUT_MS, label: `skills ${scope}` })
  } finally {
    listCache.delete(dir)
  }
}

const listCache = new Map<string, { mtimeMs: number; skills: SkillRecord[] }>()

function cloneRecord(record: SkillRecord): SkillRecord {
  return { ...record, triggers: [...record.triggers], steps: [...record.steps], pitfalls: [...record.pitfalls], tools: [...record.tools] }
}

/** Skills of one scope, newest first. Cached per process until the directory changes. */
export async function listSkills(cwd: string, scope: SkillScope): Promise<SkillRecord[]> {
  const dir = skillsDirForScope(cwd, scope)
  let mtimeMs: number
  try {
    mtimeMs = (await stat(dir)).mtimeMs
  } catch {
    listCache.delete(dir)
    return []
  }
  const cached = listCache.get(dir)
  if (cached && cached.mtimeMs === mtimeMs) return cached.skills.map(cloneRecord)
  let files: string[] = []
  try {
    files = (await readdir(dir)).filter((file) => SKILL_FILE_RE.test(file))
  } catch {
    return []
  }
  const out: SkillRecord[] = []
  for (const file of files) {
    try {
      const parsed = parseSkillRecord(JSON.parse(await readFile(join(dir, file), 'utf8')), file.slice(0, -5), scope)
      if (parsed) out.push(parsed)
    } catch { /* unreadable or corrupt skill — skip it */ }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  listCache.set(dir, { mtimeMs, skills: out.map(cloneRecord) })
  return out
}

/** Skills of the given scopes (default: what this cwd reads); an earlier scope hides a later one with the same id. */
export async function listAllSkills(cwd: string, scopes: SkillScope[] = skillScopesForCwd(cwd)): Promise<SkillRecord[]> {
  const seen = new Set<string>()
  const out: SkillRecord[] = []
  for (const scope of scopes) {
    for (const skill of await listSkills(cwd, scope)) {
      if (seen.has(skill.id)) continue
      seen.add(skill.id)
      out.push(skill)
    }
  }
  return out
}

async function readSkillIn(cwd: string, scope: SkillScope, id: string): Promise<SkillRecord | null> {
  try {
    return parseSkillRecord(JSON.parse(await readFile(skillFile(cwd, scope, id), 'utf8')), id, scope)
  } catch {
    return null
  }
}

/** Find a skill by id or name in the given scopes (default: what this cwd reads), first match wins. */
export async function readSkill(cwd: string, idOrName: string, scopes: SkillScope[] = skillScopesForCwd(cwd)): Promise<SkillRecord | null> {
  const id = slugifySkillId(idOrName)
  for (const scope of scopes) {
    const found = await readSkillIn(cwd, scope, id)
    if (found) return found
  }
  return null
}

/** Write a record to its scope (fitted to the byte cap). False when it cannot fit. */
export async function writeSkill(cwd: string, scope: SkillScope, record: SkillRecord): Promise<boolean> {
  const fitted = fitSkillToBytes(record)
  if (!fitted) return false
  await withSkillLock(cwd, scope, () => atomicWrite(skillFile(cwd, scope, fitted.id), serializeSkill(fitted)))
  return true
}

/** Keep the newest TRASH_KEPT files of a trash dir, none older than 30 days. */
export async function pruneSkillTrash(cwd: string, scope: SkillScope, nowMs = Date.now()): Promise<void> {
  const trashDir = join(skillsDirForScope(cwd, scope), TRASH_DIR)
  let files: string[] = []
  try {
    files = (await readdir(trashDir)).filter((file) => file.endsWith('.json'))
  } catch {
    return
  }
  const stamped: Array<{ file: string; mtime: number }> = []
  for (const file of files) {
    try { stamped.push({ file, mtime: (await stat(join(trashDir, file))).mtimeMs }) } catch { /* gone */ }
  }
  stamped.sort((a, b) => b.mtime - a.mtime)
  for (const [index, entry] of stamped.entries()) {
    if (index >= TRASH_KEPT || nowMs - entry.mtime > TRASH_MAX_AGE_MS) {
      try { await unlink(join(trashDir, entry.file)) } catch { /* gone */ }
    }
  }
}

async function moveToTrash(cwd: string, scope: SkillScope, id: string, tag: string, nowMs = Date.now()): Promise<boolean> {
  const trashDir = join(skillsDirForScope(cwd, scope), TRASH_DIR)
  await ensureDir(trashDir)
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
  try {
    await rename(skillFile(cwd, scope, id), join(trashDir, `${stamp}__${tag}${id}.json`))
  } catch {
    return false
  }
  await pruneSkillTrash(cwd, scope, nowMs)
  return true
}

/**
 * Move a skill to skills/.trash (recoverable by hand). With a scope, only
 * that scope is touched; without one, the first scope this cwd reads that
 * has the skill.
 */
export async function trashSkill(cwd: string, idOrName: string, scope?: SkillScope): Promise<SkillRecord | null> {
  const skill = await readSkill(cwd, idOrName, scope ? [scope] : undefined)
  if (!skill?.scope) return null
  const skillScope = skill.scope
  return withSkillLock(cwd, skillScope, async () => ((await moveToTrash(cwd, skillScope, skill.id, '')) ? skill : null))
}

// ── versions (rollback after a complaint) ──────────────────────────────────

function versionsDir(cwd: string, scope: SkillScope): string {
  return join(skillsDirForScope(cwd, scope), VERSIONS_DIR)
}

async function backupSkillVersion(cwd: string, scope: SkillScope, record: SkillRecord): Promise<void> {
  const dir = versionsDir(cwd, scope)
  await atomicWrite(join(dir, `${record.id}.v${record.version}.json`), serializeSkill(record))
  const versions = (await readdir(dir).catch(() => [] as string[]))
    .map((file) => ({ file, version: Number(file.match(new RegExp(`^${record.id}\\.v(\\d+)\\.json$`))?.[1] ?? Number.NaN) }))
    .filter((entry) => Number.isFinite(entry.version))
    .sort((a, b) => b.version - a.version)
  for (const stale of versions.slice(VERSIONS_KEPT)) {
    try { await unlink(join(dir, stale.file)) } catch { /* gone */ }
  }
}

/**
 * Roll a skill back to the version before its last update (kept in
 * skills/.versions/), counting a failure and adding the pitfall. Returns
 * the restored record, or null when there is no earlier version.
 */
export async function restorePreviousSkillVersion(
  cwd: string,
  scope: SkillScope,
  idOrName: string,
  options: { pitfall?: string; now?: Date } = {},
): Promise<SkillRecord | null> {
  const id = slugifySkillId(idOrName)
  return withSkillLock(cwd, scope, async () => {
    const current = await readSkillIn(cwd, scope, id)
    if (!current) return null
    const dir = versionsDir(cwd, scope)
    const candidates = (await readdir(dir).catch(() => [] as string[]))
      .map((file) => ({ file, version: Number(file.match(new RegExp(`^${id}\\.v(\\d+)\\.json$`))?.[1] ?? Number.NaN) }))
      .filter((entry) => Number.isFinite(entry.version) && entry.version < current.version)
      .sort((a, b) => b.version - a.version)
    const latest = candidates[0]
    if (!latest) return null
    let previous: SkillRecord | null = null
    try {
      previous = parseSkillRecord(JSON.parse(await readFile(join(dir, latest.file), 'utf8')), id, scope)
    } catch { /* unreadable backup */ }
    if (!previous) return null
    const now = options.now ?? new Date()
    const line = options.pitfall ? clampLine(options.pitfall, SKILL_LIMITS.pitfall) : ''
    const restored: SkillRecord = {
      ...previous,
      uses: current.uses,
      successes: current.successes,
      failures: current.failures + 1,
      ...(current.lastUsedAt ? { lastUsedAt: current.lastUsedAt } : {}),
      pitfalls: line ? mergeListsKeepNewest(previous.pitfalls, [line], SKILL_LIMITS.pitfalls, SKILL_LIMITS.pitfall) : previous.pitfalls,
      version: current.version + 1,
      updatedAt: now.toISOString(),
      scope,
    }
    const fitted = fitSkillToBytes(restored)
    if (!fitted) return null
    await atomicWrite(skillFile(cwd, scope, id), serializeSkill(fitted))
    try { await unlink(join(dir, latest.file)) } catch { /* gone */ }
    return fitted
  })
}

// ── similarity, merge, utility ─────────────────────────────────────────────

function skillTokens(skill: Pick<SkillRecord, 'name' | 'description' | 'triggers'>): Set<string> {
  return tokenizeForRecall(`${skill.name.replace(/-/g, ' ')} ${skill.description} ${skill.triggers.join(' ')}`)
}

export function skillSimilarity(
  a: Pick<SkillRecord, 'name' | 'description' | 'triggers'>,
  b: Pick<SkillRecord, 'name' | 'description' | 'triggers'>,
): number {
  const left = skillTokens(a)
  const right = skillTokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / (left.size + right.size - shared)
}

/** The existing skill a draft should merge into: same id, else the most similar above the threshold. */
export function findMatchingSkill(
  existing: SkillRecord[],
  draft: SkillDraft,
  threshold = SKILL_MERGE_SIMILARITY,
): SkillRecord | undefined {
  const id = slugifySkillId(draft.name)
  const sameId = existing.find((skill) => skill.id === id)
  if (sameId) return sameId
  let best: SkillRecord | undefined
  let bestScore = threshold
  for (const skill of existing) {
    const score = skillSimilarity(skill, draft)
    if (score >= bestScore) {
      best = skill
      bestScore = score
    }
  }
  return best
}

/**
 * Merge a newly distilled procedure into an existing skill: the newer
 * verified steps replace the old ones, pitfalls/triggers/tools accumulate,
 * counters stay, and the version goes up. The id never changes.
 */
export function mergeSkill(existing: SkillRecord, draft: SkillDraft, now = new Date()): SkillRecord {
  return {
    ...existing,
    description: draft.description || existing.description,
    triggers: clampList([...draft.triggers, ...existing.triggers], SKILL_LIMITS.triggers, SKILL_LIMITS.trigger),
    steps: draft.steps.length >= 2 ? draft.steps : existing.steps,
    pitfalls: mergeListsKeepNewest(existing.pitfalls, draft.pitfalls, SKILL_LIMITS.pitfalls, SKILL_LIMITS.pitfall),
    tools: clampList([...existing.tools, ...draft.tools], SKILL_LIMITS.tools, SKILL_LIMITS.tool),
    verification: draft.verification || existing.verification,
    sourceTaskSummary: draft.sourceTaskSummary || existing.sourceTaskSummary,
    updatedAt: now.toISOString(),
    version: existing.version + 1,
  }
}

/**
 * How much a skill is worth keeping: a Laplace-smoothed success rate
 * (successes vs failures), damped by how long ago it was last learned or
 * used, with a small bonus for frequent use. Lowest goes first on eviction.
 */
export function skillUtility(skill: SkillRecord, nowMs = Date.now()): number {
  const successRate = (skill.successes + 1) / (skill.successes + skill.failures + 2)
  const lastActive = Math.max(Date.parse(skill.updatedAt) || 0, Date.parse(skill.lastUsedAt ?? '') || 0)
  const ageDays = lastActive > 0 ? Math.max(0, (nowMs - lastActive) / 86_400_000) : 365
  const recency = Math.exp((-Math.LN2 / UTILITY_HALF_LIFE_DAYS) * ageDays)
  const usage = 1 + 0.1 * Math.min(skill.uses, 10)
  return successRate * (0.25 + 0.75 * recency) * usage
}

/** Trash the least useful skills until the scope has room for `incoming` more. Returns evicted ids. */
export async function evictSkillsForCapacity(
  cwd: string,
  scope: SkillScope,
  options: { maxSkills?: number; incoming?: number; protectIds?: string[]; nowMs?: number } = {},
): Promise<string[]> {
  return withSkillLock(cwd, scope, async () => {
    const maxSkills = Math.max(1, options.maxSkills ?? SKILL_MAX_COUNT)
    const incoming = Math.max(0, options.incoming ?? 1)
    const protect = new Set(options.protectIds ?? [])
    const skills = await listSkills(cwd, scope)
    const excess = skills.length + incoming - maxSkills
    if (excess <= 0) return []
    const nowMs = options.nowMs ?? Date.now()
    const candidates = skills
      .filter((skill) => !protect.has(skill.id))
      .sort((a, b) => skillUtility(a, nowMs) - skillUtility(b, nowMs) || a.updatedAt.localeCompare(b.updatedAt))
    const evicted: string[] = []
    for (const skill of candidates.slice(0, excess)) {
      if (await moveToTrash(cwd, scope, skill.id, 'evicted__', nowMs)) evicted.push(skill.id)
    }
    return evicted
  })
}

export interface UpsertSkillResult {
  op: 'added' | 'updated' | 'rejected'
  id: string
  scope: SkillScope
  reason?: string
  evicted?: string[]
}

/**
 * Add a distilled skill, or merge it into the existing skill it matches
 * (preferIds first — the skills the run loaded from this scope — then same
 * id, then the most similar). The version an update replaces is backed up
 * first. Enforces the per-scope cap and the per-skill byte cap; the whole
 * read-modify-write runs under the scope's lock.
 */
export async function upsertLearnedSkill(
  cwd: string,
  scope: SkillScope,
  rawDraft: Partial<SkillDraft>,
  options: { preferIds?: string[]; maxSkills?: number; now?: Date } = {},
): Promise<UpsertSkillResult> {
  const draft = normalizeSkillDraft(rawDraft)
  const now = options.now ?? new Date()
  const id = slugifySkillId(draft.name || draft.description)
  if (!draft.description) return { op: 'rejected', id, scope, reason: 'missing description' }
  if (draft.steps.length < 2) return { op: 'rejected', id, scope, reason: 'a skill needs at least two steps' }

  return withSkillLock(cwd, scope, async () => {
    const existing = await listSkills(cwd, scope)
    const preferred = (options.preferIds ?? [])
      .map((preferId) => existing.find((skill) => skill.id === slugifySkillId(preferId)))
      .find((skill): skill is SkillRecord => Boolean(skill) && skillSimilarity(skill!, draft) >= SKILL_MERGE_SIMILARITY / 2)
    const match = preferred ?? findMatchingSkill(existing, draft)

    if (match) {
      const merged = fitSkillToBytes(mergeSkill(match, draft, now))
      if (!merged) return { op: 'rejected' as const, id: match.id, scope, reason: `skill exceeds ${SKILL_MAX_BYTES} bytes` }
      await backupSkillVersion(cwd, scope, match)
      await atomicWrite(skillFile(cwd, scope, match.id), serializeSkill(merged))
      return { op: 'updated' as const, id: match.id, scope }
    }

    const stamp = now.toISOString()
    const record = fitSkillToBytes({
      id,
      ...draft,
      name: draft.name || id,
      createdAt: stamp,
      updatedAt: stamp,
      uses: 0,
      successes: 0,
      failures: 0,
      version: 1,
    })
    if (!record) return { op: 'rejected' as const, id, scope, reason: `skill exceeds ${SKILL_MAX_BYTES} bytes` }
    const evicted = await evictSkillsForCapacity(cwd, scope, { maxSkills: options.maxSkills, incoming: 1, nowMs: now.getTime() })
    await atomicWrite(skillFile(cwd, scope, id), serializeSkill(record))
    return { op: 'added' as const, id, scope, ...(evicted.length ? { evicted } : {}) }
  })
}

/** Read-modify-write one skill in its scope (or the first scope that has it). */
async function updateSkillRecord(
  cwd: string,
  idOrName: string,
  scope: SkillScope | undefined,
  change: (skill: SkillRecord) => SkillRecord,
): Promise<SkillRecord | null> {
  const found = await readSkill(cwd, idOrName, scope ? [scope] : undefined)
  if (!found?.scope) return null
  const skillScope = found.scope
  return withSkillLock(cwd, skillScope, async () => {
    const current = await readSkillIn(cwd, skillScope, found.id)
    if (!current) return null
    const next = fitSkillToBytes(change(current))
    if (!next) return null
    await atomicWrite(skillFile(cwd, skillScope, next.id), serializeSkill(next))
    return { ...next, scope: skillScope }
  })
}

/** Count a load of the skill (load_skill). Returns the updated record. */
export async function recordSkillUse(
  cwd: string,
  idOrName: string,
  options: { scope?: SkillScope; now?: Date } = {},
): Promise<SkillRecord | null> {
  const now = options.now ?? new Date()
  return updateSkillRecord(cwd, idOrName, options.scope, (skill) => ({ ...skill, uses: skill.uses + 1, lastUsedAt: now.toISOString() }))
}

/**
 * Record how a run that loaded the skill went, in the scope it was loaded
 * from. A failure may carry a pitfall (already sanitized by the caller),
 * which is appended and bumps the version.
 */
export async function recordSkillOutcome(
  cwd: string,
  idOrName: string,
  outcome: 'success' | 'failure',
  options: { pitfall?: string; scope?: SkillScope; now?: Date } = {},
): Promise<SkillRecord | null> {
  const now = options.now ?? new Date()
  const line = options.pitfall ? clampLine(options.pitfall, SKILL_LIMITS.pitfall) : ''
  return updateSkillRecord(cwd, idOrName, options.scope, (skill) => ({
    ...skill,
    successes: skill.successes + (outcome === 'success' ? 1 : 0),
    failures: skill.failures + (outcome === 'failure' ? 1 : 0),
    ...(line
      ? {
        pitfalls: mergeListsKeepNewest(skill.pitfalls, [line], SKILL_LIMITS.pitfalls, SKILL_LIMITS.pitfall),
        version: skill.version + 1,
        updatedAt: now.toISOString(),
      }
      : {}),
  }))
}

// ── ledger (run → next run hand-off) ───────────────────────────────────────

export interface SkillLedgerEntry<TPending = unknown> {
  sessionKey: string
  createdAt: string
  /** Skills the run loaded, with the scope each came from. */
  loadedSkills: SkillRef[]
  /** The run was verified (and already credited the skills it loaded). */
  verified: boolean
  /** Candidate kept for a later user confirmation (finished, not verified). */
  pending?: TPending
}

/** A hand-off is for the next user message only, and only within this window. */
export const SKILL_LEDGER_TTL_MS = 24 * 3_600_000
const SKILL_LEDGER_MAX_FILES = 200

function ledgerDir(cwd: string): string {
  return join(resolveDataRootDir(cwd), 'skill-ledger')
}

function ledgerFile(cwd: string, sessionKey: string): string {
  return join(ledgerDir(cwd), `${createHash('sha1').update(sessionKey).digest('hex').slice(0, 24)}.json`)
}

export async function writeSkillLedger<T>(cwd: string, entry: SkillLedgerEntry<T>): Promise<void> {
  await atomicWrite(ledgerFile(cwd, entry.sessionKey), `${JSON.stringify(entry)}\n`)
  await pruneSkillLedger(cwd)
}

/** Read the hand-off for a session without consuming it. */
export async function peekSkillLedger<T>(cwd: string, sessionKey: string): Promise<SkillLedgerEntry<T> | null> {
  try {
    const entry = JSON.parse(await readFile(ledgerFile(cwd, sessionKey), 'utf8')) as SkillLedgerEntry<T>
    return entry && entry.sessionKey === sessionKey ? entry : null
  } catch {
    return null
  }
}

/** Read and remove the hand-off for a session (consumed once). */
export async function takeSkillLedger<T>(cwd: string, sessionKey: string, nowMs = Date.now()): Promise<SkillLedgerEntry<T> | null> {
  const file = ledgerFile(cwd, sessionKey)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try { await unlink(file) } catch { /* another reader took it */ }
  try {
    const entry = JSON.parse(raw) as SkillLedgerEntry<T>
    if (!entry || entry.sessionKey !== sessionKey) return null
    const created = Date.parse(entry.createdAt)
    if (!Number.isFinite(created) || nowMs - created > SKILL_LEDGER_TTL_MS) return null
    const loadedSkills = Array.isArray(entry.loadedSkills)
      ? entry.loadedSkills.filter((ref): ref is SkillRef => Boolean(ref && typeof ref.id === 'string' && typeof ref.scope === 'string'))
      : []
    return { ...entry, loadedSkills }
  } catch {
    return null
  }
}

/** Drop expired hand-offs and keep the directory bounded. */
async function pruneSkillLedger(cwd: string, nowMs = Date.now()): Promise<void> {
  const dir = ledgerDir(cwd)
  let files: string[] = []
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.json'))
  } catch {
    return
  }
  const stamped: Array<{ file: string; mtime: number }> = []
  for (const file of files) {
    try {
      stamped.push({ file, mtime: (await stat(join(dir, file))).mtimeMs })
    } catch { /* gone */ }
  }
  stamped.sort((a, b) => b.mtime - a.mtime)
  for (const [index, entry] of stamped.entries()) {
    if (index >= SKILL_LEDGER_MAX_FILES || nowMs - entry.mtime > SKILL_LEDGER_TTL_MS) {
      try { await unlink(join(dir, entry.file)) } catch { /* gone */ }
    }
  }
}
