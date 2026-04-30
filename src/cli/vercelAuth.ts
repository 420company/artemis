/**
 * cli/vercelAuth.ts — interactive Vercel deployment token setup
 *
 * Triggered via /vercel slash command. Walks the user through:
 *   1. (If a token is already saved) — verify it's still valid; offer relogin
 *   2. Open https://vercel.com/account/tokens, create a new token, paste it
 *   3. Validate against api.vercel.com so we catch typos / expired tokens
 *   4. Persist to ~/.artemis/vercel.json
 *
 * The saved token is consumed by tools/runCommand.ts: when a shell command
 * involves `vercel`, the runner injects VERCEL_TOKEN into the spawn env.
 * That keeps the integration scoped — no global env mutation, no edits to
 * the user's vercel CLI config files.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { UiLocale } from './locale.js'
import { pickLocale } from './locale.js'

const HOME_DIR = os.homedir()
const STORE_PATH = path.join(HOME_DIR, '.artemis', 'vercel.json')

const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  white: '\x1b[97m', gray: '\x1b[90m',
}
const c = (text: string, ...codes: string[]): string =>
  process.stdout.isTTY ? codes.join('') + text + A.reset : text

export interface VercelAuthRecord {
  token: string
  userEmail?: string
  userName?: string
  username?: string
  savedAt: string
}

export interface VercelAuthResult {
  configured: boolean
  changed: boolean
  record?: VercelAuthRecord
}

/** Read whatever is on disk. Returns null if file missing or unreadable. */
export async function readStoredVercelAuth(): Promise<VercelAuthRecord | null> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as VercelAuthRecord
    if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** Synchronous variant for hot paths (e.g. tool spawn) where awaiting is awkward. */
export function readStoredVercelTokenSync(): string | null {
  try {
    const raw = readFileSync(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as VercelAuthRecord
    return parsed?.token && typeof parsed.token === 'string' ? parsed.token : null
  } catch {
    return null
  }
}

async function writeStoredVercelAuth(record: VercelAuthRecord): Promise<void> {
  const dir = path.dirname(STORE_PATH)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(STORE_PATH, JSON.stringify(record, null, 2), { mode: 0o600 })
  await fs.chmod(STORE_PATH, 0o600)
}

async function deleteStoredVercelAuth(): Promise<void> {
  try {
    await fs.unlink(STORE_PATH)
  } catch {
    /* fine — already gone */
  }
}

interface ValidationOk {
  ok: true
  email?: string
  name?: string
  username?: string
}
interface ValidationFail {
  ok: false
  status?: number
  message: string
}

/**
 * Hit Vercel's user endpoint to confirm the token works. Returns identity
 * info on success — useful for the "logged in as ..." display.
 */
export async function validateVercelToken(
  token: string,
): Promise<ValidationOk | ValidationFail> {
  try {
    const res = await fetch('https://api.vercel.com/v2/user', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '')
      return {
        ok: false,
        status: res.status,
        message: body.length > 0 ? body.slice(0, 240) : 'Token rejected by Vercel API',
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: `Vercel API returned HTTP ${res.status}`,
      }
    }
    const payload = (await res.json()) as { user?: { email?: string; name?: string; username?: string } }
    const user = payload.user ?? {}
    return {
      ok: true,
      email: user.email,
      name: user.name,
      username: user.username,
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Read a single line, optionally masking the input.
 * Returns null if the user cancels (Ctrl-C or empty close).
 */
function askLine(question: string, mask = false): Promise<string | null> {
  return new Promise((resolve) => {
    process.stdin.resume()
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: mask ? false : undefined,
    })

    if (mask && process.stdin.isTTY) {
      process.stdout.write(question)
      let buf = ''
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')
      const cleanup = () => {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onData)
        rl.close()
      }
      const onData = (ch: string) => {
        if (ch === '\r' || ch === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolve(buf || null)
        } else if (ch === '') {
          // Ctrl-C
          cleanup()
          process.stdout.write('\n')
          resolve(null)
        } else if (ch === '' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1)
            process.stdout.write('\b \b')
          }
        } else if (ch >= ' ') {
          buf += ch
          // Echo a generic dot so the token never appears on screen.
          process.stdout.write('•'.repeat([...ch].length))
        }
      }
      process.stdin.on('data', onData)
      return
    }

    rl.question(question, (answer) => {
      resolve(answer.trim() || null)
      rl.close()
    })
    rl.once('close', () => resolve(null))
  })
}

async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  const ans = (await askLine(`${question} ${hint} `))?.toLowerCase() ?? ''
  if (ans === '') return defaultYes
  return ans.startsWith('y')
}

function describeUser(record: { email?: string; name?: string; username?: string }): string {
  if (record.email) return record.email
  if (record.username) return `@${record.username}`
  if (record.name) return record.name
  return 'Vercel account'
}

function maskTokenForDisplay(token: string): string {
  if (token.length <= 12) return '*'.repeat(token.length)
  return token.slice(0, 6) + '*'.repeat(token.length - 12) + token.slice(-6)
}

/**
 * Public entry point. Called by the /vercel slash command.
 * Designed to run in a TTY-released console (caller must drop the blessed UI
 * before invoking this).
 */
export async function runVercelAuthWizard(localeHint: UiLocale): Promise<VercelAuthResult> {
  const isTTY = process.stdin.isTTY && process.stdout.isTTY
  if (!isTTY) {
    console.log('  Not an interactive terminal — Vercel auth setup requires a TTY.')
    console.log('  非交互终端，Vercel 授权配置需要交互式终端。')
    return { configured: false, changed: false }
  }

  const locale = localeHint
  const t = (zhText: string, enText: string) => pickLocale(locale, { zh: zhText, en: enText })

  console.log()
  console.log(c(`  ▸ ${t('Vercel 部署授权', 'Vercel deployment auth')}`, A.bold + A.cyan))
  console.log(c(`       ${t('单独配置 Vercel CLI 部署 token，与主模型 / 视觉模型互不影响。', 'Configure the Vercel deployment token independently of main / visual models.')}`, A.dim))
  console.log()

  // ── Step 1 — check existing saved token ──────────────────────────────────
  const existing = await readStoredVercelAuth()
  if (existing) {
    console.log(c(`  ${t('检测到已保存的 token', 'Found a saved token')}`, A.bold))
    console.log(c(`    token   ${maskTokenForDisplay(existing.token)}`, A.dim))
    console.log(c(`    saved   ${existing.savedAt}`, A.dim))
    console.log()
    console.log(c(`  ${t('正在验证 token 是否仍然有效…', 'Validating token against Vercel API…')}`, A.dim))
    const verdict = await validateVercelToken(existing.token)
    if (verdict.ok) {
      console.log(c(`  ✓ ${t('Token 有效，登录身份', 'Token valid, signed in as')}: ${describeUser(verdict)}`, A.green))
      console.log()
      const replace = await askYesNo(
        t(
          '是否要更换为新 token？',
          'Replace with a new token?',
        ),
        false,
      )
      if (!replace) {
        // User keeps current — refresh user metadata if changed
        if (
          verdict.email !== existing.userEmail ||
          verdict.username !== existing.username ||
          verdict.name !== existing.userName
        ) {
          await writeStoredVercelAuth({
            ...existing,
            userEmail: verdict.email,
            userName: verdict.name,
            username: verdict.username,
          })
        }
        console.log()
        console.log(c(`  ${t('保持当前 token，配置未修改。', 'Keeping current token; nothing changed.')}`, A.dim))
        console.log()
        return { configured: true, changed: false, record: existing }
      }
    } else {
      console.log(c(`  ✗ ${t('Token 无效或已过期', 'Token invalid or expired')}: ${verdict.message}`, A.red))
      console.log(c(`     ${t('需要重新配置。', 'You need to reconfigure.')}`, A.yellow))
      console.log()
    }
  } else {
    console.log(c(`  ${t('当前未配置 Vercel token。', 'No Vercel token configured yet.')}`, A.dim))
    console.log()
  }

  // ── Step 2 — guide user to fetch a new token ─────────────────────────────
  console.log(c(`  ${t('请按以下步骤生成 token：', 'Follow these steps to create a token:')}`, A.bold))
  console.log()
  console.log(c(`    1. ${t('在浏览器打开:', 'Open this in a browser:')} https://vercel.com/account/tokens`, A.white))
  console.log(c(`    2. ${t('点击 Create Token', 'Click "Create Token"')}`, A.white))
  console.log(c(`    3. ${t('名称随意（建议: artemis-cli），范围: Full Account，过期时间按需选择', 'Name it whatever (suggest: artemis-cli), Scope = Full Account, pick an expiration')}`, A.white))
  console.log(c(`    4. ${t('点 Create，复制生成的 token（一次性显示）', 'Click Create, copy the generated token (shown once)')}`, A.white))
  console.log(c(`    5. ${t('回到这里，把 token 粘贴到下面（输入会被掩码显示）', 'Come back here and paste the token below (input is masked)')}`, A.white))
  console.log()

  // ── Step 3 — read + validate ────────────────────────────────────────────
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const tokenInput = await askLine(
      c(`  ${t('Token: ', 'Token: ')}`, A.bold),
      true,
    )
    if (!tokenInput) {
      console.log()
      console.log(c(`  ${t('已取消，未保存任何 token。', 'Cancelled, nothing saved.')}`, A.dim))
      console.log()
      return { configured: existing !== null, changed: false, record: existing ?? undefined }
    }
    const token = tokenInput.trim()
    if (token.length < 8) {
      console.log(c(`  ${t('Token 太短，再试一次。', 'Token looks too short, try again.')}`, A.yellow))
      continue
    }

    console.log(c(`  ${t('验证中…', 'Verifying…')}`, A.dim))
    const verdict = await validateVercelToken(token)
    if (!verdict.ok) {
      console.log(c(`  ✗ ${t('Token 验证失败', 'Token validation failed')}: ${verdict.message}`, A.red))
      if (verdict.status === 401 || verdict.status === 403) {
        console.log(c(`     ${t('请重新生成一个 Full Account 范围的 token。', 'Please generate a new token with Full Account scope.')}`, A.yellow))
      }
      if (attempt < 3) {
        console.log(c(`  ${t('再试一次（剩余 ', 'Try again (remaining ')}${3 - attempt}${t(' 次）。', ' attempts).')}`, A.dim))
        continue
      }
      console.log()
      console.log(c(`  ${t('放弃了，未保存。', 'Giving up, nothing saved.')}`, A.dim))
      console.log()
      return { configured: existing !== null, changed: false, record: existing ?? undefined }
    }

    // ── Step 4 — persist ──────────────────────────────────────────────────
    const record: VercelAuthRecord = {
      token,
      userEmail: verdict.email,
      userName: verdict.name,
      username: verdict.username,
      savedAt: new Date().toISOString(),
    }
    await writeStoredVercelAuth(record)

    console.log()
    console.log(c(`  ✓ ${t('Token 验证通过', 'Token verified')}: ${describeUser(verdict)}`, A.green))
    console.log(c(`  ✓ ${t('已保存到', 'Saved to')} ${STORE_PATH} (${t('权限 0600', 'mode 0600')})`, A.green))
    console.log()
    console.log(c(`  ${t('从现在起，artemis 在执行 vercel / npx vercel ... 命令时会自动注入 VERCEL_TOKEN，无需手动 export。', 'Artemis will now auto-inject VERCEL_TOKEN whenever it runs vercel / npx vercel commands. No manual export needed.')}`, A.dim))
    console.log()
    return { configured: true, changed: true, record }
  }

  return { configured: existing !== null, changed: false, record: existing ?? undefined }
}

/**
 * Standalone helper: clear the saved token. Used by /vercel logout subcommand.
 */
export async function clearStoredVercelAuth(): Promise<boolean> {
  const had = (await readStoredVercelAuth()) !== null
  await deleteStoredVercelAuth()
  return had
}

export const VERCEL_AUTH_STORE_PATH = STORE_PATH
