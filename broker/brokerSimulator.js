// broker/brokerSimulator.js
// จำลอง broker สำหรับ backtest ด้วย interface เดียวกับ capitalClient.js เป๊ะ
// engine ไม่ต้องรู้เลยว่ากำลังคุยกับของจริงหรือของจำลอง
// เพิ่มระบบ margin: ห้ามเปิดเกินที่ margin รองรับ และมี stop-out (margin call) เมื่อ equity ตกต่ำ

const config = require('../config');

class BrokerSimulator {
  constructor({ startingBalance = 1000, spreadPips = 0, pipToPrice = 0.01, leverage } = {}) {
    this.balance = startingBalance;
    this.positions = new Map();
    this.dealCounter = 0;
    this.currentPrice = { bid: null, offer: null };
    this.settledPositions = [];
    this.spreadCost = spreadPips * pipToPrice;
    this.marginRate = 1 / (leverage ?? config.broker?.leverage ?? 100); // notional → margin
    this.stopOutLevel = config.broker?.stopOutLevel ?? 0.5;  // liquidate เมื่อ equity < usedMargin * level
    this.withdrawn = 0; // สะสมกำไรที่ถอนออกแล้ว (แยกจาก balance ที่เทรด)
  }

  _markPrice(pos) {
    return pos.direction === 'BUY' ? this.currentPrice.offer : this.currentPrice.bid;
  }

  _requiredMargin(pos) {
    const px = this._markPrice(pos);
    return pos.size * px * this.marginRate;
  }

  usedMargin() {
    let m = 0;
    for (const pos of this.positions.values()) m += this._requiredMargin(pos);
    return m;
  }

  equity() {
    let mtm = 0;
    for (const pos of this.positions.values()) {
      const dir = pos.direction === 'BUY' ? 1 : -1;
      mtm += (this._markPrice(pos) - pos.entryPrice) * dir * pos.size;
    }
    return this.balance + mtm;
  }

  // เรียกจาก backtest loop ทุกแท่งเทียนเพื่ออัปเดตราคาปัจจุบัน + เช็ค SL/TP + margin call
  tick(candle) {
    // ถ้ามี bid/ask จริง ให้ใช้มัน ไม่ต้องหัก spreadCost ซ้ำ
    this.currentPrice = {
      bid: candle.bid ?? candle.close,
      offer: candle.ask ?? candle.close,
    };
    this._checkStopsAndTargets(candle);
    this._checkMarginCall();
  }

  _checkMarginCall() {
    const used = this.usedMargin();
    if (used <= 0) return;
    if (this.equity() < used * this.stopOutLevel) {
      for (const [dealId, pos] of Array.from(this.positions.entries())) {
        this._settle(dealId, this._markPrice(pos), 'MARGIN_CALL');
      }
    }
  }

  _checkStopsAndTargets(candle) {
    for (const [dealId, pos] of this.positions.entries()) {
      const hitStop =
        pos.direction === 'BUY' ? candle.low <= pos.stopLevel : candle.high >= pos.stopLevel;
      const hitTarget =
        pos.profitLevel &&
        (pos.direction === 'BUY' ? candle.high >= pos.profitLevel : candle.low <= pos.profitLevel);

      if (hitStop) {
        this._settle(dealId, pos.stopLevel, 'STOP_LOSS');
      } else if (hitTarget) {
        this._settle(dealId, pos.profitLevel, 'TAKE_PROFIT');
      }
    }
  }

  _settle(dealId, exitPrice, exitReason) {
    const pos = this.positions.get(dealId);
    if (!pos) return;
    const direction = pos.direction === 'BUY' ? 1 : -1;
    const rawPnl = (exitPrice - pos.entryPrice) * direction * pos.size;
    const spreadCost = this.spreadCost * pos.size; // round-trip spread
    const pnl = rawPnl - spreadCost;
    this.balance += pnl;
    pos.closed = true;
    pos.exitPrice = exitPrice;
    pos.exitReason = exitReason;
    pos.pnl = pnl;
    pos.rawPnl = rawPnl;
    pos.spreadCost = spreadCost;
    this.positions.delete(dealId);
    this.settledPositions.push(pos);
    return pos;
  }

  // ---------- Interface เดียวกับ capitalClient ----------

  getMarketDetails(epic) {
    return { epic, minDealSize: 0.01, maxDealSize: 100000 };
  }

  getAccountBalance() {
    return { balance: this.balance, available: this.balance };
  }

  // ถอนกำไรทั้งหมดที่เกิน baseline คืนเข้าบัญชีจริง (หยุดคอมพาวด์ไร้ขีดจำกัด)
  // คืนจำนวนที่ถอน; ถ้าไม่มีกำไรคืน 0
  withdrawProfitAbove(baseline) {
    const profit = this.balance - baseline;
    if (profit > 0) {
      this.withdrawn += profit;
      this.balance -= profit;
      return profit;
    }
    return 0;
  }

  placeOrder({ epic, direction, size, stopLevel, profitLevel, entryPrice: givenEntry }) {
    const entryPrice = givenEntry ?? (direction === 'BUY' ? this.currentPrice.offer : this.currentPrice.bid);
    // clamp ด้วย margin ที่เหลืออยู่ (ห้ามเปิดเกิน balance รองรับ)
    const markPx = direction === 'BUY' ? this.currentPrice.offer : this.currentPrice.bid;
    const maxAffordable = (this.balance - this.usedMargin()) / (markPx * this.marginRate);
    const finalSize = Math.max(0, Math.min(size, maxAffordable));
    if (finalSize < 0.0001) return { dealReference: null }; // margin ไม่พอเปิด
    this.dealCounter += 1;
    const dealId = `SIM-${this.dealCounter}`;
    this.positions.set(dealId, {
      dealId,
      epic,
      direction,
      size: finalSize,
      entryPrice,
      stopLevel,
      profitLevel,
      closed: false,
    });
    return { dealReference: dealId };
  }

  closePosition(dealId) {
    const exitPrice =
      this.positions.get(dealId)?.direction === 'BUY'
        ? this.currentPrice.bid
        : this.currentPrice.offer;
    this._settle(dealId, exitPrice, 'MANUAL_CLOSE');
    return { dealReference: dealId };
  }

  // ปิดออเดอร์ที่ราคาที่กำหนด (ใช้โดย backtest เมื่อมีสัญญาณสวน หรือเทสอื่น)
  closeAt(dealId, exitPrice, exitReason = 'MANUAL_CLOSE') {
    return this._settle(dealId, exitPrice, exitReason);
  }

  getPositions() {
    return Array.from(this.positions.values());
  }
}

module.exports = BrokerSimulator;
