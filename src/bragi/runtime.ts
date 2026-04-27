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

import { think, resetSession, getMessages, restoreSession } from '../brain.js'
import { SessionStore } from '../storage/sessions.js'
import type { SessionRecord } from '../core/types.js'
import type { PermissionMode } from '../cli/parseArgs.js'
import { buildPanel } from '../cli/ui.js'
import type { UiLocale } from '../cli/locale.js'
import { pickLocale } from '../cli/locale.js'
import type { BridgePlatform, BridgeTerminalEvent } from '../cli/bridgeNotify.js'
import { truncate } from '../utils/fs.js'

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
  if (normalized === 'discord') return 'discord'
  if (normalized === 'wechat') return 'wechat'
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

function summarizeToolOutput(output: unknown): string {
  if (typeof output !== 'string') return ''
  const compact = output.replace(/\s+/g, ' ').trim()
  return compact ? ` · ${truncate(compact, 160)}` : ''
}

// ─── types ────────────────────────────────────────────────────────────────────

export type BragiInboundMessage = {
  targetId: string
  targetLabel: string
  text: string
  scope?: string
  images?: import('../providers/types.ts').ImageAttachment[]
}

export type BragiSessionBinding = {
  storedSession: SessionRecord
  permissionMode: PermissionMode
  rolledOver: boolean
}

export type RemoteRuntimeResult = {
  replies: string[]
  storedSession: SessionRecord
  permissionMode: PermissionMode
}

// ─── slash command parser ─────────────────────────────────────────────────────

export type RemoteCommandType = 'start' | 'stop' | 'status' | 'clear' | 'help' | 'chat'

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
  }
): Promise<RemoteRuntimeResult> {
  const { binding, store, locale, cwd } = opts
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })

  // restore session history into brain
  restoreSession(binding.storedSession.messages)

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
            '/start — 初始化会话\n/status — 查看当前状态\n/clear — 重置对话历史\n/help — 显示此帮助\n\n直接发送消息开始对话。',
            '/start — Initialize session\n/status — Show current status\n/clear — Reset conversation\n/help — Show this help\n\nOr just send a message to chat.',
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
      resetSession()
      const fresh = store.createSession({ title: binding.storedSession.title })
      await store.save(fresh)
      return {
        replies: [t('对话历史已清空。', 'Conversation cleared.')],
        storedSession: fresh,
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
      try {
        const emitProgress = (message: string, level: 'info' | 'warn' | 'error' = 'info'): void => {
          void Promise.resolve(opts.onProgress?.(message, level)).catch(() => {})
        }
        const startedText = t(
          '已收到，正在启动模型和工具执行。后续会持续回传关键进度。',
          'Received. Starting the model and tools now; key progress will be sent here.',
        )
        await opts.onProgress?.(startedText, 'info')
        let lastReasoningNoticeAt = 0
        let lastStreamNoticeAt = 0

        // Drive native-tool wiring from the bridge session's permissionMode:
        //   read-only  → disable tools (pure chat). Otherwise the model
        //                emits "let me run pwd" intent text whose call gets
        //                denied, leaving the IM user with a dangling intent
        //                line as the only reply.
        //   accept-*   → enable tools so remote coding via IM works.
        const result = await think(command.body, {
          cwd,
          permissionMode: binding.permissionMode,
          disableNativeTools: binding.permissionMode === 'read-only',
          imageAttachments: command.images,
          maxNativeToolRounds: Math.max(16, (opts.maxTurns ?? 8) * 2),
          onToolCall: (name, args) => {
            emitProgress(t(
              `🔧 正在运行工具：${String(name)}${summarizeToolArgs(args)}`,
              `🔧 Running tool: ${String(name)}${summarizeToolArgs(args)}`,
            ))
          },
          onToolResult: (name, ok, output) => {
            emitProgress(t(
              `${ok ? '✅' : '⚠️'} 工具${ok ? '完成' : '失败'}：${String(name)}${summarizeToolOutput(output)}`,
              `${ok ? '✅' : '⚠️'} Tool ${ok ? 'completed' : 'failed'}: ${String(name)}${summarizeToolOutput(output)}`,
            ), ok ? 'info' : 'warn')
          },
          onToolLog: (message, level = 'info') => {
            emitProgress(message, level)
          },
          onReasoning: () => {
            const now = Date.now()
            if (now - lastReasoningNoticeAt < 15_000) return
            lastReasoningNoticeAt = now
            emitProgress(t(
              '🧠 模型正在思考，还在工作中。',
              '🧠 The model is thinking and still working.',
            ))
          },
          onStream: () => {
            const now = Date.now()
            if (now - lastStreamNoticeAt < 15_000) return
            lastStreamNoticeAt = now
            emitProgress(t(
              '✍️ 正在生成回复。',
              '✍️ Generating the reply.',
            ))
          },
        })
        reply = result.text
        // update session
        const messages = getMessages()
        const updated = { ...binding.storedSession, messages, updatedAt: new Date().toISOString() }
        await store.save(updated)
        return { replies: [reply], storedSession: updated, permissionMode: binding.permissionMode }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          replies: [t(`错误：${truncate(msg, 400)}`, `Error: ${truncate(msg, 400)}`)],
          storedSession: binding.storedSession,
          permissionMode: binding.permissionMode,
        }
      }
    }
  }
}

// ─── message pump ─────────────────────────────────────────────────────────────

type PollBatch<TCheckpoint> = {
  messages: BragiInboundMessage[]
  checkpoint?: TCheckpoint
}

type AuthorizationResult = {
  allowed: boolean
  preReplies?: string[]
}

export type RunBragiMessagePumpOptions<TCheckpoint> = {
  channelLabel: string
  locale: UiLocale
  cwd: string
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

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function runBragiMessagePump<TCheckpoint>(
  options: RunBragiMessagePumpOptions<TCheckpoint>
): Promise<void> {
  const activeTargets = new Set<string>()
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

      // Commit checkpoint immediately after receiving the batch so that a crash
      // during processing does not re-deliver the same messages on the next run.
      if (batch.checkpoint !== undefined) {
        await options.commitCheckpoint?.(batch.checkpoint)
      }

      for (const message of batch.messages) {
        const parsed = parseRemoteCommand(message.text, {
          commandSuffixPattern: options.commandSuffixPattern,
          images: message.images,
        })

        if (activeTargets.has(message.targetId)) {
          await options.sendMessage(
            message.targetId,
            pickLocale(options.locale, {
              zh: '这个会话已经有正在执行的任务，请等当前回复完成后再发送。',
              en: 'This chat already has an active task. Wait for the current reply.',
            })
          )
          continue
        }

        const auth = await options.authorizeMessage(message, parsed)
        if (!auth.allowed) {
          for (const reply of auth.preReplies ?? []) {
            await options.sendMessage(message.targetId, reply)
          }
          continue
        }

        activeTargets.add(message.targetId)
        try {
          const platform = bridgePlatformFromLabel(options.channelLabel)
          const compactTargetLabel = compactLabel(message.targetLabel)
          const sendProgress = async (
            text: string,
            level: 'info' | 'warn' | 'error' = 'info',
          ): Promise<void> => {
            const cleanText = truncate(text.replace(/\s+$/g, ''), 900)
            if (!cleanText.trim()) return
            options.onNotify?.({
              kind: 'bridge-status',
              platform,
              targetLabel: compactTargetLabel,
              text: cleanText,
              level,
            })
            await options.sendMessage(message.targetId, cleanText).catch((sendErr: unknown) => {
              options.onInfo?.(
                `[${options.channelLabel.toLowerCase()}] failed to send progress reply: ${
                  sendErr instanceof Error ? sendErr.message : String(sendErr)
                }`,
              )
            })
          }

          options.onInfo?.(buildPanel(
            `${options.channelLabel} inbound`,
            [`[${options.channelLabel.toLowerCase()}] ${message.targetLabel} → ${truncate(message.text, 200)}`]
          ))
          options.onNotify?.({
            kind: 'bridge-message',
            platform,
            direction: 'inbound',
            targetLabel: compactTargetLabel,
            text: truncate(message.text, 1200),
          })

          for (const reply of auth.preReplies ?? []) {
            await options.sendMessage(message.targetId, reply)
          }

          const binding = await options.resolveSessionBinding(message)
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
          })

          await options.persistRuntimeResult(message, result)

          for (const reply of result.replies) {
            if (!reply.trim()) continue
            await options.sendMessage(message.targetId, reply)
            options.onInfo?.(buildPanel(
              `${options.channelLabel} outbound`,
              [`[${options.channelLabel.toLowerCase()}] Artemis → ${truncate(reply.replace(/\s+/g, ' '), 240)}`]
            ))
            options.onNotify?.({
              kind: 'bridge-message',
              platform,
              direction: 'outbound',
              targetLabel: compactTargetLabel,
              text: truncate(reply.replace(/\s+/g, ' '), 1200),
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
          // Wrap sendMessage so a send failure doesn't crash the pump loop
          try {
            await options.sendMessage(message.targetId, `${options.channelLabel} error: ${truncate(failure, 500)}`)
          } catch (sendErr: unknown) {
            options.onInfo?.(`[${options.channelLabel.toLowerCase()}] failed to send error reply: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`)
          }
          // Also notify CLI window about the error
          options.onNotify?.({
            kind: 'bridge-message',
            platform: options.channelLabel.toLowerCase() as 'telegram' | 'discord' | 'wechat',
            direction: 'outbound',
            targetLabel: compactLabel(message.targetLabel),
            text: `${options.channelLabel} error: ${truncate(failure, 1200)}`,
          })
        } finally {
          activeTargets.delete(message.targetId)
        }
      }

    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
