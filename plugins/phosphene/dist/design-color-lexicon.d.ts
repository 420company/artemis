export interface ColorSystemPalette {
    /** The primary visual field — backgrounds, dominant masses. */
    dominant: string[];
    /** High-energy punctuation colors. */
    accents: string[];
    /** Neutral structural layer. */
    neutrals: string[];
    /** What this system actively refuses — its defining rejection. */
    forbidden: string[];
}
export type TemperatureProfile = 'hot' | 'warm' | 'cool' | 'cold' | 'earth' | 'artificial' | 'oscillating' | 'metallic';
export type SaturationProfile = 'maximum' | 'high' | 'medium' | 'low' | 'limited' | 'variable';
export interface DesignColorSystem {
    id: string;
    label: string;
    /** All keywords and phrases that trigger this system's recognition. */
    aliases: string[];
    era: string;
    origin: string;
    palette: ColorSystemPalette;
    /** The one-line visual logic of this system — its organizing principle. */
    visualGrammar: string;
    /** Tactile/material quality — what it would feel like if you could touch it. */
    textureProfile: string;
    /** Characteristic geometry and spatial organization. */
    shapeLanguage: string;
    temperature: TemperatureProfile;
    saturation: SaturationProfile;
    /** Typical application domains. */
    contexts: string[];
    /** IDs of systems that share lineage, philosophy, or visual energy. */
    relatedSystems: string[];
    /**
     * IDs of systems that create productive friction with this one.
     * Not "incompatible" — interesting and generative when combined.
     */
    tensionsWith: string[];
    /** What this system conspicuously lacks — its structural absence. */
    absenceSignal: string;
    /**
     * The cultural and historical weight this system carries.
     * What it means beyond what it looks like.
     */
    culturalWeight: string;
}
/** A single resolved color with its metadata. */
export interface DesignToken {
    /** CSS-safe variable name: --color-dominant-0, --color-accent-1, etc. */
    cssVar: string;
    /** Hex value extracted from the palette string. */
    hex: string;
    /** Human description of the color role. */
    label: string;
    /** Which palette category this color belongs to. */
    role: 'dominant' | 'accent' | 'neutral';
}
/** A complete, ready-to-use token set for a design system. */
export interface DesignTokenSet {
    system: string;
    label: string;
    tokens: DesignToken[];
    /** Complete CSS custom properties block, ready to paste. */
    css: string;
    /** Same data as a JavaScript/TypeScript object literal. */
    jsTokens: Record<string, string>;
    /** Tailwind-compatible config fragment. */
    tailwindColors: Record<string, string>;
    temperature: TemperatureProfile;
    saturation: SaturationProfile;
}
export interface CrossSystemNote {
    systemIds: string[];
    systemLabels: string[];
    relationship: 'lineage' | 'rebellion' | 'parallel' | 'synthesis' | 'opposition';
    note: string;
}
export interface DesignVocabularyMatch {
    systems: DesignColorSystem[];
    crossNotes: CrossSystemNote[];
    /** True when industrial standards (Pantone, Munsell, etc.) are mentioned. */
    standardsReferenced: string[];
    /** Application context detected in the text. */
    context: 'ui' | 'game' | 'print' | 'digital-art' | 'branding' | 'space' | 'general' | null;
}
export declare const DESIGN_STANDARDS: Record<string, string>;
/**
 * Detect design vocabulary in arbitrary text and return matched systems,
 * cross-system notes, referenced standards, and application context.
 */
export declare function detectDesignVocabulary(text: string): DesignVocabularyMatch;
/** Convenience: just the first matched system, or null. */
export declare function primaryDesignSystem(text: string): DesignColorSystem | null;
/**
 * Generate a complete design token set from a system ID or name.
 *
 * Returns CSS custom properties, a JS token object, and Tailwind config fragment.
 * Only colors with parseable hex values are included.
 *
 * @example
 * const tokens = generateDesignTokens('memphis');
 * console.log(tokens.css);
 * // --color-dominant-primary-yellow: #F7E03C;
 * // --color-dominant-hot-pink: #E8208A;
 * // ...
 */
export declare function generateDesignTokens(systemIdOrName: string): DesignTokenSet | null;
/**
 * Get all resolved colors for a system as a flat array.
 * Only includes colors with valid hex values.
 */
export declare function getSystemPalette(systemIdOrName: string): DesignToken[];
/**
 * Suggest the best-matching design system for a given intent or keyword string.
 * Goes beyond alias matching — considers temperature, saturation, and context.
 *
 * @param intent - Description of the desired aesthetic (e.g. "muted luxury", "aggressive dark UI")
 */
export declare function suggestDesignSystem(intent: string): DesignColorSystem | null;
//# sourceMappingURL=design-color-lexicon.d.ts.map