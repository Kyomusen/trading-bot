// broker/capitalClient.js
// Wrapper เรียก Capital.com REST API จริง
// Interface นี้ต้องตรงกับ brokerSimulator.js เป๊ะ เพื่อให้ engine สลับใช้ได้โดยไม่ต้องรู้ว่ากำลังรันโหมดไหน

const axios = require('axios');
const config = require('../config');

class CapitalClient {
  constructor() {
    this.baseUrl = config.capital.baseUrl;
    this.cst = null;
    this.securityToken = null;
    this.sessionExpiresAt = 0;
  }

  // ---------- Session ----------

  async ensureSession() {
    if (this.cst && Date.now() < this.sessionExpiresAt) return;
    const res = await axios.post(
      `${this.baseUrl}/api/v1/session`,
      {
        identifier: config.capital.identifier,
        password: config.capital.password,
        encryptedPassword: false,
      },
      { headers: { 'X-CAP-API-KEY': config.capital.apiKey } }
    );
    this.cst = res.headers['cst'];
    this.securityToken = res.headers['x-security-token'];
    this.accountId = res.data?.accountId ?? this.accountId ?? null;
    // session อยู่ได้ 10 นาที เผื่อ margin ไว้ 8 นาที
    this.sessionExpiresAt = Date.now() + 8 * 60 * 1000;
  }

  _authHeaders() {
    return {
      'X-CAP-API-KEY': config.capital.apiKey,
      CST: this.cst,
      'X-SECURITY-TOKEN': this.securityToken,
    };
  }

  // ---------- Market data ----------

  async getMarketDetails(epic) {
    await this.ensureSession();
    const res = await axios.get(`${this.baseUrl}/api/v1/markets/${epic}`, {
      headers: this._authHeaders(),
    });
    return {
      epic,
      minDealSize: res.data.dealingRules?.minDealSize?.value ?? null,
      maxDealSize: res.data.dealingRules?.maxDealSize?.value ?? null,
      bid: res.data.snapshot?.bid ?? null,
      offer: res.data.snapshot?.offer ?? null,
    };
  }

  async getCandles(epic, resolution = 'HOUR', max = 100) {
    await this.ensureSession();
    const res = await axios.get(`${this.baseUrl}/api/v1/prices/${epic}`, {
      headers: this._authHeaders(),
      params: { resolution, max },
    });
    return res.data.prices; // array of OHLC
  }

  async getAccountBalance() {
    await this.ensureSession();
    const res = await axios.get(`${this.baseUrl}/api/v1/accounts`, {
      headers: this._authHeaders(),
    });
    const acc = res.data.accounts?.[0];
    return {
      balance: acc?.balance?.balance ?? 0,
      available: acc?.balance?.available ?? 0,
    };
  }

  // ---------- Trading ----------

  async placeOrder({ epic, direction, size, stopLevel, profitLevel }) {
    await this.ensureSession();
    const res = await axios.post(
      `${this.baseUrl}/api/v1/positions`,
      {
        epic,
        direction, // 'BUY' | 'SELL'
        size,
        stopLevel,
        profitLevel,
      },
      { headers: this._authHeaders() }
    );
    return { dealReference: res.data.dealReference };
  }

  async closePosition(dealId) {
    await this.ensureSession();
    const res = await axios.delete(`${this.baseUrl}/api/v1/positions/${dealId}`, {
      headers: this._authHeaders(),
    });
    return { dealReference: res.data.dealReference };
  }

  async getPositions() {
    await this.ensureSession();
    const res = await axios.get(`${this.baseUrl}/api/v1/positions`, {
      headers: this._authHeaders(),
    });
    // API returns [{ position: {...}, market: {...} }]
    return (res.data.positions ?? []).map(p => {
      const pos = p.position || {};
      return {
        dealId: pos.dealId,
        direction: pos.direction,
        size: pos.size,
        openLevel: pos.level,
        stopLevel: pos.stopLevel,
        profitLevel: pos.profitLevel,
        pnl: pos.upl,
        epic: p.market?.epic,
        createdDate: pos.createdDateUTC,
      };
    });
  }

  async updatePosition(dealId, { stopLevel, profitLevel }) {
    await this.ensureSession();
    const body = {};
    if (stopLevel !== undefined) body.stopLevel = stopLevel;
    if (profitLevel !== undefined) body.profitLevel = profitLevel;
    const res = await axios.put(`${this.baseUrl}/api/v1/positions/${dealId}`, body, {
      headers: this._authHeaders(),
    });
    return { dealReference: res.data.dealReference };
  }
}

module.exports = new CapitalClient();
