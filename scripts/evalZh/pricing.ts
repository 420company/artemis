/**
 * scripts/evalZh/pricing.ts — per-model token rates for live eval runs.
 *
 * Rates are USD per 1M tokens and are never committed: they come from a
 * local file (`--prices <file>`, `EVAL_ZH_PRICES=<file>`, or
 * `evals/prices.local.json`, which is git-ignored). See
 * `evals/prices.example.json` for the format (placeholder numbers only):
 *
 *   {
 *     "models": {
 *       "<model id as sent in requests>": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25, "cacheWrite1h": 2 },
 *       "<prefix>*": { ... }
 *     },
 *     "default": { ... }
 *   }
 *
 * `cacheRead` defaults to `input`, `cacheWrite` (5-minute writes, and writes
 * whose lifetime the provider does not report) to `input`, `cacheWrite1h` to
 * `cacheWrite`. The legacy `--price-in/--price-out` flags become the default
 * rate with every input token at `input`: an upper bound when the provider
 * caches prompts.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Usage } from './types.js'

export interface ModelRates {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  cacheWrite1h?: number
}

export interface PriceTable {
  models: Record<string, ModelRates>
  default?: ModelRates
  /** Where the rates came from (a file path or the flags), for the report. */
  source: string
}

/** Usage of one or more responses, split for billing. */
export interface BillableUsage {
  uncached: number
  cacheRead: number
  cacheWrite: number
  cacheWrite5m?: number
  cacheWrite1h?: number
  output: number
}

export const PRICES_ENV = 'EVAL_ZH_PRICES'
export const LOCAL_PRICES_FILE = path.join('evals', 'prices.local.json')

function rate(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`prices: ${label} must be a non-negative number`)
  return value
}

function parseRates(raw: unknown, label: string): ModelRates {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`prices: ${label} must be an object`)
  const record = raw as Record<string, unknown>
  const input = rate(record.input, `${label}.input`)
  const output = rate(record.output, `${label}.output`)
  if (input === undefined || output === undefined) throw new Error(`prices: ${label} needs "input" and "output"`)
  const known = new Set(['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'note'])
  const unknown = Object.keys(record).filter((key) => !known.has(key))
  if (unknown.length) throw new Error(`prices: ${label}: unknown field(s) ${unknown.join(', ')}`)
  const cacheRead = rate(record.cacheRead, `${label}.cacheRead`)
  const cacheWrite = rate(record.cacheWrite, `${label}.cacheWrite`)
  const cacheWrite1h = rate(record.cacheWrite1h, `${label}.cacheWrite1h`)
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
  }
}

/** Parse a rate table (the JSON of a prices file). */
export function parsePriceTable(raw: unknown, source: string): PriceTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`prices: ${source} is not a JSON object`)
  const record = raw as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => !['models', 'default', 'note'].includes(key))
  if (unknown.length) throw new Error(`prices: ${source}: unknown field(s) ${unknown.join(', ')}`)
  const models: Record<string, ModelRates> = {}
  if (record.models !== undefined) {
    if (!record.models || typeof record.models !== 'object' || Array.isArray(record.models)) throw new Error('prices: "models" must be an object')
    for (const [model, rates] of Object.entries(record.models as Record<string, unknown>)) models[model] = parseRates(rates, `models["${model}"]`)
  }
  const table: PriceTable = { models, source }
  if (record.default !== undefined) table.default = parseRates(record.default, 'default')
  if (!table.default && Object.keys(models).length === 0) throw new Error(`prices: ${source} has no rates`)
  return table
}

/**
 * The rate table for a run: the file given, else $EVAL_ZH_PRICES, else
 * evals/prices.local.json when present; the legacy flat prices fill the
 * default. Undefined when nothing is configured (cost is then reported in
 * tokens only).
 */
export function loadPriceTable(input: {
  repo: string
  file?: string
  priceIn?: number
  priceOut?: number
  env?: Record<string, string | undefined>
}): PriceTable | undefined {
  const env = input.env ?? process.env
  const local = path.join(input.repo, LOCAL_PRICES_FILE)
  const file = input.file ?? (env[PRICES_ENV]?.trim() || undefined) ?? (fs.existsSync(local) ? local : undefined)
  let table: PriceTable | undefined
  if (file) table = parsePriceTable(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')), file)
  if (input.priceIn !== undefined || input.priceOut !== undefined) {
    const flat: ModelRates = { input: input.priceIn ?? 0, output: input.priceOut ?? 0 }
    table = table
      ? { ...table, default: table.default ?? flat, source: `${table.source} + --price-in/--price-out` }
      : { models: {}, default: flat, source: '--price-in/--price-out (every input token at the input rate)' }
  }
  return table
}

/** Rates for a model: exact id, then the longest matching `prefix*`, then the default. */
export function ratesFor(table: PriceTable, model: string | undefined): ModelRates | undefined {
  if (model && table.models[model]) return table.models[model]
  if (model) {
    const prefix = Object.keys(table.models)
      .filter((key) => key.endsWith('*') && model.startsWith(key.slice(0, -1)))
      .sort((a, b) => b.length - a.length)[0]
    if (prefix) return table.models[prefix]
  }
  return table.default
}

/** USD for one response's usage; undefined when the model has no rates. */
export function priceUsage(table: PriceTable, model: string | undefined, usage: BillableUsage): number | undefined {
  const rates = ratesFor(table, model)
  if (!rates) return undefined
  const cacheRead = rates.cacheRead ?? rates.input
  const write5m = rates.cacheWrite ?? rates.input
  const write1h = rates.cacheWrite1h ?? write5m
  const longLived = Math.min(usage.cacheWrite, usage.cacheWrite1h ?? 0)
  const shortLived = usage.cacheWrite - longLived
  return (
    usage.uncached * rates.input +
    usage.cacheRead * cacheRead +
    shortLived * write5m +
    longLived * write1h +
    usage.output * rates.output
  ) / 1_000_000
}

/** Share of input tokens read from the cache (0 when nothing was sent). */
export function cacheHitRatio(usage: Usage): number {
  return usage.inputTokens > 0 ? (usage.cacheReadTokens ?? 0) / usage.inputTokens : 0
}
