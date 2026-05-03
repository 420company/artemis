/**
 * discord/store.ts — per-channel/DM state for the Discord bridge
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PermissionMode } from '../cli/parseArgs.js'
import { ensureDir, pathExists, resolveDataRootDir } from '../utils/fs.js'

export type DiscordTargetState = {
  targetId: string
  sessionId: string
  permissionMode: PermissionMode
  updatedAt: string
}

export type DiscordStoreData = {
  targets: DiscordTargetState[]
}

function now(): string { return new Date().toISOString() }
function getEmptyStore(): DiscordStoreData { return { targets: [] } }

function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'PRODUCER' || v === 'GHOSTWRITER' || v === 'WRITER' ||
    v === 'prompt' || v === 'read-only' || v === 'accept-edits' || v === 'accept-all'
}

export class DiscordStore {
  private readonly rootDir: string
  private readonly filePath: string

  constructor(cwd: string) {
    this.rootDir = resolveDataRootDir(cwd)
    this.filePath = path.join(this.rootDir, 'discord.json')
  }

  async ensure(): Promise<void> { await ensureDir(this.rootDir) }

  async load(): Promise<DiscordStoreData> {
    await this.ensure()
    if (!(await pathExists(this.filePath))) return getEmptyStore()
    const raw = await readFile(this.filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<DiscordStoreData>
    return {
      targets: Array.isArray(parsed.targets)
        ? parsed.targets.filter(
            (e): e is DiscordTargetState =>
              Boolean(e) && typeof e === 'object' &&
              typeof e.targetId === 'string' && typeof e.sessionId === 'string' &&
              isPermissionMode(e.permissionMode) && typeof e.updatedAt === 'string',
          )
        : [],
    }
  }

  async save(data: DiscordStoreData): Promise<void> {
    await this.ensure()
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }

  getTarget(data: DiscordStoreData, targetId: string): DiscordTargetState | undefined {
    return data.targets.find(t => t.targetId === targetId)
  }

  async upsertTarget(next: Omit<DiscordTargetState, 'updatedAt'>): Promise<DiscordStoreData> {
    const data = await this.load()
    const idx = data.targets.findIndex(t => t.targetId === next.targetId)
    const target: DiscordTargetState = { ...next, updatedAt: now() }
    if (idx >= 0) data.targets[idx] = target
    else data.targets.push(target)
    await this.save(data)
    return data
  }
}
