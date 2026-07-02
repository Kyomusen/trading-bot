const { createBroker, CapitalBroker } = require('./brokers');
const { getEnabledSymbols, getSymbolConfig } = require('../symbols.config');
const DataStore = require('./dataStore');
const BacktestReport = require('./backtestReport');
const DiscordNotifier = require('./discord');
const { pipToPrice, pipValuePerLot } = require('./strategy');
const { fetchCandlesCached } = require('./dataSource');
const { generateChart } = require('./chart');
const tradeEngine = require('./tradeEngine');
const fs = require('fs');
const path = require('path');

// Load .env file
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

const STATE_FILE = path.join(__dirname, '..', 'logs', 'live_state.json');
const TRADES_FILE = path.join(__dirname, '..', 'logs', 'live_trades.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return { round: 0 }; }
}
function saveState(s) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function loadTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf-8')); } catch { return []; }
}
function saveTrades(trades) {
  const dir = path.dirname(TRADES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

const DISPLAY_LIMIT = 30;

class Runner {
  constructor(options = {}) {
    this.mode = options.mode || 'stream';
    this.symbolFilter = options.symbol || null;
    this.discord = new DiscordNotifier(
      process.env.DISCORD_WEBHOOK_URL,
      process.env.DISCORD_ERROR_WEBHOOK_URL
    );
    this.dataStore = new DataStore();
    this.brokers = new Map();
  }

  async init() {
    const symbols = this.symbolFilter
      ? [getSymbolConfig(this.symbolFilter)].filter(Boolean)
      : getEnabledSymbols();

    for (const symConfig of symbols) {
      this.brokers.set(symConfig.symbol, { broker: null, config: symConfig });
    }
  }

  _getBrokerConfig(type) {
    const configs = {
      capital: {
        apiKey: process.env.CAPITAL_API_KEY,
        identifier: process.env.CAPITAL_EMAIL,
        password: process.env.CAPITAL_PASSWORD,
        demo: process.env.CAPITAL_DEMO !== 'false',
      },
      oanda: {
        apiKey: process.env.OANDA_API_KEY,
        accountId: process.env.OANDA_ACCOUNT_ID,
        demo: process.env.OANDA_DEMO !== 'false',
      },
    };
    return configs[type] || {};
  }

  _isDuplicateSignal(lastSignals, symbol, signal, config = {}) {
    const last = lastSignals?.[symbol];
    if (!last) return false;
    if (!last.time) return false;
    const hours = config.duplicateHours ?? 6;
    if (Date.now() - last.time > hours * 3600000) return false;
    return last.signal === signal.signal && last.reason === signal.reason;
  }

  async runStream() {
    const state = loadState();
    state.round = (state.round || 0) + 1;
    saveState(state);
    console.log(`\n🤖 Streaming Mode #${state.round}`);
    if (!state.lastSignals) state.lastSignals = {};
    if (!state.positions) state.positions = {};
    if (!state.consecutiveLosses) state.consecutiveLosses = {};

    const MarketStream = require('./marketStream');
    const timers = [];

    for (const [symbol, entry] of this.brokers) {
      const { config } = entry;

      const brokerType = config.broker || 'capital';
      const brokerConfig = this._getBrokerConfig(brokerType);
      const broker = createBroker(brokerType, brokerConfig);
      await broker.connect();
      entry.broker = broker;

      const candles = await fetchCandlesCached(symbol, config.timeframe || 'H1', config);
      console.log(`[${symbol}] Initial data: ${candles.length} candles`);

      const shared = require('./strategy');
      const strategy = require(`../symbols/${symbol}/strategy`);
      const EPIC_MAP = { XAUUSD: 'GOLD', USDJPY: 'USDJPY' };
      const epic = EPIC_MAP[symbol] || symbol;

      // Restore or detect existing broker position
      let brokerPositions;
      try {
        brokerPositions = await broker.getOpenPositions(symbol);
      } catch (err) {
        console.log(`[${symbol}] Failed to fetch positions: ${err.message}`);
        brokerPositions = [];
      }
      if (brokerPositions.length > 0) {
        const pos = brokerPositions[0];
        if (!state.positions[symbol]) {
          const ind = shared.getIndicators(candles);
          state.positions[symbol] = {
            type: pos.type,
            entry: pos.entryPrice,
            sl: pos.sl,
            size: pos.size,
            atrValue: ind.atr || 0,
            bestPrice: pos.entryPrice,
            currentTrailDist: null,
            trailingActivated: false,
            dealId: pos.id,
          };
          saveState(state);
          console.log(`[${symbol}] Restored position: ${pos.type} ${pos.size} @ ${pos.entryPrice}`);
        } else {
          state.positions[symbol].dealId = pos.id;
          saveState(state);
        }
        // Ensure trade history has an OPEN record for this position
        const allTrades = loadTrades();
        const hasOpen = allTrades.some(t => t.symbol === symbol && t.status === 'OPEN');
        if (!hasOpen) {
          allTrades.push({
            round: state.round,
            time: new Date().toISOString(),
            symbol,
            action: pos.type,
            type: pos.type,
            entry: pos.entryPrice,
            sl: pos.sl,
            size: pos.size,
            setup: 'restored',
            status: 'OPEN',
            pnl: 0,
          });
          saveTrades(allTrades);
        }
      } else if (state.positions?.[symbol]) {
        // Position was stopped out while bot was down
        console.log(`[${symbol}] Position closed on broker, clearing stale state`);
        const closed = state.positions[symbol];
        delete state.positions[symbol];
        saveState(state);

        // Estimate PnL from latest candle
        let pnl = 0;
        const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
        if (lastCandle && closed.size) {
          const pvpl = pipValuePerLot(symbol);
          pnl = closed.type === 'BUY'
            ? (lastCandle.close - closed.entry) * closed.size * pvpl
            : (closed.entry - lastCandle.close) * closed.size * pvpl;
        }

        if (!state.consecutiveLosses) state.consecutiveLosses = {};
        state.consecutiveLosses[symbol] = pnl < 0 ? (state.consecutiveLosses[symbol] || 0) + 1 : 0;
        saveState(state);

        // Record the close in trade history
        const trades = loadTrades();
        const openTrade = [...trades].reverse().find(t => t.symbol === symbol && t.status === 'OPEN');
        if (openTrade) {
          openTrade.status = 'CLOSED';
          openTrade.closeTime = new Date().toISOString();
          openTrade.pnl = parseFloat(pnl.toFixed(2));
        } else {
          trades.push({
            round: state.round,
            time: closed.time || new Date().toISOString(),
            symbol,
            action: closed.type,
            entry: closed.entry,
            sl: closed.sl,
            size: closed.size,
            setup: 'restored',
            status: 'CLOSED',
            closeTime: new Date().toISOString(),
            pnl: parseFloat(pnl.toFixed(2)),
          });
        }
        saveTrades(trades);
      }

      // Connect WebSocket for real-time prices
      const stream = new MarketStream({
        cst: broker.cst,
        securityToken: broker.securityToken,
        demo: brokerConfig.demo,
      });
      await stream.connect();
      stream.subscribe(epic);
      console.log(`[${symbol}] WebSocket connected → ${epic}`);

      let lastH1Time = candles.length > 0
        ? this._getH1Start(new Date(candles[candles.length - 1].time))
        : this._getH1Start(new Date());

      // Local candle builder from WebSocket ticks
      const runningCandles = [...candles];
      let curCandle = null;

      // Price tick → build local candle + update bestPrice (trail at H1 close only)
      let tickCount = 0;
      stream.on(`price:${epic}`, (payload) => {
        const bid = payload?.closePrice?.bid ?? payload?.bid ?? null;
        if (bid == null) return;

        if (!curCandle) {
          const h1Start = this._getH1Start(new Date());
          curCandle = {
            time: new Date(h1Start).toISOString(),
            open: bid,
            high: bid,
            low: bid,
            close: bid,
          };
        } else {
          const candleH1 = this._getH1Start(new Date(curCandle.time));
          const nowH1 = this._getH1Start(new Date());
          if (nowH1 > candleH1) {
            runningCandles.push(curCandle);
            runningCandles.splice(0, runningCandles.length - 720);
            curCandle = {
              time: new Date(nowH1).toISOString(),
              open: bid,
              high: bid,
              low: bid,
              close: bid,
            };
          } else {
            curCandle.high = Math.max(curCandle.high, bid);
            curCandle.low = Math.min(curCandle.low, bid);
            curCandle.close = bid;
          }
        }

        tickCount++;
        if (tickCount % 100 === 0) {
          console.log(`[${symbol}] Price: ${bid} (ticks: ${tickCount})`);
        }
        this._manageStreamPosition(symbol, config, state, bid);
      });

      // Check for new H1 candle every 30s → run signal analysis + trail
      const candleTimer = setInterval(() => {
        const now = new Date();
        const h1Start = this._getH1Start(now);
        if (h1Start <= lastH1Time) return;
        lastH1Time = h1Start;
        console.log(`[${symbol}] New H1 candle`);

        // Only push curCandle to runningCandles if it's from a completed H1
        // (curH1 < h1Start). This avoids duplicating a candle that the tick
        // handler already pushed when the H1 boundary was crossed.
        if (curCandle) {
          const curH1 = this._getH1Start(new Date(curCandle.time));
          if (curH1 < h1Start) {
            runningCandles.push(curCandle);
            runningCandles.splice(0, runningCandles.length - 720);
            curCandle = null;
          }
          // If curH1 >= h1Start then curCandle is already the in-progress
          // candle for the current H1 → keep it, next tick continues building.
        }

        this._handleStreamSignal(symbol, config, state, entry, broker, runningCandles).catch(() => {});
        this._trailOnH1Close(symbol, config, state, entry).catch(() => {});
      }, 30000);
      timers.push(candleTimer);

      // Refresh position from broker every 60s
      const refreshTimer = setInterval(() => {
        this._checkStreamPosition(symbol, config, state, entry).catch(() => {});
      }, 60000);
      timers.push(refreshTimer);
    }

    // Heartbeat every 5 minutes
    const heartbeatTimer = setInterval(() => {
      const pos = [...this.brokers.keys()].map(s => state.positions?.[s] ? 'OPEN' : 'NONE').join(', ');
      console.log(`[HEARTBEAT] Round #${state.round} | Positions: ${pos || 'NONE'} | ${new Date().toISOString()}`);
    }, 300000);
    timers.push(heartbeatTimer);

    const shutdown = () => {
      console.log('\nShutting down...');
      for (const t of timers) clearInterval(t);
      for (const [, e] of this.brokers) {
        if (e.broker) e.broker.disconnect();
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await new Promise(() => {});
  }

  _getH1Start(date) {
    return Math.floor(date.getTime() / 3600000) * 3600000;
  }

  _manageStreamPosition(symbol, config, state, bid) {
    const sp = state.positions?.[symbol];
    if (!sp || !sp.atrValue || sp.atrValue <= 0) return;
    if (!config.trailing) return;

    if (sp.type === 'BUY' && bid > sp.bestPrice) sp.bestPrice = bid;
    else if (sp.type === 'SELL' && bid < sp.bestPrice) sp.bestPrice = bid;
  }

  async _trailOnH1Close(symbol, config, state, entry) {
    const sp = state.positions?.[symbol];
    if (!sp || !sp.atrValue || sp.atrValue <= 0) return;
    if (!sp.dealId || sp.dealId === 'PENDING') return;

    const result = tradeEngine.calcTrailingStop({
      type: sp.type,
      entry: sp.entry,
      atrValue: sp.atrValue,
      bestPrice: sp.bestPrice,
      currentSl: sp.sl,
      config,
    });
    if (!result) return;

    try {
      await entry.broker.updatePositionStopLevel(sp.dealId, result.sl);
      sp.sl = result.sl;

      if (!sp.trailingActivated) {
        sp.trailingActivated = true;
        console.log(`[${symbol}] ⚡ TSL activated @ ${result.trailDist.toFixed(4)} ATR → ${result.sl.toFixed(2)}`);
      } else {
        console.log(`[${symbol}] SL updated ${result.trailDist.toFixed(4)} ATR → ${result.sl.toFixed(2)}`);
      }
      sp.currentTrailDist = result.trailDist;
      saveState(state);
    } catch (err) {
      console.error(`[${symbol}] Trail on H1 close failed: ${err.message}`);
    }
  }

  async _handleStreamSignal(symbol, config, state, entry, broker, streamCandles = null) {
    try {
      const shared = require('./strategy');
      const strategy = require(`../symbols/${symbol}/strategy`);
      const candles = streamCandles || (await fetchCandlesCached(symbol, config.timeframe || 'H1', config));
      const signal = await strategy.analyzeFromData(config, candles);

      if (signal.signal !== 'NONE' && this._isDuplicateSignal(state.lastSignals, symbol, signal, config)) {
        console.log(`[${symbol}] Duplicate signal: ${signal.signal} ${signal.reason}, skipping`);
        signal.signal = 'NONE';
      }

      const hasPos = state.positions?.[symbol]?.dealId != null && state.positions[symbol].dealId !== 'PENDING';

      if (signal.signal !== 'NONE' && !hasPos) {
        const balance = await broker.getBalance();
        const slDist = Math.abs(signal.entry - signal.sl);
        const slPips = slDist / pipToPrice(1, symbol);
        const dr = CapitalBroker.loadDealingRulesCache(symbol);
        const brokerMax = dr ? dr.maxDealSize : 999999;

        const trades = loadTrades();
        const dirMul = tradeEngine.calcAdaptiveMultiplier(trades, signal.signal, config);
        const consecutiveLosses = state.consecutiveLosses?.[symbol] || 0;
        let size = tradeEngine.calcPositionSize({ symbol, balance, dirMul, consecutiveLosses, config, slPips, brokerMax });

        if (size > 0) {
          const validation = await broker.validateSize(symbol, size);
          const finalSize = validation.valid ? validation.size : 0;

          if (finalSize > 0) {
            await broker.placeOrder(symbol, signal.signal, finalSize, signal.sl, null, '');
            console.log(`[${symbol}] ✅ Order placed: ${signal.signal} size=${finalSize} entry=${signal.entry} sl=${signal.sl}`);

            state.positions[symbol] = {
              type: signal.signal,
              entry: signal.entry,
              sl: signal.sl,
              size: finalSize,
              atrValue: signal.indicators?.atr || 0,
              bestPrice: signal.entry,
              currentTrailDist: null,
              trailingActivated: false,
              dealId: 'PENDING',
            };

            const allTrades = loadTrades();
            allTrades.push({
              round: state.round,
              time: new Date().toISOString(),
              symbol,
              action: signal.signal,
              type: signal.signal,
              entry: signal.entry,
              sl: signal.sl,
              size: finalSize,
              setup: signal.reason,
              status: 'OPEN',
              pnl: 0,
            });
            saveTrades(allTrades);
            state.lastSignals[symbol] = { signal: signal.signal, reason: signal.reason, time: Date.now() };
            saveState(state);

            // Fetch dealId after placing (non-critical, _checkStreamPosition will update later)
            try {
              const updated = await broker.getOpenPositions(symbol);
              if (updated.length > 0) {
                state.positions[symbol].dealId = updated[0].id;
                saveState(state);
              }
            } catch (_) {}
          }
        }
      }

      // Discord notification — always send (every H1 close)
      if (signal.signal === 'NONE') console.log(`[${symbol}] Signal: NONE — sending Discord`);
      const ind = shared.getIndicators(candles);
      const chartCandles = candles.slice(-DISPLAY_LIMIT);
      const brokerPos = hasPos ? await broker.getOpenPositions(symbol).catch(() => []) : [];
      const displayPos = brokerPos.length > 0
        ? { entryPrice: brokerPos[0].entryPrice, sl: brokerPos[0].sl, type: brokerPos[0].type }
        : null;
      const chartBuffer = generateChart(chartCandles, ind, displayPos, symbol, config.timeframe || 'H1', 600, 350, candles.map(c => c.close));

      const openPositionsSummary = {};
      const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : null;
      for (const [sym, pos] of Object.entries(state.positions || {})) {
        const p = { ...pos };
        if (sym === symbol && currentPrice != null && pos.size) {
          const pvpl = pipValuePerLot(sym);
          p.pnl = pos.type === 'BUY'
            ? (currentPrice - pos.entry) * pos.size * pvpl
            : (pos.entry - currentPrice) * pos.size * pvpl;
        }
        openPositionsSummary[sym] = p;
      }

      const discordPromise = this.discord.sendLiveTrade(signal, chartBuffer, openPositionsSummary, state.round, displayPos, currentPrice);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Discord timeout')), 10000));
      await Promise.race([discordPromise, timeout]);
    } catch (err) {
      console.error(`[${symbol}] Signal analysis error:`, err.message);
      const discord = this.discord;
      if (discord) discord.sendError(err, { symbol, mode: 'stream', round: state.round }).catch(() => {});
    }
  }

  async _checkStreamPosition(symbol, config, state, entry) {
    try {
      const positions = await entry.broker.getOpenPositions(symbol);

      if (positions.length === 0 && state.positions?.[symbol]) {
        const closed = state.positions[symbol];
        console.log(`[${symbol}] 🔒 Position closed by broker: ${closed.type} entry=${closed.entry}`);

        // Fetch candles for approximate close price
        let closePrice = null;
        try {
          const candles = await fetchCandlesCached(symbol, config.timeframe || 'H1', config);
          closePrice = candles.length > 0 ? candles[candles.length - 1].close : null;
        } catch {}
        let pnl = 0;
        if (closePrice != null && closed.size) {
          const pvpl = pipValuePerLot(symbol);
          const pips = (closed.type === 'BUY' ? closePrice - closed.entry : closed.entry - closePrice) / pipToPrice(1, symbol);
          pnl = pips * closed.size * pvpl;
        }

        if (!state.consecutiveLosses) state.consecutiveLosses = {};
        state.consecutiveLosses[symbol] = pnl < 0 ? (state.consecutiveLosses[symbol] || 0) + 1 : 0;

        delete state.positions[symbol];
        saveState(state);

        const trades = loadTrades();
        const lastTrade = [...trades].reverse().find(t => t.symbol === symbol && t.status === 'OPEN');
        if (lastTrade) {
          lastTrade.status = 'CLOSED';
          lastTrade.closeTime = new Date().toISOString();
          lastTrade.pnl = parseFloat(pnl.toFixed(2));
        } else {
          trades.push({
            round: state.round,
            time: closed.time || new Date().toISOString(),
            symbol,
            action: closed.type,
            entry: closed.entry,
            sl: closed.sl,
            size: closed.size,
            setup: 'restored',
            status: 'CLOSED',
            closeTime: new Date().toISOString(),
            pnl: parseFloat(pnl.toFixed(2)),
          });
        }
        saveTrades(trades);
      } else if (positions.length > 0 && state.positions?.[symbol]) {
        state.positions[symbol].dealId = positions[0].id;
        state.positions[symbol].sl = positions[0].sl;
        saveState(state);
      }
    } catch (err) {
      console.error(`[${symbol}] Position check error:`, err.message);
    }
  }

  runBacktest(symbol, candles = null) {
    const { config } = this.brokers.get(symbol) || {};
    if (!config) throw new Error(`Symbol ${symbol} not configured`);

    const shared = require('../core/strategy');
    let data = candles || DataStore.loadLocalCandles(symbol, config.timeframe);
    if (!data || data.length === 0) {
      throw new Error(`No local candle data found for ${symbol} (${config.timeframe})`);
    }

    if (config.candles && data.length > config.candles) {
      data = data.slice(-config.candles);
    }

    const precalc = shared.precalcIndicators(data);
    if (!precalc || precalc.length === 0) throw new Error('No precalculated indicators');

    const firstValid = 49;
    const startIdx = 60;

    let h4Precalc = null;
    const h4Data = DataStore.loadLocalCandles(symbol, 'H4');
    if (h4Data && h4Data.length >= 20) {
      const h4Count = Math.ceil(config.candles / 4) + 50;
      h4Precalc = shared.precalcIndicators(
        h4Data.length > h4Count ? h4Data.slice(-h4Count) : h4Data
      );
    }

    const numSeg = config.numSegments || 1;
    const segSize = numSeg > 1
      ? Math.floor((data.length - startIdx) / numSeg)
      : (data.length - startIdx);

    const balancePerSymbol = config.balancePerSymbol || 500;
    const allSegmentTrades = [];
    let globalMaxDD = 0;

    const symState = {
      balance: balancePerSymbol,
      position: null,
      trades: [],
      consecutiveLosses: 0,
      tradeHistory: [],
    };

    for (let seg = 0; seg < numSeg; seg++) {
      const segStart = startIdx + seg * segSize;
      const segEnd = seg < numSeg - 1 ? segStart + segSize : data.length;

      symState.balance = balancePerSymbol;
      symState.position = null;
      symState.consecutiveLosses = 0;

      let peakTotal = 0;
      let h4Ptr = 0;

      const getH4Trend = (h1Time) => {
        if (!h4Precalc || h4Precalc.length === 0) return 'neutral';
        const t = new Date(h1Time).getTime();
        while (h4Ptr < h4Precalc.length - 1 && new Date(h4Precalc[h4Ptr + 1].time).getTime() <= t) {
          h4Ptr++;
        }
        return h4Precalc[h4Ptr].emaTrend || 'neutral';
      };

      for (let i = segStart; i < segEnd; i++) {
        const current = data[i];
        const ind = precalc[i - firstValid];
        let entryAllowed = true;

        if (symState.position) {
          const pos = symState.position;

          if (pos.atrValue > 0) {
            if (pos.type === 'BUY' && current.high > pos.bestPrice) pos.bestPrice = current.high;
            else if (pos.type === 'SELL' && current.low < pos.bestPrice) pos.bestPrice = current.low;

            const trail = tradeEngine.calcTrailingStop({
              type: pos.type,
              entry: pos.entry,
              atrValue: pos.atrValue,
              bestPrice: pos.bestPrice,
              currentSl: pos.sl,
              config,
            });
            if (trail) { pos.sl = trail.sl; pos.trailingActivated = true; }
          }

          let exitPrice = null;
          let exitReason = '';
          if (current.low <= pos.sl && pos.type === 'BUY') { exitPrice = pos.sl; exitReason = 'SL'; }
          else if (current.high >= pos.sl && pos.type === 'SELL') { exitPrice = pos.sl; exitReason = 'SL'; }

          if (exitPrice) {
            const multiplier = pos.type === 'BUY' ? 1 : -1;
            const slp = (config.slippagePips || 0) * shared.pipToPrice(1, symbol);
            const exitPriceAdj = pos.type === 'BUY' ? exitPrice - slp : exitPrice + slp;
            const pnlPips = (exitPriceAdj - pos.entry) / shared.pipToPrice(1, symbol);
            const spreadCost = (config.spreadPips || 0) * pos.size * shared.pipValuePerLot(symbol);
            const pnl = pnlPips * pos.size * shared.pipValuePerLot(symbol) * multiplier - spreadCost;

            symState.balance += pnl;
            symState.consecutiveLosses = pnl < 0 ? symState.consecutiveLosses + 1 : 0;
            symState.tradeHistory.push({ type: pos.type, pnl });
            symState.trades.push({
              symbol,
              type: pos.type,
              entry: pos.entry,
              exit: exitPrice,
              sl: pos.sl,
              entryTime: pos.entryTime,
              exitTime: current.time,
              pnl: parseFloat(pnl.toFixed(2)),
              exitReason,
              trailingActivated: pos.trailingActivated,
            });
            symState.position = null;
            entryAllowed = false;
          }
        }

        if (!symState.position && entryAllowed) {
          const h4Trend = getH4Trend(current.time);
          const decision = shared.evaluate({ symbol, h4Trend, ind, config });
          if (decision) {
            const { action, slPips } = decision;
            const atrVal = ind.atr || 0;

            const dr = CapitalBroker.loadDealingRulesCache(symbol);
            const brokerMax = dr ? dr.maxDealSize : 999999;
            const dirMul = tradeEngine.calcAdaptiveMultiplier(symState.tradeHistory, action, config);
            const size = tradeEngine.calcPositionSize({
              symbol,
              balance: symState.balance,
              dirMul,
              consecutiveLosses: symState.consecutiveLosses,
              config,
              slPips,
              brokerMax,
            });

            if (size) {
              const slp = (config.slippagePips || 0) * shared.pipToPrice(1, symbol);
              const entryPrice = action === 'BUY'
                ? ind.currentPrice + slp
                : ind.currentPrice - slp;
              const slPrice = action === 'BUY'
                ? entryPrice - slPips * shared.pipToPrice(1, symbol)
                : entryPrice + slPips * shared.pipToPrice(1, symbol);

              symState.position = {
                type: action,
                entry: entryPrice,
                sl: slPrice,
                entryTime: current.time,
                bestPrice: entryPrice,
                atrValue: atrVal,
                trailingActivated: false,
                size,
              };
            }
          }
        }

        let equity = symState.balance;
        if (symState.position) {
          const multiplier = symState.position.type === 'BUY' ? 1 : -1;
          const pnlPips = (current.close - symState.position.entry) / shared.pipToPrice(1, symbol);
          const pnl = pnlPips * symState.position.size * shared.pipValuePerLot(symbol) * multiplier;
          equity += pnl;
        }
        if (equity > peakTotal) peakTotal = equity;
        const dd = peakTotal > 0 ? ((peakTotal - equity) / peakTotal) * 100 : 0;
        if (dd > globalMaxDD) globalMaxDD = dd;
      }

      allSegmentTrades.push(...symState.trades);
    }

    const allTrades = allSegmentTrades;
    const btReport = new BacktestReport(allTrades, balancePerSymbol);
    const report = btReport.generate();
    report.startBalance = balancePerSymbol;
    report.finalBalance = balancePerSymbol + allTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    report.returnPct = ((report.finalBalance - report.startBalance) / report.startBalance) * 100;
    report.maxDD = globalMaxDD;
    report.maxDd = globalMaxDD;

    const summary = btReport.toSummary();
    console.log(summary);
    const jsonPath = this.dataStore.saveBacktestResult(symbol, report);

    const ghUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
    this.discord.sendBacktestReport({ ...report, summary, artifactUrl: ghUrl });

    return { report, jsonPath };
  }

  async cleanup() {
    for (const entry of this.brokers) {
      const broker = entry[1].broker;
      if (broker) await broker.disconnect();
    }
  }
}

async function main() {
  const mode = process.argv[2] || 'stream';
  const symbol = process.argv[3] || null;

  if (mode !== 'backtest' && mode !== 'stream') {
    throw new Error(`Unknown mode "${mode}". Use "backtest" or "stream".`);
  }

  const runner = new Runner({ mode, symbol });
  try {
    await runner.init();

    if (mode === 'backtest') {
      if (!symbol) throw new Error('Symbol required for backtest');
      await runner.runBacktest(symbol);
    } else {
      await runner.runStream();
    }
  } catch (err) {
    console.error('Runner error:', err.message);
    await runner.discord.sendError(err, { mode, symbol });
    process.exit(1);
  } finally {
    await runner.cleanup();
  }
}

if (require.main === module) {
  main();
}

module.exports = Runner;
