// sizing/index.js
// จุดเดียวที่ engine เรียกเพื่อคำนวณ size — สลับวิธีคำนวณผ่าน config.sizingMethod
// โดยไม่ต้องแตะ engine หรือ live/backtest loop เลย

const legacyMaxLot = require('./legacyMaxLot');
const fixedRisk = require('./fixedRisk');
const confidenceBased = require('./confidenceBased');
const config = require('../config');

const methods = { legacyMaxLot, fixedRisk, confidenceBased };

// marketDetails: { minDealSize, maxDealSize } จาก broker (จริงหรือจำลอง)
// symbolConfig: config ของ symbol (ใช้หา riskPercent per-symbol ถ้ามี)
function calcPositionSize({ balance, slDistance, confidence, marketDetails, symbolConfig }) {
  const method = methods[config.sizingMethod];
  if (!method) {
    throw new Error(`ไม่รู้จัก sizingMethod: ${config.sizingMethod}`);
  }

  let size = method.calcSize({ balance, slDistance, confidence, config, symbolConfig });

  // clamp ด้วย min/max ของ broker เสมอ ไม่ว่าจะใช้ sizing วิธีไหน
  const safetyMargin = config.engine.maxDealSizeSafetyMargin;
  if (marketDetails?.maxDealSize) {
    size = Math.min(size, marketDetails.maxDealSize * safetyMargin);
  }
  if (marketDetails?.minDealSize) {
    size = Math.max(size, marketDetails.minDealSize);
  }

  return Math.round(size * 100) / 100; // ปัด 2 ตำแหน่ง
}

// คำนวณเพดานขนาด position
//  mode 'dynamic': maxLot = balance * leverage / price (ขยายตาม balance → ไม่ clamp fixedRisk sizing)
//  mode 'fixed' : ใช้ symbolConfig.maxLot (หรือ global fixed)
function resolveMaxLot(symbolConfig, balance, price) {
  const m = config.sizing.maxLot;
  if (m.mode === 'dynamic' && price > 0) {
    const lev = symbolConfig?.leverage ?? config.broker?.leverage ?? 100;
    const v = (balance * lev) / price;
    return Math.max(m.floor ?? 0.01, v);
  }
  return symbolConfig?.maxLot ?? (m.fixed ?? 5);
}

module.exports = { calcPositionSize, resolveMaxLot };
