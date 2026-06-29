class BacktestReport {
  constructor(trades, initialBalance = 10000) {
    this.trades = trades;
    this.initialBalance = initialBalance;
  }

  generate() {
    if (!this.trades || this.trades.length === 0) {
      return this._emptyReport();
    }

    let balance = this.initialBalance;
    let peak = this.initialBalance;
    let maxDrawdown = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;

    const equityCurve = [balance];

    for (const trade of this.trades) {
      const pnl = trade.pnl || 0;
      balance += pnl;
      equityCurve.push(balance);

      if (balance > peak) peak = balance;
      const dd = ((peak - balance) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;

      if (pnl > 0) {
        grossProfit += pnl;
        wins++;
      } else {
        grossLoss += Math.abs(pnl);
        losses++;
      }
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
    const netProfit = balance - this.initialBalance;
    const returnPct = (netProfit / this.initialBalance) * 100;

    return {
      symbol: this.trades[0]?.symbol || 'UNKNOWN',
      initialBalance: this.initialBalance,
      finalBalance: balance,
      netProfit: parseFloat(netProfit.toFixed(2)),
      returnPct: parseFloat(returnPct.toFixed(2)),
      totalTrades,
      wins,
      losses,
      winRate: parseFloat(winRate.toFixed(2)),
      grossProfit: parseFloat(grossProfit.toFixed(2)),
      grossLoss: parseFloat(grossLoss.toFixed(2)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
      equityCurve,
      trades: this.trades,
    };
  }

  _emptyReport() {
    return {
      symbol: 'UNKNOWN',
      initialBalance: this.initialBalance,
      finalBalance: this.initialBalance,
      netProfit: 0,
      returnPct: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      grossProfit: 0,
      grossLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      equityCurve: [this.initialBalance],
      trades: [],
    };
  }

  toHTML() {
    const r = this.generate();
    return `
<!DOCTYPE html>
<html>
<head>
  <title>Backtest Report - ${r.symbol}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .metric { display: inline-block; padding: 10px 20px; margin: 5px; background: #f5f5f5; border-radius: 4px; }
    .metric.green { background: #d4edda; color: #155724; }
    .metric.red { background: #f8d7da; color: #721c24; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #343a40; color: white; }
  </style>
</head>
<body>
  <h1>Backtest Report: ${r.symbol}</h1>
  <div>
    <span class="metric ${r.returnPct >= 0 ? 'green' : 'red'}">Return: ${r.returnPct}%</span>
    <span class="metric">Win Rate: ${r.winRate}%</span>
    <span class="metric">Profit Factor: ${r.profitFactor}</span>
    <span class="metric ${r.maxDrawdown > 10 ? 'red' : ''}">Max DD: ${r.maxDrawdown}%</span>
    <span class="metric">Trades: ${r.totalTrades}</span>
    <span class="metric ${r.netProfit >= 0 ? 'green' : 'red'}">Net Profit: ${r.netProfit}</span>
  </div>
  <h2>Trade History</h2>
  <table>
    <tr><th>Time</th><th>Type</th><th>Entry</th><th>Exit</th><th>SL</th><th>PnL</th></tr>
    ${r.trades.map(t => `
      <tr>
        <td>${t.exitTime || t.entryTime}</td>
        <td>${t.type}</td>
        <td>${t.entry}</td>
        <td>${t.exit}</td>
        <td>${t.sl}</td>
        <td class="${t.pnl >= 0 ? 'green' : 'red'}">${t.pnl}</td>
      </tr>
    `).join('')}
  </table>
</body>
</html>
    `.trim();
  }
}

module.exports = BacktestReport;
