import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { BragiStore } from './store.js'
import { broadcastToBridges, listRegisteredBridges } from '../services/bridgeNotifier.js'
import type { BragiPlatformId } from './types.js'

export type BridgeImagePlatform = BragiPlatformId | 'all'

export type BridgeImageBroadcastResult = {
  imagePath: string
  caption: string
  live: {
    registered: BragiPlatformId[]
    sent: number
    failed: Array<{ platform: BragiPlatformId; error: string }>
  }
  configured: Array<{
    platform: BragiPlatformId
    attempted: number
    sent: number
    failed: Array<{ target: string; error: string }>
  }>
  skipped: string[]
}

const PLATFORMS: BragiPlatformId[] = ['telegram', 'discord', 'wechat']

function normalizePlatforms(platform?: BridgeImagePlatform): BragiPlatformId[] {
  if (!platform || platform === 'all') return PLATFORMS
  return [platform]
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

function isConfiguredPlatform(platform: string): platform is BragiPlatformId {
  return platform === 'telegram' || platform === 'discord' || platform === 'wechat'
}

/**
 * Send a local image as a real mobile attachment through the active Bragi
 * bridges first, then fall back to configured REST clients for Telegram and
 * Discord when their bridges are not currently running.
 *
 * WeChat requires a live context_token captured from an inbound message, so it
 * can only send images through the running WeChat bridge.
 */
export async function sendBragiImageBroadcast(options: {
  cwd: string
  imagePath: string
  caption?: string
  platform?: BridgeImagePlatform
  targetId?: string
  source?: string
}): Promise<BridgeImageBroadcastResult> {
  const imagePath = resolve(options.imagePath)
  if (!existsSync(imagePath)) {
    throw new Error(`image file not found: ${imagePath}`)
  }

  const caption = options.caption?.trim() || '🖼 Artemis image'
  const platforms = normalizePlatforms(options.platform)
  const registered = listRegisteredBridges().filter(p => platforms.includes(p))
  const live = registered.length > 0
    ? await broadcastToBridges({ text: caption, imagePath, source: options.source ?? 'bridge_send_image' })
    : { sent: 0, failed: [] }

  const store = new BragiStore(options.cwd)
  const data = await store.load()
  const configured: BridgeImageBroadcastResult['configured'] = []
  const skipped: string[] = []

  for (const platform of platforms) {
    if (registered.includes(platform)) continue
    const config = data.platforms[platform]
    if (!config?.enabled) {
      skipped.push(`${platform}: not enabled`)
      continue
    }

    const targets = options.targetId
      ? [options.targetId]
      : uniq(config.allowedTargets ?? [])

    if (targets.length === 0) {
      skipped.push(`${platform}: no allowed targets`)
      continue
    }

    const record = { platform, attempted: targets.length, sent: 0, failed: [] as Array<{ target: string; error: string }> }

    if (platform === 'telegram') {
      const botToken = config.credentials.botToken
      if (!botToken) {
        record.failed.push(...targets.map(target => ({ target, error: 'missing botToken' })))
      } else {
        const { TelegramBotClient } = await import('../telegram/client.js')
        const client = new TelegramBotClient(botToken)
        for (const target of targets) {
          try {
            await client.sendPhoto(target, imagePath, caption)
            record.sent += 1
          } catch (err) {
            record.failed.push({ target, error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
    } else if (platform === 'discord') {
      const botToken = config.credentials.botToken
      if (!botToken) {
        record.failed.push(...targets.map(target => ({ target, error: 'missing botToken' })))
      } else {
        const { DiscordBotClient } = await import('../discord/client.js')
        const client = new DiscordBotClient(botToken)
        for (const target of targets) {
          try {
            await client.sendAttachment(target, imagePath, caption)
            record.sent += 1
          } catch (err) {
            record.failed.push({ target, error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
    } else if (platform === 'wechat') {
      record.failed.push(...targets.map(target => ({
        target,
        error: 'WeChat image sending requires the running WeChat bridge because iLink needs a live context_token from the chat. Ask the user to send one message first and keep `artemis bragi wechat` running.',
      })))
    } else if (!isConfiguredPlatform(platform)) {
      skipped.push(`${platform}: unsupported platform`)
    }

    configured.push(record)
  }

  return {
    imagePath,
    caption,
    live: { registered, sent: live.sent, failed: live.failed },
    configured,
    skipped,
  }
}

export function formatBridgeImageBroadcastResult(result: BridgeImageBroadcastResult): string {
  const lines = [
    `image: ${result.imagePath}`,
    `caption: ${result.caption}`,
    `live bridges: ${result.live.registered.length ? result.live.registered.join(', ') : 'none'}; sent=${result.live.sent}; failed=${result.live.failed.length}`,
  ]
  for (const item of result.configured) {
    lines.push(`${item.platform}: attempted=${item.attempted}; sent=${item.sent}; failed=${item.failed.length}`)
    for (const failure of item.failed.slice(0, 5)) {
      lines.push(`  - ${failure.target}: ${failure.error}`)
    }
  }
  for (const skipped of result.skipped) lines.push(`skipped: ${skipped}`)
  return lines.join('\n')
}
