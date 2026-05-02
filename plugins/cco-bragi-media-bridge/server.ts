#!/usr/bin/env node
/**
 * cco-bragi-media-bridge — MCP image sender for Artemis Bragi bridges.
 *
 * Tools:
 *   send_image — send a local image file as a real attachment to Telegram,
 *                Discord, and/or WeChat phone chats.
 *
 * It reuses Artemis' existing Bragi config in ARTEMIS_CWD/.artemis/bragi.json.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const cwd = process.env.ARTEMIS_CWD || process.cwd()

const mcp = new Server(
  { name: 'bragi-media-bridge', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: 'Send local image files to Artemis Bragi mobile bridges as real Telegram/Discord/WeChat attachments. Configure bridge credentials with `artemis bragi telegram setup`, `artemis bragi discord setup`, and `artemis bragi wechat setup` first.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_image',
      description: 'Send a local image file as an actual attachment to configured Telegram, Discord, and/or WeChat chats. WeChat requires the WeChat bridge to be running and the user to have sent a message first.',
      inputSchema: {
        type: 'object',
        properties: {
          imagePath: { type: 'string', description: 'Absolute or cwd-relative local PNG/JPG/GIF/WebP/BMP/SVG path.' },
          caption: { type: 'string', description: 'Optional caption shown with the image.' },
          platform: { type: 'string', enum: ['all', 'telegram', 'discord', 'wechat'], description: 'Target platform. Defaults to all.' },
          targetId: { type: 'string', description: 'Optional platform target id/chat id/channel id. Defaults to allowed targets from Bragi config.' },
        },
        required: ['imagePath'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    if (req.params.name !== 'send_image') {
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }

    const rawPath = typeof args.imagePath === 'string' ? args.imagePath.trim() : ''
    if (!rawPath) throw new Error('imagePath is required')
    const imagePath = resolve(cwd, rawPath)
    if (!existsSync(imagePath)) throw new Error(`image file not found: ${imagePath}`)

    const platform = typeof args.platform === 'string' ? args.platform : 'all'
    if (!['all', 'telegram', 'discord', 'wechat'].includes(platform)) {
      throw new Error('platform must be one of: all, telegram, discord, wechat')
    }

    const { sendBragiImageBroadcast, formatBridgeImageBroadcastResult } = await import('../../src/bragi/imageBroadcast.js')
    const result = await sendBragiImageBroadcast({
      cwd,
      imagePath,
      caption: typeof args.caption === 'string' ? args.caption : undefined,
      platform: platform as 'all' | 'telegram' | 'discord' | 'wechat',
      targetId: typeof args.targetId === 'string' ? args.targetId : undefined,
      source: 'mcp_bragi_media_bridge',
    })

    const sent = result.live.sent + result.configured.reduce((sum, item) => sum + item.sent, 0)
    return {
      content: [{ type: 'text', text: formatBridgeImageBroadcastResult(result) }],
      isError: sent === 0,
    }
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
})

await mcp.connect(new StdioServerTransport())
