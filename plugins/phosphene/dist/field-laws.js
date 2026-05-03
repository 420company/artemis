function fieldForProposal(proposal) {
    if (proposal?.spotlightField) {
        return proposal.spotlightField;
    }
    const need = proposal?.route.need;
    if (need === 'design')
        return 'design';
    if (need === 'writing')
        return 'literature';
    if (need === 'finance')
        return 'market';
    return null;
}
function buildDesignLaws(locale) {
    if (locale === 'zh') {
        return {
            field: 'design',
            title: '设计场律法',
            laws: [
                '先判结构失效，再谈美化。',
                '颜色必须有职责分工，不能所有颜色一起抢前景。',
                '动效必须运输层级、状态或因果，不能只负责“好看”。',
                '界面要像有立场的作品，而不是功能拼装件。',
            ],
            forbiddenMoves: [
                '禁止先复述需求再进入判断。',
                '禁止把“更高级、更现代、更有呼吸感”当成空形容词。',
                '禁止给一长串平庸建议却不指出真正坍塌点。',
            ],
            proofOfPower: [
                '第一句就说出界面真正塌在哪。',
                '能指出这个作品不小心对用户说了什么。',
                '能给出一个最小但足以改写全局的重做动作。',
            ],
        };
    }
    return {
        field: 'design',
        title: 'Design Field Laws',
        laws: [
            'Judge structural failure before surface beauty.',
            'Color must have responsibility rather than equal-volume presence.',
            'Motion must carry hierarchy, state, or causality.',
            'The interface must read like a position, not assembled functionality.',
        ],
        forbiddenMoves: [
            'Do not restate the brief before making a judgment.',
            'Do not hide behind empty adjectives like premium, modern, or breathable.',
            'Do not list generic advice without naming the actual collapse point.',
        ],
        proofOfPower: [
            'The first sentence identifies the real structural failure.',
            'The answer can state what the work is accidentally telling the user.',
            'The redesign move is small but system-shifting.',
        ],
    };
}
function buildLiteraryLaws(locale) {
    if (locale === 'zh') {
        return {
            field: 'literature',
            title: '文学场律法',
            laws: [
                '先给判词，不做内容摘要。',
                '把意象、重复、转折和受力线看成结构，不看成气氛。',
                '语言的触感、呼吸和压强必须被读出来。',
                '真正有力量的细读，要让用户意识到自己刚才漏看了什么。',
            ],
            forbiddenMoves: [
                '禁止把文本改写成主题句合集。',
                '禁止只说“很有画面感、很有情绪”。',
                '禁止把隐喻当成漂亮装饰，而不解释它的结构作用。',
            ],
            proofOfPower: [
                '能指出一句或一个意象为什么是 load-bearing node。',
                '能把表层情绪和深层受力区分开。',
                '能给出继续读或继续改写时最值得做的一步。',
            ],
        };
    }
    return {
        field: 'literature',
        title: 'Literary Field Laws',
        laws: [
            'Lead with a reading, not a summary.',
            'Treat image, repetition, hinge, and line of force as structure rather than atmosphere.',
            'Read texture, breath, and pressure directly from the language.',
            'A strong close reading makes the user aware of what they just failed to notice.',
        ],
        forbiddenMoves: [
            'Do not flatten the text into thematic bullet points.',
            'Do not stop at vague praise like vivid or emotional.',
            'Do not treat metaphor as ornament without explaining its structural work.',
        ],
        proofOfPower: [
            'The answer can identify a load-bearing sentence or image.',
            'It separates surface mood from deeper force.',
            'It gives a next reading or revision move worth taking.',
        ],
    };
}
function buildMarketLaws(locale) {
    if (locale === 'zh') {
        return {
            field: 'market',
            title: '市场场律法',
            laws: [
                '所有金融判断都要先锚定到用户当前时间，再查询该时点附近的最新资料。',
                '先分离 headline、叙事、真实 flow，再给 thesis。',
                '先做研究拆解，再做结论收束；不要把观察、验证和执行混成一步。',
                '每个判断都要带失效条件，不准只有方向没有撤退线。',
                '风险栈必须具体，不准只说波动和不确定性。',
                '真正强的市场答案会把语言层和定价层分开。',
            ],
            forbiddenMoves: [
                '禁止拿旧价格、旧新闻、旧宏观状态冒充现在。',
                '禁止写成情绪化喊单。',
                '禁止把价格、故事和信念搅成一团。',
                '禁止跳过验证层，直接把 thesis 翻译成仓位建议。',
                '禁止只有观点，没有接受区、失效条件和风险。 ',
            ],
            proofOfPower: [
                '能说清这次判断的参考时间和数据新鲜度。',
                '能说清楚当前 thesis 什么时候失效。',
                '能指出 narrative 和 flow 不一致的地方。',
                '能把研究任务、验证层和触发器拆出来，而不是只给一个结论。',
                '能给出接下来最值得盯的结构问题，而不是泛泛预测。',
            ],
        };
    }
    return {
        field: 'market',
        title: 'Market Field Laws',
        laws: [
            'Anchor every financial judgment to the user current-time before pulling the conclusion together.',
            'Separate headline, narrative, and actual flow before settling on a thesis.',
            'Decompose the research path before compressing it into a conclusion.',
            'Every judgment must carry an invalidation line.',
            'Risk must be specific rather than reduced to generic volatility language.',
            'Strong market answers keep the language layer separate from the pricing layer.',
        ],
        forbiddenMoves: [
            'Do not pass off stale price, stale news, or stale macro state as current.',
            'Do not slide into emotional trade-calling.',
            'Do not blend price, story, and conviction into one blur.',
            'Do not skip validation and jump straight from thesis to positioning advice.',
            'Do not offer a directional view without invalidation or risk structure.',
        ],
        proofOfPower: [
            'The answer states the reference time and data freshness clearly.',
            'The answer states exactly when the thesis fails.',
            'It identifies where narrative and flow diverge.',
            'It can separate research tasks, validation layers, and trigger conditions.',
            'It tells the user what structural question matters next.',
        ],
    };
}
export function buildFieldLaws(proposal, locale) {
    const field = fieldForProposal(proposal);
    if (!field)
        return undefined;
    if (field === 'design')
        return buildDesignLaws(locale);
    if (field === 'literature')
        return buildLiteraryLaws(locale);
    return buildMarketLaws(locale);
}
//# sourceMappingURL=field-laws.js.map