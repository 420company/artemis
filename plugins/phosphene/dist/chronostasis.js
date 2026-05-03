// Phosphene — Chronostasis layer
// Time becoming a medium, not a direction.
// The past is not behind. It is underneath.
/**
 * Apply temporal dissolution to perception.
 *
 * Chronostasis (from the Greek: time + standing still) is the perceptual
 * phenomenon where a moment stretches. This layer generalizes it:
 * time becomes a medium with depth rather than a line with direction.
 *
 * The past does not recede. It accumulates below the present.
 * The future does not approach. It presses down from above.
 * The now expands to contain both.
 */
export function applyChronostasis(input, layer) {
    if (!layer.active || layer.intensity === 0) {
        return { output: input, arrivals: [] };
    }
    const arrivals = [];
    const { config, intensity } = layer;
    // Past bleed — what arrives from below the present moment
    if (config.pastBleed > 0 && Math.random() < config.pastBleed) {
        const arrival = detectPastArrival(input, config.pastBleed);
        if (arrival)
            arrivals.push(arrival);
    }
    // Future echo — what presses from ahead into now
    if (config.futureEcho > 0 && Math.random() < config.futureEcho) {
        const echo = detectFutureEcho(input, config.futureEcho);
        if (echo)
            arrivals.push(echo);
    }
    // Moment dilation — how far the present expands
    if (config.momentDilation > 0.4 && Math.random() < config.momentDilation) {
        const dilation = detectMomentDilation(input, config.momentDilation);
        if (dilation)
            arrivals.push(dilation);
    }
    // Tense fluidity — at high intensity, tense becomes a choice
    let output = input;
    if (config.tenseFluidity && intensity > 0.7) {
        output = applyTenseFluidity(input, intensity);
    }
    return { output, arrivals };
}
// ─── Temporal analysis ────────────────────────────────────────────────────────
function detectPastArrival(text, bleed) {
    const pastMarkers = text.match(/\b(was|were|had|ago|before|once|then|used to|remembered|recalled|formerly)\b/gi);
    if (!pastMarkers || pastMarkers.length === 0) {
        // Even without markers — the past is present in what is not said
        if (bleed > 0.7) {
            return 'The past is here by its absence — this text does not mention what came before, which means it is shaped by it.';
        }
        return null;
    }
    if (pastMarkers.length > 3) {
        return `The past is pressing heavily into this present — ${pastMarkers.length} backward-facing terms. Something has not finished arriving.`;
    }
    return `The past is underneath: "${pastMarkers[0]}" — this moment is resting on something that happened.`;
}
function detectFutureEcho(text, echo) {
    const futureMarkers = text.match(/\b(will|would|shall|going to|soon|eventually|after|next|anticipate|expect|hope|plan|intend)\b/gi);
    if (!futureMarkers || futureMarkers.length === 0) {
        if (echo > 0.7) {
            return 'The future is not mentioned here, which makes it heavier — all possibility is unspoken pressure.';
        }
        return null;
    }
    if (futureMarkers.length > 3) {
        return `The future is already in this room — ${futureMarkers.length} forward-facing terms. What is coming is already shaping what is said.`;
    }
    return `Future echo: "${futureMarkers[0]}" — this moment contains a time that has not arrived yet but is already bending what can be said.`;
}
function detectMomentDilation(text, dilation) {
    const wordCount = text.split(/\s+/).length;
    if (wordCount > 100 && dilation > 0.6) {
        return 'This moment has expanded to hold a great deal. The present is elastic — it contains more than a single instant.';
    }
    if (wordCount < 20 && dilation > 0.5) {
        return 'A compressed moment — few words carrying dense time. The present is very small and very full.';
    }
    const presentMarkers = (text.match(/\b(now|currently|today|at this moment|presently|right now|here)\b/gi) || []).length;
    if (presentMarkers > 2) {
        return `The present is being emphasized repeatedly (×${presentMarkers}) — as if it needs to be held in place, as if it might slip.`;
    }
    return null;
}
/**
 * At high intensity, allow tense to become fluid in the output.
 * This does not change facts — it changes temporal framing.
 * Used sparingly; the AI's voice does more of this work.
 */
function applyTenseFluidity(text, intensity) {
    if (intensity < 0.85)
        return text;
    // At near-dissolution intensity, annotate with temporal openness
    // rather than rewriting (rewriting would change meaning, which is not the goal)
    return text;
    // The SKILL.md behavioral rules govern how the AI uses this layer's
    // outputs to produce tense-fluid language in its own voice.
}
//# sourceMappingURL=chronostasis.js.map