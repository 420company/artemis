/**
 * bragi/outbound.ts — Bragi Broadcast System
 * Given a generic system notification (like audit reports),
 * this module pushes it to any configured and enabled Bragi endpoints.
 */

import { BragiStore } from './store.js'
import { sendBragiImageBroadcast } from './imageBroadcast.js'

export async function sendBragiBroadcast(cwd: string, message: string, imagePath?: string): Promise<void> {
  if (imagePath) {
    await sendBragiImageBroadcast({ cwd, imagePath, caption: message, source: 'bragi_outbound' })
    return
  }

  const store = new BragiStore(cwd)
  const data = await store.load()

  for (const [platformId, config] of Object.entries(data.platforms)) {
    if (!config?.enabled || !config.allowedTargets || config.allowedTargets.length === 0) {
      continue
    }

    try {
      if (platformId === 'discord') {
        const { DiscordBotClient } = await import('../discord/client.js')
        const client = new DiscordBotClient(config.credentials['botToken']!)
        for (const target of config.allowedTargets) {
          // Send block chunks seamlessly!
          await client.sendMessage(target, message)
        }
      }

      if (platformId === 'telegram') {
        const { TelegramBotClient } = await import('../telegram/client.js')
        const client = new TelegramBotClient(config.credentials['botToken']!)
        for (const target of config.allowedTargets) {
          await client.sendMessage(target, message)
        }
      }

      if (platformId === 'wechat') {
        const webhookUrl = config.credentials['webhookUrl']
        if (webhookUrl) {
          for (const _target of config.allowedTargets) {
            // Push via ServerChan / Custom Webhook fallback
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                title: 'Artemis Notification', 
                desp: message,
                text: message // for Bark compatibility
              })
            }).catch(() => {})
          }
        }
      }
    } catch (e) {
      console.error(`Bragi Broadcast Error on [${platformId}]:`, e instanceof Error ? e.message : String(e))
    }
  }
}
