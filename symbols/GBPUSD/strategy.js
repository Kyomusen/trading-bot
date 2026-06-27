function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0].close;
  for (let i = 1; i < data.length; i++) {
    ema = data[i].close * k + ema * (1 - k);
  }
  return ema;
}

function calculateMACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const emaFast = data.map((_, i) => calculateEMA(data.slice(0, i + 1), fastPeriod));
  const emaSlow = data.map((_, i) => calculateEMA(data.slice(0, i + 1), slowPeriod));
  const macdLine = emaFast.map((f, i) => f - emaSlow[i]);
  const signalLine = macdLine.map((_, i) => calculateEMA(macdLine.slice(0, i + 1), signalPeriod));
  const histogram = macdLine.map((m, i) => m - signalLine[i]);
  return { macd: macdLine[macdLine.length - 1], signal: signalLine[signalLine.length - 1], histogram: histogram[histogram.length - 1] };
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
    macdFast = 12,
    macdSlow = 26,
    macdSignal = 9,
    atrPeriod = 14,
    slMultiplier = 1.5,
    tpMultiplier = 2.0,
  } = config;

  const candles = await broker.getCandles('GBPUSD', timeframe, limit);
  if (!candles || candles.length < macdSlow + macdSignal + 5) {
    return { signal: 'NONE', reason: 'Insufficient data' };
  }

  const current = candles[candles.length - 1];
  const macd = calculateMACD(candles, macdFast, macdSlow, macdSignal);
  const atr = calculateATR(candles, atrPeriod);

  const prevMacd = calculateMACD(candles.slice(0, -1), macdFast, macdSlow, macdSignal);

  let signal = 'NONE';
  let entry = current.close;
  let sl = 0;
  let tp = 0;
  let reason = '';

  const macdCrossUp = macd.macd > macd.signal && prevMacd.macd <= prevMacd.signal;
  const macdCrossDown = macd.macd < macd.signal && prevMacd.macd >= prevMacd.signal;

  if (macdCrossUp && macd.histogram > 0) {
    signal = 'BUY';
    sl = entry - atr * slMultiplier;
    tp = entry + atr * tpMultiplier;
    reason = 'MACD bullish crossover';
  } else if (macdCrossDown && macd.histogram < 0) {
    signal = 'SELL';
    sl = entry + atr * slMultiplier;
    tp = entry - atr * tpMultiplier;
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
      macd: parseFloat(macd.macd.toFixed(5)),
      signal: parseFloat(macd.signal.toFixed(5)),
      histogram: parseFloat(macd.histogram.toFixed(5)),
      atr: parseFloat(atr.toFixed(5)),
    },
  };
}

module.exports = { analyze, calculateEMA, calculateMACD, calculateATR };
