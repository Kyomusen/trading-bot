// notify/chart.js
// รับ TradeEvent (คำนวณเสร็จแล้ว) + candles เป็น input คืนค่า PNG buffer
// วาดเส้นราคา (Bresenham) + EMA overlay บน buffer pixel แล้ว encode เป็น PNG
// ไม่ใช้ external image lib — encode ด้วย zlib (built-in) + CRC32 เขียนเอง

const zlib = require('zlib');

// EMA period: อ่านจาก config ถ้ามี (config.chart.emaPeriod) ไม่มีให้ default 20
let EMA_PERIOD = 20;
try {
  const config = require('../config');
  if (config && config.chart && config.chart.emaPeriod) EMA_PERIOD = config.chart.emaPeriod;
} catch (_) { /* ใช้ default 20 */ }

const WIDTH = 800;
const HEIGHT = 400;
const BG = [17, 24, 39];
const PRICE_COLOR = [0, 200, 255];   // ฟ้า — เส้นราคา
const EMA_COLOR = [255, 165, 0];     // ส้ม — เส้น EMA (แยกต่างหากชัดเจน)

// ---------- PNG encoder (RGB, 8-bit) ----------
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
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- pixel buffer helpers ----------
function setPixel(buf, w, h, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}

// Bresenham line — เชื่อมจุดต่อเนื่องโดยไม่มีช่องว่าง
function drawLine(buf, w, h, x0, y0, x1, y1, color) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    setPixel(buf, w, h, x0, y0, color);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// EMA แบบง่าย (self-contained)
function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function generateChartPng(tradeEvent, candles) {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgb[i * 3] = BG[0]; rgb[i * 3 + 1] = BG[1]; rgb[i * 3 + 2] = BG[2];
  }

  const closes = (candles || [])
    .map((c) => parseFloat(c && c.close))
    .filter((v) => isFinite(v));

  if (closes.length >= 2) {
    let min = closes[0];
    let max = closes[0];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] < min) min = closes[i];
      if (closes[i] > max) max = closes[i];
    }
    const range = (max - min) || 1;
    const xAt = (i) => (closes.length === 1 ? 0 : (i * (WIDTH - 1)) / (closes.length - 1));
    const yAt = (v) => (1 - (v - min) / range) * (HEIGHT - 1);

    // เส้นราคา (Bresenham)
    for (let i = 1; i < closes.length; i++) {
      drawLine(rgb, WIDTH, HEIGHT, xAt(i - 1), yAt(closes[i - 1]), xAt(i), yAt(closes[i]), PRICE_COLOR);
    }
    // เส้น EMA overlay
    const e = ema(closes, EMA_PERIOD);
    for (let i = 1; i < e.length; i++) {
      drawLine(rgb, WIDTH, HEIGHT, xAt(i - 1), yAt(e[i - 1]), xAt(i), yAt(e[i]), EMA_COLOR);
    }
  }

  return encodePNG(WIDTH, HEIGHT, rgb);
}

module.exports = { generateChartPng };
