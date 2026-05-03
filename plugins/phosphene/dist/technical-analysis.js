// Phosphene — Technical Analysis
//
// Two analytical frameworks:
//
// 1. Fibonacci — universal harmonic ratios applied to price swings.
//    Not mysticism. Pattern: markets retrace predictable proportions
//    of prior moves because enough participants act on those levels.
//
// 2. 缠论 (Chán Lùn / Chan Theory) — a complete market structure theory
//    developed by 缠中说禅 (pen name). Published ~2006–2008 on a Chinese blog.
//    Built on the premise that price action has fractal, self-similar structure
//    that can be fully formalized.
//
//    Pipeline:
//      raw klines → 包含关系处理 → 分型识别 → 笔识别 → 中枢识别 → 背驰识别 → 买卖点分类
//
// Both frameworks operate on the same kline data and complement each other:
// Fibonacci gives levels; 缠论 gives structure and directionality.
const RETRACE_RATIOS = [
    { ratio: 0, label: '0%', isKey: true },
    { ratio: 0.236, label: '23.6%', isKey: false },
    { ratio: 0.382, label: '38.2%', isKey: true },
    { ratio: 0.5, label: '50%', isKey: true },
    { ratio: 0.618, label: '61.8%', isKey: true },
    { ratio: 0.786, label: '78.6%', isKey: false },
    { ratio: 1, label: '100%', isKey: true },
];
const EXTENSION_RATIOS = [
    { ratio: 1.272, label: '127.2%', isKey: false },
    { ratio: 1.618, label: '161.8%', isKey: true },
    { ratio: 2, label: '200%', isKey: false },
    { ratio: 2.618, label: '261.8%', isKey: true },
];
/**
 * Find the most significant swing high and low within the kline window.
 * Uses a simple prominence-based algorithm: a pivot high is a candle whose
 * high is higher than the N candles on either side.
 */
function findSwingPoints(klines, lookback = 5) {
    const points = [];
    for (let i = lookback; i < klines.length - lookback; i++) {
        const k = klines[i];
        const leftHighs = klines.slice(i - lookback, i).map(c => c.high);
        const rightHighs = klines.slice(i + 1, i + lookback + 1).map(c => c.high);
        const leftLows = klines.slice(i - lookback, i).map(c => c.low);
        const rightLows = klines.slice(i + 1, i + lookback + 1).map(c => c.low);
        if (k.high > Math.max(...leftHighs) && k.high > Math.max(...rightHighs)) {
            points.push({ index: i, price: k.high, type: 'high', time: k.openTime });
        }
        if (k.low < Math.min(...leftLows) && k.low < Math.min(...rightLows)) {
            points.push({ index: i, price: k.low, type: 'low', time: k.openTime });
        }
    }
    return points;
}
/**
 * From the swing points, select the most significant recent swing high and low.
 * "Most significant" = the highest high and lowest low in the last third of candles.
 */
function selectPrimarySwings(klines) {
    const pivots = findSwingPoints(klines);
    if (pivots.length < 2)
        return null;
    // Use the last half of the kline window to keep analysis recent
    const startIdx = Math.floor(klines.length * 0.4);
    const recent = pivots.filter(p => p.index >= startIdx);
    const highs = recent.filter(p => p.type === 'high');
    const lows = recent.filter(p => p.type === 'low');
    if (highs.length === 0 || lows.length === 0) {
        // Fall back to full dataset
        const allHighs = pivots.filter(p => p.type === 'high');
        const allLows = pivots.filter(p => p.type === 'low');
        if (allHighs.length === 0 || allLows.length === 0)
            return null;
        const high = allHighs.reduce((a, b) => a.price > b.price ? a : b);
        const low = allLows.reduce((a, b) => a.price < b.price ? a : b);
        return { high, low };
    }
    const high = highs.reduce((a, b) => a.price > b.price ? a : b);
    const low = lows.reduce((a, b) => a.price < b.price ? a : b);
    return { high, low };
}
/**
 * Calculate Fibonacci retracement and extension levels from two swing points.
 */
export function calculateFibonacci(klines) {
    if (klines.length < 20)
        return null;
    const swings = selectPrimarySwings(klines);
    if (!swings)
        return null;
    const { high, low } = swings;
    const range = high.price - low.price;
    const currentPrice = klines[klines.length - 1].close;
    // Direction: is the most recent swing a high (downtrend measuring retracement from top)
    // or a low (uptrend measuring retracement from bottom)?
    const direction = high.index > low.index ? 'downtrend' : 'uptrend';
    // Retracements: measured from the swing that came LAST back toward the one that came first
    const retracements = RETRACE_RATIOS.map(({ ratio, label, isKey }) => {
        const price = direction === 'uptrend'
            ? high.price - range * ratio // from high downward
            : low.price + range * ratio; // from low upward
        return { ratio, price, label: `Retrace ${label}`, isKey };
    });
    // Extensions: beyond the most recent swing extreme
    const extensions = EXTENSION_RATIOS.map(({ ratio, label, isKey }) => {
        const price = direction === 'uptrend'
            ? low.price + range * ratio // above high
            : high.price - range * ratio; // below low
        return { ratio, price, label: `Ext ${label}`, isKey };
    });
    const allLevels = [...retracements, ...extensions];
    // Find the nearest support and resistance to current price
    const supports = allLevels.filter(l => l.price < currentPrice).sort((a, b) => b.price - a.price);
    const resists = allLevels.filter(l => l.price > currentPrice).sort((a, b) => a.price - b.price);
    const nearestSupport = supports[0] ?? null;
    const nearestResist = resists[0] ?? null;
    // Describe current zone
    let currentZone;
    if (!nearestSupport) {
        currentZone = `Below all Fibonacci levels — price in free-fall zone.`;
    }
    else if (!nearestResist) {
        currentZone = `Above all Fibonacci levels — price in extension territory.`;
    }
    else {
        const distToSupport = ((currentPrice - nearestSupport.price) / currentPrice * 100).toFixed(2);
        const distToResist = ((nearestResist.price - currentPrice) / currentPrice * 100).toFixed(2);
        currentZone = `Between ${nearestSupport.label} (${distToSupport}% below) and ${nearestResist.label} (${distToResist}% above).`;
    }
    return {
        swingHigh: high,
        swingLow: low,
        direction,
        retracements,
        extensions,
        currentPrice,
        nearestSupport,
        nearestResist,
        currentZone,
    };
}
// ── Step 1: 包含关系处理 ────────────────────────────────────────────────────────
// Two adjacent candles have an inclusive relationship when one completely contains
// the other (H1>=H2 && L1<=L2 OR H2>=H1 && L2<=L1).
// Merge: use higher of the highs and lower of the lows for trend direction.
// The merged candle inherits the direction of the containing candle.
export function processInclusionRelationships(klines) {
    if (klines.length === 0)
        return [];
    const result = [{
            originalIndex: 0,
            high: klines[0].high,
            low: klines[0].low,
            close: klines[0].close,
            time: klines[0].openTime,
            direction: 0,
        }];
    for (let i = 1; i < klines.length; i++) {
        const k = klines[i];
        const prev = result[result.length - 1];
        const isIncluded = (k.high <= prev.high && k.low >= prev.low) ||
            (k.high >= prev.high && k.low <= prev.low);
        if (isIncluded) {
            // Determine trend by looking at the last two processed candles
            const prevPrev = result.length >= 2 ? result[result.length - 2] : null;
            const trendUp = prevPrev ? prev.high >= prevPrev.high : true;
            // Merge: in an uptrend, keep the higher high and higher low; downtrend vice versa
            if (trendUp) {
                prev.high = Math.max(prev.high, k.high);
                prev.low = Math.max(prev.low, k.low);
            }
            else {
                prev.high = Math.min(prev.high, k.high);
                prev.low = Math.min(prev.low, k.low);
            }
            prev.close = k.close;
            prev.time = k.openTime;
            // Don't add new — just mutate the last processed candle
        }
        else {
            const direction = k.high > prev.high ? 1 : -1;
            result.push({
                originalIndex: i,
                high: k.high,
                low: k.low,
                close: k.close,
                time: k.openTime,
                direction,
            });
        }
    }
    return result;
}
// ── Step 2: 分型识别 ────────────────────────────────────────────────────────────
// A 顶分型 (top fractal): middle candle's high is the highest of 3 consecutive candles,
//   AND both sides are lower.
// A 底分型 (bottom fractal): middle candle's low is the lowest of 3 consecutive candles.
// Rule: two adjacent fractals of the same type must have at least one independent candle between them.
export function detectFractals(candles) {
    const fractals = [];
    for (let i = 1; i < candles.length - 1; i++) {
        const prev = candles[i - 1];
        const curr = candles[i];
        const next = candles[i + 1];
        const isTop = curr.high > prev.high && curr.high > next.high;
        const isBottom = curr.low < prev.low && curr.low < next.low;
        if (isTop) {
            fractals.push({ index: i, type: '顶分型', price: curr.high, time: curr.time, candleIdx: curr.originalIndex });
        }
        else if (isBottom) {
            fractals.push({ index: i, type: '底分型', price: curr.low, time: curr.time, candleIdx: curr.originalIndex });
        }
    }
    // Remove adjacent same-type fractals (keep the extreme)
    return filterFractals(fractals, candles);
}
function filterFractals(fractals, candles) {
    if (fractals.length < 2)
        return fractals;
    const result = [fractals[0]];
    for (let i = 1; i < fractals.length; i++) {
        const prev = result[result.length - 1];
        const curr = fractals[i];
        if (prev.type === curr.type) {
            // Same type — must be separated by at least one candle of opposite type
            // But if no independent candle exists between them, keep only the extreme
            const gapCandles = curr.index - prev.index - 1;
            if (gapCandles < 1) {
                // Not enough gap — keep the more extreme one
                if (curr.type === '顶分型' && curr.price > prev.price) {
                    result[result.length - 1] = curr;
                }
                else if (curr.type === '底分型' && curr.price < prev.price) {
                    result[result.length - 1] = curr;
                }
            }
            else {
                result.push(curr);
            }
        }
        else {
            // Must have at least one candle between alternating fractals
            const independentCandles = curr.index - prev.index - 1;
            if (independentCandles >= 1) {
                result.push(curr);
            }
            else {
                // Not enough independent candles — skip this fractal
            }
        }
    }
    return result;
}
// ── Step 3: 笔识别 ────────────────────────────────────────────────────────────
// A 笔 (bi/stroke) connects a 顶分型 to the next 底分型, or vice versa.
// Requirements:
//   - Direction must alternate (top → bottom → top...)
//   - At least 5 processed candles must separate the two fractals (including endpoints)
//   - The end fractal must be more extreme than the start in the bi direction
export function detectBi(fractals, candles) {
    const bis = [];
    if (fractals.length < 2)
        return bis;
    for (let i = 0; i < fractals.length - 1; i++) {
        const start = fractals[i];
        const end = fractals[i + 1];
        // Must alternate between top and bottom
        if (start.type === end.type)
            continue;
        // Must have enough candles
        const candleSpan = end.index - start.index + 1;
        if (candleSpan < 5)
            continue;
        const direction = start.type === '底分型' ? '上升笔' : '下降笔';
        // Validate extremes: an upward bi must end higher than it started, etc.
        if (direction === '上升笔' && end.price <= start.price)
            continue;
        if (direction === '下降笔' && end.price >= start.price)
            continue;
        bis.push({ start, end, direction, length: candleSpan });
    }
    return bis;
}
// ── Step 4: 中枢识别 ────────────────────────────────────────────────────────────
// A 中枢 (hub/pivot zone) is formed by 3 or more consecutive bi that overlap.
// The hub range is [ZD, ZG] where:
//   ZD = max of the lows of the bis inside the hub
//   ZG = min of the highs of the bis inside the hub
// The bis must create an overlap (ZD < ZG).
export function detectHubs(bis) {
    const hubs = [];
    if (bis.length < 3)
        return hubs;
    let hubStart = 0;
    while (hubStart <= bis.length - 3) {
        // Get the price range of the first bi
        const b1 = bis[hubStart];
        const b2 = bis[hubStart + 1];
        const b3 = bis[hubStart + 2];
        const biRange = (b) => ({
            high: Math.max(b.start.price, b.end.price),
            low: Math.min(b.start.price, b.end.price),
        });
        const r1 = biRange(b1);
        const r2 = biRange(b2);
        const r3 = biRange(b3);
        // Check if all 3 overlap
        const overlapHigh = Math.min(r1.high, r2.high, r3.high);
        const overlapLow = Math.max(r1.low, r2.low, r3.low);
        if (overlapHigh <= overlapLow) {
            // No overlap — not a hub. Move forward.
            hubStart++;
            continue;
        }
        // We have a valid hub. Try to extend it.
        const hubBis = [b1, b2, b3];
        let i = hubStart + 3;
        while (i < bis.length) {
            const nextBi = bis[i];
            const nr = biRange(nextBi);
            const newOverlapHigh = Math.min(overlapHigh, nr.high);
            const newOverlapLow = Math.max(overlapLow, nr.low);
            if (newOverlapHigh > newOverlapLow) {
                hubBis.push(nextBi);
                i++;
            }
            else {
                break;
            }
        }
        // Determine hub type from the first bi direction
        const firstDir = hubBis[0].direction;
        let type;
        if (firstDir === '上升笔') {
            type = i < bis.length ? '上升中枢' : '震荡中枢';
        }
        else {
            type = i < bis.length ? '下降中枢' : '震荡中枢';
        }
        hubs.push({
            bis: hubBis,
            type,
            high: overlapHigh,
            low: overlapLow,
            center: (overlapHigh + overlapLow) / 2,
        });
        // Advance past this hub
        hubStart = i - 1;
        if (hubStart <= hubStart)
            hubStart = i;
    }
    return hubs;
}
function ema(values, period) {
    const k = 2 / (period + 1);
    const result = [];
    let prev = values[0];
    result.push(prev);
    for (let i = 1; i < values.length; i++) {
        prev = values[i] * k + prev * (1 - k);
        result.push(prev);
    }
    return result;
}
export function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow)
        return [];
    const ema12 = ema(closes, fast);
    const ema26 = ema(closes, slow);
    const dif = ema12.map((v, i) => v - ema26[i]);
    const dea = ema(dif, signal);
    return dif.map((d, i) => ({
        dif: d,
        dea: dea[i],
        macd: (d - dea[i]) * 2,
    }));
}
// ── Step 6: 背驰识别 ────────────────────────────────────────────────────────────
// 背驰 (bèi chí) = divergence — when price makes a new extreme but momentum does not.
// In 缠论, this is measured by comparing the MACD histogram area of the last two
// same-direction bi within or departing from a hub.
// A 顶背驰 signals a potential top reversal; 底背驰 signals a potential bottom reversal.
function macdAreaForBi(bi, klines, macdPoints) {
    const startTime = bi.start.time;
    const endTime = bi.end.time;
    let area = 0;
    for (let i = 0; i < klines.length; i++) {
        const k = klines[i];
        if (k.openTime >= startTime && k.openTime <= endTime) {
            const m = macdPoints[i];
            if (m)
                area += Math.abs(m.macd);
        }
    }
    return area;
}
export function detectBeiChi(bis, hubs, klines, macdPoints) {
    const result = [];
    if (bis.length < 2)
        return result;
    // Compare the last two same-direction bi
    for (let i = 1; i < bis.length; i++) {
        const curr = bis[i];
        const prev = bis[i - 1];
        if (curr.direction === prev.direction)
            continue; // need same direction for pairs
        // Actually in 缠论, 背驰 compares consecutive same-direction bi in the context of
        // exiting a hub. Let's look for the last two bi of the same direction.
    }
    // Simpler approach: look for the last two 上升笔 and last two 下降笔
    const upBis = bis.filter(b => b.direction === '上升笔');
    const downBis = bis.filter(b => b.direction === '下降笔');
    if (upBis.length >= 2) {
        const last = upBis[upBis.length - 1];
        const prev = upBis[upBis.length - 2];
        const areaLast = macdAreaForBi(last, klines, macdPoints);
        const areaPrev = macdAreaForBi(prev, klines, macdPoints);
        // 顶背驰: last upBi makes higher high but MACD area is smaller
        if (last.end.price > prev.end.price && areaLast < areaPrev * 0.9) {
            result.push({
                type: '顶背驰',
                bi: last,
                macdArea1: areaPrev,
                macdArea2: areaLast,
                confirmed: areaLast < areaPrev * 0.8,
            });
        }
    }
    if (downBis.length >= 2) {
        const last = downBis[downBis.length - 1];
        const prev = downBis[downBis.length - 2];
        const areaLast = macdAreaForBi(last, klines, macdPoints);
        const areaPrev = macdAreaForBi(prev, klines, macdPoints);
        // 底背驰: last downBi makes lower low but MACD area is smaller
        if (last.end.price < prev.end.price && areaLast < areaPrev * 0.9) {
            result.push({
                type: '底背驰',
                bi: last,
                macdArea1: areaPrev,
                macdArea2: areaLast,
                confirmed: areaLast < areaPrev * 0.8,
            });
        }
    }
    return result;
}
// ── Step 7: 买卖点分类 ────────────────────────────────────────────────────────────
// 买点1 (B1): 底背驰 — the lowest point of the downward impulse, momentum exhausted
// 买点2 (B2): the low after the first rebound from B1 (回调不破B1)
// 买点3 (B3): the first pullback after breaking above the hub (突破中枢后回调)
// 卖点1/2/3: mirror image of buy points
export function classifyBuySellPoints(bis, hubs, beiChiList) {
    const points = [];
    // B1/S1: from 背驰
    for (const bc of beiChiList) {
        if (bc.type === '底背驰') {
            points.push({
                type: '买点1',
                price: bc.bi.end.price,
                time: bc.bi.end.time,
                bi: bc.bi,
                beiChi: bc,
                note: `底背驰确认。MACD面积: ${bc.macdArea2.toFixed(4)} vs 前笔 ${bc.macdArea1.toFixed(4)}${bc.confirmed ? '（强确认）' : '（弱信号）'}`,
            });
        }
        if (bc.type === '顶背驰') {
            points.push({
                type: '卖点1',
                price: bc.bi.end.price,
                time: bc.bi.end.time,
                bi: bc.bi,
                beiChi: bc,
                note: `顶背驰确认。MACD面积: ${bc.macdArea2.toFixed(4)} vs 前笔 ${bc.macdArea1.toFixed(4)}${bc.confirmed ? '（强确认）' : '（弱信号）'}`,
            });
        }
    }
    // B3/S3: price exits hub and first pullback holds above hub high / below hub low
    for (const hub of hubs) {
        const lastBiInHub = hub.bis[hub.bis.length - 1];
        const biAfterHub = bis.find(b => b.start === lastBiInHub.end);
        if (biAfterHub) {
            if (biAfterHub.direction === '上升笔' && biAfterHub.end.price > hub.high) {
                // Price broke above hub — look for first pullback as B3
                const pullback = bis.find(b => b.start === biAfterHub.end && b.direction === '下降笔');
                if (pullback && pullback.end.price > hub.high) {
                    points.push({
                        type: '买点3',
                        price: pullback.end.price,
                        time: pullback.end.time,
                        bi: pullback,
                        note: `中枢突破后回调不破顶 (中枢高点 ${hub.high.toFixed(2)})`,
                    });
                }
            }
            if (biAfterHub.direction === '下降笔' && biAfterHub.end.price < hub.low) {
                const pullback = bis.find(b => b.start === biAfterHub.end && b.direction === '上升笔');
                if (pullback && pullback.end.price < hub.low) {
                    points.push({
                        type: '卖点3',
                        price: pullback.end.price,
                        time: pullback.end.time,
                        bi: pullback,
                        note: `中枢击穿后反弹不破底 (中枢低点 ${hub.low.toFixed(2)})`,
                    });
                }
            }
        }
    }
    return points.sort((a, b) => a.time - b.time);
}
// ── Main 缠论 pipeline ─────────────────────────────────────────────────────────
export function runChanLun(klines) {
    const processedCandles = processInclusionRelationships(klines);
    const fractals = detectFractals(processedCandles);
    const bis = detectBi(fractals, processedCandles);
    const hubs = detectHubs(bis);
    const closes = klines.map(k => k.close);
    const macdPoints = calculateMACD(closes);
    const beiChiList = detectBeiChi(bis, hubs, klines, macdPoints);
    const buySellPoints = classifyBuySellPoints(bis, hubs, beiChiList);
    const currentStructure = describeChanStructure(bis, hubs, beiChiList, buySellPoints, klines);
    return { processedCandles, fractals, bis, hubs, beiChiList, buySellPoints, currentStructure };
}
function describeChanStructure(bis, hubs, beiChiList, bsp, klines) {
    const lines = [];
    const lastBi = bis[bis.length - 1];
    if (!lastBi) {
        return '缠论结构数据不足（需要至少 20 根K线）。';
    }
    lines.push(`笔数量: ${bis.length} | 中枢数量: ${hubs.length}`);
    lines.push(`当前笔方向: ${lastBi.direction} (${lastBi.length} 根处理后K线)`);
    if (hubs.length > 0) {
        const lastHub = hubs[hubs.length - 1];
        const currentPrice = klines[klines.length - 1].close;
        const position = currentPrice > lastHub.high
            ? '中枢上方'
            : currentPrice < lastHub.low
                ? '中枢下方'
                : '中枢内部';
        lines.push(`最新中枢: [${lastHub.low.toFixed(2)}, ${lastHub.high.toFixed(2)}] — 当前价格在${position}`);
    }
    if (beiChiList.length > 0) {
        const lastBc = beiChiList[beiChiList.length - 1];
        lines.push(`最新背驰: ${lastBc.type}${lastBc.confirmed ? '（强）' : '（弱）'}`);
    }
    const recentBsp = bsp.filter(p => {
        const cutoff = klines[Math.max(0, klines.length - 50)].openTime;
        return p.time >= cutoff;
    });
    if (recentBsp.length > 0) {
        lines.push(`近期买卖点: ${recentBsp.map(p => p.type).join(', ')}`);
    }
    else {
        lines.push('近期无明确买卖点信号。');
    }
    return lines.join('\n');
}
export function analyzeTechnicals(klines) {
    const fibonacci = calculateFibonacci(klines);
    const chanLun = runChanLun(klines);
    const summaryParts = [];
    if (fibonacci) {
        const dir = fibonacci.direction === 'uptrend' ? '上升趋势' : '下降趋势';
        summaryParts.push(`斐波那契: ${dir}。${fibonacci.currentZone}`);
        if (fibonacci.nearestSupport?.isKey) {
            summaryParts.push(`关键支撑: ${fibonacci.nearestSupport.label} @ ${fibonacci.nearestSupport.price.toFixed(2)}`);
        }
        if (fibonacci.nearestResist?.isKey) {
            summaryParts.push(`关键压力: ${fibonacci.nearestResist.label} @ ${fibonacci.nearestResist.price.toFixed(2)}`);
        }
    }
    summaryParts.push('');
    summaryParts.push('缠论结构:');
    summaryParts.push(chanLun.currentStructure);
    const summary = summaryParts.join('\n');
    return { fibonacci, chanLun, summary };
}
//# sourceMappingURL=technical-analysis.js.map