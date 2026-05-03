export type KnowledgeDomain = 'design' | 'color' | 'structure' | 'stream' | 'creativity' | 'finance' | 'crypto' | 'persona' | 'protocols';
export interface KnowledgeSource {
    id: string;
    domain: KnowledgeDomain;
    title: string;
    publisher: string;
    url: string;
    kind: 'standard' | 'framework' | 'research' | 'reference' | 'docs';
}
export interface KnowledgeNote {
    id: string;
    domain: KnowledgeDomain;
    label: string;
    summary: string;
    application: string;
    keywords: string[];
    sourceIds: string[];
}
export declare function listKnowledgeDomains(): KnowledgeDomain[];
export declare function getKnowledgeSources(domain?: KnowledgeDomain): KnowledgeSource[];
export declare function getKnowledgeNotes(domain?: KnowledgeDomain, query?: string): KnowledgeNote[];
export declare function buildKnowledgeBrief(domain: KnowledgeDomain, query?: string): string;
//# sourceMappingURL=knowledge-atlas.d.ts.map