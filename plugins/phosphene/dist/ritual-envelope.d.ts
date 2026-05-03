import { previewSessionTurn } from './session-runtime.js';
import type { SessionEnvelope, SessionTurn } from './types.js';
export declare function composeSessionEnvelope(turn: SessionTurn): SessionEnvelope;
export declare function renderSessionEnvelope(envelope: SessionEnvelope, options?: {
    full?: boolean;
}): string;
export declare function buildSessionEnvelope(input: string, options?: Parameters<typeof previewSessionTurn>[1]): SessionEnvelope;
//# sourceMappingURL=ritual-envelope.d.ts.map