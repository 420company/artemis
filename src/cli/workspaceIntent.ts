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

/**
 * Detect a relative subpath that immediately follows an alias word like
 * "桌面" / "desktop folder" / "documents". Used so a request such as
 *   "进入桌面 BangkokProject/420-company-site 设为工作区"
 * resolves to ~/Desktop/BangkokProject/420-company-site instead of just
 * ~/Desktop (which then makes read_file fail with ENOENT for src/App.tsx
 * because the AI doesn't realize the workspace baseline never moved).
 */
function extractSubpathAfterAlias(
  input: string,
  source: WorkspaceIntentResolution['source'],
): string | null {
  // The Chinese stopword list mirrors extractPrefixedPath so we don't
  // swallow trailing imperatives like "并设为工作区".
  const zhStops = '继续|并|然后|之后|再|接着|创建|建立|新建|制作|做|写|修改|更新|运行|执行|设为|作为|设置为|开始'
  const enStops = 'and|then|create|build|make|write|edit|run|set|use'
  const aliasWord =
    source === 'desktop-alias' ? '(?:桌面(?:上|里|下)?|desktop(?:\\s+folder|\\s+directory)?)' :
    source === 'documents-alias' ? '(?:文档(?:里|下)?|documents(?:\\s+folder|\\s+directory)?)' :
    source === 'downloads-alias' ? '(?:下载(?:里|下)?|downloads(?:\\s+folder|\\s+directory)?)' :
    null
  if (!aliasWord) return null

  const pattern = new RegExp(
    // Anchor at the alias word; capture the next path-like token until a
    // stopword or punctuation. The path may contain letters, digits, dot,
    // dash, underscore, slash, and Unicode letters — but must NOT start
    // with a verb stopword.
    `${aliasWord}\\s+([\\p{L}0-9._\\-][\\p{L}0-9._\\-/]*)`,
    'iu',
  )
  const match = input.match(pattern)
  if (!match?.[1]) return null

  let candidate = match[1].trim().replace(/[，。；;,]+$/g, '').trim()
  if (!candidate) return null

  // Reject when the candidate IS a stopword (e.g. "桌面 设为" should not
  // map to ~/Desktop/设为).
  const stopwordPattern = new RegExp(`^(?:${zhStops}|${enStops})$`, 'i')
  if (stopwordPattern.test(candidate)) return null

  // Strip any trailing stopwords that snuck in.
  candidate = candidate.replace(new RegExp(`(?:${zhStops}|${enStops}).*$`, 'i'), '').trim()
  candidate = candidate.replace(/\/+$/, '')
  if (!candidate) return null

  // Must look like a folder/file path (contain at least one path-like
  // character or be all alphanumerics).
  if (!/^[\p{L}0-9][\p{L}0-9._\-/]*$/u.test(candidate)) return null

  return candidate
}

export async function resolveWorkspaceIntent(
  input: string,
  currentCwd: string,
  homeDir = homedir(),
): Promise<WorkspaceIntentResolution | null> {
  const aliasSource = aliasPathFromText(input, homeDir)
  if (aliasSource) {
    const aliasRoot = pathForAlias(aliasSource, homeDir)
    // If the user typed a subpath right after the alias (e.g.
    // "桌面 BangkokProject/420-company-site"), resolve to that subpath
    // instead of the bare alias root.
    const subpath = extractSubpathAfterAlias(input, aliasSource)
    const requestedPath = subpath ? path.join(aliasRoot, subpath) : aliasRoot
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
