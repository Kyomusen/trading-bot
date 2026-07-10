const fs = require('fs');
const path = require('path');
const broker = require('../broker/capitalClient');
const { CapitalStream } = require('../broker/capitalStream');
const config = require('../config');
const { evaluateAll } = require('../signals');
const { calcPositionSize, resolveMaxLot } = require('../sizing');
const { createTradeEvent, closeTradeEvent } = require('../engine/tradeEvent');
const { PositionTracker } = require('../engine/positionTracker');
const { CandleRecorder, TF_MS } = require('./candleRecorder');
const { atr } = require('../utils/indicators');
const discordFormatter = require('../notify/discord/formatter');
const discordSender = require('../notify/discord/sender');
const { readState, writeState } = require('./state');

const POLL_MS = 60 * 1000;
const trackers = new Map();
const recorders = new Map();
const openTradeMap = new Map();
const streams = [];
const lastEvaluatedBar = new Map();

global.__lossStreak = readState().lossStreak || 0;
function persistLossStreak() {
  writeState({ ...readState(), lossStreak: global.__lossStreak });
}

const TRADE_LOG_DIR = './data/live-trades';
function logTrade(obj) {
  try {
    fs.mkdirSync(TRADE_LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(TRADE_LOG_DIR, `${obj.epic}.jsonl`), JSON.stringify(obj) + '\n');
  } catch (e) { console.error('[live] logTrade err', e.message); }
}

function shiftForSpread(signal, liveSpread) {
  const entryUsed = signal.direction === 'BUY'
    ? signal.entry + liveSpread
    : signal.entry - liveSpread;
  const stopUsed = signal.direction === 'BUY'
    ? signal.stopLoss + liveSpread
    : signal.stopLoss - liveSpread;
  return { entryUsed, stopUsed, slDist: Math.abs(entryUsed - stopUsed) };
}

async function handleClose(epic, ev) {
  const te = openTradeMap.get(ev.dealId);
  if (!te) return;
  let balance = null;
  try { balance = (await broker.getAccountBalance()).balance; } catch {}
  if (ev.pnl != null) {
    if (ev.pnl > 0) global.__lossStreak = 0;
    else if (ev.pnl < 0) global.__lossStreak = (global.__lossStreak || 0) + 1;
    persistLossStreak();
  }

  const closeEv = closeTradeEvent(te, {
    closedAt: ev.timestamp || Date.now(),
    exitPrice: ev.exitPrice,
    exitReason: ev.exitReason,
    balance,
  });
  console.log(`[live] CLOSE ${ev.dealId} ${ev.direction} exit=${ev.exitPrice} pnl=${ev.pnl != null ? ev.pnl.toFixed(2) : '?'} reason=${ev.exitReason}`);
  logTrade({ type: 'CLOSE', epic, dealId: ev.dealId, exitPrice: ev.exitPrice, exitReason: ev.exitReason, pnl: ev.pnl, closedAt: ev.timestamp || Date.now() });
  try { await discordSender.send(discordFormatter.formatCloseEvent(closeEv)); } catch (e) { console.error('[live] discord close err', e.message); }
  const tracker = trackers.get(epic);
  if (tracker) tracker.removePosition(ev.dealId);
  openTradeMap.delete(ev.dealId);
}

function feedPrice(epic, price) {
  const tracker = trackers.get(epic);
  if (!tracker) return;
  const rec = recorders.get(epic);
  if (rec) rec.addTick({ epic, bid: price.bid, ask: price.ask, timestamp: price.timestamp || Date.now() });
  const { stopUpdates, closedEvents } = tracker.onPrice({ epic, bid: price.bid, ask: price.ask, timestamp: price.timestamp });
  for (const u of stopUpdates) {
    broker.updatePosition(u.dealId, { stopLevel: u.stopLevel })
      .then(() => console.log(`[live] trail ${u.dealId} → ${u.stopLevel.toFixed(2)}`))
      .catch((e) => console.error(`[live] updatePosition ${u.dealId} err`, e.message));
  }
  for (const ev of closedEvents) handleClose(epic, ev);
}

async function maybeOpen(symbolConfig, candles, atrNow) {
  const { epic, brokerEpic } = symbolConfig;
  const apiEpic = brokerEpic || epic;
  const sc = config.symbols.find((s) => s.epic === epic) || {};

  const marketDetails = await broker.getMarketDetails(apiEpic);
  const liveSpread = (marketDetails.offer - marketDetails.bid) || 0;
  const liveSpreadPips = liveSpread / (sc.pipValue || 0.01);
  const configSpreadPips = sc.spreadPips || 20;

  if (liveSpreadPips > configSpreadPips * 1.25) {
    console.log(`[live] ${epic} spread ${liveSpreadPips.toFixed(0)}p > ${configSpreadPips * 1.25}p ข้าม`);
    return;
  }

  const { balance } = await broker.getAccountBalance();

  let streakRiskMult = 1;
  if (global.__lossStreak >= 3) streakRiskMult = 0.5;
  else if (global.__lossStreak === 2) streakRiskMult = 0.75;

  const positions = (await broker.getPositions()) || [];
  if (positions.length >= (config.risk?.maxConcurrentTrades || 1)) {
    console.log(`[live] ${epic} มี ${positions.length} position แล้ว ข้าม`);
    return;
  }

  const signals = evaluateAll(candles, epic);
  if (signals.length === 0) return;

  const baseMaxLot = resolveMaxLot(symbolConfig, balance, signals[0].entry);
  for (const signal of signals) {
    const { entryUsed, stopUsed, slDist } = shiftForSpread(signal, liveSpread);
    if (!slDist || slDist <= 0) continue;

    const dynRisk = (symbolConfig.riskPercent ?? config.sizing?.fixedRisk?.riskPercent ?? 1) * streakRiskMult;
    const size = Math.min(
      calcPositionSize({
        balance,
        slDistance: slDist,
        riskPercent: dynRisk,
        confidence: signal.confidence,
        marketDetails: { minDealSize: 0.0001, maxDealSize: 10000 },
        symbolConfig,
      }),
      resolveMaxLot(symbolConfig, balance, entryUsed)
    );

    const order = await broker.placeOrder({
      epic: apiEpic, direction: signal.direction, size, stopLevel: stopUsed,
    });
    if (!order || !order.dealReference) {
      console.log(`[live] ${epic} เปิดไม่สำเร็จ (margin?) ข้าม`);
      continue;
    }

    let actualSize = size;
    try {
      const live = (await broker.getPositions()) || [];
      const lp = live.find((p) => p.dealId === order.dealReference);
      if (lp && lp.size) actualSize = lp.size;
    } catch {}

    const tracker = trackers.get(epic);
    if (tracker) tracker.openPosition({
      dealId: order.dealReference, epic, direction: signal.direction,
      size: actualSize, entryPrice: entryUsed, stopLevel: stopUsed,
    });

    const riskAmt = balance * ((symbolConfig.riskPercent ?? config.sizing.fixedRisk.riskPercent) / 100);
    const tradeEvent = createTradeEvent({
      strategy: signal.strategy, epic, direction: signal.direction,
      entry: signal.entry, stopLoss: signal.stopLoss, takeProfit: null, size: actualSize,
      riskAmount: Math.min(riskAmt, actualSize * slDist),
      confidence: signal.confidence, indicators: signal.indicators,
      openedAt: Date.now(),
    });
    openTradeMap.set(order.dealReference, tradeEvent);
    console.log(`[live] OPEN ${order.dealReference} ${signal.direction} size=${actualSize} @${entryUsed.toFixed(2)} SL=${stopUsed.toFixed(2)}`);
    logTrade({ type: 'OPEN', epic, dealId: order.dealReference, direction: signal.direction, entry: signal.entry, stopLoss: signal.stopLoss, size: actualSize, openedAt: Date.now() });
    try { await discordSender.send(discordFormatter.formatOpenEvent(tradeEvent)); } catch (e) { console.error('[live] discord open err', e.message); }
  }
}

async function crossCheck(epic) {
  const tracker = trackers.get(epic);
  if (!tracker || tracker.positions.size === 0) return;
  let remote;
  try { remote = await broker.getPositions(); } catch { return; }
  const diffs = tracker.crossCheck(remote);
  if (diffs.length) {
    console.log(`[live] CROSS-CHECK ${epic} พบความคลาดเคลื่อน:`);
    for (const d of diffs) console.log('   ', JSON.stringify(d));
  }
}

async function pollSymbol(symbolConfig) {
  const { epic, brokerEpic } = symbolConfig;
  const apiEpic = brokerEpic || epic;
  const sc = config.symbols.find((s) => s.epic === epic) || {};

  const rawCandles = await broker.getCandles(apiEpic, 'HOUR', 100);
  let candles = rawCandles
    .map((c) => ({
      open: c.openPrice.bid, high: c.highPrice.bid, low: c.lowPrice.bid,
      close: c.closePrice.bid, timestamp: Date.parse(c.snapshotTimeUTC),
    }))
    .filter((c) => !isNaN(c.timestamp));
  if (!candles.length) return;

  const barMs = TF_MS[symbolConfig.timeframe || 'HOUR'] || TF_MS.HOUR;
  const lastRaw = candles[candles.length - 1];
  if (lastRaw && (Date.now() - lastRaw.timestamp) < barMs) {
    candles = candles.slice(0, -1);
  }
  if (!candles.length) return;

  const rec = recorders.get(epic);
  if (rec) {
    const rest = rawCandles
      .map((c) => ({
        timestamp: Date.parse(c.snapshotTimeUTC),
        open: c.openPrice.bid, high: c.highPrice.bid, low: c.lowPrice.bid, close: c.closePrice.bid,
      }))
      .filter((c) => !isNaN(c.timestamp));
    const { added, warned } = rec.reconcile(rest, { tolerance: (sc.pipValue || 0.01) * 2 });
    if (added.length) console.log(`[live] reconcile ${epic}: เติม ${added.length} แท่งจาก REST (WS หลุด)`);
    for (const w of warned) console.log(`[live] reconcile WARN ${epic} ts=${w.timestamp} wsClose=${w.wsClose} restClose=${w.restClose} diff=${w.diff}`);
  }

  const atrValues = atr(candles, 14);
  const atrNow = atrValues[atrValues.length - 1];
  const tracker = trackers.get(epic);
  if (tracker) tracker.setAtr(atrNow);

  if (tracker && (!streams.length || streams.every((s) => !s.ready))) {
    const md = await broker.getMarketDetails(apiEpic);
    if (md.bid != null && md.offer != null) feedPrice(epic, { bid: md.bid, ask: md.offer, timestamp: Date.now() });
  }

  const lastBarTs = candles[candles.length - 1].timestamp;
  const isNewClosedBar = lastEvaluatedBar.get(epic) !== lastBarTs;
  if (atrNow && isNewClosedBar) {
    await maybeOpen(symbolConfig, candles, atrNow);
    lastEvaluatedBar.set(epic, lastBarTs);
  }
  await crossCheck(epic);
}

async function reportPositions() {
  const bal = (await broker.getAccountBalance().catch(() => ({ balance: null }))).balance;
  for (const sym of config.symbols) {
    if (!sym.enabled) continue;
    const tracker = trackers.get(sym.epic);
    if (!tracker || tracker.positions.size === 0) continue;
    const md = await broker.getMarketDetails(sym.brokerEpic || sym.epic).catch(() => null);
    const mtm = tracker.markToMarket(md || { bid: null, ask: null });
    for (const p of mtm) console.log(`[live] pos ${sym.epic} ${p.dealId} stop=${p.stopLevel?.toFixed(2)} uPnL=${p.unrealizedPnl?.toFixed(2)}`);
  }
  console.log(`[live] balance=${bal}`);
}

async function tickAllSymbols() {
  for (const sym of config.symbols) {
    if (!sym.enabled) continue;
    try { await pollSymbol(sym); } catch (err) { console.error(`[live] ${sym.epic}:`, err.message); }
  }
  try { await reportPositions(); } catch {}
}

function attachStream(symbolConfig) {
  const { epic, brokerEpic } = symbolConfig;
  const apiEpic = brokerEpic || epic;
  const tracker = new PositionTracker({
    symbolConfig,
    onClose: (ev) => handleClose(epic, ev),
  });
  trackers.set(epic, tracker);

  const recorder = new CandleRecorder({ epic, timeframe: symbolConfig.timeframe || 'HOUR' });
  recorders.set(epic, recorder);

  const stream = new CapitalStream({ epic, brokerEpic: apiEpic });
  stream.on('price', (price) => feedPrice(epic, price));
  stream.on('error', (e) => console.error(`[live] stream ${epic} err:`, e.message));
  stream.on('close', () => {
    console.log(`[live] stream ${epic} closed (fallback ไป REST poll + reconcile)`);
    pollSymbol(symbolConfig).catch((e) => console.error(`[live] reconcile-on-close ${epic} err`, e.message));
  });
  stream.connect();
  streams.push(stream);
}

function flushAll() {
  for (const rec of recorders.values()) rec.flush();
}
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });

async function start() {
  console.log('[live] เริ่มบอทเทรดสด (Capital.com demo) — เชื่อม WebSocket + shadow position tracker');
  for (const sym of config.symbols) {
    if (!sym.enabled) continue;
    attachStream(sym);
  }
  await tickAllSymbols();
  setInterval(tickAllSymbols, POLL_MS);
}

module.exports = { start, feedPrice, shiftForSpread };
