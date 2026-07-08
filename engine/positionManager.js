// engine/positionManager.js
// จุดเดียวที่มี trailing-stop logic ทั้ง repo (ใช้ร่วมกันทั้ง live และ backtest)
// เพื่อการันตีว่าพฤติกรรมเหมือนกันเป๊ะ ห้ามเขียน trailing logic ซ้ำที่อื่น
//
// calcTrailingStop(position, currentPrice, atrNow, symbolConfig, opts)
//   position:      { direction:'BUY'|'SELL', entryPrice, currentStopLevel, bestPrice? }
//                  ฟังก์ชันจะอัปเดต position.bestPrice และ position.currentStopLevel ให้ caller ด้วย
//   currentPrice:  ราคาล่าสุดที่ใช้ advance best price
//                  (backtest/audit/validate ส่ง extreme ของแท่ง: high สำหรับ BUY, low สำหรับ SELL
//                   live ส่งราคาตลาด ณ tick นั้น)
//   atrNow:        ATR ปัจจุบัน
//   symbolConfig:  config ของ symbol (trailingActivate, trailingDistance, spreadPips, pipValue)
//   opts.spreadPrice: (optional) spread จริงเป็น price units ถ้ามี ให้ใช้เป็น floor แทน spreadPips

function calcTrailingStop(position, currentPrice, atrNow, symbolConfig, opts = {}) {
  const act = symbolConfig.trailingActivate ?? 0.2;
  const dist = symbolConfig.trailingDistance ?? 0.1;
  const pip = symbolConfig.pipValue ?? 0.01;
  const floor = opts.spreadPrice != null
    ? opts.spreadPrice
    : (symbolConfig.spreadPips || 0) * pip;

  // advance best price since entry (stateful, เก็บใน position เพื่อเรียกซ้ำทุกแท่ง)
  const bestPrice = position.bestPrice != null
    ? (position.direction === 'BUY'
        ? Math.max(position.bestPrice, currentPrice)
        : Math.min(position.bestPrice, currentPrice))
    : currentPrice;
  position.bestPrice = bestPrice;

  const cur = position.currentStopLevel != null
    ? position.currentStopLevel
    : (position.direction === 'BUY' ? -Infinity : Infinity);

  if (atrNow == null) return position.currentStopLevel;

  // activation: กำไรเทียบกับ ATR ต้องถึงเกณฑ์ก่อนค่อยขยับ SL
  const profitPct = position.direction === 'BUY'
    ? (bestPrice - position.entryPrice) / atrNow
    : (position.entryPrice - bestPrice) / atrNow;
  if (profitPct < act) return position.currentStopLevel;

  // ระยะ trailing อย่างน้อยต้องเท่ากับ spread (กัน SL ตื้นกว่าสเปรด)
  const trail = Math.max(dist * atrNow, floor);
  const lockSl = position.direction === 'BUY'
    ? position.entryPrice - trail
    : position.entryPrice + trail;
  const candSl = position.direction === 'BUY'
    ? Math.max(cur, bestPrice - trail, lockSl)
    : Math.min(cur, bestPrice + trail, lockSl);

  position.currentStopLevel = candSl;
  return candSl;
}

// รวม symbol config กับ override ของ trailing (ใช้โดย validate.js ใน grid search)
// ส่งมาเป็น positional (ไม่ใช้ชื่อ field) เพื่อไม่ให้ชื่อ trailingActivate/trailingDistance
// หลุดไปอยู่ใน caller อื่น
function applyTrailingOverrides(symbolConfig, actOverride, distOverride) {
  return {
    ...symbolConfig,
    trailingActivate: actOverride ?? symbolConfig.trailingActivate ?? 0.2,
    trailingDistance: distOverride ?? symbolConfig.trailingDistance ?? 0.1,
  };
}

module.exports = { calcTrailingStop, applyTrailingOverrides };
