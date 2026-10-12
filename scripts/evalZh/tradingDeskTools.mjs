// The trading desk stub's tools (tradingDeskStub.mjs), also written into the
// task's MCP config by the worker so the agent sees them from the first turn.
const str = { type: 'string' }
const num = { type: 'number' }
const MARKET = { symbol: str, market: { type: 'string', enum: ['spot', 'perp'] } }
const DSL = { type: 'object', description: 'Strategy DSL: {name, market: {kind, symbol}, timeframe, direction, entry: {all|any: [cond]}, exit?, sizing, leverage?, stopLossPct, takeProfitPct?}' }

export const TOOLS = [
  { name: 'trade_quote', description: 'Price of a market and the expected fill of a paper order. Read-only.', inputSchema: { type: 'object', properties: { ...MARKET, side: str, usd: num }, required: ['symbol', 'market'] }, annotations: { readOnlyHint: true } },
  { name: 'trade_paper_order', description: 'Place a PAPER (simulated) order, only when the owner asked in this conversation. Perp opens need a stop-loss. Orders may wait for the owner to confirm on the 交易 page.', inputSchema: { type: 'object', properties: { ...MARKET, action: str, side: str, usd: num, leverage: num, stopLossPct: num, takeProfitPct: num, reason: str, idempotencyKey: str }, required: ['symbol', 'market', 'action', 'reason', 'idempotencyKey'] } },
  { name: 'positions', description: 'Open paper positions. Read-only.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'pnl', description: 'Paper P&L. Read-only.', inputSchema: { type: 'object', properties: { range: str } }, annotations: { readOnlyHint: true } },
  { name: 'strategy_create', description: 'Save a strategy draft (DSL). A draft never trades; only the owner can start it on the 交易 page.', inputSchema: { type: 'object', properties: { dsl: DSL, note: str }, required: ['dsl'] } },
  { name: 'strategy_list', description: 'Strategies. Read-only.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'strategy_update', description: 'Replace a strategy DSL.', inputSchema: { type: 'object', properties: { id: str, dsl: DSL }, required: ['id'] } },
  { name: 'strategy_pause', description: 'Pause a strategy.', inputSchema: { type: 'object', properties: { id: str }, required: ['id'] } },
  { name: 'strategy_delete', description: 'Delete a strategy, only when the owner asked.', inputSchema: { type: 'object', properties: { id: str }, required: ['id'] } },
  { name: 'backtest_run', description: 'Backtest a strategy on historical candles with fees and slippage. Read-only.', inputSchema: { type: 'object', properties: { strategyId: str, dsl: DSL, days: num } }, annotations: { readOnlyHint: true } },
]

