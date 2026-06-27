const fs = require('fs');
const path = require('path');

function loadSymbolsConfig() {
  const symbolsDir = path.join(__dirname, 'symbols');
  const symbols = [];

  if (!fs.existsSync(symbolsDir)) {
    return symbols;
  }

  const dirs = fs.readdirSync(symbolsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const symbol of dirs) {
    const configPath = path.join(symbolsDir, symbol, 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      symbols.push(config);
    }
  }

  return symbols;
}

function getEnabledSymbols() {
  return loadSymbolsConfig().filter(s => s.enabled);
}

function getSymbolConfig(symbolId) {
  return loadSymbolsConfig().find(s => s.symbol === symbolId);
}

module.exports = { loadSymbolsConfig, getEnabledSymbols, getSymbolConfig };
