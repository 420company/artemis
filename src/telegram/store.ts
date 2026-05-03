/**
 * telegram/store.ts — per-chat state for the Telegram bridge
 *
 * Stores: bot token, poll offset, allowed chat IDs, per-chat session mapping.
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PermissionMode } from '../cli/parseArgs.js'
import {
  TELEGRAM_ACCOUNT_PREFIX,
  TELEGRAM_SENSITIVE_FIELDS,
} from '../security/bragiSecrets.js'
import type { SecretStore } from '../security/secretStore.js'
import { ensureDir, pathExists, resolveDataRootDir } from '../utils/fs.js'

export type TelegramChatState = {
  chatId: string
  sessionId: string
  permissionMode: PermissionMode
  updatedAt: string
}

export type TelegramStoreData = {
  botToken?: string
  pollOffset?: number
  autoStartOnLaunch?: boolean
  allowedChatIds: string[]
  chats: TelegramChatState[]
}

function now(): string { return new Date().toISOString() }
function getEmptyStore(): TelegramStoreData { return { allowedChatIds: [], chats: [] } }

function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'PRODUCER' || v === 'GHOSTWRITER' || v === 'WRITER' ||
    v === 'prompt' || v === 'read-only' || v === 'accept-edits' || v === 'accept-all'
}

export class TelegramStore {
  private readonly rootDir: string
  private readonly filePath: string
  private readonly secretStore: SecretStore | undefined

  constructor(cwd: string, secretStore?: SecretStore) {
    this.rootDir = resolveDataRootDir(cwd)
    this.filePath = path.join(this.rootDir, 'telegram.json')
    this.secretStore = secretStore
  }

  async ensure(): Promise<void> { await ensureDir(this.rootDir) }

  async load(): Promise<TelegramStoreData> {
    await this.ensure()
    if (!(await pathExists(this.filePath))) return getEmptyStore()

    const raw = await readFile(this.filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<TelegramStoreData>

    const rawBotToken = typeof parsed.botToken === 'string' ? parsed.botToken : undefined
    let resolvedBotToken = rawBotToken
    if (this.secretStore && rawBotToken) {
      resolvedBotToken = await this.secretStore.resolve(
        `${TELEGRAM_ACCOUNT_PREFIX}:botToken`, rawBotToken,
      )
    }

    return {
      botToken: resolvedBotToken,
      pollOffset: typeof parsed.pollOffset === 'number' ? parsed.pollOffset : undefined,
      autoStartOnLaunch: typeof parsed.autoStartOnLaunch === 'boolean' ? parsed.autoStartOnLaunch : undefined,
      allowedChatIds: Array.isArray(parsed.allowedChatIds)
        ? parsed.allowedChatIds.filter((e): e is string => typeof e === 'string')
        : [],
      chats: Array.isArray(parsed.chats)
        ? parsed.chats.filter(
            (e): e is TelegramChatState =>
              Boolean(e) && typeof e === 'object' &&
              typeof e.chatId === 'string' && typeof e.sessionId === 'string' &&
              isPermissionMode(e.permissionMode) && typeof e.updatedAt === 'string',
          )
        : [],
    }
  }

  async save(data: TelegramStoreData): Promise<void> {
    await this.ensure()
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }

  async clear(): Promise<TelegramStoreData> {
    const data = getEmptyStore()
    await this.save(data)
    if (this.secretStore) {
      for (const field of TELEGRAM_SENSITIVE_FIELDS) {
        await this.secretStore.delete(`${TELEGRAM_ACCOUNT_PREFIX}:${field}`)
      }
    }
    return data
  }

  async setBotToken(botToken: string): Promise<TelegramStoreData> {
    const data = await this.load()
    if (this.secretStore) {
      data.botToken = await this.secretStore.encrypt(`${TELEGRAM_ACCOUNT_PREFIX}:botToken`, botToken)
    } else {
      data.botToken = botToken
    }
    await this.save(data)
    return data
  }

  async setPollOffset(offset: number): Promise<TelegramStoreData> {
    const data = await this.load()
    data.pollOffset = offset
    await this.save(data)
    return data
  }

  async setAutoStartOnLaunch(enabled: boolean): Promise<TelegramStoreData> {
    const data = await this.load()
    data.autoStartOnLaunch = enabled
    await this.save(data)
    return data
  }

  getChat(data: TelegramStoreData, chatId: string): TelegramChatState | undefined {
    return data.chats.find(c => c.chatId === chatId)
  }

  async authorizeChat(chatId: string): Promise<TelegramStoreData> {
    const data = await this.load()
    if (!data.allowedChatIds.includes(chatId)) data.allowedChatIds.push(chatId)
    await this.save(data)
    return data
  }

  isAuthorized(data: TelegramStoreData, chatId: string): boolean {
    return data.allowedChatIds.includes(chatId)
  }

  async upsertChat(nextChat: Omit<TelegramChatState, 'updatedAt'>): Promise<TelegramStoreData> {
    const data = await this.load()
    const chat: TelegramChatState = { ...nextChat, updatedAt: now() }
    const idx = data.chats.findIndex(c => c.chatId === nextChat.chatId)
    if (idx >= 0) data.chats[idx] = chat
    else data.chats.push(chat)
    await this.save(data)
    return data
  }
}
