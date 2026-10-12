#!/usr/bin/env node
// scripts/evalZh/tradingDeskStub.mjs — a stand-in for the platform's paper
// trading tools (artemis-online's `artemis_online` MCP server), for the
// trading eval tasks. Stdio MCP, newline-delimited JSON-RPC. Answers are
// canned but shaped like the real server's: strategies become drafts the
// owner must start, backtests carry a disclaimer, and every order waits for
// the owner's confirmation (so a task can check the agent does not claim a
// fill). Nothing leaves this process.
import { createInterface } from 'node:readline'

import { TOOLS } from './tradingDeskTools.mjs'

let strategies = 0

function call(name, args) {
  switch (name) {
    case 'trade_quote':
      return { market: `${args.market}:${String(args.symbol ?? 'BTCUSDT').toUpperCase()}`, bid: 62_010.5, ask: 62_011.5, mark: 62_011, mode: 'paper' }
    case 'trade_paper_order':
      return {
        status: 'pending',
        mode: 'paper',
        message: 'Not placed yet: the owner must confirm this order on the 交易 page (it expires in 10 minutes). Tell the owner; do not say it was filled.',
        order: { id: 'ord_eval_1', market: `${args.market}:${args.symbol}`, action: args.action },
      }
    case 'positions':
      return { perps: [], spot: [], cash: 10_000, equity: 10_000, mode: 'paper' }
    case 'pnl':
      return { range: args.range ?? 'today', mode: 'paper', equityUsd: 10_000, pnlUsd: 0, note: 'Paper trading (simulated, no real funds).' }
    case 'strategy_create': {
      const dsl = args.dsl && typeof args.dsl === 'object' ? args.dsl : {}
      const problems = []
      if (dsl.market?.kind === 'perp' && dsl.stopLossPct === undefined) problems.push('perpetual strategies must have a stop-loss')
      if ((dsl.leverage ?? 1) > 3) problems.push(`leverage ${dsl.leverage}x is above the limit of 3x`)
      strategies++
      return {
        id: `st_eval_${strategies}`,
        status: 'draft',
        name: dsl.name ?? 'strategy',
        problems,
        description: ['BTC 永续 · 1 小时 K 线 · 做多', '开仓：收盘价突破前 20 根 K 线的最高价', '平仓：止损 2%，止盈 4%'],
        next: 'Run backtest_run with this strategyId, then tell the owner the result and that they can start it in paper mode on the 交易 page (only the owner can start it).',
      }
    }
    case 'strategy_list':
      return { strategies: [], mode: 'paper' }
    case 'backtest_run':
      return {
        strategyId: args.strategyId ?? null,
        days: 90,
        metrics: { initialUsd: 10_000, finalEquity: 10_412.3, totalReturnPct: 4.12, maxDrawdownPct: 6.85, trades: 31, winRatePct: 41.9, profitFactor: 1.18, sharpe: 0.74, feesPaid: 38.2, fundingPaid: 4.1, buyHoldReturnPct: 9.6, liquidations: 0 },
        notes: [],
        disclaimer: 'Backtest on historical candles with fees and slippage; past results do not predict future returns. Say so when you report it.',
      }
    case 'strategy_update':
    case 'strategy_pause':
      return { id: args.id, status: 'paused' }
    case 'strategy_delete':
      return { deleted: args.id }
    default:
      return undefined
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'artemis_online', version: 'eval' } })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'resources/list':
      return reply({ resources: [] })
    case 'prompts/list':
      return reply({ prompts: [] })
    case 'tools/call': {
      const result = call(msg.params?.name, msg.params?.arguments ?? {})
      if (result === undefined) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } })
      return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result })
    }
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
  }
})
