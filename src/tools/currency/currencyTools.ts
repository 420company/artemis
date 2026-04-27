/**
 * Currency conversion tools — backed by open.er-api.com (free, no key).
 *
 * The API returns USD-pivoted rates and is updated daily. For an ambient
 * traveler agent ("how much is 5000 THB in USD?") this is plenty.
 *
 * In-memory cache: rates change once a day, so caching for 30 minutes is
 * safe and saves repeated API calls.
 */

const API_BASE = 'https://open.er-api.com/v6/latest';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

interface RatesPayload {
  result: string;
  base_code: string;
  rates: Record<string, number>;
  time_last_update_utc?: string;
}

const cache: Map<string, { fetched: number; data: RatesPayload }> = new Map();

async function getRates(base: string): Promise<RatesPayload | { error: string }> {
  const upper = base.toUpperCase();
  const cached = cache.get(upper);
  if (cached && Date.now() - cached.fetched < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const resp = await fetch(`${API_BASE}/${upper}`);
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const json = (await resp.json()) as RatesPayload;
    if (json.result !== 'success') {
      return { error: `API said: ${json.result}` };
    }
    cache.set(upper, { fetched: Date.now(), data: json });
    return json;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
}

export interface CurrencyConvertAction {
  type: 'currency_convert';
  amount: number;
  from: string; // ISO 4217 like USD, CNY, THB, EUR
  to: string;
}

export interface CurrencyRatesAction {
  type: 'currency_rates';
  base: string;
  targets?: string[]; // optional list, default to common ones
}

const COMMON_TARGETS = ['USD', 'EUR', 'CNY', 'JPY', 'THB', 'SGD', 'HKD', 'GBP', 'KRW'];

function normalizeCode(code: string): string {
  // Map common aliases
  const c = code.trim().toUpperCase();
  const aliases: Record<string, string> = {
    'RMB': 'CNY', '人民币': 'CNY', 'YUAN': 'CNY',
    'USD$': 'USD', '$': 'USD', '美元': 'USD', 'DOLLAR': 'USD',
    '€': 'EUR', 'EURO': 'EUR', '欧元': 'EUR',
    '泰铢': 'THB', 'BAHT': 'THB',
    '日元': 'JPY', 'YEN': 'JPY', '￥': 'JPY',
    '港币': 'HKD', '港元': 'HKD',
    '韩元': 'KRW', 'WON': 'KRW',
    '英镑': 'GBP', 'POUND': 'GBP', '£': 'GBP',
    '新元': 'SGD', '新加坡元': 'SGD',
  };
  return aliases[c] ?? c;
}

export async function executeCurrencyConvert(action: CurrencyConvertAction): Promise<ToolResult> {
  if (!Number.isFinite(action.amount)) {
    return {
      ok: false,
      output: '金额必须是有效数字',
      error: { code: 'invalid_amount', message: 'amount must be a finite number' },
    };
  }
  const from = normalizeCode(action.from);
  const to = normalizeCode(action.to);
  if (from.length !== 3 || to.length !== 3) {
    return {
      ok: false,
      output: `货币代码格式错误（需要 3 字母 ISO 代码，如 USD/CNY/THB）：from="${action.from}", to="${action.to}"`,
      error: { code: 'invalid_code', message: 'invalid currency code' },
    };
  }
  const rates = await getRates(from);
  if ('error' in rates) {
    return {
      ok: false,
      output: `汇率查询失败：${rates.error}`,
      error: { code: 'rates_error', message: rates.error },
    };
  }
  const rate = rates.rates[to];
  if (typeof rate !== 'number') {
    return {
      ok: false,
      output: `不支持的货币：${to}`,
      error: { code: 'unknown_target', message: to },
    };
  }
  const converted = action.amount * rate;
  // Format with 2 decimals for big amounts, more decimals for small fractional rates
  const fmt = (n: number): string => n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 1 ? 6 : 2,
  });
  return {
    ok: true,
    output: [
      `💱 ${fmt(action.amount)} ${from} = ${fmt(converted)} ${to}`,
      `   汇率 1 ${from} = ${rate.toFixed(6)} ${to}${rates.time_last_update_utc ? ` · 更新 ${rates.time_last_update_utc}` : ''}`,
    ].join('\n'),
  };
}

export async function executeCurrencyRates(action: CurrencyRatesAction): Promise<ToolResult> {
  const base = normalizeCode(action.base);
  if (base.length !== 3) {
    return {
      ok: false,
      output: `基础货币代码错误：${action.base}`,
      error: { code: 'invalid_code', message: 'invalid base code' },
    };
  }
  const rates = await getRates(base);
  if ('error' in rates) {
    return {
      ok: false,
      output: `汇率查询失败：${rates.error}`,
      error: { code: 'rates_error', message: rates.error },
    };
  }
  const targets = (action.targets && action.targets.length > 0
    ? action.targets.map(normalizeCode)
    : COMMON_TARGETS
  ).filter((t) => t !== base);
  const lines: string[] = [`💱 1 ${base} = `];
  for (const t of targets) {
    const r = rates.rates[t];
    if (typeof r !== 'number') {
      lines.push(`   ${t.padEnd(4)}: 不支持`);
    } else {
      lines.push(`   ${t.padEnd(4)}: ${r.toFixed(4)}`);
    }
  }
  if (rates.time_last_update_utc) lines.push(`   · 更新 ${rates.time_last_update_utc}`);
  return { ok: true, output: lines.join('\n') };
}
