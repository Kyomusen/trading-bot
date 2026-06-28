const { getRealTimeRates } = require('dukascopy-node');

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

module.exports = { fetchCandles };
