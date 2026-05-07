import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { BragiStore } from './store.js'
import { broadcastToBridges, listRegisteredBridges } from '../services/bridgeNotifier.js'
import type { BridgePlatform } from '../services/bridgeNotifier.js'
import type { BragiPlatformId } from './types.js'
import { resolveDataRootDir } from '../utils/fs.js'
import { findLatestDreamImage, findLatestDreamVideo } from '../services/dreamStore.js'

export type BridgeImagePlatform = BragiPlatformId | 'all'
export type BridgeMediaKind = 'image' | 'video'

const LATEST_DREAM_IMAGE_SENTINEL = 'latest_dream'
const LATEST_DREAM_VIDEO_SENTINEL = 'latest_dream_video'
const LATEST_DREAM_VIDEO_ALIASES = new Set([
  LATEST_DREAM_VIDEO_SENTINEL,
  'latestdreamvideo',
  'latest dream video',
  'latest-dream-video',
  'latest_dream_mp4',
  'latestdreammp4',
])

export type BridgeImageBroadcastResult = {
  imagePath: string
  caption: string
  live: {
    registered: BridgePlatform[]
    sent: number
    failed: Array<{ platform: BridgePlatform; error: string }>
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

function isStaleWeChatContextError(err: unknown): boolean {
  return err instanceof Error && /ret=-2\b/.test(err.message)
}

function normalizeOptionalTargetId(targetId: string | undefined): string | undefined {
  const trimmed = targetId?.trim()
  return trimmed || undefined
}

async function resolveImagePath(inputPath: string, cwd: string): Promise<string> {
  const trimmed = inputPath.trim()
  if (!trimmed) throw new Error('image path is empty')
  if (trimmed === LATEST_DREAM_IMAGE_SENTINEL) {
    const latest = await findLatestDreamImage()
    if (latest) return latest
    throw new Error('no dream image found in ~/.artemis/dreams')
  }

  const candidates = isAbsolute(trimmed)
    ? [trimmed]
    : uniq([
        resolve(cwd, trimmed),
        resolve(resolveDataRootDir(cwd), trimmed),
        resolve(homedir(), '.artemis', trimmed),
        resolve(process.cwd(), trimmed),
      ])

  const found = candidates.find(candidate => existsSync(candidate))
  if (found) return found
  throw new Error(`image file not found: ${candidates.join(' | ')}`)
}


async function resolveVideoPath(inputPath: string, cwd: string): Promise<string> {
  const trimmed = inputPath.trim()
  if (!trimmed) throw new Error('video path is empty')
  if (LATEST_DREAM_VIDEO_ALIASES.has(trimmed.toLowerCase())) {
    const latest = await findLatestDreamVideo()
    if (latest) return latest
    throw new Error('no dream video found in ~/.artemis/dreams')
  }

  const candidates = isAbsolute(trimmed)
    ? [trimmed]
    : uniq([
        resolve(cwd, trimmed),
        resolve(resolveDataRootDir(cwd), trimmed),
        resolve(homedir(), '.artemis', trimmed),
        resolve(process.cwd(), trimmed),
      ])

  const found = candidates.find(candidate => existsSync(candidate))
  if (found) return found
  throw new Error(`video file not found: ${candidates.join(' | ')}`)
}

async function loadWechatStoreCandidates(cwd: string) {
  const { WeChatStore } = await import('../wechat/store.js')
  const cwdStore = new WeChatStore(cwd)
  const candidates = [{ store: cwdStore, data: await cwdStore.load() }]

  // The background gateway daemon commonly runs with cwd=$HOME/.artemis, while
  // native tools run with the active workspace cwd. Try the daemon/global store
  // as a fallback so bridge_send_image can reuse the live WeChat credentials and
  // context tokens without requiring duplicated per-workspace setup.
  const globalCwd = resolve(homedir(), '.artemis')
  if (resolve(cwd) !== globalCwd) {
    const globalStore = new WeChatStore(globalCwd)
    candidates.push({ store: globalStore, data: await globalStore.load() })
  }

  return candidates
}

async function loadTelegramFallback(cwd: string) {
  const globalCwd = resolve(homedir(), '.artemis')
  const candidates = uniq([
    cwd,
    globalCwd,
  ])
  let botToken: string | undefined
  const targets: string[] = []
  try {
    const { TelegramStore } = await import('../telegram/store.js')
    for (const candidate of candidates) {
      const data = await new TelegramStore(candidate).load()
      botToken ??= data.botToken
      targets.push(
        ...(data.allowedChatIds ?? []),
        ...(data.chats ?? []).map(chat => chat.chatId),
      )
    }
    return { botToken, targets: uniq(targets) }
  } catch {
    return { targets: [] as string[] }
  }
}

async function loadDiscordFallbackTargets(cwd: string): Promise<string[]> {
  const globalCwd = resolve(homedir(), '.artemis')
  const candidates = uniq([
    cwd,
    globalCwd,
  ])
  const targets: string[] = []
  try {
    const { DiscordStore } = await import('../discord/store.js')
    for (const candidate of candidates) {
      const data = await new DiscordStore(candidate).load()
      targets.push(...(data.targets ?? []).map(target => target.targetId))
    }
    return uniq(targets)
  } catch {
    return []
  }
}

/**
 * Send a local image as a real mobile attachment through the active Bragi
 * bridges first, then fall back to configured REST clients for Telegram and
 * Discord when their bridges are not currently running.
 *
 * WeChat requires a context_token captured from an inbound message. The live
 * bridge is preferred, with a configured-store fallback for saved targets.
 */
export async function sendBragiImageBroadcast(options: {
  cwd: string
  imagePath: string
  caption?: string
  platform?: BridgeImagePlatform
  targetId?: string
  source?: string
}): Promise<BridgeImageBroadcastResult> {
  const imagePath = await resolveImagePath(options.imagePath, options.cwd)

  const caption = options.caption?.trim() || '🖼 Artemis image'
  const platforms = normalizePlatforms(options.platform)
  const targetId = normalizeOptionalTargetId(options.targetId)
  const registered = listRegisteredBridges().filter(p => platforms.includes(p as BragiPlatformId))
  const live = registered.length > 0
    ? await broadcastToBridges({ text: caption, imagePath, targetId, platforms: registered, source: options.source ?? 'bridge_send_image' })
    : { sent: 0, failed: [] }
  const shouldUseConfiguredFallback = live.sent === 0

  const store = new BragiStore(options.cwd)
  const data = await store.load()
  const globalCwd = resolve(homedir(), '.artemis')
  const globalData = resolve(options.cwd) === globalCwd
    ? undefined
    : await new BragiStore(globalCwd).load().catch(() => undefined)
  const configured: BridgeImageBroadcastResult['configured'] = []
  const skipped: string[] = []

  for (const platform of platforms) {
    if (registered.includes(platform) && !shouldUseConfiguredFallback) continue
    const config = data.platforms[platform] ?? globalData?.platforms[platform]
    if (!config?.enabled && platform !== 'wechat' && platform !== 'telegram') {
      skipped.push(`${platform}: not enabled`)
      continue
    }

    let targets = targetId
      ? [targetId]
      : uniq(config?.allowedTargets ?? [])

    let telegramFallback: Awaited<ReturnType<typeof loadTelegramFallback>> | undefined
    if (platform === 'telegram' && targets.length === 0) {
      telegramFallback = await loadTelegramFallback(options.cwd)
      targets = uniq(telegramFallback.targets)
    }

    if (platform === 'discord' && targets.length === 0) {
      targets = uniq(await loadDiscordFallbackTargets(options.cwd))
    }

    if (platform === 'wechat' && targets.length === 0) {
      try {
        const wechatCandidates = await loadWechatStoreCandidates(options.cwd)
        targets = uniq([
          ...wechatCandidates.flatMap(({ data: wechatData }) => [
            ...Object.keys(wechatData.contextTokens ?? {}),
            ...(wechatData.contacts ?? []).map(c => c.fromUser),
          ]),
        ])
      } catch {
        // Keep the normal no-target error below; detailed credential errors are
        // produced in the WeChat send branch.
      }
    }

    if (targets.length === 0) {
      skipped.push(`${platform}: no allowed targets`)
      continue
    }

    const record = { platform, attempted: targets.length, sent: 0, failed: [] as Array<{ target: string; error: string }> }

    if (platform === 'telegram') {
      telegramFallback ??= await loadTelegramFallback(options.cwd)
      const botToken = config?.credentials.botToken || telegramFallback.botToken
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
      if (!config) {
        record.failed.push(...targets.map(target => ({ target, error: 'discord not configured' })))
        configured.push(record)
        continue
      }
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
      try {
        const { WeChatGatewayClient } = await import('../wechat/client.js')
        const wechatCandidates = await loadWechatStoreCandidates(options.cwd)
        const usable = wechatCandidates.find(({ data: wechatData }) => wechatData.gatewayUrl && wechatData.gatewayToken)
        if (!usable) {
          record.failed.push(...targets.map(target => ({ target, error: 'missing WeChat gatewayUrl/gatewayToken' })))
        } else {
          const { store: wechatStore, data: wechatData } = usable
          const gatewayBaseUrl = wechatData.gatewayUrl
          const gatewayToken = wechatData.gatewayToken
          if (!gatewayBaseUrl || !gatewayToken) {
            record.failed.push(...targets.map(target => ({ target, error: 'missing WeChat gatewayUrl/gatewayToken' })))
            configured.push(record)
            continue
          }
          const client = new WeChatGatewayClient({ gatewayBaseUrl, gatewayToken })
          for (const target of targets) {
            try {
              const contextToken = wechatStore.getContextToken(wechatData, target)
              if (!contextToken) {
                throw new Error('missing WeChat context_token for target; send a fresh WeChat message to Artemis first')
              }
              const sentImage = await client.sendImage(target, imagePath, contextToken)
              if (!sentImage.rendered) {
                throw new Error(`WeChat iLink accepted image payload but mobile rendering is unconfirmed/known invisible for schema=${sentImage.schema}; response=${JSON.stringify(sentImage.response)}`)
              }
              if (options.source === 'dream' && caption.trim()) {
                try {
                  await client.sendText(target, caption, contextToken)
                } catch {
                  // The iLink token window is inconsistent after media sends.
                  // Keep the successfully delivered dream image instead of
                  // retrying and risking duplicate attachments.
                }
              }
              record.sent += 1
            } catch (err) {
              if (isStaleWeChatContextError(err)) {
                await wechatStore.clearContextToken(target)
              }
              record.failed.push({ target, error: err instanceof Error ? err.message : String(err) })
            }
          }
        }
      } catch (err) {
        record.failed.push(...targets.map(target => ({ target, error: err instanceof Error ? err.message : String(err) })))
      }
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


export type BridgeVideoBroadcastResult = Omit<BridgeImageBroadcastResult, 'imagePath'> & { videoPath: string }

export async function sendBragiVideoBroadcast(options: {
  cwd: string
  videoPath: string
  caption?: string
  platform?: BridgeImagePlatform
  targetId?: string
  source?: string
}): Promise<BridgeVideoBroadcastResult> {
  const videoPath = await resolveVideoPath(options.videoPath, options.cwd)
  const caption = options.caption?.trim() || '🎬 Artemis video'
  const platforms = normalizePlatforms(options.platform)
  const targetId = normalizeOptionalTargetId(options.targetId)
  const registered = listRegisteredBridges().filter(p => platforms.includes(p as BragiPlatformId))
  const live = registered.length > 0
    ? await broadcastToBridges({ text: caption, videoPath, targetId, platforms: registered, source: options.source ?? 'bridge_send_video' })
    : { sent: 0, failed: [] }
  // Do not immediately retry the same live bridge through the configured fallback.
  // For WeChat/iLink video this can consume the fresh context_token twice and also
  // hides the real live-bridge failure behind a duplicated failed=2 summary.
  const fallbackPlatforms = platforms.filter(platform => !registered.includes(platform))

  const store = new BragiStore(options.cwd)
  const data = await store.load()
  const globalCwd = resolve(homedir(), '.artemis')
  const globalData = resolve(options.cwd) === globalCwd
    ? undefined
    : await new BragiStore(globalCwd).load().catch(() => undefined)
  const configured: BridgeImageBroadcastResult['configured'] = []
  const skipped: string[] = []

  for (const platform of fallbackPlatforms) {
    const config = data.platforms[platform] ?? globalData?.platforms[platform]
    if (!config?.enabled && platform !== 'wechat' && platform !== 'telegram') {
      skipped.push(`${platform}: not enabled`)
      continue
    }

    let targets = targetId ? [targetId] : uniq(config?.allowedTargets ?? [])
    let telegramFallback: Awaited<ReturnType<typeof loadTelegramFallback>> | undefined
    if (platform === 'telegram' && targets.length === 0) {
      telegramFallback = await loadTelegramFallback(options.cwd)
      targets = uniq(telegramFallback.targets)
    }
    if (platform === 'discord' && targets.length === 0) targets = uniq(await loadDiscordFallbackTargets(options.cwd))
    if (platform === 'wechat' && targets.length === 0) {
      try {
        const wechatCandidates = await loadWechatStoreCandidates(options.cwd)
        targets = uniq(wechatCandidates.flatMap(({ data: wechatData }) => [
          ...Object.keys(wechatData.contextTokens ?? {}),
          ...(wechatData.contacts ?? []).map(c => c.fromUser),
        ]))
      } catch {
        // Keep the normal no-target error below.
      }
    }

    if (targets.length === 0) {
      skipped.push(`${platform}: no allowed targets`)
      continue
    }

    const record = { platform, attempted: targets.length, sent: 0, failed: [] as Array<{ target: string; error: string }> }
    if (platform === 'telegram') {
      telegramFallback ??= await loadTelegramFallback(options.cwd)
      const botToken = config?.credentials.botToken || telegramFallback.botToken
      if (!botToken) record.failed.push(...targets.map(target => ({ target, error: 'missing botToken' })))
      else {
        const { TelegramBotClient } = await import('../telegram/client.js')
        const client = new TelegramBotClient(botToken)
        for (const target of targets) {
          try {
            await client.sendVideo(target, videoPath, caption)
            record.sent += 1
          } catch (err) {
            record.failed.push({ target, error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
    } else if (platform === 'discord') {
      if (!config) record.failed.push(...targets.map(target => ({ target, error: 'discord not configured' })))
      else if (!config.credentials.botToken) record.failed.push(...targets.map(target => ({ target, error: 'missing botToken' })))
      else {
        const { DiscordBotClient } = await import('../discord/client.js')
        const client = new DiscordBotClient(config.credentials.botToken)
        for (const target of targets) {
          try {
            await client.sendAttachment(target, videoPath, caption)
            record.sent += 1
          } catch (err) {
            record.failed.push({ target, error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
    } else if (platform === 'wechat') {
      try {
        const { WeChatGatewayClient } = await import('../wechat/client.js')
        const wechatCandidates = await loadWechatStoreCandidates(options.cwd)
        const usable = wechatCandidates.find(({ data: wechatData }) => wechatData.gatewayUrl && wechatData.gatewayToken)
        if (!usable) record.failed.push(...targets.map(target => ({ target, error: 'missing WeChat gatewayUrl/gatewayToken' })))
        else {
          const { store: wechatStore, data: wechatData } = usable
          const gatewayBaseUrl = wechatData.gatewayUrl
          const gatewayToken = wechatData.gatewayToken
          if (!gatewayBaseUrl || !gatewayToken) record.failed.push(...targets.map(target => ({ target, error: 'missing WeChat gatewayUrl/gatewayToken' })))
          else {
            const client = new WeChatGatewayClient({ gatewayBaseUrl, gatewayToken })
            for (const target of targets) {
              try {
                const contextToken = wechatStore.getContextToken(wechatData, target)
                if (!contextToken) throw new Error('missing WeChat context_token for target; send a fresh WeChat message to Artemis first')
                const signal = AbortSignal.timeout(600_000)
                await client.sendVideo(target, videoPath, contextToken, signal, message => {
                  if (process.env.ARTEMIS_DEBUG_WECHAT_VIDEO === '1') console.error(message)
                })
                record.sent += 1
              } catch (err) {
                if (isStaleWeChatContextError(err)) {
                  await wechatStore.clearContextToken(target)
                }
                record.failed.push({ target, error: err instanceof Error ? err.message : String(err) })
              }
            }
          }
        }
      } catch (err) {
        record.failed.push(...targets.map(target => ({ target, error: err instanceof Error ? err.message : String(err) })))
      }
    } else if (!isConfiguredPlatform(platform)) {
      skipped.push(`${platform}: unsupported platform`)
    }
    configured.push(record)
  }

  return { videoPath, caption, live: { registered, sent: live.sent, failed: live.failed }, configured, skipped }
}

export function formatBridgeVideoBroadcastResult(result: BridgeVideoBroadcastResult): string {
  const lines = [
    `video: ${result.videoPath}`,
    `caption: ${result.caption}`,
    `live bridges: ${result.live.registered.length ? result.live.registered.join(', ') : 'none'}; sent=${result.live.sent}; failed=${result.live.failed.length}`,
  ]
  for (const failure of result.live.failed.slice(0, 5)) lines.push(`  - ${failure.platform}: ${failure.error}`)
  for (const item of result.configured) {
    lines.push(`${item.platform}: attempted=${item.attempted}; sent=${item.sent}; failed=${item.failed.length}`)
    for (const failure of item.failed.slice(0, 5)) lines.push(`  - ${failure.target}: ${failure.error}`)
  }
  for (const skipped of result.skipped) lines.push(`skipped: ${skipped}`)
  return lines.join('\n')
}

export function formatBridgeImageBroadcastResult(result: BridgeImageBroadcastResult): string {
  const lines = [
    `image: ${result.imagePath}`,
    `caption: ${result.caption}`,
    `live bridges: ${result.live.registered.length ? result.live.registered.join(', ') : 'none'}; sent=${result.live.sent}; failed=${result.live.failed.length}`,
  ]
  for (const failure of result.live.failed.slice(0, 5)) {
    lines.push(`  - ${failure.platform}: ${failure.error}`)
  }
  for (const item of result.configured) {
    lines.push(`${item.platform}: attempted=${item.attempted}; sent=${item.sent}; failed=${item.failed.length}`)
    for (const failure of item.failed.slice(0, 5)) {
      lines.push(`  - ${failure.target}: ${failure.error}`)
    }
  }
  for (const skipped of result.skipped) lines.push(`skipped: ${skipped}`)
  return lines.join('\n')
}
