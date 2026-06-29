const fetch = require('node-fetch');
const FormData = require('form-data');

class DiscordNotifier {
  constructor(webhookUrl, errorWebhookUrl = null) {
    this.webhookUrl = webhookUrl;
    this.errorWebhookUrl = errorWebhookUrl || webhookUrl;
  }

  async send(embed) {
    if (!this.webhookUrl) {
      console.log('No Discord webhook configured, skipping notification');
      return;
    }
    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
    } catch (err) {
      console.error('Discord send failed:', err.message);
    }
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
    const embed = {
      title: `📊 Live Signal: ${signal.symbol}`,
      color,
      fields: [
        { name: 'Signal', value: signal.signal, inline: true },
        { name: 'Entry', value: signal.entry?.toString() ?? '-', inline: true },
        { name: 'SL', value: signal.sl?.toString() ?? '-', inline: true },
        { name: 'TP', value: signal.tp?.toString() ?? '-', inline: true },
        { name: 'Reason', value: signal.reason ?? '-', inline: false },
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
    const embed = {
      title: `📈 Backtest Result: ${report.symbol}`,
      color: 0x0099ff,
      fields: [
        { name: 'Return %', value: report.returnPct.toFixed(2) + '%', inline: true },
        { name: 'Win Rate', value: report.winRate.toFixed(2) + '%', inline: true },
        { name: 'Profit Factor', value: report.profitFactor.toFixed(2), inline: true },
        { name: 'Max Drawdown', value: report.maxDrawdown.toFixed(2) + '%', inline: true },
        { name: 'Total Trades', value: report.totalTrades.toString(), inline: true },
        { name: 'Net Profit', value: report.netProfit.toFixed(2), inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Backtest Report' },
    };
    if (report.artifactUrl) {
      embed.fields.push({ name: 'Artifact', value: `[Download](${report.artifactUrl})`, inline: false });
    }
    await this.send(embed);
  }

  async sendError(error, context = {}) {
    if (!this.errorWebhookUrl) {
      console.log('No Discord error webhook configured, skipping error notification');
      return;
    }
    const embed = {
      title: '❌ Trading Bot Error',
      color: 0xff0000,
      fields: [
        { name: 'Error', value: error.message || String(error), inline: false },
        { name: 'Context', value: JSON.stringify(context, null, 2).slice(0, 1000), inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Trading Bot Error' },
    };
    await fetch(this.errorWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    }).catch(() => {});
  }
}

module.exports = DiscordNotifier;
