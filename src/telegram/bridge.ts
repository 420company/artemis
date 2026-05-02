/**
 * telegram/bridge.ts — Telegram bridge entry point
 *
 * Handles: token setup wizard, authorization, message pump lifecycle.
 * Exposes:
 *   runTelegramBridge()      — long-running pump
 *   setupTelegramBridge()    — one-shot setup wizard
 *   shouldAutoStartTelegram() — check autoStartOnLaunch flag
 */

import { createInterface } from 'node:readline'
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
import { ensureGatewayAutoStart } from '../cli/gatewayService.js'
import { SessionStore } from '../storage/sessions.js'
import { TelegramBotClient, extractTelegramTextMessages } from './client.js'
import { TelegramStore } from './store.js'

// ─── types ────────────────────────────────────────────────────────────────────

export type RunTelegramBridgeOptions = {
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

const TELEGRAM_SESSION_ROLLOVER_MSG_COUNT = 80

// ─── helpers ──────────────────────────────────────────────────────────────────

function maskToken(token: string): string {
  if (token.length <= 8) return `${token.slice(0, 2)}${'*'.repeat(token.length - 2)}`
  return `${token.slice(0, 4)}${'*'.repeat(token.length - 8)}${token.slice(-4)}`
}

/** Prompt for a secret token with masking: shows first 4 + last 4 chars, middle as *. */
function readMaskedToken(question: string): Promise<string | null> {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      rl.question(question, answer => { resolve(answer.trim() || null); rl.close() })
      rl.once('close', () => resolve(null))
      return
    }
    process.stdout.write(question)
    let buf = ''
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onData)
        process.stdout.write('\n')
        resolve(buf || null)
      } else if (ch === '') {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onData)
        process.stdout.write('\n')
        resolve(null)
      } else if (ch === '' || ch === '\b') {
        if (buf.length > 0) {
          const prev = maskToken(buf)
          buf = buf.slice(0, -1)
          const next = buf.length > 0 ? maskToken(buf) : ''
          process.stdout.write('\b'.repeat(prev.length) + next + ' '.repeat(prev.length - next.length) + '\b'.repeat(prev.length - next.length))
        }
      } else if (ch >= ' ') {
        const prevMasked = buf.length > 0 ? maskToken(buf) : ''
        buf += ch
        const newMasked = maskToken(buf)
        if (prevMasked.length > 0) process.stdout.write('\b'.repeat(prevMasked.length))
        process.stdout.write(newMasked)
      }
    }
    process.stdin.on('data', onData)
  })
}

function parseCommaSeparatedIds(input: string): string[] {
  return input.split(',').map(e => e.trim()).filter(Boolean)
}

function buildTelegramSessionTitle(chatLabel: string, cwd: string): string {
  const base = cwd.split('/').pop() ?? cwd
  return `Telegram ${chatLabel} in ${base}`
}

async function loadTelegramToken(
  telegramStore: TelegramStore,
  bragiStore: BragiStore,
  onInfo?: (message: string) => void,
): Promise<{ token: string; source: 'env' | 'telegram-store' | 'bragi-store' } | undefined> {
  const envToken = process.env.ARTEMIS_TELEGRAM_BOT_TOKEN
  if (envToken) {
    await telegramStore.setBotToken(envToken)
    onInfo?.(`[telegram] loaded bot token from environment (${maskToken(envToken)})`)
    return { token: envToken, source: 'env' }
  }

  const telegramData = await telegramStore.load()
  if (telegramData.botToken) {
    onInfo?.(`[telegram] loaded bot token from telegram store (${maskToken(telegramData.botToken)})`)
    return { token: telegramData.botToken, source: 'telegram-store' }
  }

  const bragiData = await bragiStore.load()
  const bragiToken = bragiData.platforms.telegram?.credentials.botToken
  if (bragiToken) {
    // Keep the legacy runtime store hydrated because poll offsets and
    // authorized chats still live there. This bridges new Bragi config to the
    // older Telegram runtime path used by the background gateway.
    await telegramStore.setBotToken(bragiToken)
    onInfo?.(`[telegram] loaded bot token from bragi store (${maskToken(bragiToken)})`)
    return { token: bragiToken, source: 'bragi-store' }
  }

  return undefined
}

// ─── token setup ──────────────────────────────────────────────────────────────

async function askTelegramToken(
  telegramStore: TelegramStore,
  bragiStore: BragiStore,
  locale: UiLocale,
  onInfo?: (message: string) => void,
): Promise<{ token: string; configuredNow: boolean }> {
  const existing = await loadTelegramToken(telegramStore, bragiStore, onInfo)
  if (existing) return { token: existing.token, configuredNow: false }

  if (!process.stdin.isTTY) {
    throw new Error(
      'Missing Telegram bot token. Launch `artemis bragi telegram` interactively once, or set ARTEMIS_TELEGRAM_BOT_TOKEN.'
    )
  }

  // Interactive wizard
  console.log()
  console.log(buildPanel(
    pickLocale(locale, { zh: 'Artemis Telegram 设置', en: 'Artemis Telegram setup' }),
    [
      pickLocale(locale, { zh: '步骤 1：打开 Telegram，搜索 BotFather。', en: 'Step 1: Open Telegram and find BotFather.' }),
      pickLocale(locale, { zh: '步骤 2：向 BotFather 发送 /newbot，创建机器人，复制 token。', en: 'Step 2: Send /newbot to BotFather, create a bot, copy the token.' }),
      pickLocale(locale, { zh: '步骤 3：把 token 粘贴到下一步。', en: 'Step 3: Paste the token below.' }),
    ]
  ))
  console.log()

  let token = ''
  while (!token) {
    const input = await readMaskedToken(
      pickLocale(locale, { zh: '  Telegram bot token: ', en: '  Telegram bot token: ' })
    )
    if (input === null || !input.trim()) {
      throw new Error(pickLocale(locale, { zh: '已取消 Telegram token 设置。', en: 'Telegram token setup cancelled.' }))
    }
    const candidate = input.trim()
    try {
      const client = new TelegramBotClient(candidate)
      const me = await client.getMe()
      const label = '@' + (me.username ?? me.first_name)
      console.log()
      console.log(buildPanel(
        pickLocale(locale, { zh: 'Token 验证成功', en: 'Token verified' }),
        [
          pickLocale(locale, { zh: `机器人账号: ${label}`, en: `Bot account: ${label}` }),
          pickLocale(locale, { zh: 'Token 可用，继续配置。', en: 'Token works. Continuing setup.' }),
        ]
      ))
      console.log()
      token = candidate
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log()
      console.log(buildPanel(
        pickLocale(locale, { zh: 'Token 验证失败', en: 'Token verification failed' }),
        [msg, pickLocale(locale, { zh: '请重新输入完整 token。', en: 'Please re-enter the full token.' })]
      ))
      console.log()
    }
  }

  // Prompt for allowed chat IDs (plain readline — not a secret)
  console.log()
  console.log(buildPanel(
    pickLocale(locale, { zh: 'Telegram 控制权限', en: 'Telegram control access' }),
    [
      pickLocale(locale, { zh: '步骤 4 (可选)：填写允许控制 CLI 的 Telegram chat ID，逗号分隔。', en: 'Step 4 (optional): Enter allowed Telegram chat IDs, comma-separated.' }),
      pickLocale(locale, { zh: '如留空，第一个发送 /start 的聊天可认领控制权。', en: 'If blank, the first chat that sends /start can claim control.' }),
    ]
  ))
  console.log()
  const allowedRaw = await new Promise<string>(res => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(pickLocale(locale, { zh: '  允许的 chat ID [可选]: ', en: '  Allowed chat IDs [optional]: ' }), answer => {
      rl.close()
      res(answer.trim())
    })
    rl.once('close', () => res(''))
  })
  const data = await telegramStore.setBotToken(token)
  data.allowedChatIds = parseCommaSeparatedIds(allowedRaw)
  await telegramStore.save(data)

  onInfo?.(`[telegram] bot token saved (${maskToken(token)}), allowed chats=${data.allowedChatIds.length}`)
  return { token, configuredNow: true }
}

// ─── auto-start prompt ────────────────────────────────────────────────────────

async function maybePromptAutoStart(
  telegramStore: TelegramStore,
  forcePrompt: boolean,
  locale: UiLocale,
  onInfo?: (message: string) => void,
): Promise<boolean | undefined> {
  const data = await telegramStore.load()
  if (!process.stdin.isTTY || (!forcePrompt && typeof data.autoStartOnLaunch === 'boolean')) {
    return data.autoStartOnLaunch
  }

  console.log()
  console.log(buildPanel(
    pickLocale(locale, { zh: 'Telegram 启动偏好', en: 'Telegram startup preference' }),
    [
      pickLocale(locale, { zh: '步骤 5：是否每次启动 CLI 时自动连接 Telegram bridge？', en: 'Step 5: Auto-connect Telegram bridge on every CLI launch?' }),
    ]
  ))
  console.log()
  const ans = await new Promise<string>(res => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(pickLocale(locale, { zh: '  自动启动？ [Y/n] ', en: '  Auto-start? [Y/n] ' }), answer => {
      rl.close()
      res(answer.trim())
    })
    rl.once('close', () => res(''))
  })
  const normalized = ans.toLowerCase()
  const enabled = normalized === '' || normalized === 'y' || normalized === 'yes'
  await telegramStore.setAutoStartOnLaunch(enabled)
  onInfo?.(`[telegram] auto-start on launch ${enabled ? 'enabled' : 'disabled'}`)
  return enabled
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function setupTelegramBridge(options: {
  cwd: string
  secretStore?: SecretStore
  onInfo?: (message: string) => void
  onNotify?: (payload: BridgeTerminalEvent) => void
}): Promise<string> {
  const telegramStore = new TelegramStore(options.cwd, options.secretStore)
  const bragiStore = new BragiStore(options.cwd, options.secretStore)
  const locale = (await new CliSettingsStore(options.cwd).load()).uiLocale
  const { token } = await askTelegramToken(telegramStore, bragiStore, locale, options.onInfo)
  const autoStart = true
  await telegramStore.setAutoStartOnLaunch(true)
  options.onInfo?.('[telegram] background auto-start enabled')
  const client = new TelegramBotClient(token)
  const me = await client.getMe()
  const label = '@' + (me.username ?? me.first_name)

  // Register platform in BragiStore so the main interface shows Telegram as an active bridge
  const existingData = await bragiStore.load()
  const existing = existingData.platforms.telegram
  await bragiStore.upsertPlatform('telegram', {
    enabled: true,
    autoStartOnLaunch: autoStart,
    credentials: { botToken: token },
    allowedTargets: existing?.allowedTargets ?? [],
  })
  await ensureGatewayAutoStart(options.cwd)

  return buildPanel(
    pickLocale(locale, { zh: 'Telegram 设置完成', en: 'Telegram setup complete' }),
    [
      pickLocale(locale, { zh: `机器人账号: ${label}`, en: `Bot account: ${label}` }),
      pickLocale(locale, {
        zh: '后台自动运行：已启用（系统登录后自动连接）',
        en: 'Background auto-start: enabled (connects after OS login)',
      }),
      '',
      pickLocale(locale, { zh: '下一步：在 Telegram 里打开你的机器人，发送 /start。', en: 'Next: Open your bot in Telegram and send /start.' }),
    ]
  )
}

export async function shouldAutoStartTelegram(cwd: string): Promise<boolean> {
  const telegramData = await new TelegramStore(cwd).load()
  if (telegramData.autoStartOnLaunch === true && typeof telegramData.botToken === 'string') return true

  const bragiData = await new BragiStore(cwd).load()
  const config = bragiData.platforms.telegram
  return (
    config?.enabled !== false &&
    config?.autoStartOnLaunch === true &&
    typeof config.credentials.botToken === 'string'
  )
}

export async function runTelegramBridge(options: RunTelegramBridgeOptions): Promise<void> {
  const bragiStore = new BragiStore(options.cwd, options.secretStore)
  const telegramStore = new TelegramStore(options.cwd, options.secretStore)
  const locale = (await new CliSettingsStore(options.cwd).load()).uiLocale

  const { token } = await askTelegramToken(telegramStore, bragiStore, locale, options.onInfo)
  await maybePromptAutoStart(telegramStore, false, locale, options.onInfo)

  const client = new TelegramBotClient(token)

  // Register with the cross-bridge notifier so the dream system (and any
  // future ambient sender) can push messages to this bridge's authorized
  // chats. Unregistered automatically when the pump shuts down.
  const unregisterBridge = registerBridge({
    platform: 'telegram',
    push: async (payload) => {
      const data = await telegramStore.load()
      const targets = data.allowedChatIds ?? []
      const { existsSync } = await import('node:fs')
      for (const chatId of targets) {
        try {
          if (payload.imagePath && existsSync(payload.imagePath)) {
            // Use sendPhoto with caption — image + caption in one message,
            // so phone users actually see the screenshot inline.
            await client.sendPhoto(chatId, payload.imagePath, payload.text)
          } else {
            await client.sendMessage(chatId, payload.text)
            if (payload.imagePath) {
              // File doesn't exist (yet?) — surface the path as fallback.
              await client.sendMessage(chatId, `🖼 ${payload.imagePath}`)
            }
          }
        } catch (err) {
          options.onInfo?.(`[telegram] push to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },
  })

  try {
  await runBragiMessagePump({
    channelLabel: 'Telegram',
    locale,
    cwd: options.cwd,
    bridgeIdentity: buildBridgeIdentity('telegram', token),
    sessionStore: options.sessionStore,
    maxTurns: options.maxTurns,
    commandSuffixPattern: /@[^/\s]+$/i,
    onInfo: options.onInfo,
    onNotify: options.onNotify,
    signal: options.signal,

    async poll() {
      const data = await telegramStore.load()
      const updates = await client.getUpdates(data.pollOffset, 20)
      const messages = await extractTelegramTextMessages(client, updates).then(messages => 
        messages.map(m => ({
          targetId: m.chatId,
          targetLabel: m.chatLabel,
          text: m.text,
          sourceMessageId: String(m.updateId),
          images: m.images,
        }))
      )
      return {
        messages,
        checkpoint: typeof updates.at(-1)?.update_id === 'number'
          ? (updates.at(-1)!.update_id + 1)
          : undefined,
      }
    },

    async commitCheckpoint(checkpoint) {
      await telegramStore.setPollOffset(checkpoint)
    },

    async authorizeMessage(message, parsed) {
      const data = await telegramStore.load()
      if (telegramStore.isAuthorized(data, message.targetId)) return { allowed: true }

      if (parsed.type === 'start' && data.allowedChatIds.length === 0) {
        await telegramStore.authorizeChat(message.targetId)
        return {
          allowed: true,
          preReplies: [`Telegram control enabled for chat ${message.targetLabel}.`],
        }
      }
      if (data.allowedChatIds.length === 0) {
        return {
          allowed: false,
          preReplies: ['This bot is not claimed yet. Send /start from your controller chat.'],
        }
      }
      return { allowed: false, preReplies: ['This chat is not authorized for Artemis control.'] }
    },

    async resolveSessionBinding(message): Promise<BragiSessionBinding> {
      const data = await telegramStore.load()
      const existing = telegramStore.getChat(data, message.targetId)

      if (existing) {
        const loaded = await loadSessionOrCreate({
          sessionStore: options.sessionStore,
          sessionId: existing.sessionId,
          title: buildTelegramSessionTitle(message.targetLabel, options.cwd),
          onRecovered: async (next) => {
            options.onInfo?.(`[telegram] recovered missing session ${existing.sessionId} -> ${next.id}`)
            await telegramStore.upsertChat({ chatId: message.targetId, sessionId: next.id, permissionMode: existing.permissionMode })
            await bragiStore.upsertSession({ platform: 'telegram', scope: message.targetId, targetId: message.targetId, targetLabel: message.targetLabel, sessionId: next.id, permissionMode: existing.permissionMode })
          },
        })
        const session = loaded.session
        if (loaded.recovered) {
          return { storedSession: session, permissionMode: existing.permissionMode, rolledOver: true }
        }
        if (session && session.messages.length < TELEGRAM_SESSION_ROLLOVER_MSG_COUNT) {
          return { storedSession: session, permissionMode: existing.permissionMode, rolledOver: false }
        }
        // rollover
        const next = options.sessionStore.createSession()
        next.title = buildTelegramSessionTitle(message.targetLabel, options.cwd)
        await options.sessionStore.save(next)
        await telegramStore.upsertChat({ chatId: message.targetId, sessionId: next.id, permissionMode: existing.permissionMode })
        await bragiStore.upsertSession({ platform: 'telegram', scope: message.targetId, targetId: message.targetId, targetLabel: message.targetLabel, sessionId: next.id, permissionMode: existing.permissionMode })
        return { storedSession: next, permissionMode: existing.permissionMode, rolledOver: true }
      }

      const session = options.sessionStore.createSession()
      session.title = buildTelegramSessionTitle(message.targetLabel, options.cwd)
      await options.sessionStore.save(session)
      const initialMode = options.defaultPermissionMode ?? 'read-only'
      await telegramStore.upsertChat({ chatId: message.targetId, sessionId: session.id, permissionMode: initialMode })
      await bragiStore.upsertSession({ platform: 'telegram', scope: message.targetId, targetId: message.targetId, targetLabel: message.targetLabel, sessionId: session.id, permissionMode: initialMode })
      return { storedSession: session, permissionMode: initialMode, rolledOver: false }
    },

    async persistRuntimeResult(message, result) {
      await telegramStore.upsertChat({
        chatId: message.targetId,
        sessionId: result.storedSession.id,
        permissionMode: result.permissionMode,
      })
      await bragiStore.upsertSession({
        platform: 'telegram',
        scope: message.targetId,
        targetId: message.targetId,
        targetLabel: message.targetLabel,
        sessionId: result.storedSession.id,
        permissionMode: result.permissionMode,
      })
    },

    async sendMessage(targetId, text) {
      await client.sendMessage(targetId, text)
    },
  })
  } finally {
    unregisterBridge()
  }
}
