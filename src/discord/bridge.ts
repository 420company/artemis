/**
 * discord/bridge.ts — Discord bridge entry point
 *
 * Connects to Discord via Gateway WebSocket and pipes messages to/from brain.ts.
 * Config: credentials stored in BragiStore under platform "discord".
 */

import { BragiStore } from '../bragi/store.js'
import { runBragiMessagePump } from '../bragi/runtime.js'
import type { BragiSessionBinding } from '../bragi/runtime.js'
import type { BridgeTerminalEvent } from '../cli/bridgeNotify.js'
import type { PermissionMode } from '../cli/parseArgs.js'
import { CliSettingsStore } from '../cli/settings.js'
import { pickLocale } from '../cli/locale.js'
import { buildPanel } from '../cli/ui.js'
import { createPrompt } from '../cli/prompt.js'
import type { SecretStore } from '../security/secretStore.js'
import { SessionStore } from '../storage/sessions.js'
import { DiscordBotClient, DiscordGatewayBridge } from './client.js'
import { DiscordStore } from './store.js'

// ─── setup wizard ─────────────────────────────────────────────────────────────

function maskToken(token: string): string {
  if (token.length <= 8) return '***'
  return token.slice(0, 4) + '…' + token.slice(-4)
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

  const prompt = createPrompt({ prefix: '  > ' })
  let token = ''
  let botName = ''

  while (!token) {
    process.stdout.write(t('Discord bot token: ', 'Discord bot token: '))
    const input = await prompt.read()
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

  // Ask about auto-start
  process.stdout.write(t(
    '启动 artemis 时自动连接 Discord bridge？(y/N) ',
    'Auto-start Discord bridge when artemis launches? (y/N) '
  ))
  const autoStartRaw = (await prompt.read()) ?? ''
  const autoStart = autoStartRaw.trim().toLowerCase() === 'y'

  const existingData = await bragiStore.load()
  const existing = existingData.platforms.discord
  await bragiStore.upsertPlatform('discord', {
    enabled: true,
    autoStartOnLaunch: autoStart,
    credentials: { botToken: token },
    allowedTargets: existing?.allowedTargets ?? [],
  })

  options.onInfo?.(`[discord] bot token saved (${maskToken(token)}), autoStart=${autoStart}`)

  return buildPanel(
    t('Discord 设置完成', 'Discord setup complete'),
    [
      t(`机器人账号: ${botName}`, `Bot account: ${botName}`),
      t(
        autoStart ? '自动连接启动：已启用' : '自动连接启动：未启用（可运行 artemis bragi discord 手动启动）',
        autoStart ? 'Auto-start on launch: enabled' : 'Auto-start on launch: disabled (run artemis bragi discord to start manually)',
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
   *  from the CLI's --permission-mode (default accept-all) so remote coding
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

  try {
    await runBragiMessagePump({
      channelLabel: 'Discord',
      locale,
      cwd: options.cwd,
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
          })),
        }
      },

      async authorizeMessage(message, parsed) {
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
          const session = await options.sessionStore.load(existing.sessionId)
          if (session && session.messages.length < DISCORD_SESSION_ROLLOVER_MSG_COUNT) {
            return { storedSession: session, permissionMode: existing.permissionMode, rolledOver: false }
          }
          const next = options.sessionStore.createSession()
          next.title = buildDiscordSessionTitle(message.targetLabel, options.cwd)
          await options.sessionStore.save(next)
          await discordStore.upsertTarget({ targetId: message.targetId, sessionId: next.id, permissionMode: existing.permissionMode })
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
    await gateway.stop()
  }
}
