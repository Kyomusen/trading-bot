// index.js
// entrypoint: node index.js live   -> รันเทรดสด
//             node index.js backtest -> รัน backtest ทุก symbol ใน config

require('dotenv').config();

const mode = process.argv[2];

async function main() {
  if (mode === 'live') {
    const { start } = require('./live/runLive');
    await start();
  } else if (mode === 'backtest') {
    const { run } = require('./backtest/runBacktest');
    run();
  } else {
    console.log('ใช้งาน: node index.js live | node index.js backtest');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('เกิดข้อผิดพลาด:', err);
  process.exit(1);
});
