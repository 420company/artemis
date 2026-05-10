import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

export function stripTerminalPathQuoting(text: string): string {
  let out = text.trim()
  if (out.length >= 2) {
    const first = out[0]
    const last = out[out.length - 1]
    if ((first === "'" || first === '"') && first === last) {
      out = out.slice(1, -1)
    }
  }
  // Finder/iTerm drag-and-drop escapes POSIX paths (`/a\ b`). Do not apply
  // that rule to Windows drive/UNC paths, where backslash is the separator.
  if (/^[A-Za-z]:\\/.test(out) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(out)) {
    return out
  }
  return out.replace(/\\(.)/g, '$1')
}

export function resolveTerminalPath(cwd: string, raw: string): string | null {
  let candidate = stripTerminalPathQuoting(raw)
  if (!candidate || candidate.includes('\n')) return null

  if (candidate.startsWith('file://')) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname)
      if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(candidate)) {
        candidate = candidate.slice(1)
      }
    } catch {
      return null
    }
  }

  if (candidate.startsWith('~/') || candidate === '~') {
    candidate = path.join(process.env.HOME ?? '', candidate.slice(2))
  }

  if (/^[A-Za-z]:[\\/]/.test(candidate) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(candidate)) {
    return candidate
  }

  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate)
}

export function looksLikeTerminalPathInput(text: string): boolean {
  const candidate = stripTerminalPathQuoting(text)
  if (!candidate || candidate.includes('\n')) return false
  return (
    candidate.startsWith('/') ||
    candidate.startsWith('~/') ||
    candidate === '~' ||
    candidate.startsWith('./') ||
    candidate.startsWith('../') ||
    candidate.startsWith('file://') ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(candidate)
  )
}

export function isExistingTerminalPath(cwd: string, text: string): boolean {
  if (!looksLikeTerminalPathInput(text)) return false
  const resolved = resolveTerminalPath(cwd, text)
  if (!resolved) return false
  try {
    return existsSync(resolved) && (statSync(resolved).isFile() || statSync(resolved).isDirectory())
  } catch {
    return false
  }
}
