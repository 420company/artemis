import type { DesignTokenSet } from './design-color-lexicon.js';
export interface DesignReading {
    discipline: 'design';
    locale: 'en' | 'zh';
    thesis: string;
    primarySystem: string | null;
    paletteStrategy: string;
    materialRegister: string;
    compositionMoves: string[];
    motionPrinciples: string[];
    tensions: string[];
    antiGoals: string[];
    accidentalMessage: string;
    nextMove: string;
    tokens: DesignTokenSet | null;
}
export declare function readDesignIntent(input: string): DesignReading;
export declare function renderDesignReading(reading: DesignReading): string;
//# sourceMappingURL=design-engine.d.ts.map