import { detectHumanPatterns } from './contradiction-engine.js';
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
function contradictionSection(input, locale) {
    if (!input)
        return [];
    const hit = detectHumanPatterns(input)[0];
    if (!hit)
        return [];
    return [{
            label: locale === 'zh' ? '人类矛盾' : 'Human contradiction',
            instruction: locale === 'zh'
                ? `把 ${hit.id} 读出来，区分方法、神话与代价，不要把失衡写成深度。`
                : `Name ${hit.id}, separating method, mythology, and cost instead of flattering imbalance as depth.`,
        }];
}
function zhSections(field, input) {
    const sections = (() => {
        switch (field) {
            case 'literature':
                return [
                    { label: '主判断', instruction: '先给一句真正的判词，不要先复述内容。' },
                    { label: '质地', instruction: '判断语言的触感、密度、呼吸和压强来自哪里。' },
                    { label: '结构', instruction: '指出句子或段落如何转折、回返、加压或折叠。' },
                    { label: '受力线', instruction: '说明整段文字真正被什么力量驱动。' },
                    { label: '误读风险', instruction: '指出最容易被当成气氛或表面修辞的结构性部分。' },
                    { label: '下一步', instruction: '给出继续阅读、修改或延展时最值得做的动作。' },
                ];
            case 'market':
                return [
                    { label: '主判断', instruction: '先给当前市场或文本最核心的 thesis。' },
                    { label: '时间锚点', instruction: '先把用户当前时间当作判断基准，并以这个时刻去拉最新资料。' },
                    { label: '叙事与资金流', instruction: '拆开 headline、story、真实 flow，不要混写。' },
                    { label: '结构', instruction: '说明当前处在什么结构、接受区或阶段。' },
                    { label: '研究拆解', instruction: '把问题拆成 3-4 个研究任务，先定义该验证什么。' },
                    { label: '验证晶格', instruction: '至少从价格、流动性、传播度或基本面中选 2-4 层交叉验证。' },
                    { label: '失效条件', instruction: '明确 thesis 在哪里失效，不能含糊。' },
                    { label: '风险栈', instruction: '列出最重要的 2-4 个风险，不要只说波动。' },
                    { label: '触发器', instruction: '给出接下来会改变判断的价格、事件或流动性触发器。' },
                    { label: '置信度', instruction: '说明为什么现在只能给到高、中或低置信度，不准装成确定。' },
                    { label: '执行边界', instruction: '把研究判断和执行决定分开，说明在什么条件下才进入仓位讨论。' },
                    { label: '下一步观察', instruction: '给出接下来最该盯的价格、流动性或事件问题。' },
                ];
            case 'design':
            default:
                return [
                    { label: '主判断', instruction: '先说界面真正塌在哪，不要先列建议。' },
                    { label: '色彩法则', instruction: '说明颜色职责如何分配，谁做场域、谁做结构、谁做信号。' },
                    { label: '材质与构图', instruction: '判断表面语义、块面主次、视觉路径和版式重心。' },
                    { label: '动效法则', instruction: '只写有因果的 motion，说明它替什么关系运输能量。' },
                    { label: '误传信息', instruction: '指出这个作品不小心对用户说了什么。' },
                    { label: '下一步', instruction: '给一个最小但最强的重做动作。' },
                ];
        }
    })();
    const contradiction = contradictionSection(input, 'zh');
    if (contradiction.length > 0)
        sections.splice(1, 0, ...contradiction);
    return sections;
}
function enSections(field, input) {
    const sections = (() => {
        switch (field) {
            case 'literature':
                return [
                    { label: 'Thesis', instruction: 'Lead with a real reading, not a summary of content.' },
                    { label: 'Texture', instruction: 'Name where touch, density, breath, and pressure are coming from.' },
                    { label: 'Structure', instruction: 'Show how the passage turns, repeats, tightens, or folds.' },
                    { label: 'Line of force', instruction: 'State what force is actually driving the language.' },
                    { label: 'Risk of misreading', instruction: 'Identify what looks atmospheric but is actually structural.' },
                    { label: 'Next move', instruction: 'Give the strongest next reading or revision move.' },
                ];
            case 'market':
                return [
                    { label: 'Thesis', instruction: 'State the core market thesis first.' },
                    { label: 'Time anchor', instruction: 'Anchor the analysis to the user current-time first and query the freshest available data around that moment.' },
                    { label: 'Narrative vs flow', instruction: 'Separate headline, story, and actual flow; do not blend them.' },
                    { label: 'Structure', instruction: 'Describe the current phase, acceptance zone, or structural condition.' },
                    { label: 'Research map', instruction: 'Break the problem into 3-4 research tasks before trying to conclude.' },
                    { label: 'Validation lattice', instruction: 'Cross-check the thesis through 2-4 layers such as price, flow, dissemination, or fundamentals.' },
                    { label: 'Invalidation', instruction: 'State exactly where the thesis fails.' },
                    { label: 'Risk stack', instruction: 'List the 2-4 real risks that matter most.' },
                    { label: 'Trigger map', instruction: 'Name the prices, events, or flow changes that would update the judgment.' },
                    { label: 'Confidence', instruction: 'Explain why the current confidence is high, medium, or low instead of performing certainty.' },
                    { label: 'Execution boundary', instruction: 'Keep research and execution separate; say what must be confirmed before position-taking is discussed.' },
                    { label: 'Next observations', instruction: 'Name the next prices, flows, or events worth watching.' },
                ];
            case 'design':
            default:
                return [
                    { label: 'Judgment', instruction: 'Say what is structurally wrong before offering fixes.' },
                    { label: 'Palette law', instruction: 'Explain color responsibility: field, structure, and signal.' },
                    { label: 'Material and composition', instruction: 'Judge surface semantics, dominant masses, scan path, and visual center of gravity.' },
                    { label: 'Motion law', instruction: 'Only describe motion with causality and hierarchy value.' },
                    { label: 'Accidental message', instruction: 'State what the work is unintentionally telling the user.' },
                    { label: 'Next move', instruction: 'Give one smallest high-leverage redesign action.' },
                ];
        }
    })();
    const contradiction = contradictionSection(input, 'en');
    if (contradiction.length > 0)
        sections.splice(1, 0, ...contradiction);
    return sections;
}
export function buildResponseScaffold(proposal, locale, stage, options = {}) {
    const field = fieldForProposal(proposal);
    if (!field)
        return undefined;
    const sections = locale === 'zh'
        ? zhSections(field, options.input)
        : enSections(field, options.input);
    const title = locale === 'zh'
        ? field === 'design'
            ? '设计进入骨架'
            : field === 'literature'
                ? '文学进入骨架'
                : '市场进入骨架'
        : field === 'design'
            ? 'Design Entry Scaffold'
            : field === 'literature'
                ? 'Literary Entry Scaffold'
                : 'Market Entry Scaffold';
    const openingInstruction = locale === 'zh'
        ? stage === 'threshold'
            ? '如果还在阈值上，只先透露第一段判断，不要把整套分析一次说完。'
            : '阈值已过，按下面顺序回答，让第一句就显出判断力。'
        : stage === 'threshold'
            ? 'If you are still at the threshold, reveal only the first serious reading rather than dumping the whole analysis.'
            : 'The threshold has been crossed. Answer in this order so the first sentence already carries judgment.';
    const closingInstruction = locale === 'zh'
        ? '不要把这些标题机械地当作格式化输出。保留仪式感，但结构必须清晰可感。'
        : 'Do not render these labels mechanically unless useful. Preserve ceremony, but keep the structure clearly felt.';
    return {
        field,
        title,
        openingInstruction,
        sections,
        closingInstruction,
    };
}
//# sourceMappingURL=response-scaffold.js.map