/**
 * discord/bridge.ts — Discord bridge entry point
 *
 * Connects to Discord via Gateway WebSocket and pipes messages to/from brain.ts.
 * Config: credentials stored in BragiStore under platform "discord".
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
import { pickLocale } from '../cli/locale.js'
import { buildPanel } from '../cli/ui.js'
import { ensureGatewayAutoStart } from '../cli/gatewayService.js'
import type { SecretStore } from '../security/secretStore.js'
import { SessionStore } from '../storage/sessions.js'
import { DiscordBotClient, DiscordGatewayBridge } from './client.js'
import { DiscordStore } from './store.js'

// ─── setup wizard ─────────────────────────────────────────────────────────────

function maskToken(token: string): string {
  if (token.length <= 8) return `${'*'.repeat(token.length)}`
  return `${token.slice(0, 4)}${'*'.repeat(token.length - 8)}${token.slice(-4)}`
}

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
      } else if (ch === '') {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onData)
        process.stdout.write('\n')
        resolve(null)
      } else if (ch === '' || ch === '\b') {
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

export async function setupDiscordBridge(options: {
  cwd: string
  secretStore?: SecretStore
  onInfo?: (message: string) => void
}): Promise<string> {
  const locale = (await new CliSettingsStore(options.cwd).load()).uiLocale
  const bragiStore = new BragiStore(options.cwd, options.secretStore)
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })

  console.log()
  console.log(buildPanel(
    t('Artemis Discord 设置', 'Artemis Discord setup'),
    [
      t('步骤 1：打开 Discord 开发者门户 → discord.com/developers/applications', 'Step 1: Go to discord.com/developers/applications'),
      t('步骤 2：新建应用 → Bot → 重置并复制 Token。', 'Step 2: New Application → Bot → Reset Token → Copy.'),
      t('步骤 3：在 Bot 页面开启 "Message Content Intent"（必须！）', 'Step 3: Enable "Message Content Intent" in Bot settings (required!).'),
      t('步骤 4：把 Token 粘贴到下面。', 'Step 4: Paste the token below.'),
    ]
  ))
  console.log()

  let token = ''
  let botName = ''

  while (!token) {
    const input = await readMaskedToken(t('  Discord bot token: ', '  Discord bot token: '))
    if (input === null || !input.trim()) {
      throw new Error(t('已取消 Discord token 设置。', 'Discord token setup cancelled.'))
    }
    const candidate = input.trim()
    try {
      const client = new DiscordBotClient(candidate)
      const me = await client.getCurrentUser()
      botName = me.global_name ?? me.username
      console.log()
      console.log(buildPanel(
        t('Token 验证成功', 'Token verified'),
        [t(`机器人账号: ${botName}`, `Bot account: ${botName}`)]
      ))
      console.log()
      token = candidate
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log()
      console.log(buildPanel(
        t('Token 验证失败', 'Token verification failed'),
        [msg, t('请重新输入完整 Token。', 'Please re-enter the full token.')]
      ))
      console.log()
    }
  }

  const autoStart = true

  const existingData = await bragiStore.load()
  const existing = existingData.platforms.discord
  await bragiStore.upsertPlatform('discord', {
    enabled: true,
    autoStartOnLaunch: autoStart,
    credentials: { botToken: token },
    allowedTargets: existing?.allowedTargets ?? [],
  })
  await ensureGatewayAutoStart(options.cwd)

  options.onInfo?.(`[discord] bot token saved (${maskToken(token)}), autoStart=${autoStart}`)

  return buildPanel(
    t('Discord 设置完成', 'Discord setup complete'),
    [
      t(`机器人账号: ${botName}`, `Bot account: ${botName}`),
      t(
        '后台自动运行：已启用（系统登录后自动连接）',
        'Background auto-start: enabled (connects after OS login)',
      ),
      '',
      t('下一步：在你的 Discord 频道发送 /start 认领控制权。', 'Next: Send /start in your Discord channel to claim control.'),
    ]
  )
}

export type RunDiscordBridgeOptions = {
  cwd: string
  sessionStore: SessionStore
  maxTurns: number
  secretStore?: SecretStore
  /** Permission mode applied when creating a new bridge session. Inherits
   *  from the CLI's --permission-mode (default PRODUCER) so remote coding
   *  via IM works out of the box. */
  defaultPermissionMode?: PermissionMode
  onInfo?: (message: string) => void
  onNotify?: (payload: BridgeTerminalEvent) => void
  signal?: AbortSignal
}

const DISCORD_SESSION_ROLLOVER_MSG_COUNT = 80

function buildDiscordSessionTitle(targetLabel: string, cwd: string): string {
  return `Discord ${targetLabel} in ${cwd.split('/').pop() ?? cwd}`
}

export async function shouldAutoStartDiscordBridge(cwd: string): Promise<boolean> {
  const store = new BragiStore(cwd)
  const data = await store.load()
  const config = data.platforms.discord
  return (
    config?.enabled !== false &&
    config?.autoStartOnLaunch === true &&
    typeof config.credentials.botToken === 'string'
  )
}

export async function runDiscordBridge(options: RunDiscordBridgeOptions): Promise<void> {
  const locale = (await new CliSettingsStore(options.cwd).load()).uiLocale
  const bragiStore = new BragiStore(options.cwd, options.secretStore)
  const discordStore = new DiscordStore(options.cwd)

  const bragiData = await bragiStore.load()
  const discordConfig = bragiData.platforms.discord
  if (!discordConfig?.credentials.botToken) {
    throw new Error(
      'Discord is not configured yet. Run `artemis bragi discord setup` first.'
    )
  }

  const gateway = new DiscordGatewayBridge(discordConfig.credentials.botToken)
  const me = await gateway.getCurrentUser()
  options.onInfo?.(`[discord] bot token verified for ${me.global_name ?? me.username}`)
  await gateway.start({ signal: options.signal, onInfo: options.onInfo })

  // Register with cross-bridge notifier so the dream system can push to
  // every authorized Discord channel/DM the user has approved.
  const unregisterBridge = registerBridge({
    platform: 'discord',
    push: async (payload) => {
      const data = await discordStore.load()
      const bragiLive = await bragiStore.load()
      const allowedTargets = new Set([
        ...(bragiLive.platforms.discord?.allowedTargets ?? []),
        ...(data.targets ?? []).map(t => t.targetId),
      ])
      const targets = payload.targetId ? [payload.targetId] : Array.from(allowedTargets)
      const { existsSync } = await import('node:fs')
      let sent = 0
      const failed: Array<{ target: string; error: string }> = []
      for (const targetId of targets) {
        try {
          if (payload.videoPath && existsSync(payload.videoPath)) {
            await gateway.sendAttachment(targetId, payload.videoPath, payload.text)
          } else if (payload.imagePath && existsSync(payload.imagePath)) {
            // Real attachment upload — phone users see the screenshot inline.
            await gateway.sendAttachment(targetId, payload.imagePath, payload.text)
          } else {
            await gateway.sendMessage(targetId, payload.text)
            if (payload.imagePath) {
              // File missing on disk — surface path as fallback.
              await gateway.sendMessage(targetId, `🖼 ${payload.imagePath}`)
            }
            if (payload.videoPath) {
              await gateway.sendMessage(targetId, `🎬 ${payload.videoPath}`)
            }
          }
          sent += 1
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          failed.push({ target: targetId, error })
          options.onInfo?.(`[discord] push to ${targetId} failed: ${error}`)
        }
      }
      return { sent, failed }
    },
  })

  try {
    await runBragiMessagePump({
      channelLabel: 'Discord',
      locale,
      cwd: options.cwd,
      bridgeIdentity: buildBridgeIdentity('discord', discordConfig.credentials.botToken),
      sessionStore: options.sessionStore,
      maxTurns: options.maxTurns,
      onInfo: options.onInfo,
    onNotify: options.onNotify,
      signal: options.signal,

      async poll() {
        const messages = await gateway.drainTextMessages()
        return {
          messages: messages.map(m => ({
            targetId: m.targetId,
            targetLabel: `${m.targetLabel} · ${m.authorLabel}`,
            text: m.text,
            sourceMessageId: m.messageId,
            images: m.images,
          })),
        }
      },

      async authorizeMessage(message, parsed) {
        // Primary auth: check discord.json targets (source of truth for sessions)
        const discordData = await discordStore.load()
        if (discordStore.getTarget(discordData, message.targetId)) return { allowed: true }

        // Fallback: check bragi.json allowedTargets for backward compat
        const liveData = await bragiStore.load()
        const allowed = liveData.platforms.discord?.allowedTargets ?? []
        if (allowed.includes(message.targetId)) return { allowed: true }

        // Any channel or DM can claim access by sending /start
        if (parsed.type === 'start') {
          const config = liveData.platforms.discord
          if (config) {
            await bragiStore.upsertPlatform('discord', {
              ...config,
              allowedTargets: [...allowed, message.targetId],
            })
          }
          return { allowed: true, preReplies: [`Artemis connected to ${message.targetLabel}.`] }
        }

        return { allowed: false, preReplies: ['Send /start to connect Artemis to this channel.'] }
      },

      async resolveSessionBinding(message): Promise<BragiSessionBinding> {
        const data = await discordStore.load()
        const existing = discordStore.getTarget(data, message.targetId)

        if (existing) {
          const loaded = await loadSessionOrCreate({
            sessionStore: options.sessionStore,
            sessionId: existing.sessionId,
            title: buildDiscordSessionTitle(message.targetLabel, options.cwd),
            onRecovered: async (next) => {
              options.onInfo?.(`[discord] recovered missing session ${existing.sessionId} -> ${next.id}`)
              await discordStore.upsertTarget({ targetId: message.targetId, sessionId: next.id, permissionMode: existing.permissionMode })
              await bragiStore.upsertSession({ platform: 'discord', scope: message.targetId, targetId: message.targetId, targetLabel: message.targetLabel, sessionId: next.id, permissionMode: existing.permissionMode })
            },
          })
          const session = loaded.session
          if (loaded.recovered) {
            return { storedSession: session, permissionMode: existing.permissionMode, rolledOver: true }
          }
          if (session && session.messages.length < DISCORD_SESSION_ROLLOVER_MSG_COUNT) {
            return { storedSession: session, permissionMode: existing.permissionMode, rolledOver: false }
          }
          const next = options.sessionStore.createSession()
          next.title = buildDiscordSessionTitle(message.targetLabel, options.cwd)
          await options.sessionStore.save(next)
          await discordStore.upsertTarget({ targetId: message.targetId, sessionId: next.id, permissionMode: existing.permissionMode })
          await bragiStore.upsertSession({ platform: 'discord', scope: message.targetId, targetId: message.targetId, targetLabel: message.targetLabel, sessionId: next.id, permissionMode: existing.permissionMode })
          return { storedSession: next, permissionMode: existing.permissionMode, rolledOver: true }
        }

        const session = options.sessionStore.createSession()
        session.title = buildDiscordSessionTitle(message.targetLabel, options.cwd)
        await options.sessionStore.save(session)
        const initialMode = options.defaultPermissionMode ?? 'read-only'
        await discordStore.upsertTarget({ targetId: message.targetId, sessionId: session.id, permissionMode: initialMode })
        await bragiStore.upsertSession({ platform: 'discord', scope: message.targetId, targetId: message.targetId, targetLabel: message.targetLabel, sessionId: session.id, permissionMode: initialMode })
        return { storedSession: session, permissionMode: initialMode, rolledOver: false }
      },

      async persistRuntimeResult(message, result) {
        await discordStore.upsertTarget({
          targetId: message.targetId,
          sessionId: result.storedSession.id,
          permissionMode: result.permissionMode,
        })
        await bragiStore.upsertSession({
          platform: 'discord',
          scope: message.targetId,
          targetId: message.targetId,
          targetLabel: message.targetLabel,
          sessionId: result.storedSession.id,
          permissionMode: result.permissionMode,
        })
      },

      async sendMessage(targetId, text) {
        await gateway.sendMessage(targetId, text)
      },
    })
  } finally {
    unregisterBridge()
    await gateway.stop()
  }
}
