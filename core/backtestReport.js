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
    const yearlyMap = {};

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

      const year = new Date(trade.exitTime || trade.entryTime).getFullYear();
      if (!isNaN(year)) {
        if (!yearlyMap[year]) yearlyMap[year] = { trades: [], wins: 0, losses: 0, grossProfit: 0, grossLoss: 0 };
        yearlyMap[year].trades.push(trade);
        if (pnl > 0) { yearlyMap[year].wins++; yearlyMap[year].grossProfit += pnl; }
        else { yearlyMap[year].losses++; yearlyMap[year].grossLoss += Math.abs(pnl); }
      }
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
    const netProfit = balance - this.initialBalance;
    const returnPct = (netProfit / this.initialBalance) * 100;

    const yearlyBreakdown = Object.entries(yearlyMap)
      .sort(([a], [b]) => a - b)
      .map(([year, d]) => {
        const t = d.trades.length;
        const wr = t > 0 ? (d.wins / t) * 100 : 0;
        const pf = d.grossLoss > 0 ? d.grossProfit / d.grossLoss : d.grossProfit > 0 ? 999 : 0;
        const net = d.grossProfit - d.grossLoss;
        return {
          year: parseInt(year),
          trades: t,
          wins: d.wins,
          losses: d.losses,
          winRate: parseFloat(wr.toFixed(1)),
          profitFactor: parseFloat(pf.toFixed(2)),
          netProfit: parseFloat(net.toFixed(2)),
        };
      });

    return {
      symbol: this.trades[0]?.symbol || 'UNKNOWN',
      initialBalance: this.initialBalance,
      finalBalance: parseFloat(balance.toFixed(2)),
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
      yearlyBreakdown,
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
      yearlyBreakdown: [],
    };
  }

  toSummary() {
    const r = this.generate();
    let s = `=== Backtest: ${r.symbol} ===\n`;
    s += `Initial: $${r.initialBalance}  Final: $${r.finalBalance}  Net: $${r.netProfit} (${r.returnPct}%)\n`;
    s += `Trades: ${r.totalTrades}  WR: ${r.winRate}%  PF: ${r.profitFactor}  DD: ${r.maxDrawdown}%\n`;

    if (r.yearlyBreakdown && r.yearlyBreakdown.length > 0) {
      s += `\n--- Yearly Breakdown ---\n`;
      s += `Year     Trades  WR%    PF     Net($)   \n`;
      s += `──${'─'.repeat(45)}\n`;
      for (const y of r.yearlyBreakdown) {
        s += `${y.year}  ${String(y.trades).padStart(6)}  ${y.winRate.toFixed(1).padStart(5)}%  ${y.profitFactor.toFixed(2).padStart(5)}  ${this._fmt(y.netProfit)}\n`;
      }
    }
    return s;
  }

  _fmt(n) {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }
}

module.exports = BacktestReport;
