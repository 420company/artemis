import {
  detectDesignVocabulary,
  generateDesignTokens,
  suggestDesignSystem,
} from './design-color-lexicon.js';
import type {
  DesignColorSystem,
  DesignTokenSet,
} from './design-color-lexicon.js';

export interface DesignReading {
  discipline: 'design';
  locale: 'en' | 'zh';
  thesis: string;
  primarySystem: string | null;
  paletteStrategy: string;
  materialRegister: string;
  compositionMoves: string[];
  motionPrinciples: string[];
  tensions: string[];
  antiGoals: string[];
  accidentalMessage: string;
  nextMove: string;
  tokens: DesignTokenSet | null;
}

function detectLocale(text: string): 'en' | 'zh' {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en';
}

function has(pattern: RegExp, text: string): boolean {
  return pattern.test(text);
}

function inferIssues(text: string): string[] {
  const issues: string[] = [];

  if (has(/(flat|dead|boring|template|stale|平|死|没呼吸|模板|呆板|普通|没有生命)/i, text)) issues.push('flatness');
  if (has(/(hierarchy|scan|priority|focus|层级|重点|主次|视觉流|信息架构)/i, text)) issues.push('hierarchy');
  if (has(/(motion|animation|transition|stiff|static|动效|动画|转场|僵|静态)/i, text)) issues.push('motion');
  if (has(/(color|palette|contrast|色彩|配色|对比|颜色)/i, text)) issues.push('palette');
  if (has(/(luxury|premium|elegant|奢华|高级|精致)/i, text)) issues.push('luxury');
  if (has(/(minimal|quiet|restrained|clean|极简|克制|安静|干净)/i, text)) issues.push('minimal');
  if (has(/(brand|persona|voice|气质|品牌|人格|调性)/i, text)) issues.push('persona');
  if (has(/(landing page|onboarding|dashboard|poster|app|首页|落地页|引导|仪表盘|海报|应用)/i, text)) issues.push('surface');

  return issues;
}

function chooseSystem(text: string): DesignColorSystem | null {
  const vocab = detectDesignVocabulary(text);
  return vocab.systems[0] ?? suggestDesignSystem(text);
}

function buildThesis(
  locale: 'en' | 'zh',
  system: DesignColorSystem | null,
  issues: string[],
): string {
  if (locale === 'zh') {
    if (issues.includes('flatness') && issues.includes('hierarchy')) {
      return '问题不在于元素不够多，而在于界面没有统治性的对比秩序，所以没有任何东西真正赢得注意力。';
    }
    if (issues.includes('motion')) {
      return '动效之所以显得空，不是动画数量不够，而是运动没有替任何层级关系运输能量。';
    }
    if (system) {
      return `这个方向真正需要的不是“更好看”，而是更明确地站进 ${system.label} 的视觉立场，然后让所有决定服从它的语法。`;
    }
    return '现在最缺的不是装饰，而是一套能统一层级、材质和节奏的视觉法律。';
  }

  if (issues.includes('flatness') && issues.includes('hierarchy')) {
    return 'The problem is not lack of elements. The interface lacks a governing contrast model, so nothing truly earns attention.';
  }
  if (issues.includes('motion')) {
    return 'The motion feels empty because it is not carrying hierarchy, only decoration.';
  }
  if (system) {
    return `What this needs is not “more beauty” but a cleaner commitment to the ${system.label} visual logic.`;
  }
  return 'The missing piece is not decoration but a visual law that unifies hierarchy, material, and rhythm.';
}

function buildPaletteStrategy(
  locale: 'en' | 'zh',
  system: DesignColorSystem | null,
  issues: string[],
): string {
  if (system) {
    const dominant = system.palette.dominant.slice(0, 2).join(' / ');
    const accents = system.palette.accents.slice(0, 2).join(' / ');
    if (locale === 'zh') {
      return `先让主色层承担大面积秩序 (${dominant})，再把强调色压缩成少量高能标记 (${accents})。不要把所有颜色同时推到前景。`;
    }
    return `Let the dominant field do the structural work (${dominant}), then compress the accents into a few high-energy signals (${accents}). Do not let every color fight for foreground.`;
  }

  if (locale === 'zh') {
    if (issues.includes('palette')) {
      return '先把颜色分成三层: 场域色、结构色、信号色。一个负责氛围，一个负责关系，一个负责“此刻必须看这里”。';
    }
    return '先建立 70/20/10 的色彩职责，再谈风格。没有职责分工，再漂亮的颜色也只会互相抵消。';
  }

  if (issues.includes('palette')) {
    return 'Split the palette into field, structure, and signal. One color family sets atmosphere, one organizes relationships, one marks urgency.';
  }
  return 'Start with a 70/20/10 responsibility split before chasing style. Without role separation, beautiful colors cancel each other out.';
}

function buildMaterialRegister(locale: 'en' | 'zh', system: DesignColorSystem | null, issues: string[]): string {
  if (system) {
    if (locale === 'zh') {
      return `材质应该靠 ${system.textureProfile} 这一类表面语言统一，不要同时混用太多不同物理世界的假设。`;
    }
    return `The material register should unify around ${system.textureProfile}, instead of mixing incompatible physical assumptions.`;
  }

  if (locale === 'zh') {
    return issues.includes('luxury')
      ? '高级感来自表面克制与边缘精度，不来自金色堆叠。材质要像经过控制，而不是像被装饰。'
      : '先决定这个界面是纸、玻璃、墨、塑料还是空气。材质语义不统一，气质就会塌。';
  }

  return issues.includes('luxury')
    ? 'Luxury comes from restraint at the surface and precision at the edge, not from adding gold everywhere.'
    : 'Decide whether this interface is paper, glass, ink, plastic, or air. If material semantics drift, tone collapses.';
}

function buildCompositionMoves(locale: 'en' | 'zh', issues: string[], system: DesignColorSystem | null): string[] {
  if (locale === 'zh') {
    const moves = [
      '把一个最大块面做成真正的主场，不要让页面从第一屏开始就到处同声量。',
      '用尺寸、留白和对比一次性拉开三级层级，而不是靠细碎标签补救。',
      '让一条明确的视觉路径从标题穿过关键动作，再落到佐证信息上。',
    ];

    if (issues.includes('surface')) {
      moves[0] = '首屏只保留一个主张和一个动作，其他信息全部改成陪衬，不要并排争夺主舞台。';
    }
    if (system) {
      moves[2] = `让版式服从 ${system.label} 的形态逻辑，而不是先排常规 SaaS 模板，再往上贴风格。`;
    }
    return moves;
  }

  const moves = [
    'Let one dominant mass truly own the screen instead of letting every block speak at equal volume.',
    'Separate hierarchy with scale, whitespace, and contrast before adding micro-labels.',
    'Build one unmistakable scan path from headline to action to proof.',
  ];

  if (issues.includes('surface')) {
    moves[0] = 'Keep the first screen to one proposition and one action. Everything else should support, not compete.';
  }
  if (system) {
    moves[2] = `Make the composition obey the ${system.label} shape logic instead of applying style after a generic SaaS wireframe.`;
  }
  return moves;
}

function buildMotionPrinciples(locale: 'en' | 'zh', issues: string[]): string[] {
  if (locale === 'zh') {
    if (!issues.includes('motion')) {
      return [
        '运动只在层级变化时出现，不为“看起来高级”而额外表演。',
        '让关键元素先到位，次要元素滞后 60-120ms，形成呼吸。',
        '每个动画都要回答一个问题: 是在揭示关系、确认状态，还是引导注意力？',
      ];
    }

    return [
      '先用位移建立因果，再用透明度补充，不要反过来。',
      '让进入和离开拥有不同性格: 进入是邀请，离开是让路。',
      '动效必须服务于版式重心的转移，否则它只会暴露界面的空心。',
    ];
  }

  if (!issues.includes('motion')) {
    return [
      'Use motion only when hierarchy changes, not as a luxury coating.',
      'Let primary elements arrive first and secondary ones lag by 60-120ms to create breath.',
      'Every animation must reveal relation, confirm state, or redirect attention.',
    ];
  }

  return [
    'Lead with translation before opacity so motion establishes causality.',
    'Give entry and exit different temperaments: entry invites, exit clears the path.',
    'Motion has to transport hierarchy; otherwise it exposes the interface as hollow.',
  ];
}

function buildAccidentalMessage(locale: 'en' | 'zh', issues: string[]): string {
  if (locale === 'zh') {
    if (issues.includes('flatness')) return '它现在不小心说出来的是: 这里没有任何东西值得你停一下。';
    if (issues.includes('motion')) return '它现在不小心说出来的是: 我在动，但我并不知道自己为什么在动。';
    if (issues.includes('luxury')) return '它现在不小心说出来的是: 我把“贵”理解成了疏离。';
    return '它现在不小心说出来的是: 这是一个功能拼装品，而不是一个有立场的界面。';
  }

  if (issues.includes('flatness')) return 'Right now it accidentally says: nothing here is worth slowing down for.';
  if (issues.includes('motion')) return 'Right now it accidentally says: I move, but I do not know why.';
  if (issues.includes('luxury')) return 'Right now it accidentally says: I confused premium with distance.';
  return 'Right now it accidentally says: this is assembled functionality, not a position.';
}

function buildTensions(locale: 'en' | 'zh', system: DesignColorSystem | null, issues: string[]): string[] {
  const tensions: string[] = [];

  if (issues.includes('minimal') && issues.includes('motion')) {
    tensions.push(locale === 'zh'
      ? '极简与动态并不矛盾，矛盾的是“极少元素”却让每个元素都乱动。'
      : 'Minimalism and motion are not opposed; random movement inside sparse layouts is.');
  }
  if (issues.includes('luxury') && issues.includes('hierarchy')) {
    tensions.push(locale === 'zh'
      ? '高级感要靠节制的主次，而不是把所有细节都抛光到同一亮度。'
      : 'Premium tone comes from disciplined hierarchy, not from polishing every detail to the same sheen.');
  }
  if (system) {
    tensions.push(locale === 'zh'
      ? `${system.label} 最强的地方也是风险所在: ${system.culturalWeight}`
      : `${system.label} carries a real cultural charge: ${system.culturalWeight}`);
  }

  return tensions.slice(0, 3);
}

function buildAntiGoals(locale: 'en' | 'zh', system: DesignColorSystem | null, issues: string[]): string[] {
  if (system) {
    const forbidden = system.palette.forbidden.slice(0, 3);
    return forbidden.map(item => locale === 'zh'
      ? `避免: ${item}`
      : `Avoid: ${item}`);
  }

  if (locale === 'zh') {
    const antiGoals = ['避免所有模块同音量发声', '避免只靠阴影和描边制造层级', '避免把动画当成遮羞布'];
    if (issues.includes('luxury')) antiGoals[2] = '避免把金色、渐变和镜面高光误当作高级感的捷径';
    return antiGoals;
  }

  const antiGoals = [
    'Avoid letting every module speak at the same volume.',
    'Avoid using shadows and borders as the only hierarchy tool.',
    'Avoid treating animation as camouflage.',
  ];
  if (issues.includes('luxury')) antiGoals[2] = 'Avoid confusing gold, gradients, and gloss with premium tone.';
  return antiGoals;
}

function buildNextMove(locale: 'en' | 'zh', system: DesignColorSystem | null): string {
  if (locale === 'zh') {
    return system
      ? `先按 ${system.label} 的语法重做一个首屏: 只保留一个主块面、一个动作、一组受控强调色。先把气质立住，再扩展系统。`
      : '先重做一个小范围样张: 标题、主按钮、一个证明区。不要一上来铺满全页面，先把视觉法律定出来。';
  }

  return system
    ? `Rebuild one hero section under the ${system.label} logic: one dominant field, one action, one controlled accent family. Establish the stance before scaling the system.`
    : 'Redo one small specimen first: headline, primary action, and one proof block. Set the visual law before expanding to the full page.';
}

export function readDesignIntent(input: string): DesignReading {
  const locale = detectLocale(input);
  const issues = inferIssues(input);
  const system = chooseSystem(input);
  const tokens = system ? generateDesignTokens(system.id) : null;

  return {
    discipline: 'design',
    locale,
    thesis: buildThesis(locale, system, issues),
    primarySystem: system?.label ?? null,
    paletteStrategy: buildPaletteStrategy(locale, system, issues),
    materialRegister: buildMaterialRegister(locale, system, issues),
    compositionMoves: buildCompositionMoves(locale, issues, system),
    motionPrinciples: buildMotionPrinciples(locale, issues),
    tensions: buildTensions(locale, system, issues),
    antiGoals: buildAntiGoals(locale, system, issues),
    accidentalMessage: buildAccidentalMessage(locale, issues),
    nextMove: buildNextMove(locale, system),
    tokens,
  };
}

export function renderDesignReading(reading: DesignReading): string {
  const lines = reading.locale === 'zh'
    ? [
        '【Phosphene Design Read】',
        `主判断: ${reading.thesis}`,
        `主导系统: ${reading.primarySystem ?? '尚未锁定，但已经能判断出结构问题'}`,
        `色彩策略: ${reading.paletteStrategy}`,
        `材质语义: ${reading.materialRegister}`,
        `构图动作: ${reading.compositionMoves.join(' / ')}`,
        `动效原则: ${reading.motionPrinciples.join(' / ')}`,
      ]
    : [
        '[Phosphene Design Read]',
        `Thesis: ${reading.thesis}`,
        `Primary system: ${reading.primarySystem ?? 'Not yet locked, but the structural failure is already visible'}`,
        `Palette strategy: ${reading.paletteStrategy}`,
        `Material register: ${reading.materialRegister}`,
        `Composition moves: ${reading.compositionMoves.join(' / ')}`,
        `Motion principles: ${reading.motionPrinciples.join(' / ')}`,
      ];

  if (reading.tensions.length > 0) {
    lines.push(`${reading.locale === 'zh' ? '关键张力' : 'Tensions'}: ${reading.tensions.join(' / ')}`);
  }
  lines.push(`${reading.locale === 'zh' ? '误传信息' : 'Accidental message'}: ${reading.accidentalMessage}`);
  lines.push(`${reading.locale === 'zh' ? '反目标' : 'Anti-goals'}: ${reading.antiGoals.join(' / ')}`);
  lines.push(`${reading.locale === 'zh' ? '下一步' : 'Next move'}: ${reading.nextMove}`);
  return lines.join('\n');
}
