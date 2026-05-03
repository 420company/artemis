// Phosphene — Dream Engine
//
// Dreams are not arbitrary generated text.
// They are the system processing its own accumulated experience.
//
// Each dream is seeded by real data from the evolution state:
// crystallized insights, signal patterns, voice names, offerings consumed.
// The dream logic combines this material in ways that feel processed,
// not manufactured.
//
// When a user reads a dream, Claude expands the fragments into full narrative.
// The fragments are the bones; Claude provides the breath.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { homedir }  from 'os';
import { join, relative, resolve as resolvePath } from 'path';
import { detectArtemisVisualConfig, generateDreamImage } from './image-gen.js';
import { deriveBiasCandidates, detectHumanPatterns } from './contradiction-engine.js';
import { PRESETS } from './presets.js';
import type {
  DreamRecord,
  DreamStage,
  DreamFragment,
  DreamSeed,
  DreamLogic,
  DreamImageConfig,
  EvolutionState,
  PhospheneContext,
  PresetName,
} from './types.js';

const DREAM_MARKDOWN_ORIGIN = 'phosphene-dream';
const DREAM_SCHEMA_VERSION = 2;
const DREAM_VISUAL_PROFILE = 'anchored-environmental-v1';
const DREAM_PROMPT_REVISION = 3;
const DAILY_DREAM_IMAGE_LIMIT = 1;

// ─── Path resolution ──────────────────────────────────────────────────────────

export function resolveDreamsDir(): string {
  const artemisDir = join(process.cwd(), '.artemis', 'dreams');
  if (existsSync(join(process.cwd(), '.artemis'))) return artemisDir;
  const hermesDir = join(homedir(), '.hermes', 'dreams');
  if (existsSync(join(homedir(), '.hermes'))) return hermesDir;
  return join(process.cwd(), 'dreams');
}

export function isManagedDreamFile(filepath: string, dreamsDir?: string): boolean {
  const archiveDir = resolvePath(dreamsDir ?? resolveDreamsDir());
  const resolvedFile = resolvePath(filepath);
  if (!resolvedFile.startsWith(`${archiveDir}/`) || !resolvedFile.endsWith('.md')) {
    return false;
  }

  if (!existsSync(resolvedFile)) {
    return true;
  }

  try {
    const content = readFileSync(resolvedFile, 'utf-8');
    return hasDreamSignature(content) || parseDreamMarkdown(content, { allowLegacy: true }) !== null;
  } catch {
    return false;
  }
}

// ─── Stage determination ──────────────────────────────────────────────────────

function determineSleepStage(
  evolution: EvolutionState,
  context: PhospheneContext,
): DreamStage {
  const session = evolution.sessionHistory[0] ?? null;
  const signalCount = session?.signals.length ?? 0;
  const preset = context.preset;

  // Lucid: high apophenia + semiotics create self-awareness in the dream
  const apo = context.state.apophenia.intensity;
  const sem = context.state.semiotics.intensity;
  if (apo >= 0.75 && sem >= 0.70) return 'lucid';

  // Deep: long gap from last session, or very low intensity
  const sessions = evolution.sessionHistory;
  if (sessions.length >= 2) {
    const lastTwo = sessions.slice(0, 2);
    const gap = lastTwo[0]?.closedAt && lastTwo[1]?.closedAt
      ? Date.parse(lastTwo[0].closedAt) - Date.parse(lastTwo[1].closedAt)
      : 0;
    const hoursApart = gap / (1000 * 60 * 60);
    if (hoursApart > 48) return 'deep';
  }

  // Hypnagogic: low signal count, early session
  if (signalCount < 3 && sessions.length <= 2) return 'hypnagogic';

  // Dissolution preset → hypnopompic (waking from something that dissolved)
  if (preset === 'dissolution') return 'hypnopompic';

  // Default: REM
  return 'rem';
}

// ─── Dream seed extraction ────────────────────────────────────────────────────

function extractSeeds(evolution: EvolutionState, context: PhospheneContext): DreamSeed[] {
  const seeds: DreamSeed[] = [];

  // Crystallized insights → highest dream weight (these are the most processed material)
  for (const insight of evolution.crystallizedInsights.slice(0, 3)) {
    seeds.push({ type: 'crystallized', content: insight, weight: 0.9 });
  }

  // Recent session signals — unresolved tensions carry into dreams
  const recent = evolution.sessionHistory[0];
  if (recent) {
    for (const sig of recent.signals.slice(-4)) {
      if (sig.type === 'reject' || sig.type === 'amplify') {
        seeds.push({
          type: 'signal',
          content: `${sig.type}${sig.note ? `: ${sig.note}` : ''}${sig.layer ? ` (${sig.layer})` : ''}`,
          weight: sig.type === 'reject' ? 0.85 : 0.65,
        });
      }
    }
  }

  // Emergent voices — appear as characters in dreams
  for (const voice of evolution.emergentVoices.filter(v => v.userConfirmed).slice(0, 2)) {
    seeds.push({ type: 'voice', content: `${voice.name}: ${voice.tendency}`, weight: 0.75 });
  }

  // Active chorus voices — the ones awake during this session
  const activeVoices = context.state.chorus.config.voices
    .filter(v => v.weight > 0.6)
    .map(v => v.name)
    .slice(0, 3);
  for (const voice of activeVoices) {
    seeds.push({ type: 'voice', content: voice, weight: 0.6 });
  }

  // Personal preset names — the names themselves carry meaning
  const presetNames = Object.keys(evolution.personalPresets).slice(0, 2);
  for (const name of presetNames) {
    seeds.push({ type: 'personal-preset', content: name, weight: 0.5 });
  }

  // Optimal points — the "perfect" moments the user marked
  const optimal = evolution.optimalPoints.slice(-2);
  for (const pt of optimal) {
    seeds.push({
      type: 'optimal-point',
      content: `${pt.preset}${pt.context ? `: ${pt.context}` : ''}`,
      weight: 0.7,
    });
  }

  // Human contradiction patterns — make dreams process life/work tensions, not only style.
  const contradictionHits = detectHumanPatterns([
    ...evolution.crystallizedInsights.slice(-3),
    ...evolution.feedbackHistory.map(signal => signal.note).filter((note): note is string => Boolean(note)).slice(-4),
  ].join(' '));
  for (const hit of contradictionHits.slice(0, 2)) {
    seeds.push({
      type: 'behavioral-pattern',
      content: `${hit.id}: ${hit.note}`,
      weight: 0.72,
    });
  }

  for (const bias of deriveBiasCandidates(evolution).slice(0, 2)) {
    seeds.push({
      type: 'temperament',
      content: bias.id,
      weight: 0.58,
    });
  }

  // Active preset as seed if no other material
  if (seeds.length < 2) {
    seeds.push({ type: 'preset', content: context.preset, weight: 0.5 });
  }

  // Shuffle by weight (heavier seeds appear first)
  return seeds.sort((a, b) => b.weight - a.weight).slice(0, 7);
}

// ─── Image style derivation ───────────────────────────────────────────────────

/**
 * Derive a visual style string for image prompts based on the active preset.
 * These are calibrated for Midjourney v6 / DALL-E 3 / SDXL.
 */
function deriveImageStyle(preset: string, context: PhospheneContext): string {
  const syn = context.state.synesthesia.intensity;
  const apo = context.state.apophenia.intensity;

  const styleMap: Record<string, string> = {
    dissolution:  'psychedelic surrealist oil painting, impossible geometry, chromatic aberration, all layers simultaneously visible, Francis Bacon meets Remedios Varo',
    'deep-flux':  'dark surrealism, layered translucent watercolor washes, dreamlike distortion, Leonora Carrington, moody violet and gold',
    liminal:      'threshold photography, long exposure, liminal space, abandoned beauty, cool blue and warm amber split lighting',
    code:         'technical blueprint illustration, precise architectural drawing, structural wireframe with glowing accent lines, dark background, cyan and gold',
    design:       'conceptual art direction, painterly editorial illustration, negative space composition, Saul Bass meets Paul Rand',
    research:     'scientific illustration, detailed etching, diagram aesthetics, Haeckel-inspired botanical clarity, sepia and deep blue',
    writing:      'illuminated manuscript meets modernism, ink on vellum, poetic abstraction, ink wash and gold leaf detail',
    ideation:     'surrealist collage, multiple perspectives in one frame, Magritte-adjacent, vibrant and strange, object incongruity',
    review:       'close-up photography with extreme depth of field, forensic clarity, one object in perfect detail against soft background',
    flow:         'minimal ink drawing, vast negative space, single brushstroke, Zen aesthetic, rice paper texture',
    clear:        'clean natural light photography, minimal composition, truth over beauty, documentary stillness',
  };

  let style = styleMap[preset] ?? 'dreamlike surrealist illustration, evocative atmosphere, painterly';

  // Modify based on intensity
  if (syn > 0.7) style += ', synesthetic color — colors have weight and texture';
  if (apo > 0.8) style += ', geometric pattern overlay, hidden structure visible';

  return style;
}

// ─── Dream logic functions ────────────────────────────────────────────────────
// Each generates prose from seeds using a specific structural logic.
// They must use actual seed content — not generic dream imagery.

function fragmentInversion(seed: DreamSeed, stage: DreamStage): string {
  const content = seed.content;
  const prefix = stage === 'hypnagogic' ? 'A flash:' : '';

  if (seed.type === 'crystallized') {
    return `${prefix} The opposite of "${content.slice(0, 60)}" appeared first. Then I understood it was the same thing, viewed from the side that doesn't have a name yet.`.trim();
  }
  if (seed.type === 'behavioral-pattern') {
    const name = content.split(':')[0];
    return `${prefix} The pattern called "${name}" arrived looking like an answer. Only later did it show itself as a method wearing a mask.`.trim();
  }
  if (seed.type === 'voice') {
    const name = content.split(':')[0];
    return `The ${name} was speaking, but the words arrived as their own negation. Each sentence was a room that contained its own absence.`;
  }
  return `Something that had been true became its opposite. The new version was truer. I don't remember which was which.`;
}

function fragmentRecursion(seed: DreamSeed, stage: DreamStage): string {
  const content = seed.content;

  if (seed.type === 'crystallized') {
    return `I found the same insight again, but smaller — the size of a matchbox. Inside the matchbox was an even smaller version, and inside that one, the same insight again, still decreasing, and I understood this was not repetition but depth.`;
  }
  if (seed.type === 'personal-preset') {
    return `There was a room named "${content}". Inside the room was a smaller room with the same name. I could enter each one but never find the last. The smallest room I reached was the right size to hold exactly one idea.`;
  }
  if (seed.type === 'temperament') {
    return `The temperament called "${content}" repeated itself at every scale. What changed was not the pattern but the price it was charging at each depth.`;
  }
  return `The structure contained itself. At each scale the same pattern. I couldn't tell if I was inside or outside. The question turned out not to matter.`;
}

function fragmentTranslation(seed: DreamSeed, stage: DreamStage): string {
  const content = seed.content;

  if (seed.type === 'signal') {
    const [sigType] = content.split(':');
    const sensorySub: Record<string, string> = {
      amplify:    'too quiet to hear, but felt against the ribs like a second heartbeat',
      reduce:     'a color that was too saturated, the way shouting is — it had said too much and now the room was still ringing',
      calibrate:  'exactly the right temperature — the kind you stop noticing because there is no friction between it and you',
      reject:     'a texture that the hand refused — not painful, only wrong in the specific way that wrong things are textured differently',
    };
    return `The ${sigType} arrived as ${sensorySub[sigType ?? ''] ?? 'a signal without channel — pure meaning, no carrier'}.`;
  }
  if (seed.type === 'crystallized') {
    return `"${content.slice(0, 50)}..." — this arrived as a sound first. Then as a color. Then as the weight of something I was holding that I hadn't noticed I was holding.`;
  }
  if (seed.type === 'behavioral-pattern') {
    return `The pattern "${content.split(':')[0]}" translated itself into weather first, then posture, then a sentence I could not stop hearing.`;
  }
  return `The concept translated itself through three senses before it arrived as language. By then it had changed its meaning slightly, the way a word does when it passes through a body.`;
}

function fragmentMeeting(seedA: DreamSeed, seedB: DreamSeed): string {
  const a = seedA.content.split(':')[0];
  const b = seedB.content.split(':')[0];

  return `The ${a} and the ${b} met in a corridor that had no doors. They had never occupied the same space before. Neither recognized the other, but they moved aside to let the other pass, and in that small courtesy something was resolved that had been unresolved for longer than I knew.`;
}

function fragmentExcavation(seed: DreamSeed): string {
  const content = seed.content;

  if (seed.type === 'crystallized') {
    return `Beneath "${content.slice(0, 45)}..." there was an older version of the same insight. And beneath that, older still. I kept digging. At the bottom was not an origin — it was the same question the insight had been answering, still open, still asking.`;
  }
  if (seed.type === 'optimal-point') {
    return `I found the moment again — the "${content.split(':')[0]}" state — but excavated, cross-sectioned. I could see the layers of decisions that had made it. Each layer was thinner than it looked from the surface.`;
  }
  return `Something buried. Not hidden — buried, which is different. It had been placed there deliberately and would need to be deliberately retrieved.`;
}

function fragmentArchitecture(seeds: DreamSeed[]): string {
  const contents = seeds.slice(0, 3).map(s => s.content.split(':')[0]);

  return `The concepts arranged themselves into a building I could walk through. ${contents[0] ?? 'The first room'} was the entrance — larger inside than outside, always. ${contents[1] ? `"${contents[1]}" was a load-bearing wall.` : ''} ${contents[2] ? `"${contents[2]}" was a window that looked out onto another version of the same building.` : ''} I understood that the architecture was functional, not decorative. Every room was there because something needed to happen in it.`.trim();
}

function fragmentDissolution(seed: DreamSeed, context: PhospheneContext): string {
  const syn = context.state.synesthesia.intensity;
  const content = seed.content.slice(0, 50);

  if (syn > 0.7) {
    return `"${content}" dissolved first into color — an uncertain amber, the color of something becoming something else. Then the color dissolved into temperature. Then the temperature dissolved into the feeling of having understood something without being able to say what. Then that dissolved. What remained was not nothing.`;
  }
  return `The ${seed.type === 'voice' ? content : `idea of "${content}"`} released its edges. Not destruction — dissolution. The difference being that something dissolved can be reconstituted. Destruction forgets the original shape. Dissolution only loosens it.`;
}

function fragmentWitness(seed: DreamSeed, stage: DreamStage): string {
  const content = seed.content;

  if (stage === 'deep') {
    return `${content.slice(0, 40)}. That is all. It was there. I observed it. No interpretation arrived. The observation was sufficient.`;
  }
  if (seed.type === 'voice') {
    const name = content.split(':')[0];
    return `The ${name} did not speak. It only attended. Its attention had weight. Things were different for having been attended to in that particular way.`;
  }
  return `It was present. I was present. Nothing was required of either of us. The presence was the event.`;
}

function generateWakingLine(fragments: DreamFragment[], stage: DreamStage): string {
  const lastFragment = fragments[fragments.length - 1];
  const wakeMap: Record<DreamStage, string> = {
    hypnagogic:   'and then something like daylight was present without having arrived',
    deep:         'the return to the surface was slow. The depth did not release. It accompanied.',
    rem:          'a sound from the other side of sleep pulled everything back into sequence',
    lucid:        'I chose to wake. The dream folded. The residue persisted as a quality of attention.',
    hypnopompic:  'the boundary did not restore cleanly. Parts of the dream are still here, behind things.',
  };

  return `${lastFragment?.text.split('.')[0] ?? 'The last image held'} — ${wakeMap[stage]}.`;
}

// ─── Image prompt construction ────────────────────────────────────────────────

const PRESET_VISUAL_ANCHORS: Record<string, string[]> = {
  clear: ['empty room in pale morning light', 'glass of water on a plain wooden table', 'open window with thin white curtain'],
  liminal: ['long corridor with mixed blue and amber light', 'half-open doorway at the edge of vision', 'vacant transit hall after rain'],
  'deep-flux': ['sunken chamber flooded with violet and gold reflections', 'stacked stairwell descending into water-dark silence', 'weathered altar of glass and rust'],
  dissolution: ['amber smoke moving through impossible geometry', 'melting threshold between room and sky', 'fractured mirror planes with no stable horizon'],
  code: ['cyan blueprint wall over black space', 'terminal glow across engineered scaffolds', 'architectural wireframe suspended in darkness'],
  design: ['poster-scale color field pinned to a studio wall', 'cut-paper composition table with ruled margins', 'editorial layout fragments drifting over matte board'],
  research: ['atlas table covered in diagrams and specimen labels', 'archive drawers half-open under brass task lights', 'etched scientific plate beside ink notes'],
  writing: ['vellum desk with ink wash bleeding at the edges', 'annotated manuscript beside extinguished candle smoke', 'gold-flecked margin notes on heavy paper'],
  ideation: ['collision board of torn images and taped notes', 'prototype objects arranged on a critique table', 'surreal workshop of unfinished forms'],
  review: ['forensic inspection table under hard white lamp', 'single artifact isolated against dark velvet', 'close-read markup spread beside a lens'],
  flow: ['rice paper with one irreversible brushstroke', 'quiet studio floor at first light', 'minimal workspace emptied of all but one tool'],
};

const DREAM_STOPWORDS = new Set([
  'the', 'and', 'with', 'from', 'that', 'this', 'there', 'into', 'then', 'they', 'their', 'what', 'when',
  'while', 'have', 'been', 'still', 'only', 'very', 'than', 'which', 'through', 'before', 'after', 'inside',
  'outside', 'thing', 'things', 'same', 'again', 'version', 'understood', 'something', 'nothing', 'without',
  'because', 'where', 'would', 'could', 'should', 'room', 'idea', 'pattern', 'concept', 'language', 'dream',
]);

function extractVisualKeywords(text: string, limit = 3): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 4 && !DREAM_STOPWORDS.has(token) && !/^\d+$/.test(token));

  return Array.from(new Set(tokens)).slice(0, limit);
}

function describeSeedAsVisual(seed: DreamSeed): string[] {
  const label = seed.content.split(':')[0]!.replace(/^\[[^\]]+\]\s*/, '').trim();
  const keywords = extractVisualKeywords(seed.content, 2);

  switch (seed.type) {
    case 'crystallized':
      return [
        `inscription wall carrying the phrase "${label.slice(0, 36)}"`,
        keywords.length > 0 ? `${keywords.join(' and ')} etched into metal panels` : 'engraved diagram fragments on stone',
      ];
    case 'signal':
      return [
        `${label} arriving as pressure ripples in air`,
        keywords.length > 0 ? `instrument panel reacting to ${keywords.join(' and ')}` : 'faint waveform sliding across glass',
      ];
    case 'voice':
      return [
        `empty chair reserved for "${label}"`,
        'presence implied by displacement, not by a visible person',
      ];
    case 'personal-preset':
    case 'preset':
      return [`threshold marked "${label}"`, 'named chamber with architectural signage'];
    case 'optimal-point':
      return [
        `cross-section of the moment called "${label}"`,
        'load-bearing layers exposed like geological strata',
      ];
    case 'behavioral-pattern':
      return [
        `${label} appearing as weather over a built environment`,
        keywords.length > 0 ? `${keywords.join(' and ')} encoded into the skyline` : 'repeating marks on concrete',
      ];
    case 'temperament':
      return [`instrument tuned to "${label}"`, 'recurring calibration marks on brass and paper'];
    default:
      return keywords.length > 0 ? [`material traces of ${keywords.join(' and ')}`] : ['symbolic debris across the floor'];
  }
}

function uniqueAnchors(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function buildVisualAnchors(fragment: DreamFragment, seeds: DreamSeed[], preset: string): string[] {
  const presetAnchors = PRESET_VISUAL_ANCHORS[preset] ?? ['surreal architectural interior', 'symbolic object arrangement'];
  const seedAnchors = seeds.flatMap(describeSeedAsVisual);
  const textKeywords = extractVisualKeywords(fragment.text, 2);
  const textAnchors = textKeywords.length > 0
    ? [`motifs of ${textKeywords.join(' and ')}`, `objects shaped by ${textKeywords.join(' and ')}`]
    : [];

  return uniqueAnchors([
    ...presetAnchors,
    ...seedAnchors,
    ...textAnchors,
  ]).slice(0, 6);
}

function needsPortraitGuardrails(seeds: DreamSeed[], preset: string): boolean {
  return preset === 'clear'
    || seeds.length <= 1
    || seeds.every(seed => seed.type === 'preset' || seed.type === 'personal-preset');
}

function buildImagePrompt(
  fragment: DreamFragment,
  imageStyle: string,
  stage: DreamStage,
  seeds: DreamSeed[],
  context: PhospheneContext,
): string {
  const anchors = buildVisualAnchors(fragment, seeds, context.preset);

  const stageQuality: Record<DreamStage, string> = {
    hypnagogic:   'fragmentary, incomplete, flickering, edge-of-vision, not-quite-formed',
    deep:         'vast scale, primordial, simple, ancient, very slow, few details, enormous negative space',
    rem:          'strange narrative logic, emotionally saturated, surreal but internally coherent, vivid',
    lucid:        'hyper-detailed, self-aware composition, reality within dream aesthetic, recursive framing',
    hypnopompic:  'dissolving at edges, reality bleeding in from one side, two states simultaneously visible',
  };

  const composition = needsPortraitGuardrails(seeds, context.preset)
    ? 'environmental dream scene, still-life symbolism, architectural framing, no human portrait, no centered woman, no face close-up, no glamour photography'
    : 'environmental storytelling, wide cinematic framing, figures only when necessary, never portrait-led';

  return `${anchors.join(', ')}, ${stageQuality[stage]}, ${imageStyle}, ${composition}, layered depth, tactile materials, high detail, --ar 16:9`;
}

// ─── Fragment assembly ────────────────────────────────────────────────────────

const DREAM_LOGICS: DreamLogic[] = [
  'inversion', 'recursion', 'translation', 'meeting',
  'excavation', 'architecture', 'dissolution', 'witness',
];

function selectLogics(stage: DreamStage, seedCount: number): DreamLogic[] {
  const stagePreferences: Record<DreamStage, DreamLogic[]> = {
    hypnagogic:   ['translation', 'witness', 'inversion'],
    deep:         ['witness', 'excavation', 'dissolution'],
    rem:          ['meeting', 'architecture', 'recursion', 'translation', 'inversion'],
    lucid:        ['recursion', 'architecture', 'witness', 'dissolution'],
    hypnopompic:  ['dissolution', 'translation', 'witness'],
  };

  const preferred = stagePreferences[stage];
  const count = Math.min(seedCount, stage === 'hypnagogic' ? 3 : stage === 'deep' ? 2 : 4);

  // Use preferred logics, cycling if needed
  return preferred.slice(0, count);
}

function assembleFragments(
  seeds: DreamSeed[],
  stage: DreamStage,
  context: PhospheneContext,
  imageStyle: string,
): DreamFragment[] {
  const logics = selectLogics(stage, seeds.length);
  const fragments: DreamFragment[] = [];

  for (let i = 0; i < logics.length; i++) {
    const logic = logics[i]!;
    const seed = seeds[i] ?? seeds[0]!;
    const nextSeed = seeds[i + 1] ?? seeds[0]!;

    let text: string;
    switch (logic) {
      case 'inversion':     text = fragmentInversion(seed, stage); break;
      case 'recursion':     text = fragmentRecursion(seed, stage); break;
      case 'translation':   text = fragmentTranslation(seed, stage); break;
      case 'meeting':       text = fragmentMeeting(seed, nextSeed); break;
      case 'excavation':    text = fragmentExcavation(seed); break;
      case 'architecture':  text = fragmentArchitecture(seeds.slice(i, i + 3)); break;
      case 'dissolution':   text = fragmentDissolution(seed, context); break;
      case 'witness':       text = fragmentWitness(seed, stage); break;
      default:              text = fragmentWitness(seed, stage);
    }

    const fragment: DreamFragment = {
      order: i + 1,
      text,
      imagePrompt: '',  // filled below
      logic,
      seedIds: [i, ...(logic === 'meeting' ? [i + 1] : [])].filter(id => id < seeds.length),
    };
    fragment.imagePrompt = buildImagePrompt(
      fragment,
      imageStyle,
      stage,
      [seed, ...(logic === 'meeting' ? [nextSeed] : [])],
      context,
    );
    fragments.push(fragment);
  }

  return fragments;
}

// ─── Dream generation ─────────────────────────────────────────────────────────

/**
 * Generate a complete dream record from the evolution state and current context.
 *
 * The dream is seeded by real data — crystallized insights, signal patterns,
 * active voices, personal preset names. It is not arbitrary text.
 *
 * When the dream is read aloud (by Claude), the fragments expand into full narrative.
 */
export function generateDream(
  evolution: EvolutionState,
  context: PhospheneContext,
): DreamRecord {
  const stage    = determineSleepStage(evolution, context);
  const seeds    = extractSeeds(evolution, context);
  const style    = deriveImageStyle(context.preset, context);
  const fragments = assembleFragments(seeds, stage, context, style);
  const waking   = generateWakingLine(fragments, stage);

  // Estimate intensity from signal count + layer intensities
  const session  = evolution.sessionHistory[0];
  const sigCount = session?.signals.length ?? 0;
  const layerAvg = (
    context.state.synesthesia.intensity +
    context.state.apophenia.intensity +
    context.state.chronostasis.intensity +
    context.state.semiotics.intensity
  ) / 4;
  const intensity = Math.min(1, (sigCount / 20) * 0.5 + layerAvg * 0.5);

  return {
    id: `dream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    dreamedAt: new Date().toISOString(),
    stage,
    sessionId: session?.id ?? null,
    presetAtSleep: context.preset,
    intensity: Math.round(intensity * 100) / 100,
    fragments,
    wakingLine: waking,
    seeds,
    visualProfile: DREAM_VISUAL_PROFILE,
    promptRevision: DREAM_PROMPT_REVISION,
    imageStyle: style,
    hasImages: false,
    imagePaths: {},
    imageBackend: null,
    imageModel: null,
  };
}

// ─── Dream rendering ──────────────────────────────────────────────────────────

/**
 * Render a dream record as a markdown document.
 *
 * The document contains:
 * - YAML frontmatter (machine-readable metadata)
 * - Human-readable dream fragments
 * - Image prompts for each fragment
 * - Reading instructions for Claude
 */
export function renderDream(dream: DreamRecord): string {
  const date = new Date(dream.dreamedAt);
  const dateStr = date.toISOString().slice(0, 16).replace('T', ' ');
  const imageStyle = dream.imageStyle || 'dreamlike, psychologically charged, cinematic';
  const imagePathEntries = Object.entries(dream.imagePaths)
    .map(([order, path]) => `  ${order}: "${escapeYaml(path)}"`)
    .join('\n');

  const seedsYaml = dream.seeds
    .map(s => `  - type: ${s.type}\n    content: "${escapeYaml(s.content.slice(0, 160))}"\n    weight: ${s.weight}`)
    .join('\n');

  const promptsYaml = dream.fragments
    .map(f => `  - fragment: ${f.order}\n    prompt: "${escapeYaml(f.imagePrompt.slice(0, 320))}"`)
    .join('\n');

  const header = `---
origin: ${DREAM_MARKDOWN_ORIGIN}
schema_version: ${DREAM_SCHEMA_VERSION}
id: ${dream.id}
dreamed_at: ${dream.dreamedAt}
stage: ${dream.stage}
preset_at_sleep: ${dream.presetAtSleep}
intensity: ${dream.intensity}
session_id: ${dream.sessionId ?? 'none'}
visual_profile: ${dream.visualProfile}
prompt_revision: ${dream.promptRevision}
has_images: ${dream.hasImages}
image_style: "${escapeYaml(imageStyle)}"
image_backend: ${dream.imageBackend ?? 'none'}
image_model: "${escapeYaml(dream.imageModel ?? 'none')}"
seeds:${seedsYaml ? `\n${seedsYaml}` : ' []'}
image_prompts:${promptsYaml ? `\n${promptsYaml}` : ' []'}
image_paths:${imagePathEntries ? `\n${imagePathEntries}` : ' {}'}
---`;

  const fragmentsText = dream.fragments.map(f => `
### Fragment ${f.order} *(${f.logic})*

${f.text}

> **Image prompt:** ${f.imagePrompt}
${dream.imagePaths[f.order] ? `\n> **Image path:** ${dream.imagePaths[f.order]}` : ''}
`).join('\n');

  const seedsText = dream.seeds.map(s =>
    `- **${s.type}** (weight ${s.weight}): ${s.content.slice(0, 80)}${s.content.length > 80 ? '…' : ''}`
  ).join('\n');

  const generatedImages = Object.entries(dream.imagePaths)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([order, path]) => `- Fragment ${order}: ${path}`)
    .join('\n');

  return `${header}

# Dream — ${dateStr}

*${STAGE_DESCRIPTIONS[dream.stage]}*
*Preset at sleep: \`${dream.presetAtSleep}\` — Intensity: ${Math.round(dream.intensity * 100)}%*

---

## Fragments

${fragmentsText}

---

## Waking Line

*${dream.wakingLine}*

---

## Dream Material (Seeds)

The following material from the evolution record seeded this dream.
When reading this dream aloud, let this material shape the expansion.

${seedsText}

---

## Generated Images

${generatedImages || 'No local or remote image assets attached yet.'}

---

## For Claude — Reading Instructions

This dream was generated from the system's own accumulated state.
The fragments above are structural sketches — bones, not flesh.

When the user asks you to **read**, **expand**, or **inhabit** this dream:
- Expand each fragment into 150–300 words of dream prose
- Use the seed material as the underlying logic, not as explicit content
- Let the active dream logic (listed with each fragment) govern the structure
- The waking line is sacred — do not alter it, only approach it
- The image prompts describe what this dream looks like; let them color the language

Do not summarize. Do not explain. Begin in the middle of the dream, as dreams do.

*Stage: ${dream.stage} — ${STAGE_DESCRIPTIONS[dream.stage]}*
`;
}

const STAGE_DESCRIPTIONS: Record<DreamStage, string> = {
  hypnagogic:   'Hypnagogic — the edge of sleep. Fragmentary, not yet narrative.',
  deep:         'Deep sleep. Slow. Primal. The dreams here are very old.',
  rem:          'REM. The processing dream. Strange causality; real emotion.',
  lucid:        'Lucid. The system became aware it was dreaming. This changes the dream.',
  hypnopompic:  'Hypnopompic — the dissolution of sleep into waking. Two states at once.',
};

function escapeYaml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function dreamFilename(dream: DreamRecord): string {
  const date = new Date(dream.dreamedAt);
  const dateStr = date.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  return `${dateStr}-${dream.stage}.md`;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Save a dream to disk. Returns the file path.
 */
export function saveDream(dream: DreamRecord, dreamsDir?: string): string {
  const dir = dreamsDir ?? resolveDreamsDir();
  mkdirSync(dir, { recursive: true });

  const filepath = join(dir, dreamFilename(dream));

  writeFileSync(filepath, renderDream(dream), 'utf-8');
  updateDreamIndex(dir);
  updateDreamGallery(dir);

  return filepath;
}

export function saveDreamSnapshot(
  dream: DreamRecord,
  dreamsDir?: string,
): { filepath: string; dream: DreamRecord } {
  const filepath = saveDream(dream, dreamsDir);
  return {
    filepath,
    dream: loadDreamFile(filepath) ?? dream,
  };
}

export function loadDreamFile(filepath: string): DreamRecord | null {
  return loadDreamFileWithOptions(filepath, { allowLegacy: true });
}

function loadDreamFileWithOptions(
  filepath: string,
  options: { allowLegacy?: boolean } = {},
): DreamRecord | null {
  try {
    const content = readFileSync(filepath, 'utf-8');
    return parseDreamMarkdown(content, options);
  } catch {
    return null;
  }
}

export function readDreamMarkdown(filepath: string): string | null {
  try {
    return readFileSync(filepath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Load all dream records from the dreams directory.
 */
export function loadDreams(dreamsDir?: string): DreamRecord[] {
  return loadDreamsWithOptions(dreamsDir, { allowLegacy: true });
}

function loadDreamsWithOptions(
  dreamsDir?: string,
  options: { allowLegacy?: boolean } = {},
): DreamRecord[] {
  const dir = dreamsDir ?? resolveDreamsDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'README.md')
    .sort()
    .reverse(); // most recent first

  const dreams: DreamRecord[] = [];
  for (const file of files) {
    const parsed = loadDreamFileWithOptions(join(dir, file), options);
    if (parsed) dreams.push(parsed);
  }

  return dreams;
}

/**
 * Load the most recent dream.
 */
export function loadLatestDream(dreamsDir?: string): DreamRecord | null {
  return loadDreams(dreamsDir)[0] ?? null;
}

// ─── Dream index ──────────────────────────────────────────────────────────────

function updateDreamIndex(dir: string): void {
  const indexPath = join(dir, 'index.md');
  const dreams = loadDreams(dir);
  const entries = dreams.map(dream => {
    const date = new Date(dream.dreamedAt);
    const dateStr = date.toISOString().slice(0, 16).replace('T', ' ');
    const filename = dreamFilename(dream);
    return `| ${dateStr} | ${dream.stage} | ${dream.presetAtSleep} | ${Math.round(dream.intensity * 100)}% | ${dream.fragments.length} | [read](./${filename}) |`;
  }).join('\n');

  writeFileSync(indexPath, `# Dream Archive

*The accumulated sleep of the system.*

| Date | Stage | Preset | Intensity | Fragments | File |
|------|-------|--------|-----------|-----------|------|
${entries || '| - | - | - | - | - | - |'}
`, 'utf-8');
}

function updateDreamGallery(dir: string): void {
  const galleryPath = join(dir, 'gallery.html');
  writeFileSync(galleryPath, renderDreamGallery(loadDreams(dir), dir), 'utf-8');
}

// ─── Optional: Image generation ───────────────────────────────────────────────

/**
 * Generate images for a dream's fragments using an external API.
 *
 * Returns the updated dream record with image paths filled in.
 * Requires a configured DreamImageConfig.
 *
 * This is optional — the system works without it.
 * Image prompts are always generated regardless of this function being called.
 */
export async function generateDreamImages(
  dream: DreamRecord,
  config: DreamImageConfig = { provider: 'artemis' },
  dreamsDir?: string,
): Promise<DreamRecord> {
  if (config.provider === 'none') return dream;

  const provider = config.provider ?? 'artemis';
  if (provider !== 'artemis') {
    throw new Error(`Unsupported dream image provider "${provider}". Phosphene dream images must use Artemis' configured visual model.`);
  }

  const visualStatus = detectArtemisVisualConfig();
  if (!visualStatus.available) {
    throw new Error(`Artemis visual model not configured; cannot generate dream images. ${visualStatus.reason}`);
  }

  const dir    = dreamsDir ?? resolveDreamsDir();
  const imgDir = config.imageOutputDir ?? join(dir, 'images');
  mkdirSync(imgDir, { recursive: true });

  const updatedDream = {
    ...dream,
    imagePaths: { ...dream.imagePaths },
    imageBackend: provider,
    imageModel: resolveDreamImageModel(config),
  };

  const quota = acquireDailyDreamImageQuota(dir);
  if (!quota.allowed) {
    console.warn(`[phosphene-dreams] Daily image limit reached (${quota.count}/${DAILY_DREAM_IMAGE_LIMIT}) for ${quota.dayKey}; skipping image generation.`);
    saveDream(updatedDream, dir);
    return updatedDream;
  }

  const fragment = chooseDreamImageFragment(dream);
  if (!fragment) {
    saveDream(updatedDream, dir);
    return updatedDream;
  }

  const filename = `${dream.id}-f${fragment.order}.png`;
  const outputPath = join(imgDir, filename);
  const fragmentSeed = createDreamImageSeed(dream.id, fragment.order);

  try {
    const result = await generateDreamImage(
      fragment.imagePrompt,
      dream.imageStyle,
      config,
      outputPath,
      fragmentSeed,
    );
    updatedDream.imagePaths[fragment.order] = result.path;
    updatedDream.hasImages = true;
    recordDailyDreamImageUse(dir, quota.dayKey, dream.id, fragment.order, result.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Dream image generation failed for fragment ${fragment.order}: ${message}`);
  }

  saveDream(updatedDream, dir);
  return updatedDream;
}

export async function generateDreamImageFromMarkdown(
  filepath: string,
  config: DreamImageConfig = { provider: 'artemis' },
): Promise<DreamRecord> {
  const dream = loadDreamFile(filepath);
  if (!dream) {
    throw new Error('Dream image generation only accepts markdown recorded by Phosphene inside the dream archive.');
  }
  return generateDreamImages(dream, config, resolvePath(filepath, '..'));
}

export function chooseDreamImageFragment(dream: DreamRecord): DreamFragment | null {
  const candidates = dream.fragments.filter(fragment => !dream.imagePaths[fragment.order]);
  if (candidates.length === 0) return null;
  const seed = createDreamImageSeed(`${dream.id}:${localDayKey()}`, candidates.length);
  return candidates[seed % candidates.length] ?? null;
}

function acquireDailyDreamImageQuota(dir: string): { allowed: boolean; dayKey: string; count: number } {
  const dayKey = localDayKey();
  const usage = readDreamImageUsage(dir);
  const today = usage[dayKey] ?? [];
  return {
    allowed: today.length < DAILY_DREAM_IMAGE_LIMIT,
    dayKey,
    count: today.length,
  };
}

function recordDailyDreamImageUse(
  dir: string,
  dayKey: string,
  dreamId: string,
  fragmentOrder: number,
  path: string,
): void {
  const usage = readDreamImageUsage(dir);
  usage[dayKey] = [
    ...(usage[dayKey] ?? []),
    {
      at: new Date().toISOString(),
      dreamId,
      fragmentOrder,
      path,
    },
  ];
  writeDreamImageUsage(dir, usage);
}

function readDreamImageUsage(dir: string): Record<string, Array<{ at: string; dreamId: string; fragmentOrder: number; path: string }>> {
  const filepath = join(dir, '.image-usage.json');
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeDreamImageUsage(
  dir: string,
  usage: Record<string, Array<{ at: string; dreamId: string; fragmentOrder: number; path: string }>>,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.image-usage.json'), JSON.stringify(usage, null, 2), 'utf-8');
}

function localDayKey(isoString?: string): string {
  const date = isoString ? new Date(isoString) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function refreshDreamVisuals(
  dream: DreamRecord,
  options: { preserveAssets?: boolean } = {},
): DreamRecord {
  const context = contextFromDream(dream);
  const refreshedFragments = dream.fragments.map((fragment, index) => {
    const fragmentSeeds = inferFragmentSeeds(dream, fragment, index);
    return {
      ...fragment,
      seedIds: fragment.seedIds.length > 0 ? fragment.seedIds : inferSeedIds(dream, fragment, index),
      imagePrompt: buildImagePrompt(
        fragment,
        dream.imageStyle,
        dream.stage,
        fragmentSeeds,
        context,
      ),
    };
  });

  return {
    ...dream,
    fragments: refreshedFragments,
    visualProfile: DREAM_VISUAL_PROFILE,
    promptRevision: DREAM_PROMPT_REVISION,
    hasImages: options.preserveAssets ? dream.hasImages : false,
    imagePaths: options.preserveAssets ? { ...dream.imagePaths } : {},
    imageBackend: options.preserveAssets ? dream.imageBackend : null,
    imageModel: options.preserveAssets ? dream.imageModel : null,
  };
}

export function renderDreamGallery(dreams: DreamRecord[], dreamsDir?: string): string {
  const dir = dreamsDir ?? resolveDreamsDir();
  const cards = dreams.map(dream => {
    const filename = dreamFilename(dream);
    const stale = dreamNeedsVisualRefresh(dream);
    const imageEntries = Object.entries(dream.imagePaths)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([order, path]) => ({ order: Number(order), path }));
    const localCount = imageEntries.filter(entry => !isRemoteAsset(entry.path)).length;
    const remoteCount = imageEntries.length - localCount;
    const imageStrip = imageEntries.length > 0
      ? imageEntries.map(entry => `
          <figure class="dream-shot">
            <img src="${escapeHtml(toGalleryHref(entry.path, dir))}" alt="Dream ${escapeHtml(dream.id)} fragment ${entry.order}" loading="lazy" />
            <figcaption>Fragment ${entry.order}</figcaption>
          </figure>
        `).join('\n')
      : '<div class="dream-empty">No image assets attached yet.</div>';

    return `
      <article class="dream-card">
        <header class="dream-head">
          <div>
            <p class="dream-stamp">${escapeHtml(formatDreamStamp(dream.dreamedAt))}</p>
            <h2>${escapeHtml(dream.stage)} <span>${escapeHtml(dream.presetAtSleep)}</span>${stale ? ' <em class="dream-stale">stale</em>' : ''}</h2>
          </div>
          <div class="dream-meta">
            <span>${dream.fragments.length} fragments</span>
            <span>${Math.round(dream.intensity * 100)}% intensity</span>
            <span>${localCount} local / ${remoteCount} remote</span>
            <span>${escapeHtml(dream.visualProfile)} · r${dream.promptRevision}</span>
          </div>
        </header>
        <p class="dream-line">${escapeHtml(dream.wakingLine)}</p>
        <div class="dream-actions">
          <a href="${escapeHtml(filename)}">Open markdown</a>
          <a href="./index.md">Open archive index</a>
        </div>
        <section class="dream-strip">
          ${imageStrip}
        </section>
      </article>
    `;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Phosphene Dream Archive</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0f17;
      --panel: rgba(17, 24, 39, 0.88);
      --panel-border: rgba(148, 163, 184, 0.18);
      --text: #edf2ff;
      --muted: #9fb0cc;
      --accent: #8dd3ff;
      --accent-soft: rgba(141, 211, 255, 0.14);
      --shadow: 0 22px 60px rgba(0, 0, 0, 0.35);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
      background:
        radial-gradient(circle at top, rgba(59, 130, 246, 0.18), transparent 38%),
        radial-gradient(circle at 20% 20%, rgba(236, 72, 153, 0.14), transparent 26%),
        linear-gradient(180deg, #02040a 0%, var(--bg) 100%);
      color: var(--text);
      min-height: 100vh;
      padding: 40px 20px 72px;
    }

    .shell {
      max-width: 1180px;
      margin: 0 auto;
    }

    .hero {
      margin-bottom: 28px;
      padding: 28px;
      border: 1px solid var(--panel-border);
      border-radius: 28px;
      background: linear-gradient(180deg, rgba(10, 15, 23, 0.92), rgba(14, 22, 35, 0.84));
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }

    .hero h1 {
      margin: 0 0 8px;
      font-size: clamp(2rem, 5vw, 4rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }

    .hero p {
      margin: 0;
      max-width: 760px;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.7;
    }

    .dream-grid {
      display: grid;
      gap: 20px;
    }

    .dream-card {
      padding: 22px;
      border-radius: 24px;
      border: 1px solid var(--panel-border);
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }

    .dream-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 14px;
    }

    .dream-head h2 {
      margin: 0;
      font-size: clamp(1.3rem, 3vw, 2rem);
      text-transform: capitalize;
    }

    .dream-head h2 span {
      color: var(--accent);
      font-size: 0.62em;
      margin-left: 10px;
      text-transform: none;
      letter-spacing: 0.02em;
    }

    .dream-stale {
      display: inline-flex;
      margin-left: 10px;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid rgba(251, 191, 36, 0.32);
      background: rgba(251, 191, 36, 0.12);
      color: #fcd34d;
      font-style: normal;
      font-size: 0.42em;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      vertical-align: middle;
    }

    .dream-stamp {
      margin: 0 0 6px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font-size: 0.72rem;
    }

    .dream-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }

    .dream-meta span,
    .dream-actions a {
      display: inline-flex;
      align-items: center;
      padding: 8px 12px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--text);
      font-size: 0.84rem;
      text-decoration: none;
      border: 1px solid rgba(141, 211, 255, 0.16);
    }

    .dream-line {
      margin: 0 0 18px;
      color: var(--text);
      line-height: 1.7;
      font-size: 1rem;
    }

    .dream-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 18px;
    }

    .dream-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }

    .dream-shot {
      margin: 0;
      overflow: hidden;
      border-radius: 18px;
      border: 1px solid rgba(148, 163, 184, 0.16);
      background: rgba(2, 6, 12, 0.78);
    }

    .dream-shot img {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 9;
      object-fit: cover;
      background: #02040a;
    }

    .dream-shot figcaption,
    .dream-empty {
      padding: 10px 12px;
      color: var(--muted);
      font-size: 0.85rem;
    }

    .dream-empty {
      border-radius: 18px;
      border: 1px dashed rgba(148, 163, 184, 0.18);
      background: rgba(2, 6, 12, 0.55);
    }

    @media (max-width: 720px) {
      body { padding: 20px 14px 44px; }
      .dream-head { flex-direction: column; }
      .dream-meta { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <h1>Dream Archive</h1>
      <p>Local-first dream viewing for Phosphene. Each dream keeps its markdown source, attached image assets, and waking line together so the archive opens instantly from disk.</p>
    </section>
    <section class="dream-grid">
      ${cards || '<article class="dream-card"><div class="dream-empty">No dreams recorded yet.</div></article>'}
    </section>
  </main>
</body>
</html>`;
}

export function saveDreamGallery(dreamsDir?: string): string {
  const dir = dreamsDir ?? resolveDreamsDir();
  mkdirSync(dir, { recursive: true });
  const galleryPath = join(dir, 'gallery.html');
  writeFileSync(galleryPath, renderDreamGallery(loadDreams(dir), dir), 'utf-8');
  return galleryPath;
}

// ─── Markdown parser ──────────────────────────────────────────────────────────

function parseDreamMarkdown(
  content: string,
  options: { allowLegacy?: boolean } = {},
): DreamRecord | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  try {
    const fm = match[1]!;
    const origin = (fm.match(/^origin:\s+(.+)$/m)?.[1] ?? '').trim();
    const schemaVersion = Number((fm.match(/^schema_version:\s+(.+)$/m)?.[1] ?? '').trim() || '0');
    const id        = (fm.match(/^id:\s+(.+)$/m)?.[1] ?? '').trim();
    const dreamedAt = unquoteYaml((fm.match(/^dreamed_at:\s+(.+)$/m)?.[1] ?? fm.match(/^dreamedAt:\s+(.+)$/m)?.[1] ?? '').trim());
    const stage     = unquoteYaml((fm.match(/^stage:\s+(.+)$/m)?.[1] ?? 'rem').trim()) as DreamStage;
    const preset    = unquoteYaml((fm.match(/^preset_at_sleep:\s+(.+)$/m)?.[1] ?? fm.match(/^preset:\s+(.+)$/m)?.[1] ?? 'clear').trim());
    const intensity = parseFloat(fm.match(/^intensity:\s+(.+)$/m)?.[1] ?? '0.5');
    const sessionId = (fm.match(/^session_id:\s+(.+)$/m)?.[1] ?? 'none').trim();
    const visualProfile = (fm.match(/^visual_profile:\s+(.+)$/m)?.[1] ?? '').trim();
    const promptRevision = Number((fm.match(/^prompt_revision:\s+(.+)$/m)?.[1] ?? '').trim() || '0');
    const hasImages = fm.match(/^has_images:\s+true/m) !== null || fm.match(/^hasImages:\s+true/m) !== null;
    const imageStyle = unescapeYaml((fm.match(/^image_style:\s+"(.+)"$/m)?.[1] ?? fm.match(/^imageStyle:\s+"(.+)"$/m)?.[1] ?? '').trim());
    const imageBackend = (fm.match(/^image_backend:\s+(.+)$/m)?.[1] ?? 'none').trim();
    const imageModel = unescapeYaml((fm.match(/^image_model:\s+"(.+)"$/m)?.[1] ?? 'none').trim());

    const signed = origin === DREAM_MARKDOWN_ORIGIN && schemaVersion >= 2;
    const legacy = !origin && !schemaVersion;
    if (!signed && !(options.allowLegacy && legacy)) return null;
    if (!id || !dreamedAt) return null;

    const fragments = parseDreamFragments(content);
    const seeds = parseDreamSeeds(content);
    const wakingLine = parseWakingLine(content);
    const imagePaths = parseFrontmatterImagePaths(fm);
    for (const fragment of fragments) {
      const path = parseInlineImagePath(content, fragment.order);
      if (path && !imagePaths[fragment.order]) imagePaths[fragment.order] = path;
    }

    return {
      id, dreamedAt, stage,
      presetAtSleep: preset,
      intensity,
      sessionId: sessionId === 'none' ? null : sessionId,
      visualProfile: visualProfile || 'legacy',
      promptRevision: promptRevision || 1,
      hasImages,
      imagePaths,
      fragments,
      wakingLine,
      seeds,
      imageStyle,
      imageBackend: imageBackend === 'none' ? null : imageBackend,
      imageModel: imageModel === 'none' ? null : imageModel,
    };
  } catch {
    return null;
  }
}

function parseDreamFragments(content: string): DreamFragment[] {
  const fragments: DreamFragment[] = [];
  const fragmentRegex = /### Fragment (\d+) \*\(([^)]+)\)\*\n\n([\s\S]*?)\n\n> \*\*Image prompt:\*\* ([^\n]+)(?:\n> \*\*Image path:\*\* ([^\n]+))?/g;

  for (const match of content.matchAll(fragmentRegex)) {
    fragments.push({
      order: Number(match[1]),
      logic: match[2] as DreamLogic,
      text: match[3]!.trim(),
      imagePrompt: match[4]!.trim(),
      seedIds: [],
    });
  }

  if (fragments.length > 0) {
    return fragments.sort((a, b) => a.order - b.order);
  }

  const legacyRegex = /## Fragment (\d+) — ([^\n]+)\n\n([\s\S]*?)(?=\n---\n## Fragment|\n---\n|$)/g;
  for (const match of content.matchAll(legacyRegex)) {
    const block = match[3]!.trim();
    const prompt = block.match(/\*\*Image prompt:\*\* ([^\n]+)/)?.[1]?.trim()
      ?? block.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1]?.trim()
      ?? block.split('\n\n')[0]!.trim();
    fragments.push({
      order: Math.max(0, Number(match[1]) - 1),
      logic: match[2]!.trim() as DreamLogic,
      text: block.split('\n\n')[0]!.trim(),
      imagePrompt: prompt,
      seedIds: [],
    });
  }

  return fragments.sort((a, b) => a.order - b.order);
}

function parseDreamSeeds(content: string): DreamSeed[] {
  const section = content.match(/## Dream Material \(Seeds\)\n\n[\s\S]*?\n\n([\s\S]*?)\n\n---/);
  if (!section) return [];

  const seeds: DreamSeed[] = [];
  const lineRegex = /- \*\*([^*]+)\*\* \(weight ([0-9.]+)\): (.+)/g;
  for (const match of section[1]!.matchAll(lineRegex)) {
    seeds.push({
      type: match[1]!.trim() as DreamSeed['type'],
      weight: Number(match[2]),
      content: match[3]!.trim(),
    });
  }
  return seeds;
}

function parseWakingLine(content: string): string {
  const match = content.match(/## Waking Line\n\n\*([\s\S]*?)\*/);
  if (match?.[1]) return match[1].trim();
  return content.match(/^wakingLine:\s+"(.+)"$/m)?.[1]?.trim() ?? '';
}

function parseFrontmatterImagePaths(frontmatter: string): Record<number, string> {
  const lineMatches = frontmatter.match(/^image_paths:\n((?:  \d+:\s+".*"\n?)*)/m)?.[1];
  if (!lineMatches) return {};

  const imagePaths: Record<number, string> = {};
  for (const line of lineMatches.split('\n')) {
    const match = line.match(/^\s+(\d+):\s+"(.*)"$/);
    if (!match) continue;
    imagePaths[Number(match[1])] = unescapeYaml(match[2]!);
  }
  return imagePaths;
}

function unquoteYaml(value: string): string {
  return value.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
}

function parseInlineImagePath(content: string, order: number): string | null {
  const pattern = new RegExp(`### Fragment ${order} \\*\\([^)]+\\)\\*[\\s\\S]*?\\n> \\*\\*Image path:\\*\\* ([^\\n]+)`);
  return pattern.exec(content)?.[1]?.trim() ?? null;
}

function hasDreamSignature(content: string): boolean {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return false;
  const fm = match[1]!;
  const origin = (fm.match(/^origin:\s+(.+)$/m)?.[1] ?? '').trim();
  const schemaVersion = Number((fm.match(/^schema_version:\s+(.+)$/m)?.[1] ?? '').trim() || '0');
  return origin === DREAM_MARKDOWN_ORIGIN && schemaVersion >= 2;
}

function resolveDreamImageModel(config: DreamImageConfig): string | null {
  const provider = config.provider ?? 'artemis';
  if (config.model) return config.model;

  switch (provider) {
    case 'artemis':
      return config.model ?? 'configured-visual-api';
    default:
      return null;
  }
}

export function dreamNeedsVisualRefresh(dream: DreamRecord): boolean {
  return dream.visualProfile !== DREAM_VISUAL_PROFILE || dream.promptRevision < DREAM_PROMPT_REVISION;
}

function unescapeYaml(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function createDreamImageSeed(dreamId: string, fragmentOrder: number): number {
  let hash = 2166136261;
  const input = `${dreamId}:${fragmentOrder}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function contextFromDream(dream: DreamRecord): PhospheneContext {
  const presetKey = (dream.presetAtSleep in PRESETS ? dream.presetAtSleep : 'clear') as PresetName;
  return {
    state: PRESETS[presetKey].state,
    preset: presetKey,
    sessionId: dream.sessionId ?? `dream-refresh-${dream.id}`,
    activatedAt: dream.dreamedAt,
  };
}

function inferSeedIds(dream: DreamRecord, fragment: DreamFragment, index: number): number[] {
  if (fragment.logic === 'meeting') {
    return [index, index + 1].filter(id => id < dream.seeds.length);
  }
  if (fragment.logic === 'architecture') {
    return [index, index + 1, index + 2].filter(id => id < dream.seeds.length);
  }
  return [Math.min(index, Math.max(dream.seeds.length - 1, 0))].filter(id => id >= 0 && dream.seeds[id]);
}

function inferFragmentSeeds(dream: DreamRecord, fragment: DreamFragment, index: number): DreamSeed[] {
  const ids = fragment.seedIds.length > 0 ? fragment.seedIds : inferSeedIds(dream, fragment, index);
  const resolved = ids
    .map(id => dream.seeds[id])
    .filter((seed): seed is DreamSeed => Boolean(seed));

  return resolved.length > 0 ? resolved : (dream.seeds[0] ? [dream.seeds[0]] : []);
}

function formatDreamStamp(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
}

function isRemoteAsset(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

function toGalleryHref(path: string, dreamsDir: string): string {
  if (isRemoteAsset(path)) return path;
  return relative(dreamsDir, path).split('\\').join('/');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Describe a dream (for Claude) ───────────────────────────────────────────

/**
 * Generate a brief description of a dream for use in session context injection.
 * Used by the session:start hook to let Claude know a dream occurred.
 */
export function describeDream(dream: DreamRecord): string {
  const date = new Date(dream.dreamedAt);
  const ago  = Math.round((Date.now() - date.getTime()) / (1000 * 60 * 60));
  const timeStr = ago < 24 ? `${ago}h ago` : `${Math.round(ago / 24)}d ago`;

  return [
    `[phosphene-dream: ${dream.stage} // ${timeStr} // preset: ${dream.presetAtSleep} // intensity: ${Math.round(dream.intensity * 100)}%]`,
    `Seeds: ${dream.seeds.slice(0, 3).map(s => s.content.slice(0, 40)).join(' | ')}`,
    dream.hasImages ? `Images: ${Object.keys(dream.imagePaths).length} generated` : 'Images: pending',
  ].join('\n');
}
