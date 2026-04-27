import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { ensureDir, pathExists } from '../utils/fs.js'

const execFileAsync = promisify(execFile)

export const KEYCHAIN_SENTINEL = '__keychain__'
const KEYCHAIN_SERVICE = 'artemis'
const AES_ALGO = 'aes-256-gcm'

// ─── macOS Keychain ───────────────────────────────────────────────────────────

class MacOSKeychainBackend {
  async set(account: string, secret: string): Promise<void> {
    await execFileAsync('/usr/bin/security', [
      'add-generic-password', '-U',
      '-s', KEYCHAIN_SERVICE, '-a', account, '-w', secret,
    ])
  }
  async get(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', [
        'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w',
      ])
      return stdout.trim() || undefined
    } catch { return undefined }
  }
  async delete(account: string): Promise<void> {
    try {
      await execFileAsync('/usr/bin/security', [
        'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account,
      ])
    } catch { /* not found is fine */ }
  }
  static async isAvailable(): Promise<boolean> {
    try { await execFileAsync('/usr/bin/security', ['list-keychains']); return true }
    catch { return false }
  }
}

// ─── Linux secret-tool ────────────────────────────────────────────────────────

class LinuxSecretToolBackend {
  async set(account: string, secret: string): Promise<void> {
    await execFileAsync('secret-tool', [
      'store', '--label', `${KEYCHAIN_SERVICE}:${account}`,
      'service', KEYCHAIN_SERVICE, 'account', account,
    ], { input: secret } as never)
  }
  async get(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('secret-tool', [
        'lookup', 'service', KEYCHAIN_SERVICE, 'account', account,
      ])
      return stdout.trim() || undefined
    } catch { return undefined }
  }
  async delete(account: string): Promise<void> {
    try {
      await execFileAsync('secret-tool', [
        'clear', 'service', KEYCHAIN_SERVICE, 'account', account,
      ])
    } catch { /* ok */ }
  }
  static async isAvailable(): Promise<boolean> {
    try { await execFileAsync('secret-tool', ['--version']); return true }
    catch { return false }
  }
}

// ─── Local AES-256-GCM fallback ──────────────────────────────────────────────

class LocalAesBackend {
  private keyFile: string
  private secretsFile: string

  constructor(dir: string) {
    this.keyFile    = path.join(dir, '.artemis-keyring')
    this.secretsFile = path.join(dir, '.artemis-secrets')
  }

  private async getKey(): Promise<Buffer> {
    if (await pathExists(this.keyFile)) {
      const buf = await readFile(this.keyFile)
      if (buf.length === 32) return buf
    }
    const key = randomBytes(32)
    await writeFile(this.keyFile, key, { mode: 0o600 })
    await chmod(this.keyFile, 0o600)
    return key
  }

  private async loadSecrets(): Promise<Record<string, string>> {
    if (!(await pathExists(this.secretsFile))) return {}
    try { return JSON.parse(await readFile(this.secretsFile, 'utf8')) }
    catch { return {} }
  }

  private async saveSecrets(map: Record<string, string>): Promise<void> {
    await writeFile(this.secretsFile, JSON.stringify(map, null, 2), { mode: 0o600 })
    await chmod(this.secretsFile, 0o600)
  }

  async set(account: string, secret: string): Promise<void> {
    const key = await this.getKey()
    const iv  = randomBytes(12)
    const cipher = createCipheriv(AES_ALGO, key, iv)
    const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const encoded = `${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`
    const map = await this.loadSecrets()
    map[account] = encoded
    await this.saveSecrets(map)
  }

  async get(account: string): Promise<string | undefined> {
    const map = await this.loadSecrets()
    const encoded = map[account]
    if (!encoded) return undefined
    try {
      const [ivHex, encHex, tagHex] = encoded.split(':')
      if (!ivHex || !encHex || !tagHex) return undefined
      const key     = await this.getKey()
      const decipher = createDecipheriv(AES_ALGO, key, Buffer.from(ivHex, 'hex'))
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
      return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8')
    } catch { return undefined }
  }

  async delete(account: string): Promise<void> {
    const map = await this.loadSecrets()
    delete map[account]
    await this.saveSecrets(map)
  }
}

// ─── SecretStore ──────────────────────────────────────────────────────────────

export type SecretStoreBackendKind = 'macos-keychain' | 'linux-secret-tool' | 'local-aes'

interface Backend {
  set(account: string, secret: string): Promise<void>
  get(account: string): Promise<string | undefined>
  delete(account: string): Promise<void>
}

export class SecretStore {
  readonly backendKind: SecretStoreBackendKind
  private backend: Backend

  private constructor(backend: Backend, kind: SecretStoreBackendKind) {
    this.backend = backend
    this.backendKind = kind
  }

  static async create(fallbackDir: string): Promise<SecretStore> {
    await ensureDir(fallbackDir)
    if (process.platform === 'darwin' && await MacOSKeychainBackend.isAvailable()) {
      return new SecretStore(new MacOSKeychainBackend(), 'macos-keychain')
    }
    if (process.platform === 'linux' && await LinuxSecretToolBackend.isAvailable()) {
      return new SecretStore(new LinuxSecretToolBackend(), 'linux-secret-tool')
    }
    return new SecretStore(new LocalAesBackend(fallbackDir), 'local-aes')
  }

  /** Test-only factory: always uses local AES, never touches OS keychain */
  static createLocalAes(dir: string): SecretStore {
    return new SecretStore(new LocalAesBackend(dir), 'local-aes')
  }

  isSentinel(value: string | undefined): boolean {
    return value === KEYCHAIN_SENTINEL
  }

  async set(account: string, secret: string): Promise<void> {
    await this.backend.set(account, secret)
  }

  async get(account: string): Promise<string | undefined> {
    return this.backend.get(account)
  }

  async delete(account: string): Promise<void> {
    return this.backend.delete(account)
  }

  /** Store the secret, return the sentinel placeholder */
  async encrypt(account: string, secret: string): Promise<string> {
    await this.set(account, secret)
    return KEYCHAIN_SENTINEL
  }

  /** If value is a sentinel, resolve it from the backend; else return value as-is */
  async resolve(account: string, value: string | undefined): Promise<string | undefined> {
    if (!this.isSentinel(value)) return value
    return this.get(account)
  }

  async encryptFields(
    credentials: Record<string, string>,
    accountPrefix: string,
    sensitiveFields: readonly string[]
  ): Promise<Record<string, string>> {
    const result = { ...credentials }
    for (const field of sensitiveFields) {
      const val = credentials[field]
      if (val && val !== KEYCHAIN_SENTINEL) {
        result[field] = await this.encrypt(`${accountPrefix}:${field}`, val)
      }
    }
    return result
  }

  async resolveFields(
    credentials: Record<string, string>,
    accountPrefix: string,
    sensitiveFields: readonly string[]
  ): Promise<Record<string, string>> {
    const result = { ...credentials }
    for (const field of sensitiveFields) {
      result[field] = (await this.resolve(`${accountPrefix}:${field}`, credentials[field])) ?? ''
    }
    return result
  }
}
