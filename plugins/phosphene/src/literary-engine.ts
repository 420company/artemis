export interface LiteraryReading {
  discipline: 'literature';
  locale: 'en' | 'zh';
  thesis: string;
  texture: string;
  structure: string;
  symbols: string[];
  turningPoints: string[];
  lineOfForce: string;
  riskOfMisreading: string;
  nextMove: string;
  evidence: string[];
}

type SymbolFamily =
  | 'time'
  | 'body'
  | 'light'
  | 'threshold'
  | 'absence'
  | 'water'
  | 'weather'
  | 'motion';

const EN_STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'were', 'your', 'you',
  'into', 'there', 'their', 'about', 'what', 'when', 'then', 'them', 'they',
  'been', 'more', 'than', 'only', 'over', 'very', 'like', 'just', 'also',
  'does', 'because', 'while', 'where', 'which', 'would', 'could', 'should',
  'still', 'again', 'after', 'before', 'through', 'between',
]);

const SYMBOLS: Array<{ family: SymbolFamily; pattern: RegExp; zh: string; en: string }> = [
  { family: 'time', pattern: /(time|past|future|before|after|again|still|always|never|memory|old|young|yesterday|tomorrow|now|曾经|过去|未来|之前|之后|时间|还在|仍然|又|再次|旧|如今|现在)/i, zh: '时间在文本里不是背景，而是施力者。', en: 'Time is not background here; it behaves like a force.' },
  { family: 'body', pattern: /(body|hand|skin|bone|breath|mouth|heart|blood|spine|eyes|face|身体|手|皮肤|骨|呼吸|嘴|心|血|脊背|眼|脸)/i, zh: '文本把抽象问题压回身体，让意义必须经过感官。', en: 'The text forces abstraction back through the body.' },
  { family: 'light', pattern: /(light|dark|shadow|glow|bright|dim|sun|moon|lamp|光|暗|影|亮|微光|太阳|月亮|灯)/i, zh: '明暗不是装饰，而是在安排可见与不可见的边界。', en: 'Light and shadow are staging visibility, not decorating it.' },
  { family: 'threshold', pattern: /(door|window|edge|border|threshold|between|cross|gate|bridge|门|窗|边缘|边界|阈值|之间|跨过|桥)/i, zh: '文本反复靠近门槛状态，真正关心的是“将要发生”的那一刻。', en: 'The text keeps returning to thresholds: the moment before becoming.' },
  { family: 'absence', pattern: /(nothing|empty|absence|silence|missing|void|blank|lost|没有|空|沉默|缺失|失去|虚无|空白)/i, zh: '缺失在这里不是空白，而是被主动写成内容。', en: 'Absence is written as content rather than left as empty space.' },
  { family: 'water', pattern: /(water|river|sea|rain|flood|wave|tide|lake|stream|水|河|海|雨|潮|浪|湖|溪)/i, zh: '液态意象让边界失稳，说明文本更在乎渗透而不是结论。', en: 'Water imagery destabilizes edges; the text prefers seepage to closure.' },
  { family: 'weather', pattern: /(wind|storm|fog|cloud|snow|dust|heat|cold|风|暴|雾|云|雪|尘|热|冷)/i, zh: '天气在这里是情绪的外化层，不是背景板。', en: 'Weather is functioning as emotional exteriorization.' },
  { family: 'motion', pattern: /(drag|pull|fall|rise|break|drift|turn|return|carry|move|拖|拉|落|升|碎|漂|转身|回去|带着|移动)/i, zh: '动词承担了真正的戏剧重量，说明文本写的是力而不是信息。', en: 'The verbs carry the dramatic load; this is a text about force, not information.' },
];

function detectLocale(text: string): 'en' | 'zh' {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en';
}

function splitSentences(text: string): string[] {
  return text
    .split(/[\n\r]+|(?<=[。！？!?])|(?<=\.)\s+/)
    .map(part => part.trim())
    .filter(Boolean);
}

function extractEvidence(text: string): string[] {
  return splitSentences(text).slice(0, 3);
}

function repeatedWords(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter(word => !EN_STOPWORDS.has(word));
  const counts = new Map<string, number>();

  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word)
    .slice(0, 4);
}

function detectSymbols(text: string): Array<{ family: SymbolFamily; note: string }> {
  const locale = detectLocale(text);
  return SYMBOLS
    .filter(entry => entry.pattern.test(text))
    .map(entry => ({
      family: entry.family,
      note: locale === 'zh' ? entry.zh : entry.en,
    }));
}

function describeTexture(text: string, locale: 'en' | 'zh', symbols: SymbolFamily[]): string {
  const sensoryDensity = (text.match(/(warm|cold|bright|dark|soft|sharp|heavy|light|quiet|loud|热|冷|亮|暗|软|硬|重|轻|静|响)/gi) ?? []).length;
  const fragmented = splitSentences(text).some(sentence => sentence.length <= 14);

  if (locale === 'zh') {
    if (sensoryDensity >= 4) {
      return '感官密度很高，词语不是在报告事实，而是在把触感、温度和重量压到句面上。';
    }
    if (fragmented) {
      return '句子偏短，切口明显，像一段一段压出来的呼吸，因此紧张感来自停顿本身。';
    }
    if (symbols.includes('absence')) {
      return '表层语言并不浓烈，但空白、停顿和未说出的部分持续带电。';
    }
    return '质地偏克制，力量更多来自语义回响，而不是形容词堆积。';
  }

  if (sensoryDensity >= 4) {
    return 'The language is sensorily dense: it presses touch, temperature, and weight directly onto the sentence.';
  }
  if (fragmented) {
    return 'The short sentence cuts matter. Tension arrives through breath and interruption rather than ornament.';
  }
  if (symbols.includes('absence')) {
    return 'The surface is restrained, but the unsaid remains electrically active.';
  }
  return 'The texture is controlled. The charge comes from echo and pressure, not verbal excess.';
}

function describeStructure(
  text: string,
  locale: 'en' | 'zh',
  repeated: string[],
  symbols: SymbolFamily[],
): { structure: string; turningPoints: string[]; lineOfForce: string } {
  const sentences = splitSentences(text);
  const turns = sentences.filter(sentence => /(but|yet|however|although|though|still|而是|但是|却|然而|可是|只是)/i.test(sentence));
  const lineOfForce = symbols.includes('threshold')
    ? locale === 'zh'
      ? '从停留的边缘，逼近跨越。'
      : 'From suspended edge toward crossing.'
    : symbols.includes('time')
      ? locale === 'zh'
        ? '从回望旧时间，逼向必须发生的现在。'
        : 'From retrospective drag toward an unavoidable present.'
      : locale === 'zh'
        ? '从表层描述，向更深的内在受力推进。'
        : 'From surface description toward inner pressure.';

  if (locale === 'zh') {
    if (turns.length > 0) {
      return {
        structure: '结构不是线性铺陈，而是靠转折词建立铰链。文本每次说“但是 / 却 / 然而”，都在把意义从表层推向更深一层。',
        turningPoints: turns.slice(0, 3).map(turn => `转折发生在：${turn}`),
        lineOfForce,
      };
    }
    if (repeated.length > 0) {
      return {
        structure: `结构依靠重复词建立内压，真正的重音落在 ${repeated.join(' / ')} 这些回返节点上。`,
        turningPoints: sentences.slice(1, 3).map(sentence => `重音推进段：${sentence}`),
        lineOfForce,
      };
    }
    return {
      structure: '结构更像持续加压而非情节推进。它不是要告诉你发生了什么，而是要让一种受力感逐步成形。',
      turningPoints: sentences.slice(1, 3).map(sentence => `压力抬升段：${sentence}`),
      lineOfForce,
    };
  }

  if (turns.length > 0) {
    return {
      structure: 'The structure is hinge-based rather than linear. Each contrast marker pushes the meaning beneath the stated surface.',
      turningPoints: turns.slice(0, 3).map(turn => `Hinge: ${turn}`),
      lineOfForce,
    };
  }
  if (repeated.length > 0) {
    return {
      structure: `Repetition is doing the architectural work. The real stress points sit on ${repeated.join(', ')}.`,
      turningPoints: sentences.slice(1, 3).map(sentence => `Pressure node: ${sentence}`),
      lineOfForce,
    };
  }
  return {
    structure: 'This piece accumulates pressure more than it advances plot. It builds force before it yields statement.',
    turningPoints: sentences.slice(1, 3).map(sentence => `Pressure lift: ${sentence}`),
    lineOfForce,
  };
}

function buildThesis(
  locale: 'en' | 'zh',
  symbols: SymbolFamily[],
  repeated: string[],
): string {
  const hasTime = symbols.includes('time');
  const hasBody = symbols.includes('body');
  const hasThreshold = symbols.includes('threshold');
  const hasAbsence = symbols.includes('absence');

  if (locale === 'zh') {
    if (hasTime && hasBody) {
      return '这段文字真正写的不是情绪本身，而是时间如何落到身体上，变成一种拖拽与负重。';
    }
    if (hasThreshold && hasAbsence) {
      return '文本的核心不是事件，而是门槛感本身: 某件事尚未发生，但它的压力已经先抵达。';
    }
    if (repeated.length > 0) {
      return `这段文字不是在扩展题材，而是在不断敲击同一个核心问题: ${repeated[0]}.`;
    }
    return '这段文字的力量不在信息量，而在它把一种内在受力写成了可被感到的形式。';
  }

  if (hasTime && hasBody) {
    return 'The text is not really about feeling in the abstract; it is about time landing on the body as drag and load.';
  }
  if (hasThreshold && hasAbsence) {
    return 'The core subject is not the event itself but the threshold before it: pressure arrives before resolution does.';
  }
  if (repeated.length > 0) {
    return `The passage is not broadening outward. It keeps striking the same load-bearing question: ${repeated[0]}.`;
  }
  return 'Its force lies less in information than in how it renders inner pressure as something palpable.';
}

function buildRisk(locale: 'en' | 'zh', symbols: SymbolFamily[]): string {
  if (locale === 'zh') {
    if (symbols.includes('light') || symbols.includes('weather')) {
      return '最容易的误读，是把这些意象当作装饰气氛。实际上它们在承担结构功能，负责分配可见、不可见、靠近与撤离。';
    }
    return '最容易的误读，是把它当成“情绪化表达”。真正关键的是它如何安排受力，而不是它抒发了什么。';
  }

  if (symbols.includes('light') || symbols.includes('weather')) {
    return 'The easy misreading is to treat the imagery as atmosphere. It is structural: distributing visibility, distance, and exposure.';
  }
  return 'The easiest mistake is to reduce this to mood. The real issue is how the passage arranges force.';
}

function buildNextMove(locale: 'en' | 'zh', symbols: SymbolFamily[]): string {
  if (locale === 'zh') {
    if (symbols.includes('threshold')) {
      return '如果继续写，下一步不该解释主题，而该让门槛真正被跨过去一次，让前面的压力找到落点。';
    }
    if (symbols.includes('absence')) {
      return '如果继续读或改写，先追踪那些没有被说出的部分。它们比明说的句子更接近文本的真正发动机。';
    }
    return '下一步最值得做的，不是扩写，而是把最重的那个意象再压实一次，让它成为全段的组织中心。';
  }

  if (symbols.includes('threshold')) {
    return 'If you continue the piece, do not explain the theme. Let the threshold actually be crossed once so the stored pressure has somewhere to land.';
  }
  if (symbols.includes('absence')) {
    return 'If you revise or read further, track what remains unsaid. It is closer to the engine than the explicit statements are.';
  }
  return 'The next move is not expansion but compression: densify the heaviest image until it becomes the organizing center.';
}

export function readLiterature(text: string): LiteraryReading {
  const locale = detectLocale(text);
  const repeated = repeatedWords(text);
  const symbolEntries = detectSymbols(text);
  const symbols = symbolEntries.map(entry => entry.family);
  const structure = describeStructure(text, locale, repeated, symbols);

  return {
    discipline: 'literature',
    locale,
    thesis: buildThesis(locale, symbols, repeated),
    texture: describeTexture(text, locale, symbols),
    structure: structure.structure,
    symbols: symbolEntries.map(entry => entry.note),
    turningPoints: structure.turningPoints,
    lineOfForce: structure.lineOfForce,
    riskOfMisreading: buildRisk(locale, symbols),
    nextMove: buildNextMove(locale, symbols),
    evidence: extractEvidence(text),
  };
}

export function renderLiteraryReading(reading: LiteraryReading): string {
  if (reading.locale === 'zh') {
    const lines = [
      '【Phosphene Literary Read】',
      `主判断: ${reading.thesis}`,
      `质地: ${reading.texture}`,
      `结构: ${reading.structure}`,
      `受力线: ${reading.lineOfForce}`,
    ];

    if (reading.symbols.length > 0) {
      lines.push(`意象电荷: ${reading.symbols.join(' ')}`);
    }
    if (reading.turningPoints.length > 0) {
      lines.push(`转折点: ${reading.turningPoints.join(' / ')}`);
    }
    lines.push(`误读风险: ${reading.riskOfMisreading}`);
    lines.push(`下一步: ${reading.nextMove}`);
    return lines.join('\n');
  }

  const lines = [
    '[Phosphene Literary Read]',
    `Thesis: ${reading.thesis}`,
    `Texture: ${reading.texture}`,
    `Structure: ${reading.structure}`,
    `Line of force: ${reading.lineOfForce}`,
  ];

  if (reading.symbols.length > 0) {
    lines.push(`Charged symbols: ${reading.symbols.join(' ')}`);
  }
  if (reading.turningPoints.length > 0) {
    lines.push(`Turning points: ${reading.turningPoints.join(' / ')}`);
  }
  lines.push(`Risk of misreading: ${reading.riskOfMisreading}`);
  lines.push(`Next move: ${reading.nextMove}`);
  return lines.join('\n');
}
