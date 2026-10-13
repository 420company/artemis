/**
 * setupWizardServerPush.ts — P3 integration: offer "push to server" at the end
 * of the setup wizard.
 *
 * Wiring (in setupWizard.ts — see wiring-setupWizard.patch):
 *
 *   import { offerServerPush } from './setupWizardServerPush.js'
 *   // ... inside printSetupSummary(), before the "Next steps" panel:
 *   await offerServerPush(cwd, locale)
 *
 * ── Behavior after the C1 fix ────────────────────────────────────────────
 * The server's PUT /model-settings needs a JWT session token (wallet-signature
 * login). The CLI cannot mint one, and a static GATEWAY_KEY is never accepted
 * (always 401) and must never be asked of the user. So this flow is:
 *
 *   1. Ask for the server URL (https enforced).
 *   2. Probe support WITHOUT credentials.
 *   3. If the probe says auth-required/unsupported/unreachable → print a clear,
 *      honest message and return. Local config is untouched.
 *   4. Only when ARTEMIS_SERVER_TOKEN is set (a valid session JWT) AND the
 *      probe succeeded do we show the exact payload, require explicit
 *      confirmation, push, and verify via GET-back.
 *
 * Prompt I/O uses the shared createInteractivePromptIO (real masked input),
 * not a local re-implementation [已修复 H3].
 */

import { createInteractivePromptIO } from './prompt.js'
import { ProviderStore } from '../providers/store.js'
import {
  describePushPayload,
  normalizeServerUrl,
  probeServerPushSupport,
  pushProviderConfigToServer,
  resolveSessionTokenFromEnv,
  toServerPushProfiles,
} from './serverConfigPush.js'
import type { UiLocale } from './locale.js'

function tr(locale: UiLocale, zh: string, en: string): string {
  return locale === 'zh-CN' ? zh : en
}

async function askText(prompt: string): Promise<string> {
  const io = createInteractivePromptIO()
  return (await io.ask(`${prompt} `, false)).trim()
}

async function askYesNo(locale: UiLocale, prompt: string, defaultYes: boolean): Promise<boolean> {
  const io = createInteractivePromptIO()
  const hint = defaultYes ? '(Y/n)' : '(y/N)'
  const answer = (await io.ask(`${prompt} ${hint} `, false)).trim().toLowerCase()
  if (!answer) return defaultYes
  return answer === 'y' || answer === 'yes' || (locale === 'zh-CN' && answer === '是')
}

/**
 * Offer to push the just-configured provider profiles to the artemis-online
 * server. Called once at the end of the setup wizard. Never throws; any
 * failure degrades to "local config only" with a clear message.
 */
export async function offerServerPush(cwd: string, locale: UiLocale): Promise<void> {
  const want = await askYesNo(
    locale,
    tr(
      locale,
      '是否把刚配置的 Provider 推送到 artemis-online 服务端？（网页端和服务端 agent 将使用相同模型）',
      'Push the just-configured providers to your artemis-online server? (The web UI and server-side agent will use the same models)',
    ),
    false,
  )
  if (!want) return

  const rawUrl = await askText(
    tr(locale, '服务端地址（例如 https://agent.example.com）:', 'Server URL (e.g. https://agent.example.com):'),
  )
  if (!rawUrl) {
    console.log(tr(locale, '已跳过：未提供服务端地址。', 'Skipped: no server URL given.'))
    return
  }

  // [已修复 H4] https enforced; embedded creds rejected.
  let serverUrl: string
  try {
    serverUrl = normalizeServerUrl(rawUrl)
  } catch (err) {
    console.log(
      tr(locale, '已跳过：', 'Skipped: ') + (err instanceof Error ? err.message : String(err)),
    )
    return
  }

  const store = new ProviderStore(cwd)
  const data = await store.load()
  // [已修复 H1] apiKey stripped by default.
  const profiles = toServerPushProfiles(data)
  if (profiles.length === 0) {
    console.log(tr(locale, '本地没有已配置的 provider，无需推送。', 'No local providers configured, nothing to push.'))
    return
  }

  // [已修复 C1] Phase 1: capability probe, no credentials.
  console.log(tr(locale, '正在检查服务端是否支持 provider 推送…', 'Probing server for provider-push support…'))
  const probe = await probeServerPushSupport({ serverUrl })

  if (probe.status === 'unreachable') {
    console.log(
      tr(
        locale,
        `无法连接服务端（${probe.message}）。配置已保存到本地，服务端推送已跳过。`,
        `Cannot reach the server (${probe.message}). Config saved locally; server push skipped.`,
      ),
    )
    return
  }
  if (probe.status === 'unsupported') {
    console.log(
      tr(
        locale,
        '服务端暂不支持 provider 推送（需要服务端升级）。配置已保存到本地。',
        'The server does not support provider push yet (server upgrade required). Config saved locally.',
      ),
    )
    return
  }
  // 'auth-required' or 'supported': either way we need a session JWT for PUT.
  const sessionToken = resolveSessionTokenFromEnv()
  if (!sessionToken) {
    console.log(
      tr(
        locale,
        '服务端推送需要登录会话（钱包签名），CLI 暂不支持自动登录；配置已保存到本地。' +
          '如已有有效会话令牌，可设置 ARTEMIS_SERVER_TOKEN 环境变量后重试。',
        'Server push requires a logged-in session (wallet signature), which the CLI cannot do yet; config saved locally. ' +
          'If you have a valid session token, set the ARTEMIS_SERVER_TOKEN env var and retry.',
      ),
    )
    return
  }

  // We have a token: show EXACTLY what will be sent and require explicit
  // confirmation [已修复 H1 / M1].
  console.log(tr(locale, '将推送以下配置到服务端（不含 API key）：', 'About to push the following to the server (no API keys):'))
  console.log(describePushPayload(profiles))
  const confirmed = await askYesNo(
    locale,
    tr(locale, '确认推送？', 'Confirm push?'),
    false,
  )
  if (!confirmed) {
    console.log(tr(locale, '已取消推送，本地配置不受影响。', 'Push cancelled; local config unaffected.'))
    return
  }

  console.log(tr(locale, `正在推送 ${profiles.length} 个 provider…`, `Pushing ${profiles.length} providers…`))
  const result = await pushProviderConfigToServer({ serverUrl, sessionToken, profiles })

  if (result.ok) {
    console.log(`✓ ${result.message}`)
  } else {
    console.log(`✗ ${tr(locale, '推送失败', 'Push failed')}: ${result.message}`)
    console.log(
      tr(
        locale,
        '本地配置不受影响。',
        'Local config is unaffected.',
      ),
    )
  }
}
