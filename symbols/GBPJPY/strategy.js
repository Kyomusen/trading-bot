const INDICATOR_OFFSET = 50;

function calcEMAFull(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length);
  result[0] = closes[0];
  for (let i = 1; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function calcRSIFull(closes, period = 14) {
  const result = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return result;
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
  const emaFast = config.emaFast || 9;
  const emaSlow = config.emaSlow || 21;
  const rsiPeriod = config.rsiPeriod || 14;
  const atrPeriod = config.atrPeriod || 14;

  const emaFastAll = calcEMAFull(closes, emaFast);
  const emaSlowAll = calcEMAFull(closes, emaSlow);
  const rsiAll = calcRSIFull(closes, rsiPeriod);
  const atrAll = calcATRFull(highs, lows, closes, atrPeriod);

  const startIdx = Math.max(emaSlow, rsiPeriod, atrPeriod) + 5;
  const result = [];
  for (let i = startIdx; i < candles.length; i++) {
    result.push({
      time: candles[i].time,
      currentPrice: closes[i],
      emaFast: emaFastAll[i],
      emaSlow: emaSlowAll[i],
      prevEmaFast: emaFastAll[i - 1],
      prevEmaSlow: emaSlowAll[i - 1],
      rsi: rsiAll[i],
      atr: atrAll[i],
    });
  }
  return result;
}

function evaluate(ind, config = {}) {
  const rsiOverbought = config.rsiOverbought || 70;
  const rsiOversold = config.rsiOversold || 30;
  const slMultiplier = config.slMultiplier || 1.0;
  const tpMultiplier = config.tpMultiplier || 5.0;

  const crossUp = ind.emaFast > ind.emaSlow && ind.prevEmaFast <= ind.prevEmaSlow;
  const crossDown = ind.emaFast < ind.emaSlow && ind.prevEmaFast >= ind.prevEmaSlow;

  let signal = 'NONE', entry = ind.currentPrice, sl = 0, tp = 0, reason = '';

  if (crossUp && ind.rsi < rsiOverbought) {
    signal = 'BUY';
    sl = entry - ind.atr * slMultiplier;
    tp = entry + ind.atr * tpMultiplier;
    reason = 'EMA cross up + RSI not overbought';
  } else if (crossDown && ind.rsi > rsiOversold) {
    signal = 'SELL';
    sl = entry + ind.atr * slMultiplier;
    tp = entry - ind.atr * tpMultiplier;
    reason = 'EMA cross down + RSI not oversold';
  } else {
    reason = 'No clear signal';
  }

  return {
    symbol: 'GBPJPY',
    signal,
    entry: parseFloat(entry.toFixed(3)),
    sl: parseFloat(sl.toFixed(3)),
    tp: parseFloat(tp.toFixed(3)),
    reason,
    indicators: {
      emaFast: parseFloat(ind.emaFast.toFixed(3)),
      emaSlow: parseFloat(ind.emaSlow.toFixed(3)),
      rsi: parseFloat(ind.rsi.toFixed(2)),
      atr: parseFloat(ind.atr.toFixed(5)),
    },
  };
}

async function analyze(broker, config = {}) {
  const timeframe = config.timeframe || 'H1';
  const limit = config.limit || 100;
  const candles = await broker.getCandles('GBPJPY', timeframe, limit);
  if (!candles || candles.length < INDICATOR_OFFSET) {
    return { signal: 'NONE', reason: 'Insufficient data' };
  }
  const precalc = precalcIndicators(candles, config);
  return evaluate(precalc[precalc.length - 1], config);
}

module.exports = { analyze, precalcIndicators, evaluate, INDICATOR_OFFSET };
