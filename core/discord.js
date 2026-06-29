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

  async sendLiveTrade(signal, chartBuffer = null) {
    const color = signal.signal === 'BUY' ? 0x00ff00 : signal.signal === 'SELL' ? 0xff0000 : 0x808080;
    const emoji = signal.signal === 'BUY' ? '🟢' : signal.signal === 'SELL' ? '🔴' : '⚪';
    const embed = {
      title: `${emoji} Live Signal: ${signal.signal} ${signal.symbol}`,
      color,
      fields: [
        { name: '📍 Entry', value: signal.entry?.toString() ?? '-', inline: true },
        { name: '🛑 SL', value: signal.sl?.toString() ?? '-', inline: true },
        { name: '📊 Technicals', value: `RSI: ${signal.indicators?.rsi?.toFixed(1) ?? '-'} | ATR: ${signal.indicators?.atr?.toFixed(2) ?? '-'}`, inline: true },
        { name: '📦 Lot Size', value: signal.lotSize?.toString() ?? '-', inline: true },
        { name: '📝 Reason', value: signal.reason ?? '-', inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Trading Bot' },
    };
    if (chartBuffer) {
      embed.image = { url: 'attachment://chart.png' };
      await this.sendWithAttachment(embed, chartBuffer);
    } else {
      await this.send(embed);
    }
  }

  async sendBacktestReport(report) {
    const emoji = report.netProfit >= 0 ? '📈' : '📉';
    const desc = `**Net**: $${this._fmt(report.netProfit)}  **WR**: ${report.winRate.toFixed(1)}%  **PF**: ${report.profitFactor.toFixed(2)}  **DD**: ${report.maxDrawdown.toFixed(1)}%  **Trades**: ${report.totalTrades}`;
    const embed = {
      title: `${emoji} Backtest: ${report.symbol}`,
      color: 0x0099ff,
      description: desc,
      timestamp: new Date().toISOString(),
      footer: { text: 'Backtest Report' },
    };
    if (report.summary) {
      const yearlySection = report.summary.split('--- Yearly Breakdown ---')[1]?.trim();
      if (yearlySection) {
        embed.fields.push({ name: '📅 Yearly Breakdown', value: '```\n' + yearlySection.slice(0, 1000) + '\n```', inline: false });
      }
    }
    if (report.artifactUrl) {
      embed.fields.push({ name: '🔗 Artifact', value: `[View Report](${report.artifactUrl})`, inline: false });
    }
    await this.send(embed);
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
    const embed = {
      title: '🚨 Critical Error Detected',
      color: 0xff0000,
      description: `\`${error.message || String(error)}\``,
      fields: [
        { name: '🔍 Context', value: `\`\`\`json\n${JSON.stringify(context, null, 2).slice(0, 950)}\n\`\`\``, inline: false },
        { name: '🛠️ Action Required', value: 'Check logs and verify system status.', inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Error Monitor' },
    };
    await this._post(this.errorWebhookUrl, embed);
  }
}

module.exports = DiscordNotifier;
