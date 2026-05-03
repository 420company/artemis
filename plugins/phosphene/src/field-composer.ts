import { detectHumanPatterns } from './contradiction-engine.js';
import { readDesignIntent } from './design-engine.js';
import { readLiterature } from './literary-engine.js';
import { readMarketText } from './market-engine.js';
import type {
  RitualFieldComposition,
  RitualLocale,
  RitualProposal,
} from './types.js';

type CommonField = 'design' | 'literature' | 'market';

function fieldForProposal(proposal?: RitualProposal | null): CommonField | null {
  if (proposal?.spotlightField) {
    return proposal.spotlightField;
  }

  const need = proposal?.route.need;
  if (need === 'design') return 'design';
  if (need === 'writing') return 'literature';
  if (need === 'finance') return 'market';
  return null;
}

function contradictionBeat(input: string, locale: RitualLocale) {
  const hit = detectHumanPatterns(input)[0];
  if (!hit) return undefined;

  return {
    beat: {
      label: locale === 'zh' ? '人类矛盾' : 'Human contradiction',
      content: locale === 'zh'
        ? `${hit.id}：${hit.note}`
        : `${hit.id}: ${hit.note}`,
    },
    paragraph: locale === 'zh'
      ? `这里还带着一层人类矛盾：${hit.id}。${hit.note}`
      : `There is also a human contradiction running through this: ${hit.id}. ${hit.note}`,
  };
}

function composeDesign(
  input: string,
  locale: RitualLocale,
  options: { includeContradiction?: boolean } = {},
): RitualFieldComposition {
  const reading = readDesignIntent(input);
  const beats = [
    { label: locale === 'zh' ? '色彩法则' : 'Palette law', content: reading.paletteStrategy },
    { label: locale === 'zh' ? '材质与构图' : 'Material and composition', content: `${reading.materialRegister} ${reading.compositionMoves.join(' ')}` },
    { label: locale === 'zh' ? '动效法则' : 'Motion law', content: reading.motionPrinciples.join(' ') },
    { label: locale === 'zh' ? '误传信息' : 'Accidental message', content: reading.accidentalMessage },
  ];
  const contradiction = options.includeContradiction === false ? undefined : contradictionBeat(input, locale);
  if (contradiction) beats.push(contradiction.beat);

  const title = locale === 'zh' ? '设计成品草案' : 'Design Composition Draft';
  const fullDraft = locale === 'zh'
    ? `${reading.thesis}\n\n色彩上，${reading.paletteStrategy}\n\n构图与材质上，${reading.materialRegister} ${reading.compositionMoves.join(' ')}\n\n动效上，${reading.motionPrinciples.join(' ')}\n\n它现在不小心说出来的是：${reading.accidentalMessage}${contradiction ? `\n\n${contradiction.paragraph}` : ''}\n\n下一步，${reading.nextMove}`
    : `${reading.thesis}\n\nIn palette terms, ${reading.paletteStrategy}\n\nIn material and composition terms, ${reading.materialRegister} ${reading.compositionMoves.join(' ')}\n\nIn motion terms, ${reading.motionPrinciples.join(' ')}\n\nRight now it accidentally says: ${reading.accidentalMessage}${contradiction ? `\n\n${contradiction.paragraph}` : ''}\n\nNext move: ${reading.nextMove}`;

  return {
    field: 'design',
    title,
    opening: reading.thesis,
    beats,
    closing: reading.nextMove,
    fullDraft,
  };
}

function composeLiterature(
  input: string,
  locale: RitualLocale,
  options: { includeContradiction?: boolean } = {},
): RitualFieldComposition {
  const reading = readLiterature(input);
  const beats = [
    { label: locale === 'zh' ? '质地' : 'Texture', content: reading.texture },
    { label: locale === 'zh' ? '结构' : 'Structure', content: reading.structure },
    { label: locale === 'zh' ? '受力线' : 'Line of force', content: reading.lineOfForce },
    { label: locale === 'zh' ? '误读风险' : 'Risk of misreading', content: reading.riskOfMisreading },
  ];
  const contradiction = options.includeContradiction === false ? undefined : contradictionBeat(input, locale);
  if (contradiction) beats.push(contradiction.beat);

  const title = locale === 'zh' ? '文学成品草案' : 'Literary Composition Draft';
  const fullDraft = locale === 'zh'
    ? `${reading.thesis}\n\n这段文字的质地在于：${reading.texture}\n\n结构上，${reading.structure}\n\n真正把它往前推的，是这样一条受力线：${reading.lineOfForce}\n\n最容易的误读是：${reading.riskOfMisreading}${contradiction ? `\n\n${contradiction.paragraph}` : ''}\n\n如果继续读或继续改，下一步最值得做的是：${reading.nextMove}`
    : `${reading.thesis}\n\nIts texture comes from this pressure: ${reading.texture}\n\nStructurally, ${reading.structure}\n\nThe real line of force is this: ${reading.lineOfForce}\n\nThe easiest misreading is: ${reading.riskOfMisreading}${contradiction ? `\n\n${contradiction.paragraph}` : ''}\n\nIf you keep reading or revising, the next move is: ${reading.nextMove}`;

  return {
    field: 'literature',
    title,
    opening: reading.thesis,
    beats,
    closing: reading.nextMove,
    fullDraft,
  };
}

function composeMarket(
  input: string,
  locale: RitualLocale,
  options: { includeContradiction?: boolean } = {},
): RitualFieldComposition {
  const reading = readMarketText(input);
  const beats = [
    { label: locale === 'zh' ? '叙事与资金流' : 'Narrative vs flow', content: reading.narrativeVsFlow },
    { label: locale === 'zh' ? '结构' : 'Structure', content: reading.structure },
    { label: locale === 'zh' ? '研究拆解' : 'Research map', content: reading.researchMap.join(' ') },
    { label: locale === 'zh' ? '验证晶格' : 'Validation lattice', content: reading.validationLenses.join(' ') },
    { label: locale === 'zh' ? '失效条件' : 'Invalidation', content: reading.invalidation },
    { label: locale === 'zh' ? '风险栈' : 'Risk stack', content: reading.riskStack.join(' ') },
    { label: locale === 'zh' ? '触发器' : 'Trigger map', content: reading.triggerMap.join(' ') },
    { label: locale === 'zh' ? '置信度' : 'Confidence', content: reading.confidenceNote },
    { label: locale === 'zh' ? '执行边界' : 'Execution boundary', content: reading.executionBoundary },
  ];
  const contradiction = options.includeContradiction === false ? undefined : contradictionBeat(input, locale);
  if (contradiction) beats.push(contradiction.beat);

  const title = locale === 'zh' ? '市场成品草案' : 'Market Composition Draft';
  const fullDraft = locale === 'zh'
    ? `${reading.thesis}\n\n先把叙事和真实资金流拆开看：${reading.narrativeVsFlow}\n\n结构上，${reading.structure}\n\n研究拆解应先这样走：${reading.researchMap.join(' ')}\n\n验证时要过这几层：${reading.validationLenses.join(' ')}\n\n这个判断失效的位置是：${reading.invalidation}\n\n真正要背着走的风险是：${reading.riskStack.join(' ')}\n\n关键触发器是：${reading.triggerMap.join(' ')}\n\n当前置信度判断：${reading.confidenceNote}\n\n执行边界是：${reading.executionBoundary}${contradiction ? `\n\n${contradiction.paragraph}` : ''}\n\n接下来最值得盯的是：${reading.nextQuestions.join(' ')}`
    : `${reading.thesis}\n\nFirst separate narrative from actual flow: ${reading.narrativeVsFlow}\n\nStructurally, ${reading.structure}\n\nThe research path should run like this: ${reading.researchMap.join(' ')}\n\nValidation has to pass through these lenses: ${reading.validationLenses.join(' ')}\n\nThis thesis fails here: ${reading.invalidation}\n\nThe real risk stack is: ${reading.riskStack.join(' ')}\n\nThe key triggers are: ${reading.triggerMap.join(' ')}\n\nThe current confidence call is: ${reading.confidenceNote}\n\nThe execution boundary is: ${reading.executionBoundary}${contradiction ? `\n\n${contradiction.paragraph}` : ''}\n\nThe next observations that matter are: ${reading.nextQuestions.join(' ')}`;

  return {
    field: 'market',
    title,
    opening: reading.thesis,
    beats,
    closing: reading.nextQuestions.join(' '),
    fullDraft,
  };
}

export function buildFieldComposition(
  input: string,
  proposal: RitualProposal | null | undefined,
  locale: RitualLocale,
  options: { forcedField?: CommonField; includeContradiction?: boolean } = {},
): RitualFieldComposition | undefined {
  const field = options.forcedField ?? fieldForProposal(proposal);
  if (!field) return undefined;

  if (field === 'design') return composeDesign(input, locale, options);
  if (field === 'literature') return composeLiterature(input, locale, options);
  return composeMarket(input, locale, options);
}
