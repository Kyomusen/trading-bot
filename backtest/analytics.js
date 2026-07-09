// backtest/analytics.js
// คำนวณเมตริกประเมินความแข็งแรงของ backtest นอกเหนือจาก summarize()
// รับ trades (TradeEvent[]) ที่ปิดแล้ว และ startingBalance
// คืน object เดียวที่รวม: drawdown, streaks, monthly/yearly PF, session PF,
// position-size distribution, expectancy, Sharpe/Sortino, แยก STOP_LOSS กำไร/ขาดทุน

function pct(x) { return +(x * 100).toFixed(2); }
function r2(x) { return Math.round(x * 100) / 100; }

function groupPF(rows) {
  let win = 0, loss = 0;
  for (const t of rows) {
    if (t.pnl > 0) win += t.pnl;
    else loss += t.pnl;
  }
  return loss !== 0 ? r2(Math.abs(win / loss)) : (win > 0 ? null : 0);
}

function analyze(trades, { startingBalance = 1000 } = {}) {
  const closed = trades
    .filter((t) => t.pnl != null)
    .sort((a, b) => a.closedAt - b.closedAt);

  if (closed.length === 0) return { error: 'no closed trades' };

  // ----- Equity curve + Max Drawdown (บน total equity = startingBalance + cumulativePnL) -----
  // total equity = broker.balance + withdrawn สะท้อนความมั่งคั่งรวม (ไม่รวมถอน)
  const equityCurve = [{ t: closed[0].closedAt, balance: startingBalance }];
  let bal = startingBalance;
  const returns = [];
  for (const tr of closed) {
    const before = bal;
    bal += tr.pnl;
    equityCurve.push({ t: tr.closedAt, balance: bal });
    if (before > 0) returns.push(tr.pnl / before);
  }

  let peak = startingBalance, maxDD = 0, maxDDpct = 0;
  for (const p of equityCurve) {
    if (p.balance > peak) peak = p.balance;
    const dd = p.balance - peak;
    if (dd < maxDD) maxDD = dd;
    const dp = peak > 0 ? dd / peak : 0;
    if (dp < maxDDpct) maxDDpct = dp;
  }

  // ----- Consecutive streaks -----
  let curWin = 0, curLoss = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const t of closed) {
    if (t.pnl > 0) { curWin++; curLoss = 0; if (curWin > maxWinStreak) maxWinStreak = curWin; }
    else { curLoss++; curWin = 0; if (curLoss > maxLossStreak) maxLossStreak = curLoss; }
  }

  // ----- Monthly / Yearly PF + profit -----
  const byMonth = {}, byYear = {}, byHour = {};
  for (const t of closed) {
    const d = new Date(t.closedAt);
    const y = d.getUTCFullYear();
    const m = `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const h = d.getUTCHours();
    (byMonth[m] = byMonth[m] || []).push(t);
    (byYear[y] = byYear[y] || []).push(t);
    (byHour[h] = byHour[h] || []).push(t);
  }
  const monthly = Object.keys(byMonth).sort().map((k) => ({
    period: k, trades: byMonth[k].length, pf: groupPF(byMonth[k]),
    profit: r2(byMonth[k].reduce((s, t) => s + t.pnl, 0)),
  }));
  const yearly = Object.keys(byYear).sort().map((k) => ({
    period: k, trades: byYear[k].length, pf: groupPF(byYear[k]),
    profit: r2(byYear[k].reduce((s, t) => s + t.pnl, 0)),
  }));
  const sessionPF = Object.keys(byHour).sort((a, b) => a - b).map((h) => ({
    hourUTC: +h, trades: byHour[h].length, pf: groupPF(byHour[h]),
  }));

  // ----- Position size distribution -----
  const buckets = [
    { label: '<1', min: 0, max: 1 },
    { label: '1–5', min: 1, max: 5 },
    { label: '5–10', min: 5, max: 10 },
    { label: '10–20', min: 10, max: 20 },
    { label: '20–50', min: 20, max: 50 },
    { label: '50+', min: 50, max: Infinity },
  ];
  const sizeDist = buckets.map((b) => ({
    label: b.label,
    count: closed.filter((t) => t.size >= b.min && t.size < b.max).length,
  }));

  // ----- Expectancy -----
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const expectancy = r2(totalPnl / closed.length);
  const rExpectancy = closed.reduce((s, t) => s + (t.riskAmount ? t.pnl / t.riskAmount : 0), 0) / closed.length;

  // ----- Sharpe / Sortino (per-trade return, annualized) -----
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance) || 1e-9;
  const downside = returns.filter((x) => x < 0);
  const dVar = downside.reduce((s, x) => s + (x - 0) ** 2, 0) / returns.length;
  const dStd = Math.sqrt(dVar) || 1e-9;
  const spanYears = (closed[closed.length - 1].closedAt - closed[0].closedAt) / (365 * 86400000) || 1;
  const annFactor = Math.sqrt(closed.length / spanYears);
  const sharpe = r2((mean / std) * annFactor);
  const sortino = r2((mean / dStd) * annFactor);

  // ----- STOP_LOSS breakdown (แยก trailing กำไร vs SL จริงขาดทุน) -----
  const sl = closed.filter((t) => t.exitReason === 'STOP_LOSS');
  const trailing = closed.filter((t) => t.exitReason === 'TRAILING_STOP');
  const slLoss = sl.length;
  const slWin = trailing.length;

  return {
    maxDrawdownUsd: r2(maxDD),
    maxDrawdownPct: pct(maxDDpct),
    maxWinStreak,
    maxLossStreak,
    expectancyUsd: expectancy,
    rExpectancy: +r2(rExpectancy),
    sharpe,
    sortino,
    stopLossBreakdown: { total: sl.length, trailingWins: slWin, realLosses: slLoss },
    positionSizeDistribution: sizeDist,
    monthly,
    yearly,
    sessionPFbyHourUTC: sessionPF,
  };
}

module.exports = { analyze };
