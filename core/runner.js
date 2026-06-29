const { createBroker } = require('./brokers');
const { getEnabledSymbols, getSymbolConfig } = require('../symbols.config');
const DataStore = require('./dataStore');
const BacktestReport = require('./backtestReport');
const DiscordNotifier = require('./discord');
const { pipToPrice, pipValuePerLot } = require('./strategy');
const { fetchCandlesCached, fetchCandles } = require('./dataSource');
const { generateChart } = require('./chart');
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
    this.mode = options.mode || 'live';
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

  async runLive() {
    const state = loadState();
    state.round = (state.round || 0) + 1;
    saveState(state);
    console.log(`\n🤖 Live Round #${state.round}`);

    const results = [];
    for (const [symbol, entry] of this.brokers) {
      const { config } = entry;
      try {
        const strategy = require(`../symbols/${symbol}/strategy`);
        const shared = require('./strategy');

        const candles = await fetchCandlesCached(symbol, config.timeframe || 'H1', config);
        console.log(`[${symbol}] Data: ${candles.length} candles`);

        const chartCandles = candles.slice(-DISPLAY_LIMIT);
        const ind = shared.getIndicators(candles);
        const chartBuffer = generateChart(chartCandles, ind, null, symbol);

        const signal = await strategy.analyzeFromData(config, candles);

        if (signal.signal !== 'NONE') {
          const brokerType = config.broker || 'capital';
          const brokerConfig = this._getBrokerConfig(brokerType);
          const broker = createBroker(brokerType, brokerConfig);
          await broker.connect();
          entry.broker = broker;

          const positions = await broker.getOpenPositions(symbol);
          if (positions.length >= (config.maxPositions || 1)) {
            console.log(`[${symbol}] Max positions reached, skipping`);
          } else {
            const balance = await broker.getBalance();
            const slDist = Math.abs(signal.entry - signal.sl);
            const slPips = slDist / pipToPrice(1, symbol);
            const pvpl = pipValuePerLot(symbol);
            const riskAmt = balance * (config.riskPercent / 100);
            let size = Math.max(0.01, riskAmt / (slPips * pvpl));

            size = Math.min(size, config.maxLot || 5);
            if (size <= 0) {
              console.log(`[${symbol}] Calculated size is 0, skipping`);
            } else {
              const validation = await broker.validateSize(symbol, size);
              let finalSize = validation.valid ? validation.size : 0;

              if (!validation.valid && size < validation.min) {
                const minRiskPct = (validation.min * slPips * pvpl) / balance * 100;
                if (minRiskPct <= (config.riskPercent || 1) * 3) {
                  finalSize = validation.min;
                  console.log(`[${symbol}] Size ${size.toFixed(4)} < min ${validation.min}, using min (risk ${minRiskPct.toFixed(1)}%)`);
                } else {
                  console.log(`[${symbol}] Cannot trade: min size ${validation.min} would risk ${minRiskPct.toFixed(1)}% (limit: ${(config.riskPercent || 1) * 3}%)`);
                  signal.signal = 'NONE';
                  signal.reason = `Size too large: min ${validation.min} would risk ${minRiskPct.toFixed(0)}%`;
                }
              } else if (!validation.valid && size > validation.max) {
                finalSize = validation.max;
                console.log(`[${symbol}] Size ${size.toFixed(4)} > max ${validation.max}, capping`);
              }

              if (finalSize > 0) {
                await broker.placeOrder(symbol, signal.signal, finalSize, signal.sl, signal.tp);
                console.log(`[${symbol}] Order placed: ${signal.signal} size=${finalSize}`);

                const trades = loadTrades();
                trades.push({
                  round: state.round,
                  time: new Date().toISOString(),
                  symbol,
                  action: signal.signal,
                  entry: signal.entry,
                  sl: signal.sl,
                  tp: signal.tp,
                  size: finalSize,
                  setup: signal.reason,
                  status: 'OPEN',
                });
                saveTrades(trades);
              }
            }
          }
        }

        console.log(`${symbol}: ${signal.signal}`);
        await this.discord.sendLiveTrade(signal, chartBuffer);
        results.push({ symbol, signal, success: true });
      } catch (err) {
        console.error(`Error processing ${symbol}:`, err.message);
        await this.discord.sendError(err, { symbol, mode: 'live', round: state.round });
        results.push({ symbol, error: err.message, success: false });
      }
    }
    return results;
  }

  _calcSize(symbol, balance, dirMul, consecutiveLosses, config, slPips) {
    const pvpl = pipValuePerLot(symbol);
    if (!slPips || slPips <= 0) return symbol.includes('XAU') ? 0.0001 : 0.01;
    let riskBase = balance * dirMul;
    let riskAmount = riskBase * (config.riskPercent / 100);
    let lots = riskAmount / (slPips * pvpl);

    const lossCfg = config.lossSizing || {};
    if (lossCfg.enabled !== false && consecutiveLosses >= (lossCfg.reduceAfter ?? 1)) {
      const factor = Math.max(
        lossCfg.minFactor ?? 0.1,
        Math.pow(lossCfg.reduceTo ?? 0.65, Math.floor(consecutiveLosses / (lossCfg.reduceAfter ?? 1)))
      );
      lots *= factor;
    }

    const maxLot = config.dynamicMaxLot ? Math.max(0.01, balance / 50000) : (config.maxLot ?? 5);
    const minLot = symbol.includes('XAU') ? 0.0001 : 0.01;
    const size = Math.max(minLot, Math.min(maxLot, lots));
    const riskPct = (size * slPips * pvpl) / riskBase * 100;
    if (riskPct > (config.riskPercent || 1) * 3) return 0;
    return size;
  }

  _calcAdaptiveMultiplier(tradeHistory, direction, config) {
    const adCfg = config.adaptiveSizing || {};
    if (!adCfg.enabled) return 1;
    const dirTrades = tradeHistory.filter(t => t.type === direction);
    if (dirTrades.length < 5) return 1;
    const lookback = adCfg.lookback ?? 50;
    const recent = dirTrades.slice(-lookback);
    if (recent.length === 0) return 1;
    const wins = recent.filter(t => (t.pnl ?? 0) > 0).length;
    const winRate = wins / recent.length;
    const minMul = adCfg.min ?? 0.5;
    const maxMul = adCfg.max ?? 1.5;
    if (winRate >= 0.5) return 1 + (winRate - 0.5) * 2 * (maxMul - 1);
    return 1 - (0.5 - winRate) * 2 * (1 - minMul);
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
    let peakTotal = 0;
    let globalMaxDD = 0;

    const symState = {
      balance: balancePerSymbol,
      position: null,
      trades: [],
      consecutiveLosses: 0,
      tradeHistory: [],
    };

    let h4Ptr = 0;
    for (let seg = 0; seg < numSeg; seg++) {
      const segStart = startIdx + seg * segSize;
      const segEnd = seg < numSeg - 1 ? segStart + segSize : data.length;

      symState.balance = balancePerSymbol;
      symState.position = null;
      symState.consecutiveLosses = 0;

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

          if (config.trailing && pos.atrValue > 0) {
            if (pos.type === 'BUY') {
              if (current.high > pos.bestPrice) pos.bestPrice = current.high;
              const profit = pos.bestPrice - pos.entry;
              if (profit >= (config.trailingActivate || 0.5) * pos.atrValue) {
                const newSl = Math.max(pos.sl, pos.bestPrice - (config.trailingDistance || 0.2) * pos.atrValue);
                if (newSl > pos.sl) { pos.sl = newSl; pos.trailingActivated = true; }
              }
            } else {
              if (current.low < pos.bestPrice) pos.bestPrice = current.low;
              const profit = pos.entry - pos.bestPrice;
              if (profit >= (config.trailingActivate || 0.5) * pos.atrValue) {
                const newSl = Math.min(pos.sl, pos.bestPrice + (config.trailingDistance || 0.2) * pos.atrValue);
                if (newSl < pos.sl) { pos.sl = newSl; pos.trailingActivated = true; }
              }
            }
          }

          let exitPrice = null;
          let exitReason = '';
          if (pos.type === 'BUY') {
            if (current.low <= pos.sl) { exitPrice = pos.sl; exitReason = 'SL'; }
            else if (current.high >= pos.tp) { exitPrice = pos.tp; exitReason = 'TP'; }
          } else {
            if (current.high >= pos.sl) { exitPrice = pos.sl; exitReason = 'SL'; }
            else if (current.low <= pos.tp) { exitPrice = pos.tp; exitReason = 'TP'; }
          }

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
              tp: pos.tp,
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
            const { action, slPips, tpPips } = decision;
            const atrVal = ind.atr || 0;

            const adCfg = config.adaptiveSizing;
            let dirMul = 1;
            if (adCfg?.enabled) {
              const dirTrades = symState.tradeHistory.filter(t => t.type === action);
              if (dirTrades.length >= 5) {
                const recent = dirTrades.slice(-(adCfg.lookback || 50));
                const wins = recent.filter(t => t.pnl > 0).length;
                const wr = wins / recent.length;
                dirMul = wr >= 0.5
                  ? 1 + (wr - 0.5) * 2 * ((adCfg.max || 1.5) - 1)
                  : 1 - (0.5 - wr) * 2 * (1 - (adCfg.min || 0.5));
                dirMul = Math.max(adCfg.min || 0.5, Math.min(adCfg.max || 1.5, dirMul));
              }
            }

            const pvpl = shared.pipValuePerLot(symbol);
            const maxLot = config.dynamicMaxLot ? Math.max(0.01, symState.balance / 50000) : (config.maxLot || 5);
            const minLot = symbol.includes('XAU') ? 0.0001 : 0.01;
            let size;
            const ls = config.lossSizing;
            if (ls?.enabled && symState.consecutiveLosses >= (ls.reduceAfter || 1)) {
              const factor = Math.max(ls.minFactor || 0.1, (ls.reduceTo || 0.65) ** Math.floor(symState.consecutiveLosses / (ls.reduceAfter || 1))) * dirMul;
              const riskBase = symState.balance * factor;
              const riskAmount = riskBase * (config.riskPercent / 100);
              const lots = riskAmount / (slPips * pvpl);
              size = Math.min(maxLot, Math.max(minLot, parseFloat(lots.toFixed(4))));
              const riskPct = (size * slPips * pvpl) / riskBase * 100;
              if (riskPct > config.riskPercent * 3) size = 0;
            } else {
              const riskBase = symState.balance * dirMul;
              const riskAmount = riskBase * (config.riskPercent / 100);
              const lots = riskAmount / (slPips * pvpl);
              size = Math.min(maxLot, Math.max(minLot, parseFloat(lots.toFixed(4))));
              const riskPct = (size * slPips * pvpl) / riskBase * 100;
              if (riskPct > config.riskPercent * 3) size = 0;
            }

            if (size) {
              const slp = (config.slippagePips || 0) * shared.pipToPrice(1, symbol);
              const entryPrice = action === 'BUY'
                ? ind.currentPrice + slp
                : ind.currentPrice - slp;
              const slPrice = action === 'BUY'
                ? entryPrice - slPips * shared.pipToPrice(1, symbol)
                : entryPrice + slPips * shared.pipToPrice(1, symbol);
              const tpPrice = action === 'BUY'
                ? entryPrice + tpPips * shared.pipToPrice(1, symbol)
                : entryPrice - tpPips * shared.pipToPrice(1, symbol);

              symState.position = {
                type: action,
                entry: entryPrice,
                sl: slPrice,
                tp: tpPrice,
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
    const report = new BacktestReport(allTrades).generate();
    report.startBalance = balancePerSymbol;
    report.finalBalance = balancePerSymbol + allTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    report.returnPct = ((report.finalBalance - report.startBalance) / report.startBalance) * 100;
    report.maxDD = globalMaxDD;
    report.maxDd = globalMaxDD;

    const html = new BacktestReport(allTrades).toHTML();
    const jsonPath = this.dataStore.saveBacktestResult(symbol, report);
    const htmlPath = jsonPath.replace('.json', '.html');
    fs.writeFileSync(htmlPath, html);

    this.discord.sendBacktestReport({ ...report, artifactUrl: `artifact://${path.basename(htmlPath)}` });

    return { report, jsonPath, htmlPath };
  }

  async cleanup() {
    for (const [symbol, { broker }] of this.brokers) {
      if (broker) await broker.disconnect();
    }
  }
}

function getPrice(c) { return c.close; }
function getHigh(c) { return c.high; }
function getLow(c) { return c.low; }

async function main() {
  const mode = process.argv[2] || 'live';
  const symbol = process.argv[3] || null;

  const runner = new Runner({ mode, symbol });
  try {
    await runner.init();

    if (mode === 'backtest') {
      if (!symbol) throw new Error('Symbol required for backtest');
      await runner.runBacktest(symbol);
    } else {
      await runner.runLive();
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
