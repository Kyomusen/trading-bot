// signals/exampleStrategy.js
// ตัวอย่างกลยุทธ์: EMA cross + RSI filter
// TODO: แทนที่ด้วยกลยุทธ์จริงของ Nat — โครงสร้าง input/output ต้องคงเดิม
// เพื่อให้ signals/index.js กับ engine เรียกใช้ได้แบบเดียวกันทุกกลยุทธ์

const { ema, rsi } = require('../utils/indicators');

const name = 'exampleEmaRsi';

// candles: array ของ { open, high, low, close, timestamp } เรียงเก่า -> ใหม่
// คืนค่า signal หรือ null ถ้าไม่มีสัญญาณ
function evaluate(candles) {
  if (candles.length < 50) return null;

  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, 12);
  const emaSlow = ema(closes, 26);
  const rsiValues = rsi(closes, 14);

  const i = closes.length - 1;
  const prevFast = emaFast[i - 1];
  const prevSlow = emaSlow[i - 1];
  const curFast = emaFast[i];
  const curSlow = emaSlow[i];
  const curRsi = rsiValues[i];

  const crossUp = prevFast <= prevSlow && curFast > curSlow;
  const crossDown = prevFast >= prevSlow && curFast < curSlow;

  // confluence นับจำนวนเงื่อนไขที่เห็นด้วยกัน ใช้เป็น confidence เบื้องต้น
  // TODO: metric confidence จริงยังไม่ตกผลึก อันนี้เป็นแค่ placeholder
  if (crossUp && curRsi < 70) {
    const confluence = [crossUp, curRsi < 60].filter(Boolean).length;
    return {
      strategy: name,
      direction: 'BUY',
      entry: candles[i].close,
      confidence: confluence / 2, // 0.5 หรือ 1.0
      indicators: { emaFast: curFast, emaSlow: curSlow, rsi: curRsi },
    };
  }

  if (crossDown && curRsi > 30) {
    const confluence = [crossDown, curRsi > 40].filter(Boolean).length;
    return {
      strategy: name,
      direction: 'SELL',
      entry: candles[i].close,
      confidence: confluence / 2,
      indicators: { emaFast: curFast, emaSlow: curSlow, rsi: curRsi },
    };
  }

  return null;
}

module.exports = { name, evaluate };
