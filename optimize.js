const shared = require('./core/strategy');
const DataStore = require('./core/dataStore');

const config = require('./symbols/USDJPY/config.json');
const CANDLES = 5000;

let h1 = DataStore.loadLocalCandles('USDJPY', 'H1').slice(-CANDLES);
let h4 = DataStore.loadLocalCandles('USDJPY', 'H4');
const h4Count = Math.ceil(CANDLES / 4) + 50;
h4 = h4.slice(-h4Count);

const h1Pre = shared.precalcIndicators(h1);
const h4Pre = shared.precalcIndicators(h4);

function run(opts) {
  let h4Ptr = 0;
  const getH4Trend = (t) => {
    const tt = new Date(t).getTime();
    while (h4Ptr < h4Pre.length - 1 && new Date(h4Pre[h4Ptr + 1].time).getTime() <= tt) h4Ptr++;
    return h4Pre[h4Ptr].emaTrend || 'neutral';
  };

  const baseCfg = { ...config };
  const cfg = {
    ...baseCfg,
    trendMode: opts.trendMode || 'AND',
    trailing: opts.trailing ?? true,
    trailingActivate: opts.trailingActivate ?? 0.5,
    trailingDistance: opts.trailingDistance ?? 0.2,
    atrSl: opts.atrSl ?? 0.8,
    atrTp: opts.atrTp ?? 20,
    riskPercent: opts.riskPercent ?? 1,
    spreadPips: opts.spreadPips ?? 2,
    slippagePips: opts.slippagePips ?? 1,
    adaptiveSizing: { enabled: opts.adaptive ?? true, lookback: 50, min: 0.5, max: 1.5 },
    lossSizing: { enabled: opts.lossSizing ?? true, reduceAfter: 1, reduceTo: 0.65, minFactor: 0.1 },
  };

  // Pass SYMBOL_STRATEGY overrides through config to avoid mutating shared state
  const symCfg = shared.SYMBOL_STRATEGY.USDJPY;
  Object.assign(cfg, {
    allowedSetups: opts.setups || symCfg.allowedSetups,
    rsi: opts.rsi || symCfg.rsi,
    atrSlM: opts.atrSlM ?? symCfg.atrSlM,
    atrTpM: opts.atrTpM ?? symCfg.atrTpM,
    minSl: opts.minSl ?? symCfg.minSl,
    minTp: opts.minTp ?? symCfg.minTp,
  });

  let balance = 500, position = null, trades = [], cl = 0, th = [];
  let peak = balance, mdd = 0;

  for (let i = 60; i < h1.length; i++) {
    const c = h1[i];
    const ind = h1Pre[i - 49];
    if (!ind) continue;
    const h4Trend = getH4Trend(c.time);
    const decision = shared.evaluate({ symbol: 'USDJPY', h4Trend, ind, config: cfg });

    if (!position) {
      if (decision) {
        const { action, slPips, tpPips } = decision;
        const adCfg = cfg.adaptiveSizing; let dm = 1;
        if (adCfg?.enabled) {
          const dt = th.filter(t => t.type === action);
          if (dt.length >= 5) {
            const r = dt.slice(-(adCfg.lookback||50));
            const wr = r.filter(t => t.pnl > 0).length / r.length;
            dm = wr >= 0.5 ? 1 + (wr-0.5)*2*((adCfg.max||1.5)-1) : 1 - (0.5-wr)*2*(1-(adCfg.min||0.5));
            dm = Math.max(adCfg.min||0.5, Math.min(adCfg.max||1.5, dm));
          }
        }
        const pvpl = shared.pipValuePerLot('USDJPY');
        const ml = cfg.dynamicMaxLot ? Math.max(0.01, balance/50000) : (cfg.maxLot||5);
        let size; const ls = cfg.lossSizing;
        if (ls?.enabled && cl >= (ls.reduceAfter||1)) {
          const f = Math.max(ls.minFactor||0.1, (ls.reduceTo||0.65)**Math.floor(cl/(ls.reduceAfter||1))) * dm;
          const lots = (balance*f*(cfg.riskPercent/100))/(slPips*pvpl);
          size = Math.min(ml, Math.max(0.0001, parseFloat(lots.toFixed(4))));
          if ((size*slPips*pvpl)/(balance*f)*100 > cfg.riskPercent*3) size = 0;
        } else {
          const lots = (balance*dm*(cfg.riskPercent/100))/(slPips*pvpl);
          size = Math.min(ml, Math.max(0.0001, parseFloat(lots.toFixed(4))));
          if ((size*slPips*pvpl)/(balance*dm)*100 > cfg.riskPercent*3) size = 0;
        }
        if (!size) continue;
        const slp = (cfg.slippagePips||0)*shared.pipToPrice(1,'USDJPY');
        const ep = action === 'BUY' ? ind.currentPrice+slp : ind.currentPrice-slp;
        position = {
          type: action, entry: ep,
          sl: action === 'BUY' ? ep-slPips*shared.pipToPrice(1,'USDJPY') : ep+slPips*shared.pipToPrice(1,'USDJPY'),
          tp: action === 'BUY' ? ep+tpPips*shared.pipToPrice(1,'USDJPY') : ep-tpPips*shared.pipToPrice(1,'USDJPY'),
          size, bp: ep, atr: ind.atr||0
        };
      }
    } else {
      if (cfg.trailing && position.atr > 0) {
        if (position.type === 'BUY' && c.high > position.bp) position.bp = c.high;
        if (position.type === 'BUY' && position.bp - position.entry >= (cfg.trailingActivate||0.5)*position.atr) {
          const ns = Math.max(position.sl, position.bp - (cfg.trailingDistance||0.2)*position.atr);
          if (ns > position.sl) position.sl = ns;
        }
        if (position.type === 'SELL' && c.low < position.bp) position.bp = c.low;
        if (position.type === 'SELL' && position.entry - position.bp >= (cfg.trailingActivate||0.5)*position.atr) {
          const ns = Math.min(position.sl, position.bp + (cfg.trailingDistance||0.2)*position.atr);
          if (ns < position.sl) position.sl = ns;
        }
      }
      let ep = null;
      if (position.type === 'BUY') { if (c.low <= position.sl) ep = position.sl; else if (c.high >= position.tp) ep = position.tp; }
      else { if (c.high >= position.sl) ep = position.sl; else if (c.low <= position.tp) ep = position.tp; }
      if (ep) {
        const m = position.type === 'BUY' ? 1 : -1;
        const slp = (cfg.slippagePips||0)*shared.pipToPrice(1,'USDJPY');
        const eaj = position.type === 'BUY' ? ep - slp : ep + slp;
        const pnl = ((eaj-position.entry)/shared.pipToPrice(1,'USDJPY'))*position.size*shared.pipValuePerLot('USDJPY')*m - (cfg.spreadPips||0)*position.size*shared.pipValuePerLot('USDJPY');
        balance += pnl; cl = pnl < 0 ? cl+1 : 0; th.push({ type: position.type, pnl }); trades.push({ pnl }); position = null;
      }
    }
    let eq = balance;
    if (position) { const m = position.type === 'BUY' ? 1 : -1; eq += ((c.close-position.entry)/shared.pipToPrice(1,'USDJPY'))*position.size*shared.pipValuePerLot('USDJPY')*m; }
    if (eq > peak) peak = eq;
    const dd = ((peak - eq)/peak)*100;
    if (dd > mdd) mdd = dd;
  }

  const closed = trades.filter(t => t.pnl !== 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl < 0);
  const netPnl = trades.reduce((s,t) => s + (t.pnl||0), 0);
  const wr = closed.length > 0 ? (wins.length/closed.length*100) : 0;
  const pf = losses.length > 0 ? (wins.reduce((s,t)=>s+t.pnl,0) / Math.abs(losses.reduce((s,t)=>s+t.pnl,0))) : (wins.length > 0 ? 999 : 0);
  const score = (netPnl > 0 && closed.length > 10) ? (netPnl / Math.max(1, mdd)) : -999;
  const retPct = ((balance - 500) / 500) * 100;

  return { trades: closed.length, wr, pf, netPnl, mdd, score, retPct, final: balance };
}

// Helper to create RSI config
function rsi(buyMin, buyMax, sellMin, sellMax) {
  return {
    trend_buy: { min: buyMin ?? 30, max: buyMax ?? 50 },
    trend_sell: { min: sellMin ?? 50, max: sellMax ?? 70 },
    momentum_buy: { min: buyMin ?? 48, max: buyMax ?? 62 },
    momentum_sell: { min: sellMin ?? 28, max: sellMax ?? 48 },
    pullback_buy: { min: buyMin ?? 30, max: buyMax ?? 50 },
    pullback_sell: { min: sellMin ?? 55, max: sellMax ?? 75 },
  };
}

const results = [];

console.log('=== Phase 1: Setup Types ===');
for (const setups of [
  ['momentum_buy', 'momentum_sell'],
  ['trend_buy', 'trend_sell'],
  ['pullback_buy', 'pullback_sell'],
  ['momentum_buy', 'momentum_sell', 'trend_buy', 'trend_sell'],
  ['trend_buy', 'trend_sell', 'pullback_buy', 'pullback_sell'],
  ['momentum_buy', 'momentum_sell', 'pullback_buy', 'pullback_sell'],
  ['trend_buy', 'trend_sell', 'momentum_buy', 'momentum_sell', 'pullback_buy', 'pullback_sell'],
]) {
  const r = run({ setups, trendMode: 'AND', atrSl: 0.8, atrTp: 20, atrSlM: 1.2, atrTpM: 3.0, riskPercent: 1 });
  results.push({ ...r, label: 'setups=' + setups.join('+')[0] });
  const label = setups.join('+').substring(0, 60);
  console.log(label.padEnd(62), '| Trades:', String(r.trades).padStart(5), '| WR:', r.wr.toFixed(1)+'%', '| PF:', r.pf.toFixed(2), '| PnL:', r.netPnl.toFixed(0), '| DD:', r.mdd.toFixed(1)+'%', '| Score:', r.score.toFixed(0));
}
