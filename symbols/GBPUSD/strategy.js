const INDICATOR_OFFSET = 50;

function calcSMACloses(closes) {
  const period = 26;
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  result[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    result[i] = sum / period;
  }
  return result;
}

function calcEMAFull(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length);
  result[0] = closes[0];
  for (let i = 1; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function calcMACDFull(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const emaFast = calcEMAFull(closes, fastPeriod);
  const emaSlow = calcEMAFull(closes, slowPeriod);
  const macdLine = emaFast.map((f, i) => f - emaSlow[i]);
  const signalLine = calcEMAFull(macdLine, signalPeriod);
  const histogram = macdLine.map((m, i) => m - signalLine[i]);
  return { macd: macdLine, signal: signalLine, histogram };
}

function calcATRFull(highs, lows, closes, period = 14) {
  const result = new Array(closes.length).fill(0);
  if (closes.length < period + 1) return result;
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  result[period] = trSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    result[i] = (result[i - 1] * (period - 1) + tr) / period;
  }
  return result;
}

function precalcIndicators(candles, config = {}) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const macdFast = config.macdFast || 12;
  const macdSlow = config.macdSlow || 26;
  const macdSignal = config.macdSignal || 9;
  const atrPeriod = config.atrPeriod || 14;

  const macd = calcMACDFull(closes, macdFast, macdSlow, macdSignal);
  const atrAll = calcATRFull(highs, lows, closes, atrPeriod);

  const startIdx = Math.max(macdSlow + macdSignal, atrPeriod) + 5;
  const result = [];
  for (let i = startIdx; i < candles.length; i++) {
    result.push({
      time: candles[i].time,
      currentPrice: closes[i],
      macd: macd.macd[i],
      signal: macd.signal[i],
      histogram: macd.histogram[i],
      prevMacd: macd.macd[i - 1],
      prevSignal: macd.signal[i - 1],
      prevHistogram: macd.histogram[i - 1],
      atr: atrAll[i],
    });
  }
  return result;
}

function evaluate(ind, config = {}) {
  const slMultiplier = config.slMultiplier || 1.5;
  const tpMultiplier = config.tpMultiplier || 2.0;

  const macdCrossUp = ind.macd > ind.signal && ind.prevMacd <= ind.prevSignal;
  const macdCrossDown = ind.macd < ind.signal && ind.prevMacd >= ind.prevSignal;

  let signal = 'NONE', entry = ind.currentPrice, sl = 0, tp = 0, reason = '';

  if (macdCrossUp && ind.histogram > 0) {
    signal = 'BUY';
    sl = entry - ind.atr * slMultiplier;
    tp = entry + ind.atr * tpMultiplier;
    reason = 'MACD bullish crossover';
  } else if (macdCrossDown && ind.histogram < 0) {
    signal = 'SELL';
    sl = entry + ind.atr * slMultiplier;
    tp = entry - ind.atr * tpMultiplier;
    reason = 'MACD bearish crossover';
  } else {
    reason = 'No MACD crossover';
  }

  return {
    symbol: 'GBPUSD',
    signal,
    entry: parseFloat(entry.toFixed(5)),
    sl: parseFloat(sl.toFixed(5)),
    tp: parseFloat(tp.toFixed(5)),
    reason,
    indicators: {
      macd: parseFloat(ind.macd.toFixed(5)),
      signal: parseFloat(ind.signal.toFixed(5)),
      histogram: parseFloat(ind.histogram.toFixed(5)),
      atr: parseFloat(ind.atr.toFixed(5)),
    },
  };
}

async function analyze(broker, config = {}) {
  const timeframe = config.timeframe || 'H1';
  const limit = config.limit || 100;
  const candles = await broker.getCandles('GBPUSD', timeframe, limit);
  if (!candles || candles.length < INDICATOR_OFFSET) {
    return { signal: 'NONE', reason: 'Insufficient data' };
  }
  const precalc = precalcIndicators(candles, config);
  return evaluate(precalc[precalc.length - 1], config);
}

module.exports = { analyze, precalcIndicators, evaluate, INDICATOR_OFFSET };
