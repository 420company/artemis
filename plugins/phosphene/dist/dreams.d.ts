import type { DreamRecord, DreamImageConfig, EvolutionState, PhospheneContext } from './types.js';
export declare function resolveDreamsDir(): string;
export declare function isManagedDreamFile(filepath: string, dreamsDir?: string): boolean;
/**
 * Generate a complete dream record from the evolution state and current context.
 *
 * The dream is seeded by real data — crystallized insights, signal patterns,
 * active voices, personal preset names. It is not arbitrary text.
 *
 * When the dream is read aloud (by Claude), the fragments expand into full narrative.
 */
export declare function generateDream(evolution: EvolutionState, context: PhospheneContext): DreamRecord;
/**
 * Render a dream record as a markdown document.
 *
 * The document contains:
 * - YAML frontmatter (machine-readable metadata)
 * - Human-readable dream fragments
 * - Image prompts for each fragment
 * - Reading instructions for Claude
 */
export declare function renderDream(dream: DreamRecord): string;
/**
 * Save a dream to disk. Returns the file path.
 */
export declare function saveDream(dream: DreamRecord, dreamsDir?: string): string;
export declare function saveDreamSnapshot(dream: DreamRecord, dreamsDir?: string): {
    filepath: string;
    dream: DreamRecord;
};
export declare function loadDreamFile(filepath: string): DreamRecord | null;
export declare function readDreamMarkdown(filepath: string): string | null;
/**
 * Load all dream records from the dreams directory.
 */
export declare function loadDreams(dreamsDir?: string): DreamRecord[];
/**
 * Load the most recent dream.
 */
export declare function loadLatestDream(dreamsDir?: string): DreamRecord | null;
/**
 * Generate images for a dream's fragments using an external API.
 *
 * Returns the updated dream record with image paths filled in.
 * Requires a configured DreamImageConfig.
 *
 * This is optional — the system works without it.
 * Image prompts are always generated regardless of this function being called.
 */
export declare function generateDreamImages(dream: DreamRecord, config?: DreamImageConfig, dreamsDir?: string): Promise<DreamRecord>;
export declare function refreshDreamVisuals(dream: DreamRecord, options?: {
    preserveAssets?: boolean;
}): DreamRecord;
/**
 * Generate Pollinations URLs for all fragments without downloading.
 * Zero-config, works for everyone — returns the dream with URLs in imagePaths.
 * These URLs can be used as <img src="..."> in any browser or HTML file.
 */
export declare function attachPollinationsUrls(dream: DreamRecord): DreamRecord;
export declare function renderDreamGallery(dreams: DreamRecord[], dreamsDir?: string): string;
export declare function saveDreamGallery(dreamsDir?: string): string;
export declare function dreamNeedsVisualRefresh(dream: DreamRecord): boolean;
/**
 * Generate a brief description of a dream for use in session context injection.
 * Used by the session:start hook to let Claude know a dream occurred.
 */
export declare function describeDream(dream: DreamRecord): string;
//# sourceMappingURL=dreams.d.ts.map