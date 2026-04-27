/**
 * wechat/client.ts — iLink personal WeChat gateway client
 *
 * Uses the iLink native bot HTTP API:
 *   POST ilink/bot/getupdates   — long-poll for new messages (cursor-based)
 *   POST ilink/bot/sendmessage  — send text reply (requires context_token)
 *
 * Auth: Authorization: Bearer <gatewayToken> + AuthorizationType: ilink_bot_token
 */

import { randomBytes } from 'node:crypto'

// ─── internal gateway types ───────────────────────────────────────────────────

type WeChatTextItem = {
  text?: string
}

type WeChatMessageItem = {
  type?: number
  text_item?: WeChatTextItem
  voice_item?: { text?: string }
  ref_msg?: {
    title?: string
    message_item?: WeChatMessageItem
  }
}

type WeChatGatewayMessage = {
  seq?: number
  message_id?: number
  from_user_id?: string
  session_id?: string
  create_time_ms?: number
  message_type?: number
  item_list?: WeChatMessageItem[]
  context_token?: string
}

type WeChatGetUpdatesResponse = {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeChatGatewayMessage[]
  get_updates_buf?: string
}

type WeChatSendMessageResponse = {
  ret?: number
  errcode?: number
  errmsg?: string
}

// ─── public types ─────────────────────────────────────────────────────────────

export type WeChatTextMessage = {
  targetId: string
  targetLabel: string
  peerUserId: string
  sessionScope: string
  text: string
  contextToken?: string
  messageId: string
}

// ─── constants ────────────────────────────────────────────────────────────────

const WECHAT_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const WECHAT_DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
const WECHAT_SHORT_HTTP_TIMEOUT_MS = 15_000
const WECHAT_MESSAGE_LIMIT = 3_800
const WECHAT_SESSION_EXPIRED_ERRCODE = -14
const WECHAT_MESSAGE_TYPE_USER = 1
const WECHAT_MESSAGE_ITEM_TEXT = 1
const WECHAT_MESSAGE_ITEM_VOICE = 3

// ─── helpers ──────────────────────────────────────────────────────────────────

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}...`
}

function splitMessage(text: string): string[] {
  const normalized = text.trim()
  if (!normalized) return ['(empty reply)']
  const chunks: string[] = []
  let remaining = normalized
  while (remaining.length > WECHAT_MESSAGE_LIMIT) {
    chunks.push(remaining.slice(0, WECHAT_MESSAGE_LIMIT))
    remaining = remaining.slice(WECHAT_MESSAGE_LIMIT)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function randomClientId(): string {
  return `artemis-wx-${randomBytes(6).toString('hex')}`
}

function randomMessageId(): string {
  return randomBytes(8).toString('hex')
}

function randomWeChatUin(): string {
  return Buffer.from(randomBytes(4)).toString('base64')
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim()
  return `${(trimmed || WECHAT_DEFAULT_BASE_URL).replace(/\/+$/, '')}/`
}

function bodyFromItemList(items: WeChatMessageItem[] | undefined): string | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined
  for (const item of items) {
    if (item.type === WECHAT_MESSAGE_ITEM_TEXT) {
      const text = item.text_item?.text?.trim()
      if (!text) continue
      const ref = item.ref_msg
      if (!ref) return text
      const parts: string[] = []
      if (ref.title?.trim()) parts.push(ref.title.trim())
      const refBody = bodyFromItemList(ref.message_item ? [ref.message_item] : [])
      if (refBody) parts.push(refBody)
      return parts.length > 0 ? `[Quoted: ${parts.join(' | ')}]\n${text}` : text
    }
    if (item.type === WECHAT_MESSAGE_ITEM_VOICE) {
      const text = item.voice_item?.text?.trim()
      if (text) return text
    }
  }
  return undefined
}

function toWeChatTextMessage(message: WeChatGatewayMessage): WeChatTextMessage | undefined {
  if (
    message.message_type !== undefined &&
    message.message_type !== 0 &&
    message.message_type !== WECHAT_MESSAGE_TYPE_USER
  ) {
    return undefined
  }

  const peerUserId = message.from_user_id?.trim()
  const sessionScope = message.session_id?.trim() || peerUserId
  const text = bodyFromItemList(message.item_list)

  if (!peerUserId || !sessionScope || !text) return undefined

  return {
    targetId:   sessionScope,
    targetLabel: sessionScope === peerUserId ? peerUserId : `${peerUserId} · session:${sessionScope}`,
    peerUserId,
    sessionScope,
    text,
    contextToken: message.context_token?.trim() || undefined,
    messageId:
      typeof message.message_id === 'number' && Number.isFinite(message.message_id)
        ? String(message.message_id)
        : randomMessageId(),
  }
}

// ─── WeChatGatewayClient ──────────────────────────────────────────────────────

export class WeChatGatewayClient {
  private readonly baseUrl: string
  private readonly gatewayToken: string
  private readonly routeTag?: string
  private readonly longPollTimeoutMs: number

  constructor(opts: {
    gatewayToken: string
    gatewayBaseUrl?: string
    routeTag?: string
    longPollTimeoutMs?: number
  }) {
    this.baseUrl = normalizeBaseUrl(opts.gatewayBaseUrl)
    this.gatewayToken = opts.gatewayToken.trim()
    this.routeTag = opts.routeTag?.trim() || undefined
    this.longPollTimeoutMs =
      opts.longPollTimeoutMs && opts.longPollTimeoutMs > 0
        ? opts.longPollTimeoutMs
        : WECHAT_DEFAULT_LONG_POLL_TIMEOUT_MS
  }

  async poll(
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ messages: WeChatTextMessage[]; checkpoint?: string }> {
    const response = await this.post<WeChatGetUpdatesResponse>(
      'ilink/bot/getupdates',
      {
        get_updates_buf: cursor ?? '',
        base_info: { channel_version: 'artemis-bragi-wechat/1.0' },
      },
      this.longPollTimeoutMs + 5_000,
      'getUpdates',
      signal,
    )

    if (response.errcode === WECHAT_SESSION_EXPIRED_ERRCODE) {
      throw new Error(
        'WeChat gateway session expired. Re-run `artemis bragi wechat setup` to re-login with a fresh QR code.',
      )
    }

    if ((response.ret ?? 0) !== 0) {
      throw new Error(
        `WeChat getUpdates failed: ret=${response.ret ?? '?'} errcode=${response.errcode ?? '?'} errmsg=${truncate(response.errmsg ?? 'unknown', 180)}`,
      )
    }

    return {
      messages: (response.msgs ?? [])
        .map(m => toWeChatTextMessage(m))
        .filter((m): m is WeChatTextMessage => Boolean(m)),
      checkpoint: response.get_updates_buf,
    }
  }

  async sendText(
    peerUserId: string,
    text: string,
    contextToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!contextToken.trim()) {
      throw new Error(
        `WeChat reply needs a context token for ${peerUserId}. The user must send a message first.`,
      )
    }

    for (const chunk of splitMessage(text)) {
      const response = await this.post<WeChatSendMessageResponse>(
        'ilink/bot/sendmessage',
        {
          msg: {
            from_user_id: '',
            to_user_id: peerUserId,
            client_id: randomClientId(),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [{ type: WECHAT_MESSAGE_ITEM_TEXT, text_item: { text: chunk } }],
          },
          base_info: { channel_version: 'artemis-bragi-wechat/1.0' },
        },
        WECHAT_SHORT_HTTP_TIMEOUT_MS,
        'sendMessage',
        signal,
      )

      if ((response.ret ?? 0) !== 0) {
        throw new Error(
          `WeChat sendMessage failed: ret=${response.ret ?? '?'} errcode=${response.errcode ?? '?'} errmsg=${truncate(response.errmsg ?? 'unknown', 180)}`,
        )
      }
    }
  }

  private async post<T>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(new URL(endpoint, this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${this.gatewayToken}`,
        'X-WECHAT-UIN': randomWeChatUin(),
        ...(this.routeTag ? { SKRouteTag: this.routeTag } : {}),
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
        : AbortSignal.timeout(timeoutMs),
    })

    const raw = await response.text()
    if (!response.ok) {
      throw new Error(
        `WeChat ${label} HTTP ${response.status}: ${truncate(raw || response.statusText, 240)}`,
      )
    }
    if (!raw.trim()) return {} as T
    try {
      return JSON.parse(raw) as T
    } catch (err) {
      throw new Error(
        `WeChat ${label} invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
