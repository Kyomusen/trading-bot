const { getRealTimeRates } = require('dukascopy-node');
const { loadCandleCache, saveCandleCache, mergeCandles } = require('./candleCache');

const INSTRUMENT_MAP = {
  XAUUSD: 'xauusd',
  USDJPY: 'usdjpy',
};

async function fetchCandles(symbol, timeframe = 'h1', count = 100) {
  const instrument = INSTRUMENT_MAP[symbol];
  if (!instrument) throw new Error(`No Dukascopy instrument mapping for ${symbol}`);

  const raw = await getRealTimeRates({
    instrument,
    timeframe,
    format: 'json',
    last: count,
    volumes: false,
  });

  if (!raw || raw.length === 0) throw new Error(`No data returned from Dukascopy for ${symbol} ${timeframe}`);

  return raw.map(c => ({
    time: new Date(c.timestamp).toISOString(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

async function fetchCandlesCached(symbol, timeframe = 'H1', config = {}) {
  const tf = timeframe.toLowerCase();
  const dukascopyTf = { h1: 'h1', h4: 'h4', d1: 'd1', m1: 'm1', m5: 'm5', m15: 'm15', m30: 'm30' }[tf] || 'h1';
  const fullLimit = config.limit || 100;
  const liveFetchCount = config.liveFetchCount ?? 5;
  const maxCache = config.maxCache || 720;

  const cached = loadCandleCache(symbol, timeframe);

  if (cached && cached.length >= 50) {
    const fresh = await fetchCandles(symbol, dukascopyTf, liveFetchCount);
    const merged = mergeCandles(cached, fresh);
    saveCandleCache(symbol, timeframe, merged, maxCache);
    if (merged.length < fullLimit && cached.length < fullLimit) {
      const topUp = await fetchCandles(symbol, dukascopyTf, fullLimit);
      saveCandleCache(symbol, timeframe, topUp, maxCache);
      return topUp;
    }
    return merged;
  }

  const full = await fetchCandles(symbol, dukascopyTf, fullLimit);
  saveCandleCache(symbol, timeframe, full, maxCache);
  return full;
}

module.exports = { fetchCandles, fetchCandlesCached };
