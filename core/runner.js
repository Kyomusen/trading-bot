const { createBroker } = require('./brokers');
const { getEnabledSymbols, getSymbolConfig } = require('../symbols.config');
const DataStore = require('./dataStore');
const BacktestReport = require('./backtestReport');
const DiscordNotifier = require('./discord');
const fs = require('fs');
const path = require('path');

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

    if (this.mode === 'backtest') {
      for (const symConfig of symbols) {
        this.brokers.set(symConfig.symbol, { broker: null, config: symConfig });
      }
      return;
    }

    for (const symConfig of symbols) {
      const brokerType = symConfig.broker || 'capital';
      const brokerConfig = this._getBrokerConfig(brokerType);
      const broker = createBroker(brokerType, brokerConfig);
      await broker.connect();
      this.brokers.set(symConfig.symbol, { broker, config: symConfig });
      console.log(`Connected to ${brokerType} for ${symConfig.symbol}`);
    }
  }

  _getBrokerConfig(type) {
    const configs = {
      capital: {
        apiKey: process.env.CAPITAL_API_KEY,
        identifier: process.env.CAPITAL_IDENTIFIER,
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
    const results = [];
    for (const [symbol, { broker, config }] of this.brokers) {
      try {
        const strategy = require(`../symbols/${symbol}/strategy`);
        const signal = await strategy.analyze(broker, config.strategy);
        console.log(`${symbol}: ${signal.signal} @ ${signal.entry} (SL: ${signal.sl}, TP: ${signal.tp})`);

        if (signal.signal !== 'NONE') {
          const positions = await broker.getOpenPositions(symbol);
          if (positions.length < config.maxPositions) {
            await broker.placeOrder(symbol, signal.signal, config.lotSize, signal.sl, signal.tp);
            console.log(`Order placed for ${symbol}`);
          }
        }

        await this.discord.sendLiveTrade(signal);
        results.push({ symbol, signal, success: true });
      } catch (err) {
        console.error(`Error processing ${symbol}:`, err.message);
        await this.discord.sendError(err, { symbol, mode: 'live' });
        results.push({ symbol, error: err.message, success: false });
      }
    }
    return results;
  }

  async runBacktest(symbol, candles = null) {
    const { config } = this.brokers.get(symbol) || {};
    if (!config) throw new Error(`Symbol ${symbol} not configured`);

    const strategy = require(`../symbols/${symbol}/strategy`);
    const data = candles || DataStore.loadLocalCandles(symbol, config.timeframe);
    if (!data || data.length === 0) {
      throw new Error(`No local candle data found for ${symbol} (${config.timeframe})`);
    }

    const trades = [];
    let position = null;
    let balance = 10000;

    for (let i = 50; i < data.length; i++) {
      const slice = data.slice(0, i + 1);
      const signal = await strategy.analyze({
        getCandles: async () => slice,
      }, config.strategy);

      if (!position && signal.signal !== 'NONE') {
        position = {
          type: signal.signal,
          entryPrice: signal.entry,
          sl: signal.sl,
          tp: signal.tp,
          entryTime: data[i].time,
          size: config.lotSize,
        };
      } else if (position) {
        const current = data[i];
        let exitPrice = null;
        let exitReason = '';

        if (position.type === 'BUY') {
          if (current.low <= position.sl) { exitPrice = position.sl; exitReason = 'SL'; }
          else if (current.high >= position.tp) { exitPrice = position.tp; exitReason = 'TP'; }
        } else {
          if (current.high >= position.sl) { exitPrice = position.sl; exitReason = 'SL'; }
          else if (current.low <= position.tp) { exitPrice = position.tp; exitReason = 'TP'; }
        }

        if (exitPrice) {
          const pips = position.type === 'BUY'
            ? (exitPrice - position.entryPrice) * 10000
            : (position.entryPrice - exitPrice) * 10000;
          const pnl = pips * position.size * 10;
          balance += pnl;
          trades.push({
            symbol,
            type: position.type,
            entryPrice: position.entryPrice,
            exitPrice,
            sl: position.sl,
            tp: position.tp,
            entryTime: position.entryTime,
            exitTime: current.time,
            pnl: parseFloat(pnl.toFixed(2)),
            exitReason,
          });
          position = null;
        }
      }
    }

    const report = new BacktestReport(trades).generate();
    const html = new BacktestReport(trades).toHTML();

    const jsonPath = this.dataStore.saveBacktestResult(symbol, report);
    const htmlPath = jsonPath.replace('.json', '.html');
    fs.writeFileSync(htmlPath, html);

    await this.discord.sendBacktestReport({ ...report, artifactUrl: `artifact://${path.basename(htmlPath)}` });

    return { report, jsonPath, htmlPath };
  }

  async cleanup() {
    for (const [symbol, { broker }] of this.brokers) {
      if (broker) await broker.disconnect();
    }
  }
}

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
