/**
 * bragi/types.ts — Bragi platform types
 */

import type { PermissionMode } from '../cli/parseArgs.js'

export const BRAGI_PLATFORM_IDS = ['telegram', 'discord', 'wechat'] as const
export type BragiPlatformId = (typeof BRAGI_PLATFORM_IDS)[number]

export type BragiPlatformConfig = {
  enabled?: boolean
  autoStartOnLaunch?: boolean
  connectionMode?: string
  deployment?: string
  credentials: Record<string, string>
  allowedTargets: string[]
  notes?: string
  updatedAt?: string
}

export type BragiSessionRecord = {
  sessionKey: string
  platform: BragiPlatformId
  scope: string
  targetId: string
  targetLabel: string
  sessionId: string
  permissionMode: PermissionMode
  updatedAt: string
}

export type BragiStoreData = {
  version: 1
  lastConfiguredPlatform?: BragiPlatformId
  platforms: Partial<Record<BragiPlatformId, BragiPlatformConfig>>
  sessions: BragiSessionRecord[]
}

export function buildBragiSessionKey(input: {
  platform: BragiPlatformId
  scope: string
  targetId: string
}): string {
  return `${input.platform}:${input.scope}:${input.targetId}`
}

export function getBragiPlatformDisplayLabel(options: {
  platform: BragiPlatformId
  deployment?: string
}): string {
  switch (options.platform) {
    case 'telegram': return 'Telegram'
    case 'discord':  return 'Discord'
    case 'wechat':   return 'WeChat (personal)'
  }
}
