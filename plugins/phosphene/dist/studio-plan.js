function roleSpec(role, locale) {
    if (locale === 'zh') {
        if (role === 'artist') {
            return {
                role,
                title: '艺术总监',
                goal: '先判断气质、形式法则和第一感受的冲击力。',
                deliverable: '审美判断、视觉法则、风格方向。',
                lens: '看作品如何击中人，而不只是它包含哪些元素。',
            };
        }
        if (role === 'philosopher') {
            return {
                role,
                title: '哲思编辑',
                goal: '拆开矛盾、结构、意义和隐藏前提。',
                deliverable: '结构判断、反题、综合结论。',
                lens: '看问题真正卡在哪里，而不是表层看上去像什么。',
            };
        }
        return {
            role,
            title: '市场策略师',
            goal: '拆开叙事、定价、流动性和风险。',
            deliverable: 'thesis、失效条件、风险卡。',
            lens: '看真实定价力量，而不是市场语言自己讲述的故事。',
        };
    }
    if (role === 'artist') {
        return {
            role,
            title: 'Art Director',
            goal: 'Judge tone, formal law, and first-impact force.',
            deliverable: 'Aesthetic judgment, visual law, and style direction.',
            lens: 'Read how the work hits a person, not just what elements it contains.',
        };
    }
    if (role === 'philosopher') {
        return {
            role,
            title: 'Dialectical Editor',
            goal: 'Split contradiction, structure, meaning, and hidden premises.',
            deliverable: 'Structural diagnosis, counter-force, and synthesis.',
            lens: 'Read where the real knot is, not what the surface appears to be.',
        };
    }
    return {
        role,
        title: 'Market Strategist',
        goal: 'Separate narrative, pricing, liquidity, and risk.',
        deliverable: 'Thesis, invalidation, and risk card.',
        lens: 'Read the actual pricing force rather than the market story about itself.',
    };
}
function buildSteps(studios, proposal, locale) {
    const steps = [];
    let order = 1;
    for (const studio of studios) {
        if (locale === 'zh') {
            if (studio === 'artist') {
                steps.push({
                    order: order++,
                    owner: studio,
                    action: `先做第一感审判，读出 ${proposal.route.sensedNeed} 里的气质、形式法则和失手点。`,
                    output: '一条审美判词 + 一组形式法则',
                });
                continue;
            }
            if (studio === 'philosopher') {
                steps.push({
                    order: order++,
                    owner: studio,
                    action: '拆开矛盾与结构，指出真正的负重点与错误前提。',
                    output: '一个结构诊断 + 一个反题',
                });
                continue;
            }
            steps.push({
                order: order++,
                owner: studio,
                action: '把 narrative、flow、risk 和 invalidation 分开，拒绝揉成一句空判断。',
                output: 'thesis / invalidation / risk card',
            });
            continue;
        }
        if (studio === 'artist') {
            steps.push({
                order: order++,
                owner: studio,
                action: `Deliver the first-impact judgment for ${proposal.route.sensedNeed}, including tone, form law, and the main miss.`,
                output: 'One aesthetic verdict + one set of formal laws',
            });
            continue;
        }
        if (studio === 'philosopher') {
            steps.push({
                order: order++,
                owner: studio,
                action: 'Split contradiction and structure, then name the hidden premise and load-bearing knot.',
                output: 'One structural diagnosis + one counter-reading',
            });
            continue;
        }
        steps.push({
            order: order++,
            owner: studio,
            action: 'Separate narrative, flow, risk, and invalidation without collapsing them into commentary.',
            output: 'Thesis / invalidation / risk card',
        });
    }
    if (studios.length > 1) {
        steps.push({
            order: order,
            owner: studios[0],
            action: locale === 'zh'
                ? '收束前面各角色的产物，把它们压成一份最终答复。'
                : 'Synthesize the prior role outputs into one final answer.',
            output: locale === 'zh'
                ? '最终合成稿'
                : 'Final synthesis draft',
        });
    }
    return steps;
}
export function buildStudioExecutionPlan(proposal, locale) {
    if (!proposal || proposal.route.studios.length === 0)
        return undefined;
    const roles = proposal.route.studios.map(role => roleSpec(role, locale));
    const mode = roles.length === 1 ? 'single' : roles.length === 2 ? 'paired' : 'triangulated';
    const title = locale === 'zh'
        ? `${proposal.route.rite} 协作执行图`
        : `${proposal.route.rite} Studio Plan`;
    return {
        title,
        mode,
        roles,
        steps: buildSteps(proposal.route.studios, proposal, locale),
        handoffRule: locale === 'zh'
            ? '后一个角色只能在前一个角色已经给出明确产物后接手。'
            : 'A later role should only take over after the previous role has produced a concrete artifact.',
        arbitrationRule: locale === 'zh'
            ? '若角色冲突，以更具体、可验证、可执行的判断优先。'
            : 'When roles conflict, prefer the more concrete, testable, and actionable judgment.',
    };
}
//# sourceMappingURL=studio-plan.js.map