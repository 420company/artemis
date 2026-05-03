/**
 * bragi/store.ts — BragiStore: cross-platform session registry
 *
 * Tracks which platform sessions map to which Artemis sessions.
 * Sensitive credentials are routed through SecretStore.
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, pathExists, resolveDataRootDir } from '../utils/fs.js'
import { BRAGI_SENSITIVE_FIELDS, bragiAccountPrefix } from '../security/bragiSecrets.js'
import type { SecretStore } from '../security/secretStore.js'
import { buildBragiSessionKey } from './types.js'
import type {
  BragiPlatformConfig,
  BragiPlatformId,
  BragiSessionRecord,
  BragiStoreData,
} from './types.js'
import type { PermissionMode } from '../cli/parseArgs.js'

function now(): string { return new Date().toISOString() }

function getEmptyStore(): BragiStoreData {
  return { version: 1, platforms: {}, sessions: [] }
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
  )
}

function normalizePlatformConfig(value: unknown): BragiPlatformConfig | undefined {
  if (!value || typeof value !== 'object') return undefined
  const p = value as Partial<BragiPlatformConfig>
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined,
    autoStartOnLaunch: typeof p.autoStartOnLaunch === 'boolean' ? p.autoStartOnLaunch : undefined,
    connectionMode: typeof p.connectionMode === 'string' ? p.connectionMode : undefined,
    deployment: typeof p.deployment === 'string' ? p.deployment : undefined,
    credentials: normalizeStringRecord(p.credentials),
    allowedTargets: Array.isArray(p.allowedTargets)
      ? p.allowedTargets.filter((e): e is string => typeof e === 'string')
      : [],
    notes: typeof p.notes === 'string' ? p.notes : undefined,
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
  }
}

function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'PRODUCER' || v === 'GHOSTWRITER' || v === 'WRITER' ||
    v === 'prompt' || v === 'read-only' || v === 'accept-edits' || v === 'accept-all'
}

function isBragiPlatform(v: unknown): v is BragiPlatformId {
  return v === 'telegram' || v === 'discord' || v === 'wechat'
}

function normalizeSessionRecord(value: unknown): BragiSessionRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const p = value as Partial<BragiSessionRecord>
  if (!isBragiPlatform(p.platform)) return undefined
  if (typeof p.scope !== 'string') return undefined
  if (typeof p.targetId !== 'string') return undefined
  if (typeof p.targetLabel !== 'string') return undefined
  if (typeof p.sessionId !== 'string') return undefined
  if (!isPermissionMode(p.permissionMode)) return undefined
  return {
    sessionKey: typeof p.sessionKey === 'string' && p.sessionKey.trim()
      ? p.sessionKey
      : buildBragiSessionKey({ platform: p.platform, scope: p.scope, targetId: p.targetId }),
    platform: p.platform,
    scope: p.scope,
    targetId: p.targetId,
    targetLabel: p.targetLabel,
    sessionId: p.sessionId,
    permissionMode: p.permissionMode,
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : now(),
  }
}

function normalizeStoreData(value: unknown): BragiStoreData {
  if (!value || typeof value !== 'object') return getEmptyStore()
  const p = value as Partial<BragiStoreData>
  const rawPlatforms = p.platforms && typeof p.platforms === 'object' ? p.platforms : {}
  const platforms = Object.fromEntries(
    Object.entries(rawPlatforms)
      .map(([k, v]) => [k, normalizePlatformConfig(v)])
      .filter((e): e is [BragiPlatformId, BragiPlatformConfig] => Boolean(e[1]) && isBragiPlatform(e[0]))
  ) as Partial<Record<BragiPlatformId, BragiPlatformConfig>>
  return {
    version: 1,
    lastConfiguredPlatform: isBragiPlatform(p.lastConfiguredPlatform) ? p.lastConfiguredPlatform : undefined,
    platforms,
    sessions: Array.isArray(p.sessions)
      ? p.sessions.map(normalizeSessionRecord).filter((e): e is BragiSessionRecord => Boolean(e))
      : [],
  }
}

export class BragiStore {
  private readonly rootDir: string
  private readonly filePath: string
  private readonly secretStore: SecretStore | undefined

  constructor(cwd: string, secretStore?: SecretStore) {
    this.rootDir = resolveDataRootDir(cwd)
    this.filePath = path.join(this.rootDir, 'bragi.json')
    this.secretStore = secretStore
  }

  async ensure(): Promise<void> { await ensureDir(this.rootDir) }

  async load(): Promise<BragiStoreData> {
    await this.ensure()
    if (!(await pathExists(this.filePath))) return getEmptyStore()
    const raw = await readFile(this.filePath, 'utf8')
    const data = normalizeStoreData(JSON.parse(raw))
    if (this.secretStore) {
      for (const [platform, config] of Object.entries(data.platforms) as [BragiPlatformId, BragiPlatformConfig][]) {
        if (config) {
          config.credentials = await this.secretStore.resolveFields(
            config.credentials,
            bragiAccountPrefix(platform),
            BRAGI_SENSITIVE_FIELDS[platform],
          )
        }
      }
    }
    return data
  }

  async save(data: BragiStoreData): Promise<void> {
    await this.ensure()
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }

  async upsertPlatform(platform: BragiPlatformId, nextConfig: BragiPlatformConfig): Promise<BragiStoreData> {
    const data = await this.load()
    let credentials = nextConfig.credentials
    if (this.secretStore) {
      credentials = await this.secretStore.encryptFields(
        credentials, bragiAccountPrefix(platform), BRAGI_SENSITIVE_FIELDS[platform],
      )
    }
    data.platforms[platform] = { ...nextConfig, credentials, updatedAt: now() }
    data.lastConfiguredPlatform = platform
    await this.save(data)
    return data
  }

  async clearPlatform(platform: BragiPlatformId): Promise<BragiStoreData> {
    const data = await this.load()
    delete data.platforms[platform]
    data.sessions = data.sessions.filter(s => s.platform !== platform)
    if (data.lastConfiguredPlatform === platform) data.lastConfiguredPlatform = undefined
    await this.save(data)
    if (this.secretStore) {
      for (const field of BRAGI_SENSITIVE_FIELDS[platform]) {
        await this.secretStore.delete(`${bragiAccountPrefix(platform)}:${field}`)
      }
    }
    return data
  }

  listSessions(data: BragiStoreData, options?: { platform?: BragiPlatformId }): BragiSessionRecord[] {
    return [...data.sessions]
      .filter(s => !options?.platform || s.platform === options.platform)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  getSession(data: BragiStoreData, sessionKey: string): BragiSessionRecord | undefined {
    return data.sessions.find(s => s.sessionKey === sessionKey)
  }

  async upsertSession(
    input: Omit<BragiSessionRecord, 'updatedAt' | 'sessionKey'> & { sessionKey?: string; updatedAt?: string }
  ): Promise<BragiStoreData> {
    const data = await this.load()
    const sessionKey = input.sessionKey
      ?? buildBragiSessionKey({ platform: input.platform, scope: input.scope, targetId: input.targetId })
    const record: BragiSessionRecord = { ...input, sessionKey, updatedAt: input.updatedAt ?? now() }
    const idx = data.sessions.findIndex(s => s.sessionKey === sessionKey)
    if (idx >= 0) data.sessions[idx] = record
    else data.sessions.push(record)
    await this.save(data)
    return data
  }
}
