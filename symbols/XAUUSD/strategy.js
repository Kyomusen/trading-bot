const shared = require('../../core/strategy');
const SYMBOL = 'XAUUSD';

function evaluateWrapper(ind, h4Trend = 'neutral', config = {}) {
  const decision = shared.evaluate({ symbol: SYMBOL, h4Trend, ind, config });
  if (!decision) return { signal: 'NONE', reason: 'No setup matched' };
  const entryPrice = decision.action === 'BUY'
    ? ind.currentPrice + 2 * shared.pipToPrice(1, SYMBOL)
    : ind.currentPrice - 2 * shared.pipToPrice(1, SYMBOL);
  const slPrice = decision.action === 'BUY'
    ? entryPrice - decision.slPips * shared.pipToPrice(1, SYMBOL)
    : entryPrice + decision.slPips * shared.pipToPrice(1, SYMBOL);
  return {
    symbol: SYMBOL,
    signal: decision.action,
    entry: parseFloat(entryPrice.toFixed(2)),
    sl: parseFloat(slPrice.toFixed(2)),
    reason: decision.setup,
    confidence: decision.confidence,
    slPips: decision.slPips,
    indicators: ind,
  };
}

module.exports = {
  analyze: (broker, config) => shared.analyze(broker, { ...config, symbol: SYMBOL }),
  analyzeFromData: (config, candles) => shared.analyzeFromData(SYMBOL, config, candles),
  evaluate: evaluateWrapper,
  precalcIndicators: shared.precalcIndicators,
  INDICATOR_OFFSET: shared.INDICATOR_OFFSET,
  SYMBOL_STRATEGY: shared.SYMBOL_STRATEGY[SYMBOL],
};
