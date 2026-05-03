// Phosphene — Market Data
// Binance public REST API client. No API key required for market data.
// All price data is live; analysis layers are applied on top.
import https from 'https';
// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            timeout: 10_000,
            headers: {
                'User-Agent': 'phosphene/1.0',
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const status = res.statusCode ?? 0;
                try {
                    const parsed = JSON.parse(body);
                    if (status >= 400) {
                        const detail = !Array.isArray(parsed) && parsed
                            ? String(parsed['msg'] ?? parsed['message'] ?? body.slice(0, 200))
                            : body.slice(0, 200);
                        reject(new Error(`Binance API ${status}: ${detail}`));
                        return;
                    }
                    resolve(parsed);
                }
                catch (e) {
                    if (status >= 400) {
                        reject(new Error(`Binance API ${status}: ${body.slice(0, 200)}`));
                        return;
                    }
                    reject(new Error(`JSON parse error: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
}
const BASE = 'https://api.binance.com';
// ─── Endpoints ────────────────────────────────────────────────────────────────
/**
 * Fetch OHLCV klines from Binance.
 * Default: last 200 candles of 1h interval for BTCUSDT.
 */
export async function fetchKlines(symbol, interval = '1h', limit = 200) {
    const sym = symbol.toUpperCase();
    const url = `${BASE}/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
    const raw = await httpsGet(url);
    if (!Array.isArray(raw)) {
        throw new Error(`Unexpected Binance kline payload for ${sym}`);
    }
    return raw.map((k) => ({
        openTime: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: Number(k[6]),
    }));
}
/**
 * Fetch 24h ticker statistics.
 */
export async function fetchTicker(symbol) {
    const sym = symbol.toUpperCase();
    const url = `${BASE}/api/v3/ticker/24hr?symbol=${sym}`;
    const raw = await httpsGet(url);
    if (Array.isArray(raw) || raw == null) {
        throw new Error(`Unexpected Binance ticker payload for ${sym}`);
    }
    return {
        symbol: String(raw['symbol']),
        priceChange: parseFloat(raw['priceChange']),
        priceChangePct: parseFloat(raw['priceChangePercent']),
        weightedAvgPrice: parseFloat(raw['weightedAvgPrice']),
        prevClosePrice: parseFloat(raw['prevClosePrice']),
        lastPrice: parseFloat(raw['lastPrice']),
        lastQty: parseFloat(raw['lastQty']),
        bidPrice: parseFloat(raw['bidPrice']),
        bidQty: parseFloat(raw['bidQty']),
        askPrice: parseFloat(raw['askPrice']),
        askQty: parseFloat(raw['askQty']),
        openPrice: parseFloat(raw['openPrice']),
        highPrice: parseFloat(raw['highPrice']),
        lowPrice: parseFloat(raw['lowPrice']),
        volume: parseFloat(raw['volume']),
        quoteVolume: parseFloat(raw['quoteVolume']),
        openTime: Number(raw['openTime']),
        closeTime: Number(raw['closeTime']),
        count: Number(raw['count']),
    };
}
/**
 * Fetch order book depth (top N bids/asks).
 */
export async function fetchOrderBook(symbol, limit = 20) {
    const sym = symbol.toUpperCase();
    const url = `${BASE}/api/v3/depth?symbol=${sym}&limit=${limit}`;
    const raw = await httpsGet(url);
    if (!raw || !Array.isArray(raw.bids) || !Array.isArray(raw.asks)) {
        throw new Error(`Unexpected Binance order book payload for ${sym}`);
    }
    return {
        symbol: sym,
        lastUpdateId: raw.lastUpdateId,
        bids: raw.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
        asks: raw.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    };
}
/**
 * Fetch everything in parallel and return a snapshot.
 */
export async function fetchMarketSnapshot(symbol, interval = '1h', klineLimit = 200) {
    const sym = symbol.toUpperCase();
    const [klines, ticker, orderBook] = await Promise.all([
        fetchKlines(sym, interval, klineLimit),
        fetchTicker(sym),
        fetchOrderBook(sym, 20),
    ]);
    return { symbol: sym, interval, klines, ticker, orderBook, fetchedAt: Date.now() };
}
// ─── Formatting helpers ───────────────────────────────────────────────────────
export function formatPrice(price, decimals = 2) {
    if (price >= 1000)
        return price.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    if (price >= 1)
        return price.toFixed(4);
    return price.toFixed(8);
}
export function formatPct(pct) {
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(2)}%`;
}
//# sourceMappingURL=market-data.js.map