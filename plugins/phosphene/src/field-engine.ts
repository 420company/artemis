import {
  detectDesignVocabulary,
} from './design-color-lexicon.js';
import {
  hasFinancialContent,
} from './financial-lexicon.js';
import {
  readDesignIntent,
  renderDesignReading,
} from './design-engine.js';
import {
  readLiterature,
  renderLiteraryReading,
} from './literary-engine.js';
import {
  readMarketText,
  renderMarketReading,
} from './market-engine.js';

export type CommonField = 'design' | 'literature' | 'market';

export interface FieldSpotlight {
  field: CommonField;
  confidence: number;
  rendered: string;
}

function designScore(input: string): number {
  const vocab = detectDesignVocabulary(input);
  let score = vocab.systems.length > 0 ? 0.7 : 0;
  const generalDesign = /(design|layout|motion|hierarchy|typography|color|palette|ui|ux|branding|landing page|视觉|排版|动效|层级|字体|色彩|配色|界面|品牌)/i.test(input);
  if (generalDesign) {
    score += vocab.systems.length > 0 ? 0.25 : 0.45;
  }
  if (/(flat|dead|template|breath|平|死|模板|呼吸感)/i.test(input)) {
    score += 0.15;
  }
  return Math.min(score, 1);
}

function literaryScore(input: string): number {
  let score = 0;
  if (/(poem|poetry|novel|essay|paragraph|line|close read|literary|文案|句子|诗|小说|散文|分析这段|解读这段|改写这段文字)/i.test(input)) {
    score += 0.45;
  }
  if ((input.match(/\n/g) ?? []).length >= 1) {
    score += 0.2;
  }
  if (/(time|body|shadow|door|memory|silence|过去|身体|影子|门|记忆|沉默)/i.test(input)) {
    score += 0.2;
  }
  if (input.length >= 80) {
    score += 0.15;
  }
  return Math.min(score, 1);
}

function marketScore(input: string): number {
  const cryptoOrMacro = /(btc|eth|sol|crypto|earnings|guidance|liquidity|breakout|lower highs|higher lows|fed|yield|仓位|流动性|突破|结构|财报|指引|加密|市场)/i.test(input);
  let score = hasFinancialContent(input) ? 0.65 : 0;
  if (cryptoOrMacro) {
    score += hasFinancialContent(input) ? 0.25 : 0.45;
  }
  return Math.min(score, 1);
}

export function senseCommonField(input: string): Array<{ field: CommonField; confidence: number }> {
  const scores: Array<{ field: CommonField; confidence: number }> = [
    { field: 'market', confidence: marketScore(input) },
    { field: 'design', confidence: designScore(input) },
    { field: 'literature', confidence: literaryScore(input) },
  ];

  return scores
    .filter(entry => entry.confidence >= 0.35)
    .sort((a, b) => b.confidence - a.confidence);
}

export function buildFieldSpotlight(input: string): FieldSpotlight | null {
  const sensed = senseCommonField(input)[0];
  if (!sensed) return null;

  if (sensed.field === 'design') {
    return {
      field: 'design',
      confidence: sensed.confidence,
      rendered: renderDesignReading(readDesignIntent(input)),
    };
  }

  if (sensed.field === 'market') {
    return {
      field: 'market',
      confidence: sensed.confidence,
      rendered: renderMarketReading(readMarketText(input)),
    };
  }

  return {
    field: 'literature',
    confidence: sensed.confidence,
    rendered: renderLiteraryReading(readLiterature(input)),
  };
}

export function buildForcedFieldSpotlight(input: string, field: CommonField): FieldSpotlight {
  if (field === 'design') {
    return {
      field,
      confidence: 1,
      rendered: renderDesignReading(readDesignIntent(input)),
    };
  }

  if (field === 'market') {
    return {
      field,
      confidence: 1,
      rendered: renderMarketReading(readMarketText(input)),
    };
  }

  return {
    field,
    confidence: 1,
    rendered: renderLiteraryReading(readLiterature(input)),
  };
}
