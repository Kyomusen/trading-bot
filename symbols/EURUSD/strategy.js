function calculateSMA(data, period) {
  if (data.length < period) return null;
  const sum = data.slice(-period).reduce((a, c) => a + c.close, 0);
  return sum / period;
}

function calculateBB(data, period = 20, stdDev = 2) {
  const sma = calculateSMA(data, period);
  if (!sma) return { upper: 0, middle: 0, lower: 0 };
  const variance = data.slice(-period).reduce((sum, c) => sum + Math.pow(c.close - sma, 2), 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: sma + sd * stdDev, middle: sma, lower: sma - sd * stdDev };
}

function calculateRSI(data, period = 14) {
  if (data.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function analyze(broker, config = {}) {
  const {
    timeframe = 'H1',
    limit = 100,
    bbPeriod = 20,
    bbStdDev = 2,
    rsiPeriod = 14,
    rsiOverbought = 70,
    rsiOversold = 30,
    slPips = 20,
    tpPips = 40,
  } = config;

  const candles = await broker.getCandles('EURUSD', timeframe, limit);
  if (!candles || candles.length < bbPeriod + 5) {
    return { signal: 'NONE', reason: 'Insufficient data' };
  }

  const current = candles[candles.length - 1];
  const bb = calculateBB(candles, bbPeriod, bbStdDev);
  const rsi = calculateRSI(candles, rsiPeriod);

  const pipValue = 0.0001;
  let signal = 'NONE';
  let entry = current.close;
  let sl = 0;
  let tp = 0;
  let reason = '';

  if (current.close <= bb.lower && rsi < rsiOversold) {
    signal = 'BUY';
    sl = entry - slPips * pipValue;
    tp = entry + tpPips * pipValue;
    reason = 'Price at lower BB + RSI oversold';
  } else if (current.close >= bb.upper && rsi > rsiOverbought) {
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
      bbUpper: parseFloat(bb.upper.toFixed(5)),
      bbMiddle: parseFloat(bb.middle.toFixed(5)),
      bbLower: parseFloat(bb.lower.toFixed(5)),
      rsi: parseFloat(rsi.toFixed(2)),
    },
  };
}

module.exports = { analyze, calculateSMA, calculateBB, calculateRSI };
