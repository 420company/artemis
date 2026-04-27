/**
 * cli/toolRender.ts — per-tool colored label / icon / duration formatting.
 *
 * Produces compact single-line summaries like:
 *   ◆ Editing  src/x.ts      1.2s
 *   ▲ Bash     npm test      342ms
 *   ✗ Reading  missing.txt   (error)
 *
 * Output carries ANSI codes — callers should set `preserveAnsi: true` on the
 * scroll block so the renderer doesn't strip them.
 */

import type { UiLocale } from './locale.js'
import { stringWidth } from '../input/stringWidth.js'

const ESC = '\x1b'
const RESET = `${ESC}[0m`

// Visible terminal width minus the indent the renderer adds around tool
// blocks. Tool blocks get 2 spaces of outer indent (interactive.ts) plus 2
// spaces of inner indent (preview rows) plus 2 chars for the "+ "/"- "
// marker, leaving (cols - 6) for actual diff content. Without this, long
// HTML/JS lines wrap to column 0 and break the +/- column alignment.
function getDiffContentWidth(): number {
  const cols = process.stdout?.columns
  const usable = (typeof cols === 'number' && cols > 20 ? cols : 100) - 6
  return Math.max(20, usable)
}

function clipDiffLine(line: string, maxWidth: number): string {
  if (stringWidth(line) <= maxWidth) return line
  let out = ''
  let used = 0
  for (const ch of line) {
    const w = stringWidth(ch)
    if (used + w + 1 > maxWidth) break
    out += ch
    used += w
  }
  return out + '…'
}

function color(text: string, code: string): string {
  return process.stdout.isTTY ? `${code}${text}${RESET}` : text
}
function dim(text: string): string { return color(text, `${ESC}[2m`) }
function bold(text: string): string { return color(text, `${ESC}[1m`) }
function red(text: string): string { return color(text, `${ESC}[31m`) }
function green(text: string): string { return color(text, `${ESC}[32m`) }
function amber(text: string): string { return color(text, `${ESC}[38;5;214m`) }
function rgb(text: string, r: number, g: number, b: number, b2 = false): string {
  return color(text, `${ESC}[${b2 ? '1;' : ''}38;2;${r};${g};${b}m`)
}

// ─── per-tool metadata ────────────────────────────────────────────────────────

interface ToolMeta {
  labelZh: string
  labelEn: string
  rgb: [number, number, number]
  icon: string
}

const TOOL_META: Record<string, ToolMeta> = {
  run_command:     { labelZh: '执行', labelEn: 'Bash',      rgb: [255, 170,  80], icon: '▲' },
  read_file:       { labelZh: '读取', labelEn: 'Reading',   rgb: [100, 210, 240], icon: '◇' },
  write_file:      { labelZh: '写入', labelEn: 'Writing',   rgb: [130, 220, 140], icon: '◆' },
  replace_in_file: { labelZh: '编辑', labelEn: 'Editing',   rgb: [130, 220, 140], icon: '◆' },
  insert_in_file:  { labelZh: '编辑', labelEn: 'Editing',   rgb: [130, 220, 140], icon: '◆' },
  apply_patch:     { labelZh: '补丁', labelEn: 'Patching',  rgb: [130, 220, 140], icon: '◆' },
  list_files:      { labelZh: '列表', labelEn: 'Listing',   rgb: [120, 170, 250], icon: '▸' },
  search_files:    { labelZh: '搜索', labelEn: 'Searching', rgb: [235, 205, 100], icon: '◈' },
  lookup_docs:     { labelZh: '查文档', labelEn: 'Docs',    rgb: [200, 140, 250], icon: '§' },
  http_request:    { labelZh: '网络', labelEn: 'Fetch',     rgb: [230, 120, 200], icon: '◉' },
}

const FALLBACK_META: ToolMeta = { labelZh: '工具', labelEn: 'Tool', rgb: [160, 160, 160], icon: '⚙' }

function metaFor(name: string): ToolMeta {
  return TOOL_META[name] ?? FALLBACK_META
}

// ─── target extraction — pick the most informative arg ────────────────────────

export function formatToolTarget(name: string, args: Record<string, unknown>): string {
  const asStr = (v: unknown): string => typeof v === 'string' ? v : ''
  switch (name) {
    case 'run_command':
      return asStr(args.command).slice(0, 80)
    case 'read_file':
    case 'write_file':
    case 'list_files':
      return asStr(args.path).slice(0, 80)
    case 'replace_in_file':
    case 'insert_in_file':
    case 'apply_patch':
      return asStr(args.path).slice(0, 80)
    case 'search_files': {
      const q = asStr(args.query) || asStr(args.pattern)
      const scope = asStr(args.path)
      return scope ? `"${q}" @ ${scope}` : `"${q}"`
    }
    case 'lookup_docs':
      return asStr(args.query).slice(0, 80)
    case 'http_request':
      return asStr(args.url).slice(0, 80)
    default: {
      const entries = Object.entries(args)
        .slice(0, 2)
        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 30)}`)
      return entries.join(' ')
    }
  }
}

// ─── duration formatting ──────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return `${min}m${sec}s`
}

// ─── rendering ────────────────────────────────────────────────────────────────

function labelFor(meta: ToolMeta, locale: UiLocale): string {
  return locale === 'zh-CN' ? meta.labelZh : meta.labelEn
}

/** Render "running" state — tool call just started. */
export function formatToolRunning(options: {
  name: string
  args: Record<string, unknown>
  locale: UiLocale
}): string {
  const { name, args, locale } = options
  const meta = metaFor(name)
  const [r, g, b] = meta.rgb
  const icon = rgb(meta.icon, r, g, b, true)
  const label = rgb(labelFor(meta, locale).padEnd(8, ' '), r, g, b)
  const target = formatToolTarget(name, args)
  return `${icon} ${label} ${target} ${dim('…')}`
}

/** Render completed state — update the block in place. */
export function formatToolDone(options: {
  name: string
  args: Record<string, unknown>
  ok: boolean
  output: string
  durationMs: number
  locale: UiLocale
}): string {
  const { name, args, ok, output, durationMs, locale } = options
  const meta = metaFor(name)
  const [r, g, b] = meta.rgb
  const icon = ok ? rgb(meta.icon, r, g, b, true) : color('✗', `${ESC}[1;31m`)
  const label = ok
    ? rgb(labelFor(meta, locale).padEnd(8, ' '), r, g, b)
    : color(labelFor(meta, locale).padEnd(8, ' '), `${ESC}[31m`)
  const target = formatToolTarget(name, args)
  const timing = dim(formatDuration(durationMs))

  if (ok) {
    return `${icon} ${label} ${target}  ${timing}`
  }

  // Error: show a short error line under the label for quick scanning.
  const errLine = output.split('\n').find(l => l.trim()) ?? ''
  const trimmed = errLine.slice(0, 140)
  return `${icon} ${label} ${target}  ${timing}\n  ${color(trimmed, `${ESC}[31m`)}`
}

/** Heavy-output tools (read/write/patch): second summary line with byte count hint. */
function asStr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clipPreviewLines(lines: string[], limit = 10): string[] {
  if (limit === Infinity || lines.length <= limit) return lines
  return [...lines.slice(0, limit), dim(`  … ${lines.length - limit} more line(s)`)]
}

function renderPatchPreview(patch: string): string | null {
  const rows = patch
    .split('\n')
    .filter(line =>
      line.startsWith('*** Update File:') ||
      line.startsWith('*** Add File:') ||
      line.startsWith('*** Delete File:') ||
      line.startsWith('@@') ||
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---')),
    )

  if (rows.length === 0) return null

  const maxWidth = getDiffContentWidth()
  return clipPreviewLines(rows.map((line) => {
    // Strip the marker for clipping math, then re-attach so the marker stays
    // in its fixed column even when the source line is truncated.
    if (line.startsWith('*** ')) {
      return `  ${bold(clipDiffLine(line, maxWidth + 2))}`
    }
    if (line.startsWith('@@')) {
      return `  ${amber(clipDiffLine(line, maxWidth + 2))}`
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      const marker = line[0]!
      const body = clipDiffLine(line.slice(1), maxWidth)
      const tinted = marker === '+' ? green(`${marker}${body}`) : red(`${marker}${body}`)
      return `  ${tinted}`
    }
    return `  ${dim(clipDiffLine(line, maxWidth + 2))}`
  }), Infinity).join('\n')
}

function renderReplacePreview(find: string, replace: string): string | null {
  const rows: string[] = []
  const maxWidth = getDiffContentWidth()
  
  // 
  if (find.trim() || replace.trim()) {
    // 
    const findLines = find.split('\n').filter(line => line.trim())
    const replaceLines = replace.split('\n').filter(line => line.trim())
    
    // 
    if (findLines.length === 1 && replaceLines.length === 1) {
      rows.push(`  ${red(`- ${clipDiffLine(findLines[0], maxWidth)}`)}`)
      rows.push(`  ${green(`+ ${clipDiffLine(replaceLines[0], maxWidth)}`)}`)
    } else {
      // 
      for (const line of find.split('\n')) {
        if (line.trim()) {
          rows.push(`  ${red(`- ${clipDiffLine(line, maxWidth)}`)}`)
        }
      }
      for (const line of replace.split('\n')) {
        if (line.trim()) {
          rows.push(`  ${green(`+ ${clipDiffLine(line, maxWidth)}`)}`)
        }
      }
    }
  }
  
  return rows.length > 0 ? clipPreviewLines(rows, Infinity).join('\n') : null
}

function renderInsertPreview(content: string): string | null {
  const maxWidth = getDiffContentWidth()
  const rows = content
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => `  ${green(`+ ${clipDiffLine(line, maxWidth)}`)}`)
  return rows.length > 0 ? clipPreviewLines(rows, Infinity).join('\n') : null
}

export function formatToolResultPreview(name: string, args: Record<string, unknown>, output: string): string | null {
  if (!output.trim()) return null

  if (name === 'apply_patch') {
    return renderPatchPreview(asStr(args.patch))
  }

  if (name === 'replace_in_file') {
    const path = asStr(args.path)
    const find = asStr(args.find)
    const replace = asStr(args.replace)
    
    // 
    let preview = `a${path} → b${path}`
    preview += `\n${renderReplacePreview(find, replace) || ''}`
    return preview.trim()
  }

  if (name === 'insert_in_file') {
    return renderInsertPreview(asStr(args.content) || asStr(args.insert))
  }

  if (name === 'write_file') {
    return renderInsertPreview(asStr(args.content))
  }

  const isWrite = ['write_file', 'insert_in_file', 'replace_in_file', 'apply_patch'].includes(name)
  if (isWrite) {
    const line = output.split('\n').find(l => l.trim())
    return line ? `  ${dim(line.slice(0, 140))}` : null
  }
  // Read / list / search: one-line preview, dimmed.
  const first = output.split('\n').filter(l => l.trim()).slice(0, 1).join('')
  return first ? `  ${dim(first.slice(0, 140))}` : null
}

/** Expose bold for callers that want to emphasize headings. */
export const style = { bold, dim, rgb }

// ─── permission dialog — natural-language translation ─────────────────────────

/**
 * Translate a tool-permission request into friendly, non-technical prose for
 * the confirmation dialog. Returns a title line (what the AI wants to do) plus
 * an optional detail line (the actual target — path, command, URL).
 */
export function formatToolPermission(options: {
  name: string
  args: Record<string, unknown>
  category: string
  locale: UiLocale
}): { title: string; detail: string } {
  const { name, args, category, locale } = options
  const zh = locale === 'zh-CN'
  const asStr = (v: unknown): string => typeof v === 'string' ? v : ''
  const clip = (s: string, n = 120): string =>
    s.length <= n ? s : s.slice(0, n - 1) + '…'

  switch (name) {
    case 'run_command': {
      const cmd = asStr(args.command)
      return {
        title: zh ? 'AI 想在你的电脑上运行一条命令' : 'The AI wants to run a command on your computer',
        detail: clip(cmd),
      }
    }
    case 'write_file': {
      const path = asStr(args.path)
      return {
        title: zh ? 'AI 想创建或覆盖一个文件' : 'The AI wants to create or overwrite a file',
        detail: clip(path),
      }
    }
    case 'replace_in_file':
    case 'insert_in_file': {
      const path = asStr(args.path)
      return {
        title: zh ? 'AI 想修改文件内容' : 'The AI wants to modify a file',
        detail: clip(path),
      }
    }
    case 'apply_patch': {
      const path = asStr(args.path)
      return {
        title: zh ? 'AI 想对文件应用一个补丁' : 'The AI wants to apply a patch to a file',
        detail: clip(path),
      }
    }
    case 'delete_file': {
      const path = asStr(args.path)
      return {
        title: zh ? 'AI 想删除一个文件' : 'The AI wants to delete a file',
        detail: clip(path),
      }
    }
    case 'move_file': {
      const from = asStr(args.from) || asStr(args.source) || asStr(args.path)
      const to = asStr(args.to) || asStr(args.destination)
      return {
        title: zh ? 'AI 想移动或重命名一个文件' : 'The AI wants to move or rename a file',
        detail: clip(to ? `${from} → ${to}` : from),
      }
    }
    case 'copy_file': {
      const from = asStr(args.from) || asStr(args.source) || asStr(args.path)
      const to = asStr(args.to) || asStr(args.destination)
      return {
        title: zh ? 'AI 想复制一个文件' : 'The AI wants to copy a file',
        detail: clip(to ? `${from} → ${to}` : from),
      }
    }
    case 'create_directory': {
      const path = asStr(args.path)
      return {
        title: zh ? 'AI 想创建一个新文件夹' : 'The AI wants to create a directory',
        detail: clip(path),
      }
    }
    case 'delete_directory': {
      const path = asStr(args.path)
      return {
        title: zh ? 'AI 想删除一个文件夹' : 'The AI wants to delete a directory',
        detail: clip(path),
      }
    }
    case 'git_commit': {
      const msg = asStr(args.message)
      return {
        title: zh ? 'AI 想提交一次 Git 变更' : 'The AI wants to create a Git commit',
        detail: clip(msg || (zh ? '(无提交信息)' : '(no message)')),
      }
    }
    case 'git_add': {
      const files = Array.isArray(args.files) ? (args.files as unknown[]).join(', ') : asStr(args.files) || asStr(args.path)
      return {
        title: zh ? 'AI 想把改动加入 Git 暂存区' : 'The AI wants to stage files in Git',
        detail: clip(files),
      }
    }
    case 'npm_run': {
      const script = asStr(args.script) || asStr(args.command)
      return {
        title: zh ? 'AI 想运行一个 npm 脚本' : 'The AI wants to run an npm script',
        detail: clip(script),
      }
    }
    case 'format_code': {
      const path = asStr(args.path)
      return {
        title: zh ? 'AI 想运行代码格式化工具' : 'The AI wants to run a code formatter',
        detail: clip(path),
      }
    }
    case 'download_file': {
      const url = asStr(args.url)
      const dest = asStr(args.path) || asStr(args.destination)
      return {
        title: zh ? 'AI 想从网络下载一个文件' : 'The AI wants to download a file',
        detail: clip(dest ? `${url} → ${dest}` : url),
      }
    }
    case 'http_request': {
      const url = asStr(args.url)
      const method = asStr(args.method).toUpperCase() || 'POST'
      return {
        title: zh ? 'AI 想向网络地址发送请求' : 'The AI wants to send a network request',
        detail: clip(`${method} ${url}`),
      }
    }
    default: {
      const verb = category === 'shell'
        ? (zh ? '运行命令' : 'run a command')
        : category === 'write'
        ? (zh ? '修改文件或系统' : 'modify files or system')
        : (zh ? '使用工具' : 'use a tool')
      const target = formatToolTarget(name, args)
      return {
        title: zh ? `AI 想${verb}` : `The AI wants to ${verb}`,
        detail: clip(target || name),
      }
    }
  }
}
