export type CommonField = 'design' | 'literature' | 'market';
export interface FieldSpotlight {
    field: CommonField;
    confidence: number;
    rendered: string;
}
export declare function senseCommonField(input: string): Array<{
    field: CommonField;
    confidence: number;
}>;
export declare function buildFieldSpotlight(input: string): FieldSpotlight | null;
export declare function buildForcedFieldSpotlight(input: string, field: CommonField): FieldSpotlight;
//# sourceMappingURL=field-engine.d.ts.map