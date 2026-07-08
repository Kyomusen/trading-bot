const fs = require('fs');
const path = require('path');

const symbols = ['XAUUSD', 'USDJPY', 'EURUSD'];
const dataDir = path.join(__dirname, '..', 'data');
const historicalDir = path.join(dataDir, 'historical');

if (!fs.existsSync(historicalDir)) fs.mkdirSync(historicalDir, { recursive: true });

for (const symbol of symbols) {
  const csvPath = path.join(dataDir, 'symbols', symbol, 'data', 'candles_H1.csv');
  if (!fs.existsSync(csvPath)) {
    console.log(`skip ${symbol}: no CSV`);
    continue;
  }
  const raw = fs.readFileSync(csvPath, 'utf-8').trim();
  const lines = raw.split('\n').slice(1);
  const candles = lines.map((line) => {
    const [dateStr, open, high, low, close, volume] = line.split(';');
    const [d, t] = dateStr.split(' ');
    const [y, m, day] = d.split('.');
    const [hh, mm] = t.split(':');
    const timestamp = new Date(+y, +m - 1, +day, +hh, +mm).getTime();
    return {
      timestamp,
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    };
  });
  const outPath = path.join(historicalDir, `${symbol}.json`);
  fs.writeFileSync(outPath, JSON.stringify(candles));
  console.log(`converted ${symbol}: ${candles.length} candles -> ${outPath}`);
}
