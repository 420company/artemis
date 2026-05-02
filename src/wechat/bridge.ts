/**
 * wechat/bridge.ts — WeChat personal bridge (iLink cloud gateway)
 *
 * Uses cursor-based long-polling via the iLink native API.
 * Replies require a context_token captured from each inbound message.
 *
 * Auth flow: run setup → QR scan → bot_token saved to WeChatStore.
 */

import { BragiStore } from '../bragi/store.js'
import { buildBridgeIdentity, runBragiMessagePump } from '../bragi/runtime.js'
import { registerBridge } from '../services/bridgeNotifier.js'
import type { BragiSessionBinding } from '../bragi/runtime.js'
import { loadSessionOrCreate } from '../bragi/sessionRecovery.js'
import type { BridgeTerminalEvent } from '../cli/bridgeNotify.js'
import type { PermissionMode } from '../cli/parseArgs.js'
import { CliSettingsStore } from '../cli/settings.js'
import type { SecretStore } from '../security/secretStore.js'
import type { UiLocale } from '../cli/locale.js'
import { pickLocale } from '../cli/locale.js'
import { buildPanel } from '../cli/ui.js'
import { createInterface } from 'node:readline'
import { SessionStore } from '../storage/sessions.js'
import { WeChatGatewayClient } from './client.js'
import { WeChatStore } from './store.js'
import { runWeixinQRLogin } from './setup.js'

export type RunWeChatBridgeOptions = {
  cwd: string
  sessionStore: SessionStore
  maxTurns: number
  secretStore?: SecretStore
  /** Permission mode applied when creating a new bridge session. Inherits
   *  from the CLI's --permission-mode (default accept-all) so remote coding
   *  via IM works out of the box. */
  defaultPermissionMode?: PermissionMode
  onInfo?: (message: string) => void
  onNotify?: (payload: BridgeTerminalEvent) => void
  signal?: AbortSignal
}

const WECHAT_SESSION_ROLLOVER_MSG_COUNT = 80

// ─── credential wizard ────────────────────────────────────────────────────────

async function askWeChatCredentials(
  store: WeChatStore,
  locale: UiLocale,
  onInfo?: (message: string) => void,
  options?: { forceRefresh?: boolean },
): Promise<{ gatewayUrl: string; gatewayToken: string }> {
  const data = await store.load()
  if (!options?.forceRefresh && data.gatewayUrl && data.gatewayToken) {
    onInfo?.(`[wechat] loaded credentials (gateway: ${data.gatewayUrl})`)
    return { gatewayUrl: data.gatewayUrl, gatewayToken: data.gatewayToken }
  }

  const envUrl   = process.env.ARTEMIS_WECHAT_GATEWAY_URL
  const envToken = process.env.ARTEMIS_WECHAT_GATEWAY_TOKEN
  if (envUrl && envToken) {
    await store.setCredentials({ gatewayUrl: envUrl, gatewayToken: envToken })
    onInfo?.(`[wechat] loaded credentials from environment (gateway: ${envUrl})`)
    return { gatewayUrl: envUrl, gatewayToken: envToken }
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'Missing WeChat credentials. Run `artemis bragi wechat setup` interactively, or set ARTEMIS_WECHAT_GATEWAY_URL / ARTEMIS_WECHAT_GATEWAY_TOKEN.',
    )
  }

  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })

  console.log()
  console.log(buildPanel(
    t('Artemis WeChat 设置', 'Artemis WeChat setup'),
    [
      t('通过 iLink 云服务扫码登录，无需本地安装任何软件。', 'Log in via iLink cloud service — no local software needed.'),
      t('步骤 1：获取二维码链接并用微信扫码。', 'Step 1: Get QR code link and scan with WeChat.'),
      t('步骤 2：在手机上确认登录。', 'Step 2: Confirm login on your phone.'),
    ]
  ))
  console.log()

  onInfo?.('[wechat] fetching QR code from iLink...')
  console.log(t('  正在获取二维码...', '  Fetching QR code...'))
  console.log()

  try {
    const result = await runWeixinQRLogin({
      onStatus: (msg) => {
        if (msg.startsWith('QR URL:')) {
          const url = msg.slice('QR URL:'.length).trim()
          console.log(t('  请用微信扫描以下链接：', '  Scan this link with WeChat:'))
          console.log()
          console.log(`  ${url}`)
          console.log()
        } else {
          console.log(`  ${msg}`)
        }
      },
    })

    const gatewayUrl   = result.botBaseUrl
    const gatewayToken = result.token
    await store.setCredentials({ gatewayUrl, gatewayToken })
    onInfo?.(`[wechat] credentials saved via QR login (gateway: ${gatewayUrl})`)
    console.log()
    console.log(t('  ✓ 微信登录成功！', '  ✓ WeChat login successful!'))
    return { gatewayUrl, gatewayToken }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(t(`微信登录失败：${msg}`, `WeChat login failed: ${msg}`))
  }
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function setupWeChatBridge(options: {
  cwd: string
  secretStore?: SecretStore
  onInfo?: (message: string) => void
  onNotify?: (payload: BridgeTerminalEvent) => void
}): Promise<string> {
  const wechatStore = new WeChatStore(options.cwd, options.secretStore)
  const bragiStore  = new BragiStore(options.cwd, options.secretStore)
  const locale = (await new CliSettingsStore(options.cwd).load()).uiLocale
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })

  const { gatewayUrl, gatewayToken } = await askWeChatCredentials(
    wechatStore,
    locale,
    options.onInfo,
    { forceRefresh: true },
  )

  // Ask about auto-start
  const raw = await new Promise<string>(res => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(t(
      '  启动 artemis 时自动连接 WeChat bridge？(Y/n) ',
      '  Auto-start WeChat bridge when artemis launches? (Y/n) ',
    ), answer => { rl.close(); res(answer.trim()) })
    rl.once('close', () => res(''))
  })
  const autoStartAnswer = raw.toLowerCase()
  const autoStart = autoStartAnswer === '' || autoStartAnswer === 'y' || autoStartAnswer === 'yes'

  // Persist auto-start flag to both WeChatStore and BragiStore
  await wechatStore.setAutoStartOnLaunch(autoStart)

  const existingBragi = await bragiStore.load()
  const existingCfg   = existingBragi.platforms.wechat
  await bragiStore.upsertPlatform('wechat', {
    enabled: true,
    autoStartOnLaunch: autoStart,
    credentials: { gatewayToken },
    allowedTargets: existingCfg?.allowedTargets ?? [],
  })

  options.onInfo?.(`[wechat] setup complete, autoStart=${autoStart}`)

  return buildPanel(
    t('WeChat 设置完成', 'WeChat setup complete'),
    [
      `Gateway: ${gatewayUrl}`,
      t(
        autoStart ? '自动连接启动：已启用' : '自动连接启动：未启用（可运行 artemis bragi wechat 手动启动）',
        autoStart ? 'Auto-start on launch: enabled' : 'Auto-start on launch: disabled (run artemis bragi wechat to start manually)',
      ),
      '',
      t('下一步：用微信给已登录的账号发一条消息即可开始对话。', 'Next: Send a WeChat message to the logged-in account to start chatting.'),
    ]
  )
}

export async function shouldAutoStartWeChatBridge(cwd: string): Promise<boolean> {
  const store = new WeChatStore(cwd)
  const data = await store.load()
  return data.autoStartOnLaunch === true && typeof data.gatewayToken === 'string'
}

export async function runWeChatBridge(options: RunWeChatBridgeOptions): Promise<void> {
  const bragiStore  = new BragiStore(options.cwd, options.secretStore)
  const wechatStore = new WeChatStore(options.cwd, options.secretStore)
  const locale      = (await new CliSettingsStore(options.cwd).load()).uiLocale

  const { gatewayUrl, gatewayToken } = await askWeChatCredentials(wechatStore, locale, options.onInfo)

  const client = new WeChatGatewayClient({ gatewayToken, gatewayBaseUrl: gatewayUrl })
  options.onInfo?.(`[wechat] personal gateway bridge connected (${gatewayUrl})`)

  // Register with cross-bridge notifier so the dream system can push to
  // every WeChat chat that has an active context token.
  const unregisterBridge = registerBridge({
    platform: 'wechat',
    push: async (payload) => {
      const data = await wechatStore.load()
      // WeChat push needs a contextToken; only chats that previously talked
      // to us have one. Skip the rest silently.
      const targets = (data.contacts ?? []).map(c => c.fromUser)
      for (const targetId of targets) {
        try {
          const contextToken = wechatStore.getContextToken(data, targetId)
          if (!contextToken) continue
          if (payload.imagePath) {
            await client.sendImage(targetId, payload.imagePath, contextToken, payload.text, options.signal)
          } else {
            await client.sendText(targetId, payload.text, contextToken, options.signal)
          }
        } catch (err) {
          options.onInfo?.(`[wechat] dream push to ${targetId} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },
  })

  function buildSessionTitle(fromUser: string): string {
    const base = options.cwd.split('/').pop() ?? options.cwd
    return `WeChat ${fromUser.slice(0, 8)} in ${base}`
  }

  await runBragiMessagePump<string | undefined>({
    channelLabel: 'WeChat',
    locale,
    cwd: options.cwd,
    bridgeIdentity: buildBridgeIdentity('wechat', `${gatewayUrl}:${gatewayToken}`),
    sessionStore: options.sessionStore,
    maxTurns: options.maxTurns,
    onInfo: options.onInfo,
    onNotify: options.onNotify,
    signal: options.signal,

    async poll() {
      const storeData = await wechatStore.load()
      const batch = await client.poll(storeData.checkpoint, options.signal)

      // Capture contextToken for each sender before anything else
      for (const m of batch.messages) {
        if (m.contextToken) {
          await wechatStore.setContextToken(m.peerUserId, m.contextToken)
        }
      }

      return {
        messages: batch.messages.map(m => ({
          targetId:    m.peerUserId,
          targetLabel: m.targetLabel,
          text:        m.text,
        })),
        checkpoint: batch.checkpoint,
      }
    },

    async commitCheckpoint(checkpoint) {
      if (checkpoint !== undefined) {
        await wechatStore.setCheckpoint(String(checkpoint))
      }
    },

    async authorizeMessage(message, parsed) {
      const d = await wechatStore.load()
      if (wechatStore.isAuthorized(d, message.targetId)) {
        return { allowed: true }
      }
      // Auto-authorize first user who sends /start when no whitelist set
      if (parsed.type === 'start' && d.allowedUsers.length === 0) {
        await wechatStore.authorizeUser(message.targetId)
        return {
          allowed: true,
          preReplies: [pickLocale(locale, {
            zh: '微信控制已启用。',
            en: 'WeChat control enabled.',
          })],
        }
      }
      return { allowed: false }
    },

    async resolveSessionBinding(message): Promise<BragiSessionBinding> {
      const d = await wechatStore.load()
      const existing = wechatStore.getContact(d, message.targetId)
      if (existing) {
        const loaded = await loadSessionOrCreate({
          sessionStore: options.sessionStore,
          sessionId: existing.sessionId,
          title: buildSessionTitle(message.targetId),
          onRecovered: async (next) => {
            options.onInfo?.(`[wechat] recovered missing session ${existing.sessionId} -> ${next.id}`)
            await wechatStore.upsertContact({ fromUser: message.targetId, sessionId: next.id, permissionMode: existing.permissionMode })
            await bragiStore.upsertSession({ platform: 'wechat', scope: 'p2p', targetId: message.targetId, targetLabel: message.targetLabel, sessionId: next.id, permissionMode: existing.permissionMode })
          },
        })
        const session = loaded.session
        if (loaded.recovered) {
          return { storedSession: session, permissionMode: existing.permissionMode, rolledOver: true }
        }
        if (session && session.messages.length < WECHAT_SESSION_ROLLOVER_MSG_COUNT) {
          return { storedSession: session, permissionMode: existing.permissionMode, rolledOver: false }
        }
        const next = options.sessionStore.createSession()
        next.title = buildSessionTitle(message.targetId)
        await options.sessionStore.save(next)
        await wechatStore.upsertContact({ fromUser: message.targetId, sessionId: next.id, permissionMode: existing.permissionMode })
        await bragiStore.upsertSession({ platform: 'wechat', scope: 'p2p', targetId: message.targetId, targetLabel: message.targetLabel, sessionId: next.id, permissionMode: existing.permissionMode })
        return { storedSession: next, permissionMode: existing.permissionMode, rolledOver: true }
      }
      const session = options.sessionStore.createSession()
      session.title = buildSessionTitle(message.targetId)
      await options.sessionStore.save(session)
      const initialMode = options.defaultPermissionMode ?? 'read-only'
      await wechatStore.upsertContact({ fromUser: message.targetId, sessionId: session.id, permissionMode: initialMode })
      await bragiStore.upsertSession({ platform: 'wechat', scope: 'p2p', targetId: message.targetId, targetLabel: message.targetLabel, sessionId: session.id, permissionMode: initialMode })
      return { storedSession: session, permissionMode: initialMode, rolledOver: false }
    },

    async persistRuntimeResult(message, result) {
      await wechatStore.upsertContact({ fromUser: message.targetId, sessionId: result.storedSession.id, permissionMode: result.permissionMode })
      await bragiStore.upsertSession({ platform: 'wechat', scope: 'p2p', targetId: message.targetId, targetLabel: message.targetLabel, sessionId: result.storedSession.id, permissionMode: result.permissionMode })
    },

    async sendMessage(targetId, text) {
      const d = await wechatStore.load()
      const contextToken = wechatStore.getContextToken(d, targetId)
      if (!contextToken) {
        throw new Error(
          `WeChat: no context token for ${targetId}. The user must send a message first before we can reply.`,
        )
      }
      await client.sendText(targetId, text, contextToken, options.signal)
    },
  })
  unregisterBridge()
}
