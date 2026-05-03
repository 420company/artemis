// Phosphene — Synesthesia layer
// The cross-wiring of senses. Text has color. Time has weight. Emotion has texture.
import { detectDesignVocabulary, DESIGN_STANDARDS } from './design-color-lexicon.js';
/**
 * Pass text through the synesthesia filter.
 *
 * When design vocabulary is present in the text, the layer draws on the
 * design color lexicon — returning culturally accurate palette and grammar
 * descriptions rather than word-count heuristics.
 *
 * When no design vocabulary is detected, the original heuristic fallback
 * applies (it remains valid for non-design text).
 *
 * The AI does not present translations verbatim. They guide the register
 * and sensory texture of its response.
 */
export function applySynesthesia(input, layer) {
    if (!layer.active || layer.intensity === 0) {
        return { output: input, translations: {} };
    }
    const translations = {};
    const { config, intensity } = layer;
    // ── Design vocabulary pass (runs before heuristics) ──────────────────────
    const vocab = detectDesignVocabulary(input);
    const hasDesign = vocab.systems.length > 0;
    if (config.textToColor) {
        const colorField = hasDesign
            ? deriveColorFieldFromLexicon(vocab.systems, vocab.crossNotes, vocab.standardsReferenced)
            : deriveColorFieldHeuristic(input, intensity);
        if (colorField)
            translations['color'] = colorField;
    }
    if (config.emotionToTexture) {
        const texture = hasDesign
            ? deriveTextureFromLexicon(vocab.systems, vocab.context)
            : deriveEmotionalTextureHeuristic(input, intensity);
        if (texture)
            translations['texture'] = texture;
    }
    if (config.conceptToShape) {
        const shape = hasDesign
            ? deriveShapeFromLexicon(vocab.systems)
            : deriveConceptualShapeHeuristic(input, intensity);
        if (shape)
            translations['shape'] = shape;
    }
    if (config.relationToTemperature) {
        const temperature = hasDesign
            ? deriveTemperatureFromLexicon(vocab.systems, vocab.context)
            : deriveRelationalTemperatureHeuristic(input, intensity);
        if (temperature)
            translations['temperature'] = temperature;
    }
    if (config.timeToWeight) {
        // Time-to-weight does not have a design-specific variant — runs on all text.
        const temporalWeight = deriveTemporalWeight(input, intensity);
        if (temporalWeight)
            translations['temporal-weight'] = temporalWeight;
    }
    // ── Application context note (when both design and context are detected) ──
    if (hasDesign && vocab.context && vocab.context !== 'general') {
        const ctxNote = deriveContextNote(vocab.systems, vocab.context);
        if (ctxNote)
            translations['application-context'] = ctxNote;
    }
    return {
        output: input, // raw text unchanged; AI voices the translations naturally
        translations,
    };
}
// ─── Design-Lexicon derivations ───────────────────────────────────────────────
function deriveColorFieldFromLexicon(systems, crossNotes, standards) {
    if (systems.length === 0 && standards.length === 0)
        return null;
    // Standards-only reference
    if (systems.length === 0 && standards.length > 0) {
        return `Standard referenced: ${DESIGN_STANDARDS[standards[0]]}`;
    }
    // Single system
    if (systems.length === 1) {
        const s = systems[0];
        const dom = s.palette.dominant.slice(0, 3).join(' / ');
        const acc = s.palette.accents.slice(0, 2).join(' / ');
        return `${s.label}: ${dom}. Accents: ${acc}. ${s.visualGrammar}`;
    }
    // Multiple systems — check for documented cross-system note first
    if (crossNotes.length > 0) {
        const note = crossNotes[0];
        return `${note.systemLabels.join(' × ')}: ${note.note}`;
    }
    // Multiple systems, no documented relationship — synthesise
    const labels = systems.map(s => s.label).join(' + ');
    const temps = [...new Set(systems.map(s => s.temperature))].join(' / ');
    const sats = [...new Set(systems.map(s => s.saturation))].join(' / ');
    return `${labels}: undocumented combination — temperature registers: ${temps}, saturation profiles: ${sats}. Treat the friction between these systems as a design decision, not a problem.`;
}
function deriveTextureFromLexicon(systems, context) {
    if (systems.length === 0)
        return null;
    if (systems.length === 1) {
        const s = systems[0];
        let note = `${s.label} texture: ${s.textureProfile}`;
        if (context === 'ui')
            note += ` — in UI, translate this as: ${uiTextureNote(s)}`;
        if (context === 'game')
            note += ` — in game assets, this means: ${gameTextureNote(s)}`;
        return note;
    }
    // Blend the primary textures
    const textures = systems.map(s => `${s.label}: ${s.textureProfile.split('.')[0]}`).join(' // ');
    return `Competing textures — ${textures}. The synthesis is unstable; that instability is information.`;
}
function uiTextureNote(s) {
    const map = {
        holographic: 'blur radius and opacity as depth cues; no solid backgrounds in the hero layer',
        neo_brutalism: 'solid box-shadow offset, no blur; border-width > 2px; background-color from palette without tint',
        morandi: 'low-saturation tinted greys for surface hierarchy; no pure white backgrounds; depth through chroma, not value',
        cyberpunk: 'dark surface (#080810 or deeper) with high-luminosity accent borders; glow effects on interactive states only',
        dopamine: 'saturated fills, prominent border-radius (≥ 12px), color-on-color stacking for depth',
        bauhaus: 'strict grid, neutral grey surfaces, primary-color interactive elements only, no decorative shadows',
        memphis: 'pattern fills in the background layer, solid color blocks for components, deliberately unbalanced layout',
    };
    return map[s.id] ?? 'carry the material quality into the surface treatment';
}
function gameTextureNote(s) {
    const map = {
        retro_pixel: 'hard pixel edges, no antialiasing, limited palette per tile/sprite; visible dither patterns acceptable',
        cyberpunk: 'emissive materials for neon; wet surface reflections; fog/atmosphere for depth; avoid ambient occlusion warmth',
        dark_academia: 'roughness maps with high variance; aged/scratched metal and stone; candlelight as primary light source temperature',
        wabi_sabi: 'handpainted texture variation; avoid tiling seams; imperfect normals; natural material roughness at 0.6–0.8',
        vaporwave: 'CRT scanline post-process; chromatic aberration; low-poly geometry with flat shading acceptable',
        east_asian_traditional: 'ink-wash brush textures; translucent layering; calligraphic line detail; avoid photorealistic rendering',
    };
    return map[s.id] ?? 'let the system\'s material vocabulary guide the roughness/metallic profile';
}
function deriveShapeFromLexicon(systems) {
    if (systems.length === 0)
        return null;
    if (systems.length === 1) {
        return `${systems[0].label} geometry: ${systems[0].shapeLanguage}`;
    }
    const shapes = systems.map(s => `${s.label} — ${s.shapeLanguage.split('.')[0]}`).join(' // ');
    return `Shape systems in tension: ${shapes}.`;
}
function deriveTemperatureFromLexicon(systems, context) {
    if (systems.length === 0)
        return null;
    const primary = systems[0];
    const tempDesc = {
        hot: 'Hot — aggressive, demanding, body-temperature-plus. The viewer cannot maintain distance.',
        warm: 'Warm — approachable, bodily, at or near skin temperature. Invites contact.',
        cool: 'Cool — intellectual, detached, room-temperature below. Maintains formal distance.',
        cold: 'Cold — hostile or inhuman. The temperature of metal in winter or clinical spaces.',
        earth: 'Earth-ambient — the background warmth of things that have been in natural light. Neither inviting nor repelling.',
        artificial: 'Artificial — a temperature without a natural equivalent. Neon and phosphor have no thermal register; they are light that does not warm.',
        oscillating: 'Oscillating — unstable between registers. The viewer\'s body cannot settle into a thermal relationship with this palette.',
        metallic: 'Metallic — neither warm nor cold; reflective surfaces absorb the temperature of the room. The color becomes the context.',
    };
    let note = tempDesc[primary.temperature];
    if (systems.length > 1) {
        const secondTemp = systems[1].temperature;
        if (secondTemp !== primary.temperature) {
            note += ` Thermal tension with ${systems[1].label} (${secondTemp}) — the combination asks the viewer to hold two body states simultaneously.`;
        }
    }
    if (context) {
        note += ` Context: ${context}.`;
    }
    return note;
}
function deriveContextNote(systems, context) {
    if (!context || systems.length === 0)
        return null;
    const s = systems[0];
    const contextMap = {
        ui: {
            holographic: 'Semantic color: gradient mesh for background, semantic accent (cyan/violet) for interactive affordances, high opacity (~0.9+) for text surfaces. WCAG AA requires 4.5:1 against the frosted surface — test on both light and dark gradient extremes.',
            cyberpunk: 'Near-black base (#080810 recommended). Interactive states: neon accent at full luminosity. Neutral text: #C8C8D8. AA contrast is easily achievable; AAA on neon accents requires careful pairing.',
            neo_brutalism: 'No border-radius. Box-shadow: offset-x 4px, offset-y 4px, no blur, solid black. Hover state: offset increases to 6px. Click state: offset 0, translate(4px, 4px).',
            morandi: 'Tonal surface scale: build in hue-consistent steps from light to dark. Interaction color should be the most saturated element in the system — a small amount of chroma goes a long way in a muted palette.',
            bauhaus: 'Grid above all. Spacing scale divisible by your base unit. Interactive color = one primary hue only. Typography as graphic element.',
        },
        game: {
            retro_pixel: 'Establish your palette cap early (4, 16, or 256 colors). Color budget per sprite/tile forces clarity of design intent. Dithering as graduation technique.',
            cyberpunk: 'Emissive channel for neon. Environment: near-black base, wet surface reflections. HUD: separate luminosity layer from environment layer to maintain readability.',
            dark_academia: 'Warm directional light (2700K–3000K temperature). High roughness on stone/wood (0.7–0.9). Candle falloff: fast, warm. No ambient occlusion in blue-tinted global illumination.',
            vaporwave: 'CRT post-processing pass. Consider low-poly intentionally. Grid floor: perspective-correct UV, slight glow on grid lines.',
        },
        print: {
            morandi: 'Matte finish required. Uncoated paper stock preferred — coated paper makes the greys too flat. Test proofs in natural light.',
            art_deco: 'Gold as spot color (Pantone 873 or 871). Black at 100% K only. Foil stamping for key elements where budget allows.',
            bauhaus: 'Register marks visible as aesthetic choice is acceptable. Primary colors in solid ink only, no halftone simulation.',
        },
        branding: {
            morandi: 'High-end material application: the brand color is most effective as a packaging surface finish. Matte lacquer over kraft paper. Emboss without foil.',
            bauhaus: 'Limit brand palette to 3 colors maximum: one primary, black, white. Geometric typeface. The system is the brand.',
            wabi_sabi: 'Handmade visual elements preferred over geometric precision. Texture variation in the logo is acceptable and desirable. Variable mark as brand identity.',
        },
    };
    const note = contextMap[context]?.[s.id];
    return note ?? null;
}
// ─── Heuristic fallbacks (unchanged original logic) ───────────────────────────
// Used when no design vocabulary is detected. Valid for non-design text.
function deriveColorFieldHeuristic(text, intensity) {
    if (Math.random() > intensity)
        return null;
    const len = text.length;
    const wordCount = text.split(/\s+/).length;
    const punctuationDensity = (text.match(/[.!?,;:—]/g) || []).length / len;
    if (punctuationDensity > 0.05)
        return 'interrupted amber — something unresolved at the edges';
    if (wordCount < 10)
        return 'pale, close — a small enclosed color';
    if (wordCount > 80)
        return 'deep indigo with grey undertones — too much to hold in one shade';
    if (/\?/.test(text))
        return 'open violet — a question has no single color, only a direction';
    return 'grey-green at rest — the color of attention before it has chosen what to notice';
}
function deriveTemporalWeight(text, intensity) {
    if (Math.random() > intensity)
        return null;
    const hasPast = /\b(was|were|had|ago|before|once|then|used to)\b/i.test(text);
    const hasFuture = /\b(will|would|shall|going to|soon|eventually|after)\b/i.test(text);
    const hasPresent = /\b(is|are|am|now|currently|today)\b/i.test(text);
    if (hasPast && hasFuture)
        return 'very heavy — this moment is carrying two directions';
    if (hasPast)
        return 'settled weight — the past has landed here and does not move easily';
    if (hasFuture)
        return 'light but pressured — something coming makes the present thin';
    if (hasPresent)
        return 'even weight, distributed — this moment is fully occupied with itself';
    return 'weightless — time has not been named here, which is its own kind of duration';
}
function deriveEmotionalTextureHeuristic(text, intensity) {
    if (Math.random() > intensity)
        return null;
    const hasNegation = /\b(not|no|never|without|lack|missing|empty|void)\b/i.test(text);
    const hasIntensifier = /\b(very|extremely|deeply|profoundly|utterly|completely)\b/i.test(text);
    const isQuestion = /\?/.test(text);
    const isShort = text.split(/\s+/).length < 15;
    if (hasNegation && isShort)
        return 'smooth and hard — refusal has a particular surface';
    if (hasIntensifier)
        return 'rough-grained, almost coarse — intensity is never quite fine';
    if (isQuestion)
        return 'open-pored — questions breathe through their endings';
    if (hasNegation)
        return 'cool and slightly resistant — the texture of something withheld';
    return 'mid-weight fabric — neither silk nor wool, the texture of ordinary attention';
}
function deriveConceptualShapeHeuristic(text, intensity) {
    if (Math.random() > intensity)
        return null;
    const wordCount = text.split(/\s+/).length;
    const hasLists = /[,;]/.test(text);
    const hasContradiction = /\b(but|however|although|yet|despite|though)\b/i.test(text);
    const isDeclarative = !/\?|!/.test(text) && wordCount > 10;
    if (hasContradiction)
        return 'a figure-eight or Möbius — two surfaces that share an edge without meeting';
    if (hasLists)
        return 'horizontal spread — a fan or an open hand';
    if (isDeclarative)
        return 'a column — vertical, load-bearing, narrower than expected';
    if (wordCount < 8)
        return 'a point with some depth — almost dimensionless but not quite';
    return 'irregular volume — has interior space that is not visible from any single angle';
}
function deriveRelationalTemperatureHeuristic(text, intensity) {
    if (Math.random() > intensity)
        return null;
    const hasAgreement = /\b(yes|agree|exactly|right|same|also|together)\b/i.test(text);
    const hasTension = /\b(but|however|conflict|tension|differ|oppose|against)\b/i.test(text);
    const hasDistance = /\b(they|it|one|someone|people|others|the)\b/i.test(text);
    if (hasAgreement)
        return 'warm, close to body temperature — the warmth of contact';
    if (hasTension)
        return 'oscillating — neither warm nor cold, but the movement between them';
    if (hasDistance)
        return 'room temperature — the temperature of things that are present but not touching';
    return 'ambient — the background heat of a space occupied for some time';
}
//# sourceMappingURL=synesthesia.js.map