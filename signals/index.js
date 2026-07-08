const xauStrategy = require('./xauStrategy');

const strategies = [xauStrategy];

function evaluateAll(candles) {
  return strategies
    .map((s) => s.evaluate(candles))
    .filter(Boolean);
}

module.exports = { strategies, evaluateAll };
