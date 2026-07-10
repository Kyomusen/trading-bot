const fs = require('fs');
const path = require('path');
const broker = require('../broker/capitalClient');
const { CapitalStream } = require('../broker/capitalStream');
const config = require('../config');
const { evaluateAll } = require('../signals');
const xauStrategy = require('../signals/xauStrategy');
const { calcPositionSize, resolveMaxLot } = require('../sizing');
const { createTradeEvent, closeTradeEvent } = require('../engine/tradeEvent');
const { PositionTracker } = require('../engine/positionTracker');
const { TF_MS } = require('./candleRecorder');
const { atr } = require('../utils/indicators');
const discordFormatter = require('../notify/discord/formatter');
const discordSender = require('../notify/discord/sender');
const { readState, writeState } = require('./state');
const { logEvent, logCandle, logSignal, logTrade } = require('./liveLogger');
const { generateChartPng } = require('../notify/chart');

const POLL_MS = 5 * 60 * 1000;
const trackers = new Map();
const openTradeMap = new Map();
const streams = [];
const lastEvaluatedBar = new Map();
const lastPrice = new Map();
const lastCandles = new Map();
let _startTs = Date.now();

const _savedState = readState();
global.__lossStreak = _savedState.lossStreak || 0;
function persistState() {
  const m = {};
  for (const [k, v] of lastEvaluatedBar) m[k] = v;
  writeState({ lossStreak: global.__lossStreak, evaluatedBars: m });
}
function persistLossStreak() {
  writeState({ ...readState(), lossStreak: global.__lossStreak });
}

// Restore evaluated bars from saved state (ป้องกัน restart duplicate)
if (_savedState.evaluatedBars) {
  for (const [epic, ts] of Object.entries(_savedState.evaluatedBars)) {
    if (ts) lastEvaluatedBar.set(epic, ts);
  }
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
  logEvent(epic, { type: 'close', dealId: ev.dealId, direction: ev.direction, exitPrice: ev.exitPrice, pnl: ev.pnl, reason: ev.exitReason });
  logTrade(epic, { type: 'CLOSE', epic, dealId: ev.dealId, direction: ev.direction, exitPrice: ev.exitPrice, exitReason: ev.exitReason, pnl: ev.pnl, closedAt: ev.timestamp || Date.now(), strategy: te.strategy });
  try { await discordSender.send(discordFormatter.formatCloseEvent(closeEv)); } catch (e) { logEvent(epic, { type: 'discord_err', context: 'close', msg: e.message }); }
  const tracker = trackers.get(epic);
  if (tracker) tracker.removePosition(ev.dealId);
  openTradeMap.delete(ev.dealId);
}

function feedPrice(epic, price) {
  const tracker = trackers.get(epic);
  if (!tracker) return;
  tracker.onPrice({ epic, bid: price.bid, ask: price.ask, timestamp: price.timestamp });
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
    logEvent(epic, { type: 'skip_spread', spread: liveSpreadPips, limit: configSpreadPips * 1.25 });
    return;
  }

  const { balance } = await broker.getAccountBalance();

  let streakRiskMult = 1;
  if (global.__lossStreak >= 3) streakRiskMult = 0.5;
  else if (global.__lossStreak === 2) streakRiskMult = 0.75;

  const positions = (await broker.getPositions()) || [];
  if (positions.length >= (config.risk?.maxConcurrentTrades || 1)) {
    logEvent(epic, { type: 'skip_positions_full', count: positions.length, max: config.risk?.maxConcurrentTrades || 1 });
    return;
  }

  const existingDirections = new Set(positions.map((p) => p.direction));

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

    if (existingDirections.has(signal.direction)) {
      logEvent(epic, { type: 'skip_direction_exists', direction: signal.direction });
      continue;
    }

    const order = await broker.placeOrder({
      epic: apiEpic, direction: signal.direction, size, stopLevel: stopUsed,
    });
    if (!order || !order.dealReference) {
      logEvent(epic, { type: 'skip_order_failed', reason: 'margin or reject', direction: signal.direction, size });
      continue;
    }

    // Verify order was accepted by broker
    const confirm = await broker.confirmDeal(order.dealReference);
    if (confirm.dealStatus !== 'ACCEPTED' && confirm.status !== 'OPEN') {
      logEvent(epic, { type: 'skip_order_rejected', dealRef: order.dealReference, reason: confirm.reason || confirm.dealStatus });
      continue;
    }

    const actualEntry = confirm.level || entryUsed;
    const actualSiz = confirm.size || size;

    const tracker = trackers.get(epic);
    if (tracker) tracker.openPosition({
      dealId: order.dealReference, brokerDealId: confirm.dealId,
      epic, direction: signal.direction,
      size: actualSiz, entryPrice: actualEntry, stopLevel: stopUsed,
    });

    const riskAmt = balance * ((symbolConfig.riskPercent ?? config.sizing.fixedRisk.riskPercent) / 100);
    const tradeEvent = createTradeEvent({
      strategy: signal.strategy, epic, direction: signal.direction,
      entry: actualEntry, stopLoss: signal.stopLoss, takeProfit: null, size: actualSiz,
      riskAmount: Math.min(riskAmt, actualSiz * slDist),
      confidence: signal.confidence, indicators: signal.indicators,
      openedAt: Date.now(),
    });
    openTradeMap.set(order.dealReference, tradeEvent);
    logEvent(epic, { type: 'open', dealId: order.dealReference, direction: signal.direction, entry: entryUsed, stop: stopUsed, size: actualSiz, fillEntry: actualEntry });
    logTrade(epic, { type: 'OPEN', epic, dealId: order.dealReference, direction: signal.direction, entry: signal.entry, stopLoss: signal.stopLoss, size: actualSiz, openedAt: Date.now(), strategy: signal.strategy, indicators: signal.indicators });
    try { await discordSender.send(discordFormatter.formatOpenEvent(tradeEvent)); } catch (e) { logEvent(epic, { type: 'discord_err', context: 'open', msg: e.message }); }
  }
}

async function crossCheck(epic) {
  const tracker = trackers.get(epic);
  if (!tracker || tracker.positions.size === 0) return;
  let remote;
  try { remote = await broker.getPositions(); } catch { return; }
  const { diffs, autoClosed } = tracker.crossCheck(remote);

  // Fetch broker transaction history (1 วัน) for real PnL
  const fmt = (d) => d.toISOString().slice(0, 19);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  let txns = [];
  try { txns = await broker.getTransactionHistory(fmt(yesterday), fmt(now)); } catch {}

  for (const ev of autoClosed) {
    // Match against broker txn history using brokerDealId (stored from confirmDeal)
    const brokerDealId = ev.brokerDealId;
    let brokerPnl = null;
    if (brokerDealId) {
      const matches = txns.filter((t) => t.dealId === brokerDealId);
      if (matches.length) brokerPnl = matches.reduce((s, t) => s + (t.pnl || 0), 0);
    }
    // Fallback: confirmDeal if brokerDealId wasn't stored (e.g. old positions)
    if (brokerPnl == null) {
      const confirm = await broker.confirmDeal(ev.dealId);
      if (confirm?.dealId) {
        const matches = txns.filter((t) => t.dealId === confirm.dealId);
        if (matches.length) brokerPnl = matches.reduce((s, t) => s + (t.pnl || 0), 0);
      }
    }

    logEvent(epic, {
      type: 'auto_close', dealId: ev.dealId, direction: ev.direction,
      exitPrice: ev.exitPrice, shadowPnl: ev.pnl, brokerPnl, brokerDealId,
    });

    handleClose(epic, { ...ev, pnl: brokerPnl ?? ev.pnl });
  }
  if (diffs.length) {
    logEvent(epic, { type: 'cross_check_mismatch', diffs });
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

  // Save every REST candle to live-recorded before processing
  const existingLines = new Set();
  try {
    const rp = path.join('./data/live-recorded', `${epic}.jsonl`);
    if (fs.existsSync(rp)) {
      const lines = fs.readFileSync(rp, 'utf-8').split('\n').filter(Boolean);
      for (const ln of lines) {
        try { existingLines.add(JSON.parse(ln).timestamp); } catch {}
      }
    }
  } catch {}
  const restCandles = rawCandles
    .map((c) => ({
      timestamp: Date.parse(c.snapshotTimeUTC),
      open: c.openPrice.bid, high: c.highPrice.bid, low: c.lowPrice.bid, close: c.closePrice.bid,
    }))
    .filter((c) => !isNaN(c.timestamp));
  for (const rc of restCandles) {
    if (!existingLines.has(rc.timestamp)) {
      logCandle(epic, { ...rc, source: 'rest' });
      existingLines.add(rc.timestamp);
    }
  }

  lastCandles.set(epic, candles);
  const atrValues = atr(candles, 14);
  const atrNow = atrValues[atrValues.length - 1];
  const tracker = trackers.get(epic);
  if (tracker) tracker.setAtr(atrNow);

  // REST price feed fallback (เมื่อ WS หลุด)
  if (tracker && (!streams.length || streams.every((s) => !s.ready))) {
    const md = await broker.getMarketDetails(apiEpic);
    if (md.bid != null && md.offer != null) feedPrice(epic, { bid: md.bid, ask: md.offer, timestamp: Date.now() });
  }

  // Sync shadow trailing stops → broker REST (ทุก 5m)
  if (tracker && tracker.positions.size > 0) {
    const md = await broker.getMarketDetails(apiEpic).catch(() => null);
    if (md && md.bid != null) feedPrice(epic, { bid: md.bid, ask: md.offer, timestamp: Date.now() });
    for (const [dealId, pos] of tracker.positions) {
      if (pos.closed) continue;
      try {
        await broker.updatePosition(dealId, { stopLevel: pos.stopLevel });
        logEvent(epic, { type: 'trail_sync', dealId, stopLevel: pos.stopLevel });
      } catch (e) {
        logEvent(epic, { type: 'trail_sync_err', dealId, msg: e.message });
      }
    }
  }

  const lastBarTs = candles[candles.length - 1].timestamp;
  const isNewClosedBar = lastEvaluatedBar.get(epic) !== lastBarTs;
  if (atrNow && isNewClosedBar) {
    // Log full signal evaluation before maybeOpen
    const debugSignal = xauStrategy.evaluateDebug(candles, epic);
    logSignal(epic, {
      candleTimestamp: lastBarTs,
      debug: debugSignal,
      evaluatedAt: Date.now(),
    });
    await maybeOpen(symbolConfig, candles, atrNow);
    lastEvaluatedBar.set(epic, lastBarTs);
    persistState();
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
    for (const p of mtm) {
      logEvent(sym.epic, { type: 'position_report', dealId: p.dealId, stopLevel: p.stopLevel?.toFixed(2), uPnL: p.unrealizedPnl?.toFixed(2) });
    }
  }
  logEvent('system', { type: 'balance_report', balance: bal });
}

async function tickAllSymbols() {
  for (const sym of config.symbols) {
    if (!sym.enabled) continue;
    try { await pollSymbol(sym); } catch (err) { logEvent(sym.epic, { type: 'poll_err', msg: err.message }); }
  }
  try { await reportPositions(); } catch {}
}

async function sendHeartbeat() {
  if (!config.notify?.heartbeat?.enabled) return;
  let balance = null;
  try { balance = (await broker.getAccountBalance()).balance; } catch {}

  const symbols = [];
  for (const sym of config.symbols) {
    if (!sym.enabled) continue;
    const { epic } = sym;
    const price = lastPrice.get(epic);
    const ws = streams.find((s) => s.epic === epic);
    const candles = lastCandles.get(epic);
    let indicators = null;
    if (candles && candles.length > 50) {
      try {
        const dbg = xauStrategy.evaluateDebug(candles, epic);
        if (dbg && dbg.indicators) {
          const ind = dbg.indicators;
          indicators = {
            rsi: ind.rsi,
            ema20: ind.ema20,
            ema50: ind.ema50,
            atr: ind.atr,
            adx: ind.adx,
            macd: ind.macd,
            macdHist: ind.macd?.histogram ?? (typeof ind.macd === 'number' ? ind.macd : undefined),
          };
        }
      } catch {}
    }

    const tracker = trackers.get(epic);
    let positions = [];
    if (tracker && tracker.positions.size > 0) {
      for (const pos of tracker.positions.values()) {
        if (pos.closed) continue;
        const mtm = tracker.markToMarket(price || { bid: null, ask: null });
        const mtmEntry = mtm.find((m) => m.dealId === pos.dealId);
        positions.push({
          dealId: pos.dealId,
          direction: pos.direction,
          size: pos.size,
          entryPrice: pos.entryPrice,
          stopLevel: pos.stopLevel,
          unrealizedPnl: mtmEntry?.unrealizedPnl ?? null,
        });
      }
    }

    symbols.push({ epic, price, ws: ws?.ready ?? false, indicators, positions });
  }

  const uptimeMs = Date.now() - _startTs;
  const h = Math.floor(uptimeMs / 3600000);
  const m = Math.floor((uptimeMs % 3600000) / 60000);
  const uptimeStr = `${h}h ${m}m`;

  const payload = discordFormatter.formatHeartbeat({ uptime: uptimeStr, symbols, balance, lossStreak: global.__lossStreak });

  let chartFile = null;
  try {
    const primaryEpic = (config.symbols.find((s) => s.enabled) || {}).epic;
    if (primaryEpic) {
      const candles = lastCandles.get(primaryEpic);
      if (candles && candles.length > 20) {
        const pngBuf = generateChartPng(null, candles);
        chartFile = { buffer: pngBuf, name: 'chart.png', type: 'image/png' };
        payload.embeds[0].image = { url: 'attachment://chart.png' };
      }
    }
  } catch {}

  try {
    await discordSender.send(payload, chartFile);
    logEvent('system', { type: 'heartbeat', balance, positions: symbols.reduce((a, s) => a + s.positions.length, 0), chart: !!chartFile });
  } catch (e) {
    logEvent('system', { type: 'heartbeat_err', msg: e.message });
  }
}

function attachStream(symbolConfig) {
  const { epic, brokerEpic } = symbolConfig;
  const apiEpic = brokerEpic || epic;
  const tracker = new PositionTracker({
    symbolConfig,
    onClose: (ev) => handleClose(epic, ev),
  });
  trackers.set(epic, tracker);

  // CandleRecorder remains instantiated (for reconcile if needed)
  // but feedPrice no longer calls rec.addTick — WS is SL/TSL only

  const stream = new CapitalStream({ epic, brokerEpic: apiEpic });
  stream.on('price', (price) => {
    lastPrice.set(epic, price);
    feedPrice(epic, price);
  });
  stream.on('error', (e) => logEvent(epic, { type: 'ws_error', msg: e.message }));
  stream.on('close', () => {
    logEvent(epic, { type: 'ws_closed' });
  });
  stream.connect();
  streams.push(stream);
}

function flushAll() {
  // no WS candle recording to flush — WS is SL/TSL only
}
process.on('SIGINT', () => { logEvent('system', { type: 'shutdown', signal: 'SIGINT' }); process.exit(0); });
process.on('SIGTERM', () => { logEvent('system', { type: 'shutdown', signal: 'SIGTERM' }); process.exit(0); });

async function start() {
  _startTs = Date.now();
  logEvent('system', { type: 'start', msg: 'เริ่มบอทเทรดสด — WS=SL/TSL only, REST=signals' });

  // Correct lossStreak from broker transaction history (reset wrong shadow PnL)
  try {
    const fmt = (d) => d.toISOString().slice(0, 19);
    const now2 = new Date();
    const from = new Date(now2.getTime() - 3 * 86400000);
    const txns = await broker.getTransactionHistory(fmt(from), fmt(now2));
    // Walk backward: find streaks of consecutive same-sign PnL
    let streak = 0;
    for (let i = txns.length - 1; i >= 0; i--) {
      const pnl = txns[i].pnl;
      if (pnl == null) continue;
      if (pnl < 0) streak++;
      else if (pnl > 0) { streak = 0; break; }
    }
    if (streak !== global.__lossStreak) {
      logEvent('system', { type: 'loss_streak_corrected', from: global.__lossStreak, to: streak });
      global.__lossStreak = streak;
      persistState();
    }
  } catch (e) {
    logEvent('system', { type: 'loss_streak_correction_err', msg: e.message });
  }

  for (const sym of config.symbols) {
    if (!sym.enabled) continue;
    attachStream(sym);
  }
  await tickAllSymbols();
  setInterval(tickAllSymbols, POLL_MS);

  const hbMs = (config.notify?.heartbeat?.intervalMinutes ?? 60) * 60 * 1000;
  if (config.notify?.heartbeat?.enabled) {
    setTimeout(() => sendHeartbeat(), 60000);
    setInterval(sendHeartbeat, hbMs);
  }
}

module.exports = { start, feedPrice, shiftForSpread };
