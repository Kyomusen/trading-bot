// Shared position-sizing, adaptive-multiplier, and trailing-stop math.
// Used by BOTH runStream (live) and runBacktest so the two paths can never
// diverge in behavior — this is the single source of truth for that math.

const { pipValuePerLot } = require('./strategy');

/**
 * Win-rate based multiplier applied to risk in a given direction (BUY/SELL).
 * Returns 1 (neutral) when disabled or there isn't enough trade history yet.
 */
function calcAdaptiveMultiplier(tradeHistory, direction, config) {
  const adCfg = config.adaptiveSizing || {};
  if (!adCfg.enabled) return 1;

  const dirTrades = (tradeHistory || []).filter(t => (t.type || t.action) === direction);
  if (dirTrades.length < 5) return 1;

  const lookback = adCfg.lookback ?? 50;
  const recent = dirTrades.slice(-lookback);
  if (recent.length === 0) return 1;

  const wins = recent.filter(t => (t.pnl ?? 0) > 0).length;
  const winRate = wins / recent.length;
  const minMul = adCfg.min ?? 0.5;
  const maxMul = adCfg.max ?? 1.5;

  const raw = winRate >= 0.5
    ? 1 + (winRate - 0.5) * 2 * (maxMul - 1)
    : 1 - (0.5 - winRate) * 2 * (1 - minMul);

  return Math.max(minMul, Math.min(maxMul, raw));
}

/**
 * Risk-based position size in lots, honoring loss-streak reduction, the
 * adaptive direction multiplier, dynamic/static max-lot caps, and the
 * broker's own max deal size.
 */
function calcPositionSize({ symbol, balance, dirMul = 1, consecutiveLosses = 0, config, slPips, brokerMax = 999999 }) {
  const pvpl = pipValuePerLot(symbol);
  const minLot = symbol.includes('XAU') ? 0.0001 : 0.01;
  if (!slPips || slPips <= 0) return minLot;

  const riskBase = balance * dirMul;

  let riskFactor = 1;
  const lossCfg = config.lossSizing || {};
  if (lossCfg.enabled !== false && consecutiveLosses >= (lossCfg.reduceAfter ?? 1)) {
    riskFactor = Math.max(
      lossCfg.minFactor ?? 0.1,
      Math.pow(lossCfg.reduceTo ?? 0.65, Math.floor(consecutiveLosses / (lossCfg.reduceAfter ?? 1)))
    );
  }

  const riskAmount = riskBase * riskFactor * (config.riskPercent / 100);
  const lots = riskAmount / (slPips * pvpl);

  // config.maxLot is always a ceiling; dynamicMaxLot adds a balance-scaled
  // ceiling on top of it (not instead of it).
  const dynamicCap = config.dynamicMaxLot ? Math.max(0.01, balance / 50000) : Infinity;
  const maxLot = Math.min(config.maxLot ?? 5, dynamicCap, brokerMax);

  const size = Math.max(minLot, Math.min(maxLot, parseFloat(lots.toFixed(4))));
  const riskPct = (size * slPips * pvpl) / riskBase * 100;
  if (riskPct > (config.riskPercent || 1) * 3) return 0;
  return size;
}

/**
 * Computes an updated trailing stop given the position's best excursion so
 * far. Returns null when trailing isn't active/activated yet or the new SL
 * wouldn't be an improvement over the current one. Otherwise returns
 * { sl, trailDist }.
 */
function calcTrailingStop({ type, entry, atrValue, bestPrice, currentSl, config }) {
  if (!config.trailing || !atrValue || atrValue <= 0) return null;

  const baseActivate = config.trailingActivate ?? 0.2;
  const baseDist = config.trailingDistance ?? 0.1;
  const maxDist = config.trailingDistanceMax ?? 0.5;
  const progFactor = config.trailingProgressive ?? 0.01;

  const profitPct = type === 'BUY'
    ? (bestPrice - entry) / atrValue
    : (entry - bestPrice) / atrValue;
  if (profitPct < baseActivate) return null;

  const trailDist = Math.min(maxDist, Math.max(0.02, baseDist + (profitPct - baseActivate) * progFactor));
  const trailPrice = trailDist * atrValue;
  const lockSl = type === 'BUY' ? entry + 0.05 * atrValue : entry - 0.05 * atrValue;

  const candidateSl = type === 'BUY'
    ? Math.max(currentSl, bestPrice - trailPrice, lockSl)
    : Math.min(currentSl, bestPrice + trailPrice, lockSl);

  const improved = type === 'BUY' ? candidateSl > currentSl : candidateSl < currentSl;
  if (!improved) return null;

  return { sl: candidateSl, trailDist };
}

module.exports = { calcAdaptiveMultiplier, calcPositionSize, calcTrailingStop };
