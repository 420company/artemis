/**
 * telegram/client.ts — Telegram Bot API client (long-polling)
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveArtemisHomeDir } from '../utils/fs.js'

type TelegramApiResponse<T> = {
  ok: boolean
  result: T
  description?: string
}

export function normalizeTelegramBotToken(input: string): string {
  const compact = input
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
  const match = compact.match(/\d{5,20}:[A-Za-z0-9_-]{20,}/)
  return match?.[0] ?? compact
}

export function isPlausibleTelegramBotToken(input: string): boolean {
  return /^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(normalizeTelegramBotToken(input))
}

function guessMimeType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

function mimeToExtension(mimeType?: string, fallbackName?: string): string {
  const lower = mimeType?.toLowerCase() ?? ''
  if (lower.includes('jpeg')) return '.jpg'
  if (lower.includes('png')) return '.png'
  if (lower.includes('gif')) return '.gif'
  if (lower.includes('webp')) return '.webp'
  if (lower.includes('bmp')) return '.bmp'
  if (lower.includes('svg')) return '.svg'
  if (lower.includes('mp3')) return '.mp3'
  if (lower.includes('wav')) return '.wav'
  if (lower.includes('m4a')) return '.m4a'
  if (lower.includes('aac')) return '.aac'
  if (lower.includes('flac')) return '.flac'
  if (lower.includes('ogg')) return '.ogg'
  if (lower.includes('mp4')) return '.mp4'
  if (lower.includes('quicktime') || lower.includes('mov')) return '.mov'
  if (lower.includes('webm')) return '.webm'
  if (lower.includes('mpeg')) return '.mp3'
  const match = fallbackName?.toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp|svg|mp3|wav|m4a|aac|flac|ogg|mp4|mov|webm)$/)
  return match ? `.${match[1].replace('jpeg', 'jpg')}` : ''
}

async function saveTelegramMediaFile(options: {
  chatId: string
  updateId: number
  label: string
  buffer: ArrayBuffer
  mimeType?: string
  fileName?: string
}): Promise<string> {
  const ext = mimeToExtension(options.mimeType, options.fileName) || path.extname(options.fileName ?? '') || '.bin'
  const dir = path.join(resolveArtemisHomeDir(), 'tmp', 'bridge-attachments', 'telegram', options.chatId)
  await mkdir(dir, { recursive: true })
  const safeLabel = options.label.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'media'
  const fileName = `${options.updateId}-${safeLabel}${ext}`
  const filePath = path.join(dir, fileName)
  await writeFile(filePath, Buffer.from(options.buffer))
  return filePath
}

function formatTelegramApiFailure(options: {
  method: string
  status?: number
  statusText?: string
  description?: string
  body?: string
}): string {
  const details = [options.status, options.statusText, options.description, options.body]
    .filter(Boolean).join(' ')
  const lower = details.toLowerCase()

  if (options.status === 404 || /not found/.test(lower)) {
    return [
      `Telegram API request failed while calling ${options.method}: 404 Not Found.`,
      'Likely issue: the bot token is invalid, incomplete, revoked, or contains extra characters.',
      'Telegram bot tokens come from BotFather and look like "123456789:AA...".',
    ].join('\n')
  }
  if (options.status === 401 || /unauthorized/.test(lower)) {
    return [
      `Telegram API request failed while calling ${options.method}: unauthorized.`,
      'Likely issue: the bot token is invalid or no longer active.',
    ].join('\n')
  }
  if (/chat not found/.test(lower)) {
    return [
      `Telegram API request failed while calling ${options.method}: chat not found.`,
      'Likely issue: the chat ID is wrong, or the user has not started the bot yet.',
    ].join('\n')
  }
  return [
    `Telegram API request failed while calling ${options.method}.`,
    details || 'Unknown Telegram API error.',
  ].join('\n')
}

export function formatTelegramNetworkFailure(method: string, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err))
  const cause = (error as { cause?: unknown }).cause
  const causeMessage = cause instanceof Error ? cause.message : (cause ? String(cause) : '')
  const causeCode = typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code?: unknown }).code ?? '')
    : ''
  const detail = [error.message, causeCode, causeMessage].filter(Boolean).join(' — ')

  return [
    `Telegram API network error while calling ${method}: ${detail || 'fetch failed'}.`,
    'This does not prove the bot token is wrong. Telegram may be unreachable from this network, blocked, or timing out.',
  ].join('\n')
}

export function isTelegramNetworkFailure(err: unknown): boolean {
  const error = err instanceof Error ? err : new Error(String(err))
  const cause = (error as { cause?: unknown }).cause
  const causeCode = typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code?: unknown }).code ?? '')
    : ''
  const text = [error.name, error.message, causeCode, cause instanceof Error ? cause.message : String(cause ?? '')]
    .join(' ')
  return /fetch failed|network|timeout|timed out|connect timeout|econnreset|econnrefused|enotfound|etimedout|und_err_connect_timeout/i.test(text)
}

export type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    text?: string
    caption?: string
    chat: {
      id: number
      type: string
      username?: string
      title?: string
      first_name?: string
      last_name?: string
    }
    from?: {
      id: number
      username?: string
      first_name?: string
      last_name?: string
    }
    photo?: Array<{
      file_id: string
      file_unique_id: string
      file_size: number
      width: number
      height: number
    }>
    audio?: {
      file_id: string
      file_unique_id: string
      file_name?: string
      mime_type?: string
      file_size?: number
      duration?: number
      performer?: string
      title?: string
    }
    video?: {
      file_id: string
      file_unique_id: string
      file_name?: string
      mime_type?: string
      file_size?: number
      duration?: number
      width?: number
      height?: number
    }
    voice?: {
      file_id: string
      file_unique_id: string
      mime_type?: string
      file_size?: number
      duration?: number
    }
    document?: {
      file_id: string
      file_unique_id: string
      file_name?: string
      mime_type?: string
      file_size?: number
    }
  }
}

export type TelegramTextMessage = {
  updateId: number
  chatId: string
  text: string
  chatLabel: string
  images?: import('../providers/types.ts').ImageAttachment[]
}

const TELEGRAM_MESSAGE_LIMIT = 3500

function joinNameParts(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ').trim()
}

function splitMessage(text: string): string[] {
  const normalized = text.trim()
  if (!normalized) return ['(empty reply)']

  const chunks: string[] = []
  let remaining = normalized

  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    const slice = remaining.slice(0, TELEGRAM_MESSAGE_LIMIT)
    const breakIndex = Math.max(
      slice.lastIndexOf('\n\n'),
      slice.lastIndexOf('\n'),
      slice.lastIndexOf('. '),
      slice.lastIndexOf(' '),
    )
    const cutoff = breakIndex > TELEGRAM_MESSAGE_LIMIT * 0.5 ? breakIndex + 1 : TELEGRAM_MESSAGE_LIMIT
    chunks.push(remaining.slice(0, cutoff).trim())
    remaining = remaining.slice(cutoff).trim()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

export class TelegramBotClient {
  private readonly baseUrl: string
  private readonly botToken: string

  constructor(botToken: string) {
    this.botToken = normalizeTelegramBotToken(botToken)
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`
  }

  private async call<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined,
      })
    } catch (err) {
      throw new Error(formatTelegramNetworkFailure(method, err), { cause: err })
    }

    if (!response.ok) {
      const body = await response.text()
      let description: string | undefined
      try {
        const parsed = JSON.parse(body) as TelegramApiResponse<unknown>
        description = parsed.description
      } catch { description = undefined }
      throw new Error(formatTelegramApiFailure({
        method, status: response.status, statusText: response.statusText, description, body,
      }))
    }

    const json = (await response.json()) as TelegramApiResponse<T>
    if (!json.ok) {
      throw new Error(formatTelegramApiFailure({ method, description: json.description }))
    }
    return json.result
  }

  async getMe(): Promise<{ id: number; is_bot: boolean; username?: string; first_name: string }> {
    return this.call('getMe')
  }

  async getUpdates(offset?: number, timeout = 20): Promise<TelegramUpdate[]> {
    return this.call('getUpdates', { offset, timeout, allowed_updates: ['message'] })
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const chunks = splitMessage(text)
    for (const chunk of chunks) {
      await this.call('sendMessage', { chat_id: chatId, text: chunk })
    }
  }

  /**
   * Upload an image file to a chat using sendPhoto. Used by the dream system
   * and the bridge image-broadcast hook so phone users see actual screenshots
   * inline instead of the "🖼 /Users/.../foo.png" text fallback.
   */
  async sendPhoto(chatId: string, imagePath: string, caption?: string): Promise<void> {
    const { readFile } = await import('node:fs/promises')
    const { basename } = await import('node:path')
    const buffer = await readFile(imagePath)
    const form = new FormData()
    form.append('chat_id', chatId)
    if (caption) form.append('caption', caption.slice(0, 1024)) // Telegram caption cap
    form.append('photo', new Blob([new Uint8Array(buffer)], { type: guessMimeType(imagePath) }), basename(imagePath))
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/sendPhoto`, { method: 'POST', body: form })
    } catch (err) {
      throw new Error(formatTelegramNetworkFailure('sendPhoto', err), { cause: err })
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(formatTelegramApiFailure({
        method: 'sendPhoto',
        status: response.status,
        statusText: response.statusText,
        body: body.slice(0, 300),
      }))
    }
    const json = await response.json() as TelegramApiResponse<unknown>
    if (!json.ok) {
      throw new Error(formatTelegramApiFailure({ method: 'sendPhoto', description: json.description }))
    }
  }


  async sendVideo(chatId: string, videoPath: string, caption?: string): Promise<void> {
    const { readFile } = await import('node:fs/promises')
    const { basename } = await import('node:path')
    const buffer = await readFile(videoPath)
    const form = new FormData()
    form.append('chat_id', chatId)
    if (caption) form.append('caption', caption.slice(0, 1024))
    form.append('video', new Blob([new Uint8Array(buffer)], { type: 'video/mp4' }), basename(videoPath))
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/sendVideo`, { method: 'POST', body: form })
    } catch (err) {
      throw new Error(formatTelegramNetworkFailure('sendVideo', err), { cause: err })
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(formatTelegramApiFailure({
        method: 'sendVideo',
        status: response.status,
        statusText: response.statusText,
        body: body.slice(0, 300),
      }))
    }
    const json = await response.json() as TelegramApiResponse<unknown>
    if (!json.ok) {
      throw new Error(formatTelegramApiFailure({ method: 'sendVideo', description: json.description }))
    }
  }

  async getFile(fileId: string): Promise<{ file_path: string }> {
    return this.call('getFile', { file_id: fileId })
  }

  async downloadFile(filePath: string): Promise<ArrayBuffer> {
    let response: Response
    try {
      response = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${filePath}`)
    } catch (err) {
      throw new Error(formatTelegramNetworkFailure('downloadFile', err), { cause: err })
    }
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status} ${response.statusText}`)
    }
    return response.arrayBuffer()
  }
}

export async function extractTelegramTextMessages(client: TelegramBotClient, updates: TelegramUpdate[]): Promise<TelegramTextMessage[]> {
  const messages: TelegramTextMessage[] = []
  
  for (const update of updates) {
    const text = (update.message?.text ?? update.message?.caption)?.trim()
    const chat = update.message?.chat
    if (!chat) continue
    
    const chatLabel = chat.title
      || chat.username
      || joinNameParts([chat.first_name, chat.last_name])
      || String(chat.id)
    
    const images: import('../providers/types.ts').ImageAttachment[] = []
    const mediaPaths: string[] = []
    
    // 处理照片
    if (update.message?.photo && update.message.photo.length > 0) {
      // 选择最大尺寸的照片
      const largestPhoto = update.message.photo.reduce((prev, current) => 
        prev.file_size > current.file_size ? prev : current
      )
      
      try {
        const fileInfo = await client.getFile(largestPhoto.file_id)
        const fileData = await client.downloadFile(fileInfo.file_path)
        const base64Data = Buffer.from(fileData).toString('base64')
        images.push({
          data: base64Data,
          mediaType: 'image/jpeg',
        })
      } catch (error) {
        console.error(`Failed to download photo: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    
    // 处理文档（支持的图片格式）
    if (update.message?.document?.mime_type?.startsWith('image/')) {
      try {
        const fileInfo = await client.getFile(update.message.document.file_id)
        const fileData = await client.downloadFile(fileInfo.file_path)
        const base64Data = Buffer.from(fileData).toString('base64')
        images.push({
          data: base64Data,
          mediaType: update.message.document.mime_type as import('../providers/types.ts').ImageMediaType,
        })
      } catch (error) {
        console.error(`Failed to download document: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const mediaCandidates = [
      { kind: 'audio', item: update.message?.audio },
      { kind: 'video', item: update.message?.video },
      { kind: 'voice', item: update.message?.voice },
      { kind: 'document-audio', item: update.message?.document && update.message.document.mime_type?.startsWith('audio/') ? update.message.document : undefined },
      { kind: 'document-video', item: update.message?.document && update.message.document.mime_type?.startsWith('video/') ? update.message.document : undefined },
    ] as const

    for (const candidate of mediaCandidates) {
      const item = candidate.item
      if (!item) continue
      try {
        const fileInfo = await client.getFile(item.file_id)
        const fileData = await client.downloadFile(fileInfo.file_path)
        const filePath = await saveTelegramMediaFile({
          chatId: String(chat.id),
          updateId: update.update_id,
          label: candidate.kind,
          buffer: fileData,
          mimeType: 'mime_type' in item ? item.mime_type : undefined,
          fileName: 'file_name' in item ? item.file_name : undefined,
        })
        mediaPaths.push(filePath)
      } catch (error) {
        console.error(`Failed to download ${candidate.kind}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    
    // 确保消息至少有文本、图片或音视频附件；附件会以本地路径拼进文本，交给 Saga 继续识别。
    if (text || images.length > 0 || mediaPaths.length > 0) {
      const attachmentHint = mediaPaths.length > 0
        ? mediaPaths.join('\n')
        : ''
      messages.push({
        updateId: update.update_id,
        chatId: String(chat.id),
        text: [
          text || (images.length > 0
            ? '[用户发送了一张图片，请识别并分析图片内容。]'
            : '[用户发送了音频或视频附件，请识别并处理。]'),
          attachmentHint,
        ].filter(Boolean).join('\n'),
        chatLabel,
        images: images.length > 0 ? images : undefined,
      })
    }
  }
  
  return messages
}
