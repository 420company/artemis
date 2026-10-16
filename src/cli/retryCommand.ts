/**
 * retryCommand.ts — Q5: standalone `artemis retry` command.
 *
 * The interactive CLI already has `/retry` and headless `execute` has
 * `--retry`, but there was no user-facing standalone command to re-run the
 * last exchange of a session from the shell. This fills that gap:
 *
 *   artemis retry [--session <id>] [--model <m>] [--max-turns <n>] [--json]
 *
 * It finds the most recent session (or the given one), takes the last
 * user→assistant exchange out, and runs the agent again with the same
 * message — exactly what `execute --retry --session <id>` does, without
 * requiring the caller to know the session id or the flag spelling.
 *
 * Implementation delegates to the existing headless retry path in
 * services/headlessAgent.ts via runHeadlessAgent, so behavior stays identical
 * to `--retry` (attachment re-resolution, SessionRewindError on changed
 * exchanges, etc.).
 */

import { runHeadlessAgent, type HeadlessAgentOptions, type HeadlessAgentResult } from '../services/headlessAgent.js'
import { SessionStore } from '../storage/sessions.js'
import { lastOwnerMessageIndex } from '../storage/sessionTurns.js'

export interface RetryCommandOptions {
  cwd: string
  /** When omitted, the most recently active session is used [已修复 L3]. */
  sessionId?: string
  /** Forwarded to the agent run. */
  model?: string
  maxTurns?: number
  /** Progress lines and events of the run, as `execute` forwards them. */
  onInfo?: HeadlessAgentOptions['onInfo']
  /** Headless approvals, as `execute` passes them (suspend at an approval request). */
  approvals?: HeadlessAgentOptions['approvals']
}

export interface RetryCommandResult {
  ok: boolean
  sessionId: string
  /** The user message that was re-run [已修复 L2: filled with the actual value]. */
  retriedPrompt: string
  message: string
  /** The agent's reply to the re-run message. */
  reply: string
  turns: number
  durationMs: number
  /** Set when the run stopped at an approval request. */
  approval?: HeadlessAgentResult['approval']
  contextNotices: string[]
}

/** Truncate a prompt for display; never let a huge message flood the terminal. */
function snippet(text: string, maxLen = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine
}

/**
 * Re-run the last exchange of a session headlessly.
 * Returns a result object; throws only on unrecoverable setup errors
 * (no sessions at all, session not found).
 */
export async function runRetryCommand(options: RetryCommandOptions): Promise<RetryCommandResult> {
  const { cwd } = options
  const store = new SessionStore(cwd)

  let sessionId = options.sessionId
  if (!sessionId) {
    // [已修复 L3] loadLatest() resolves to the root session for agent
    // sub-sessions instead of blindly taking list()[0].
    const latest = await store.loadLatest()
    if (!latest) {
      throw new Error('No sessions found. Start a conversation first, then retry.')
    }
    sessionId = latest.id
  } else {
    // Fail fast with a clear message instead of a confusing downstream error.
    const existing = await store.load(sessionId).catch(() => null)
    if (!existing) {
      throw new Error(`Session not found: ${sessionId}`)
    }
  }

  // [已修复 L2] Read the actual last user message BEFORE retrying, so the
  // result reports what was really re-run (retry mode itself re-reads it).
  let retriedPrompt = ''
  try {
    const session = await store.load(sessionId)
    const messages = session?.messages ?? []
    // The owner's own message, not a runtime note kept after it.
    const index = lastOwnerMessageIndex(messages)
    if (index >= 0) retriedPrompt = snippet(messages[index]!.content)
  } catch {
    // Best-effort only: the retry itself is authoritative.
  }

  // Delegate to the existing headless retry implementation. The prompt is
  // empty: retry mode re-reads the message from the session.
  const result = await runHeadlessAgent(cwd, '', {
    sessionId,
    retry: true,
    ...(options.model ? { model: options.model } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.onInfo ? { onInfo: options.onInfo } : {}),
    ...(options.approvals ? { approvals: options.approvals } : {}),
  })

  return {
    ok: true,
    sessionId: result.sessionId || sessionId,
    retriedPrompt,
    message: `Retried last exchange of session ${sessionId}.`,
    reply: result.reply,
    turns: result.turns,
    durationMs: result.durationMs,
    ...(result.approval ? { approval: result.approval } : {}),
    contextNotices: result.contextNotices,
  }
}
