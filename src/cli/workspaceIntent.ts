/* eslint-disable @typescript-eslint/no-unused-vars, prefer-const */
import path from 'node:path'
import { homedir } from 'node:os'
import {
  findNearestExistingWorkspaceRoot,
  isOverbroadTrustedWorkspaceRoot,
  resolveWorkspaceCandidatePath,
} from '../utils/workspaceRoots.js'

export type WorkspaceIntentResolution = {
  requestedPath: string
  workspacePath: string
  usedNearestExistingParent: boolean
  source: 'explicit-path' | 'desktop-alias' | 'documents-alias' | 'downloads-alias'
}

const STRONG_PATH_INTENT_PREFIXES = [
  '进入',
  '进入工作区',
  '切换到',
  '切换工作区到',
  '切到',
  '工作区设为',
  '工作区设置为',
  '工作区切换到',
  '设置工作区为',
  '设为工作区',
  '作为工作区',
  'cd to',
  'switch to',
  'switch workspace to',
  'change to',
  'change workspace to',
] as const

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isLikelyPastedRichText(input: string): boolean {
  const lineCount = input.split(/\r?\n/).length
  if (lineCount >= 3) return true
  if (input.length >= 500) return true
  if (/```|<\/?(?:div|p|span|pre|code|html|body)\b/i.test(input)) return true
  return false
}

function startsWithStrongWorkspaceIntent(input: string): boolean {
  const trimmed = input.trimStart()
  return STRONG_PATH_INTENT_PREFIXES.some((prefix) =>
    new RegExp(`^${escapeRegExp(prefix)}(?:\\s|[:：])`, 'i').test(trimmed),
  )
}

const ABSOLUTE_PATH_START = String.raw`(?:~|/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)`

function normalizeCandidate(raw: string, currentCwd: string, homeDir: string): string | null {
  let candidate = raw
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/[，。；;,]+$/g, '')
    .trim()

  if (!candidate) return null
  if (/^\/\s/.test(candidate)) return null

  // Reject candidates that are too short or don't look like paths
  // (e.g., "/y" from "/yes" should not be treated as a workspace path)
  if (candidate.length < 3 || !/[/\\]/.test(candidate)) return null

  // On native Windows, a leading POSIX-style slash such as `/foo` is not a
  // user workspace path. Node resolves it against the current drive
  // (`C:\foo`), and if that child is missing our nearest-parent fallback can
  // escalate all the way to `C:\`, triggering the trust dialog from an
  // ordinary unknown slash command typed in the chat box. Windows absolute
  // paths should be `C:\foo`, `C:/foo`, `\\server\share`, or relative paths.
  if (process.platform === 'win32' && /^\/(?!\/)/.test(candidate)) return null

  return resolveWorkspaceCandidatePath(candidate, currentCwd, homeDir)
}

function extractQuotedPath(input: string): string | null {
  const quoteChars = `["“'‘\`]`
  const endQuoteChars = `["”'’\`]`
  const pathCapture = `(${ABSOLUTE_PATH_START}[^"”'’\`\\r\\n]*)`
  const strongPrefixPattern = STRONG_PATH_INTENT_PREFIXES
    .map(prefix => escapeRegExp(prefix))
    .join('|')

  const strongQuoted = input.match(
    new RegExp(`^\\s*(?:${strongPrefixPattern})(?:\\s+|[:：]\\s*)${quoteChars}${pathCapture}${endQuoteChars}`, 'i'),
  )
  if (strongQuoted?.[1]?.trim()) return strongQuoted[1].trim()

  const leadingQuoted = input.trimStart().match(new RegExp(`^${quoteChars}${pathCapture}${endQuoteChars}`))
  return leadingQuoted?.[1]?.trim() ?? null
}

function extractPrefixedPath(input: string): string | null {
  const zhStops = '继续|并|然后|之后|再|接着|创建|建立|新建|制作|做|写|修改|更新|运行|执行|设为|作为'
  const enStops = 'and|then|create|build|make|write|edit|run'
  const prefixes = STRONG_PATH_INTENT_PREFIXES
  for (const prefix of prefixes) {
    const pattern = new RegExp(
      `${escapeRegExp(prefix)}(?:\\s+|[:：]\\s*)(${ABSOLUTE_PATH_START}[\\s\\S]*?)(?=$|[\\r\\n，。；;,]|\\s+(?:${zhStops})|\\s+(?:${enStops})\\b)`,
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

function extractPathWithWorkspaceMarker(input: string): string | null {
  const marker = String.raw`(?:设为工作区|作为工作区|设置为工作区|use\s+as\s+(?:the\s+)?workspace|set\s+as\s+(?:the\s+)?workspace)`
  const quotedPath = String.raw`["“'‘\`](${ABSOLUTE_PATH_START}[^"”'’\`\r\n]*)["”'’\`]`
  const barePath = String.raw`(${ABSOLUTE_PATH_START}[^\s，。；;,\r\n]*)`

  const quotedBefore = input.match(new RegExp(`${quotedPath}[\\s\\S]{0,80}?${marker}`, 'i'))
  if (quotedBefore?.[1]?.trim()) return quotedBefore[1].trim()

  const bareBefore = input.match(new RegExp(`${barePath}[\\s\\S]{0,80}?${marker}`, 'i'))
  if (bareBefore?.[1]?.trim()) return bareBefore[1].trim()

  return null
}

function extractLeadingPath(input: string): string | null {
  const zhStops = '继续|并|然后|之后|再|接着|创建|建立|新建|制作|做|写|修改|更新|运行|执行|设为|作为'
  const enStops = 'and|then|continue|create|build|make|write|edit|run'
  const match = input.trimStart().match(
    new RegExp(
      `^(${ABSOLUTE_PATH_START}[\\s\\S]*?)(?=$|[\\r\\n，。；;,]|\\s+(?:${zhStops})|\\s+(?:${enStops})\\b)`,
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
 * "desktop" / "desktop folder" / "documents". This keeps the workspace
 * baseline aligned with the user's intended project directory instead of
 * resolving only to the alias root.
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
  const likelyPastedRichText = isLikelyPastedRichText(input)
  const strongOnly = likelyPastedRichText && !startsWithStrongWorkspaceIntent(input)

  // Long pasted logs / docs / rich text often contain incidental absolute
  // paths such as /etc/nginx or /private/etc/hosts. Those are content, not a
  // request to move Artemis' workspace. In that mode we only honor explicit
  // leading workspace verbs ("进入 ...", "switch to ...") and ignore generic
  // prose like "in /etc" or quoted path examples.
  if (strongOnly) return null

  const aliasSource = aliasPathFromText(input, homeDir)
  if (aliasSource) {
    const aliasRoot = pathForAlias(aliasSource, homeDir)
    // If the user typed a subpath right after the alias, resolve to that
    // subpath instead of the bare alias root.
    const subpath = extractSubpathAfterAlias(input, aliasSource)
    const requestedPath = subpath ? path.join(aliasRoot, subpath) : aliasRoot
    const existing = await findNearestExistingWorkspaceRoot(requestedPath)
    if (!existing) return null
    if (
      existing.usedNearestExistingParent &&
      isOverbroadTrustedWorkspaceRoot(existing.workspacePath, homeDir)
    ) {
      return null
    }
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
    extractPathWithWorkspaceMarker(input) ??
    extractLeadingPath(input)
  if (!rawPath) return null

  const requestedPath = normalizeCandidate(rawPath, currentCwd, homeDir)
  if (!requestedPath) return null
  const existing = await findNearestExistingWorkspaceRoot(requestedPath)
  if (!existing) return null
  if (
    existing.usedNearestExistingParent &&
    isOverbroadTrustedWorkspaceRoot(existing.workspacePath, homeDir)
  ) {
    return null
  }

  return {
    requestedPath,
    workspacePath: existing.workspacePath,
    usedNearestExistingParent: existing.usedNearestExistingParent,
    source: 'explicit-path',
  }
}
