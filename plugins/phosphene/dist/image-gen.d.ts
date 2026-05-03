import type { DreamImageConfig } from './types.js';
export { assertArtemisVisualConfig, detectArtemisVisualConfig } from './artemis-visual-config.js';
export interface GeneratedImage {
    /** Local file path returned by Artemis. */
    path: string;
    /** The backend that produced the image. */
    backend: DreamImageConfig['provider'];
    /** The full prompt that was used. */
    prompt: string;
    /** Width in pixels, when requested/known. */
    width: number;
    /** Height in pixels, when requested/known. */
    height: number;
    /** Raw Artemis CLI output for diagnostics. */
    stdout?: string;
}
export interface GeneratedVideo {
    path: string;
    backend: 'artemis';
    prompt: string;
    durationSeconds: number;
    stdout?: string;
}
/**
 * Generate a single dream image through Artemis CLI's configured visual API.
 *
 * The default provider is `artemis`. This deliberately reads the user's live
 * Artemis visual configuration from ~/.artemis/providers.json by running the
 * Artemis tool with cwd=homedir().
 */
export declare function generateDreamImage(prompt: string, style: string, config?: DreamImageConfig, outputPath?: string, seed?: number): Promise<GeneratedImage>;
export declare function generateDreamVideo(prompt: string, style: string, config?: DreamImageConfig, outputPath?: string): Promise<GeneratedVideo>;
export declare function coverImageUrl(insights: string[], imageStyle: string, config?: DreamImageConfig, seed?: number): string;
//# sourceMappingURL=image-gen.d.ts.map