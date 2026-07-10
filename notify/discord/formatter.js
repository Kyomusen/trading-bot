// notify/discord/formatter.js
// รับ TradeEvent ที่คำนวณครบถ้วนแล้วเท่านั้น — ห้ามคำนวณอะไรเพิ่มในไฟล์นี้
// หน้าที่เดียว: แปลง object เป็น Discord embed format

function formatOpenEvent(tradeEvent) {
  const color = tradeEvent.direction === 'BUY' ? 0x2ecc71 : 0xe74c3c;
  return {
    embeds: [
      {
        title: `เปิดออเดอร์ ${tradeEvent.direction} — ${tradeEvent.epic}`,
        color,
        description: [
          `**กลยุทธ์:** ${tradeEvent.strategy}`,
          `**Entry:** ${tradeEvent.entry}`,
          `**Stop Loss:** ${tradeEvent.stopLoss}`,
          `**Take Profit:** ${tradeEvent.takeProfit ?? '-'}`,
          `**Size:** ${tradeEvent.size}`,
          `**Risk:** $${tradeEvent.riskAmount?.toFixed(2) ?? '-'}`,
          `**Confidence:** ${tradeEvent.confidence ?? '-'}`,
        ].join('\n'),
        timestamp: new Date(tradeEvent.openedAt).toISOString(),
      },
    ],
  };
}

function formatCloseEvent(tradeEvent) {
  const isProfit = (tradeEvent.pnl ?? 0) >= 0;
  const isStopHit = tradeEvent.exitReason === 'STOP_LOSS' || tradeEvent.exitReason === 'TRAILING_STOP' || tradeEvent.exitReason?.startsWith('STOP');
  let color = isProfit ? 0x2ecc71 : 0xe74c3c;
  let prefix = '';
  if (isStopHit) {
    color = isProfit ? 0x2ecc71 : 0xff4444;
    prefix = '🛑 ';
  }
  return {
    embeds: [
      {
        title: `${prefix}ปิดออเดอร์ ${tradeEvent.direction} — ${tradeEvent.epic}`,
        color,
        description: [
          `**กลยุทธ์:** ${tradeEvent.strategy}`,
          `**Exit Reason:** ${tradeEvent.exitReason}`,
          `**PnL:** $${tradeEvent.pnl?.toFixed(2)} (${tradeEvent.pnlPercent?.toFixed(2)}%)`,
        ].join('\n'),
        timestamp: new Date(tradeEvent.closedAt).toISOString(),
      },
    ],
  };
}

function formatHeartbeat({ uptime, symbols, balance, lossStreak }) {
  const lines = [];
  lines.push(`**อัปไทม์:** ${uptime}`);
  lines.push(`**Balance:** $${balance?.toFixed(2) ?? '-'}`);
  if (lossStreak) lines.push(`**Loss Streak:** ${lossStreak}`);

  for (const sym of symbols) {
    lines.push('');
    lines.push(`**${sym.epic}**`);
    if (sym.price) {
      const spread = ((sym.price.ask - sym.price.bid) * 10000).toFixed(0);
      lines.push(`\`${sym.price.bid.toFixed(2)} / ${sym.price.ask.toFixed(2)}\` (${spread} pip)`);
    }
    if (sym.ws) lines.push('📍 WS live');
    else lines.push('⏳ REST poll');

    if (sym.indicators) {
      const ind = sym.indicators;
      const parts = [];
      parts.push(`RSI ${ind.rsi?.toFixed(1)}`);
      parts.push(`EMA20 ${ind.ema20?.toFixed(1)}`);
      parts.push(`EMA50 ${ind.ema50?.toFixed(1)}`);
      if (ind.atr != null) parts.push(`ATR ${ind.atr.toFixed(2)}`);
      if (ind.adx != null) parts.push(`ADX ${ind.adx.toFixed(1)}`);
      if (ind.macd != null) parts.push(`MACD ${ind.macd > 0 ? '+' : ''}${ind.macd.toFixed(2)}`);
      lines.push(parts.join(' · '));
    }

    if (sym.positions && sym.positions.length > 0) {
      for (const pos of sym.positions) {
        const emoji = pos.direction === 'BUY' ? '🟢' : '🔴';
        const uPnl = pos.unrealizedPnl != null ? `UPnL $${pos.unrealizedPnl.toFixed(2)}` : '';
        lines.push(`${emoji} ${pos.direction} size=${pos.size} entry=${pos.entryPrice} SL=${pos.stopLevel} ${uPnl}`.trim());
      }
    }
  }

  const color = balance >= 0 ? 0x2ecc71 : 0xe74c3c;
  return {
    embeds: [
      {
        title: '💓 Heartbeat — Bot Status',
        color,
        description: lines.join('\n'),
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

module.exports = { formatOpenEvent, formatCloseEvent, formatHeartbeat };
