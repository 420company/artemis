export type CanonicalPermissionMode =
  | 'PRODUCER'
  | 'GHOSTWRITER'
  | 'WRITER'
  | 'read-only'

export type LegacyPermissionMode =
  | 'prompt'
  | 'accept-edits'
  | 'accept-all'

export type PermissionModeInput = CanonicalPermissionMode | LegacyPermissionMode

export type ToolAccessMode = 'ask' | 'full-access' | 'read' | 'write'

export function isPermissionModeInput(value: unknown): value is PermissionModeInput {
  return value === 'PRODUCER' ||
    value === 'GHOSTWRITER' ||
    value === 'WRITER' ||
    value === 'read-only' ||
    value === 'prompt' ||
    value === 'accept-edits' ||
    value === 'accept-all'
}

export function normalizePermissionMode(value: PermissionModeInput): CanonicalPermissionMode {
  if (value === 'accept-all') return 'PRODUCER'
  if (value === 'accept-edits') return 'WRITER'
  if (value === 'prompt') return 'GHOSTWRITER'
  return value
}

export function normalizePermissionModeValue(value: unknown): CanonicalPermissionMode | undefined {
  return isPermissionModeInput(value) ? normalizePermissionMode(value) : undefined
}

export function mapPermissionModeToToolAccess(mode: PermissionModeInput): ToolAccessMode {
  switch (normalizePermissionMode(mode)) {
    case 'PRODUCER':
      return 'full-access'
    case 'WRITER':
      return 'write'
    case 'read-only':
      return 'read'
    case 'GHOSTWRITER':
    default:
      return 'ask'
  }
}
