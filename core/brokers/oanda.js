const BaseBroker = require('./base');

class OandaBroker extends BaseBroker {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey;
    this.accountId = config.accountId;
    this.baseUrl = config.demo ? 'https://api-fxpractice.oanda.com' : 'https://api-fxtrade.oanda.com';
  }

  async connect() {
    const res = await fetch(`${this.baseUrl}/v3/accounts/${this.accountId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`OANDA connect failed: ${res.status}`);
    this.isConnected = true;
  }

  async disconnect() {
    this.isConnected = false;
  }

  async getCandles(symbol, timeframe, limit = 100) {
    const granularity = this._mapTimeframe(timeframe);
    const res = await fetch(`${this.baseUrl}/v3/instruments/${symbol}/candles?granularity=${granularity}&count=${limit}&price=M`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`OANDA candles failed: ${res.status}`);
    const data = await res.json();
    return data.candles.map(c => ({
      time: c.time,
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
      volume: c.volume,
    }));
  }

  _mapTimeframe(tf) {
    const map = { 'M1': 'M1', 'M5': 'M5', 'M15': 'M15', 'M30': 'M30', 'H1': 'H1', 'H4': 'H4', 'D1': 'D' };
    return map[tf] || 'H1';
  }

  async placeOrder(symbol, type, lotSize, sl, tp, comment = '') {
    const units = type === 'BUY' ? lotSize * 100000 : -lotSize * 100000;
    const body = {
      order: {
        type: 'MARKET',
        instrument: symbol,
        units: units.toString(),
        timeInForce: 'FOK',
        positionFill: 'DEFAULT',
        ...(sl && { stopLossOnFill: { price: sl.toString() } }),
        ...(tp && { takeProfitOnFill: { price: tp.toString() } }),
        clientExtensions: { comment },
      },
    };
    const res = await fetch(`${this.baseUrl}/v3/accounts/${this.accountId}/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OANDA order failed: ${res.status}`);
    return res.json();
  }

  async getOpenPositions(symbol) {
    const res = await fetch(`${this.baseUrl}/v3/accounts/${this.accountId}/openPositions`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`OANDA positions failed: ${res.status}`);
    const data = await res.json();
    return data.positions
      .filter(p => p.instrument === symbol)
      .map(p => ({
        id: p.long?.tradeID || p.short?.tradeID,
        symbol: p.instrument,
        type: p.long ? 'BUY' : 'SELL',
        size: parseFloat(p.long?.units || p.short?.units) / 100000,
        entryPrice: parseFloat(p.long?.averagePrice || p.short?.averagePrice),
        sl: parseFloat(p.long?.stopLossOrder?.price || p.short?.stopLossOrder?.price || 0),
        tp: parseFloat(p.long?.takeProfitOrder?.price || p.short?.takeProfitOrder?.price || 0),
      }));
  }

  async closePosition(positionId) {
    const res = await fetch(`${this.baseUrl}/v3/accounts/${this.accountId}/trades/${positionId}/close`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ units: 'ALL' }),
    });
    if (!res.ok) throw new Error(`OANDA close failed: ${res.status}`);
    return res.json();
  }

  async getAccountInfo() {
    const res = await fetch(`${this.baseUrl}/v3/accounts/${this.accountId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    return res.json();
  }

  async getSymbolInfo(symbol) {
    const res = await fetch(`${this.baseUrl}/v3/accounts/${this.accountId}/instruments?instruments=${symbol}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    return res.json();
  }
}

module.exports = OandaBroker;
