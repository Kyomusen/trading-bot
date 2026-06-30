const BaseBroker = require('./base');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

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
    this.dealingRuleCache = new Map();
    this._reconnecting = false;
  }

  async connect() {
    const res = await this._request(`${this.baseUrl}/api/v1/session`, {
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

    const accountRes = await this._request(`${this.baseUrl}/api/v1/accounts`, {
      headers: this._authHeaders(),
    });
    const accounts = await accountRes.json();
    this.accountId = accounts.accounts[0].accountId;

    this.isConnected = true;
  }

  async disconnect() {
    if (this.cst && this.securityToken) {
      await this._request(`${this.baseUrl}/api/v1/session`, {
        method: 'DELETE',
        headers: this._authHeaders(),
      }, 0);
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

  async _request(url, options = {}, retries = 1) {
    const res = await fetch(url, options);
    if (res.status === 401 && retries > 0 && !this._reconnecting) {
      this._reconnecting = true;
      try {
        console.log('[Capital] Session expired, reconnecting...');
        await this.connect();
        const newOpts = { ...options, headers: { ...options.headers, ...this._authHeaders() } };
        return await fetch(url, newOpts);
      } finally {
        this._reconnecting = false;
      }
    }
    return res;
  }

  async getDealingRules(symbol) {
    const epic = resolveEpic(symbol);
    if (this.dealingRuleCache.has(epic)) return this.dealingRuleCache.get(epic);
    const res = await this._request(`${this.baseUrl}/api/v1/markets/${epic}`, {
      headers: this._authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to get market info for ${epic}: ${res.status}`);
    const data = await res.json();
    const rules = {
      minDealSize: data.dealingRules?.minDealSize?.value ?? 0.01,
      maxDealSize: data.dealingRules?.maxDealSize?.value ?? 999999,
      lotSize: data.instrument?.lotSize ?? 1,
      currency: data.instrument?.currency || 'USD',
    };
    this.dealingRuleCache.set(epic, rules);
    this._saveDealingRulesCache(symbol, rules);
    return rules;
  }

  static loadDealingRulesCache(symbol) {
    const p = path.join(__dirname, '..', '..', 'symbols', symbol, 'data', 'dealing_rules.json');
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }

  _saveDealingRulesCache(symbol, rules) {
    const dir = path.join(__dirname, '..', '..', 'symbols', symbol, 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dealing_rules.json'), JSON.stringify(rules, null, 2));
  }

  async getBalance() {
    const res = await this._request(`${this.baseUrl}/api/v1/accounts`, {
      headers: this._authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to get accounts: ${res.status}`);
    const data = await res.json();
    const acc = data.accounts?.[0];
    if (!acc) throw new Error('No account found');
    return parseFloat(acc.balance?.available ?? acc.balance ?? 0);
  }

  async getCandles(symbol, timeframe, limit = 100) {
    const epic = resolveEpic(symbol);
    const resolution = this._mapTimeframe(timeframe);
    const res = await this._request(`${this.baseUrl}/api/v1/prices/${epic}?resolution=${resolution}&max=${limit}`, {
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

  async placeOrder(symbol, type, size, sl, tp, _comment = '', trailingOptions = null) {
    const epic = resolveEpic(symbol);
    const direction = type === 'BUY' ? 'BUY' : 'SELL';
    const body = {
      epic,
      direction,
      size,
      orderType: 'MARKET',
      currencyCode: 'USD',
      guaranteedStop: false,
      forceOpen: true,
      limitLevel: tp,
    };

    if (trailingOptions?.enabled) {
      body.trailingStop = true;
      body.stopDistance = trailingOptions.distance;
    } else {
      body.stopLevel = sl;
    }

    const res = await this._request(`${this.baseUrl}/api/v1/positions`, {
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

  async updatePositionTrailingStop(dealId, stopDistance) {
    const res = await this._request(`${this.baseUrl}/api/v1/positions/${dealId}`, {
      method: 'PUT',
      headers: this._authHeaders(),
      body: JSON.stringify({
        trailingStop: true,
        stopDistance: parseFloat(stopDistance.toFixed(5)),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Update trailing stop failed: ${res.status} - ${err}`);
    }
    return res.json();
  }

  async updatePositionStopLevel(dealId, stopLevel) {
    const sl = parseFloat(stopLevel.toFixed(2));
    const res = await this._request(`${this.baseUrl}/api/v1/positions/${dealId}`, {
      method: 'PUT',
      headers: this._authHeaders(),
      body: JSON.stringify({ stopLevel: sl }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Update stop level failed: ${res.status} - ${err}`);
    }
    return res.json();
  }

  async validateSize(symbol, size) {
    let rules;
    try {
      rules = await this.getDealingRules(symbol);
    } catch {
      return { valid: true, size, min: 0, max: 999999 };
    }
    const min = rules.minDealSize;
    const max = rules.maxDealSize;
    if (size < min) return { valid: false, size: min, min, max, reason: `Size ${size} < min ${min}` };
    if (size > max) return { valid: false, size: max, min, max, reason: `Size ${size} > max ${max}` };
    return { valid: true, size: Math.round(size * 100) / 100, min, max };
  }

  async getOpenPositions(symbol) {
    const res = await this._request(`${this.baseUrl}/api/v1/positions`, {
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
    const res = await this._request(`${this.baseUrl}/api/v1/positions`, {
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
    const res = await this._request(`${this.baseUrl}/api/v1/accounts`, {
      headers: this._authHeaders(),
    });
    return res.json();
  }

  async getSymbolInfo(symbol) {
    const res = await this._request(`${this.baseUrl}/api/v1/markets/${symbol}`, {
      headers: this._authHeaders(),
    });
    return res.json();
  }
}

module.exports = CapitalBroker;
