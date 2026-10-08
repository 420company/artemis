import type { SessionMessage } from '../core/types.js'

/** Name of the per-run context message runAgent appends after the history. */
export const RUNTIME_CONTEXT_MESSAGE_NAME = 'runtime_context'

/**
 * Split off the trailing per-run context messages. Adapters attach images
 * and cache breakpoints to the newest real message, so the ephemeral
 * context (re-sent, possibly different, on every run) never becomes part of
 * a cached prefix or carries the user's images.
 */
export function splitTrailingRuntimeContext(messages: readonly SessionMessage[]): [SessionMessage[], SessionMessage[]] {
  let end = messages.length
  while (end > 0 && messages[end - 1]!.name === RUNTIME_CONTEXT_MESSAGE_NAME) end -= 1
  return [messages.slice(0, end), messages.slice(end)]
}
