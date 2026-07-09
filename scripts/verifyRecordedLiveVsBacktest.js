// scripts/verifyRecordedLiveVsBacktest.js
// โหลดแท่งที่บันทึกจาก live session จริง (data/live-recorded/{epic}.jsonl)
// แล้วพิสูจน์สองระดับ:
//
//  (A) Lockstep engine check — รัน backtest engine + PositionTracker คู่ขนานบนแท่งที่บันทึก
//      (เหมือน verifyLiveMatchesBacktest แต่ใช้แท่งที่บันทึกจาก live) เพื่อยืนยันว่า
//      ข้อมูลที่บันทึกไหลผ่าน engine ได้ผลตรงกับ backtest (tracker ≈ backtest ~99.9%)
//
//  (B) runLive decision check — เทียบสิ่งที่ runLive.js เปิด/ปิดจริง (data/live-trades/{epic}.jsonl)
//      กับสิ่งที่ backtest replay "ควร" ทำ: ตัดสินใจถูกหรือไม่ วัดจาก DECISION FIELDS
//      (direction / entry / SL / openedAt) ซึ่งเป็นค่าที่ตรงเป๊ะ และ exit-reason (STOP_LOSS)
//      แท่งที่ source:'rest_fallback' (WS หลุด เอา REST มาเติม) แยก stat ต่างหาก
//
// วิธิรัน: node scripts/verifyRecordedLiveVsBacktest.js [epic]

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { runBacktestForCandles } = require('../backtest/runBacktest');
const xauStrategy = require('../signals/xauStrategy');
const { calcPositionSize, resolveMaxLot } = require('../sizing');
const { PositionTracker } = require('../engine/positionTracker');
const { getSpread } = require('../broker/spreadHelper');

const BAR_MS = 3600e3;
const EPIC = process.argv[2] || 'XAUUSD';
const symCfg = config.symbols.find((s) => s.epic === EPIC);
if (!symCfg) { console.error('ไม่พบ symbol', EPIC); process.exit(1); }

function loadJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------- โหลดแท่งที่บันทึก ----------
const recLines = loadJsonl(path.join('./data/live-recorded', `${EPIC}.jsonl`));
const candles = recLines
  .map((c) => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, bid: c.bid, ask: c.ask, source: c.source || 'ws' }))
  .sort((a, b) => a.timestamp - b.timestamp);
const sourceByTs = new Map(candles.map((c) => [c.timestamp, c.source]));
console.log(`\n[recorded] แท่ง: ${candles.length} (ws=${candles.filter((c) => c.source === 'ws').length}, rest_fallback=${candles.filter((c) => c.source === 'rest_fallback').length})`);

// ================= (A) Lockstep engine check =================
// รัน backtest replay + tracker คู่ขนานบนแท่งเดียวกัน (เหมือน verifyLiveMatchesBacktest)
console.log('\n===== (A) Lockstep: tracker vs backtest replay บนแท่งที่บันทึก =====');
const BrokerSimulator = require('../broker/brokerSimulator');
const broker = new BrokerSimulator({ startingBalance: config.backtest.startingBalance, spreadPips: 0, pipToPrice: EPIC === 'XAUUSD' ? 0.01 : 0.0001, leverage: symCfg.leverage });
const trackerCloses = [];
const tracker = new PositionTracker({ symbolConfig: symCfg, onClose: (e) => trackerCloses.push(e) });
const offset = 50;
const precalc = xauStrategy.precalc ? xauStrategy.precalc(candles, EPIC) : null;
for (let i = offset; i < candles.length; i++) {
  broker.tick(candles[i]);
  const atrNow = precalc?.[i]?.atr;
  if (atrNow) tracker.setAtr(atrNow);
  if (atrNow && broker.positions.size > 0) {
    const spr = getSpread(candles[i], EPIC);
    for (const [dealId, pos] of broker.positions) {
      const tp = { direction: pos.direction, entryPrice: pos.entryPrice, currentStopLevel: pos.stopLevel, bestPrice: pos.bestPrice != null ? pos.bestPrice : pos.entryPrice };
      const ns = require('../engine/positionManager').calcTrailingStop(tp, pos.direction === 'BUY' ? candles[i].high : candles[i].low, atrNow, symCfg, { spreadPrice: spr > 0 ? spr : undefined });
      pos.stopLevel = ns; pos.bestPrice = tp.bestPrice;
    }
  }
  if (atrNow) tracker.onPrice({ epic: EPIC, bid: candles[i].bid, ask: candles[i].ask, high: candles[i].high, low: candles[i].low, timestamp: candles[i].timestamp });
  let signals;
  if (xauStrategy.evaluatePrecalc && precalc?.[i]) { const s = xauStrategy.evaluatePrecalc(candles, precalc, i, EPIC); signals = s ? [s] : []; }
  else { const w = candles.slice(Math.max(0, i - 100 + 1), i + 1); signals = require('../signals').evaluateAll(w, EPIC); }
  if (signals.length === 0) continue;
  if (broker.positions.size >= (config.risk?.maxConcurrentTrades ?? Infinity)) continue;
  for (const signal of signals) {
    const liveSpread = getSpread(candles[i], EPIC);
    let entryUsed = signal.entry, stopUsed = signal.stopLoss;
    if (liveSpread > 0) { if (signal.direction === 'BUY') { entryUsed += liveSpread; stopUsed += liveSpread; } else { entryUsed -= liveSpread; stopUsed -= liveSpread; } }
    const slDist = Math.abs(entryUsed - stopUsed); if (slDist <= 0) continue;
    const size = Math.min(calcPositionSize({ balance: broker.balance, slDistance: slDist, confidence: signal.confidence, marketDetails: { minDealSize: 0.0001, maxDealSize: 10000 }, symbolConfig: symCfg }), resolveMaxLot(symCfg, broker.balance, entryUsed));
    const { dealReference } = broker.placeOrder({ epic: EPIC, direction: signal.direction, size, stopLevel: stopUsed, entryPrice: entryUsed });
    if (!dealReference) continue;
    const actualSize = broker.positions.get(dealReference)?.size ?? size;
    tracker.openPosition({ dealId: dealReference, epic: EPIC, direction: signal.direction, size: actualSize, entryPrice: entryUsed, stopLevel: stopUsed });
  }
}
const brokerSL = broker.settledPositions.filter((p) => p.exitReason === 'STOP_LOSS');
const byId = new Map(trackerCloses.map((c) => [c.dealId, c]));
let aOk = 0, aBad = 0;
for (const b of brokerSL) { const t = byId.get(b.dealId); if (!t) { aBad++; continue; } if (Math.abs((t.exitPrice ?? 0) - (b.exitPrice ?? 0)) < 1e-6 && Math.abs((t.pnl ?? 0) - (b.pnl ?? 0)) < 1e-6) aOk++; else aBad++; }
const aPct = brokerSL.length ? ((aOk / brokerSL.length) * 100).toFixed(2) : 'n/a';
console.log(`tracker closes = ${trackerCloses.length}, broker STOP_LOSS = ${brokerSL.length}`);
console.log(`tracker vs backtest ตรงกันเป๊ะ (exit+pnl): ${aOk}/${brokerSL.length} (${aPct}%)  — คาดหวัง ~99.9% (เช่นเดียวกับ verifyLiveMatchesBacktest)`);

// ================= (B) runLive decision check =================
console.log('\n===== (B) runLive trade-log vs backtest replay =====');
const { trades: expected } = runBacktestForCandles(symCfg, candles);
const expClosed = expected.filter((t) => t.pnl != null);
console.log(`backtest replay ปิด: ${expClosed.length}`);

const logLines = loadJsonl(path.join('./data/live-trades', `${EPIC}.jsonl`));
const opens = logLines.filter((l) => l.type === 'OPEN');
const closes = logLines.filter((l) => l.type === 'CLOSE');
const actualByDeal = new Map();
for (const o of opens) actualByDeal.set(o.dealId, { ...o });
for (const c of closes) actualByDeal.set(c.dealId, { ...actualByDeal.get(c.dealId), ...c, closed: true });
const actualArr = Array.from(actualByDeal.values()).filter((a) => a.closed);
console.log(`runLive ปิด: ${actualArr.length} (opens=${opens.length})`);

const tol = (symCfg.pipValue || 0.01) * 5;
const dec = { ws: { ok: 0, bad: 0 }, rest: { ok: 0, bad: 0 } };
const reason = { ws: { ok: 0, bad: 0 }, rest: { ok: 0, bad: 0 } };
const examples = [];
for (const e of expClosed) {
  const grp = (sourceByTs.get(e.openedAt) === 'rest_fallback') ? 'rest' : 'ws';
  const hit = actualArr.find((a) =>
    a.direction === e.direction &&
    Math.abs((a.openedAt || 0) - e.openedAt) <= 2 * BAR_MS &&
    Math.abs((a.entry ?? 0) - (e.entry ?? 0)) < tol &&
    Math.abs((a.stopLoss ?? 0) - (e.stopLoss ?? 0)) < tol
  );
  if (!hit) { dec[grp].bad++; if (examples.length < 8) examples.push({ issue: 'BACKTEST_ควรเปิดแต่_LIVE_ไม่เปิด', expected: { direction: e.direction, entry: e.entry, ts: e.openedAt } }); continue; }
  // ตัดสินใจถูก = direction/entry/SL/time ตรง
  dec[grp].ok++;
  const rk = (hit.exitReason || '') === (e.exitReason || '') ? 'ok' : 'bad';
  reason[grp][rk]++;
}
const pct = (m) => { const t = m.ok + m.bad; return t ? ((m.ok / t) * 100).toFixed(2) : 'n/a'; };
console.log(`Decision match (direction/entry/SL/time):`);
console.log(`  WS-derived : ${dec.ws.ok}/${dec.ws.ok + dec.ws.bad} (${pct(dec.ws)}%)`);
console.log(`  rest_fallback: ${dec.rest.ok}/${dec.rest.ok + dec.rest.bad} (${pct(dec.rest)}%)  [คาดหวังต่ำ เพราะไม่มี bid/ask จริง]`);
console.log(`Exit-reason match (STOP_LOSS ตรงกัน):`);
console.log(`  WS-derived : ${reason.ws.ok}/${reason.ws.ok + reason.ws.bad} (${pct(reason.ws)}%)`);
console.log(`  rest_fallback: ${reason.rest.ok}/${reason.rest.ok + reason.rest.bad} (${pct(reason.rest)}%)`);
const unmatched = actualArr.filter((a) => !expClosed.some((e) => e.direction === a.direction && Math.abs((e.openedAt || 0) - (a.openedAt || 0)) <= 2 * BAR_MS && Math.abs((e.entry ?? 0) - (a.entry ?? 0)) < tol)).length;
console.log(`LIVE เปิดแต่ backtest ไม่ควร: ${unmatched}`);
if (examples.length) { console.log('\nตัวอย่าง mismatch:'); console.log(JSON.stringify(examples, null, 2)); }
