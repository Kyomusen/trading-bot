const zlib = require('zlib');

const WIDTH = 800;
const HEIGHT = 600;
const MARGIN = 40;
const PANEL_H = (HEIGHT - MARGIN * 2) / 3;
const MAIN_H = PANEL_H * 1.4;
const RSI_H = PANEL_H * 0.8;
const MACD_H = PANEL_H * 0.8;

const BG = [17, 24, 39];
const GRID = [31, 41, 55];
const DIVIDER = [55, 65, 81];

const COLOR = {
  price: [0, 200, 255],
  ema20: [255, 165, 0],
  ema50: [0, 255, 100],
  rsi: [180, 100, 255],
  rsiBand: [80, 60, 100],
  macdLine: [255, 220, 0],
  macdSignal: [255, 100, 100],
  macdUp: [0, 200, 80],
  macdDown: [255, 60, 60],
  zero: [80, 80, 80],
  label: [200, 200, 200],
};

// --- pure math helpers ---
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  const avg = (arr, n) => arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let avgG = avg(gains, period);
  let avgL = avg(losses, period);
  const out = new Array(closes.length).fill(null);
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  const k = 1 / period;
  for (let i = period + 1; i <= gains.length; i++) {
    avgG = gains[i - 1] * k + avgG * (1 - k);
    avgL = losses[i - 1] * k + avgL * (1 - k);
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const ema = (vals, period) => {
    if (!vals.length) return [];
    const k = 2 / (period + 1);
    const out = [vals[0]];
    for (let i = 1; i < vals.length; i++) out.push(vals[i] * k + out[i - 1] * (1 - k));
    return out;
  };
  const eFast = ema(closes, fast);
  const eSlow = ema(closes, slow);
  const macdLine = eFast.map((v, i) => v - eSlow[i]);
  const sigLine = ema(macdLine.slice(slow - 1), signal);
  const pad = slow - 1;
  return {
    macd: macdLine.map((v, i) => i >= pad ? v : null),
    signal: sigLine.map((v, i) => i >= pad ? v : null).concat(new Array(macdLine.length - sigLine.length).fill(null)),
    histogram: macdLine.map((v, i) => {
      if (i < pad) return null;
      const sigIdx = i - pad;
      return sigIdx < sigLine.length ? v - sigLine[sigIdx] : null;
    }),
  };
}

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// --- PNG encoder (same as before) ---
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// --- pixel helpers ---
function setPixel(buf, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}

function drawLine(buf, x0, y0, x1, y1, color) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    setPixel(buf, x0, y0, color);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function fillRect(buf, x, y, w, h, color) {
  for (let row = y; row < Math.min(y + h, HEIGHT); row++) {
    for (let col = x; col < Math.min(x + w, WIDTH); col++) {
      setPixel(buf, col, row, color);
    }
  }
}

function drawText(buf, x, y, text, color, size) {
  // simple 5×7 bitmap font (caps + digits + . - only)
  const font = {
    '0': [0x7c,0x82,0x82,0x82,0x7c], '1': [0x20,0x60,0x20,0x20,0x70],
    '2': [0x7c,0x80,0x7c,0x02,0xfe], '3': [0x7c,0x80,0x78,0x80,0x7c],
    '4': [0x42,0x42,0xfe,0xc2,0xc2], '5': [0xfe,0x02,0x7c,0x80,0x7c],
    '6': [0x7c,0x02,0x7c,0x82,0x7c], '7': [0xfe,0x80,0x40,0x20,0x10],
    '8': [0x7c,0x82,0x7c,0x82,0x7c], '9': [0x7c,0x82,0xfc,0x80,0x7c],
    '.': [0x00,0x00,0x00,0x60,0x60], '-': [0x00,0x00,0xfe,0x00,0x00],
    '+': [0x00,0x10,0xfe,0x10,0x00], 'R': [0x7c,0x82,0xfe,0x82,0x82],
    'S': [0xfc,0x02,0x7c,0x80,0xfe], 'I': [0xfe,0x10,0x10,0x10,0xfe],
    'M': [0x82,0xc6,0xaa,0x92,0x82], 'A': [0x7c,0x82,0xfe,0x82,0x82],
    'C': [0x7c,0x82,0x82,0x82,0x7c], 'D': [0x7c,0x82,0x82,0x82,0x7c],
    'E': [0xfe,0x02,0x1e,0x02,0xfe], 'P': [0xfe,0x82,0xfe,0x82,0x82],
    'B': [0xfe,0x82,0xfc,0x82,0xfe], 'L': [0x02,0x02,0x02,0x02,0xfe],
    ' ': [0x00,0x00,0x00,0x00,0x00],
  };
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = font[ch] || font[' '];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 7; col++) {
        if (glyph[row] & (1 << (6 - col))) {
          setPixel(buf, cx + col, y + row, color);
        }
      }
    }
    cx += 8;
  }
}

// --- draw oscillators ---
function drawOscillator(buf, values, yBase, height, zeroLine, overbought, oversold, lineColor, upColor, downColor, useBar) {
  const n = values.length;
  if (n < 2) return;
  const valid = values.filter(v => v != null);
  if (!valid.length) return;
  let min = Math.min(...valid), max = Math.max(...valid);
  if (max - min < 1) { min -= 0.5; max += 0.5; }
  const toY = (v) => yBase + height - ((v - min) / (max - min)) * height * 0.85 - height * 0.075;
  // zero line
  const zy = Math.round(toY(zeroLine || 0));
  drawLine(buf, 0, zy, WIDTH - 1, zy, DIVIDER);
  // bands
  if (overbought != null) { const oy = Math.round(toY(overbought)); drawLine(buf, 0, oy, WIDTH - 1, oy, COLOR.rsiBand); }
  if (oversold != null) { const oy = Math.round(toY(oversold)); drawLine(buf, 0, oy, WIDTH - 1, oy, COLOR.rsiBand); }

  const xAt = (i) => (i * (WIDTH - 1)) / (n - 1);
  if (useBar) {
    for (let i = 1; i < n; i++) {
      if (values[i] == null) continue;
      const x = Math.round(xAt(i));
      const y0 = zy;
      const y1 = Math.round(toY(values[i]));
      const c = values[i] >= 0 ? upColor : downColor;
      drawLine(buf, x, y0, x, y1, c);
    }
  } else {
    let prevI = -1;
    for (let i = 0; i < n; i++) {
      if (values[i] == null) continue;
      if (prevI >= 0) drawLine(buf, xAt(prevI), toY(values[prevI]), xAt(i), toY(values[i]), lineColor);
      prevI = i;
    }
  }
  // labels
  const labelX = WIDTH - 55;
  drawText(buf, labelX, yBase + 2, max.toFixed(1), COLOR.label);
  if (overbought != null) drawText(buf, labelX, yBase + height * 0.25 - 4, String(overbought), COLOR.rsiBand);
  if (oversold != null) drawText(buf, labelX, yBase + height * 0.75 - 4, String(oversold), COLOR.rsiBand);
  drawText(buf, labelX, yBase + height - 10, min.toFixed(1), COLOR.label);
}

function generateChartPng(tradeEvent, candles) {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  fillRect(rgb, 0, 0, WIDTH, HEIGHT, BG);

  // panel boundaries
  const mainBottom = MARGIN + MAIN_H;
  const rsiTop = mainBottom + 15;
  const rsiBottom = rsiTop + RSI_H;
  const macdTop = rsiBottom + 15;
  const macdBottom = macdTop + MACD_H;

  // draw dividers
  drawLine(rgb, 0, mainBottom, WIDTH - 1, mainBottom, DIVIDER);
  drawLine(rgb, 0, rsiBottom, WIDTH - 1, rsiBottom, DIVIDER);
  drawLine(rgb, 0, macdBottom, WIDTH - 1, macdBottom, DIVIDER);

  // ---- MAIN PANEL: candlestick + EMA ----
  const ohlc = (candles || []).map(c => ({
    o: parseFloat(c.open), h: parseFloat(c.high),
    l: parseFloat(c.low),  c: parseFloat(c.close),
  })).filter(v => isFinite(v.o) && isFinite(v.h) && isFinite(v.l) && isFinite(v.c));
  if (ohlc.length < 2) return encodePNG(WIDTH, HEIGHT, rgb);

  let pMin = Infinity, pMax = -Infinity;
  for (const v of ohlc) {
    if (v.h > pMax) pMax = v.h;
    if (v.l < pMin) pMin = v.l;
  }
  const e20 = ema(ohlc.map(v => v.c), 20);
  const e50 = ema(ohlc.map(v => v.c), 50);
  for (const arr of [e20, e50]) for (const v of arr) {
    if (v < pMin) pMin = v; if (v > pMax) pMax = v;
  }
  const pRange = (pMax - pMin) || 1;
  const pPad = pRange * 0.05;
  pMin -= pPad; pMax += pPad;
  const adjRange = pMax - pMin;

  const n = ohlc.length;
  const candleW = Math.max(2, Math.floor((WIDTH - 1) / n / 1.3));
  const gap = Math.max(0, Math.floor((WIDTH - 1) / n) - candleW);
  const toMainY = (v) => 0 + MAIN_H - ((v - pMin) / adjRange) * (MAIN_H - 1);

  for (let i = 0; i < n; i++) {
    const cx = Math.round((i * (WIDTH - 1)) / (n - 1));
    const x = cx - Math.floor(candleW / 2);
    const bodyTop = toMainY(Math.max(ohlc[i].o, ohlc[i].c));
    const bodyBot = toMainY(Math.min(ohlc[i].o, ohlc[i].c));
    const wickTop = toMainY(ohlc[i].h);
    const wickBot = toMainY(ohlc[i].l);
    const isUp = ohlc[i].c >= ohlc[i].o;
    const bodyColor = isUp ? [0, 200, 80] : [255, 60, 60];

    // wick
    drawLine(rgb, cx, wickTop, cx, bodyTop, [150, 150, 150]);
    drawLine(rgb, cx, bodyBot, cx, wickBot, [150, 150, 150]);
    // body
    if (candleW >= 3) {
      fillRect(rgb, x, bodyBot, candleW, Math.max(1, bodyBot - bodyTop + 1), bodyColor);
    } else {
      setPixel(rgb, cx, bodyBot, bodyColor);
    }
  }

  // EMA overlays
  for (let i = 1; i < e20.length; i++) {
    if (e20[i - 1] == null || e20[i] == null) continue;
    const x0 = (i - 1) * (WIDTH - 1) / (n - 1);
    const x1 = i * (WIDTH - 1) / (n - 1);
    drawLine(rgb, x0, toMainY(e20[i - 1]), x1, toMainY(e20[i]), COLOR.ema20);
  }
  for (let i = 1; i < e50.length; i++) {
    if (e50[i - 1] == null || e50[i] == null) continue;
    const x0 = (i - 1) * (WIDTH - 1) / (n - 1);
    const x1 = i * (WIDTH - 1) / (n - 1);
    drawLine(rgb, x0, toMainY(e50[i - 1]), x1, toMainY(e50[i]), COLOR.ema50);
  }

  // price labels
  drawText(rgb, 3, 2, pMax.toFixed(1), COLOR.label);
  drawText(rgb, 3, MAIN_H - 12, pMin.toFixed(1), COLOR.label);

  // ---- RSI SUB-PANEL ----
  const rsiVals = calcRSI(ohlc.map(v => v.c), 14);
  drawOscillator(rgb, rsiVals, rsiTop, RSI_H, 50, 70, 30, COLOR.rsi, null, null, false);
  drawText(rgb, 5, rsiTop + 2, 'RSI(14)', COLOR.rsi);

  // ---- MACD SUB-PANEL ----
  const macdData = calcMACD(ohlc.map(v => v.c), 12, 26, 9);
  const macdLen = macdData.histogram.length;
  const validMacd = macdData.histogram.filter(v => v != null);
  let macdMin = Math.min(...validMacd, ...macdData.macd.filter(v => v != null), ...macdData.signal.filter(v => v != null));
  let macdMax = Math.max(...validMacd, ...macdData.macd.filter(v => v != null), ...macdData.signal.filter(v => v != null));
  if (macdMax - macdMin < 0.1) { macdMin -= 0.5; macdMax += 0.5; }
  const macdAbsMax = Math.max(Math.abs(macdMin), Math.abs(macdMax));
  const macdRange = macdAbsMax * 2.2 || 1;
  const mY0 = macdTop + MACD_H / 2;

  const toMacdY = (v) => mY0 - (v / macdRange) * (MACD_H * 0.45);
  drawLine(rgb, 0, mY0, WIDTH - 1, mY0, COLOR.zero);

  // histogram bars
  const xAt = (i) => (i * (WIDTH - 1)) / (macdLen - 1);
  for (let i = 0; i < macdLen; i++) {
    if (macdData.histogram[i] == null) continue;
    const x = Math.round(xAt(i));
    const y1 = Math.round(toMacdY(macdData.histogram[i]));
    const c = macdData.histogram[i] >= 0 ? COLOR.macdUp : COLOR.macdDown;
    drawLine(rgb, x, mY0, x, y1, c);
  }

  drawText(rgb, 5, macdTop + 2, 'MACD(12,26,9)', COLOR.macdLine);

  return encodePNG(WIDTH, HEIGHT, rgb);
}

module.exports = { generateChartPng };
