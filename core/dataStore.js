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
      const headers = raw[0].split(',');
      return raw.slice(1).map(line => {
        const vals = line.split(',');
        const row = {};
        headers.forEach((h, i) => {
          row[h.trim()] = isNaN(vals[i]) ? vals[i].trim() : parseFloat(vals[i]);
        });
        return row;
      });
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
