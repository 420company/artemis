/* eslint-disable @typescript-eslint/no-unused-vars, prefer-const */
import path from 'node:path'
import { homedir } from 'node:os'
import { resolveWorkspaceCandidatePath, findNearestExistingWorkspaceRoot } from '../utils/workspaceRoots.js'

export type WorkspaceIntentResolution = {
  requestedPath: string
  workspacePath: string
  usedNearestExistingParent: boolean
  source: 'explicit-path' | 'desktop-alias' | 'documents-alias' | 'downloads-alias'
}

const PATH_INTENT_PREFIXES = [
  '进入',
  '切换到',
  '切到',
  '工作区设为',
  '工作区设置为',
  '工作区切换到',
  '设为工作区',
  '作为工作区',
  '在',
  '到',
  '保存到',
  '写到',
  '放到',
  'cd to',
  'switch to',
  'change to',
  'use',
  'inside',
  'under',
  'in',
  'at',
  'to',
] as const

function normalizeCandidate(raw: string, currentCwd: string, homeDir: string): string | null {
  let candidate = raw
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/[，。；;,]+$/g, '')
    .trim()

  if (!candidate) return null
  if (/^\/\s/.test(candidate)) return null

  return resolveWorkspaceCandidatePath(candidate, currentCwd, homeDir)
}

function extractQuotedPath(input: string): string | null {
  const quoted = input.match(/["“'‘`]((?:~|\/)[^"”'’`\r\n]+)["”'’`]/)
  return quoted?.[1]?.trim() ?? null
}

function extractPrefixedPath(input: string): string | null {
  const zhStops = '继续|并|然后|之后|再|接着|创建|建立|新建|制作|做|写|修改|更新|运行|执行|设为|作为'
  const enStops = 'and|then|create|build|make|write|edit|run'
  for (const prefix of PATH_INTENT_PREFIXES) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `${escaped}\\s+((?:~|/)[\\s\\S]+?)(?=$|[\\r\\n，。；;,]|\\s+(?:${zhStops})|\\s+(?:${enStops})\\b)`,
      'i',
    )
    const match = input.match(pattern)
    if (match?.[1]?.trim()) {
      const candidate = match[1].trim()
      if (/^\/\s/.test(candidate)) return null
      return candidate
    }
  }
  return null
}

function extractLeadingPath(input: string): string | null {
  const zhStops = '继续|并|然后|之后|再|接着|创建|建立|新建|制作|做|写|修改|更新|运行|执行|设为|作为'
  const enStops = 'and|then|continue|create|build|make|write|edit|run'
  const match = input.trimStart().match(
    new RegExp(
      `^((?:~|/)[\\s\\S]+?)(?=$|[\\r\\n，。；;,]|\\s+(?:${zhStops})|\\s+(?:${enStops})\\b)`,
      'i',
    ),
  )
  return match?.[1]?.trim() ?? null
}

function aliasPathFromText(input: string, homeDir: string): WorkspaceIntentResolution['source'] | null {
  if (/(?:在|到|进入|切换到|保存到|写到|放到)?\s*桌面(?:上|里|下)?/u.test(input)) {
    return 'desktop-alias'
  }
  if (/\b(?:on|in|inside|under|to)\s+(?:the\s+)?desktop\b/i.test(input) || /\bdesktop\s+(?:folder|directory)\b/i.test(input)) {
    return 'desktop-alias'
  }
  if (/(?:在|到|进入|切换到|保存到|写到|放到)?\s*(?:文档|Documents)(?:里|下)?/iu.test(input)) {
    return 'documents-alias'
  }
  if (/(?:在|到|进入|切换到|保存到|写到|放到)?\s*(?:下载|Downloads)(?:里|下)?/iu.test(input)) {
    return 'downloads-alias'
  }
  return null
}

function pathForAlias(source: WorkspaceIntentResolution['source'], homeDir: string): string {
  if (source === 'desktop-alias') return path.join(homeDir, 'Desktop')
  if (source === 'documents-alias') return path.join(homeDir, 'Documents')
  if (source === 'downloads-alias') return path.join(homeDir, 'Downloads')
  return homeDir
}

export async function resolveWorkspaceIntent(
  input: string,
  currentCwd: string,
  homeDir = homedir(),
): Promise<WorkspaceIntentResolution | null> {
  const aliasSource = aliasPathFromText(input, homeDir)
  if (aliasSource) {
    const requestedPath = pathForAlias(aliasSource, homeDir)
    const existing = await findNearestExistingWorkspaceRoot(requestedPath)
    if (!existing) return null
    return {
      requestedPath,
      workspacePath: existing.workspacePath,
      usedNearestExistingParent: existing.usedNearestExistingParent,
      source: aliasSource,
    }
  }

  const rawPath =
    extractQuotedPath(input) ??
    extractPrefixedPath(input) ??
    extractLeadingPath(input)
  if (!rawPath) return null

  const requestedPath = normalizeCandidate(rawPath, currentCwd, homeDir)
  if (!requestedPath) return null
  const existing = await findNearestExistingWorkspaceRoot(requestedPath)
  if (!existing) return null

  return {
    requestedPath,
    workspacePath: existing.workspacePath,
    usedNearestExistingParent: existing.usedNearestExistingParent,
    source: 'explicit-path',
  }
}
