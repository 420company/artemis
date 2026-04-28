import type { SessionRecord } from '../core/types.js'
import type { SessionStore } from '../storage/sessions.js'

function isMissingSessionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

export async function loadSessionOrCreate(options: {
  sessionStore: SessionStore
  sessionId: string
  title: string
  onRecovered?: (session: SessionRecord) => Promise<void>
}): Promise<{ session: SessionRecord; recovered: boolean }> {
  try {
    return {
      session: await options.sessionStore.load(options.sessionId),
      recovered: false,
    }
  } catch (error) {
    if (!isMissingSessionError(error)) {
      throw error
    }

    const session = options.sessionStore.createSession({ title: options.title })
    await options.sessionStore.save(session)
    await options.onRecovered?.(session)
    return { session, recovered: true }
  }
}
