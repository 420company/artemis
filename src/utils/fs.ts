/* eslint-disable @typescript-eslint/no-unused-vars */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { access, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, basename, dirname, resolve, relative, sep, extname, isAbsolute } from 'node:path'

const DEFAULT_IGNORES = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', '.artemis',
])

// Paths that must never be read or written by the AI regardless of cwd.
// These contain credentials, API keys, SSH/GPG keys, or tool data.
const SENSITIVE_PATH_SEGMENTS = [
  '.claude',
  '.env',
  '.netrc',
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gh',
  // The agent's own credentials and VPN profiles (security/credentialStore.ts, tools/serverSetup).
  'agent-credentials',
  'vpn-profiles',
]

type WalkFilesCacheEntry = {
  createdAt: number
  files: string[]
}

const WALK_FILES_CACHE = new Map<string, WalkFilesCacheEntry>()
const WALK_FILES_CACHE_TTL_MS = 4_000
const WALK_HIDDEN_CACHE_PREFIX = 'hidden:'

export function isSensitivePath(absolute: string): boolean {
  const home = homedir()
  const normalized = absolute.replace(/\\/g, '/')
  const normalizedHome = home.replace(/\\/g, '/')
  if (
    normalized === `${normalizedHome}/.artemis/gateway.log` ||
    normalized === `${normalizedHome}/.artemis/gateway.launchd.log` ||
    normalized === `${normalizedHome}/.artemis/gateway.launchd.err.log` ||
    normalized.startsWith(`${normalizedHome}/.artemis/dreams/`)
  ) {
    return false
  }
  // Artemis' data root is a mixed directory: some files are credentials while
  // others are user-visible logs/assets. Do not block the whole tree; block the
  // known secret-bearing files below so tools can inspect benign paths without
  // triggering a workspace-switch refusal for ~/.artemis itself.
  for (const seg of SENSITIVE_PATH_SEGMENTS) {
    if (normalized.includes(`/${seg}/`) || normalized.endsWith(`/${seg}`)) return true
    if (normalized === join(home, seg).replace(/\\/g, '/')) return true
  }
  const base = basename(absolute).toLowerCase()
  if (base === '.env' || base.startsWith('.env.') || base === '.netrc') return true
  if (base === 'providers.json' || base === 'bragi.json' || base === 'vercel.json') return true
  // The approval key, and the owner's approval policy in a data dir (security/approvals.ts).
  if (base === 'approvals.key') return true
  if (base === 'approvals.json') {
    const parent = resolve(dirname(absolute))
    const dataHome = resolveArtemisHomeDir()
    if (basename(parent) === '.artemis' || parent === dataHome || parent.startsWith(`${dataHome}${sep}`)) return true
  }
  return false
}

/** The agent's own credential store and VPN profiles: closed to file tools in every permission mode. */
export function isAlwaysPrivatePath(absolute: string): boolean {
  const normalized = absolute.replace(/\\/g, '/')
  return /(^|\/)(agent-credentials|vpn-profiles)(\/|$)/.test(normalized)
}

/** Throws if `absolute` is a sensitive path. Use to guard write tools. */
export function ensureNotSensitivePath(absolute: string, inputPath: string): void {
  if (isSensitivePath(absolute)) {
    throw new Error(`Access denied: ${inputPath} is in a protected directory.`)
  }
}

export function resolveArtemisHomeDir(): string {
  const explicit = process.env.ARTEMIS_HOME?.trim()
  if (explicit) return resolve(explicit)
  return join(resolve(homedir()), '.artemis')
}

export function resolveDataRootDir(cwd: string): string {
  const normalized = resolve(cwd)
  const explicitHome = process.env.ARTEMIS_HOME?.trim()
  if (explicitHome) {
    const root = resolve(explicitHome)
    if (normalized === root || basename(normalized) === '.artemis') return root
    const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 16)
    return join(root, 'workspaces', hash)
  }
  if (basename(normalized) === '.artemis') return normalized
  const homeDir = resolve(homedir())
  // If cwd is a filesystem/account-container root, use the user's home data
  // root instead of trying to create /.artemis or /Users/.artemis.
  if (normalized === '/' || normalized === sep || normalized === dirname(homeDir)) {
    return join(homeDir, '.artemis')
  }
  return join(normalized, '.artemis')
}

function isWithinPath(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

/** The real path: symlinks followed as far as the path exists, the rest appended. */
export function realPathOf(target: string): string {
  let current = resolve(target)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return join(current, ...rest.reverse())
      rest.push(basename(current))
      current = parent
    }
  }
}

/**
 * `inputPath` inside `root`, both as written and through symlinks: a link
 * in the workspace that points outside (`link/sub`, or the link itself)
 * does not count as inside.
 */
export function resolveInsideRoot(root: string, inputPath: string): string {
  const normalizedRoot = resolve(root)
  const absolute = resolve(normalizedRoot, inputPath)
  if (isWithinPath(normalizedRoot, absolute) && isWithinPath(realPathOf(normalizedRoot), realPathOf(absolute))) {
    return absolute
  }
  throw new Error(`Path escapes working directory: ${inputPath}`)
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function readTextFileSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(`File not found: ${filePath}`)
  }
}

export function invalidateWalkFilesCache(root?: string): void {
  if (!root) {
    WALK_FILES_CACHE.clear()
    return
  }

  const normalizedRoot = resolve(root)
  const keys = Array.from(WALK_FILES_CACHE.keys())
  for (const key of keys) {
    const keyPath = key.startsWith(WALK_HIDDEN_CACHE_PREFIX)
      ? key.slice(WALK_HIDDEN_CACHE_PREFIX.length)
      : key
    if (
      keyPath === normalizedRoot ||
      keyPath.startsWith(`${normalizedRoot}${sep}`) ||
      normalizedRoot.startsWith(`${keyPath}${sep}`)
    ) {
      WALK_FILES_CACHE.delete(key)
    }
  }
}

export async function walkFiles(root: string, opts: { includeHidden?: boolean } = {}): Promise<string[]> {
  const normalizedRoot = resolve(root)
  const includeHidden = opts.includeHidden === true
  // Separate cache entry per visibility mode; prefix can't collide with an
  // absolute path (those start with / or a drive letter).
  const cacheKey = includeHidden ? `${WALK_HIDDEN_CACHE_PREFIX}${normalizedRoot}` : normalizedRoot
  const cached = WALK_FILES_CACHE.get(cacheKey)
  const now = Date.now()

  if (cached && now - cached.createdAt <= WALK_FILES_CACHE_TTL_MS) {
    return [...cached.files]
  }

  const output: string[] = []

  // Parallel walker with concurrency control
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })

    const tasks = entries.map(async (entry) => {
      // DEFAULT_IGNORES always applies — .git/.artemis hold credentials/noise.
      if (DEFAULT_IGNORES.has(entry.name)) return
      if (!includeHidden && entry.name.startsWith('.')) return // Ignore other hidden files

      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
      } else if (entry.isFile()) {
        output.push(fullPath)
      }
    })

    await Promise.all(tasks)
  }

  await visit(normalizedRoot)
  WALK_FILES_CACHE.set(cacheKey, {
    createdAt: now,
    files: [...output],
  })
  return output
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`
}

/**
 * Like truncate, for text that sits inside a sentence or a one-line field:
 * no line break is added (a reason in "Could not … (<reason>), …" stays on
 * one line however long it was).
 */
export function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}… [+${text.length - maxChars} chars]`
}

// Opened without following a symlink as the file itself, and without
// blocking on a FIFO (refused below as not a regular file).
const NO_FOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)

export interface OwnFileOptions {
  /** The real path of the file must stay inside this folder (symlinked parents included). */
  folder?: string
  /** Larger files are refused. */
  maxBytes?: number
}

function ownFileError(file: string, why: string): Error {
  return Object.assign(new Error(`${basename(file)} ${why}`), { code: 'EOWNFILE' })
}

/** Where open() cannot refuse a link itself (no O_NOFOLLOW), it is checked first. */
function refuseLinkWithoutNoFollow(file: string): void {
  if (fsConstants.O_NOFOLLOW === undefined && lstatSync(file).isSymbolicLink()) throw ownFileError(file, 'is a link, which is not read')
}

function insideFolder(realFile: string, realFolder: string): boolean {
  return realFile !== realFolder && isWithinPath(realFolder, realFile)
}

/**
 * The text of a file a skill (or other installable content) is made of:
 * refused when the file is a symlink, is not a regular file, is larger than
 * `maxBytes`, or (given `folder`) resolves outside that folder. A link in a
 * skill folder never pulls another file (credentials, settings) into a run.
 */
export async function readOwnFileText(file: string, options: OwnFileOptions = {}): Promise<string> {
  if (options.folder !== undefined) {
    const [realFile, realFolder] = await Promise.all([realpath(file), realpath(options.folder)])
    if (!insideFolder(realFile, realFolder)) throw ownFileError(file, 'is outside its folder')
  }
  refuseLinkWithoutNoFollow(file)
  let handle: import('node:fs/promises').FileHandle
  try {
    handle = await open(file, NO_FOLLOW_FLAGS)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw ownFileError(file, 'is a link, which is not read')
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw ownFileError(file, 'is not a regular file')
    if (options.maxBytes !== undefined && info.size > options.maxBytes) throw ownFileError(file, 'is too large')
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/** readOwnFileText, synchronously. */
export function readOwnFileTextSync(file: string, options: OwnFileOptions = {}): string {
  if (options.folder !== undefined && !insideFolder(realpathSync(file), realpathSync(options.folder))) {
    throw ownFileError(file, 'is outside its folder')
  }
  refuseLinkWithoutNoFollow(file)
  let fd: number
  try {
    fd = openSync(file, NO_FOLLOW_FLAGS)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw ownFileError(file, 'is a link, which is not read')
    throw error
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw ownFileError(file, 'is not a regular file')
    if (options.maxBytes !== undefined && info.size > options.maxBytes) throw ownFileError(file, 'is too large')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** A regular file at this path, not a symlink. */
export function isOwnFile(file: string): boolean {
  try {
    return lstatSync(file).isFile()
  } catch {
    return false
  }
}
