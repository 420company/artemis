/**
 * bragi/runtime.ts — generic Bragi message pump
 *
 * Drives a polling loop for any IM platform. Each inbound message is:
 *   1. Authorized (allowed target check)
 *   2. Dispatched to a session-bound AI turn (via runRemoteCommand)
 *   3. Replied back to the originating chat
 *
 * Only one concurrent task per target ID is allowed.
 */

import { think, resetSession, getMessages, restoreSessionStateForCwd } from '../brain.js'
import { open, readFile, unlink, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { hostname, homedir } from 'node:os'
import path from 'node:path'
import { SessionStore } from '../storage/sessions.js'
import type { SessionRecord } from '../core/types.js'
import type { PermissionMode } from '../cli/parseArgs.js'
import { buildPanel } from '../cli/ui.js'
import type { UiLocale } from '../cli/locale.js'
import { DEFAULT_UI_LOCALE, pickLocale } from '../cli/locale.js'
import type { BridgePlatform, BridgeTerminalEvent } from '../cli/bridgeNotify.js'
import { ensureDir, resolveArtemisHomeDir, resolveDataRootDir, truncate } from '../utils/fs.js'
import stripAnsi from 'strip-ansi'
import {
  detectExplicitWorkflowIntent,
  resolveWorkflow,
  type WorkflowResolution,
} from '../core/workflowDispatcher.js'
import { resolveMainProviderConfig } from '../providers/onboarding.js'
import { ProviderStore } from '../providers/store.js'
import { createTrackedProviderFromConfig } from '../providers/telemetry.js'
import { createProviderRouter } from '../providers/router.js'
import { PermissionManager } from '../security/permissions.js'
import { runWorkflowMode } from '../core/workflowMode.js'
import type { ChatProvider, ProviderConfig } from '../providers/types.js'
import { resolveWorkspaceIntent } from '../cli/workspaceIntent.js'
import { RuntimeDirectoryService } from '../services/runtimeDirectory.js'
import { isTaskRuntimeActiveStatus } from '../core/taskRuntime.js'
import { sendBragiImageBroadcast } from './imageBroadcast.js'
import { DEFAULT_AGENT_MAX_TURNS } from '../cli/branding.js'
import { handleSeedanceMultimodalWorkflow } from '../tools/visual/seedanceWorkflow.js'
import { handleSagaLongVideoWorkflow } from '../tools/visual/sagaWorkflow.js'
import { executeAction } from '../tools/index.js'
import { mapPermissionModeToToolAccess } from '../security/permissionModes.js'
import { loadDreamIndex, readDreamBody } from '../services/dreamStore.js'
import { broadcastToBridges } from '../services/bridgeNotifier.js'
import { withRuntimeLogSink, type RuntimeLogEntry } from '../utils/log.js'
import { existsSync, statSync } from 'node:fs'

// ─── display helpers ──────────────────────────────────────────────────────────

/**
 * Shorten a bridge sender label for compact terminal display.
 * - Strips platform suffixes (@im.wechat, @chatroom, @qq.com, @feishu.cn, etc.)
 * - Truncates to ≤16 chars with ellipsis
 * - Falls back to original if already short
 */
export function compactLabel(label: string): string {
  const stripped = label
    .replace(/@im\.wechat$/i, '')
    .replace(/@chatroom$/i, '')
    .replace(/@qq\.com$/i, '')
    .replace(/@feishu\.cn$/i, '')
    .trim()
  return stripped.length > 16 ? stripped.slice(0, 14) + '…' : stripped
}

function bridgePlatformFromLabel(label: string): BridgePlatform {
  const normalized = label.toLowerCase()
  if (normalized.includes('discord')) return 'discord'
  if (normalized.includes('wechat')) return 'wechat'
  return 'telegram'
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  const candidates = ['path', 'filePath', 'outputPath', 'command', 'query', 'pattern', 'url']
  for (const key of candidates) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return ` · ${truncate(value.replace(/\s+/g, ' '), 120)}`
    }
  }
  return ''
}

function isUnsafeBridgeWorkspace(cwd: string): boolean {
  const normalized = path.resolve(cwd)
  const homeDir = path.resolve(homedir())
  return normalized === path.parse(normalized).root || normalized === path.dirname(homeDir)
}

function summarizeToolOutput(output: unknown): string {
  if (typeof output !== 'string') return ''
  const compact = output.replace(/\s+/g, ' ').trim()
  return compact ? ` · ${truncate(compact, 160)}` : ''
}

function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

function buildLongVideoMobileCompletionReply(output: unknown, locale: UiLocale): string {
  const videoPath = extractVideoPathsFromToolOutput('generate_long_video', output)[0]
  let detail = ''
  if (videoPath) {
    const name = path.basename(videoPath)
    let size = ''
    try {
      if (existsSync(videoPath)) size = formatBytesCompact(statSync(videoPath).size)
    } catch { /* ignore size lookup */ }
    detail = size ? `${name} · ${size}` : name
  }
  return pickLocale(locale, {
    zh: ['✅ 长视频生成完成', '🎬 已自动发送视频附件到当前聊天。', detail ? `📎 ${detail}` : ''].filter(Boolean).join('\n'),
    en: ['✅ Long video is ready', '🎬 Sent the video attachment to this chat automatically.', detail ? `📎 ${detail}` : ''].filter(Boolean).join('\n'),
  })
}

function normalizeBridgeWorkspacePath(value: string | undefined): string | null {
  if (!value) return null
  return path.resolve(value).replace(/[\\/]+$/g, '').toLowerCase()
}

function sameBridgeWorkspacePath(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeBridgeWorkspacePath(a)
  const right = normalizeBridgeWorkspacePath(b)
  return Boolean(left && right && left === right)
}

const IMAGE_PRODUCING_TOOLS = new Set([
  'browser_screenshot',
  'generate_image',
  'generate_video', // generated GIF previews may be sent as images where supported
  'generate_long_video',
])

const VIDEO_PRODUCING_TOOLS = new Set([
  'generate_video',
  'generate_long_video',
])

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg)\b/i
const VIDEO_EXTENSION_RE = /\.(mp4|mov|webm|m4v)\b/i

/**
 * Extract image file paths from a tool's output string. We only run the scan
 * for tools known to produce images (browser_screenshot, generate_image,
 * generate_video) so an unrelated `read_file` of a doc that happens to mention
 * "image.png" doesn't trigger a phantom broadcast.
 *
 * Output shapes the helper recognizes:
 *   - "📸 已截图：/Users/.../screenshot-123.png\n   URL: ..."
 *   - "Generated 1 image(s) via openai/gpt-image-2: /Users/.../foo.png"
 *   - JSON envelope { output: "...path..." }
 *   - Plain absolute path lines
 *
 * Returns absolute paths, deduped, in source order. Existence is NOT checked
 * here — the bridge push will silently skip missing files.
 */
export function extractImagePathsFromToolOutput(toolName: string, output: unknown): string[] {
  return extractMediaPathsFromToolOutput(toolName, output, IMAGE_PRODUCING_TOOLS, IMAGE_EXTENSION_RE, 'png|jpe?g|gif|webp|bmp|svg')
}

export function extractVideoPathsFromToolOutput(toolName: string, output: unknown): string[] {
  return extractMediaPathsFromToolOutput(toolName, output, VIDEO_PRODUCING_TOOLS, VIDEO_EXTENSION_RE, 'mp4|mov|webm|m4v')
}

function extractMediaPathsFromToolOutput(
  toolName: string,
  output: unknown,
  producingTools: Set<string>,
  extensionRe: RegExp,
  extensionPattern: string,
): string[] {
  if (!producingTools.has(toolName)) return []
  let text: string
  if (typeof output === 'string') {
    text = output
  } else if (output && typeof output === 'object') {
    try { text = JSON.stringify(output) } catch { return [] }
  } else {
    return []
  }
  const found = new Set<string>()
  // Absolute POSIX paths or Windows drive paths ending in an image extension.
  // The lookbehind matches start-of-string OR any character that is NOT a
  // path component character — this catches Chinese punctuation (：，。)
  // sitting right before the path, which a simple [\s"'] class would miss.
  const re = new RegExp(`(?:^|[^A-Za-z0-9_./\\\\:])((?:/|[A-Za-z]:[\\\\/])[^\\s"'\\\`]*?\\.(?:${extensionPattern}))(?=$|[\\s"'\\\`])`, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const candidate = match[1]?.trim()
    if (candidate && extensionRe.test(candidate)) {
      found.add(candidate)
    }
  }

  // Labeled tool-output lines often contain absolute paths under workspaces
  // with spaces, e.g. "Video: /Users/me/Artemis Code/out.mp4".
  // The generic scanner above intentionally stops at whitespace, so handle
  // these explicit media-path lines separately.
  const labeledLineRe = new RegExp(
    `(?:^|\\n)\\s*(?:(?:Video|Image|Output|Path|File)\\s*[:：]|Generated\\s+(?:image|video)[^\\n]*?\\bsaved\\s+to\\b)\\s*(.+?\\.(?:${extensionPattern}))\\s*(?=\\n|$)`,
    'gi',
  )
  while ((match = labeledLineRe.exec(text)) !== null) {
    const candidate = match[1]
      ?.trim()
      .replace(/[),，。]+$/g, '')
    if (candidate && extensionRe.test(candidate)) {
      found.add(candidate)
    }
  }

  const openLineRe = new RegExp(`\\bopen\\s+["'](.+?\\.(?:${extensionPattern}))["']`, 'gi')
  while ((match = openLineRe.exec(text)) !== null) {
    const candidate = match[1]?.trim()
    if (candidate && extensionRe.test(candidate)) {
      found.add(candidate)
    }
  }

  for (const line of text.split('\n')) {
    const candidate = line
      .trim()
      .replace(/^open\s+["]?/, '')
      .replace(/[")，。]+$/g, '')
    if ((candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate)) && extensionRe.test(candidate)) {
      found.add(candidate)
    }
  }
  return Array.from(found)
}

function formatMobileReply(text: string): string {
  let out = stripAnsi(text).replace(/\r\n?/g, '\n').trim()
  if (!out) return ''

  out = out
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/^```[a-zA-Z0-9_-]*\n?/gm, '')
    .replace(/```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')

  return out.trim()
}

let bridgeThinkQueue: Promise<void> = Promise.resolve()

async function withBridgeThinkLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = bridgeThinkQueue
  let release!: () => void
  bridgeThinkQueue = new Promise<void>((resolve) => { release = resolve })
  await previous.catch(() => undefined)
  try {
    return await run()
  } finally {
    release()
  }
}

type BridgeProviderRuntime = {
  config: ProviderConfig
  provider: ChatProvider
}

async function resolveBridgeProviderRuntime(_cwd: string): Promise<BridgeProviderRuntime> {
  // SECURITY / CONSISTENCY: messaging bridges (telegram / discord / wechat)
  // ALWAYS resolve the AI provider from the GLOBAL ~/.artemis/providers.json,
  // never from a workspace-local .artemis/providers.json that happens to sit
  // under the session's cwd. The bridge is a system service that processes
  // remote IM messages — its provider choice should not be hijackable by any
  // file the agent edits or any stale .artemis subdir left over from an old
  // install in any directory the agent's cwd ever pointed to. The session
  // cwd remains correct for tool-execution context (file edits, etc.) — only
  // provider resolution is hardened here.
  const globalCwd = homedir()
  const config = await resolveMainProviderConfig({ cwd: globalCwd, config: {} })
  const trackedProfileId =
    typeof (config as unknown as { id?: unknown }).id === 'string'
      ? (config as unknown as { id: string }).id
      : undefined
  const trackedProfileLabel =
    typeof (config as unknown as { label?: unknown }).label === 'string'
      ? (config as unknown as { label: string }).label
      : trackedProfileId
  const provider = createTrackedProviderFromConfig(config, {
    cwd: globalCwd,
    profileId: trackedProfileId,
    profileLabel: trackedProfileLabel,
  })
  return { config, provider }
}

/**
 * Provider for the /team routing call only. Same GLOBAL-only hardening as
 * resolveBridgeProviderRuntime, but prefers the cheaper specialist (worker)
 * profile and forces low effort — routing is a one-line JSON classification
 * that doesn't deserve the lead model's cost or thinking depth.
 */
async function resolveBridgeRouterProviderRuntime(): Promise<BridgeProviderRuntime> {
  let baseConfig: Record<string, unknown> | undefined
  try {
    const store = new ProviderStore(resolveArtemisHomeDir())
    const data = await store.load()
    const specialist = store.getProfile(data, data.specialistProfileId)
    if (specialist) baseConfig = specialist as unknown as Record<string, unknown>
  } catch { /* fall back to the main profile */ }
  const config = (baseConfig
    ?? await resolveMainProviderConfig({ cwd: homedir(), config: {} })) as Parameters<typeof createTrackedProviderFromConfig>[0]
  const routerConfig = { ...config, effort: 'low' as const }
  const trackedProfileId =
    typeof (config as unknown as { id?: unknown }).id === 'string'
      ? (config as unknown as { id: string }).id
      : undefined
  const provider = createTrackedProviderFromConfig(routerConfig, {
    cwd: homedir(),
    profileId: trackedProfileId,
    profileLabel: trackedProfileId,
  })
  return { config: routerConfig as BridgeProviderRuntime['config'], provider }
}

// ─── types ────────────────────────────────────────────────────────────────────

export type BragiInboundMessage = {
  targetId: string
  targetLabel: string
  text: string
  sourceMessageId?: string
  scope?: string
  images?: import('../providers/types.ts').ImageAttachment[]
}

export type BragiSessionBinding = {
  storedSession: SessionRecord
  permissionMode: PermissionMode
  rolledOver: boolean
}

function parseSessionTime(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function rebaseBridgeBindingToLatestMainSession(options: {
  binding: BragiSessionBinding
  store: SessionStore
  cwd: string
  onInfo?: (message: string) => void
}): Promise<BragiSessionBinding> {
  const latest = await options.store.loadLatest().catch(() => null)
  if (!latest || latest.id === options.binding.storedSession.id) {
    return options.binding
  }
  if (latest.kind && latest.kind !== 'main') {
    return options.binding
  }
  // PREVIOUS behavior: skipped rebase when the latest main session's cwd
  // did not match the bridge's bound cwd. That left the bridge stuck on an
  // old session whenever the user moved to a new workspace on the desktop —
  // the bridge would no longer mirror the user's current conversation.
  //
  // NEW behavior: always rebase to the latest main session regardless of
  // workspace path. The IM bridge mirrors whatever the user is actively
  // working on at the desktop, so the messaging session stays in sync with
  // the desktop CLI session at all times. (Provider resolution is now
  // global per resolveBridgeProviderRuntime, so workspace path no longer
  // controls model selection — only tool-execution context.)

  const latestUpdatedAt = parseSessionTime(latest.updatedAt)
  const boundUpdatedAt = parseSessionTime(options.binding.storedSession.updatedAt)
  if (latestUpdatedAt <= boundUpdatedAt) {
    return options.binding
  }

  options.onInfo?.(`[bridge] attached remote chat to latest main session ${latest.id} (was ${options.binding.storedSession.id}); cwd=${latest.cwd ?? 'unset'}`)
  return {
    ...options.binding,
    storedSession: latest,
    rolledOver: true,
  }
}

export type RemoteRuntimeResult = {
  replies: string[]
  storedSession: SessionRecord
  permissionMode: PermissionMode
}

// ─── slash command parser ─────────────────────────────────────────────────────

export type RemoteCommandType = 'start' | 'stop' | 'status' | 'clear' | 'help' | 'dream_show' | 'chat'

export type RemoteCommand = {
  type: RemoteCommandType
  body: string
  images?: import('../providers/types.ts').ImageAttachment[]
}

/** Clean bot @mention suffix: "/cmd@MyBotName" → "/cmd" */
function stripBotMention(text: string, pattern?: RegExp): string {
  return pattern ? text.replace(pattern, '').trim() : text.trim()
}

export function parseRemoteCommand(text: string, opts?: { commandSuffixPattern?: RegExp; images?: import('../providers/types.ts').ImageAttachment[] }): RemoteCommand {
  const cleaned = stripBotMention(text, opts?.commandSuffixPattern)
  const lower = cleaned.toLowerCase()
  if (lower === '/start')  return { type: 'start',  body: cleaned, images: opts?.images }
  if (lower === '/stop')   return { type: 'stop',   body: cleaned, images: opts?.images }
  if (lower === '/status') return { type: 'status', body: cleaned, images: opts?.images }
  if (lower === '/clear')  return { type: 'clear',  body: cleaned, images: opts?.images }
  if (lower === '/help')   return { type: 'help',   body: cleaned, images: opts?.images }
  if (lower === '/dream show') return { type: 'dream_show', body: cleaned, images: opts?.images }
  return { type: 'chat', body: cleaned, images: opts?.images }
}

// ─── remote command runner ────────────────────────────────────────────────────



export async function runRemoteCommand(
  command: RemoteCommand,
  opts: {
    binding: BragiSessionBinding
    store: SessionStore
    locale: UiLocale
    cwd?: string
    maxTurns?: number
    onProgress?: (message: string, level?: 'info' | 'warn' | 'error') => void | Promise<void>
    /**
     * Send an intermediate message to the originating chat. Used by workflow
     * commands to surface routing decisions before the main reply. Differs
     * from onProgress (which only updates CLI display).
     */
    sendChatUpdate?: (text: string) => void | Promise<void>
    /**
     * Optional bridge-level waiter used by request_user_confirmation. Platforms
     * can implement this by waiting for the next reply in the same chat.
     */
    awaitUserConfirmation?: (request: { question: string; timeoutMs: number }) => Promise<boolean>
    pollRunningUserMessages?: () => string[]
    onRunningUserMessageAccepted?: (text: string) => void
    bridgePlatform?: 'telegram' | 'discord' | 'wechat'
    targetId?: string
  }
): Promise<RemoteRuntimeResult> {
  let binding = opts.binding
  const { store, locale, cwd } = opts
  const storedCwd = binding.storedSession.cwd
  const fallbackCwd = storedCwd && !isUnsafeBridgeWorkspace(storedCwd)
    ? storedCwd
    : cwd || process.cwd()
  binding = await rebaseBridgeBindingToLatestMainSession({
    binding,
    store,
    cwd: fallbackCwd,
    onInfo: (message) => void Promise.resolve(opts.onProgress?.(message, 'info')).catch(() => {}),
  })
  if (storedCwd && storedCwd !== fallbackCwd && isUnsafeBridgeWorkspace(storedCwd)) {
    binding.storedSession.cwd = fallbackCwd
    await store.save({
      ...binding.storedSession,
      cwd: fallbackCwd,
      updatedAt: new Date().toISOString(),
    })
  }
  let commandCwd = fallbackCwd
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })

  switch (command.type) {
    case 'start':
      return {
        replies: [t(
          'Artemis 已就绪。直接发消息开始对话，或发送 /help 查看命令列表。',
          'Artemis is ready. Send a message to start chatting, or /help to see commands.',
        )],
        storedSession: binding.storedSession,
        permissionMode: binding.permissionMode,
      }

    case 'help':
      return {
        replies: [
          t(
            '/start — 初始化会话\n/status — 查看当前状态\n/clear — 重置对话历史\n/dream show — 发送最新梦境日记和配图\n/help — 显示此帮助\n\n直接发送消息开始对话。',
            '/start — Initialize session\n/status — Show current status\n/clear — Reset conversation\n/dream show — Send latest dream diary and image\n/help — Show this help\n\nOr just send a message to chat.',
          ),
        ],
        storedSession: binding.storedSession,
        permissionMode: binding.permissionMode,
      }

    case 'status': {
      const msgCount = binding.storedSession.messages.length
      const tokens = 0
      return {
        replies: [
          t(
            `状态: 已连接\n消息数: ${msgCount}\n已用 Token: ${tokens}\n会话 ID: ${binding.storedSession.id.slice(0, 8)}`,
            `Status: connected\nMessages: ${msgCount}\nTokens used: ${tokens}\nSession: ${binding.storedSession.id.slice(0, 8)}`,
          ),
        ],
        storedSession: binding.storedSession,
        permissionMode: binding.permissionMode,
      }
    }

    case 'clear': {
      await withBridgeThinkLock(async () => {
        resetSession()
      })
      const fresh = store.createSession({ title: binding.storedSession.title })
      await store.save(fresh)
      return {
        replies: [t('对话历史已清空。', 'Conversation cleared.')],
        storedSession: fresh,
        permissionMode: binding.permissionMode,
      }
    }

    case 'dream_show': {
      const list = await loadDreamIndex()
      const latest = list[0]
      if (!latest) {
        return {
          replies: [t('还没有任何梦境。', 'No dreams yet.')],
          storedSession: binding.storedSession,
          permissionMode: binding.permissionMode,
        }
      }

      const body = await readDreamBody(latest.id)
      const caption = [
        t('🌙 Artemis 最新梦境', '🌙 Artemis latest dream'),
        '',
        body?.trim() || latest.preview,
      ].join('\n')

      const textResult = await broadcastToBridges({
        text: caption,
        platforms: opts.bridgePlatform ? [opts.bridgePlatform] : undefined,
        targetId: opts.targetId,
        source: 'dream_show',
      })
      let imageSent = 0
      let imageFailed = 0
      if (latest.imagePath) {
        const imageResult = await sendBragiImageBroadcast({
          cwd: commandCwd,
          imagePath: latest.imagePath,
          caption: t('🌙 Artemis 最新梦境配图', '🌙 Artemis latest dream image'),
          platform: opts.bridgePlatform,
          targetId: opts.targetId,
          source: 'dream_show',
        })
        imageSent = imageResult.live.sent + imageResult.configured.reduce((sum, item) => sum + item.sent, 0)
        imageFailed = imageResult.live.failed.length + imageResult.configured.reduce((sum, item) => sum + item.failed.length, 0)
      }

      return {
        replies: [t(
          `已发送最新梦境：${latest.id}\n日记 sent=${textResult.sent}; failed=${textResult.failed.length}\n配图 sent=${imageSent}; failed=${imageFailed}`,
          `Sent latest dream: ${latest.id}\nDiary sent=${textResult.sent}; failed=${textResult.failed.length}\nImage sent=${imageSent}; failed=${imageFailed}`,
        )],
        storedSession: binding.storedSession,
        permissionMode: binding.permissionMode,
      }
    }

    case 'stop':
      return {
        replies: [t('Artemis bridge 停止中。', 'Artemis bridge stopping.')],
        storedSession: binding.storedSession,
        permissionMode: binding.permissionMode,
    }

    case 'chat': {
      let reply = ''
      // Hoisted out so the catch + finally below can clear the heartbeat timer
      // even if think() throws partway through.
      let heartbeatTimer: NodeJS.Timeout | null = null
      const explicitWorkspace = await resolveWorkspaceIntent(command.body, fallbackCwd, homedir())
      if (explicitWorkspace) {
        commandCwd = explicitWorkspace.workspacePath
        binding.storedSession.cwd = commandCwd
        await store.save({
          ...binding.storedSession,
          cwd: commandCwd,
          updatedAt: new Date().toISOString(),
        })
        await opts.onProgress?.(t(
          `📁 已将本轮工作区固定为 ${commandCwd}`,
          `📁 Pinned this turn to workspace ${commandCwd}`,
        ), 'info')
      }

      const sagaTrim = command.body.trimStart()
      const sagaForceIntent = sagaTrim === '/saga' || /^\/saga(\s|$)/i.test(sagaTrim)
      const sagaText = sagaForceIntent ? sagaTrim.replace(/^\/saga\s*/i, '').trim() : command.body
      const sagaWorkflow = sagaForceIntent && !sagaText
        ? { handled: true as const, reply: t(
            'Saga 长视频：请在 /saga 后跟一段故事文字。例：/saga 一个赛博朋克的清晨，主角在霓虹街道上喝咖啡。',
            'Saga long video: type /saga followed by a story description. Example: /saga A cyberpunk morning, the protagonist sips coffee on a neon-lit street.',
          ) }
        : await handleSagaLongVideoWorkflow({
            scope: 'bridge',
            key: `${opts.bridgePlatform ?? 'bridge'}:${opts.targetId ?? binding.storedSession.id}`,
            cwd: commandCwd,
            text: sagaText,
            locale,
            imageAttachments: command.images,
            deliveryPlatform: opts.bridgePlatform,
            deliveryTargetId: opts.targetId,
            forceIntent: sagaForceIntent,
          })
      if (sagaWorkflow.handled) {
        return {
          replies: [sagaWorkflow.reply],
          storedSession: binding.storedSession,
          permissionMode: binding.permissionMode,
        }
      }
      // When Saga has rewritten the body to a long-video generation prompt,
      // skip the Seedance multimodal workflow — it would otherwise match
      // its own intent regex on the rewritten body (which mentions "video"
      // / "Seedance" / "references") and hijack the flow into a single-shot
      // generate_video call. Saga's prompt contains a stable marker
      // `[Artemis Saga long video workflow]` that we use to detect this.
      const sagaTookOver = Boolean(sagaWorkflow.prompt)
      if (sagaWorkflow.prompt) {
        command.body = sagaWorkflow.prompt
        await opts.onProgress?.(
          t(
            `🌙 Saga 长视频工作流已接管：注入导演级 System Prompt (${sagaWorkflow.prompt.length} 字符)。`,
            `🌙 Saga long-video workflow engaged: injected director-level System Prompt (${sagaWorkflow.prompt.length} chars).`,
          ),
          'info',
        )
      }
      const directSagaAction = sagaWorkflow.action

      if (!sagaTookOver) {
        const seedanceWorkflow = await handleSeedanceMultimodalWorkflow({
          scope: 'bridge',
          key: `${opts.bridgePlatform ?? 'bridge'}:${opts.targetId ?? binding.storedSession.id}`,
          cwd: commandCwd,
          text: command.body,
          locale,
          imageAttachments: command.images,
          deliveryPlatform: opts.bridgePlatform,
          deliveryTargetId: opts.targetId,
        })
        if (seedanceWorkflow.handled) {
          return {
            replies: [seedanceWorkflow.reply],
            storedSession: binding.storedSession,
            permissionMode: binding.permissionMode,
          }
        }
        if (seedanceWorkflow.prompt) {
          command.body = seedanceWorkflow.prompt
        }
      }

      try {
        const emitProgress = (message: string, level: 'info' | 'warn' | 'error' = 'info'): void => {
          void Promise.resolve(opts.onProgress?.(message, level)).catch(() => {})
        }

        // Workflow slash dispatch: detect /team /niko /design /athena /nidhogg /contest /run
        // and apply visual generation policy. Falls back to direct chat when no command.
        const slashMatch = detectExplicitWorkflowIntent(command.body)
        let workflowResolution: WorkflowResolution | undefined
        let providerRuntime: BridgeProviderRuntime | undefined
        let routerRuntime: BridgeProviderRuntime | undefined
        if (slashMatch.command) {
          if (slashMatch.command === '/team') {
            // /team routing runs on the cheap router provider (specialist
            // profile at low effort); the actual task still uses the lead.
            try {
              routerRuntime = await resolveBridgeRouterProviderRuntime()
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              await opts.onProgress?.(t(
                `Team 路由不可用（无 provider 配置），按 direct 处理：${truncate(msg, 200)}`,
                `Team router unavailable (no provider configured), falling back to direct: ${truncate(msg, 200)}`,
              ), 'warn')
            }
          }

          try {
            workflowResolution = await resolveWorkflow(slashMatch, {
              cwd: commandCwd,
              locale,
              provider: routerRuntime?.provider,
              nonInteractive: true,
              onProgress: opts.onProgress,
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            await opts.onProgress?.(t(
              `工作流分发失败：${msg}`,
              `Workflow dispatch failed: ${msg}`,
            ), 'warn')
          }

          if (workflowResolution && workflowResolution.summary.length > 0) {
            // Send to chat so user sees the routing decision; also mirror to CLI.
            const summaryText = workflowResolution.summary.join('\n')
            await opts.onProgress?.(summaryText, 'info')
            await opts.sendChatUpdate?.(summaryText)
          }

          if (workflowResolution) {
            try {
              providerRuntime ??= await resolveBridgeProviderRuntime(commandCwd)
              const workflowStartedText = t(
                `已进入 /${workflowResolution.mode} 可执行工作流；将使用真实 workflow/runtime 路径，而不是普通聊天模拟。`,
                `Entered executable /${workflowResolution.mode} workflow; using the real workflow/runtime path, not chat simulation.`,
              )
              await opts.onProgress?.(workflowStartedText, 'info')
              await opts.sendChatUpdate?.(workflowStartedText)

              const permissionManager = new PermissionManager(binding.permissionMode, false)
              const providerRouter = await createProviderRouter({
                cwd: commandCwd,
                mainProvider: providerRuntime.provider,
                onInfo: (message) => emitProgress(message, 'info'),
              })
              const result = await runWorkflowMode(
                workflowResolution.mode,
                binding.storedSession,
                workflowResolution.effectivePrompt,
                {
                  cwd: commandCwd,
                  provider: providerRuntime.provider,
                  sessionStore: store,
                  permissionManager,
                  maxTurns: opts.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
                  ensureSpecialistProvider: providerRouter.ensureSpecialistProvider,
                  resolveProvider: providerRouter.resolveProvider,
                  imageAttachments: command.images,
                  onInfo: (message) => emitProgress(message, 'info'),
                },
              )
              return {
                replies: [result.reply],
                storedSession: binding.storedSession,
                permissionMode: binding.permissionMode,
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              return {
                replies: [t(`工作流执行失败：${truncate(msg, 800)}`, `Workflow execution failed: ${truncate(msg, 800)}`)],
                storedSession: binding.storedSession,
                permissionMode: binding.permissionMode,
              }
            }
          }
        }

        const effectiveBody = workflowResolution?.effectivePrompt ?? command.body
        const startedText = t(
          '请求已接收 · Artemis 正在后台处理，完成后将自动送达。',
          'Request received · Artemis is processing it in the background and will deliver the result once complete.',
        )
        await opts.onProgress?.(startedText, 'info')
        await opts.sendChatUpdate?.(startedText)

        if (directSagaAction) {
          await opts.onProgress?.(t(
            `🔧 正在直接运行工具：generate_long_video · ${directSagaAction.totalDuration ?? directSagaAction.duration ?? 60}s`,
            `🔧 Running tool directly: generate_long_video · ${directSagaAction.totalDuration ?? directSagaAction.duration ?? 60}s`,
          ), 'info')

          // Pipe toolLog/toolWarn/toolError to the bridge so users on Telegram
          // (or other bridges) see real-time progress. Without this, the
          // 7-15 minute generation looks like a hang. Heartbeat every 30s as
          // a fallback for sub-tool awaits that don't log themselves.
          const longRunStartMs = Date.now()
          const sinkToBridge = (entry: RuntimeLogEntry) => {
            const elapsed = Math.round((Date.now() - longRunStartMs) / 1000)
            const text = `${entry.message}  (+${elapsed}s)`
            void opts.onProgress?.(text, entry.level === 'error' ? 'warn' : entry.level)
          }
          const HEARTBEAT_INTERVAL_MS = 30_000
          const HEARTBEAT_MAX_TICKS = 80
          let heartbeatTicks = 0
          const heartbeatTimer = setInterval(() => {
            heartbeatTicks += 1
            if (heartbeatTicks > HEARTBEAT_MAX_TICKS) {
              clearInterval(heartbeatTimer)
              return
            }
            const elapsed = Math.round((Date.now() - longRunStartMs) / 1000)
            void opts.onProgress?.(t(
              `⏱ 长视频生成进行中 · 已耗时 ${elapsed}s · 心跳 #${heartbeatTicks}`,
              `⏱ Long-video generation running · elapsed ${elapsed}s · heartbeat #${heartbeatTicks}`,
            ), 'info')
          }, HEARTBEAT_INTERVAL_MS)

          let result: Awaited<ReturnType<typeof executeAction>>
          try {
            result = await withRuntimeLogSink(sinkToBridge, () =>
              executeAction(directSagaAction, {
                cwd: commandCwd,
                locale,
                permissionMode: mapPermissionModeToToolAccess(binding.permissionMode),
                sessionId: binding.storedSession.id,
              }),
            )
          } finally {
            clearInterval(heartbeatTimer)
          }
          const msg = t(
            `${result.ok ? '✅' : '⚠️'} 工具${result.ok ? '完成' : '失败'}：generate_long_video${summarizeToolOutput(result.output)}`,
            `${result.ok ? '✅' : '⚠️'} Tool ${result.ok ? 'completed' : 'failed'}: generate_long_video${summarizeToolOutput(result.output)}`,
          )
          await opts.onProgress?.(msg, result.ok ? 'info' : 'warn')

          if (result.ok) {
            const videoPaths = extractVideoPathsFromToolOutput('generate_long_video', result.output)
            for (const videoPath of videoPaths) {
              try {
                const { broadcastToBridges } = await import('../services/bridgeNotifier.js')
                await broadcastToBridges({
                  text: t('🎬 Saga 长视频已生成。', '🎬 Saga long video generated.'),
                  videoPath,
                  source: 'tool:generate_long_video',
                })
              } catch { /* best-effort video push */ }
            }
          }

          const updated = {
            ...binding.storedSession,
            cwd: commandCwd,
            updatedAt: new Date().toISOString(),
          }
          await store.save(updated)
          return {
            replies: [result.ok
              ? buildLongVideoMobileCompletionReply(result.output, locale)
              : t(`长视频生成失败：\n${truncate(result.output, 1200)}`, `Long video generation failed:\n${truncate(result.output, 1200)}`)],
            storedSession: updated,
            permissionMode: binding.permissionMode,
          }
        }

        // Heartbeat: every ~45s while the model is working, send a short
        // chat message describing the most recent activity so the user
        // knows the AI is alive. Cancelled in the finally block.
        const turnStartedAt = Date.now()
        let lastActivitySnapshot = t(
          'reasoning + tools 运行中，等待下一段进度。',
          'reasoning + tools running',
        )
        const HEARTBEAT_INTERVAL_MS = 45_000
        heartbeatTimer = setInterval(() => {
          const elapsedSec = Math.round((Date.now() - turnStartedAt) / 1000)
          const heartbeatMsg = t(
            `⏳ 仍在处理（已 ${elapsedSec}s）：${lastActivitySnapshot}`,
            `⏳ Still working (${elapsedSec}s elapsed): ${lastActivitySnapshot}`,
          )
          void Promise.resolve(opts.sendChatUpdate?.(heartbeatMsg)).catch(() => {})
        }, HEARTBEAT_INTERVAL_MS)
        // Update the activity snapshot from any tool/reasoning event so the
        // heartbeat reflects what's actually happening right now.
        const recordActivity = (snapshot: string): void => {
          const trimmed = snapshot.trim()
          if (trimmed) lastActivitySnapshot = truncate(trimmed, 200)
        }

        let lastReasoningNoticeAt = 0
        let lastStreamNoticeAt = 0

        // Drive native-tool wiring from the bridge session's permissionMode:
        //   read-only  → disable tools (pure chat). Otherwise the model
        //                emits "let me run pwd" intent text whose call gets
        //                denied, leaving the IM user with a dangling intent
        //                line as the only reply.
        //   PRODUCER/GHOSTWRITER/WRITER → enable tools so remote coding via IM works.
        let latestCompressionSummary = binding.storedSession.summary
        const result = await withBridgeThinkLock(async () => {
          restoreSessionStateForCwd({
            messages: binding.storedSession.messages,
            summary: binding.storedSession.summary,
          }, commandCwd)
          return think(effectiveBody, {
            cwd: commandCwd,
            permissionMode: binding.permissionMode,
            initialCompressionSummary: binding.storedSession.summary,
            onCompressionSummary: (summary: string) => { latestCompressionSummary = summary },
            disableNativeTools: binding.permissionMode === 'read-only',
            imageAttachments: command.images,
            maxNativeToolRounds: Math.max(96, (opts.maxTurns ?? DEFAULT_AGENT_MAX_TURNS) * 3),
            pollRunningUserMessages: opts.pollRunningUserMessages,
            onRunningUserMessageAccepted: (text) => {
              const msg = t(
                `💬 已采纳运行中插话：${truncate(text, 160)}`,
                `💬 Running interjection accepted: ${truncate(text, 160)}`,
              )
              emitProgress(msg, 'info')
              recordActivity(msg)
              opts.onRunningUserMessageAccepted?.(text)
            },
            // Auto-approve only when this message explicitly named the same
            // workspace. For any other workspace switch, ask the bridge user
            // for confirmation; continuing without consent can make a stale
            // session/model guess edit the wrong project.
            onWorkspaceSwitchRequest: async (request) => {
              const explicitlyAllowed = Boolean(
                explicitWorkspace &&
                  (sameBridgeWorkspacePath(request.workspacePath, explicitWorkspace.workspacePath) ||
                    sameBridgeWorkspacePath(request.requestedPath, explicitWorkspace.requestedPath)),
              )
              if (explicitlyAllowed) {
                await opts.onProgress?.(t(
                  `📁 切换工作区到 ${request.workspacePath}`,
                  `📁 Switching workspace to ${request.workspacePath}`,
                ), 'info')
                return true
              }

              const question = t(
                `Artemis 想切换信任工作区到：${request.workspacePath}\n来源：${request.source}${request.toolName ? ` / 工具：${request.toolName}` : ''}${request.originalPath ? `\n原始路径：${request.originalPath}` : ''}\n确认继续吗？`,
                `Artemis wants to switch the trusted workspace to: ${request.workspacePath}\nSource: ${request.source}${request.toolName ? ` / tool: ${request.toolName}` : ''}${request.originalPath ? `\nOriginal path: ${request.originalPath}` : ''}\nContinue?`,
              )
              await opts.onProgress?.(t(
                `⚠️ 等待确认工作区切换：${request.workspacePath}`,
                `⚠️ Waiting for workspace-switch confirmation: ${request.workspacePath}`,
              ), 'warn')
              await opts.sendChatUpdate?.(t(
                `${question}\n回复“确认/yes/y”继续；回复其他内容或超时将暂停这次切换。`,
                `${question}\nReply "yes/y" to continue; anything else or timeout pauses this switch.`,
              ))
              if (!opts.awaitUserConfirmation) {
                recordActivity(t(
                  `确认等待未接入，已暂停工作区切换：${request.workspacePath}`,
                  `Confirmation waiter is not wired; paused workspace switch: ${request.workspacePath}`,
                ))
                return false
              }
              recordActivity(t(
                `等待用户确认工作区切换：${request.workspacePath}`,
                `Waiting for workspace-switch confirmation: ${request.workspacePath}`,
              ))
              const allowed = await opts.awaitUserConfirmation({ question, timeoutMs: 10 * 60_000 })
              await opts.onProgress?.(t(
                allowed
                  ? `📁 切换工作区到 ${request.workspacePath}`
                  : `⚠️ 用户拒绝/超时，已暂停工作区切换：${request.workspacePath}`,
                allowed
                  ? `📁 Switching workspace to ${request.workspacePath}`
                  : `⚠️ User declined/timed out; paused workspace switch: ${request.workspacePath}`,
              ), allowed ? 'info' : 'warn')
              return allowed
            },
            onUserConfirmationRequest: async (request) => {
              const question = request.question.trim()
              const timeoutMs = request.timeoutMs ?? 10 * 60_000
              await opts.sendChatUpdate?.(t(
                `⚠️ 需要你确认：${question}\n回复“确认/yes/y”继续；回复其他内容或超时将停止。`,
                `⚠️ Confirmation needed: ${question}\nReply "yes/y" to continue; anything else or timeout stops.`,
              ))
              if (request.screenshotPath) {
                try {
                  const { broadcastToBridges } = await import('../services/bridgeNotifier.js')
                  await broadcastToBridges({
                    text: t('请基于这张截图确认。', 'Please confirm based on this screenshot.'),
                    imagePath: request.screenshotPath,
                    source: 'tool:request_user_confirmation',
                  })
                } catch { /* best-effort */ }
              }
              if (!opts.awaitUserConfirmation) {
                recordActivity(t(
                  `确认等待未接入，已停止敏感操作：${question}`,
                  `Confirmation waiter is not wired; stopped sensitive action: ${question}`,
                ))
                return false
              }
              recordActivity(t(`等待用户确认：${question}`, `Waiting for user confirmation: ${question}`))
              return await opts.awaitUserConfirmation({ question, timeoutMs })
            },
            onToolCall: (name, args) => {
              const msg = t(
                `🔧 正在运行工具：${String(name)}${summarizeToolArgs(args)}`,
                `🔧 Running tool: ${String(name)}${summarizeToolArgs(args)}`,
              )
              emitProgress(msg)
              recordActivity(msg)
            },
            onToolResult: (name, ok, output) => {
              const msg = t(
                `${ok ? '✅' : '⚠️'} 工具${ok ? '完成' : '失败'}：${String(name)}${summarizeToolOutput(output)}`,
                `${ok ? '✅' : '⚠️'} Tool ${ok ? 'completed' : 'failed'}: ${String(name)}${summarizeToolOutput(output)}`,
              )
              emitProgress(msg, ok ? 'info' : 'warn')
              recordActivity(msg)
              // Auto-push generated images to every active bridge so phone
              // users see what the AI is showing on the desktop. Without
              // this, browser_screenshot / generate_image saved the file
              // locally but bridge users only got a text path they can't
              // open from their phone.
              if (ok) {
                const imagePaths = extractImagePathsFromToolOutput(String(name), output)
                for (const imagePath of imagePaths) {
                  void (async () => {
                    try {
                      const { broadcastToBridges } = await import('../services/bridgeNotifier.js')
                      await broadcastToBridges({
                        text: t(
                          `🖼 工具产出：${String(name)}`,
                          `🖼 Tool output: ${String(name)}`,
                        ),
                        imagePath,
                        source: `tool:${String(name)}`,
                      })
                    } catch { /* image push is best-effort */ }
                  })()
                }
                const videoPaths = extractVideoPathsFromToolOutput(String(name), output)
                for (const videoPath of videoPaths) {
                  void (async () => {
                    try {
                      const { broadcastToBridges } = await import('../services/bridgeNotifier.js')
                      await broadcastToBridges({
                        text: t(
                          `🎬 工具产出：${String(name)}`,
                          `🎬 Tool output: ${String(name)}`,
                        ),
                        videoPath,
                        source: `tool:${String(name)}`,
                      })
                    } catch { /* video push is best-effort */ }
                  })()
                }
              }
            },
            onToolLog: (message, level = 'info') => {
              emitProgress(message, level)
              recordActivity(message)
            },
            onReasoning: () => {
              const now = Date.now()
              if (now - lastReasoningNoticeAt < 15_000) return
              lastReasoningNoticeAt = now
              emitProgress(t(
                '🧠 reasoning stream active · 模型仍在思考。',
                '🧠 reasoning stream active',
              ))
            },
            onStream: () => {
              const now = Date.now()
              if (now - lastStreamNoticeAt < 15_000) return
              lastStreamNoticeAt = now
              emitProgress(t(
                '✍️ response stream active · 正在输出回复。',
                '✍️ response stream active',
              ))
            },
          })
        })
        reply = result.text
        // update session
        const messages = getMessages()
        const updated = {
          ...binding.storedSession,
          cwd: result.cwd ?? binding.storedSession.cwd,
          messages,
          summary: latestCompressionSummary ?? binding.storedSession.summary ?? '',
          updatedAt: new Date().toISOString(),
        }
        await store.save(updated)
        return { replies: [reply], storedSession: updated, permissionMode: binding.permissionMode }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          replies: [t(`错误：${truncate(msg, 400)}`, `Error: ${truncate(msg, 400)}`)],
          storedSession: binding.storedSession,
          permissionMode: binding.permissionMode,
        }
      } finally {
        // Always stop the heartbeat — otherwise it keeps firing after the
        // turn ended and leaks "Still working…" messages into the chat.
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = null
        }
        // Do not send a separate "done" notice here. The caller sends the real
        // final reply after runRemoteCommand returns; a pre-reply completion
        // status is misleading when the model produced an empty reply, hit a
        // blocker, or still needs a follow-up turn.
      }
    }
  }
}

// ─── message pump ─────────────────────────────────────────────────────────────

type PollBatch<TCheckpoint> = {
  messages: BragiInboundMessage[]
  checkpoint?: TCheckpoint
}

type BridgeInboxEntry<TCheckpoint> = {
  message: BragiInboundMessage
  checkpoint?: TCheckpoint
  capturedAt: string
}

function bridgeInboxMessageKey(message: BragiInboundMessage): string {
  return message.sourceMessageId
    ? `${message.targetId}:${message.sourceMessageId}`
    : `${message.targetId}:${message.text}`
}

function bridgeInboxEntryKey(entry: BridgeInboxEntry<unknown>): string {
  return bridgeInboxMessageKey(entry.message)
}

type AuthorizationResult = {
  allowed: boolean
  preReplies?: string[]
}

type ActiveBridgeTask = {
  targetId: string
  targetLabel: string
  startedAt: number
  sessionId?: string
  pendingUserMessages: string[]
  promise: Promise<void>
}

export type RunBragiMessagePumpOptions<TCheckpoint> = {
  channelLabel: string
  locale: UiLocale
  cwd: string
  /** Stable non-secret identity for cross-workspace bridge locking. */
  bridgeIdentity?: string
  sessionStore: SessionStore
  maxTurns: number
  commandSuffixPattern?: RegExp
  onInfo?: (message: string) => void
  /** Called with structured notifications for the live terminal REPL. */
  onNotify?: (payload: BridgeTerminalEvent) => void
  signal?: AbortSignal
  poll(): Promise<PollBatch<TCheckpoint>>
  commitCheckpoint?(checkpoint: TCheckpoint): Promise<void>
  authorizeMessage(msg: BragiInboundMessage, cmd: RemoteCommand): Promise<AuthorizationResult>
  resolveSessionBinding(msg: BragiInboundMessage): Promise<BragiSessionBinding>
  persistRuntimeResult(msg: BragiInboundMessage, result: RemoteRuntimeResult): Promise<void>
  sendMessage(targetId: string, text: string): Promise<void>
}

function isBridgeConfirmationReply(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return ['确认', '同意', '继续', '是', 'yes', 'y', 'ok', 'okay', 'continue'].includes(normalized)
}

function isBridgeStopReply(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return ['/stop', 'stop', '停止', '中止', '终止', '打断', '取消', 'cancel', 'interrupt'].includes(normalized)
}

async function enqueueBridgeInterjection(options: {
  sessionStore: SessionStore
  targetSessionId?: string
  message: BragiInboundMessage
  parsed: RemoteCommand
  platform: BridgePlatform
  onInfo?: (message: string) => void
}): Promise<number> {
  const text = options.parsed.body.trim()
  if (!text) return 0
  const runtimeDirectory = new RuntimeDirectoryService(options.sessionStore)
  let queued = 0
  try {
    const sessions = await options.sessionStore.list()
    for (const session of sessions) {
      if (options.targetSessionId && session.id !== options.targetSessionId) continue
      for (const runtime of session.taskRuntimes ?? []) {
        if (!isTaskRuntimeActiveStatus(runtime.status)) continue
        const result = await runtimeDirectory.notifyRuntime(runtime.id, text, {
          source: 'bridge_interjection',
          platform: options.platform,
          targetId: options.message.targetId,
          sourceMessageId: options.message.sourceMessageId ?? '',
        })
        if (result.found && result.changed) queued += 1
      }
    }
  } catch (err) {
    options.onInfo?.(`[${options.platform}] failed to queue bridge interjection: ${err instanceof Error ? err.message : String(err)}`)
  }
  return queued
}

async function interruptBridgeRuntimes(options: {
  sessionStore: SessionStore
  targetSessionId?: string
  onInfo?: (message: string) => void
}): Promise<number> {
  const runtimeDirectory = new RuntimeDirectoryService(options.sessionStore)
  let interrupted = 0
  try {
    const sessions = await options.sessionStore.list()
    for (const session of sessions) {
      if (options.targetSessionId && session.id !== options.targetSessionId) continue
      for (const runtime of session.taskRuntimes ?? []) {
        if (!isTaskRuntimeActiveStatus(runtime.status)) continue
        const result = await runtimeDirectory.interruptRuntime(runtime.id)
        if (result.found && result.changed) interrupted += 1
      }
    }
  } catch (err) {
    options.onInfo?.(`[bridge] failed to interrupt active runtimes: ${err instanceof Error ? err.message : String(err)}`)
  }
  return interrupted
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type BridgeLockInfo = {
  pid: number
  hostname: string
  platform: BridgePlatform
  cwd?: string
  identity?: string
  startedAt: string
}

function normalizeLockToken(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96) || 'default'
}

function bridgeLockPath(cwd: string, platform: BridgePlatform, identity?: string): string {
  if (identity) {
    return path.join(resolveArtemisHomeDir(), 'bridge-locks', `bridge-lock-${platform}-${normalizeLockToken(identity)}.json`)
  }
  return path.join(resolveDataRootDir(cwd), `bridge-lock-${platform}.json`)
}

export function buildBridgeIdentity(platform: BridgePlatform, secretOrEndpoint: string): string {
  const digest = createHash('sha256').update(`${platform}:${secretOrEndpoint}`).digest('hex').slice(0, 16)
  return `${platform}-${digest}`
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
        ? err.code
        : undefined
    return code === 'EPERM'
  }
}

async function readBridgeLock(cwd: string, platform: BridgePlatform, identity?: string): Promise<BridgeLockInfo | undefined> {
  try {
    const raw = await readFile(bridgeLockPath(cwd, platform, identity), 'utf8')
    const parsed = JSON.parse(raw) as Partial<BridgeLockInfo>
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' &&
      parsed.platform === platform &&
      typeof parsed.startedAt === 'string'
    ) {
      return parsed as BridgeLockInfo
    }
  } catch {
    return undefined
  }
  return undefined
}

async function tryAcquireBridgeLock(
  cwd: string,
  platform: BridgePlatform,
  identity?: string,
  onInfo?: (message: string) => void,
  onBlocked?: (message: string) => void,
): Promise<(() => Promise<void>) | undefined> {
  const p = bridgeLockPath(cwd, platform, identity)
  await ensureDir(path.dirname(p))

  const writeLock = async (): Promise<() => Promise<void>> => {
    const info: BridgeLockInfo = {
      pid: process.pid,
      hostname: hostname(),
      platform,
      cwd,
      identity,
      startedAt: new Date().toISOString(),
    }
    const handle = await open(p, 'wx')
    try {
      await handle.writeFile(JSON.stringify(info, null, 2), 'utf8')
    } finally {
      await handle.close()
    }

    return async () => {
      const current = await readBridgeLock(cwd, platform, identity)
      if (current?.pid !== process.pid) return
      await unlink(p).catch(() => {})
    }
  }

  try {
    return await writeLock()
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
        ? err.code
        : undefined
    if (code !== 'EEXIST') throw err
  }

  const existing = await readBridgeLock(cwd, platform, identity)
  if (!existing || !isProcessRunning(existing.pid)) {
    await unlink(p).catch(() => {})
    return writeLock()
  }

  const takeoverDisabled = process.env.ARTEMIS_BRIDGE_LOCK_MODE === 'passive'

  // In passive mode (background daemon whose bridge was taken over by a CLI),
  // silently yield — no warnings needed; the user's terminal has it covered.
  if (takeoverDisabled) {
    return undefined
  }

  if (existing.pid !== process.pid) {
    const repairMessage = pickLocale(DEFAULT_UI_LOCALE, {
      zh: `[${platform}] 从后台服务接管通讯桥...`,
      en: `[${platform}] Taking over from background daemon...`,
    })
    onInfo?.(repairMessage)
    try {
      process.kill(existing.pid, 'SIGTERM')
      for (let i = 0; i < 20; i += 1) {
        await wait(150)
        if (!isProcessRunning(existing.pid)) break
      }
      if (!isProcessRunning(existing.pid)) {
        await unlink(p).catch(() => {})
        return writeLock()
      }
    } catch {
      // Fall through to the localized blocked message below.
    }
  }

  const blockedMessage = pickLocale(DEFAULT_UI_LOCALE, {
    zh: `[${platform}] 通讯桥由另一个进程 (PID ${existing.pid}) 管理中。`,
    en: `[${platform}] bridge managed by another process (PID ${existing.pid}).`,
  })
  onInfo?.(blockedMessage)
  onBlocked?.(blockedMessage)
  return undefined
}

function bridgeInboxPath(cwd: string, channelLabel: string, identity?: string): string {
  const identityHash = createHash('sha256').update(identity || channelLabel).digest('hex').slice(0, 16)
  return path.join(resolveDataRootDir(cwd), 'bridge-inbox', `${channelLabel.toLowerCase()}-${identityHash}.json`)
}

async function loadBridgeInbox<TCheckpoint>(
  cwd: string,
  channelLabel: string,
  identity?: string,
): Promise<BridgeInboxEntry<TCheckpoint>[]> {
  try {
    const raw = await readFile(bridgeInboxPath(cwd, channelLabel, identity), 'utf-8')
    const parsed = JSON.parse(raw) as { entries?: BridgeInboxEntry<TCheckpoint>[] }
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

async function saveBridgeInbox<TCheckpoint>(
  cwd: string,
  channelLabel: string,
  identity: string | undefined,
  entries: BridgeInboxEntry<TCheckpoint>[],
): Promise<void> {
  const filePath = bridgeInboxPath(cwd, channelLabel, identity)
  await ensureDir(path.dirname(filePath))
  await writeFile(filePath, JSON.stringify({ version: 1, entries }, null, 2), 'utf-8')
}

async function clearBridgeInbox(cwd: string, channelLabel: string, identity?: string): Promise<void> {
  await rm(bridgeInboxPath(cwd, channelLabel, identity), { force: true })
}

export async function runBragiMessagePump<TCheckpoint>(
  options: RunBragiMessagePumpOptions<TCheckpoint>
): Promise<void> {
  const bridgePlatform = bridgePlatformFromLabel(options.channelLabel)
  const releaseBridgeLock = await tryAcquireBridgeLock(
    options.cwd,
    bridgePlatform,
    options.bridgeIdentity,
    options.onInfo,
    (message) => options.onNotify?.({
      kind: 'bridge-status',
      platform: bridgePlatform,
      targetLabel: 'system',
      text: message,
      level: 'warn',
    }),
  )
  if (!releaseBridgeLock) return

  const activeTargets = new Map<string, ActiveBridgeTask>()
  const confirmationWaiters = new Map<string, {
    resolve: (allowed: boolean) => void
    timer: NodeJS.Timeout
  }>()
  const recentlyProcessed = new Set<string>()
  const recentlyProcessedOrder: string[] = []
  let firstInboundConfirmed = false
  let stopped = false

  const stop = () => { stopped = true }
  const onAbort = () => { stopped = true }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (!stopped) {
      let batch: PollBatch<TCheckpoint>
      try {
        batch = await options.poll()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        options.onInfo?.(buildPanel(
          `${options.channelLabel} polling error`, [truncate(msg, 300)]
        ))
        await wait(2_000)
        continue
      }

      const polledEntries: BridgeInboxEntry<TCheckpoint>[] = batch.messages.map((message) => ({
        message,
        checkpoint: batch.checkpoint,
        capturedAt: new Date().toISOString(),
      }))
      let inboxEntries = await loadBridgeInbox<TCheckpoint>(options.cwd, options.channelLabel, options.bridgeIdentity)
      if (polledEntries.length > 0) {
        const merged = new Map<string, BridgeInboxEntry<TCheckpoint>>()
        for (const entry of inboxEntries) merged.set(bridgeInboxEntryKey(entry), entry)
        for (const entry of polledEntries) merged.set(bridgeInboxEntryKey(entry), entry)
        inboxEntries = [...merged.values()]
        await saveBridgeInbox(options.cwd, options.channelLabel, options.bridgeIdentity, inboxEntries)
      }

      // Commit the remote checkpoint only after the inbound batch has been
      // durably captured in a local inbox. If the process crashes during AI
      // handling, restart will replay the inbox instead of losing phone input.
      if (batch.checkpoint !== undefined) {
        await options.commitCheckpoint?.(batch.checkpoint)
      }

      const acknowledgeInboxEntry = async (key: string): Promise<void> => {
        inboxEntries = inboxEntries.filter((entry) => bridgeInboxEntryKey(entry) !== key)
        if (inboxEntries.length > 0) {
          await saveBridgeInbox(options.cwd, options.channelLabel, options.bridgeIdentity, inboxEntries)
        } else {
          await clearBridgeInbox(options.cwd, options.channelLabel, options.bridgeIdentity)
        }
      }

      for (const inboxEntry of inboxEntries) {
        const message = inboxEntry.message
        const inboxKey = bridgeInboxEntryKey(inboxEntry)
        // Bridge inbound message counts as user activity → reset dream-system
        // idle clock so we don't dream while a chat conversation is happening.
        void (async () => {
          try {
            const { markActivity } = await import('../services/idleWatcher.js')
            markActivity()
          } catch { /* ignore */ }
        })()

        const dedupeKey = message.sourceMessageId
          ? `${message.targetId}:${message.sourceMessageId}`
          : undefined
        if (dedupeKey) {
          if (recentlyProcessed.has(dedupeKey)) {
            // If the original task is still running, keep the inbox entry on
            // disk so a crash can replay it. It will be acknowledged by the
            // original task's finally block after safe completion.
            if (activeTargets.has(message.targetId)) continue
            await acknowledgeInboxEntry(inboxKey)
            continue
          }
          recentlyProcessed.add(dedupeKey)
          recentlyProcessedOrder.push(dedupeKey)
          while (recentlyProcessedOrder.length > 500) {
            const old = recentlyProcessedOrder.shift()
            if (old) recentlyProcessed.delete(old)
          }
        }

        const parsed = parseRemoteCommand(message.text, {
          commandSuffixPattern: options.commandSuffixPattern,
          images: message.images,
        })

        const pendingConfirmation = confirmationWaiters.get(message.targetId)
        if (pendingConfirmation) {
          clearTimeout(pendingConfirmation.timer)
          confirmationWaiters.delete(message.targetId)
          const allowed = isBridgeConfirmationReply(message.text)
          const confirmationAck = pickLocale(options.locale, {
            zh: allowed ? '✓ 已收到确认，继续执行。' : '已收到回复，本次操作已暂停。',
            en: allowed ? '✓ Confirmation received; continuing.' : 'Reply received; this operation has been paused.',
          })
          options.onInfo?.(`[${options.channelLabel.toLowerCase()}] confirmation ${allowed ? 'accepted' : 'declined'} from ${message.targetLabel}`)
          options.onNotify?.({
            kind: 'bridge-status',
            platform: bridgePlatform,
            targetLabel: compactLabel(message.targetLabel),
            text: confirmationAck,
            level: allowed ? 'info' : 'warn',
          })
          try {
            await options.sendMessage(message.targetId, confirmationAck)
          } catch (err) {
            options.onInfo?.(`[${options.channelLabel.toLowerCase()}] failed to send confirmation ack: ${err instanceof Error ? err.message : String(err)}`)
          }
          pendingConfirmation.resolve(allowed)
          await acknowledgeInboxEntry(inboxKey)
          continue
        }

        const runningTask = activeTargets.get(message.targetId)
        if (runningTask) {
          if (isBridgeStopReply(message.text) || parsed.type === 'stop') {
            const interrupted = await interruptBridgeRuntimes({
              sessionStore: options.sessionStore,
              targetSessionId: runningTask.sessionId,
              onInfo: options.onInfo,
            })
            await options.sendMessage(
              message.targetId,
              pickLocale(options.locale, {
                zh: interrupted > 0 ? `✓ 已发送中断信号（${interrupted} 个运行中任务）。` : '✓ 已收到停止请求；当前任务会尽快停下。',
                en: interrupted > 0 ? `✓ Interrupt signal sent (${interrupted} active runtime(s)).` : '✓ Stop request received; the current task will stop as soon as possible.',
              }),
            )
            await acknowledgeInboxEntry(inboxKey)
            continue
          }

          runningTask.pendingUserMessages.push(parsed.body)
          const queued = await enqueueBridgeInterjection({
            sessionStore: options.sessionStore,
            targetSessionId: runningTask.sessionId,
            message,
            parsed,
            platform: bridgePlatform,
            onInfo: options.onInfo,
          })
          await options.sendMessage(
            message.targetId,
            pickLocale(options.locale, {
              zh: queued > 0
                ? `✓ 已插话给当前任务（已注入当前对话；${queued} 个运行中任务也会读取）。`
                : '✓ 已收到插话，已注入当前运行中的对话。',
              en: queued > 0
                ? `✓ Interjection injected into the current chat; ${queued} active runtime(s) will also read it.`
                : '✓ Interjection received and injected into the current running chat.',
            }),
          )
          await acknowledgeInboxEntry(inboxKey)
          continue
        }

        const auth = await options.authorizeMessage(message, parsed)
        if (!auth.allowed) {
          for (const reply of auth.preReplies ?? []) {
            await options.sendMessage(message.targetId, reply)
          }
          await acknowledgeInboxEntry(inboxKey)
          continue
        }

        const activeTask: ActiveBridgeTask = {
          targetId: message.targetId,
          targetLabel: message.targetLabel,
          startedAt: Date.now(),
          pendingUserMessages: [],
          promise: Promise.resolve(),
        }
        activeTargets.set(message.targetId, activeTask)
        activeTask.promise = (async () => {
        try {
          const compactTargetLabel = compactLabel(message.targetLabel)
          const sendProgress = async (
            text: string,
            level: 'info' | 'warn' | 'error' = 'info',
          ): Promise<void> => {
            const cleanText = text.replace(/\s+$/g, '')
            if (!cleanText.trim()) return
            options.onNotify?.({
              kind: 'bridge-status',
              platform: bridgePlatform,
              targetLabel: compactTargetLabel,
              text: cleanText,
              level,
            })
          }

          options.onInfo?.(buildPanel(
            `${options.channelLabel} inbound`,
            [`[${options.channelLabel.toLowerCase()}] ${message.targetLabel} → ${truncate(message.text, 200)}`]
          ))
          options.onNotify?.({
            kind: 'bridge-message',
            platform: bridgePlatform,
            direction: 'inbound',
            targetLabel: compactTargetLabel,
            text: message.text,
          })

          for (const reply of auth.preReplies ?? []) {
            await options.sendMessage(message.targetId, reply)
          }

          const binding = await options.resolveSessionBinding(message)
          activeTask.sessionId = binding.storedSession.id
          if (binding.rolledOver) {
            options.onInfo?.(`[${options.channelLabel.toLowerCase()}] session rolled over for ${message.targetLabel}`)
          }

          const result = await runRemoteCommand(parsed, {
            binding,
            store: options.sessionStore,
            locale: options.locale,
            cwd: options.cwd,
            maxTurns: options.maxTurns,
            onProgress: sendProgress,
            sendChatUpdate: async (text) => {
              const trimmed = text.trim()
              if (!trimmed) return
              try {
                await options.sendMessage(message.targetId, trimmed)
              } catch (err) {
                options.onInfo?.(`[${options.channelLabel.toLowerCase()}] sendChatUpdate failed: ${err instanceof Error ? err.message : String(err)}`)
              }
            },
            awaitUserConfirmation: async ({ timeoutMs }) => {
              const existing = confirmationWaiters.get(message.targetId)
              if (existing) {
                clearTimeout(existing.timer)
                existing.resolve(false)
              }
              return await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => {
                  confirmationWaiters.delete(message.targetId)
                  resolve(false)
                }, timeoutMs)
                confirmationWaiters.set(message.targetId, { resolve, timer })
              })
            },
            pollRunningUserMessages: () => activeTask.pendingUserMessages.splice(0),
            onRunningUserMessageAccepted: (text) => {
              options.onInfo?.(`[${options.channelLabel.toLowerCase()}] running interjection accepted from ${message.targetLabel}: ${truncate(text, 200)}`)
            },
            bridgePlatform: bridgePlatform === 'cli' ? undefined : bridgePlatform,
            targetId: message.targetId,
          })

          activeTask.sessionId = result.storedSession.id

          await options.persistRuntimeResult(message, result)

          for (const reply of result.replies) {
            if (!reply.trim()) continue
            const mobileReply = formatMobileReply(reply)
            if (!mobileReply) continue
            try {
              await options.sendMessage(message.targetId, mobileReply)
            } catch (sendErr: unknown) {
              const sendFailure = sendErr instanceof Error ? sendErr.message : String(sendErr)
              const detail = `[${options.channelLabel.toLowerCase()}] failed to send final reply to ${compactTargetLabel} (${mobileReply.length} chars): ${truncate(sendFailure, 500)}`
              options.onInfo?.(detail)
              options.onNotify?.({
                kind: 'bridge-status',
                platform: bridgePlatform,
                targetLabel: compactTargetLabel,
                text: detail,
                level: 'error',
              })
              continue
            }
            options.onInfo?.(buildPanel(
              `${options.channelLabel} outbound`,
              [`[${options.channelLabel.toLowerCase()}] Artemis sent final reply (${mobileReply.length} chars)`]
            ))
            options.onNotify?.({
              kind: 'bridge-message',
              platform: bridgePlatform,
              direction: 'outbound',
              targetLabel: compactTargetLabel,
              text: mobileReply,
            })
          }

          if (!firstInboundConfirmed) {
            firstInboundConfirmed = true
            options.onInfo?.(buildPanel(
              `${options.channelLabel} test successful`,
              [
                pickLocale(options.locale, {
                  zh: `恭喜！${options.channelLabel} 通讯桥已配置完成。`,
                  en: `Success! Your ${options.channelLabel} bridge is fully connected.`,
                })
              ]
            ))
          }
        } catch (err: unknown) {
          const failure = err instanceof Error ? err.message : String(err)
          const sendFailure = /sendMessage failed|failed to send/i.test(failure)
          if (!sendFailure) {
            try {
              await options.sendMessage(message.targetId, `${options.channelLabel} error: ${truncate(failure, 500)}`)
            } catch (sendErr: unknown) {
              options.onInfo?.(`[${options.channelLabel.toLowerCase()}] failed to send error reply: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`)
            }
          }
          // Also notify CLI window about the error
          if (sendFailure) {
            options.onNotify?.({
              kind: 'bridge-status',
              platform: options.channelLabel.toLowerCase() as 'telegram' | 'discord' | 'wechat',
              targetLabel: compactLabel(message.targetLabel),
              text: `${options.channelLabel} error: ${truncate(failure, 1200)}`,
              level: 'error',
            })
          } else {
            options.onNotify?.({
              kind: 'bridge-message',
              platform: options.channelLabel.toLowerCase() as 'telegram' | 'discord' | 'wechat',
              direction: 'outbound',
              targetLabel: compactLabel(message.targetLabel),
              text: `${options.channelLabel} error: ${truncate(failure, 1200)}`,
            })
          }
        } finally {
          if (activeTargets.get(message.targetId) === activeTask) {
            activeTargets.delete(message.targetId)
          }
          await acknowledgeInboxEntry(inboxKey)
        }
        })()
      }

    }
  } finally {
    for (const waiter of confirmationWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    confirmationWaiters.clear()
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    options.signal?.removeEventListener('abort', onAbort)
    await releaseBridgeLock()
  }
}
