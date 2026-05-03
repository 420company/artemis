import { formatPct, formatPrice } from './market-data.js';
import { buildFinanceFreshnessBrief } from './finance-freshness.js';
import type { RitualLocale } from './types.js';

export interface FinancialHeadline {
  title: string;
  url: string;
  publisher: string;
  publishedAt: string | null;
}

export interface FinancialLiveSpot {
  symbol: string;
  lastPrice: number;
  priceChangePct: number;
  volume: number;
  fetchedAt: string;
  source: string;
}

export interface FinancialLiveDerivatives {
  symbol: string;
  fundingRate: number | null;
  markPrice: number | null;
  openInterest: number | null;
  fetchedAt: string;
  source: string;
}

export interface FinancialLiveContext {
  query: string;
  locale: RitualLocale;
  referenceTimeIso: string;
  symbol?: string;
  spot?: FinancialLiveSpot;
  derivatives?: FinancialLiveDerivatives;
  headlines: FinancialHeadline[];
  warnings: string[];
}

const CRYPTO_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'SUI'];

function detectLocale(text: string): RitualLocale {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en';
}

function escapeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function inferMarketSymbol(input: string): string | undefined {
  const upper = input.toUpperCase();

  for (const base of CRYPTO_SYMBOLS) {
    if (new RegExp(`\\b${base}(?:USDT)?\\b`).test(upper)) {
      return upper.includes(`${base}USDT`) ? `${base}USDT` : `${base}USDT`;
    }
  }

  return undefined;
}

function buildNewsQuery(input: string, symbol?: string): string {
  if (symbol) {
    const base = symbol.replace(/USDT$/i, '');
    return `${base} crypto market`;
  }

  return input
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'phosphene/1.0',
      'Accept': 'application/json, text/plain, */*',
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return await response.json() as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'phosphene/1.0',
      'Accept': 'application/rss+xml, application/xml, text/xml, text/plain, */*',
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return await response.text();
}

export async function fetchLiveSpot(symbol: string): Promise<FinancialLiveSpot> {
  const payload = await fetchJson<Record<string, string | number>>(
    `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol.toUpperCase()}`,
  );

  return {
    symbol: String(payload.symbol),
    lastPrice: Number(payload.lastPrice),
    priceChangePct: Number(payload.priceChangePercent),
    volume: Number(payload.volume),
    fetchedAt: new Date().toISOString(),
    source: 'Binance spot ticker/24hr',
  };
}

export async function fetchLiveDerivatives(symbol: string): Promise<FinancialLiveDerivatives> {
  const upper = symbol.toUpperCase();
  const [fundingPayload, oiPayload, premiumPayload] = await Promise.all([
    fetchJson<Array<Record<string, string>>>(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${upper}&limit=1`),
    fetchJson<Record<string, string>>(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${upper}`),
    fetchJson<Record<string, string>>(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${upper}`),
  ]);

  const latestFunding = fundingPayload[0] ?? null;

  return {
    symbol: upper,
    fundingRate: latestFunding ? Number(latestFunding.fundingRate) : null,
    markPrice: premiumPayload.markPrice ? Number(premiumPayload.markPrice) : null,
    openInterest: oiPayload.openInterest ? Number(oiPayload.openInterest) : null,
    fetchedAt: new Date().toISOString(),
    source: 'Binance futures funding/open-interest/premium-index',
  };
}

export function parseGoogleNewsRss(xml: string): FinancialHeadline[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

  return items.map((item) => {
    const block = item[1] ?? '';
    const title = escapeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim();
    const url = escapeXml(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '').trim();
    const publisher = escapeXml(block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? 'Google News').trim();
    const publishedAt = escapeXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '').trim() || null;

    return {
      title,
      url,
      publisher,
      publishedAt,
    };
  }).filter(item => item.title && item.url).slice(0, 5);
}

export async function fetchGoogleNewsHeadlines(query: string): Promise<FinancialHeadline[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchText(url);
  return parseGoogleNewsRss(xml);
}

export async function fetchFinancialLiveContext(
  input: string,
  options: {
    locale?: RitualLocale;
    referenceTime?: string | Date;
    symbol?: string;
  } = {},
): Promise<FinancialLiveContext> {
  const locale = options.locale ?? detectLocale(input);
  const referenceTimeIso = typeof options.referenceTime === 'string'
    ? new Date(options.referenceTime).toISOString()
    : options.referenceTime instanceof Date
      ? options.referenceTime.toISOString()
      : new Date().toISOString();
  const symbol = options.symbol ?? inferMarketSymbol(input);
  const query = buildNewsQuery(input, symbol);

  const warnings: string[] = [];

  const [spotResult, derivativesResult, newsResult] = await Promise.allSettled([
    symbol ? fetchLiveSpot(symbol) : Promise.resolve(undefined),
    symbol ? fetchLiveDerivatives(symbol) : Promise.resolve(undefined),
    fetchGoogleNewsHeadlines(query),
  ]);

  const context: FinancialLiveContext = {
    query: input,
    locale,
    referenceTimeIso,
    symbol,
    headlines: [],
    warnings,
  };

  if (spotResult.status === 'fulfilled') {
    context.spot = spotResult.value;
  } else if (symbol) {
    warnings.push(locale === 'zh'
      ? `现货快照获取失败: ${spotResult.reason instanceof Error ? spotResult.reason.message : String(spotResult.reason)}`
      : `Spot snapshot failed: ${spotResult.reason instanceof Error ? spotResult.reason.message : String(spotResult.reason)}`);
  }

  if (derivativesResult.status === 'fulfilled') {
    context.derivatives = derivativesResult.value;
  } else if (symbol) {
    warnings.push(locale === 'zh'
      ? `衍生品上下文获取失败: ${derivativesResult.reason instanceof Error ? derivativesResult.reason.message : String(derivativesResult.reason)}`
      : `Derivatives context failed: ${derivativesResult.reason instanceof Error ? derivativesResult.reason.message : String(derivativesResult.reason)}`);
  }

  if (newsResult.status === 'fulfilled') {
    context.headlines = newsResult.value;
  } else {
    warnings.push(locale === 'zh'
      ? `新闻抓取失败: ${newsResult.reason instanceof Error ? newsResult.reason.message : String(newsResult.reason)}`
      : `News fetch failed: ${newsResult.reason instanceof Error ? newsResult.reason.message : String(newsResult.reason)}`);
  }

  if (!context.spot && !context.derivatives && context.headlines.length === 0) {
    warnings.push(locale === 'zh'
      ? '当前没有拉到最新外部资料，只能保留结构性阅读。'
      : 'No fresh external context could be retrieved, so this should remain a structural reading.');
  }

  return context;
}

export function renderFinancialLiveContext(context: FinancialLiveContext): string {
  const zh = context.locale === 'zh';
  const lines: string[] = [
    zh ? '【Phosphene Live Finance Context】' : '[Phosphene Live Finance Context]',
    `${zh ? '参考时间' : 'Reference time'}: ${context.referenceTimeIso}`,
    `${zh ? '查询' : 'Query'}: ${context.query}`,
  ];

  if (context.symbol) {
    lines.push(`${zh ? '符号' : 'Symbol'}: ${context.symbol}`);
  }

  if (context.spot) {
    lines.push(
      `${zh ? '现货' : 'Spot'}: ${formatPrice(context.spot.lastPrice)} (${formatPct(context.spot.priceChangePct)}) · ${zh ? '成交量' : 'volume'} ${context.spot.volume.toLocaleString('en-US')} · ${context.spot.source}`,
    );
  }

  if (context.derivatives) {
    const funding = context.derivatives.fundingRate == null
      ? (zh ? '无' : 'n/a')
      : `${(context.derivatives.fundingRate * 100).toFixed(4)}%`;
    const openInterest = context.derivatives.openInterest == null
      ? (zh ? '无' : 'n/a')
      : context.derivatives.openInterest.toLocaleString('en-US');
    const mark = context.derivatives.markPrice == null
      ? (zh ? '无' : 'n/a')
      : formatPrice(context.derivatives.markPrice);

    lines.push(
      `${zh ? '衍生品' : 'Derivatives'}: ${zh ? '资金费率' : 'funding'} ${funding} · ${zh ? '未平仓量' : 'open interest'} ${openInterest} · ${zh ? '标记价格' : 'mark'} ${mark} · ${context.derivatives.source}`,
    );
  }

  if (context.headlines.length > 0) {
    lines.push(`${zh ? '最新头条' : 'Latest headlines'}:`);
    for (const headline of context.headlines) {
      lines.push(`- ${headline.title} (${headline.publisher}${headline.publishedAt ? ` · ${headline.publishedAt}` : ''})`);
    }
  }

  if (context.warnings.length > 0) {
    lines.push(`${zh ? '警告' : 'Warnings'}:`);
    for (const warning of context.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}

export function renderFinancialLiveAudit(context: FinancialLiveContext): string {
  const zh = context.locale === 'zh';
  const liveDataAttached = Boolean(context.spot || context.derivatives || context.headlines.length > 0);
  const sourcesHit: string[] = [];
  const sourcesMissing: string[] = [];

  if (context.spot) {
    sourcesHit.push(zh ? '现货快照' : 'spot snapshot');
  } else if (context.symbol) {
    sourcesMissing.push(zh ? '现货快照' : 'spot snapshot');
  }

  if (context.derivatives) {
    sourcesHit.push(zh ? '衍生品上下文' : 'derivatives context');
  } else if (context.symbol) {
    sourcesMissing.push(zh ? '衍生品上下文' : 'derivatives context');
  }

  if (context.headlines.length > 0) {
    sourcesHit.push(zh ? '最新新闻' : 'latest headlines');
  } else {
    sourcesMissing.push(zh ? '最新新闻' : 'latest headlines');
  }

  const freshness = buildFinanceFreshnessBrief(context.locale, {
    referenceTime: context.referenceTimeIso,
    liveDataAttached,
    dataSource: sourcesHit.join(' / ') || (zh ? '无外部命中' : 'no external hits'),
  });

  const lines: string[] = [
    zh ? '【Phosphene Finance Audit】' : '[Phosphene Finance Audit]',
    `${zh ? '参考时间' : 'Reference time'}: ${freshness.referenceTimeIso}`,
    `${zh ? '数据状态' : 'Data status'}: ${freshness.dataStatus}`,
    `${zh ? '最新资料规则' : 'Latest data rule'}: ${freshness.latestDataRule}`,
    `${zh ? '命中来源' : 'Source hits'}: ${sourcesHit.length > 0 ? sourcesHit.join(' / ') : (zh ? '无' : 'none')}`,
    `${zh ? '缺失来源' : 'Missing sources'}: ${sourcesMissing.length > 0 ? sourcesMissing.join(' / ') : (zh ? '无' : 'none')}`,
    `${zh ? '警告数量' : 'Warning count'}: ${context.warnings.length}`,
  ];

  if (context.warnings.length > 0) {
    lines.push(`${zh ? '警告' : 'Warnings'}:`);
    for (const warning of context.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}
