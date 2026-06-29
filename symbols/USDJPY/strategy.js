const shared = require('../../core/strategy');
const SYMBOL = 'USDJPY';

function evaluateWrapper(ind, h4Trend = 'neutral', config = {}) {
  const decision = shared.evaluate({ symbol: SYMBOL, h4Trend, ind, config });
  if (!decision) return { signal: 'NONE', reason: 'No setup matched' };
  const entryPrice = decision.action === 'BUY'
    ? ind.currentPrice + 2 * shared.pipToPrice(1, SYMBOL)
    : ind.currentPrice - 2 * shared.pipToPrice(1, SYMBOL);
  const slPrice = decision.action === 'BUY'
    ? entryPrice - decision.slPips * shared.pipToPrice(1, SYMBOL)
    : entryPrice + decision.slPips * shared.pipToPrice(1, SYMBOL);
  const tpPrice = decision.action === 'BUY'
    ? entryPrice + decision.tpPips * shared.pipToPrice(1, SYMBOL)
    : entryPrice - decision.tpPips * shared.pipToPrice(1, SYMBOL);
  return {
    symbol: SYMBOL,
    signal: decision.action,
    entry: parseFloat(entryPrice.toFixed(5)),
    sl: parseFloat(slPrice.toFixed(5)),
    tp: parseFloat(tpPrice.toFixed(5)),
    reason: decision.setup,
    confidence: decision.confidence,
    slPips: decision.slPips,
    tpPips: decision.tpPips,
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
