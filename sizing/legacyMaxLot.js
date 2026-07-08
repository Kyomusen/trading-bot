// sizing/legacyMaxLot.js
// วิธีเดิมที่ backtest 22 ปีผ่านมาแล้ว: maxLot = balance / divisor
// เก็บไว้เป็นทางเลือกเทียบผลกับวิธีใหม่

function calcSize({ balance, config }) {
  const { divisor } = config.sizing.legacyMaxLot;
  return balance / divisor;
}

module.exports = { calcSize };
