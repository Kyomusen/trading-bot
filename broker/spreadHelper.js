const config = require('../config');

function getSpread(candle, epic) {
  if (!candle || candle.bid === undefined) return 0;
  const raw = candle.ask - candle.bid;
  if (raw <= 0) return 0;
  const sc = config.symbols.find(s => s.epic === epic);
  const mult = sc?.spreadMultiplier ?? 1.0;
  return raw * mult;
}

module.exports = { getSpread };
