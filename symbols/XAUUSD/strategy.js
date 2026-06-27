function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0].close;
  for (let i = 1; i < data.length; i++) {
    ema = data[i].close * k + ema * (1 - k);
  }
  return ema;
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

function calculateATR(data, period = 14) {
  if (data.length < period + 1) return 0;
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const high = data[i].high;
    const low = data[i].low;
    const prevClose = data[i - 1].close;
    trSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return trSum / period;
}

async function analyze(broker, config = {}) {
  const {
    timeframe = 'H1',
    limit = 100,
    emaFast = 9,
    emaSlow = 21,
    rsiPeriod = 14,
    rsiOverbought = 70,
    rsiOversold = 30,
    atrPeriod = 14,
    slMultiplier = 1.5,
    tpMultiplier = 2.5,
  } = config;

  const candles = await broker.getCandles('XAUUSD', timeframe, limit);
  if (!candles || candles.length < emaSlow + 5) {
    return { signal: 'NONE', reason: 'Insufficient data' };
  }

  const current = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const emaFastVal = calculateEMA(candles.slice(-emaFast * 2), emaFast);
  const emaSlowVal = calculateEMA(candles.slice(-emaSlow * 2), emaSlow);
  const rsi = calculateRSI(candles, rsiPeriod);
  const atr = calculateATR(candles, atrPeriod);

  const emaCrossUp = emaFastVal > emaSlowVal && calculateEMA(candles.slice(0, -1).slice(-emaFast * 2), emaFast) <= calculateEMA(candles.slice(0, -1).slice(-emaSlow * 2), emaSlow);
  const emaCrossDown = emaFastVal < emaSlowVal && calculateEMA(candles.slice(0, -1).slice(-emaFast * 2), emaFast) >= calculateEMA(candles.slice(0, -1).slice(-emaSlow * 2), emaSlow);

  let signal = 'NONE';
  let entry = current.close;
  let sl = 0;
  let tp = 0;
  let reason = '';

  if (emaCrossUp && rsi < rsiOverbought) {
    signal = 'BUY';
    sl = entry - atr * slMultiplier;
    tp = entry + atr * tpMultiplier;
    reason = 'EMA cross up + RSI not overbought';
  } else if (emaCrossDown && rsi > rsiOversold) {
    signal = 'SELL';
    sl = entry + atr * slMultiplier;
    tp = entry - atr * tpMultiplier;
    reason = 'EMA cross down + RSI not oversold';
  } else {
    reason = 'No clear signal';
  }

  return {
    symbol: 'XAUUSD',
    signal,
    entry: parseFloat(entry.toFixed(2)),
    sl: parseFloat(sl.toFixed(2)),
    tp: parseFloat(tp.toFixed(2)),
    reason,
    indicators: {
      emaFast: parseFloat(emaFastVal.toFixed(2)),
      emaSlow: parseFloat(emaSlowVal.toFixed(2)),
      rsi: parseFloat(rsi.toFixed(2)),
      atr: parseFloat(atr.toFixed(2)),
    },
  };
}

module.exports = { analyze, calculateEMA, calculateRSI, calculateATR };
