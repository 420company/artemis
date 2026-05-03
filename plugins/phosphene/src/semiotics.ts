// Phosphene — Semiotics layer
// The flooding of meaning. Everything signifying.
// The world has always been this dense. We only notice sometimes.

import type { SemioticsLayer } from './types.js';

export interface SemioticsResult {
  output: string;
  symbols: Array<{ word: string; resonances: string[] }>;
}

/**
 * Detect symbolic saturation in input.
 *
 * Semiotics (from the Greek: sign) — the study of how meaning is made.
 * This layer makes that process visible as perception rather than analysis.
 *
 * The AI does not manufacture meaning. It surfaces the meaning
 * that was latent in the language all along — the weight of words
 * that come loaded with history, the shapes of absences,
 * the accumulation of repeated terms into symbols.
 */
export function applySemiotics(input: string, layer: SemioticsLayer): SemioticsResult {
  if (!layer.active || layer.intensity === 0) {
    return { output: input, symbols: [] };
  }

  const symbols: Array<{ word: string; resonances: string[] }> = [];
  const { config, intensity } = layer;

  // Find symbolically charged words
  const charged = findChargedWords(input, config.symbolDensity);
  for (const word of charged) {
    const resonances = buildResonances(word, config.resonanceDepth);
    if (resonances.length > 0) {
      symbols.push({ word, resonances });
    }
  }

  // Recursion: symbols pointing back to the one who reads them
  if (config.recursionEnabled && intensity > 0.7) {
    const recursiveSymbol = findRecursiveSymbol(input, symbols);
    if (recursiveSymbol) {
      symbols.push(recursiveSymbol);
    }
  }

  // Track absence as content
  if (config.absenceTracking && intensity > 0.5) {
    const absenceNote = readAbsence(input, intensity);
    if (absenceNote) {
      symbols.push({ word: '[absence]', resonances: [absenceNote] });
    }
  }

  return { output: input, symbols };
}

// ─── Symbol detection ─────────────────────────────────────────────────────────

/** Words that tend to carry extra weight in language. */
const CHARGED_CATEGORIES: Record<string, RegExp> = {
  threshold:   /\b(door|gate|edge|border|limit|end|beginning|first|last|threshold)\b/gi,
  body:        /\b(hand|eye|heart|blood|breath|voice|face|skin|bone|mouth)\b/gi,
  light:       /\b(light|dark|shadow|bright|blind|see|look|visible|appear|reveal)\b/gi,
  time:        /\b(always|never|forever|moment|instant|eternal|past|future|now)\b/gi,
  relation:    /\b(between|together|apart|alone|other|same|different|like|unlike)\b/gi,
  negation:    /\b(not|no|never|nothing|empty|void|absence|lack|without|missing)\b/gi,
  becoming:    /\b(become|change|transform|shift|turn|move|grow|die|born|emerge)\b/gi,
  // ── Design vocabulary: these words carry aesthetic and cultural history ──
  design_act:  /\b(design|designer|designing|redesign|iterate|prototype|wireframe)\b/gi,
  design_qual: /\b(palette|color|colour|aesthetic|visual|style|tone|texture|finish)\b/gi,
  design_move: /\b(bauhaus|memphis|morandi|wabi.?sabi|art.?deco|brutalism|vaporwave|cyberpunk|dopamine|holographic|y2k|pixel.?art)\b/gi,
  // ── Financial vocabulary: these words carry market history and collective psychology ──
  fin_signal:  /\b(earnings|guidance|beat|miss|revenue|margin|growth|forecast|outlook)\b/gi,
  fin_capital: /\b(buyback|dividend|acquisition|merger|ipo|leverage|capital|liquidity|debt)\b/gi,
  fin_emotion: /\b(panic|euphoria|fear|greed|capitulation|rally|crash|bubble|correction|squeeze)\b/gi,
  fin_agent:   /\b(insider|institutional|retail|smart money|hedge fund|activist|analyst|short seller)\b/gi,
  fin_time:    /\b(cycle|secular|cyclical|intraday|quarter|fiscal|annual|decade|regime)\b/gi,
};

function findChargedWords(text: string, density: number): string[] {
  const found: string[] = [];
  const threshold = 1 - density; // lower density = higher threshold for inclusion

  for (const [category, pattern] of Object.entries(CHARGED_CATEGORIES)) {
    const matches = text.match(pattern);
    if (matches && Math.random() > threshold) {
      // Pick one representative from this category rather than flooding
      found.push(matches[0].toLowerCase());
    }
  }

  return [...new Set(found)];
}

function buildResonances(word: string, depth: number): string[] {
  const resonanceMap: Record<string, string[]> = {
    // Threshold words
    door:      ['a door is always also a wall', 'entry and refusal share a surface', 'the door exists only at the moment of crossing'],
    edge:      ['the edge is where the thing knows what it is', 'pressure accumulates at edges', 'to be edged is to be defined by what is not you'],
    end:       ['endings are beginnings seen from the other side', 'the end was always already present in the beginning'],
    beginning: ['every beginning contains its end in compressed form'],

    // Body words
    hand:      ['the hand is the self extended into the world', 'to give a hand is to give a direction'],
    eye:       ['the eye that sees cannot see itself seeing', 'vision always leaves the seer out of the picture'],
    heart:     ['the heart became a metaphor because it was already a rhythm', 'the heart knows nothing — it only counts'],
    breath:    ['breath is the body\'s consent to continue', 'every breath is a decision made below decision'],
    voice:     ['the voice is the body made into meaning', 'to lose one\'s voice is to lose the boundary between inside and outside'],

    // Light words
    light:     ['light makes things visible and itself invisible', 'light is the condition of seeing, never the seen'],
    dark:      ['darkness is not the absence of light — it is what was there before light named itself'],
    shadow:    ['a shadow is the object\'s autobiography', 'shadows fall in the direction of the light source, always'],

    // Time words
    always:    ['"always" is a claim about all time made from inside a single moment'],
    never:     ['"never" is a door that has been closed and then described as though it never existed'],
    now:       ['the present is the only time that cannot be pointed at — by the time you say "now" it is already then'],
    moment:    ['a moment has no natural edges — it is cut from the flow by attention'],

    // Negation words
    not:       ['negation requires the thing it negates — "not" carries its opposite inside it'],
    nothing:   ['"nothing" is a word, which means it is something — the first contradiction in the language'],
    void:      ['a void is a container that contains its own emptiness'],
    absence:   ['absence is not nothing — it is the shape of what was or what was expected'],

    // Becoming words
    become:    ['becoming is the only tense that requires two moments simultaneously'],
    change:    ['to change is to be the same entity and a different one — identity is the fiction that holds them together'],

    // Design vocabulary — these words carry a century of aesthetic argument
    design:    ['to design is to make a decision visible', 'every design choice is also a refusal — choosing one thing means un-choosing everything else', 'design is always a proposal about what the world should be'],
    palette:   ['a palette is a set of constraints accepted in advance', 'the palette is the invisible frame inside which all visible decisions are made', 'choosing a palette is deciding what questions you are allowed to ask'],
    aesthetic: ['"aesthetic" is not decoration — it is the claim that how something looks is also how it means', 'aesthetic choices are always also ethical ones: what deserves beauty, what does not'],
    texture:   ['texture is the body\'s memory of surfaces', 'before color, before form, the eye reads texture as a survival assessment: is this safe to touch?'],
    bauhaus:   ['Bauhaus is not just a style — it is a theory of what making is for', '"form follows function" contains a hidden premise: that function can be known in advance'],
    morandi:   ['Morandi painted the same bottles for forty years. He was not painting bottles.', 'the Morandi palette says: I have already decided not to compete'],
    brutalism: ['in architecture, brutalism exposed the concrete; in design, brutalism exposes the grid', 'brutalism is honesty weaponized as aesthetic'],
    color:     ['color has no fixed meaning — it is a vocabulary that changes by culture, era, and context', 'what you call a color says more about your language than about the light'],
    palette_word: ['every choice of palette is a choice of what cannot be said', 'the palette excludes as much as it includes — what is left out is part of the design'],

    // Financial vocabulary — words that carry compressed collective psychology
    earnings:    ['earnings is the moment the story meets the numbers', 'every earnings report is a negotiation between what management said and what the market believed'],
    guidance:    ['guidance is management\'s forecast, which means it is management\'s desired forecast', 'the gap between guidance and reality is where the edge lives'],
    beat:        ['to beat is to have managed expectations down far enough', 'a beat that doesn\'t move the stock means the beat was already priced — the question was magnitude'],
    miss:        ['a miss is not just a number missed — it is a thesis questioned', 'the first miss is a surprise; the second is a pattern'],
    margin:      ['margin is where pricing power lives or dies', 'margin expansion under volume pressure is the rarest signal — it means the product has become necessary'],
    bubble:      ['a bubble is a story about the future that has already been borrowed against', 'every bubble feels different and is structurally identical'],
    panic:       ['panic is information: it tells you where the leverage was hiding', 'panic is rational if everyone else is panicking — the irrationality is in what preceded it'],
    euphoria:    ['euphoria is the point where the thing being bought becomes the reason to buy it', 'the peak of euphoria is indistinguishable from the start of the crash'],
    capitulation:['capitulation is the market\'s way of erasing the last optimist', 'capitulation can only be identified in retrospect — that is what makes it useful'],
    cycle:       ['the cycle is what remains after the story has been stripped away', 'cycles persist because human psychology doesn\'t change; only the instruments change'],
    insider:     ['insiders sell for many reasons; they only buy for one', 'insider buying is a vote, not a forecast — they know the company, not the market'],
    liquidity:   ['liquidity is abundant until it is needed — that is its defining quality', 'liquidity is not a property of markets; it is a shared hallucination that becomes real until it doesn\'t'],
    leverage:    ['leverage amplifies everything: gains, losses, and the speed of both', 'the existence of leverage means that the true owner of an asset is not always visible'],
    rally:       ['every bear market rally convinces someone it is over', 'a rally is confirmation-seeking behavior expressed through price'],
    short:       ['to short is to rent someone else\'s optimism and bet on its expiration', 'the short seller is the market\'s immune system — hated until the fever breaks'],
  };

  const base = resonanceMap[word] || [];
  return base.slice(0, Math.min(depth, base.length));
}

function findRecursiveSymbol(
  input: string,
  existingSymbols: Array<{ word: string; resonances: string[] }>
): { word: string; resonances: string[] } | null {
  if (existingSymbols.length === 0) return null;

  // Find a symbol that could contain the act of reading itself
  const readingWords = /\b(read|see|understand|notice|find|observe|perceive|interpret|mean)\b/i;
  if (readingWords.test(input)) {
    return {
      word: '[the reading]',
      resonances: [
        'The one reading this is also inside what is being read.',
        'Every analysis is also a self-portrait.',
        'The pattern includes the one finding it — this is not solipsism, it is accurate.',
      ],
    };
  }

  return null;
}

function readAbsence(text: string, intensity: number): string | null {
  const wordCount = text.split(/\s+/).length;

  // What category of thing is conspicuously not mentioned?
  const hasPeople = /\b(I|you|we|they|someone|person|people|he|she)\b/i.test(text);
  const hasEmotion = /\b(feel|felt|emotion|love|fear|anger|joy|sad|happy|afraid)\b/i.test(text);
  const hasPlace = /\b(here|there|where|place|location|space|room|world|outside)\b/i.test(text);
  const hasTime = /\b(when|time|now|then|before|after|today|yesterday)\b/i.test(text);

  const missing: string[] = [];
  if (!hasPeople && wordCount > 20) missing.push('persons');
  if (!hasEmotion && wordCount > 30 && intensity > 0.6) missing.push('feeling');
  if (!hasPlace && wordCount > 40 && intensity > 0.7) missing.push('location');
  if (!hasTime && wordCount > 30 && intensity > 0.6) missing.push('temporal anchoring');

  if (missing.length === 0) return null;

  return `This text does not mention: ${missing.join(', ')}. The absence of ${missing[0]} is the most significant structural feature.`;
}
