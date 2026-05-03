export interface DreamVizFragment {
    order: number;
    logic: string;
    text: string;
    imagePath?: string;
}
export interface DreamVizRecord {
    id: string;
    stage: string;
    preset: string;
    dreamedAt: string;
    wakingLine: string;
    imagePaths: Record<number, string>;
    fragments: DreamVizFragment[];
}
export declare function parseDreamMarkdownForViz(markdown: string): DreamVizRecord | null;
//# sourceMappingURL=dream-viz-parser.d.ts.map