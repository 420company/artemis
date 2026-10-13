/**
 * serverConfigPush.ts — probe + push local provider config to an artemis-online server.
 *
 * P3: `artemis setup` writes to the local providers.json only. This module adds
 * an optional "push to server" step so the web UI / server-side agent can use
 * the same provider profiles.
 *
 * ── Auth model [已修复 C1] ──────────────────────────────────────────────
 * PUT /model-settings requires a JWT session token minted by the server's
 * wallet-signature login flow. A static GATEWAY_KEY is a server-side secret:
 * it is NEVER accepted by this endpoint (always 401) and must NEVER be asked
 * of the user. The CLI cannot mint a session token by itself, therefore:
 *
 *   1. `probeServerPushSupport()` (no credentials) checks whether the server
 *      even supports `providerProfiles` before anything else happens.
 *   2. `pushProviderConfigToServer()` takes an explicit `sessionToken`
 *      (JWT). The only supported source today is the ARTEMIS_SERVER_TOKEN
 *      environment variable — set by a future `artemis login` flow or copied
 *      from a logged-in browser session. The token is NEVER prompted for
 *      interactively and NEVER written to disk by this module.
 *   3. Without a usable token the wizard degrades honestly to local-only and
 *      says so; it never fabricates a push.
 *
 * Server API contract (artemis-online):
 *   GET /model-settings            → capability probe (may 401 without token)
 *   PUT /model-settings
 *     Authorization: Bearer <JWT session token>
 *     Body: { providerProfiles?: ProviderProfile[] }
 */

export type PushSupport =
  /** Endpoint exists and advertises providerProfiles support. */
  | { status: 'supported' }
  /** Server exists but demands a session JWT we were not given. */
  | { status: 'auth-required' }
  /** 404, or 200 without any providerProfiles capability marker. */
  | { status: 'unsupported' }
  /** DNS / TCP / TLS / timeout failure. */
  | { status: 'unreachable'; message: string }

export interface ServerPushProfile {
  id: string
  label?: string
  protocol: string
  baseUrl: string
  model: string
  /**
   * Only present when the caller explicitly opts in via
   * `toServerPushProfiles(data, { includeApiKeys: true })`.
   * Default is stripped [已修复 H1].
   */
  apiKey?: string
}

export interface ProbeOptions {
  serverUrl: string
  timeoutMs?: number
  /** Allow http://localhost (and loopbacks) for local development. Default false. */
  allowInsecureLocalhost?: boolean
}

export interface PushOptions extends ProbeOptions {
  /** JWT session token. Never prompted, never persisted by this module. */
  sessionToken: string
  profiles: ServerPushProfile[]
}

export interface PushResult {
  ok: boolean
  status: number
  /** Human-readable message for CLI output. */
  message: string
  /** True when the server accepted the PUT but a follow-up GET proved the
   *  providerProfiles were silently ignored [已修复 H2]. */
  silentlyIgnored?: boolean
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Normalize and validate a server URL [已修复 H4].
 * - Only https: is accepted.
 * - http://localhost / 127.0.0.1 / [::1] is accepted ONLY with
 *   `allowInsecureLocalhost: true` (explicit opt-in, e.g. --insecure-local).
 * - Embedded credentials (user:pass@host) are rejected.
 * Throws on any violation — callers turn this into a clean CLI error.
 */
export function normalizeServerUrl(
  raw: string,
  opts?: { allowInsecureLocalhost?: boolean },
): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(`服务端地址不合法: ${raw.trim() || '(空)'}`)
  }
  if (url.username || url.password) {
    throw new Error('服务端地址不能包含用户名/密码')
  }
  const isLoopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]'
  if (url.protocol !== 'https:') {
    if (!(isLoopback && opts?.allowInsecureLocalhost)) {
      throw new Error(
        '只允许 https 的服务端地址' +
          (isLoopback ? '（本地调试请显式传入 allowInsecureLocalhost）' : ''),
      )
    }
  }
  return url.toString().replace(/\/+$/, '')
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

/**
 * Phase 1 of the push flow [已修复 C1]: unauthenticated capability probe.
 * Never sends credentials. Interprets the response as:
 *   401/403 → 'auth-required' (endpoint exists, needs session JWT)
 *   404     → 'unsupported'
 *   200     → 'supported' iff the body advertises providerProfiles support,
 *             otherwise 'unsupported'
 *   network error / timeout → 'unreachable'
 */
export async function probeServerPushSupport(options: ProbeOptions): Promise<PushSupport> {
  const base = normalizeServerUrl(options.serverUrl, options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { signal, done } = withTimeout(timeoutMs)
  try {
    const res = await fetch(`${base}/model-settings`, { method: 'GET', signal })
    if (res.status === 401 || res.status === 403) {
      return { status: 'auth-required' }
    }
    if (res.status === 404) {
      return { status: 'unsupported' }
    }
    if (!res.ok) {
      return { status: 'unreachable', message: `服务端返回 HTTP ${res.status}` }
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      return { status: 'unsupported' }
    }
    return advertisesProviderProfiles(body) ? { status: 'supported' } : { status: 'unsupported' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'unreachable', message }
  } finally {
    done()
  }
}

/** Heuristic capability check on a GET /model-settings body. */
function advertisesProviderProfiles(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (Array.isArray(b['providerProfiles'])) return true
  const caps = b['capabilities']
  if (Array.isArray(caps) && caps.some((c) => c === 'providerProfiles')) return true
  const fields = b['supportedFields']
  if (Array.isArray(fields) && fields.some((f) => f === 'providerProfiles')) return true
  return false
}

/**
 * Build the push payload from a local ProviderStore data object.
 * [已修复 H1]: apiKey is STRIPPED by default. Pass { includeApiKeys: true }
 * only when the user explicitly confirmed sending secrets AND the transport
 * is trusted; the confirmation UI must use describePushPayload() first.
 */
export function toServerPushProfiles(
  data: {
    profiles?: Array<{
      id: string
      label?: string
      protocol: string
      baseUrl: string
      apiKey?: string
      model: string
    }>
    defaultMainProfileId?: string
  },
  opts?: { includeApiKeys?: boolean },
): ServerPushProfile[] {
  const profiles = data.profiles ?? []
  const mainId = data.defaultMainProfileId
  // Main profile first, so the server can treat index 0 as the default.
  const sorted = [...profiles].sort((a, b) => {
    if (a.id === mainId) return -1
    if (b.id === mainId) return 1
    return 0
  })
  return sorted.map((p) => {
    const out: ServerPushProfile = {
      id: p.id,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      model: p.model,
    }
    if (p.label !== undefined) out.label = p.label
    if (opts?.includeApiKeys && p.apiKey) out.apiKey = p.apiKey
    return out
  })
}

/**
 * Render the exact field list that WOULD be sent, marking sensitive fields.
 * Show this to the user and require explicit confirmation before any push
 * that includes secrets [已修复 H1 / M1].
 */
export function describePushPayload(profiles: ServerPushProfile[]): string {
  const lines: string[] = []
  for (const p of profiles) {
    lines.push(`- ${p.id}${p.label ? ` (${p.label})` : ''}`)
    lines.push(`    protocol: ${p.protocol}`)
    lines.push(`    baseUrl:  ${p.baseUrl}`)
    lines.push(`    model:    ${p.model}`)
    lines.push(
      p.apiKey !== undefined
        ? `    apiKey:   [敏感! 将明文发送, 服务端应存入 SecretStore]`
        : `    apiKey:   (不发送)`,
    )
  }
  return lines.join('\n')
}

interface PutResult {
  ok: boolean
  status: number
  message: string
}

async function putProviderProfiles(options: PushOptions, base: string): Promise<PutResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { signal, done } = withTimeout(timeoutMs)
  let res: Response
  try {
    res = await fetch(`${base}/model-settings`, {
      method: 'PUT',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.sessionToken}`,
      },
      body: JSON.stringify({ providerProfiles: options.profiles }),
    })
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: `无法连接服务端: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    done()
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, message: '会话令牌无效或已过期（401/403）' }
  }
  if (!res.ok) {
    let detail = ''
    try {
      const data = (await res.json()) as { error?: string; message?: string }
      detail = data.error ?? data.message ?? ''
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, status: res.status, message: `服务端返回 ${res.status}${detail ? `: ${detail}` : ''}` }
  }
  return { ok: true, status: res.status, message: '服务端已接受推送' }
}

/**
 * Verify the push actually landed [已修复 H2]: GET /model-settings back and
 * confirm every pushed profile id is present in the server's providerProfiles.
 * A 200 PUT means nothing if the server silently drops unknown fields.
 */
async function verifyServerPush(options: PushOptions, base: string): Promise<PushResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { signal, done } = withTimeout(timeoutMs)
  try {
    const res = await fetch(`${base}/model-settings`, {
      method: 'GET',
      signal,
      headers: { Authorization: `Bearer ${options.sessionToken}` },
    })
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: `推送后校验失败: 无法回读服务端配置 (HTTP ${res.status})`,
      }
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    const stored = (body as Record<string, unknown> | null)?.['providerProfiles']
    if (!Array.isArray(stored)) {
      // The server accepted the PUT but has no providerProfiles field at all:
      // it silently ignored our payload. Report honestly instead of claiming
      // success.
      return {
        ok: false,
        status: res.status,
        message: '服务端忽略了 providerProfiles 字段（暂不支持该推送），配置未生效',
        silentlyIgnored: true,
      }
    }
    const storedIds = new Set(
      stored.map((p) => (p as Record<string, unknown>)?.['id']).filter((id) => typeof id === 'string'),
    )
    const missing = options.profiles.map((p) => p.id).filter((id) => !storedIds.has(id))
    if (missing.length > 0) {
      return {
        ok: false,
        status: res.status,
        message: `服务端未保存以下 profile: ${missing.join(', ')}`,
        silentlyIgnored: true,
      }
    }
    return {
      ok: true,
      status: res.status,
      message: `已推送 ${options.profiles.length} 个 provider 配置到服务端（已回读校验）`,
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: `推送后校验失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    done()
  }
}

/**
 * Push provider profiles to the artemis-online server (phase 2, [已修复 C1]).
 * Requires an explicit JWT session token — never prompts for one.
 * Always verifies with a follow-up GET [已修复 H2]; never reports success
 * when the server silently ignored the payload.
 */
export async function pushProviderConfigToServer(options: PushOptions): Promise<PushResult> {
  const base = normalizeServerUrl(options.serverUrl, options)
  if (!options.sessionToken) {
    return { ok: false, status: 0, message: '缺少会话令牌：服务端推送需要登录后的 JWT（ARTEMIS_SERVER_TOKEN）' }
  }
  const put = await putProviderProfiles(options, base)
  if (!put.ok) {
    return { ok: false, status: put.status, message: put.message }
  }
  return verifyServerPush(options, base)
}

/**
 * Resolve a session token from the environment only.
 * There is deliberately NO interactive prompt for tokens: pasting a JWT into
 * a terminal is error-prone and the token is short-lived. A future
 * `artemis login` (wallet-signature) flow will mint and store it.
 */
export function resolveSessionTokenFromEnv(): string | undefined {
  const token = process.env['ARTEMIS_SERVER_TOKEN']
  return token && token.trim() ? token.trim() : undefined
}
