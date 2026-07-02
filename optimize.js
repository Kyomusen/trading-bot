const shared = require('./core/strategy');
const DataStore = require('./core/dataStore');
const { CapitalBroker } = require('./core/brokers');

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
    trailingActivate: opts.trailingActivate ?? 0.2,
    trailingDistance: opts.trailingDistance ?? 0.1,
    trailingDistanceMax: opts.trailingDistanceMax ?? 0.5,
    trailingProgressive: opts.trailingProgressive ?? 0.01,
    atrSl: opts.atrSl ?? 0.8,
    riskPercent: opts.riskPercent ?? 1,
    spreadPips: opts.spreadPips ?? 2,
    slippagePips: opts.slippagePips ?? 1,
    adaptiveSizing: { enabled: opts.adaptive ?? true, lookback: 50, min: 0.5, max: 1.5 },
    lossSizing: { enabled: opts.lossSizing ?? true, reduceAfter: 1, reduceTo: 0.65, minFactor: 0.1 },
  };

  const symCfg = shared.SYMBOL_STRATEGY.USDJPY;
  Object.assign(cfg, {
    allowedSetups: opts.setups || symCfg.allowedSetups,
    rsi: opts.rsi || symCfg.rsi,
    atrSlM: opts.atrSlM ?? symCfg.atrSlM,
    minSl: opts.minSl ?? symCfg.minSl,
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
        const { action, slPips } = decision;
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
        const dr = CapitalBroker.loadDealingRulesCache('USDJPY');
        const brokerMax = dr ? dr.maxDealSize : 999999;
        const ml = cfg.dynamicMaxLot ? Math.min(brokerMax, (cfg.maxLot||5), Math.max(0.01, balance/50000)) : Math.min((cfg.maxLot||5), brokerMax);
        let size; const ls = cfg.lossSizing;
        if (ls?.enabled && cl >= (ls.reduceAfter||1)) {
          const f = Math.max(ls.minFactor||0.1, (ls.reduceTo||0.65)**Math.floor(cl/(ls.reduceAfter||1))) * dm;
          const lots = (balance*f*(cfg.riskPercent/100))/(slPips*pvpl);
          size = Math.min(ml, Math.max(0.0001, parseFloat(lots.toFixed(4))));
          if ((size*slPips*pvpl)/(balance*dm)*100 > cfg.riskPercent*3) size = 0;
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
          size, bp: ep, atr: ind.atr||0
        };
      }
    } else {
      if (cfg.trailing && position.atr > 0) {
        const baseAct = cfg.trailingActivate ?? 0.2;
        const baseD = cfg.trailingDistance ?? 0.1;
        const maxD = cfg.trailingDistanceMax ?? 0.5;
        const progF = cfg.trailingProgressive ?? 0.01;
        if (position.type === 'BUY') {
          if (c.high > position.bp) position.bp = c.high;
          const pp = (position.bp - position.entry) / position.atr;
          if (pp >= baseAct) {
            const td = Math.min(maxD, Math.max(0.02, baseD + (pp - baseAct) * progF));
            const ns = Math.max(position.sl, position.bp - td * position.atr, position.entry + 0.05 * position.atr);
            if (ns > position.sl) position.sl = ns;
          }
        } else {
          if (c.low < position.bp) position.bp = c.low;
          const pp = (position.entry - position.bp) / position.atr;
          if (pp >= baseAct) {
            const td = Math.min(maxD, Math.max(0.02, baseD + (pp - baseAct) * progF));
            const ns = Math.min(position.sl, position.bp + td * position.atr, position.entry - 0.05 * position.atr);
            if (ns < position.sl) position.sl = ns;
          }
        }
      }
      let ep = null;
      if (position.type === 'BUY' && c.low <= position.sl) ep = position.sl;
      else if (position.type === 'SELL' && c.high >= position.sl) ep = position.sl;
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

function fmt(r) {
  return 'Trades:' + String(r.trades).padStart(5) + ' | WR:' + r.wr.toFixed(1)+'%' + ' | PF:' + r.pf.toFixed(2) + ' | PnL:' + r.netPnl.toFixed(0) + ' | DD:' + r.mdd.toFixed(1)+'%' + ' | Score:' + r.score.toFixed(0);
}

const results = [];

console.log('\n=== Phase 1: Best Setups ===');
const bestSetups = ['trend_buy', 'trend_sell', 'pullback_buy', 'pullback_sell'];
for (const setups of [
  ['momentum_buy', 'momentum_sell'],
  ['trend_buy', 'trend_sell'],
  ['pullback_buy', 'pullback_sell'],
  ['momentum_buy', 'momentum_sell', 'trend_buy', 'trend_sell'],
  ['trend_buy', 'trend_sell', 'pullback_buy', 'pullback_sell'],
  ['momentum_buy', 'momentum_sell', 'pullback_buy', 'pullback_sell'],
  ['trend_buy', 'trend_sell', 'momentum_buy', 'momentum_sell', 'pullback_buy', 'pullback_sell'],
]) {
  const r = run({ setups, trendMode: 'AND', atrSl: 1.0, riskPercent: 1 });
  results.push({ ...r, label: 'setups=' + setups.join('+')[0], setups });
  const label = setups.join('+').substring(0, 62);
  console.log(label, '|', fmt(r));
}
results.sort((a, b) => b.score - a.score);
const topSetups = results[0].setups;
console.log(`\nBest setups: ${topSetups.join(', ')}`);

console.log('\n=== Phase 2: atrSl (Fixed SL) ===');
const atrSlResults = [];
for (const v of [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0]) {
  const r = run({ setups: topSetups, trendMode: 'AND', atrSl: v, riskPercent: 1 });
  atrSlResults.push({ ...r, atrSl: v });
  console.log('atrSl:', String(v).padEnd(5), '|', fmt(r));
}

console.log('\n=== Phase 3: trailingActivate ===');
const taResults = [];
const bestAtrSl = atrSlResults.sort((a, b) => b.score - a.score)[0].atrSl;
for (const v of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
  const r = run({ setups: topSetups, trendMode: 'AND', atrSl: bestAtrSl, trailingActivate: v, riskPercent: 1 });
  taResults.push({ ...r, trailingActivate: v });
  console.log('trailingActivate:', v.toFixed(2).padStart(7), '|', fmt(r));
}

console.log('\n=== Phase 4: trailingDistance ===');
const tdResults = [];
const bestTa = taResults.sort((a, b) => b.score - a.score)[0].trailingActivate;
for (const v of [0.02, 0.03, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2]) {
  const r = run({ setups: topSetups, trendMode: 'AND', atrSl: bestAtrSl, trailingActivate: bestTa, trailingDistance: v, riskPercent: 1 });
  tdResults.push({ ...r, trailingDistance: v });
  console.log('trailingDistance:', v.toFixed(2).padStart(7), '|', fmt(r));
}

console.log('\n=== Phase 5: trailingDistanceMax + Progressive ===');
for (const maxD of [0.5, 1.0, 2.0, 3.0, 5.0]) {
  for (const prog of [0, 0.01, 0.02, 0.05]) {
    const r = run({ setups: topSetups, trendMode: 'AND', atrSl: bestAtrSl, trailingActivate: bestTa, trailingDistance: 0.03, trailingDistanceMax: maxD, trailingProgressive: prog, riskPercent: 1 });
    results.push({ ...r, label: `maxD=${maxD} prog=${prog}` });
    console.log(`maxD:${String(maxD).padEnd(5)} prog:${String(prog).padEnd(5)}`, '|', fmt(r));
  }
}

console.log('\n=== FINAL: Best Parameters ===');
const allSorted = results.concat(atrSlResults, taResults, tdResults).sort((a, b) => b.score - a.score);
const best = allSorted[0];
console.log(`Best score: ${best.score.toFixed(0)}`);
console.log(`Setups: ${topSetups.join(', ')}`);
console.log(`atrSl: ${bestAtrSl}`);
console.log(`trailingActivate: ${bestTa}`);
const bestTd = tdResults.sort((a, b) => b.score - a.score)[0];
console.log(`trailingDistance: ${bestTd.trailingDistance}`);
console.log('');
console.log(`Result: ${best.trades} trades, WR ${best.wr.toFixed(1)}%, PF ${best.pf.toFixed(2)}, PnL $${best.netPnl.toFixed(2)}, DD ${best.mdd.toFixed(1)}%`);
