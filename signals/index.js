const xauStrategy = require('./xauStrategy');

const strategies = [xauStrategy];

function evaluateAll(candles, epic) {
  return strategies
    .map((s) => s.evaluate(candles, epic))
    .filter(Boolean);
}

module.exports = { strategies, evaluateAll };
