// Matches a long-video request against the Lumina style library (styleDna.ts)
// and turns the match into an ADDITIVE block for the story text, the way
// buildSagaConstitution adds the narrative rules.
//
// The owner's rule, verbatim from the distillation README: "不是把 prompt 硬塞
// 進用戶提交的東西里 —— 而是分析用戶需求 → 推斷真實意圖 → 如果蒸餾知識相關，就
// 智能增強質量（加法，絕不替換；不匹配就靜默跳過）". So: no match, no block;
// a raw-passthrough or cleanDirect run gets no block either, because the user
// asked for their own words untouched.
//
// Matching is at sub-genre level on purpose: "rap MV" is not a style, hip-hop
// alone has twelve of them and their visual languages do not overlap.

import {
  CATEGORY_DEFAULTS,
  CONDITIONAL_PRINCIPLES,
  MUSIC_STRUCTURE,
  QUALITY_ANCHORS,
  STRUCTURE_TEMPLATES,
  STYLE_LIBRARY,
  principleById,
  type PrincipleId,
  type StructureTemplate,
  type StyleCategory,
  type StyleDna,
} from './styleDna.js';

export type StyleMatch = {
  style: StyleDna;
  category: StyleCategory;
  /** 0–1, from how much of the style's trigger dictionary the request hit. */
  confidence: number;
  /** The trigger words that fired, for the log and the plan. */
  hits: string[];
  /** Style DNA plus the category's own rules, deduplicated. */
  principles: PrincipleId[];
  /**
   * An umbrella style whose route is still open (P24: "动画 MV" is not a
   * style). The caller asks the user instead of guessing.
   */
  openRoutes?: string[];
};

/** A trigger made only of ASCII needs a word boundary; CJK matches as a substring. */
function triggerHit(text: string, trigger: string): boolean {
  if (trigger.length < 2) return false;
  if (/^[\x20-\x7e]+$/.test(trigger)) {
    if (trigger.length < 3) return false;
    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
  }
  return text.includes(trigger);
}

/** A longer or multi-word trigger is more telling than a single short word. */
function triggerWeight(trigger: string): number {
  return trigger.length >= 4 || /\s/.test(trigger) ? 2 : 1;
}

/** Below this the request is too vague to enhance: stay silent (and never guess). */
const MIN_SCORE = 3;

export type StyleMatchInput = {
  /** The user's story and brief, after the Saga workflow collected it. */
  story: string;
  /** The narrative analyser's mode, when it ran. */
  mode?: 'character' | 'product' | 'environment' | 'mixed' | 'unclear';
  /** Only these categories are considered when given. */
  categories?: readonly StyleCategory[];
};

/** The best style for this request, or undefined when nothing matches well enough. */
export function matchStyleDna(input: StyleMatchInput): StyleMatch | undefined {
  const text = input.story.toLowerCase();
  if (!text.trim()) return undefined;

  let best: StyleMatch | undefined;
  for (const style of STYLE_LIBRARY) {
    if (input.categories && !input.categories.includes(style.category)) continue;
    const hits = style.triggers.filter((trigger) => triggerHit(text, trigger.toLowerCase()));
    if (hits.length === 0) continue;
    const score = hits.reduce((total, trigger) => total + triggerWeight(trigger), 0);
    if (score < MIN_SCORE) continue;
    // A product request should not be dressed as a music video and the other
    // way round: the analyser's mode decides when both could match.
    if (input.mode === 'product' && style.category === 'music-mv') continue;
    if (input.mode === 'character' && style.category === 'product-ad' && !hits.some((hit) => triggerWeight(hit) === 2)) continue;

    const candidate: StyleMatch = {
      style,
      category: style.category,
      confidence: Math.min(1, score / (style.triggers.length * 0.6)),
      hits,
      principles: applicablePrinciples(style, text),
      ...(openRoutesFor(style, text) ? { openRoutes: openRoutesFor(style, text) } : {}),
    };
    if (!best || better(candidate, best)) best = candidate;
  }
  return best;
}

/** More trigger weight wins; a verified anchor breaks a tie. */
function better(candidate: StyleMatch, current: StyleMatch): boolean {
  const candidateScore = candidate.hits.reduce((total, hit) => total + triggerWeight(hit), 0);
  const currentScore = current.hits.reduce((total, hit) => total + triggerWeight(hit), 0);
  if (candidateScore !== currentScore) return candidateScore > currentScore;
  const rank = (style: StyleDna) => (style.quality === 'anchor-positive' ? 2 : style.quality === 'verified' ? 1 : 0);
  if (rank(candidate.style) !== rank(current.style)) return rank(candidate.style) > rank(current.style);
  return candidate.style.evidence.length > current.style.evidence.length;
}

/**
 * Style DNA rules first, then the category's own, then any technique whose own
 * cue appears in the request (Principle.triggers): a conditional principle is
 * a move to reach for when it is asked for, not a standing rule, so without
 * its cue it stays out of the block.
 */
export function applicablePrinciples(style: StyleDna, story = ''): PrincipleId[] {
  const text = story.toLowerCase();
  const ids = new Set<PrincipleId>([...style.principles, ...CATEGORY_DEFAULTS[style.category]]);
  for (const principle of CONDITIONAL_PRINCIPLES) {
    if (ids.has(principle.id)) continue;
    const inScope = principle.scope === 'all' || principle.scope.includes(style.category);
    if (!inScope) continue;
    if ((principle.triggers ?? []).some((trigger) => triggerHit(text, trigger.toLowerCase()))) ids.add(principle.id);
  }
  return [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** The routes of an umbrella style that the request has not settled yet. */
function openRoutesFor(style: StyleDna, text: string): string[] | undefined {
  if (!style.routes || style.routes.length === 0) return undefined;
  // A route is settled when its own words appear (黏土, 乐高, 赛璐璐 …).
  const settled = style.routes.some((route) => {
    const words = route.match(/[一-鿿]{2,}/g) ?? [];
    return words.some((word) => word.length >= 2 && text.includes(word.toLowerCase()));
  });
  return settled ? undefined : [...style.routes];
}

/** Which anchors apply: the worked examples came from music videos. */
function anchorsApply(category: StyleCategory): boolean {
  return category === 'hiphop-mv' || category === 'music-mv';
}

/**
 * The block that goes into the story text, which is what shot planning and the
 * shot rewriter read. The locks that have to reach the video model itself
 * (palette, camera, forbidden elements) travel through the continuity bible
 * instead — see the buildContinuityBible call in generateLongVideo.ts. Short
 * on purpose: it carries rules, not prose.
 */
export function buildStyleEnhancement(match: StyleMatch, options: { structureTemplate?: StructureTemplate } = {}): string {
  const { style } = match;
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════',
    '[Style Enhancement — additive; the user brief always wins]',
    '═══════════════════════════════════════════════════════════════',
    `Matched style: ${style.label} (${style.id}, confidence ${match.confidence.toFixed(2)}${style.evidence.length > 0 ? `, evidence ${style.evidence.join(' ')}` : ''})`,
    `必备元素 / Must have: ${style.motifs.join('；')}`,
    `色调 / Palette: ${style.palette}`,
    `运镜 / Camera: ${style.camera.join('；')}`,
    `节奏 / Pacing: ${style.pacing}`,
    `禁止 / Forbidden: ${style.antiPatterns.join('；')}`,
  ];

  if (match.principles.length > 0) {
    lines.push('规则 / Rules (these outrank the style DNA):');
    for (const id of match.principles) {
      const principle = principleById(id);
      lines.push(`  ${id}. ${principle.rule} → ${principle.action}`);
    }
  }

  const structure = options.structureTemplate;
  if (structure) {
    lines.push(`结构 / Structure (${structure.label}; the user brought none, so use this skeleton):`);
    for (const beat of structure.beats) {
      lines.push(`  ${beat.span} ${beat.beat} ｜ ${beat.camera}`);
    }
  }
  const music = musicStructureFor(match);
  if (music) lines.push(`音乐结构 / Cut points: ${music}`);

  if (anchorsApply(match.category)) {
    lines.push(
      `自检 / Self-check, learn from ${QUALITY_ANCHORS.positive.id}: ${QUALITY_ANCHORS.positive.checks.join(' ')}`,
      `自检 / Self-check, avoid ${QUALITY_ANCHORS.negative.id}: ${QUALITY_ANCHORS.negative.checks.join(' ')}`,
    );
  }

  lines.push('═══════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

/**
 * The beat skeleton for a request that brought none of its own: the style's
 * preferred template, else the category's. A user who wrote a script, shots
 * or timecodes keeps them — the caller passes hasOwnStructure for that, and
 * nothing is suggested (P27).
 */
export function pickStructureTemplate(match: StyleMatch, hasOwnStructure: boolean): StructureTemplate | undefined {
  if (hasOwnStructure) return undefined;
  const preferred = STRUCTURE_TEMPLATES.find((template) => template.preferredStyles?.includes(match.style.id));
  if (preferred) return preferred;
  return STRUCTURE_TEMPLATES.find((template) => template.scope === 'all' || template.scope.includes(match.category));
}

/** How this style's music sections map to cut points, when it is a music style. */
export function musicStructureFor(match: StyleMatch): string | undefined {
  return MUSIC_STRUCTURE[match.style.id];
}

/**
 * The short form for a single clip: one shot, a tight prompt budget, so only
 * the three locks that change the picture travel. Returns '' when nothing
 * useful fits in the budget.
 */
export function buildCompactStyleEnhancement(match: StyleMatch, maxChars = 420): string {
  const parts = [
    `风格 Style: ${match.style.label}`,
    `色调 Palette: ${match.style.palette}`,
    `运镜 Camera: ${match.style.camera.slice(0, 2).join('；')}`,
    `禁止 Avoid: ${match.style.antiPatterns.slice(0, 3).join('；')}`,
  ];
  let text = parts.join('\n');
  while (text.length > maxChars && parts.length > 2) {
    parts.pop();
    text = parts.join('\n');
  }
  return text.length > maxChars ? '' : text;
}

/** One line for the tool log, so the owner sees what was applied and why. */
export function describeStyleMatch(match: StyleMatch): string {
  const routes = match.openRoutes ? `；路数未定（${match.openRoutes.length} 条可选）` : '';
  return `🎨 风格增强：${match.style.label}（命中 ${match.hits.slice(0, 4).join('、')}${match.hits.length > 4 ? '…' : ''}，置信度 ${match.confidence.toFixed(2)}，规则 ${match.principles.join('/')}）${routes}`;
}

/**
 * The question to ask when an umbrella style's route is still open, instead of
 * picking one (P24). Empty when there is nothing to ask.
 */
export function routeQuestion(match: StyleMatch): string {
  if (!match.openRoutes || match.openRoutes.length === 0) return '';
  return [
    `${match.style.label} 不是一种风格，需要先定路数：`,
    ...match.openRoutes.map((route, index) => `  ${index + 1}. ${route}`),
    '回复编号或描述即可。',
  ].join('\n');
}
