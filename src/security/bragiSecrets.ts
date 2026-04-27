/**
 * security/bragiSecrets.ts — sensitive field declarations for Bragi platforms
 */

import type { BragiPlatformId } from '../bragi/types.js'

export const BRAGI_SENSITIVE_FIELDS: Readonly<Record<BragiPlatformId, readonly string[]>> = {
  telegram: ['botToken'],
  discord:  ['botToken'],
  wechat:   ['gatewayToken'],
}

export const TELEGRAM_SENSITIVE_FIELDS: readonly string[] = ['botToken']

export function bragiAccountPrefix(platform: BragiPlatformId): string {
  return `bragi:${platform}`
}

export const TELEGRAM_ACCOUNT_PREFIX = 'telegram'
