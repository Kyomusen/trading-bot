// engine/positionTracker.js
// Shadow simulator ของโพซิชันที่เปิดอยู่จริงบนบรoker
// ทำหน้าที่ "จำลอง position แบบ realtime" ให้รู้ว่า order hit SL / TSL เมื่อใด
// และกำไร/ขาดทุนเท่าใด — โดยใช้ logic เดียวเป๊ะกับ backtest (brokerSimulator + runBacktest loop)
//
// ทำไมต้องมี: ใน live เราเปิดออเดอร์จริงกับบรoker (Capital.com) และเซ็ต stop ไว้แล้ว
// แต่บรokerจะแจ้งผลตอนชน stop จริงเท่านั้น ตัวบอทเองจึงเก็บ "เงา" ของโพซิชันแต่ละออเดอร์
// แล้ว feed ราคา realtime (จาก WebSocket) เข้ามา คำนวณ trailing / เช็ค hit SL เหมือน backtest เป๊ะ
// ฟังก์ชัน crossCheck() เอาไว้เทียบเงากับข้อมูลที่ดึงจาก API ว่าตรงกันหรือไม่
//
// ความสอดคล้องกับ backtest:
//   - exit เมื่อราคาแตะ stop เท่านั้น (STOP_LOSS) — ไม่มี TP, ไม่มีปิดเมื่อสัญญาณสวน
//     (brokerSimulator._checkStopsAndTargets + runBacktest ไม่มี exit อื่น)
//   - PnL = (exitPrice - entryPrice) * direction * size  (ไม่หัก spread ซ้ำ เพราะ entry/stop
//     ถูกเลื่อนตาม spread ตั้งแต่เปิดออเดอร์แล้ว — ตรงกับ backtest ที่ spreadPips=0 ใน simulator)
//   - trailing ใช้ calcTrailingStop ตัวเดียวกับ backtest (engine/positionManager.js)
//   - BUY: advance best ด้วย ask (≈ high), เช็ค hit ด้วย bid (≈ low)
//     SELL: advance best ด้วย bid (≈ low), เช็ค hit ด้วย ask (≈ high)
//     → ตรงกับ backtest ที่ส่ง candle.high ให้ calcTrailingStop และเช็ค candle.low

const { calcTrailingStop } = require('./positionManager');

class PositionTracker {
  constructor({ symbolConfig, onClose } = {}) {
    this.sc = symbolConfig || {};
    this.pip = this.sc.pipValue ?? 0.01;
    this.positions = new Map(); // dealId -> shadow position
    this.onClose = onClose || (() => {});
    this.atrNow = null;
  }

  setAtr(v) { this.atrNow = v; }

  // ลงทะเบียนโพซิชันที่เปิดผ่าน REST แล้ว (entry/stop ต้องคำนวณด้วยสูตรเดียวกับ backtest)
  openPosition({ dealId, brokerDealId, epic, direction, size, entryPrice, stopLevel }) {
    this.positions.set(dealId, {
      dealId,
      brokerDealId,    // broker internal dealId (สำหรับ crossCheck match)
      epic,
      direction,
      size,
      entryPrice,
      stopLevel,
      bestPrice: entryPrice,
      closed: false,
      exitPrice: null,
      exitReason: null,
      pnl: null,
    });
  }

  removePosition(dealId) { this.positions.delete(dealId); }

  getShadow(dealId) { return this.positions.get(dealId); }

  // ป้อนราคา realtime ทีละ tick
  // price: { epic, bid, ask, timestamp, high?, low? }
  // broker ปิด position เองเมื่อ SL/TSL ถึง — บอทไม่ต้องตรวจจับการ hit SL
  // บอทมีหน้าที่:
  //   1. คำนวณ trailing stop ว่า SL ควรขยับไปเท่าใด (ถ้ามีการเปลี่ยนแปลง → ส่งไป update ที่ broker)
  //   2. advance bestPrice สำหรับรอบถัดไป
  // คืน { stopUpdates:[{dealId, stopLevel}] }
  onPrice({ epic, bid, ask, timestamp, high, low }) {
    const stopUpdates = [];
    const tickHigh = high != null ? high : (ask ?? bid);
    const tickLow = low != null ? low : (bid ?? ask);
    const spreadPrice = (bid != null && ask != null) ? (ask - bid) : undefined;

    for (const [dealId, pos] of this.positions) {
      if (pos.closed) continue;
      if (pos.epic && epic && pos.epic !== epic) continue;

      const isBuy = pos.direction === 'BUY';
      const bestTick = isBuy ? tickHigh : tickLow;

      let newStop = pos.stopLevel;
      if (this.atrNow) {
        const trailPos = {
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          currentStopLevel: pos.stopLevel,
          bestPrice: pos.bestPrice,
        };
        newStop = calcTrailingStop(trailPos, bestTick, this.atrNow, this.sc, { spreadPrice });
        pos.bestPrice = trailPos.bestPrice;
      }

      if (newStop !== pos.stopLevel) {
        pos.stopLevel = newStop;
        stopUpdates.push({ dealId, stopLevel: newStop });
      }
    }
    return { stopUpdates };
  }

  // PnL ปัจจุบัน (mark-to-market) สำหรับรายงาน — ไม่ใช้ settle
  markToMarket(price) {
    const out = [];
    for (const pos of this.positions.values()) {
      if (pos.closed) continue;
      const m = pos.direction === 'BUY' ? (price.ask ?? price.bid) : (price.bid ?? price.ask);
      const dir = pos.direction === 'BUY' ? 1 : -1;
      out.push({ dealId: pos.dealId, unrealizedPnl: (m - pos.entryPrice) * dir * pos.size, stopLevel: pos.stopLevel });
    }
    return out;
  }

  // เทียบเงากับโพซิชันที่ดึงจาก API จริง
  // remotePositions: array จาก broker.getPositions() → { dealId, stopLevel, pnl, size, direction }
  // คืน { diffs, autoClosed } — autoClosed คือ position ที่ shadow มีแต่ broker ปิดไปแล้ว (โดน SL/TSL ตอน WS หลุด)
  crossCheck(remotePositions) {
    const diffs = [];
    const autoClosed = [];
    // Index by both dealId and brokerDealId
    const remoteById = new Map();
    for (const p of (remotePositions || [])) {
      remoteById.set(p.dealId, p);
      // some brokers also have a parent dealId or reference field
    }
    const tolStop = this.pip * 0.5; // 0.5 pip
    for (const [dealId, pos] of this.positions) {
      if (pos.closed) continue;
      // Try brokerDealId first, then shadow dealId (dealReference)
      let r = pos.brokerDealId ? remoteById.get(pos.brokerDealId) : null;
      if (!r) r = remoteById.get(dealId);
      if (!r) {
        // broker ปิด position ไปแล้ว (SL/TSL ขณะ WS หลุด) — สร้าง close event ตาม stopLevel
        const dir = pos.direction === 'BUY' ? 1 : -1;
        const ev = {
          ...pos,
          exitPrice: pos.stopLevel,
          exitReason: 'STOP_LOSS',
          pnl: (pos.stopLevel - pos.entryPrice) * dir * pos.size,
          timestamp: Date.now(),
        };
        autoClosed.push(ev);
        diffs.push({ dealId, issue: 'SHADOW_AUTO_CLOSED' });
        continue;
      }
      if (Math.abs((r.stopLevel ?? 0) - pos.stopLevel) > tolStop) {
        diffs.push({ dealId, issue: 'STOP_MISMATCH', shadow: pos.stopLevel, broker: r.stopLevel });
      }
      // PnL broker (upl) เทียบกับเงา — อนุญาต tolerance จาก spread/ราคาเติม
      const tolPnl = this.pip * 50 * pos.size;
      if (r.pnl != null && pos.pnl != null && Math.abs(r.pnl - pos.pnl) > tolPnl) {
        diffs.push({ dealId, issue: 'PNL_MISMATCH', shadow: pos.pnl, broker: r.pnl });
      }
      if (r.size != null && Math.abs(r.size - pos.size) > 1e-6) {
        diffs.push({ dealId, issue: 'SIZE_MISMATCH', shadow: pos.size, broker: r.size });
      }
    }
    return { diffs, autoClosed };
  }
}

module.exports = { PositionTracker };
