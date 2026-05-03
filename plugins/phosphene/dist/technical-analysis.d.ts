import type { Kline } from './market-data.js';
export interface PriceLevel {
    price: number;
    label: string;
    type: 'support' | 'resistance' | 'pivot';
    strength: number;
}
export interface SwingPoint {
    index: number;
    price: number;
    type: 'high' | 'low';
    time: number;
}
export interface FibLevel {
    ratio: number;
    price: number;
    label: string;
    isKey: boolean;
}
export interface FibonacciResult {
    swingHigh: SwingPoint;
    swingLow: SwingPoint;
    direction: 'uptrend' | 'downtrend';
    retracements: FibLevel[];
    extensions: FibLevel[];
    currentPrice: number;
    nearestSupport: FibLevel | null;
    nearestResist: FibLevel | null;
    currentZone: string;
}
/**
 * Calculate Fibonacci retracement and extension levels from two swing points.
 */
export declare function calculateFibonacci(klines: Kline[]): FibonacciResult | null;
export type FractalType = '顶分型' | '底分型';
export type BiDirection = '上升笔' | '下降笔';
export type HubType = '上升中枢' | '下降中枢' | '震荡中枢';
export type BeiChiType = '顶背驰' | '底背驰';
export type BSP = '买点1' | '买点2' | '买点3' | '卖点1' | '卖点2' | '卖点3';
export interface ProcessedCandle {
    originalIndex: number;
    high: number;
    low: number;
    close: number;
    time: number;
    direction: 1 | -1 | 0;
}
export interface Fractal {
    index: number;
    type: FractalType;
    price: number;
    time: number;
    candleIdx: number;
}
export interface Bi {
    start: Fractal;
    end: Fractal;
    direction: BiDirection;
    length: number;
}
export interface Hub {
    bis: Bi[];
    type: HubType;
    high: number;
    low: number;
    center: number;
}
export interface BeiChi {
    type: BeiChiType;
    bi: Bi;
    macdArea1: number;
    macdArea2: number;
    confirmed: boolean;
}
export interface BuySellPoint {
    type: BSP;
    price: number;
    time: number;
    bi: Bi;
    beiChi?: BeiChi;
    note: string;
}
export interface ChanResult {
    processedCandles: ProcessedCandle[];
    fractals: Fractal[];
    bis: Bi[];
    hubs: Hub[];
    beiChiList: BeiChi[];
    buySellPoints: BuySellPoint[];
    currentStructure: string;
}
export declare function processInclusionRelationships(klines: Kline[]): ProcessedCandle[];
export declare function detectFractals(candles: ProcessedCandle[]): Fractal[];
export declare function detectBi(fractals: Fractal[], candles: ProcessedCandle[]): Bi[];
export declare function detectHubs(bis: Bi[]): Hub[];
interface MacdPoint {
    dif: number;
    dea: number;
    macd: number;
}
export declare function calculateMACD(closes: number[], fast?: number, slow?: number, signal?: number): MacdPoint[];
export declare function detectBeiChi(bis: Bi[], hubs: Hub[], klines: Kline[], macdPoints: MacdPoint[]): BeiChi[];
export declare function classifyBuySellPoints(bis: Bi[], hubs: Hub[], beiChiList: BeiChi[]): BuySellPoint[];
export declare function runChanLun(klines: Kline[]): ChanResult;
export interface TechnicalAnalysisResult {
    fibonacci: FibonacciResult | null;
    chanLun: ChanResult;
    summary: string;
}
export declare function analyzeTechnicals(klines: Kline[]): TechnicalAnalysisResult;
export {};
//# sourceMappingURL=technical-analysis.d.ts.map