// scripts/dryRunLive.js
// ตัวจำลอง live session แบบไม่ต้องต่อ network (mock/dry-run)
// รีเพลย์แท่ง historical จริง เป็น tick ไหลเข้า CandleRecorder + PositionTracker
// ใช้ BrokerSimulator เป็นบรokerจำลอง (เปิด/ปิดออเดอร์ + บันทึก trade log เหมือน runLive)
// รองรับจำลอง WS หลุด (--drop a-b) และจำลอง kill/restart ด้วย --phase 1 / --phase 2
//
// วิธีรัน (จำลอง crash กลางทางแล้ว restart):
//   node scripts/dryRunLive.js --phase 1 --clear --split 500 --drop 300-320
//   node scripts/dryRunLive.js --phase 2 --split 500 --end 1000
//   node scripts/verifyRecordedLiveVsBacktest.js XAUUSD
//
// หมายเหตุ: เขียนลง data/live-recorded/{epic}.jsonl และ data/live-trades/{epic}.jsonl
//           (path เดียวกับ runLive จริง เพื่อให้ verify script ใช้ได้เลย)

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { CandleRecorder } = require('../live/candleRecorder');
const { PositionTracker } = require('../engine/positionTracker');
const BrokerSimulator = require('../broker/brokerSimulator');
const { evaluateAll } = require('../signals');
const { calcPositionSize, resolveMaxLot } = require('../sizing');
const { createTradeEvent, closeTradeEvent } = require('../engine/tradeEvent');
const { atr } = require('../utils/indicators');

const EPIC = 'XAUUSD';
const symCfg = config.symbols.find((s) => s.epic === EPIC);
const SPREAD = 0.25; // 25 pip สำหรับ gold (mock)
const TF_MS = 3600e3;

// ---- parse args ----
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--clear') args.clear = true;
  else if (a === '--phase') args.phase = Number(process.argv[++i]);
  else if (a === '--split') args.split = Number(process.argv[++i]);
  else if (a === '--end') args.end = Number(process.argv[++i]);
  else if (a === '--drop') { const [s, e] = process.argv[++i].split('-').map(Number); args.drop = [s, e]; }
}
const SPLIT = args.split || 500;
const END = args.end || 1000;
const PHASE = args.phase || 1;

// ลบ log เก่า (ต้องทำก่อนสร้าง recorder มิฉะนั้น recorder จะจำ lastWrittenTs ของไฟล์เก่า)
if (args.clear) {
  for (const f of ['./data/live-recorded', './data/live-trades']) {
    try { fs.rmSync(path.join(f, `${EPIC}.jsonl`), { force: true }); } catch {}
  }
}

// ---- state ----
const broker = new BrokerSimulator({ startingBalance: config.backtest.startingBalance, spreadPips: 0, pipToPrice: 0.01, leverage: symCfg.leverage });
const tracker = new PositionTracker({
  symbolConfig: symCfg,
  onClose: (ev) => {
    broker.closeAt(ev.dealId, ev.exitPrice, ev.exitReason);
    logTrade({ type: 'CLOSE', epic: EPIC, dealId: ev.dealId, exitPrice: ev.exitPrice, exitReason: ev.exitReason, pnl: ev.pnl, closedAt: ev.timestamp || Date.now() });
    console.log(`  [dry] CLOSE ${ev.dealId} ${ev.direction} exit=${ev.exitPrice} pnl=${ev.pnl?.toFixed(2)} ${ev.exitReason}`);
  },
});
const recorder = new CandleRecorder({ epic: EPIC, timeframe: 'HOUR', onCandleClose: () => {} });
const openTradeMap = new Map();

function logTrade(obj) {
  fs.mkdirSync('./data/live-trades', { recursive: true });
  fs.appendFileSync(path.join('./data/live-trades', `${EPIC}.jsonl`), JSON.stringify(obj) + '\n');
}
function shiftForSpread(signal, liveSpread) {
  const entryUsed = signal.direction === 'BUY' ? signal.entry + liveSpread : signal.entry - liveSpread;
  const stopUsed = signal.direction === 'BUY' ? signal.stopLoss + liveSpread : signal.stopLoss - liveSpread;
  return { entryUsed, stopUsed, slDist: Math.abs(entryUsed - stopUsed) };
}

// ---- load historical เป็นทั้ง "tick source" และ "REST fallback source" ----
const allBars = JSON.parse(fs.readFileSync(path.join(config.backtest.dataPath, `${EPIC}.json`), 'utf8'));
const startTs = allBars[0].timestamp;

function ticksForBar(barIdx) {
  const bar = allBars[barIdx];
  const b0 = bar.timestamp;
  const path_ = [bar.open, bar.high, bar.low, bar.close];
  const ticks = [];
  for (let k = 0; k < path_.length; k++) {
    const bid = path_[k];
    ticks.push({ epic: EPIC, bid, ask: bid + SPREAD, high: bar.high, low: bar.low, timestamp: b0 + Math.floor((k / path_.length) * TF_MS) });
  }
  return ticks;
}

function decisionPass() {
  const candles = recorder.toArray().slice(-100);
  if (candles.length < 50) return;
  const a = atr(candles, 14);
  const atrNow = a[a.length - 1];
  if (!atrNow) return;
  tracker.setAtr(atrNow);
  const signals = evaluateAll(candles, EPIC);
  if (!signals.length) return;
  if (broker.positions.size >= (config.risk?.maxConcurrentTrades ?? Infinity)) return;
  const openTs = candles[candles.length - 1].timestamp; // บาร์ที่สัญญาณเกิด (ตรงกับ backtest openedAt)
  for (const signal of signals) {
    const { entryUsed, stopUsed, slDist } = shiftForSpread(signal, SPREAD);
    if (!slDist || slDist <= 0) continue;
    const size = Math.min(
      calcPositionSize({ balance: broker.balance, slDistance: slDist, confidence: signal.confidence, marketDetails: { minDealSize: 0.0001, maxDealSize: 10000 }, symbolConfig: symCfg }),
      resolveMaxLot(symCfg, broker.balance, entryUsed)
    );
    const { dealReference } = broker.placeOrder({ epic: EPIC, direction: signal.direction, size, stopLevel: stopUsed, entryPrice: entryUsed });
    if (!dealReference) continue;
    const actualSize = broker.positions.get(dealReference)?.size ?? size;
    tracker.openPosition({ dealId: dealReference, epic: EPIC, direction: signal.direction, size: actualSize, entryPrice: entryUsed, stopLevel: stopUsed });
    const te = createTradeEvent({ strategy: signal.strategy, epic: EPIC, direction: signal.direction, entry: signal.entry, stopLoss: signal.stopLoss, takeProfit: null, size: actualSize, riskAmount: actualSize * slDist, confidence: signal.confidence, indicators: signal.indicators, openedAt: openTs });
    openTradeMap.set(dealReference, te);
    logTrade({ type: 'OPEN', epic: EPIC, dealId: dealReference, direction: signal.direction, entry: signal.entry, stopLoss: signal.stopLoss, size: actualSize, openedAt: openTs });
    console.log(`  [dry] OPEN ${dealReference} ${signal.direction} size=${actualSize} @${entryUsed.toFixed(2)} SL=${stopUsed.toFixed(2)}`);
  }
}
let _lastBarTs = startTs;
function barTsOf() { return _lastBarTs; }

// ---- main loop (phase-based) ----
const from = PHASE === 1 ? 0 : SPLIT;
const to = PHASE === 1 ? SPLIT : END;

for (let i = from; i < to; i++) {
  _lastBarTs = allBars[i].timestamp;
  broker.currentPrice = { bid: allBars[i].close, offer: allBars[i].close + SPREAD };
  // จำลอง WS หลุดในช่วง --drop: ข้ามการป้อน tick ของแท่งนั้นๆ (ข้อมูลหาย)
  const inDrop = args.drop && i >= args.drop[0] && i < args.drop[1];
  if (!inDrop) {
    // recorder ได้ tick เต็มรูป (OHLC ถูกต้อง)
    for (const t of ticksForBar(i)) recorder.addTick(t);
    // tracker ได้ 1 tick ต่อแท่ง ที่มี high/low กำกับ → ตรวจ hit ด้วย stop เก่าแล้วค่อย trail
    // (ตรงกับ semantics ของ backtest: tick() เช็ค stop เก่า แล้วค่อย trailing)
    const b = allBars[i];
    tracker.onPrice({ epic: EPIC, bid: b.close, ask: b.close + SPREAD, high: b.high, low: b.low, timestamp: b.timestamp + TF_MS / 2 });
  }
  decisionPass();
}

// จำลอง WS หลุด → reconcile เติมจาก REST (ใช้ historical เป็น REST source)
if (args.drop) {
  const rest = [];
  for (let i = args.drop[0]; i < args.drop[1]; i++) {
    const b = allBars[i];
    rest.push({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close });
  }
  const { added, warned } = recorder.reconcile(rest, { tolerance: 0.02 });
  console.log(`[dry] reconcile phase${PHASE}: เติม ${added.length} แท่ง rest_fallback, warned=${warned.length}`);
}

if (PHASE === 2) {
  // จำลอง REST ดึงชดเชยช่วงที่ WS หลุดตอน crash: reconcile แท่งค้าง (bar 499) ให้เต็ม
  const gapRest = [];
  for (let i = Math.max(0, SPLIT - 2); i <= Math.min(END, SPLIT + 2); i++) {
    const b = allBars[i];
    gapRest.push({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close });
  }
  const { added } = recorder.reconcile(gapRest, { tolerance: 0.02 });
  console.log(`[dry] crash-gap reconcile: เติม ${added.length} แท่งค้างตอน crash (แตะศูนย์ช่องว่าง)`);
  recorder.flush();
}

// ---- รายงาน ----
const recLines = fs.existsSync(`./data/live-recorded/${EPIC}.jsonl`) ? fs.readFileSync(`./data/live-recorded/${EPIC}.jsonl`, 'utf8').split('\n').filter(Boolean) : [];
const tsList = recLines.map((l) => JSON.parse(l).timestamp);
const uniq = new Set(tsList);
let maxGap = 0;
for (let k = 1; k < tsList.length; k++) maxGap = Math.max(maxGap, tsList[k] - tsList[k - 1]);
console.log(`\n[phase ${PHASE}] บันทึกแท่ง: ${tsList.length} บรรทัด, unique ts=${uniq.size}, maxGap=${maxGap}ms (บาร์=${TF_MS}ms)`);
console.log(`[phase ${PHASE}] เปิด=${openTradeMap.size}, broker.balance=${broker.balance.toFixed(2)}, แท่ง ws=${(recLines.filter(l=>JSON.parse(l).source==='ws')).length}, rest_fallback=${(recLines.filter(l=>JSON.parse(l).source==='rest_fallback')).length}`);
console.log(PHASE === 1 ? '[phase 1] จบ (จำลอง crash โดยไม่ flush แท่งค้าง) — รัน phase 2 ต่อ' : '[phase 2] จบ + flush เรียบร้อย');
