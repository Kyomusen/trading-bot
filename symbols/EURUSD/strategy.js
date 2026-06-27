const INDICATOR_OFFSET = 50;

function calcSMAFull(closes, period) {
  const result = new Array(closes.length).fill(0);
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

function calcBBFull(closes, period = 20, stdDev = 2) {
  const sma = calcSMAFull(closes, period);
  const upper = new Array(closes.length).fill(0);
  const lower = new Array(closes.length).fill(0);
  for (let i = period - 1; i < closes.length; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += Math.pow(closes[j] - sma[i], 2);
    }
    variance /= period;
    const sd = Math.sqrt(variance);
    upper[i] = sma[i] + sd * stdDev;
    lower[i] = sma[i] - sd * stdDev;
  }
  return { upper, middle: sma, lower };
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

function precalcIndicators(candles, config = {}) {
  const closes = candles.map(c => c.close);
  const bbPeriod = config.bbPeriod || 20;
  const bbStdDev = config.bbStdDev || 2;
  const rsiPeriod = config.rsiPeriod || 14;

  const bb = calcBBFull(closes, bbPeriod, bbStdDev);
  const rsiAll = calcRSIFull(closes, rsiPeriod);

  const startIdx = Math.max(bbPeriod, rsiPeriod) + 5;
  const result = [];
  for (let i = startIdx; i < candles.length; i++) {
    result.push({
      time: candles[i].time,
      currentPrice: closes[i],
      bbUpper: bb.upper[i],
      bbLower: bb.lower[i],
      bbMiddle: bb.middle[i],
      rsi: rsiAll[i],
    });
  }
  return result;
}

function evaluate(ind, config = {}) {
  const rsiOverbought = config.rsiOverbought || 70;
  const rsiOversold = config.rsiOversold || 30;
  const slPips = config.slPips || 20;
  const tpPips = config.tpPips || 40;
  const pipValue = 0.0001;

  let signal = 'NONE', entry = ind.currentPrice, sl = 0, tp = 0, reason = '';

  if (ind.currentPrice <= ind.bbLower && ind.rsi < rsiOversold) {
    signal = 'BUY';
    sl = entry - slPips * pipValue;
    tp = entry + tpPips * pipValue;
    reason = 'Price at lower BB + RSI oversold';
  } else if (ind.currentPrice >= ind.bbUpper && ind.rsi > rsiOverbought) {
    signal = 'SELL';
    sl = entry + slPips * pipValue;
    tp = entry - tpPips * pipValue;
    reason = 'Price at upper BB + RSI overbought';
  } else {
    reason = 'No BB squeeze signal';
  }

  return {
    symbol: 'EURUSD',
    signal,
    entry: parseFloat(entry.toFixed(5)),
    sl: parseFloat(sl.toFixed(5)),
    tp: parseFloat(tp.toFixed(5)),
    reason,
    indicators: {
      bbUpper: parseFloat(ind.bbUpper.toFixed(5)),
      bbMiddle: parseFloat(ind.bbMiddle.toFixed(5)),
      bbLower: parseFloat(ind.bbLower.toFixed(5)),
      rsi: parseFloat(ind.rsi.toFixed(2)),
    },
  };
}

async function analyze(broker, config = {}) {
  const timeframe = config.timeframe || 'H1';
  const limit = config.limit || 100;
  const candles = await broker.getCandles('EURUSD', timeframe, limit);
  if (!candles || candles.length < INDICATOR_OFFSET) {
    return { signal: 'NONE', reason: 'Insufficient data' };
  }
  const precalc = precalcIndicators(candles, config);
  return evaluate(precalc[precalc.length - 1], config);
}

module.exports = { analyze, precalcIndicators, evaluate, INDICATOR_OFFSET };
