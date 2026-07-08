// scripts/offsetTest.js
// Unit test เปรียบเทียบค่าอินดิเคเตอร์ระหว่าง calcInd (real-time, ไม่มี offset)
// กับ precalc (มี offset) ที่ index เดียวกันของ candle เดียวกัน
// ค่าต้องตรงกันเป๊ะ (tolerance เล็กน้อยสำหรับ float) หากไม่ตรง = ยังมี offset bug

const assert = require('assert');
const { calcInd, precalc, h4FromH1 } = require('../signals/xauStrategy');

function genCandles(n, startPrice = 4000) {
  const candles = [];
  let price = startPrice;
  const HOUR = 3600000;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 7) * 3 + Math.cos(i / 3) * 2;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + Math.abs(Math.sin(i)) * 4;
    const low = Math.min(open, close) - Math.abs(Math.cos(i)) * 4;
    candles.push({
      timestamp: 1700000000000 + i * HOUR,
      open: parseFloat(open.toFixed(5)),
      high: parseFloat(high.toFixed(5)),
      low: parseFloat(low.toFixed(5)),
      close: parseFloat(close.toFixed(5)),
    });
    price = close;
  }
  return candles;
}

function approx(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) < 1e-6;
}

function compareAt(candles, i) {
  const pre = precalc(candles)[i];
  const live = calcInd(candles.slice(0, i + 1));
  // h4Trend แบบ real-time (เช่นเดียวกับที่ _evaluate คำนวณ) แต่ใช้เฉพาะข้อมูลถึงแท่ง i (causal)
  const h4cLive = h4FromH1(candles.slice(0, i + 1));
  const liveH4Trend = h4cLive.length >= 20 ? calcInd(h4cLive).emaTrend : 'neutral';
  const keys = ['currentPrice', 'rsi', 'ema20', 'ema50', 'emaTrend', 'atr', 'swingHigh', 'swingLow', 'nearSupport', 'nearResistance'];
  for (const k of keys) {
    assert.ok(approx(pre[k], live[k]), `mismatch key=${k} i=${i} precalc=${pre[k]} live=${live[k]}`);
  }
  assert.ok(pre.h4Trend === liveH4Trend, `mismatch key=h4Trend i=${i} precalc=${pre.h4Trend} live=${liveH4Trend}`);
  for (const k of ['macd', 'signal', 'histogram', 'histogramTrend']) {
    assert.ok(approx(pre.macd[k], live.macd[k]), `mismatch macd.${k} i=${i} precalc=${pre.macd[k]} live=${live.macd[k]}`);
  }
}

const N = 120;
const candles = genCandles(N);
const pc = precalc(candles);
let checked = 0;
for (let i = 50; i < N; i++) {
  compareAt(candles, i);
  checked++;
}
console.log(`PASS: เปรียบเทียบครบ ${checked} index (i=50..${N - 1}) ค่า calcInd กับ precalc ตรงกันเป๊ะ`);
