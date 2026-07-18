/**
 * storage/memoryFiles.ts — file-per-memory long-term store (Mnemosyne v2)
 *
 * One markdown file per memory with YAML-ish frontmatter, plus a MEMORY.md
 * index (one line per entry) that is cheap enough to keep resident in the
 * system prompt. Two scopes:
 *
 *   global  → <artemis home>/memory/          cross-project preferences, identity
 *   project → <data root of cwd>/memory/      project-specific facts
 *
 * Files are the source of truth; MEMORY.md is regenerated after every
 * mutation. Deletes go to memory/.trash/ instead of being destroyed.
 * Legacy <data root>/memory.json stores are migrated in place (idempotent).
 */

import { join, dirname, basename } from 'node:path'
import { readFile, writeFile, readdir, rename, mkdir, stat } from 'node:fs/promises'
import { ensureDir, resolveDataRootDir, resolveArtemisHomeDir } from '../utils/fs.js'

export type MemoryScope = 'global' | 'project'
export type MemoryCategory = 'preference' | 'feedback' | 'project' | 'reference' | 'skill' | 'architecture' | 'profile'

export interface MemoryEntry {
  name: string
  description: string
  category: MemoryCategory
  scope: MemoryScope
  createdAt: string
  updatedAt: string
  source: string
  content: string
}

export const MEMORY_MAX_ENTRY_BYTES = 4_096
export const MEMORY_MAX_ENTRIES_PER_SCOPE = 100
const INDEX_FILE = 'MEMORY.md'
const TRASH_DIR = '.trash'
/** Entries kept out of the index listing (injected elsewhere in full). */
const INDEX_EXCLUDED = new Set(['user-profile'])

const VALID_CATEGORIES: readonly string[] = ['preference', 'feedback', 'project', 'reference', 'skill', 'architecture', 'profile']

export function memoryDirForScope(cwd: string, scope: MemoryScope): string {
  return scope === 'global'
    ? join(resolveArtemisHomeDir(), 'memory')
    : join(resolveDataRootDir(cwd), 'memory')
}

/** cwd inside the artemis home makes both scopes point at the same dir. */
export function scopesCollide(cwd: string): boolean {
  return memoryDirForScope(cwd, 'global') === memoryDirForScope(cwd, 'project')
}

export function slugifyMemoryName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || `memory-${Math.abs(hashText(raw)).toString(16).slice(0, 8)}`
}

function hashText(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return h
}

function sanitizeCategory(raw: unknown): MemoryCategory {
  const value = String(raw ?? '').trim().toLowerCase()
  return (VALID_CATEGORIES.includes(value) ? value : 'preference') as MemoryCategory
}

// ── frontmatter ─────────────────────────────────────────────────────────────

export function serializeMemory(entry: MemoryEntry): string {
  const esc = (v: string) => v.replace(/\r?\n/g, ' ').trim()
  return [
    '---',
    `name: ${esc(entry.name)}`,
    `description: ${esc(entry.description)}`,
    `category: ${entry.category}`,
    `scope: ${entry.scope}`,
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
    `source: ${esc(entry.source)}`,
    '---',
    '',
    entry.content.trim(),
    '',
  ].join('\n')
}

export function parseMemory(raw: string, fallbackName: string, scope: MemoryScope): MemoryEntry | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    const content = raw.trim()
    if (!content) return null
    return {
      name: fallbackName,
      description: content.slice(0, 80).replace(/\r?\n/g, ' '),
      category: 'preference',
      scope,
      createdAt: '',
      updatedAt: '',
      source: 'unknown',
      content,
    }
  }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  const content = match[2].trim()
  if (!content && !meta.description) return null
  return {
    name: slugifyMemoryName(meta.name || fallbackName),
    description: meta.description || content.slice(0, 80).replace(/\r?\n/g, ' '),
    category: sanitizeCategory(meta.category),
    scope,
    createdAt: meta.createdAt || '',
    updatedAt: meta.updatedAt || meta.createdAt || '',
    source: meta.source || 'unknown',
    content,
  }
}

// ── low-level IO ────────────────────────────────────────────────────────────

async function atomicWrite(filePath: string, data: string): Promise<void> {
  await ensureDir(dirname(filePath))
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, filePath)
}

function fileFor(dir: string, name: string): string {
  return join(dir, `${name}.md`)
}

async function listMemoryFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((f) => f.endsWith('.md') && f !== INDEX_FILE && !f.endsWith('.legacy'))
  } catch {
    return []
  }
}

// ── public API ──────────────────────────────────────────────────────────────

export async function listMemories(cwd: string, scope: MemoryScope): Promise<MemoryEntry[]> {
  const dir = memoryDirForScope(cwd, scope)
  const files = await listMemoryFiles(dir)
  const out: MemoryEntry[] = []
  for (const file of files) {
    try {
      const raw = await readFile(join(dir, file), 'utf8')
      const parsed = parseMemory(raw, basename(file, '.md'), scope)
      if (parsed) out.push(parsed)
    } catch { /* unreadable entry — skip */ }
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  return out
}

export async function readMemoryByName(cwd: string, scope: MemoryScope, name: string): Promise<MemoryEntry | null> {
  const dir = memoryDirForScope(cwd, scope)
  try {
    const raw = await readFile(fileFor(dir, slugifyMemoryName(name)), 'utf8')
    return parseMemory(raw, slugifyMemoryName(name), scope)
  } catch {
    return null
  }
}

export interface SaveMemoryInput {
  name: string
  description: string
  category?: MemoryCategory | string
  content: string
  source?: string
}

export interface SaveMemoryResult {
  ok: boolean
  op: 'added' | 'updated' | 'rejected'
  name: string
  reason?: string
}

/**
 * Create or update a memory. Guards (enforced in code, not trusted to the model):
 * - entry serialized size ≤ MEMORY_MAX_ENTRY_BYTES
 * - per-scope entry count ≤ MEMORY_MAX_ENTRIES_PER_SCOPE (updates always allowed)
 * - updates that shrink content >40% are rejected unless allowShrink is set
 */
export async function saveMemory(
  cwd: string,
  scope: MemoryScope,
  input: SaveMemoryInput,
  opts: { allowShrink?: boolean } = {},
): Promise<SaveMemoryResult> {
  const name = slugifyMemoryName(input.name)
  const dir = memoryDirForScope(cwd, scope)
  const now = new Date().toISOString().slice(0, 10)
  const existing = await readMemoryByName(cwd, scope, name)

  const entry: MemoryEntry = {
    name,
    description: (input.description || input.content.slice(0, 80)).replace(/\r?\n/g, ' ').slice(0, 200),
    category: input.category !== undefined ? sanitizeCategory(input.category) : (existing?.category ?? 'preference'),
    scope,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source: input.source || existing?.source || 'manual',
    content: input.content.trim(),
  }

  const serialized = serializeMemory(entry)
  if (Buffer.byteLength(serialized, 'utf8') > MEMORY_MAX_ENTRY_BYTES) {
    return { ok: false, op: 'rejected', name, reason: `entry exceeds ${MEMORY_MAX_ENTRY_BYTES} bytes — split or condense it` }
  }

  if (existing) {
    const oldLen = existing.content.length
    if (!opts.allowShrink && oldLen > 200 && entry.content.length < oldLen * 0.6) {
      return { ok: false, op: 'rejected', name, reason: 'update shrinks content >40%; pass an explicit delete/allowShrink instead' }
    }
  } else {
    const count = (await listMemoryFiles(dir)).length
    if (count >= MEMORY_MAX_ENTRIES_PER_SCOPE) {
      return { ok: false, op: 'rejected', name, reason: `scope already holds ${count} entries — merge or delete before adding` }
    }
  }

  await atomicWrite(fileFor(dir, name), serialized)
  await rebuildIndex(cwd, scope)
  return { ok: true, op: existing ? 'updated' : 'added', name }
}

/** Move a memory into .trash (recoverable) instead of unlinking. */
export async function trashMemory(cwd: string, scope: MemoryScope, name: string): Promise<boolean> {
  const dir = memoryDirForScope(cwd, scope)
  const slug = slugifyMemoryName(name)
  const src = fileFor(dir, slug)
  try {
    await stat(src)
  } catch {
    return false
  }
  const trashDir = join(dir, TRASH_DIR)
  await ensureDir(trashDir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await rename(src, join(trashDir, `${stamp}__${slug}.md`))
  await rebuildIndex(cwd, scope)
  return true
}

/** Restore the most recent trashed copy of a memory. */
export async function restoreMemory(cwd: string, scope: MemoryScope, name: string): Promise<boolean> {
  const dir = memoryDirForScope(cwd, scope)
  const slug = slugifyMemoryName(name)
  const trashDir = join(dir, TRASH_DIR)
  let candidates: string[] = []
  try {
    candidates = (await readdir(trashDir)).filter((f) => f.endsWith(`__${slug}.md`)).sort()
  } catch {
    return false
  }
  const latest = candidates.pop()
  if (!latest) return false
  await rename(join(trashDir, latest), fileFor(dir, slug))
  await rebuildIndex(cwd, scope)
  return true
}

// ── index ───────────────────────────────────────────────────────────────────

export async function rebuildIndex(cwd: string, scope: MemoryScope): Promise<void> {
  const dir = memoryDirForScope(cwd, scope)
  const entries = await listMemories(cwd, scope)
  const lines = entries
    .filter((e) => !INDEX_EXCLUDED.has(e.name))
    .map((e) => `- [${e.name}](${e.name}.md) — ${e.description}`)
  const header = scope === 'global' ? '# Memory Index (global)' : '# Memory Index (project)'
  await atomicWrite(join(dir, INDEX_FILE), `${header}\n\n${lines.join('\n')}\n`)
}

/** Compact index text for prompt injection. Empty string when no entries. */
export async function loadIndexText(cwd: string, scope: MemoryScope): Promise<string> {
  const entries = await listMemories(cwd, scope)
  const lines = entries
    .filter((e) => !INDEX_EXCLUDED.has(e.name))
    .map((e) => `- ${e.name} [${e.category}]: ${e.description}`)
  return lines.join('\n')
}

// ── recall ──────────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0]
    if (w.length >= 2) tokens.add(w)
    // CJK words don't space-separate; add bigrams for overlap scoring
    if (/[一-鿿]/.test(w)) {
      for (let i = 0; i < w.length - 1; i++) tokens.add(w.slice(i, i + 2))
    }
  }
  return tokens
}

/** Leading slice of content that participates in recall scoring. */
const RECALL_CONTENT_CHARS = 2000
/** MMR balance: λ·relevance − (1−λ)·max Jaccard similarity to already-selected. */
const RECALL_MMR_LAMBDA = 0.7
/** Half-life for time decay of non-evergreen entries, in days. */
const RECALL_HALF_LIFE_DAYS = 14
/** Durable categories exempt from time decay. */
const RECALL_EVERGREEN = new Set<string>(['preference', 'feedback', 'project', 'reference', 'profile'])
/** Widest candidate pool handed to MMR (keeps re-ranking O(pool²)). */
const RECALL_MMR_POOL = 12

/** Exponential decay on updatedAt age for transient categories; evergreen → 1. */
function recallRecencyMultiplier(entry: MemoryEntry, nowMs: number): number {
  if (RECALL_EVERGREEN.has(entry.category)) return 1
  const stamp = Date.parse(entry.updatedAt || entry.createdAt || '')
  if (!Number.isFinite(stamp)) return 1
  const ageDays = Math.max(0, (nowMs - stamp) / 86_400_000)
  return Math.exp((-Math.LN2 / RECALL_HALF_LIFE_DAYS) * ageDays)
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

interface RecallCandidate {
  entry: MemoryEntry
  tokens: Set<string>
  score: number
}

/**
 * Greedy MMR selection: each round picks the candidate maximizing
 * λ·normalizedRelevance − (1−λ)·maxSimilarityToSelected, so near-duplicate
 * entries about one topic can't crowd out the whole result set.
 */
function mmrSelect(candidates: RecallCandidate[], k: number, lambda: number): RecallCandidate[] {
  if (candidates.length <= 1) return candidates.slice(0, k)
  let maxScore = -Infinity
  for (const c of candidates) {
    if (c.score > maxScore) maxScore = c.score
  }
  // Ratio normalization (score/max), not min-max: keyword scores cluster in a
  // narrow band, and min-max would collapse the weakest candidate to 0 —
  // making the diversity penalty unable to ever promote it.
  const scale = maxScore > 0 ? maxScore : Number.EPSILON

  const selected: RecallCandidate[] = []
  const remaining = [...candidates]
  while (remaining.length > 0 && selected.length < k) {
    let bestPos = 0
    let bestMmr = -Infinity
    for (let pos = 0; pos < remaining.length; pos++) {
      const candidate = remaining[pos]!
      const normalized = candidate.score / scale
      let maxSim = 0
      for (const sel of selected) {
        const sim = jaccard(candidate.tokens, sel.tokens)
        if (sim > maxSim) maxSim = sim
      }
      const mmrScore = lambda * normalized - (1 - lambda) * maxSim
      if (mmrScore > bestMmr || (mmrScore === bestMmr && candidate.score > remaining[bestPos]!.score)) {
        bestMmr = mmrScore
        bestPos = pos
      }
    }
    selected.push(remaining.splice(bestPos, 1)[0]!)
  }
  return selected
}

/**
 * Zero-dependency keyword recall over name+description+content head, with
 * time decay for transient categories and MMR diversity re-ranking. Returns
 * up to max(k, 5) entries, most relevant first.
 */
export function recallRelevant(query: string, entries: MemoryEntry[], k = 3): MemoryEntry[] {
  const queryTokens = tokenize(query)
  if (queryTokens.size === 0) return []
  const now = Date.now()
  const scored: RecallCandidate[] = []
  for (const entry of entries) {
    const headTokens = tokenize(`${entry.name} ${entry.description}`)
    const bodyTokens = tokenize(entry.content.slice(0, RECALL_CONTENT_CHARS))
    let headHits = 0
    for (const t of headTokens) if (queryTokens.has(t)) headHits++
    let bodyHits = 0
    for (const t of bodyTokens) if (queryTokens.has(t) && !headTokens.has(t)) bodyHits++
    const relevance =
      (headTokens.size ? headHits / Math.sqrt(headTokens.size) : 0) +
      0.5 * (bodyTokens.size ? bodyHits / Math.sqrt(bodyTokens.size) : 0)
    const score = relevance * recallRecencyMultiplier(entry, now)
    if (score <= 0.1) continue
    const tokens = new Set(headTokens)
    for (const t of bodyTokens) tokens.add(t)
    scored.push({ entry, tokens, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const limit = Math.max(k, 5)
  const pool = scored.slice(0, Math.max(limit, RECALL_MMR_POOL))
  return mmrSelect(pool, limit, RECALL_MMR_LAMBDA).map((s) => s.entry)
}

// ── legacy migration ────────────────────────────────────────────────────────

/**
 * Migrate <data root>/memory.json (Mnemosyne v1) into per-file project-scope
 * memories. Idempotent: the legacy file is renamed to memory.json.legacy on
 * success so the migration never re-runs.
 */
export async function migrateLegacyMemoryJson(cwd: string): Promise<number> {
  const legacyPath = join(resolveDataRootDir(cwd), 'memory.json')
  let raw: string
  try {
    raw = await readFile(legacyPath, 'utf8')
  } catch {
    return 0
  }
  let insights: Array<{ content?: string; category?: string; createdAt?: string }> = []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) insights = parsed
  } catch { /* corrupt legacy store — leave in place */ }

  let migrated = 0
  for (const insight of insights) {
    const content = String(insight?.content ?? '').trim()
    if (!content) continue
    const name = slugifyMemoryName(content.slice(0, 48))
    const result = await saveMemory(cwd, 'project', {
      name,
      description: content.slice(0, 120),
      category: sanitizeCategory(insight?.category),
      content,
      source: 'mnemosyne-v1-migration',
    }, { allowShrink: true })
    if (result.ok) migrated++
  }
  try {
    await rename(legacyPath, `${legacyPath}.legacy`)
  } catch { /* keep legacy file; next run retries (saves are idempotent) */ }
  return migrated
}

/** Ensure migration ran for this cwd. Cheap: one stat when nothing to do. */
export async function ensureMemoryMigrated(cwd: string): Promise<void> {
  try {
    await migrateLegacyMemoryJson(cwd)
  } catch { /* passive routine — never break the caller */ }
}

/** Ensure both scope dirs exist (used by onboarding/dashboard). */
export async function ensureMemoryDirs(cwd: string): Promise<void> {
  await mkdir(memoryDirForScope(cwd, 'global'), { recursive: true })
  if (!scopesCollide(cwd)) await mkdir(memoryDirForScope(cwd, 'project'), { recursive: true })
}
