/**
 * `artemis dream` — compose one dream headlessly and exit.
 *
 * For hosts that schedule dreams themselves (a server's nightly job) instead
 * of the interactive idle watcher. It never prompts: it reads the configured
 * main model and visual profile from providers.json, writes the diary (and
 * the picture, and optionally a short video) into the dream store, copies
 * them into `--out <dir>` when given, and prints one machine-readable line:
 *
 *   [dream:result] {"v":1,"status":"ok"|"skipped"|"failed",...}
 *
 * Options:
 *   --out <dir>          also copy the diary/picture/video here
 *   --no-image           diary only
 *   --video              also render a short video from the dream (off by default)
 *   --date YYYY-MM-DD    the material is that local day's sessions (default: the last 24 hours)
 *   --since-hours <n>    the material is the last n hours (1-168)
 *   --until <ISO time>   the window ends there instead of now (a host catching up a missed slot)
 *   --day YYYY-MM-DD     the day the dream is named after (default: the window's local day)
 *   --require-activity   skip (status "skipped", reason "no_activity") when no session was active in the window
 *   --locale zh-CN|en    language of the diary
 *   --push               also push to configured chat bridges (off by default; the host delivers)
 *   --taste-file <path>  the owner's taste (≤1 KB JSON, see services/dreamTaste.ts): steers this
 *                        dream's look and voice, in the diary and picture prompts only
 *   --explore            deliberately try a look/voice the taste does not favour yet
 *   --evolve             also add the dream's distilled style notes to the learned prompt (off by
 *                        default: headless dreams read session text, so their notes never reach
 *                        future system prompts unless the owner asks for it here)
 *   --json               print only the result line
 *
 * Exit code: 0 when the dream was written or skipped, 1 when it failed, 2 on bad arguments.
 */
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { constants as fsConstants, existsSync } from 'node:fs'
import path from 'node:path'
import type { UiLocale } from './locale.js'

export const DREAM_RESULT_MARKER = '[dream:result]'

export interface DreamCommandOptions {
  outDir?: string
  image: boolean
  video: boolean
  date?: string
  sinceHours?: number
  until?: Date
  day?: string
  requireActivity: boolean
  locale?: UiLocale
  push: boolean
  json: boolean
  evolve: boolean
  tasteFile?: string
  explore: boolean
}

export interface DreamCommandResult {
  v: 1
  status: 'ok' | 'skipped' | 'failed'
  /** Why it was skipped or failed (for logs; not meant for end users). */
  reason?: string
  id?: string
  /** Local day the material comes from (YYYY-MM-DD). */
  day: string
  createdAt?: string
  title?: string
  /** The diary text, without its title and the distilled notes. */
  diary?: string
  preview?: string
  learned?: string[]
  diaryPath?: string
  imagePath?: string
  videoPath?: string
  /** Why no picture/video was made, when one was asked for. */
  imageNote?: string
  videoNote?: string
  locale: UiLocale
  /** Engine sessions active in the window. */
  sessions: number
  /** The style choices the dream was made with (`dimension:value`). */
  style?: string[]
  /** It deliberately tried something the taste does not favour yet. */
  explore?: boolean
}

export class DreamArgsError extends Error {}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseDreamArgs(args: readonly string[]): DreamCommandOptions {
  const options: DreamCommandOptions = { image: true, video: false, requireActivity: false, push: false, json: false, evolve: false, explore: false }
  const rest = [...args]
  while (rest.length > 0) {
    const cur = rest.shift()!
    const [flag, inline] = cur.startsWith('--') && cur.includes('=') ? [cur.slice(0, cur.indexOf('=')), cur.slice(cur.indexOf('=') + 1)] : [cur, undefined]
    const value = (): string => {
      const v = inline ?? rest.shift()
      if (v === undefined || v === '' || (inline === undefined && v.startsWith('--'))) throw new DreamArgsError(`${flag} requires a value`)
      return v
    }
    switch (flag) {
      case '--out': options.outDir = path.resolve(value()); break
      case '--no-image': options.image = false; break
      case '--image': options.image = true; break
      case '--video': options.video = true; break
      case '--no-video': options.video = false; break
      case '--require-activity': options.requireActivity = true; break
      case '--push': options.push = true; break
      case '--json': options.json = true; break
      case '--evolve': options.evolve = true; break
      case '--explore': options.explore = true; break
      case '--taste-file': options.tasteFile = path.resolve(value()); break
      case '--locale': {
        const v = value().toLowerCase()
        if (v.startsWith('zh')) options.locale = 'zh-CN'
        else if (v.startsWith('en')) options.locale = 'en'
        else throw new DreamArgsError('--locale must be zh-CN or en')
        break
      }
      case '--date': {
        const v = value()
        const m = DATE_RE.exec(v)
        const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined
        if (!m || !d || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) throw new DreamArgsError('--date must be YYYY-MM-DD')
        options.date = v
        break
      }
      case '--until': {
        const v = value()
        const t = Date.parse(v)
        if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || !Number.isFinite(t)) throw new DreamArgsError('--until must be an ISO date-time')
        options.until = new Date(t)
        break
      }
      case '--day': {
        const v = value()
        if (!DATE_RE.test(v)) throw new DreamArgsError('--day must be YYYY-MM-DD')
        options.day = v
        break
      }
      case '--since-hours': {
        const n = Number(value())
        if (!Number.isFinite(n) || n < 1 || n > 168) throw new DreamArgsError('--since-hours must be between 1 and 168')
        options.sinceHours = n
        break
      }
      default:
        throw new DreamArgsError(`Unknown option for dream: ${cur}`)
    }
  }
  if (options.date && (options.sinceHours !== undefined || options.until)) throw new DreamArgsError('Give either --date or --since-hours/--until, not both')
  return options
}

/** Local YYYY-MM-DD of a time. */
export function localDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** The window whose sessions are the dream's material, and the day it is named after. */
export function dreamWindow(options: Pick<DreamCommandOptions, 'date' | 'sinceHours' | 'until' | 'day'>, now: Date = new Date()): { sinceMs: number; untilMs: number; day: string } {
  if (options.date) {
    const m = DATE_RE.exec(options.date)!
    const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)
    return { sinceMs: start.getTime(), untilMs: Math.min(end.getTime() - 1, now.getTime()), day: options.date }
  }
  const hours = options.sinceHours ?? 24
  const until = Math.min(options.until?.getTime() ?? now.getTime(), now.getTime())
  return { sinceMs: until - hours * 3_600_000, untilMs: until, day: options.day ?? localDay(new Date(until)) }
}

/** Title, diary body and distilled notes of a composed dream's markdown. */
export function splitDreamMarkdown(md: string): { title?: string; diary: string } {
  const text = md.replace(/^<!--[\s\S]*?-->\s*/, '').trim()
  const titleMatch = /^#\s+(.+)$/m.exec(text)
  const title = titleMatch?.[1]?.trim()
  const diary = text
    .replace(/^#\s+.+\n*/m, '')
    .replace(/#{2,4}\s*(?:学到了什么|What I learned)[\s\S]*$/i, '')
    .trim()
  return { ...(title ? { title } : {}), diary }
}

export function formatDreamResultLine(result: DreamCommandResult): string {
  return `${DREAM_RESULT_MARKER} ${JSON.stringify(result)}`
}

/** Copies a dream file into `outDir`, never over an existing file (a numbered name instead). */
async function copyInto(outDir: string | undefined, file: string | undefined, day: string): Promise<string | undefined> {
  if (!file || !existsSync(file)) return undefined
  if (!outDir) return file
  await mkdir(outDir, { recursive: true })
  const base = path.basename(file)
  const name = base.startsWith(day) ? base : `${day}_${base}`
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 0; n < 100; n += 1) {
    const target = path.join(outDir, n === 0 ? name : `${stem}-${n + 1}${ext}`)
    try {
      await copyFile(file, target, fsConstants.COPYFILE_EXCL)
      return target
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error(`no free file name for ${name} in ${outDir}`)
}

export async function runDreamCommand(input: {
  cwd: string
  locale: UiLocale
  args: readonly string[]
  /** Overrides for tests. */
  now?: () => Date
  write?: (line: string) => void
  status?: (line: string) => void
}): Promise<{ exitCode: number; result?: DreamCommandResult }> {
  const write = input.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  let options: DreamCommandOptions
  try {
    options = parseDreamArgs(input.args)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`dream: ${message}\n`)
    return { exitCode: 2 }
  }
  const locale = options.locale ?? input.locale
  const status = options.json ? () => undefined : (input.status ?? ((line: string) => process.stderr.write(`${line}\n`)))
  const now = input.now?.() ?? new Date()
  const window = dreamWindow(options, now)
  const { countRecentSessions } = await import('../services/dreamStore.js')
  const sessions = await countRecentSessions({ cwd: input.cwd, sinceMs: window.sinceMs, untilMs: window.untilMs })
  const finish = (result: DreamCommandResult, exitCode: number) => {
    write(formatDreamResultLine(result))
    return { exitCode, result }
  }
  if (options.requireActivity && sessions === 0) {
    return finish({ v: 1, status: 'skipped', reason: 'no_activity', day: window.day, locale, sessions }, 0)
  }

  // The owner's taste: bounded, vocabulary-only weights and their own notes.
  const { chooseDreamStyle, parseDreamTaste, DREAM_TASTE_MAX_BYTES } = await import('../services/dreamTaste.js')
  let taste
  if (options.tasteFile) {
    try {
      const info = await stat(options.tasteFile)
      if (info.size > DREAM_TASTE_MAX_BYTES) throw new Error(`the taste file is larger than ${DREAM_TASTE_MAX_BYTES} bytes`)
      taste = parseDreamTaste(await readFile(options.tasteFile, 'utf8'))
    } catch (err) {
      process.stderr.write(`dream: --taste-file: ${err instanceof Error ? err.message : String(err)}\n`)
      return { exitCode: 2 }
    }
  }
  const style = chooseDreamStyle({ ...(taste ? { taste } : {}), explore: options.explore })

  const { composeDream } = await import('../services/dreamComposer.js')
  let composed
  try {
    composed = await composeDream({
      cwd: input.cwd,
      trigger: 'scheduled',
      locale,
      window: { sinceMs: window.sinceMs, untilMs: window.untilMs },
      onStatus: status,
      style,
      ...(taste ? { taste } : {}),
      // The host decides when to dream and where it goes: never the idle cap or bridges here.
      configOverride: { enabled: true, mode: options.image ? 'vision' : 'text', pushToBridges: options.push, evolveSystemPrompt: options.evolve },
    })
  } catch (err) {
    composed = { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
  if (!composed.ok || !composed.entry) {
    return finish({ v: 1, status: 'failed', reason: composed.reason ?? 'unknown', day: window.day, locale, sessions }, 1)
  }

  let entry = composed.entry
  let videoNote: string | undefined
  if (options.video) {
    try {
      const { generateDreamVideo } = await import('../services/dreamVideo.js')
      const video = await generateDreamVideo({ cwd: input.cwd, id: entry.id, locale, onStatus: status })
      if (video.ok && video.entry) entry = video.entry
      else videoNote = video.reason ?? 'no video'
    } catch (err) {
      videoNote = err instanceof Error ? err.message : String(err)
    }
  }

  const md = await readFile(entry.mdPath, 'utf8').catch(() => '')
  const { title, diary } = splitDreamMarkdown(md)
  const diaryPath = await copyInto(options.outDir, entry.mdPath, window.day)
  const imagePath = await copyInto(options.outDir, entry.imagePath, window.day)
  const videoPath = await copyInto(options.outDir, entry.videoPath, window.day)
  return finish({
    v: 1,
    status: 'ok',
    id: entry.id,
    day: window.day,
    createdAt: entry.createdAt,
    ...(title ? { title } : {}),
    diary,
    preview: entry.preview,
    ...(entry.learned?.length ? { learned: entry.learned } : {}),
    ...(diaryPath ? { diaryPath } : {}),
    ...(imagePath ? { imagePath } : {}),
    ...(videoPath ? { videoPath } : {}),
    ...(options.image && !imagePath && composed.imageNote ? { imageNote: composed.imageNote } : {}),
    ...(options.image && !imagePath && !composed.imageNote ? { imageNote: 'no image' } : {}),
    ...(videoNote ? { videoNote } : {}),
    locale,
    sessions,
    style: entry.style ?? [],
    explore: options.explore,
  }, 0)
}
