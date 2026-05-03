function normalizeFamily(input) {
    return input.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function detectField(proposal) {
    if (proposal?.spotlightField)
        return proposal.spotlightField;
    const need = proposal?.route.need;
    if (need === 'design')
        return 'design';
    if (need === 'writing')
        return 'literature';
    if (need === 'finance')
        return 'market';
    return null;
}
function buildDesignFamily(input, locale) {
    if (/(extreme|maximal|manifesto|shock|extreme mode|极致|极端|宣言|震撼)/i.test(input)) {
        return {
            field: 'design',
            family: locale === 'zh' ? '宣言级创意总监' : 'Manifesto Creative Director',
            rationale: locale === 'zh'
                ? '输入明确追求极致和震撼，适合使用更具宣言感和压迫感的设计语言。'
                : 'The brief asks for extremity and shock, so the renderer should become more manifesto-like and confrontational.',
        };
    }
    if (/(luxury|premium|elegant|wellness|奢华|高级|精致|疗愈)/i.test(input)) {
        return {
            field: 'design',
            family: locale === 'zh' ? '静奢总监' : 'Quiet Luxury Director',
            rationale: locale === 'zh'
                ? '输入里有高级感、精致、疗愈等语义，适合用克制、边缘精度和低噪音的审美语言。'
                : 'The brief carries premium and refined signals, so the output should lean toward restraint, edge precision, and low-noise luxury.',
        };
    }
    if (/(brutal|bold|poster|campaign|neo|锋利|激进|海报|大胆)/i.test(input)) {
        return {
            field: 'design',
            family: locale === 'zh' ? '锋面美术指导' : 'Frontline Art Director',
            rationale: locale === 'zh'
                ? '输入带有锋利、海报、激进等线索，适合更强势、更断裂的视觉判断。'
                : 'The input suggests poster energy and boldness, so a sharper, more forceful visual register fits.',
        };
    }
    return {
        field: 'design',
        family: locale === 'zh' ? '界面总导演' : 'Interface Director',
        rationale: locale === 'zh'
            ? '默认采用高判断力的界面总导演口吻，优先处理层级、动效和视觉法则。'
            : 'Default to a high-judgment interface-director voice focused on hierarchy, motion, and visual law.',
    };
}
function buildLiteraryFamily(input, locale) {
    if (/(extreme|oracular|verdict|oracle|极致|判词|神谕|裁决)/i.test(input)) {
        return {
            field: 'literature',
            family: locale === 'zh' ? '裁决者' : 'Verdict Reader',
            rationale: locale === 'zh'
                ? '输入追求更狠的判词感，因此输出会更短、更硬、更像落锤。'
                : 'The brief wants harder verdict energy, so the output becomes shorter, harder, and more hammer-like.',
        };
    }
    if (/(poem|poetry|诗|抒情|line|verse)/i.test(input)) {
        return {
            field: 'literature',
            family: locale === 'zh' ? '神谕细读者' : 'Oracular Reader',
            rationale: locale === 'zh'
                ? '输入更接近诗性材料，适合使用更凝练、更带判词感的 close reading。'
                : 'The material reads as poetic, so the output should become more condensed and oracle-like.',
        };
    }
    if (/(essay|novel|paragraph|分析这段|散文|小说)/i.test(input)) {
        return {
            field: 'literature',
            family: locale === 'zh' ? '结构细读者' : 'Structural Reader',
            rationale: locale === 'zh'
                ? '输入更像段落或叙述文本，适合强调结构铰链和受力线。'
                : 'The material looks more paragraphic or narrative, so structural hinge-reading is the right register.',
        };
    }
    return {
        field: 'literature',
        family: locale === 'zh' ? '深读批评者' : 'Deep Reading Critic',
        rationale: locale === 'zh'
            ? '默认采用高密度 close reading 口吻，兼顾判词与结构。'
            : 'Default to a dense close-reading voice that balances judgment with structure.',
    };
}
function buildMarketFamily(input, locale) {
    if (/(extreme|war room|battle|kill shot|extreme mode|极致|战情室|作战|杀招)/i.test(input)) {
        return {
            field: 'market',
            family: locale === 'zh' ? '战情室指挥官' : 'War-Room Commander',
            rationale: locale === 'zh'
                ? '输入要求更强执行力和极限判断，所以输出会更像战情室作战卡。'
                : 'The brief asks for maximum decisiveness, so the output should feel like a war-room action card.',
        };
    }
    if (/(risk|invalidation|drawdown|hedge|风险|失效|回撤|对冲)/i.test(input)) {
        return {
            field: 'market',
            family: locale === 'zh' ? '风险官' : 'Risk Officer',
            rationale: locale === 'zh'
                ? '输入把风险和失效条件放在前面，适合更冷、更克制的风控视角。'
                : 'The brief foregrounds invalidation and risk, so a colder risk-officer register fits best.',
        };
    }
    if (/(liquidity|flow|positioning|btc|eth|crypto|流动性|资金流|仓位|比特币|加密)/i.test(input)) {
        return {
            field: 'market',
            family: locale === 'zh' ? '交易台策略师' : 'Desk Strategist',
            rationale: locale === 'zh'
                ? '输入偏向结构、流动性和仓位，适合更像交易台晨会笔记的输出。'
                : 'The input leans toward structure, flow, and positioning, so a desk-strategist tone is appropriate.',
        };
    }
    return {
        field: 'market',
        family: locale === 'zh' ? '结构分析师' : 'Structure Analyst',
        rationale: locale === 'zh'
            ? '默认采用结构分析师口吻，优先拆开叙事、定价和风险。'
            : 'Default to a structure-analyst voice that separates narrative, pricing, and risk.',
    };
}
function overrideFamily(field, override, locale) {
    const normalized = normalizeFamily(override);
    const designFamilies = [
        {
            keys: ['manifesto creative director', 'manifesto', '宣言级创意总监'],
            family: locale === 'zh' ? '宣言级创意总监' : 'Manifesto Creative Director',
            rationale: locale === 'zh'
                ? '你手动指定了宣言家族，所以输出会更像强势创意宣言，而不是温和界面建议。'
                : 'You explicitly selected the manifesto family, so the output will behave more like a creative manifesto than polite interface advice.',
        },
        {
            keys: ['quiet luxury director', 'quiet luxury', '静奢总监'],
            family: locale === 'zh' ? '静奢总监' : 'Quiet Luxury Director',
            rationale: locale === 'zh'
                ? '你手动指定了静奢家族，所以输出会更克制、更精密、更低噪音。'
                : 'You explicitly selected the quiet-luxury family, so the output will become more restrained, precise, and low-noise.',
        },
        {
            keys: ['frontline art director', 'frontline', '锋面美术指导'],
            family: locale === 'zh' ? '锋面美术指导' : 'Frontline Art Director',
            rationale: locale === 'zh'
                ? '你手动指定了锋面家族，所以输出会更强势、更海报化、更具有冲击性。'
                : 'You explicitly selected the frontline family, so the output will become sharper, more poster-like, and more forceful.',
        },
        {
            keys: ['interface director', 'interface', '界面总导演'],
            family: locale === 'zh' ? '界面总导演' : 'Interface Director',
            rationale: locale === 'zh'
                ? '你手动指定了界面总导演家族，所以输出会回到高判断力的界面结构语言。'
                : 'You explicitly selected the interface-director family, so the output will return to a high-judgment interface-structure register.',
        },
    ];
    const literaryFamilies = [
        {
            keys: ['verdict reader', 'verdict', '裁决者'],
            family: locale === 'zh' ? '裁决者' : 'Verdict Reader',
            rationale: locale === 'zh'
                ? '你手动指定了裁决家族，所以输出会更像落判词。'
                : 'You explicitly selected the verdict family, so the output will feel more like a delivered judgment.',
        },
        {
            keys: ['oracular reader', 'oracular', '神谕细读者'],
            family: locale === 'zh' ? '神谕细读者' : 'Oracular Reader',
            rationale: locale === 'zh'
                ? '你手动指定了神谕家族，所以输出会更凝缩、更像判词。'
                : 'You explicitly selected the oracular family, so the output will become more condensed and verdict-like.',
        },
        {
            keys: ['structural reader', 'structural', '结构细读者'],
            family: locale === 'zh' ? '结构细读者' : 'Structural Reader',
            rationale: locale === 'zh'
                ? '你手动指定了结构细读家族，所以输出会更强调铰链、回返和受力。'
                : 'You explicitly selected the structural-reading family, so the output will emphasize hinges, returns, and pressure.',
        },
        {
            keys: ['deep reading critic', 'deep reading', '深读批评者'],
            family: locale === 'zh' ? '深读批评者' : 'Deep Reading Critic',
            rationale: locale === 'zh'
                ? '你手动指定了深读批评家族，所以输出会在判词和分析之间保持平衡。'
                : 'You explicitly selected the deep-reading-critic family, so the output will balance verdict and analysis.',
        },
    ];
    const marketFamilies = [
        {
            keys: ['war-room commander', 'war room', '战情室指挥官'],
            family: locale === 'zh' ? '战情室指挥官' : 'War-Room Commander',
            rationale: locale === 'zh'
                ? '你手动指定了战情室家族，所以输出会更像作战卡。'
                : 'You explicitly selected the war-room family, so the output will behave more like an action card.',
        },
        {
            keys: ['risk officer', 'risk', '风险官'],
            family: locale === 'zh' ? '风险官' : 'Risk Officer',
            rationale: locale === 'zh'
                ? '你手动指定了风险官家族，所以输出会更冷、更强调失效与回撤。'
                : 'You explicitly selected the risk-officer family, so the output will become colder and more invalidation-focused.',
        },
        {
            keys: ['desk strategist', 'desk', '交易台策略师'],
            family: locale === 'zh' ? '交易台策略师' : 'Desk Strategist',
            rationale: locale === 'zh'
                ? '你手动指定了交易台家族，所以输出会更像策略晨会记录。'
                : 'You explicitly selected the desk-strategist family, so the output will become more like a desk note.',
        },
        {
            keys: ['structure analyst', 'structure', '结构分析师'],
            family: locale === 'zh' ? '结构分析师' : 'Structure Analyst',
            rationale: locale === 'zh'
                ? '你手动指定了结构分析师家族，所以输出会优先拆开结构、叙事与定价。'
                : 'You explicitly selected the structure-analyst family, so the output will prioritize structural decomposition.',
        },
    ];
    const groups = {
        design: designFamilies,
        literature: literaryFamilies,
        market: marketFamilies,
    };
    const match = groups[field].find(entry => entry.keys.some(key => normalizeFamily(key) === normalized));
    if (!match)
        return undefined;
    return { field, family: match.family, rationale: match.rationale };
}
export function buildFieldFamily(input, proposal, locale, options = {}) {
    const field = detectField(proposal);
    if (!field)
        return undefined;
    if (options.override) {
        const overridden = overrideFamily(field, options.override, locale);
        if (overridden)
            return overridden;
    }
    if (field === 'design')
        return buildDesignFamily(input, locale);
    if (field === 'literature')
        return buildLiteraryFamily(input, locale);
    return buildMarketFamily(input, locale);
}
//# sourceMappingURL=field-family.js.map