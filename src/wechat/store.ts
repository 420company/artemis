/**
 * wechat/store.ts — per-contact state for the WeChat personal bridge (iLink)
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PermissionMode } from '../cli/parseArgs.js'
import { normalizePermissionModeValue } from '../security/permissionModes.js'
import type { SecretStore } from '../security/secretStore.js'
import { ensureDir, pathExists, resolveDataRootDir } from '../utils/fs.js'

const WECHAT_ACCOUNT_PREFIX = 'bragi:wechat'
const WECHAT_SENSITIVE_FIELDS = ['gatewayToken'] as const

export type WeChatContactState = {
  fromUser: string          // peerUserId — kept as fromUser for store compat
  sessionId: string
  permissionMode: PermissionMode
  updatedAt: string
}

export type WeChatStoreData = {
  gatewayUrl?: string
  gatewayToken?: string
  allowedUsers: string[]
  autoStartOnLaunch?: boolean
  checkpoint?: string                    // iLink cursor for getUpdates
  contextTokens?: Record<string, string> // peerUserId → contextToken
  contacts: WeChatContactState[]
}

function now(): string { return new Date().toISOString() }
function getEmptyStore(): WeChatStoreData { return { allowedUsers: [], contacts: [] } }

export class WeChatStore {
  private readonly rootDir: string
  private readonly filePath: string
  private readonly secretStore: SecretStore | undefined

  constructor(cwd: string, secretStore?: SecretStore) {
    this.rootDir = resolveDataRootDir(cwd)
    this.filePath = path.join(this.rootDir, 'wechat.json')
    this.secretStore = secretStore
  }

  async ensure(): Promise<void> { await ensureDir(this.rootDir) }

  async load(): Promise<WeChatStoreData> {
    await this.ensure()
    if (!(await pathExists(this.filePath))) return getEmptyStore()
    const raw = await readFile(this.filePath, 'utf8')
    const p = JSON.parse(raw) as Partial<WeChatStoreData>
    let gatewayToken = typeof p.gatewayToken === 'string' ? p.gatewayToken : undefined
    if (this.secretStore && gatewayToken) {
      gatewayToken = await this.secretStore.resolve(`${WECHAT_ACCOUNT_PREFIX}:gatewayToken`, gatewayToken)
    }
    return {
      gatewayUrl:    typeof p.gatewayUrl === 'string' ? p.gatewayUrl : undefined,
      gatewayToken,
      allowedUsers:  Array.isArray(p.allowedUsers)
        ? p.allowedUsers.filter((e): e is string => typeof e === 'string')
        : [],
      autoStartOnLaunch: typeof p.autoStartOnLaunch === 'boolean' ? p.autoStartOnLaunch : undefined,
      checkpoint:    typeof p.checkpoint === 'string' ? p.checkpoint : undefined,
      contextTokens: (p.contextTokens && typeof p.contextTokens === 'object' && !Array.isArray(p.contextTokens))
        ? p.contextTokens as Record<string, string>
        : {},
      contacts: Array.isArray(p.contacts)
        ? p.contacts.filter(
            (e): e is WeChatContactState =>
              Boolean(e) && typeof e === 'object' && typeof e.fromUser === 'string' &&
              typeof e.sessionId === 'string' && Boolean(normalizePermissionModeValue(e.permissionMode)),
          ).map((e) => ({
            ...e,
            permissionMode: normalizePermissionModeValue(e.permissionMode)!,
          }))
        : [],
    }
  }

  async save(data: WeChatStoreData): Promise<void> {
    await this.ensure()
    const toWrite = { ...data }
    if (this.secretStore && toWrite.gatewayToken) {
      toWrite.gatewayToken = await this.secretStore.encrypt(`${WECHAT_ACCOUNT_PREFIX}:gatewayToken`, toWrite.gatewayToken)
    }
    await writeFile(this.filePath, JSON.stringify(toWrite, null, 2), 'utf8')
  }

  async setCredentials(opts: { gatewayUrl: string; gatewayToken: string }): Promise<WeChatStoreData> {
    const data = await this.load()
    data.gatewayUrl   = opts.gatewayUrl
    data.gatewayToken = opts.gatewayToken
    await this.save(data)
    return data
  }

  async setAutoStartOnLaunch(enabled: boolean): Promise<WeChatStoreData> {
    const data = await this.load()
    data.autoStartOnLaunch = enabled
    await this.save(data)
    return data
  }

  async setCheckpoint(checkpoint: string): Promise<WeChatStoreData> {
    const data = await this.load()
    data.checkpoint = checkpoint
    await this.save(data)
    return data
  }

  getContextToken(data: WeChatStoreData, peerUserId: string): string | undefined {
    return data.contextTokens?.[peerUserId]
  }

  async setContextToken(peerUserId: string, contextToken: string): Promise<void> {
    const data = await this.load()
    data.contextTokens = { ...(data.contextTokens ?? {}), [peerUserId]: contextToken }
    await this.save(data)
  }

  isAuthorized(data: WeChatStoreData, fromUser: string): boolean {
    return data.allowedUsers.length === 0 ||
      data.allowedUsers.includes('*') ||
      data.allowedUsers.includes(fromUser)
  }

  async authorizeUser(fromUser: string): Promise<WeChatStoreData> {
    const data = await this.load()
    if (!data.allowedUsers.includes(fromUser)) {
      data.allowedUsers = [...data.allowedUsers, fromUser]
      await this.save(data)
    }
    return data
  }

  getContact(data: WeChatStoreData, fromUser: string): WeChatContactState | undefined {
    return data.contacts.find(c => c.fromUser === fromUser)
  }

  async upsertContact(next: Omit<WeChatContactState, 'updatedAt'>): Promise<WeChatStoreData> {
    const data = await this.load()
    const contact: WeChatContactState = { ...next, updatedAt: now() }
    const idx = data.contacts.findIndex(c => c.fromUser === next.fromUser)
    if (idx >= 0) data.contacts[idx] = contact
    else data.contacts.push(contact)
    await this.save(data)
    return data
  }

  async clear(): Promise<WeChatStoreData> {
    const fresh = getEmptyStore()
    await this.save(fresh)
    if (this.secretStore) {
      for (const field of WECHAT_SENSITIVE_FIELDS) {
        await this.secretStore.delete(`${WECHAT_ACCOUNT_PREFIX}:${field}`)
      }
    }
    return fresh
  }
}
