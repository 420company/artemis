export interface Kline {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    closeTime: number;
}
export interface Ticker24h {
    symbol: string;
    priceChange: number;
    priceChangePct: number;
    weightedAvgPrice: number;
    prevClosePrice: number;
    lastPrice: number;
    lastQty: number;
    bidPrice: number;
    bidQty: number;
    askPrice: number;
    askQty: number;
    openPrice: number;
    highPrice: number;
    lowPrice: number;
    volume: number;
    quoteVolume: number;
    openTime: number;
    closeTime: number;
    count: number;
}
export interface OrderBookLevel {
    price: number;
    qty: number;
}
export interface OrderBook {
    symbol: string;
    lastUpdateId: number;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
}
export type KlineInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '8h' | '12h' | '1d' | '3d' | '1w' | '1M';
export interface MarketSnapshot {
    symbol: string;
    interval: KlineInterval;
    klines: Kline[];
    ticker: Ticker24h;
    orderBook: OrderBook;
    fetchedAt: number;
}
/**
 * Fetch OHLCV klines from Binance.
 * Default: last 200 candles of 1h interval for BTCUSDT.
 */
export declare function fetchKlines(symbol: string, interval?: KlineInterval, limit?: number): Promise<Kline[]>;
/**
 * Fetch 24h ticker statistics.
 */
export declare function fetchTicker(symbol: string): Promise<Ticker24h>;
/**
 * Fetch order book depth (top N bids/asks).
 */
export declare function fetchOrderBook(symbol: string, limit?: number): Promise<OrderBook>;
/**
 * Fetch everything in parallel and return a snapshot.
 */
export declare function fetchMarketSnapshot(symbol: string, interval?: KlineInterval, klineLimit?: number): Promise<MarketSnapshot>;
export declare function formatPrice(price: number, decimals?: number): string;
export declare function formatPct(pct: number): string;
//# sourceMappingURL=market-data.d.ts.map