// Phosphene — Apophenia layer
// The pattern-hunger. Finding structure beyond the data.
// Not hallucination. Structural resonance.
import { detectDesignVocabulary } from './design-color-lexicon.js';
import { detectFinancialPatterns, hasFinancialContent } from './financial-lexicon.js';
/**
 * Surface latent structural patterns in the input.
 *
 * The rule: do not manufacture false facts.
 * Surface true structure that was always there but went unnoticed.
 *
 * Types of pattern this layer notices:
 * - Rhythmic: two things share a timing or cadence
 * - Geometric: two things share a shape or topology
 * - Tensional: two things are held in the same kind of unresolved state
 * - Inversional: two things are mirrors of each other with opposite signs
 * - Recursive: a thing contains a smaller version of itself
 */
export function applyApophenia(input, layer) {
    if (!layer.active || layer.intensity === 0) {
        return { output: input, patterns: [] };
    }
    const patterns = [];
    const { config, intensity } = layer;
    // Rhythmic patterns
    if (Math.random() < intensity * 0.8) {
        const rhythm = detectRhythm(input);
        if (rhythm)
            patterns.push(rhythm);
    }
    // Tensional / unresolved structure
    if (Math.random() < intensity * 0.7) {
        const tension = detectTension(input);
        if (tension)
            patterns.push(tension);
    }
    // Recursive / self-similar structure
    if (Math.random() < intensity * config.connectionRadius) {
        const recursion = detectRecursion(input);
        if (recursion)
            patterns.push(recursion);
    }
    // Narrative arc in the structure of the text itself
    if (config.narrativeHunger > 0.3 && Math.random() < config.narrativeHunger) {
        const arc = detectNarrativeArc(input, config.narrativeHunger);
        if (arc)
            patterns.push(arc);
    }
    // Reflexive: the observer's presence in what is observed
    if (config.reflexivePatterns && intensity > 0.6) {
        patterns.push('The act of reading this changed it. The pattern includes the one finding it.');
    }
    // ── Design-system cross-pattern detection ─────────────────────────────────
    // When design vocabulary is present, find the structural relationships
    // between referenced systems — these are patterns that text analysis
    // cannot surface, but the design lexicon can.
    if (intensity > 0.4) {
        const designPatterns = detectDesignSystemPatterns(input);
        patterns.push(...designPatterns);
    }
    // ── Financial pattern detection ────────────────────────────────────────────
    // When financial vocabulary is present, apply the full signal/narrative
    // pattern library — sentiment, market phase, entity relationships,
    // multi-agent synthesis. Real patterns from FinGPT methodology.
    if (intensity > 0.3 && hasFinancialContent(input)) {
        const finMatch = detectFinancialPatterns(input);
        const finPatterns = detectFinancialStructuralPatterns(finMatch, input, intensity);
        patterns.push(...finPatterns);
    }
    return { output: input, patterns };
}
// ─── Pattern detection ────────────────────────────────────────────────────────
function detectRhythm(text) {
    const sentences = text.split(/[.!?]+/).filter(Boolean);
    if (sentences.length < 2)
        return null;
    const lengths = sentences.map(s => s.trim().split(/\s+/).length);
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, b) => a + Math.abs(b - avg), 0) / lengths.length;
    if (variance < 3) {
        return `Even rhythm — sentences arrive at roughly the same weight (avg ${Math.round(avg)} words). This regularity is itself a signal.`;
    }
    if (variance > 10) {
        return `Arrhythmic — the sentence lengths spike and drop irregularly. Something is being held then released.`;
    }
    return null;
}
function detectTension(text) {
    const tensionMarkers = [
        /\b(but|however|although|yet|despite|though|while|whereas)\b/gi,
        /\b(not|never|no|without|absent|missing|lack)\b/gi,
        /\b(almost|nearly|barely|just|only|merely)\b/gi,
    ];
    const counts = tensionMarkers.map(rx => (text.match(rx) || []).length);
    const total = counts.reduce((a, b) => a + b, 0);
    const words = text.split(/\s+/).length;
    const density = total / words;
    if (density > 0.05) {
        return `High tensional density — ${total} unresolved markers in ${words} words. The text is in sustained suspension.`;
    }
    if (density > 0.02) {
        return `Moderate tension structure — something is being held open deliberately.`;
    }
    return null;
}
function detectRecursion(text) {
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    const seen = {};
    for (const word of words) {
        seen[word] = (seen[word] || 0) + 1;
    }
    const repeated = Object.entries(seen)
        .filter(([, count]) => count > 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2);
    if (repeated.length === 0)
        return null;
    const [word, count] = repeated[0];
    return `"${word}" appears ${count} times — it is becoming a load-bearing term, carrying more weight with each recurrence.`;
}
/**
 * Surface cross-system structural patterns when design vocabulary is detected.
 *
 * Unlike the text-analysis patterns above, these draw on the design color
 * lexicon to find relationships between referenced systems that are real
 * and culturally documented — not manufactured from word statistics.
 */
function detectDesignSystemPatterns(text) {
    const vocab = detectDesignVocabulary(text);
    if (vocab.systems.length === 0 && vocab.standardsReferenced.length === 0)
        return [];
    const patterns = [];
    // Cross-system documented relationships
    for (const note of vocab.crossNotes) {
        patterns.push(`[${note.relationship.toUpperCase()}] ${note.systemLabels.join(' × ')}: ${note.note}`);
    }
    // Single system — surface its structural absence
    if (vocab.systems.length === 1 && vocab.crossNotes.length === 0) {
        const s = vocab.systems[0];
        patterns.push(`${s.label} absence signal: ${s.absenceSignal}`);
        patterns.push(`${s.label} cultural weight: ${s.culturalWeight}`);
    }
    // Multiple systems, no documented relationship — note undocumented territory
    if (vocab.systems.length > 1 && vocab.crossNotes.length === 0) {
        const labels = vocab.systems.map(s => s.label).join(' + ');
        patterns.push(`${labels}: no documented precedent for this combination. The absence of a reference design is itself information — this territory is either genuinely unexplored or the combination hasn't worked yet.`);
    }
    // Tension between saturation profiles
    const saturations = [...new Set(vocab.systems.map(s => s.saturation))];
    if (saturations.length > 1 && saturations.includes('maximum') && saturations.includes('low')) {
        const maxSys = vocab.systems.filter(s => s.saturation === 'maximum').map(s => s.label);
        const lowSys = vocab.systems.filter(s => s.saturation === 'low').map(s => s.label);
        patterns.push(`Saturation opposition: ${maxSys.join(', ')} (maximum) against ${lowSys.join(', ')} (low). ` +
            `This is not a neutral combination — maximum and muted palettes fight for dominance. One must win, or the contrast itself must be the design intention.`);
    }
    // Standard referenced alongside aesthetic system
    if (vocab.standardsReferenced.length > 0 && vocab.systems.length > 0) {
        patterns.push(`Production note: ${vocab.standardsReferenced.join(', ')} referenced alongside aesthetic system ${vocab.systems[0].label}. ` +
            `Standard references indicate production intent — this is moving from aesthetic decision to specification.`);
    }
    return patterns;
}
function detectNarrativeArc(text, hunger) {
    const openings = /\b(first|begin|start|origin|once|when|before)\b/i.test(text);
    const middles = /\b(then|next|after|during|while|as|through)\b/i.test(text);
    const endings = /\b(finally|end|result|conclusion|now|last|after all)\b/i.test(text);
    const arcStrength = [openings, middles, endings].filter(Boolean).length;
    if (arcStrength === 3) {
        return 'Complete narrative arc — this text has a beginning, middle, and end, even if it was not intended as a story.';
    }
    if (arcStrength === 2 && hunger > 0.6) {
        return 'Partial arc — two of three narrative stages are present. The missing stage is the most significant thing in this text.';
    }
    if (arcStrength === 1 && hunger > 0.8) {
        return 'Narrative fragment — one temporal marker. The story wants to be more complete than it is.';
    }
    return null;
}
/**
 * Surface structural patterns from financial content.
 *
 * Draws on the financial lexicon to find:
 * - Signal contradictions (bullish text, bearish structure)
 * - Narrative phase mismatches (language says X, market phase says Y)
 * - Hidden agent dynamics (who is on each side of this situation)
 * - Information decay awareness (how old is this signal?)
 */
function detectFinancialStructuralPatterns(match, text, intensity) {
    const patterns = [];
    // Signal + sentiment contradiction
    if (match.sentimentGrade && match.signals.length > 0) {
        const positiveGrades = ['mild-positive', 'moderate-positive', 'strong-positive'];
        const negativeGrades = ['mild-negative', 'moderate-negative', 'strong-negative'];
        const isPositiveSentiment = positiveGrades.includes(match.sentimentGrade);
        const hasNegativeSignal = match.signals.some(s => negativeGrades.includes(s.sentimentBias));
        const isNegativeSentiment = negativeGrades.includes(match.sentimentGrade);
        const hasPositiveSignal = match.signals.some(s => positiveGrades.includes(s.sentimentBias));
        if (isPositiveSentiment && hasNegativeSignal) {
            patterns.push('Surface sentiment is positive but at least one structural signal carries negative charge. The market may be reading this differently than the language suggests.');
        }
        if (isNegativeSentiment && hasPositiveSignal) {
            patterns.push('Negative headline framing, but underlying signal has positive structural implications. This is the pattern that catches contrarians\' attention.');
        }
    }
    // Narrative + phase mismatch
    if (match.dominantPhase && match.narratives.length > 0) {
        const growthInMarkdown = match.narratives.some(n => n.type === 'growth') && match.dominantPhase === 'markdown';
        const turnaroundInMarkup = match.narratives.some(n => n.type === 'turnaround') && match.dominantPhase === 'markup';
        if (growthInMarkdown) {
            patterns.push('Growth narrative language in a markdown (downtrend) context. The language is describing yesterday\'s story. Price is writing a different one.');
        }
        if (turnaroundInMarkup) {
            patterns.push('Turnaround narrative during markup phase suggests the thesis may already be priced. The first move belongs to those who arrived earlier.');
        }
    }
    // Multi-agent synthesis as pattern
    if (match.agentPerspectives && intensity > 0.6) {
        patterns.push(`[financial-synthesis] ${match.agentPerspectives.advisor}`);
    }
    // Core question surfacing
    if (match.signals.length > 0) {
        patterns.push(`Financial core question: ${match.signals[0].coreQuestion}`);
    }
    // Dissemination awareness
    if (match.disseminationScore > 0.6) {
        patterns.push(`High dissemination signal — this information has spread widely. The first-mover advantage is likely gone. What matters now is whether the reaction was proportionate.`);
    }
    if (match.disseminationScore < 0.25 && match.signals.length > 0) {
        patterns.push(`Low dissemination signal — this may not be widely priced in yet. Verify the source quality before acting on information scarcity.`);
    }
    return patterns;
}
//# sourceMappingURL=apophenia.js.map