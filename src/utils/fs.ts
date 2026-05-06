/* eslint-disable @typescript-eslint/no-unused-vars */
import { access, mkdir, readdir, readFile } from 'node:fs/promises'
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
]

type WalkFilesCacheEntry = {
  createdAt: number
  files: string[]
}

const WALK_FILES_CACHE = new Map<string, WalkFilesCacheEntry>()
const WALK_FILES_CACHE_TTL_MS = 4_000

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
  return false
}

/** Throws if `absolute` is a sensitive path. Use to guard write tools. */
export function ensureNotSensitivePath(absolute: string, inputPath: string): void {
  if (isSensitivePath(absolute)) {
    throw new Error(`Access denied: ${inputPath} is in a protected directory.`)
  }
}

export function resolveDataRootDir(cwd: string): string {
  const normalized = resolve(cwd)
  if (basename(normalized) === '.artemis') return normalized
  const homeDir = resolve(homedir())
  // If cwd is a filesystem/account-container root, use the user's home data
  // root instead of trying to create /.artemis or /Users/.artemis.
  if (normalized === '/' || normalized === sep || normalized === dirname(homeDir)) {
    return join(homeDir, '.artemis')
  }
  return join(normalized, '.artemis')
}

export function resolveInsideRoot(root: string, inputPath: string): string {
  const normalizedRoot = resolve(root)
  const absolute = resolve(normalizedRoot, inputPath)
  const relativePath = relative(normalizedRoot, absolute)
  if (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  ) {
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
    if (
      key === normalizedRoot ||
      key.startsWith(`${normalizedRoot}${sep}`) ||
      normalizedRoot.startsWith(`${key}${sep}`)
    ) {
      WALK_FILES_CACHE.delete(key)
    }
  }
}

export async function walkFiles(root: string): Promise<string[]> {
  const normalizedRoot = resolve(root)
  const cached = WALK_FILES_CACHE.get(normalizedRoot)
  const now = Date.now()

  if (cached && now - cached.createdAt <= WALK_FILES_CACHE_TTL_MS) {
    return [...cached.files]
  }

  const output: string[] = []
  
  // Parallel walker with concurrency control
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    
    const tasks = entries.map(async (entry) => {
      if (DEFAULT_IGNORES.has(entry.name)) return
      if (entry.name.startsWith('.')) return // Ignore other hidden files
      
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
  WALK_FILES_CACHE.set(normalizedRoot, {
    createdAt: now,
    files: [...output],
  })
  return output
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`
}
