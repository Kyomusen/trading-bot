const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'logs', 'candle_cache');

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheKey(symbol, timeframe) {
  return `${symbol}_${timeframe.toUpperCase()}.json`;
}

function cachePath(symbol, timeframe) {
  return path.join(CACHE_DIR, cacheKey(symbol, timeframe));
}

function loadCandleCache(symbol, timeframe) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(symbol, timeframe), 'utf-8'));
    if (Array.isArray(raw)) return raw;
    return null;
  } catch {
    return null;
  }
}

function saveCandleCache(symbol, timeframe, candles, maxSize = 720) {
  ensureDir();
  const trimmed = candles.length > maxSize ? candles.slice(candles.length - maxSize) : candles;
  fs.writeFileSync(cachePath(symbol, timeframe), JSON.stringify(trimmed));
}

function mergeCandles(cached, fresh) {
  const timeSet = new Set();
  for (const c of cached) {
    timeSet.add(c.time);
  }
  const newOnes = fresh.filter(c => !timeSet.has(c.time));
  if (newOnes.length === 0) return cached;
  const merged = [...cached, ...newOnes];
  merged.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const final = [];
  const seen = new Set();
  for (const c of merged) {
    if (!seen.has(c.time)) {
      seen.add(c.time);
      final.push(c);
    }
  }
  return final;
}

module.exports = { loadCandleCache, saveCandleCache, mergeCandles };
