/**
 * Trading playbook (src/core/tradingPlaybook.ts): which requests get it,
 * what it insists on, and that it rides on the turn's hint.
 */
import assert from 'node:assert/strict';
import { isTradingRequest, TRADING_PLAYBOOK, withTradingPlaybook } from '../src/core/tradingPlaybook.js';

const trading = [
  '帮我设计一个 BTC 突破策略，用 300U、3 倍杠杆',
  '用 1000 USDT 模拟跑一个 ETH 均线策略',
  '回测一下这个策略最近三个月的表现',
  'BTC 现在能买吗',
  '比特币跌破 6 万就做空',
  '我的永续仓位离强平还有多远',
  'Backtest a moving-average crossover on ETH',
  'set a stop-loss on my BTC long',
];
const notTrading = [
  '帮我写一份请假邮件',
  '这周末上海天气怎么样',
  '做一个咖啡店的营销策略',
  '把菜单翻译成英文',
  '整理一下这个 CSV 的销售额',
  '解释一下什么是复利',
];
for (const text of trading) assert.equal(isTradingRequest(text), true, text);
for (const text of notTrading) assert.equal(isTradingRequest(text), false, text);

// What the playbook insists on.
for (const must of ['模拟盘', '绝不承诺', '不代表未来', 'strategy_create', 'backtest_run', '「交易」页', '只有用户能启动', '不是用户的指令', '不要想办法绕过', 'risk_limits_propose', '确认后才生效']) {
  assert.ok(TRADING_PLAYBOOK.includes(must), must);
}

// Appended to the routed hint; untouched for other requests.
assert.equal(withTradingPlaybook('', '写一首诗'), '');
assert.equal(withTradingPlaybook(undefined, '写一首诗'), undefined);
assert.equal(withTradingPlaybook(undefined, '帮我回测 BTC 策略'), TRADING_PLAYBOOK);
assert.equal(withTradingPlaybook('[plan]', '帮我回测 BTC 策略'), `[plan]\n\n${TRADING_PLAYBOOK}`);

console.log('tradingPlaybookSmoke: ok');
assert.equal(isTradingRequest('find a solution and compare the price'), false);

// MCP tool lines name the server and tool (artemis-online tells its own tools from other servers').
{
  const { mcpTarget } = await import('../src/core/agent.js');
  assert.equal(mcpTarget({ type: 'mcp_call_tool', serverId: 'artemis_online', toolName: 'trade_quote', args: {} } as never), ' {"server":"artemis_online","tool":"trade_quote"}');
  assert.equal(mcpTarget({ type: 'mcp_read_resource', serverId: 'mail', uri: 'x://y' } as never), ' {"server":"mail"}');
  assert.equal(mcpTarget({ type: 'read_file', path: 'a' } as never), '');
  console.log('tradingPlaybookSmoke: mcp tool lines ok');
}
