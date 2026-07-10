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

module.exports = { formatOpenEvent, formatCloseEvent };
