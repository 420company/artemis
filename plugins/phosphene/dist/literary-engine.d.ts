export interface LiteraryReading {
    discipline: 'literature';
    locale: 'en' | 'zh';
    thesis: string;
    texture: string;
    structure: string;
    symbols: string[];
    turningPoints: string[];
    lineOfForce: string;
    riskOfMisreading: string;
    nextMove: string;
    evidence: string[];
}
export declare function readLiterature(text: string): LiteraryReading;
export declare function renderLiteraryReading(reading: LiteraryReading): string;
//# sourceMappingURL=literary-engine.d.ts.map