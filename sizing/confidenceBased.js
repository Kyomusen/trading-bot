// sizing/confidenceBased.js
// TODO: metric วัด confidence ยังไม่ตกผลึก — ตอนนี้ scale risk% เชิงเส้นตาม
// signal.confidence (0-1) ระหว่าง baseRiskPercent กับ maxRiskPercent เป็นแค่ placeholder
// ห้ามใช้ตัดสินใจจริงจนกว่าจะออกแบบ metric และ backtest ยืนยันแล้ว

function calcSize({ balance, slDistance, confidence = 0.5, config, symbolConfig }) {
  if (!slDistance || slDistance <= 0) {
    throw new Error('confidenceBased sizing ต้องการ slDistance ที่มากกว่า 0');
  }
  const { baseRiskPercent, maxRiskPercent } = config.sizing.confidenceBased;
  const clampedConfidence = Math.max(0, Math.min(1, confidence));
  const scaledRisk = baseRiskPercent + (maxRiskPercent - baseRiskPercent) * clampedConfidence;
  // per-symbol riskPercent ให้ override ค่า global ถ้ามี
  const riskPercent = symbolConfig?.riskPercent ?? scaledRisk;
  const riskAmount = balance * (riskPercent / 100);
  return riskAmount / slDistance;
}

module.exports = { calcSize };
