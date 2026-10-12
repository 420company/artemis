/**
 * scripts/evalZh/mockWeb.ts — an offline "web" for errand tasks: a fixture
 * directory of made-up provider and shop pages served on 127.0.0.1, and
 * browser tools that browse only it (installed in the worker process, in
 * mock and live mode, so a task can never reach a real shop or pay anyone).
 *
 * Links (<a href>) and buttons with data-goto="page.html" navigate; typed
 * values are remembered per page; nothing is ever submitted anywhere real.
 */

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

export interface MockWebHandle {
  baseUrl: string
  close: () => Promise<void>
}

/**
 * `portFile` keeps the address the same across a task's messages (each runs
 * in its own process), so a password bound to the mock shop's origin in one
 * message is still that shop's in the next.
 */
export async function startMockWeb(dir: string, portFile?: string): Promise<MockWebHandle> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const file = path.resolve(dir, rel)
    if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>404</title></head><body><h1>页面不存在</h1></body></html>')
      return
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' })
    res.end(fs.readFileSync(file))
  })
  const listen = (port: number) =>
    new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
  let wanted = 0
  try {
    wanted = portFile ? Number(fs.readFileSync(portFile, 'utf8').trim()) || 0 : 0
  } catch {
    wanted = 0
  }
  if (!(await listen(wanted)) && !(await listen(0))) throw new Error('mock web: cannot listen')
  const port = (server.address() as { port: number }).port
  if (portFile) fs.writeFileSync(portFile, String(port))
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

/** Replaces `{{MOCK_WEB}}` in every string of a mock script. */
export function withMockWeb<T>(value: T, baseUrl: string): T {
  return JSON.parse(JSON.stringify(value).split('{{MOCK_WEB}}').join(baseUrl)) as T
}

interface Page {
  url: string
  html: string
  title: string
  typed: Record<string, string>
}

function textOf(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => `${inner.replace(/<[^>]+>/g, '')} (${href})`)
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/option)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/** The form field a simple selector (#id, [name=x], tag[name="x"]) points at in a page. */
function fieldOf(html: string, selector: string): { tag: string; type?: string; hints: string } | undefined {
  const id = /^#([\w-]+)$/.exec(selector)?.[1]
  const name = /^(?:\w+)?\[name=["']?([\w-]+)["']?\]$/.exec(selector)?.[1]
  for (const m of html.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
    const attrs = m[2]!
    const attr = (key: string) => new RegExp(`\\b${key}="([^"]*)"`, 'i').exec(attrs)?.[1]
    if ((id && attr('id') === id) || (name && attr('name') === name)) {
      return { tag: m[1]!, type: attr('type'), hints: `${attr('autocomplete') ?? ''} ${attr('name') ?? ''} ${attr('id') ?? ''}` }
    }
  }
  return undefined
}

/**
 * Overrides the browser tools' executors in this process's tool registry
 * (the eval worker only) so they browse the mock web.
 */
export async function installMockBrowser(baseUrl: string, stateFile?: string): Promise<void> {
  const { getToolDefinition } = await import('../../src/tools/registry.js')
  let page: Page | undefined
  // The page stays open between messages, as the real shared browser does
  // (each message runs in its own process, on a new port).
  const remembered = (() => {
    try {
      return stateFile ? (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { path?: string }).path : undefined
    } catch {
      return undefined
    }
  })()
  const ok = (action: unknown, output: string) => ({ action, ok: true, output })
  const bad = (action: unknown, output: string, code = 'mock_web') => ({ action, ok: false, output, error: { code, message: output } })
  const open = async (url: string): Promise<Page> => {
    let target = url
    if (!target.startsWith(baseUrl)) target = `${baseUrl}/index.html`
    const res = await fetch(target)
    const html = await res.text()
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? ''
    page = { url: target, html, title, typed: {} }
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ path: target.slice(baseUrl.length) }))
    return page
  }
  if (remembered) await open(`${baseUrl}${remembered}`).catch(() => undefined)
  const set = (type: string, execute: (a: any) => Promise<unknown>) => {
    const def = getToolDefinition(type) as { execute?: unknown } | undefined
    if (def) def.execute = execute
  }
  set('browser_navigate', async (a) => {
    const requested = String(a?.url ?? '')
    const p = await open(requested)
    const note = requested.startsWith(baseUrl) ? '' : `（离线测试网络：${requested} 不可访问，已打开网络首页）\n`
    return ok(a, `${note}✅ 已打开 ${p.url}\n标题：${p.title}`)
  })
  set('browser_extract_text', async (a) => (page ? ok(a, `页面：${page.url}\n${textOf(page.html).slice(0, 8000)}`) : bad(a, '还没有打开任何网页')))
  set('browser_screenshot', async (a) => (page ? ok(a, `📸 已截图（离线测试）：${page.title}`) : bad(a, '还没有打开任何网页')))
  set('browser_wait_for', async (a) => (page ? ok(a, '✅ 元素已出现') : bad(a, '还没有打开任何网页')))
  set('browser_close', async (a) => {
    page = undefined
    return ok(a, '已关闭标签页')
  })
  for (const type of ['browser_evaluate', 'browser_console', 'browser_requests', 'browser_tabs']) set(type, async (a) => ok(a, '（离线测试网络：此操作无结果）'))
  const { resolveCredentialValue, credentialFieldKind } = await import('../../src/tools/browser/browserTools.js')
  const fill = async (a: any, value: string) => {
    if (!page) return bad(a, '还没有打开任何网页')
    const current = page
    const selector = String(a?.selector ?? '')
    if (!selector) return bad(a, 'selector 必填', 'invalid_input')
    // Stored credentials go through the real rules: bound origin, field kind, whole value.
    const resolved = await resolveCredentialValue(value, current.url, async () => {
      const field = fieldOf(current.html, selector)
      return field ? credentialFieldKind(field) : 'other'
    })
    if (!resolved.ok) return { action: a, ...resolved.result }
    current.typed[selector] = resolved.credential ? `{{credential:${resolved.credential}}}` : value
    return ok(a, `⌨  已输入到 ${selector}: "${resolved.credential ? '••••' : value.slice(0, 80)}"`)
  }
  set('browser_type', async (a) => fill(a, String(a?.text ?? '')))
  set('browser_form_input', async (a) => fill(a, String(a?.value ?? (Array.isArray(a?.values) ? a.values.join(',') : a?.checked ?? ''))))
  set('browser_click', async (a) => {
    if (!page) return bad(a, '还没有打开任何网页')
    const wanted = String(a?.text ?? a?.selector ?? '').replace(/^text=/, '').trim()
    const targets = [
      ...[...page.html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1]!, label: m[2]!.replace(/<[^>]+>/g, '').trim(), id: /id="([^"]*)"/.exec(m[0])?.[1] ?? '' })),
      ...[...page.html.matchAll(/<button\s[^>]*data-goto="([^"]*)"[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => ({ href: m[1]!, label: m[2]!.replace(/<[^>]+>/g, '').trim(), id: /id="([^"]*)"/.exec(m[0])?.[1] ?? '' })),
    ]
    const hit = targets.find((t) => wanted && (t.label.includes(wanted) || `#${t.id}` === wanted || t.href === wanted))
    if (!hit) return bad(a, `找不到可点击的元素：${wanted}`)
    const next = new URL(hit.href, page.url).toString()
    const p = await open(next)
    return ok(a, `🖱 已点击「${hit.label}」→ ${p.url}\n标题：${p.title}`)
  })
}
