const { RSI, EMA, MACD, ATR } = require('technicalindicators');
const config = require('../config');

function pipToPrice(pips) {
  return pips * 0.01;
}

function h4FromH1(candles) {
  const groups = {};
  for (const c of candles) {
    const key = Math.floor(c.timestamp / 14400000) * 14400000;
    if (!groups[key]) {
      groups[key] = { timestamp: key, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      const g = groups[key];
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
    }
  }
  return Object.values(groups);
}

function calcInd(candles) {
  const high = candles.map(c => c.high);
  const low = candles.map(c => c.low);
  const close = candles.map(c => c.close);
  const n = close.length;

  const rsiAll = RSI.calculate({ values: close, period: 14 });
  const ema20All = EMA.calculate({ values: close, period: 20 });
  const ema50All = EMA.calculate({ values: close, period: 50 });
  const macdAll = MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const atrAll = ATR.calculate({ high, low, close, period: 14 });

  const last = {
    currentPrice: close[n - 1],
    rsi: rsiAll[rsiAll.length - 1] ?? null,
    ema20: ema20All[ema20All.length - 1] ?? null,
    ema50: ema50All[ema50All.length - 1] ?? null,
    emaTrend: (ema20All[ema20All.length - 1] ?? 0) > (ema50All[ema50All.length - 1] ?? 0) ? 'bullish' : 'bearish',
    macd: {
      macd: macdAll[macdAll.length - 1]?.MACD ?? null,
      signal: macdAll[macdAll.length - 1]?.signal ?? null,
      histogram: macdAll[macdAll.length - 1]?.histogram ?? null,
      histogramTrend: (macdAll[macdAll.length - 1]?.histogram ?? 0) > 0 ? 'positive' : 'negative',
    },
    atr: atrAll[atrAll.length - 1] ?? null,
  };

  const recent = candles.slice(-24);
  const swingHigh = Math.max(...recent.map(c => c.high));
  const swingLow = Math.min(...recent.map(c => c.low));
  const threshold = last.atr ? last.atr * 0.3 : 0;
  const nearSupport = threshold > 0 && Math.abs(last.currentPrice - swingLow) <= threshold;
  const nearResistance = threshold > 0 && Math.abs(last.currentPrice - swingHigh) <= threshold;

  return { ...last, swingHigh, swingLow, nearSupport, nearResistance };
}

function evaluate(candles, epic) {
  return _evaluate(candles, null, null, epic);
}

function _evaluate(candles, pc, idx, epic) {
  const sc = config.symbols.find(s => s.epic === epic) || {};
  if (!sc || !sc.enabled) return null;

  // session filter สำหรับ generate signal เท่านั้น (1 = 24/7, null = ไม่จำกัด)
  const session = sc.tradingHours;
  if (session && session.utcStart != null) {
    const cur = idx != null ? candles[idx] : candles[candles.length - 1];
    const h = new Date(cur.timestamp).getUTCHours();
    if (h < session.utcStart || h >= session.utcEnd) return null;
  }

  const ind = pc ? pc[idx] : calcInd(candles);
  if (!ind || ind.rsi == null || !ind.atr) return null;

  const { rsi, atr, currentPrice, ema20, ema50, emaTrend, macd, nearSupport, nearResistance } = ind;

  let h4Trend = 'neutral';
  if (pc && pc[idx]?.h4Trend) {
    h4Trend = pc[idx].h4Trend;
  } else {
    try {
      const h4c = h4FromH1(candles);
      if (h4c.length >= 20) h4Trend = calcInd(h4c).emaTrend;
    } catch {}
  }

  const aboveEma50 = currentPrice && ema50 ? currentPrice > ema50 : false;
  const belowEma50 = currentPrice && ema50 ? currentPrice < ema50 : false;
  const macdNegative = macd?.histogramTrend === 'negative';
  const macdPositive = macd?.histogramTrend === 'positive';
  const macdCrossoverBear = macd?.histogram < 0 && macd?.macd < macd?.signal;
  const macdCrossoverBull = macd?.histogram > 0 && macd?.macd > macd?.signal;

  const trendMode = sc.trendMode || 'AND';
  const downtrend = trendMode === 'AND'
    ? (h4Trend === 'bearish' && belowEma50)
    : (h4Trend === 'bearish' || belowEma50);
  const uptrend = trendMode === 'AND'
    ? (h4Trend === 'bullish' && aboveEma50)
    : (h4Trend === 'bullish' || aboveEma50);

  const pips = Math.round(atr / pipToPrice(1));
  const slM = sc.atrSl || 1.5;
  const spreadPips = sc.spreadPips || 20;
  const slPips = Math.max(Math.round(pips * slM + spreadPips), 10);

  const allowedSetups = sc.activeSetups || ['trend_buy', 'trend_sell'];
  const rsiRanges = sc.rsi || {
    trend_buy: { min: 30, max: 50 },
    trend_sell: { min: 50, max: 70 },
  };

  const candidates = [];
  for (const setup of allowedSetups) {
    const rr = rsiRanges[setup];
    if (!rr) continue;
    if (rsi < rr.min || rsi > rr.max) continue;

    if (setup === 'trend_sell' && downtrend && nearResistance)
      candidates.push({ action: 'SELL', setup, confidence: 0.8, slPips });
    if (setup === 'trend_buy' && uptrend && nearSupport)
      candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips });
    if (setup === 'momentum_sell' && downtrend && macdNegative && macdCrossoverBear)
      candidates.push({ action: 'SELL', setup, confidence: 0.7, slPips });
    if (setup === 'momentum_buy' && uptrend && macdPositive && macdCrossoverBull)
      candidates.push({ action: 'BUY', setup, confidence: 0.7, slPips });
    if (setup === 'pullback_sell' && downtrend && macdNegative && macdCrossoverBear)
      candidates.push({ action: 'SELL', setup, confidence: 0.8, slPips });
    if (setup === 'pullback_buy' && uptrend && macdPositive && macdCrossoverBull)
      candidates.push({ action: 'BUY', setup, confidence: 0.8, slPips });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.confidence - a.confidence);
  const d = candidates[0];

  const slippage = sc.slippagePips || 2;
  const entryPrice = d.action === 'BUY'
    ? currentPrice + slippage * pipToPrice(1)
    : currentPrice - slippage * pipToPrice(1);
  const slPrice = d.action === 'BUY'
    ? entryPrice - d.slPips * pipToPrice(1)
    : entryPrice + d.slPips * pipToPrice(1);

  return {
    strategy: 'xauTrend',
    direction: d.action,
    entry: parseFloat(entryPrice.toFixed(5)),
    stopLoss: parseFloat(slPrice.toFixed(5)),
    confidence: d.confidence,
    indicators: {
      rsi, ema20, ema50, emaTrend,
      macd: macd.histogram, atr, h4Trend,
      setup: d.setup, slPips: d.slPips,
    },
  };
}

// EMA แบบ causal ที่ seed ด้วย SMA ของ period แรก (ตรงกับ technicalindicators.EMA)
// คืน array ความยาวเท่ากับ input, ค่าต่อน period-1 แรกเป็น null (ช่วง warmup)
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let k = 0; k < period; k++) sum += values[k];
  const alpha = 2 / (period + 1);
  let prev = sum / period;
  out[period - 1] = prev;
  for (let k = period; k < values.length; k++) {
    prev = values[k] * alpha + prev * (1 - alpha);
    out[k] = prev;
  }
  return out;
}

// EMA ของ H4 close series ที่จบด้วย runningClose (ราคาล่าสุดของ bucket ปัจจุบัน)
// = EMA([h4ClosesAll[0..hj-1], runningClose]) ณ ดัชนีสุดท้าย (causal 100%)
function h4EmaAt(hj, runningClose, emaFull, period, h4ClosesAll) {
  const Slen = hj + 1;
  if (Slen < period) return null;
  if (Slen === period) {
    let s = 0;
    for (let k = 0; k < period - 1; k++) s += h4ClosesAll[k];
    return (s + runningClose) / period;
  }
  const prev = emaFull[hj - 1];
  const alpha = 2 / (period + 1);
  return runningClose * alpha + prev * (1 - alpha);
}

function precalc(candles, epic) {
  const n = candles.length;
  if (n < 60) return [];
  const high = candles.map(c => c.high);
  const low = candles.map(c => c.low);
  const close = candles.map(c => c.close);

  const rsiAll = RSI.calculate({ values: close, period: 14 });
  const ema20All = EMA.calculate({ values: close, period: 20 });
  const ema50All = EMA.calculate({ values: close, period: 50 });
  const macdAll = MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const atrAll = ATR.calculate({ high, low, close, period: 14 });

  // คำนวณ offset จากความยาวจริงของ array ที่ library ให้มา
  // จะได้ไม่พังถ้าต่อมา technicalindicators เปลี่ยนจำนวน warmup bar
  const offRsi = close.length - rsiAll.length;
  const offEma20 = close.length - ema20All.length;
  const offEma50 = close.length - ema50All.length;
  const offMacd = close.length - macdAll.length;
  const offAtr = close.length - atrAll.length;
  const offset = Math.max(offRsi, offEma20, offEma50, offMacd, offAtr);

  // H4 trend แบบไม่มี look-ahead:
  // สร้าง H4 buckets ล่วงหน้า (close = ราคาปิดสุดท้ายของแต่ละ bucket)
  // ตอนคำนวณ trend ที่แท่ง i จะแทน close ของ bucket "ที่กำลังเกิด" ด้วย candles[i].close
  // (ราคาล่าสุดที่รู้จริงๆ) แทน close ในอนาคต เพื่อไม่ให้เกิด look-ahead bias
  const H4_MS = 14400000;
  const h4All = h4FromH1(candles);
  const h4ClosesAll = h4All.map(c => c.close);
  // EMA แบบ causal ที่ seed ด้วย SMA ของ period แรก (ตรงกับ technicalindicators)
  const emaFull20 = emaSeries(h4ClosesAll, 20);
  const emaFull50 = emaSeries(h4ClosesAll, 50);
  const h4IndexByKey = {};
  h4All.forEach((c, j) => { h4IndexByKey[c.timestamp] = j; });

  const result = new Array(n);

  for (let i = offset; i < n; i++) {
    const start = Math.max(0, i - 23);
    let sh = -Infinity, sl = Infinity;
    for (let j = start; j <= i; j++) {
      if (candles[j].high > sh) sh = candles[j].high;
      if (candles[j].low < sl) sl = candles[j].low;
    }
    const currentPrice = close[i];
    const atrVal = atrAll[i - offAtr] ?? null;
    const threshold = atrVal && atrVal > 0 ? atrVal * 0.3 : 0;
    const nearSupport = threshold > 0 && Math.abs(currentPrice - sl) <= threshold;
    const nearResistance = threshold > 0 && Math.abs(currentPrice - sh) <= threshold;

    // H4 trend แบบไม่มี look-ahead: EMA ของ H4 bucket ที่ complete แล้ว (0..j-1)
    // + bucket ปัจจุบัน (j) ที่เอาค่า close ล่าสุด candles[i].close แทน close อนาคต
    const h4Key = Math.floor(candles[i].timestamp / H4_MS) * H4_MS;
    const hj = h4IndexByKey[h4Key];
    let h4Trend;
    if (hj == null || (hj + 1) < 20) {
      h4Trend = 'neutral';
    } else {
      const e20 = h4EmaAt(hj, candles[i].close, emaFull20, 20, h4ClosesAll);
      const e50 = h4EmaAt(hj, candles[i].close, emaFull50, 50, h4ClosesAll);
      h4Trend = (e20 ?? 0) > (e50 ?? 0) ? 'bullish' : 'bearish';
    }

    result[i] = {
      currentPrice,
      rsi: rsiAll[i - offRsi] ?? null,
      ema20: ema20All[i - offEma20] ?? null,
      ema50: ema50All[i - offEma50] ?? null,
      emaTrend: (ema20All[i - offEma20] ?? 0) > (ema50All[i - offEma50] ?? 0) ? 'bullish' : 'bearish',
      macd: {
        macd: macdAll[i - offMacd]?.MACD ?? null,
        signal: macdAll[i - offMacd]?.signal ?? null,
        histogram: macdAll[i - offMacd]?.histogram ?? null,
        histogramTrend: (macdAll[i - offMacd]?.histogram ?? 0) > 0 ? 'positive' : 'negative',
      },
      atr: atrVal,
      swingHigh: sh, swingLow: sl, nearSupport, nearResistance,
      h4Trend,
    };
  }
  return result;
}

function evaluatePrecalc(candles, pc, idx, epic) {
  return _evaluate(candles, pc, idx, epic);
}

module.exports = { name: 'xauTrend', evaluate, precalc, evaluatePrecalc, calcInd, h4FromH1 };
