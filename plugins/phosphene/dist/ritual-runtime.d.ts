import { getContext } from './phosphene.js';
import type { RitualLocale, RitualProposal, RitualResolution } from './types.js';
export declare function buildRitualAtlasBrief(proposal: RitualProposal, { maxDomains }?: {
    maxDomains?: number;
}): string;
export declare function renderRitualThreshold(proposal: RitualProposal, locale?: RitualLocale): string;
export declare function renderRitualCommencement(proposal: RitualProposal, locale?: RitualLocale): string;
export declare function renderRitualDecline(proposal: RitualProposal, locale?: RitualLocale): string;
export declare function initiateRitual(input: string, { locale, persist, currentPreset, }?: {
    locale?: RitualLocale;
    persist?: boolean;
    currentPreset?: ReturnType<typeof getContext>['preset'];
}): RitualResolution;
export declare function resolvePendingRitual(input: string, { locale, persist, includeAtlas, awaken, pending, }?: {
    locale?: RitualLocale;
    persist?: boolean;
    includeAtlas?: boolean;
    awaken?: boolean;
    pending?: RitualProposal | null;
}): RitualResolution;
//# sourceMappingURL=ritual-runtime.d.ts.map