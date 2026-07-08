// notify/chart.js
// TODO: ย้าย logic จาก chart.js เดิม (Bresenham line drawing + EMA overlay) มาไว้ตรงนี้
// รับ TradeEvent (คำนวณเสร็จแล้ว) + candles เป็น input คืนค่า PNG buffer
// ห้ามคำนวณ indicator ใหม่ในนี้ — ใช้ indicators ที่มากับ tradeEvent.indicators หรือ candles ที่ส่งเข้ามาแล้ว

function generateChartPng(tradeEvent, candles) {
  // placeholder — ใส่ logic การวาดจริงจากไฟล์ chart.js เดิม
  throw new Error('notify/chart.js: ยังไม่ได้ implement — ย้าย logic จาก chart.js เดิมมาใส่ตรงนี้');
}

module.exports = { generateChartPng };
