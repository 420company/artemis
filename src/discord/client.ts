/**
 * discord/client.ts — Discord Bot API client + WebSocket gateway bridge
 *
 * Uses Discord Gateway v10 with long-polling pattern via drainTextMessages().
 */

type DiscordApiFailureOptions = {
  path: string; status?: number; statusText?: string; body?: string
}

function formatDiscordApiFailure(options: DiscordApiFailureOptions): string {
  const details = [options.status, options.statusText, options.body].filter(Boolean).join(' ')
  const lower = details.toLowerCase()
  if (options.status === 401 || /unauthorized|invalid token/.test(lower)) {
    return [
      `Discord API request failed while calling ${options.path}: unauthorized.`,
      'Likely issue: the Discord bot token is invalid, incomplete, or revoked.',
    ].join('\n')
  }
  if (options.status === 403 || /missing access/.test(lower)) {
    return [
      `Discord API request failed while calling ${options.path}: missing access.`,
      'Likely issue: bot not in target server/channel, or missing permissions.',
    ].join('\n')
  }
  return [`Discord API request failed while calling ${options.path}.`, details || 'Unknown Discord API error.'].join('\n')
}

export type DiscordGatewayInfo = { url: string }
export type DiscordCurrentUser = { id: string; username: string; global_name?: string | null; bot?: boolean }

type DiscordGatewayPacket = { op: number; d?: unknown; s?: number | null; t?: string }
type DiscordGatewayReadyPayload = { user?: DiscordCurrentUser }
type DiscordGatewayMessageAuthor = { id: string; username?: string; global_name?: string | null; bot?: boolean }
type DiscordGatewayMessagePayload = {
  id: string; channel_id: string; guild_id?: string; content?: string
  author?: DiscordGatewayMessageAuthor
}

export type DiscordTextMessage = {
  messageId: string; targetId: string; targetLabel: string; text: string
  authorId: string; authorLabel: string; guildId?: string
}

const DISCORD_API_BASE = 'https://discord.com/api/v10'
const DISCORD_MESSAGE_LIMIT = 1900
// Guilds (servers) intent | Guild messages | DMs | DM typing
const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

function splitMessage(text: string): string[] {
  const normalized = text.trim()
  if (!normalized) return ['(empty reply)']
  const chunks: string[] = []
  let remaining = normalized
  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    const slice = remaining.slice(0, DISCORD_MESSAGE_LIMIT)
    const breakIndex = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf('. '), slice.lastIndexOf(' '))
    const cutoff = breakIndex > DISCORD_MESSAGE_LIMIT * 0.5 ? breakIndex + 1 : DISCORD_MESSAGE_LIMIT
    chunks.push(remaining.slice(0, cutoff).trim())
    remaining = remaining.slice(cutoff).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function packetToString(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) {
    const v = data as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8')
  }
  return String(data)
}

function deriveAuthorLabel(author: DiscordGatewayMessageAuthor | undefined): string {
  return author?.global_name ?? author?.username ?? author?.id ?? 'unknown'
}

function toDiscordTextMessage(payload: DiscordGatewayMessagePayload): DiscordTextMessage | undefined {
  const text = payload.content?.trim()
  const authorId = payload.author?.id
  if (!text || !authorId) return undefined
  return {
    messageId: payload.id,
    targetId: payload.channel_id,
    targetLabel: payload.guild_id ? `channel:${payload.channel_id}` : `dm:${payload.channel_id}`,
    text, authorId,
    authorLabel: deriveAuthorLabel(payload.author),
    guildId: payload.guild_id,
  }
}

export class DiscordBotClient {
  private readonly token: string

  constructor(botToken: string) { this.token = botToken }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${DISCORD_API_BASE}${path}`, {
      ...init,
      headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json', ...init?.headers },
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(formatDiscordApiFailure({ path, status: response.status, statusText: response.statusText, body }))
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  async getCurrentUser(): Promise<DiscordCurrentUser> { return this.call('/users/@me') }
  async getGatewayBot(): Promise<DiscordGatewayInfo> { return this.call('/gateway/bot') }

  async sendMessage(channelId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await this.call(`/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: chunk, allowed_mentions: { parse: [] } }),
      })
    }
  }
}

export class DiscordGatewayBridge {
  private readonly client: DiscordBotClient
  private readonly token: string
  private readonly queue: DiscordTextMessage[] = []
  private readonly waiters = new Set<() => void>()
  private started = false
  private stopped = false
  private loopPromise?: Promise<void>
  private socket?: WebSocket
  private lastSequence?: number
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private botUserId?: string

  constructor(botToken: string) {
    this.token = botToken
    this.client = new DiscordBotClient(botToken)
  }

  async getCurrentUser(): Promise<DiscordCurrentUser> { return this.client.getCurrentUser() }
  async sendMessage(channelId: string, text: string): Promise<void> { await this.client.sendMessage(channelId, text) }

  async start(options?: { signal?: AbortSignal; onInfo?: (msg: string) => void }): Promise<void> {
    if (this.started) return
    this.started = true
    this.loopPromise = this.runLoop(options?.signal, options?.onInfo)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearHeartbeat()
    this.socket?.close(1000, 'shutdown')
    this.flushWaiters()
    await this.loopPromise
  }

  async drainTextMessages(timeoutMs = 1_500): Promise<DiscordTextMessage[]> {
    if (this.queue.length > 0) return this.queue.splice(0)
    if (this.stopped) return []
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.waiters.delete(resolver); resolve() }, timeoutMs)
      const resolver = () => { clearTimeout(timer); this.waiters.delete(resolver); resolve() }
      this.waiters.add(resolver)
    })
    return this.queue.splice(0)
  }

  private enqueue(message: DiscordTextMessage): void {
    this.queue.push(message)
    this.flushWaiters()
  }

  private flushWaiters(): void {
    for (const w of this.waiters) w()
    this.waiters.clear()
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined }
  }

  private async runLoop(signal: AbortSignal | undefined, onInfo: ((msg: string) => void) | undefined): Promise<void> {
    while (!this.stopped && !signal?.aborted) {
      try { await this.connectOnce(signal, onInfo) }
      catch (err: unknown) {
        if (this.stopped || signal?.aborted) break
        onInfo?.(`[discord] ${err instanceof Error ? err.message : String(err)}`)
        await sleep(2_000)
      }
    }
  }

  private async connectOnce(signal: AbortSignal | undefined, onInfo: ((msg: string) => void) | undefined): Promise<void> {
    const gateway = await this.client.getGatewayBot()
    const url = `${gateway.url}?v=10&encoding=json`

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const socket = new WebSocket(url)
      this.socket = socket

      const cleanup = () => {
        if (this.socket === socket) this.socket = undefined
        this.clearHeartbeat()
        signal?.removeEventListener('abort', onAbort)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('close', onClose)
        socket.removeEventListener('error', onError)
      }
      const settle = (cb: () => void) => { if (settled) return; settled = true; cleanup(); cb() }
      const sendPacket = (p: DiscordGatewayPacket) => socket.send(JSON.stringify(p))
      const sendHeartbeat = () => { if (socket.readyState === WebSocket.OPEN) sendPacket({ op: 1, d: this.lastSequence ?? null }) }

      // WebSocket close codes: per RFC 6455, clients may only send 1000 or
      // 3000-4999. Codes 1001-1015 are reserved for protocol/server use; sending
      // 1012 from a client crashes Node's undici with InvalidAccessError. Wrap
      // every close() in a guard so a transient socket-state issue can't take
      // down the whole CLI.
      const safeClose = (code: number, reason: string): void => {
        try { socket.close(code, reason) }
        catch (err) { onInfo?.(`[discord] socket.close(${code}) ignored: ${err instanceof Error ? err.message : String(err)}`) }
      }
      const onAbort = () => { this.stopped = true; safeClose(1000, 'aborted') }
      const onOpen = () => onInfo?.('[discord] gateway socket opened')

      const onMessage = (event: MessageEvent) => {
        let packet: DiscordGatewayPacket
        try { packet = JSON.parse(packetToString(event.data)) as DiscordGatewayPacket }
        catch { return }

        if (typeof packet.s === 'number') this.lastSequence = packet.s

        if (packet.op === 10) {
          const hbInterval = (packet.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval
          if (typeof hbInterval !== 'number' || hbInterval <= 0) {
            settle(() => reject(new Error('Discord gateway did not provide heartbeat interval.')))
            return
          }
          this.clearHeartbeat()
          this.heartbeatTimer = setInterval(sendHeartbeat, hbInterval)
          sendPacket({ op: 2, d: { token: this.token, intents: DISCORD_GATEWAY_INTENTS, properties: { os: process.platform, browser: 'artemis', device: 'artemis' } } })
          return
        }
        if (packet.op === 1) { sendHeartbeat(); return }
        if (packet.op === 7) { safeClose(1000, 'reconnect'); return }
        if (packet.op === 9) { settle(() => reject(new Error('Discord gateway rejected session.'))); return }
        if (packet.op !== 0) return

        if (packet.t === 'READY') {
          const ready = packet.d as DiscordGatewayReadyPayload | undefined
          this.botUserId = ready?.user?.id
          onInfo?.(`[discord] bot connected as ${ready?.user?.username ?? 'unknown'}`)
          return
        }
        if (packet.t === 'MESSAGE_CREATE') {
          const msg = toDiscordTextMessage(packet.d as DiscordGatewayMessagePayload)
          if (!msg || msg.authorId === this.botUserId) return
          this.enqueue(msg)
        }
      }

      const onClose = (event: CloseEvent) => {
        const code = typeof event.code === 'number' ? event.code : 0
        if (this.stopped || signal?.aborted || code === 1000) { settle(resolve); return }
        settle(() => reject(new Error(`Discord gateway closed (code ${code}${event.reason ? `: ${event.reason}` : ''}).`)))
      }
      const onError = () => {
        if (this.stopped || signal?.aborted) { settle(resolve); return }
        settle(() => reject(new Error('Discord gateway socket failed.')))
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      socket.addEventListener('open', onOpen)
      socket.addEventListener('message', onMessage)
      socket.addEventListener('close', onClose)
      socket.addEventListener('error', onError)
    })
  }
}
