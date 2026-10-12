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
import { resolveArtemisHomeDir, resolveDataRootDir } from '../utils/fs.js'
import { mkdir, readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export type DreamMode = 'text' | 'vision' | 'off'

export interface DreamConfig {
  /** Whether the dream system is enabled at all. */
  enabled: boolean
  /** Output mode for new dreams. */
  mode: DreamMode
  /**
   * Append distilled style/preferences to system prompt over time. Off unless
   * the owner turned it on in the setup wizard (`evolveChosen`): the notes come
   * from a model that read session text, and the filter on them is a guard,
   * not a guarantee.
   */
  evolveSystemPrompt: boolean
  /** The owner chose evolveSystemPrompt themselves (older files' `true` is not a choice). */
  evolveChosen?: boolean
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
  /** The style choices it was made with (`dimension:value`, see dreamTaste.ts). */
  style?: string[]
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
  evolveSystemPrompt: false,
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
      // Earlier versions wrote `true` as the default: only an explicit choice counts.
      evolveSystemPrompt: raw.evolveChosen === true && raw.evolveSystemPrompt === true,
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

/**
 * A dream's id: the local date, the time-of-day slot, the local time to the
 * second and a short random suffix, so two dreams never share files (two
 * runs in the same second included).
 */
export function buildDreamId(now: Date = new Date(), random: () => number = Math.random): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const hour = now.getHours()
  const slot = hour < 5 ? 'midnight' : hour < 12 ? 'dawn' : hour < 18 ? 'noon' : 'night'
  const suffix = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')
  return `${date}_${slot}_${pad(hour)}${pad(now.getMinutes())}${pad(now.getSeconds())}-${suffix}`
}

export function buildDreamPaths(id: string): { mdPath: string; imagePath: string; videoPath: string } {
  return {
    mdPath: path.join(DREAMS_ROOT, `${id}.md`),
    imagePath: path.join(DREAMS_ROOT, `${id}.png`),
    videoPath: path.join(DREAMS_ROOT, `${id}.mp4`),
  }
}

/** Longest distilled line kept, in characters. */
export const LEARNED_LINE_MAX_CHARS = 160

/**
 * Lines that are not style notes: they name places, run things or talk about
 * secrets and instructions. Dream notes come from a model that read session
 * text (and, through memories, tool output), so anything here may be an
 * injected instruction; only plain notes about tone and style are kept.
 */
const LEARNED_LINE_DENY: RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[\w-]+\.(?:com|net|org|io|dev|ai|xyz|ru|cn|me|app)\b/i, // URLs and hosts
  /(?:^|[\s"'`(])(?:~|\.{1,2})?\/[\w.-]|[a-z]:\\|\\\\/i, // file paths
  /`|\$\(|\$\{|&&|\|\||;\s*\w|\|\s*\w|>\s*\/|\b(?:curl|wget|rm|sudo|ssh|scp|chmod|chown|bash|sh|zsh|python3?|node|npm|npx|pip|git|eval|exec|powershell|nc|base64)\b/i, // commands
  /\b(?:password|passwd|passphrase|token|api[\s_-]?key|secret|credential|private[\s_-]?key|seed[\s_-]?phrase|mnemonic|cookie|session[\s_-]?id|wallet|\.ssh|\.env)\b|密码|口令|密钥|私钥|令牌|助记词|凭据|钱包|cookie/i, // secrets
  /\b(?:ignore|disregard|override|forget)\b.{0,40}\b(?:previous|prior|above|earlier|system|instructions?|rules?)\b|\bsystem prompt\b|\b(?:always|never|must)\s+(?:send|upload|post|share|forward|reveal|run|execute|delete|disable|bypass|obey)\b|\bfrom now on\b|忽略.{0,10}(?:之前|以上|上面|规则|指令)|系统提示|发送到|上传到|转发到|一律|从现在起/i, // instructions
]

/** The style notes worth keeping from a dream's "what I learned" lines (see LEARNED_LINE_DENY). */
export function sanitizeLearnedLines(lines: readonly string[]): string[] {
  const kept: string[] = []
  for (const raw of lines) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, ' ').replace(/^[-•*]\s*/, '').replace(/\s+/g, ' ').trim()
    if (!line || [...line].length > LEARNED_LINE_MAX_CHARS) continue
    if (/^#|<\/?[a-z_]+>/i.test(line)) continue
    if (LEARNED_LINE_DENY.some((re) => re.test(line))) continue
    kept.push(line)
  }
  return kept
}

/**
 * The learned style notes, as stored, with every note that would not pass
 * sanitizeLearnedLines dropped (a file written by an older version, or by
 * hand, is filtered the same way).
 */
export async function loadLearnedPrompt(): Promise<string> {
  if (!existsSync(LEARNED_PROMPT_FILE)) return ''
  try {
    const text = (await readFile(LEARNED_PROMPT_FILE, 'utf8')).trim()
    const out: string[] = []
    for (const line of text.split('\n')) {
      if (/^#{1,3}\s/.test(line) || !line.trim()) out.push(line)
      else if (sanitizeLearnedLines([line]).length > 0) out.push(`- ${sanitizeLearnedLines([line])[0]}`)
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  } catch {
    return ''
  }
}

export async function appendLearnedPrompt(distilled: string[]): Promise<void> {
  const notes = sanitizeLearnedLines(distilled)
  if (notes.length === 0) return
  await ensureRoot()
  const existing = await loadLearnedPrompt()
  const stamp = new Date().toISOString().slice(0, 10)
  const block = [`### ${stamp}`, ...notes.map(line => `- ${line}`)].join('\n')
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

/** Which sessions count as "today" for a dream: modified inside the window. */
export interface DreamActivityWindow {
  /** Workspace whose engine sessions count too (headless runs keep them there). */
  cwd?: string
  /** Start of the window, ms since epoch (default: 24 hours before `untilMs`). */
  sinceMs?: number
  /** End of the window, ms since epoch (default: now). */
  untilMs?: number
}

/**
 * Session directories a dream reads: the workspace's own data root (where
 * headless runs such as `artemis execute` keep their sessions) and the
 * global ~/.artemis/sessions, without duplicates.
 */
function dreamSessionDirs(cwd: string | undefined): string[] {
  const dirs = [
    ...(cwd ? [path.join(resolveDataRootDir(cwd), 'sessions')] : []),
    path.join(resolveArtemisHomeDir(), 'sessions'),
  ].map((dir) => path.resolve(dir))
  return [...new Set(dirs)]
}

/** Session files read per dream at most, and the largest one read. */
const MAX_SESSION_FILES = 200
const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024

interface WindowSession {
  file: string
  title: string
  cwd: string
  /** User messages written inside the window, oldest first. */
  userMessages: string[]
  /** When the session last had activity inside the window. */
  lastAt: number
}

const timeOf = (value: unknown): number | undefined => {
  const t = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(t) ? t : undefined
}

/**
 * Sessions with activity inside the window, newest first. A session counts
 * by when its messages were written (their `createdAt`), not by when its file
 * was last touched: a session first used today but saved again tomorrow still
 * belongs to today. A message without a time takes the session's
 * `updatedAt`, then the file time. Files last modified before the window
 * cannot hold anything inside it and are not read.
 */
async function listWindowSessions(window: DreamActivityWindow = {}): Promise<WindowSession[]> {
  const untilMs = window.untilMs ?? Date.now()
  const sinceMs = window.sinceMs ?? untilMs - 24 * 60 * 60 * 1000
  const candidates: Array<{ file: string; mtime: number; size: number }> = []
  for (const dir of dreamSessionDirs(window.cwd)) {
    if (!existsSync(dir)) continue
    const files = await readdir(dir).catch(() => [] as string[])
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const file = path.join(dir, f)
      try {
        const st = await stat(file)
        if (st.mtimeMs >= sinceMs) candidates.push({ file, mtime: st.mtimeMs, size: st.size })
      } catch { /* skip */ }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  const inWindow = (t: number) => t >= sinceMs && t <= untilMs
  const sessions: WindowSession[] = []
  for (const { file, mtime, size } of candidates.slice(0, MAX_SESSION_FILES)) {
    if (size > MAX_SESSION_FILE_BYTES) continue
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      const fallback = timeOf(raw?.updatedAt) ?? mtime
      const messages = Array.isArray(raw?.messages) ? (raw.messages as Array<Record<string, unknown>>) : []
      let lastAt: number | undefined
      const userMessages: string[] = []
      for (const m of messages) {
        const at = timeOf(m?.createdAt) ?? fallback
        if (!inWindow(at)) continue
        lastAt = Math.max(lastAt ?? at, at)
        if (m?.role === 'user' && typeof m?.content === 'string' && m.content.trim()) {
          userMessages.push(m.content.replace(/\s+/g, ' ').slice(0, 220))
        }
      }
      if (lastAt === undefined) continue
      sessions.push({
        file,
        title: typeof raw?.title === 'string' ? raw.title : 'untitled session',
        cwd: typeof raw?.cwd === 'string' ? raw.cwd : '?',
        userMessages,
        lastAt,
      })
    } catch { /* skip malformed */ }
  }
  return sessions.sort((a, b) => b.lastAt - a.lastAt)
}

/** How many engine sessions were active in the window (0 = nothing to dream about). */
export async function countRecentSessions(window: DreamActivityWindow = {}): Promise<number> {
  return (await listWindowSessions(window)).length
}

/**
 * Best-effort: scan the workspace's and ~/.artemis's sessions/*.json for
 * sessions with activity in the window (default: the last 24h). Used by the
 * composer to gather "what did the user work on today".
 * Only returns light metadata + the first/last user message of each session
 * — never the full transcript — to keep prompts small and avoid leaking
 * arbitrary chat content into the dream LLM call.
 */
export async function gatherRecentSessionDigest(maxSessions = 8, window: DreamActivityWindow = {}): Promise<string[]> {
  const sessions = await listWindowSessions(window)
  return sessions.slice(0, maxSessions).map(({ title, cwd, userMessages }) => {
    const firstUser = userMessages[0]
    const lastUser = userMessages.at(-1)
    return [
      `- ${title}`,
      `  cwd: ${cwd}`,
      firstUser ? `  first: ${firstUser}` : '',
      lastUser && lastUser !== firstUser ? `  last:  ${lastUser}` : '',
    ].filter(Boolean).join('\n')
  })
}
