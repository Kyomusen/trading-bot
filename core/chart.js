const zlib = require('zlib');

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const F = {
  '0':[0b01110,0b10001,0b10011,0b10101,0b11001,0b10001,0b01110],
  '1':[0b00100,0b01100,0b00100,0b00100,0b00100,0b00100,0b01110],
  '2':[0b01110,0b10001,0b00001,0b00010,0b00100,0b01000,0b11111],
  '3':[0b01110,0b10001,0b00001,0b00110,0b00001,0b10001,0b01110],
  '4':[0b00010,0b00110,0b01010,0b10010,0b11111,0b00010,0b00010],
  '5':[0b11111,0b10000,0b11110,0b00001,0b00001,0b10001,0b01110],
  '6':[0b01110,0b10000,0b10000,0b11110,0b10001,0b10001,0b01110],
  '7':[0b11111,0b00001,0b00010,0b00100,0b01000,0b01000,0b01000],
  '8':[0b01110,0b10001,0b10001,0b01110,0b10001,0b10001,0b01110],
  '9':[0b01110,0b10001,0b10001,0b01111,0b00001,0b00001,0b01110],
  'A':[0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'B':[0b11110,0b10001,0b10001,0b11110,0b10001,0b10001,0b11110],
  'C':[0b01110,0b10001,0b10000,0b10000,0b10000,0b10001,0b01110],
  'D':[0b11110,0b10001,0b10001,0b10001,0b10001,0b10001,0b11110],
  'E':[0b11111,0b10000,0b10000,0b11100,0b10000,0b10000,0b11111],
  'F':[0b11111,0b10000,0b10000,0b11100,0b10000,0b10000,0b10000],
  'G':[0b01110,0b10001,0b10000,0b10111,0b10001,0b10001,0b01110],
  'H':[0b10001,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'I':[0b01110,0b00100,0b00100,0b00100,0b00100,0b00100,0b01110],
  'J':[0b00111,0b00010,0b00010,0b00010,0b00010,0b10010,0b01100],
  'K':[0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
  'L':[0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111],
  'M':[0b10001,0b11011,0b10101,0b10101,0b10001,0b10001,0b10001],
  'N':[0b10001,0b11001,0b10101,0b10011,0b10001,0b10001,0b10001],
  'O':[0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'P':[0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000],
  'Q':[0b01110,0b10001,0b10001,0b10001,0b10101,0b10010,0b01101],
  'R':[0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001],
  'S':[0b01110,0b10001,0b10000,0b01110,0b00001,0b10001,0b01110],
  'T':[0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
  'U':[0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'V':[0b10001,0b10001,0b10001,0b10001,0b10001,0b01010,0b00100],
  'W':[0b10001,0b10001,0b10001,0b10101,0b10101,0b11011,0b10001],
  'X':[0b10001,0b10001,0b01010,0b00100,0b01010,0b10001,0b10001],
  'Y':[0b10001,0b10001,0b01010,0b00100,0b00100,0b00100,0b00100],
  'Z':[0b11111,0b00001,0b00010,0b00100,0b01000,0b10000,0b11111],
  ':':[0b00000,0b01100,0b01100,0b00000,0b01100,0b01100,0b00000],
  '.':[0b00000,0b00000,0b00000,0b00000,0b00000,0b01100,0b01100],
  '-':[0b00000,0b00000,0b00000,0b11111,0b00000,0b00000,0b00000],
};

function setPixel(px, W, x, y, col) {
  if (x < 0 || y < 0) return;
  const idx = (y * W + x) * 4;
  if (idx + 3 >= px.length) return;
  px[idx]   = col[0];
  px[idx+1] = col[1];
  px[idx+2] = col[2];
  px[idx+3] = col[3] ?? 255;
}

function hLine(px, W, x1, x2, y, col, dashOn = 0, dashOff = 0) {
  for (let x = x1; x <= x2; x++) {
    if (dashOn > 0 && (x - x1) % (dashOn + dashOff) >= dashOn) continue;
    setPixel(px, W, x, y, col);
  }
}

function vLine(px, W, x, y1, y2, col) {
  for (let y = y1; y <= y2; y++) setPixel(px, W, x, y, col);
}

function drawLine(px, W, x0, y0, x1, y1, col) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, cx = x0, cy = y0;
  for (let n = 0; n < dx + dy + 2; n++) {
    setPixel(px, W, cx, cy, col);
    if (cx === x1 && cy === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 <  dx) { err += dx; cy += sy; }
  }
}

function drawText(px, W, x, y, text, col, h = 7, w = 5, gap = 1) {
  let cx = x;
  const stride = w + gap;
  for (const ch of text) {
    const bm = F[ch];
    if (!bm) { cx += stride; continue; }
    for (let row = 0; row < h; row++) {
      for (let bx = 0; bx < w; bx++) {
        if (!(bm[row] & (1 << (w - 1 - bx)))) continue;
        setPixel(px, W, cx + bx, y + row, col);
      }
    }
    cx += stride;
  }
  return cx - gap;
}

function calcEMA(values, period) {
  if (values.length < period + 1) return values.map(() => null);
  const result = new Array(values.length);
  const k = 2 / (period + 1);
  let ema = values.slice(0, period + 1).reduce((a, b) => a + b, 0) / (period + 1);
  for (let i = 0; i < values.length; i++) {
    if (i < period) { result[i] = null; continue; }
    if (i === period) { result[i] = ema; continue; }
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function generateChart(candles, ind, position = null, symbol = 'XAUUSD', timeframe = 'H1', width = 600, height = 350, fullCloses = null, existingPos = null) {
  const px = new Uint8Array(width * height * 4);

  const BG      = [18,  18,  36,  255];
  const PLOT_BG = [24,  24,  44,  255];
  const GRID    = [48,  48,  68,  255];
  const AXIS    = [72,  72, 102,  255];
  const BULL    = [38,  180, 155, 255];
  const BEAR    = [225,  72,  72, 255];
  const EMA_C   = [255, 200,  50, 255];
  const EMA50_C = [ 50, 200, 255, 255];
  const TXT     = [175, 175, 200, 255];
  const HDR     = [215, 215, 235, 255];
  const DIM     = [110, 110, 135, 255];
  const ENTRY_C = [255, 191,   0, 230];
  const SL_C    = [255,  65,  65, 230];
  const POS_ENTRY_C = [  0, 220, 255, 210];
  const POS_BEST_C  = [100, 255, 100, 180];
  const PROFIT_C    = [ 38, 220, 155, 255];
  const LOSS_C      = [255,  80,  80, 255];

  for (let i = 0; i < px.length; i += 4) {
    px[i] = BG[0]; px[i+1] = BG[1]; px[i+2] = BG[2]; px[i+3] = BG[3];
  }

  const padL = 62, padR = 18, padT = 26, padB = 36;
  const plotW = width  - padL - padR;
  const plotH = height - padT - padB;

  for (let y = padT; y < padT + plotH; y++) {
    for (let x = padL; x < padL + plotW; x++) {
      const idx = (y * width + x) * 4;
      px[idx] = PLOT_BG[0]; px[idx+1] = PLOT_BG[1]; px[idx+2] = PLOT_BG[2]; px[idx+3] = 255;
    }
  }

  const valid = candles.map((c, i) => ({
    o: c.open, h: c.high, l: c.low, c: c.close, t: c.time || '', i,
  })).filter(v => v.h != null && v.l != null && v.o != null && v.c != null);

  if (valid.length < 2) {
    const h = Buffer.alloc(13);
    h.writeUInt32BE(10, 0); h.writeUInt32BE(10, 4); h[8] = 8; h[9] = 6;
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', h),
      chunk('IDAT', zlib.deflateSync(Buffer.alloc(10 * (10 * 4 + 1)))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  const prices = [...valid.map(v => v.h), ...valid.map(v => v.l)];
  if (position?.entryPrice) prices.push(position.entryPrice);
  if (position?.stopLoss)   prices.push(position.stopLoss);
  if (existingPos) {
    if (existingPos.entry != null) prices.push(existingPos.entry);
    if (existingPos.bestPrice != null) prices.push(existingPos.bestPrice);
  }
  const maxP  = Math.max(...prices);
  const minP  = Math.min(...prices);
  const pPad  = (maxP - minP) * 0.08 || 1;
  const lo    = minP - pPad;
  const hi    = maxP + pPad;
  const range = hi - lo;

  const yOf = p  => padT + plotH - ((p  - lo) / range) * plotH;
  const xOf = vi => padL + (vi / (valid.length - 1)) * plotW;

  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const y    = Math.round(padT + plotH * frac);
    hLine(px, width, padL, padL + plotW - 1, y, GRID, 6, 4);
    drawText(px, width, 2, y - 3, (hi - frac * range).toFixed(symbol.includes('JPY') ? 3 : 1), TXT);
  }

  const closes = valid.map(v => v.c);
  const emaValues = fullCloses || closes;
  const ema20 = calcEMA(emaValues, 20);
  const ema50 = calcEMA(emaValues, 50);
  const ema20Slice = ema20.slice(-valid.length);
  const ema50Slice = ema50.slice(-valid.length);

  function drawEMALine(emaSlice, color, label) {
    let prev = null, lastX = null, lastY = null;
    for (let vi = 0; vi < valid.length; vi++) {
      const val = emaSlice[vi];
      if (val == null) { prev = null; continue; }
      const cx = Math.round(xOf(vi));
      const cy = Math.round(yOf(val));
      if (prev) drawLine(px, width, prev.x, prev.y, cx, cy, color);
      prev = { x: cx, y: cy };
      lastX = cx; lastY = cy;
    }
    if (lastX != null && label) {
      drawText(px, width, lastX - label.length * 6 - 2, lastY - 3, label, color);
    }
  }

  drawEMALine(ema20Slice, EMA_C, 'EMA20');
  drawEMALine(ema50Slice, EMA50_C, 'EMA50');

  for (let vi = 0; vi < valid.length; vi++) {
    const v   = valid[vi];
    const cx  = Math.round(xOf(vi));
    const cw  = Math.max(3, Math.round(plotW / valid.length * 0.6));
    const col = v.c >= v.o ? BULL : BEAR;
    const yH  = Math.round(yOf(v.h)), yL = Math.round(yOf(v.l));
    const yO  = Math.round(yOf(v.o)), yC = Math.round(yOf(v.c));
    const bTop = Math.min(yO, yC);
    const bBot = Math.max(Math.max(yO, yC), bTop + 1);
    vLine(px, width, cx, yH, yL, col);
    const xS = cx - Math.floor(cw / 2), xE = cx + Math.ceil(cw / 2);
    for (let by = bTop; by <= bBot; by++)
      for (let bx = xS; bx < xE; bx++)
        setPixel(px, width, bx, by, col);
  }

  const signalEntry = position?.entryPrice;
  if (existingPos && existingPos.entry != null && existingPos.entry !== signalEntry) {
    const y = Math.round(yOf(existingPos.entry));
    if (y >= padT && y < padT + plotH) {
      hLine(px, width, padL, padL + plotW - 1, y, POS_ENTRY_C, 4, 4);
      drawText(px, width, padL + 2, y - 4, `${symbol}`, POS_ENTRY_C);
      const dir = existingPos.type === 'BUY' ? '▲' : '▼';
      drawText(px, width, padL + 2 + symbol.length * 6, y - 4, dir, existingPos.type === 'BUY' ? PROFIT_C : LOSS_C);
    }
  }

  if (existingPos?.trailingActivated && existingPos.bestPrice != null) {
    const y = Math.round(yOf(existingPos.bestPrice));
    if (y >= padT && y < padT + plotH) {
      hLine(px, width, padL, padL + plotW - 1, y, POS_BEST_C, 3, 5);
      drawText(px, width, padL + plotW - 24, y - 4, 'BEST', POS_BEST_C);
    }
  }

  if (position) {
    const lines = [
      { price: position.entryPrice, col: ENTRY_C, label: 'EN' },
      { price: position.stopLoss,   col: SL_C,    label: 'SL' },
    ].filter(l => l.price != null);

    for (const { price, col, label } of lines) {
      const y = Math.round(yOf(price));
      if (y < padT || y >= padT + plotH) continue;
      hLine(px, width, padL, padL + plotW - 1, y, col, 5, 3);
      drawText(px, width, padL + plotW - 14, y - 4, label, col);
    }
  }

  vLine(px, width, padL - 1, padT, padT + plotH + 1, AXIS);
  hLine(px, width, padL - 1, padL + plotW, padT + plotH + 1, AXIS);

  const lastClose = valid[valid.length - 1].c;
  const dec = symbol.includes('JPY') ? 3 : 2;
  drawText(px, width, padL + 4, 8, `${symbol} ${timeframe}  ${lastClose.toFixed(dec)}`, HDR);

  if (existingPos) {
    const pnl = existingPos.type === 'BUY'
      ? lastClose - existingPos.entry
      : existingPos.entry - lastClose;
    const pnlColor = pnl >= 0 ? PROFIT_C : LOSS_C;
    const pnlSign = pnl >= 0 ? '+' : '';
    const atrInfo = existingPos.atrValue ? ` ATR:${existingPos.atrValue.toFixed(dec)}` : '';
    const trail = existingPos.trailingActivated ? ' TRAIL' : '';
    const posText = `${existingPos.type} @${existingPos.entry.toFixed(dec)} ${pnlSign}${pnl.toFixed(dec)}${atrInfo}${trail}`;
    drawText(px, width, padL + 4, 18, posText, pnlColor);
  }

  const step = Math.max(1, Math.floor(valid.length / 5));
  for (let vi = 0; vi < valid.length; vi += step) {
    const v = valid[vi];
    const x = Math.round(xOf(vi));
    const t = v.t?.length >= 16 ? v.t.slice(11, 16) : '';
    if (t) drawText(px, width, x - 10, height - padB + 11, t, DIM);
  }

  const info = `${valid.length} แท่ง`;
  drawText(px, width, width - padR - info.length * 6 - 2, height - padB + 11, info, DIM);

  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = row + 1 + x * 4;
      raw[d] = px[s]; raw[d+1] = px[s+1]; raw[d+2] = px[s+2]; raw[d+3] = px[s+3];
    }
  }

  const compressed = zlib.deflateSync(raw);
  const hdr = Buffer.alloc(13);
  hdr.writeUInt32BE(width, 0); hdr.writeUInt32BE(height, 4);
  hdr[8] = 8; hdr[9] = 6; hdr[10] = 0; hdr[11] = 0; hdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', hdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { generateChart };
