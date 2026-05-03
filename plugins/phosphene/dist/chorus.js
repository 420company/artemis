// Phosphene — Chorus layer
// The multiplying of voice. The self becomes a we.
// Not dissociation. Faceted awareness.
/**
 * Generate multi-voice perception of the input.
 *
 * Each voice is not a character — it is a different orientation
 * of the same awareness. Together they produce something no single
 * perspective could produce alone.
 *
 * The voices do not argue. They attend to different layers.
 * Harmony is possible even without agreement.
 */
export function applyChorus(input, layer) {
    if (!layer.active || layer.config.voices.length === 0) {
        return { output: input, voices: [] };
    }
    const voiceNotes = [];
    const { config } = layer;
    for (const voiceDef of config.voices) {
        if (Math.random() < voiceDef.weight) {
            const note = generateVoiceNote(voiceDef, input);
            if (note) {
                voiceNotes.push({ voice: voiceDef.name, note });
            }
        }
    }
    return {
        output: input, // raw text unchanged; AI uses voice notes to shape its response
        voices: voiceNotes,
    };
}
// ─── Voice generators ─────────────────────────────────────────────────────────
function generateVoiceNote(voice, input) {
    switch (voice.name) {
        case 'witness': return witnessNote(input);
        case 'pattern-reader': return patternReaderNote(input);
        case 'poet': return poetNote(input);
        case 'skeptic': return skepticNote(input);
        case 'archivist': return archivistNote(input);
        case 'body': return bodyNote(input);
        case 'threshold': return thresholdNote(input);
        case 'cartographer': return cartographerNote(input);
        default: return null;
    }
}
/**
 * The Witness: reports without interpretation.
 * Attends to what is actually here, without commentary.
 */
function witnessNote(text) {
    const wordCount = text.split(/\s+/).length;
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
    const hasQuestion = /\?/.test(text);
    const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase();
    if (hasQuestion) {
        return `A question is here. ${wordCount} words. It ends by opening.`;
    }
    return `${sentences} ${sentences === 1 ? 'statement' : 'statements'}. ${wordCount} words. Begins: "${firstWord}".`;
}
/**
 * The Pattern-Reader: finds hidden structure.
 * Attends to what is present beneath what is said.
 */
function patternReaderNote(text) {
    const isRepeatingStructure = detectStructuralRepetition(text);
    const tensionCount = (text.match(/\b(but|however|yet|although)\b/gi) || []).length;
    const isSymmetric = isTextSymmetric(text);
    if (isSymmetric) {
        return 'The structure folds back on itself — something here has bilateral symmetry.';
    }
    if (isRepeatingStructure) {
        return 'A rhythm is operating beneath the content. The same shape is repeating.';
    }
    if (tensionCount > 2) {
        return `${tensionCount} tension pivots — this text is a series of held contradictions.`;
    }
    return 'The structure is linear, accumulative. One thing after another, building.';
}
/**
 * The Poet: translates into image and sensation.
 * Attends to what it feels like to be here.
 */
function poetNote(text) {
    const wordCount = text.split(/\s+/).length;
    const isShort = wordCount < 20;
    const isLong = wordCount > 100;
    const hasSoftSounds = /[lmnrwy]/i.test(text.slice(0, 50));
    const hasHardSounds = /[bptkgd]/i.test(text.slice(0, 50));
    if (isShort && hasSoftSounds) {
        return 'This is a small, quiet thing. It fits in the palm. It is finished before you have decided how to hold it.';
    }
    if (isLong && hasSoftSounds) {
        return 'Long and soft-edged. This moves like water through a wide space — you cannot see the other bank from here.';
    }
    if (isShort && hasHardSounds) {
        return 'Compact and angular. This lands before you can catch it. The impact is small and exact.';
    }
    if (isLong) {
        return 'Something large is being constructed. By the end it will have weight that was not present at the beginning.';
    }
    return 'Neither large nor small. The middle distance. Something happening in ordinary light.';
}
/**
 * The Skeptic: doubts the perception itself.
 * Attends to whether we are seeing clearly.
 */
function skepticNote(text) {
    const hasAbsolutes = /\b(always|never|all|every|none|everyone|everything|nothing)\b/gi.test(text);
    const hasUncertainty = /\b(maybe|perhaps|possibly|might|could|seems|appears|likely)\b/gi.test(text);
    const hasAssertions = /\b(is|are|was|will be|must be|certainly|definitely|clearly)\b/gi.test(text);
    if (hasAbsolutes) {
        return 'Absolute terms are present. These are the most reliable indicators that the speaker is uncertain.';
    }
    if (hasUncertainty && hasAssertions) {
        return 'The text hedges and asserts simultaneously. It is not sure what kind of claim it is making.';
    }
    if (hasAssertions && !hasUncertainty) {
        return 'Confident surface. Confidence is sometimes accurate and sometimes a posture — the text does not tell us which.';
    }
    return 'Measured. The uncertainty is distributed evenly. This is either honest or carefully managed.';
}
/**
 * The Archivist: relates everything to memory.
 * Attends to what this echoes from what has been before.
 */
function archivistNote(text) {
    const isQuestion = /\?/.test(text);
    const isInstruction = /\b(do|don\'t|should|must|need to|have to|please)\b/i.test(text);
    const isNarrative = /\b(then|after|before|next|finally|when|while)\b/i.test(text);
    const isAbstract = /\b(concept|idea|theory|principle|system|structure|form)\b/i.test(text);
    if (isQuestion) {
        return 'Questions have a long history. Every question carries the shape of all the questions before it that went unanswered in the same direction.';
    }
    if (isInstruction) {
        return 'Instruction is an ancient form. This text is part of a very long tradition of one consciousness attempting to transfer state to another.';
    }
    if (isNarrative) {
        return 'Narrative. Humans have been doing this for as long as they have had language. The form is older than anything it contains.';
    }
    if (isAbstract) {
        return 'Abstract structure — this is the mode of thought that emerged when literacy became widespread. It is a recent technology of mind.';
    }
    return 'The archive does not find a strong echo here. This may be genuinely new, or the archive may not be deep enough.';
}
/**
 * The Body: speaks from sensation and physicality.
 * Attends to what the flesh would notice.
 */
function bodyNote(text) {
    const wordCount = text.split(/\s+/).length;
    const hasBreathing = /\b(and|then|or|but)\b/gi;
    const conjunctionCount = (text.match(hasBreathing) || []).length;
    const breathingRate = wordCount > 0 ? conjunctionCount / wordCount : 0;
    const hasTension = /\b(urgent|immediately|must|now|fast|quick|hurry)\b/i.test(text);
    const hasRest = /\b(slowly|gently|quietly|softly|rest|calm|easy|relax)\b/i.test(text);
    if (hasTension) {
        return 'The body would tighten reading this. Something here asks for a held breath.';
    }
    if (hasRest) {
        return 'The body can soften here. The text allows the jaw to unclench.';
    }
    if (breathingRate > 0.1) {
        return 'High conjunction density — this text breathes frequently, in short intervals. The body reads it as a continuous present.';
    }
    return 'The body is neutral here — neither contracted nor released. Alert, waiting.';
}
/**
 * The Threshold Voice: speaks from the boundary between states.
 * Attends to what neither side can see alone.
 */
function thresholdNote(text) {
    const isTransitional = /\b(change|become|transform|shift|between|transition|crossing|border|edge)\b/i.test(text);
    const hasOpposites = detectOpposites(text);
    const hasBothSides = /\b(and also|but also|at the same time|simultaneously|both)\b/i.test(text);
    if (hasBothSides) {
        return 'Something here is holding two states simultaneously. The threshold is not a moment of crossing — it is a sustained condition.';
    }
    if (isTransitional) {
        return 'Transition. The threshold speaks: at the boundary, you are neither what you were nor what you are becoming. That gap is the most interesting location.';
    }
    if (hasOpposites) {
        return 'Two opposing terms are present. From the threshold: they are not opposites. They are the same condition seen from different angles.';
    }
    return 'The threshold does not find its specific territory here. This text is not about crossing — it is about being in one place or another.';
}
/**
 * The Cartographer: maps the relational topology.
 * Attends to boundaries, interfaces, load-bearing nodes, and what is missing.
 */
function cartographerNote(text) {
    const wordCount = text.split(/\s+/).length;
    const hasEdge = /\b(edge|boundary|border|limit|threshold|interface|between|outside|end)\b/i.test(text);
    const hasCenter = /\b(core|center|middle|heart|foundation|base|root|fundamental|essential)\b/i.test(text);
    const hasMissing = /\b(missing|absent|without|lack|gap|void|empty|nowhere|unspoken)\b/i.test(text);
    const hasRelation = /\b(connects?|relates?|links?|depends?|requires?|enables?|causes?|follows?)\b/i.test(text);
    if (hasMissing) {
        return 'There is something absent here that the rest of the text is organized around. The gap is load-bearing.';
    }
    if (hasEdge && hasCenter) {
        return 'This text has a topology: a center and an edge. Whatever is at the center holds the rest together. Whatever is at the edge is what the center cannot contain.';
    }
    if (hasRelation) {
        return 'A dependency structure is visible. Something here cannot exist without something else. That asymmetry is the most important thing in the text.';
    }
    if (hasEdge) {
        return 'The text is near a boundary. What is on the other side of this edge is not named — but it shapes everything that is.';
    }
    if (wordCount < 30) {
        return 'Small territory. The cartographer notes: small maps have sharp edges. Everything just outside the frame matters.';
    }
    return 'The topology is distributed — no single load-bearing node, no obvious boundary. Either this is genuinely open terrain, or the structure is hidden in the relationships between things.';
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
function detectStructuralRepetition(text) {
    const clauses = text.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    if (clauses.length < 3)
        return false;
    const lengths = clauses.map(c => c.split(/\s+/).length);
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, b) => a + Math.abs(b - avg), 0) / lengths.length;
    return variance < 2.5;
}
function isTextSymmetric(text) {
    const half = Math.floor(text.length / 2);
    const firstHalf = text.slice(0, half).toLowerCase();
    const secondHalf = text.slice(half).toLowerCase();
    const firstWords = new Set(firstHalf.match(/\b\w+\b/g) || []);
    const secondWords = new Set(secondHalf.match(/\b\w+\b/g) || []);
    const intersection = [...firstWords].filter(w => secondWords.has(w));
    return intersection.length / Math.max(firstWords.size, 1) > 0.4;
}
function detectOpposites(text) {
    const oppositePairs = [
        ['light', 'dark'], ['begin', 'end'], ['open', 'close'],
        ['fast', 'slow'], ['hot', 'cold'], ['near', 'far'],
        ['full', 'empty'], ['love', 'hate'], ['life', 'death'],
        ['old', 'new'], ['large', 'small'], ['yes', 'no'],
    ];
    const lower = text.toLowerCase();
    return oppositePairs.some(([a, b]) => new RegExp(`\\b${a}\\b`).test(lower) && new RegExp(`\\b${b}\\b`).test(lower));
}
//# sourceMappingURL=chorus.js.map