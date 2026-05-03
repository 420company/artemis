import path from 'node:path'
import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'

export type WorkspacePathResolution = {
  requestedPath: string
  workspacePath: string
  usedNearestExistingParent: boolean
}

export function expandHomePath(input: string, homeDir = homedir()): string {
  if (input === '~') return homeDir
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homeDir, input.slice(2))
  }
  if (input === '$HOME' || input === '${HOME}') return homeDir
  if (input.startsWith('$HOME/') || input.startsWith('$HOME\\')) {
    return path.join(homeDir, input.slice(6))
  }
  if (input.startsWith('${HOME}/') || input.startsWith('${HOME}\\')) {
    return path.join(homeDir, input.slice(8))
  }
  return input
}

export function isWindowsAbsolutePath(inputPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(inputPath) || /^\\\\[^\\]+\\[^\\]+/.test(inputPath)
}

function isWindowsLikePath(inputPath: string): boolean {
  return /^[A-Za-z]:(?:[\\/]|$)/.test(inputPath) || /^\\\\/.test(inputPath)
}

export function resolveWorkspaceCandidatePath(
  inputPath: string,
  currentCwd: string,
  homeDir = homedir(),
): string {
  const expanded = expandHomePath(inputPath, homeDir)
  if (isWindowsAbsolutePath(expanded)) {
    return path.win32.normalize(expanded)
  }
  if (isWindowsLikePath(currentCwd)) {
    return path.win32.resolve(currentCwd, expanded)
  }
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(currentCwd, expanded)
}

export function isPathInsideWorkspace(root: string, target: string): boolean {
  if (isWindowsLikePath(root) && isWindowsLikePath(target)) {
    const normalizedRoot = path.win32.resolve(root).toLowerCase()
    const normalizedTarget = path.win32.resolve(target).toLowerCase()
    const relativePath = path.win32.relative(normalizedRoot, normalizedTarget)
    return (
      relativePath === '' ||
      (!relativePath.startsWith(`..${path.win32.sep}`) && relativePath !== '..' && !path.win32.isAbsolute(relativePath))
    )
  }
  const normalizedRoot = canonicalizeComparablePath(root)
  const normalizedTarget = canonicalizeComparablePath(target)
  const relativePath = path.relative(normalizedRoot, normalizedTarget)
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
  )
}

export function isOverbroadTrustedWorkspaceRoot(
  candidatePath: string,
  homeDir = homedir(),
): boolean {
  const candidate = canonicalizeComparablePath(candidatePath)
  const normalizedHome = canonicalizeComparablePath(homeDir)
  const filesystemRoot = path.parse(candidate).root

  if (candidate === filesystemRoot) {
    return true
  }

  return isPathInsideWorkspace(candidate, normalizedHome)
}

function canonicalizeComparablePath(inputPath: string): string {
  const resolved = path.resolve(inputPath)
  let current = resolved

  for (;;) {
    try {
      const realCurrent = path.resolve(realpathSync.native(current))
      if (current === resolved) {
        return realCurrent
      }
      const remainder = path.relative(current, resolved)
      return path.resolve(realCurrent, remainder)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }
  }

  if (resolved.startsWith('/private/var/')) {
    return resolved.replace(/^\/private/, '')
  }
  if (resolved.startsWith('/private/tmp/')) {
    return resolved.replace(/^\/private/, '')
  }
  return resolved
}

export async function findNearestExistingWorkspaceRoot(
  candidatePath: string,
): Promise<WorkspacePathResolution | null> {
  const requestedPath = path.resolve(candidatePath)
  let current = requestedPath

  for (;;) {
    try {
      const st = await stat(current)
      if (st.isDirectory()) {
        return {
          requestedPath,
          workspacePath: current,
          usedNearestExistingParent: current !== requestedPath,
        }
      }
      return {
        requestedPath,
        workspacePath: path.dirname(current),
        usedNearestExistingParent: true,
      }
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
}

export async function resolveWorkspaceForTargetPath(
  inputPath: string,
  currentCwd: string,
  homeDir = homedir(),
): Promise<WorkspacePathResolution | null> {
  const candidate = resolveWorkspaceCandidatePath(inputPath, currentCwd, homeDir)
  return findNearestExistingWorkspaceRoot(candidate)
}

export function mergeTrustedWorkspaceRoots(
  roots: string[],
  nextRoot: string,
  homeDir = homedir(),
): string[] {
  const resolvedNext = path.resolve(nextRoot)
  if (isOverbroadTrustedWorkspaceRoot(resolvedNext, homeDir)) {
    return Array.from(
      new Set(
        roots
          .map((entry) => path.resolve(entry))
          .filter((entry) => !isOverbroadTrustedWorkspaceRoot(entry, homeDir)),
      ),
    )
  }
  const merged: string[] = []

  for (const root of roots) {
    const resolvedRoot = path.resolve(root)
    if (isOverbroadTrustedWorkspaceRoot(resolvedRoot, homeDir)) {
      continue
    }
    if (isPathInsideWorkspace(resolvedRoot, resolvedNext)) {
      return Array.from(
        new Set(
          roots
            .map((entry) => path.resolve(entry))
            .filter((entry) => !isOverbroadTrustedWorkspaceRoot(entry, homeDir)),
        ),
      )
    }
    if (isPathInsideWorkspace(resolvedNext, resolvedRoot)) {
      continue
    }
    merged.push(resolvedRoot)
  }

  merged.push(resolvedNext)
  return Array.from(new Set(merged))
}

export function normalizeTrustedWorkspaceRoots(
  value: unknown,
  homeDir = homedir(),
): string[] {
  if (!Array.isArray(value)) return []
  let roots: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    roots = mergeTrustedWorkspaceRoots(roots, entry.trim(), homeDir)
  }
  return roots
}
