/**
 * Bridge notifier — singleton registry that lets cross-cutting systems
 * (currently the dream system; in the future cron, alerts, ambient agents)
 * push messages to every active IM bridge without knowing about each
 * platform's transport.
 *
 * Each bridge (Telegram/Discord/WeChat) registers a push function on
 * startup and unregisters on shutdown. broadcast() fans the payload out
 * to all registered bridges in parallel; failures are isolated so a dead
 * bridge can't block the others.
 */

export type BridgePlatform = 'telegram' | 'discord' | 'wechat' | 'cli'

export interface BridgePushTarget {
  platform: BridgePlatform
  /** Send a text message to one of the bridge's authorized chat targets. */
  push: (payload: BridgeBroadcastPayload) => Promise<void>
}

export interface BridgeBroadcastPayload {
  /** Plain text body. Bridges may format/truncate per platform. */
  text: string
  /** Optional local image path to attach (PNG/JPG). Bridges that can't
   *  attach images should fall back to a "image saved locally" note. */
  imagePath?: string
  /** Free-form tag for log/debug; bridges may include it in the log line. */
  source: string
}

const targets = new Map<symbol, BridgePushTarget>()

export function registerBridge(target: BridgePushTarget): () => void {
  const key = Symbol(target.platform)
  targets.set(key, target)
  return () => {
    targets.delete(key)
  }
}

export function listRegisteredBridges(): BridgePlatform[] {
  return Array.from(targets.values()).map(t => t.platform)
}

export async function broadcastToBridges(payload: BridgeBroadcastPayload): Promise<{
  sent: number
  failed: Array<{ platform: BridgePlatform; error: string }>
}> {
  const list = Array.from(targets.values())
  if (list.length === 0) return { sent: 0, failed: [] }

  const failed: Array<{ platform: BridgePlatform; error: string }> = []
  let sent = 0

  await Promise.all(
    list.map(async (t) => {
      try {
        await t.push(payload)
        sent += 1
      } catch (err) {
        failed.push({
          platform: t.platform,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }),
  )

  return { sent, failed }
}
