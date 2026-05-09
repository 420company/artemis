/**
 * cli/updateCheck.ts — startup check against the npm registry.
 *
 * On interactive launch, fires a background fetch to npm for the latest
 * published artemis-code version. Before the chat UI takes over, if the
 * registry reports a newer version, the user can update immediately or keep
 * using the current process. The check intentionally runs on every interactive
 * startup so "cancel" only defers until the next launch.
 */

import { spawn } from 'node:child_process'
import { pickLocale, type UiLocale } from './locale.js'
import type { PromptIO } from '../providers/types.js'
import { choosePromptBoolean } from './prompt.js'

const PACKAGE_NAME = 'artemis-code'
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const CHECK_TIMEOUT_MS = 4_000
const PROMPT_AWAIT_TIMEOUT_MS = 6_000

export type UpdateCheckOutcome =
  | { kind: 'has-update'; current: string; latest: string }
  | { kind: 'no-update' }
  | { kind: 'skipped'; reason: 'env' | 'non-tty' | 'network' | 'parse' | 'invalid' }

export type UpdatePromptResult = 'updated' | 'cancel' | 'skipped' | 'failed'

export function startUpdateCheck(params: {
  currentVersion: string
}): Promise<UpdateCheckOutcome> {
  return performCheck(params).catch(() => ({ kind: 'skipped', reason: 'network' as const }))
}

async function performCheck(params: {
  currentVersion: string
}): Promise<UpdateCheckOutcome> {
  if (process.env.ARTEMIS_DISABLE_UPDATE_CHECK === '1') {
    return { kind: 'skipped', reason: 'env' }
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { kind: 'skipped', reason: 'non-tty' }
  }

  let latest: string
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      return { kind: 'skipped', reason: 'network' }
    }
    const body = (await res.json()) as { version?: unknown }
    if (typeof body.version !== 'string') {
      return { kind: 'skipped', reason: 'parse' }
    }
    latest = body.version.trim()
  } catch {
    return { kind: 'skipped', reason: 'network' }
  }

  if (!/^\d+\.\d+\.\d+/.test(latest)) {
    return { kind: 'skipped', reason: 'invalid' }
  }

  if (isNewerVersion(latest, params.currentVersion)) {
    return { kind: 'has-update', current: params.currentVersion, latest }
  }
  return { kind: 'no-update' }
}

function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] => {
    const main = v.split('-')[0] ?? v
    return main.split('.').map((piece) => {
      const n = parseInt(piece, 10)
      return Number.isFinite(n) ? n : 0
    })
  }
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    if (ai > bi) return true
    if (ai < bi) return false
  }
  return false
}

export async function awaitUpdateCheckOutcome(
  promise: Promise<UpdateCheckOutcome>,
): Promise<UpdateCheckOutcome> {
  return Promise.race([
    promise,
    new Promise<UpdateCheckOutcome>((resolve) =>
      setTimeout(() => resolve({ kind: 'skipped', reason: 'network' }), PROMPT_AWAIT_TIMEOUT_MS),
    ),
  ])
}

function getNpmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function installLatestVersion(locale: UiLocale): Promise<boolean> {
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  console.log()
  console.log(`  ${t('正在更新 Artemis，请稍候…', 'Updating Artemis, please wait…')}`)
  console.log(`  npm install -g ${PACKAGE_NAME}@latest`)
  console.log()

  return new Promise((resolve) => {
    const child = spawn(getNpmCommand(), ['install', '-g', `${PACKAGE_NAME}@latest`], {
      stdio: 'inherit',
      shell: false,
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

export async function maybePromptForUpdate(params: {
  outcome: UpdateCheckOutcome
  locale: UiLocale
  promptIO: PromptIO | undefined
}): Promise<UpdatePromptResult> {
  if (params.outcome.kind !== 'has-update') {
    return 'skipped'
  }
  const { current, latest } = params.outcome
  const t = (zh: string, en: string) => pickLocale(params.locale, { zh, en })

  const accepted = await choosePromptBoolean(params.promptIO, {
    title: t(
      `Artemis 检测到新版本：v${current} → v${latest}，是否现在更新？`,
      `Artemis detected a new version: v${current} → v${latest}. Update now?`,
    ),
    yesLabel: t('更新到最新版', 'Update to latest'),
    noLabel: t('暂不更新', 'Not now'),
    yesDescription: t(
      `自动运行 npm install -g ${PACKAGE_NAME}@latest；完成后退出，请重新启动 artemis`,
      `Runs npm install -g ${PACKAGE_NAME}@latest; exits after completion, then relaunch artemis`,
    ),
    noDescription: t(
      '继续使用当前版本；下次启动会再次检测并询问',
      'Continue with the current version; Artemis will check again on next startup',
    ),
    defaultValue: false,
  })

  if (!accepted) {
    console.log()
    console.log(`  ${t('已暂不更新，继续启动 Artemis。', 'Update skipped; continuing Artemis startup.')}`)
    console.log()
    return 'cancel'
  }

  const ok = await installLatestVersion(params.locale)
  console.log()
  if (ok) {
    console.log(`  ${t('Artemis 已更新到最新版。请重新启动 artemis。', 'Artemis has been updated. Please relaunch artemis.')}`)
    console.log()
    return 'updated'
  }
  console.log(`  ${t('自动更新失败，将继续使用当前版本。', 'Automatic update failed; continuing with the current version.')}`)
  console.log()
  return 'failed'
}
