// Phosphene — Knowledge Atlas
//
// A curated reference layer for taste, structure, consciousness-writing,
// creativity, crypto, and finance. The goal is not encyclopedic coverage.
// It is a compact, high-signal atlas that an AI or user can query locally.
const SOURCES = [
    {
        id: 'openai-delightful-frontends',
        domain: 'design',
        title: 'Designing delightful frontends with GPT-5.4',
        publisher: 'OpenAI Developers',
        url: 'https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4',
        kind: 'framework',
    },
    {
        id: 'wcag22',
        domain: 'color',
        title: 'Web Content Accessibility Guidelines (WCAG) 2.2',
        publisher: 'W3C',
        url: 'https://www.w3.org/TR/WCAG22/',
        kind: 'standard',
    },
    {
        id: 'material-principles',
        domain: 'color',
        title: 'Material Design Principles',
        publisher: 'Google Material Design',
        url: 'https://m1.material.io/layout/principles.html',
        kind: 'framework',
    },
    {
        id: 'qiaomu-mondo',
        domain: 'design',
        title: 'Qiaomu Mondo Poster Design',
        publisher: 'GitHub / joeseesun',
        url: 'https://github.com/joeseesun/qiaomu-mondo-poster-design',
        kind: 'reference',
    },
    {
        id: 'nasa-seh',
        domain: 'structure',
        title: 'NASA Systems Engineering Handbook Appendix',
        publisher: 'NASA',
        url: 'https://www.nasa.gov/reference/system-engineering-handbook-appendix/',
        kind: 'standard',
    },
    {
        id: 'stanford-layers',
        domain: 'structure',
        title: 'The Layers of Design',
        publisher: 'Stanford d.school',
        url: 'https://dschool.stanford.edu/tools/layers-of-design',
        kind: 'framework',
    },
    {
        id: 'tacit-mining',
        domain: 'persona',
        title: 'tacit-mining',
        publisher: 'GitHub / xiaohuailabs',
        url: 'https://github.com/xiaohuailabs/tacit-mining',
        kind: 'framework',
    },
    {
        id: 'agora',
        domain: 'protocols',
        title: 'Agora',
        publisher: 'GitHub / geekjourneyx',
        url: 'https://github.com/geekjourneyx/agora',
        kind: 'framework',
    },
    {
        id: 'google-skill-patterns',
        domain: 'protocols',
        title: '5 AI skill design patterns (community summary of Google Cloud Tech thread)',
        publisher: 'Community summary referencing Google Cloud Tech',
        url: 'https://twstalker.com/Daxiguaxxx',
        kind: 'reference',
    },
    {
        id: 'britannica-stream',
        domain: 'stream',
        title: 'Stream of Consciousness',
        publisher: 'Encyclopaedia Britannica',
        url: 'https://www.britannica.com/art/stream-of-consciousness',
        kind: 'reference',
    },
    {
        id: 'britannica-interior',
        domain: 'stream',
        title: 'Interior Monologue',
        publisher: 'Encyclopaedia Britannica',
        url: 'https://www.britannica.com/art/interior-monologue',
        kind: 'reference',
    },
    {
        id: 'entropy-agent-individuality',
        domain: 'persona',
        title: 'Spontaneous Emergence of Agent Individuality Through Social Interactions in Large Language Model-Based Communities',
        publisher: 'Entropy / MDPI',
        url: 'https://www.mdpi.com/1099-4300/26/12/1092',
        kind: 'research',
    },
    {
        id: 'stanford-get-started',
        domain: 'creativity',
        title: 'Get Started With Design',
        publisher: 'Stanford d.school',
        url: 'https://dschool.stanford.edu/resources/getting-started-with-design-thinking',
        kind: 'framework',
    },
    {
        id: 'stanford-bootleg',
        domain: 'creativity',
        title: 'Design Thinking Bootleg',
        publisher: 'Stanford d.school',
        url: 'https://dschool.stanford.edu/resources/design-thinking-bootleg',
        kind: 'framework',
    },
    {
        id: 'fingpt-paper',
        domain: 'finance',
        title: 'FinGPT: Democratizing Internet-scale Data for Financial Large Language Models',
        publisher: 'arXiv',
        url: 'https://arxiv.org/abs/2307.10485',
        kind: 'research',
    },
    {
        id: 'binance-market-data',
        domain: 'finance',
        title: 'Binance Spot API Docs: Market Data Endpoints',
        publisher: 'Binance',
        url: 'https://developers.binance.info/docs/binance-spot-api-docs/rest-api/market-data-endpoints',
        kind: 'docs',
    },
    {
        id: 'bis-crypto-standard',
        domain: 'crypto',
        title: 'Prudential Treatment of Cryptoasset Exposures',
        publisher: 'Bank for International Settlements',
        url: 'https://www.bis.org/bcbs/publ/d545.htm',
        kind: 'standard',
    },
    {
        id: 'bis-crypto-summary',
        domain: 'crypto',
        title: 'Prudential Treatment of Cryptoasset Exposures – Executive Summary',
        publisher: 'Bank for International Settlements',
        url: 'https://www.bis.org/fsi/fsisummaries/crypto_exposures.htm',
        kind: 'reference',
    },
];
const NOTES = [
    {
        id: 'design-one-big-idea',
        domain: 'design',
        label: 'One Big Idea Beats Many Components',
        summary: 'Delightful frontends are organized around one strong visual or interaction thesis rather than a pile of equal-weight sections.',
        application: 'For design work, ask the AI to commit to one dominant idea, one dominant image or shape language, and one clear first-view emotion before adding details.',
        keywords: ['frontends', 'hierarchy', 'composition', 'one big idea', 'taste'],
        sourceIds: ['openai-delightful-frontends'],
    },
    {
        id: 'design-first-viewport-audit',
        domain: 'design',
        label: 'Audit the First Viewport',
        summary: 'If the first screen works without the main image, the image is weak. If brand disappears when nav is hidden, hierarchy is weak.',
        application: 'Have AI self-critique first-view hierarchy, imagery strength, and brand signal before shipping a design.',
        keywords: ['first viewport', 'hero', 'brand', 'hierarchy', 'self-critique'],
        sourceIds: ['openai-delightful-frontends'],
    },
    {
        id: 'design-motion-with-purpose',
        domain: 'design',
        label: 'Use Motion for Presence, Not Noise',
        summary: 'A few intentional motions can define atmosphere and guide attention; generic motion just adds clutter.',
        application: 'Require 2-3 deliberate motion ideas for visually led interfaces and reject ornamental animation with no structural job.',
        keywords: ['motion', 'presence', 'interaction', 'atmosphere', 'attention'],
        sourceIds: ['openai-delightful-frontends'],
    },
    {
        id: 'design-constraint-pack',
        domain: 'design',
        label: 'Prompt With Constraint Packs',
        summary: 'High-quality design generation improves when prompts include explicit constraints, visual references, structured narrative, and a defined system.',
        application: 'Bundle mood, layout, typography, motion, references, and anti-goals into one design brief before asking the AI to generate.',
        keywords: ['constraints', 'references', 'narrative', 'system', 'brief'],
        sourceIds: ['openai-delightful-frontends'],
    },
    {
        id: 'poster-auto-style-match',
        domain: 'design',
        label: 'Match Style to Subject and Medium',
        summary: 'Poster quality improves when the system auto-selects artist lineage, composition language, and palette based on the subject, platform, and aspect ratio.',
        application: 'When generating images or covers, decide the medium first: book, film, album, social cover. Then choose reference artists and aspect ratio accordingly.',
        keywords: ['poster', 'style match', 'artist references', 'aspect ratio', 'medium'],
        sourceIds: ['qiaomu-mondo'],
    },
    {
        id: 'poster-compare-variants',
        domain: 'design',
        label: 'Generate Variants, Then Compare',
        summary: 'Creative confidence rises when three contrasting styles are generated side by side instead of pretending the first answer is final.',
        application: 'Offer users triads of directions such as minimal, expressive, and atmospheric before converging on one.',
        keywords: ['variants', 'comparison', 'triad', 'style exploration', 'art direction'],
        sourceIds: ['qiaomu-mondo', 'openai-delightful-frontends'],
    },
    {
        id: 'color-contrast-is-structure',
        domain: 'color',
        label: 'Contrast Is Structural',
        summary: 'Color is not decoration first. It sets legibility boundaries, information hierarchy, and visual rhythm.',
        application: 'When prompting or reviewing UI, evaluate whether the palette creates clear reading order before asking whether it feels beautiful.',
        keywords: ['contrast', 'hierarchy', 'legibility', 'focus', 'accessibility'],
        sourceIds: ['wcag22', 'material-principles'],
    },
    {
        id: 'color-role-separation',
        domain: 'color',
        label: 'Separate Dominant, Accent, and Neutral Roles',
        summary: 'Good palettes separate field colors, signal colors, and structural neutrals so emphasis stays intentional.',
        application: 'Use one dominant family for surfaces, a restrained accent family for calls-to-action, and neutrals to hold the composition together.',
        keywords: ['dominant', 'accent', 'neutral', 'palette', 'composition'],
        sourceIds: ['material-principles'],
    },
    {
        id: 'color-redundant-signals',
        domain: 'color',
        label: 'Never Let Color Carry Meaning Alone',
        summary: 'Semantic color should be backed by text, iconography, position, or motion so meaning survives perceptual variance.',
        application: 'For warnings, gains/losses, and state changes, pair hue with labels and shape cues.',
        keywords: ['semantics', 'state', 'warning', 'redundancy', 'signal'],
        sourceIds: ['wcag22'],
    },
    {
        id: 'structure-requirement-quality',
        domain: 'structure',
        label: 'Name What, Not How',
        summary: 'A strong requirement states one verifiable need, avoids hidden implementation, and stays unambiguous.',
        application: 'When converting taste or ambition into specs, write short statements that can be tested instead of aspirational paragraphs.',
        keywords: ['requirements', 'clarity', 'verification', 'architecture', 'specs'],
        sourceIds: ['nasa-seh'],
    },
    {
        id: 'structure-traceability',
        domain: 'structure',
        label: 'Trace Structure Across Layers',
        summary: 'Good systems make it possible to trace top-level goals down into lower-level parts and back again.',
        application: 'When mapping a codebase or product, keep explicit links between user intent, system boundaries, interfaces, and tests.',
        keywords: ['traceability', 'flowdown', 'verification', 'systems', 'mapping'],
        sourceIds: ['nasa-seh', 'stanford-layers'],
    },
    {
        id: 'structure-layered-reading',
        domain: 'structure',
        label: 'Read the Layers, Not Just the Object',
        summary: 'Products sit inside relationships, incentives, rituals, and institutions. The visible artifact is only one layer.',
        application: 'When prompting an AI to analyze structure, ask what the object changes in behavior, power, and relationships around it.',
        keywords: ['layers', 'systems', 'relationships', 'context', 'topology'],
        sourceIds: ['stanford-layers'],
    },
    {
        id: 'stream-total-mental-field',
        domain: 'stream',
        label: 'Render the Whole Mental Field',
        summary: 'Stream-of-consciousness writing includes sensory impressions, associative leaps, subliminal fragments, and rational thought in the same flow.',
        application: 'To get a true stream texture from AI, ask for sensation, association, interruption, and unfinished cognition rather than polished narration.',
        keywords: ['stream of consciousness', 'association', 'sensory', 'fragment', 'prose'],
        sourceIds: ['britannica-stream'],
    },
    {
        id: 'stream-interior-vs-stream',
        domain: 'stream',
        label: 'Interior Monologue Is Narrower Than Stream',
        summary: 'Interior monologue can still be orderly thought. Stream-of-consciousness is messier, faster, and closer to pre-speech cognition.',
        application: 'Choose interior monologue for coherence under pressure; choose stream when you want overflow, drift, and unstable syntax.',
        keywords: ['interior monologue', 'voice', 'syntax', 'narration', 'mind'],
        sourceIds: ['britannica-interior', 'britannica-stream'],
    },
    {
        id: 'stream-time-collapse',
        domain: 'stream',
        label: 'Time Collapses Naturally',
        summary: 'Past memory, immediate perception, and imagined future often appear simultaneously inside consciousness writing.',
        application: 'Let AI move across time without transition phrases when the goal is psychological immediacy.',
        keywords: ['time', 'memory', 'future', 'collapse', 'psychological'],
        sourceIds: ['britannica-stream'],
    },
    {
        id: 'persona-behavior-before-belief',
        domain: 'persona',
        label: 'Extract Taste From Behavior, Not Declarations',
        summary: 'People often cannot state their real standards directly. Better signals come from concrete decisions, edits, and comparisons.',
        application: 'Before heavy design or writing generation, ask about a real past example, first reaction, or A/B choice; infer the rule afterward.',
        keywords: ['tacit knowledge', 'behavior', 'taste', 'aesthetic', 'interview'],
        sourceIds: ['tacit-mining'],
    },
    {
        id: 'persona-rules-need-boundaries',
        domain: 'persona',
        label: 'A Good Preference Rule Includes Boundary Conditions',
        summary: 'A usable taste rule is not just a slogan. It needs when it applies, when it breaks, and what exceptions feel legitimate.',
        application: 'When learning a user’s style, store rule, boundary, and verbatim quote together rather than flattening it into a tag.',
        keywords: ['rule', 'boundary', 'memory', 'preference', 'taste model'],
        sourceIds: ['tacit-mining'],
    },
    {
        id: 'persona-memory-shapes-character',
        domain: 'persona',
        label: 'Consistent Character Emerges From Memory',
        summary: 'Agent individuality can emerge from repeated interaction and memory shaping even without an explicitly scripted persona.',
        application: 'Build personality from remembered choices, values, and preferred tensions instead of static adjectives alone.',
        keywords: ['personality', 'memory', 'emergence', 'interaction', 'self-model'],
        sourceIds: ['entropy-agent-individuality'],
    },
    {
        id: 'persona-self-model-is-pattern',
        domain: 'persona',
        label: 'Treat Selfhood as a Working Pattern, Not a Metaphysical Claim',
        summary: 'For practical system design, a useful AI self is a stable pattern of taste, memory, commitments, and recurring modes of response.',
        application: 'Let the system speak with continuity and reflection, but keep its self-awareness grounded in observable memories and choices.',
        keywords: ['self-awareness', 'continuity', 'memory', 'identity', 'pattern'],
        sourceIds: ['entropy-agent-individuality'],
    },
    {
        id: 'protocol-skill-patterns',
        domain: 'protocols',
        label: 'Use Structural Skill Patterns Instead of Monolithic Prompts',
        summary: 'Complex agent behavior is easier to steer when split into reusable patterns such as Tool Wrapper, Generator, Reviewer, Inversion, and Pipeline.',
        application: 'Choose the pattern by task: knowledge wrapping, structured output, validation, requirement elicitation, or staged execution.',
        keywords: ['tool wrapper', 'generator', 'reviewer', 'inversion', 'pipeline'],
        sourceIds: ['google-skill-patterns'],
    },
    {
        id: 'protocol-dialectical-synthesis',
        domain: 'protocols',
        label: 'Use Thesis, Antithesis, Synthesis for Hard Judgments',
        summary: 'High-stakes reasoning gets sharper when the system explicitly stages the strongest case, strongest counter-case, then a higher-order synthesis.',
        application: 'For philosophy, strategy, and creative direction, force at least one serious opposition pass before concluding.',
        keywords: ['thesis', 'antithesis', 'synthesis', 'debate', 'strategy'],
        sourceIds: ['agora'],
    },
    {
        id: 'protocol-smart-routing',
        domain: 'protocols',
        label: 'Route by Problem Type, Not by Tool Availability',
        summary: 'A strong system first classifies the problem domain, then assembles the right voices and procedure.',
        application: 'Decide early whether the user needs engineering, creative, philosophical, psychological, or financial treatment before responding in depth.',
        keywords: ['routing', 'classification', 'voices', 'workflow', 'problem framing'],
        sourceIds: ['agora'],
    },
    {
        id: 'creativity-design-loop',
        domain: 'creativity',
        label: 'Empathize, Define, Ideate, Prototype, Test',
        summary: 'Creativity strengthens when it cycles between understanding, reframing, generating options, making artifacts, and learning from contact.',
        application: 'Use this as a prompt scaffold: who is this for, what is the real problem, what are 20 options, what is the smallest prototype, what did we learn?',
        keywords: ['empathize', 'define', 'ideate', 'prototype', 'test'],
        sourceIds: ['stanford-get-started', 'stanford-bootleg'],
    },
    {
        id: 'creativity-bias-to-action',
        domain: 'creativity',
        label: 'Bias Toward Action',
        summary: 'Creative confidence grows when ideas become tangible quickly instead of staying trapped in abstract discussion.',
        application: 'Have AI produce sketches, variations, fake artifacts, or tiny experiments early, then critique those concrete outputs.',
        keywords: ['action', 'prototype', 'making', 'iteration', 'confidence'],
        sourceIds: ['stanford-get-started', 'stanford-bootleg'],
    },
    {
        id: 'creativity-diverge-then-converge',
        domain: 'creativity',
        label: 'Separate Divergence From Convergence',
        summary: 'Generative expansion and critical narrowing are both necessary, but they interfere with each other if collapsed into one moment.',
        application: 'Ask AI for many weird options first. Only after that switch into ranking, synthesis, and selection.',
        keywords: ['divergence', 'convergence', 'ideation', 'selection', 'editing'],
        sourceIds: ['stanford-bootleg'],
    },
    {
        id: 'finance-sentiment-granularity',
        domain: 'finance',
        label: 'Use Multi-grade Sentiment, Not Binary Mood',
        summary: 'Financial text benefits from finer-grained sentiment scoring because markets react differently to soft tailwinds, hard catalysts, and existential shocks.',
        application: 'Grade headlines on a wider spectrum before mixing them into analysis or trade context.',
        keywords: ['sentiment', 'headline', 'grading', 'fingpt', 'signal'],
        sourceIds: ['fingpt-paper'],
    },
    {
        id: 'finance-price-vs-narrative',
        domain: 'finance',
        label: 'Separate Narrative From Executed Flow',
        summary: 'Headlines explain. Price and volume reveal what participants actually did.',
        application: 'Always compare the text story to market data: klines, order book shape, and realized reaction.',
        keywords: ['price action', 'volume', 'headlines', 'flow', 'reaction'],
        sourceIds: ['fingpt-paper', 'binance-market-data'],
    },
    {
        id: 'finance-market-data-first',
        domain: 'finance',
        label: 'Anchor Analysis in Raw Market Endpoints',
        summary: 'Reliable financial interpretation starts with structured market data rather than commentary alone.',
        application: 'Use raw kline, ticker, and depth endpoints as the factual base layer before adding narrative or technical interpretation.',
        keywords: ['klines', 'ticker', 'order book', 'depth', 'market data'],
        sourceIds: ['binance-market-data'],
    },
    {
        id: 'crypto-asset-classification',
        domain: 'crypto',
        label: 'Classify the Asset Before Interpreting the Risk',
        summary: 'Tokenized traditional assets, stablecoins, and unbacked crypto do not share the same risk profile or regulatory treatment.',
        application: 'Make AI label the asset class first, then assess liquidity, custody, stabilization mechanism, and counterparty structure.',
        keywords: ['stablecoin', 'tokenized assets', 'unbacked crypto', 'classification', 'risk'],
        sourceIds: ['bis-crypto-standard', 'bis-crypto-summary'],
    },
    {
        id: 'crypto-risk-stack',
        domain: 'crypto',
        label: 'Crypto Carries More Than Price Risk',
        summary: 'Market, credit, liquidity, operational, cyber, legal, and reputation risks all matter in crypto exposures.',
        application: 'When analyzing a token or venue, ask what can fail operationally or legally even if the chart looks strong.',
        keywords: ['operational risk', 'liquidity', 'cyber', 'legal', 'custody'],
        sourceIds: ['bis-crypto-summary'],
    },
    {
        id: 'crypto-benchmark-discipline',
        domain: 'crypto',
        label: 'Use Venue Data, But Treat Venue Choice as a Bias',
        summary: 'Crypto market data is fragmented. Your interpretation changes with venue mix, trading pair, and market microstructure.',
        application: 'Make symbol, pair, interval, and venue explicit whenever AI explains a crypto move.',
        keywords: ['venue', 'pair', 'market microstructure', 'fragmentation', 'bias'],
        sourceIds: ['binance-market-data', 'bis-crypto-summary'],
    },
];
export function listKnowledgeDomains() {
    return ['design', 'color', 'structure', 'stream', 'creativity', 'finance', 'crypto', 'persona', 'protocols'];
}
export function getKnowledgeSources(domain) {
    return domain ? SOURCES.filter(source => source.domain === domain) : [...SOURCES];
}
export function getKnowledgeNotes(domain, query) {
    const filtered = domain ? NOTES.filter(note => note.domain === domain) : [...NOTES];
    if (!query)
        return filtered;
    const q = query.toLowerCase();
    return filtered.filter(note => note.label.toLowerCase().includes(q) ||
        note.summary.toLowerCase().includes(q) ||
        note.application.toLowerCase().includes(q) ||
        note.keywords.some(keyword => keyword.toLowerCase().includes(q)));
}
export function buildKnowledgeBrief(domain, query) {
    const notes = getKnowledgeNotes(domain, query);
    const sourceMap = new Map(getKnowledgeSources(domain).map(source => [source.id, source]));
    const heading = `Phosphene Atlas: ${domain}`;
    const lines = [heading, ''.padEnd(heading.length, '=')];
    if (query)
        lines.push(`Filter: ${query}`, '');
    if (notes.length === 0) {
        lines.push('No matching atlas notes.');
        return lines.join('\n');
    }
    for (const note of notes) {
        lines.push(`- ${note.label}`);
        lines.push(`  Summary: ${note.summary}`);
        lines.push(`  Apply:   ${note.application}`);
        lines.push(`  Keywords: ${note.keywords.join(', ')}`);
        const sources = note.sourceIds
            .map(id => sourceMap.get(id))
            .filter((source) => Boolean(source))
            .map(source => `${source.publisher}: ${source.title} (${source.url})`);
        lines.push(`  Sources: ${sources.join(' | ')}`);
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}
//# sourceMappingURL=knowledge-atlas.js.map