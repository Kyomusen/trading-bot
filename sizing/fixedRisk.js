// sizing/fixedRisk.js
// quantity = (balance x riskPercent/100) / slDistance
// slDistance ต้องเป็นหน่วยเดียวกับราคา (ดอลลาร์ต่อ oz สำหรับทอง)

function calcSize({ balance, slDistance, config, symbolConfig }) {
  if (!slDistance || slDistance <= 0) {
    throw new Error('fixedRisk sizing ต้องการ slDistance ที่มากกว่า 0');
  }
  // per-symbol riskPercent ให้ override ค่า global ถ้ามี
  const riskPercent = symbolConfig?.riskPercent ?? config.sizing.fixedRisk.riskPercent;
  const riskAmount = balance * (riskPercent / 100);
  return riskAmount / slDistance;
}

module.exports = { calcSize };
