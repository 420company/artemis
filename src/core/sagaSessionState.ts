/**
 * Saga state of a stored session (web / `artemis execute` runs).
 *
 * A confirmed Saga conversation is recorded in the session's metadata with
 * a timestamp (services/headlessWorkflow.ts), never as a marker in the
 * stored user message. core/agent.ts reads it for the generate_video →
 * generate_long_video safety reroute, which therefore applies only while a
 * Saga is active and recent, not for the rest of the session.
 */
import type { SessionRecord } from './types.js';

export const SAGA_SESSION_TTL_MS = 30 * 60 * 1000;

export type WorkflowRoutingState = {
  /** A Saga question is waiting for yes / no. */
  sagaOffer?: { text: string; at: number };
  /** Saga was confirmed (or continued) at this time; cleared when it ends. */
  sagaActiveAt?: number;
};

export function readWorkflowRoutingState(session: Pick<SessionRecord, 'metadata'>): WorkflowRoutingState {
  const raw = session.metadata?.workflowRouting;
  return raw && typeof raw === 'object' ? { ...(raw as WorkflowRoutingState) } : {};
}

export function writeWorkflowRoutingState(session: Pick<SessionRecord, 'metadata'>, state: WorkflowRoutingState): void {
  const clean: WorkflowRoutingState = {};
  if (state.sagaOffer) clean.sagaOffer = state.sagaOffer;
  if (state.sagaActiveAt) clean.sagaActiveAt = state.sagaActiveAt;
  const metadata = { ...(session.metadata ?? {}) };
  if (clean.sagaOffer || clean.sagaActiveAt) metadata.workflowRouting = clean;
  else delete metadata.workflowRouting;
  session.metadata = metadata;
}

/** True while a confirmed Saga is active in this session (and not older than the TTL). */
export function isSagaSessionActive(session: Pick<SessionRecord, 'metadata'>, now = Date.now()): boolean {
  const at = readWorkflowRoutingState(session).sagaActiveAt;
  return typeof at === 'number' && now - at < SAGA_SESSION_TTL_MS;
}

/** A successful generate_long_video in these messages: the Saga video is done. */
export function hasFinishedLongVideo(messages: ReadonlyArray<{ role?: string; name?: string; content?: unknown }>): boolean {
  return messages.some((message) => {
    if (message.role !== 'tool' || message.name !== 'generate_long_video') return false;
    const content = typeof message.content === 'string' ? message.content : '';
    return /"ok"\s*:\s*true/.test(content);
  });
}
