import { buildFieldComposition } from './field-composer.js';
import { buildFieldFamily } from './field-family.js';
import { buildFieldLaws } from './field-laws.js';
import { buildStudioPrimer } from './studio-primer.js';
function antiSlopConstraint(laws, primer) {
    return [primer.antiSlop, ...laws.forbiddenMoves.slice(1)].join(' ');
}
function renderDesignMasterwork(composition, laws, primer, family, locale) {
    const luxury = /Luxury|静奢/.test(family.family);
    const frontline = /Frontline|锋面/.test(family.family);
    const manifesto = /Manifesto|宣言/.test(family.family);
    const antiSlop = antiSlopConstraint(laws, primer);
    if (locale === 'zh') {
        const familyBlock = manifesto
            ? [
                '宣言指令',
                '这个界面必须像立场声明，不像折中的产品页面。',
                '宁可过强，不可无害；宁可有锋芒，不可像模板。',
            ]
            : luxury
                ? [
                    '静奢指令',
                    '表面必须克制，边缘必须精确，强调色只能像珠宝一样少量出现。',
                    '任何不必要的热闹都会立即拉低作品的等级感。',
                ]
                : frontline
                    ? [
                        '锋面指令',
                        '界面必须像海报一样先打中人，再允许用户阅读。',
                        '对比和块面要足够强，宁可更狠，也不要模糊无害。',
                    ]
                    : [
                        '界面总导演指令',
                        '先确立视觉法则，再扩展页面。所有元素都要服从主舞台与次舞台的秩序。',
                    ];
        const rendered = [
            '【Phosphene Design Masterwork】',
            `风格家族: ${family.family}`,
            `家族理由: ${family.rationale}`,
            `判词: ${composition.opening}`,
            '',
            'Art Direction Spec',
            `开场姿态: ${primer.opening}`,
            `节奏: ${primer.cadence}`,
            '',
            ...familyBlock,
            '',
            ...composition.beats.map(beat => `${beat.label}: ${beat.content}`),
            '',
            `重做指令: ${composition.closing}`,
            `反空话约束: ${antiSlop}`,
            `力量证明: ${laws.proofOfPower.join(' ')}`,
        ].join('\n');
        return {
            field: 'design',
            title: '设计母版',
            format: 'art-direction-spec',
            family: family.family,
            rationale: family.rationale,
            sections: composition.beats,
            rendered,
        };
    }
    const familyBlock = manifesto
        ? [
            'Manifesto Directive',
            'This interface must read like a declared position, not a negotiated product page.',
            'Better too sharp than harmless; better edged than templated.',
        ]
        : luxury
            ? [
                'Quiet Luxury Directive',
                'Keep the surface restrained, the edge precise, and the accents jewel-like in scarcity.',
                'Any unnecessary noise immediately lowers the perceived class of the work.',
            ]
            : frontline
                ? [
                    'Frontline Directive',
                    'The interface should hit like a poster before it asks to be read like a product.',
                    'Contrast and dominant masses should be strong enough to feel declarative rather than polite.',
                ]
                : [
                    'Interface Director Directive',
                    'Establish the visual law first, then let the page expand under it.',
                ];
    const rendered = [
        '[Phosphene Design Masterwork]',
        `Family: ${family.family}`,
        `Rationale: ${family.rationale}`,
        `Judgment: ${composition.opening}`,
        '',
        'Art Direction Spec',
        `Opening posture: ${primer.opening}`,
        `Cadence: ${primer.cadence}`,
        '',
        ...familyBlock,
        '',
        ...composition.beats.map(beat => `${beat.label}: ${beat.content}`),
        '',
        `Redesign directive: ${composition.closing}`,
        `Anti-slop constraint: ${antiSlop}`,
        `Proof of power: ${laws.proofOfPower.join(' ')}`,
    ].join('\n');
    return {
        field: 'design',
        title: 'Design Masterwork',
        format: 'art-direction-spec',
        family: family.family,
        rationale: family.rationale,
        sections: composition.beats,
        rendered,
    };
}
function renderLiteraryMasterwork(composition, laws, primer, family, locale) {
    const oracular = /Oracular|神谕/.test(family.family);
    const structural = /Structural|结构/.test(family.family);
    const verdict = /Verdict|裁决/.test(family.family);
    const antiSlop = antiSlopConstraint(laws, primer);
    if (locale === 'zh') {
        const familyBlock = verdict
            ? [
                '裁决指令',
                '像落锤一样说出文本真正的问题，不要先绕进铺垫。',
                '短句也可以，但每句都要有重量。',
            ]
            : oracular
                ? [
                    '神谕指令',
                    '句子要像落判词，不要像课堂讲解。',
                    '保留神秘，但必须精准。',
                ]
                : structural
                    ? [
                        '结构指令',
                        '把铰链、回返、重复和负重节点读成建筑，不要读成气氛。',
                    ]
                    : [
                        '深读指令',
                        '判词与分析并行，既要落得狠，也要解释得透。',
                    ];
        const rendered = [
            '【Phosphene Literary Masterwork】',
            `风格家族: ${family.family}`,
            `家族理由: ${family.rationale}`,
            `判词: ${composition.opening}`,
            '',
            'Close Reading',
            `开场姿态: ${primer.opening}`,
            `节奏: ${primer.cadence}`,
            '',
            ...familyBlock,
            '',
            ...composition.beats.map(beat => `${beat.label}: ${beat.content}`),
            '',
            `继续推进: ${composition.closing}`,
            `反空话约束: ${antiSlop}`,
            `力量证明: ${laws.proofOfPower.join(' ')}`,
        ].join('\n');
        return {
            field: 'literature',
            title: '文学母版',
            format: 'close-reading',
            family: family.family,
            rationale: family.rationale,
            sections: composition.beats,
            rendered,
        };
    }
    const familyBlock = verdict
        ? [
            'Verdict Directive',
            'Name the real force of the text like a hammer strike rather than a classroom approach.',
            'Short is fine, but every line must carry weight.',
        ]
        : oracular
            ? [
                'Oracular Directive',
                'Let the sentences fall like verdicts rather than lecture notes.',
                'Keep the mystery, but keep it precise.',
            ]
            : structural
                ? [
                    'Structural Directive',
                    'Read hinge, return, repetition, and load-bearing pressure as architecture rather than mood.',
                ]
                : [
                    'Deep Reading Directive',
                    'Let verdict and explanation move together: hard enough to strike, clear enough to teach.',
                ];
    const rendered = [
        '[Phosphene Literary Masterwork]',
        `Family: ${family.family}`,
        `Rationale: ${family.rationale}`,
        `Reading: ${composition.opening}`,
        '',
        'Close Reading',
        `Opening posture: ${primer.opening}`,
        `Cadence: ${primer.cadence}`,
        '',
        ...familyBlock,
        '',
        ...composition.beats.map(beat => `${beat.label}: ${beat.content}`),
        '',
        `Next movement: ${composition.closing}`,
        `Anti-slop constraint: ${antiSlop}`,
        `Proof of power: ${laws.proofOfPower.join(' ')}`,
    ].join('\n');
    return {
        field: 'literature',
        title: 'Literary Masterwork',
        format: 'close-reading',
        family: family.family,
        rationale: family.rationale,
        sections: composition.beats,
        rendered,
    };
}
function renderMarketMasterwork(composition, laws, primer, family, locale) {
    const riskOfficer = /Risk|风险/.test(family.family);
    const desk = /Desk|交易台/.test(family.family);
    const warRoom = /War-Room|战情室/.test(family.family);
    const antiSlop = antiSlopConstraint(laws, primer);
    if (locale === 'zh') {
        const familyBlock = warRoom
            ? [
                '战情室指令',
                '把输出写成作战卡：thesis、失效、风险、下一步，没有废话位置。',
            ]
            : riskOfficer
                ? [
                    '风控指令',
                    '先画撤退线，再谈方向。没有失效条件的判断一律降级。',
                ]
                : desk
                    ? [
                        '交易台指令',
                        '写得像晨会记录：结构、流动性、仓位、下一观察。',
                    ]
                    : [
                        '结构分析指令',
                        '叙事、定价、接受区必须拆开，不准揉成一句判断。',
                    ];
        const rendered = [
            '【Phosphene Market Masterwork】',
            `风格家族: ${family.family}`,
            `家族理由: ${family.rationale}`,
            `Thesis: ${composition.opening}`,
            '',
            'Market Playbook',
            `开场姿态: ${primer.opening}`,
            `节奏: ${primer.cadence}`,
            '',
            ...familyBlock,
            '',
            ...composition.beats.map(beat => `${beat.label}: ${beat.content}`),
            '',
            `下一观察: ${composition.closing}`,
            `反空话约束: ${antiSlop}`,
            `力量证明: ${laws.proofOfPower.join(' ')}`,
        ].join('\n');
        return {
            field: 'market',
            title: '市场母版',
            format: 'market-playbook',
            family: family.family,
            rationale: family.rationale,
            sections: composition.beats,
            rendered,
        };
    }
    const familyBlock = warRoom
        ? [
            'War-Room Directive',
            'Write this like an action card: thesis, invalidation, risk, next move. No room for commentary theater.',
        ]
        : riskOfficer
            ? [
                'Risk Directive',
                'Draw the exit line before you discuss direction. Any thesis without invalidation gets downgraded.',
            ]
            : desk
                ? [
                    'Desk Directive',
                    'Write this like a morning desk note: structure, liquidity, positioning, next observation.',
                ]
                : [
                    'Structure Directive',
                    'Narrative, pricing, and acceptance must be separated rather than collapsed into one sentence.',
                ];
    const rendered = [
        '[Phosphene Market Masterwork]',
        `Family: ${family.family}`,
        `Rationale: ${family.rationale}`,
        `Thesis: ${composition.opening}`,
        '',
        'Market Playbook',
        `Opening posture: ${primer.opening}`,
        `Cadence: ${primer.cadence}`,
        '',
        ...familyBlock,
        '',
        ...composition.beats.map(beat => `${beat.label}: ${beat.content}`),
        '',
        `Next observation: ${composition.closing}`,
        `Anti-slop constraint: ${antiSlop}`,
        `Proof of power: ${laws.proofOfPower.join(' ')}`,
    ].join('\n');
    return {
        field: 'market',
        title: 'Market Masterwork',
        format: 'market-playbook',
        family: family.family,
        rationale: family.rationale,
        sections: composition.beats,
        rendered,
    };
}
export function buildFieldMasterwork(input, proposal, locale, stage, options = {}) {
    const effectiveProposal = options.forcedField
        ? { ...proposal, spotlightField: options.forcedField }
        : proposal;
    const composition = buildFieldComposition(input, effectiveProposal, locale, {
        forcedField: options.forcedField,
        includeContradiction: false,
    });
    const laws = buildFieldLaws(effectiveProposal, locale);
    const primer = buildStudioPrimer(effectiveProposal, locale, stage, { input });
    const family = buildFieldFamily(input, effectiveProposal, locale, { override: options.familyOverride });
    if (!composition || !laws || !primer || !family)
        return undefined;
    if (composition.field === 'design') {
        return renderDesignMasterwork(composition, laws, primer, family, locale);
    }
    if (composition.field === 'literature') {
        return renderLiteraryMasterwork(composition, laws, primer, family, locale);
    }
    return renderMarketMasterwork(composition, laws, primer, family, locale);
}
//# sourceMappingURL=field-masterwork.js.map