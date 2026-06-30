const fetch = require('node-fetch');
const FormData = require('form-data');

class DiscordNotifier {
  constructor(webhookUrl, errorWebhookUrl = null) {
    this.webhookUrl = webhookUrl;
    this.errorWebhookUrl = errorWebhookUrl || webhookUrl;
  }

  async _post(webhookUrl, embed) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
    } catch (err) {
      console.error('Discord send failed:', err.message);
    }
  }

  async send(embed) {
    if (!this.webhookUrl) {
      console.log('No Discord webhook configured, skipping notification');
      return;
    }
    await this._post(this.webhookUrl, embed);
  }

  async sendWithAttachment(embed, buffer, filename = 'chart.png') {
    if (!this.webhookUrl) {
      console.log('No Discord webhook configured, skipping notification');
      return;
    }
    try {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ embeds: [embed] }));
      form.append('file', buffer, filename);
      await fetch(this.webhookUrl, {
        method: 'POST',
        body: form,
        headers: form.getHeaders(),
      });
    } catch (err) {
      console.error('Discord send with attachment failed:', err.message);
    }
  }

  async sendLiveTrade(signal, chartBuffer = null, openPositions = null, round = 0, brokerPos = null, currentPrice = null) {
    const isBuy = signal.signal === 'BUY';
    const isNone = signal.signal === 'NONE';
    const emoji = isBuy ? '🟢' : isNone ? '⚪' : '🔴';
    const color = isBuy ? 0x00da7a : isNone ? 0x808080 : 0xda3a3a;
    const dec = (signal.symbol?.includes('JPY') ? 3 : 2);
    const priceStr = currentPrice != null ? ` @ ${currentPrice.toFixed(dec)}` : '';

    const title = `${emoji} #${round} ${signal.symbol}${priceStr}${isNone ? '' : ` | ${isBuy ? 'BUY' : 'SELL'}`}`;

    const fields = [];
    if (signal.indicators?.rsi != null || signal.indicators?.atr != null) {
      const rsiVal = signal.indicators?.rsi?.toFixed(1) ?? '-';
      const atrVal = signal.indicators?.atr?.toFixed(dec) ?? '-';
      fields.push({
        name: '📊 วิเคราะห์',
        value: `RSI \`${rsiVal}\`  ·  ATR \`${atrVal}\``,
        inline: true,
      });
    }
    if (!isNone && signal.reason) {
      fields.push({
        name: '💡 เหตุผล',
        value: signal.reason,
        inline: false,
      });
    }

    if (openPositions && Object.keys(openPositions).length > 0) {
      const lines = [];
      let totalPnl = 0;
      for (const [sym, pos] of Object.entries(openPositions)) {
        const dir = pos.type === 'BUY' ? '▲' : '▼';
        const pnl = pos.pnl != null ? pos.pnl : 0;
        totalPnl += pnl;
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        const entryStr = (pos.entry?.toString() ?? '-').padEnd(10);
        const trailing = pos.trailingActivated ? ' ⚡' : '';
        lines.push(`${dir} ${sym.padEnd(8)} ${entryStr} ${pnlStr.padStart(10)}${trailing}`);
      }
      if (lines.length > 0) {
        const totalStr = `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`;
        const sep = '─'.repeat(32);
        const posTable = `\`\`\`\n${lines.join('\n')}\n${sep}\nรวม  ${totalStr.padStart(10)}\n\`\`\``;
        fields.push({
          name: `📋 ออเดอร์ (${Object.keys(openPositions).length})`,
          value: posTable,
          inline: false,
        });
      }
    }

    const embed = {
      title,
      color,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: `บอทเทรด · ${signal.symbol}` },
    };
    if (chartBuffer) {
      embed.image = { url: 'attachment://chart.png' };
      await this.sendWithAttachment(embed, chartBuffer);
    } else {
      await this.send(embed);
    }
  }

  async sendBacktestReport(report) {
    const isProfitable = report.netProfit >= 0;
    const color = isProfitable ? 0x00da7a : 0xda3a3a;
    const emoji = isProfitable ? '📈' : '📉';
    const netStr = `${isProfitable ? '+' : ''}$${this._fmtMoney(report.netProfit)}`;
    const retStr = `${report.returnPct >= 0 ? '+' : ''}${report.returnPct?.toFixed(1) ?? '?'}%`;

    const desc = [
      `\`\`\`diff`,
      `${isProfitable ? '+ ' : '- '} กำไรสุทธิ : ${netStr}`,
      `  ผลตอบแทน : ${retStr}`,
      `  ชนะ ${report.winRate.toFixed(1)}%`,
      `  PF ${report.profitFactor.toFixed(2)}`,
      `  DD สูงสุด ${report.maxDrawdown.toFixed(1)}%`,
      `  เทรดทั้งหมด ${report.totalTrades}`,
      `\`\`\``,
    ].join('\n');

    const embed = {
      title: `${emoji} ทดสอบย้อนหลัง · ${report.symbol}`,
      color,
      description: desc,
      fields: [],
      timestamp: new Date().toISOString(),
      footer: { text: 'รายงานทดสอบ' },
    };
    if (report.summary) {
      const yearlySection = report.summary.split('--- Yearly Breakdown ---')[1]?.trim();
      if (yearlySection) {
        embed.fields.push({ name: '📅 แยกตามปี', value: '```\n' + yearlySection.slice(0, 1000) + '\n```', inline: false });
      }
    }
    if (report.artifactUrl) {
      embed.fields.push({ name: '🔗 รายงาน', value: `[เปิดรายงาน](${report.artifactUrl})`, inline: false });
    }
    await this.send(embed);
  }

  _fmtMoney(n) {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return n.toFixed(2);
  }

  _fmt(n) {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }

  async sendError(error, context = {}) {
    if (!this.errorWebhookUrl) {
      console.log('No Discord error webhook configured, skipping error notification');
      return;
    }
    const ctxStr = Object.keys(context).length > 0
      ? `\`\`\`\n${Object.entries(context).map(([k, v]) => `${k}: ${v}`).join('\n').slice(0, 950)}\n\`\`\``
      : '';
    const fields = [
      { name: '⚠️ ข้อผิดพลาด', value: `\`${error.message || String(error)}\``, inline: false },
    ];
    if (ctxStr) {
      fields.push({ name: '📋 บริบท', value: ctxStr, inline: false });
    }
    const embed = {
      title: '🚨 เกิดข้อผิดพลาด',
      color: 0xda3a3a,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'ระบบแจ้งเตือน' },
    };
    await this._post(this.errorWebhookUrl, embed);
  }
}

module.exports = DiscordNotifier;
