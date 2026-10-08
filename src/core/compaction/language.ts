/**
 * Conversation language detection for compaction output. The summary, the
 * boundary message and the user notice follow the language the user writes
 * in, so a Chinese conversation is not summarized into English (or the
 * reverse) and later turns stay in the user's language.
 */

import type { SessionMessage } from '../types.js'
import { countCjkChars } from '../tokenEstimation.js'

export type ConversationLanguage = 'zh' | 'en'

/** True for messages the runtime wrote, not the user. */
export function isSyntheticUserMessage(message: SessionMessage): boolean {
  if (message.role !== 'user') return false
  if (message.compaction) return true
  if (message.name === 'runtime_context' || message.name === 'compaction_boundary') return true
  const id = message.id ?? ''
  if (id.startsWith('ctx-') || id.startsWith('compact-') || id.startsWith('recovery-')) return true
  const text = (message.content ?? '').trimStart()
  return text.startsWith('[tool:runtime_guard]') || text.startsWith('[Runtime context')
}

function languageOfText(text: string): ConversationLanguage | undefined {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '')
  if (letters.length === 0) return undefined
  const cjk = countCjkChars(letters)
  return cjk / letters.length >= 0.15 ? 'zh' : 'en'
}

/**
 * Language of the user's most recent real messages (up to `sample`). Falls
 * back to `fallback` when no user text is available.
 */
export function detectConversationLanguage(
  messages: readonly SessionMessage[],
  fallback: ConversationLanguage = 'en',
  sample = 6,
): ConversationLanguage {
  const texts: string[] = []
  for (let i = messages.length - 1; i >= 0 && texts.length < sample; i -= 1) {
    const message = messages[i]!
    if (message.role !== 'user' || isSyntheticUserMessage(message)) continue
    const text = (message.content ?? '').slice(0, 2_000)
    if (text.trim()) texts.push(text)
  }
  if (texts.length === 0) return fallback
  return languageOfText(texts.join('\n')) ?? fallback
}
