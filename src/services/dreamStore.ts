/**
 * Dream system — persistence + config layer.
 *
 * Lives at ~/.artemis/dreams/. Keeps everything local; nothing leaves the
 * machine except the LLM/image-API calls the composer makes. The user can
 * delete the whole folder anytime with no side effects on Artemis itself.
 *
 * Layout:
 *   ~/.artemis/dreams/
 *     ├── config.json         — user preferences (mode, schedule)
 *     ├── index.json          — chronological list of dream entries
 *     ├── learned-prompt.md   — distilled style/preference suffix appended
 *     │                         to every system prompt (opt-in)
 *     ├── 2026-05-02_dawn.md  — individual dream texts
 *     └── 2026-05-02_dawn.png — optional vision-mode renders
 *     └── 2026-05-02_dawn.mp4 — optional video renders
 */

import path from 'node:path'
import { resolveArtemisHomeDir } from '../utils/fs.js'
import { mkdir, readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export type DreamMode = 'text' | 'vision' | 'off'

export interface DreamConfig {
  /** Whether the dream system is enabled at all. */
  enabled: boolean
  /** Output mode for new dreams. */
  mode: DreamMode
  /** Append distilled style/preferences to system prompt over time. */
  evolveSystemPrompt: boolean
  /** Push composed dreams to all active bridge chats. */
  pushToBridges: boolean
  /** Idle threshold in seconds before a dream may trigger. */
  idleThresholdSec: number
  /** Maximum dreams per 24h window (anti-spam). */
  maxDreamsPerDay: number
  /** Local-time night window where dreams are preferred (still trigger outside). */
  nightWindow: { startHour: number; endHour: number }
}

export interface DreamEntry {
  id: string
  createdAt: string
  mdPath: string
  imagePath?: string
  videoPath?: string
  trigger: 'idle-auto' | 'manual' | 'scheduled'
  /** Truncated first-paragraph preview for index listings. */
  preview: string
  /** Distilled style/insight lines that fed into learned-prompt.md (if any). */
  learned?: string[]
  /** Token cost of composing this dream (best-effort). */
  tokenCost?: { input: number; output: number }
}

const DREAMS_ROOT = process.env.ARTEMIS_DREAMS_ROOT && process.env.ARTEMIS_DREAMS_ROOT.trim().length > 0
  ? process.env.ARTEMIS_DREAMS_ROOT
  : path.join(resolveArtemisHomeDir(), 'dreams')
const CONFIG_FILE = path.join(DREAMS_ROOT, 'config.json')
const INDEX_FILE = path.join(DREAMS_ROOT, 'index.json')
const LEARNED_PROMPT_FILE = path.join(DREAMS_ROOT, 'learned-prompt.md')

/** Soft cap on learned-prompt.md to prevent runaway growth. */
const LEARNED_PROMPT_MAX_BYTES = 4096

const DEFAULT_CONFIG: DreamConfig = {
  enabled: true,
  // Default to vision so first-time users actually see the image-mode output
  // they likely expected when they signed up for "Artemis dreams". A configured
  // visual provider is required; if missing, the composer silently degrades to
  // text-only so the dream still completes.
  mode: 'vision',
  evolveSystemPrompt: true,
  pushToBridges: true,
  idleThresholdSec: 3600,
  maxDreamsPerDay: 3,
  nightWindow: { startHour: 23, endHour: 7 },
}

async function ensureRoot(): Promise<void> {
  await mkdir(DREAMS_ROOT, { recursive: true })
}

export function getDreamsRoot(): string {
  return DREAMS_ROOT
}

export async function loadDreamConfig(): Promise<DreamConfig> {
  await ensureRoot()
  if (!existsSync(CONFIG_FILE)) {
    await writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')
    return { ...DEFAULT_CONFIG }
  }
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<DreamConfig>
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      nightWindow: { ...DEFAULT_CONFIG.nightWindow, ...(raw.nightWindow ?? {}) },
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export async function saveDreamConfig(config: DreamConfig): Promise<void> {
  await ensureRoot()
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
}

export async function loadDreamIndex(): Promise<DreamEntry[]> {
  await ensureRoot()
  if (!existsSync(INDEX_FILE)) return []
  try {
    const raw = JSON.parse(await readFile(INDEX_FILE, 'utf8'))
    if (Array.isArray(raw)) return raw.filter((e): e is DreamEntry => typeof e?.id === 'string')
    return []
  } catch {
    return []
  }
}

export async function appendDreamIndex(entry: DreamEntry): Promise<void> {
  const current = await loadDreamIndex()
  current.unshift(entry)
  // Cap at 365 entries to keep file size reasonable; older ones stay on disk
  // as MD/PNG but stop being indexed.
  const trimmed = current.slice(0, 365)
  await writeFile(INDEX_FILE, JSON.stringify(trimmed, null, 2), 'utf8')
}

export async function updateDreamEntry(id: string, patch: Partial<DreamEntry>): Promise<DreamEntry | null> {
  const current = await loadDreamIndex()
  const index = current.findIndex(e => e.id === id)
  if (index < 0) return null
  const updated = { ...current[index], ...patch, id }
  current[index] = updated
  await writeFile(INDEX_FILE, JSON.stringify(current, null, 2), 'utf8')
  return updated
}

export async function removeDreamEntry(id: string): Promise<boolean> {
  const current = await loadDreamIndex()
  const target = current.find(e => e.id === id)
  if (!target) return false
  await Promise.all([
    unlink(target.mdPath).catch(() => undefined),
    target.imagePath ? unlink(target.imagePath).catch(() => undefined) : Promise.resolve(),
    target.videoPath ? unlink(target.videoPath).catch(() => undefined) : Promise.resolve(),
  ])
  const remaining = current.filter(e => e.id !== id)
  await writeFile(INDEX_FILE, JSON.stringify(remaining, null, 2), 'utf8')
  return true
}

export async function countDreamsInLast24h(): Promise<number> {
  const list = await loadDreamIndex()
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  return list.filter(e => {
    const ts = Date.parse(e.createdAt)
    return Number.isFinite(ts) && ts >= cutoff
  }).length
}

export function buildDreamId(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  const hour = now.getHours()
  const slot = hour < 5 ? 'midnight' : hour < 12 ? 'dawn' : hour < 18 ? 'noon' : 'night'
  // Append seconds to avoid collisions when two dreams fall in the same slot.
  return `${date}_${slot}_${now.getHours().toString().padStart(2, '0')}${now
    .getMinutes()
    .toString()
    .padStart(2, '0')}`
}

export function buildDreamPaths(id: string): { mdPath: string; imagePath: string; videoPath: string } {
  return {
    mdPath: path.join(DREAMS_ROOT, `${id}.md`),
    imagePath: path.join(DREAMS_ROOT, `${id}.png`),
    videoPath: path.join(DREAMS_ROOT, `${id}.mp4`),
  }
}

export async function loadLearnedPrompt(): Promise<string> {
  if (!existsSync(LEARNED_PROMPT_FILE)) return ''
  try {
    return (await readFile(LEARNED_PROMPT_FILE, 'utf8')).trim()
  } catch {
    return ''
  }
}

export async function appendLearnedPrompt(distilled: string[]): Promise<void> {
  if (distilled.length === 0) return
  await ensureRoot()
  const existing = await loadLearnedPrompt()
  const stamp = new Date().toISOString().slice(0, 10)
  const block = [`### ${stamp}`, ...distilled.map(line => `- ${line.trim()}`)].join('\n')
  let next = existing ? `${existing}\n\n${block}` : `# Artemis Learned Style\n\n${block}`
  // Cap size — when over budget, keep the most recent half. This is a coarse
  // truncation; a future iteration could ask the LLM to compress instead.
  if (Buffer.byteLength(next, 'utf8') > LEARNED_PROMPT_MAX_BYTES) {
    const halfPoint = Math.floor(next.length / 2)
    const trimAt = next.indexOf('### ', halfPoint)
    if (trimAt > 0) {
      next = `# Artemis Learned Style\n\n` + next.slice(trimAt)
    } else {
      next = `# Artemis Learned Style\n\n${block}`
    }
  }
  await writeFile(LEARNED_PROMPT_FILE, next, 'utf8')
}

export async function clearLearnedPrompt(): Promise<void> {
  if (existsSync(LEARNED_PROMPT_FILE)) {
    await unlink(LEARNED_PROMPT_FILE).catch(() => undefined)
  }
}

/**
 * Read a dream's body. Returns null if missing.
 */
export async function readDreamBody(id: string): Promise<string | null> {
  const { mdPath } = buildDreamPaths(id)
  if (!existsSync(mdPath)) return null
  try {
    return await readFile(mdPath, 'utf8')
  } catch {
    return null
  }
}


export async function findLatestDreamVideo(): Promise<string | null> {
  const indexed = await loadDreamIndex()
  for (const entry of indexed) {
    if (entry.videoPath && existsSync(entry.videoPath)) return entry.videoPath
    const { videoPath } = buildDreamPaths(entry.id)
    if (existsSync(videoPath)) return videoPath
  }
  try {
    const files = await readdir(DREAMS_ROOT)
    const videos = await Promise.all(files
      .filter(file => file.toLowerCase().endsWith('.mp4'))
      .map(async file => {
        const fullPath = path.join(DREAMS_ROOT, file)
        const info = await stat(fullPath)
        return { path: fullPath, mtimeMs: info.mtimeMs }
      }))
    videos.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return videos[0]?.path ?? null
  } catch {
    return null
  }
}

export async function findLatestDreamEntry(): Promise<DreamEntry | null> {
  const indexed = await loadDreamIndex()
  for (const entry of indexed) {
    if (entry.mdPath && existsSync(entry.mdPath)) return entry
  }
  return null
}

export async function findLatestDreamBody(): Promise<{ entry: DreamEntry; body: string } | null> {
  const entry = await findLatestDreamEntry()
  if (!entry) return null
  try {
    return { entry, body: await readFile(entry.mdPath, 'utf8') }
  } catch {
    return null
  }
}

export async function findLatestDreamImage(): Promise<string | null> {
  const indexed = await loadDreamIndex()
  for (const entry of indexed) {
    if (entry.imagePath && existsSync(entry.imagePath)) return entry.imagePath
  }

  await ensureRoot()
  try {
    const files = await readdir(DREAMS_ROOT)
    const images = await Promise.all(
      files
        .filter(file => /\.(png|jpe?g|webp|gif)$/i.test(file))
        .map(async file => {
          const fullPath = path.join(DREAMS_ROOT, file)
          try {
            const info = await stat(fullPath)
            return { fullPath, mtimeMs: info.mtimeMs }
          } catch {
            return null
          }
        }),
    )
    const latest = images
      .filter((item): item is { fullPath: string; mtimeMs: number } => item !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    return latest?.fullPath ?? null
  } catch {
    return null
  }
}

/**
 * Best-effort: scan ~/.artemis/sessions/*.json for sessions touched in the
 * last 24h. Used by the composer to gather "what did the user work on today".
 * Only returns light metadata + the first/last user message of each session
 * — never the full transcript — to keep prompts small and avoid leaking
 * arbitrary chat content into the dream LLM call.
 */
export async function gatherRecentSessionDigest(maxSessions = 8): Promise<string[]> {
  const sessionsDir = path.join(resolveArtemisHomeDir(), 'sessions')
  if (!existsSync(sessionsDir)) return []
  const files = await readdir(sessionsDir).catch(() => [])
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const recent: Array<{ file: string; mtime: number }> = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const st = await stat(path.join(sessionsDir, f))
      if (st.mtimeMs >= cutoff) recent.push({ file: f, mtime: st.mtimeMs })
    } catch { /* skip */ }
  }
  recent.sort((a, b) => b.mtime - a.mtime)

  const digests: string[] = []
  for (const { file } of recent.slice(0, maxSessions)) {
    try {
      const raw = JSON.parse(await readFile(path.join(sessionsDir, file), 'utf8'))
      const title: string = typeof raw?.title === 'string' ? raw.title : 'untitled session'
      const cwd: string = typeof raw?.cwd === 'string' ? raw.cwd : '?'
      const messages: unknown = raw?.messages ?? []
      let firstUser: string | undefined
      let lastUser: string | undefined
      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (m?.role === 'user' && typeof m?.content === 'string' && m.content.trim()) {
            const compact = m.content.replace(/\s+/g, ' ').slice(0, 220)
            firstUser ??= compact
            lastUser = compact
          }
        }
      }
      digests.push([
        `- ${title}`,
        `  cwd: ${cwd}`,
        firstUser ? `  first: ${firstUser}` : '',
        lastUser && lastUser !== firstUser ? `  last:  ${lastUser}` : '',
      ].filter(Boolean).join('\n'))
    } catch { /* skip malformed */ }
  }
  return digests
}
