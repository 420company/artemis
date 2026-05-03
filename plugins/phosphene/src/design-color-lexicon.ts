// Phosphene — Design Color Lexicon
// A structured knowledge base mapping design vocabulary to perceptual data.
//
// Used by synesthesia, apophenia, and semiotics layers to produce
// culturally accurate design intelligence rather than word-count heuristics.
//
// Coverage: classic art movements · digital-commercial trends ·
//           subcultural aesthetics · industrial standards

// ─── Types ────────────────────────────────────────────────────────────────────

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

export type TemperatureProfile =
  | 'hot'           // overheated, aggressive
  | 'warm'          // bodily, approachable
  | 'cool'          // detached, intellectual
  | 'cold'          // hostile, artificial winter
  | 'earth'         // ambient organic warmth
  | 'artificial'    // neon, synthetic — temperature that has no natural equivalent
  | 'oscillating'   // unstable — swings between registers
  | 'metallic';     // neither warm nor cool — reflective surfaces absorb temperature

export type SaturationProfile =
  | 'maximum'   // everything at or near 100% saturation
  | 'high'      // vivid but not aggressive
  | 'medium'    // balanced — neither flat nor vivid
  | 'low'       // muted, complex color relationships
  | 'limited'   // restricted palette by design (pixel art, Bauhaus)
  | 'variable'; // wide range within system — contextual

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

// ─── Design Token types ───────────────────────────────────────────────────────

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

// ─── Color System Entries ─────────────────────────────────────────────────────

const SYSTEMS: DesignColorSystem[] = [

  // ── Classic Art Movements ──────────────────────────────────────────────────

  {
    id: 'memphis',
    label: 'Memphis',
    aliases: ['memphis', 'memphis design', 'memphis group', 'memphis style', 'memphis aesthetic'],
    era: '1980s',
    origin: 'Milan, Italy — Ettore Sottsass',
    palette: {
      dominant:  ['primary yellow (#F7E03C)', 'hot pink (#E8208A)', 'electric blue (#2255CC)', 'acid green (#88CC00)'],
      accents:   ['tangerine orange (#FF6B35)', 'violet (#8833FF)', 'turquoise (#00CCBB)'],
      neutrals:  ['pure white (#FFFFFF)', 'black (#000000)', 'bold graphite (#333333)'],
      forbidden: ['gradients', 'desaturated tones', '"harmonious" color relationships', 'natural earth tones'],
    },
    visualGrammar: 'High-saturation collision. Colors do not relate — they interrupt each other. The composition is intentionally unstable; the eye has nowhere to rest.',
    textureProfile: 'Flat, matte, tactile — like cardboard cutouts or screen-printed paper. No depth, no material simulation. The surface is the thing.',
    shapeLanguage: 'Geometric confetti: overlapping circles, zigzags, grid dots, Memphis squiggles, bold stripes. Everything is a 2D shape asserting its own existence.',
    temperature: 'hot',
    saturation: 'maximum',
    contexts: ['creative posters', 'editorial design', 'playful UI', 'youth branding', 'event design', 'packaging'],
    relatedSystems: ['pop_art', 'dopamine'],
    tensionsWith: ['bauhaus', 'morandi', 'wabi_sabi'],
    absenceSignal: 'Depth, shadow, or visual hierarchy. Memphis refuses to tell you what to look at first.',
    culturalWeight: 'A deliberate act of violence against Bauhaus-descended minimalism. Every Memphis piece is a manifesto: decoration is not a crime, pleasure is not trivial, ugliness can be beautiful.',
  },

  {
    id: 'bauhaus',
    label: 'Bauhaus',
    aliases: ['bauhaus', 'bauhaus style', 'bauhaus design', 'bauhaus aesthetic', 'modernist', 'constructivist'],
    era: '1919–1933',
    origin: 'Weimar/Dessau/Berlin, Germany',
    palette: {
      dominant:  ['pure red (#CC0000)', 'primary blue (#0055CC)', 'primary yellow (#FFDD00)'],
      accents:   ['black (#000000)', 'white (#FFFFFF)'],
      neutrals:  ['mid-grey (#888888)', 'light grey (#CCCCCC)', 'dark grey (#333333)'],
      forbidden: ['pastels', 'gradients', 'decorative color', 'colors without structural function'],
    },
    visualGrammar: 'Color as structure, not decoration. Each hue has a role: red advances, blue recedes, yellow expands. Nothing is present unless it does functional work.',
    textureProfile: 'Smooth, impersonal, precise. The material announces itself — wood grain, metal edge — but is never embellished. Texture serves structure.',
    shapeLanguage: 'Strict geometric vocabulary: circle, square, triangle. Asymmetric balance. The grid is sacred. Nothing curves without purpose.',
    temperature: 'cool',
    saturation: 'limited',
    contexts: ['institutional design', 'architecture', 'typography', 'systematic UI', 'product design', 'education'],
    relatedSystems: ['material_design'],
    tensionsWith: ['memphis', 'pop_art', 'dopamine'],
    absenceSignal: 'Decoration, ornament, or color for its own pleasure. Bauhaus is the system that asks: if you removed this element, would anything be lost?',
    culturalWeight: 'The origin of modern design thinking. "Form follows function" is not just a rule — it is an ethics of making. Every flat UI in existence carries Bauhaus DNA.',
  },

  {
    id: 'morandi',
    label: 'Morandi',
    aliases: ['morandi', 'morandi palette', 'morandi color', 'morandi aesthetic', 'high level grey', 'high-level grey', 'elegant grey', 'muted palette', 'desaturated elegant'],
    era: 'Early–mid 20th century (contemporary revival 2010s–present)',
    origin: 'Bologna, Italy — Giorgio Morandi',
    palette: {
      dominant:  ['ash rose (#C4A99A)', 'dusty sage (#8A9E8A)', 'warm grey (#B5ADA6)', 'antique white (#F0EBE3)'],
      accents:   ['faded ochre (#C8B08A)', 'muted lavender (#9C95AA)', 'pale terracotta (#C9967A)'],
      neutrals:  ['linen white (#F5F0EB)', 'warm charcoal (#5C5652)', 'greige (#C2B9AD)'],
      forbidden: ['pure saturated color', 'high contrast', 'neon', 'anything that declares itself loudly'],
    },
    visualGrammar: 'Every color is diluted with grey until it becomes polite. The chromatic relationships are close, intimate, non-confrontational. Harmony through restraint.',
    textureProfile: 'Dry, powdery, slightly porous — like fresco or chalky paint. There is a sensation of dust on glass, of light absorbed rather than reflected.',
    shapeLanguage: 'Simple organic volumes: bottles, vessels, boxes. Soft shadows. Nothing geometric or aggressive. The composition breathes slowly.',
    temperature: 'earth',
    saturation: 'low',
    contexts: ['luxury branding', 'minimalist UI', 'home goods', 'skincare/cosmetics', 'lifestyle editorial', 'space design', 'fashion'],
    relatedSystems: ['wabi_sabi', 'dark_academia'],
    tensionsWith: ['memphis', 'cyberpunk', 'acid_graphics', 'dopamine'],
    absenceSignal: 'Energy, urgency, declaration. Morandi is the aesthetic of things that have already happened, already settled.',
    culturalWeight: 'In contemporary design, Morandi palette has become a universal shorthand for "quiet luxury" — the color of restraint as status signal. It says: I do not need to shout.',
  },

  {
    id: 'pop_art',
    label: 'Pop Art',
    aliases: ['pop art', 'pop-art', 'warhol', 'andy warhol', 'lichtenstein', 'pop aesthetic', 'comic pop', 'halftone', 'ben-day dots'],
    era: '1950s–1970s',
    origin: 'New York / London',
    palette: {
      dominant:  ['process yellow (#FFDD00)', 'process magenta (#FF00AA)', 'process cyan (#00AAFF)'],
      accents:   ['red (#FF2200)', 'lime green (#88FF00)', 'orange (#FF6600)'],
      neutrals:  ['black (#000000)', 'white (#FFFFFF)'],
      forbidden: ['naturalistic color', 'tonal nuance', 'anything that takes itself seriously'],
    },
    visualGrammar: 'Flat, declarative, aggressive. Printing-process colors used at full strength with black contour. The image is always already a reproduction.',
    textureProfile: 'Screen-printed, slightly offset, the dot matrix visible up close. Industrial reproduction as aesthetic, not as flaw.',
    shapeLanguage: 'Bold outlines, flat planes, comic-book cell structure. The contour line is as important as the fill.',
    temperature: 'hot',
    saturation: 'maximum',
    contexts: ['poster design', 'political graphics', 'editorial illustration', 'streetwear', 'packaging', 'event branding'],
    relatedSystems: ['memphis', 'dopamine', 'neo_brutalism'],
    tensionsWith: ['morandi', 'wabi_sabi', 'dark_academia'],
    absenceSignal: 'Sincerity, depth, or the claim to unique originality. Pop Art is always quoting something.',
    culturalWeight: 'The first modern art movement to declare that mass culture and fine art occupy the same space. Every meme aesthetic, every ironic commercial design, descends from this.',
  },

  {
    id: 'art_deco',
    label: 'Art Deco',
    aliases: ['art deco', 'art-deco', 'deco', 'gatsby', 'great gatsby', 'jazz age', '1920s aesthetic', 'roaring twenties'],
    era: '1920s–1940s',
    origin: 'Paris, international',
    palette: {
      dominant:  ['black (#0A0A0A)', 'deep gold (#C9A84C)', 'midnight navy (#1A1A3A)'],
      accents:   ['champagne (#F7E7CE)', 'emerald (#1A6B3C)', 'burgundy (#7A1528)', 'ivory (#FFFFF0)'],
      neutrals:  ['cream (#FAF0E6)', 'warm charcoal (#3A3028)'],
      forbidden: ['pastels', 'casualness', 'organic irregularity', 'anything suggesting poverty or impermanence'],
    },
    visualGrammar: 'Luxury through geometry. Gold linearizes everything. The decorative detail is always symmetrical, always precise, always announcing the cost of production.',
    textureProfile: 'Polished, metallic, cool to the touch. Lacquer, gilding, chrome, inlaid marble. Every surface has been deliberately finished.',
    shapeLanguage: 'Sunburst rays, chevrons, stepped ziggurats, stylized natural forms. Symmetry as power. The geometric grid underlying all organic ornament.',
    temperature: 'metallic',
    saturation: 'variable',
    contexts: ['luxury branding', 'hotel/hospitality', 'wedding design', 'jewelry', 'game environments (period)', 'film titles'],
    relatedSystems: ['dark_academia'],
    tensionsWith: ['wabi_sabi', 'neo_brutalism', 'retro_pixel'],
    absenceSignal: 'Casualness, imperfection, or the suggestion of cost-cutting. Art Deco is never apologetic about excess.',
    culturalWeight: 'The aesthetic of triumphant modernity between the wars — when industrial wealth expressed itself as ornament. Now carries nostalgia for a confidence the 21st century does not share.',
  },

  {
    id: 'wabi_sabi',
    label: 'Wabi-Sabi',
    aliases: ['wabi sabi', 'wabi-sabi', 'wabisabi', 'wabi', 'sabi', 'japanese minimalism', 'zen aesthetic', 'imperfect beauty', 'impermanence aesthetic', 'earthy japanese'],
    era: 'Medieval Japan — contemporary global adoption',
    origin: 'Japan — Zen Buddhist aesthetics',
    palette: {
      dominant:  ['linen (#F5F0E8)', 'clay white (#EDE0D4)', 'warm ash (#C5BEB5)', 'dried grass (#C8B89A)'],
      accents:   ['rust (#8B3A2A)', 'iron grey (#6B6B6B)', 'moss (#6B7A5A)'],
      neutrals:  ['paper white (#F8F4EE)', 'charcoal (#3C3732)', 'sand (#D4C9B8)'],
      forbidden: ['synthetic neon', 'machine-perfect symmetry', 'high saturation', 'the appearance of newness'],
    },
    visualGrammar: 'Beauty lives in imperfection, incompleteness, and impermanence. A visible crack, an uneven texture, an asymmetric composition — these are features, not failures.',
    textureProfile: 'Hand-made, natural, aged. Raw linen, unpolished stone, cracked clay, weathered wood. The material shows time passing through it.',
    shapeLanguage: 'Organic, asymmetric, irregular. No two things exactly alike. The composition accepts negative space as equal to positive form.',
    temperature: 'earth',
    saturation: 'low',
    contexts: ['ceramics/craft', 'interior design', 'luxury lifestyle', 'wellness branding', 'editorial', 'packaging (premium)'],
    relatedSystems: ['morandi', 'east_asian_traditional'],
    tensionsWith: ['memphis', 'cyberpunk', 'y2k', 'art_deco'],
    absenceSignal: 'Perfection, resolution, or the finished state. Wabi-sabi is always in the middle of becoming.',
    culturalWeight: 'A philosophy of acceptance embedded in aesthetics. Choosing wabi-sabi is not just a visual decision — it is a statement about what deserves to exist.',
  },

  {
    id: 'east_asian_traditional',
    label: 'East Asian Traditional',
    aliases: [
      'chinese traditional', 'chinese color', 'chinese palette', 'traditional chinese',
      'japanese traditional', 'japanese color', 'wa color', 'wasabi green',
      'ink wash', 'sumi-e', 'chinese ink', 'orient', 'oriental palette',
      'cherry blossom palette', 'jade', 'cinnabar', 'stone blue', 'tianqing', 'traditional asian',
    ],
    era: 'Ancient — present',
    origin: 'China and Japan',
    palette: {
      dominant:  ['tianqing blue (#4A7FA5)', 'stone green (#5A8A6A)', 'rice paper (#F5EFE0)'],
      accents:   ['cinnabar red (#CC3311)', 'lacquer red (#A5231A)', 'gold (#D4A54A)', 'ink black (#1A1A18)'],
      neutrals:  ['mist white (#F0ECE4)', 'ink wash grey (#8A8A85)', 'pale celadon (#B5C8B8)'],
      forbidden: ['synthetic neon', 'purely Western color relationships', 'visual noise without meaning'],
    },
    visualGrammar: 'Color as carrier of cultural meaning, not merely visual information. Each color has symbolic weight: red for luck/vitality, blue-green for nature/longevity, black for ink/authority, gold for imperial/sacred.',
    textureProfile: 'Translucent, layered — like watercolor on rice paper or silk. Colors bleed into each other rather than asserting hard edges. The ground shows through.',
    shapeLanguage: 'Calligraphic line, flowing asymmetry, pictorial space organized by proximity not perspective. Mountains, water, empty sky as equal compositional elements.',
    temperature: 'cool',
    saturation: 'medium',
    contexts: ['cultural branding', 'luxury (Asian market)', 'game environments (historical East Asia)', 'festival design', 'tea/wellness brands'],
    relatedSystems: ['wabi_sabi', 'morandi'],
    tensionsWith: ['art_deco', 'neo_brutalism', 'acid_graphics'],
    absenceSignal: 'Pure Western compositional logic. The negative space carries as much meaning as the mark.',
    culturalWeight: 'Thousands of years of encoded meaning. Using this system without knowledge of its symbolic vocabulary produces beautiful decoration — with knowledge, it produces communication.',
  },

  // ── Digital-Commercial / Contemporary Trends ───────────────────────────────

  {
    id: 'holographic',
    label: 'Holographic / Aurora Gradient',
    aliases: [
      'holographic', 'holographic gradient', 'aurora', 'aurora gradient', 'iridescent',
      'glassmorphism', 'glass morphism', 'frosted glass', 'web3', 'defi aesthetic',
      'saas aesthetic', 'gradient mesh', 'fluid gradient', 'chrome aesthetic',
    ],
    era: '2018–present',
    origin: 'Web3 / SaaS / contemporary digital design',
    palette: {
      dominant:  ['deep void (#0A0A18)', 'violet (#6633CC)', 'cobalt (#1A44CC)'],
      accents:   ['magenta (#CC22AA)', 'cyan (#22CCCC)', 'rose (#FF3388)', 'mint (#44FFAA)'],
      neutrals:  ['frosted white (rgba 255,255,255,0.15)', 'blur-dark (#12121A)'],
      forbidden: ['flat solid color without gradient', 'hard edges in the background layer', 'warmth'],
    },
    visualGrammar: 'Color as atmosphere. Gradients are not transitions between two colors — they are light moving through a space that has no solid surfaces. Blur and transparency are structural tools.',
    textureProfile: 'Weightless, liquid, slightly iridescent. The surface catches light differently at every angle. Glass, oil film, aurora borealis.',
    shapeLanguage: 'Soft, rounded, dissolving. Cards float on gradient fields. Blur radius as spatial depth. The foreground is always slightly transparent.',
    temperature: 'artificial',
    saturation: 'high',
    contexts: ['Web3 / crypto', 'fintech', 'SaaS dashboards', 'AI product UI', 'premium app landing pages', 'digital art'],
    relatedSystems: ['y2k'],
    tensionsWith: ['neo_brutalism', 'retro_pixel', 'bauhaus'],
    absenceSignal: 'Weight, physicality, or ground. Holographic UI is always slightly hovering.',
    culturalWeight: 'The aesthetic language of the speculative economy. Transparent surfaces suit products whose value is also partially transparent — crypto, data, cloud services.',
  },

  {
    id: 'acid_graphics',
    label: 'Acid Graphics',
    aliases: [
      'acid', 'acid graphics', 'acid design', 'acid aesthetic', 'acid house',
      'techno aesthetic', 'rave aesthetic', 'toxic green', 'fluorescent', 'neon green',
      'electronic music art', 'gabber', 'industrial design aesthetic', 'transgressive design',
    ],
    era: '1988–present (rave culture) / 2018–present (digital revival)',
    origin: 'UK/European rave culture',
    palette: {
      dominant:  ['void black (#000000)', 'toxic green (#00FF41)', 'electric violet (#8800FF)'],
      accents:   ['laser red (#FF0033)', 'chrome silver (#C0C0C0)', 'UV yellow (#FFFF00)'],
      neutrals:  ['terminal black (#0A0A0A)', 'metal grey (#808080)'],
      forbidden: ['warm colors', 'anything "friendly"', 'pastel', 'naturalistic hues', 'visual comfort'],
    },
    visualGrammar: 'Aggression as aesthetic. High luminosity on pure black. Colors are toxic, artificial, medical. The composition attacks.',
    textureProfile: 'Industrial, metallic, slick. Liquid metal, CRT phosphor, UV-reactive pigment. Hard surfaces that reflect without warmth.',
    shapeLanguage: 'Glitch geometry, distorted type, melting forms. The grid is present but damaged. Everything looks like it came from a machine that is malfunctioning intentionally.',
    temperature: 'artificial',
    saturation: 'maximum',
    contexts: ['electronic music', 'crypto art / NFT', 'avant-garde fashion', 'underground club culture', 'transgressive branding', 'game UI (dark sci-fi)'],
    relatedSystems: ['cyberpunk'],
    tensionsWith: ['morandi', 'wabi_sabi', 'holographic'],
    absenceSignal: 'Comfort, invitation, or friendliness. Acid graphics is designed to exclude the unprepared.',
    culturalWeight: 'A chemical allegory embedded in aesthetics: these are the colors of things that will hurt you if you touch them, and that is exactly why they are beautiful.',
  },

  {
    id: 'neo_brutalism',
    label: 'Neo-Brutalism',
    aliases: [
      'brutalism', 'neo brutalism', 'neo-brutalism', 'neobrutalism', 'brutal ui',
      'brutal web design', 'flat design brutal', 'black border', 'hard shadow',
    ],
    era: '2020–present (digital brutalism revival)',
    origin: 'Reaction against "over-polished" digital design',
    palette: {
      dominant:  ['mustard yellow (#F5C518)', 'mint green (#A8F0B8)', 'baby pink (#FFB3C6)', 'sky blue (#87CEEB)'],
      accents:   ['pure black (#000000)', 'pure white (#FFFFFF)', 'bright orange (#FF5F00)'],
      neutrals:  ['newspaper grey (#E8E8E8)', 'off-white (#F5F5F0)'],
      forbidden: ['gradients', 'border-radius > 0', 'drop shadows with blur', 'subtle anything'],
    },
    visualGrammar: 'Remove all pretense of sophistication. Hard black borders, flat colors, offset solid shadows. The construction is visible and proud. Nothing is disguised.',
    textureProfile: 'Flat, printed, slightly photocopied. Like a zine or an urgent note. Anti-polish is the polish.',
    shapeLanguage: 'Rectangular blocks, no curves, hard grid. Shadows are offset solids, not blurs. The component stack is visually obvious.',
    temperature: 'oscillating',
    saturation: 'high',
    contexts: ['startup web apps', 'design tool UI', 'indie SaaS', 'portfolio sites', 'zines / editorial', 'fintech for Gen Z'],
    relatedSystems: ['pop_art', 'bauhaus'],
    tensionsWith: ['holographic', 'morandi', 'art_deco'],
    absenceSignal: 'Subtlety. Neo-brutalism is not subtle. If you need to look twice to find the border, it is not brutal enough.',
    culturalWeight: 'The anti-aesthetic as aesthetic. A rejection of the homogenized, over-rounded, over-polished visual language that "good design" defaulted to in the 2010s. Rough edges as authenticity signal.',
  },

  {
    id: 'dopamine',
    label: 'Dopamine Colors',
    aliases: [
      'dopamine', 'dopamine colors', 'dopamine palette', 'dopamine dressing',
      'maximalist color', 'joy palette', 'happiness design', 'feel-good design',
      'color stacking', 'vibrant', 'bright and happy',
    ],
    era: '2021–present',
    origin: 'Post-pandemic cultural response / social media aesthetics',
    palette: {
      dominant:  ['tangerine (#FF8C00)', 'sunshine yellow (#FFD700)', 'hot pink (#FF1493)', 'electric blue (#0080FF)'],
      accents:   ['lime (#32CD32)', 'coral (#FF6B6B)', 'lavender (#9B59B6)', 'aqua (#00CED1)'],
      neutrals:  ['bright white (#FFFFFF)', 'warm ivory (#FFF8F0)'],
      forbidden: ['dark backgrounds', 'grey neutrals', 'muted tones', 'anything that reduces energy'],
    },
    visualGrammar: 'Simultaneous color saturation. The goal is immediate positive affect — not beauty in the classical sense, but the visual equivalent of eating something sweet.',
    textureProfile: 'Smooth, inflated, slightly candy-coated. 3D rounded forms, bubble plastic, fresh paint. Everything looks edible.',
    shapeLanguage: 'Rounded corners everywhere, inflated 3D shapes, bouncy typography. The composition has no sharp edges — everything is designed to be comforting.',
    temperature: 'hot',
    saturation: 'maximum',
    contexts: ['consumer apps', 'social media', 'food delivery', 'fitness / wellness apps', 'children\'s products', 'fast fashion'],
    relatedSystems: ['memphis', 'pop_art', 'y2k'],
    tensionsWith: ['morandi', 'wabi_sabi', 'dark_academia', 'neo_brutalism'],
    absenceSignal: 'Depth, complexity, or anything requiring sustained attention. Dopamine colors are designed for the scroll.',
    culturalWeight: 'The color of algorithmic happiness — an aesthetic calibrated to produce positive engagement metrics rather than lasting emotional resonance.',
  },

  // ── Subcultural / Retro-Revival ────────────────────────────────────────────

  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    aliases: [
      'cyberpunk', 'cyber punk', 'neon noir', 'synthwave dark', 'dystopian future',
      'blade runner', 'ghost in the shell', 'hi tech lo life', 'neon city',
      'rain-slicked streets', 'corporate dystopia',
    ],
    era: '1980s literary origin / 2016–present design revival',
    origin: 'Science fiction literature (Gibson, Dick) → game / film → design',
    palette: {
      dominant:  ['near-black (#080810)', 'deep navy (#0A0A2A)', 'dark grey (#1A1A1A)'],
      accents:   ['hot pink neon (#FF2D78)', 'cyan (#00FFEE)', 'electric purple (#9933FF)', 'acid yellow (#F5FF00)'],
      neutrals:  ['charcoal (#2A2A2A)', 'cable grey (#444454)'],
      forbidden: ['warm white', 'natural daylight colors', 'safety', 'pastoral greens', 'softness'],
    },
    visualGrammar: 'Extreme contrast. The dark field is the world; neon light is the exception that defines it. High luminosity against deep darkness. Color is a source of light, not a surface property.',
    textureProfile: 'Wet concrete, rain-slicked metal, neon reflected in puddles. Industrial, cold, occasionally beautiful in its ugliness.',
    shapeLanguage: 'Hard edges, diagonal cuts, overlapping layers of information. Typography stacked like infrastructure. Scan lines, glitch, signal noise.',
    temperature: 'artificial',
    saturation: 'variable',
    contexts: ['game UI / HUD design', 'sci-fi environments', 'music visuals', 'fashion editorial', 'crypto / blockchain branding', 'dark mode interfaces'],
    relatedSystems: ['acid_graphics', 'vaporwave'],
    tensionsWith: ['wabi_sabi', 'morandi', 'art_deco', 'east_asian_traditional'],
    absenceSignal: 'Natural light, warmth, or organic matter. Cyberpunk is a world where nature has already been replaced.',
    culturalWeight: 'High-tech, low-life. The prophecy that technology would not liberate us but stratify us. Using this aesthetic carries that critique, consciously or not.',
  },

  {
    id: 'vaporwave',
    label: 'Vaporwave',
    aliases: [
      'vaporwave', 'vapor wave', 'aesthetics tumblr', 'retrowave', 'outrun',
      'lo-fi aesthetic', 'late capitalism aesthetic', 'mall aesthetic', 'pastel retrowave',
      'windows 95 aesthetic', 'greek statue aesthetic', 'early internet nostalgia',
    ],
    era: '2010–present (born online)',
    origin: 'Internet subculture / music genre',
    palette: {
      dominant:  ['lavender (#CC88FF)', 'hot pink (#FF44AA)', 'aqua (#44FFEE)', 'sunset peach (#FFAA88)'],
      accents:   ['mint (#88FFCC)', 'deep violet (#4400AA)', 'gold (#FFCC44)'],
      neutrals:  ['soft black (#1A0A22)', 'rose grey (#E8D0D8)'],
      forbidden: ['desaturated realism', 'current-era design language', 'the present tense'],
    },
    visualGrammar: 'Nostalgia as drug. Early internet aesthetic filtered through pastel light. Everything looks like it was scanned from a magazine that no longer exists.',
    textureProfile: 'Scan noise, CRT glow, slightly faded — like a VHS recording of a TV show. The resolution is deliberately insufficient.',
    shapeLanguage: 'Classical marble statues, palm trees, grid floors extending to horizon, Sun rendered as wireframe. The formal language of a lost utopia.',
    temperature: 'artificial',
    saturation: 'high',
    contexts: ['music visuals / album art', 'lo-fi YouTube content', 'aesthetic social media', 'retrowave game environments', 'fashion editorial'],
    relatedSystems: ['y2k', 'cyberpunk'],
    tensionsWith: ['neo_brutalism', 'bauhaus', 'wabi_sabi'],
    absenceSignal: 'The present. Vaporwave has no present tense — only a past that was imagined, and a future that will not arrive.',
    culturalWeight: 'The first art movement born entirely within internet subculture. A mourning for a consumerist utopia that was always a lie. The aesthetic of late capitalism consuming its own nostalgia.',
  },

  {
    id: 'y2k',
    label: 'Y2K',
    aliases: [
      'y2k', 'y2k aesthetic', 'year 2000', 'millennium aesthetic', 'early 2000s',
      'plastic chrome', 'candy chrome', 'cyber y2k', 'millennium bug aesthetic',
      'paris hilton aesthetic', 'flip phone era',
    ],
    era: '1998–2004 / Revival 2020–present',
    origin: 'Turn of the millennium Western pop culture',
    palette: {
      dominant:  ['chrome silver (#C8C8C8)', 'candy pink (#FF99CC)', 'sky blue (#99CCFF)', 'white (#FFFFFF)'],
      accents:   ['electric blue (#0066FF)', 'hot magenta (#FF00AA)', 'metallic gold (#CCAA44)'],
      neutrals:  ['pearl white (#F0F0F0)', 'plastic grey (#DDDDDD)'],
      forbidden: ['anything matte', 'anything that suggests age or history', 'earth tones'],
    },
    visualGrammar: 'Shiny optimism. Everything plastic, reflective, slightly translucent. The future was going to be made of polycarbonate and it was going to be great.',
    textureProfile: 'Glossy, hard plastic, chrome-plated. The tactile pleasure of a Nokia phone. Surfaces that have no memory of being made.',
    shapeLanguage: 'Teardrop forms, bubble letters, chrome bevels, transparent overlays. The visual language of the first generation of 3D rendering software.',
    temperature: 'artificial',
    saturation: 'high',
    contexts: ['fashion / streetwear', 'social media aesthetics', 'music video', 'pop branding', 'phone case design', 'nostalgia-driven UI'],
    relatedSystems: ['vaporwave', 'holographic', 'dopamine'],
    tensionsWith: ['wabi_sabi', 'dark_academia', 'bauhaus'],
    absenceSignal: 'History, weight, or the possibility of failure. Y2K is the aesthetic of naive technological optimism.',
    culturalWeight: 'The visual language of millennial childhood. Its revival is nostalgia not for the era itself but for a time when the internet still felt like possibility rather than infrastructure.',
  },

  {
    id: 'dark_academia',
    label: 'Dark Academia / Dark Gothic',
    aliases: [
      'dark academia', 'dark academic', 'gothic', 'dark gothic', 'gothic aesthetic',
      'academia aesthetic', 'victorian gothic', 'medieval aesthetic', 'old library',
      'candlelit', 'manuscript aesthetic', 'occult aesthetic', 'romantic gothic',
      'school of magic aesthetic',
    ],
    era: 'Historical roots / Revival 2016–present',
    origin: 'Western Gothic literature / Tumblr aesthetic movement',
    palette: {
      dominant:  ['dark walnut (#2C1810)', 'aged parchment (#C8B56A)', 'deep forest (#1A3A1A)', 'charcoal (#2A2A2A)'],
      accents:   ['blood red (#8B0000)', 'oxidized copper green (#4A6B4A)', 'gold (#B8860B)', 'ivory (#FFFFF0)'],
      neutrals:  ['sepia (#C09A6B)', 'ash (#888880)', 'vellum (#F5E6C8)'],
      forbidden: ['bright saturated color', 'neon', 'synthetic materials', 'digital-native surfaces'],
    },
    visualGrammar: 'Age, weight, knowledge, and secrets. Colors that have been sitting in a room for centuries. Candlelight and shadows. The palette of books that have been touched by too many hands.',
    textureProfile: 'Paper, leather, stone, wood. Surfaces that accumulate time. The patina of use and age is the point.',
    shapeLanguage: 'Pointed arches, heavy cornices, intricate ornamental detail. Gothic verticality and weight. The architecture of transcendence-through-structure.',
    temperature: 'warm',
    saturation: 'low',
    contexts: ['game environments (Gothic/medieval)', 'fantasy branding', 'editorial (literary/academic)', 'fashion (academic aesthetic)', 'album/book covers', 'app UI (reading apps, occult-adjacent)'],
    relatedSystems: ['morandi', 'art_deco'],
    tensionsWith: ['memphis', 'holographic', 'dopamine', 'y2k'],
    absenceSignal: 'Light, levity, or the present day. Dark academia exists outside of modern time.',
    culturalWeight: 'The aesthetics of inherited knowledge and its shadows — the library as temple, learning as ritual, the past as a more serious place than the present.',
  },

  {
    id: 'retro_pixel',
    label: 'Retro Pixel / 8-Bit',
    aliases: [
      'pixel art', 'pixel aesthetic', '8 bit', '8-bit', 'retro game', 'chiptune aesthetic',
      'gameboy', 'game boy', 'nes aesthetic', 'famicom', 'snes', '16 bit', '16-bit',
      'limited palette', 'sprite art', 'pixel palette', 'retro pixel',
    ],
    era: '1977–1994 hardware origin / perpetual revival',
    origin: 'Hardware limitations of early video game consoles',
    palette: {
      dominant:  ['NES tan (#E8C888)', 'CGA cyan (#55FFFF)', 'Game Boy green (#8BAC0F)', 'SNES blue (#2C5AA0)'],
      accents:   ['sprite red (#FF2222)', 'pixel yellow (#FFFF00)', 'bit orange (#FF8822)'],
      neutrals:  ['dark border (#0F380F)', 'light field (#9BBC0F)', 'grey scale (#AAAAAA)'],
      forbidden: ['smooth gradients', 'sub-pixel antialiasing', 'more than 16 simultaneous colors (hardware-accurate)', 'photographic realism'],
    },
    visualGrammar: 'Limitation as grammar. The pixel is the atom. Every visual decision is a tradeoff made visible. Maximum expressiveness inside absolute constraint.',
    textureProfile: 'Hard, precise, blocky. Each pixel is a decision. The grid is always present, even when you stop seeing it.',
    shapeLanguage: 'Isometric grids, orthographic projection, tiles and sprites. The world is made of identical-size blocks organized into meaning.',
    temperature: 'oscillating',
    saturation: 'limited',
    contexts: ['indie games', 'pixel-art social sandboxes', 'retro-style apps', 'nostalgia branding', 'virtual world construction', 'demoscene art'],
    relatedSystems: ['y2k'],
    tensionsWith: ['holographic', 'morandi', 'art_deco'],
    absenceSignal: 'The smoothness that hides construction. Pixel art is always showing you how it was made.',
    culturalWeight: 'Constraint as creative engine. The Haiku of visual arts. An entire generation of aesthetic memory encoded in 4-color palettes and 16×16 sprite sheets.',
  },
];

// ─── Industrial Standards ─────────────────────────────────────────────────────
// These are reference systems, not aesthetic systems.
// When detected, they should be noted differently.

export const DESIGN_STANDARDS: Record<string, string> = {
  pantone:        'Pantone: The global physical color communication standard. Spot colors for print/physical production. Each number is a contractual commitment to a specific ink mixture. Used to ensure brand color survives the journey from screen to substrate.',
  munsell:        'Munsell Color System: The scientific model for describing color through Hue, Value, and Chroma independently. The most perceptually uniform color notation — used in color science, calibration, and precise specification. Not an aesthetic, a measurement.',
  ncs:            'NCS — Natural Color System: Describes color through six psychological primaries (R, Y, G, B, W, K) and how much of each a color appears to contain. Used in architecture and space design for its alignment with how humans actually perceive surfaces under different lighting conditions.',
  material_design: 'Material Design: Google\'s UI design system. Bauhaus principles translated into screen physics — the metaphor of paper, ink, and elevation. Provides a complete semantic color system: Primary, Secondary, Surface, Error, On-* variants, and a tonal palette generation algorithm.',
  apple_hig:      'Apple HIG: Human Interface Guidelines. Semantic color naming, adaptive color (light/dark mode), vibrancy, and elevated surface materials. Designed around perceptual consistency across hardware, not aesthetic expression.',
};

// ─── Lookup ───────────────────────────────────────────────────────────────────

function normalise(text: string): string {
  return text.toLowerCase().replace(/[-_]/g, ' ');
}

function detectApplicationContext(text: string): DesignVocabularyMatch['context'] {
  const t = text.toLowerCase();
  if (/\b(ui|interface|ux|dashboard|app|application|screen|web|mobile|button|component|layout)\b/.test(t)) return 'ui';
  if (/\b(game|gameplay|sprite|tile|level|dungeon|world|environment|pixel|asset)\b/.test(t)) return 'game';
  if (/\b(poster|print|brochure|editorial|magazine|book cover|packaging|flyer)\b/.test(t)) return 'print';
  if (/\b(illustration|digital art|artwork|render|concept art|nft|minting)\b/.test(t)) return 'digital-art';
  if (/\b(brand|branding|logo|identity|corporate|startup|product)\b/.test(t)) return 'branding';
  if (/\b(space|room|interior|architecture|furniture|exhibition)\b/.test(t)) return 'space';
  return null;
}

function detectStandards(text: string): string[] {
  const t = normalise(text);
  return Object.keys(DESIGN_STANDARDS).filter(id => t.includes(id.replace('_', ' ')));
}

/** The full cross-system relationship map. */
const CROSS_SYSTEM_NOTES: CrossSystemNote[] = [
  {
    systemIds: ['memphis', 'bauhaus'],
    systemLabels: ['Memphis', 'Bauhaus'],
    relationship: 'rebellion',
    note: 'The most charged pairing in design history. Memphis was literally founded as an attack on Bauhaus — Sottsass used exactly the colors and decorative excess that Bauhaus declared sinful. Memphis did not abandon Bauhaus principles; it inverted them intentionally. The tension between these two systems is not a design problem to solve — it is the design.',
  },
  {
    systemIds: ['bauhaus', 'material_design'],
    systemLabels: ['Bauhaus', 'Material Design'],
    relationship: 'lineage',
    note: 'Direct descent. Material Design is what happens when Bauhaus meets screen physics — the paper/ink/elevation metaphor is "form follows function" translated to 2.5D space. The tonal color palette, the semantic naming, the grid — all Bauhaus. Using Material Design is using a Bauhaus-derived grammar without necessarily knowing its origin.',
  },
  {
    systemIds: ['wabi_sabi', 'morandi'],
    systemLabels: ['Wabi-Sabi', 'Morandi'],
    relationship: 'parallel',
    note: 'Nearly identical philosophical alignment across cultures. Both insist that beauty lives in imperfection and restraint. The palette overlap is significant: muted, low-saturation, dusty, grounded. The difference is origin — Morandi comes from solitary Western still-life painting; Wabi-sabi comes from Zen Buddhism and the tea ceremony. Same visual answer to the same question asked independently.',
  },
  {
    systemIds: ['cyberpunk', 'vaporwave'],
    systemLabels: ['Cyberpunk', 'Vaporwave'],
    relationship: 'parallel',
    note: 'Two futures imagined from the same era looking in opposite directions. Cyberpunk is the dark future — technology as control, surveillance, corporate domination. Vaporwave is the utopian past that never happened — the smooth, clean, optimistic world that technology promised and failed to deliver. Both are elegies. One mourns what is coming; the other mourns what should have been.',
  },
  {
    systemIds: ['art_deco', 'dark_academia'],
    systemLabels: ['Art Deco', 'Dark Academia'],
    relationship: 'synthesis',
    note: 'Gold on dark backgrounds — the same visual DNA, opposite spiritual charge. Art Deco is triumphant modernity declaring its own glamour. Dark Academia is inherited knowledge and its weight, the library as sacred space. Combining them produces something like a cursed treasure chamber: power and beauty and the feeling that it costs something to possess.',
  },
  {
    systemIds: ['holographic', 'y2k'],
    systemLabels: ['Holographic', 'Y2K'],
    relationship: 'lineage',
    note: 'Y2K is the ancestor of the holographic aesthetic. Both celebrate synthetic sheen — the beauty of plastic, chrome, and iridescence. Y2K is naive and optimistic; holographic is sophisticated and slightly melancholy, knowing that the utopia Y2K expected did not arrive. Holographic is Y2K after it learned to be ironic.',
  },
  {
    systemIds: ['holographic', 'acid_graphics'],
    systemLabels: ['Holographic', 'Acid Graphics'],
    relationship: 'opposition',
    note: 'Same material — iridescent, optical, synthetic — completely opposite intent. Holographic aims for weightless luxury: beautiful, approachable, premium. Acid graphics aims for aggressive transgression: threatening, exclusive, hostile to the uninitiated. They share a chemical vocabulary and use it to say opposite things.',
  },
  {
    systemIds: ['pop_art', 'memphis'],
    systemLabels: ['Pop Art', 'Memphis'],
    relationship: 'lineage',
    note: 'Memphis is Pop Art applied to design objects. Both refuse "good taste," both celebrate flat color and visual excess. Pop Art is ironic — it quotes consumer culture to expose it. Memphis is sincere — it genuinely enjoys the pleasure of color. The shift from irony to sincerity is the generational distance between 1965 and 1985.',
  },
  {
    systemIds: ['retro_pixel', 'wabi_sabi'],
    systemLabels: ['Retro Pixel', 'Wabi-Sabi'],
    relationship: 'parallel',
    note: 'An unexpected philosophical convergence. Both find beauty in limitation, both make the constraint visible, both refuse to hide their construction. The pixel grid is the crack in the tea bowl. The visible bitmap is the grain of the unpolished wood. One is Eastern philosophy; one is Western hardware accident. Both say: the mark of making is the beauty.',
  },
  {
    systemIds: ['wabi_sabi', 'east_asian_traditional'],
    systemLabels: ['Wabi-Sabi', 'East Asian Traditional'],
    relationship: 'lineage',
    note: 'Wabi-sabi IS a Japanese crystallization of the broader East Asian aesthetic philosophy — the same foundation that underlies Chinese ink painting, the tea ceremony, and the haiku. East Asian traditional color carries the classical formal vocabulary; wabi-sabi distills it to its philosophical core. They are the same inheritance at different scales.',
  },
  {
    systemIds: ['neo_brutalism', 'bauhaus'],
    systemLabels: ['Neo-Brutalism', 'Bauhaus'],
    relationship: 'rebellion',
    note: 'Neo-brutalism and Bauhaus share the same rejection of unnecessary decoration — but their conclusions are opposite. Bauhaus refined this into geometric perfection; neo-brutalism makes the rawness itself the point. Bauhaus: "remove decoration until only function remains." Neo-brutalism: "remove polish until construction is visible." Both anti-ornamental, one cool and one aggressive.',
  },
  {
    systemIds: ['cyberpunk', 'acid_graphics'],
    systemLabels: ['Cyberpunk', 'Acid Graphics'],
    relationship: 'parallel',
    note: 'Both use neon on black. Both belong to cultures that were in some sense underground or oppositional. Cyberpunk is narrative — it tells a story about corporate control. Acid graphics is sensory — it induces a state. Cyberpunk wants you to feel dread; acid wants you to feel overwhelm. The overlap is in the visual vocabulary of things that assault your perception deliberately.',
  },
];

/**
 * Detect design vocabulary in arbitrary text and return matched systems,
 * cross-system notes, referenced standards, and application context.
 */
export function detectDesignVocabulary(text: string): DesignVocabularyMatch {
  const normalised = normalise(text);
  const matched: DesignColorSystem[] = [];

  for (const system of SYSTEMS) {
    const hit = system.aliases.some(alias => normalised.includes(normalise(alias)));
    if (hit) matched.push(system);
  }

  // Find cross-system notes for all pairs of matched systems
  const matchedIds = new Set(matched.map(s => s.id));
  const crossNotes = CROSS_SYSTEM_NOTES.filter(note =>
    note.systemIds.every(id => matchedIds.has(id))
  );

  return {
    systems: matched,
    crossNotes,
    standardsReferenced: detectStandards(text),
    context: detectApplicationContext(text),
  };
}

/** Convenience: just the first matched system, or null. */
export function primaryDesignSystem(text: string): DesignColorSystem | null {
  return detectDesignVocabulary(text).systems[0] ?? null;
}

// ─── Design Token extraction ──────────────────────────────────────────────────

/**
 * Extract hex value from a palette string like "primary yellow (#F7E03C)".
 * Returns null if no hex found.
 */
function extractHex(colorString: string): string | null {
  const match = colorString.match(/#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Extract the label portion from a palette string like "primary yellow (#F7E03C)".
 * Returns the string with the hex portion stripped.
 */
function extractLabel(colorString: string): string {
  return colorString.replace(/\s*\(#[0-9A-Fa-f]{3,6}\)/, '').replace(/\s*#[0-9A-Fa-f]{3,6}/, '').trim();
}

/**
 * Convert a label to a CSS-safe token name fragment.
 * "primary yellow" → "primary-yellow"
 */
function toCssName(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

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
export function generateDesignTokens(systemIdOrName: string): DesignTokenSet | null {
  const normalised = systemIdOrName.toLowerCase().replace(/[-\s]/g, '_');
  const system = SYSTEMS.find(s =>
    s.id === normalised ||
    s.id === systemIdOrName.toLowerCase().replace(/\s/g, '_') ||
    s.label.toLowerCase() === systemIdOrName.toLowerCase() ||
    s.aliases.some(a => a.toLowerCase() === systemIdOrName.toLowerCase())
  );

  if (!system) return null;

  const tokens: DesignToken[] = [];

  // Process each palette role
  const roles: Array<['dominant' | 'accent' | 'neutral', string[]]> = [
    ['dominant', system.palette.dominant],
    ['accent',   system.palette.accents],
    ['neutral',  system.palette.neutrals],
  ];

  for (const [role, colors] of roles) {
    for (let i = 0; i < colors.length; i++) {
      const colorStr = colors[i]!;
      const hex = extractHex(colorStr);
      if (!hex) continue;

      const label   = extractLabel(colorStr);
      const cssName = toCssName(label) || `${role}-${i}`;

      tokens.push({
        cssVar: `--color-${role}-${cssName}`,
        hex,
        label,
        role,
      });
    }
  }

  // Build CSS block
  const cssLines = [
    `/* ${system.label} — generated by phosphene/design-color-lexicon */`,
    `/* ${system.era} · ${system.origin} */`,
    `/* Temperature: ${system.temperature} · Saturation: ${system.saturation} */`,
    ':root {',
    `  --design-system: "${system.id}";`,
    `  --design-temperature: "${system.temperature}";`,
    `  --design-saturation: "${system.saturation}";`,
    '',
    ...tokens.map(t => `  ${t.cssVar}: ${t.hex}; /* ${t.label} */`),
    '}',
  ];

  // JS tokens object
  const jsTokens: Record<string, string> = {};
  for (const t of tokens) {
    // cssVar "–-color-dominant-primary-yellow" → key "colorDominantPrimaryYellow"
    const key = t.cssVar.replace(/^--/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    jsTokens[key] = t.hex;
  }

  // Tailwind colors
  const tailwindColors: Record<string, string> = {};
  for (const t of tokens) {
    const key = t.cssVar.replace(/^--color-/, '').replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    tailwindColors[key] = t.hex;
  }

  return {
    system: system.id,
    label:  system.label,
    tokens,
    css:    cssLines.join('\n'),
    jsTokens,
    tailwindColors,
    temperature: system.temperature,
    saturation:  system.saturation,
  };
}

/**
 * Get all resolved colors for a system as a flat array.
 * Only includes colors with valid hex values.
 */
export function getSystemPalette(systemIdOrName: string): DesignToken[] {
  return generateDesignTokens(systemIdOrName)?.tokens ?? [];
}

/**
 * Suggest the best-matching design system for a given intent or keyword string.
 * Goes beyond alias matching — considers temperature, saturation, and context.
 *
 * @param intent - Description of the desired aesthetic (e.g. "muted luxury", "aggressive dark UI")
 */
export function suggestDesignSystem(intent: string): DesignColorSystem | null {
  const lower = intent.toLowerCase();

  // Try direct vocabulary match first
  const direct = primaryDesignSystem(intent);
  if (direct) return direct;

  // Intent-based scoring
  let bestScore = -1;
  let bestSystem: DesignColorSystem | null = null;

  const TEMPERATURE_HINTS: Record<string, TemperatureProfile[]> = {
    warm:       ['warm', 'earth'],
    cold:       ['cold', 'cool', 'artificial'],
    cool:       ['cool', 'metallic'],
    hot:        ['hot', 'artificial'],
    neon:       ['artificial'],
    organic:    ['earth', 'warm'],
    synthetic:  ['artificial', 'metallic'],
    metallic:   ['metallic'],
  };

  const SATURATION_HINTS: Record<string, SaturationProfile[]> = {
    muted:       ['low', 'limited'],
    subtle:      ['low'],
    vibrant:     ['high', 'maximum'],
    loud:        ['maximum'],
    quiet:       ['low', 'limited'],
    minimal:     ['low', 'limited'],
    maximalist:  ['maximum', 'high'],
    simple:      ['limited'],
  };

  const CONTEXT_HINTS: Record<string, string[]> = {
    luxury:   ['morandi', 'art_deco', 'dark_academia', 'wabi_sabi'],
    tech:     ['cyberpunk', 'holographic', 'acid_graphics', 'neo_brutalism'],
    playful:  ['memphis', 'dopamine', 'pop_art', 'y2k'],
    dark:     ['cyberpunk', 'dark_academia', 'acid_graphics'],
    minimal:  ['bauhaus', 'morandi', 'wabi_sabi', 'flow'],
    retro:    ['vaporwave', 'y2k', 'retro_pixel', 'pop_art'],
    nature:   ['wabi_sabi', 'east_asian_traditional', 'morandi'],
    game:     ['cyberpunk', 'retro_pixel', 'acid_graphics', 'dark_academia'],
    ui:       ['neo_brutalism', 'holographic', 'bauhaus', 'material_design'],
    fashion:  ['morandi', 'dopamine', 'dark_academia', 'y2k'],
    art:      ['pop_art', 'memphis', 'bauhaus', 'east_asian_traditional'],
    brutal:   ['neo_brutalism', 'acid_graphics'],
    soft:     ['morandi', 'wabi_sabi', 'dopamine'],
    elegant:  ['morandi', 'art_deco', 'dark_academia'],
    japanese: ['wabi_sabi', 'east_asian_traditional'],
    chinese:  ['east_asian_traditional'],
  };

  for (const system of SYSTEMS) {
    let score = 0;

    // Temperature match
    for (const [hint, temps] of Object.entries(TEMPERATURE_HINTS)) {
      if (lower.includes(hint) && temps.includes(system.temperature)) score += 2;
    }

    // Saturation match
    for (const [hint, sats] of Object.entries(SATURATION_HINTS)) {
      if (lower.includes(hint) && sats.includes(system.saturation)) score += 2;
    }

    // Context hints
    for (const [hint, ids] of Object.entries(CONTEXT_HINTS)) {
      if (lower.includes(hint) && ids.includes(system.id)) score += 3;
    }

    // Context field match
    for (const ctx of system.contexts) {
      if (lower.includes(ctx.toLowerCase())) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestSystem = system;
    }
  }

  return bestSystem;
}
