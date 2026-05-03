import type { RitualFieldComposition, RitualLocale, RitualProposal } from './types.js';
type CommonField = 'design' | 'literature' | 'market';
export declare function buildFieldComposition(input: string, proposal: RitualProposal | null | undefined, locale: RitualLocale, options?: {
    forcedField?: CommonField;
    includeContradiction?: boolean;
}): RitualFieldComposition | undefined;
export {};
//# sourceMappingURL=field-composer.d.ts.map