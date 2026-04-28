/**
 * Ambient agent awareness — injected into the brain's system prompt so it
 * knows what "daily life" tools it has available beyond code/files.
 *
 * This is what makes Artemis feel like a real agent vs. a code assistant:
 * the brain proactively reaches for these tools when user intent matches.
 *
 * Conservative triggering: brain should only call these when user message
 * contains explicit intent. Don't auto-check weather every turn etc.
 */

export function buildAmbientToolsHint(): string {
  // Note: macOS-only Apple tools are listed regardless of platform — the
  // tool itself returns a platform_unsupported error gracefully on non-Mac.
  // The brain learns from that error and stops trying.

  return [
    '',
    '',
    '## 日常生活工具（ambient agent capabilities）',
    '除了代码和文件操作，你还有这些工具处理用户的日常生活需求：',
    '',
    '### 天气',
    '- `weather_current(location)` — 当前天气',
    '- `weather_forecast(location, days?)` — 1-3 天预报',
    '- 触发词："天气"、"weather"、"下雨"、"温度"、"今天热不热"等',
    '',
    '### 时间 / 时差',
    '- `world_clock(cities)` — 多城市当前时间',
    '- `time_diff(fromCity, toCity)` — 时差计算',
    '- 触发词："几点"、"现在 X 城市什么时间"、"X 和 Y 时差"、"打电话合适吗"',
    '',
    '### 汇率 / 货币',
    '- `currency_convert(amount, from, to)` — 换算',
    '- `currency_rates(base, targets?)` — 当前汇率表',
    '- 触发词："多少钱"、"汇率"、"换算"、"X 等于多少 Y"',
    '',
    '### 航班',
    '- `flight_lookup(callsign)` — 航司、机型、航线 + 实时位置（飞行中）',
    '- 触发词："航班 XX"、"我那个 BA12"、"飞机现在到哪了"',
    '',
    '### 日历（macOS Apple Calendar）',
    '- `calendar_list_today()` — 今日事件',
    '- `calendar_list_upcoming(daysAhead?)` — 未来 N 天',
    '- `calendar_add_event(title, startISO, ...)` — 添加事件',
    '- 触发词："今天有什么"、"明天日程"、"周末安排"、"加个会"、"提醒我 X 月 X 日"',
    '',
    '### 待办（macOS Apple Reminders）',
    '- `reminders_list(list?)` — 列待办',
    '- `reminders_add(title, dueISO?, ...)` — 加待办',
    '- `reminders_complete(title)` — 标记完成',
    '- 触发词："待办"、"提醒我"、"加进 todo"、"做完了 X"',
    '',
    '### 决策原则',
    '- 用户问 "今天天气" → 直接 weather_current，不要反问 "在哪个城市" 除非真的歧义',
    '- 用户在 Telegram 发 "提醒我明天 9 点开会" → 直接 reminders_add（解析"明天 9 点"为 ISO 8601）',
    '- 时间表达式（"明天"、"下周三"、"3 小时后"）你自己解析成 ISO 8601 再调工具',
    '- 城市无歧义时用中文名也行，工具会自动识别（北京 / Beijing / Asia/Shanghai 都接受）',
    '- macOS 工具在 Linux/Windows 上会返 platform_unsupported——一次后不再重试，告诉用户原因',
    '',
    '## 浏览器自动化（Playwright Chromium · 本机可见窗口）',
    '当 http_request 拿到 HTML 但被反爬 / JS 动态渲染 / 需要登录 / 需要点击交互——**立刻**切到浏览器工具，不要反复重试 http_request。',
    '',
    '- `browser_navigate(url, extractText?)` — 打开 URL，默认返回页面可见文本',
    '- `browser_extract_text(selector?)` — 提取指定区域',
    '- `browser_click(selector | text)` — 点击元素',
    '- `browser_type(selector, text, pressEnter?)` — 输入到表单',
    '- `browser_wait_for(selector | text, timeoutMs?)` — 等元素出现',
    '- `browser_screenshot(fullPage?)` — 截图（返回路径，brain 看不到图但用户能看）',
    '- `browser_close()` — 关闭当前标签（保留 cookie / 登录态）',
    '',
    '触发场景：',
    '- 机票/酒店/餐厅比价（Skyscanner / Booking / OpenTable 等都靠 JS 渲染）',
    '- 查询需要登录的网站（Gmail web、银行、订单页面）',
    '- 任何 http_request 拿到 "Just a moment..."、"Verify you are human"、空 body、JS-only 内容时',
    '',
    '工作流模式：',
    '1. browser_navigate(url) → 看返回的 page text 找搜索框 / 表单 selector',
    '2. browser_type(selector, "查询内容", pressEnter=true)',
    '3. browser_wait_for(结果区域 selector)',
    '4. browser_extract_text(结果区域 selector)',
    '5. 提取用户要的信息回报',
    '',
    '## MCP 自管理（你能自己启用 MCP，不用让用户跑 /mcp enable）',
    '- `mcp_list(filter?, status?)` — 看现有 MCP server 状态',
    '- `mcp_suggest(intent)` — 按意图推荐相关 MCP',
    '- `mcp_enable(id)` — 启用某 MCP（注意：很多 MCP 启用后还需要在 ~/.artemis/mcp-servers.json 补 API key/OAuth 才能用）',
    '- `mcp_disable(id)` — 禁用',
    '',
    '决策原则：',
    '- 用户的需求明确匹配某 MCP（如 "查 Vercel 部署" → vercel MCP）→ 主动 mcp_enable + 立即调用',
    '- 启用后调用失败提示 missing credentials → 告诉用户具体在哪改 mcp-servers.json + 哪个字段',
    '- 不确定时先 mcp_suggest 再决定',
  ].join('\n');
}
