// engine/tradeEvent.js
// TradeEvent: object เดียวที่รวมทุกอย่างที่คำนวณเสร็จสมบูรณ์แล้ว
// สร้างครั้งเดียว ห้ามแก้ไขซ้ำ (Object.freeze) — notify/chart/database เป็น consumer อย่างเดียว
// แก้ปัญหาดีเลย์: การคำนวณทั้งหมดต้องเสร็จก่อนส่งเข้า notify เสมอ ไม่มีการคำนวณเพิ่มใน sender

function createTradeEvent({
  strategy,
  epic,
  direction,
  entry,
  stopLoss,
  takeProfit,
  size,
  riskAmount,
  confidence,
  indicators,
  openedAt,
  closedAt = null,
  exitPrice = null,
  pnl = null,
  pnlPercent = null,
  exitReason = null,
}) {
  const event = {
    strategy,
    epic,
    direction,
    entry,
    stopLoss,
    takeProfit,
    size,
    riskAmount,
    confidence,
    indicators,
    openedAt,
    closedAt,
    exitPrice,
    pnl,
    pnlPercent,
    exitReason,
  };
  return Object.freeze(event);
}

// สร้าง TradeEvent ใหม่สำหรับตอนปิด position (ไม่แก้ของเดิม เพราะ freeze ไว้แล้ว)
function closeTradeEvent(openEvent, { closedAt, exitPrice, exitReason, balance }) {
  const direction = openEvent.direction === 'BUY' ? 1 : -1;
  const pnl = (exitPrice - openEvent.entry) * direction * openEvent.size;
  const pnlPercent = balance ? (pnl / balance) * 100 : null;

  return createTradeEvent({
    ...openEvent,
    closedAt,
    exitPrice,
    pnl,
    pnlPercent,
    exitReason,
  });
}

module.exports = { createTradeEvent, closeTradeEvent };
