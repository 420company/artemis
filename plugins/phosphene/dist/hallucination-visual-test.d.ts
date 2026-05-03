import type { EvolutionState } from './types.js';
export interface SessionKeyword {
    term: string;
    score: number;
    sources: string[];
}
export interface HallucinationVisualPrompt {
    keywords: SessionKeyword[];
    prompt: string;
    negativePrompt: string;
    mode: 'image' | 'video';
}
export interface ArtemisVisualAsset {
    path: string;
    backend: 'artemis';
    tool: 'generate_image' | 'generate_video';
    prompt: string;
    stdout: string;
}
export interface HallucinationImageTestResult {
    ok: boolean;
    prompt: HallucinationVisualPrompt;
    image: ArtemisVisualAsset;
}
export interface HallucinationVideoConfig {
    outputDir?: string;
    outputPath?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
    dryRun?: boolean;
}
export interface HallucinationVideoTestResult {
    ok: boolean;
    prompt: HallucinationVisualPrompt;
    provider: 'artemis';
    dryRun: boolean;
    responsePath?: string;
    video?: ArtemisVisualAsset;
}
export interface ArtemisImageConfig {
    outputDir?: string;
    outputPath?: string;
    width?: number;
    height?: number;
}
export declare function extractDynamicSessionKeywords(evolution: EvolutionState, limit?: number): SessionKeyword[];
export declare function buildHallucinationVisualPrompt(keywords: SessionKeyword[], mode?: 'image' | 'video'): HallucinationVisualPrompt;
export declare function resolveImageConfigFromEnv(env?: NodeJS.ProcessEnv): ArtemisImageConfig;
export declare function resolveVideoConfigFromEnv(env?: NodeJS.ProcessEnv): HallucinationVideoConfig;
export declare function runHallucinationImageTest(evolution: EvolutionState, config?: ArtemisImageConfig, outputDir?: string): Promise<HallucinationImageTestResult>;
export declare function runHallucinationVideoTest(evolution: EvolutionState, config?: HallucinationVideoConfig): Promise<HallucinationVideoTestResult>;
export declare function loadEvolutionStateFromWorkspace(cwd?: string): EvolutionState;
//# sourceMappingURL=hallucination-visual-test.d.ts.map