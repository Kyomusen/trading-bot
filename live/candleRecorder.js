// live/candleRecorder.js
// รวบรวม tick จาก WebSocket (capitalStream) เป็นแท่งเทียนตาม timeframe ของกลยุทธ์ (HOUR)
// เก็บแยก bid OHLC และ ask OHLC เพื่อให้ spreadHelper / verify ใช้ bid/ask จริงได้
// และออก schema ตรงกับไฟล์ historical (data/historical/{epic}.json) เป๊ะ:
//   { timestamp, open, high, low, close, bid, ask }  (+ openAsk/highAsk/lowAsk/closeAsk, source)
//
// Durability:
//   - เขียนลง JSONL แบบ append-only ทันทีที่แท่ง "ปิดสมบูรณ์" (มีแท่งถัดไปเข้ามา)
//     ไม่เขียนทุก tick (กัน I/O หนัก) และไม่เก็บแค่ memory
//   - ตอน restart: อ่านบรรทัดสุดท้าย → รู้แท่งล่าสุดที่จบ → ละทิ้ง tick ที่เก่ากว่า
//     (barStart <= lastWrittenTs) เพื่อไม่เขียนซ้ำ ส่วนช่องว่าง (แท่งที่ค้างตอน crash)
//     ให้ Task 3 (REST reconciliation) เติมให้
//
// REST reconciliation:
//   reconcile(restCandles) → ถ้าแท่งไหนจาก WS ขาดหาย (WS หลุดพอดี) ให้เติมจาก REST
//   แล้วใส่ source:'rest_fallback' (ต่างจาก source:'ws') เพื่อให้ verify รู้แยก

const fs = require('fs');
const path = require('path');

const TF_MS = { MINUTE: 60e3, HOUR: 3600e3, DAY: 86400e3 };

class CandleRecorder {
  constructor({ epic, timeframe = 'HOUR', dataPath = './data/live-recorded', onCandleClose } = {}) {
    this.epic = epic;
    this.barMs = TF_MS[timeframe] || 3600e3;
    this.dir = dataPath;
    this.file = path.join(dataPath, `${epic}.jsonl`);
    this.onCandleClose = onCandleClose || (() => {});
    this.bars = new Map();      // timestamp -> candle (in-memory index)
    this.current = null;        // แท่งที่กำลังรวบรวม
    this.lastWrittenTs = null;  // ป้องกันเขียนซ้ำตอน restart
    this._loadTail();
  }

  _loadTail() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    for (const ln of lines) {
      try {
        const c = JSON.parse(ln);
        this.bars.set(c.timestamp, c);
        if (this.lastWrittenTs == null || c.timestamp > this.lastWrittenTs) this.lastWrittenTs = c.timestamp;
      } catch {}
    }
  }

  _append(line) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file, line + '\n');
  }

  _newBar(ts, bid, ask) {
    return {
      timestamp: ts,
      open: bid, high: bid, low: bid, close: bid, bid, ask,
      _oA: ask, _hA: ask, _lA: ask, _cA: ask,
    };
  }

  _update(b, bid, ask) {
    if (bid > b.high) b.high = bid;
    if (bid < b.low) b.low = bid;
    b.close = bid; b.bid = bid; b.ask = ask;
    if (ask > b._hA) b._hA = ask;
    if (ask < b._lA) b._lA = ask;
    b._cA = ask;
  }

  // รับ tick จาก capitalStream: { epic, bid, ask, timestamp }
  addTick({ epic, bid, ask, timestamp }) {
    if (this.epic && epic && epic !== this.epic) return;
    if (bid == null || ask == null || !timestamp) return;
    const barStart = Math.floor(timestamp / this.barMs) * this.barMs;
    // ละทิ้ง tick ของแท่งที่เขียนไปแล้ว หรือก่อนหน้า crash (ป้องกันเขียนซ้ำ)
    if (barStart <= this.lastWrittenTs) return;

    if (!this.current) {
      this.current = this._newBar(barStart, bid, ask);
    } else if (barStart > this.current.timestamp) {
      this._closeBar(this.current);
      this.current = this._newBar(barStart, bid, ask);
    } else if (barStart === this.current.timestamp) {
      this._update(this.current, bid, ask);
    }
  }

  _closeBar(b) {
    const candle = {
      timestamp: b.timestamp,
      open: b.open, high: b.high, low: b.low, close: b.close,
      bid: b.bid, ask: b.ask,
      openAsk: b._oA, highAsk: b._hA, lowAsk: b._lA, closeAsk: b._cA,
      source: 'ws',
    };
    this.bars.set(b.timestamp, candle);
    this._append(JSON.stringify(candle));
    this.lastWrittenTs = b.timestamp;
    this.onCandleClose(candle);
  }

  // เขียนแท่งที่ค้างอยู่ (ถ้ามี) ทันที — เรียกก่อนปิดโปรแกรมเพื่อไม่ให้เสียแท่งสุดท้าย
  flush() {
    if (this.current) {
      this._closeBar(this.current);
      this.current = null;
    }
  }

  // Task 3: เทียบกับ REST candles แล้วเติมช่องว่าง
  // restCandles: [{ timestamp, open, high, low, close }] (bid-based, ไม่มี ask แยก)
  // คืน { added:[timestamp...], warned:[{timestamp, wsClose, restClose, diff}] }
  reconcile(restCandles, { tolerance = 0.02 } = {}) {
    const added = [];
    const warned = [];
    for (const rc of restCandles) {
      const existing = this.bars.get(rc.timestamp);
      if (!existing) {
        // WS ขาดหาย → เติมจาก REST (ไม่มี ask จริง ให้ ask=close เสมอ เผื่อ spreadHelper ได้ 0)
        const fb = {
          timestamp: rc.timestamp,
          open: rc.open, high: rc.high, low: rc.low, close: rc.close,
          bid: rc.close, ask: rc.close,
          source: 'rest_fallback',
        };
        this.bars.set(rc.timestamp, fb);
        this._append(JSON.stringify(fb));
        added.push(rc.timestamp);
      } else if (existing.source !== 'rest_fallback') {
        const diff = Math.abs((existing.close ?? existing.bid) - (rc.close ?? rc.bid));
        if (diff > tolerance) {
          warned.push({ timestamp: rc.timestamp, wsClose: existing.close, restClose: rc.close, diff });
        }
      }
    }
    return { added, warned };
  }

  // export แท่งเรียงตามเวลา (สำหรับ verify)
  toArray() {
    return Array.from(this.bars.values()).sort((a, b) => a.timestamp - b.timestamp);
  }
}

module.exports = { CandleRecorder, TF_MS };
