import type { RitualFieldMasterwork, RitualLocale, RitualProposal, SessionStage } from './types.js';
export declare function buildFieldMasterwork(input: string, proposal: RitualProposal | null | undefined, locale: RitualLocale, stage: SessionStage, options?: {
    familyOverride?: string;
    forcedField?: 'design' | 'literature' | 'market';
}): RitualFieldMasterwork | undefined;
//# sourceMappingURL=field-masterwork.d.ts.map