/**
 * cli/wordup.ts — WordUP session snapshot and resume tooling
 *
 * `artemis wordup` — list saved sessions, inspect, or delete them.
 * `artemis resume [id]` — resume the latest or a specific session.
 */

import { buildPanel } from './ui.js'
import { SessionStore } from '../storage/sessions.js'
import type { SessionRecord, SessionMessage } from '../core/types.js'
import type { UiLocale } from './locale.js'
import { pickLocale } from './locale.js'

/**
 * wordupNow — immediately snapshot the current session to disk.
 *
 * Call this before any action that clears or replaces the active session
 * (model switch, /clear, /config, /newborn, process exit).
 *
 * Returns the saved SessionRecord so the caller can update its reference.
 */
export async function wordupNow(opts: {
  store: SessionStore
  storedSession: SessionRecord | null
  messages: SessionMessage[]
  /** Optional: override the session title for the snapshot */
  titleHint?: string
}): Promise<SessionRecord | null> {
  const { store, storedSession, messages, titleHint } = opts
  if (messages.length === 0) return storedSession  // nothing to save

  let session: SessionRecord
  if (storedSession) {
    session = {
      ...storedSession,
      ...(titleHint ? { title: titleHint } : {}),
      messages,
      updatedAt: new Date().toISOString(),
    }
  } else {
    session = Object.assign(
      store.createSession({ title: titleHint }),
      { messages, updatedAt: new Date().toISOString() },
    )
  }

  await store.save(session).catch(() => { /* non-fatal */ })
  return session
}

export async function runWordup(opts: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = opts
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  const store = new SessionStore(cwd)
  const sessions = await store.list()

  if (sessions.length === 0) {
    console.log()
    console.log(buildPanel(
      t('WordUP 会话快照', 'WordUP Session Snapshots'),
      [t('暂无保存的会话。', 'No saved sessions found.')]
    ))
    console.log()
    return
  }

  const header = `${'ID'.padEnd(10)}  ${'Updated'.padEnd(16)}  ${'Tokens'.padEnd(8)}  Title`
  const divider = '─'.repeat(header.length)
  const rows = sessions.slice(0, 30).map(s => formatSessionRow(s))

  console.log()
  console.log(buildPanel(
    t(`WordUP 会话快照 (${sessions.length})`, `WordUP Session Snapshots (${sessions.length})`),
    [header, divider, ...rows]
  ))
  console.log()
  console.log(t(
    '  运行 artemis resume <id> 来恢复某个会话。',
    '  Run artemis resume <id> to resume a session.'
  ))
  console.log()
}

export async function loadResumeSession(opts: {
  cwd: string
  sessionId?: string
  resumeLast?: boolean
  locale: UiLocale
}): Promise<SessionRecord | null> {
  const { cwd, sessionId, resumeLast, locale } = opts
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  const store = new SessionStore(cwd)

  let session: SessionRecord | undefined

  if (sessionId) {
    session = await store.load(sessionId)
    if (!session) {
      // Try prefix match
      const all = await store.list()
      session = all.find(s => s.id.startsWith(sessionId))
    }
    if (!session) {
      console.log()
      console.log(buildPanel(t('未找到会话', 'Session not found'), [`ID: ${sessionId}`]))
      console.log()
      return null
    }
  } else if (resumeLast) {
    session = await store.loadLatest() ?? undefined
    if (!session) {
      console.log()
      console.log(buildPanel(
        t('无可恢复会话', 'No session to resume'),
        [t('没有保存的会话记录。', 'No saved sessions found.')]
      ))
      console.log()
      return null
    }
  } else {
    return null
  }

  console.log()
  console.log(buildPanel(
    t('正在恢复会话', 'Resuming session'),
    [
      `ID: ${session.id}`,
      t(`标题: ${session.title}`, `Title: ${session.title}`),
      t(`消息数: ${session.messages.length}`, `Messages: ${session.messages.length}`),
      t(`Token 用量: ${session.messages.length}`, `Tokens used: ${session.messages.length}`),
      t(`最后更新: ${session.updatedAt.slice(0, 16).replace('T', ' ')}`, `Last updated: ${session.updatedAt.slice(0, 16).replace('T', ' ')}`),
    ]
  ))
  console.log()

  return session
}

function formatSessionRow(s: SessionRecord): string {
  const id = s.id.slice(0, 8).padEnd(10)
  const updated = s.updatedAt.slice(0, 16).replace('T', ' ').padEnd(16)
  const tokens = String(s.messages.length).padEnd(8)
  const title = s.title.slice(0, 50)
  return `${id}  ${updated}  ${tokens}  ${title}`
}
