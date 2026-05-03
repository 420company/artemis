import type { RitualLocale, RitualProposal } from './types.js';
type CommonField = 'design' | 'literature' | 'market';
export interface FieldFamily {
    field: CommonField;
    family: string;
    rationale: string;
}
export declare function buildFieldFamily(input: string, proposal: RitualProposal | null | undefined, locale: RitualLocale, options?: {
    override?: string;
}): FieldFamily | undefined;
export {};
//# sourceMappingURL=field-family.d.ts.map