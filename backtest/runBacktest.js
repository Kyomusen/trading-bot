const fs = require('fs');
const path = require('path');
const config = require('../config');
const BrokerSimulator = require('../broker/brokerSimulator');
const { evaluateAll } = require('../signals');
const xauStrategy = require('../signals/xauStrategy');
const { calcPositionSize, resolveMaxLot } = require('../sizing');
const { createTradeEvent, closeTradeEvent } = require('../engine/tradeEvent');
const { calcTrailingStop } = require('../engine/positionManager');
const { getSpread } = require('../broker/spreadHelper');

// คีย์งวดสำหรับถอนกำไร ('monthly' => YYYY-MM, 'quarterly' => YYYY-Qn, อื่นๆ => null)
function periodKey(ts, freq) {
  if (!freq) return null;
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  if (freq === 'monthly') return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  if (freq === 'quarterly') return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  return null;
}

function loadHistoricalCandles(epic) {
  const filePath = path.join(config.backtest.dataPath, `${epic}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function runBacktestForSymbol(symbolConfig) {
  const { epic } = symbolConfig;
  const candles = loadHistoricalCandles(epic);
  return runBacktestForCandles(symbolConfig, candles);
}

// วิ่ง backtest engine กับ candles ที่กำหนด (ใช้ซ้ำโดย verify script กับแท่งที่บันทึกจาก live)
function runBacktestForCandles(symbolConfig, candles) {
  const { epic } = symbolConfig;
  const sc = config.symbols.find(s => s.epic === epic) || {};
  const pipToPrice = epic === 'XAUUSD' ? 0.01 : (epic === 'USDJPY' ? 0.01 : 0.0001);
  const broker = new BrokerSimulator({
    startingBalance: config.backtest.startingBalance,
    spreadPips: 0,  // bid/ask handles spread cost
    pipToPrice,
    leverage: sc.leverage ?? config.broker.leverage,
  });
  const baseline = config.backtest.startingBalance;
  const withdrawFreq = config.broker.withdraw?.frequency ?? null;
  const target = baseline * (config.broker.withdraw?.targetMultiple ?? 1);
  let lastWKey = null;
  const trades = [];
  const openTradeMap = new Map();
  const offset = 50;
  let lastMaxLot = 0.01;
  const precalc = xauStrategy.precalc ? xauStrategy.precalc(candles) : null;

  for (let i = offset; i < candles.length; i++) {
    broker.tick(candles[i]);

    // ถอนกำไรตามงวด: ช่วงแรกไม่ถอน (ปล่อยทบต้น) จนกว่าพอร์ตจะถึงเป้า (target)
    // พอถึงเป้าแล้วถอนเฉพาะส่วนที่เกินระดับทุนที่ตั้งไว้ รายไตรมาส
    const wKey = periodKey(candles[i].timestamp, withdrawFreq);
    if (wKey && wKey !== lastWKey) {
      if (lastWKey !== null && broker.balance >= target) broker.withdrawProfitAbove(target);
      lastWKey = wKey;
    }

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

    // Trailing stop (จุดเดียวผ่าน positionManager)
    const pc = precalc?.[i];
    const atrNow = pc?.atr;
    if (atrNow && broker.positions.size > 0) {
      const spr = getSpread(candles[i]);
      const spreadPrice = spr > 0 ? spr : undefined;
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
          sc,
          { spreadPrice }
        );
        pos.stopLevel = newStop;
        pos.bestPrice = trailPos.bestPrice;
      }
    }

    // Signals using precalc
    let signals;
    if (xauStrategy.evaluatePrecalc && precalc?.[i]) {
      const s = xauStrategy.evaluatePrecalc(candles, precalc, i);
      signals = s ? [s] : [];
    } else {
      const window = candles.slice(Math.max(0, i - 100 + 1), i + 1);
      signals = evaluateAll(window);
    }
    if (signals.length === 0) continue;

    // ทดสอบ: ปิดออเดอร์ที่ค้างอยู่เมื่อมีสัญญาณสวนทาง (flip)
    if (config.backtest.exitOnOppositeSignal) {
      const mkt = candles[i].close;
      for (const [dealId, pos] of Array.from(broker.positions.entries())) {
        if (signals.some((s) => s.direction !== pos.direction)) {
          broker.closeAt(dealId, mkt, 'OPPOSITE_SIGNAL');
        }
      }
    }

    if (broker.positions.size >= (config.risk?.maxConcurrentTrades ?? Infinity)) continue;

    for (const signal of signals) {
      const stopLevel = signal.stopLoss;
      if (!stopLevel) continue;

      // When real bid/ask is available: BUY enters at ask, SELL at bid
      // คิด spread symmetric ทั้งสองฝั่ง (SELL หักในทิศตรงข้ามกับ BUY)
      let entryUsed = signal.entry;
      let stopUsed = signal.stopLoss;
      const liveSpread = getSpread(candles[i]);
      if (liveSpread > 0) {
        if (signal.direction === 'BUY') {
          entryUsed += liveSpread;
          stopUsed += liveSpread;
        } else {
          entryUsed -= liveSpread;
          stopUsed -= liveSpread;
        }
      }

      const slDist = Math.abs(entryUsed - stopUsed);
      if (slDist <= 0) continue;

      const size = calcPositionSize({
        balance: broker.balance,
        slDistance: slDist,
        confidence: signal.confidence,
        marketDetails: { minDealSize: 0.0001, maxDealSize: 10000 },
        symbolConfig,
      });

      const effMaxLot = resolveMaxLot(sc, broker.balance, entryUsed);
      lastMaxLot = effMaxLot;
      const clampedSize = Math.max(0.0001, Math.min(size, effMaxLot));

      const { dealReference } = broker.placeOrder({
        epic, direction: signal.direction, size: clampedSize,
        stopLevel: stopUsed, entryPrice: entryUsed,
      });
      if (!dealReference) continue; // margin ไม่พอเปิด → ข้าม

      const riskAmt = broker.balance * ((symbolConfig.riskPercent ?? config.sizing.fixedRisk.riskPercent) / 100);
      const actualRisk = clampedSize * slDist;
      const tradeEvent = createTradeEvent({
        strategy: signal.strategy, epic, direction: signal.direction,
        entry: signal.entry, stopLoss: stopLevel, takeProfit: null,
        size: clampedSize,
        riskAmount: Math.min(riskAmt, actualRisk),
        confidence: signal.confidence,
        indicators: signal.indicators,
        openedAt: candles[i].timestamp,
      });

      openTradeMap.set(dealReference, tradeEvent);
      trades.push(tradeEvent);
    }
  }

  for (const [dealId, openEvent] of openTradeMap) {
    const lastCandle = candles[candles.length - 1];
    const exitPrice = (openEvent.direction === 'BUY' && lastCandle.bid !== undefined)
      ? lastCandle.bid
      : (openEvent.direction === 'SELL' && lastCandle.ask !== undefined)
        ? lastCandle.ask
        : lastCandle.close;
    trades.push(closeTradeEvent(openEvent, {
      closedAt: lastCandle.timestamp,
      exitPrice,
      exitReason: 'END_OF_BACKTEST',
      balance: broker.balance,
    }));
  }

  const reasonCounts = {};
  for (const t of trades) {
    if (t.pnl != null) reasonCounts[t.exitReason] = (reasonCounts[t.exitReason] || 0) + 1;
  }

  return { ...summarize(trades, broker.balance, config.backtest.startingBalance, lastMaxLot, broker.withdrawn), reasonCounts, trades };
}

function summarize(trades, finalBalance, startingBalance, maxLot, withdrawn = 0) {
  const closed = trades.filter((t) => t.pnl !== null);
  const wins = closed.filter((t) => t.pnl > 0);
  const totalWin = wins.reduce((sum, t) => sum + t.pnl, 0);
  const totalLoss = closed.reduce((sum, t) => sum + Math.min(t.pnl, 0), 0);

  const buyT = closed.filter((t) => t.direction === 'BUY');
  const buyW = buyT.filter((t) => t.pnl > 0);
  const sellT = closed.filter((t) => t.direction === 'SELL');
  const sellW = sellT.filter((t) => t.pnl > 0);

  const sized = closed.filter((t) => typeof t.size === 'number');
  const avgPositionSize = sized.length ? sized.reduce((s, t) => s + t.size, 0) / sized.length : 0;
  const clamped = sized.filter((t) => t.size >= maxLot * 0.999).length;
  const clampedByMaxLotPercent = sized.length ? (clamped / sized.length) * 100 : 0;

  // รวมกำไรที่ถอนออกแล้วเข้าด้วยกันคำนวณ return จริง
  const totalEquity = finalBalance + withdrawn;
  const totalReturnPercent = ((totalEquity - startingBalance) / startingBalance) * 100;

  return {
    totalTrades: closed.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: totalLoss !== 0 ? Math.abs(totalWin / totalLoss) : null,
    startingBalance,
    finalBalance,
    withdrawn,
    totalEquity,
    returnPercent: ((finalBalance - startingBalance) / startingBalance) * 100,
    totalReturnPercent,
    buyWR: buyT.length ? (buyW.length / buyT.length) * 100 : 0,
    sellWR: sellT.length ? (sellW.length / sellT.length) * 100 : 0,
    buyTrades: buyT.length,
    sellTrades: sellT.length,
    avgPositionSize,
    clampedByMaxLotPercent,
  };
}

function run() {
  const results = config.symbols
    .filter((s) => s.enabled)
    .map((symbolConfig) => ({
      epic: symbolConfig.epic,
      result: runBacktestForSymbol(symbolConfig),
    }));
  const rows = results.map((r) => {
    const { trades, ...rest } = r.result;
    return { epic: r.epic, ...rest };
  });
  console.table(rows);
  return results;
}

module.exports = { run, runBacktestForSymbol, runBacktestForCandles };
