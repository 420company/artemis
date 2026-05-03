import {
  formatPct,
  formatPrice,
} from './market-data.js';
import {
  detectFinancialPatterns,
  extractCoreQuestion,
} from './financial-lexicon.js';
import { buildFinanceFreshnessBrief } from './finance-freshness.js';
import type { FinancialLexiconMatch } from './financial-lexicon.js';
import type { MarketSnapshot } from './market-data.js';
import type { TechnicalAnalysisResult } from './technical-analysis.js';

export interface MarketReading {
  discipline: 'market';
  locale: 'en' | 'zh';
  thesis: string;
  signalStack: string[];
  narrativeVsFlow: string;
  structure: string;
  researchMap: string[];
  validationLenses: string[];
  riskStack: string[];
  invalidation: string;
  triggerMap: string[];
  confidenceNote: string;
  executionBoundary: string;
  referenceTimeIso: string;
  timeBasis: string;
  latestDataRule: string;
  staleDataRule: string;
  dataStatus: string;
  sourceChecklist: string[];
  nextQuestions: string[];
  disclaimer: string;
}

function detectLocale(text: string): 'en' | 'zh' {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en';
}

function summarizeSentiment(match: FinancialLexiconMatch, locale: 'en' | 'zh'): string {
  if (!match.sentimentGrade) {
    return locale === 'zh'
      ? '情绪面没有明确单边，但这本身说明市场还在寻找定价框架。'
      : 'Sentiment is not decisively one-sided yet, which means the market is still searching for its pricing frame.';
  }

  return locale === 'zh'
    ? `情绪分级落在 ${match.sentimentGrade}，说明语言层已经带有方向性。`
    : `The sentiment grade lands at ${match.sentimentGrade}, so the language layer is already directional.`;
}

function narrativeVsFlowFromMatch(match: FinancialLexiconMatch, locale: 'en' | 'zh'): string {
  const labels = match.signals.map(signal => signal.label.toLowerCase());
  const beat = labels.some(label => label.includes('beat'));
  const miss = labels.some(label => label.includes('miss'));
  const raise = labels.some(label => label.includes('raise'));
  const cut = labels.some(label => label.includes('cut'));

  if (locale === 'zh') {
    if (beat && cut) return '标题层偏多，但前瞻层偏空。最危险的情形不是坏消息，而是“好 headline + 坏 guide”。';
    if (miss && raise) return '静态结果偏弱，但未来指引在修复。市场通常会比新闻标题更在乎这个转向。';
    if (match.narratives.length > 0) {
      return `叙事主轴是 ${match.narratives[0]!.label}，但真正要盯的是它何时失去 hidden structure 的支撑。`;
    }
    return '语言叙事和真实资金流未必同步，先分清谁在讲故事，谁在真正定价。';
  }

  if (beat && cut) return 'Headline positive, forward guide negative. The danger is not bad news but good headlines masking weaker forward structure.';
  if (miss && raise) return 'The static result is weaker, but the forward guide is repairing. Markets often care more about that turn than the headline does.';
  if (match.narratives.length > 0) {
    return `The dominant narrative is ${match.narratives[0]!.label}, but the key question is when it loses support from the hidden structure underneath it.`;
  }
  return 'Narrative and flow are rarely identical. First separate who is telling the story from who is actually pricing the asset.';
}

function buildTextThesis(match: FinancialLexiconMatch, locale: 'en' | 'zh'): string {
  const core = extractCoreQuestion(match);

  if (locale === 'zh') {
    if (match.signals.length > 0) {
      return `现在最值得盯的，不是表面新闻，而是这个核心问题: ${core}`;
    }
    if (match.narratives.length > 0) {
      return `这段市场语言已经落入 ${match.narratives[0]!.label} 叙事，真正的 edge 在于识别它什么时候开始失真。`;
    }
    return '当前没有单一强信号，说明你面对的不是结论题，而是一个需要等市场自己暴露偏好的局面。';
  }

  if (match.signals.length > 0) {
    return `The real thing to watch is not the headline but the underlying question it opens: ${core}`;
  }
  if (match.narratives.length > 0) {
    return `This language is already inside the ${match.narratives[0]!.label} narrative. The edge is in spotting when the story starts to misprice reality.`;
  }
  return 'There is no single dominant signal yet, which means this is not a conclusion problem but a waiting-for-revelation problem.';
}

function buildTextStructure(match: FinancialLexiconMatch, locale: 'en' | 'zh'): string {
  const phase = match.dominantPhase ?? (locale === 'zh' ? '未明阶段' : 'unclear phase');
  const dissemination = Math.round(match.disseminationScore * 100);

  return locale === 'zh'
    ? `市场阶段更像 ${phase}。传播度约 ${dissemination}%: 如果扩散过快，后手空间会被压缩；如果扩散不足，价格还没完成信息搬运。`
    : `The structural phase looks closer to ${phase}. Dissemination is about ${dissemination}%: if spread is already broad, upside from the same story compresses; if spread is thin, price may still be carrying the information.`;
}

function buildTextRiskStack(match: FinancialLexiconMatch, locale: 'en' | 'zh'): string[] {
  const risks: string[] = [];

  if (match.signals.some(signal => signal.signalQuality === 'low')) {
    risks.push(locale === 'zh'
      ? '信号质量偏低，说明噪音和叙事污染较重。'
      : 'At least one matched signal is low quality, so noise contamination is high.');
  }
  if (match.disseminationScore > 0.7) {
    risks.push(locale === 'zh'
      ? '传播已经很广，后知后觉资金可能正在成为流动性的提供方。'
      : 'Dissemination is already broad, which means late money may be turning into liquidity for earlier positioning.');
  }
  if (match.narratives.some(narrative => narrative.type === 'contagion' || narrative.type === 'regulatory')) {
    risks.push(locale === 'zh'
      ? '这里的尾部风险不能只看均值，监管与传染型叙事经常用跳空说话。'
      : 'Tail risk matters here. Regulatory and contagion narratives often speak through gaps rather than gradual repricing.');
  }
  if (risks.length === 0) {
    risks.push(locale === 'zh'
      ? '最大的风险是把叙事当成价格，把语言强度误认为资金强度。'
      : 'The main risk is mistaking narrative intensity for actual flow intensity.');
  }

  return risks;
}

function buildTextInvalidation(match: FinancialLexiconMatch, locale: 'en' | 'zh'): string {
  if (locale === 'zh') {
    if (match.signals.length > 0) {
      return `如果后续价格行为不再回应「${match.signals[0]!.label}」所暗示的方向，这个 thesis 就需要立刻降级。`;
    }
    return '如果后续没有价格确认，就不要把这段分析升级成仓位信念。';
  }

  if (match.signals.length > 0) {
    return `If price stops honoring the direction implied by ${match.signals[0]!.label}, downgrade the thesis immediately.`;
  }
  return 'Without price confirmation, this should remain an analytical frame, not a position belief.';
}

function buildTextQuestions(match: FinancialLexiconMatch, locale: 'en' | 'zh'): string[] {
  const questions = [extractCoreQuestion(match)];

  if (match.narratives.length > 0) {
    questions.push(locale === 'zh'
      ? `什么事件会终结 ${match.narratives[0]!.label} 这条叙事？`
      : `What event would actually terminate the ${match.narratives[0]!.label} narrative?`);
  }
  questions.push(locale === 'zh'
    ? '价格是否已经提前走完了这段语言想表达的东西？'
    : 'Has price already moved further than the language implies?');

  return questions.slice(0, 3);
}

function buildResearchMap(
  match: FinancialLexiconMatch,
  locale: 'en' | 'zh',
  cryptoContext: boolean,
): string[] {
  const tasks = [
    locale === 'zh'
      ? `先把核心问题拆出来：${extractCoreQuestion(match)}`
      : `Start by isolating the core question: ${extractCoreQuestion(match)}`,
    match.signals.length > 0
      ? locale === 'zh'
        ? `逐条验证信号是否真的被价格接住，而不是只停留在新闻标题里。`
        : 'Check whether the matched signals are actually being absorbed by price rather than remaining headline artifacts.'
      : locale === 'zh'
        ? '先确认市场到底在给哪个变量定价，再决定是否值得下注。'
        : 'Confirm which variable the market is actually repricing before deciding whether the setup deserves risk.',
    match.narratives.length > 0
      ? locale === 'zh'
        ? `单独跟踪 ${match.narratives[0]!.label} 这条叙事的延续条件和终结条件。`
        : `Track the continuation and termination conditions of the ${match.narratives[0]!.label} narrative separately.`
      : locale === 'zh'
        ? '找出谁在讲故事，谁在真正搬运价格。'
        : 'Separate the storyteller from the actor actually moving price.',
  ];

  if (cryptoContext) {
    tasks.push(locale === 'zh'
      ? '把链上/杠杆/流动性三个面分开检查，不要用单一价格走势替代它们。'
      : 'Check on-chain, leverage, and liquidity separately rather than letting one price move stand in for all three.');
  } else {
    tasks.push(locale === 'zh'
      ? '把 headline、forward guide、行业对照三层分开看，再决定 thesis 强弱。'
      : 'Separate the headline, forward guide, and peer context before sizing the strength of the thesis.');
  }

  return tasks.slice(0, 4);
}

function buildValidationLenses(
  match: FinancialLexiconMatch,
  locale: 'en' | 'zh',
  cryptoContext: boolean,
): string[] {
  const lenses = [
    locale === 'zh'
      ? '价格接受度：价格是否真的在新叙事对应的区间完成接受。'
      : 'Price acceptance: does price actually accept in the zone implied by the new narrative?',
    locale === 'zh'
      ? '资金流响应：成交、盘口或后续跟随是否支持这段语言。'
      : 'Flow response: do follow-through, order book, or volume support the language?',
    locale === 'zh'
      ? '传播度校验：如果全市场都已经知道，这条 edge 可能只剩下退出管理。'
      : 'Dissemination check: if everyone already knows, the edge may have collapsed into exit management.',
  ];

  lenses.push(cryptoContext
    ? locale === 'zh'
      ? '杠杆/清算校验：行情是否被杠杆踩踏放大，而不是真实现货需求驱动。'
      : 'Leverage/liquidation check: is the move being amplified by leverage rather than real spot demand?'
    : locale === 'zh'
      ? '基本面校验：未来指引、利润质量、行业位置是否真的支撑 headline。'
      : 'Fundamental check: do guidance, quality of earnings, and peer positioning actually support the headline?');

  return lenses;
}

function buildConfidenceNote(match: FinancialLexiconMatch, locale: 'en' | 'zh'): string {
  const lowQuality = match.signals.some(signal => signal.signalQuality === 'low');
  const mediumSignals = match.signals.some(signal => signal.signalQuality === 'medium');
  const broadDissemination = match.disseminationScore > 0.7;

  if (match.signals.length >= 2 && !lowQuality && !broadDissemination) {
    return locale === 'zh'
      ? '置信度偏高：信号不止一个，质量尚可，而且叙事还没有完全烂大街。'
      : 'Confidence is relatively high: there is more than one usable signal, quality is acceptable, and the narrative is not fully crowded yet.';
  }

  if (match.signals.length > 0 || mediumSignals || match.narratives.length > 0) {
    return locale === 'zh'
      ? '置信度中等：已经有可读结构，但还需要价格和流动性继续确认。'
      : 'Confidence is medium: there is a readable structure, but price and liquidity still need to keep confirming it.';
  }

  return locale === 'zh'
    ? '置信度偏低：现在更像建立观察框架，而不是形成可执行结论。'
    : 'Confidence is low: this is better treated as an observation frame than an executable conclusion.';
}

function buildTriggerMap(
  match: FinancialLexiconMatch,
  locale: 'en' | 'zh',
  cryptoContext: boolean,
): string[] {
  const triggers = [
    match.signals.length > 0
      ? locale === 'zh'
        ? `如果价格开始反向回应 ${match.signals[0]!.label}，立刻重估 thesis。`
        : `If price begins to react opposite to ${match.signals[0]!.label}, reassess the thesis immediately.`
      : locale === 'zh'
        ? '如果后续价格依然没有方向性响应，就维持观察，不升级成观点。'
        : 'If price still refuses to respond directionally, keep it in observation mode rather than upgrading it into a view.',
    match.narratives.length > 0
      ? locale === 'zh'
        ? `${match.narratives[0]!.label} 叙事一旦被新的事件改写，就是第一触发器。`
        : `A new event rewriting the ${match.narratives[0]!.label} narrative is a primary trigger.`
      : locale === 'zh'
        ? '传播速度突然上升或突然熄火，都会改变赔率结构。'
        : 'A sudden acceleration or collapse in dissemination changes the odds structure.',
  ];

  triggers.push(cryptoContext
    ? locale === 'zh'
      ? '关注杠杆清算、资金费率和链上大额转移是否同时偏向同一边。'
      : 'Watch whether liquidations, funding, and large on-chain transfers start leaning the same way.'
    : locale === 'zh'
      ? '关注新的指引、管理层措辞变化或同业对照是否打破当前定价。'
      : 'Watch for new guidance, management language shifts, or peer repricing that breaks the current valuation frame.');

  return triggers;
}

function buildExecutionBoundary(locale: 'en' | 'zh'): string {
  return locale === 'zh'
    ? '先把这份输出当研究骨架，不当执行指令。只有当价格、流动性与失效条件三者都被再次确认后，才允许进入仓位或执行讨论。'
    : 'Treat this as a research frame first, not an execution order. Only move into positioning or execution after price, liquidity, and invalidation have all been re-confirmed.';
}

export function readMarketText(text: string): MarketReading {
  const locale = detectLocale(text);
  const match = detectFinancialPatterns(text);
  const cryptoContext = /\b(btc|eth|sol|crypto|liquidity|breakout|support|resistance|lower highs|higher lows)\b/i.test(text);
  const freshness = buildFinanceFreshnessBrief(locale, {
    liveDataAttached: false,
  });
  const signalStack = [
    summarizeSentiment(match, locale),
    ...(match.signals.slice(0, 3).map(signal => `${signal.label}: ${signal.coreQuestion}`)),
  ];

  if (cryptoContext) {
    signalStack.push(locale === 'zh'
      ? '加密结构语境明确，优先把流动性、接受区与杠杆踩踏风险分开看。'
      : 'Crypto-structure context is explicit, so separate liquidity, acceptance, and leverage-risk questions.');
  }

  return {
    discipline: 'market',
    locale,
    thesis: buildTextThesis(match, locale),
    signalStack,
    narrativeVsFlow: narrativeVsFlowFromMatch(match, locale),
    structure: buildTextStructure(match, locale),
    researchMap: buildResearchMap(match, locale, cryptoContext),
    validationLenses: buildValidationLenses(match, locale, cryptoContext),
    riskStack: buildTextRiskStack(match, locale),
    invalidation: buildTextInvalidation(match, locale),
    triggerMap: buildTriggerMap(match, locale, cryptoContext),
    confidenceNote: buildConfidenceNote(match, locale),
    executionBoundary: buildExecutionBoundary(locale),
    referenceTimeIso: freshness.referenceTimeIso,
    timeBasis: freshness.timeBasis,
    latestDataRule: freshness.latestDataRule,
    staleDataRule: freshness.staleDataRule,
    dataStatus: freshness.dataStatus,
    sourceChecklist: freshness.sourceChecklist,
    nextQuestions: buildTextQuestions(match, locale),
    disclaimer: locale === 'zh'
      ? '这是结构性阅读，不是投资建议。真正确认 thesis 的永远是价格与流动性。'
      : 'This is structural reading, not investment advice. Price and liquidity always get the final vote.',
  };
}

function flowRead(
  snapshot: MarketSnapshot,
  analysis: TechnicalAnalysisResult,
  locale: 'en' | 'zh',
): string {
  const bidTotal = snapshot.orderBook.bids.reduce((sum, level) => sum + level.price * level.qty, 0);
  const askTotal = snapshot.orderBook.asks.reduce((sum, level) => sum + level.price * level.qty, 0);
  const imbalance = bidTotal / Math.max(bidTotal + askTotal, 1);
  const upDay = snapshot.ticker.priceChangePct >= 0;

  if (locale === 'zh') {
    if (upDay && imbalance < 0.45) return '日内价格偏强，但盘口上方供给更厚，说明上涨还在被动承压。';
    if (!upDay && imbalance > 0.55) return '价格偏弱，但买盘开始在近处接货，说明下跌里已经出现响应式承接。';
    if (imbalance > 0.6) return '价格和盘口同向偏多，短线主动权更多在买方。';
    if (imbalance < 0.4) return '价格和盘口同向偏空，短线主动权更多在卖方。';
    return `价格方向与盘口基本一致，当前更像结构整理而不是情绪失控。${analysis.chanLun.currentStructure.split('\n')[0] ?? ''}`;
  }

  if (upDay && imbalance < 0.45) return 'Price is green on the day, but offer-side supply is still heavier overhead. Strength is being absorbed.';
  if (!upDay && imbalance > 0.55) return 'Price is weak, yet nearby bids are responding. Buyers are beginning to absorb the drop.';
  if (imbalance > 0.6) return 'Price and order-book pressure are aligned to the upside. Buyers have more local control.';
  if (imbalance < 0.4) return 'Price and order-book pressure are aligned to the downside. Sellers have more local control.';
  return `Price and local flow are broadly aligned. This looks more like structural consolidation than emotional disorder. ${analysis.chanLun.currentStructure.split('\n')[0] ?? ''}`;
}

export function composeMarketReading(
  snapshot: MarketSnapshot,
  analysis: TechnicalAnalysisResult,
): MarketReading {
  const locale: 'zh' = 'zh';
  const freshness = buildFinanceFreshnessBrief(locale, {
    referenceTime: snapshot.fetchedAt,
    liveDataAttached: true,
    dataSource: 'Binance spot market endpoints',
  });
  const fib = analysis.fibonacci;
  const chan = analysis.chanLun;
  const confirmedBeiChi = chan.beiChiList.filter(item => item.confirmed);
  const latestBsp = chan.buySellPoints.slice(-1)[0] ?? null;

  const signalStack = [
    `24h 变化: ${formatPct(snapshot.ticker.priceChangePct)} @ ${formatPrice(snapshot.ticker.lastPrice)}`,
    fib
      ? `Fibonacci: ${fib.currentZone}`
      : 'Fibonacci: 数据不足，暂不形成回撤结构。',
    `缠论: ${chan.currentStructure.split('\n')[0] ?? chan.currentStructure}`,
  ];

  if (latestBsp) {
    signalStack.push(`最近买卖点: ${latestBsp.type} @ ${formatPrice(latestBsp.price)}`);
  }
  if (confirmedBeiChi.length > 0) {
    signalStack.push(`确认背驰: ${confirmedBeiChi.map(item => item.type).join(' / ')}`);
  }

  const thesis = fib
    ? fib.direction === 'uptrend'
      ? `当前更像上升结构中的位置选择题，而不是纯粹方向题。关键在于价格是否继续接受于 ${fib.nearestSupport?.label ?? '最近支撑'} 之上。`
      : `当前更像下降结构中的反弹质量测试。关键不在反弹有没有，而在反弹能否站上 ${fib.nearestResist?.label ?? '最近压力'}。`
    : '当前结构还不足以给出高级别斐波那契路径，先把它当成局部博弈而不是中期趋势。';

  const riskStack = [
    fib?.nearestSupport
      ? `下方最近支撑在 ${fib.nearestSupport.label} @ ${formatPrice(fib.nearestSupport.price)}`
      : '缺少清晰支撑定位，说明波段结构还不够干净。',
    fib?.nearestResist
      ? `上方最近压力在 ${fib.nearestResist.label} @ ${formatPrice(fib.nearestResist.price)}`
      : '价格已处于延伸区，上方参照减少但回撤风险增大。',
    confirmedBeiChi.length > 0
      ? `存在确认背驰 (${confirmedBeiChi.map(item => item.type).join(' / ')})，趋势延续性要打折。`
      : '暂无确认背驰，说明趋势衰减证据还不充分。',
  ];

  const researchMap = [
    fib
      ? `先观察 ${fib.nearestSupport?.label ?? '最近支撑'} 到 ${fib.nearestResist?.label ?? '最近压力'} 之间，市场到底是在接受还是只是穿越。`
      : '先确认当前区间是否真的存在接受，而不是机械横盘。',
    latestBsp
      ? `把最近的 ${latestBsp.type} 当成结构假设，继续验证它是延续还是诱骗。`
      : '等待下一次分型和笔，确认市场是否愿意给出新的结构信号。',
    '把盘口失衡和后续成交分开看，避免把局部深度误当成持续性资金流。',
    '把斐波那契位置和缠论结构交叉验证，不要只依赖单一框架。',
  ];

  const validationLenses = [
    fib
      ? `位置校验：价格是否继续接受于 ${fib.nearestSupport?.label ?? '最近支撑'} 之上或 ${fib.nearestResist?.label ?? '最近压力'} 之下。`
      : '位置校验：价格是否能第一次建立清晰接受区。',
    '结构校验：缠论当前笔、中枢与背驰是否继续同向。',
    '流动性校验：盘口失衡是否能延续到后续成交与波动扩张。',
    confirmedBeiChi.length > 0
      ? `衰减校验：已出现 ${confirmedBeiChi.map(item => item.type).join(' / ')}，趋势是否开始被削弱。`
      : '衰减校验：目前没有确认背驰，继续观察趋势是否首次出现衰减证据。',
  ];

  const triggerMap = [
    fib
      ? fib.direction === 'uptrend'
        ? `如果价格有效跌破 ${fib.nearestSupport?.label ?? '最近支撑'}，这是第一触发器。`
        : `如果价格有效站回 ${fib.nearestResist?.label ?? '最近压力'} 之上，这是第一触发器。`
      : '如果价格继续无结构穿越当前区间，先降级 thesis。',
    latestBsp
      ? `最近的 ${latestBsp.type} 若被延续，说明结构还活着；若被反向吞没，说明 thesis 需要重算。`
      : '新的买卖点一旦出现，就是结构更新的主触发器。',
    confirmedBeiChi.length > 0
      ? '确认背驰若继续增多，优先考虑趋势衰减而不是趋势延续。'
      : '若首次出现确认背驰，需要立刻检查趋势延续性是否已经打折。',
  ];

  const confidenceNote = fib && latestBsp
    ? '置信度中高：价格位置、结构信号和局部流动性可以互相验证，但仍需要后续接受确认。'
    : fib
      ? '置信度中等：位置已经可读，但结构和触发器还需要进一步补全。'
      : '置信度偏低：当前更像建立观察框架，而不是形成可执行判断。';

  return {
    discipline: 'market',
    locale,
    thesis,
    signalStack,
    narrativeVsFlow: flowRead(snapshot, analysis, locale),
    structure: chan.currentStructure,
    researchMap,
    validationLenses,
    riskStack,
    invalidation: fib
      ? fib.direction === 'uptrend'
        ? `若价格有效跌破 ${fib.nearestSupport?.label ?? '最近支撑'}，当前偏多结构需要撤销。`
        : `若价格有效站回 ${fib.nearestResist?.label ?? '最近压力'} 之上，当前偏空结构需要撤销。`
      : '若后续走势继续无结构地来回穿越最近区间，本轮 thesis 需要降级为观望。',
    triggerMap,
    confidenceNote,
    executionBoundary: buildExecutionBoundary(locale),
    referenceTimeIso: freshness.referenceTimeIso,
    timeBasis: freshness.timeBasis,
    latestDataRule: freshness.latestDataRule,
    staleDataRule: freshness.staleDataRule,
    dataStatus: freshness.dataStatus,
    sourceChecklist: freshness.sourceChecklist,
    nextQuestions: [
      fib?.nearestResist
        ? `价格能否在 ${fib.nearestResist.label} 附近完成接受，而不是只打一根影线？`
        : '下一段价格推进会不会第一次给出明确的接受区？',
      latestBsp
        ? `最近的 ${latestBsp.type} 会被延续还是被反向吞没？`
        : '下一次分型与笔是否会给出新的买卖点？',
      '盘口失衡是持续性的，还是仅仅停留在局部深度里？',
    ],
    disclaimer: '以上为市场结构阅读，不构成任何投资建议。仓位决策必须独立管理风险。',
  };
}

export function renderMarketReading(reading: MarketReading): string {
  const header = reading.locale === 'zh' ? '【Phosphene Market Read】' : '[Phosphene Market Read]';
  const lines = [
    header,
    `${reading.locale === 'zh' ? '主判断' : 'Thesis'}: ${reading.thesis}`,
    `${reading.locale === 'zh' ? '信号栈' : 'Signal stack'}: ${reading.signalStack.join(' / ')}`,
    `${reading.locale === 'zh' ? '叙事与资金流' : 'Narrative vs flow'}: ${reading.narrativeVsFlow}`,
    `${reading.locale === 'zh' ? '结构' : 'Structure'}: ${reading.structure.replace(/\n/g, ' ')}`,
    `${reading.locale === 'zh' ? '研究拆解' : 'Research map'}: ${reading.researchMap.join(' / ')}`,
    `${reading.locale === 'zh' ? '验证晶格' : 'Validation lattice'}: ${reading.validationLenses.join(' / ')}`,
    `${reading.locale === 'zh' ? '风险栈' : 'Risk stack'}: ${reading.riskStack.join(' / ')}`,
    `${reading.locale === 'zh' ? '失效条件' : 'Invalidation'}: ${reading.invalidation}`,
    `${reading.locale === 'zh' ? '触发器' : 'Trigger map'}: ${reading.triggerMap.join(' / ')}`,
    `${reading.locale === 'zh' ? '置信度' : 'Confidence'}: ${reading.confidenceNote}`,
    `${reading.locale === 'zh' ? '执行边界' : 'Execution boundary'}: ${reading.executionBoundary}`,
    `${reading.locale === 'zh' ? '参考时间' : 'Reference time'}: ${reading.referenceTimeIso}`,
    `${reading.locale === 'zh' ? '时间基准' : 'Time basis'}: ${reading.timeBasis}`,
    `${reading.locale === 'zh' ? '最新资料规则' : 'Latest data rule'}: ${reading.latestDataRule}`,
    `${reading.locale === 'zh' ? '陈旧资料处理' : 'Stale-data rule'}: ${reading.staleDataRule}`,
    `${reading.locale === 'zh' ? '数据状态' : 'Data status'}: ${reading.dataStatus}`,
    `${reading.locale === 'zh' ? '资料清单' : 'Source checklist'}: ${reading.sourceChecklist.join(' / ')}`,
    `${reading.locale === 'zh' ? '接下来该问' : 'Next questions'}: ${reading.nextQuestions.join(' / ')}`,
    `${reading.locale === 'zh' ? '说明' : 'Note'}: ${reading.disclaimer}`,
  ];

  return lines.join('\n');
}
