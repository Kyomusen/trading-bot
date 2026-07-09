const fs = require('fs');
const path = require('path');
const config = require('../config');
const BrokerSimulator = require('../broker/brokerSimulator');
const { evaluateAll } = require('../signals');
const xauStrategy = require('../signals/xauStrategy');
const { calcPositionSize, resolveMaxLot } = require('../sizing');
const { createTradeEvent, closeTradeEvent } = require('../engine/tradeEvent');
const { calcTrailingStop } = require('../engine/positionManager');

function load(epic) {
  return JSON.parse(fs.readFileSync(path.join(config.backtest.dataPath, `${epic}.json`), 'utf-8'));
}

function runDetailed(epic, candlesSubset) {
  const candles = candlesSubset || load(epic);
  const sc = config.symbols.find(s => s.epic === epic) || {};
  const pipToPrice = epic === 'XAUUSD' ? 0.01 : (epic === 'USDJPY' ? 0.01 : 0.0001);
  const broker = new BrokerSimulator({ startingBalance: config.backtest.startingBalance, spreadPips: sc.spreadPips ?? 0, pipToPrice, leverage: sc.leverage ?? config.broker.leverage });
  const trades = [];
  const openTradeMap = new Map();
  const offset = 50;
  const precalc = xauStrategy.precalc ? xauStrategy.precalc(candles, epic) : null;
  const equityCurve = [{ time: candles[0]?.timestamp, equity: broker.balance, balance: broker.balance }];

  for (let i = offset; i < candles.length; i++) {
    broker.tick(candles[i]);
    for (const settled of broker.settledPositions.splice(0)) {
      const openEvent = openTradeMap.get(settled.dealId);
      if (!openEvent) continue;
      trades.push(closeTradeEvent(openEvent, {
        closedAt: candles[i].timestamp,
        exitPrice: settled.exitPrice,
        exitReason: settled.exitReason,
        balance: broker.balance - settled.pnl,
      }));
      openTradeMap.delete(settled.dealId);
    }
    if (broker.balance <= 0) break;

    // trailing stop (จุดเดียวผ่าน positionManager)
    const pc = precalc?.[i];
    const atrNow = pc?.atr;
    if (atrNow && broker.positions.size > 0) {
      for (const [dealId, pos] of broker.positions) {
        const openEvent = openTradeMap.get(dealId);
        if (!openEvent) continue;
        if (pos.bestPrice == null) pos.bestPrice = openEvent.entry;
        const trailPos = {
          direction: pos.direction,
          entryPrice: openEvent.entry,
          currentStopLevel: pos.stopLevel,
          bestPrice: pos.bestPrice,
        };
        const newStop = calcTrailingStop(
          trailPos,
          pos.direction === 'BUY' ? candles[i].high : candles[i].low,
          atrNow,
          sc
        );
        pos.stopLevel = newStop;
        pos.bestPrice = trailPos.bestPrice;
      }
    }

    // signals
    let signals;
    if (xauStrategy.evaluatePrecalc && precalc?.[i]) {
      const s = xauStrategy.evaluatePrecalc(candles, precalc, i, epic);
      signals = s ? [s] : [];
    } else {
      signals = evaluateAll(candles.slice(Math.max(0, i - 100 + 1), i + 1), epic);
    }
    if (signals.length > 0) {
      for (const signal of signals) {
        const stopLevel = signal.stopLoss;
        if (!stopLevel) continue;
        const slDist = Math.abs(signal.entry - stopLevel);
        if (slDist <= 0) continue;
        const size = calcPositionSize({ balance: broker.balance, slDistance: slDist, confidence: signal.confidence, marketDetails: { minDealSize: 0.0001, maxDealSize: 10000 }, symbolConfig: sc });
        const effMaxLot = resolveMaxLot(sc, broker.balance, signal.entry);
        const clampedSize = Math.max(0.0001, Math.min(size, effMaxLot));
        const { dealReference } = broker.placeOrder({ epic, direction: signal.direction, size: clampedSize, stopLevel, entryPrice: signal.entry });
        if (!dealReference) continue; // margin ไม่พอเปิด → ข้าม
        const riskAmt = broker.balance * ((sc.riskPercent ?? config.sizing.fixedRisk.riskPercent) / 100);
        const actualRisk = clampedSize * slDist;
        const tradeEvent = createTradeEvent({
          strategy: signal.strategy, epic, direction: signal.direction,
          entry: signal.entry, stopLoss: stopLevel, takeProfit: null,
          size: clampedSize, riskAmount: Math.min(riskAmt, actualRisk),
          confidence: signal.confidence, indicators: signal.indicators,
          openedAt: candles[i].timestamp,
        });
        openTradeMap.set(dealReference, tradeEvent);
        trades.push(tradeEvent);
      }
    }

    // equity curve: balance + mark-to-market of open positions
    let mtm = 0;
    for (const [, pos] of broker.positions) {
      const dir = pos.direction === 'BUY' ? 1 : -1;
      mtm += (candles[i].close - pos.entryPrice) * dir * pos.size;
    }
    equityCurve.push({ time: candles[i].timestamp, equity: broker.balance + mtm, balance: broker.balance });
  }

  // force-close remaining
  for (const [dealId, openEvent] of openTradeMap) {
    const last = candles[candles.length - 1];
    trades.push(closeTradeEvent(openEvent, { closedAt: last.timestamp, exitPrice: last.close, exitReason: 'END_OF_BACKTEST', balance: broker.balance }));
  }

  // max DD from equity curve
  let peak = -Infinity, maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = (peak - p.equity) / peak * 100;
    if (dd > maxDd) maxDd = dd;
  }

  // aggregate
  const closed = trades.filter(t => t.pnl !== null);
  const wins = closed.filter(t => t.pnl > 0);
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = closed.reduce((s, t) => s + Math.min(t.pnl, 0), 0);

  // monthly breakdown
  const monthly = {};
  for (const t of closed) {
    const d = new Date(t.closedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (!monthly[key]) monthly[key] = { count: 0, wins: 0, pnl: 0 };
    monthly[key].count++;
    if (t.pnl > 0) monthly[key].wins++;
    monthly[key].pnl += t.pnl;
  }

  // yearly breakdown
  const yearly = {};
  for (const t of closed) {
    const key = String(new Date(t.closedAt).getFullYear());
    if (!yearly[key]) yearly[key] = { count: 0, wins: 0, pnl: 0 };
    yearly[key].count++;
    if (t.pnl > 0) yearly[key].wins++;
    yearly[key].pnl += t.pnl;
  }

  return {
    totalTrades: closed.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: totalLoss !== 0 ? Math.abs(totalWin / totalLoss) : null,
    startingBalance: config.backtest.startingBalance,
    finalBalance: broker.balance,
    returnPercent: ((broker.balance - config.backtest.startingBalance) / config.backtest.startingBalance) * 100,
    maxDrawdown: maxDd,
    monthly: Object.entries(monthly).sort((a,b) => a[0].localeCompare(b[0])).map(([k,v]) => ({ month: k, ...v })),
    yearly: Object.entries(yearly).sort((a,b) => a[0].localeCompare(b[0])).map(([k,v]) => ({ year: k, ...v })),
    equityCurve: equityCurve.filter((_, i) => i % 1000 === 0 || i === equityCurve.length - 1),
  };
}

// Walk-forward: train 2004-2012 (first ~50%), test 2013-2026 (second ~50%)
function walkForward(epic) {
  const all = load(epic);
  const midIdx = Math.floor(all.length / 2);
  const midTime = all[midIdx].timestamp;
  const d = new Date(midTime);
  console.log(`Walk-forward split: ${new Date(all[0].timestamp).toISOString().slice(0,10)} -> ${d.toISOString().slice(0,10)} (midpoint)`);
  const firstHalf = all.slice(0, midIdx);
  const secondHalf = all.slice(midIdx);
  const r1 = runDetailed(epic, firstHalf);
  const r2 = runDetailed(epic, secondHalf);
  return { firstHalf: r1, secondHalf: r2 };
}

const epic = 'XAUUSD';
console.log('=== FULL BACKTEST (2004-2026) ===');
const full = runDetailed(epic);
console.log(`Trades: ${full.totalTrades} | WR: ${full.winRate.toFixed(2)}% | PF: ${full.profitFactor.toFixed(2)}`);
console.log(`Balance: $${full.finalBalance.toLocaleString()} | Return: ${full.returnPercent.toFixed(2)}% | Max DD: ${full.maxDrawdown.toFixed(2)}%`);

console.log('\n=== YEARLY ===');
for (const y of full.yearly) {
  const wr = y.count ? (y.wins / y.count * 100).toFixed(1) : '0';
  console.log(`${y.year}: trades=${y.count} wins=${y.wins} WR=${wr}% pnl=$${y.pnl.toFixed(2)}`);
}

console.log('\n=== MONTHLY STATS ===');
const months = full.monthly;
const totalMonths = months.length;
const greenMonths = months.filter(m => m.pnl > 0).length;
const avgMonthlyPnl = months.reduce((s, m) => s + m.pnl, 0) / totalMonths;
const monthlyReturns = months.map(m => m.pnl / config.backtest.startingBalance * 100);
const avgMonthlyReturn = monthlyReturns.reduce((s, v) => s + v, 0) / totalMonths;
console.log(`Total months: ${totalMonths} | Green: ${greenMonths} (${(greenMonths/totalMonths*100).toFixed(1)}%)`);
console.log(`Avg monthly PnL: $${avgMonthlyPnl.toFixed(2)} | Avg monthly return: ${avgMonthlyReturn.toFixed(2)}%`);
const worstMonth = months.reduce((a, b) => a.pnl < b.pnl ? a : b);
const bestMonth = months.reduce((a, b) => a.pnl > b.pnl ? a : b);
console.log(`Worst month: ${worstMonth.month} $${worstMonth.pnl.toFixed(2)}`);
console.log(`Best month: ${bestMonth.month} $${bestMonth.pnl.toFixed(2)}`);

console.log('\n=== WALK-FORWARD ===');
const wf = walkForward(epic);
const fh = wf.firstHalf, sh = wf.secondHalf;
console.log(`First half: trades=${fh.totalTrades} WR=${fh.winRate.toFixed(2)}% PF=${fh.profitFactor.toFixed(2)} return=${fh.returnPercent.toFixed(2)}% maxDD=${fh.maxDrawdown.toFixed(2)}% balance=$${fh.finalBalance.toLocaleString()}`);
console.log(`Second half: trades=${sh.totalTrades} WR=${sh.winRate.toFixed(2)}% PF=${sh.profitFactor.toFixed(2)} return=${sh.returnPercent.toFixed(2)}% maxDD=${sh.maxDrawdown.toFixed(2)}% balance=$${sh.finalBalance.toLocaleString()}`);

console.log('\n=== TOP 10 DRAWDOWN EVENTS ===');
let peak2 = -Infinity, ddEvents = [];
for (const p of full.equityCurve) {
  if (p.equity > peak2) peak2 = p.equity;
  else {
    ddEvents.push({ time: new Date(p.time).toISOString().slice(0,10), dd: (peak2 - p.equity) / peak2 * 100, equity: p.equity, peak: peak2 });
  }
}
ddEvents.sort((a,b) => b.dd - a.dd).slice(0, 10).forEach((e, i) => {
  console.log(`${i+1}. ${e.time} DD=${e.dd.toFixed(2)}% equity=$${e.equity.toFixed(2)} peak=$${e.peak.toFixed(2)}`);
});
