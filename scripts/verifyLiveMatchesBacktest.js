// scripts/verifyLiveMatchesBacktest.js
// พิสูจน์ว่า engine/positionTracker (ที่ runLive ใช้จำลอง position แบบ realtime)
// ให้ผลลัพธ์การปิดออเดอร์ (hit SL / TSL, ราคาปิด, PnL) เหมือนกับ backtest (brokerSimulator) ทุกประการ
//
// วิธี: รัน loop แบบเดียวกับ backtest/runBacktest.js ทีละแท่ง
//   - brokerSimulator ทำหน้าที่เป็น "canonical" (สิ่งที่ backtest ใช้)
//   - PositionTracker ทำหน้าที่เป็น "live shadow" โดนป้อนราคาเดียวกันเป๊ะ (candle.high/low + bid/ask จริง)
//   เปิดออเดอร์พร้อมกันในทั้งสองที่ (dealId เดียวกัน) แล้วเทียบการปิดทุกตัว

const fs = require('fs');
const path = require('path');
const config = require('../config');
const BrokerSimulator = require('../broker/brokerSimulator');
const xauStrategy = require('../signals/xauStrategy');
const { calcPositionSize, resolveMaxLot } = require('../sizing');
const { PositionTracker } = require('../engine/positionTracker');
const { getSpread } = require('../broker/spreadHelper');

function loadHistoricalCandles(epic) {
  return JSON.parse(fs.readFileSync(path.join(config.backtest.dataPath, `${epic}.json`), 'utf-8'));
}

function verify(symbolConfig) {
  const { epic } = symbolConfig;
  const sc = config.symbols.find((s) => s.epic === epic) || {};
  const candles = loadHistoricalCandles(epic);
  const pipToPrice = epic === 'XAUUSD' ? 0.01 : (epic === 'USDJPY' ? 0.01 : 0.0001);

  const broker = new BrokerSimulator({
    startingBalance: config.backtest.startingBalance,
    spreadPips: 0,
    pipToPrice,
    leverage: sc.leverage ?? config.broker.leverage,
  });

  const trackerCloses = [];
  const tracker = new PositionTracker({ symbolConfig: sc, onClose: (ev) => trackerCloses.push(ev) });

  const offset = 50;
  const precalc = xauStrategy.precalc ? xauStrategy.precalc(candles, epic) : null;

  for (let i = offset; i < candles.length; i++) {
    broker.tick(candles[i]); // canonical: เช็ค hit SL (ด้วย stop เดิม) + margin call

    const pc = precalc?.[i];
    const atrNow = pc?.atr;
    if (atrNow) tracker.setAtr(atrNow);

    // ---- trailing (เดียวกับ backtest) ----
    if (atrNow && broker.positions.size > 0) {
      const spr = getSpread(candles[i], epic);
      const spreadPrice = spr > 0 ? spr : undefined;
      for (const [dealId, pos] of broker.positions) {
        const trailPos = {
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          currentStopLevel: pos.stopLevel,
          bestPrice: pos.bestPrice != null ? pos.bestPrice : pos.entryPrice,
        };
        const newStop = require('../engine/positionManager').calcTrailingStop(
          trailPos, pos.direction === 'BUY' ? candles[i].high : candles[i].low, atrNow, sc, { spreadPrice }
        );
        pos.stopLevel = newStop;
        pos.bestPrice = trailPos.bestPrice;
      }
    }

    // ---- ป้อนราคาเดียวกับ backtest ให้ tracker (high/low = extreme, bid/ask = spread จริง) ----
    if (broker.positions.size > 0 || true) {
      tracker.onPrice({
        epic,
        bid: candles[i].bid ?? candles[i].close,
        ask: candles[i].ask ?? candles[i].close,
        high: candles[i].high,
        low: candles[i].low,
        timestamp: candles[i].timestamp,
      });
    }

    // ---- signals + open (เปิดพร้อมกันใน broker + tracker) ----
    let signals;
    if (xauStrategy.evaluatePrecalc && precalc?.[i]) {
      const s = xauStrategy.evaluatePrecalc(candles, precalc, i, epic);
      signals = s ? [s] : [];
    } else {
      const window = candles.slice(Math.max(0, i - 100 + 1), i + 1);
      signals = require('../signals').evaluateAll(window, epic);
    }
    if (signals.length === 0) continue;
    if (broker.positions.size >= (config.risk?.maxConcurrentTrades ?? Infinity)) continue;

    for (const signal of signals) {
      const stopLevel = signal.stopLoss;
      if (!stopLevel) continue;
      const liveSpread = getSpread(candles[i], epic);
      let entryUsed = signal.entry, stopUsed = signal.stopLoss;
      if (liveSpread > 0) {
        if (signal.direction === 'BUY') { entryUsed += liveSpread; stopUsed += liveSpread; }
        else { entryUsed -= liveSpread; stopUsed -= liveSpread; }
      }
      const slDist = Math.abs(entryUsed - stopUsed);
      if (slDist <= 0) continue;
      const size = Math.min(
        calcPositionSize({ balance: broker.balance, slDistance: slDist, confidence: signal.confidence, marketDetails: { minDealSize: 0.0001, maxDealSize: 10000 }, symbolConfig }),
        resolveMaxLot(sc, broker.balance, entryUsed)
      );
      const { dealReference } = broker.placeOrder({ epic, direction: signal.direction, size, stopLevel: stopUsed, entryPrice: entryUsed });
      if (!dealReference) continue;
      const actualSize = broker.positions.get(dealReference)?.size ?? size;
      tracker.openPosition({ dealId: dealReference, epic, direction: signal.direction, size: actualSize, entryPrice: entryUsed, stopLevel: stopUsed });
    }
  }

  // ---- เปรียบเทียบ ----
  const brokerSL = broker.settledPositions.filter((p) => p.exitReason === 'STOP_LOSS');
  const byId = new Map(trackerCloses.map((c) => [c.dealId, c]));
  let match = 0, mismatch = 0, unmatchedTracker = 0;
  const examples = [];
  for (const b of brokerSL) {
    const t = byId.get(b.dealId);
    if (!t) { mismatch++; if (examples.length < 5) examples.push({ dealId: b.dealId, issue: 'Tracker ไม่ปิด', brokerExit: b.exitPrice, brokerPnl: b.pnl }); continue; }
    const dExit = Math.abs((t.exitPrice ?? 0) - (b.exitPrice ?? 0));
    const dPnl = Math.abs((t.pnl ?? 0) - (b.pnl ?? 0));
    if (dExit < 1e-6 && dPnl < 1e-6) match++;
    else { mismatch++; if (examples.length < 5) examples.push({ dealId: b.dealId, issue: 'ต่างกัน', brokerExit: b.exitPrice, trackerExit: t.exitPrice, brokerPnl: b.pnl, trackerPnl: t.pnl }); }
  }
  for (const t of trackerCloses) {
    if (!broker.settledPositions.find((b) => b.dealId === t.dealId)) unmatchedTracker++;
  }

  return {
    epic,
    brokerSLCloses: brokerSL.length,
    trackerCloses: trackerCloses.length,
    match,
    mismatch,
    unmatchedTracker,
    matchPercent: brokerSL.length ? ((match / brokerSL.length) * 100).toFixed(4) : 'n/a',
    examples,
  };
}

const results = config.symbols.filter((s) => s.enabled).map(verify);
for (const r of results) {
  console.log(`\n=== ${r.epic} ===`);
  console.log(`broker STOP_LOSS closes : ${r.brokerSLCloses}`);
  console.log(`tracker closes         : ${r.trackerCloses}`);
  console.log(`ตรงกันเป๊ะ (exit+pnl)   : ${r.match}`);
  console.log(`ไม่ตรงกัน              : ${r.mismatch}`);
  console.log(`tracker ปิดแต่ broker ไม่ปิด : ${r.unmatchedTracker}`);
  console.log(`ความตรงกัน            : ${r.matchPercent}%`);
  if (r.examples.length) console.log('ตัวอย่างความคลาดเคลื่อน:', JSON.stringify(r.examples, null, 2));
}
