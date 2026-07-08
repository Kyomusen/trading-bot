const fs = require('fs');
const path = require('path');
const config = require('../config');
const BrokerSimulator = require('../broker/brokerSimulator');
const xauStrategy = require('../signals/xauStrategy');
const { calcPositionSize, resolveMaxLot } = require('../sizing');
const { createTradeEvent } = require('../engine/tradeEvent');
const { calcTrailingStop, applyTrailingOverrides } = require('../engine/positionManager');
const { getSpread } = require('../broker/spreadHelper');

function load(epic) {
  return JSON.parse(fs.readFileSync(path.join(config.backtest.dataPath, `${epic}.json`), 'utf-8'));
}

// runDetailed returns metrics computed from ACTUAL broker balance (spread included)
// marginCallFrac: fraction of starting balance that triggers stop-out (0.3 = stop at 30%)
function runDetailed({ candles, trailingAct, trailingDist, maxLot, spreadPips, slippagePips, startingBalance, marginCallFrac }) {
  const epic = 'XAUUSD';
  const pipToPrice = 0.01;
  const startBal = startingBalance ?? config.backtest.startingBalance;
  const sc = config.symbols.find(s => s.epic === epic) || {};
  const defaultSpread = candles.some(c => c.bid !== undefined) ? 0 : (sc.spreadPips ?? 20);
  const broker = new BrokerSimulator({ startingBalance: startBal, spreadPips: spreadPips ?? defaultSpread, pipToPrice, leverage: sc.leverage ?? config.broker.leverage });
  const trades = [];
  const openTradeMap = new Map();
  const offset = 50;
  const effSc = applyTrailingOverrides(sc, trailingAct, trailingDist);
  const mLot = maxLot != null ? maxLot : null; // override: ใช้ fixed แบบเดิม; ถ้าไม่ให้ใช้ dynamic จาก balance
  const precalc = xauStrategy.precalc ? xauStrategy.precalc(candles) : null;
  const equityCurve = [{ time: candles[0]?.timestamp, equity: broker.balance, balance: broker.balance }];
  const slip = slippagePips ?? 0;
  const marginStop = marginCallFrac ? startBal * marginCallFrac : 0;
  let marginCalled = false;

  for (let i = offset; i < candles.length; i++) {
    broker.tick(candles[i]);

    // process settlements — record NET PnL from broker (includes spread)
    for (const settled of broker.settledPositions.splice(0)) {
      const openEvent = openTradeMap.get(settled.dealId);
      if (!openEvent) continue;
      // Use broker's PnL (includes spread) for the trade event
      trades.push({
        ...openEvent,
        closedAt: candles[i].timestamp,
        exitPrice: settled.exitPrice,
        exitReason: settled.exitReason,
        pnl: settled.pnl,          // NET PnL (raw - spread) from broker
        rawPnl: settled.rawPnl,    // PnL without spread
        spreadCost: settled.spreadCost,
        balanceBefore: broker.balance - settled.pnl,
      });
      openTradeMap.delete(settled.dealId);
    }

    if (broker.balance <= 0) break;

    // Margin call check: if equity drops below threshold, liquidate all and stop
    if (marginCallFrac) {
      let mtm = 0;
      for (const [, pos] of broker.positions) {
        const price = getSpread(candles[i]) > 0
          ? (pos.direction === 'BUY' ? candles[i].bid : candles[i].ask)
          : candles[i].close;
        mtm += (pos.direction === 'BUY' ? 1 : -1) * (price - pos.entryPrice) * pos.size;
      }
      const equity = broker.balance + mtm;
      if (equity < marginStop) {
        // Force-close all positions at market
        for (const [dealId, pos] of broker.positions) {
          const exitPrice = getSpread(candles[i]) > 0
            ? (pos.direction === 'BUY' ? candles[i].bid : candles[i].ask)
            : candles[i].close;
          broker._settle(dealId, exitPrice, 'MARGIN_CALL');
        }
        // Process the forced settlements
        for (const settled of broker.settledPositions.splice(0)) {
          const openEvent = openTradeMap.get(settled.dealId);
          if (!openEvent) continue;
          trades.push({
            ...openEvent,
            closedAt: candles[i].timestamp,
            exitPrice: settled.exitPrice,
            exitReason: 'MARGIN_CALL',
            pnl: settled.pnl,
            rawPnl: settled.rawPnl,
            spreadCost: settled.spreadCost,
            balanceBefore: broker.balance - settled.pnl,
          });
          openTradeMap.delete(settled.dealId);
        }
        marginCalled = true;
        break;
      }
    }

    // trailing stop (จุดเดียวผ่าน positionManager)
    const pc = precalc?.[i];
    const atrNow = pc?.atr;
    if (atrNow && broker.positions.size > 0) {
      const liveSpr = getSpread(candles[i]);
      const spreadPrice = liveSpr > 0 ? liveSpr : undefined;
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
          effSc,
          { spreadPrice }
        );
        pos.stopLevel = newStop;
        pos.bestPrice = trailPos.bestPrice;
      }
    }

    // signals
    let signals;
    if (xauStrategy.evaluatePrecalc && precalc?.[i]) {
      const s = xauStrategy.evaluatePrecalc(candles, precalc, i);
      signals = s ? [s] : [];
    } else {
      signals = require('../signals').evaluateAll(candles.slice(Math.max(0, i - 100 + 1), i + 1));
    }
    if (signals.length > 0) {
      for (const signal of signals) {
        let entry = signal.entry;
        let stopLevel = signal.stopLoss;
        const liveSpread = getSpread(candles[i]);
        if (liveSpread > 0 && signal.direction === 'BUY') {
          entry += liveSpread;
          stopLevel += liveSpread;
        }
        if (slip > 0) {
          const slipAmt = (Math.random() * slip) * pipToPrice;
          entry += signal.direction === 'BUY' ? slipAmt : -slipAmt;
        }
        if (!stopLevel) continue;
        const slDist = Math.abs(entry - stopLevel);
        if (slDist <= 0) continue;
        const size = calcPositionSize({ balance: broker.balance, slDistance: slDist, confidence: signal.confidence, marketDetails: { minDealSize: 0.0001, maxDealSize: 10000 }, symbolConfig: sc });
        const effMaxLot = mLot != null ? mLot : resolveMaxLot(sc, broker.balance, entry);
        const clampedSize = Math.max(0.0001, Math.min(size, effMaxLot));
        const { dealReference } = broker.placeOrder({ epic, direction: signal.direction, size: clampedSize, stopLevel, entryPrice: entry });
        if (!dealReference) continue; // margin ไม่พอเปิด → ข้าม
        const riskAmt = broker.balance * ((sc.riskPercent ?? config.sizing.fixedRisk.riskPercent) / 100);
        const actualRisk = clampedSize * slDist;
        const tradeEvent = createTradeEvent({
          strategy: signal.strategy, epic, direction: signal.direction,
          entry, stopLoss: stopLevel, takeProfit: null,
          size: clampedSize, riskAmount: Math.min(riskAmt, actualRisk),
          confidence: signal.confidence, indicators: signal.indicators,
          openedAt: candles[i].timestamp,
        });
        openTradeMap.set(dealReference, tradeEvent);
        trades.push(tradeEvent); // open event (pnl=null)
      }
    }

    // equity curve
    let mtm = 0;
    for (const [, pos] of broker.positions) {
      const price = getSpread(candles[i]) > 0
        ? (pos.direction === 'BUY' ? candles[i].bid : candles[i].ask)
        : candles[i].close;
      mtm += (pos.direction === 'BUY' ? 1 : -1) * (price - pos.entryPrice) * pos.size;
    }
    const equity = Math.max(0, broker.balance + mtm);
    equityCurve.push({ time: candles[i].timestamp, equity, balance: broker.balance });
  }

  // force-close remaining (skip if margin called — already closed)
  if (!marginCalled) {
    for (const [dealId, openEvent] of openTradeMap) {
      const last = candles[candles.length - 1];
      const pos = broker.positions.get(dealId);
      const exitPrice = pos
        ? (last.bid !== undefined
          ? (openEvent.direction === 'BUY' ? last.bid : last.ask)
          : last.close)
        : openEvent.entry;
      if (pos) {
        broker._settle(dealId, exitPrice, 'END_OF_BACKTEST');
        const settled = broker.settledPositions.find(s => s.dealId === dealId);
        if (settled) {
          trades.push({
            ...openEvent,
            closedAt: last.timestamp,
            exitPrice: settled.exitPrice,
            exitReason: 'END_OF_BACKTEST',
            pnl: settled.pnl,
            rawPnl: settled.rawPnl,
            spreadCost: settled.spreadCost,
            balanceBefore: broker.balance - settled.pnl,
          });
        }
      }
    }
  }

  // compute metrics from closed trades with NET PnL (spread included)
  const closed = trades.filter(t => t.pnl !== null && t.pnl !== undefined);
  const wins = closed.filter(t => t.pnl > 0);
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = closed.reduce((s, t) => s + Math.min(t.pnl, 0), 0);
  const totalSpread = closed.reduce((s, t) => s + (t.spreadCost || 0), 0);

  // max DD from equity curve
  let peak = -Infinity, maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }

  // monthly
  const monthly = {};
  for (const t of closed) {
    const d = new Date(t.closedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (!monthly[key]) monthly[key] = { count: 0, wins: 0, pnl: 0, spread: 0 };
    monthly[key].count++;
    if (t.pnl > 0) monthly[key].wins++;
    monthly[key].pnl += t.pnl;
    monthly[key].spread += t.spreadCost || 0;
  }
  const months = Object.entries(monthly).sort((a,b) => a[0].localeCompare(b[0]));
  const greenMonths = months.filter(([,v]) => v.pnl > 0).length;

  return {
    totalTrades: closed.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: totalLoss !== 0 ? Math.abs(totalWin / totalLoss) : null,
    finalBalance: broker.balance,
    netProfit: broker.balance - startBal,
    totalSpread,
    returnPercent: startBal > 0 ? ((broker.balance - startBal) / startBal) * 100 : 0,
    maxDrawdown: maxDd,
    totalMonths: months.length,
    greenMonths,
    marginCalled,
    tradePnLs: closed.map(t => t.pnl),
  };
}

function runDefault(opts = {}) {
  return runDetailed({ candles: load('XAUUSD'), ...opts });
}

// ============================================================
// 1. VERIFY PF/WR WITH SPREAD
// ============================================================
function verifySpreadImpact() {
  console.log('=== SPREAD IMPACT VERIFICATION (PnL from broker balance) ===');
  for (const sp of [0, 10, 20, 30, 50]) {
    const r = runDetailed({ candles: load('XAUUSD'), spreadPips: sp });
    console.log(`  spread=${sp}p: WR=${r.winRate.toFixed(1)}% PF=${r.profitFactor.toFixed(2)} final=$${r.finalBalance.toLocaleString()} net=$${r.netProfit.toLocaleString()} spreadCost=$${r.totalSpread.toLocaleString()} DD=${r.maxDrawdown.toFixed(2)}%`);
  }
}

// ============================================================
// 2. MARGIN CALL SIMULATION
// ============================================================
function marginCallTest() {
  console.log('\n=== MARGIN CALL SIMULATION (stop at 30% of start balance = $300) ===');
  const base = runDetailed({ candles: load('XAUUSD') });
  const mc = runDetailed({ candles: load('XAUUSD'), marginCallFrac: 0.3 });
  console.log(`  No margin call:  final=$${base.finalBalance.toLocaleString()} DD=${base.maxDrawdown.toFixed(2)}%`);
  console.log(`  With margin call: final=$${mc.finalBalance.toLocaleString()} DD=${mc.maxDrawdown.toFixed(2)}% marginCalled=${mc.marginCalled}`);
  console.log(`  Trades: ${mc.totalTrades} WR=${mc.winRate.toFixed(1)}% PF=${mc.profitFactor.toFixed(2)}`);

  // Also test at different spreads
  for (const sp of [20, 30, 40]) {
    const r = runDetailed({ candles: load('XAUUSD'), spreadPips: sp, marginCallFrac: 0.3 });
    console.log(`  spread=${sp}p MC: final=$${r.finalBalance.toLocaleString()} DD=${r.maxDrawdown.toFixed(2)}% called=${r.marginCalled}`);
  }
}

// ============================================================
// 3. BOOTSTRAP MONTE CARLO
// ============================================================
function bootstrapMC(iterations = 10000) {
  console.log(`\n=== BOOTSTRAP MONTE CARLO (${iterations} iterations — resample with replacement) ===`);
  const full = runDetailed({ candles: load('XAUUSD') });
  const pnls = full.tradePnLs;
  const n = pnls.length;
  const startBal = config.backtest.startingBalance;
  const results = [];

  for (let iter = 0; iter < iterations; iter++) {
    let bal = startBal;
    let peak = startBal;
    let dd = 0;
    for (let t = 0; t < n; t++) {
      const idx = Math.floor(Math.random() * n);
      bal += pnls[idx];
      if (bal < 0) bal = 0;
      if (bal > peak) peak = bal;
      if (peak > 0) {
        const d = (peak - bal) / peak * 100;
        if (d > dd) dd = d;
      }
    }
    results.push({ final: bal, dd, ret: (bal - startBal) / startBal * 100 });
    if ((iter + 1) % 2000 === 0) process.stdout.write(`  Bootstrap ${iter + 1}/${iterations}\n`);
  }

  const finals = results.map(r => r.final).sort((a, b) => a - b);
  const dds = results.map(r => r.dd).sort((a, b) => a - b);
  const returns = results.map(r => r.ret).sort((a, b) => a - b);
  const p5 = finals[Math.floor(0.05 * iterations)];
  const p25 = finals[Math.floor(0.25 * iterations)];
  const p50 = finals[Math.floor(0.50 * iterations)];
  const p75 = finals[Math.floor(0.75 * iterations)];
  const p95 = finals[Math.floor(0.95 * iterations)];
  const dd95 = dds[Math.floor(0.95 * iterations)];
  const dd99 = dds[Math.floor(0.99 * iterations)];
  const negReturn = returns.filter(r => r <= 0).length / iterations * 100;

  const p5v = finals[Math.floor(0.05 * iterations)];
  const p25v = finals[Math.floor(0.25 * iterations)];
  const p50v = finals[Math.floor(0.50 * iterations)];
  const p75v = finals[Math.floor(0.75 * iterations)];
  const p95v = finals[Math.floor(0.95 * iterations)];
  const dd95v = dds[Math.floor(0.95 * iterations)];
  const dd99v = dds[Math.floor(0.99 * iterations)];
  console.log(`  Original:  final=$${full.finalBalance.toLocaleString()} DD=${full.maxDrawdown.toFixed(2)}%`);
  console.log(`  Bootstrap P5:  $${p5v.toLocaleString()}`);
  console.log(`  Bootstrap P25: $${p25v.toLocaleString()}`);
  console.log(`  Bootstrap P50: $${p50v.toLocaleString()}`);
  console.log(`  Bootstrap P75: $${p75v.toLocaleString()}`);
  console.log(`  Bootstrap P95: $${p95v.toLocaleString()}`);
  console.log(`  Bootstrap DD@95: ${dd95v.toFixed(2)}%`);
  console.log(`  Bootstrap DD@99: ${dd99v.toFixed(2)}%`);
  console.log(`  Negative return: ${negReturn.toFixed(2)}%`);
}

// ============================================================
// 4. GRID SEARCH TRAILING DISTANCE
// ============================================================
function gridSearchTrailing() {
  console.log('\n=== GRID SEARCH: TRAIL DISTANCE ===');
  const dists = [0.02, 0.03, 0.05, 0.07, 0.10, 0.15, 0.20, 0.30, 0.50];
  for (const d of dists) {
    const r = runDetailed({ candles: load('XAUUSD'), trailingDist: d });
    console.log(`  dist=${d.toFixed(2)}: WR=${r.winRate.toFixed(1)}% PF=${r.profitFactor.toFixed(2)} final=$${r.finalBalance.toLocaleString()} DD=${r.maxDrawdown.toFixed(2)}%`);
  }
}

// ============= RUN ALL =============
console.time('validation');
verifySpreadImpact();
marginCallTest();
bootstrapMC(5000);
gridSearchTrailing();
console.timeEnd('validation');
