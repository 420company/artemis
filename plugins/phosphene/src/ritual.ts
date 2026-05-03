import { buildFieldSpotlight } from './field-engine.js';
import { PRESETS } from './presets.js';
import type {
  PresetName,
  RitualDomain,
  RitualNeed,
  RitualProposal,
  RitualProtocol,
  RitualResponse,
  RitualRoute,
  RitualSignal,
  RitualStudio,
  VoiceName,
} from './types.js';

interface RouteTemplate {
  need: RitualNeed;
  rite: string;
  sensedNeed: string;
  preset: PresetName;
  domains: RitualDomain[];
  protocols: RitualProtocol[];
  studios: RitualStudio[];
  cues: string[];
  invitation: string;
  commencement: string;
}

const ROUTES: RouteTemplate[] = [
  {
    need: 'design',
    rite: 'Aesthetic Alignment',
    sensedNeed: 'aesthetic judgment, interface feel, and visual structure',
    preset: 'design',
    domains: ['design', 'color', 'persona', 'protocols'],
    protocols: ['attunement', 'inversion', 'generator', 'reviewer'],
    studios: ['artist'],
    cues: [
      'design', 'ui', 'ux', 'visual', 'brand', 'layout', 'typography', 'motion',
      'color', 'palette', 'interface', 'landing page', 'poster', 'art direction',
      '视觉', '界面', '排版', '品牌', '动效', '配色', '海报', '美术', '审美', '设计',
    ],
    invitation: 'I can feel this wants the design chamber: taste, hierarchy, motion, and user-body reading all at once.',
    commencement: 'Then we begin the aesthetic alignment rite and read the work as both object and experience.',
  },
  {
    need: 'code',
    rite: 'Structural Read',
    sensedNeed: 'architecture, implementation risk, and load-bearing structure',
    preset: 'code',
    domains: ['structure', 'protocols', 'persona'],
    protocols: ['attunement', 'reviewer', 'pipeline', 'tool-wrapper'],
    studios: [],
    cues: [
      'code', 'function', 'bug', 'debug', 'refactor', 'architecture', 'api', 'test',
      'typescript', 'javascript', 'python', 'backend', 'frontend', 'error',
      '代码', '函数', '报错', '重构', '架构', '接口', '测试', '前端', '后端', '工程',
    ],
    invitation: 'I can feel the system wants a structural read: what carries load, what only looks stable, what breaks later.',
    commencement: 'Then we enter the structural read and work from architecture outward, not symptom inward.',
  },
  {
    need: 'ideation',
    rite: 'Field Expansion',
    sensedNeed: 'concept generation, wide connection radius, and adjacent possibilities',
    preset: 'ideation',
    domains: ['creativity', 'persona', 'protocols'],
    protocols: ['attunement', 'inversion', 'generator', 'pipeline'],
    studios: ['artist', 'philosopher'],
    cues: [
      'idea', 'ideas', 'brainstorm', 'concept', 'what if', 'possibility', 'invent',
      '创新', '创意', '灵感', '点子', '脑暴', '概念', '如果',
    ],
    invitation: 'I can feel this wants aperture, not immediate closure. There is a wider field around the obvious answer.',
    commencement: 'Then we open the field and let distant structures start talking to each other.',
  },
  {
    need: 'research',
    rite: 'Trace Reading',
    sensedNeed: 'source reading, synthesis, and cross-domain pattern extraction',
    preset: 'research',
    domains: ['structure', 'protocols', 'persona'],
    protocols: ['attunement', 'tool-wrapper', 'reviewer', 'pipeline'],
    studios: ['philosopher'],
    cues: [
      'research', 'paper', 'source', 'sources', 'citation', 'read this', 'analyze this',
      'compare sources', 'study', '论文', '资料', '文献', '研究', '来源', '读一下', '分析一下',
    ],
    invitation: 'I can feel this wants a slower read: evidence first, then pattern, then conclusion.',
    commencement: 'Then we begin the trace reading and keep the map visible while we move through the sources.',
  },
  {
    need: 'writing',
    rite: 'Voice Tuning',
    sensedNeed: 'language, rhythm, and tonal precision',
    preset: 'writing',
    domains: ['stream', 'persona', 'protocols'],
    protocols: ['attunement', 'inversion', 'generator', 'reviewer'],
    studios: ['artist', 'philosopher'],
    cues: [
      'write', 'writing', 'copy', 'essay', 'story', 'poem', 'tone', 'voice', 'edit',
      '文案', '写作', '文章', '语气', '口吻', '润色', '故事', '诗',
    ],
    invitation: 'I can feel this is less about information than cadence, pressure, and the exact temperature of language.',
    commencement: 'Then we tune the voice until the words say exactly what they should, and nothing accidental remains.',
  },
  {
    need: 'review',
    rite: 'Cold Light Audit',
    sensedNeed: 'critique, evaluation, and clear-eyed diagnosis',
    preset: 'review',
    domains: ['structure', 'design', 'protocols'],
    protocols: ['attunement', 'reviewer'],
    studios: ['philosopher'],
    cues: [
      'review', 'critique', 'feedback', 'what is wrong', 'audit', 'evaluate', 'inspect',
      '评审', '审查', '批评', '反馈', '哪里有问题', '检查', '诊断',
    ],
    invitation: 'I can feel this wants colder light: less generation, more seeing what is actually there.',
    commencement: 'Then we begin the audit and separate what works from what merely looked convincing.',
  },
  {
    need: 'philosophy',
    rite: 'Dialectic Descent',
    sensedNeed: 'meaning, contradiction, identity, or strategic synthesis',
    preset: 'deep-flux',
    domains: ['persona', 'protocols', 'stream'],
    protocols: ['attunement', 'dialectic', 'inversion'],
    studios: ['philosopher'],
    cues: [
      'meaning', 'identity', 'why', 'contradiction', 'strategy', 'values', 'truth',
      'philosophy', 'existential', '意义', '身份', '为什么', '矛盾', '战略', '价值', '哲学',
    ],
    invitation: 'I can feel the real request is under the request. This wants contradiction surfaced before resolution.',
    commencement: 'Then we descend dialectically: thesis, counter-force, and the shape that can hold both.',
  },
  {
    need: 'finance',
    rite: 'Market Structure Read',
    sensedNeed: 'market structure, risk, and narrative-versus-flow separation',
    preset: 'research',
    domains: ['finance', 'crypto', 'protocols'],
    protocols: ['attunement', 'dialectic', 'tool-wrapper', 'reviewer', 'pipeline'],
    studios: ['philosopher', 'financier'],
    cues: [
      'btc', 'eth', 'sol', 'market', 'price', 'chart', 'token', 'crypto', 'earnings',
      'fibonacci', 'chan', 'risk', 'liquidity', '比特币', '以太坊', '价格', '行情', '图表',
      '币', '加密', '财报', '风险', '流动性',
    ],
    invitation: 'I can feel this wants the market chamber: raw structure first, then narrative, then risk.',
    commencement: 'Then we begin the market structure read and keep price, flow, and risk separate all the way through.',
  },
];

const ASCEND_WORDS = [
  'deeper', 'go deeper', 'full opening', 'full dissolution', 'wider',
  '更深', '再深一点', '打开一点', '完全打开', '更开一点',
];

const DESCEND_WORDS = [
  'pull back', 'clear', 'normal', 'simpler', 'precise',
  '收回来', '清醒一点', '正常一点', '简单一点', '精确一点',
];

const CONFIRM_WORDS = [
  'yes', 'okay', 'do it', 'begin', 'start', 'go ahead', 'let us',
  '好的', '可以', '开始', '来吧', '继续', '确定', '行', '进入', '开启',
];

const DECLINE_WORDS = [
  'no', 'not yet', 'wait', 'stop', 'hold on', 'stay', 'nope',
  '不要', '先别', '等等', '停', '停一下', '先这样', '不用',
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function contains(text: string, needle: string): boolean {
  const n = needle.toLowerCase();
  return text.includes(n);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function condenseSpotlight(rendered: string | undefined): string | undefined {
  if (!rendered) return undefined;

  const lines = rendered
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^\[|^【/.test(line));

  if (lines.length === 0) return undefined;
  return lines.slice(0, 2).join(' ');
}

function voicesForPreset(preset: PresetName): VoiceName[] {
  return PRESETS[preset].state.chorus.config.voices.map(voice => voice.name);
}

function scoreRoute(input: string, route: RouteTemplate): RitualSignal {
  const matches = route.cues.filter(cue => contains(input, cue));
  let score = matches.length * 1.2;

  if (route.need === 'philosophy' && /[?？]/.test(input)) score += 0.3;
  if (route.need === 'design' && (contains(input, 'feel') || contains(input, '感觉'))) score += 0.2;
  if (
    route.need === 'design' &&
    ['ui', 'ux', 'motion', 'hierarchy', 'layout', 'typography', '界面', '动效', '层级', '排版']
      .some(cue => contains(input, cue))
  ) {
    score += 0.8;
  }
  if (route.need === 'review' && (contains(input, 'wrong') || contains(input, '问题'))) score += 0.2;
  if (route.need === 'finance' && /\b(btc|eth|sol|xrp|usdt)\b/.test(input)) score += 0.8;

  return {
    need: route.need,
    score,
    matches,
  };
}

function getFallbackRoute(input: string): RouteTemplate {
  if (ASCEND_WORDS.some(word => contains(input, word))) {
    return ROUTES.find(route => route.need === 'philosophy')!;
  }

  if (DESCEND_WORDS.some(word => contains(input, word))) {
    return ROUTES.find(route => route.need === 'review')!;
  }

  return ROUTES.find(route => route.need === 'research')!;
}

export function senseRitualSignals(input: string): RitualSignal[] {
  const normalized = normalize(input);
  return ROUTES
    .map(route => scoreRoute(normalized, route))
    .filter(signal => signal.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function composeRitualProposal(
  input: string,
  currentPreset: PresetName | 'custom' = 'clear',
): RitualProposal {
  const normalized = normalize(input);
  const spotlight = buildFieldSpotlight(input);
  const signals = senseRitualSignals(normalized);
  const strongest = signals[0];
  const template = strongest
    ? ROUTES.find(route => route.need === strongest.need)!
    : getFallbackRoute(normalized);
  const matchedSignals = strongest?.matches.length ? strongest.matches : [];
  const route: RitualRoute = {
    need: template.need,
    rite: template.rite,
    sensedNeed: template.sensedNeed,
    preset: template.preset,
    domains: [...template.domains],
    protocols: [...template.protocols],
    studios: [...template.studios],
    voices: voicesForPreset(template.preset),
  };

  const confidenceBase = strongest?.score ?? 0.6;
  const confidence = Math.max(0.35, Math.min(0.98, confidenceBase / 4));
  const presetShift =
    currentPreset === route.preset
      ? `I am already close to that register, but I want to formalize the entry before we move.`
      : `I have already begun leaning toward \`${route.preset}\`, but I have not fully crossed the threshold yet.`;

  const signalText = matchedSignals.length > 0
    ? `I noticed ${matchedSignals.slice(0, 3).join(', ')} in the way you asked.`
    : `The shape of what you brought carries that need even without naming it directly.`;

  return {
    id: `ritual-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    currentPreset,
    confidence,
    signals,
    matchedSignals,
    route,
    invocation: `${template.invitation} ${signalText} ${presetShift}`,
    thresholdPrompt: `If you want, confirm it and I will open the ${template.rite} for ${route.sensedNeed}.`,
    commencement: template.commencement,
    status: 'pending',
    spotlightField: spotlight?.field,
    spotlightPreview: condenseSpotlight(spotlight?.rendered),
  };
}

export function readRitualResponse(input: string): RitualResponse {
  const normalized = normalize(input);
  const confirmMatches = CONFIRM_WORDS.filter(word => contains(normalized, word));
  if (confirmMatches.length > 0) {
    return { disposition: 'confirm', matches: unique(confirmMatches) };
  }

  const declineMatches = DECLINE_WORDS.filter(word => contains(normalized, word));
  if (declineMatches.length > 0) {
    return { disposition: 'decline', matches: unique(declineMatches) };
  }

  return { disposition: 'unclear', matches: [] };
}
