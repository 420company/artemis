/**
 * wechat/client.ts — iLink personal WeChat gateway client
 *
 * Uses the iLink native bot HTTP API:
 *   POST ilink/bot/getupdates   — long-poll for new messages (cursor-based)
 *   POST ilink/bot/sendmessage  — send text reply (requires context_token)
 *
 * Auth: Authorization: Bearer <gatewayToken> + AuthorizationType: ilink_bot_token
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import type { ImageAttachment, ImageMediaType } from '../providers/types.js'

// ─── internal gateway types ───────────────────────────────────────────────────

type WeChatTextItem = {
  text?: string
}

type WeChatMessageItem = {
  type?: number
  text_item?: WeChatTextItem
  image_item?: Record<string, unknown>
  file_item?: Record<string, unknown>
  video_item?: Record<string, unknown>
  voice_item?: { text?: string }
  ref_msg?: {
    title?: string
    message_item?: WeChatMessageItem
  }
}

type WeChatImageItem = {
  aeskey?: string
  media?: {
    full_url?: string
    aes_key?: string
    encrypt_query_param?: string
  }
  mid_size?: number
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
  hd_size?: number
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

type WeChatGetUploadUrlResponse = {
  ret?: number
  errcode?: number
  errmsg?: string
  upload_param?: string
  thumb_upload_param?: string
  upload_full_url?: string
}

type WeChatCdnUploadResponse = {
  status: number
  statusText: string
  ok: boolean
  headers: Headers
  text: () => Promise<string>
}

type WeChatPreparedVideo = {
  path: string
  bytes: Buffer
  md5: string
  durationSeconds: number
  thumbPath: string
  thumbBytes: Buffer
  thumbWidth: number
  thumbHeight: number
  cleanup: () => Promise<void>
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
  images?: ImageAttachment[]
}

export type WeChatMediaDownload = {
  kind: 'image'
  path: string
  bytes: number
  contentType?: string
}

export type WeChatMediaDebugRecord = {
  timestamp: string
  targetId: string
  peerUserId?: string
  messageType?: number
  messageId?: number
  items: unknown
}

// ─── constants ────────────────────────────────────────────────────────────────

const WECHAT_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const WECHAT_DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const WECHAT_DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
const WECHAT_SHORT_HTTP_TIMEOUT_MS = 15_000
const WECHAT_CDN_UPLOAD_TIMEOUT_MS = 90_000
const WECHAT_CDN_UPLOAD_RETRY_DELAY_MS = 1_000
const WECHAT_MESSAGE_LIMIT = 3_800
const WECHAT_SESSION_EXPIRED_ERRCODE = -14
const WECHAT_MESSAGE_TYPE_USER = 1
const WECHAT_MESSAGE_ITEM_TEXT = 1
const WECHAT_MESSAGE_ITEM_IMAGE = 2
const WECHAT_MESSAGE_ITEM_VOICE = 3
const WECHAT_MESSAGE_ITEM_VIDEO = 5
const WECHAT_MESSAGE_ITEM_FILE = 4
const WECHAT_UPLOAD_MEDIA_IMAGE = 1
const WECHAT_UPLOAD_MEDIA_VIDEO = 2
const WECHAT_UPLOAD_MEDIA_FILE = 4
const WECHAT_CDN_UPLOAD_MAX_RETRIES = 3
const WECHAT_IMAGE_SEND_MAX_ATTEMPTS = 3
const WECHAT_SEND_MEDIA_MAX_RETRIES = 3
const WECHAT_SEND_MEDIA_RETRY_DELAY_MS = 500
const WECHAT_OUTBOUND_IMAGE_MAX_DIRECT_BYTES = 600_000
const WECHAT_OUTBOUND_VIDEO_MAX_DIRECT_BYTES = 1_000_000
const WECHAT_OUTBOUND_IMAGE_VARIANTS = [
  { maxDimension: 1280, quality: 80 },
  { maxDimension: 960, quality: 72 },
  { maxDimension: 720, quality: 65 },
] as const
const execFileAsync = promisify(execFile)

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
  const bytes = randomBytes(4)
  const value = (
    (bytes[0] << 24) >>> 0 |
    (bytes[1] << 16) |
    (bytes[2] << 8) |
    bytes[3]
  ) >>> 0
  return Buffer.from(String(value), 'utf8').toString('base64')
}

function isRetMinusTwoError(err: unknown): boolean {
  return err instanceof Error && /ret=-2\b/.test(err.message)
}

function isRetryableWeChatImageSendError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    /WeChat CDN upload/i.test(err.message) ||
    /HTTP 5\d\d\b/.test(err.message) ||
    /timed out|aborted|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i.test(err.message) ||
    isRetMinusTwoError(err)
  )
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    if (signal.aborted) {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }, { once: true })
  })
}

function imageTypeFromBytes(bytes: Buffer): { ext: string; contentType: string } | undefined {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { ext: '.jpg', contentType: 'image/jpeg' }
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: '.png', contentType: 'image/png' }
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: '.webp', contentType: 'image/webp' }
  }
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return { ext: '.gif', contentType: 'image/gif' }
  }
  return undefined
}

function toImageMediaType(contentType: string | undefined, ext: string): ImageMediaType {
  const normalized = contentType?.toLowerCase()
  if (normalized === 'image/png' || ext === '.png') return 'image/png'
  if (normalized === 'image/webp' || ext === '.webp') return 'image/webp'
  if (normalized === 'image/gif' || ext === '.gif') return 'image/gif'
  return 'image/jpeg'
}

function trimTrailingJpegBytes(bytes: Buffer): Buffer {
  let end = -1
  for (let i = bytes.length - 2; i >= 0; i -= 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
      end = i + 2
      break
    }
  }
  return end > 0 ? bytes.subarray(0, end) : bytes
}

function aesEcbPaddedSize(plaintextLength: number): number {
  if (plaintextLength < 0) return 0
  return Math.floor((plaintextLength + 16) / 16) * 16
}

function encryptOutboundMedia(bytes: Buffer, aesKey: Buffer): Buffer {
  if (aesKey.length !== 16) throw new Error(`WeChat CDN AES key must be 16 bytes, got ${aesKey.length}`)
  const cipher = createCipheriv('aes-128-ecb', aesKey, null)
  // Node enables PKCS#7-compatible auto padding for block ciphers by default.
  return Buffer.concat([cipher.update(bytes), cipher.final()])
}

function formatOutboundAesKey(aesKey: Buffer): string {
  // iLink sendMessage expects base64(hex_string), not base64(raw 16 bytes).
  return Buffer.from(aesKey.toString('hex'), 'utf8').toString('base64')
}

async function prepareOutboundWeChatImage(imagePath: string, variant = 0): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const original = await readFile(imagePath)
  const detected = imageTypeFromBytes(original)
  if (variant === 0 && detected?.contentType === 'image/jpeg' && original.length <= WECHAT_OUTBOUND_IMAGE_MAX_DIRECT_BYTES) {
    return { path: imagePath, cleanup: async () => undefined }
  }

  // The iLink CDN endpoint is less tolerant of large PNG/WebP payloads than
  // Telegram/Discord uploads. Normalize outbound images to a bounded JPEG
  // before encryption/upload; this is the format that reliably renders on mobile.
  if (process.platform !== 'darwin') {
    return { path: imagePath, cleanup: async () => undefined }
  }

  const profile = WECHAT_OUTBOUND_IMAGE_VARIANTS[Math.min(variant, WECHAT_OUTBOUND_IMAGE_VARIANTS.length - 1)]
  const out = join(tmpdir(), `artemis-wechat-${Date.now()}-${randomBytes(4).toString('hex')}.jpg`)
  try {
    await execFileAsync(
      '/usr/bin/sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(profile.quality), '-Z', String(profile.maxDimension), imagePath, '--out', out],
      { timeout: 30_000 },
    )
    return { path: out, cleanup: async () => { await unlink(out).catch(() => undefined) } }
  } catch {
    await unlink(out).catch(() => undefined)
    return { path: imagePath, cleanup: async () => undefined }
  }
}

function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  const base = cdnBaseUrl.replace(/\/+$/, '')
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

function buildCdnUploadUrlCandidates(cdnBaseUrl: string, upload: WeChatGetUploadUrlResponse, filekey: string): string[] {
  const candidates = [
    upload.upload_param?.trim()
      ? buildCdnUploadUrl(cdnBaseUrl, upload.upload_param.trim(), filekey)
      : undefined,
    upload.upload_full_url?.trim() || undefined,
  ].filter((url): url is string => Boolean(url))
  return Array.from(new Set(candidates))
}

async function probeVideoDurationSeconds(videoPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/local/bin/ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
      { timeout: 15_000 },
    )
    const seconds = Number.parseFloat(stdout.trim())
    if (Number.isFinite(seconds) && seconds > 0) return Math.max(1, Math.round(seconds))
  } catch {
    // Fall through to a safe default; iLink requires a positive play_length.
  }
  return 1
}

async function probeImageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/local/bin/ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', imagePath],
      { timeout: 15_000 },
    )
    const [rawWidth, rawHeight] = stdout.trim().split('x')
    const width = Number.parseInt(rawWidth ?? '', 10)
    const height = Number.parseInt(rawHeight ?? '', 10)
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return { width, height }
  } catch {
    // Use the same common 16:9 thumbnail size observed in inbound iLink video items.
  }
  return { width: 288, height: 162 }
}

async function prepareOutboundWeChatVideo(videoPath: string): Promise<WeChatPreparedVideo> {
  let preparedVideoPath = videoPath
  const originalBytes = await readFile(videoPath)
  if (originalBytes.length === 0) throw new Error(`WeChat video reply cannot send empty file: ${videoPath}`)

  let optimizedVideoPath: string | undefined
  if (originalBytes.length > WECHAT_OUTBOUND_VIDEO_MAX_DIRECT_BYTES) {
    optimizedVideoPath = join(tmpdir(), `artemis-wechat-video-${Date.now()}-${randomBytes(4).toString('hex')}.mp4`)
    try {
      await execFileAsync(
        '/usr/local/bin/ffmpeg',
        [
          '-y',
          '-i', videoPath,
          '-map', '0:v:0',
          '-map', '0:a?',
          '-vf', 'scale=640:-2',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '32',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '64k',
          '-movflags', '+faststart',
          optimizedVideoPath,
        ],
        { timeout: 120_000 },
      )
      const optimizedStat = await readFile(optimizedVideoPath)
      if (optimizedStat.length > 0 && optimizedStat.length < originalBytes.length) {
        preparedVideoPath = optimizedVideoPath
      }
    } catch {
      await unlink(optimizedVideoPath).catch(() => undefined)
      optimizedVideoPath = undefined
    }
  }

  const bytes = preparedVideoPath === videoPath ? originalBytes : await readFile(preparedVideoPath)
  if (bytes.length === 0) throw new Error(`WeChat video reply cannot send empty file: ${videoPath}`)

  const thumbPath = join(tmpdir(), `artemis-wechat-video-thumb-${Date.now()}-${randomBytes(4).toString('hex')}.jpg`)
  let cleanupNeeded = false
  try {
    await execFileAsync(
      '/usr/local/bin/ffmpeg',
      ['-y', '-i', preparedVideoPath, '-frames:v', '1', '-vf', 'scale=288:-2', '-q:v', '4', thumbPath],
      { timeout: 30_000 },
    )
    cleanupNeeded = true
    const thumbBytes = await readFile(thumbPath)
    const dimensions = await probeImageDimensions(thumbPath)
    return {
      path: preparedVideoPath,
      bytes,
      md5: createHash('md5').update(bytes).digest('hex'),
      durationSeconds: await probeVideoDurationSeconds(preparedVideoPath),
      thumbPath,
      thumbBytes,
      thumbWidth: dimensions.width,
      thumbHeight: dimensions.height,
      cleanup: async () => {
        await unlink(thumbPath).catch(() => undefined)
        if (optimizedVideoPath) await unlink(optimizedVideoPath).catch(() => undefined)
      },
    }
  } catch (err) {
    if (cleanupNeeded) await unlink(thumbPath).catch(() => undefined)
    if (optimizedVideoPath) await unlink(optimizedVideoPath).catch(() => undefined)
    throw new Error(`WeChat video thumbnail generation failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function isWeChatCdnHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return host.endsWith('.weixin.qq.com') || host.endsWith('.wechat.com')
  } catch {
    return false
  }
}

function redactCdnUploadUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    if (url.searchParams.has('encrypted_query_param')) url.searchParams.set('encrypted_query_param', '<redacted>')
    if (url.searchParams.has('filekey')) url.searchParams.set('filekey', '<redacted>')
    return url.toString()
  } catch {
    return '<invalid-url>'
  }
}

async function postCdnBytesDirect(uploadUrl: string, body: Buffer, signal?: AbortSignal): Promise<WeChatCdnUploadResponse> {
  const url = new URL(uploadUrl)
  const request = url.protocol === 'http:' ? httpRequest : httpsRequest

  return await new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
        },
        timeout: WECHAT_CDN_UPLOAD_TIMEOUT_MS,
        agent: false,
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => {
          if (Buffer.isBuffer(chunk)) chunks.push(chunk)
          else chunks.push(Buffer.from(chunk))
        })
        res.on('end', () => {
          const headers = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) headers.set(key, value.join(', '))
            else if (value !== undefined) headers.set(key, String(value))
          }
          const responseText = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode ?? 0
          resolve({
            status,
            statusText: res.statusMessage ?? '',
            ok: status >= 200 && status < 300,
            headers,
            text: async () => responseText,
          })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`WeChat CDN upload timed out after ${WECHAT_CDN_UPLOAD_TIMEOUT_MS}ms`)))
    req.on('error', reject)
    if (signal) {
      if (signal.aborted) {
        req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => {
        req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }, { once: true })
    }
    req.end(body)
  })
}

function decryptInboundImage(bytes: Buffer, image: WeChatImageItem): Buffer {
  const aeskey = image.aeskey?.trim()
  if (!aeskey || !/^[a-f0-9]{32}$/i.test(aeskey)) return bytes

  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(aeskey, 'hex'), null)
  // iLink image CDN payloads are AES-ECB encrypted and are not always padded
  // with PKCS#7. Disable auto padding and trim JPEG EOI below when present.
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([decipher.update(bytes), decipher.final()])
  return imageTypeFromBytes(decrypted)?.ext === '.jpg' ? trimTrailingJpegBytes(decrypted) : decrypted
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

function mediaBodyFromItemList(items: WeChatMessageItem[] | undefined): string | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined
  const kinds: string[] = []
  for (const item of items) {
    if (item.type === WECHAT_MESSAGE_ITEM_IMAGE || item.image_item) kinds.push('图片')
    else if (item.file_item) kinds.push('文件')
    else if (item.video_item) kinds.push('视频')
    else if (item.voice_item) kinds.push('语音')
    else if (item.type !== WECHAT_MESSAGE_ITEM_TEXT) kinds.push(`非文本消息(type=${item.type ?? '?'})`)
  }
  if (kinds.length === 0) return undefined
  return `[微信收到${Array.from(new Set(kinds)).join('/')}消息；正在尝试下载附件内容，并已记录原始 iLink item schema 用于调试。]`
}

function imageItemsFromMessage(message: WeChatGatewayMessage): WeChatImageItem[] {
  const items = message.item_list ?? []
  return items
    .filter(item => item.type === WECHAT_MESSAGE_ITEM_IMAGE || item.image_item)
    .map(item => item.image_item)
    .filter((item): item is WeChatImageItem => Boolean(item) && typeof item === 'object')
}

function redactLargeMediaFields(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]'
  if (typeof value === 'string') {
    if (value.length > 180) return `[string:${value.length}] ${value.slice(0, 80)}...`
    return value
  }
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(v => redactLargeMediaFields(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (lower.includes('base64') || lower === 'data' || lower.includes('buffer')) {
      out[key] = typeof item === 'string' ? `[redacted:${item.length}]` : '[redacted]'
      continue
    }
    out[key] = redactLargeMediaFields(item, depth + 1)
  }
  return out
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
  const text = bodyFromItemList(message.item_list) ?? mediaBodyFromItemList(message.item_list)

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
  private readonly cdnBaseUrl: string

  constructor(opts: {
    gatewayToken: string
    gatewayBaseUrl?: string
    routeTag?: string
    longPollTimeoutMs?: number
    cdnBaseUrl?: string
  }) {
    this.baseUrl = normalizeBaseUrl(opts.gatewayBaseUrl)
    this.gatewayToken = opts.gatewayToken.trim()
    this.routeTag = opts.routeTag?.trim() || undefined
    this.cdnBaseUrl = (opts.cdnBaseUrl?.trim() || WECHAT_DEFAULT_CDN_BASE_URL).replace(/\/+$/, '')
    this.longPollTimeoutMs =
      opts.longPollTimeoutMs && opts.longPollTimeoutMs > 0
        ? opts.longPollTimeoutMs
        : WECHAT_DEFAULT_LONG_POLL_TIMEOUT_MS
  }

  async poll(
    cursor: string | undefined,
    signal?: AbortSignal,
    onDebugMessage?: (message: string) => void,
    onMediaDebugRecord?: (record: WeChatMediaDebugRecord) => Promise<void> | void,
    mediaDownloadDir?: string,
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

    const rawMessages = response.msgs ?? []
    for (const message of rawMessages) {
      const items = message.item_list ?? []
      if (items.some(item => item.type !== WECHAT_MESSAGE_ITEM_TEXT || item.image_item || item.file_item || item.video_item)) {
        const targetId = message.session_id?.trim() || message.from_user_id?.trim() || '?'
        const record: WeChatMediaDebugRecord = {
          timestamp: new Date().toISOString(),
          targetId,
          peerUserId: message.from_user_id?.trim() || undefined,
          messageType: message.message_type,
          messageId: message.message_id,
          items,
        }
        onDebugMessage?.(`[wechat] inbound non-text item schema target=${targetId} message_type=${message.message_type ?? '?'} items=${JSON.stringify(redactLargeMediaFields(items))}`)
        await onMediaDebugRecord?.(record)
      }
    }

    const messages: WeChatTextMessage[] = []
    for (const raw of rawMessages) {
      const message = toWeChatTextMessage(raw)
      if (!message) continue
      const imageItems = imageItemsFromMessage(raw)
      if (imageItems.length > 0 && mediaDownloadDir) {
        const downloads = await this.downloadInboundImages(imageItems, message.messageId, mediaDownloadDir, signal, onDebugMessage)
        if (downloads.length > 0) {
          const paths = downloads.map(d => `${d.path} (${d.bytes} bytes)`).join('\n')
          message.text = `${message.text}\n\n已下载微信图片到本地：\n${paths}`
          message.images = await Promise.all(downloads.map(async d => ({
            data: (await readFile(d.path)).toString('base64'),
            mediaType: toImageMediaType(d.contentType, d.path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '.jpg'),
            label: `WeChat image: ${d.path}`,
          })))
        }
      }
      messages.push(message)
    }

    return {
      messages,
      checkpoint: response.get_updates_buf,
    }
  }

  private async downloadInboundImages(
    images: WeChatImageItem[],
    messageId: string,
    outputDir: string,
    signal?: AbortSignal,
    onDebugMessage?: (message: string) => void,
  ): Promise<WeChatMediaDownload[]> {
    await mkdir(outputDir, { recursive: true })
    const downloads: WeChatMediaDownload[] = []
    for (const [index, image] of images.entries()) {
      const url = image.media?.full_url?.trim()
      if (!url) continue
      try {
        const response = await fetch(url, { signal })
        if (!response.ok) {
          onDebugMessage?.(`[wechat] inbound image download failed status=${response.status} url=${truncate(url, 160)}`)
          continue
        }
        const responseContentType = response.headers.get('content-type') ?? undefined
        const encryptedBytes: Buffer = Buffer.from(await response.arrayBuffer())
        let bytes: Buffer = encryptedBytes
        try {
          bytes = decryptInboundImage(encryptedBytes, image)
        } catch (err) {
          onDebugMessage?.(`[wechat] inbound image decrypt failed, saving raw payload: ${err instanceof Error ? err.message : String(err)}`)
        }
        const detected = imageTypeFromBytes(bytes)
        const contentType = detected?.contentType ?? responseContentType
        const ext = detected?.ext ?? (contentType?.includes('png') ? '.png' : contentType?.includes('webp') ? '.webp' : contentType?.includes('gif') ? '.gif' : '.jpg')
        const filePath = `${outputDir}/wechat-${messageId}-${index + 1}${ext}`
        await writeFile(filePath, bytes)
        downloads.push({ kind: 'image', path: filePath, bytes: bytes.length, contentType })
        onDebugMessage?.(`[wechat] inbound image downloaded path=${filePath} bytes=${bytes.length} contentType=${contentType ?? '?'} encryptedBytes=${encryptedBytes.length}`)
      } catch (err) {
        onDebugMessage?.(`[wechat] inbound image download error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return downloads
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

    const chunks = splitMessage(text)
    for (const [index, chunk] of chunks.entries()) {
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
          `WeChat sendMessage failed: ret=${response.ret ?? '?'} errcode=${response.errcode ?? '?'} errmsg=${truncate(response.errmsg ?? 'unknown', 180)} chunk=${index + 1}/${chunks.length} chars=${chunk.length} raw=${truncate(JSON.stringify(response), 240)}`,
        )
      }
    }
  }

  async sendImage(
    peerUserId: string,
    imagePath: string,
    contextToken: string,
    caption?: string,
    signal?: AbortSignal,
  ): Promise<{ filename: string; bytes: number; response: WeChatSendMessageResponse; rendered: boolean; schema: string }> {
    if (!contextToken.trim()) {
      throw new Error(
        `WeChat image reply needs a context token for ${peerUserId}. The user must send a message first.`,
      )
    }

    // iLink context tokens are tied to a reply turn. Sending a text caption
    // first can consume the token/window, leaving the following image request
    // accepted by the gateway but invisible on the phone. Use the token for
    // the actual attachment; callers that need text should send it separately
    // after a fresh inbound message provides a new context token.
    void caption

    const schema = 'image_item_cdn_media_v1'
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= WECHAT_IMAGE_SEND_MAX_ATTEMPTS; attempt += 1) {
      const prepared = await prepareOutboundWeChatImage(imagePath, attempt - 1)
      try {
        const image = await readFile(prepared.path)
        if (image.length === 0) throw new Error(`WeChat image reply cannot send empty file: ${prepared.path}`)

        const filename = basename(prepared.path)
        const uploaded = await this.uploadMedia(peerUserId, image, WECHAT_UPLOAD_MEDIA_IMAGE, signal)

        const item = {
          type: WECHAT_MESSAGE_ITEM_IMAGE,
          image_item: {
            media: {
              encrypt_query_param: uploaded.encryptedQueryParam,
              aes_key: formatOutboundAesKey(uploaded.aesKey),
              encrypt_type: 1,
            },
            mid_size: uploaded.cipherSize,
          },
        }
        const response = await this.sendSingleMediaItemWithRetry(peerUserId, contextToken, item, 'sendImage', signal)

        return { filename, bytes: image.length, response, rendered: true, schema }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt >= WECHAT_IMAGE_SEND_MAX_ATTEMPTS || !isRetryableWeChatImageSendError(lastError)) {
          throw lastError
        }
        await delay(WECHAT_CDN_UPLOAD_RETRY_DELAY_MS * attempt, signal)
      } finally {
        await prepared.cleanup()
      }
    }
    throw lastError ?? new Error('WeChat image send failed')
  }

  async sendVideo(
    peerUserId: string,
    videoPath: string,
    contextToken: string,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<{ filename: string; bytes: number; response: WeChatSendMessageResponse; schema: string }> {
    if (!contextToken.trim()) {
      throw new Error(
        `WeChat video reply needs a context token for ${peerUserId}. The user must send a message first.`,
      )
    }

    const filename = basename(videoPath)
    onProgress?.(`[wechat] video send stage=prepare_video path=${videoPath}`)
    const prepared = await prepareOutboundWeChatVideo(videoPath)
    onProgress?.(`[wechat] video send stage=prepare_video_done bytes=${prepared.bytes.length} duration=${prepared.durationSeconds}s thumbBytes=${prepared.thumbBytes.length} thumb=${prepared.thumbWidth}x${prepared.thumbHeight}`)
    try {
      const uploaded = await this.uploadVideoWithThumbnail(peerUserId, prepared.bytes, prepared.thumbBytes, signal, onProgress)
      const item = {
        type: WECHAT_MESSAGE_ITEM_VIDEO,
        video_item: {
          media: {
            encrypt_query_param: uploaded.video.encryptedQueryParam,
            aes_key: formatOutboundAesKey(uploaded.aesKey),
            encrypt_type: 1,
          },
          video_size: uploaded.video.cipherSize,
          play_length: prepared.durationSeconds,
          video_md5: prepared.md5,
          thumb_media: {
            encrypt_query_param: uploaded.thumb.encryptedQueryParam,
            aes_key: formatOutboundAesKey(uploaded.aesKey),
            encrypt_type: 1,
          },
          thumb_size: uploaded.thumb.cipherSize,
          thumb_height: prepared.thumbHeight,
          thumb_width: prepared.thumbWidth,
        },
      }
      onProgress?.(`[wechat] video send stage=sendmessage_start schema=video_item_cdn_media_v2 videoCipherBytes=${uploaded.video.cipherSize} thumbCipherBytes=${uploaded.thumb.cipherSize}`)
      const response = await this.sendSingleMediaItemWithRetry(peerUserId, contextToken, item, 'sendVideo', signal)
      onProgress?.(`[wechat] video send stage=sendmessage_done schema=video_item_cdn_media_v2 response=${JSON.stringify(response)}`)
      return { filename, bytes: prepared.bytes.length, response, schema: 'video_item_cdn_media_v2' }
    } finally {
      await prepared.cleanup()
    }
  }

  async sendFile(
    peerUserId: string,
    filePath: string,
    contextToken: string,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<{ filename: string; bytes: number; response: WeChatSendMessageResponse; schema: string }> {
    if (!contextToken.trim()) {
      throw new Error(
        `WeChat file reply needs a context token for ${peerUserId}. The user must send a message first.`,
      )
    }

    const filename = basename(filePath)
    onProgress?.(`[wechat] file send stage=read_file path=${filePath}`)
    const bytes = await readFile(filePath)
    if (bytes.length === 0) throw new Error(`WeChat file reply cannot send empty file: ${filePath}`)
    onProgress?.(`[wechat] file send stage=read_file_done bytes=${bytes.length}`)

    const md5 = createHash('md5').update(bytes).digest('hex')
    const uploaded = await this.uploadMedia(peerUserId, bytes, WECHAT_UPLOAD_MEDIA_FILE, signal, onProgress)
    const item = {
      type: WECHAT_MESSAGE_ITEM_FILE,
      file_item: {
        media: {
          encrypt_query_param: uploaded.encryptedQueryParam,
          aes_key: formatOutboundAesKey(uploaded.aesKey),
          encrypt_type: 1,
        },
        file_name: filename,
        md5,
        len: String(bytes.length),
      },
    }
    onProgress?.(`[wechat] file send stage=sendmessage_start schema=file_item_cdn_media_v1 cipherBytes=${uploaded.cipherSize}`)
    const response = await this.sendSingleMediaItemWithRetry(peerUserId, contextToken, item, 'sendFile', signal)
    onProgress?.(`[wechat] file send stage=sendmessage_done schema=file_item_cdn_media_v1 response=${JSON.stringify(response)}`)
    return { filename, bytes: bytes.length, response, schema: 'file_item_cdn_media_v1' }
  }

  private async uploadVideoWithThumbnail(
    peerUserId: string,
    video: Buffer,
    thumb: Buffer,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<{
    aesKey: Buffer
    video: { encryptedQueryParam: string; cipherSize: number }
    thumb: { encryptedQueryParam: string; cipherSize: number }
  }> {
    const aesKey = randomBytes(16)
    const videoFilekey = randomBytes(16).toString('hex')
    const thumbFilekey = randomBytes(16).toString('hex')
    const videoCipherSize = aesEcbPaddedSize(video.length)
    const thumbCipherSize = aesEcbPaddedSize(thumb.length)
    onProgress?.(`[wechat] media upload stage=get_upload_url_start mediaType=${WECHAT_UPLOAD_MEDIA_VIDEO} rawBytes=${video.length} cipherBytes=${videoCipherSize}`)
    const videoUpload = await this.getUploadUrl({
      filekey: videoFilekey,
      mediaType: WECHAT_UPLOAD_MEDIA_VIDEO,
      toUserId: peerUserId,
      rawSize: video.length,
      rawMd5: createHash('md5').update(video).digest('hex'),
      cipherSize: videoCipherSize,
      aesKeyHex: aesKey.toString('hex'),
      noNeedThumb: true,
      signal,
    })
    onProgress?.(`[wechat] media upload stage=get_upload_url_done mediaType=${WECHAT_UPLOAD_MEDIA_VIDEO} hasFullUrl=${Boolean(videoUpload.upload_full_url?.trim())} hasParam=${Boolean(videoUpload.upload_param?.trim())} hasThumbParam=${Boolean(videoUpload.thumb_upload_param?.trim())}`)

    // iLink no longer returns thumb_upload_param for outbound video uploads on
    // this account. Inbound video items, however, carry an independently
    // uploaded thumb_media using the same AES key. Mirror that shape: request a
    // normal image upload URL for the generated thumbnail, encrypt it with the
    // same AES key, then place its encrypted query param under video_item.thumb_media.
    onProgress?.(`[wechat] media upload stage=get_upload_url_start mediaType=${WECHAT_UPLOAD_MEDIA_IMAGE} rawBytes=${thumb.length} cipherBytes=${thumbCipherSize} role=video_thumb`)
    const thumbUpload = await this.getUploadUrl({
      filekey: thumbFilekey,
      mediaType: WECHAT_UPLOAD_MEDIA_IMAGE,
      toUserId: peerUserId,
      rawSize: thumb.length,
      rawMd5: createHash('md5').update(thumb).digest('hex'),
      cipherSize: thumbCipherSize,
      aesKeyHex: aesKey.toString('hex'),
      noNeedThumb: true,
      signal,
    })
    onProgress?.(`[wechat] media upload stage=get_upload_url_done mediaType=${WECHAT_UPLOAD_MEDIA_IMAGE} role=video_thumb hasFullUrl=${Boolean(thumbUpload.upload_full_url?.trim())} hasParam=${Boolean(thumbUpload.upload_param?.trim())}`)

    const videoUploadUrls = buildCdnUploadUrlCandidates(this.cdnBaseUrl, videoUpload, videoFilekey)
    const thumbUploadUrls = buildCdnUploadUrlCandidates(this.cdnBaseUrl, thumbUpload, thumbFilekey)
    if (videoUploadUrls.length === 0) {
      throw new Error(`WeChat getUploadUrl returned no video upload URL/param: ${truncate(JSON.stringify(videoUpload), 240)}`)
    }
    if (thumbUploadUrls.length === 0) {
      throw new Error(`WeChat getUploadUrl returned no thumbnail upload URL/param: ${truncate(JSON.stringify(thumbUpload), 240)}`)
    }
    onProgress?.(`[wechat] media upload stage=cdn_upload_start mediaType=${WECHAT_UPLOAD_MEDIA_VIDEO} videoUrlCandidates=${videoUploadUrls.length} thumbUrlCandidates=${thumbUploadUrls.length}`)
    const videoEncryptedQueryParam = await this.uploadEncryptedMedia(videoUploadUrls, video, aesKey, WECHAT_UPLOAD_MEDIA_VIDEO, signal, onProgress)
    const thumbEncryptedQueryParam = await this.uploadEncryptedMedia(thumbUploadUrls, thumb, aesKey, WECHAT_UPLOAD_MEDIA_IMAGE, signal, onProgress)
    onProgress?.(`[wechat] media upload stage=cdn_upload_done mediaType=${WECHAT_UPLOAD_MEDIA_VIDEO} withThumb=true`)
    return {
      aesKey,
      video: { encryptedQueryParam: videoEncryptedQueryParam, cipherSize: videoCipherSize },
      thumb: { encryptedQueryParam: thumbEncryptedQueryParam, cipherSize: thumbCipherSize },
    }
  }

  private async uploadMedia(
    peerUserId: string,
    bytes: Buffer,
    mediaType: number,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<{ aesKey: Buffer; encryptedQueryParam: string; cipherSize: number }> {
    const aesKey = randomBytes(16)
    const filekey = randomBytes(16).toString('hex')
    const cipherSize = aesEcbPaddedSize(bytes.length)
    onProgress?.(`[wechat] media upload stage=get_upload_url_start mediaType=${mediaType} rawBytes=${bytes.length} cipherBytes=${cipherSize}`)
    const upload = await this.getUploadUrl({
      filekey,
      mediaType,
      toUserId: peerUserId,
      rawSize: bytes.length,
      rawMd5: createHash('md5').update(bytes).digest('hex'),
      cipherSize,
      aesKeyHex: aesKey.toString('hex'),
      noNeedThumb: true,
      signal,
    })
    onProgress?.(`[wechat] media upload stage=get_upload_url_done mediaType=${mediaType} hasFullUrl=${Boolean(upload.upload_full_url?.trim())} hasParam=${Boolean(upload.upload_param?.trim())}`)
    const uploadUrls = buildCdnUploadUrlCandidates(this.cdnBaseUrl, upload, filekey)
    if (uploadUrls.length === 0) {
      throw new Error(`WeChat getUploadUrl returned no upload URL/param: ${truncate(JSON.stringify(upload), 240)}`)
    }
    onProgress?.(`[wechat] media upload stage=cdn_upload_start mediaType=${mediaType} urlCandidates=${uploadUrls.length}`)
    const encryptedQueryParam = await this.uploadEncryptedMedia(uploadUrls, bytes, aesKey, mediaType, signal, onProgress)
    onProgress?.(`[wechat] media upload stage=cdn_upload_done mediaType=${mediaType}`)
    return { aesKey, encryptedQueryParam, cipherSize }
  }

  private async sendSingleMediaItemWithRetry(
    peerUserId: string,
    contextToken: string,
    item: Record<string, unknown>,
    label: string,
    signal?: AbortSignal,
  ): Promise<WeChatSendMessageResponse> {
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= WECHAT_SEND_MEDIA_MAX_RETRIES; attempt += 1) {
      try {
        const response = await this.post<WeChatSendMessageResponse>(
          'ilink/bot/sendmessage',
          {
            msg: {
              from_user_id: '',
              to_user_id: peerUserId,
              client_id: `cc-${randomBytes(4).toString('hex')}`,
              message_type: 2,
              message_state: 2,
              context_token: contextToken,
              item_list: [item],
            },
            base_info: { channel_version: 'artemis-bragi-wechat/1.0' },
          },
          WECHAT_SHORT_HTTP_TIMEOUT_MS,
          label,
          signal,
        )

        if ((response.ret ?? 0) === 0) return response
        throw new Error(
          `WeChat ${label} failed: ret=${response.ret ?? '?'} errcode=${response.errcode ?? '?'} errmsg=${truncate(response.errmsg ?? 'unknown', 180)} raw=${truncate(JSON.stringify(response), 240)}`,
        )
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (!isRetMinusTwoError(lastError) || attempt >= WECHAT_SEND_MEDIA_MAX_RETRIES) break
        await delay(WECHAT_SEND_MEDIA_RETRY_DELAY_MS, signal)
      }
    }
    throw lastError ?? new Error(`WeChat ${label} failed`)
  }

  private async getUploadUrl(opts: {
    filekey: string
    mediaType: number
    toUserId: string
    rawSize: number
    rawMd5: string
    cipherSize: number
    aesKeyHex: string
    noNeedThumb?: boolean
    signal?: AbortSignal
  }): Promise<WeChatGetUploadUrlResponse> {
    const response = await this.post<WeChatGetUploadUrlResponse>(
      'ilink/bot/getuploadurl',
      {
        filekey: opts.filekey,
        media_type: opts.mediaType,
        to_user_id: opts.toUserId,
        rawsize: opts.rawSize,
        rawfilemd5: opts.rawMd5,
        filesize: opts.cipherSize,
        ...(opts.noNeedThumb ? { no_need_thumb: true } : {}),
        aeskey: opts.aesKeyHex,
        base_info: { channel_version: 'artemis-bragi-wechat/1.0' },
      },
      WECHAT_SHORT_HTTP_TIMEOUT_MS,
      'getUploadUrl',
      opts.signal,
    )

    if ((response.ret ?? 0) !== 0) {
      throw new Error(
        `WeChat getUploadUrl failed: ret=${response.ret ?? '?'} errcode=${response.errcode ?? '?'} errmsg=${truncate(response.errmsg ?? 'unknown', 180)} raw=${truncate(JSON.stringify(response), 240)}`,
      )
    }
    if (!response.upload_full_url?.trim() && !response.upload_param?.trim()) {
      throw new Error(`WeChat getUploadUrl returned no upload URL/param: ${truncate(JSON.stringify(response), 240)}`)
    }
    return response
  }

  private async uploadEncryptedMedia(
    uploadUrls: string[],
    plaintext: Buffer,
    aesKey: Buffer,
    mediaType: number,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<string> {
    const ciphertext = encryptOutboundMedia(plaintext, aesKey)
    onProgress?.(`[wechat] CDN upload stage=encrypt_done mediaType=${mediaType} plaintextBytes=${plaintext.length} ciphertextBytes=${ciphertext.length}`)
    let lastError: Error | undefined
    for (const [urlIndex, uploadUrl] of uploadUrls.entries()) {
      for (let attempt = 1; attempt <= WECHAT_CDN_UPLOAD_MAX_RETRIES; attempt += 1) {
        try {
          onProgress?.(`[wechat] CDN upload stage=attempt_start mediaType=${mediaType} url=${urlIndex + 1}/${uploadUrls.length} attempt=${attempt}/${WECHAT_CDN_UPLOAD_MAX_RETRIES} host=${new URL(uploadUrl).host}`)
          // New iLink upload_full_url points at WeChat CDN directly. Match
          // cc-connect and bypass undici/fetch for those hosts: direct node:http
          // has proven more reliable for multi-megabyte encrypted video payloads.
          const response: WeChatCdnUploadResponse = isWeChatCdnHost(uploadUrl)
            ? await postCdnBytesDirect(uploadUrl, ciphertext, signal)
            : await fetch(uploadUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: new Uint8Array(ciphertext),
              signal: signal
                ? AbortSignal.any([AbortSignal.timeout(WECHAT_CDN_UPLOAD_TIMEOUT_MS), signal])
                : AbortSignal.timeout(WECHAT_CDN_UPLOAD_TIMEOUT_MS),
            })
          const encryptedParam = response.headers.get('x-encrypted-param')?.trim()
          if (response.status >= 400 && response.status < 500) {
            const errorMessage = response.headers.get('x-error-message') || await response.text().catch(() => response.statusText)
            throw new Error(`WeChat CDN upload client error HTTP ${response.status}: ${truncate(errorMessage || response.statusText, 180)}`)
          }
          if (!response.ok) {
            const errorMessage = response.headers.get('x-error-message') || await response.text().catch(() => response.statusText)
            const diagnosticHeaders = ['x-error-code', 'x-error-message', 'x-encrypted-param', 'server', 'date']
              .map(name => `${name}=${response.headers.get(name) ?? ''}`)
              .join('; ')
            lastError = new Error(`WeChat CDN upload server error HTTP ${response.status} mediaType=${mediaType} url=${redactCdnUploadUrl(uploadUrl)} headers=[${diagnosticHeaders}] body=${truncate(errorMessage || response.statusText, 300)}`)
            continue
          }
          if (!encryptedParam) {
            lastError = new Error('WeChat CDN upload response missing x-encrypted-param')
            onProgress?.(`[wechat] CDN upload stage=attempt_failed mediaType=${mediaType} reason=${lastError.message}`)
            continue
          }
          onProgress?.(`[wechat] CDN upload stage=attempt_done mediaType=${mediaType} url=${urlIndex + 1}/${uploadUrls.length} attempt=${attempt}`)
          return encryptedParam
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          onProgress?.(`[wechat] CDN upload stage=attempt_failed mediaType=${mediaType} url=${urlIndex + 1}/${uploadUrls.length} attempt=${attempt} error=${lastError.message}`)
        }
        if (attempt < WECHAT_CDN_UPLOAD_MAX_RETRIES) {
          await delay(WECHAT_CDN_UPLOAD_RETRY_DELAY_MS * attempt, signal)
        }
      }
    }
    throw new Error(`WeChat CDN upload failed after ${uploadUrls.length * WECHAT_CDN_UPLOAD_MAX_RETRIES} attempts across ${uploadUrls.length} URL(s): ${lastError?.message ?? 'unknown error'}`)
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
