const fs = require('fs');
const path = require('path');

class DataStore {
  constructor(baseDir = path.join(__dirname, '../backtests')) {
    this.baseDir = baseDir;
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  }

  static loadLocalCandles(symbol, timeframe) {
    const dataDir = path.join(__dirname, '..', 'symbols', symbol, 'data');
    const jsonFile = path.join(dataDir, `candles_${timeframe}.json`);
    const csvFile = path.join(dataDir, `candles_${timeframe}.csv`);

    if (fs.existsSync(jsonFile)) {
      return JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    }

    if (fs.existsSync(csvFile)) {
      const raw = fs.readFileSync(csvFile, 'utf8').trim().split('\n');
      const delim = raw[0].includes(';') ? ';' : ',';
      const headers = raw[0].split(delim).map(h => h.trim().toLowerCase());
      const colIdx = (aliases) => {
        for (const a of aliases) {
          const i = headers.indexOf(a);
          if (i >= 0) return i;
        }
        return -1;
      };
      const ci = {
        time: colIdx(['date', 'timestamp', 'time', 'datetime', 't']),
        open: colIdx(['open', 'o']),
        high: colIdx(['high', 'h']),
        low: colIdx(['low', 'l']),
        close: colIdx(['close', 'c']),
        volume: colIdx(['volume', 'vol', 'v']),
      };
      const missing = ['time', 'open', 'high', 'low', 'close'].filter(k => ci[k] < 0);
      if (missing.length > 0) {
        throw new Error(`CSV missing columns: ${missing.join(', ')}`);
      }
      return raw.slice(1).map(line => {
        const vals = line.split(delim);
        const timeStr = vals[ci.time].replace(/"/g, '').trim();
        const o = parseFloat(vals[ci.open]);
        const h = parseFloat(vals[ci.high]);
        const l = parseFloat(vals[ci.low]);
        const c = parseFloat(vals[ci.close]);
        if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) return null;
        return {
          time: timeStr.replace(/\./g, '-').replace(' ', 'T'),
          open: o, high: h, low: l, close: c,
          volume: ci.volume >= 0 ? (parseInt(vals[ci.volume]) || 0) : 0,
        };
      }).filter(Boolean);
    }

    return null;
  }

  saveBacktestResult(symbol, result) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${symbol}_${timestamp}.json`;
    const filepath = path.join(this.baseDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(result, null, 2));
    return filepath;
  }

  loadBacktestResult(symbol, timestamp) {
    const filename = `${symbol}_${timestamp}.json`;
    const filepath = path.join(this.baseDir, filename);
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  }

  listBacktestResults(symbol = null) {
    const files = fs.readdirSync(this.baseDir);
    return files
      .filter(f => f.endsWith('.json') && (!symbol || f.startsWith(symbol)))
      .map(f => {
        const filepath = path.join(this.baseDir, f);
        const stat = fs.statSync(filepath);
        return { file: f, path: filepath, time: stat.mtime };
      })
      .sort((a, b) => b.time - a.time);
  }

  getLatestBacktest(symbol) {
    const results = this.listBacktestResults(symbol);
    if (results.length === 0) return null;
    return this.loadBacktestResult(symbol, results[0].file.split('_').slice(1).join('_').replace('.json', ''));
  }
}

module.exports = DataStore;
