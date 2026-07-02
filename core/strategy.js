const { RSI, EMA, MACD, ATR } = require('technicalindicators');

const SYMBOL_STRATEGY = {
  XAUUSD: { allowedSetups: ['trend_buy', 'trend_sell'], rsi: { trend_buy: { min: 30, max: 50 }, trend_sell: { min: 50, max: 70 }, momentum_sell: { min: 28, max: 48 }, momentum_buy: { min: 48, max: 62 }, pullback_sell: { min: 55, max: 75 }, pullback_buy: { min: 30, max: 50 } }, trendRequired: false, requireH1Trend: false, requireBelowEma50: false, atrSlM: 1.0, minSl: 10 },
  USDJPY: { allowedSetups: ['trend_buy', 'trend_sell'], rsi: { trend_buy: { min: 25, max: 60 }, trend_sell: { min: 40, max: 75 } }, trendRequired: false, requireH1Trend: false, requireBelowEma50: false, atrSlM: 1.5, minSl: 8 },
};

function getPrice(c) { return c.close; }
function getHigh(c) { return c.high; }
function getLow(c) { return c.low; }

function pipToPrice(pips, symbol) {
  const s = symbol.toUpperCase();
  const jpyPairs = ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'NZDJPY', 'CHFJPY'];
  if (jpyPairs.some(p => s.includes(p.replace('/', '')))) return pips * 0.01;
  if (s.includes('XAU') || s.includes('GOLD')) return pips * 0.01;
  if (s.includes('US30') || s.includes('WS30') || s.includes('SPX') || s.includes('NAS')) return pips * 1.0;
  return pips * 0.0001;
}

function pipValuePerLot(symbol) {
  const s = symbol.toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 10;
  if (s.includes('US30') || s.includes('WS30') || s.includes('SPX') || s.includes('NAS')) return 1;
  return 10;
}

function extractOHLC(candles) {
  return {
    open: candles.map(c => c.open),
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
  };
}

function calcRSI(closes, period = 14) {
  const result = RSI.calculate({ values: closes, period });
  return result[result.length - 1] ?? null;
}

function calcEMA(closes, period) {
  const result = EMA.calculate({ values: closes, period });
  return result[result.length - 1] ?? null;
}

function calcMACD(closes) {
  const result = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26,
    signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false,
  });
  return result[result.length - 1] ?? null;
}

function calcATR(highs, lows, closes, period = 14) {
  const result = ATR.calculate({ high: highs, low: lows, close: closes, period });
  return result[result.length - 1] ?? null;
}

function calcSupportResistance(candles, lookback = 24, ema50, atrVal) {
  const recent = candles.slice(-Math.min(lookback, candles.length - 1));
  if (recent.length < 10) return { swingHigh: null, swingLow: null, nearSupport: false, nearResistance: false };
  if (!atrVal || atrVal <= 0) return { swingHigh: null, swingLow: null, nearSupport: false, nearResistance: false };
  const currentPrice = getPrice(candles[candles.length - 1]);
  const swingHigh = Math.max(...recent.map(c => getHigh(c)));
  const swingLow = Math.min(...recent.map(c => getLow(c)));
  const threshold = atrVal * 0.3;
  const nearSwingSupport = currentPrice !== null && Math.abs(currentPrice - swingLow) <= threshold;
  const nearSwingResistance = currentPrice !== null && Math.abs(currentPrice - swingHigh) <= threshold;
  const nearEma = ema50 && currentPrice !== null ? Math.abs(currentPrice - ema50) <= threshold * 2 : false;
  const aboveEma50 = currentPrice !== null && ema50 ? currentPrice > ema50 : false;
  const belowEma50 = currentPrice !== null && ema50 ? currentPrice < ema50 : false;
  return {
    swingHigh, swingLow,
    nearSupport: nearSwingSupport || (nearEma && aboveEma50),
    nearResistance: nearSwingResistance || (nearEma && belowEma50),
  };
}

function getIndicators(candles) {
  const { high, low, close } = extractOHLC(candles);
  const rsi = calcRSI(close);
  const ema20 = calcEMA(close, 20);
  const ema50 = calcEMA(close, 50);
  const macd = calcMACD(close);
  const atr = calcATR(high, low, close);
  const sr = calcSupportResistance(candles, 24, ema50, atr);
  const currentPrice = close[close.length - 1];
  return {
    currentPrice, rsi, ema20, ema50,
    emaTrend: ema20 > ema50 ? 'bullish' : 'bearish',
    macd: {
      macd: macd?.MACD ?? null,
      signal: macd?.signal ?? null,
      histogram: macd?.histogram ?? null,
      histogramTrend: macd?.histogram > 0 ? 'positive' : 'negative',
    },
    atr, ...sr,
  };
}

function slParams(atr, symbol, config = {}) {
  const cfg = SYMBOL_STRATEGY[symbol];
  const slM = config.atrSl || (cfg?.atrSlM ?? 2);
  if (!atr || atr <= 0) return { slPips: cfg?.minSl ?? 15 };
  const pips = Math.round(atr / pipToPrice(1, symbol));
  return {
    slPips: Math.max(cfg?.minSl ?? 18, Math.round(pips * slM)),
  };
}

function evaluate(params) {
  const { symbol, h4Trend, ind, config = {} } = params;
  const { rsi, ema20, ema50, emaTrend: h1Trend, macd, atr, currentPrice, nearSupport, nearResistance } = ind;
  if (rsi == null || !atr) return null;
  let cfg = { ...SYMBOL_STRATEGY[symbol] };
  if (!cfg) return null;
  if (config.allowedSetups) cfg.allowedSetups = config.allowedSetups;
  if (config.rsi) cfg.rsi = config.rsi;
  if (config.atrSlM != null) cfg.atrSlM = config.atrSlM;
  if (config.minSl != null) cfg.minSl = config.minSl;
  const { slPips } = slParams(atr, symbol, config);
  const aboveEma50 = currentPrice && ema50 ? currentPrice > ema50 : false;
  const belowEma50 = currentPrice && ema50 ? currentPrice < ema50 : false;
  const aboveEma20 = currentPrice && ema20 ? currentPrice > ema20 : false;
  const belowEma20 = currentPrice && ema20 ? currentPrice < ema20 : false;
  const macdNegative = macd?.histogramTrend === 'negative';
  const macdPositive = macd?.histogramTrend === 'positive';
  const macdCrossoverBear = macd?.histogram < 0 && macd?.macd < macd?.signal;
  const macdCrossoverBull = macd?.histogram > 0 && macd?.macd > macd?.signal;
  const downtrend = cfg.trendRequired
    ? h4Trend === 'bearish' && belowEma50 && h1Trend === 'bearish'
    : config.trendMode === 'AND'
      ? (h4Trend === 'bearish' && belowEma50)
      : (h4Trend === 'bearish' || belowEma50);
  const uptrend = cfg.trendRequired
    ? h4Trend === 'bullish' && aboveEma50 && h1Trend === 'bullish'
    : config.trendMode === 'AND'
      ? (h4Trend === 'bullish' && aboveEma50)
      : (h4Trend === 'bullish' || aboveEma50);
  const candidates = [];
  for (const setup of cfg.allowedSetups) {
    const rsiRange = cfg.rsi[setup];
    if (!rsiRange) continue;

    if (setup === 'trend_sell' && downtrend && nearResistance)
      candidates.push({ action: 'SELL', setup, confidence: 0.8, slPips });
    if (setup === 'trend_buy' && uptrend && nearSupport)
      candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips });
    if (setup === 'momentum_sell' && downtrend && macdNegative) {
      let ok = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBear && belowEma20;
      if (cfg.requireH1Trend && h1Trend !== 'bearish') ok = false;
      if (cfg.requireBelowEma50 && !belowEma50) ok = false;
      if (ok) candidates.push({ action: 'SELL', setup, confidence: 0.7, slPips });
    }
    if (setup === 'momentum_buy' && uptrend && macdPositive) {
      let ok = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBull && aboveEma20;
      if (cfg.requireH1Trend && h1Trend !== 'bullish') ok = false;
      if (cfg.requireBelowEma50 && !aboveEma50) ok = false;
      if (ok) candidates.push({ action: 'BUY', setup, confidence: 0.7, slPips });
    }
    if (setup === 'pullback_sell' && downtrend && macdNegative) {
      let ok = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBear && aboveEma20;
      if (cfg.requireH1Trend && h1Trend !== 'bearish') ok = false;
      if (cfg.requireBelowEma50 && !belowEma50) ok = false;
      if (ok) candidates.push({ action: 'SELL', setup, confidence: 0.8, slPips });
    }
    if (setup === 'pullback_buy' && uptrend && macdPositive) {
      let ok = rsi >= rsiRange.min && rsi <= rsiRange.max && macdCrossoverBull && belowEma20;
      if (cfg.requireH1Trend && h1Trend !== 'bullish') ok = false;
      if (cfg.requireBelowEma50 && !aboveEma50) ok = false;
      if (ok) candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0];
}

function getMultiTFIndicators(candleMap) {
  const result = {};
  for (const [tf, candles] of Object.entries(candleMap)) {
    result[tf] = getIndicators(candles);
  }
  return result;
}

function precalcIndicators(candles) {
  const { high, low, close } = extractOHLC(candles);
  const n = close.length;
  const allRsi = RSI.calculate({ values: close, period: 14 });
  const allEma20 = EMA.calculate({ values: close, period: 20 });
  const allEma50 = EMA.calculate({ values: close, period: 50 });
  const allMacd = MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const allAtr = ATR.calculate({ high, low, close, period: 14 });
  const LOOKBACK = 24, firstValid = 49;
  const result = new Array(n - firstValid);
  for (let i = firstValid; i < n; i++) {
    const start = Math.max(0, i - LOOKBACK + 1);
    let swingHigh = -Infinity, swingLow = Infinity;
    for (let j = start; j <= i; j++) {
      const ch = getHigh(candles[j]); if (ch > swingHigh) swingHigh = ch;
      const cl = getLow(candles[j]); if (cl < swingLow) swingLow = cl;
    }
    const currentPrice = close[i];
    const ema50v = allEma50[i - 49] ?? null;
    const atrVal = allAtr[i - 13] ?? null;
    const threshold = atrVal && atrVal > 0 ? atrVal * 0.3 : 0;
    const nearSwingSupport = threshold > 0 && currentPrice !== null && Math.abs(currentPrice - swingLow) <= threshold;
    const nearSwingResistance = threshold > 0 && currentPrice !== null && Math.abs(currentPrice - swingHigh) <= threshold;
    const nearEma = threshold > 0 && ema50v && currentPrice !== null ? Math.abs(currentPrice - ema50v) <= threshold * 2 : false;
    const aboveEma50 = ema50v && currentPrice !== null ? currentPrice > ema50v : false;
    const belowEma50 = ema50v && currentPrice !== null ? currentPrice < ema50v : false;
    result[i - firstValid] = {
      time: candles[i].time ?? candles[i].snapshotTime ?? i,
      currentPrice,
      rsi: allRsi[i - 13] ?? null,
      ema20: allEma20[i - 19] ?? null,
      ema50: ema50v,
      emaTrend: (allEma20[i - 19] ?? 0) > (ema50v ?? 0) ? 'bullish' : 'bearish',
      macd: {
        macd: allMacd[i - 25]?.MACD ?? null,
        signal: allMacd[i - 25]?.signal ?? null,
        histogram: allMacd[i - 25]?.histogram ?? null,
        histogramTrend: (allMacd[i - 25]?.histogram ?? 0) > 0 ? 'positive' : 'negative',
      },
      atr: atrVal,
      swingHigh, swingLow, nearSupport: nearSwingSupport || (nearEma && aboveEma50), nearResistance: nearSwingResistance || (nearEma && belowEma50),
    };
  }
  return result;
}

const INDICATOR_OFFSET = 50;

const { fetchCandles } = require('./dataSource');

function normalizeSignal(symbol, decision, ind) {
  if (!decision) return { symbol, signal: 'NONE', reason: 'No setup matched', indicators: ind };
  const entryPrice = decision.action === 'BUY'
    ? ind.currentPrice + 2 * pipToPrice(1, symbol)
    : ind.currentPrice - 2 * pipToPrice(1, symbol);
  const slPrice = decision.action === 'BUY'
    ? entryPrice - decision.slPips * pipToPrice(1, symbol)
    : entryPrice + decision.slPips * pipToPrice(1, symbol);
  return {
    symbol,
    signal: decision.action,
    entry: parseFloat(entryPrice.toFixed(5)),
    sl: parseFloat(slPrice.toFixed(5)),
    reason: decision.setup,
    confidence: decision.confidence,
    indicators: ind,
  };
}

function buildH4FromH1(h1Candles) {
  const h4 = [];
  const groups = {};
  for (const c of h1Candles) {
    const t = new Date(c.time);
    const h4Key = Math.floor(t.getTime() / 14400000) * 14400000;
    if (!groups[h4Key]) {
      groups[h4Key] = { time: new Date(h4Key).toISOString(), open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      const g = groups[h4Key];
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
    }
  }
  for (const key of Object.keys(groups).sort()) h4.push(groups[key]);
  return h4;
}

async function analyzeFromData(symbol, config = {}, candles = null) {
  const timeframe = config.timeframe || 'H1';
  const limit = config.limit || 100;
  const tfMap = { H1: 'h1', H4: 'h4', D1: 'd1', M1: 'm1', M5: 'm5', M15: 'm15', M30: 'm30' };

  try {
    const h1Candles = candles || (await fetchCandles(symbol, tfMap[timeframe] || 'h1', limit));
    if (!h1Candles || h1Candles.length < INDICATOR_OFFSET) {
      return { symbol, signal: 'NONE', reason: 'Insufficient data from Dukascopy' };
    }
    const ind = getIndicators(h1Candles);

    let h4Trend = 'neutral';
    try {
      const h4Candles = candles ? buildH4FromH1(candles) : await fetchCandles(symbol, 'h4', 50);
      if (h4Candles && h4Candles.length >= 20) {
        const h4Ind = getIndicators(h4Candles);
        h4Trend = h4Ind.emaTrend;
      }
    } catch {
      // H4 trend is optional; fall back to neutral
    }

    const decision = evaluate({ symbol, h4Trend, ind, config });
    return normalizeSignal(symbol, decision, ind);
  } catch (err) {
    return { symbol, signal: 'NONE', reason: `Data fetch failed: ${err.message}` };
  }
}

async function analyze(broker, config = {}) {
  const symbol = config.symbol || 'XAUUSD';
  const timeframe = config.timeframe || 'H1';
  const limit = config.limit || 100;
  const candles = await broker.getCandles(symbol, timeframe, limit);
  if (!candles || candles.length < INDICATOR_OFFSET) {
    return { signal: 'NONE', reason: 'Insufficient data' };
  }
  const ind = getIndicators(candles);
  const h4Candles = await broker.getCandles(symbol, 'H4', 50).catch(() => null);
  let h4Trend = 'neutral';
  if (h4Candles && h4Candles.length >= 20) {
    const h4Ind = getIndicators(h4Candles);
    h4Trend = h4Ind.emaTrend;
  }
  const decision = evaluate({ symbol, h4Trend, ind, config });
  if (!decision) return { signal: 'NONE', reason: 'No setup matched', indicators: ind };
  const entryPrice = decision.action === 'BUY'
    ? ind.currentPrice + 2 * pipToPrice(1, symbol)
    : ind.currentPrice - 2 * pipToPrice(1, symbol);
  const slPrice = decision.action === 'BUY'
    ? entryPrice - decision.slPips * pipToPrice(1, symbol)
    : entryPrice + decision.slPips * pipToPrice(1, symbol);
  return {
    symbol,
    signal: decision.action,
    entry: parseFloat(entryPrice.toFixed(5)),
    sl: parseFloat(slPrice.toFixed(5)),
    reason: decision.setup,
    confidence: decision.confidence,
    indicators: ind,
  };
}

module.exports = {
  SYMBOL_STRATEGY,
  pipToPrice,
  pipValuePerLot,
  getIndicators,
  getMultiTFIndicators,
  precalcIndicators,
  evaluate,
  slParams,
  analyze,
  analyzeFromData,
  normalizeSignal,
  INDICATOR_OFFSET,
};
