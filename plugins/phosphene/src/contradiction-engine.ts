import {
  BEHAVIORAL_PATTERNS,
  EVOLUTIONARY_BIASES,
  HUMAN_CONTRADICTION_HARD_RULE,
} from './human-patterns.js';
import type {
  ContradictionRead,
  EvolutionAnalysis,
  EvolutionState,
  HumanPatternHit,
  RitualLocale,
} from './types.js';

type BaseEvolutionAnalysis = Omit<EvolutionAnalysis, 'contradictionPatterns' | 'suggestedBiases'>;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function scorePattern(input: string, patternId: string): HumanPatternHit | null {
  const pattern = BEHAVIORAL_PATTERNS.find(item => item.id === patternId);
  if (!pattern) return null;

  const evidence = [...pattern.triggers, ...pattern.signals].filter(token => input.includes(token.toLowerCase()));
  const triggerMatches = pattern.triggers.filter(token => input.includes(token.toLowerCase())).length;
  const signalMatches = pattern.signals.filter(token => input.includes(token.toLowerCase())).length;
  const score = triggerMatches * 0.55 + signalMatches * 0.35;

  if (score < 0.75 || evidence.length === 0) return null;

  return {
    id: pattern.id,
    label: pattern.label,
    confidence: Math.min(0.97, Number((0.45 + score / 4).toFixed(2))),
    note: pattern.description,
    evidence: evidence.slice(0, 4),
  };
}

export function detectHumanPatterns(input: string): HumanPatternHit[] {
  const normalized = normalize(input);
  return BEHAVIORAL_PATTERNS
    .map(pattern => scorePattern(normalized, pattern.id))
    .filter((hit): hit is HumanPatternHit => Boolean(hit))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

function mapBiases(patterns: HumanPatternHit[]) {
  const ids = new Set(patterns.map(pattern => pattern.id));
  return EVOLUTIONARY_BIASES.filter(bias => {
    if (ids.has('pain_transmutation') && bias.id === 'bias_pain_transmutation') return true;
    if (ids.has('ritual_dependency') && bias.id === 'bias_ritual_separation') return true;
    if (ids.has('success_masks_damage') && bias.id === 'bias_damage_visibility') return true;
    if (ids.has('mythic_self_narration') && bias.id === 'bias_demythologization') return true;
    if (ids.has('work_more_coherent_than_life') && bias.id === 'bias_life_work_delta') return true;
    if (ids.has('false_causality_after_breakthrough') && bias.id === 'bias_false_causality_guard') return true;
    return false;
  });
}

function aggregatePatternMentions(chunks: string[]): HumanPatternHit[] {
  const tally = new Map<string, { count: number; best: HumanPatternHit }>();

  for (const chunk of chunks) {
    for (const hit of detectHumanPatterns(chunk)) {
      const current = tally.get(hit.id);
      if (!current) {
        tally.set(hit.id, { count: 1, best: hit });
        continue;
      }
      tally.set(hit.id, {
        count: current.count + 1,
        best: current.best.confidence >= hit.confidence ? current.best : hit,
      });
    }
  }

  return [...tally.values()]
    .map(({ count, best }) => ({
      ...best,
      confidence: Math.min(0.99, Number((best.confidence + Math.min(0.18, count * 0.05)).toFixed(2))),
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
}

export function deriveBiasCandidates(evolution: EvolutionState) {
  const sessionChunks = evolution.sessionHistory
    .slice(0, 6)
    .flatMap(session => [
      ...session.crystallized,
      ...session.anchored,
      ...session.signals.map(signal => signal.note).filter((note): note is string => Boolean(note)),
    ]);
  const globalChunks = [
    ...evolution.crystallizedInsights,
    ...evolution.feedbackHistory.map(signal => signal.note).filter((note): note is string => Boolean(note)),
  ];

  const patterns = aggregatePatternMentions([...sessionChunks, ...globalChunks]);
  return mapBiases(patterns);
}

export function enrichEvolutionAnalysis(base: BaseEvolutionAnalysis, evolution: EvolutionState): EvolutionAnalysis {
  const chunks = [
    ...base.crystallizedInsights,
    ...base.recentAnchors,
    ...evolution.feedbackHistory.map(signal => signal.note).filter((note): note is string => Boolean(note)),
  ];
  const contradictionPatterns = aggregatePatternMentions(chunks);

  return {
    ...base,
    contradictionPatterns,
    suggestedBiases: mapBiases(contradictionPatterns),
  };
}

export function buildContradictionRead(
  input: string,
  locale: RitualLocale,
  analysis?: Pick<EvolutionAnalysis, 'suggestedBiases'>,
): ContradictionRead | undefined {
  const patterns = detectHumanPatterns(input);
  if (patterns.length === 0) return undefined;

  const primary = patterns[0]!;
  const biasCandidates = analysis?.suggestedBiases?.length
    ? analysis.suggestedBiases.slice(0, 3)
    : mapBiases(patterns).slice(0, 3);
  const patternMeta = BEHAVIORAL_PATTERNS.find(pattern => pattern.id === primary.id);

  if (locale === 'zh') {
    return {
      title: 'Human Contradiction Read',
      thesis: `我读到的核心不是单纯任务，而是「${primary.label}」正在影响这次表达和判断。`,
      patterns,
      warnings: patternMeta?.falseBeliefs.slice(0, 2) ?? [],
      biasCandidates,
      hardRule: HUMAN_CONTRADICTION_HARD_RULE,
    };
  }

  return {
    title: 'Human Contradiction Read',
    thesis: `The deeper movement here is not just the task itself. ${primary.label} is shaping how the work is being narrated and judged.`,
    patterns,
    warnings: patternMeta?.falseBeliefs.slice(0, 2) ?? [],
    biasCandidates,
    hardRule: HUMAN_CONTRADICTION_HARD_RULE,
  };
}
