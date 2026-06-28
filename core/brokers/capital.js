const BaseBroker = require('./base');
const fetch = require('node-fetch');

const EPIC_MAP = {
  XAUUSD: 'GOLD',
  USDJPY: 'USDJPY',
};

function resolveEpic(symbol) {
  return EPIC_MAP[symbol] || symbol;
}

class CapitalBroker extends BaseBroker {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey;
    this.identifier = config.identifier;
    this.password = config.password;
    this.baseUrl = config.demo ? 'https://demo-api-capital.backend-capital.com' : 'https://api-capital.backend-capital.com';
    this.cst = null;
    this.securityToken = null;
    this.accountId = null;
  }

  async connect() {
    const res = await fetch(`${this.baseUrl}/api/v1/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CAP-API-KEY': this.apiKey,
      },
      body: JSON.stringify({
        identifier: this.identifier,
        password: this.password,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Capital.com login failed: ${res.status} - ${err}`);
    }

    this.cst = res.headers.get('cst');
    this.securityToken = res.headers.get('x-security-token');

    const accountRes = await fetch(`${this.baseUrl}/api/v1/accounts`, {
      headers: this._authHeaders(),
    });
    const accounts = await accountRes.json();
    this.accountId = accounts.accounts[0].accountId;

    this.isConnected = true;
  }

  async disconnect() {
    if (this.cst && this.securityToken) {
      await fetch(`${this.baseUrl}/api/v1/session`, {
        method: 'DELETE',
        headers: this._authHeaders(),
      });
    }
    this.isConnected = false;
    this.cst = null;
    this.securityToken = null;
  }

  _authHeaders() {
    return {
      'CST': this.cst,
      'X-SECURITY-TOKEN': this.securityToken,
      'Content-Type': 'application/json',
    };
  }

  async getCandles(symbol, timeframe, limit = 100) {
    const epic = resolveEpic(symbol);
    const resolution = this._mapTimeframe(timeframe);
    const res = await fetch(`${this.baseUrl}/api/v1/prices/${epic}?resolution=${resolution}&max=${limit}`, {
      headers: this._authHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Failed to get candles: ${res.status}`);
    }

    const data = await res.json();
    return data.prices.map(p => ({
      time: p.snapshotTime,
      open: p.openPrice.bid,
      high: p.highPrice.bid,
      low: p.lowPrice.bid,
      close: p.closePrice.bid,
      volume: p.lastTradedVolume,
    }));
  }

  _mapTimeframe(tf) {
    const map = {
      'M1': 'MINUTE',
      'M5': 'MINUTE_5',
      'M15': 'MINUTE_15',
      'M30': 'MINUTE_30',
      'H1': 'HOUR',
      'H4': 'HOUR_4',
      'D1': 'DAY',
    };
    return map[tf] || 'HOUR';
  }

  async placeOrder(symbol, type, lotSize, sl, tp, comment = '') {
    const epic = resolveEpic(symbol);
    const direction = type === 'BUY' ? 'BUY' : 'SELL';
    const body = {
      epic,
      direction,
      size: lotSize,
      orderType: 'MARKET',
      currencyCode: 'USD',
      guaranteedStop: false,
      forceOpen: true,
      limitLevel: tp,
      stopLevel: sl,
    };

    const res = await fetch(`${this.baseUrl}/api/v1/positions`, {
      method: 'POST',
      headers: this._authHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Place order failed: ${res.status} - ${err}`);
    }

    return res.json();
  }

  async getOpenPositions(symbol) {
    const res = await fetch(`${this.baseUrl}/api/v1/positions`, {
      headers: this._authHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Get positions failed: ${res.status}`);
    }

    const epic = resolveEpic(symbol);
    const data = await res.json();
    return data.positions
      .filter(p => p.market.epic === epic)
      .map(p => ({
        id: p.position.dealId,
        symbol: p.market.epic,
        type: p.position.direction,
        size: p.position.size,
        entryPrice: p.position.level,
        sl: p.position.stopLevel,
        tp: p.position.limitLevel,
        profit: p.position.profit,
      }));
  }

  async closePosition(positionId) {
    const positions = await this.getOpenPositions('');
    const pos = positions.find(p => p.id === positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);

    const direction = pos.type === 'BUY' ? 'SELL' : 'BUY';
    const res = await fetch(`${this.baseUrl}/api/v1/positions`, {
      method: 'DELETE',
      headers: this._authHeaders(),
      body: JSON.stringify({
        dealId: positionId,
        direction,
        size: pos.size,
      }),
    });

    if (!res.ok) {
      throw new Error(`Close position failed: ${res.status}`);
    }

    return res.json();
  }

  async getAccountInfo() {
    const res = await fetch(`${this.baseUrl}/api/v1/accounts`, {
      headers: this._authHeaders(),
    });
    return res.json();
  }

  async getSymbolInfo(symbol) {
    const res = await fetch(`${this.baseUrl}/api/v1/markets/${symbol}`, {
      headers: this._authHeaders(),
    });
    return res.json();
  }
}

module.exports = CapitalBroker;
