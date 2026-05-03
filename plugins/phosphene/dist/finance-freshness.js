function toIso(referenceTime) {
    if (referenceTime instanceof Date)
        return referenceTime.toISOString();
    if (typeof referenceTime === 'number')
        return new Date(referenceTime).toISOString();
    if (typeof referenceTime === 'string')
        return new Date(referenceTime).toISOString();
    return new Date().toISOString();
}
export function buildFinanceFreshnessBrief(locale, options = {}) {
    const iso = toIso(options.referenceTime);
    const source = options.dataSource ?? (locale === 'zh' ? '外部市场/新闻/链上资料' : 'external market / news / on-chain sources');
    if (locale === 'zh') {
        return {
            title: '金融时间锚点',
            referenceTimeIso: iso,
            timeBasis: `所有金融判断都以用户当前请求时刻为锚点。当前参考时间: ${iso}`,
            latestDataRule: options.liveDataAttached
                ? `这次输出已经附着最新可用数据快照；仍然要把 ${iso} 作为判断时刻，不要混入更早时段的陈旧结论。`
                : `在形成最终金融判断前，必须先查询用户当前时刻附近的最新资料，再反馈。当前应以 ${iso} 为“现在”。`,
            staleDataRule: '如果拿不到最新资料，必须明确说“当前无法完成实时确认”，不能把旧价格、旧新闻、旧宏观状态伪装成现在。',
            dataStatus: options.liveDataAttached
                ? `最新数据状态: 已附着实时/近实时数据来源 (${source})。`
                : '最新数据状态: 当前仅有结构性阅读，还没有附着实时外部资料。',
            sourceChecklist: [
                '先看最新价格/成交/流动性，再看叙事。',
                '涉及事件驱动时，先查最新新闻、公告、财报或宏观时点。',
                '涉及加密时，优先补链上、杠杆、资金费率和清算数据。',
            ],
        };
    }
    return {
        title: 'Finance Time Anchor',
        referenceTimeIso: iso,
        timeBasis: `All financial judgments are anchored to the user's current request-time. Current reference time: ${iso}`,
        latestDataRule: options.liveDataAttached
            ? `This output already carries a fresh market snapshot, but ${iso} still defines the judgment time. Do not let older conclusions leak in as if they were current.`
            : `Before finalizing any financial answer, query the freshest available data around the user's current time. Treat ${iso} as now.`,
        staleDataRule: 'If fresh data cannot be retrieved, say that real-time confirmation is unavailable. Do not present stale prices, stale news, or stale macro states as current.',
        dataStatus: options.liveDataAttached
            ? `Freshness status: live / near-real-time data is attached from ${source}.`
            : 'Freshness status: this is currently a structural reading without attached live external data.',
        sourceChecklist: [
            'Check latest price, volume, and liquidity before hardening the thesis.',
            'For event-driven views, query the newest news, filings, earnings, or macro releases first.',
            'For crypto, add on-chain, leverage, funding, and liquidation context before acting.',
        ],
    };
}
//# sourceMappingURL=finance-freshness.js.map