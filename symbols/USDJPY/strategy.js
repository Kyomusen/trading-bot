// Thin per-symbol binding onto the shared strategy engine (core/strategy.js).
// analyzeFromData is the only entry point the runner actually calls, in both
// backtest and live (stream) modes, so both paths run the exact same logic.
const shared = require('../../core/strategy');
const SYMBOL = 'USDJPY';

module.exports = {
  analyzeFromData: (config, candles) => shared.analyzeFromData(SYMBOL, config, candles),
};
