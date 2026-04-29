/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * tools/extras.ts — 39 additional inline tools (no TOOL_REGISTRY required)
 *
 * These tools are handled directly in brain.ts executeTool() and defined in
 * buildDirectTools(). They cover file ops, git, text processing, encoding,
 * system info, network, and dev utilities — taking us to 51 direct tools total.
 */

import { copyFile, mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve as pathResolve, join, basename, extname, dirname } from 'node:path'
import { lookup as dnsLookup } from 'node:dns/promises'
import { ensureNotSensitivePath, resolveInsideRoot } from '../utils/fs.js'
import { resolveWorkspaceCandidatePath } from '../utils/workspaceRoots.js'
import { 
  execNotebookCreate, execNotebookList, execNotebookUpdate, execNotebookDelete, 
  execNotebookView, execNotebookSearch, execNotebookAddTag, execNotebookRemoveTag, 
  execNotebookTree 
} from './NotebookWorktreeTool/NotebookWorktreeTool.js'

const execAsync = promisify(exec)

type TR = { ok: boolean; output: string }

// ── Helper ────────────────────────────────────────────────────────────────────

/** Resolve a user-supplied path inside `cwd` AND guard against sensitive dirs.
 *  Returns a TR error instead of throwing to match the other exec* helpers. */
function guardPath(cwd: string, inputPath: string): { ok: true; absolute: string } | { ok: false; output: string } {
  try {
    const candidate = resolveWorkspaceCandidatePath(inputPath, cwd)
    const absolute = resolveInsideRoot(cwd, candidate)
    ensureNotSensitivePath(absolute, inputPath)
    return { ok: true, absolute }
  } catch (e) {
    return { ok: false, output: String(e instanceof Error ? e.message : e) }
  }
}

async function gitRun(args: string, cwd: string): Promise<TR> {
  try {
    const { stdout, stderr } = await execAsync(`git ${args}`, { cwd, timeout: 15_000 })
    const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim()
    return { ok: true, output: out || '(no output)' }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, output: msg }
  }
}

// ── File System ───────────────────────────────────────────────────────────────

export async function execDeleteFile(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const g = guardPath(cwd, String(inp.path ?? ''))
  if (!g.ok) return g
  try { await unlink(g.absolute); return { ok: true, output: `Deleted: ${g.absolute}` } }
  catch (e) { return { ok: false, output: String(e) } }
}

export async function execMoveFile(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const gs = guardPath(cwd, String(inp.from ?? ''))
  if (!gs.ok) return gs
  const gd = guardPath(cwd, String(inp.to ?? ''))
  if (!gd.ok) return gd
  try { await rename(gs.absolute, gd.absolute); return { ok: true, output: `Moved: ${gs.absolute} → ${gd.absolute}` } }
  catch (e) { return { ok: false, output: String(e) } }
}

export async function execCopyFile(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const gs = guardPath(cwd, String(inp.from ?? ''))
  if (!gs.ok) return gs
  const gd = guardPath(cwd, String(inp.to ?? ''))
  if (!gd.ok) return gd
  try { await copyFile(gs.absolute, gd.absolute); return { ok: true, output: `Copied: ${gs.absolute} → ${gd.absolute}` } }
  catch (e) { return { ok: false, output: String(e) } }
}

export async function execCreateDirectory(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const g = guardPath(cwd, String(inp.path ?? ''))
  if (!g.ok) return g
  try { await mkdir(g.absolute, { recursive: true }); return { ok: true, output: `Created directory: ${g.absolute}` } }
  catch (e) { return { ok: false, output: String(e) } }
}

export async function execDeleteDirectory(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const g = guardPath(cwd, String(inp.path ?? ''))
  if (!g.ok) return g
  const force = inp.force === true
  try {
    await rm(g.absolute, { recursive: true, force })
    return { ok: true, output: `Deleted directory: ${g.absolute}` }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execFileInfo(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const g = guardPath(cwd, String(inp.path ?? ''))
  if (!g.ok) return g
  try {
    const s = await stat(g.absolute)
    const info = {
      path: g.absolute, size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(),
      created: s.birthtime.toISOString(), modified: s.mtime.toISOString(),
      permissions: s.mode.toString(8).slice(-3),
    }
    return { ok: true, output: JSON.stringify(info, null, 2) }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execListDirectory(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const g = guardPath(cwd, String(inp.path ?? '.'))
  if (!g.ok) return g
  try {
    const entries = await readdir(g.absolute, { withFileTypes: true })
    const lines = entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
    return { ok: true, output: lines.join('\n') || '(empty)' }
  } catch (e) { return { ok: false, output: String(e) } }
}

// ── Git ───────────────────────────────────────────────────────────────────────

export async function execGitStatus(_inp: Record<string, unknown>, cwd: string): Promise<TR> {
  return gitRun('status --short --branch', cwd)
}

export async function execGitDiff(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const staged = inp.staged === true ? '--staged' : ''
  const path   = inp.path   ? String(inp.path) : ''
  return gitRun(`diff ${staged} ${path}`.trim(), cwd)
}

export async function execGitLog(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const limit = Number(inp.limit ?? 10)
  return gitRun(`log --oneline -${limit}`, cwd)
}

export async function execGitAdd(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const paths = Array.isArray(inp.paths) ? inp.paths.map(String).join(' ') : String(inp.paths ?? '.')
  return gitRun(`add ${paths}`, cwd)
}

export async function execGitCommit(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const msg = String(inp.message ?? 'chore: update')
    .replace(/"/g, '\\"')
  return gitRun(`commit -m "${msg}"`, cwd)
}

export async function execGitBranch(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  if (inp.create) return gitRun(`checkout -b ${inp.create}`, cwd)
  if (inp.checkout) return gitRun(`checkout ${inp.checkout}`, cwd)
  return gitRun('branch -a', cwd)
}

// ── Text Processing ───────────────────────────────────────────────────────────

export async function execRegexMatch(inp: Record<string, unknown>): Promise<TR> {
  const text    = String(inp.text ?? '')
  const pattern = String(inp.pattern ?? '')
  const flags   = String(inp.flags ?? 'gm')
  try {
    const rx = new RegExp(pattern, flags)
    const matches: string[] = []
    let m: RegExpExecArray | null
    while ((m = rx.exec(text)) !== null) {
      matches.push(m[0])
      if (!flags.includes('g')) break
    }
    return { ok: true, output: matches.length > 0 ? matches.join('\n') : '(no matches)' }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execJsonQuery(inp: Record<string, unknown>): Promise<TR> {
  const text = String(inp.json ?? inp.text ?? '')
  const path = String(inp.query ?? inp.path ?? '')
  try {
    let obj = JSON.parse(text)
    if (path && path !== '.') {
      for (const key of path.replace(/^\./,'').split('.')) {
        if (obj == null) break
        obj = key.match(/^\d+$/) ? obj[parseInt(key)] : obj[key]
      }
    }
    return { ok: true, output: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execFormatJson(inp: Record<string, unknown>): Promise<TR> {
  const text = String(inp.text ?? inp.json ?? '')
  const indent = Number(inp.indent ?? 2)
  try {
    return { ok: true, output: JSON.stringify(JSON.parse(text), null, indent) }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execDiffText(inp: Record<string, unknown>): Promise<TR> {
  const a = String(inp.original ?? inp.a ?? '').split('\n')
  const b = String(inp.modified ?? inp.b ?? '').split('\n')
  const lines: string[] = []
  const maxLen = Math.max(a.length, b.length)
  let diffs = 0
  for (let i = 0; i < maxLen; i++) {
    if (a[i] === b[i]) continue
    diffs++
    if (a[i] !== undefined) lines.push(`- ${a[i]}`)
    if (b[i] !== undefined) lines.push(`+ ${b[i]}`)
  }
  return { ok: true, output: diffs === 0 ? '(identical)' : lines.join('\n') }
}

export async function execSortLines(inp: Record<string, unknown>): Promise<TR> {
  const lines = String(inp.text ?? '').split('\n')
  const desc  = inp.direction === 'desc'
  const sorted = lines.sort((a, b) => desc ? b.localeCompare(a) : a.localeCompare(b))
  return { ok: true, output: sorted.join('\n') }
}

export async function execDedupeLines(inp: Record<string, unknown>): Promise<TR> {
  const lines  = String(inp.text ?? '').split('\n')
  const unique = [...new Set(lines)]
  return { ok: true, output: `Removed ${lines.length - unique.length} duplicates.\n${unique.join('\n')}` }
}

export async function execCountLines(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const { readFile } = await import('node:fs/promises')
  const g = guardPath(cwd, String(inp.path ?? ''))
  if (!g.ok) return g
  try {
    const content = await readFile(g.absolute, 'utf8')
    const lines = content.split('\n')
    return { ok: true, output: `${lines.length} lines  ${content.length} bytes  ${g.absolute}` }
  } catch (e) { return { ok: false, output: String(e) } }
}

// ── Encoding / Crypto ─────────────────────────────────────────────────────────

export async function execBase64Encode(inp: Record<string, unknown>): Promise<TR> {
  return { ok: true, output: Buffer.from(String(inp.text ?? '')).toString('base64') }
}

export async function execBase64Decode(inp: Record<string, unknown>): Promise<TR> {
  try {
    return { ok: true, output: Buffer.from(String(inp.text ?? ''), 'base64').toString('utf8') }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execHashText(inp: Record<string, unknown>): Promise<TR> {
  const text = String(inp.text ?? '')
  const algo = String(inp.algorithm ?? 'sha256').toLowerCase()
  try {
    const hash = createHash(algo).update(text).digest('hex')
    return { ok: true, output: `${algo}: ${hash}` }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execGenerateUuid(): Promise<TR> {
  return { ok: true, output: randomUUID() }
}

// ── System ────────────────────────────────────────────────────────────────────

export async function execGetEnv(inp: Record<string, unknown>): Promise<TR> {
  const keys = inp.keys
  if (Array.isArray(keys)) {
    const result: Record<string, string | undefined> = {}
    keys.forEach(k => { result[String(k)] = process.env[String(k)] })
    return { ok: true, output: JSON.stringify(result, null, 2) }
  }
  if (typeof inp.key === 'string') {
    const val = process.env[inp.key]
    return { ok: true, output: val ?? `(${inp.key} not set)` }
  }
  // Return all non-sensitive env vars
  const safe = Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => !/(token|secret|password|key|credential)/i.test(k))
      .slice(0, 50)
  )
  return { ok: true, output: JSON.stringify(safe, null, 2) }
}

export async function execWhichCommand(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const cmd = String(inp.command ?? '')
  try {
    const { stdout } = await execAsync(`which ${cmd}`, { cwd })
    return { ok: true, output: stdout.trim() }
  } catch { return { ok: false, output: `${cmd}: not found` } }
}

export async function execGetSystemInfo(): Promise<TR> {
  const { platform, arch, version } = process
  const { totalmem, freemem, cpus } = await import('node:os')
  const info = {
    platform, arch, nodeVersion: version,
    cpuCores: cpus().length,
    totalMemMB: Math.round(totalmem() / 1024 / 1024),
    freeMemMB:  Math.round(freemem()  / 1024 / 1024),
    cwd: process.cwd(),
    pid: process.pid,
  }
  return { ok: true, output: JSON.stringify(info, null, 2) }
}

export async function execDateNow(inp: Record<string, unknown>): Promise<TR> {
  const d = new Date()
  const fmt = String(inp.format ?? 'iso')
  if (fmt === 'iso')       return { ok: true, output: d.toISOString() }
  if (fmt === 'local')     return { ok: true, output: d.toLocaleString() }
  if (fmt === 'unix')      return { ok: true, output: String(Math.floor(d.getTime() / 1000)) }
  if (fmt === 'date')      return { ok: true, output: d.toLocaleDateString() }
  if (fmt === 'time')      return { ok: true, output: d.toLocaleTimeString() }
  return { ok: true, output: d.toString() }
}

export async function execCalculate(inp: Record<string, unknown>): Promise<TR> {
  const expr = String(inp.expression ?? '')
  // Whitelist: only allow safe math characters
  if (!/^[\d\s+\-*/%().,^]+$/.test(expr.replace(/Math\.\w+|PI|E/g, ''))) {
    return { ok: false, output: 'Expression contains disallowed characters. Only math operators and Math.* functions allowed.' }
  }
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${expr.replace(/\^/g, '**')})`)()
    return { ok: true, output: String(result) }
  } catch (e) { return { ok: false, output: `Eval error: ${String(e)}` } }
}

// ── Network ───────────────────────────────────────────────────────────────────

export async function execCheckUrl(inp: Record<string, unknown>): Promise<TR> {
  const url = String(inp.url ?? '')
  try {
    const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
    return { ok: resp.ok, output: `HTTP ${resp.status} ${resp.statusText}  (${url})` }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execDownloadFile(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const url = String(inp.url ?? '')
  const g = guardPath(cwd, String(inp.destination ?? basename(url.split('?')[0] ?? 'download')))
  if (!g.ok) return g
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!resp.ok) return { ok: false, output: `HTTP ${resp.status}: ${url}` }
    const buf = await resp.arrayBuffer()
    await writeFile(g.absolute, Buffer.from(buf))
    return { ok: true, output: `Downloaded ${buf.byteLength} bytes to ${g.absolute}` }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execDnsLookup(inp: Record<string, unknown>): Promise<TR> {
  const host = String(inp.hostname ?? '')
  try {
    const addresses = await dnsLookup(host)
    return { ok: true, output: JSON.stringify(addresses) }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execParseUrl(inp: Record<string, unknown>): Promise<TR> {
  const url = String(inp.url ?? '')
  try {
    const u = new URL(url)
    const result = {
      protocol: u.protocol, host: u.host, hostname: u.hostname,
      port: u.port, pathname: u.pathname, search: u.search,
      hash: u.hash,
      params: Object.fromEntries(u.searchParams.entries()),
    }
    return { ok: true, output: JSON.stringify(result, null, 2) }
  } catch (e) { return { ok: false, output: String(e) } }
}

// ── Development ───────────────────────────────────────────────────────────────

export async function execNpmRun(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const script = String(inp.script ?? 'test')
  try {
    const { stdout, stderr } = await execAsync(`npm run ${script}`, { cwd, timeout: 120_000 })
    return { ok: true, output: (stdout + stderr).slice(0, 10_000) }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, output: msg.slice(0, 5_000) }
  }
}

export async function execFormatCode(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const target = String(inp.path ?? '.')
  const ext    = extname(target)
  let cmd = ''
  if (['.ts','.tsx','.js','.jsx','.json','.css','.md'].includes(ext) || target === '.') {
    cmd = `npx prettier --write "${target}"`
  } else if (['.go'].includes(ext)) {
    cmd = `gofmt -w "${target}"`
  } else if (['.py'].includes(ext)) {
    cmd = `python3 -m black "${target}"`
  } else if (['.rs'].includes(ext)) {
    cmd = `rustfmt "${target}"`
  } else {
    return { ok: false, output: `No known formatter for ${ext}` }
  }
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 30_000 })
    return { ok: true, output: (stdout + stderr).trim() || `Formatted: ${target}` }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execGetImports(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const { readFile } = await import('node:fs/promises')
  const g = guardPath(cwd, String(inp.path ?? ''))
  if (!g.ok) return g
  try {
    const content = await readFile(g.absolute, 'utf8')
    const matches = content.match(/^(?:import|require|from)\s+.+$/gm) ?? []
    return { ok: true, output: matches.join('\n') || '(no imports found)' }
  } catch (e) { return { ok: false, output: String(e) } }
}

export async function execPathInfo(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const p = String(inp.path ?? cwd)
  const g = guardPath(cwd, p)
  if (!g.ok) return g
  return {
    ok: true,
    output: JSON.stringify({
      input: p, absolute: g.absolute,
      basename: basename(g.absolute), dirname: dirname(g.absolute),
      extension: extname(g.absolute),
    }, null, 2),
  }
}

export async function execUrlEncode(inp: Record<string, unknown>): Promise<TR> {
  const text = String(inp.text ?? '')
  const mode = String(inp.mode ?? 'encode')
  return { ok: true, output: mode === 'decode' ? decodeURIComponent(text) : encodeURIComponent(text) }
}

export async function execHashFile(inp: Record<string, unknown>, cwd: string): Promise<TR> {
  const { readFile } = await import('node:fs/promises')
  const g = guardPath(cwd, String(inp.path ?? ''))
  if (!g.ok) return g
  const algo = String(inp.algorithm ?? 'sha256')
  try {
    const content = await readFile(g.absolute)
    const hash = createHash(algo).update(content).digest('hex')
    return { ok: true, output: `${algo}: ${hash}  ${g.absolute}` }
  } catch (e) { return { ok: false, output: String(e) } }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export const EXTRA_TOOL_NAMES = new Set([
  'delete_file','move_file','copy_file','create_directory','delete_directory','file_info','list_directory',
  'git_status','git_diff','git_log','git_add','git_commit','git_branch',
  'regex_match','json_query','format_json','diff_text','sort_lines','dedupe_lines','count_lines',
  'base64_encode','base64_decode','hash_text','generate_uuid',
  'get_env','which_command','get_system_info','date_now','calculate',
  'check_url','download_file','dns_lookup','parse_url',
  'npm_run','format_code','get_imports','path_info','url_encode','hash_file',
  'notebook_create','notebook_list','notebook_update','notebook_delete','notebook_view','notebook_search',
  'notebook_addTag','notebook_removeTag','notebook_tree'
])

export async function executeExtraTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  switch (name) {
    // File ops
    case 'delete_file':       return execDeleteFile(input, cwd)
    case 'move_file':         return execMoveFile(input, cwd)
    case 'copy_file':         return execCopyFile(input, cwd)
    case 'create_directory':  return execCreateDirectory(input, cwd)
    case 'delete_directory':  return execDeleteDirectory(input, cwd)
    case 'file_info':         return execFileInfo(input, cwd)
    case 'list_directory':    return execListDirectory(input, cwd)
    // Git
    case 'git_status':  return execGitStatus(input, cwd)
    case 'git_diff':    return execGitDiff(input, cwd)
    case 'git_log':     return execGitLog(input, cwd)
    case 'git_add':     return execGitAdd(input, cwd)
    case 'git_commit':  return execGitCommit(input, cwd)
    case 'git_branch':  return execGitBranch(input, cwd)
    // Text
    case 'regex_match':  return execRegexMatch(input)
    case 'json_query':   return execJsonQuery(input)
    case 'format_json':  return execFormatJson(input)
    case 'diff_text':    return execDiffText(input)
    case 'sort_lines':   return execSortLines(input)
    case 'dedupe_lines': return execDedupeLines(input)
    case 'count_lines':  return execCountLines(input, cwd)
    // Encoding/crypto
    case 'base64_encode': return execBase64Encode(input)
    case 'base64_decode': return execBase64Decode(input)
    case 'hash_text':     return execHashText(input)
    case 'generate_uuid': return execGenerateUuid()
    // System
    case 'get_env':        return execGetEnv(input)
    case 'which_command':  return execWhichCommand(input, cwd)
    case 'get_system_info':return execGetSystemInfo()
    case 'date_now':       return execDateNow(input)
    case 'calculate':      return execCalculate(input)
    // Network
    case 'check_url':     return execCheckUrl(input)
    case 'download_file': return execDownloadFile(input, cwd)
    case 'dns_lookup':    return execDnsLookup(input)
    case 'parse_url':     return execParseUrl(input)
    // Dev
    case 'npm_run':     return execNpmRun(input, cwd)
    case 'format_code': return execFormatCode(input, cwd)
    case 'get_imports': return execGetImports(input, cwd)
    case 'path_info':   return execPathInfo(input, cwd)
    case 'url_encode':  return execUrlEncode(input)
    case 'hash_file':   return execHashFile(input, cwd)
    // Notebook
    case 'notebook_create':    return execNotebookCreate(input, cwd)
    case 'notebook_list':      return execNotebookList(input, cwd)
    case 'notebook_update':    return execNotebookUpdate(input, cwd)
    case 'notebook_delete':    return execNotebookDelete(input, cwd)
    case 'notebook_view':      return execNotebookView(input, cwd)
    case 'notebook_search':    return execNotebookSearch(input, cwd)
    case 'notebook_addTag':    return execNotebookAddTag(input, cwd)
    case 'notebook_removeTag': return execNotebookRemoveTag(input, cwd)
    case 'notebook_tree':      return execNotebookTree(input, cwd)
    default: return { ok: false, output: `Unknown extra tool: ${name}` }
  }
}

/** Anthropic tool definitions for all extra tools */
export function buildExtraToolDefs(): Anthropic.Tool[] {
  return [
    // ── File operations ──────────────────────────────────────────────────────
    { name: 'delete_file', description: 'Permanently delete a file.',
      input_schema: { type: 'object' as const, properties: { path: { type: 'string', description: 'File path to delete' } }, required: ['path'] } },
    { name: 'move_file', description: 'Move or rename a file.',
      input_schema: { type: 'object' as const, properties: {
        from: { type: 'string', description: 'Source path' }, to: { type: 'string', description: 'Destination path' }
      }, required: ['from','to'] } },
    { name: 'copy_file', description: 'Copy a file to a new location.',
      input_schema: { type: 'object' as const, properties: {
        from: { type: 'string', description: 'Source path' }, to: { type: 'string', description: 'Destination path' }
      }, required: ['from','to'] } },
    { name: 'create_directory', description: 'Create a directory (and parents if needed).',
      input_schema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Directory path to create' } }, required: ['path'] } },
    { name: 'delete_directory', description: 'Delete a directory and all its contents.',
      input_schema: { type: 'object' as const, properties: {
        path: { type: 'string', description: 'Directory path to delete' },
        force: { type: 'boolean', description: 'Force deletion even if non-empty' }
      }, required: ['path'] } },
    { name: 'file_info', description: 'Get file metadata: size, timestamps, type, permissions.',
      input_schema: { type: 'object' as const, properties: { path: { type: 'string', description: 'File or directory path' } }, required: ['path'] } },
    { name: 'list_directory', description: 'List contents of a directory with file/directory type markers.',
      input_schema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Directory path (default: current)' } } } },

    // ── Git ──────────────────────────────────────────────────────────────────
    { name: 'git_status', description: 'Show git working tree status (staged, unstaged, untracked files).',
      input_schema: { type: 'object' as const, properties: {} } },
    { name: 'git_diff', description: 'Show git diff for working tree or staged changes.',
      input_schema: { type: 'object' as const, properties: {
        staged: { type: 'boolean', description: 'Show staged diff instead of working tree' },
        path: { type: 'string', description: 'Limit diff to specific file/path' }
      } } },
    { name: 'git_log', description: 'Show recent git commit log (one-line format).',
      input_schema: { type: 'object' as const, properties: { limit: { type: 'number', description: 'Number of commits to show (default: 10)' } } } },
    { name: 'git_add', description: 'Stage files for commit.',
      input_schema: { type: 'object' as const, properties: {
        paths: { description: 'File path(s) to stage (string or array, default: ".")' }
      } } },
    { name: 'git_commit', description: 'Create a git commit with a message.',
      input_schema: { type: 'object' as const, properties: { message: { type: 'string', description: 'Commit message' } }, required: ['message'] } },
    { name: 'git_branch', description: 'List branches, create a new branch, or checkout a branch.',
      input_schema: { type: 'object' as const, properties: {
        create: { type: 'string', description: 'Create and checkout this new branch' },
        checkout: { type: 'string', description: 'Checkout this existing branch' }
      } } },

    // ── Text processing ──────────────────────────────────────────────────────
    { name: 'regex_match', description: 'Find all matches of a regex pattern in text.',
      input_schema: { type: 'object' as const, properties: {
        text: { type: 'string', description: 'Input text to search' },
        pattern: { type: 'string', description: 'Regular expression pattern' },
        flags: { type: 'string', description: 'Regex flags (default: "gm")' }
      }, required: ['text','pattern'] } },
    { name: 'json_query', description: 'Extract a value from JSON using a dot-path query (e.g. ".user.name").',
      input_schema: { type: 'object' as const, properties: {
        json: { type: 'string', description: 'JSON string to query' },
        query: { type: 'string', description: 'Dot-path query (e.g. ".data.items.0")' }
      }, required: ['json','query'] } },
    { name: 'format_json', description: 'Pretty-print a JSON string with proper indentation.',
      input_schema: { type: 'object' as const, properties: {
        text: { type: 'string', description: 'JSON string to format' },
        indent: { type: 'number', description: 'Indentation spaces (default: 2)' }
      }, required: ['text'] } },
    { name: 'diff_text', description: 'Compute a line-by-line diff between two strings.',
      input_schema: { type: 'object' as const, properties: {
        original: { type: 'string', description: 'Original text' },
        modified: { type: 'string', description: 'Modified text' }
      }, required: ['original','modified'] } },
    { name: 'sort_lines', description: 'Sort lines of text alphabetically.',
      input_schema: { type: 'object' as const, properties: {
        text: { type: 'string', description: 'Multi-line text to sort' },
        direction: { type: 'string', description: '"asc" (default) or "desc"' }
      }, required: ['text'] } },
    { name: 'dedupe_lines', description: 'Remove duplicate lines from text.',
      input_schema: { type: 'object' as const, properties: { text: { type: 'string', description: 'Multi-line text' } }, required: ['text'] } },
    { name: 'count_lines', description: 'Count lines and bytes in a file.',
      input_schema: { type: 'object' as const, properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } },

    // ── Encoding / Crypto ────────────────────────────────────────────────────
    { name: 'base64_encode', description: 'Encode text to Base64.',
      input_schema: { type: 'object' as const, properties: { text: { type: 'string', description: 'Text to encode' } }, required: ['text'] } },
    { name: 'base64_decode', description: 'Decode Base64-encoded text.',
      input_schema: { type: 'object' as const, properties: { text: { type: 'string', description: 'Base64 string to decode' } }, required: ['text'] } },
    { name: 'hash_text', description: 'Hash text using md5, sha1, sha256, or sha512.',
      input_schema: { type: 'object' as const, properties: {
        text: { type: 'string', description: 'Text to hash' },
        algorithm: { type: 'string', description: 'Hash algorithm: md5 | sha1 | sha256 (default) | sha512' }
      }, required: ['text'] } },
    { name: 'generate_uuid', description: 'Generate a random UUID v4.',
      input_schema: { type: 'object' as const, properties: {} } },

    // ── System ───────────────────────────────────────────────────────────────
    { name: 'get_env', description: 'Read environment variable(s). Filters out secrets automatically.',
      input_schema: { type: 'object' as const, properties: {
        key: { type: 'string', description: 'Single env var name to read' },
        keys: { type: 'array', items: { type: 'string' }, description: 'List of env var names to read' }
      } } },
    { name: 'which_command', description: 'Find the full path of a shell command.',
      input_schema: { type: 'object' as const, properties: { command: { type: 'string', description: 'Command name to locate' } }, required: ['command'] } },
    { name: 'get_system_info', description: 'Get OS, CPU, memory, and Node.js runtime information.',
      input_schema: { type: 'object' as const, properties: {} } },
    { name: 'date_now', description: 'Get the current date/time in various formats.',
      input_schema: { type: 'object' as const, properties: { format: { type: 'string', description: 'iso | local | unix | date | time (default: iso)' } } } },
    { name: 'calculate', description: 'Evaluate a math expression (supports +, -, *, /, %, **, and Math.* functions).',
      input_schema: { type: 'object' as const, properties: { expression: { type: 'string', description: 'Math expression to evaluate' } }, required: ['expression'] } },

    // ── Network ──────────────────────────────────────────────────────────────
    { name: 'check_url', description: 'Check if a URL is reachable (HEAD request) and return the HTTP status.',
      input_schema: { type: 'object' as const, properties: { url: { type: 'string', description: 'URL to check' } }, required: ['url'] } },
    { name: 'download_file', description: 'Download a file from a URL and save it to disk.',
      input_schema: { type: 'object' as const, properties: {
        url: { type: 'string', description: 'Source URL' },
        destination: { type: 'string', description: 'Local file path to save to' }
      }, required: ['url'] } },
    { name: 'dns_lookup', description: 'Resolve a hostname to IP address(es) via DNS.',
      input_schema: { type: 'object' as const, properties: { hostname: { type: 'string', description: 'Hostname to resolve' } }, required: ['hostname'] } },
    { name: 'parse_url', description: 'Parse a URL into its components (protocol, host, path, query params, etc.).',
      input_schema: { type: 'object' as const, properties: { url: { type: 'string', description: 'URL to parse' } }, required: ['url'] } },

    // ── Development ──────────────────────────────────────────────────────────
    { name: 'npm_run', description: 'Run an npm script from package.json (e.g. test, build, lint).',
      input_schema: { type: 'object' as const, properties: { script: { type: 'string', description: 'npm script name (default: test)' } } } },
    { name: 'format_code', description: 'Auto-format a code file using the appropriate formatter (prettier, gofmt, black, rustfmt).',
      input_schema: { type: 'object' as const, properties: { path: { type: 'string', description: 'File or directory path to format' } }, required: ['path'] } },
    { name: 'get_imports', description: 'Extract all import/require statements from a source file.',
      input_schema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Source file path' } }, required: ['path'] } },
    { name: 'path_info', description: 'Parse a path into its components (dirname, basename, extension, absolute).',
      input_schema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Path to analyze' } }, required: ['path'] } },
    { name: 'url_encode', description: 'URL-encode or decode a string.',
      input_schema: { type: 'object' as const, properties: {
        text: { type: 'string', description: 'Text to encode/decode' },
        mode: { type: 'string', description: '"encode" (default) or "decode"' }
      }, required: ['text'] } },
    { name: 'hash_file', description: 'Compute the hash of a file\'s contents.',
      input_schema: { type: 'object' as const, properties: {
        path: { type: 'string', description: 'File path' },
        algorithm: { type: 'string', description: 'md5 | sha1 | sha256 (default) | sha512' }
      }, required: ['path'] } },

    // ── Notebook ───────────────────────────────────────────────────────────────
    { name: 'notebook_create', description: '创建新笔记',
      input_schema: { type: 'object' as const, properties: {
        title: { type: 'string', description: '笔记标题' },
        content: { type: 'string', description: '笔记内容' },
        tags: { type: 'array', items: { type: 'string' }, description: '笔记标签' }
      }, required: ['title'] } },
    { name: 'notebook_list', description: '列出所有笔记',
      input_schema: { type: 'object' as const, properties: {} } },
    { name: 'notebook_update', description: '更新笔记',
      input_schema: { type: 'object' as const, properties: {
        id: { type: 'string', description: '笔记ID' },
        title: { type: 'string', description: '笔记标题' },
        content: { type: 'string', description: '笔记内容' },
        tags: { type: 'array', items: { type: 'string' }, description: '笔记标签' }
      }, required: ['id'] } },
    { name: 'notebook_delete', description: '删除笔记',
      input_schema: { type: 'object' as const, properties: {
        id: { type: 'string', description: '笔记ID' }
      }, required: ['id'] } },
    { name: 'notebook_view', description: '查看笔记详情',
      input_schema: { type: 'object' as const, properties: {
        id: { type: 'string', description: '笔记ID' }
      }, required: ['id'] } },
    { name: 'notebook_search', description: '搜索笔记',
      input_schema: { type: 'object' as const, properties: {
        search: { type: 'string', description: '搜索词' }
      }, required: ['search'] } },
    { name: 'notebook_addTag', description: '给笔记添加标签',
      input_schema: { type: 'object' as const, properties: {
        id: { type: 'string', description: '笔记ID' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组' }
      }, required: ['id', 'tags'] } },
    { name: 'notebook_removeTag', description: '移除笔记的标签',
      input_schema: { type: 'object' as const, properties: {
        id: { type: 'string', description: '笔记ID' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组' }
      }, required: ['id', 'tags'] } },
    { name: 'notebook_tree', description: '获取笔记树结构',
      input_schema: { type: 'object' as const, properties: {} } },
  ]
}

// Need Anthropic type for the tool definitions
import type Anthropic from '@anthropic-ai/sdk'
